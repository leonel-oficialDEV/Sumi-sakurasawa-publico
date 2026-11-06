import { promises as fs } from 'fs';
import path from 'path';
import db from '#db';

const STATS_FILE_PATH = path.join(process.cwd(), 'lib', 'character_stats.json');

function normalizeStr(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

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

function findCharacterInStructure(structure, query) {
  if (!structure) return null;
  const q = normalizeStr(query);
  if (!q) return null;

  const checkChar = (c, defaultSeries = 'Desconocido') => {
    if (!c) return null;
    const charId = normalizeStr(c.id || c.keyword || '').replace(/\s+/g, '_');
    const charName = normalizeStr(c.name || '');
    const aliases = Array.isArray(c.aliases) ? c.aliases.map(normalizeStr) : [];
    const tags = Array.isArray(c.tags) ? c.tags.map(normalizeStr) : [];

    if (charId === q || charName === q || charName.includes(q) || aliases.includes(q) || tags.includes(q)) {
      return {
        character: c,
        series: c.source || c.series || c.anime || defaultSeries
      };
    }
    return null;
  };

  if (Array.isArray(structure)) {
    for (const item of structure) {
      if (!item) continue;
      if (Array.isArray(item.characters)) {
        const sName = item.name || item.title || item.series || 'Desconocido';
        for (const c of item.characters) {
          const res = checkChar(c, sName);
          if (res) return res;
        }
      } else {
        const res = checkChar(item);
        if (res) return res;
      }
    }
  } else if (typeof structure === 'object') {
    for (const [key, val] of Object.entries(structure)) {
      if (!val) continue;
      if (Array.isArray(val)) {
        for (const c of val) {
          const res = checkChar(c, key);
          if (res) return res;
        }
      } else if (Array.isArray(val.characters)) {
        const sName = val.name || val.title || key;
        for (const c of val.characters) {
          const res = checkChar(c, sName);
          if (res) return res;
        }
      } else if (val.name) {
        const res = checkChar(val, key);
        if (res) return res;
      }
    }
  }
  return null;
}

export default {
  command: ['wboard', 'haremboard', 'topval', 'topower'],
  category: 'gacha',
  description: 'Muestra el Top 10 de los harenes más valiosos del grupo con información precisa.',
  run: async ({ msg, sock, usedPrefix, command }) => {
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

      const [structure, allStats] = await Promise.all([
        loadCharacters(),
        loadAllStats()
      ]);

      const chatPrefix = chatId + '__';
      const userHarems = {};

      // 1. Cargar desde character_stats.json
      for (const [key, stat] of Object.entries(allStats)) {
        if (key.startsWith(chatPrefix)) {
          const userId = stat?.owner || stat?.claimedBy || stat?.user || stat?.claimed;
          if (userId) {
            const id = key.replace(chatPrefix, '');
            if (!userHarems[userId]) userHarems[userId] = new Map();
            userHarems[userId].set(id, stat);
          }
        }
      }

      // 2. Complementar con db.data.chat_users
      const chatUsersObj = db.data.chat_users?.[chatId] || {};
      for (const [userId, uData] of Object.entries(chatUsersObj)) {
        let userChars = uData?.characters || [];
        if (typeof userChars === 'string') {
          try { userChars = JSON.parse(userChars); } catch { userChars = []; }
        }
        if (Array.isArray(userChars)) {
          if (!userHarems[userId]) userHarems[userId] = new Map();
          for (const rawCharId of userChars) {
            const cleanId = String(rawCharId).replace(chatPrefix, '');
            if (!userHarems[userId].has(cleanId)) {
              userHarems[userId].set(cleanId, null);
            }
          }
        }
      }

      const leaderboard = [];

      for (const [userId, ownedEntries] of Object.entries(userHarems)) {
        if (ownedEntries.size === 0) continue;

        let totalValue = 0;
        let bestChar = { name: 'Desconocido', rarity: 'Común', value: -1, series: 'Desconocido' };
        const charactersList = [];

        for (const [id, stat] of ownedEntries.entries()) {
          const result = findCharacterInStructure(structure, id);
          const sourceData = result?.character;
          const seriesName = result?.series || sourceData?.source || sourceData?.series || sourceData?.anime || 'Desconocido';

          const charName = stat?.name || sourceData?.name || id;
          const value = Number(stat?.value) || Number(sourceData?.value) || 100;
          const rarity = stat?.rareza || stat?.rarity || stat?.clase || sourceData?.rareza || sourceData?.rarity || sourceData?.clase || sourceData?.tier || 'Común';

          totalValue += value;
          charactersList.push({ id, name: charName, value, series: seriesName, rarity });

          if (value > bestChar.value) {
            bestChar = { name: charName, rarity, value, series: seriesName };
          }
        }

        let userName = userId.split('@')[0];
        const userGlobal = db.getUser ? db.getUser(userId) : db.data.users?.[userId];
        const userChat = db.getChatUser ? db.getChatUser(chatId, userId) : db.data.chat_users?.[chatId]?.[userId];
        if (userGlobal?.name) userName = userGlobal.name.trim();
        else if (userChat?.name) userName = userChat.name.trim();

        leaderboard.push({
          userId,
          userName,
          count: charactersList.length,
          totalValue,
          bestChar
        });
      }

      if (leaderboard.length === 0) {
        return msg.reply(`ꕥ Ningún usuario tiene personajes reclamados en su harem en este grupo.`);
      }

      leaderboard.sort((a, b) => b.totalValue - a.totalValue || b.count - a.count);
      const top10 = leaderboard.slice(0, 10);

      let message = `✧ *TOP 10 HAREMS MÁS VALIOSOS* ✧\n`;
      message += `> *Ranking basado en el valor total de cartas del grupo.*\n\n`;

      const mentions = [];

      top10.forEach((item, index) => {
        const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `*#${index + 1}*`;
        const cleanUser = item.userId.includes('@') ? item.userId : item.userId + '@s.whatsapp.net';
        mentions.push(cleanUser);

        message += `${medal} ⟡ @${item.userId.split('@')[0]}\n`;
        message += `   ├ ⛩️ Personajes: *${item.count}* cartas\n`;
        message += `   ├ 💴 Valor Total: *¥${item.totalValue.toLocaleString()}*\n`;
        message += `   └ ⭐ Joya: *${item.bestChar.name}* [${item.bestChar.rarity}] (¥${item.bestChar.value.toLocaleString()})\n\n`;
      });

      message += `> *💡 Usa ${usedPrefix}harem para ver tus cartas en detalle.*`;

      if (sock && typeof sock.sendMessage === 'function') {
        await sock.sendMessage(msg.chat, { text: message.trim(), mentions }, { quoted: msg });
      } else {
        await msg.reply(message.trim());
      }
    } catch (e) {
      await msg.reply(`> Ocurrió un error al ejecutar *${usedPrefix + command}*.\n> [Error: *${e.message}*]`);
    }
  }
};
            
