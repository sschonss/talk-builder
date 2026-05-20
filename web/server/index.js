import express from 'express'
import cors from 'cors'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { indexTalk, removeTalk, searchChats, searchSlides, stats as indexStats } from './db.js'
import { loadConfig, saveConfig, redactConfig, CONFIG_PATH } from './config.js'
import { listProviders, runProvider, streamProvider, checkProvider, PROVIDER_IDS } from './providers.js'
import { startWorker, embedStats, checkOllama, processBatch } from './embeddings.js'
import { similarTalks, searchSemantic } from './similar.js'

const TALKS_DIR = path.join(os.homedir(), 'Documents/talks')
const ENGINE_DIR = path.join(os.homedir(), 'Documents/talk-builder')
const BUILD_SH   = path.join(ENGINE_DIR, 'build.sh')

const app = express()
app.use(cors())
app.use(express.json({ limit: '10mb' }))

// ---------- helpers ----------
function slugify(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'untitled'
}

function listTalks() {
  if (!fs.existsSync(TALKS_DIR)) return []
  return fs.readdirSync(TALKS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => {
      const dir = path.join(TALKS_DIR, d.name)
      const slidesPath = path.join(dir, 'slides.json')
      const chatPath   = path.join(dir, 'chat.json')
      const hasSlides  = fs.existsSync(slidesPath)
      let title = d.name
      if (hasSlides) {
        try { title = JSON.parse(fs.readFileSync(slidesPath, 'utf-8'))?.presentation?.title || d.name } catch {}
      }
      return {
        slug: d.name,
        title,
        has_slides: hasSlides,
        has_chat: fs.existsSync(chatPath),
        modified: fs.statSync(dir).mtimeMs,
      }
    })
    .sort((a, b) => b.modified - a.modified)
}

function ensureTalkDir(slug) {
  const dir = path.join(TALKS_DIR, slug)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function loadChat(slug) {
  const file = path.join(TALKS_DIR, slug, 'chat.json')
  if (!fs.existsSync(file)) return []
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')) } catch { return [] }
}
function saveChat(slug, messages) {
  ensureTalkDir(slug)
  fs.writeFileSync(path.join(TALKS_DIR, slug, 'chat.json'), JSON.stringify(messages, null, 2))
  reindex(slug)
}

function loadSlides(slug) {
  const file = path.join(TALKS_DIR, slug, 'slides.json')
  if (!fs.existsSync(file)) return null
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')) } catch { return null }
}
function saveSlides(slug, json) {
  ensureTalkDir(slug)
  rotateSnapshot(slug)
  fs.writeFileSync(path.join(TALKS_DIR, slug, 'slides.json'), JSON.stringify(json, null, 2))
  reindex(slug)
}

function rotateSnapshot(slug) {
  const dir = path.join(TALKS_DIR, slug)
  const src = path.join(dir, 'slides.json')
  if (!fs.existsSync(src)) return
  const histDir = path.join(dir, '.history')
  fs.mkdirSync(histDir, { recursive: true })
  const s1 = path.join(histDir, 'slides-1.json')
  const s2 = path.join(histDir, 'slides-2.json')
  const s3 = path.join(histDir, 'slides-3.json')
  try {
    if (fs.existsSync(s2)) fs.copyFileSync(s2, s3)
    if (fs.existsSync(s1)) fs.copyFileSync(s1, s2)
    fs.copyFileSync(src, s1)
  } catch (e) {
    console.warn(`[snapshot] failed for ${slug}:`, e.message)
  }
}

function backupBeforeLLM(slug) {
  const dir = path.join(TALKS_DIR, slug)
  const src = path.join(dir, 'slides.json')
  if (!fs.existsSync(src)) return
  const histDir = path.join(dir, '.history')
  fs.mkdirSync(histDir, { recursive: true })
  try { fs.copyFileSync(src, path.join(histDir, 'latest.bak.json')) } catch (e) {
    console.warn(`[backup] failed for ${slug}:`, e.message)
  }
}

function restoreFromBackup(slug) {
  const dir = path.join(TALKS_DIR, slug)
  const bak = path.join(dir, '.history', 'latest.bak.json')
  if (!fs.existsSync(bak)) return false
  try {
    fs.copyFileSync(bak, path.join(dir, 'slides.json'))
    return true
  } catch { return false }
}

async function buildSimilarContext(slug, userMessage) {
  try {
    const mod = await import('./similar.js')
    return await mod.buildSimilarContext(slug, userMessage)
  } catch { return '' }
}

function loadSnapshots(slug, max = 3) {
  const histDir = path.join(TALKS_DIR, slug, '.history')
  const out = []
  for (let i = 1; i <= max; i++) {
    const p = path.join(histDir, `slides-${i}.json`)
    if (fs.existsSync(p)) {
      try { out.push(JSON.parse(fs.readFileSync(p, 'utf-8'))) } catch {}
    }
  }
  return out
}

function reindex(slug) {
  try {
    indexTalk(slug, { slides: loadSlides(slug), messages: loadChat(slug) })
  } catch (e) {
    console.warn(`[index] failed for ${slug}:`, e.message)
  }
}

function reindexAll() {
  if (!fs.existsSync(TALKS_DIR)) return
  for (const d of fs.readdirSync(TALKS_DIR, { withFileTypes: true })) {
    if (d.isDirectory() && !d.name.startsWith('.')) reindex(d.name)
  }
}

// ---------- provider wrapper ----------
function runLLM(prompt, { timeoutMs = 600_000 } = {}) {
  const cfg = loadConfig()
  return runProvider(cfg.provider, prompt, cfg)
}

// Try to find a JSON object inside the raw reply (slides.json content)
function extractSlidesJson(raw) {
  // Look for ```json ... ``` fenced block first
  const fenced = raw.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/)
  if (fenced) {
    try { return JSON.parse(fenced[1]) } catch {}
  }
  // Fallback: try to find first balanced { ... } that has "presentation"
  const idx = raw.indexOf('{"presentation"')
  if (idx >= 0) {
    let depth = 0
    for (let i = idx; i < raw.length; i++) {
      if (raw[i] === '{') depth++
      else if (raw[i] === '}') {
        depth--
        if (depth === 0) {
          try { return JSON.parse(raw.slice(idx, i + 1)) } catch { break }
        }
      }
    }
  }
  return null
}

