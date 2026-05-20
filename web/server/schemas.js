export const ACTION_TYPES = [
  'edit_slide',
  'add_slides',
  'remove_slide',
  'move_slide',
  'set_meta',
  'bulk_edit',
  'replace_section',
  'regenerate_slide',
]

export const DESTRUCTIVE = new Set(['remove_slide', 'replace_section'])

const isInt = (v) => Number.isInteger(v)
const isStr = (v) => typeof v === 'string' && v.length > 0
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)

export function validateAction(a) {
  if (!isObj(a) || !isStr(a.type)) return { ok: false, error: 'ação sem type válido' }
  if (!ACTION_TYPES.includes(a.type)) return { ok: false, error: `type desconhecido: ${a.type}` }

  switch (a.type) {
    case 'edit_slide':
      if (!isInt(a.idx) || a.idx < 0) return { ok: false, error: 'edit_slide: idx inválido' }
      if (!isStr(a.instruction)) return { ok: false, error: 'edit_slide: instruction vazia' }
      return { ok: true }
    case 'add_slides':
      if (!isInt(a.after)) return { ok: false, error: 'add_slides: after inválido' }
      if (!isInt(a.count) || a.count < 1 || a.count > 20) return { ok: false, error: 'add_slides: count fora de 1..20' }
      if (!isStr(a.topic)) return { ok: false, error: 'add_slides: topic vazio' }
      return { ok: true }
    case 'remove_slide':
      if (!isInt(a.idx) || a.idx < 0) return { ok: false, error: 'remove_slide: idx inválido' }
      return { ok: true }
    case 'move_slide':
      if (!isInt(a.from) || !isInt(a.to)) return { ok: false, error: 'move_slide: from/to inválidos' }
      return { ok: true }
    case 'set_meta':
      if (!isObj(a.patch)) return { ok: false, error: 'set_meta: patch deve ser objeto' }
      return { ok: true }
    case 'bulk_edit':
      if (!isObj(a.filter)) return { ok: false, error: 'bulk_edit: filter inválido' }
      if (!isStr(a.transform)) return { ok: false, error: 'bulk_edit: transform vazio' }
      return { ok: true }
    case 'replace_section':
      if (!isInt(a.start) || !isInt(a.end) || a.end < a.start) return { ok: false, error: 'replace_section: start/end inválidos' }
      if (!isStr(a.instruction)) return { ok: false, error: 'replace_section: instruction vazia' }
      return { ok: true }
    case 'regenerate_slide':
      if (!isInt(a.idx) || a.idx < 0) return { ok: false, error: 'regenerate_slide: idx inválido' }
      if (!isStr(a.instruction)) return { ok: false, error: 'regenerate_slide: instruction vazia' }
      return { ok: true }
    default:
      return { ok: false, error: 'tipo não tratado' }
  }
}

export function validatePlan(plan) {
  if (!isObj(plan)) return { ok: false, error: 'plano não é objeto' }
  if (!isStr(plan.preamble)) return { ok: false, error: 'plano sem preamble' }
  if (!Array.isArray(plan.actions)) return { ok: false, error: 'plano sem actions[]' }
  if (plan.actions.length === 0) return { ok: false, error: 'plano vazio (0 ações)' }
  if (plan.actions.length > 50) return { ok: false, error: 'plano com mais de 50 ações' }
  for (let i = 0; i < plan.actions.length; i++) {
    const r = validateAction(plan.actions[i])
    if (!r.ok) return { ok: false, error: `ação ${i}: ${r.error}` }
  }
  return { ok: true }
}

export function validateSlide(s) {
  if (!isObj(s)) return { ok: false, error: 'slide não é objeto' }
  if (!isStr(s.template)) return { ok: false, error: 'slide sem template' }
  if (!isObj(s.data)) return { ok: false, error: 'slide sem data' }
  return { ok: true }
}

export function summarizeDeck(slides) {
  const arr = slides?.slides || []
  return arr.map((s, i) => ({
    idx: i,
    title: s?.data?.title || s?.data?.headline || '(sem título)',
    template: s?.template || '?',
  }))
}
