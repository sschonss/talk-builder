<script setup>
import { ref, reactive, onMounted, onBeforeUnmount, computed, nextTick, watch } from 'vue'
import FidelitySlide from './FidelitySlide.vue'

const talks = ref([])
const currentSlug = ref(null)
const messages = ref([])
const slides = ref(null)
const selectedIndex = ref(0)
const previewMode = ref('fidel')
const input = ref('')
const sending = ref(false)
const building = ref(false)
const opening = ref(false)
const error = ref('')
const health = ref(null)
const listEl = ref(null)
const newTitle = ref('')
const settingsOpen = ref(false)
const settings = ref(null)
const settingsDraft = ref({})
const settingsSaving = ref(false)
const testing = ref(false)
const testResult = ref(null)

watch(settingsDraft, () => { testResult.value = null }, { deep: true })

const slidesMtime = ref(null)
const now = ref(Date.now())
let nowTimer = null

const savedLabel = computed(() => {
  if (!slidesMtime.value) return ''
  const diff = Math.max(0, now.value - slidesMtime.value)
  const s = Math.floor(diff / 1000)
  if (s < 5) return 'salvo agora'
  if (s < 60) return `salvo há ${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `salvo há ${m}min`
  const h = Math.floor(m / 60)
  if (h < 24) return `salvo há ${h}h`
  return `salvo há ${Math.floor(h / 24)}d`
})

const COPILOT_MODELS = [
  '', 'claude-sonnet-4.7', 'claude-sonnet-4.6', 'claude-sonnet-4.5',
  'claude-opus-4.7', 'claude-opus-4.6', 'claude-opus-4.5',
  'claude-haiku-4.5',
  'gpt-5.5', 'gpt-5.4', 'gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.2', 'gpt-4.1',
]

const searchQuery = ref('')
const searchResults = ref(null)
const searching = ref(false)
let searchTimer = null

watch(searchQuery, (v) => {
  if (searchTimer) clearTimeout(searchTimer)
  if (!v || !v.trim()) { searchResults.value = null; return }
  searchTimer = setTimeout(async () => {
    searching.value = true
    try {
      searchResults.value = await api(`/api/search?q=${encodeURIComponent(v.trim())}&semantic=1&limit=10`)
    } catch (e) {
      searchResults.value = { error: e.message }
    } finally {
      searching.value = false
    }
  }, 300)
})

const similar = ref([])

async function loadSimilar(slug) {
  similar.value = []
  if (!slug) return
  try {
    const r = await api(`/api/talks/${slug}/similar?limit=5`)
    similar.value = r.results || []
  } catch {}
}

function openSearchResult(slug, slideIdx) {
  openTalk(slug).then(() => {
    if (typeof slideIdx === 'number') selectedIndex.value = slideIdx
    searchQuery.value = ''
  })
}

const embedStatus = ref(null)
async function refreshEmbedStatus() {
  try { embedStatus.value = await api('/api/index/embed-status') } catch {}
}

const providerLabel = computed(() => {
  if (!health.value) return 'carregando...'
  const id = health.value.provider
  const p = (health.value.providers || []).find(x => x.id === id)
  if (!p) return id
  return `${p.label} ${p.configured ? 'pronto' : '(não configurado)'}`
})

async function openSettings() {
  settings.value = await api('/api/settings').catch(() => null)
  if (!settings.value) return
  settingsDraft.value = {
    provider: settings.value.provider,
    anthropic_api_key: '',
    anthropic_model: settings.value.anthropic_model,
    openai_api_key: '',
    openai_model: settings.value.openai_model,
    copilot_binary: settings.value.copilot_binary,
    copilot_model: settings.value.copilot_model || '',
    claude_binary: settings.value.claude_binary,
    claude_model: settings.value.claude_model || '',
    opencode_binary: settings.value.opencode_binary,
    opencode_model: settings.value.opencode_model || '',
    llm_timeout_minutes: settings.value.llm_timeout_minutes || 30,
    edit_mode: settings.value.edit_mode || 'auto',
    planner_threshold: settings.value.planner_threshold || 30,
    planner_provider: settings.value.planner_provider || '',
    planner_model: settings.value.planner_model || '',
    planner_concurrency: settings.value.planner_concurrency || 3,
    cache_enabled: settings.value.cache_enabled !== false,
    autocompact_threshold_tokens: settings.value.autocompact_threshold_tokens || 8000,
  }
  testResult.value = null
  settingsOpen.value = true
}

async function saveSettings() {
  if (!testResult.value || !testResult.value.ok) {
    testResult.value = { ok: false, msg: 'Teste o provider antes de salvar' }
    return
  }
  settingsSaving.value = true
  try {
    const patch = { ...settingsDraft.value }
    if (!patch.anthropic_api_key) delete patch.anthropic_api_key
    if (!patch.openai_api_key) delete patch.openai_api_key
    settings.value = await api('/api/settings', { method: 'POST', body: patch })
    health.value = await api('/api/health').catch(() => null)
    settingsOpen.value = false
  } catch (e) {
    testResult.value = { ok: false, msg: 'Erro ao salvar: ' + e.message }
  } finally {
    settingsSaving.value = false
  }
}

async function testProvider() {
  testing.value = true
  testResult.value = null
  try {
    const r = await api('/api/providers/test', { method: 'POST', body: settingsDraft.value })
    testResult.value = { ok: true, msg: `Conectado em ${r.ms}ms — resposta: ${r.sample}` }
  } catch (e) {
    testResult.value = { ok: false, msg: 'Falhou: ' + e.message }
  } finally {
    testing.value = false
  }
}

async function api(path, opts = {}) {
  const r = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.error || r.statusText)
  return data
}

async function loadTalks() {
  talks.value = (await api('/api/talks')).talks
}

async function openTalk(slug) {
  currentSlug.value = slug
  error.value = ''
  const data = await api(`/api/talks/${slug}`)
  slides.value = data.slides
  messages.value = data.messages || []
  slidesMtime.value = data.slides_mtime || null
  selectedIndex.value = 0
  await nextTick(scrollBottom)
  loadSimilar(slug)
  await reconnectPlanIfAny(slug)
  await refreshContextStats(slug)
}

async function reconnectPlanIfAny(slug) {
  try {
    const r = await api(`/api/talks/${slug}/plan/state`)
    if (!r.active) return
    const st = r.state
    const msg = messages.value.find(m => m.kind === 'plan' && m.plan === st.plan) || messages.value.slice().reverse().find(m => m.kind === 'plan' && st.msgIndex != null && messages.value.indexOf(m) === st.msgIndex)
    const target = msg || reactive({
      role: 'assistant', kind: 'plan', plan: st.plan, status: st.status,
      progress: st.progress || {}, tokens: st.tokens || { in: 0, out: 0 },
      userPrompt: st.userPrompt, ts: Date.now(),
    })
    if (!msg) messages.value.push(target)
    target.plan = st.plan
    target.progress = st.progress || {}
    target.tokens = st.tokens || { in: 0, out: 0 }
    target.userPrompt = st.userPrompt
    target.status = st.status
    if (st.status === 'running') {
      sending.value = true
      streamPlanUpdates(slug, target)
    }
  } catch {}
}

function streamPlanUpdates(slug, target) {
  sseRequestGet(`/api/talks/${slug}/plan/stream`, {
    snapshot: (d) => {
      target.plan = d.plan
      target.progress = d.progress || {}
      target.tokens = d.tokens || { in: 0, out: 0 }
      target.status = d.status
    },
    action_start: (d) => { target.currentIndex = d.i; target.progress[d.i] = { ...(target.progress[d.i] || {}), status: 'running', attempt: 1 } },
    plan_expanded: (d) => { target.plan = d.plan; target.progress = {} },
    action_attempt: (d) => { target.progress[d.i] = { ...(target.progress[d.i] || {}), attempt: d.attempt } },
    action_done: (d) => {
      target.progress[d.i] = { status: 'done', elapsed_ms: d.elapsed_ms, tokens_in: d.tokens_in, tokens_out: d.tokens_out, attempt: target.progress[d.i]?.attempt || 1 }
      if (d.tokens_total) target.tokens = d.tokens_total
    },
    action_error: (d) => {
      target.progress[d.i] = { status: 'error', error: d.error }
      target.status = 'error'; target.errorMsg = `Ação ${d.i}: ${d.error}`
      sending.value = false
    },
    cancelled: () => { target.status = 'cancelled'; sending.value = false },
    all_done: (d) => {
      target.status = d.status || 'done'
      if (d.tokens) target.tokens = d.tokens
      if (d.slides) slides.value = d.slides
      if (d.slides_mtime) slidesMtime.value = d.slides_mtime
      sending.value = false
      refreshContextStats(slug)
    },
    no_plan: () => { sending.value = false },
  })
}

async function sseRequestGet(url, handlers) {
  try {
    const r = await fetch(url)
    if (!r.ok || !r.body) return
    const reader = r.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const events = buf.split('\n\n'); buf = events.pop()
      for (const ev of events) {
        let name = 'message', data = ''
        for (const line of ev.split('\n')) {
          if (line.startsWith('event: ')) name = line.slice(7)
          else if (line.startsWith('data: ')) data += line.slice(6)
        }
        let parsed = {}
        try { parsed = JSON.parse(data) } catch {}
        handlers[name]?.(parsed)
      }
    }
  } catch {}
}

async function createTalk() {
  if (!newTitle.value.trim()) return
  const { slug } = await api('/api/talks', { method: 'POST', body: { title: newTitle.value.trim() } })
  newTitle.value = ''
  await loadTalks()
  await openTalk(slug)
}

async function deleteTalk(slug) {
  const t = talks.value.find(x => x.slug === slug)
  const name = t?.title || slug
  if (!confirm(`Apagar a talk "${name}"?\n\nIsso vai remover slides.json, chat.json e output/ permanentemente. Esta ação não pode ser desfeita.`)) return
  await api(`/api/talks/${slug}`, { method: 'DELETE' })
  if (currentSlug.value === slug) {
    currentSlug.value = null
    messages.value = []
    slides.value = null
  }
  await loadTalks()
}

async function renameTalk() {
  if (!currentSlug.value) return
  const current = slides.value?.presentation?.title || ''
  const next = prompt('Novo título da talk:', current)
  if (!next || next.trim() === current) return
  try {
    await api(`/api/talks/${currentSlug.value}`, { method: 'PATCH', body: { title: next.trim() } })
    await openTalk(currentSlug.value)
    await loadTalks()
  } catch (e) {
    error.value = 'Erro ao renomear: ' + e.message
  }
}

const debugMode = ref(localStorage.getItem('tc.debug') === '1')
const debugPanelOpen = ref(false)
const debugEvents = ref([])
const lastPrompt = ref('')
const lastResponse = ref('')
const showStreamInChat = ref(localStorage.getItem('tc.stream_chat') !== '0')

watch(debugMode, v => localStorage.setItem('tc.debug', v ? '1' : '0'))
watch(showStreamInChat, v => localStorage.setItem('tc.stream_chat', v ? '1' : '0'))

function pushDebug(kind, payload) {
  if (!debugMode.value) return
  debugEvents.value.push({ kind, payload, t: Date.now() })
  if (debugEvents.value.length > 200) debugEvents.value.shift()
}

async function sseRequest(url, body, handlers) {
  const startedAt = Date.now()
  pushDebug('request', { url, body })
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`)
  const reader = r.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const events = buf.split('\n\n')
    buf = events.pop()
    for (const ev of events) {
      let name = 'message', data = ''
      for (const line of ev.split('\n')) {
        if (line.startsWith('event: ')) name = line.slice(7)
        else if (line.startsWith('data: ')) data += line.slice(6)
      }
      let parsed = {}
      try { parsed = JSON.parse(data) } catch {}
      pushDebug(`sse:${name}`, parsed)
      handlers[name]?.(parsed)
    }
  }
  pushDebug('request:done', { url, elapsed_ms: Date.now() - startedAt })
}