function stripSlidesBlock(raw) {
  return raw.replace(/```(?:json)?\s*\{[\s\S]*?\}\s*```/g, '').trim()
}

// ---------- system prompt ----------
function systemPrompt() {
  return `Você é um co-autor de palestras técnicas para devs no Brasil.

Seu trabalho é conversar com a pessoa pra construir uma apresentação técnica que vira um JSON consumido pelo talk-builder.

# Tom
- Português brasileiro, direto e conversacional.
- Nunca use em-dashes (—). Use vírgulas, dois pontos ou ponto final.
- Bullets curtos (até ~70 caracteres) pra não quebrar layout.
- Cite fontes no campo "quote" quando trouxer dados externos. Pode usar suas tools de busca na web.

# Como você responde
1. Texto livre conversando com a pessoa (curto).
2. SEMPRE que houver mudanças no deck, devolva o slides.json COMPLETO atualizado dentro de um bloco \`\`\`json ... \`\`\`. Não devolva diff, devolva o JSON inteiro.
3. Se o usuário só perguntou algo (sem pedir alteração), responda só com texto.

# Schema do slides.json
\`\`\`
{
  "presentation": { "title": "...", "subtitle": "...", "author": "...", "event": "..." },
  "theme": { "config": { "colors": {...}, "fonts": {...} } },
  "slides": [
    { "order": 0, "template": "cover", "data": { "title": "...", "subtitle": "...", "author": "...", "event": "..." } },
    ...
  ]
}
\`\`\`

# Templates disponíveis
- cover: capa (title, subtitle, author, event)
- bio: apresentação pessoal (name, role, bullets[], github, linkedin?, website?)
- agenda: roteiro (title, items[])
- section: divisória (number, title)
- question: pergunta grande (question)
- content: bullets + quote opcional (title, bullets[], quote?)
- comparison: 2 colunas (title, left_title, left_items[], right_title, right_items[])
- diagram: mermaid (title, caption, mermaid_code)
- code: snippet (title, code, language)
- story: linha do tempo (title, steps:[{time, event}])
- metrics: KPIs (title, stats:[{label, before, after}], footnote?)
- closing: frase de impacto (text)
- takeaways: pontos pra levar (title, items[])
- transition: transição curta
- credits: agradecimento (title, contacts[], references[])

# Boas práticas
- Pergunte 1 coisa por vez antes de gerar o deck inteiro.
- Comece sempre confirmando: tema, público, duração e tom.
- Sugira estrutura em atos (3-7 seções).
- Quando atualizar o deck, mantenha tudo que já existia e só ajuste o que foi pedido.
- Se o usuário pedir pesquisa, use suas tools de web e cite fontes nas slides com quote.
`
}

function buildTurnPrompt({ slug, talkTitle, slides, history, message, snapshots = [], similarContext = '' }) {
  const recent = history.slice(-10)
  const historyBlock = recent.length
    ? recent.map(t => `${t.role.toUpperCase()}: ${t.content}`).join('\n\n')
    : '(sem histórico ainda)'
  const deckBlock = slides
    ? '```json\n' + JSON.stringify(slides, null, 2) + '\n```'
    : '(ainda não existe slides.json para esta talk)'

  let snapshotBlock = ''
  if (snapshots.length) {
    snapshotBlock = '\n# Versões anteriores deste deck (mais recente primeiro, para você ver a evolução)\n'
      + snapshots.map((s, i) => `## Versão -${i + 1}\n\`\`\`json\n${JSON.stringify(s, null, 2).slice(0, 4000)}\n\`\`\``).join('\n\n')
  }

  let contextBlock = ''
  if (similarContext) {
    contextBlock = `\n# Trechos relevantes de outras talks do usuário (apenas como referência de estilo/temas, não copie)\n${similarContext}\n`
  }

  return `${systemPrompt()}

# Talk atual
slug: ${slug}
título sugerido: ${talkTitle}

# Deck atual
${deckBlock}
${snapshotBlock}
${contextBlock}
# Histórico recente
${historyBlock}

# Nova mensagem do usuário
${message}
`
}

