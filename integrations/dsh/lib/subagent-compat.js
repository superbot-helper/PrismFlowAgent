import { randomUUID } from 'node:crypto'

export function canStartSubagent(service) {
  return typeof service?.startActivation === 'function' || typeof service?.start === 'function'
}

/**
 * Bridge the pre-0.2.1 run API and managed activations. New hosts no longer
 * accept per-request Persona/tool filters: install those on the reserved local
 * child's scope before agent/created releases its first turn. Never downgrade a
 * restricted task to an unrestricted external backend or a prompt-only policy.
 */
export async function startPrismFlowSubagent(ctx, provider, options) {
  const service = ctx.subagents ?? ctx.get?.('subagents')
  if (typeof service?.startActivation !== 'function') {
    if (typeof service?.start !== 'function') throw new Error('DSH subagents service is unavailable')
    return service.start(provider, options)
  }

  const { label = 'PrismFlow task', signal, persona, toolFilter, ...request } = options
  signal.throwIfAborted()
  const childId = randomUUID()
  let initialized = false
  if (typeof ctx.on !== 'function') throw new Error('DSH agent initialization hooks are unavailable')
  const removeHook = ctx.on('agent/created', ({ agent }) => {
    if (agent.id !== childId) return
    if (persona !== undefined) {
      const systemPrompt = agent.ctx.systemPrompt
      systemPrompt.section({
        name: 'deployment:persona-prefix',
        order: systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
        text: persona,
      })
    }
    if (toolFilter !== undefined) agent.ctx.tools.restrict(toolFilter)
    initialized = true
  })

  let activation
  try {
    // An explicit childId requires a local provider. Caller delivery avoids
    // injecting workflow/reviewer internals into the parent conversation.
    activation = await service.startActivation({ provider, label, childId, request, signal, delivery: 'caller' })
    if (!initialized) {
      await activation.dispose()
      throw new Error('DSH child initialization did not apply the PrismFlow execution policy')
    }
  } finally {
    removeHook()
  }

  // On 0.2.1 the startup signal stops owning cancellation after publication.
  // Bridge it to exact-activation disposal, retaining failures for the caller's
  // normal result/disposal aggregation. Never target a later resumed child.
  let disposal
  const dispose = () => disposal ??= Promise.resolve().then(() => activation.dispose())
    .finally(() => signal.removeEventListener('abort', abort))
  const abort = () => { void dispose().catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  return {
    id: activation.childId,
    result: Promise.resolve(activation.result).finally(() => signal.removeEventListener('abort', abort)),
    dispose,
  }
}
