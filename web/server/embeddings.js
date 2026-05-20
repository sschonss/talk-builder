import { db } from './db.js'

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434'
const EMBED_MODEL = process.env.EMBED_MODEL || 'nomic-embed-text'

let lastOllamaStatus = { ok: false, checked_at: 0, error: null, model: EMBED_MODEL }

export async function checkOllama() {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const data = await r.json()
    const models = (data.models || []).map(m => m.name)
    const hasModel = models.some(m => m.startsWith(EMBED_MODEL))
    lastOllamaStatus = {
      ok: hasModel,
      checked_at: Date.now(),
      model: EMBED_MODEL,
      error: hasModel ? null : `modelo ${EMBED_MODEL} não encontrado em ollama. Rode: ollama pull ${EMBED_MODEL}`,
      available_models: models,
    }
  } catch (e) {
    lastOllamaStatus = { ok: false, checked_at: Date.now(), error: e.message, model: EMBED_MODEL }
  }
  return lastOllamaStatus
}

export function getOllamaStatus() { return lastOllamaStatus }

export async function generateEmbedding(text) {
  const r = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
    signal: AbortSignal.timeout(30000),
  })
  if (!r.ok) throw new Error(`ollama HTTP ${r.status}: ${await r.text().catch(() => '')}`)
  const data = await r.json()
  if (!Array.isArray(data.embedding)) throw new Error('resposta sem embedding')
  return data.embedding
}

export function vecToBlob(arr) {
  return Buffer.from(new Float32Array(arr).buffer)
}

export function blobToVec(buf) {
  if (!buf) return null
  const f = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
  return Array.from(f)
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return -1
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? -1 : dot / denom
}

const updateChatEmb = db.prepare(`UPDATE chats SET embedding = ?, embed_model = ? WHERE id = ?`)
const updateSlideEmb = db.prepare(`UPDATE slides SET embedding = ?, embed_model = ? WHERE id = ?`)
const pendingChats = db.prepare(`SELECT id, content FROM chats WHERE embedding IS NULL AND length(content) > 0 LIMIT ?`)
const pendingSlides = db.prepare(`SELECT id, content FROM slides WHERE embedding IS NULL AND length(content) > 0 LIMIT ?`)

export function embedStats() {
  const pending_chats = db.prepare(`SELECT COUNT(*) AS n FROM chats WHERE embedding IS NULL`).get().n
  const pending_slides = db.prepare(`SELECT COUNT(*) AS n FROM slides WHERE embedding IS NULL`).get().n
  const done_chats = db.prepare(`SELECT COUNT(*) AS n FROM chats WHERE embedding IS NOT NULL`).get().n
  const done_slides = db.prepare(`SELECT COUNT(*) AS n FROM slides WHERE embedding IS NOT NULL`).get().n
  return { pending_chats, pending_slides, done_chats, done_slides, ollama: lastOllamaStatus }
}

let workerRunning = false
let workerStop = false

export async function processBatch(batchSize = 10) {
  const status = await checkOllama()
  if (!status.ok) return { processed: 0, error: status.error }

  let processed = 0
  for (const row of pendingChats.all(batchSize)) {
    try {
      const vec = await generateEmbedding(row.content.slice(0, 8000))
      updateChatEmb.run(vecToBlob(vec), EMBED_MODEL, row.id)
      processed++
    } catch (e) { console.warn(`[embed:chat ${row.id}] ${e.message}`); break }
  }
  for (const row of pendingSlides.all(batchSize)) {
    try {
      const vec = await generateEmbedding(row.content.slice(0, 8000))
      updateSlideEmb.run(vecToBlob(vec), EMBED_MODEL, row.id)
      processed++
    } catch (e) { console.warn(`[embed:slide ${row.id}] ${e.message}`); break }
  }
  return { processed }
}

export async function startWorker({ intervalMs = 15000 } = {}) {
  if (workerRunning) return
  workerRunning = true
  workerStop = false
  await checkOllama()
  ;(async () => {
    while (!workerStop) {
      try { await processBatch(10) } catch (e) { console.warn('[worker]', e.message) }
      await new Promise(r => setTimeout(r, intervalMs))
    }
    workerRunning = false
  })()
}

export function stopWorker() { workerStop = true }

export function isWorkerRunning() { return workerRunning }
