import { pathToFileURL } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'

export class PrismToolsetRuntimeError extends Error {
  constructor(message, cause) { super(message, { cause }); this.name = 'PrismToolsetRuntimeError' }
}

/** Own only PrismFlow registrations. Never alter unrelated Host tools. */
export class PrismToolsetRuntime {
  constructor(manager) {
    this.manager = manager
    this.native = new Map()
    this.personal = new Map()
    this.closed = false
  }
  guard(definition, owner) {
    const manager = this.manager
    return { ...definition, async execute(...args) {
      if (owner.closed || owner.failed || !manager.isToolEnabled(definition.name)) {
        throw new PrismToolsetRuntimeError('This PrismFlow tool is disabled by the current toolset')
      }
      const call = Promise.resolve().then(() => definition.execute.apply(definition, args))
      owner.calls.add(call)
      try { return await call } finally { owner.calls.delete(call) }
    } }
  }
  registerNative(ctx, definition) {
    if (this.closed) throw new PrismToolsetRuntimeError('PrismFlow tool runtime is closed')
    if (this.native.has(definition.name)) throw new PrismToolsetRuntimeError(`Duplicate PrismFlow tool binding: ${definition.name}`)
    const binding = { ctx, definition, unregister: undefined, closed: false, failed: false, calls: new Set() }
    binding.guarded = this.guard(definition, binding)
    this.native.set(definition.name, binding)
    try { if (this.manager.isToolEnabled(definition.name)) this.enableNative(binding) }
    catch (error) { this.native.delete(definition.name); throw error }
    const release = async () => {
      if (this.native.get(definition.name) !== binding) return
      binding.closed = true
      await Promise.allSettled([...binding.calls])
      await this.disableNative(binding)
      this.native.delete(definition.name)
    }
    try { return typeof ctx.effect === 'function' ? ctx.effect(() => release, `prismflow:tool-binding:${definition.name}`) : release }
    catch (error) { void release().catch(() => {}); throw error }
  }
  enableNative(binding) {
    if (binding.unregister || binding.closed) return
    if (this.manager.nativeToolDisposers.has(binding.definition.name)) throw new PrismToolsetRuntimeError(`Duplicate PrismFlow tool registration: ${binding.definition.name}`)
    const unregister = binding.ctx.tools.register(binding.guarded)
    if (typeof unregister !== 'function') throw new PrismToolsetRuntimeError('DSH tool registration did not return a disposer')
    binding.unregister = this.manager.trackNativeTool(binding.definition.name, unregister)
    binding.failed = false
  }
  async disableNative(binding) {
    if (!binding.unregister) return
    try { await binding.unregister(); binding.unregister = undefined; binding.failed = false }
    catch (error) { binding.failed = true; throw error }
  }
  async preparePersonal(manifest) {
    const runtime = { definitions: new Map(), tools: new Map(), cleanup: undefined, calls: new Set(), closed: false, failed: false }
    let accepting = true
    const api = Object.freeze({
      pluginId: manifest.pluginId,
      getService: name => this.manager.ctx.get?.(name),
      registerTool: definition => {
        if (!accepting || !definition || typeof definition !== 'object' || !manifest.tools.includes(definition.name) || runtime.definitions.has(definition.name)) {
          throw new PrismToolsetRuntimeError(`Personal plugin declared an invalid or duplicate tool: ${manifest.pluginId}`)
        }
        // Validate every declaration, but publish none until activate completes.
        runtime.definitions.set(definition.name, this.guard(defineTool(definition), runtime))
      },
    })
    try {
      const module = await import(`${pathToFileURL(manifest.entryPath).href}?v=${encodeURIComponent(String(manifest.entryMtimeMs))}`)
      if (typeof module.default !== 'function') throw new Error('Missing activate export')
      const cleanup = await module.default(api)
      if (typeof cleanup === 'function') runtime.cleanup = cleanup
      accepting = false
      if (runtime.definitions.size !== manifest.tools.length) throw new Error('Incomplete tool declarations')
      if (this.closed) throw new Error('Runtime closed during activation')
      return runtime
    } catch (error) {
      accepting = false; runtime.closed = true
      try { await runtime.cleanup?.() } catch (cleanupError) { throw new PrismToolsetRuntimeError(`Personal plugin activation and cleanup failed: ${manifest.pluginId}`, new AggregateError([error, cleanupError])) }
      throw new PrismToolsetRuntimeError(`Personal plugin activation failed: ${manifest.pluginId}`, error)
    }
  }
  async deactivatePersonal(pluginId) {
    const runtime = this.personal.get(pluginId)
    if (!runtime) return
    runtime.closed = true
    const failures = []
    for (const [name, dispose] of [...runtime.tools]) {
      try { await dispose(); runtime.tools.delete(name) } catch (error) { failures.push(error) }
    }
    await Promise.allSettled([...runtime.calls])
    if (!failures.length) {
      try { await runtime.cleanup?.(); runtime.cleanup = undefined } catch (error) { failures.push(error) }
    }
    if (failures.length) { runtime.failed = true; throw new PrismToolsetRuntimeError(`Personal plugin cleanup failed: ${pluginId}`, new AggregateError(failures)) }
    this.personal.delete(pluginId)
  }
  async reconcile(selection, requiredTools = []) {
    if (this.closed) throw new PrismToolsetRuntimeError('PrismFlow tool runtime is closed')
    const enabledPlugins = new Set(selection.enabledPlugins)
    const enabledTools = new Set(selection.enabledTools)
    for (const [id, runtime] of [...this.personal]) {
      if (!enabledPlugins.has(id) || !this.manager.personalPluginManifests.has(id) || runtime.closed || runtime.failed) await this.deactivatePersonal(id)
    }
    // Revoke registrations first. The manager also blocks cached definitions
    // throughout this transition, including a failed/ambiguous disposal.
    for (const binding of this.native.values()) {
      if (!enabledTools.has(binding.definition.name) || binding.failed) await this.disableNative(binding)
    }
    for (const [name, dispose] of [...this.manager.nativeToolDisposers]) {
      if (!this.native.has(name) && !enabledTools.has(name)) await dispose()
    }
    for (const [id, runtime] of this.personal) {
      for (const [name, dispose] of [...runtime.tools]) if (!enabledTools.has(name)) {
        try { await dispose(); runtime.tools.delete(name) }
        catch (error) { runtime.failed = true; throw new PrismToolsetRuntimeError(`Personal tool revocation failed: ${id}`, error) }
      }
    }
    for (const binding of this.native.values()) if (enabledTools.has(binding.definition.name)) this.enableNative(binding)
    for (const manifest of this.manager.personalPluginManifests.values()) {
      if (!manifest.uploaded || !enabledPlugins.has(manifest.pluginId)) continue
      let runtime = this.personal.get(manifest.pluginId)
      if (!runtime) {
        runtime = await this.preparePersonal(manifest)
        this.personal.set(manifest.pluginId, runtime)
      }
      if (this.closed || runtime.closed || runtime.failed) throw new PrismToolsetRuntimeError(`Personal plugin runtime is unavailable: ${manifest.pluginId}`)
      for (const [name, definition] of runtime.definitions) if (enabledTools.has(name) && !runtime.tools.has(name)) {
        try {
          const dispose = this.manager.ctx.tools.register(definition)
          if (typeof dispose !== 'function') throw new Error('Missing tool disposer')
          runtime.tools.set(name, dispose)
        } catch (error) { runtime.failed = true; throw new PrismToolsetRuntimeError(`Personal tool registration failed: ${manifest.pluginId}`, error) }
      }
    }
    for (const name of requiredTools) {
      const registered = this.native.get(name)?.unregister || this.manager.nativeToolDisposers.has(name)
        || [...this.personal.values()].some(runtime => !runtime.closed && !runtime.failed && runtime.tools.has(name))
      if (!registered) throw new PrismToolsetRuntimeError(`Selected personal tool has no ready registration provider: ${name}`)
    }
  }
  status(manifest, selection) {
    const runtime = this.personal.get(manifest.pluginId)
    const selected = selection.enabledPlugins.includes(manifest.pluginId)
    const desired = manifest.tools.filter(name => selection.enabledTools.includes(name))
    const registered = manifest.tools.filter(name => runtime?.tools.has(name) || this.native.get(name)?.unregister && !this.native.get(name)?.failed || this.manager.nativeToolDisposers.has(name))
    const failed = runtime?.failed || runtime?.closed || manifest.tools.some(name => this.native.get(name)?.failed)
    return { state: failed ? 'error' : !selected ? 'disabled' : registered.length === desired.length ? 'active' : 'pending', registeredTools: registered }
  }
  async close() {
    this.closed = true
    const results = await Promise.allSettled([
      ...[...this.personal.keys()].map(id => this.deactivatePersonal(id)),
      ...[...this.native.values()].map(async binding => {
        binding.closed = true
        await Promise.allSettled([...binding.calls])
        await this.disableNative(binding)
      }),
    ])
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (failures.length) throw new PrismToolsetRuntimeError('PrismFlow runtime cleanup failed', new AggregateError(failures))
    this.native.clear()
  }
}
