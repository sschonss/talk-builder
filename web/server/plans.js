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
  return true
}

export function estimateTokens(text) {
  if (!text) return 0
  return Math.ceil(String(text).length / 4)
}
