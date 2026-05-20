import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'

const CACHE_DIR = process.env.TALK_CACHE_DIR
  || path.join(os.homedir(), 'Documents', 'talks', '.llm-cache')

const MAX_FILES = 2000
const TTL_MS = 1000 * 60 * 60 * 24 * 7

function ensureDir() {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }) } catch {}
}

function keyFor(provider, model, prompt) {
  const h = crypto.createHash('sha256')
  h.update(provider || '')
  h.update('\x00')
  h.update(model || '')
  h.update('\x00')
  h.update(prompt || '')
  return h.digest('hex')
}

export function cacheGet(provider, model, prompt) {
  ensureDir()
  const k = keyFor(provider, model, prompt)
  const file = path.join(CACHE_DIR, `${k}.json`)
  try {
    const stat = fs.statSync(file)
    if (Date.now() - stat.mtimeMs > TTL_MS) return null
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
    return raw.reply
  } catch { return null }
}

export function cacheSet(provider, model, prompt, reply) {
  ensureDir()
  const k = keyFor(provider, model, prompt)
  const file = path.join(CACHE_DIR, `${k}.json`)
  try {
    fs.writeFileSync(file, JSON.stringify({ provider, model, reply, ts: Date.now() }))
    rotate()
  } catch {}
}

function rotate() {
  try {
    const entries = fs.readdirSync(CACHE_DIR).map(f => ({
      f, mtime: fs.statSync(path.join(CACHE_DIR, f)).mtimeMs,
    }))
    if (entries.length <= MAX_FILES) return
    entries.sort((a, b) => a.mtime - b.mtime)
    const toDel = entries.slice(0, entries.length - MAX_FILES)
    for (const e of toDel) try { fs.unlinkSync(path.join(CACHE_DIR, e.f)) } catch {}
  } catch {}
}

export function cacheStats() {
  ensureDir()
  try {
    const files = fs.readdirSync(CACHE_DIR)
    let bytes = 0
    for (const f of files) bytes += fs.statSync(path.join(CACHE_DIR, f)).size
    return { count: files.length, bytes, dir: CACHE_DIR }
  } catch { return { count: 0, bytes: 0, dir: CACHE_DIR } }
}

export function cacheClear() {
  try {
    const files = fs.readdirSync(CACHE_DIR)
    for (const f of files) try { fs.unlinkSync(path.join(CACHE_DIR, f)) } catch {}
    return files.length
  } catch { return 0 }
}
