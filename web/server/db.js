import Database from 'better-sqlite3'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

const DB_PATH = process.env.TALK_INDEX_DB
  || path.join(os.homedir(), 'Documents', 'talks', '.index.db')

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })

export const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS talks (
    slug         TEXT PRIMARY KEY,
    title        TEXT,
    theme        TEXT,
    n_slides     INTEGER DEFAULT 0,
    created_at   TEXT DEFAULT (datetime('now')),
    updated_at   TEXT DEFAULT (datetime('now')),
    last_indexed TEXT
  );

  CREATE TABLE IF NOT EXISTS chats (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    talk_slug   TEXT NOT NULL REFERENCES talks(slug) ON DELETE CASCADE,
    turn_index  INTEGER NOT NULL,
    role        TEXT NOT NULL,
    content     TEXT NOT NULL,
    created_at  TEXT,
    embedding   BLOB,
    embed_model TEXT,
    UNIQUE(talk_slug, turn_index, role)
  );
  CREATE INDEX IF NOT EXISTS idx_chats_talk ON chats(talk_slug);

  CREATE TABLE IF NOT EXISTS slides (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    talk_slug   TEXT NOT NULL REFERENCES talks(slug) ON DELETE CASCADE,
    slide_idx   INTEGER NOT NULL,
    template    TEXT,
    title       TEXT,
    content     TEXT NOT NULL,
    embedding   BLOB,
    embed_model TEXT,
    UNIQUE(talk_slug, slide_idx)
  );
  CREATE INDEX IF NOT EXISTS idx_slides_talk ON slides(talk_slug);

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS chats_fts USING fts5(
    content,
    talk_slug UNINDEXED,
    role UNINDEXED,
    content='chats',
    content_rowid='id'
  );
  CREATE TRIGGER IF NOT EXISTS chats_ai AFTER INSERT ON chats BEGIN
    INSERT INTO chats_fts(rowid, content, talk_slug, role)
    VALUES (new.id, new.content, new.talk_slug, new.role);
  END;
  CREATE TRIGGER IF NOT EXISTS chats_ad AFTER DELETE ON chats BEGIN
    INSERT INTO chats_fts(chats_fts, rowid, content, talk_slug, role)
    VALUES('delete', old.id, old.content, old.talk_slug, old.role);
  END;
  CREATE TRIGGER IF NOT EXISTS chats_au AFTER UPDATE ON chats BEGIN
    INSERT INTO chats_fts(chats_fts, rowid, content, talk_slug, role)
    VALUES('delete', old.id, old.content, old.talk_slug, old.role);
    INSERT INTO chats_fts(rowid, content, talk_slug, role)
    VALUES (new.id, new.content, new.talk_slug, new.role);
  END;

  CREATE VIRTUAL TABLE IF NOT EXISTS slides_fts USING fts5(
    title, content,
    talk_slug UNINDEXED,
    template UNINDEXED,
    content='slides',
    content_rowid='id'
  );
  CREATE TRIGGER IF NOT EXISTS slides_ai AFTER INSERT ON slides BEGIN
    INSERT INTO slides_fts(rowid, title, content, talk_slug, template)
    VALUES (new.id, new.title, new.content, new.talk_slug, new.template);
  END;
  CREATE TRIGGER IF NOT EXISTS slides_ad AFTER DELETE ON slides BEGIN
    INSERT INTO slides_fts(slides_fts, rowid, title, content, talk_slug, template)
    VALUES('delete', old.id, old.title, old.content, old.talk_slug, old.template);
  END;
  CREATE TRIGGER IF NOT EXISTS slides_au AFTER UPDATE ON slides BEGIN
    INSERT INTO slides_fts(slides_fts, rowid, title, content, talk_slug, template)
    VALUES('delete', old.id, old.title, old.content, old.talk_slug, old.template);
    INSERT INTO slides_fts(rowid, title, content, talk_slug, template)
    VALUES (new.id, new.title, new.content, new.talk_slug, new.template);
  END;
