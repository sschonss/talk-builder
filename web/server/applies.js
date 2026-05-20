import { validateSlide } from './schemas.js'

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)) }

export function applyEditSlide(slides, idx, newSlide) {
  const v = validateSlide(newSlide)
  if (!v.ok) throw new Error(`edit_slide: ${v.error}`)
  if (idx < 0 || idx >= slides.slides.length) throw new Error(`edit_slide: idx ${idx} fora dos limites`)
  slides.slides[idx] = newSlide
  return slides
}

export function applyAddSlides(slides, after, newSlides) {
  if (!Array.isArray(newSlides) || newSlides.length === 0) throw new Error('add_slides: lista vazia')
  for (let i = 0; i < newSlides.length; i++) {
    const v = validateSlide(newSlides[i])
    if (!v.ok) throw new Error(`add_slides[${i}]: ${v.error}`)
  }
  const pos = clamp(after + 1, 0, slides.slides.length)
  slides.slides.splice(pos, 0, ...newSlides)
  return slides
}

export function applyRemoveSlide(slides, idx) {
  if (idx < 0 || idx >= slides.slides.length) throw new Error(`remove_slide: idx ${idx} fora dos limites`)
  slides.slides.splice(idx, 1)
  return slides
}

export function applyMoveSlide(slides, from, to) {
  if (from < 0 || from >= slides.slides.length) throw new Error(`move_slide: from ${from} fora dos limites`)
  const item = slides.slides.splice(from, 1)[0]
  const dest = clamp(to, 0, slides.slides.length)
  slides.slides.splice(dest, 0, item)
  return slides
}

export function applySetMeta(slides, patch) {
  slides.presentation = { ...(slides.presentation || {}), ...patch }
  return slides
}

export function applyReplaceSection(slides, start, end, newSlides) {
  if (start < 0 || end >= slides.slides.length || end < start) throw new Error(`replace_section: range inválido`)
  for (let i = 0; i < newSlides.length; i++) {
    const v = validateSlide(newSlides[i])
    if (!v.ok) throw new Error(`replace_section[${i}]: ${v.error}`)
  }
  slides.slides.splice(start, end - start + 1, ...newSlides)
  return slides
}

export function applyRegenerateSlide(slides, idx, newSlide) {
  return applyEditSlide(slides, idx, newSlide)
}

export function applyBulkEdit(slides, indices, replacements) {
  if (indices.length !== replacements.length) throw new Error('bulk_edit: indices/replacements de tamanhos diferentes')
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i]
    const v = validateSlide(replacements[i])
    if (!v.ok) throw new Error(`bulk_edit[${idx}]: ${v.error}`)
    if (idx < 0 || idx >= slides.slides.length) throw new Error(`bulk_edit: idx ${idx} fora`)
    slides.slides[idx] = replacements[i]
  }
  return slides
}

export function filterSlides(slides, filter) {
  const out = []
  const arr = slides.slides || []
  for (let i = 0; i < arr.length; i++) {
    const s = arr[i]
    let match = true
    if (filter.template && s.template !== filter.template) match = false
    if (filter.idx_range) {
      const [lo, hi] = filter.idx_range
      if (i < lo || i > hi) match = false
    }
    if (filter.title_contains) {
      const t = s?.data?.title || ''
      if (!t.toLowerCase().includes(String(filter.title_contains).toLowerCase())) match = false
    }
    if (match) out.push(i)
  }
  return out
}
