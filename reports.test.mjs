import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { namePattern, nextRun, Reports, recentContext } from './reports.mjs';

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
  try {
    const file = join(dir, 'reports.json');
    const r = new Reports(file);
    const start = Date.parse('2026-09-20T09:00:00Z');
    r.observe('1', { id: 2, first_name: 'Иван' });
    r.configure('1', 'weekly', '10:00', 'Europe/Moscow', 1, start);
    const due = r.chat('1').jobs.weekly.due;
    let generations = 0;
    const generate = async (c, j, rows) => { generations++; assert.equal(rows.length, 1); return { text: 'Отчёт', ratings: { 2: 6 } }; };
    const history = new Map([['1', [{ role: 'user', userId: 2, at: start + 1 }, { role: 'user', content: 'old without timestamp' }, { role: 'user', userId: 2, at: due }]]]);
    await r.tick(history, generate, async () => { throw new Error('offline'); }, due);
    assert.equal(r.chat('1').members[2].rating, 5);
    const restored = new Reports(file);
    let sends = 0;
    await restored.tick(history, generate, async () => sends++, due + 300001);
    await restored.tick(history, generate, async () => sends++, due + 300002);
    assert.equal(generations, 1);
    assert.equal(sends, 1);
    assert.equal(restored.chat('1').members[2].rating, 6);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('daily reports leave ratings unchanged and empty periods work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'robert-tests-'));
  try {
    const r = new Reports(join(dir, 'r.json'));
    r.observe('1', { id: 3, first_name: 'Анна' });
    r.configure('1', 'daily', '10:00', 'UTC', 1, Date.parse('2026-09-20T09:00Z'));
    await r.tick(new Map(), async (c, j, rows) => { assert.equal(rows.length, 0); return { text: 'empty', ratings: { 3: 9 } }; }, async () => {}, r.chat('1').jobs.daily.due);
    assert.equal(r.chat('1').members[3].rating, 5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
