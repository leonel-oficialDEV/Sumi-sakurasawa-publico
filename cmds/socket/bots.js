import db from "#db";
import { listSessions } from '#subs';

const PAGE_SIZE = 30;

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
  run: async ({ msg, sock, args, isStaff, isOwner, isDev }) => {
    const botId = toPn(sock.user?.id);
    const mainBotJid = toPn(global.sock?.user?.id);
    const isPrivileged = isStaff || isOwner || isDev;

    const groupIds = new Set();
    if (msg.isGroup) {
      const meta = await sock.groupMetadata(msg.chat).catch(() => null);
      for (const p of meta?.participants || []) {
        for (const v of [p.phoneNumber, p.jid, p.lid, p.id]) {
          if (typeof v === 'string' && v) groupIds.add(v.replace(/:\d+@/, '@'));
        }
      }
    }

    const subNumbers = listSessions()
      .filter((s) => s.registered && !global.SUBS_STOPPED?.has(s.id))
      .map((s) => s.id.replace(/\D/g, ''))
      .filter((n) => n && n + '@s.whatsapp.net' !== mainBotJid);

    const bots = [];
    if (mainBotJid) bots.push({ jid: mainBotJid, label: 'Owner' });
    for (const n of subNumbers) bots.push({ jid: n + '@s.whatsapp.net', label: 'Sub' });
    for (const b of bots) b.inGroup = groupIds.has(b.jid);

    const inGroupList = msg.isGroup ? bots.filter((b) => b.inGroup) : [];

    const biggest = Math.max(inGroupList.length, isPrivileged ? bots.length : 0);
    const totalPages = Math.max(1, Math.ceil(biggest / PAGE_SIZE));
    const page = Math.max(1, parseInt(args?.[0], 10) || 1);

    if (page > totalPages) {
      return sock.sendMessage(
        msg.chat,
        { text: `✎ Esa página no existe. Hay *${totalPages}* página${totalPages > 1 ? 's' : ''}.` },
        { quoted: msg },
      );
    }

    const start = (page - 1) * PAGE_SIZE;
    const mentionedJid = new Set();

    const renderLines = (list) => list.slice(start, start + PAGE_SIZE).map((b, i) => {
      const name = getSafeSettings(b.jid).namebot2 || 'Bot';
      if (b.inGroup) mentionedJid.add(b.jid);
      return `${start + i + 1}. [${b.label} *${name}*] › ${b.inGroup ? '@' : ''}${b.jid.split('@')[0]}`;
    });

    let message = `ꕥ Números de Sockets activos *(${bots.length})*\n\n`;
    message += `ੈ❖‧₊˚ Principales › *${mainBotJid ? 1 : 0}*\n`;
    message += `ੈ✿‧₊˚ Subs › *${subNumbers.length}*\n\n`;

    if (msg.isGroup) {
      message += `➭ *Bots en el grupo ›* ${inGroupList.length}\n`;
      const lines = renderLines(inGroupList);
      if (lines.length) message += lines.join('\n') + '\n';
    }

    if (isPrivileged && bots.length) {
      message += `\n➭ *TOTAL BOTS ›* ${bots.length}\n`;
      const lines = renderLines(bots);
      if (lines.length) message += lines.join('\n') + '\n';
    }

    if (totalPages > 1) {
      message += `\n❖ Página *${page}/${totalPages}*`;
      if (page < totalPages) message += ` › usa *#bots ${page + 1}* para ver más`;
      message += '\n';
    }

    const text = message.trim();
    const contextInfo = { mentionedJid: [...mentionedJid] };

    const data = getSafeSettings(botId);
    const icon = data.icon || data.banner || '';

    if (icon) {
      try {
        await sock.sendMessage(msg.chat, { image: { url: icon }, caption: text, contextInfo }, { quoted: msg });
        return;
      } catch {}
    }
    await sock.sendMessage(msg.chat, { text, contextInfo }, { quoted: msg });
  },
};