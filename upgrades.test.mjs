import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage } from './storage.mjs';
import { Reports } from './reports.mjs';
import { Memory } from './memory.mjs';
import { parseSchedule } from './schedule-language.mjs';
import { deliverReport, resolveDelivery, splitText } from './delivery.mjs';

test('legacy migration is atomic, repeatable and leaves source intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'robert-migrate-'));
  let db;
  try {
    const legacy = join(dir, 'history.json');
    const source = JSON.stringify({ '-100': [{ role: 'user', content: 'old' }, { role: 'user', content: 'new', messageId: 3, userId: 7, at: 100 }] });
    writeFileSync(legacy, source);
    writeFileSync(legacy + '.reports.json', JSON.stringify({ '-100': { members: { 7: { name: 'Alex', rating: 8 } }, jobs: {} } }));
    db = new Storage(join(dir, 'bot.sqlite'), legacy);
    assert.equal(db.recent('-100').length, 2);
    assert.equal(db.getState('reports')['-100'].members[7].rating, 8);
    assert.equal(db.append('-100', { role: 'user', content: 'duplicate', messageId: 3 }), false);
    assert.equal(readFileSync(legacy, 'utf8'), source);
    db.reset('-100');
    db.close();
    db = new Storage(join(dir, 'bot.sqlite'), legacy);
    assert.equal(db.recent('-100').length, 0);
  } finally { db?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('memory advances only after a successful summary and isolates chats', async () => {
  const db = new Storage(':memory:');
  try {
    for (let i = 0; i < 160; i++) db.append('a', { role: 'user', content: `message ${i}` });
    db.append('b', { role: 'user', content: 'private' });
    let calls = 0;
    const m = new Memory(db, async input => { calls++; assert.ok(!JSON.stringify(input).includes('private')); return 'Agreed to meet Monday'; });
    await m.update('a');
    assert.equal(m.read('a').cursor, 100);
    await m.update('a');
    assert.equal(m.read('a').cursor, 120);
    await m.update('a');
    assert.equal(calls, 2);
    assert.equal(m.read('b').text, '');
    assert.equal(db.recent('a', 1000).length, 160);
    db.reset('a');
    assert.equal(m.read('a').text, '');
  } finally { db.close(); }
});

test('failed memory compaction leaves cursor and retries later', async () => {
  const db = new Storage(':memory:');
  try {
    for (let i = 0; i < 80; i++) db.append('a', { role: 'user', content: 'text' });
    let calls = 0;
    const m = new Memory(db, async () => { calls++; throw new Error('API unavailable'); });
    await m.update('a', 1000);
    await m.update('a', 2000);
    assert.equal(calls, 1);
    assert.equal(m.read('a').cursor, 0);
  } finally { db.close(); }
});

test('reset during compaction cannot resurrect memory, even after a new message', async () => {
  const db = new Storage(':memory:');
  try {
    for (let i = 0; i < 80; i++) db.append('a', { role: 'user', content: 'old' });
    let resolve;
    const m = new Memory(db, () => new Promise(r => { resolve = r; }));
    const pending = m.update('a');
    db.reset('a');
    db.append('a', { role: 'user', content: 'new' });
    resolve('Old memory');
    await pending;
    assert.equal(m.read('a').text, '');
    assert.equal(db.recent('a').length, 1);
  } finally { db.close(); }
});

test('Russian proposals require valid time/day and do not apply before owner confirmation', () => {
  const now = Date.parse('2026-09-20T09:00Z');
  const parsed = parseSchedule('Роберт, присылай отчёт каждый понедельник в 10:00 по Москве', now);
  assert.deepEqual(parsed.jobs, [{ kind: 'weekly', time: '10:00', zone: 'Europe/Moscow', day: 1 }]);
  assert.equal(parseSchedule('Роберт, привет'), null);
  assert.ok(parseSchedule('Роберт, не присылай ежедневный отчет').error);
  assert.ok(parseSchedule('Роберт, присылай отчет по понедельникам и пятницам').error);
  assert.ok(parseSchedule('Роберт, присылай ежедневный отчет в 27:00').error);
  assert.equal(parseSchedule('Роберт, присылай отчет каждый день в 9:30 Asia/Yekaterinburg').jobs[0].zone, 'Asia/Yekaterinburg');
  const example = 'Роберт, с этого момента значения каждого участника в системе социального рейтинга 5. Это будет стартовая позиция. Веди этот рейтинг постоянно и обновляй каждый Понедельник. Присылай в Понедельник отчет по каждому участнику';
  assert.equal(parseSchedule(example).reset, true);
  const db = new Storage(':memory:');
  try {
    const r = new Reports(db);
    const p = r.propose('chat', 7, parsed, now);
    assert.deepEqual(r.chat('chat').jobs, {});
    assert.throws(() => r.confirm('chat', 8, p.token, now));
    assert.throws(() => r.confirm('chat', 7, p.token, now + 600001));
    r.confirm('chat', 7, p.token, now + 1);
    assert.equal(r.chat('chat').jobs.weekly.day, 1);
    assert.throws(() => r.confirm('chat', 7, p.token, now + 2));
  } finally { db.close(); }
});

test('delivery resumes only unsent parts after a definite rejection', async () => {
  let state = { id: 'test', text: 'a'.repeat(7500) };
  let saved;
  const persist = () => { saved = JSON.stringify(state); };
  let calls = 0;
  await assert.rejects(deliverReport('chat', state, persist, async () => {
    calls++;
    if (calls === 2) throw Object.assign(new Error('429'), { definitelyRejected: true });
    return { message_id: calls };
  }));
  state = JSON.parse(saved);
  let resumed = 0;
  assert.equal(await deliverReport('chat', state, persist, async () => { resumed++; return { message_id: 9 }; }), true);
  assert.equal(resumed, 2);
  assert.equal(state.parts[0].messageId, 1);
});

test('ambiguous send and crash before acknowledgement pause rather than duplicate', async () => {
  const p = { id: 'test', text: 'hello' };
  await assert.rejects(deliverReport('chat', p, () => {}, async () => { throw new Error('socket closed'); }));
  let sends = 0;
  assert.equal(await deliverReport('chat', p, () => {}, async () => sends++), false);
  assert.equal(sends, 0);
  resolveDelivery(p, 'delivered');
  assert.equal(await deliverReport('chat', p, () => {}, async () => sends++), true);
  assert.equal(sends, 0);
  const crashed = { id: 'crash', text: 'hello', parts: [{ text: 'hello', status: 'sending' }] };
  assert.equal(await deliverReport('chat', crashed, () => {}, async () => sends++), false);
  resolveDelivery(crashed, 'retry');
  assert.equal(await deliverReport('chat', crashed, () => {}, async () => sends++), true);
  assert.equal(sends, 1);
});

test('chunking preserves emoji surrogate pairs', () => {
  const text = '😀'.repeat(5000);
  const parts = splitText(text);
  assert.equal(parts.join(''), text);
  for (const p of parts) assert.ok(p.length <= 3500 && p.isWellFormed());
});
