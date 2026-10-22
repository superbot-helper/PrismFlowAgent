import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import YAML from 'yaml'
import { validateConfigurationStartup } from '../lib/configuration-startup-validation.js'
import { createPrismFlowDataBackup, decryptPrismFlowDataBackup, encryptPrismFlowDataBackup, parsePrismFlowDataBackup, PRISMFLOW_DATA_UNITS, restorePrismFlowDataBackup } from '../lib/data-backup.js'
import { PrismToolsetStore } from '../lib/store-prismflow-toolsets.js'
import { createDeploymentExecutionProfile, PrismGeneratorWorkflowStore } from '../lib/store-generator-workflows.js'

class Table {
  constructor(records = []) { this.map = new Map(records.map(row => [row.key, JSON.parse(row.value)])) }
  get(key) { return this.map.get(key) }
  entries() { return this.map.entries() }
  async put(key, value) { this.map.set(key, structuredClone(value)); return value }
}
function createDatabase(path) {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA user_version = 1; CREATE TABLE units (name TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT; CREATE TABLE unit_globals (unit TEXT PRIMARY KEY REFERENCES units(name), value TEXT NOT NULL) STRICT')
  for (const unit of PRISMFLOW_DATA_UNITS) {
    db.prepare('INSERT INTO units (name, version) VALUES (?, ?)').run(unit.name, unit.version)
    for (const table of unit.tables) db.exec(`CREATE TABLE "u_${unit.name}_${table}" (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`)
  }
  return db
}
function insertRows(db, unit, table, rows) {
  const insert = db.prepare(`INSERT INTO "u_${unit}_${table}" (key, value) VALUES (?, ?)`)
  for (const [key, value] of rows) insert.run(key, JSON.stringify(value))
}
function readRows(db, unit, table) {
  return db.prepare(`SELECT key, value FROM "u_${unit}_${table}" ORDER BY key`).all().map(row => ({ key: row.key, value: row.value }))
}
function makeToolsets(records = []) {
  const store = new PrismToolsetStore(new Context())
  store.table = new Table(records); store.materializeSkill = async () => {}
  return store
}
function makeWorkflows() {
  const store = new PrismGeneratorWorkflowStore(new Context())
  store.historyTable = new Table(); store.releaseWriterLock = async () => {}
  store.registerExecutionProfile(createDeploymentExecutionProfile({
    format: 'spawn-profile-v1', id: 'dashboard-builder', version: 1, runnerPolicyVersion: 'serial-workflow-v2', providerRef: 'spawn', toolPolicy: { allow: [] },
    ceilings: { maxSteps: 8, maxInputChars: 10000, maxCombinedInputChars: 20000, maxIntermediateOutputChars: 10000, maxFinalOutputChars: 10000, maxPromptAggregateChars: 32000 },
  }), { builderDefault: true })
  return store
}

for (const mode of ['complete', 'custom']) test(`encrypted .pfbackup restores ${mode} plugin selections and full workflow history into a clean target that can reopen`, async t => {
  const home = await mkdtemp(join(tmpdir(), 'prismflow-restored-startup-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const sourcePath = join(home, 'source.sqlite'), targetPath = join(home, 'target.sqlite')
  const toolsets = makeToolsets()
  const pluginId = 'prismflow-personal-source-only'
  const personal = { pluginId, name: 'Source only', description: 'Fixture', origin: 'personal', version: '1', tools: ['prismflow_source_only'], skills: [], uploaded: true, bundled: false }
  toolsets.personalPluginManifests.set(pluginId, personal)
  await toolsets.bootstrap(); await toolsets.bootstrapPromptSuggestions()
  const initial = toolsets.getToolset()
  await toolsets.saveToolset({ mode, enabledPlugins: initial.enabledPlugins, enabledTools: initial.enabledTools, enabledSkills: initial.enabledSkills,
    expected: { version: initial.version, sha256: initial.sha256 } })
  const workflows = makeWorkflows()
  const definition = id => ({ generatorId: id, generatorName: id, description: '', steps: [{ id: 'draft', name: 'Draft', persona: 'PRIVATE_PERSONA_FIXTURE', processPrompt: '' }] })
  const ref = row => ({ kind: 'workflow-v1', version: row.version, sha256: row.sha256 })
  const created = await workflows.create(definition('retained'))
  await workflows.save({ ...definition('retained'), generatorName: 'Updated', expected: ref(created) })
  const removed = await workflows.create(definition('deleted'))
  const archived = await workflows.disable({ generatorId: removed.generatorId, expected: ref(removed) })
  await workflows.delete({ generatorId: removed.generatorId, expected: ref(archived) })
  const source = createDatabase(sourcePath)
  insertRows(source, 'prismflow_toolsets', 'records', toolsets.table.entries())
  insertRows(source, 'prismflow_generator_workflows', 'history', workflows.historyTable.entries())
  source.close()
  const exported = createPrismFlowDataBackup(sourcePath, '0.24.128')
  const password = randomUUID()
  const parsed = parsePrismFlowDataBackup(decryptPrismFlowDataBackup(encryptPrismFlowDataBackup(exported.buffer, password), password))
  const original = JSON.stringify(parsed)
  const missingBundleCheck = await validateConfigurationStartup(parsed)
  assert.equal(missingBundleCheck.startupValidated, true)
  assert.equal((await validateConfigurationStartup(parsed, [personal])).enabledPluginCount, missingBundleCheck.enabledPluginCount + 1)
  assert.equal(JSON.stringify(parsed), original, 'preflight must not mutate imported history or selections')

  const profileDir = join(home, 'profiles', 'web')
  await mkdir(profileDir, { recursive: true }); await writeFile(join(profileDir, 'package.json'), '{}\n')
  const managed = [
    { id: 'prismflow-store-production', disabled: false, config: { writerLockPath: join(home, 'target-production.lock') } },
    { id: 'prismflow-store-toolsets', disabled: false, config: { writerLockPath: join(home, 'target-toolsets.lock'), skillRoot: join(home, 'skills'), pluginRoot: join(home, 'plugins') } },
    { id: 'prismflow-store-generator-workflows', disabled: false, config: { writerLockPath: join(home, 'target-workflows.lock') } },
  ]
  const patchPath = join(profileDir, 'cordis.patch.yml')
  await writeFile(patchPath, JSON.stringify([{ id: 'prismflow-store-source-settings', config: {} }, { id: 'prismflow-generator-subagent', config: { generators: [] } }, ...managed]))
  createDatabase(targetPath).close()
  restorePrismFlowDataBackup(targetPath, exported.buffer, patchPath, { dshHome: home, profileName: 'web' })
  const patch = YAML.parse(await readFile(patchPath, 'utf8'))
  for (const row of managed) assert.deepEqual(patch.find(value => value.id === row.id), row, 'restore must preserve target enablement and writer roots')
  const target = new DatabaseSync(targetPath, { readOnly: true })
  try {
    const reopened = makeToolsets(readRows(target, 'prismflow_toolsets', 'records'))
    await reopened.bootstrap(); await reopened.bootstrapPromptSuggestions()
    assert.equal(reopened.getToolset().enabledPlugins.includes(pluginId), false)
    assert.equal(reopened.getToolset().enabledTools.includes('prismflow_source_only'), false)
    const reopenedWorkflows = makeWorkflows()
    reopenedWorkflows.historyTable = new Table(readRows(target, 'prismflow_generator_workflows', 'history'))
    reopenedWorkflows.scanHistory()
    assert.equal((await reopenedWorkflows.list()).length, 1)
    assert.equal(reopenedWorkflows.currentSync('deleted').action, 'delete')
    assert.deepEqual(readRows(target, 'prismflow_generator_workflows', 'history'), parsed.payload.units.find(unit => unit.name === 'prismflow_generator_workflows').tables[0].records)
  } finally { target.close() }

  const malformed = structuredClone(parsed)
  const history = malformed.payload.units.find(unit => unit.name === 'prismflow_generator_workflows').tables[0].records
  history.splice(history.findIndex(row => row.key === 'retained:0000000001'), 1)
  await assert.rejects(validateConfigurationStartup(malformed), error => error.unit === 'prismflow_generator_workflows' && !error.message.includes('PRIVATE_PERSONA_FIXTURE'))
  for (const [unitName, tableName, key] of [
    ['prismflow_generator_prompts', 'history', 'legacy:0000000001'],
    ['prismflow_image_generation_settings', 'current', 'current'],
    ['prismflow_source_settings', 'sources', 'rss:invalid'],
  ]) {
    const invalid = structuredClone(parsed)
    invalid.payload.units.find(unit => unit.name === unitName).tables.find(table => table.name === tableName).records = [
      { key, value: JSON.stringify({ secret: 'DO_NOT_LEAK_IMPORTED_VALUE' }) },
    ]
    await assert.rejects(validateConfigurationStartup(invalid), error => error.unit === unitName && !error.message.includes('DO_NOT_LEAK_IMPORTED_VALUE'))
  }
  const invalidToolset = structuredClone(parsed)
  const active = invalidToolset.payload.units.find(unit => unit.name === 'prismflow_toolsets').tables[0].records.find(record => record.key === '@toolset:active')
  const activeRow = JSON.parse(active.value); activeRow.sha256 = 'f'.repeat(64); active.value = JSON.stringify(activeRow)
  await assert.rejects(validateConfigurationStartup(invalidToolset), error => error.unit === 'prismflow_toolsets')
})