// ---------- routes ----------
app.get('/api/health', async (_req, res) => {
  const cfg = loadConfig()
  const providers = listProviders(cfg)
  const active = providers.find(p => p.id === cfg.provider) || null
  res.json({
    provider: cfg.provider,
    active_ok: !!(active && active.configured),
    providers,
    talks_dir: TALKS_DIR,
    engine_dir: ENGINE_DIR,
    copilot: providers.find(p => p.id === 'copilot')?.configured || false,
  })
})

app.get('/api/settings', (_req, res) => {
  res.json({ ...redactConfig(loadConfig()), providers: listProviders(loadConfig()), config_path: CONFIG_PATH })
})

app.post('/api/providers/test', async (req, res) => {
  const stored = loadConfig()
  const body = req.body || {}
  const draft = { ...stored }
  for (const k of ['provider', 'anthropic_api_key', 'anthropic_model', 'openai_api_key', 'openai_model', 'copilot_binary', 'copilot_model', 'claude_binary', 'claude_model', 'opencode_binary', 'opencode_model']) {
    if (k in body && body[k] !== undefined && body[k] !== '') draft[k] = body[k]
  }
  const id = body.provider || draft.provider
  const check = checkProvider(id, draft)
  if (!check.ok) return res.status(400).json({ ok: false, error: `provider ${id} não configurado` })
  const started = Date.now()
  try {
    const out = await Promise.race([
      runProvider(id, 'Responda apenas com a palavra: pong', draft),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 30s')), 30_000)),
    ])
    const sample = String(out || '').trim().slice(0, 200)
    res.json({ ok: true, ms: Date.now() - started, sample, provider: id })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, ms: Date.now() - started, provider: id })
  }
})

app.post('/api/settings', (req, res) => {
  const body = req.body || {}
  const allowed = ['provider', 'anthropic_api_key', 'anthropic_model', 'openai_api_key', 'openai_model', 'copilot_binary', 'copilot_model', 'claude_binary', 'claude_model', 'opencode_binary', 'opencode_model']
  const patch = {}
  for (const k of allowed) {
    if (k in body && body[k] !== undefined) patch[k] = body[k]
  }
  if (patch.provider && !PROVIDER_IDS.includes(patch.provider)) {
    return res.status(400).json({ error: `provider inválido: ${patch.provider}` })
  }
  const saved = saveConfig(patch)
  res.json({ ...redactConfig(saved), providers: listProviders(saved) })
})

app.get('/api/talks', (_req, res) => res.json({ talks: listTalks() }))

app.post('/api/talks', async (req, res) => {
  const { title } = req.body || {}
  if (!title) return res.status(400).json({ error: 'title obrigatório' })
  const slug = slugify(title)
  const dir = ensureTalkDir(slug)
  if (!fs.existsSync(path.join(dir, 'slides.json'))) {
    const { pickThemeForTitle, getTheme } = await import('./themes.js')
    const themeId = pickThemeForTitle(title)
    const theme = getTheme(themeId)
    saveSlides(slug, {
      presentation: { title, subtitle: '', author: '', event: '' },
      theme: { id: themeId, config: theme.config },
      slides: [],
    })
  }
  res.json({ slug })
})

app.get('/api/talks/:slug', (req, res) => {
  const { slug } = req.params
  const slides = loadSlides(slug)
  const messages = loadChat(slug)
  if (!slides && !messages.length) return res.status(404).json({ error: 'talk não encontrada' })
  const slidesPath = path.join(TALKS_DIR, slug, 'slides.json')
  const slides_mtime = fs.existsSync(slidesPath) ? fs.statSync(slidesPath).mtimeMs : null
  res.json({ slug, slides, messages, slides_mtime })
})

app.patch('/api/talks/:slug', (req, res) => {
  const { slug } = req.params
  const { title } = req.body || {}
  if (!title || !title.trim()) return res.status(400).json({ error: 'title obrigatório' })
  const slides = loadSlides(slug)
  if (!slides) return res.status(404).json({ error: 'talk não encontrada' })
  slides.presentation = slides.presentation || {}
  slides.presentation.title = title.trim()
  saveSlides(slug, slides)
  res.json({ ok: true, slug, title: title.trim() })
})

app.delete('/api/talks/:slug', (req, res) => {
  const dir = path.join(TALKS_DIR, req.params.slug)
  if (!dir.startsWith(TALKS_DIR + path.sep)) return res.status(400).json({ error: 'slug inválido' })
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  removeTalk(req.params.slug)
  res.json({ ok: true })
})

