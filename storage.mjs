import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class Storage {
  constructor(file, legacyFile) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, chat TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT NOT NULL, at INTEGER, userId TEXT, messageId INTEGER,
        UNIQUE(chat, messageId));
      CREATE INDEX IF NOT EXISTS messages_chat_id ON messages(chat,id);
      CREATE INDEX IF NOT EXISTS messages_chat_time ON messages(chat,at);
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    if (legacyFile) this.migrate(legacyFile);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  getState(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM state WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }
  setState(key, value) {
    this.db.prepare('INSERT INTO state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  }
  append(chat, e) {
    return this.db.prepare('INSERT OR IGNORE INTO messages(chat,role,content,at,userId,messageId) VALUES (?,?,?,?,?,?)')
      .run(String(chat), e.role, e.content, e.at ?? null, e.userId == null ? null : String(e.userId), e.messageId ?? null).changes > 0;
  }
  hasMessage(chat, id) { return Boolean(this.db.prepare('SELECT 1 FROM messages WHERE chat=? AND messageId=?').get(String(chat), id)); }
  recent(chat, limit = 200) {
    return this.db.prepare('SELECT * FROM messages WHERE chat=? ORDER BY id DESC LIMIT ?').all(String(chat), limit).reverse();
  }
  period(chat, since, until) {
    return this.db.prepare("SELECT * FROM messages WHERE chat=? AND role='user' AND at>=? AND at<? AND userId IS NOT NULL ORDER BY id").all(String(chat), since, until);
  }
  memoryBatch(chat, cursor, limit = 100, keep = 40) {
    const cutoff = this.db.prepare('SELECT id FROM messages WHERE chat=? ORDER BY id DESC LIMIT 1 OFFSET ?').get(String(chat), keep);
    if (!cutoff) return [];
    return this.db.prepare('SELECT * FROM messages WHERE chat=? AND id>? AND id<=? ORDER BY id LIMIT ?').all(String(chat), cursor, cutoff.id, limit);
  }
  chatIds() { return this.db.prepare('SELECT DISTINCT chat FROM messages').all().map(r => r.chat); }
  reset(chat) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM messages WHERE chat=?').run(String(chat));
      this.db.prepare('DELETE FROM state WHERE key=?').run(`memory:${chat}`);
      this.setState(`memory-version:${chat}`, this.getState(`memory-version:${chat}`, 0) + 1);
    });
  }
  migrate(file) {
    if (this.getState('migration:v1')) return;
    const read = path => {
      try { const data = JSON.parse(readFileSync(path, 'utf8')); if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error(`Некорректный архив: ${path}`); return data; }
      catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
    };
    const history = read(file);
    const reports = read(file + '.reports.json');
    this.transaction(() => {
      for (const [chat, rows] of Object.entries(history)) {
        if (!Array.isArray(rows)) throw new Error('Некорректная история чата');
        for (const row of rows) this.append(chat, row);
      }
      this.setState('reports', reports);
      this.setState('migration:v1', { at: Date.now(), source: file });
    });
  }
  close() { this.db.close(); }
}
