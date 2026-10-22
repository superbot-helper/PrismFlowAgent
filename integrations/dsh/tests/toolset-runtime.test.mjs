import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { PrismToolsetStore, registerPrismFlowTool } from '../lib/store-prismflow-toolsets.js'

class Table {
  constructor() { this.rows = new Map() }
  get(key) { return this.rows.get(key) }
  entries() { return this.rows.entries() }
  async put(key, value) { this.rows.set(key, structuredClone(value)); return value }
  async delete(key) { this.rows.delete(key) }
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'prismflow-toolset-runtime-'))
  const host = new Context()
  host.provide('systemPrompt', { tools() { return () => {} }, section() { return () => {} }, getSectionOrder() { return 0 } })
  const tools = new ToolRuntime(host)
  const counter = { activations: 0, cleanups: 0, calls: 0 }
  const store = new PrismToolsetStore(new Context(), { pluginRoot: join(root, 'plugins') })
  store.table = new Table(); store.materializeSkill = async () => {}
  store.ctx = { tools, get: key => key === 'counter' ? counter : undefined }
  await mkdir(store.pluginRoot, { recursive: true })
  await store.bootstrap(); await store.bootstrapPromptSuggestions(); await store.activatePersonalPlugins()
  t.after(async () => { try { await store.toolsetRuntime.close() } finally { await rm(root, { recursive: true, force: true }) } })
  return { store, tools, counter }
}
const TOOL_A = 'prismflow_runtime_a'
const TOOL_B = 'prismflow_runtime_b'
const PLUGIN = 'prismflow-personal-runtime-fixture'
function definition(name) {
  return { name, description: 'Fixture tool', parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, async execute() { return 'ok' } }
}
async function install(store, code) {
  const manifest = { format: 'prismflow-personal-plugin/v1', pluginId: PLUGIN, name: 'Runtime fixture', description: 'Fixture', version: '1.0.0', entry: 'index.mjs', tools: [TOOL_A, TOOL_B] }
  const source = code ?? `export default async api => {
    const counter = api.getService('counter'); counter.activations += 1;
    if (counter.activationWait) await counter.activationWait;
    for (const name of ${JSON.stringify([TOOL_A, TOOL_B])}) api.registerTool({ name, description: 'Fixture', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { counter.calls += 1; if (counter.wait) await counter.wait; return name; } });
    return () => { counter.cleanups += 1; };
  }`
  return store.installPersonalPlugin([
    { path: 'prismflow-plugin.json', data: Buffer.from(JSON.stringify(manifest)) },
    { path: 'index.mjs', data: Buffer.from(source) },
  ])
}
function save(store, names, enabled = true, mode = 'custom') {
  const current = store.getToolset()
  return store.saveToolset({ mode, enabledPlugins: enabled ? [PLUGIN] : [], enabledTools: names, enabledSkills: [],
    expected: { version: current.version, sha256: current.sha256 } })
}
function names(tools) { return tools.schemas().map(tool => tool.name).sort() }

test('uploaded plugin enable/disable, individual tools and repeated toggles reconcile the actual DSH registry immediately', async t => {
  const { store, tools, counter } = await fixture(t)
  await install(store)
  assert.deepEqual(names(tools), []); assert.equal(counter.activations, 0, 'upload must not execute code')
  await save(store, [TOOL_A])
  assert.deepEqual(names(tools), [TOOL_A])
  assert.equal(counter.activations, 1)
  const cached = tools.get(TOOL_A)
  assert.equal(await cached.execute({}), TOOL_A)
  await save(store, [TOOL_B])
  assert.deepEqual(names(tools), [TOOL_B])
  assert.equal(counter.activations, 1, 'per-tool changes must not rerun plugin activation')
  await assert.rejects(cached.execute({}), /disabled/u)
  assert.equal(await tools.get(TOOL_B).execute({}), TOOL_B)
  await save(store, [], false)
  assert.deepEqual(names(tools), []); assert.equal(counter.cleanups, 1)
  await save(store, [TOOL_A, TOOL_B])
  await store.activatePersonalPlugins()
  assert.deepEqual(names(tools), [TOOL_A, TOOL_B]); assert.equal(counter.activations, 2)
  const runtime = store.listPlugins().find(plugin => plugin.pluginId === PLUGIN).runtime
  assert.equal(runtime.state, 'active'); assert.deepEqual(runtime.registeredTools.sort(), [TOOL_A, TOOL_B])
  await save(store, [], false, 'core')
  assert.deepEqual(names(tools), []); assert.equal(counter.cleanups, 2)
})

