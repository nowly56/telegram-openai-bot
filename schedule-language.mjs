import { nextRun } from './reports.mjs';

// Deliberately bounded grammar: unknown requests never silently change a schedule.
export function parseSchedule(text, now = Date.now()) {
  const s = text.toLowerCase().replaceAll('ё', 'е');
  if (!/отчет/.test(s) || !/(присылай|присылать|отправляй|отправлять|настрой|составляй|кажд|ежеднев|еженедел)/.test(s)) return null;
  if (/(не\s+(?:присылай|отправляй|составляй)|отмени|отключи|перестань)/.test(s)) return { error: 'Для отключения: /reports off daily или /reports off weekly.' };
  const days = [/воскресень/, /понедельник/, /вторник/, /сред[ау]/, /четверг/, /пятниц/, /суббот/];
  const selected = days.map((r, i) => r.test(s) ? i : -1).filter(i => i >= 0);
  if (selected.length > 1) return { error: 'Для недельного отчёта укажи один день недели.' };
  const daily = /ежеднев|каждый день|кажд[ыую]+\s+сутк|дневной/.test(s);
  const weekly = /еженедел|недельн/.test(s) || selected.length === 1;
  if (!daily && !weekly) return { error: 'Укажи период: ежедневно или каждую неделю, например «каждый понедельник в 10:00».' };
  const times = [...s.matchAll(/(?:в\s+)?(\d{1,2})[:.](\d{2})(?!\d)/g)];
  if (times.length > 1) return { error: 'Укажи одно время; разные часы для дневного и недельного отчёта настрой отдельными сообщениями.' };
  if (!times.length && /\b\d/.test(s.replace(/(?:рейтинг|позиция|значени)[^.!?]*?5/g, ''))) return { error: 'Укажи время в формате 10:00.' };
  const time = times.length ? `${times[0][1].padStart(2, '0')}:${times[0][2]}` : '10:00';
  const zoneMatch = text.match(/\b[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?\b/);
  if (!zoneMatch && /(по\s+(?!моск)[а-я]+\s+времени|utc|gmt)/.test(s)) return { error: 'Укажи часовой пояс IANA, например Europe/Moscow или Asia/Yekaterinburg.' };
  const zone = zoneMatch?.[0] || 'Europe/Moscow';
  const jobs = [daily && { kind: 'daily', time, zone, day: 1 }, weekly && { kind: 'weekly', time, zone, day: selected[0] ?? 1 }].filter(Boolean);
  try { for (const j of jobs) nextRun(j.kind, j.time, j.zone, j.day, now); }
  catch (e) { return { error: e.message }; }
  const reset = /(?:рейтинг|позици|значени)/.test(s) && /(?:старт|начал|сброс|с этого момента)/.test(s) && /(?:^|\D)5(?:\D|$)/.test(s);
  return { jobs, reset };
}
