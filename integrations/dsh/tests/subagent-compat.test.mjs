import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import semver from 'semver'
import { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { canStartSubagent, startPrismFlowSubagent } from '../lib/subagent-compat.js'
import { detectInstalledDshVersion, sqliteVersionForDsh } from '../lib/dsh-install.js'
import { apply as applyGenerator } from '../lib/generator-subagent.js'

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

function options(signal = new AbortController().signal) {
  return { label: 'PrismFlow review', parent: { id: 'parent' }, signal,
    prompt: [{ type: 'text', text: 'untrusted evidence' }],
    outputSchema: { type: 'object', properties: {}, additionalProperties: false },
    persona: 'Trusted reviewer instructions', toolFilter: { allow: [] } }
}

function modernContext(start) {
  const hooks = new Set(), sections = [], restrictions = []
  const ctx = {
    on(event, listener) {
      assert.equal(event, 'agent/created')
      hooks.add(listener)
      return () => hooks.delete(listener)
    },
    subagents: { startActivation: spec => start(spec, initialize) },
  }
  function initialize(id) {
    const agent = { id, ctx: {
      systemPrompt: {
        getSectionOrder(key) { assert.equal(key, 'DEPLOYMENT_PERSONA_PREFIX'); return 17 },
        section(section) { sections.push({ id, ...section }) },
      },
      tools: { restrict(filter) { restrictions.push({ id, filter }) } },
    } }
    for (const hook of hooks) hook({ agent })
  }
  return { ctx, hooks, sections, restrictions }
}

function activation(childId, dispose = async () => {}) {
  return { childId, result: Promise.resolve({ stopReason: 'completed', structured: {} }), dispose }
}

test('DSH peers admit 0.2.0/0.2.1 prereleases and later stable releases without dropping the old baseline', () => {
  for (const [name, range] of Object.entries(manifest.peerDependencies)) {
    if (!name.startsWith('@deepseek-ai/dsh-')) continue
    for (const version of ['0.1.0-rc.6', '0.1.7-rc.1', '0.2.0-alpha.1', '0.2.0-rc.2', '0.2.0', '0.2.1-rc.2', '0.2.1', '0.2.9', '0.3.0', '1.0.0']) {
      assert.equal(semver.satisfies(version, range), true, `${name} rejects ${version}`)
    }
    assert.equal(semver.satisfies('0.1.0-rc.5', range), false)
  }
})

test('the installed DSH cohort and its actual subagent API match the tested baseline', () => {
  const version = manifest.devDependencies['@deepseek-ai/dsh-subagent']
  assert.equal(detectInstalledDshVersion(fileURLToPath(new URL('../', import.meta.url))), version)
  assert.equal(sqliteVersionForDsh(version), version)
  if (semver.gte(version, '0.2.1-rc.2')) {
    assert.equal(typeof SubagentRuntime.prototype.startActivation, 'function')
    assert.equal(SubagentRuntime.prototype.start, undefined)
  } else {
    assert.equal(typeof SubagentRuntime.prototype.start, 'function')
  }
  assert.equal(canStartSubagent(SubagentRuntime.prototype), true)
  assert.equal(canStartSubagent({}), false)
})

test('legacy hosts receive the exact original request and own run cancellation', async () => {
  const request = options(), expected = activation('legacy')
  const ctx = { subagents: { start(provider, actual) {
    assert.equal(provider, 'spawn'); assert.equal(actual, request); return expected
  } } }
  assert.equal(await startPrismFlowSubagent(ctx, 'spawn', request), expected)
})

test('managed activations retain structured output and install Persona and tool policy on only the reserved child', async () => {
  const request = options()
  let disposals = 0
  const value = modernContext(async (spec, initialize) => {
    assert.deepEqual(Object.keys(spec).sort(), ['childId', 'delivery', 'label', 'provider', 'request', 'signal'])
    assert.equal(spec.provider, 'spawn'); assert.equal(spec.delivery, 'caller')
    assert.equal(spec.label, request.label); assert.equal(spec.signal, request.signal)
    assert.deepEqual(spec.request, { parent: request.parent, prompt: request.prompt, outputSchema: request.outputSchema })
    initialize('unrelated-child')
    initialize(spec.childId)
    return activation(spec.childId, async () => { disposals += 1 })
  })
  value.ctx.subagents.start = () => assert.fail('must prefer managed activation')
  const run = await startPrismFlowSubagent(value.ctx, 'spawn', request)
  assert.deepEqual(value.sections, [{ id: run.id, name: 'deployment:persona-prefix', order: 17, text: request.persona }])
  assert.deepEqual(value.restrictions, [{ id: run.id, filter: request.toolFilter }])
  assert.equal(value.hooks.size, 0)
  assert.equal((await run.result).stopReason, 'completed')
  await Promise.all([run.dispose(), run.dispose()])
  assert.equal(disposals, 1)
})

test('the production generator executes and disposes a managed no-tool child with its trusted Persona', async () => {
  let provider, disposals = 0
  const value = modernContext(async (spec, initialize) => {
    initialize(spec.childId)
    return { childId: spec.childId,
      result: Promise.resolve({ stopReason: 'completed', structured: { title: 'Brief', markdown: '# Brief' } }),
      async dispose() { disposals += 1 },
    }
  })
  value.ctx.prismProduction = { registerGenerator(value) { provider = value; return () => {} } }
  value.ctx.effect = () => {}
  applyGenerator(value.ctx, { generators: [{ id: 'daily', name: 'Daily', description: '', subagentProvider: 'spawn',
    instruction: 'Create a brief.', persona: 'Editor', maxInputChars: 10000, maxOutputChars: 10000 }] })
  const reference = await provider.pinPrompt()
  const record = { storeId: 'a'.repeat(64), item: { title: 'Source', url: '', description: 'Untrusted evidence', source: 'test', category: 'news', published_date: '' } }
  const result = await provider.generate(reference, [record], { agent: {}, signal: new AbortController().signal })
  assert.equal(result.title, 'Brief')
  assert.equal(value.sections[0].text, 'Editor\n\nCreate a brief.')
  assert.deepEqual(value.restrictions[0].filter, { allow: [] })
  assert.equal(disposals, 1)
})

test('unrestricted workflows do not acquire an accidental empty tool allowlist', async () => {
  const value = modernContext(async (spec, initialize) => { initialize(spec.childId); return activation(spec.childId) })
  const { toolFilter: _filter, ...request } = options()
  const run = await startPrismFlowSubagent(value.ctx, 'spawn', request)
  await run.result; await run.dispose()
  assert.deepEqual(value.restrictions, [])
})

test('running abort disposes the exact activation once instead of relying on its startup signal', async () => {
  const controller = new AbortController()
  let complete, disposals = 0
  const pending = new Promise(resolve => { complete = resolve })
  const value = modernContext(async (spec, initialize) => {
    initialize(spec.childId)
    return { childId: spec.childId, result: pending, async dispose() {
      disposals += 1; complete({ stopReason: 'aborted' })
    } }
  })
  const run = await startPrismFlowSubagent(value.ctx, 'spawn', options(controller.signal))
  controller.abort('operator cancelled')
  assert.equal((await run.result).stopReason, 'aborted')
  await run.dispose()
  assert.equal(disposals, 1)
})

test('abort racing publication still cancels, and teardown failures remain observable', async () => {
  const controller = new AbortController(), failure = new Error('teardown failed')
  const value = modernContext(async (spec, initialize) => {
    initialize(spec.childId); controller.abort()
    return activation(spec.childId, async () => { throw failure })
  })
  const run = await startPrismFlowSubagent(value.ctx, 'spawn', options(controller.signal))
  await run.result
  await assert.rejects(run.dispose(), error => error === failure)
})

test('aborted startup, failed startup and missing initialization never silently weaken execution policy', async () => {
  const controller = new AbortController(); controller.abort()
  const unused = modernContext(() => assert.fail('must not start aborted work'))
  await assert.rejects(startPrismFlowSubagent(unused.ctx, 'spawn', options(controller.signal)), { name: 'AbortError' })
  assert.equal(unused.hooks.size, 0)
  const failed = modernContext(async () => { throw new Error('startup failed') })
  await assert.rejects(startPrismFlowSubagent(failed.ctx, 'spawn', options()), /startup failed/)
  assert.equal(failed.hooks.size, 0)
  let disposed = false
  const missing = modernContext(async spec => activation(spec.childId, async () => { disposed = true }))
  await assert.rejects(startPrismFlowSubagent(missing.ctx, 'spawn', options()), /initialization did not apply/)
  assert.equal(disposed, true); assert.equal(missing.hooks.size, 0)
  await assert.rejects(startPrismFlowSubagent({ subagents: missing.ctx.subagents }, 'spawn', options()), /hooks are unavailable/)
})

test('concurrent child initialization keeps each task Persona and tool restriction isolated', async () => {
  const pending = []
  const value = modernContext((spec, initialize) => new Promise(resolve => {
    pending.push(() => { initialize(spec.childId); resolve(activation(spec.childId)) })
  }))
  const first = startPrismFlowSubagent(value.ctx, 'spawn', options())
  const second = startPrismFlowSubagent(value.ctx, 'spawn', { ...options(), persona: 'Researcher', toolFilter: { allow: ['web_search'] } })
  for (const initialize of pending.reverse()) initialize()
  const runs = await Promise.all([first, second])
  assert.deepEqual(value.sections.map(section => section.text), ['Researcher', 'Trusted reviewer instructions'])
  assert.deepEqual(value.restrictions.map(row => row.filter.allow), [['web_search'], []])
  assert.equal(value.hooks.size, 0)
  await Promise.all(runs.map(async run => { await run.result; await run.dispose() }))
})
