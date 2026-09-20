import process from "node:process";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

loadDotEnv();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-5.6-sol";
const BOT_NAME = process.env.BOT_NAME || "Роберт";
const CONTEXT_FILE = process.env.CONTEXT_FILE || "data/chat-context.json";
const SYSTEM_PROMPT = loadSystemPrompt();

if (!BOT_TOKEN || !OPENAI_API_KEY) {
  console.error(
    "Не заданы TELEGRAM_BOT_TOKEN и/или OPENAI_API_KEY. Скопируйте .env.example в .env и заполните значения."
  );
  process.exit(1);
}

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const chatHistories = loadChatHistories();
const chatQueues = new Map();
const MAX_TELEGRAM_MESSAGE_LENGTH = 4000;

let botInfo;
let nextUpdateOffset = 0;
let shuttingDown = false;

async function telegram(method, body = {}) {
  const response = await fetch(`${TELEGRAM_API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error(`Telegram ${method} failed: ${data.description || response.statusText}`);
  }
  return data.result;
}

async function askOpenAI(chatId) {
  const history = chatHistories.get(chatKey(chatId)) || [];
  const input = [
    { role: "developer", content: SYSTEM_PROMPT },
    ...history,
  ];

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, input, store: false }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data?.error?.message || response.statusText;
    throw new Error(`OpenAI request failed: ${detail}`);
  }

  const answer = extractOutputText(data).trim();
  if (!answer) throw new Error("OpenAI returned an empty response");

  appendHistory(chatId, { role: "assistant", content: answer });
  return answer;
}

function extractOutputText(data) {
  if (typeof data.output_text === "string") return data.output_text;
  return (data.output || [])
    .flatMap((item) => item.content || [])
    .filter((part) => part.type === "output_text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function loadDotEnv() {
  // Deliberately tiny .env reader: this project has no runtime dependencies.
  try {
    const text = readFileSync(".env", "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator < 0) continue;
      const key = trimmed.slice(0, separator).trim();
      let value = trimmed.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function loadSystemPrompt() {
  const promptFile = process.env.BOT_SYSTEM_PROMPT_FILE;
  if (promptFile) {
    try {
      return readFileSync(promptFile, "utf8").trim();
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return (
    process.env.BOT_SYSTEM_PROMPT ||
    "Ты дружелюбный помощник в Telegram-группе. Отвечай по-русски, если пользователь не попросил другой язык. Пиши ясно и по делу."
  );
}

function chatKey(chatId) {
  return String(chatId);
}

function loadChatHistories() {
  try {
    const parsed = JSON.parse(readFileSync(CONTEXT_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${CONTEXT_FILE} должен содержать JSON-объект`);
    }
    return new Map(
      Object.entries(parsed).map(([key, value]) => [
        key,
        Array.isArray(value) ? value : [],
      ])
    );
  } catch (error) {
    if (error?.code === "ENOENT") return new Map();
    throw error;
  }
}

function saveChatHistories() {
  mkdirSync(dirname(CONTEXT_FILE), { recursive: true });
  const temporaryFile = `${CONTEXT_FILE}.tmp`;
  writeFileSync(
    temporaryFile,
    JSON.stringify(Object.fromEntries(chatHistories), null, 2),
    "utf8"
  );
  renameSync(temporaryFile, CONTEXT_FILE);
}

function appendHistory(chatId, entry) {
  const key = chatKey(chatId);
  const history = chatHistories.get(key) || [];
  history.push(entry);
  chatHistories.set(key, history);
  saveChatHistories();
}

function resetHistory(chatId) {
  chatHistories.delete(chatKey(chatId));
  saveChatHistories();
}

function isGroup(chat) {
  return chat?.type === "group" || chat?.type === "supergroup";
}

function shouldAnswer(message) {
  const text = message.text || "";
  if (message.reply_to_message) return false;
  if (!isGroup(message.chat)) return true;
  if (/^\/ask(?:@\w+)?\b/i.test(text)) return true;
  return containsBotName(text);
}