const autoExecuteSession = ref(false)
const ctxStats = ref(null)
const ctxModalOpen = ref(false)
const compacting = ref(false)
const themes = ref([])
const themeOpen = ref(false)
const cacheStats = ref(null)

async function loadThemes() {
  if (themes.value.length) return
  try {
    const r = await api('/api/themes')
    themes.value = r.themes || []
  } catch {}
}

async function applyTheme(id) {
  if (!currentSlug.value) return
  try {
    await api(`/api/talks/${currentSlug.value}/theme`, { method: 'POST', body: { id } })
    const data = await api(`/api/talks/${currentSlug.value}`)
    slides.value = data.slides
    slidesMtime.value = data.slides_mtime
    themeOpen.value = false
  } catch (e) { error.value = e.message }
}

async function refreshCacheStats() {
  try { cacheStats.value = await api('/api/cache/stats') } catch { cacheStats.value = null }
}

async function clearCache() {
  if (!confirm('Limpar todo o cache de LLM?')) return
  await api('/api/cache/clear', { method: 'POST' })
  await refreshCacheStats()
}

async function refreshContextStats(slug) {
  if (!slug) { ctxStats.value = null; return }
  try { ctxStats.value = await api(`/api/talks/${slug}/context-stats`) } catch { ctxStats.value = null }
}

