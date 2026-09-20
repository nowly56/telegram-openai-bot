export function splitText(text, size = 3500) {
  const chunks = [];
  let part = '';
  for (const ch of text) {
    if (part.length + ch.length > size) { chunks.push(part); part = ''; }
    part += ch;
  }
  if (part) chunks.push(part);
  return chunks;
}

export async function deliverReport(id, pending, persist, send) {
  pending.parts ||= splitText(pending.text).map((text, i) => ({ text: `Отчёт ${pending.id}, часть ${i + 1}\n${text}`, status: 'ready' }));
  persist();
  for (const part of pending.parts) {
    if (part.status === 'sent') continue;
    if (['sending', 'uncertain'].includes(part.status)) { part.status = 'uncertain'; persist(); return false; }
    part.status = 'sending';
    persist();
    try {
      const message = await send(id, part.text);
      part.messageId = message?.message_id;
      part.status = 'sent';
      persist();
    } catch (e) {
      // Only explicit Telegram rejection proves that retrying will not duplicate delivery.
      part.status = e.definitelyRejected ? 'ready' : 'uncertain';
      persist();
      throw e;
    }
  }
  return true;
}

export function resolveDelivery(pending, action) {
  const part = pending?.parts?.find(p => ['sending', 'uncertain'].includes(p.status));
  if (!part || !['retry', 'delivered'].includes(action)) throw new Error('Нет спорной отправки или неверное действие');
  part.status = action === 'retry' ? 'ready' : 'sent';
}
