import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

export function loadSystemPrompt(env = process.env, baseDir = import.meta.dirname) {
  const file = env.BOT_SYSTEM_PROMPT_FILE?.trim();
  const inline = env.BOT_SYSTEM_PROMPT?.trim();
  const source = file || (!inline ? 'bot_prompt.txt' : null);
  let text;
  if (source) {
    try {
      text = readFileSync(resolve(baseDir, source), 'utf8').trim();
    } catch (error) {
      throw new Error(`Cannot read BOT_SYSTEM_PROMPT_FILE: ${source} (${error.code || 'read error'})`);
    }
  } else {
    text = inline;
  }
  if (!text) throw new Error(`System prompt is empty: ${source || 'BOT_SYSTEM_PROMPT'}`);
  return { text, source: source || 'BOT_SYSTEM_PROMPT', hash: createHash('sha256').update(text).digest('hex').slice(0, 12) };
}
