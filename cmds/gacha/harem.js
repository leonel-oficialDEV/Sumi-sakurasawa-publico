import { promises as fs } from 'fs';
import path from 'path';
import db from '#db';

const STATS_FILE_PATH = path.join(process.cwd(), 'lib', 'character_stats.json');

async function loadCharacters() {
  const filePath = path.join(process.cwd(), 'lib', 'characters.js');
  try {
    const module = await import(`file://${filePath}?update=${Date.now()}`);
    return module.default || module;
  } catch {
    return [];
  }
}

async function loadAllStats() {
  try {
    await fs.access(STATS_FILE_PATH);
    const data = await fs.readFile(STATS_FILE_PATH, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function normalizeStr(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findCharacterInStructure(structure, query) {
  if (!structure) return null;
  const q = normalizeStr(query);
  if (!q) return null;

  let charactersList = [];

  if (Array.isArray(structure)) {
    charactersList = structure;
  } else if (typeof structure === 'object') {
    for (const val of Object.values(structure)) {
      if (Array.isArray(val)) {
        charactersList.push(...val);
      } else if (val && Array.isArray(val.characters)) {
        charactersList.push(...val.characters);
      } else if (val && typeof val === 'object' && val.name) {
        charactersList.push(val);
      }
    }
  }

  const found = charactersList.find(c => {
    const charName = normalizeStr(c?.name);
    const charId = normalizeStr(c?.id || c?.keyword || '').replace(/\s+/g, '_');
    return charName === q || charId === q;
  });

  if (found) {
    const seriesName = found.source || found.series || found.anime || 'Desconocido';
    const generatedId = found.id || found.keyword || normalizeStr(found.name).replace(/\s+/g, '_');
    return {
      character: { ...found, id: generatedId },
      series: seriesName
    };
  }

  return null;
}

export default {
  command: ['harem', 'waifus', 'claims'],
  category: 'gacha',
  description: 'Ver tus personajes reclamados.',
  run: async ({ msg, sock, args, usedPrefix, command }) => {
    try {
      if (typeof db.read === 'function') await db.read();
      const chatId = msg.chat;

      if (!db.data) db.data = {};
      if (!db.data.chats) db.data.chats = {};
      if (!db.data.chats[chatId]) db.data.chats[chatId] = {};
      let chat = db.getChat ? db.getChat(chatId) : db.data.chats[chatId];

      if (chat?.adminonly || chat?.gacha === false) {
        return msg.reply(`ꕥ Los comandos de *Gacha* están desactivados en este grupo.\n\nUn *administrador* puede activarlos con el comando:\n» *${usedPrefix}gacha on*`);
      }

      const userId = msg.mentionedJid?.[0] || msg.quoted?.sender || msg.sender;
      const userGlobal = db.getUser ? db.getUser(userId) : db.data.users?.[userId];
      const name = userGlobal?.name?.trim() || userId.split('@')[0];

      const structure = await loadCharacters();
      const allStats = await loadAllStats();

      let chatUser = db.getChatUser ? db.getChatUser(chatId, userId) : db.data.chat_users?.[chatId]?.[userId] || {};
      let userCharacters = chatUser.characters || [];
      if (typeof userCharacters === 'string') {
        try { userCharacters = JSON.parse(userCharacters); } catch { userCharacters = []; }
      }
      if (!Array.isArray(userCharacters)) userCharacters = [];

      const ownedIDsSet = new Set(userCharacters);
      const chatPrefix = chatId + '__';

      for (const [key, stat] of Object.entries(allStats)) {
        if (key.startsWith(chatPrefix) && stat.user === userId) {
          const rawId = key.replace(chatPrefix, '');
          ownedIDsSet.add(rawId);
        }
      }

      const ownedIDs = Array.from(ownedIDsSet);

      if (ownedIDs.length === 0) {
        const isSelf = userId === msg.sender;
        const replyText = isSelf ? 'ꕥ No tienes personajes reclamados en tu harem.' : `ꕥ *${name}* no tiene personajes reclamados en su harem.`;
        return sock.sendMessage(chatId, { text: replyText, mentions: [userId] }, { quoted: msg });
      }

      const charactersList = [];
      for (const id of ownedIDs) {
        const charKey = chatId + '__' + id;
        const result = findCharacterInStructure(structure, id);
        const sourceData = result?.character;
        const seriesName = result?.series || sourceData?.source || sourceData?.series || 'Desconocido';
        const savedStat = allStats[charKey] || allStats[id];

        const charName = savedStat?.name || sourceData?.name || `ID:${id}`;
        const value = Number(savedStat?.value) || Number(sourceData?.value) || 100;

        charactersList.push({ id, name: charName, value, series: seriesName });
      }

      charactersList.sort((a, b) => b.value - a.value);

      const pageArg = args.find(arg => !isNaN(parseInt(arg)));
      const page = pageArg ? parseInt(pageArg) : 1;
      const perPage = 15;
      const totalPages = Math.ceil(charactersList.length / perPage) || 1;

      if (page < 1 || page > totalPages) {
        return msg.reply(`❀ Página no válida. Hay un total de *${totalPages}* páginas.`);
      }

      const start = (page - 1) * perPage;
      const end = Math.min(start + perPage, charactersList.length);

      let message = `✿ HAREM DE ${name.toUpperCase()} ✿\n`;
      message += `♡ Total de personajes: *${charactersList.length}*\n\n`;

      for (let i = start; i < end; i++) {
        const item = charactersList[i];
        message += `» *${item.name}*\n  ❖ Serie: *${item.series}*\n  ✰ Valor: *${item.value.toLocaleString()}*\n\n`;
      }

      message += `⌦ _Página *${page}* de *${totalPages}*_`;
      if (page < totalPages) {
        const nameArgs = args.filter(arg => isNaN(parseInt(arg))).join(' ');
        const paginationCmd = nameArgs ? `${usedPrefix}${command} ${nameArgs} ${page + 1}` : `${usedPrefix}${command} ${page + 1}`;
        message += `\n> Usa *${paginationCmd}* para ver la siguiente página.`;
      }

      await sock.sendMessage(chatId, { text: message.trim(), mentions: [userId] }, { quoted: msg });
    } catch (e) {
      await msg.reply(`> Ocurrió un error al ejecutar el comando *${usedPrefix + command}*.\n> [Error: *${e.message}*]`);
    }
  }
};
