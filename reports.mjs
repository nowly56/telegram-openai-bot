import { randomUUID } from 'node:crypto';
import { deliverReport, resolveDelivery } from './delivery.mjs';

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
  constructor(store) {
    this.store = store;
    this.chats = store.getState('reports', {});
  }
  chat(id) { return this.chats[id] ||= { members: {}, jobs: {} }; }
  save() {
    this.store.setState('reports', this.chats);
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
  propose(id, userId, proposal, now = Date.now()) {
    const c = this.chat(id);
    c.proposal = { ...proposal, userId: String(userId), token: randomUUID().slice(0, 8), expires: now + 600000 };
    this.save();
    return c.proposal;
  }
  confirm(id, userId, token, now = Date.now()) {
    const c = this.chat(id), p = c.proposal;
    if (!p || p.token !== token || p.userId !== String(userId) || p.expires < now) throw new Error('Подтверждение устарело или принадлежит другому администратору');
    if (Object.values(c.jobs).some(j => j.pending)) throw new Error('Сначала завершите отправку текущего отчёта');
    const jobs = p.jobs.map(j => ({ ...j, due: nextRun(j.kind, j.time, j.zone, j.day, now), since: now }));
    if (p.reset) {
      for (const m of Object.values(c.members)) m.rating = 5;
      for (const j of Object.values(c.jobs)) j.since = now;
    }
    for (const j of jobs) c.jobs[j.kind] = j;
    delete c.proposal;
    this.save();
  }
  resolve(id, kind, action) {
    const job = this.chat(id).jobs[kind];
    resolveDelivery(job?.pending, action);
    delete job.retryAt;
    this.save();
  }
  async tick(history, generate, send, now = Date.now()) {
    for (const [id, c] of Object.entries(this.chats)) {
      for (const job of Object.values(c.jobs)) {
        if (job.due > now || job.retryAt > now) continue;
        try {
          // Freeze the report and rating changes before delivery: retries do not regenerate it.
          if (!job.pending) {
            const rows = history.period(id, job.since, job.due);
            job.pending = await generate(c, job, rows);
            this.save();
          }
          job.pending.id ||= randomUUID().slice(0, 8);
          if (!await deliverReport(id, job.pending, () => this.save(), send)) {
            if (!job.pending.noticeAttempted) {
              job.pending.noticeAttempted = true;
              this.save();
              await send(id, `Доставка части отчёта ${job.pending.id} не подтверждена из-за сбоя связи. Автоповтор приостановлен.\nЕсли часть получена: /reports delivered ${job.kind}\nЕсли не получена: /reports retry ${job.kind} (возможен дубль)\n/reports status — подробности.`);
            }
            continue;
          }
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