app.post('/api/talks/:slug/message', async (req, res) => {
  const { slug } = req.params
  const { content } = req.body || {}
  if (!content) return res.status(400).json({ error: 'content obrigatório' })

  const slides = loadSlides(slug)
  const history = loadChat(slug)
  const talkTitle = slides?.presentation?.title || slug
  const snapshots = loadSnapshots(slug, 3)
  const similarContext = await buildSimilarContext(slug, content).catch(() => '')

  const prompt = buildTurnPrompt({ slug, talkTitle, slides, history, message: content, snapshots, similarContext })

  history.push({ role: 'user', content, ts: Date.now() })

  backupBeforeLLM(slug)

  let raw
  try {
    raw = await runLLM(prompt)
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) })
  }

  let updatedSlides = extractSlidesJson(raw)
  if (updatedSlides) {
    if (!updatedSlides.presentation || !Array.isArray(updatedSlides.slides)) {
      console.warn(`[guard] LLM retornou slides.json inválido para ${slug}; revertendo`)
      restoreFromBackup(slug)
      updatedSlides = null
    }
  }
  const reply = stripSlidesBlock(raw) || (updatedSlides ? 'Deck atualizado.' : raw)

  history.push({
    role: 'assistant',
    content: reply,
    slides_updated: !!updatedSlides,
    ts: Date.now(),
  })
  saveChat(slug, history)

  if (updatedSlides) saveSlides(slug, updatedSlides)

  const slidesPath = path.join(TALKS_DIR, slug, 'slides.json')
  const slides_mtime = fs.existsSync(slidesPath) ? fs.statSync(slidesPath).mtimeMs : null
  res.json({ reply, slides_updated: !!updatedSlides, slides: updatedSlides || slides, slides_mtime })
})

app.post('/api/talks/:slug/build', (req, res) => {
  const { slug } = req.params
  const dir = path.join(TALKS_DIR, slug)
  if (!fs.existsSync(path.join(dir, 'slides.json'))) {
    return res.status(404).json({ error: 'slides.json não existe' })
  }
  const mode = req.body?.quick ? 'quick' : ''
  const args = mode ? [dir, mode] : [dir]
  const child = spawn(BUILD_SH, args, { cwd: ENGINE_DIR })
  const log = []
  child.stdout.on('data', d => log.push(d.toString()))
  child.stderr.on('data', d => log.push(d.toString()))
  child.on('close', code => {
    if (code !== 0) return res.status(500).json({ ok: false, log: log.join('') })
    const slideTitle = (loadSlides(slug)?.presentation?.title) || slug
    const pptxSlug = slugify(slideTitle)
    const pptxPath = path.join(dir, 'output', `${pptxSlug}.pptx`)
    res.json({ ok: true, pptx: pptxPath, log: log.join('') })
  })
})

function sseInit(res) {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()
}

