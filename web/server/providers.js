import { spawn, spawnSync } from 'node:child_process'

function runCli(binary, args, prompt, { timeoutMs = 1_800_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env: process.env })
    let stdout = '', stderr = ''
    const t = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`${binary} timed out`)) }, timeoutMs)
    child.stdout.on('data', d => stdout += d.toString())
    child.stderr.on('data', d => stderr += d.toString())
    child.on('error', err => { clearTimeout(t); reject(err) })
    child.on('close', code => {
      clearTimeout(t)
      if (code !== 0) return reject(new Error(`${binary} exited ${code}: ${stderr.slice(0, 400)}`))
      resolve(stdout)
    })
  })
}

async function* streamCli(binary, args, { timeoutMs = 1_800_000, signal } = {}) {
  const child = spawn(binary, args, { env: process.env })
  const queue = []
  let resolveNext, rejectAll, done = false, error = null
  const t = setTimeout(() => { child.kill('SIGTERM'); error = new Error(`${binary} timed out`); if (resolveNext) resolveNext() }, timeoutMs)
  const onAbort = () => { try { child.kill('SIGTERM') } catch {}; error = new Error('cancelled'); done = true; if (resolveNext) { const r = resolveNext; resolveNext = null; r() } }
  if (signal) {
    if (signal.aborted) { onAbort() }
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  child.stdout.on('data', d => {
    queue.push(d.toString())
    if (resolveNext) { const r = resolveNext; resolveNext = null; r() }
  })
  child.stderr.on('data', d => {
    queue.push({ stderr: d.toString() })
    if (resolveNext) { const r = resolveNext; resolveNext = null; r() }
  })
  child.on('close', () => { clearTimeout(t); done = true; if (resolveNext) { const r = resolveNext; resolveNext = null; r() } })
  child.on('error', e => { clearTimeout(t); error = e; done = true; if (resolveNext) { const r = resolveNext; resolveNext = null; r() } })

  while (!done || queue.length) {
    if (queue.length) { yield queue.shift(); continue }
    await new Promise(r => { resolveNext = r })
  }
  if (error) throw error
}

async function* streamAnthropic(prompt, cfg, { signal } = {}) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.anthropic_api_key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: cfg.anthropic_model || 'claude-sonnet-4-5',
      max_tokens: 8192,
      stream: true,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!r.ok) throw new Error(`Anthropic HTTP ${r.status}: ${await r.text()}`)
  const reader = r.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const payload = line.slice(6)
      if (payload === '[DONE]') return
      try {
        const ev = JSON.parse(payload)
        if (ev.type === 'content_block_delta' && ev.delta?.text) yield ev.delta.text
      } catch {}
    }
  }
}

async function* streamOpenAI(prompt, cfg, { signal } = {}) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.openai_api_key}`,
    },
    body: JSON.stringify({
      model: cfg.openai_model || 'gpt-4o',
      stream: true,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!r.ok) throw new Error(`OpenAI HTTP ${r.status}: ${await r.text()}`)
  const reader = r.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const payload = line.slice(6)
      if (payload === '[DONE]') return
      try {
        const ev = JSON.parse(payload)
        const t = ev.choices?.[0]?.delta?.content
        if (t) yield t
      } catch {}
    }
  }
}

function checkBinary(binary) {
  try {
    const r = spawnSync('which', [binary], { encoding: 'utf-8' })
    return r.status === 0 && r.stdout.trim().length > 0
  } catch { return false }
}

function timeoutMs(cfg) {
  const m = Number(cfg?.llm_timeout_minutes)
  if (!m || m <= 0 || !isFinite(m)) return 1_800_000
  return Math.min(Math.max(m, 1), 180) * 60 * 1000
}

async function fetchJson(url, opts) {
  const r = await fetch(url, opts)
  const text = await r.text()
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 400)}`)
  try { return JSON.parse(text) } catch { throw new Error('bad json response') }
}

