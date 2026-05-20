import { db } from './db.js'
import { generateEmbedding, blobToVec, cosine, checkOllama } from './embeddings.js'

const getTalkSlides = db.prepare(`SELECT title, content, embedding FROM slides WHERE talk_slug = ? AND embedding IS NOT NULL`)
const allTalks = db.prepare(`SELECT slug, title FROM talks`)
const allSlidesWithEmb = db.prepare(`SELECT id, talk_slug, slide_idx, template, title, content, embedding FROM slides WHERE embedding IS NOT NULL`)

function avgVector(vecs) {
  if (!vecs.length) return null
  const dim = vecs[0].length
  const out = new Array(dim).fill(0)
  for (const v of vecs) for (let i = 0; i < dim; i++) out[i] += v[i]
  for (let i = 0; i < dim; i++) out[i] /= vecs.length
  return out
}

export function talkEmbedding(slug) {
  const rows = getTalkSlides.all(slug)
  const vecs = rows.map(r => blobToVec(r.embedding)).filter(Boolean)
  return avgVector(vecs)
}

export function similarTalks(slug, limit = 5) {
  const target = talkEmbedding(slug)
  if (!target) return []
  const out = []
  for (const t of allTalks.all()) {
    if (t.slug === slug) continue
    const v = talkEmbedding(t.slug)
    if (!v) continue
    out.push({ slug: t.slug, title: t.title, score: cosine(target, v) })
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit)
}

export async function searchSemantic(query, { limit = 20, excludeSlug = null } = {}) {
  const status = await checkOllama()
  if (!status.ok) return { ok: false, error: status.error, results: [] }
  let vec
  try { vec = await generateEmbedding(query) } catch (e) { return { ok: false, error: e.message, results: [] } }
  const slides = allSlidesWithEmb.all()
  const scored = []
  for (const s of slides) {
    if (excludeSlug && s.talk_slug === excludeSlug) continue
    const v = blobToVec(s.embedding)
    const score = cosine(vec, v)
    scored.push({ talk_slug: s.talk_slug, slide_idx: s.slide_idx, template: s.template, title: s.title, content: s.content, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return { ok: true, results: scored.slice(0, limit) }
}

export async function buildSimilarContext(slug, userMessage) {
  if (!userMessage || userMessage.length < 5) return ''
  const r = await searchSemantic(userMessage, { limit: 3, excludeSlug: slug })
  if (!r.ok || !r.results.length) return ''
  const lines = r.results
    .filter(x => x.score > 0.5)
    .map(x => `- (${x.talk_slug}, slide ${x.slide_idx + 1}, ${x.template}) ${x.title ? x.title + ': ' : ''}${x.content.slice(0, 300).replace(/\n/g, ' ')}`)
  return lines.join('\n')
}
