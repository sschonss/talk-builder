import { runProvider, streamProvider } from './providers.js'
import { validateSlide, summarizeDeck } from './schemas.js'
import { extractJson } from './planner.js'
import { cacheGet, cacheSet } from './cache.js'
import {
  applyEditSlide, applyAddSlides, applyRemoveSlide, applyMoveSlide,
  applySetMeta, applyReplaceSection, applyRegenerateSlide,
  applyBulkEdit, filterSlides,
} from './applies.js'

function neighbors(slides, idx, span = 1) {
  const out = []
  for (let i = Math.max(0, idx - span); i <= Math.min(slides.slides.length - 1, idx + span); i++) {
    if (i !== idx) out.push({ idx: i, slide: slides.slides[i] })
  }
  return out
}

function summaryBlock(slides) {
  const sum = summarizeDeck(slides)
  if (!sum.length) return '(deck vazio)'
  return sum.map(s => `  ${String(s.idx).padStart(3, ' ')}: [${s.template}] ${s.title}`).join('\n')
}

function basePrompt(action, slides) {
  return `Você é um agente de edição de slides. Recebe UMA ação e devolve APENAS o JSON do(s) slide(s) afetado(s).

Resumo do deck completo (para contexto, NÃO regere):
${summaryBlock(slides)}

Apresentação:
${JSON.stringify(slides.presentation || {}, null, 2)}

Ação:
${JSON.stringify(action, null, 2)}
`
}

function singleSlideOutputInstr() {
  return `
Devolva APENAS o JSON do slide novo, dentro de \`\`\`json:

\`\`\`json
{
  "template": "...",
  "data": { ... },
  "notes": null
}
\`\`\`
`
}

function multiSlideOutputInstr() {
  return `
Devolva APENAS um array JSON dos slides novos, dentro de \`\`\`json:

\`\`\`json
[
  { "template": "...", "data": { ... }, "notes": null },
  { "template": "...", "data": { ... }, "notes": null }
]
\`\`\`
`
}

function metaOutputInstr() {
  return `
Devolva APENAS o patch (objeto) a aplicar em 'presentation', dentro de \`\`\`json:

\`\`\`json
{ "title": "...", "author": "..." }
\`\`\`
`
}

function buildPromptForAction(action, slides) {
  let p = basePrompt(action, slides)

  switch (action.type) {
    case 'edit_slide':
    case 'regenerate_slide': {
      const cur = slides.slides[action.idx]
      const nb = neighbors(slides, action.idx)
      p += `\nSlide atual (idx ${action.idx}):\n${JSON.stringify(cur, null, 2)}\n`
      if (nb.length) p += `\nVizinhos (para contexto narrativo):\n${nb.map(n => `idx ${n.idx}:\n${JSON.stringify(n.slide, null, 2)}`).join('\n\n')}\n`
      p += singleSlideOutputInstr()
      break
    }
    case 'add_slides': {
      const after = slides.slides[action.after]
      const next = slides.slides[action.after + 1]
      p += `\nSlide ANTES do ponto de inserção (idx ${action.after}):\n${after ? JSON.stringify(after, null, 2) : '(início do deck)'}\n`
      if (next) p += `\nSlide DEPOIS:\n${JSON.stringify(next, null, 2)}\n`
      p += `\nGere ${action.count} slides novos sobre: "${action.topic}".`
      if (action.template_hint) p += ` Use preferencialmente o template '${action.template_hint}'.`
      p += multiSlideOutputInstr()
      break
    }
    case 'replace_section': {
      const sec = slides.slides.slice(action.start, action.end + 1)
      const before = slides.slides[action.start - 1]
      const after = slides.slides[action.end + 1]
      p += `\nSeção atual (idx ${action.start}..${action.end}):\n${JSON.stringify(sec, null, 2)}\n`
      if (before) p += `\nSlide antes:\n${JSON.stringify(before, null, 2)}\n`
      if (after) p += `\nSlide depois:\n${JSON.stringify(after, null, 2)}\n`
      p += `\nInstrução: ${action.instruction}\n`
      p += multiSlideOutputInstr()
      break
    }
    case 'set_meta': {
      p += `\nPatch sugerido: ${JSON.stringify(action.patch)}\n`
      p += metaOutputInstr()
      break
    }
    case 'bulk_edit': {
      const indices = filterSlides(slides, action.filter)
      const sample = indices.slice(0, 10).map(i => ({ idx: i, slide: slides.slides[i] }))
      p += `\nFilter casou ${indices.length} slides (mostrando até 10 amostras):\n${JSON.stringify(sample, null, 2)}\n`
      p += `\nTransformação: ${action.transform}\n`
      p += `Devolva um objeto JSON com chave por idx do slide a editar:\n\n\`\`\`json\n{\n  "${indices[0] ?? 0}": { "template": "...", "data": { ... }, "notes": null }\n}\n\`\`\`\n`
      break
    }
    default:
      p += singleSlideOutputInstr()
  }
  return p
}