test('a registration failure rolls back configuration, history, partial registry entries and plugin resources', async t => {
  const { store, tools, counter } = await fixture(t)
  await install(store)
  const before = store.getToolset(), beforeRows = structuredClone([...store.table.entries()])
  const register = tools.register.bind(tools)
  let fail = true
  store.ctx.tools = { register(value) {
    if (value.name === TOOL_B && fail) { fail = false; throw new Error('DO_NOT_EXPOSE_REGISTRATION_DETAIL') }
    return register(value)
  } }
  await assert.rejects(save(store, [TOOL_A, TOOL_B]), error => /previous selection/u.test(error.message) && !error.message.includes('DO_NOT_EXPOSE'))
  assert.deepEqual(store.getToolset(), before)
  assert.deepEqual([...store.table.entries()], beforeRows)
  assert.deepEqual(names(tools), []); assert.equal(counter.cleanups, 1)
  await save(store, [TOOL_A, TOOL_B])
  assert.deepEqual(names(tools), [TOOL_A, TOOL_B]); assert.equal(counter.activations, 2)
})

test('persistence failure never activates new code and removes the uncommitted history revision', async t => {
  const { store, tools, counter } = await fixture(t)
  await install(store)
  const before = structuredClone([...store.table.entries()])
  const put = store.table.put.bind(store.table)
  let failed = false
  store.table.put = async (key, value) => {
    if (key === '@toolset:active' && !failed) { failed = true; throw new Error('storage failure') }
    return put(key, value)
  }
  await assert.rejects(save(store, [TOOL_A]), /previous selection/u)
  assert.deepEqual([...store.table.entries()], before)
  assert.deepEqual(names(tools), []); assert.equal(counter.activations, 0)
})

test('concurrent toolset changes serialize activation and enforce CAS rather than duplicate registrations', async t => {
  const { store, tools, counter } = await fixture(t)
  await install(store)
  let release
  counter.activationWait = new Promise(resolve => { release = resolve })
  const first = save(store, [TOOL_A])
  const second = save(store, [TOOL_B])
  const rejected = assert.rejects(second, /version conflict/u)
  const deadline = Date.now() + 2000
  while (!counter.activations && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve))
  assert.equal(counter.activations, 1)
  assert.deepEqual(names(tools), [], 'activation declarations remain unpublished while preparation is pending')
  release(); await first; await rejected
  assert.deepEqual(names(tools), [TOOL_A]); assert.equal(counter.activations, 1)
})

test('a revocation failure restores the previous selection and a fresh valid registration without reviving cached definitions', async t => {
  const { store, tools, counter } = await fixture(t)
  await install(store)
  const register = tools.register.bind(tools)
  let fail = true
  store.ctx.tools = { register(value) {
    const off = register(value)
    return async () => { await off(); if (fail) { fail = false; throw new Error('revocation failed once') } }
  } }
  await save(store, [TOOL_A])
  const before = store.getToolset(), cached = tools.get(TOOL_A)
  await assert.rejects(save(store, [], false), /previous selection/u)
  assert.deepEqual(store.getToolset(), before)
  assert.deepEqual(names(tools), [TOOL_A])
  await assert.rejects(cached.execute({}), /disabled/u)
  assert.equal(await tools.get(TOOL_A).execute({}), TOOL_A)
  assert.equal(counter.activations, 2); assert.equal(counter.cleanups, 1)
})

