// Loaded only by the offline child-process integration test. Never copied into Docker.
const sent = [];
let step = 0;
const base = { chat: { id: -100, type: 'supergroup' }, from: { id: 7, first_name: 'Иван' }, date: Math.floor(Date.now() / 1000) };
globalThis.fetch = async (url, options) => {
  const body = JSON.parse(options.body);
  let result;
  if (url === 'https://api.openai.com/v1/responses') return { ok: true, json: async () => ({ output_text: 'Тестовый ответ' }) };
  if (!url.startsWith('https://api.telegram.org/botTEST/')) throw new Error('Unexpected network access blocked');
  const method = url.split('/').at(-1);
  switch (method) {
    case 'getMe': result = { username: 'robert_bot', can_read_all_group_messages: true }; break;
    case 'setMyCommands': case 'sendChatAction': result = true; break;
    case 'getChatMember': result = { status: body.user_id === 7 ? 'administrator' : 'member' }; break;
    case 'sendMessage': sent.push(body.text); result = { message_id: sent.length }; break;
    case 'getUpdates': {
      step++;
      const texts = [
        'Роберт, привет',
        'Роберт, ответь на reply',
        'Роберт, присылай отчёт каждый понедельник в 10:00',
        `/reports confirm ${sent.join('\n').match(/\/reports confirm ([a-f0-9-]+)/)?.[1] || 'missing'}`,
        '/reports status',
        'Роберт, присылай отчёт каждый день в 21:00',
      ];
      if (step > texts.length) { process.emit('SIGTERM'); result = []; break; }
      const message = { ...base, message_id: step, text: texts[step - 1] };
      if (step === 2) message.reply_to_message = { message_id: 99 };
      if (step === 6) message.from = { id: 8, first_name: 'Участник' };
      result = [{ update_id: step, message }];
      break;
    }
    default: throw new Error(`Unexpected Telegram method: ${method}`);
  }
  return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
};
process.on('exit', () => console.log(`TEST_SENT=${JSON.stringify(sent)}`));
