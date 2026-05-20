import { runProvider } from './providers.js'
import { validatePlan, summarizeDeck, ACTION_TYPES } from './schemas.js'

function extractJson(text) {
  if (!text) return null
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]+?)\n```/i)
  const candidate = fenced ? fenced[1] : text
  const firstObj = candidate.indexOf('{')
  const firstArr = candidate.indexOf('[')
  let start = -1, openChar = '', closeChar = ''
  if (firstObj === -1 && firstArr === -1) return null
  if (firstObj === -1 || (firstArr !== -1 && firstArr < firstObj)) {
    start = firstArr; openChar = '['; closeChar = ']'
  } else {
    start = firstObj; openChar = '{'; closeChar = '}'
  }
  const end = candidate.lastIndexOf(closeChar)
  if (end < 0 || end < start) return null
  try { return JSON.parse(candidate.slice(start, end + 1)) } catch { return null }
}

function buildPlannerPrompt({ userPrompt, summary, presentation, chatHistory, similarContext }) {
  const recentChat = (chatHistory || []).slice(-6)
    .map(m => `[${m.role}] ${String(m.content || '').slice(0, 400)}`)
    .join('\n')

  const summaryLines = summary.length
    ? summary.map(s => `  ${String(s.idx).padStart(3, ' ')}: [${s.template}] ${s.title}`).join('\n')
    : '  (deck vazio)'

  const sim = similarContext ? `\n\nContexto de talks parecidas:\n${similarContext}\n` : ''

  return `Você é um planejador de edições de slides. Sua única tarefa é converter o pedido do usuário em uma lista de ações estruturadas.

NUNCA gere conteúdo de slides aqui. Apenas decida QUAIS ações devem ser feitas. O conteúdo será gerado depois por outro agente.

Apresentação atual:
- Título: ${presentation?.title || '(sem título)'}
- ${summary.length} slides

Resumo do deck (idx: [template] título):
${summaryLines}

Histórico recente da conversa:
${recentChat || '(nenhum)'}
${sim}
Pedido do usuário:
${userPrompt}

Tipos de ação disponíveis (use só estes):
- edit_slide(idx, instruction): muda um slide existente
- add_slides(after, count, topic, template_hint?): insere N slides depois do idx 'after'
- remove_slide(idx): apaga um slide (DESTRUTIVA)
- move_slide(from, to): reordena
- set_meta(patch): muda metadados da apresentação (title, author, theme)
- bulk_edit(filter, transform): aplica transformação em vários slides (filter: {template?, idx_range?, title_contains?})
- replace_section(start, end, instruction): substitui slides start..end por novos (DESTRUTIVA)
- regenerate_slide(idx, instruction): regenera um slide do zero

Responda APENAS com um JSON neste formato, dentro de \`\`\`json:

\`\`\`json
{
  "preamble": "uma frase explicando o que vai fazer",
  "actions": [
    { "type": "edit_slide", "idx": 12, "instruction": "trocar título para X" },
    { "type": "add_slides", "after": 20, "count": 3, "topic": "exemplos de Y" }
  ]
}
\`\`\`

Regras:
- Use índices 0-based.
- Prefira ações pequenas e específicas. Se o pedido mexe em 5 slides separados, gere 5 edit_slide, não 1 bulk_edit.
- Use bulk_edit só quando a mesma transformação se aplica a um grupo coerente (ex: "deixa todos os títulos em maiúsculas").
- Máximo 50 ações por plano. Se o pedido for muito grande, faça só a primeira parte e diga no preamble.
- Não invente novos tipos de ação.`
}

export async function planActions({ slides, userPrompt, chatHistory, similarContext, cfg }) {
  const summary = summarizeDeck(slides)
  const prompt = buildPlannerPrompt({
    userPrompt,
    summary,
    presentation: slides?.presentation,
    chatHistory,
    similarContext,
  })

  const provider = cfg.planner_provider || cfg.provider
  const subCfg = { ...cfg, provider }
  if (cfg.planner_model) subCfg[`${provider}_model`] = cfg.planner_model

  const reply = await runProvider(provider, prompt, subCfg)
  const json = extractJson(reply)
  if (!json) return { ok: false, error: 'planner não devolveu JSON válido', raw: reply }
  const v = validatePlan(json)
  if (!v.ok) return { ok: false, error: v.error, raw: reply, parsed: json }
  return { ok: true, plan: json, raw: reply }
}

export { extractJson }
