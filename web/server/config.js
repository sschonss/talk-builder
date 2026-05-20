import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const CONFIG_PATH = process.env.TALK_CHAT_CONFIG
  || path.join(os.homedir(), 'Documents', 'talks', '.config.json')

const DEFAULTS = {
  provider: 'copilot',
  anthropic_api_key: '',
  anthropic_model: 'claude-sonnet-4-5',
  openai_api_key: '',
  openai_model: 'gpt-4o',
  copilot_binary: 'copilot',
  copilot_model: '',
  claude_binary: 'claude',
  claude_model: '',
  opencode_binary: 'opencode',
  opencode_model: '',
}

export function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8')
    return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveConfig(patch) {
  const current = loadConfig()
  const next = { ...current, ...patch }
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2))
  try { fs.chmodSync(CONFIG_PATH, 0o600) } catch {}
  return next
}

export function redactConfig(cfg) {
  const mask = (s) => (s ? `${s.slice(0, 7)}${'•'.repeat(8)}${s.slice(-4)}` : '')
  return {
    ...cfg,
    anthropic_api_key: mask(cfg.anthropic_api_key),
    openai_api_key: mask(cfg.openai_api_key),
    has_anthropic_key: !!cfg.anthropic_api_key,
    has_openai_key: !!cfg.openai_api_key,
  }
}

export { CONFIG_PATH }