test('incomplete plugin declarations are rejected before any tool is published', async t => {
  const { store, tools, counter } = await fixture(t)
  await install(store, `export default api => { const counter = api.getService('counter'); counter.activations += 1;
    api.registerTool({ name: '${TOOL_A}', description: 'Fixture', parameters: {}, output: { schema: { type: 'string' }, render: () => [] }, async execute() { return 'ok' } });
    return () => { counter.cleanups += 1; }; }`)
  const before = store.getToolset()
  await assert.rejects(save(store, [TOOL_A]))
  assert.deepEqual(store.getToolset(), before); assert.deepEqual(names(tools), [])
  assert.equal(counter.activations, 1); assert.equal(counter.cleanups, 1)
})

test('disable blocks cached calls immediately and drains an admitted call before plugin cleanup', async t => {
  const { store, tools, counter } = await fixture(t)
  await install(store); await save(store, [TOOL_A])
  let finish
  counter.wait = new Promise(resolve => { finish = resolve })
  const cached = tools.get(TOOL_A), running = cached.execute({})
  await new Promise(resolve => setImmediate(resolve))
  const disabling = save(store, [], false)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(names(tools), [])
  assert.equal(counter.cleanups, 0)
  await assert.rejects(cached.execute({}), /disabled/u)
  finish(); assert.equal(await running, TOOL_A)
  await disabling; assert.equal(counter.cleanups, 1)
})

test('a selected native personal plugin cannot report applied before its tool provider is ready', async t => {
  const { store, tools } = await fixture(t)
  const root = new URL('../manual-import-src/plugins/prismflow-personal-rss/', import.meta.url)
  await store.installPersonalPlugin([
    { path: 'prismflow-plugin.json', data: await readFile(new URL('prismflow-plugin.json', root)) },
    { path: 'index.mjs', data: await readFile(new URL('index.mjs', root)) },
  ])
  const apply = () => {
    const row = store.getToolset()
    return store.saveToolset({ mode: 'custom', enabledPlugins: ['prismflow-personal-rss'], enabledTools: ['prismflow_generate_rss_content'], enabledSkills: [],
      expected: { version: row.version, sha256: row.sha256 } })
  }
  const previous = store.getToolset()
  await assert.rejects(apply(), /no ready registration provider/u)
  assert.deepEqual(store.getToolset(), previous); assert.deepEqual(names(tools), [])
  const release = registerPrismFlowTool({ get: key => key === 'prismToolsets' ? store : undefined, tools }, defineTool(definition('prismflow_generate_rss_content')))
  t.after(release)
  assert.deepEqual(names(tools), [], 'a disabled factory must not register prematurely')
  await apply()
  assert.deepEqual(names(tools), ['prismflow_generate_rss_content'])
})

test('native managed definitions survive disable/re-enable without touching unrelated Host tools', async t => {
  const { store, tools } = await fixture(t)
  const other = tools.register(defineTool(definition('host_unrelated'))); t.after(other)
  const ctx = { get: key => key === 'prismToolsets' ? store : undefined, tools }
  const release = registerPrismFlowTool(ctx, defineTool(definition('prismflow_sources')))
  const cached = tools.get('prismflow_sources')
  assert.deepEqual(names(tools), ['host_unrelated', 'prismflow_sources'])
  const set = async enabled => {
    const row = store.getToolset()
    return store.saveToolset({ mode: 'custom', enabledPlugins: ['prismflow-system-sources'], enabledTools: enabled ? ['prismflow_sources'] : [], enabledSkills: [],
      expected: { version: row.version, sha256: row.sha256 } })
  }
  await set(false); assert.deepEqual(names(tools), ['host_unrelated'])
  await assert.rejects(cached.execute({}), /disabled/u)
  await set(true); assert.deepEqual(names(tools), ['host_unrelated', 'prismflow_sources'])
  assert.equal(await tools.get('prismflow_sources').execute({}), 'ok')
  await release(); await set(false); await set(true)
  assert.deepEqual(names(tools), ['host_unrelated'], 'disposed plugin owners must not be resurrected')
})
