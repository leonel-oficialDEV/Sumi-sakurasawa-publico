import { promises as fs } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
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
  if (Array.isArray(global.characters) && global.characters.length > 0) {
    return global.characters;
  }
  const filePath = path.join(process.cwd(), 'lib', 'characters.js');
  try {
    const fileUrl = pathToFileURL(filePath).href;
    const module = await import(`${fileUrl}?update=${Date.now()}`);
    return module.default || module.characters || module.data || module;
  } catch {
    return Array.isArray(global.characters) ? global.characters : [];
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

async function saveAllStats(data) {
  await fs.writeFile(STATS_FILE_PATH, JSON.stringify(data, null, 2));
}

function isCharacterInStructure(structure, id) {
  if (!structure) return false;
  const q = normalizeStr(id);
  if (!q) return false;

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

  return charactersList.some(c => {
    const charName = normalizeStr(c?.name);
    const charId = normalizeStr(c?.id || c?.keyword || '').replace(/\s+/g, '_');
    return charName === q || charId === q;
  });
}

export default {
  command: ['fixw', 'fixwaifu', 'cleanwaifu', 'fixharem'],
  category: 'gacha',
  description: 'Elimina del harem y de character_stats las cartas que no existan en characters.js',
  run: async ({ msg, args, usedPrefix, command }) => {
    const userId = msg.sender;
    const chatId = msg.chat;

    const isOwner = global.owner?.some(o => userId.includes(o)) || (typeof db.isOwner === 'function' && db.isOwner(userId));
    if (!isOwner) {
      return msg.reply('ꕥ Este comando solo puede ser utilizado por los propietarios del bot.');
    }

    let targetId = msg.mentionedJid?.[0] || msg.quoted?.sender;

    if (!targetId && args[0]) {
      const cleanArg = args[0].replace(/[^0-9]/g, '');
      if (cleanArg.length >= 7) {
        targetId = cleanArg + '@s.whatsapp.net';
      }
    }

    if (!targetId) {
      targetId = userId;
    }

    try {
      if (typeof db.read === 'function') await db.read();

      const structure = await loadCharacters();
      if (!structure || (Array.isArray(structure) && !structure.length)) {
        return msg.reply('ꕥ No hay personajes cargados en la base de datos para realizar la verificación.');
      }

      const allStats = await loadAllStats();
      const chatPrefix = chatId + '__';

      let chatUser = db.getChatUser ? db.getChatUser(chatId, targetId) : db.data?.chat_users?.[chatId]?.[targetId] || {};
      let globalUser = db.data?.users?.[targetId] || {};

      let userCharacters = chatUser.characters || globalUser.characters || [];
      if (typeof userCharacters === 'string') {
        try { userCharacters = JSON.parse(userCharacters); } catch { userCharacters = []; }
      }
      if (!Array.isArray(userCharacters)) userCharacters = [];

      const ownedIDsSet = new Set(userCharacters);

      for (const [key, stat] of Object.entries(allStats)) {
        if (key.startsWith(chatPrefix) && (stat.user === targetId || stat.owner === targetId || stat.claimedBy === targetId)) {
          const rawId = key.replace(chatPrefix, '');
          ownedIDsSet.add(rawId);
        }
      }

      const ownedIDs = Array.from(ownedIDsSet);

      if (ownedIDs.length === 0) {
        return msg.reply(`ꕥ @${targetId.split('@')[0]} no tiene personajes registrados en su harem.`, { mentions: [targetId] });
      }

      let removedCount = 0;
      const validUserChars = [];
      let statsModified = false;

      for (const id of ownedIDs) {
        const isValid = isCharacterInStructure(structure, id);
        const charKey = chatPrefix + id;

        if (isValid) {
          if (userCharacters.includes(id)) {
            validUserChars.push(id);
          }
        } else {
          removedCount++;
          if (allStats[charKey]) {
            delete allStats[charKey];
            statsModified = true;
          }
          if (allStats[id]) {
            delete allStats[id];
            statsModified = true;
          }
        }
      }

      if (chatUser) {
        chatUser.characters = validUserChars;
        if (typeof db.updateChatUser === 'function') {
          db.updateChatUser(chatId, targetId, 'characters', validUserChars);
        }
      }
      if (globalUser) {
        globalUser.characters = validUserChars;
      }

      if (statsModified) {
        await saveAllStats(allStats);
      }

      if (typeof db.write === 'function') await db.write();

      const targetTag = `@${targetId.split('@')[0]}`;

      if (removedCount === 0) {
        return msg.reply(`✅ El harem de ${targetTag} está en perfecto estado.\n📊 Cartas comprobadas y válidas: *${ownedIDs.length}*`, { mentions: [targetId] });
      }

      const report = `🛠️ *Depuración de Harem completada*\n\n` +
        `👤 Usuario: ${targetTag}\n` +
        `❌ Cartas no registradas eliminadas: *${removedCount}*\n` +
        `✅ Cartas conservadas: *${ownedIDs.length - removedCount}*\n` +
        `📦 Total original: *${ownedIDs.length}*`;

      return msg.reply(report, { mentions: [targetId] });

    } catch (e) {
      return msg.reply(`> Ocurrió un error al ejecutar fixw:\n> [Error: *${e.message}*]`);
    }
  }
};
