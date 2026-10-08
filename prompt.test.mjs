import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSystemPrompt } from './prompt.mjs';

test('prompt selection uses bundled file, respects overrides, and rejects broken configuration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-prompt-'));
  try {
    writeFileSync(join(dir, 'bot_prompt.txt'), '  File prompt  \n');
    writeFileSync(join(dir, 'custom.txt'), 'Custom prompt');
    writeFileSync(join(dir, 'empty.txt'), ' \n');
    assert.equal(loadSystemPrompt({}, dir).text, 'File prompt');
    assert.equal(loadSystemPrompt({ BOT_SYSTEM_PROMPT: 'Inline prompt' }, dir).text, 'Inline prompt');
    assert.equal(loadSystemPrompt({ BOT_SYSTEM_PROMPT_FILE: 'custom.txt', BOT_SYSTEM_PROMPT: 'Ignored' }, dir).text, 'Custom prompt');
    assert.equal(loadSystemPrompt({ BOT_SYSTEM_PROMPT_FILE: join(dir, 'custom.txt') }, dir).text, 'Custom prompt');
    assert.throws(() => loadSystemPrompt({ BOT_SYSTEM_PROMPT_FILE: 'missing.txt', BOT_SYSTEM_PROMPT: 'Ignored' }, dir), /Cannot read/);
    assert.throws(() => loadSystemPrompt({ BOT_SYSTEM_PROMPT_FILE: 'empty.txt' }, dir), /empty/);
    assert.match(loadSystemPrompt({}, dir).hash, /^[a-f0-9]{12}$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
