import db from "#db";
import { listSessions } from '#subs';

const cleanJid = (jid = '') => String(jid).split('@')[0].split(':')[0];
const toPn = (jid) => {
  const n = cleanJid(jid);
  return n ? n + '@s.whatsapp.net' : '';
};

const getSafeSettings = (jid) => {
  try {
    return db.getSettings(jid) || {};
  } catch {
    return {};
  }
};

export default {
  command: ['bots', 'sockets'],
  category: 'socket',
  description: 'mira las sesiones y sockets activos en el grupo',
  isAdmin: true,
  run: async ({ msg, sock, isStaff, isOwner, isDev }) => {
    const botId = toPn(sock.user?.id);
    const mainBotJid = toPn(global.sock?.user?.id);

    const subNumbers = listSessions()
      .filter((s) => s.registered && !global.SUBS_STOPPED?.has(s.id))
      .map((s) => s.id.replace(/\D/g, ''))
      .filter((n) => n && n + '@s.whatsapp.net' !== mainBotJid);

    const total = 1 + subNumbers.length;

    const message = `❖ Números de Sockets activos *(${total})*\n\n` +
      `❖ Principales › *1*\n` +
      `❖ Subs › *${subNumbers.length}*`;

    const data = getSafeSettings(botId);
    const icon = data.icon || data.banner || '';

    if (icon) {
      try {
        await sock.sendMessage(msg.chat, { image: { url: icon }, caption: message }, { quoted: msg });
        return;
      } catch {}
    }
    await sock.sendMessage(msg.chat, { text: message }, { quoted: msg });
  },
};