function fmtTok(n) {
  if (n == null) return '-'
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

async function compactChat() {
  if (!currentSlug.value) return
  if (!confirm('Compactar todas as mensagens antigas em um único resumo? As 4 mais recentes são preservadas. Isso reescreve chat.json.')) return
  compacting.value = true
  try {
    const r = await api(`/api/talks/${currentSlug.value}/chat/compact`, { method: 'POST', body: { keep_last: 4 } })
    if (r.skipped) { error.value = r.reason; return }
    const data = await api(`/api/talks/${currentSlug.value}`)
    messages.value = data.messages || []
    await refreshContextStats(currentSlug.value)
    ctxModalOpen.value = false
  } catch (e) {
    error.value = e.message
  } finally {
    compacting.value = false
  }
}

function shouldUsePlanner() {
  const mode = settings.value?.edit_mode || 'auto'
  if (mode === 'classic') return false
  if (mode === 'planner') return true
  const threshold = settings.value?.planner_threshold || 30
  return (slides.value?.slides?.length || 0) >= threshold
}

function describeAction(a) {
  switch (a.type) {
    case 'edit_slide': return `slide ${a.idx}: ${a.instruction}`
    case 'add_slides': return `+${a.count} depois do ${a.after} sobre ${a.topic}`
    case 'remove_slide': return `apagar slide ${a.idx}`
    case 'move_slide': return `mover ${a.from} → ${a.to}`
    case 'set_meta': return `meta: ${Object.keys(a.patch || {}).join(', ')}`
    case 'bulk_edit': return `bulk: ${a.transform}`
    case 'replace_section': return `substituir ${a.start}..${a.end}: ${a.instruction}`
    case 'regenerate_slide': return `regenerar slide ${a.idx}: ${a.instruction}`
    default: return a.type
  }
}

function progressLabel(m, ai) {
  const p = m.progress?.[ai]
  if (!p) return ''
  if (p.status === 'running') {
    const chunks = p.chunks ? ` · ${fmtTok(p.chunks)}c` : ''
    return `... tentativa ${p.attempt || 1}${chunks}`
  }
  if (p.status === 'done') {
    const cache = p.cached ? ' [cache]' : ''
    return `ok (${Math.round((p.elapsed_ms || 0) / 100) / 10}s)${cache}`
  }
  if (p.status === 'error') return `falhou`
  return ''
}

function hasDestructive(plan) {
  return (plan.actions || []).some(a => a.type === 'remove_slide' || a.type === 'replace_section')
}

function hasInstruction(a) {
  return 'instruction' in a || 'transform' in a || 'topic' in a
}

async function removeAction(m, ai) {
  if (!m.plan) return
  if (!confirm(`Remover ação ${ai} (${m.plan.actions[ai].type})?`)) return
  const newActions = m.plan.actions.slice()
  newActions.splice(ai, 1)
  if (!newActions.length) { cancelPlan(m); return }
  try {
    const r = await api(`/api/talks/${currentSlug.value}/plan`, { method: 'PATCH', body: { actions: newActions } })
    m.plan = r.plan
    m.progress = {}
    m.editing = null
  } catch (e) { error.value = e.message }
}

async function savePlanEdits(m) {
  if (!m.plan) return
  try {
    const r = await api(`/api/talks/${currentSlug.value}/plan`, { method: 'PATCH', body: { actions: m.plan.actions } })
    m.plan = r.plan
    m.editing = null
  } catch (e) { error.value = e.message }
}

async function send() {
  const content = input.value.trim()
  if (!content || sending.value || !currentSlug.value) return
  input.value = ''
  error.value = ''
  lastPrompt.value = content
  messages.value.push({ role: 'user', content, ts: Date.now() })
  await nextTick(scrollBottom)
  sending.value = true

  const usePlanner = shouldUsePlanner()

  try {
    if (usePlanner) {
      await runPlannerFlow(content)
    } else {
      await runClassicFlow(content)
    }
  } catch (e) {
    error.value = e.message
  } finally {
    sending.value = false
    await nextTick(scrollBottom)
  }
}

async function runClassicFlow(content) {
  const assistantMsg = { role: 'assistant', content: '', rawStream: '', showRaw: false, ts: Date.now(), streaming: true }
  messages.value.push(assistantMsg)
  await sseRequest(`/api/talks/${currentSlug.value}/message/stream`, { content, debug: debugMode.value }, {
    chunk: (d) => {
      const t = d.text || ''
      assistantMsg.rawStream += t
      if (showStreamInChat.value) {
        assistantMsg.content += t
        scrollBottom()
      }
    },
    done: (d) => {
      assistantMsg.content = d.reply || assistantMsg.content
      assistantMsg.slides_updated = d.slides_updated
      assistantMsg.streaming = false
      lastResponse.value = assistantMsg.content
      if (d.slides) slides.value = d.slides
      if (d.slides_mtime) slidesMtime.value = d.slides_mtime
    },
    error: (d) => { error.value = d.error || 'Erro no stream'; assistantMsg.streaming = false },
  })
}

async function runPlannerFlow(content) {
  let r
  try {
    r = await fetch(`/api/talks/${currentSlug.value}/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
  } catch (e) {
    error.value = `Falha de rede: ${e.message}`
    return
  }
  if (!r.ok) {
    const body = await r.json().catch(() => ({}))
    error.value = `Planner falhou: ${body.error || r.statusText}`
    return
  }
  const data = await r.json()
  const fresh = await api(`/api/talks/${currentSlug.value}`)
  messages.value = fresh.messages || []
  const planMsg = reactive(messages.value[messages.value.length - 1])
  messages.value[messages.value.length - 1] = planMsg
  planMsg.userPrompt = content
  await nextTick(scrollBottom)

  if (autoExecuteSession.value && !hasDestructive(data.plan)) {
    await executePlan(planMsg)
  }
}

function cancelPlan(m) {
  fetch(`/api/talks/${currentSlug.value}/plan/cancel`, { method: 'POST' }).catch(() => {})
  m.status = 'cancelled'
  m.content = 'Plano cancelado.'
}

async function executePlan(m) {
  if (!m.plan) return
  if (m.editing != null) await savePlanEdits(m)
  m.status = 'running'
  m.errorMsg = ''
  m.progress = m.progress || {}
  m.tokens = m.tokens || { in: 0, out: 0 }
  m.currentIndex = 0
  sending.value = true
  try {
    await sseRequest(`/api/talks/${currentSlug.value}/execute/stream`, {
      plan: m.plan,
      user_prompt: m.userPrompt,
    }, {
      action_start: (d) => {
        m.currentIndex = d.i
        m.progress[d.i] = { status: 'running', attempt: 1 }
      },
      plan_expanded: (d) => { m.plan = d.plan; m.progress = {} },
      action_attempt: (d) => {
        if (!m.progress[d.i]) m.progress[d.i] = { status: 'running' }
        m.progress[d.i].attempt = d.attempt
      },
      action_chunk: (d) => {
        if (!m.progress[d.i]) m.progress[d.i] = { status: 'running' }
        m.progress[d.i].chunks = (m.progress[d.i].chunks || 0) + (d.len || 0)
        if (d.cached) m.progress[d.i].cached = true
      },
      action_done: (d) => {
        m.progress[d.i] = {
          status: 'done', elapsed_ms: d.elapsed_ms,
          tokens_in: d.tokens_in, tokens_out: d.tokens_out,
          attempt: m.progress[d.i]?.attempt || 1,
        }
        if (d.tokens_total) m.tokens = d.tokens_total
      },
      action_error: (d) => {
        m.progress[d.i] = { status: 'error', error: d.error }
        m.failedIndex = d.i
        m.status = 'error'
        m.errorMsg = `Ação ${d.i} falhou: ${d.error}`
      },
      cancelled: () => { m.status = 'cancelled' },
      all_done: (d) => {
        if (d.slides) slides.value = d.slides
        if (d.slides_mtime) slidesMtime.value = d.slides_mtime
        if (d.tokens) m.tokens = d.tokens
        if (m.status !== 'error' && m.status !== 'cancelled') m.status = d.status || 'done'
        refreshContextStats(currentSlug.value)
      },
      error: (d) => {
        m.status = 'error'
        m.errorMsg = d.error || 'Erro no stream'
      },
    })
  } catch (e) {
    m.status = 'error'
    m.errorMsg = e.message
  } finally {
    sending.value = false
  }
}

async function retryFromFailed(m) {
  if (m.failedIndex == null || !m.plan) return
  const remaining = {
    preamble: m.plan.preamble + ' (retomada)',
    actions: m.plan.actions.slice(m.failedIndex),
  }
  const newMsg = reactive({
    role: 'assistant', kind: 'plan', plan: remaining, status: 'awaiting',
    content: '', ts: Date.now(), userPrompt: m.userPrompt, progress: {},
  })
  messages.value.push(newMsg)
  await executePlan(newMsg)
}

async function replanFromScratch(m) {
  input.value = m.userPrompt || ''
  await send()
}

const buildLog = ref('')
const buildLogOpen = ref(false)
const buildElapsed = ref(0)
const buildStatus = ref('')
const buildLogPre = ref(null)
let buildTimer = null

watch(buildLog, () => {
  nextTick(() => {
    if (buildLogPre.value) buildLogPre.value.scrollTop = buildLogPre.value.scrollHeight
  })
})

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}min ${s % 60}s`
}

async function build(quick = false) {
  if (!currentSlug.value) return
  building.value = true
  buildLog.value = ''
  buildLogOpen.value = true
  buildElapsed.value = 0
  buildStatus.value = 'iniciando...'
  error.value = ''
  const startedAt = Date.now()
  if (buildTimer) clearInterval(buildTimer)
  buildTimer = setInterval(() => { buildElapsed.value = Date.now() - startedAt }, 250)
  let finalPptx = null
  try {
    await sseRequest(`/api/talks/${currentSlug.value}/build/stream`, { quick, debug: debugMode.value }, {
      start: (d) => { buildStatus.value = `modo: ${d.mode}` },
      log: (d) => {
        buildLog.value += d.text || ''
        const t = (d.text || '').trim()
        if (/mermaid|mmdc/i.test(t)) buildStatus.value = 'renderizando diagramas mermaid...'
        else if (/pptx|python-pptx|generating/i.test(t)) buildStatus.value = 'gerando pptx...'
        else if (/installing|pip|npm/i.test(t)) buildStatus.value = 'instalando deps...'
        else if (t) buildStatus.value = t.split('\n').pop().slice(0, 80)
      },
      heartbeat: () => {},
      done: (d) => {
        finalPptx = d.pptx
        buildStatus.value = `concluído em ${fmtElapsed(d.elapsed_ms || 0)}`
      },
      error: (d) => {
        error.value = `Build falhou (exit ${d.code}) após ${fmtElapsed(d.elapsed_ms || 0)}`
        buildStatus.value = 'falhou'
      },
    })
    if (finalPptx) {
      messages.value.push({ role: 'system', content: `Build concluído: ${finalPptx}`, ts: Date.now() })
    }
  } catch (e) {
    error.value = 'Build falhou: ' + e.message
    buildStatus.value = 'erro'
  } finally {
    building.value = false
    if (buildTimer) { clearInterval(buildTimer); buildTimer = null }
  }
}

async function openInKeynote() {
  if (!currentSlug.value) return
  opening.value = true
  error.value = ''
  try {
    await api(`/api/talks/${currentSlug.value}/open`, { method: 'POST' })
  } catch (e) {
    error.value = e.message
  } finally {
    opening.value = false
  }
}

function scrollBottom() {
  if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight
}

function onKey(e) {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    send()
  }
}

const slideCount = computed(() => slides.value?.slides?.length || 0)

onMounted(async () => {
  health.value = await api('/api/health').catch(() => null)
  await loadTalks()
  refreshEmbedStatus()
  nowTimer = setInterval(() => {
    now.value = Date.now()
    refreshEmbedStatus()
  }, 15000)
})

onBeforeUnmount(() => { if (nowTimer) clearInterval(nowTimer) })

watch(messages, () => nextTick(scrollBottom), { deep: true })
</script>

<template>
  <div class="layout">
    <aside class="sidebar">
      <header class="brand">
        <div class="brand-row">
          <h1>Talk Chat</h1>
          <div class="brand-actions">
            <button :class="['debug-btn', showStreamInChat && 'on']" @click="showStreamInChat = !showStreamInChat" :title="showStreamInChat ? 'Mostrando stream do LLM no chat (clique para ocultar)' : 'Stream oculto (resposta aparece só no fim)'">STR</button>
            <button :class="['debug-btn', debugMode && 'on']" @click="debugMode = !debugMode" :title="debugMode ? 'Debug ligado (clique para desligar)' : 'Debug desligado'">DBG</button>
            <button v-if="debugMode" class="debug-btn" @click="debugPanelOpen = true" title="Abrir painel de debug">···</button>
            <button class="settings-btn" @click="openSettings" title="Configurações">⚙</button>
          </div>
        </div>
        <p v-if="health" class="health">
          <span :class="['dot', health.active_ok ? 'ok' : 'off']" />
          {{ providerLabel }}
        </p>
      </header>

      <form class="new-talk" @submit.prevent="createTalk">
        <input v-model="newTitle" placeholder="Nova talk: título..." />
        <button type="submit" :disabled="!newTitle.trim()">Criar</button>
      </form>

      <div class="search-box">
        <input v-model="searchQuery" placeholder="Buscar (FTS + vetor)..." />
        <div v-if="searchResults" class="search-results">
          <div v-if="searching" class="search-loading">buscando...</div>
          <div v-if="searchResults.error" class="search-err">{{ searchResults.error }}</div>
          <div v-if="searchResults.semantic?.length" class="search-section">
            <h4>Semântica</h4>
            <button v-for="(r, i) in searchResults.semantic.slice(0, 5)" :key="'s'+i" class="search-hit" @click="openSearchResult(r.talk_slug, r.slide_idx)">
              <span class="hit-talk">{{ r.talk_slug }}</span>
              <span class="hit-meta">slide {{ r.slide_idx + 1 }} · score {{ r.score.toFixed(2) }}</span>
              <span class="hit-snippet">{{ r.title || r.content.slice(0, 80) }}</span>
            </button>
          </div>
          <div v-if="searchResults.slides?.length" class="search-section">
            <h4>Slides (texto)</h4>
            <button v-for="(r, i) in searchResults.slides.slice(0, 5)" :key="'sl'+i" class="search-hit" @click="openSearchResult(r.talk_slug, r.slide_idx)">
              <span class="hit-talk">{{ r.talk_slug }}</span>
              <span class="hit-meta">slide {{ r.slide_idx + 1 }}</span>
              <span class="hit-snippet" v-html="r.snippet"></span>
            </button>
          </div>
          <div v-if="searchResults.chats?.length" class="search-section">
            <h4>Chats</h4>
            <button v-for="(r, i) in searchResults.chats.slice(0, 5)" :key="'c'+i" class="search-hit" @click="openSearchResult(r.talk_slug)">
              <span class="hit-talk">{{ r.talk_slug }} · {{ r.role }}</span>
              <span class="hit-snippet" v-html="r.snippet"></span>
            </button>
          </div>
        </div>
      </div>

      <ul class="talks">
        <li v-for="t in talks" :key="t.slug"
            :class="{ active: t.slug === currentSlug }"
            @click="openTalk(t.slug)">
          <div class="t-title">{{ t.title }}</div>
          <div class="t-meta">
            <span>{{ t.slug }}</span>
            <button class="t-del" @click.stop="deleteTalk(t.slug)" title="apagar">×</button>
          </div>
        </li>
        <li v-if="!talks.length" class="empty">Nenhuma talk ainda.</li>
      </ul>

      <div v-if="similar.length && currentSlug" class="similar-box">
        <h4>Talks parecidas</h4>
        <button v-for="t in similar" :key="t.slug" class="sim-hit" @click="openTalk(t.slug)">
          <span class="sim-title">{{ t.title || t.slug }}</span>
          <span class="sim-score">{{ (t.score * 100).toFixed(0) }}%</span>
        </button>
      </div>

      <footer class="sidebar-foot" v-if="embedStatus">
        <span :class="['dot', embedStatus.ollama?.ok ? 'ok' : 'off']" />
        <span class="embed-label">
          ollama {{ embedStatus.ollama?.ok ? 'on' : 'off' }} ·
          {{ embedStatus.done_chats + embedStatus.done_slides }}/{{ embedStatus.done_chats + embedStatus.done_slides + embedStatus.pending_chats + embedStatus.pending_slides }} vetorizados
        </span>
      </footer>
    </aside>

    <section class="chat-pane" v-if="currentSlug">
      <header class="topbar">
        <div class="title-block">
          <h2 @click="renameTalk" title="Clique para renomear" class="editable">{{ slides?.presentation?.title || currentSlug }}</h2>
          <p class="sub">
            {{ slideCount }} slide{{ slideCount === 1 ? '' : 's' }} · {{ currentSlug }}
            <span v-if="savedLabel" class="saved-badge">· {{ savedLabel }}</span>
          </p>
        </div>
        <div class="actions">
          <button
            @click="build(true)"
            :disabled="building || !slideCount"
            title="Build rápido: reusa diagramas mermaid já renderizados no cache. Mais veloz, mas não reflete mudanças em diagramas."
          >
            {{ building ? 'Gerando...' : 'Build rápido' }}
          </button>
          <button
            class="primary"
            @click="build(false)"
            :disabled="building || !slideCount"
            title="Build completo: re-renderiza todos os diagramas mermaid via Puppeteer. Mais lento, use quando alterar diagramas ou para a versão final."
          >
            {{ building ? 'Gerando...' : 'Build completo' }}
          </button>
          <button @click="openInKeynote" :disabled="opening || !slideCount">
            {{ opening ? '...' : 'Abrir Keynote' }}
          </button>
          <button v-if="currentSlug" class="ctx-badge" @click="ctxModalOpen = true" :title="'Contexto estimado por turno'">
            ctx {{ ctxStats ? fmtTok(ctxStats.classic_prompt_tokens_est) : '-' }}
          </button>
          <button v-if="currentSlug" class="ctx-badge" @click="() => { loadThemes(); themeOpen = true }" :title="'Trocar tema visual'">
            tema {{ slides?.theme?.id || '?' }}
          </button>
        </div>
      </header>

      <div v-if="ctxStats?.should_compact" class="autocompact-banner">
        Chat acumulou ~{{ fmtTok(ctxStats.chat_tokens_est) }} tokens. Considere
        <button class="link-btn" @click="ctxModalOpen = true">compactar</button>
        antes do próximo turno pra economizar.
      </div>

      <div ref="listEl" class="chat">
        <p v-if="!messages.length && !sending" class="empty-chat">
          Comece descrevendo a talk: tema, público, duração, tom.
        </p>
        <div v-for="(m, i) in messages" :key="i" :class="['msg', m.role]">
          <div class="who">{{ m.role === 'user' ? 'você' : m.role === 'system' ? 'sistema' : 'copilot' }}</div>
          <div class="text" v-if="m.content">{{ m.content }}</div>

          <div v-if="m.kind === 'plan' && m.plan" class="plan-card">
            <div class="plan-preamble">{{ m.plan.preamble }}</div>
            <ol class="plan-actions">
              <li v-for="(a, ai) in m.plan.actions" :key="ai" :class="['plan-action', m.progress?.[ai]?.status || 'pending']">
                <span class="pa-type">{{ a.type }}</span>
                <span class="pa-desc" v-if="m.editing !== ai">{{ describeAction(a) }}</span>
                <input v-else class="pa-edit" v-model="a.instruction" @keydown.enter.prevent="m.editing = null" />
                <span class="pa-status">{{ progressLabel(m, ai) }}</span>
                <span class="pa-tokens" v-if="m.progress?.[ai]?.tokens_in != null">
                  {{ fmtTok(m.progress[ai].tokens_in) }}↑ {{ fmtTok(m.progress[ai].tokens_out) }}↓
                  <span v-if="m.progress[ai].cached" class="cache-badge" title="resposta veio do cache">cache</span>
                </span>
                <span class="pa-edits" v-if="m.status === 'awaiting'">
                  <button v-if="hasInstruction(a)" class="link-btn" @click="m.editing = (m.editing === ai ? null : ai)" :title="m.editing === ai ? 'fechar' : 'editar instrução'">
                    {{ m.editing === ai ? 'ok' : 'editar' }}
                  </button>
                  <button class="link-btn danger" @click="removeAction(m, ai)" title="remover ação">×</button>
                </span>
              </li>
            </ol>
            <div v-if="m.tokens && (m.tokens.in || m.tokens.out)" class="plan-totals">
              total: {{ fmtTok(m.tokens.in) }} tokens entrada · {{ fmtTok(m.tokens.out) }} saída
            </div>
            <div v-if="m.status === 'awaiting'" class="plan-controls">
              <label class="auto-toggle">
                <input type="checkbox" v-model="autoExecuteSession" />
                <span>Sempre executar nesta sessão</span>
              </label>
              <p v-if="hasDestructive(m.plan)" class="warn">Plano contém ações destrutivas — sempre pedirá confirmação.</p>
              <div class="btn-row">
                <button @click="cancelPlan(m)">Cancelar</button>
                <button class="primary" @click="executePlan(m)">Executar</button>
              </div>
            </div>
            <div v-else-if="m.status === 'running'" class="plan-controls">
              <small>Executando ação {{ (m.currentIndex ?? 0) + 1 }}/{{ m.plan.actions.length }}...</small>
            </div>
            <div v-else-if="m.status === 'error'" class="plan-controls">
              <p class="err">{{ m.errorMsg }}</p>
              <div class="btn-row">
                <button @click="retryFromFailed(m)">Tentar essa ação de novo</button>
                <button @click="replanFromScratch(m)">Remandar prompt do zero</button>
              </div>
            </div>
            <div v-else-if="m.status === 'done'" class="plan-controls ok">
              <small>Plano aplicado.</small>
            </div>
          </div>

          <div v-if="m.slides_updated" class="badge">deck atualizado</div>
          <div v-if="m.role === 'assistant' && m.rawStream && m.rawStream !== m.content" class="raw-toggle">
            <button @click="m.showRaw = !m.showRaw" class="raw-btn">
              {{ m.showRaw ? '▼' : '▶' }} stream cru ({{ m.rawStream.length }} chars)
            </button>
            <pre v-if="m.showRaw" class="raw-pre">{{ m.rawStream }}</pre>
          </div>
        </div>
        <div v-if="sending" class="msg assistant thinking">
          <div class="who">copilot</div>
          <div class="dots"><span></span><span></span><span></span></div>
          <div class="thinking-label">pensando, pesquisando, escrevendo...</div>
        </div>
      </div>

      <form class="composer" @submit.prevent="send">
        <textarea
          v-model="input"
          rows="3"
          placeholder="Digite... (Cmd+Enter pra enviar)"
          :disabled="sending || !health?.active_ok"
          @keydown="onKey"
        />
        <button type="submit" :disabled="sending || !input.trim() || !health?.active_ok">
          {{ sending ? 'Pensando...' : 'Enviar' }}
        </button>
        <p v-if="error" class="err">{{ error }}</p>
      </form>

      <div v-if="buildLogOpen" class="build-log">
        <header>
          <div class="bl-meta">
            <span class="bl-label">{{ building ? 'Build em andamento' : (error ? 'Build falhou' : 'Build concluído') }}</span>
            <span class="bl-elapsed">{{ fmtElapsed(buildElapsed) }}</span>
            <span class="bl-status">{{ buildStatus }}</span>
          </div>
          <div class="bl-actions">
            <button @click="navigator.clipboard.writeText(buildLog)" title="Copiar log">⧉</button>
            <button @click="buildLogOpen = false" title="Fechar">×</button>
          </div>
        </header>
        <pre ref="buildLogPre">{{ buildLog || '(aguardando saída do build.sh... se estiver lento, ative DBG e tente de novo)' }}</pre>
      </div>
    </section>

    <div v-if="debugPanelOpen" class="modal-backdrop" @click.self="debugPanelOpen = false">
      <div class="modal debug-modal">
        <header>
          <h3>Painel de debug</h3>
          <button @click="debugPanelOpen = false">×</button>
        </header>
        <div class="debug-tabs">
          <div class="debug-section">
            <h4>Último prompt enviado</h4>
            <pre>{{ lastPrompt || '(nenhum ainda)' }}</pre>
          </div>
          <div class="debug-section">
            <h4>Última resposta do LLM</h4>
            <pre>{{ lastResponse || '(nenhuma ainda)' }}</pre>
          </div>
          <div class="debug-section">
            <h4>Último build log</h4>
            <pre class="build-pre">{{ buildLog || '(nenhum build rodado)' }}</pre>
          </div>
          <div class="debug-section">
            <h4>Eventos SSE recentes ({{ debugEvents.length }})</h4>
            <div class="debug-events">
              <div v-for="(e, i) in debugEvents.slice().reverse().slice(0, 50)" :key="i" class="dev-row">
                <span class="dev-kind">{{ e.kind }}</span>
                <span class="dev-payload">{{ JSON.stringify(e.payload).slice(0, 200) }}</span>
              </div>
            </div>
            <button @click="debugEvents = []" class="btn-small">Limpar</button>
          </div>
        </div>
      </div>
    </div>

    <aside class="preview-pane" v-if="currentSlug">
      <header class="preview-head">
        <h3>Preview</h3>
        <div class="mode-toggle">
          <button :class="{ active: previewMode === 'fidel' }" @click="previewMode = 'fidel'">Fiel</button>
          <button :class="{ active: previewMode === 'cards' }" @click="previewMode = 'cards'">Resumo</button>
        </div>
        <span class="count" v-if="slideCount">{{ selectedIndex + 1 }} / {{ slideCount }}</span>
      </header>

      <div class="preview-main" v-if="slideCount">
        <button class="nav prev" @click="selectedIndex = Math.max(0, selectedIndex - 1)" :disabled="selectedIndex === 0">‹</button>

        <FidelitySlide
          v-if="previewMode === 'fidel'"
          :slide="slides.slides[selectedIndex]"
          :theme="slides.theme"
        />

        <div v-else class="slide-card big" :class="'tpl-' + slides.slides[selectedIndex].template">
          <div class="slide-head">
            <span class="num">{{ String(selectedIndex + 1).padStart(2, '0') }}</span>
            <span class="tpl">{{ slides.slides[selectedIndex].template }}</span>
          </div>
          <div class="slide-body">
            <h4 v-if="slides.slides[selectedIndex].data?.title">{{ slides.slides[selectedIndex].data.title }}</h4>
            <p v-if="slides.slides[selectedIndex].data?.subtitle" class="sub">{{ slides.slides[selectedIndex].data.subtitle }}</p>
            <p v-if="slides.slides[selectedIndex].data?.author" class="author">por {{ slides.slides[selectedIndex].data.author }}</p>
            <p v-if="slides.slides[selectedIndex].data?.question" class="big-q">{{ slides.slides[selectedIndex].data.question }}</p>
            <p v-if="slides.slides[selectedIndex].data?.text" class="closing">{{ slides.slides[selectedIndex].data.text }}</p>
            <p v-if="slides.slides[selectedIndex].data?.caption" class="caption">{{ slides.slides[selectedIndex].data.caption }}</p>
            <ul v-if="Array.isArray(slides.slides[selectedIndex].data?.bullets)" class="bullets">
              <li v-for="(b, bi) in slides.slides[selectedIndex].data.bullets" :key="bi">{{ b }}</li>
            </ul>
            <ul v-if="Array.isArray(slides.slides[selectedIndex].data?.items)" class="bullets">
              <li v-for="(b, bi) in slides.slides[selectedIndex].data.items" :key="bi">{{ b }}</li>
            </ul>
            <div v-if="slides.slides[selectedIndex].template === 'comparison'" class="comp">
              <div>
                <strong>{{ slides.slides[selectedIndex].data?.left_title }}</strong>
                <ul><li v-for="(x, xi) in (slides.slides[selectedIndex].data?.left_items || [])" :key="xi">{{ x }}</li></ul>
              </div>
              <div>
                <strong>{{ slides.slides[selectedIndex].data?.right_title }}</strong>
                <ul><li v-for="(x, xi) in (slides.slides[selectedIndex].data?.right_items || [])" :key="xi">{{ x }}</li></ul>
              </div>
            </div>
            <div v-if="slides.slides[selectedIndex].template === 'metrics'" class="metrics-grid">
              <div v-for="(st, si) in (slides.slides[selectedIndex].data?.stats || [])" :key="si" class="metric">
                <div class="metric-label">{{ st.label }}</div>
                <div class="metric-vals"><span class="before">{{ st.before }}</span><span class="arrow">→</span><span class="after">{{ st.after }}</span></div>
              </div>
            </div>
            <div v-if="slides.slides[selectedIndex].template === 'story'" class="steps">
              <div v-for="(st, si) in (slides.slides[selectedIndex].data?.steps || [])" :key="si" class="step">
                <span class="time">{{ st.time }}</span>
                <span class="event">{{ st.event }}</span>
              </div>
            </div>
            <pre v-if="slides.slides[selectedIndex].template === 'code'" class="code-block"><code>{{ slides.slides[selectedIndex].data?.code }}</code></pre>
            <div v-if="slides.slides[selectedIndex].template === 'diagram'" class="diag-block">
              <div class="diag-label">diagrama mermaid</div>
              <pre v-if="slides.slides[selectedIndex].data?.mermaid_code">{{ slides.slides[selectedIndex].data.mermaid_code }}</pre>
            </div>
            <div v-if="slides.slides[selectedIndex].template === 'credits'">
              <ul class="bullets" v-if="slides.slides[selectedIndex].data?.contacts">
                <li v-for="(c, ci) in slides.slides[selectedIndex].data.contacts" :key="ci">{{ c }}</li>
              </ul>
              <p class="caption" v-if="slides.slides[selectedIndex].data?.references">{{ slides.slides[selectedIndex].data.references.length }} referências</p>
            </div>
            <p v-if="slides.slides[selectedIndex].data?.quote" class="quote">{{ slides.slides[selectedIndex].data.quote }}</p>
            <p v-if="slides.slides[selectedIndex].data?.footnote" class="footnote">{{ slides.slides[selectedIndex].data.footnote }}</p>
          </div>
        </div>
        <button class="nav next" @click="selectedIndex = Math.min(slideCount - 1, selectedIndex + 1)" :disabled="selectedIndex >= slideCount - 1">›</button>
      </div>

      <div class="filmstrip" v-if="slideCount">
        <button
          v-for="(s, i) in slides.slides"
          :key="i"
          :class="['thumb', { active: i === selectedIndex }]"
          @click="selectedIndex = i"
          :title="s.data?.title || s.template"
        >
          <span class="thumb-num">{{ i + 1 }}</span>
          <span class="thumb-tpl">{{ s.template }}</span>
        </button>
      </div>

      <div v-if="!slideCount" class="preview-empty">
        Nenhum slide ainda. Converse com o copilot pra gerar.
      </div>
    </aside>

    <section class="chat-pane empty-state" v-else>
      <div>
        <h2>Selecione ou crie uma talk</h2>
        <p>O talk-chat conversa com o LLM configurado pra montar seu slides.json e gerar o pptx no clique de um botão.</p>
      </div>
    </section>

    <div v-if="themeOpen" class="modal-backdrop" @click.self="themeOpen = false">
      <div class="modal">
        <header><h3>Tema da apresentação</h3></header>
        <div class="modal-body">
          <p style="margin: 0 0 8px; color: var(--muted); font-size: 12px;">
            Cada talk pode ter sua própria identidade visual. O build.sh usa essas cores/fontes no pptx.
          </p>
          <div class="theme-grid">
            <button v-for="t in themes" :key="t.id"
              :class="['theme-card', { active: slides?.theme?.id === t.id }]"
              @click="applyTheme(t.id)"
              :style="{ background: t.config.colors.background, color: t.config.colors.text, borderColor: t.config.colors.secondary }">
              <div class="theme-title" :style="{ color: t.config.colors.primary, fontFamily: t.config.fonts.heading }">{{ t.label }}</div>
              <div class="theme-sub" :style="{ color: t.config.colors.secondary }">Aa Bb · {{ t.config.fonts.body }}</div>
              <div class="theme-id">{{ t.id }}</div>
            </button>
          </div>
        </div>
        <footer>
          <div class="footer-btns"><button @click="themeOpen = false">Fechar</button></div>
        </footer>
      </div>
    </div>

    <div v-if="ctxModalOpen" class="modal-backdrop" @click.self="ctxModalOpen = false">
      <div class="modal">
        <header><h3>Contexto</h3></header>
        <div class="modal-body" v-if="ctxStats">
          <p style="margin: 0 0 8px; color: var(--muted); font-size: 12px;">
            Estimativas em tokens (≈ chars / 4). Provedores CLI não reportam tokens reais.
          </p>
          <table class="ctx-table"><tbody>
            <tr><td>Mensagens no chat</td><td>{{ ctxStats.chat_messages }}</td></tr>
            <tr><td>Chars do chat</td><td>{{ ctxStats.chat_chars.toLocaleString() }}</td></tr>
            <tr><td>~tokens chat</td><td>{{ fmtTok(ctxStats.chat_tokens_est) }}</td></tr>
            <tr><td>Slides</td><td>{{ ctxStats.slides_count }}</td></tr>
            <tr><td>~tokens slides.json</td><td>{{ fmtTok(ctxStats.slides_json_tokens_est) }}</td></tr>
            <tr><td>~tokens resumo do deck</td><td>{{ fmtTok(ctxStats.summary_tokens_est) }}</td></tr>
            <tr class="hi"><td>Prompt clássico (por turno)</td><td>{{ fmtTok(ctxStats.classic_prompt_tokens_est) }}</td></tr>
            <tr class="hi"><td>Prompt planner (por turno)</td><td>{{ fmtTok(ctxStats.planner_prompt_tokens_est) }}</td></tr>
          </tbody></table>
          <p style="margin: 12px 0 6px; color: var(--muted); font-size: 12px;">
            Compactar resume todas as mensagens em um único parágrafo de "system", preservando as 4 mais recentes intactas.
          </p>
        </div>
        <footer>
          <div class="footer-btns">
            <button @click="ctxModalOpen = false">Fechar</button>
            <button class="primary" :disabled="compacting" @click="compactChat">
              {{ compacting ? 'Resumindo...' : 'Compactar chat' }}
            </button>
          </div>
        </footer>
      </div>
    </div>

    <div v-if="settingsOpen" class="modal-backdrop" @click.self="settingsOpen = false">
      <div class="modal">
        <header>
          <h3>Configurações</h3>
          <button class="close" @click="settingsOpen = false">×</button>
        </header>
        <div class="modal-body">
          <label class="field">
            <span>Provider ativo</span>
            <select v-model="settingsDraft.provider">
              <option v-for="p in (settings?.providers || [])" :key="p.id" :value="p.id">
                {{ p.label }}{{ p.configured ? '' : ' (não configurado)' }}
              </option>
            </select>
          </label>

          <fieldset>
            <legend>CLIs locais</legend>
            <label class="field">
              <span>Binário copilot</span>
              <input v-model="settingsDraft.copilot_binary" placeholder="copilot" />
            </label>
            <label class="field">
              <span>Modelo copilot (deixe vazio pra usar o padrão da CLI)</span>
              <select v-model="settingsDraft.copilot_model">
                <option v-for="m in COPILOT_MODELS" :key="m" :value="m">{{ m || 'padrão da CLI' }}</option>
              </select>
            </label>
            <label class="field">
              <span>Binário claude</span>
              <input v-model="settingsDraft.claude_binary" placeholder="claude" />
            </label>
            <label class="field">
              <span>Modelo claude (ex: claude-sonnet-4-5, claude-opus-4-1)</span>
              <input v-model="settingsDraft.claude_model" placeholder="vazio = padrão" />
            </label>
            <label class="field">
              <span>Binário opencode</span>
              <input v-model="settingsDraft.opencode_binary" placeholder="opencode" />
            </label>
            <label class="field">
              <span>Modelo opencode (formato provider/model, ex: anthropic/claude-sonnet-4-5)</span>
              <input v-model="settingsDraft.opencode_model" placeholder="vazio = padrão" />
            </label>
          </fieldset>

          <fieldset>
            <legend>Anthropic API</legend>
            <label class="field">
              <span>API key {{ settings?.has_anthropic_key ? '(salva, em branco mantém)' : '' }}</span>
              <input v-model="settingsDraft.anthropic_api_key" type="password" placeholder="sk-ant-..." />
            </label>
            <label class="field">
              <span>Modelo</span>
              <input v-model="settingsDraft.anthropic_model" placeholder="claude-sonnet-4-5" />
            </label>
          </fieldset>

          <fieldset>
            <legend>OpenAI API</legend>
            <label class="field">
              <span>API key {{ settings?.has_openai_key ? '(salva, em branco mantém)' : '' }}</span>
              <input v-model="settingsDraft.openai_api_key" type="password" placeholder="sk-..." />
            </label>
            <label class="field">
              <span>Modelo</span>
              <input v-model="settingsDraft.openai_model" placeholder="gpt-4o" />
            </label>
          </fieldset>

          <fieldset>
            <legend>Timeout</legend>
            <label class="field">
              <span>Timeout do LLM (minutos)</span>
              <input v-model.number="settingsDraft.llm_timeout_minutes" type="number" min="1" max="180" placeholder="30" />
              <small>Decks grandes (100+ slides) podem precisar de 30-60min. Máximo 180.</small>
            </label>
          </fieldset>

          <fieldset>
            <legend>Modo de edição</legend>
            <label class="field">
              <span>Estratégia</span>
              <select v-model="settingsDraft.edit_mode">
                <option value="auto">Auto (planner em decks grandes)</option>
                <option value="classic">Sempre clássico (regera o deck todo)</option>
                <option value="planner">Sempre planner (ações pontuais)</option>
              </select>
              <small>Planner divide o pedido em ações pequenas. Cada ação roda separada — menos timeout, sem perder trabalho.</small>
            </label>
            <label class="field">
              <span>Threshold do auto (slides)</span>
              <input v-model.number="settingsDraft.planner_threshold" type="number" min="1" max="500" placeholder="30" />
              <small>Em "auto", planner é usado quando o deck tem pelo menos esse número de slides.</small>
            </label>
            <label class="field">
              <span>Concorrência do executor</span>
              <input v-model.number="settingsDraft.planner_concurrency" type="number" min="1" max="8" placeholder="3" />
              <small>Quantas ações paralelas o executor roda. Só ações que não mexem em índice (edit_slide, regenerate_slide, set_meta) são paralelizáveis.</small>
            </label>
            <label class="field">
              <span>Provider do planner (opcional)</span>
              <select v-model="settingsDraft.planner_provider">
                <option value="">(usar o mesmo do executor)</option>
                <option value="copilot">copilot</option>
                <option value="claude">claude</option>
                <option value="opencode">opencode</option>
                <option value="anthropic">anthropic</option>
                <option value="openai">openai</option>
              </select>
              <small>Use um modelo mais barato pra planejar. Vazio = mesmo do executor.</small>
            </label>
            <label class="field" v-if="settingsDraft.planner_provider">
              <span>Modelo do planner</span>
              <input v-model="settingsDraft.planner_model" placeholder="ex: gpt-4o-mini ou claude-haiku" />
            </label>
          </fieldset>

          <fieldset>
            <legend>Cache e contexto</legend>
            <label class="field">
              <span><input type="checkbox" v-model="settingsDraft.cache_enabled" /> Cache de respostas do LLM</span>
              <small>Cacheia hash(provider+modelo+prompt) → resposta por 7 dias. Útil pra repetições e retries.</small>
            </label>
            <label class="field">
              <span>Auto-aviso de compactação (tokens)</span>
              <input v-model.number="settingsDraft.autocompact_threshold_tokens" type="number" min="500" max="100000" placeholder="8000" />
              <small>Quando o chat passa desse tamanho, aparece um banner sugerindo compactar.</small>
            </label>
          </fieldset>

          <p class="config-path" v-if="settings">Arquivo: {{ settings.config_path }}</p>
        </div>
        <footer>
          <div class="test-result" v-if="testResult" :class="{ ok: testResult.ok, err: !testResult.ok }">
            {{ testResult.msg }}
          </div>
          <div class="footer-btns">
            <button @click="settingsOpen = false">Fechar</button>
            <button @click="testProvider" :disabled="testing || settingsSaving">
              {{ testing ? 'Testando...' : 'Testar' }}
            </button>
            <button class="primary" @click="saveSettings" :disabled="settingsSaving || testing || !testResult?.ok" :title="testResult?.ok ? '' : 'Teste com sucesso antes de salvar'">
              {{ settingsSaving ? 'Salvando...' : 'Salvar' }}
            </button>
          </div>
        </footer>
      </div>
    </div>
  </div>
</template>

<style scoped>
.layout { display: grid; grid-template-columns: 240px 1fr 520px; height: 100vh; }
.layout:has(.empty-state) { grid-template-columns: 240px 1fr; }

.sidebar { background: var(--panel); border-right: 1px solid var(--border); display: flex; flex-direction: column; min-width: 0; }
.brand { padding: 16px; border-bottom: 1px solid var(--border); }
.brand-row { display: flex; align-items: center; justify-content: space-between; }
.brand h1 { font-size: 16px; margin: 0; }
.settings-btn { background: transparent; border: 1px solid var(--border); color: var(--muted); width: 28px; height: 28px; border-radius: 6px; cursor: pointer; font-size: 14px; line-height: 1; }
.settings-btn:hover { color: var(--text); border-color: var(--accent); }

.modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; width: 520px; max-width: 90vw; max-height: 90vh; display: flex; flex-direction: column; overflow: hidden; }
.modal > header { padding: 14px 18px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
.modal > header h3 { margin: 0; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px; }
.modal .close { background: transparent; border: 0; color: var(--muted); font-size: 22px; cursor: pointer; }
.modal-body { padding: 18px; overflow-y: auto; display: flex; flex-direction: column; gap: 16px; }
.modal fieldset { border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
.modal legend { padding: 0 6px; font-size: 11px; text-transform: uppercase; color: var(--muted); letter-spacing: 0.5px; }
.modal .field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
.modal .field input, .modal .field select { background: #0a0a0a; border: 1px solid var(--border); color: var(--text); padding: 8px 10px; border-radius: 6px; font-size: 13px; font-family: inherit; }
.modal .config-path { font-size: 11px; color: var(--muted); margin: 0; font-family: Menlo, monospace; }
.modal > footer { padding: 14px 18px; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 10px; }
.footer-btns { display: flex; gap: 8px; justify-content: flex-end; }
.test-result { font-size: 12px; padding: 8px 10px; border-radius: 6px; word-break: break-word; }
.test-result.ok { background: rgba(60, 180, 90, 0.15); color: #7fd99a; border: 1px solid rgba(60, 180, 90, 0.3); }
.test-result.err { background: rgba(220, 60, 60, 0.15); color: #ff8a8a; border: 1px solid rgba(220, 60, 60, 0.3); }
.modal > footer button { padding: 8px 16px; border-radius: 6px; border: 1px solid var(--border); background: transparent; color: var(--text); cursor: pointer; font-size: 13px; }
.modal > footer button.primary { background: var(--accent); border-color: var(--accent); }
.modal > footer button:disabled { opacity: 0.5; cursor: not-allowed; }
.health { font-size: 11px; margin: 6px 0 0; color: var(--muted); display: flex; align-items: center; gap: 6px; }
.dot { width: 8px; height: 8px; border-radius: 50%; }
.dot.ok { background: var(--ok); }
.dot.off { background: #c33; }

.new-talk { padding: 12px; display: flex; gap: 6px; border-bottom: 1px solid var(--border); }
.new-talk input { flex: 1; min-width: 0; background: var(--panel-2); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 8px; }
.new-talk button { background: var(--accent); color: #fff; border: none; padding: 8px 12px; border-radius: 6px; font-weight: 600; cursor: pointer; }
.new-talk button:disabled { opacity: 0.4; cursor: not-allowed; }

.talks { list-style: none; margin: 0; padding: 8px; overflow-y: auto; flex: 1; }
.talks li { padding: 10px 12px; border-radius: 6px; cursor: pointer; margin-bottom: 4px; }
.talks li:hover { background: var(--panel-2); }
.talks li.active { background: var(--panel-2); border-left: 3px solid var(--accent); }
.t-title { font-weight: 600; font-size: 13px; }
.t-meta { display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: var(--muted); margin-top: 2px; }
.t-del { background: transparent; border: none; color: var(--muted); cursor: pointer; font-size: 16px; padding: 0 4px; }
.t-del:hover { color: #c33; }
.empty { padding: 20px; color: var(--muted); font-size: 13px; text-align: center; }

.chat-pane { display: flex; flex-direction: column; height: 100vh; min-width: 0; border-right: 1px solid var(--border); }
.chat-pane.empty-state { align-items: center; justify-content: center; text-align: center; color: var(--muted); padding: 40px; border-right: none; }

.topbar { padding: 14px 20px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
.title-block { min-width: 0; }
.topbar h2 { margin: 0; font-size: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 420px; }
.topbar h2.editable { cursor: pointer; }
.topbar h2.editable:hover { color: var(--accent); }
.saved-badge { color: var(--ok); margin-left: 4px; }
.topbar .sub { margin: 4px 0 0; font-size: 12px; color: var(--muted); }
.actions { display: flex; gap: 8px; }
.actions button { background: var(--panel-2); color: var(--text); border: 1px solid var(--border); padding: 8px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; }
.actions button:hover:not(:disabled) { border-color: var(--accent); }
.actions button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
.actions button:disabled { opacity: 0.4; cursor: not-allowed; }

.chat { flex: 1; overflow-y: auto; padding: 20px; }
.empty-chat { color: var(--muted); text-align: center; margin-top: 80px; }
.msg { max-width: 780px; margin-bottom: 14px; padding: 12px 16px; border-radius: 10px; }
.msg.user { background: #1f1f30; margin-left: auto; }
.msg.assistant { background: var(--panel); border: 1px solid var(--border); }
.msg.system { background: transparent; border: 1px dashed var(--ok); color: #9fd29f; font-size: 13px; }
.who { font-size: 10px; opacity: 0.6; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
.text { white-space: pre-wrap; line-height: 1.55; font-size: 14px; }
.badge { display: inline-block; background: var(--ok); color: #fff; font-size: 10px; padding: 2px 8px; border-radius: 999px; margin-top: 6px; }

.thinking .dots { display: flex; gap: 6px; padding: 4px 0; }
.thinking .dots span {
  width: 8px; height: 8px; border-radius: 50%; background: var(--accent);
  animation: bounce 1.2s infinite ease-in-out;
}
.thinking .dots span:nth-child(2) { animation-delay: 0.15s; }
.thinking .dots span:nth-child(3) { animation-delay: 0.3s; }
.thinking-label { font-size: 11px; color: var(--muted); margin-top: 6px; animation: pulse 2s infinite; }
@keyframes bounce {
  0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
  40% { transform: scale(1); opacity: 1; }
}
@keyframes pulse { 0%, 100% { opacity: 0.5; } 50% { opacity: 1; } }

.composer { border-top: 1px solid var(--border); padding: 14px 20px; display: grid; grid-template-columns: 1fr auto; gap: 12px; }
.composer textarea { background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 10px; resize: vertical; min-height: 60px; }
.composer button { background: var(--accent); color: #fff; border: none; padding: 0 24px; border-radius: 8px; font-weight: 600; cursor: pointer; }
.composer button:disabled { opacity: 0.4; cursor: not-allowed; }
.err { grid-column: 1 / -1; color: #ff6b6b; margin: 0; font-size: 13px; }

.preview-pane { background: var(--panel); border-left: 1px solid var(--border); display: flex; flex-direction: column; height: 100vh; min-width: 0; }
.preview-head { padding: 14px 16px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.preview-head h3 { margin: 0; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); }
.mode-toggle { display: flex; background: #0a0a0a; border: 1px solid var(--border); border-radius: 6px; padding: 2px; }
.mode-toggle button { background: transparent; border: 0; color: var(--muted); font-size: 11px; padding: 4px 10px; border-radius: 4px; cursor: pointer; text-transform: uppercase; letter-spacing: 0.5px; }
.mode-toggle button.active { background: var(--accent); color: #fff; }
.count { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.preview-empty { padding: 40px 20px; text-align: center; color: var(--muted); font-size: 13px; }

.preview-main { flex: 1; display: grid; grid-template-columns: 36px 1fr 36px; align-items: center; padding: 16px; gap: 8px; min-height: 0; }
.nav { background: transparent; border: 1px solid var(--border); color: var(--text); width: 36px; height: 36px; border-radius: 50%; font-size: 20px; cursor: pointer; line-height: 1; }
.nav:hover:not(:disabled) { background: var(--panel-2); border-color: var(--accent); }
.nav:disabled { opacity: 0.25; cursor: not-allowed; }

.slide-card.big { aspect-ratio: 16/9; background: #000; border: 1px solid var(--border); border-radius: 10px; padding: 28px; display: flex; flex-direction: column; overflow: hidden; }
.slide-card.big .slide-head { display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); margin-bottom: 14px; }
.slide-card.big .slide-head .num { font-weight: 700; color: var(--accent); }
.slide-card.big .slide-head .tpl { text-transform: uppercase; letter-spacing: 1px; }
.slide-card.big .slide-body { flex: 1; overflow-y: auto; font-size: 13px; line-height: 1.5; color: #ddd; }
.slide-card.big .slide-body h4 { margin: 0 0 10px; font-size: 22px; color: #fff; line-height: 1.25; }
.slide-card.big .slide-body .sub { margin: 0 0 6px; color: #aaa; font-size: 14px; font-style: italic; }
.slide-card.big .slide-body .author { margin: 12px 0 0; color: var(--accent); font-size: 12px; }
.slide-card.big .slide-body .big-q { font-size: 22px; font-weight: 600; color: var(--accent); margin: 20px 0 0; line-height: 1.3; }
.slide-card.big .slide-body .closing { font-size: 22px; font-style: italic; color: #fff; margin: 20px 0 0; white-space: pre-wrap; line-height: 1.4; text-align: center; }
.slide-card.big .slide-body .caption { color: var(--muted); font-size: 12px; margin: 6px 0; }
.slide-card.big .slide-body .bullets { margin: 0; padding-left: 18px; }
.slide-card.big .slide-body .bullets li { margin-bottom: 6px; }

.slide-card.big .slide-body .comp { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.slide-card.big .slide-body .comp strong { display: block; color: var(--accent); font-size: 13px; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; }
.slide-card.big .slide-body .comp ul { margin: 0; padding-left: 16px; }
.slide-card.big .slide-body .comp li { margin-bottom: 4px; font-size: 12px; }

.slide-card.big .metrics-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; }
.slide-card.big .metric { background: var(--panel-2); padding: 12px; border-radius: 6px; }
.slide-card.big .metric-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); margin-bottom: 6px; }
.slide-card.big .metric-vals { display: flex; align-items: baseline; gap: 6px; font-weight: 700; }
.slide-card.big .metric-vals .before { color: #888; text-decoration: line-through; font-size: 14px; }
.slide-card.big .metric-vals .arrow { color: var(--accent); }
.slide-card.big .metric-vals .after { color: var(--accent); font-size: 18px; }

.slide-card.big .steps .step { display: grid; grid-template-columns: 80px 1fr; gap: 12px; padding: 6px 0; border-bottom: 1px solid #1a1a24; }
.slide-card.big .steps .time { color: var(--accent); font-weight: 700; font-size: 12px; }
.slide-card.big .steps .event { font-size: 13px; }

.slide-card.big .code-block { background: #14141c; border-radius: 6px; padding: 14px; font-family: Menlo, monospace; font-size: 12px; color: #9fd29f; overflow: auto; margin: 0; max-height: 240px; }
.slide-card.big .diag-block { background: var(--panel-2); border-radius: 6px; padding: 14px; }
.slide-card.big .diag-block .diag-label { color: var(--muted); font-size: 11px; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; }
.slide-card.big .diag-block pre { font-family: Menlo, monospace; font-size: 10px; color: #aaa; margin: 0; max-height: 160px; overflow: auto; }

.slide-card.big .quote { margin: 14px 0 0; padding-top: 12px; border-top: 1px solid #2a2a38; font-size: 12px; font-style: italic; color: var(--muted); }
.slide-card.big .footnote { margin: 10px 0 0; font-size: 10px; color: var(--muted); }

.filmstrip { border-top: 1px solid var(--border); padding: 10px; display: flex; gap: 6px; overflow-x: auto; flex-shrink: 0; }
.thumb { flex-shrink: 0; width: 64px; height: 40px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 4px; color: var(--muted); cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 2px; font-size: 10px; }
.thumb:hover { border-color: var(--accent); }
.thumb.active { border-color: var(--accent); background: #2a1110; color: #fff; }
.thumb-num { font-weight: 700; font-size: 12px; }
.thumb-tpl { font-size: 8px; text-transform: uppercase; opacity: 0.7; }

.tpl-cover { background: linear-gradient(135deg, #000 0%, #1a0508 100%); }
.tpl-section { background: var(--accent); }
.tpl-section .slide-head, .tpl-section .slide-body h4 { color: #fff; }
.tpl-question { background: #14141c; }
.tpl-closing { background: linear-gradient(135deg, #000 0%, #1a0508 100%); }
.search-box { padding: 8px 12px; border-bottom: 1px solid var(--border); position: relative; }
.search-box input { width: 100%; background: #0a0a0a; border: 1px solid var(--border); color: var(--text); padding: 6px 10px; border-radius: 6px; font-size: 12px; }
.search-results { max-height: 320px; overflow-y: auto; margin-top: 6px; }
.search-loading, .search-err { font-size: 11px; color: var(--muted); padding: 4px; }
.search-err { color: #ff8a8a; }
.search-section h4 { margin: 8px 0 4px; font-size: 10px; text-transform: uppercase; color: var(--muted); letter-spacing: 0.5px; }
.search-hit { display: flex; flex-direction: column; align-items: flex-start; width: 100%; background: #0a0a0a; border: 1px solid var(--border); color: var(--text); text-align: left; padding: 6px 8px; border-radius: 4px; margin-bottom: 4px; cursor: pointer; font-size: 11px; gap: 2px; }
.search-hit:hover { border-color: var(--accent); }
.hit-talk { color: var(--accent); font-weight: 600; }
.hit-meta { color: var(--muted); font-size: 10px; }
.hit-snippet { color: var(--text); opacity: 0.85; line-height: 1.3; }
.hit-snippet :deep(mark) { background: rgba(255, 64, 19, 0.3); color: #fff; padding: 0 2px; border-radius: 2px; }

.similar-box { padding: 10px 12px; border-top: 1px solid var(--border); }
.similar-box h4 { margin: 0 0 6px; font-size: 10px; text-transform: uppercase; color: var(--muted); letter-spacing: 0.5px; }
.sim-hit { display: flex; justify-content: space-between; width: 100%; background: transparent; border: 1px solid var(--border); color: var(--text); padding: 6px 8px; border-radius: 4px; margin-bottom: 4px; cursor: pointer; font-size: 11px; }
.sim-hit:hover { border-color: var(--accent); }
.sim-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 160px; }
.sim-score { color: var(--accent); font-weight: 600; }

.sidebar-foot { padding: 8px 12px; border-top: 1px solid var(--border); display: flex; align-items: center; gap: 6px; font-size: 10px; color: var(--muted); margin-top: auto; }
.embed-label { line-height: 1.3; }

.build-log { position: absolute; bottom: 0; left: 0; right: 0; max-height: 60%; min-height: 200px; background: #0a0a0a; border-top: 1px solid var(--border); display: flex; flex-direction: column; z-index: 10; box-shadow: 0 -8px 24px rgba(0,0,0,0.5); }
.build-log header { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--border); }
.bl-meta { display: flex; gap: 12px; align-items: center; }
.bl-label { font-size: 11px; text-transform: uppercase; color: var(--accent); letter-spacing: 0.5px; font-weight: 600; }
.bl-elapsed { font-family: Menlo, monospace; font-size: 11px; color: var(--text); background: #1a1a1a; padding: 2px 8px; border-radius: 4px; }
.bl-status { font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 320px; }
.bl-actions { display: flex; gap: 4px; }
.bl-actions button { background: transparent; border: 0; color: var(--muted); cursor: pointer; font-size: 16px; padding: 2px 8px; }
.bl-actions button:hover { color: var(--text); }
.build-log pre { flex: 1; overflow-y: auto; padding: 12px; font-family: Menlo, monospace; font-size: 11px; color: #b8e6c8; margin: 0; white-space: pre-wrap; word-break: break-word; }

.chat-pane { position: relative; }

.brand-actions { display: flex; gap: 4px; align-items: center; }
.debug-btn { background: transparent; border: 1px solid var(--border); color: var(--muted); padding: 2px 8px; border-radius: 4px; cursor: pointer; font-size: 10px; font-family: Menlo, monospace; }
.debug-btn:hover { color: var(--text); border-color: var(--text); }
.debug-btn.on { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }

.debug-modal { max-width: 900px; width: 90vw; max-height: 85vh; display: flex; flex-direction: column; }
.debug-tabs { overflow-y: auto; padding: 16px; }
.debug-section { margin-bottom: 20px; }
.debug-section h4 { font-size: 11px; text-transform: uppercase; color: var(--muted); letter-spacing: 0.5px; margin: 0 0 6px; }
.debug-section pre { background: #0a0a0a; border: 1px solid var(--border); padding: 10px; font-family: Menlo, monospace; font-size: 11px; color: #b8e6c8; max-height: 200px; overflow-y: auto; white-space: pre-wrap; word-break: break-word; border-radius: 4px; margin: 0; }
.debug-section pre.build-pre { color: #b8e6c8; max-height: 240px; }
.debug-events { max-height: 240px; overflow-y: auto; border: 1px solid var(--border); border-radius: 4px; }
.dev-row { display: flex; gap: 8px; padding: 4px 8px; border-bottom: 1px solid var(--border); font-family: Menlo, monospace; font-size: 10px; }
.dev-row:last-child { border-bottom: 0; }
.dev-kind { color: var(--accent); flex-shrink: 0; min-width: 100px; }
.dev-payload { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.btn-small { background: transparent; border: 1px solid var(--border); color: var(--muted); padding: 4px 10px; font-size: 10px; border-radius: 4px; cursor: pointer; margin-top: 6px; }
.raw-toggle { margin-top: 6px; }
.raw-btn { background: transparent; border: 0; color: var(--muted); font-size: 10px; cursor: pointer; padding: 2px 0; font-family: Menlo, monospace; }
.raw-btn:hover { color: var(--text); }
.raw-pre { background: #0a0a0a; border: 1px solid var(--border); padding: 8px; margin: 4px 0 0; font-family: Menlo, monospace; font-size: 10px; color: #b8e6c8; max-height: 240px; overflow-y: auto; white-space: pre-wrap; word-break: break-word; border-radius: 4px; }
.plan-card { margin-top: 6px; border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; background: #0d0d0d; }
.plan-preamble { font-size: 13px; margin-bottom: 8px; color: var(--text); }
.plan-actions { list-style: none; padding: 0; margin: 0 0 8px; }
.plan-action { display: grid; grid-template-columns: 120px 1fr auto; gap: 8px; padding: 4px 0; font-size: 12px; border-bottom: 1px dashed var(--border); align-items: baseline; }
.plan-action:last-child { border-bottom: 0; }
.pa-type { font-family: Menlo, monospace; font-size: 11px; color: var(--muted); }
.pa-desc { color: var(--text); word-break: break-word; }
.pa-status { font-size: 11px; color: var(--muted); font-family: Menlo, monospace; }
.plan-action.running .pa-status { color: #e6c97a; }
.plan-action.done .pa-status { color: #7ad48a; }
.plan-action.error .pa-status { color: #e67a7a; }
.plan-controls { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }
.plan-controls .btn-row { display: flex; gap: 6px; justify-content: flex-end; }
.plan-controls.ok { color: #7ad48a; font-size: 12px; }
.plan-controls .warn { font-size: 11px; color: #e6c97a; margin: 0; }
.auto-toggle { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
.auto-toggle input { margin: 0; }
.pa-tokens { grid-column: 1 / -1; text-align: right; font-family: Menlo, monospace; font-size: 10px; color: var(--muted); }
.plan-totals { margin-top: 6px; font-size: 11px; font-family: Menlo, monospace; color: var(--muted); text-align: right; }
.ctx-badge { background: transparent; border: 1px solid var(--border); color: var(--muted); font-family: Menlo, monospace; font-size: 11px; padding: 2px 8px; border-radius: 999px; cursor: pointer; }
.ctx-badge:hover { color: var(--text); border-color: var(--text); }
.ctx-table { width: 100%; font-size: 13px; border-collapse: collapse; }
.ctx-table td { padding: 4px 6px; border-bottom: 1px dashed var(--border); }
.ctx-table td:last-child { text-align: right; font-family: Menlo, monospace; color: var(--text); }
.ctx-table tr.hi td { color: var(--text); font-weight: 600; }
.pa-edit { background: #111; border: 1px solid var(--border); color: var(--text); font-size: 12px; padding: 2px 6px; border-radius: 3px; font-family: inherit; min-width: 0; }
.pa-edits { display: inline-flex; gap: 4px; align-items: center; }
.link-btn { background: transparent; border: 0; color: var(--muted); font-size: 11px; cursor: pointer; padding: 2px 6px; font-family: Menlo, monospace; }
.link-btn:hover { color: var(--text); }
.link-btn.danger:hover { color: #e67a7a; }
.cache-badge { display: inline-block; padding: 0 4px; border-radius: 3px; font-size: 9px; background: #1a3a5c; color: #9ec5e0; margin-left: 4px; text-transform: uppercase; }
.autocompact-banner { padding: 6px 12px; background: #2b1f0a; border-bottom: 1px solid #4a3a1a; color: #e6c97a; font-size: 12px; }
.theme-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
.theme-card { padding: 16px; border: 2px solid; border-radius: 6px; cursor: pointer; text-align: left; min-height: 90px; transition: transform 120ms; font-family: inherit; }
.theme-card:hover { transform: translateY(-2px); }
.theme-card.active { box-shadow: 0 0 0 3px var(--text); }
.theme-title { font-size: 16px; font-weight: 700; margin-bottom: 4px; }
.theme-sub { font-size: 12px; margin-bottom: 8px; }
.theme-id { font-family: Menlo, monospace; font-size: 10px; opacity: 0.6; }
</style>