function applyAction(action, slides, llmOutput) {
  switch (action.type) {
    case 'edit_slide':       return applyEditSlide(slides, action.idx, llmOutput)
    case 'regenerate_slide': return applyRegenerateSlide(slides, action.idx, llmOutput)
    case 'add_slides':       return applyAddSlides(slides, action.after, Array.isArray(llmOutput) ? llmOutput : [llmOutput])
    case 'remove_slide':     return applyRemoveSlide(slides, action.idx)
    case 'move_slide':       return applyMoveSlide(slides, action.from, action.to)
    case 'set_meta':         return applySetMeta(slides, llmOutput)
    case 'replace_section':  return applyReplaceSection(slides, action.start, action.end, Array.isArray(llmOutput) ? llmOutput : [llmOutput])
    case 'bulk_edit': {
      const indices = Object.keys(llmOutput).map(Number).sort((a, b) => a - b)
      const replacements = indices.map(i => llmOutput[i])
      return applyBulkEdit(slides, indices, replacements)
    }
    default: throw new Error(`tipo de ação não suportado: ${action.type}`)
  }
}

const NO_LLM = new Set(['remove_slide', 'move_slide'])
const INDEX_SHIFTING = new Set(['add_slides', 'remove_slide', 'move_slide', 'replace_section', 'bulk_edit'])

function estTokens(text) {
  if (!text) return 0
  return Math.ceil(String(text).length / 4)
}

export function isParallelSafe(action) {
  return !INDEX_SHIFTING.has(action.type)
}

async function callLLM(cfg, prompt, { onChunk, useCache = true, signal } = {}) {
  const model = cfg[`${cfg.provider}_model`] || ''
  if (useCache) {
    const hit = cacheGet(cfg.provider, model, prompt)
    if (hit != null) {
      if (onChunk) onChunk(hit, { cached: true })
      return { reply: hit, cached: true }
    }
  }
  let reply
  if (onChunk) {
    let acc = ''
    const gen = streamProvider(cfg.provider, prompt, cfg, { signal })
    for await (const chunk of gen) {
      if (typeof chunk === 'string') {
        acc += chunk
        onChunk(chunk, { cached: false })
      }
    }
    reply = acc
  } else {
    reply = await runProvider(cfg.provider, prompt, cfg)
  }
  if (useCache && reply) cacheSet(cfg.provider, model, prompt, reply)
  return { reply, cached: false }
}

export async function executeAction({ slides, action, cfg, onAttempt, onChunk, useCache = true }) {
  if (NO_LLM.has(action.type)) {
    applyAction(action, slides, null)
    return { ok: true, slides, llm_text: null, tokens_in: 0, tokens_out: 0, cached: false }
  }

  let lastError = null
  let lastRaw = null
  let prompt = ''
  let cachedAny = false
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (onAttempt) onAttempt(attempt)
    prompt = buildPromptForAction(action, slides)
    if (attempt > 1 && lastError) {
      prompt += `\n\nSua tentativa anterior falhou com este erro:\n${lastError}\n\nRaw output anterior (primeiros 800 chars):\n${(lastRaw || '').slice(0, 800)}\n\nCorrija o JSON e tente de novo.`
    }
    try {
      const { reply, cached } = await callLLM(cfg, prompt, { onChunk, useCache })
      cachedAny = cachedAny || cached
      lastRaw = reply
      const json = extractJson(reply)
      if (!json) { lastError = 'LLM não devolveu JSON válido'; continue }
      applyAction(action, slides, json)
      return {
        ok: true, slides, llm_text: reply,
        tokens_in: estTokens(prompt), tokens_out: estTokens(reply),
        cached: cachedAny,
      }
    } catch (e) {
      lastError = e.message
    }
  }
  return {
    ok: false, error: lastError, raw: lastRaw,
    tokens_in: estTokens(prompt), tokens_out: estTokens(lastRaw), cached: cachedAny,
  }
}

export async function planActionLLM({ slides, action, cfg, onChunk, useCache = true, signal, onPrompt }) {
  if (NO_LLM.has(action.type)) {
    return { ok: true, llmOutput: null, tokens_in: 0, tokens_out: 0, cached: false }
  }
  let lastError = null
  let lastRaw = null
  let prompt = ''
  let cachedAny = false
  for (let attempt = 1; attempt <= 2; attempt++) {
    prompt = buildPromptForAction(action, slides)
    if (attempt > 1 && lastError) {
      prompt += `\n\nSua tentativa anterior falhou com este erro:\n${lastError}\n\nRaw output anterior (primeiros 800 chars):\n${(lastRaw || '').slice(0, 800)}\n\nCorrija o JSON e tente de novo.`
    }
    if (onPrompt) onPrompt(prompt, attempt)
    try {
      const { reply, cached } = await callLLM(cfg, prompt, { onChunk, useCache, signal })
      cachedAny = cachedAny || cached
      lastRaw = reply
      const json = extractJson(reply)
      if (!json) { lastError = 'LLM não devolveu JSON válido'; continue }
      return {
        ok: true, llmOutput: json, raw: reply,
        tokens_in: estTokens(prompt), tokens_out: estTokens(reply), cached: cachedAny,
      }
    } catch (e) {
      lastError = e.message
      if (signal?.aborted) break
    }
  }
  return {
    ok: false, error: lastError, raw: lastRaw,
    tokens_in: estTokens(prompt), tokens_out: estTokens(lastRaw), cached: cachedAny,
  }
}

export { applyAction }

export function expandBulkActions(plan, slides) {
  const out = []
  let expanded = false
  for (const action of plan.actions) {
    if (action.type !== 'bulk_edit') { out.push(action); continue }
    const indices = filterSlides(slides, action.filter)
    if (!indices.length) { out.push(action); continue }
    expanded = true
    for (const idx of indices) {
      out.push({
        type: 'edit_slide',
        idx,
        instruction: action.transform,
        _origin: 'bulk_edit',
      })
    }
  }
  return { plan: { ...plan, actions: out }, expanded }
}
