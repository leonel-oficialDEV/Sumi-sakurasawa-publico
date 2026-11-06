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

async function getCharacterStat(id) {
  try {
    await fs.access(STATS_FILE_PATH);
  } catch {
    await fs.writeFile(STATS_FILE_PATH, '{}');
  }
  try {
    const data = await fs.readFile(STATS_FILE_PATH, 'utf-8');
    const json = JSON.parse(data);
    return json[id] || null;
  } catch {
    return null;
  }
}

async function setCharacterStat(id, val) {
  let json = {};
  try {
    await fs.access(STATS_FILE_PATH);
    const data = await fs.readFile(STATS_FILE_PATH, 'utf-8');
    json = JSON.parse(data);
  } catch {
    json = {};
  }
  json[id] = val;
  await fs.writeFile(STATS_FILE_PATH, JSON.stringify(json, null, 2));
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
    const tags = Array.isArray(c?.tags) ? c.tags.map(normalizeStr) : [];
    const aliases = Array.isArray(c?.aliases) ? c.aliases.map(normalizeStr) : [];

    return charName === q || charName.includes(q) || charId === q || tags.some(t => t === q || t.includes(q)) || aliases.some(a => a === q || a.includes(q));
  });

  if (found) {
    return {
      ...found,
      id: found.id || found.keyword || normalizeStr(found.name).replace(/\s+/g, '_')
    };
  }
  
  return null;
}

export default {
  command: ['claim', 'c', 'reclamar'],
  category: 'gacha',
  description: 'Reclamar un personaje.',
  run: async ({ msg, sock, usedPrefix, command }) => {
    try {
      if (typeof db.read === 'function') await db.read();
      const chatId = msg.chat;
      const userId = msg.sender;

      if (!db.data) db.data = {};
      if (!db.data.chats) db.data.chats = {};
      if (!db.data.chats[chatId]) db.data.chats[chatId] = {};
      let chat = db.getChat ? db.getChat(chatId) : db.data.chats[chatId];

      if (chat?.adminonly || chat?.gacha === false) {
        return msg.reply(`ꕥ Los comandos de *Gacha* están desactivados en este grupo.\n\nUn *administrador* puede activarlos con:\n» *${usedPrefix}gacha on*`);
      }

      const quotedId = msg.quoted?.id;
      if (!chat.rolls || !quotedId || !chat.rolls[quotedId]) {
        return msg.reply(`❀ Debes responder a un mensaje de un personaje válido generado por el bot para reclamar.`);
      }

      const rollData = chat.rolls[quotedId];
      if (rollData.claimed) {
        return msg.reply(`ꕥ Este personaje ya ha sido reclamado.`);
      }

      const characterId = rollData.id || rollData.characterId;
      const charKey = rollData.charKey || (chatId + '__' + characterId);

      const structure = await loadCharacters();
      const sourceData = findCharacterInStructure(structure, characterId);
      if (!sourceData) {
        return msg.reply('ꕥ Personaje no encontrado en la base de datos.');
      }

      const now = Date.now();
      let character = await getCharacterStat(charKey);
      if (!character) {
        character = { name: sourceData.name, value: sourceData.value || 100, votes: 0 };
      } else if (!character.name) {
        character.name = sourceData.name;
      }

      if (character.reservedBy && character.reservedBy !== userId && now < character.reservedUntil) {
        const reserver = db.getUser ? db.getUser(character.reservedBy) : db.data.users?.[character.reservedBy];
        const reserverName = reserver?.name || character.reservedBy.split('@')[0];
        const remaining = ((character.reservedUntil - now) / 1000).toFixed(1);
        return msg.reply(`ꕥ Este personaje está protegido por *${reserverName}* durante *${remaining}s.*`);
      }

      if (character.expiresAt && now > character.expiresAt && !character.user && !(character.reservedBy && now < character.reservedUntil)) {
        const expiredTime = ((now - character.expiresAt) / 1000).toFixed(1);
        return msg.reply(`ꕥ El tiempo para reclamar este personaje ha expirado hace » *${expiredTime}s.*`);
      }

      if (character.user) {
        const owner = db.getUser ? db.getUser(character.user) : db.data.users?.[character.user];
        const ownerName = owner?.name || character.user.split('@')[0];
        return msg.reply(`ꕥ El personaje *${character.name}* ya ha sido reclamado por *${ownerName}*`);
      }

      character.user = userId;
      character.claimedAt = now;
      delete character.reservedBy;
      delete character.reservedUntil;
      await setCharacterStat(charKey, character);

      let chatUser = db.getChatUser ? db.getChatUser(chatId, userId) : db.data.chat_users?.[chatId]?.[userId] || {};
      let userCharacters = chatUser.characters || [];
      if (typeof userCharacters === 'string') {
        try { userCharacters = JSON.parse(userCharacters); } catch { userCharacters = []; }
      }
      if (!Array.isArray(userCharacters)) userCharacters = [];

      if (!userCharacters.includes(sourceData.id)) {
        userCharacters.push(sourceData.id);
      }

      chatUser.characters = userCharacters;

      if (!db.data.chat_users) db.data.chat_users = {};
      if (!db.data.chat_users[chatId]) db.data.chat_users[chatId] = {};
      if (!db.data.chat_users[chatId][userId]) db.data.chat_users[chatId][userId] = {};
      db.data.chat_users[chatId][userId].characters = userCharacters;

      if (typeof db.setCreate === 'function') {
        db.setCreate('chat_users', [chatId, userId], 'characters', userCharacters);
      }

      chat.rolls[quotedId].claimed = true;
      db.data.chats[chatId].rolls = chat.rolls;

      if (typeof db.updateChat === 'function') {
        db.updateChat(chatId, 'rolls', chat.rolls);
      }
      if (typeof db.write === 'function') await db.write();

      const userGlobal = db.getUser ? db.getUser(userId) : db.data.users?.[userId];
      const displayName = userGlobal?.name || userId.split('@')[0];
      const custom = userGlobal?.claimMessage;
      const duration = character.expiresAt ? ((now - character.expiresAt + 60000) / 1000).toFixed(1) : '0.0';
      const finalMessage = custom
        ? custom.replace(/€user/g, `*${displayName}*`).replace(/€character/g, `*${character.name}*`)
        : `*${character.name}* ha sido reclamado y añadido a tu harem con éxito`;

      await msg.reply(`❀ ${finalMessage} (${duration}s)`);
    } catch (e) {
      await msg.reply(`> Ocurrió un error al ejecutar *${usedPrefix + command}*.\n> [Error: *${e.message}*]`);
    }
  }
};
          