const providers = {
  copilot: {
    label: 'GitHub Copilot CLI',
    needs: 'binary',
    check: (cfg) => ({ ok: checkBinary(cfg.copilot_binary), detail: cfg.copilot_model || 'padrão' }),
    run: (prompt, cfg) => {
      const args = ['-p', prompt, '--allow-all-tools']
      if (cfg.copilot_model) args.push('--model', cfg.copilot_model)
      return runCli(cfg.copilot_binary, args, prompt, { timeoutMs: timeoutMs(cfg) })
    },
    stream: (prompt, cfg, opts) => {
      const args = ['-p', prompt, '--allow-all-tools']
      if (cfg.copilot_model) args.push('--model', cfg.copilot_model)
      return streamCli(cfg.copilot_binary, args, { timeoutMs: timeoutMs(cfg), signal: opts?.signal })
    },
  },

  claude: {
    label: 'Claude Code CLI',
    needs: 'binary',
    check: (cfg) => ({ ok: checkBinary(cfg.claude_binary), detail: cfg.claude_model || 'padrão' }),
    run: (prompt, cfg) => {
      const args = ['-p', prompt, '--dangerously-skip-permissions']
      if (cfg.claude_model) args.push('--model', cfg.claude_model)
      return runCli(cfg.claude_binary, args, prompt, { timeoutMs: timeoutMs(cfg) })
    },
    stream: (prompt, cfg, opts) => {
      const args = ['-p', prompt, '--dangerously-skip-permissions']
      if (cfg.claude_model) args.push('--model', cfg.claude_model)
      return streamCli(cfg.claude_binary, args, { timeoutMs: timeoutMs(cfg), signal: opts?.signal })
    },
  },

  opencode: {
    label: 'OpenCode CLI',
    needs: 'binary',
    check: (cfg) => ({ ok: checkBinary(cfg.opencode_binary), detail: cfg.opencode_model || 'padrão' }),
    run: (prompt, cfg) => {
      const args = ['run']
      if (cfg.opencode_model) args.push('--model', cfg.opencode_model)
      args.push(prompt)
      return runCli(cfg.opencode_binary, args, prompt, { timeoutMs: timeoutMs(cfg) })
    },
    stream: (prompt, cfg, opts) => {
      const args = ['run']
      if (cfg.opencode_model) args.push('--model', cfg.opencode_model)
      args.push(prompt)
      return streamCli(cfg.opencode_binary, args, { timeoutMs: timeoutMs(cfg), signal: opts?.signal })
    },
  },

  anthropic: {
    label: 'Anthropic API',
    needs: 'key',
    check: (cfg) => ({ ok: !!cfg.anthropic_api_key, detail: cfg.anthropic_model }),
    run: async (prompt, cfg) => {
      if (!cfg.anthropic_api_key) throw new Error('Configure a Anthropic API key em Settings')
      const data = await fetchJson('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': cfg.anthropic_api_key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: cfg.anthropic_model || 'claude-sonnet-4-5',
          max_tokens: 8192,
          messages: [{ role: 'user', content: prompt }],
        }),
      })
      return (data.content || []).map(c => c.text || '').join('\n')
    },
    stream: (prompt, cfg, opts) => {
      if (!cfg.anthropic_api_key) throw new Error('Configure a Anthropic API key em Settings')
      return streamAnthropic(prompt, cfg, opts)
    },
  },

  openai: {
    label: 'OpenAI API',
    needs: 'key',
    check: (cfg) => ({ ok: !!cfg.openai_api_key, detail: cfg.openai_model }),
    run: async (prompt, cfg) => {
      if (!cfg.openai_api_key) throw new Error('Configure a OpenAI API key em Settings')
      const data = await fetchJson('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${cfg.openai_api_key}`,
        },
        body: JSON.stringify({
          model: cfg.openai_model || 'gpt-4o',
          messages: [{ role: 'user', content: prompt }],
        }),
      })
      return data.choices?.[0]?.message?.content || ''
    },
    stream: (prompt, cfg, opts) => {
      if (!cfg.openai_api_key) throw new Error('Configure a OpenAI API key em Settings')
      return streamOpenAI(prompt, cfg, opts)
    },
  },
}

export function listProviders(cfg) {
  return Object.entries(providers).map(([id, p]) => {
    const c = p.check(cfg)
    return { id, label: p.label, needs: p.needs, configured: c.ok, detail: c.detail }
  })
}

export function checkProvider(id, cfg) {
  const p = providers[id]
  if (!p) return { ok: false, error: `provider ${id} desconhecido` }
  return p.check(cfg)
}

export async function runProvider(id, prompt, cfg) {
  const p = providers[id]
  if (!p) throw new Error(`provider ${id} desconhecido`)
  return p.run(prompt, cfg)
}

export function streamProvider(id, prompt, cfg, opts = {}) {
  const p = providers[id]
  if (!p) throw new Error(`provider ${id} desconhecido`)
  if (!p.stream) throw new Error(`provider ${id} não suporta streaming`)
  return p.stream(prompt, cfg, opts)
}

export const PROVIDER_IDS = Object.keys(providers)
