import { Context } from '@deepseek-ai/cordis'
import { PrismFlowDataBackupError } from './data-backup.js'
import { PrismToolsetStore } from './store-prismflow-toolsets.js'
import { PrismGeneratorWorkflowStore } from './store-generator-workflows.js'
import { PrismGeneratorPromptStore } from './store-generator-prompts.js'
import { PrismImageGenerationSettingsStore } from './store-image-generation-settings.js'
import { normalizeManagedSource } from './store-source-settings.js'
import { CATEGORY_CATALOG_KEY, readCategoryCatalog } from './category-catalog.js'

class SnapshotTable {
  constructor(records = []) { this.rows = new Map(records.map(record => [record.key, JSON.parse(record.value)])) }
  get(key) { return this.rows.get(key) }
  entries() { return this.rows.entries() }
  async put(key, value) { this.rows.set(key, structuredClone(value)); return value }
}
function records(payload, unit, table) {
  return payload.units.find(candidate => candidate.name === unit)?.tables.find(candidate => candidate.name === table)?.records ?? []
}
function historyGroups(rows) {
  const groups = new Map()
  for (const record of rows) {
    const match = /^([a-zA-Z0-9_-]{1,128}):\d{10}$/u.exec(record.key)
    if (!match) throw new Error('Unsupported history key')
    const group = groups.get(match[1]) ?? []
    group.push(record); groups.set(match[1], group)
  }
  return groups
}
async function check(unit, operation) {
  try { return await operation() }
  catch {
    // Imported Personas, prompts, credential values and arbitrary validator
    // exception messages must never become an HTTP error projection.
    const error = new PrismFlowDataBackupError(`Backup configuration cannot initialize ${unit}; nothing was imported. Keep the original backup and inspect this unit's history/schema.`)
    error.unit = unit
    throw error
  }
}

/**
 * Reuse target-runtime validation against detached in-memory tables. No Service
 * init hook runs, no domain or writer lease opens, no Bundle executes, and no
 * imported value or target file is modified during this preflight.
 */
export async function validateConfigurationStartup(parsed, personalPlugins = []) {
  const { payload } = parsed
  await check('prismflow_generator_workflows', () => {
    const store = new PrismGeneratorWorkflowStore(new Context())
    for (const [id, group] of historyGroups(records(payload, 'prismflow_generator_workflows', 'history'))) {
      store.historyTable = new SnapshotTable(group)
      store.rows(id)
    }
  })
  await check('prismflow_generator_prompts', () => {
    const store = new PrismGeneratorPromptStore(new Context())
    for (const [id, group] of historyGroups(records(payload, 'prismflow_generator_prompts', 'history'))) {
      store.historyTable = new SnapshotTable(group)
      store.historyRows({ id })
    }
  })
  const toolset = await check('prismflow_toolsets', async () => {
    const store = new PrismToolsetStore(new Context())
    store.table = new SnapshotTable(records(payload, 'prismflow_toolsets', 'records'))
    store.materializeSkill = async () => {} // preflight never writes Skill Bundles
    for (const plugin of personalPlugins) if (plugin.origin === 'personal') store.personalPluginManifests.set(plugin.pluginId, structuredClone(plugin))
    await store.bootstrap()
    await store.bootstrapPromptSuggestions()
    store.listSkills(); store.getPromptSuggestions()
    return store.getToolset()
  })
  await check('prismflow_image_generation_settings', () => {
    const store = new PrismImageGenerationSettingsStore(new Context())
    for (const table of ['current', 'history']) for (const record of records(payload, 'prismflow_image_generation_settings', table)) {
      const value = JSON.parse(record.value)
      store.current = new SnapshotTable([{ key: 'current', value: record.value }])
      store.get()
      if (record.key !== (table === 'current' ? 'current' : String(value.version))) throw new Error('Image settings key mismatch')
    }
  })
  await check('prismflow_source_settings', () => {
    const table = new SnapshotTable(records(payload, 'prismflow_source_settings', 'sources'))
    readCategoryCatalog(table)
    const slots = new Set(payload.sourceCredentialSlots.map(slot => slot.id))
    for (const [key, value] of table.entries()) {
      if (key === CATEGORY_CATALOG_KEY) continue
      if (key.startsWith('@adapter:')) {
        if (!value || value.kind !== 'adapter-state' || key !== `@adapter:${value.type}`
          || !['rss', 'follow', 'github-trending', 'ai-search'].includes(value.type) || typeof value.enabled !== 'boolean') throw new Error('Invalid adapter state')
        continue
      }
      const source = normalizeManagedSource(value, value, new Date(value?.updatedAt ?? 0))
      if (source.settingsId !== key || source.credentialSlotId && !slots.has(source.credentialSlotId)) throw new Error('Invalid source binding')
    }
  })
  return { startupValidated: true, enabledPluginCount: toolset.enabledPlugins.length }
}
