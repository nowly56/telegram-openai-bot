import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage } from './storage.mjs';

test('bot handles punctuation, reply suppression, admin confirmation and SQLite end-to-end offline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'robert-integration-'));
  let store;
  try {
    const child = spawnSync(process.execPath, ['--import', './test-support/fake-network.mjs', 'bot.mjs'], {
      cwd: import.meta.dirname, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, TELEGRAM_BOT_TOKEN: 'TEST', OPENAI_API_KEY: 'TEST', DATABASE_FILE: join(dir, 'bot.sqlite'), CONTEXT_FILE: join(dir, 'legacy.json'), BOT_NAME: 'Роберт', BOT_SYSTEM_PROMPT_FILE: join(dir, 'none.txt'), BOT_SYSTEM_PROMPT: 'Test assistant' },
    });
    assert.equal(child.status, 0, child.stderr);
    const sent = JSON.parse(child.stdout.match(/TEST_SENT=(.*)/)[1]);
    assert.equal(sent.filter(s => s === 'Тестовый ответ').length, 1);
    assert.ok(sent.some(s => s.includes('Расписание подтверждено')));
    assert.ok(sent.some(s => s.includes('weekly: 10:00, Europe/Moscow')));
    assert.ok(sent.some(s => s.includes('только администраторы')));
    store = new Storage(join(dir, 'bot.sqlite'));
    assert.equal(store.getState('telegram:offset'), 7);
    assert.equal(store.getState('reports')['-100'].jobs.weekly.time, '10:00');
    assert.equal(store.getState('reports')['-100'].jobs.daily, undefined);
    assert.ok(store.recent('-100').some(r => r.content.includes('reply')));
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});
