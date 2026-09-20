import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { namePattern, nextRun, Reports, recentContext } from './reports.mjs';
import { Storage } from './storage.mjs';

test('API context is bounded and excludes storage metadata', () => {
  const rows = [{ role: 'user', content: '12345', userId: 9 }, { role: 'assistant', content: '6789', at: 1 }];
  assert.deepEqual(recentContext(rows, 7), [{ role: 'user', content: '123' }, { role: 'assistant', content: '6789' }]);
});

test('Russian name boundaries include punctuation but not other names', () => {
  for (const text of ['Роберт, привет', 'Роберт!', 'роберт?', 'Привет, Роберт.', 'Роберт']) assert.ok(namePattern('Роберт').test(text), text);
  for (const text of ['Роберто', 'Роберта', 'СуперРоберт', 'Роберт_123']) assert.ok(!namePattern('Роберт').test(text), text);
});
test('daily and weekly schedule use the requested timezone', () => {
  const now = Date.parse('2026-09-20T09:00:00Z');
  assert.equal(nextRun('daily', '10:00', 'Europe/Moscow', 1, now), Date.parse('2026-09-21T07:00:00Z'));
  assert.equal(nextRun('weekly', '10:00', 'Europe/Moscow', 1, now), Date.parse('2026-09-21T07:00:00Z'));
  assert.throws(() => nextRun('daily', '25:00', 'UTC'));
  assert.throws(() => nextRun('daily', '10:00', 'bad/zone'));
});
test('failed delivery survives restart; weekly rating is applied once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'robert-tests-'));
  let store;
  try {
    const file = join(dir, 'bot.sqlite');
    store = new Storage(file);
    const r = new Reports(store);
    const start = Date.parse('2026-09-20T09:00:00Z');
    r.observe('1', { id: 2, first_name: 'Иван' });
    r.configure('1', 'weekly', '10:00', 'Europe/Moscow', 1, start);
    const due = r.chat('1').jobs.weekly.due;
    let generations = 0;
    const generate = async (c, j, rows) => { generations++; assert.equal(rows.length, 1); return { text: 'Отчёт', ratings: { 2: 6 } }; };
    store.append('1', { role: 'user', content: 'hello', userId: 2, at: start + 1 });
    store.append('1', { role: 'user', content: 'old without timestamp' });
    store.append('1', { role: 'user', content: 'next period', userId: 2, at: due });
    await r.tick(store, generate, async () => { throw Object.assign(new Error('rate limited'), { definitelyRejected: true }); }, due);
    assert.equal(r.chat('1').members[2].rating, 5);
    store.close();
    store = new Storage(file);
    const restored = new Reports(store);
    let sends = 0;
    await restored.tick(store, generate, async () => sends++, due + 300001);
    await restored.tick(store, generate, async () => sends++, due + 300002);
    assert.equal(generations, 1);
    assert.equal(sends, 1);
    assert.equal(restored.chat('1').members[2].rating, 6);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('daily reports leave ratings unchanged and empty periods work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'robert-tests-'));
  let store;
  try {
    store = new Storage(join(dir, 'bot.sqlite'));
    const r = new Reports(store);
    r.observe('1', { id: 3, first_name: 'Анна' });
    r.configure('1', 'daily', '10:00', 'UTC', 1, Date.parse('2026-09-20T09:00Z'));
    await r.tick(store, async (c, j, rows) => { assert.equal(rows.length, 0); return { text: 'empty', ratings: { 3: 9 } }; }, async () => {}, r.chat('1').jobs.daily.due);
    assert.equal(r.chat('1').members[3].rating, 5);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});