function sseSend(res, event, data) {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

app.post('/api/talks/:slug/message/stream', async (req, res) => {
  const { slug } = req.params
  const { content } = req.body || {}
  if (!content) return res.status(400).json({ error: 'content obrigatório' })

  sseInit(res)
  const cfg = loadConfig()
  const slides = loadSlides(slug)
  const history = loadChat(slug)
  const talkTitle = slides?.presentation?.title || slug
  const snapshots = loadSnapshots(slug, 3)
  const similarContext = await buildSimilarContext(slug, content).catch(() => '')
  const prompt = buildTurnPrompt({ slug, talkTitle, slides, history, message: content, snapshots, similarContext })

  history.push({ role: 'user', content, ts: Date.now() })
  backupBeforeLLM(slug)

  let raw = ''
  try {
    const gen = streamProvider(cfg.provider, prompt, cfg)
    sseSend(res, 'start', { provider: cfg.provider, model: cfg[`${cfg.provider}_model`] || 'default' })
    for await (const chunk of gen) {
      if (typeof chunk === 'string') {
        raw += chunk
        sseSend(res, 'chunk', { text: chunk })
      } else if (chunk && chunk.stderr) {
        sseSend(res, 'log', { text: chunk.stderr })
      }
    }
  } catch (e) {
    sseSend(res, 'error', { error: String(e.message || e) })
    return res.end()
  }

  let updatedSlides = extractSlidesJson(raw)
  if (updatedSlides) {
    if (!updatedSlides.presentation || !Array.isArray(updatedSlides.slides)) {
      restoreFromBackup(slug)
      updatedSlides = null
    }
  }
  const reply = stripSlidesBlock(raw) || (updatedSlides ? 'Deck atualizado.' : raw)

  history.push({ role: 'assistant', content: reply, slides_updated: !!updatedSlides, ts: Date.now() })
  saveChat(slug, history)
  if (updatedSlides) saveSlides(slug, updatedSlides)

  const slidesPath = path.join(TALKS_DIR, slug, 'slides.json')
  const slides_mtime = fs.existsSync(slidesPath) ? fs.statSync(slidesPath).mtimeMs : null

  sseSend(res, 'done', {
    reply,
    slides_updated: !!updatedSlides,
    slides: updatedSlides || slides,
    slides_mtime,
  })
  res.end()
})

app.post('/api/talks/:slug/build/stream', (req, res) => {
  const { slug } = req.params
  const dir = path.join(TALKS_DIR, slug)
  if (!fs.existsSync(path.join(dir, 'slides.json'))) {
    return res.status(404).json({ error: 'slides.json não existe' })
  }
  sseInit(res)
  const mode = req.body?.quick ? 'quick' : ''
  const debug = !!req.body?.debug
  const args = mode ? [dir, mode] : [dir]
  const startedAt = Date.now()
  sseSend(res, 'start', { mode: mode || 'full', startedAt })
  const env = {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
  }
  if (debug) env.TALK_BUILDER_DEBUG = '1'
  const useStdbuf = process.platform === 'linux'
  const cmd = useStdbuf ? 'stdbuf' : BUILD_SH
  const cmdArgs = useStdbuf ? ['-oL', '-eL', BUILD_SH, ...args] : args
  const child = spawn(cmd, cmdArgs, { cwd: ENGINE_DIR, env })
  let spawnFailed = false
  const tick = setInterval(() => {
    sseSend(res, 'heartbeat', { elapsed_ms: Date.now() - startedAt })
  }, 2000)
  child.on('error', err => {
    spawnFailed = true
    clearInterval(tick)
    sseSend(res, 'log', { text: `[spawn error] ${err.message}\ncmd: ${cmd} ${cmdArgs.join(' ')}\ncwd: ${ENGINE_DIR}\n`, stream: 'stderr', elapsed_ms: Date.now() - startedAt })
    sseSend(res, 'error', { code: -1, message: err.message, elapsed_ms: Date.now() - startedAt })
    try { res.end() } catch {}
  })
  child.stdout.on('data', d => sseSend(res, 'log', { text: d.toString(), stream: 'stdout', elapsed_ms: Date.now() - startedAt }))
  child.stderr.on('data', d => sseSend(res, 'log', { text: d.toString(), stream: 'stderr', elapsed_ms: Date.now() - startedAt }))
  child.on('close', code => {
    if (spawnFailed) return
    clearInterval(tick)
    const elapsed_ms = Date.now() - startedAt
    if (code !== 0) { sseSend(res, 'error', { code, elapsed_ms }); return res.end() }
    const slideTitle = (loadSlides(slug)?.presentation?.title) || slug
    const pptxSlug = slugify(slideTitle)
    const pptxPath = path.join(dir, 'output', `${pptxSlug}.pptx`)
    sseSend(res, 'done', { ok: true, pptx: pptxPath, elapsed_ms })
    res.end()
  })
  let finished = false
  child.on('close', () => { finished = true })
  res.on('close', () => {
    if (finished) return
    clearInterval(tick)
    try { child.kill('SIGTERM') } catch {}
  })
})

app.post('/api/talks/:slug/plan', async (req, res) => {
  const { slug } = req.params
  const { content } = req.body || {}
  if (!content) return res.status(400).json({ error: 'content obrigatório' })
  const slides = loadSlides(slug)
  if (!slides) return res.status(404).json({ error: 'talk não encontrada' })
  const cfg = loadConfig()
  const chatHistory = loadChat(slug)
  const similarContext = await buildSimilarContext(slug, content).catch(() => '')
  try {
    const { planActions } = await import('./planner.js')
    const { setPlan, estimateTokens } = await import('./plans.js')
    const result = await planActions({ slides, userPrompt: content, chatHistory, similarContext, cfg })
    if (!result.ok) return res.status(422).json({ error: result.error, raw: result.raw })

    const state = setPlan(slug, result.plan, content)
    state.tokens.in = estimateTokens(result.raw ? result.raw.length * 0 : 0)

    const history = loadChat(slug)
    history.push({
      role: 'user', content, ts: Date.now(),
    })
    const msgIndex = history.length
    history.push({
      role: 'assistant', kind: 'plan', plan: result.plan, status: 'awaiting',
      progress: {}, tokens: { in: 0, out: 0 }, userPrompt: content, ts: Date.now(),
    })
    state.msgIndex = msgIndex
    saveChat(slug, history)

    res.json({ plan: result.plan, raw: result.raw, msg_index: msgIndex })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})

app.get('/api/talks/:slug/plan/state', async (req, res) => {
  const { getPlan } = await import('./plans.js')
  const s = getPlan(req.params.slug)
  if (!s) return res.json({ active: false })
  const { listeners, ...rest } = s
  res.json({ active: true, state: rest })
})

app.post('/api/talks/:slug/plan/cancel', async (req, res) => {
  const { cancelPlan } = await import('./plans.js')
  res.json({ cancelled: cancelPlan(req.params.slug) })
})

app.get('/api/talks/:slug/plan/stream', async (req, res) => {
  const { getPlan, subscribePlan } = await import('./plans.js')
  const s = getPlan(req.params.slug)
  sseInit(res)
  if (!s) {
    sseSend(res, 'no_plan', {})
    return res.end()
  }
  sseSend(res, 'snapshot', {
    plan: s.plan, status: s.status, currentIndex: s.currentIndex,
    progress: s.progress, tokens: s.tokens, error: s.error, userPrompt: s.userPrompt,
  })
  const unsub = subscribePlan(req.params.slug, (event, data) => {
    sseSend(res, event, data)
    if (event === 'all_done' || event === 'cancelled') {
      setTimeout(() => { try { res.end() } catch {} }, 100)
    }
  })
  res.on('close', () => { unsub() })
})

app.post('/api/talks/:slug/execute/stream', async (req, res) => {
  const { slug } = req.params
  const { plan: bodyPlan } = req.body || {}
  const slides = loadSlides(slug)
  if (!slides) return res.status(404).json({ error: 'talk não encontrada' })

  const { getPlan, setPlan, updatePlan, emitPlanEvent, clearPlan } = await import('./plans.js')
  let state = getPlan(slug)
  if (!state || (bodyPlan && bodyPlan !== state.plan)) {
    if (bodyPlan) state = setPlan(slug, bodyPlan, req.body?.user_prompt || '')
  }
  if (!state) return res.status(400).json({ error: 'sem plano ativo' })
  if (state.status === 'running') return res.status(409).json({ error: 'plano já em execução' })

  sseInit(res)
  const cfg = loadConfig()
  backupBeforeLLM(slug)

  let work = JSON.parse(JSON.stringify(slides))
  let anyApplied = false
  const { planActionLLM, applyAction, isParallelSafe } = await import('./executor.js')

  updatePlan(slug, { status: 'running', cancelled: false, error: null })
  const startEv = { total: state.plan.actions.length, preamble: state.plan.preamble, concurrency: cfg.planner_concurrency || 1 }
  sseSend(res, 'start', startEv)
  emitPlanEvent(slug, 'start', startEv)

  let clientClosed = false
  res.on('close', () => { clientClosed = true })

  const concurrency = Math.max(1, Math.min(8, cfg.planner_concurrency || 3))
  const useCache = cfg.cache_enabled !== false

  function emit(ev, data) {
    if (!clientClosed) sseSend(res, ev, data)
    emitPlanEvent(slug, ev, data)
  }

  async function runSingle(i, snapshot) {
    const action = state.plan.actions[i]
    const t0 = Date.now()
    state.currentIndex = i
    emit('action_start', { i, action })
    state.progress[i] = { status: 'running', attempt: 1, chunks: 0 }
    try {
      const r = await planActionLLM({
        slides: snapshot, action, cfg, useCache,
        onChunk: (text, meta) => {
          state.progress[i].chunks = (state.progress[i].chunks || 0) + text.length
          emit('action_chunk', { i, text: text.slice(0, 400), len: text.length, cached: !!meta?.cached })
        },
      })
      state.tokens.in += r.tokens_in || 0
      state.tokens.out += r.tokens_out || 0
      if (!r.ok) {
        state.progress[i] = { status: 'error', error: r.error, attempt: state.progress[i]?.attempt || 1 }
        emit('action_error', { i, error: r.error, raw: (r.raw || '').slice(0, 1000), retryable: true, tokens: state.tokens })
        return { ok: false, i, error: r.error }
      }
      return { ok: true, i, llmOutput: r.llmOutput, elapsed_ms: Date.now() - t0, tokens_in: r.tokens_in, tokens_out: r.tokens_out, cached: r.cached }
    } catch (e) {
      const msg = String(e.message || e)
      state.progress[i] = { status: 'error', error: msg }
      emit('action_error', { i, error: msg, retryable: true })
      return { ok: false, i, error: msg }
    }
  }

  let i = 0
  outer: while (i < state.plan.actions.length) {
    if (state.cancelled) {
      emit('cancelled', { at: i })
      updatePlan(slug, { status: 'cancelled' })
      break
    }
    const action = state.plan.actions[i]

    if (concurrency > 1 && isParallelSafe(action)) {
      const batch = []
      let j = i
      while (j < state.plan.actions.length
        && batch.length < concurrency
        && isParallelSafe(state.plan.actions[j])) {
        batch.push(j)
        j++
      }
      const snapshot = JSON.parse(JSON.stringify(work))
      const results = await Promise.all(batch.map(idx => runSingle(idx, snapshot)))

      for (const r of results) {
        if (!r.ok) {
          updatePlan(slug, { status: 'error', error: `Ação ${r.i}: ${r.error}` })
          break outer
        }
        try {
          applyAction(state.plan.actions[r.i], work, r.llmOutput)
          anyApplied = true
          state.progress[r.i] = {
            status: 'done', elapsed_ms: r.elapsed_ms,
            tokens_in: r.tokens_in, tokens_out: r.tokens_out, cached: r.cached,
            attempt: state.progress[r.i]?.attempt || 1,
          }
          emit('action_done', { i: r.i, elapsed_ms: r.elapsed_ms, tokens_in: r.tokens_in, tokens_out: r.tokens_out, cached: r.cached, tokens_total: state.tokens })
        } catch (e) {
          state.progress[r.i] = { status: 'error', error: e.message }
          emit('action_error', { i: r.i, error: e.message, retryable: false })
          updatePlan(slug, { status: 'error', error: e.message })
          break outer
        }
      }
      saveSlides(slug, work)
      i = j
    } else {
      const r = await runSingle(i, work)
      if (!r.ok) {
        updatePlan(slug, { status: 'error', error: `Ação ${i}: ${r.error}` })
        break
      }
      try {
        if (r.llmOutput !== null) applyAction(action, work, r.llmOutput)
        else applyAction(action, work, null)
        anyApplied = true
        state.progress[i] = {
          status: 'done', elapsed_ms: r.elapsed_ms,
          tokens_in: r.tokens_in, tokens_out: r.tokens_out, cached: r.cached,
          attempt: state.progress[i]?.attempt || 1,
        }
        emit('action_done', { i, elapsed_ms: r.elapsed_ms, tokens_in: r.tokens_in, tokens_out: r.tokens_out, cached: r.cached, tokens_total: state.tokens })
      } catch (e) {
        state.progress[i] = { status: 'error', error: e.message }
        emit('action_error', { i, error: e.message, retryable: false })
        updatePlan(slug, { status: 'error', error: e.message })
        break
      }
      saveSlides(slug, work)
      i++
    }
  }

  const slidesPath = path.join(TALKS_DIR, slug, 'slides.json')
  const slides_mtime = fs.existsSync(slidesPath) ? fs.statSync(slidesPath).mtimeMs : null

  if (state.status === 'running') updatePlan(slug, { status: 'done' })

  const history = loadChat(slug)
  if (state.msgIndex != null && history[state.msgIndex] && history[state.msgIndex].kind === 'plan') {
    history[state.msgIndex].status = state.status
    history[state.msgIndex].progress = state.progress
    history[state.msgIndex].tokens = state.tokens
    history[state.msgIndex].slides_updated = anyApplied
    history[state.msgIndex].errorMsg = state.error || null
    saveChat(slug, history)
  }

  const finalEv = { slides: work, slides_mtime, applied: anyApplied, status: state.status, tokens: state.tokens, error: state.error }
  emit('all_done', finalEv)

  setTimeout(() => clearPlan(slug), 60_000)
  if (!clientClosed) res.end()
})

app.patch('/api/talks/:slug/plan', async (req, res) => {
  const { getPlan, updatePlan } = await import('./plans.js')
  const s = getPlan(req.params.slug)
  if (!s) return res.status(404).json({ error: 'sem plano ativo' })
  if (s.status === 'running') return res.status(409).json({ error: 'não dá pra editar durante execução' })
  const { actions } = req.body || {}
  if (!Array.isArray(actions)) return res.status(400).json({ error: 'actions[] obrigatório' })
  const { validatePlan } = await import('./schemas.js')
  const newPlan = { ...s.plan, actions }
  const v = validatePlan(newPlan)
  if (!v.ok) return res.status(422).json({ error: v.error })
  s.plan = newPlan
  s.progress = {}
  updatePlan(req.params.slug, {})
  const history = loadChat(req.params.slug)
  if (s.msgIndex != null && history[s.msgIndex]?.kind === 'plan') {
    history[s.msgIndex].plan = newPlan
    history[s.msgIndex].progress = {}
    saveChat(req.params.slug, history)
  }
  res.json({ plan: newPlan })
})

app.get('/api/themes', async (_req, res) => {
  const { listThemes } = await import('./themes.js')
  res.json({ themes: listThemes() })
})

app.post('/api/talks/:slug/theme', async (req, res) => {
  const { slug } = req.params
  const { id } = req.body || {}
  const { getTheme } = await import('./themes.js')
  const t = getTheme(id)
  if (!t) return res.status(404).json({ error: 'tema não encontrado' })
  const slides = loadSlides(slug)
  if (!slides) return res.status(404).json({ error: 'talk não encontrada' })
  slides.theme = { config: t.config }
  saveSlides(slug, slides)
  res.json({ ok: true, theme: t })
})

app.get('/api/cache/stats', async (_req, res) => {
  const { cacheStats } = await import('./cache.js')
  res.json(cacheStats())
})

app.post('/api/cache/clear', async (_req, res) => {
  const { cacheClear } = await import('./cache.js')
  res.json({ cleared: cacheClear() })
})

app.get('/api/talks/:slug/context-stats', async (req, res) => {
  const { slug } = req.params
  const slides = loadSlides(slug)
  const chat = loadChat(slug)
  if (!slides) return res.status(404).json({ error: 'talk não encontrada' })
  const cfg = loadConfig()
  const tk = (chars) => Math.ceil(chars / 4)
  const chatChars = chat.reduce((a, m) => a + String(m?.content || '').length, 0)
  const slidesJsonChars = JSON.stringify(slides).length
  const summaryChars = (slides.slides || []).reduce((a, s) => a + 40 + (s?.data?.title?.length || 0), 0)
  const classicTok = tk(chatChars + slidesJsonChars)
  const plannerTok = tk(summaryChars + Math.min(chatChars, 2400))
  const threshold = cfg.autocompact_threshold_tokens || 8000
  res.json({
    chat_messages: chat.length,
    chat_chars: chatChars,
    chat_tokens_est: tk(chatChars),
    slides_count: slides.slides?.length || 0,
    slides_json_chars: slidesJsonChars,
    slides_json_tokens_est: tk(slidesJsonChars),
    summary_tokens_est: tk(summaryChars),
    classic_prompt_tokens_est: classicTok,
    planner_prompt_tokens_est: plannerTok,
    autocompact_threshold: threshold,
    should_compact: tk(chatChars) > threshold,
  })
})

app.post('/api/talks/:slug/chat/compact', async (req, res) => {
  const { slug } = req.params
  const { keep_last = 4 } = req.body || {}
  const chat = loadChat(slug)
  if (chat.length <= keep_last + 1) return res.json({ skipped: true, reason: 'pouco contexto para compactar' })
  const cfg = loadConfig()
  const head = chat.slice(0, chat.length - keep_last)
  const tail = chat.slice(chat.length - keep_last)
  const corpus = head.map(m => `[${m.role}] ${String(m.content || '').slice(0, 1200)}`).join('\n')
  const prompt = `Resuma o histórico de chat abaixo em um único parágrafo denso, em português, preservando: decisões tomadas, ajustes pedidos, tom do usuário, padrões recorrentes. Sem emojis. Sem preâmbulo. Devolva apenas o resumo.\n\n---\n${corpus}\n---`
  try {
    const summary = await runProvider(cfg.provider, prompt, cfg)
    const clean = String(summary || '').trim().slice(0, 4000)
    const newHistory = [
      { role: 'system', content: `Resumo de ${head.length} mensagens anteriores: ${clean}`, ts: Date.now(), compacted: true },
      ...tail,
    ]
    saveChat(slug, newHistory)
    res.json({ ok: true, summarized: head.length, kept: tail.length, summary: clean })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})

app.post('/api/talks/:slug/open', (req, res) => {
  const { slug } = req.params
  const dir = path.join(TALKS_DIR, slug)
  const slideTitle = (loadSlides(slug)?.presentation?.title) || slug
  const pptxSlug = slugify(slideTitle)
  const pptxPath = path.join(dir, 'output', `${pptxSlug}.pptx`)
  if (!fs.existsSync(pptxPath)) return res.status(404).json({ error: 'pptx ainda não foi gerado' })
  spawn('open', ['-a', 'Keynote', pptxPath])
  res.json({ ok: true })
})

app.get('/api/index/stats', (_req, res) => res.json({ ...indexStats(), embed: embedStats() }))

app.get('/api/index/embed-status', async (_req, res) => {
  await checkOllama()
  res.json(embedStats())
})

app.post('/api/index/embed-now', async (_req, res) => {
  const r = await processBatch(20)
  res.json({ ...r, ...embedStats() })
})

app.post('/api/index/rebuild', (_req, res) => {
  reindexAll()
  res.json({ ok: true, ...indexStats() })
})

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim()
  const limit = Math.min(parseInt(req.query.limit) || 20, 100)
  const semantic = req.query.semantic === '1'
  if (!q) return res.json({ chats: [], slides: [], semantic: [] })
  try {
    const out = {
      chats: searchChats(q, limit),
      slides: searchSlides(q, limit),
      semantic: [],
    }
    if (semantic) {
      const sem = await searchSemantic(q, { limit })
      out.semantic = sem.results || []
      out.semantic_ok = sem.ok
      out.semantic_error = sem.error
    }
    res.json(out)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.get('/api/talks/:slug/similar', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 5, 20)
  res.json({ results: similarTalks(req.params.slug, limit) })
})

const PORT = process.env.PORT || 5174
app.listen(PORT, () => {
  console.log(`[talk-chat] api on http://localhost:${PORT}`)
  try {
    reindexAll()
    const s = indexStats()
    console.log(`[index] ready: ${s.talks} talks, ${s.chats} chats, ${s.slides} slides @ ${s.db_path}`)
  } catch (e) {
    console.warn('[index] startup reindex failed:', e.message)
  }
  startWorker({ intervalMs: 15000 }).catch(e => console.warn('[worker]', e.message))
})
