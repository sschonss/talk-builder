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

app.post('/api/talks', (req, res) => {
  const { title } = req.body || {}
  if (!title) return res.status(400).json({ error: 'title obrigatório' })
  const slug = slugify(title)
  const dir = ensureTalkDir(slug)
  if (!fs.existsSync(path.join(dir, 'slides.json'))) {
    saveSlides(slug, {
      presentation: { title, subtitle: '', author: '', event: '' },
      theme: { config: { colors: { background: '#000000', primary: '#FFFFFF', secondary: '#FF4013', text: '#FFFFFF' }, fonts: { heading: 'Inter', body: 'Inter', code: 'Menlo' } } },
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
    const result = await planActions({ slides, userPrompt: content, chatHistory, similarContext, cfg })
    if (!result.ok) return res.status(422).json({ error: result.error, raw: result.raw })
    res.json({ plan: result.plan, raw: result.raw })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})

app.post('/api/talks/:slug/execute/stream', async (req, res) => {
  const { slug } = req.params
  const { plan, user_prompt } = req.body || {}
  if (!plan || !Array.isArray(plan.actions)) return res.status(400).json({ error: 'plan inválido' })
  const slides = loadSlides(slug)
  if (!slides) return res.status(404).json({ error: 'talk não encontrada' })

  sseInit(res)
  const cfg = loadConfig()
  const history = loadChat(slug)
  backupBeforeLLM(slug)

  if (user_prompt) history.push({ role: 'user', content: user_prompt, ts: Date.now() })

  let work = JSON.parse(JSON.stringify(slides))
  let anyApplied = false
  const { executeAction } = await import('./executor.js')

  sseSend(res, 'start', { total: plan.actions.length, preamble: plan.preamble })

  for (let i = 0; i < plan.actions.length; i++) {
    const action = plan.actions[i]
    const t0 = Date.now()
    sseSend(res, 'action_start', { i, action })
    try {
      const r = await executeAction({
        slides: work,
        action,
        cfg,
        onAttempt: (n) => sseSend(res, 'action_attempt', { i, attempt: n }),
      })
      if (!r.ok) {
        sseSend(res, 'action_error', { i, error: r.error, raw: (r.raw || '').slice(0, 1000), retryable: true })
        break
      }
      work = r.slides
      saveSlides(slug, work)
      anyApplied = true
      sseSend(res, 'action_done', { i, elapsed_ms: Date.now() - t0 })
    } catch (e) {
      sseSend(res, 'action_error', { i, error: String(e.message || e), retryable: true })
      break
    }
  }

  const slidesPath = path.join(TALKS_DIR, slug, 'slides.json')
  const slides_mtime = fs.existsSync(slidesPath) ? fs.statSync(slidesPath).mtimeMs : null

  const replySummary = `Plano aplicado: ${plan.preamble}`
  history.push({ role: 'assistant', content: replySummary, slides_updated: anyApplied, ts: Date.now(), plan })
  saveChat(slug, history)

  sseSend(res, 'all_done', { slides: work, slides_mtime, applied: anyApplied })
  res.end()
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