`)

function slideToText(s) {
  const d = s.data || {}
  const parts = []
  if (d.title) parts.push(d.title)
  if (d.subtitle) parts.push(d.subtitle)
  if (d.question) parts.push(d.question)
  if (d.text) parts.push(d.text)
  if (d.caption) parts.push(d.caption)
  if (d.quote) parts.push(d.quote)
  if (Array.isArray(d.bullets)) parts.push(...d.bullets)
  if (Array.isArray(d.items)) parts.push(...d.items)
  if (Array.isArray(d.left_items)) parts.push(d.left_title || '', ...d.left_items)
  if (Array.isArray(d.right_items)) parts.push(d.right_title || '', ...d.right_items)
  if (Array.isArray(d.steps)) parts.push(...d.steps.map(x => `${x.time || ''} ${x.event || ''}`))
  if (Array.isArray(d.stats)) parts.push(...d.stats.map(x => `${x.label || ''} ${x.before || ''} -> ${x.after || ''}`))
  if (Array.isArray(d.contacts)) parts.push(...d.contacts)
  if (d.code) parts.push(d.code)
  return parts.filter(Boolean).join('\n')
}

const upsertTalk = db.prepare(`
  INSERT INTO talks (slug, title, theme, n_slides, updated_at, last_indexed)
  VALUES (@slug, @title, @theme, @n_slides, datetime('now'), datetime('now'))
  ON CONFLICT(slug) DO UPDATE SET
    title=excluded.title,
    theme=excluded.theme,
    n_slides=excluded.n_slides,
    updated_at=datetime('now'),
    last_indexed=datetime('now')
`)

const deleteChats = db.prepare(`DELETE FROM chats WHERE talk_slug = ?`)
const insertChat = db.prepare(`
  INSERT INTO chats (talk_slug, turn_index, role, content, created_at)
  VALUES (?, ?, ?, ?, ?)
`)

const deleteSlides = db.prepare(`DELETE FROM slides WHERE talk_slug = ?`)
const insertSlide = db.prepare(`
  INSERT INTO slides (talk_slug, slide_idx, template, title, content)
  VALUES (?, ?, ?, ?, ?)
`)

const deleteTalk = db.prepare(`DELETE FROM talks WHERE slug = ?`)

export function indexTalk(slug, { slides: slidesDoc, messages }) {
  const pres = (slidesDoc && slidesDoc.presentation) || {}
  const themeName = (slidesDoc && slidesDoc.theme && slidesDoc.theme.name) || null
  const slideList = (slidesDoc && Array.isArray(slidesDoc.slides)) ? slidesDoc.slides : []

  const tx = db.transaction(() => {
    upsertTalk.run({
      slug,
      title: pres.title || null,
      theme: themeName,
      n_slides: slideList.length,
    })
    deleteChats.run(slug)
    if (Array.isArray(messages)) {
      messages.forEach((m, i) => {
        insertChat.run(slug, i, m.role || 'user', m.content || '', m.created_at || null)
      })
    }
    deleteSlides.run(slug)
    slideList.forEach((s, i) => {
      const title = (s.data && s.data.title) || null
      insertSlide.run(slug, i, s.template || null, title, slideToText(s))
    })
  })
  tx()
}

export function removeTalk(slug) {
  deleteTalk.run(slug)
}

export function searchChats(query, limit = 20) {
  return db.prepare(`
    SELECT c.talk_slug, c.role, c.content, c.turn_index,
           snippet(chats_fts, 0, '<mark>', '</mark>', '...', 12) AS snippet,
           bm25(chats_fts) AS score
    FROM chats_fts
    JOIN chats c ON c.id = chats_fts.rowid
    WHERE chats_fts MATCH ?
    ORDER BY score
    LIMIT ?
  `).all(query, limit)
}

export function searchSlides(query, limit = 20) {
  return db.prepare(`
    SELECT s.talk_slug, s.slide_idx, s.template, s.title,
           snippet(slides_fts, 1, '<mark>', '</mark>', '...', 12) AS snippet,
           bm25(slides_fts) AS score
    FROM slides_fts
    JOIN slides s ON s.id = slides_fts.rowid
    WHERE slides_fts MATCH ?
    ORDER BY score
    LIMIT ?
  `).all(query, limit)
}

export function stats() {
  return {
    talks: db.prepare(`SELECT COUNT(*) AS n FROM talks`).get().n,
    chats: db.prepare(`SELECT COUNT(*) AS n FROM chats`).get().n,
    slides: db.prepare(`SELECT COUNT(*) AS n FROM slides`).get().n,
    embedded_chats: db.prepare(`SELECT COUNT(*) AS n FROM chats WHERE embedding IS NOT NULL`).get().n,
    embedded_slides: db.prepare(`SELECT COUNT(*) AS n FROM slides WHERE embedding IS NOT NULL`).get().n,
    db_path: DB_PATH,
  }
}

export { DB_PATH }
