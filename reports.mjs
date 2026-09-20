import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

export function namePattern(name) {
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}\\p{N}_])`, 'giu');
}

export function recentContext(history, budget = 40000) {
  const result = [];
  for (let i = history.length - 1; i >= 0 && result.length < 200 && budget > 0; i--) {
    const { role, content } = history[i];
    if (!['user', 'assistant'].includes(role) || typeof content !== 'string') continue;
    const text = content.slice(0, Math.min(6000, budget));
    result.unshift({ role, content: text });
    budget -= text.length;
  }
  return result;
}

export function nextRun(kind, time, zone, weekday = 1, now = Date.now()) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Время должно быть HH:MM, например 10:00');
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (let t = Math.floor(now / 60000) * 60000 + 60000; t <= now + 9 * 86400000; t += 60000) {
    const p = Object.fromEntries(fmt.formatToParts(t).map(x => [x.type, x.value]));
    if (`${p.hour}:${p.minute}` === time && (kind === 'daily' || p.weekday === days[weekday])) return t;
  }
  throw new Error('Не удалось рассчитать расписание');
}

export class Reports {
  constructor(file) {
    this.file = file;
    try { this.chats = JSON.parse(readFileSync(file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; this.chats = {}; }
  }
  chat(id) { return this.chats[id] ||= { members: {}, jobs: {} }; }
  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file + '.tmp', JSON.stringify(this.chats));
    renameSync(this.file + '.tmp', this.file);
  }
  observe(id, from) {
    if (!from || from.is_bot) return;
    const c = this.chat(id);
    const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || String(from.id);
    c.members[from.id] ||= { rating: 5, name };
    c.members[from.id].name = name;
  }
  configure(id, kind, time, zone, day = 1, now = Date.now()) {
    if (!['daily', 'weekly'].includes(kind) || !Number.isInteger(day) || day < 0 || day > 6) throw new Error('Тип: daily/weekly; день: 0–6 (1 = понедельник)');
    const due = nextRun(kind, time, zone, day, now);
    this.chat(id).jobs[kind] = { kind, time, zone, day, due, since: now };
    this.save();
  }
  async tick(history, generate, send, now = Date.now()) {
    for (const [id, c] of Object.entries(this.chats)) {
      for (const job of Object.values(c.jobs)) {
        if (job.due > now || job.retryAt > now) continue;
        try {
          // Freeze the report and rating changes before delivery: retries do not regenerate it.
          if (!job.pending) {
            const rows = (history.get(id) || []).filter(e => e.role === 'user' && e.at >= job.since && e.at < job.due && e.userId);
            job.pending = await generate(c, job, rows);
            this.save();
          }
          await send(id, job.pending.text);
          if (job.kind === 'weekly') for (const [uid, rating] of Object.entries(job.pending.ratings)) {
            if (c.members[uid]) c.members[uid].rating = rating;
          }
          job.since = job.due;
          job.due = nextRun(job.kind, job.time, job.zone, job.day, now);
          delete job.pending;
          delete job.retryAt;
          this.save();
        } catch (e) {
          job.retryAt = now + 300000;
          this.save();
          console.error('Report failed:', e.message);
        }
      }
    }
  }
}
