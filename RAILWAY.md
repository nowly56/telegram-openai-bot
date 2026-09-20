# Размещение бота на Railway

Railway запускает проект как постоянный сервис. Секреты добавляются в разделе Variables, а Volume подключается к `/data`, чтобы `data/chat-context.json` не пропадал при перезапуске.

## Настройки сервиса

Добавьте переменные:

```text
TELEGRAM_BOT_TOKEN=...
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.6-sol
BOT_NAME=Роберт
BOT_SYSTEM_PROMPT_FILE=bot_prompt.txt
CONTEXT_FILE=/data/chat-context.json
```

Затем подключите Volume с mount path `/data` и запустите сервис. Railway автоматически использует Dockerfile и команду `npm start`.

После деплоя бот работает сам, пока сервис запущен. В Telegram всё равно нужно отключить Privacy Mode через `@BotFather` командой `/setprivacy` → `Disable`, чтобы Роберт видел всю переписку группы.
