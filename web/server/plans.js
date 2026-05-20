const plans = new Map()

export function setPlan(slug, plan, userPrompt) {
  const state = {
    slug,
    plan,
    userPrompt: userPrompt || '',
    status: 'awaiting',
    currentIndex: -1,
    progress: {},
    cancelled: false,
    error: null,
    tokens: { in: 0, out: 0 },
    msgIndex: null,
    listeners: new Set(),
    logs: {},
    controllers: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  plans.set(slug, state)
  return state
}

export function getPlan(slug) {
  return plans.get(slug) || null
}

export function clearPlan(slug) {
  plans.delete(slug)
}

export function updatePlan(slug, patch) {
  const s = plans.get(slug)
  if (!s) return null
  Object.assign(s, patch)
  s.updatedAt = Date.now()
  return s
}

export function emitPlanEvent(slug, event, data) {
  const s = plans.get(slug)
  if (!s) return
  s.updatedAt = Date.now()
  for (const fn of s.listeners) {
    try { fn(event, data) } catch {}
  }
}

export function subscribePlan(slug, fn) {
  const s = plans.get(slug)
  if (!s) return () => {}
  s.listeners.add(fn)
  return () => s.listeners.delete(fn)
}

export function cancelPlan(slug) {
  const s = plans.get(slug)
  if (!s) return false
  s.cancelled = true
  if (s.controllers) {
    for (const c of Object.values(s.controllers)) {
      try { c.abort() } catch {}
    }
  }
  return true
}

export function cancelAction(slug, i) {
  const s = plans.get(slug)
  if (!s || !s.controllers || !s.controllers[i]) return false
  try { s.controllers[i].abort() } catch {}
  return true
}

export function appendLog(slug, i, patch) {
  const s = plans.get(slug)
  if (!s) return
  if (!s.logs[i]) s.logs[i] = { prompt: '', reply: '', attempts: [] }
  if (patch.prompt != null) s.logs[i].prompt = patch.prompt
  if (patch.attempt != null) s.logs[i].attempts.push({ at: Date.now(), attempt: patch.attempt })
  if (patch.replyChunk) s.logs[i].reply += patch.replyChunk
  if (patch.reset) s.logs[i].reply = ''
  if (patch.cached) s.logs[i].cached = true
  if (patch.error != null) s.logs[i].error = patch.error
}

export function getLog(slug, i) {
  const s = plans.get(slug)
  if (!s || !s.logs[i]) return null
  return s.logs[i]
}

export function estimateTokens(text) {
  if (!text) return 0
  return Math.ceil(String(text).length / 4)
}