function extractPrompt(text) {
  let prompt = text.trim();
  prompt = prompt.replace(/^\/ask(?:@\w+)?\s*/i, "");
  prompt = prompt.replace(botNamePattern(), " ");
  return prompt.trim();
}

function botNamePattern() {
  return new RegExp(
    `(^|[^\\p{L}\\p{N}_])${escapeRegExp(BOT_NAME)}(?=$|[^\\p{L}\\p{N}_])`,
    "giu"
  );
}

function containsBotName(text) {
  return botNamePattern().test(text);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function displayName(from = {}) {
  return [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username || "Пользователь";
}

function splitMessage(text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += MAX_TELEGRAM_MESSAGE_LENGTH) {
    chunks.push(text.slice(i, i + MAX_TELEGRAM_MESSAGE_LENGTH));
  }
  return chunks;
}

async function sendText(chatId, text, replyToMessageId) {
  for (const chunk of splitMessage(text)) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: chunk,
      ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {}),
    });
  }
}

function enqueue(chatId, task) {
  const previous = chatQueues.get(chatId) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  chatQueues.set(chatId, current.finally(() => {
    if (chatQueues.get(chatId) === current) chatQueues.delete(chatId);
  }));
  return current;
}

async function handleMessage(message) {
  if (!message?.text || message.from?.is_bot) return;

  const text = message.text.trim();
  const isReply = Boolean(message.reply_to_message);
  if (/^\/start(?:@\w+)?\b/i.test(text)) {
    if (isReply) return;
    await sendText(
      message.chat.id,
      `Привет! В личке просто напиши сообщение. В группе назови меня по имени «${BOT_NAME}» или используй /ask.`,
      message.message_id
    );
    return;
  }
  if (/^\/help(?:@\w+)?\b/i.test(text)) {
    if (isReply) return;
    await sendText(
      message.chat.id,
      `Команды: «${BOT_NAME}, ваш вопрос» или /ask ваш вопрос — спросить; /reset — очистить контекст чата. Ответы на сообщения игнорируются.`,
      message.message_id
    );
    return;
  }
  if (/^\/reset(?:@\w+)?\b/i.test(text)) {
    if (isReply) return;
    resetHistory(message.chat.id);
    await sendText(message.chat.id, "Контекст этого чата очищен.", message.message_id);
    return;
  }

  const prompt = extractPrompt(text);
  const contextMessage = isGroup(message.chat) && prompt ? prompt : text;
  appendHistory(message.chat.id, {
    role: "user",
    content: `${displayName(message.from)}: ${contextMessage}`,
  });

  if (!shouldAnswer(message)) return;
  if (!prompt) {
    await sendText(message.chat.id, "Напиши вопрос после /ask или упомяни меня с текстом вопроса.", message.message_id);
    return;
  }

  await enqueue(message.chat.id, async () => {
    try {
      await telegram("sendChatAction", { chat_id: message.chat.id, action: "typing" });
      const answer = await askOpenAI(message.chat.id);
      await sendText(message.chat.id, answer, message.message_id);
    } catch (error) {
      console.error(error);
      await sendText(message.chat.id, "Не получилось получить ответ сейчас. Проверь ключ OpenAI и попробуй ещё раз.", message.message_id);
    }
  });
}

async function poll() {
  while (!shuttingDown) {
    try {
      const updates = await telegram("getUpdates", {
        offset: nextUpdateOffset,
        timeout: 25,
        allowed_updates: ["message"],
      });
      for (const update of updates) {
        nextUpdateOffset = update.update_id + 1;
        await handleMessage(update.message);
      }
    } catch (error) {
      console.error(error);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

async function main() {
  botInfo = await telegram("getMe");
  console.log(`Бот @${botInfo.username} запущен. Модель: ${MODEL}`);
  await telegram("setMyCommands", {
    commands: [
      { command: "start", description: "Начать работу" },
      { command: "ask", description: "Задать вопрос" },
      { command: "reset", description: "Очистить контекст чата" },
      { command: "help", description: "Помощь" },
    ],
  });
  await poll();
}

process.on("SIGINT", () => { shuttingDown = true; });
process.on("SIGTERM", () => { shuttingDown = true; });

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
