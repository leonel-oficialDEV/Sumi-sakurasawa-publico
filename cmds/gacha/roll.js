import axios from 'axios';
import { promises as fs } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import db from '#db';

const rollLocks = new Map();
const STATS_FILE_PATH = path.join(process.cwd(), 'lib', 'character_stats.json');

function cleanOldLocks() {
  const now = Date.now();
  for (const [userId, lockTime] of rollLocks.entries()) {
    if (now - lockTime > 30000) rollLocks.delete(userId);
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

// Carga del sistema Gacha y su función de probabilidad
async function getGachaSystem() {
  const filePath = path.join(process.cwd(), 'lib', 'characters.js');
  try {
    const fileUrl = pathToFileURL(filePath).href;
    const module = await import(`${fileUrl}?update=${Date.now()}`);

    const list = module.characters || module.data || module.default || (Array.isArray(module) ? module : []);
    const getRandom = typeof module.getRandomCharacter === 'function' ? module.getRandomCharacter : null;

    if (Array.isArray(list) && list.length > 0) {
      return { list, getRandom };
    }
  } catch (err) {
    console.error('[RollWaifu Error] Error al importar lib/characters.js:', err.message);
  }

  const globalList = Array.isArray(global.characters) ? global.characters : [];
  return { list: globalList, getRandom: null };
}

async function getCharacterStat(id) {
  try {
    await fs.access(STATS_FILE_PATH);
  } catch {
    await fs.writeFile(STATS_FILE_PATH, '{}');
  }
  try {
    const data = await fs.readFile(STATS_FILE_PATH, 'utf-8');
    return JSON.parse(data)[id] || null;
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

// Clasificación por tus 8 Rarezas exactas según valor económico
function getRarityByValue(val) {
  if (val >= 10000000) return { name: 'Secreto', color: '🌌' };
  if (val >= 2000000) return { name: 'Mítico', color: '🔴' };
  if (val >= 750000) return { name: 'Legendario', color: '🟡' };
  if (val >= 250000) return { name: 'Épico', color: '🟣' };
  if (val >= 90000) return { name: 'Muy Raro', color: '🔷' };
  if (val >= 30000) return { name: 'Raro', color: '🔵' };
  if (val >= 10000) return { name: 'Poco Común', color: '🟢' };
  return { name: 'Común', color: '⚪' };
}

// Detección de texto de Rareza asignada directamente
function getCharacterRarity(character, chatChar, finalValue) {
  const rawRarity = chatChar?.rareza || chatChar?.rarity || chatChar?.clase || character?.rareza || character?.rarity || character?.clase || character?.tier;

  if (rawRarity) {
    const cleanRar = String(rawRarity).trim();
    const lowerRar = cleanRar.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

    if (lowerRar.includes('secreto')) return { name: 'Secreto', color: '🌌' };
    if (lowerRar.includes('mitico')) return { name: 'Mítico', color: '🔴' };
    if (lowerRar.includes('legendario') || lowerRar.includes('leyenda')) return { name: 'Legendario', color: '🟡' };
    if (lowerRar.includes('epico') || lowerRar.includes('especial')) return { name: 'Épico', color: '🟣' };
    if (lowerRar.includes('muy raro')) return { name: 'Muy Raro', color: '🔷' };
    if (lowerRar.includes('raro')) return { name: 'Raro', color: '🔵' };
    if (lowerRar.includes('poco')) return { name: 'Poco Común', color: '🟢' };
    if (lowerRar.includes('comun')) return { name: 'Común', color: '⚪' };
    return { name: cleanRar, color: '⭐' };
  }

  return getRarityByValue(finalValue);
}

async function buscarImagenPersonaje(nombre, serie) {
  const cleanName = nombre.replace(/\s*\(.*?\)\s*/g, '').trim();
  const cleanSeries = (serie && serie !== 'Desconocido') ? serie.trim() : 'anime';
  const booruTag = cleanName.replace(/\s+/g, '_').toLowerCase();
  let results = [];

  try {
    const { data } = await axios.get(`https://safebooru.org/index.php?page=dapi&s=post&q=index&json=1&tags=${encodeURIComponent(booruTag)}`, { timeout: 4000 });
    if (Array.isArray(data) && data.length > 0) {
      results = data.map(p => `https://safebooru.org/images/${p.directory}/${p.image}`);
      if (results.length > 0) return results;
    }
  } catch {}

  try {
    const { data } = await axios.get(`https://gelbooru.com/index.php?page=dapi&s=post&q=index&json=1&tags=${encodeURIComponent(booruTag)}+rating:general`, { timeout: 4000 });
    if (data?.post?.length > 0) {
      results = data.post.map(p => p.file_url);
      if (results.length > 0) return results;
    }
  } catch {}

  const queries = [
    `${cleanName} ${cleanSeries} anime`.trim(),
    `${cleanName} ${cleanSeries} character`.trim()
  ];

  for (const query of queries) {
    const endpoints = [
      `https://api.evogb.org/search/pinterest?query=${encodeURIComponent(query)}&apikey=Mai301520-art`,
      `https://api.delirius.online/search/pinterestv2?text=${encodeURIComponent(query)}`,
      `https://bk9.fun/search/gimage?q=${encodeURIComponent(query)}`
    ];

    for (const ep of endpoints) {
      try {
        const { data } = await axios.get(ep, { timeout: 4000 });
        const items = data?.data || data?.result || data?.results || data;
        if (Array.isArray(items) && items.length > 0) {
          results = items.map(i => i?.hd || i?.image_url || i?.url || i?.image || i?.link).filter(url => typeof url === 'string' && /^https?:\/\//i.test(url));
          if (results.length > 0) return results;
        }
      } catch {}
    }
  }
  return results;
}

export default {
  command: ['rollwaifu', 'rw', 'roll'],
  category: 'gacha',
  description: 'Obtén una waifu o husbando aleatorio para reclamar.',
  run: async ({ msg, sock, usedPrefix, command }) => {
    const userId = msg.sender;
    const chatId = msg.chat;

    cleanOldLocks();
    if (rollLocks.has(userId)) {
      const lockTime = rollLocks.get(userId);
      const now = Date.now();
      if (now - lockTime < 15000) return;
      rollLocks.delete(userId);
    }

    try {
      if (typeof db.read === 'function') await db.read();

      if (!db.data) db.data = {};
      if (!db.data.chats) db.data.chats = {};
      if (!db.data.chats[chatId]) db.data.chats[chatId] = {};
      let chat = db.getChat ? db.getChat(chatId) : db.data.chats[chatId];

      if (chat?.adminonly || chat?.gacha === false) {
        return msg.reply(`ꕥ Los comandos de *Gacha* están desactivados en este grupo.\n\nUn *administrador* puede activarlos con el comando:\n» *${usedPrefix}gacha on*`);
      }

      const isOwner = global.owner?.some(o => userId.includes(o)) || (typeof db.isOwner === 'function' && db.isOwner(userId));
      let user = db.getChatUser ? db.getChatUser(chatId, userId) : db.data.chat_users?.[chatId]?.[userId] || {};
      const now = Date.now();
      const cooldown = 15 * 60 * 1000;

      if (!isOwner && user.lastRoll && now < user.lastRoll) {
        const r = Math.ceil((user.lastRoll - now) / 1000);
        const min = Math.floor(r / 60);
        const sec = r % 60;
        let timeText = '';
        if (min > 0) timeText += `${min} minuto${min !== 1 ? 's' : ''} `;
        if (sec > 0 || timeText === '') timeText += `${sec} segundo${sec !== 1 ? 's' : ''}`;
        return msg.reply(`ꕥ Debes esperar *${timeText.trim()}* para usar *${usedPrefix + command}* de nuevo.`);
      }

      rollLocks.set(userId, now);

      const { list: dbChars, getRandom } = await getGachaSystem();
      if (!dbChars || !dbChars.length) {
        rollLocks.delete(userId);
        return msg.reply(`ꕥ No se encontraron personajes cargados en la base de datos.`);
      }

      // Usa la función probabilística de lib/characters.js si existe; de lo contrario, elige uno al azar
      const character = getRandom ? getRandom() : dbChars[Math.floor(Math.random() * dbChars.length)];
      if (!character) {
        rollLocks.delete(userId);
        return msg.reply(`ꕥ Error al seleccionar un personaje aleatorio.`);
      }

      const series = character.source || character.series || character.anime || 'Desconocido';
      const charId = character.keyword || character.id || normalizeStr(character.name || 'char').replace(/\s+/g, '_');
      const charName = character.name || 'Sin nombre';

      const characterImage = character.image || character.img || character.avatar || character.photo || character.url;
      let mediaList = [];

      if (characterImage && typeof characterImage === 'string' && /^https?:\/\//i.test(characterImage)) {
        mediaList = [characterImage];
      } else {
        mediaList = await buscarImagenPersonaje(charName, series);
      }

      if (!mediaList || mediaList.length === 0) {
        rollLocks.delete(userId);
        return msg.reply(`ꕥ No se encontraron imágenes válidas para *${charName}*.`);
      }

      let imageToSend = null;
      for (const mediaUrl of mediaList) {
        try {
          const imgRes = await axios.get(mediaUrl, { 
            responseType: 'arraybuffer', 
            timeout: 6000, 
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
          });
          if (imgRes.data && imgRes.data.byteLength > 1000) {
            imageToSend = Buffer.from(imgRes.data);
            break;
          }
        } catch {}
      }

      if (!imageToSend) {
        rollLocks.delete(userId);
        return msg.reply(`ꕥ No se pudo descargar ninguna imagen válida para *${charName}*.`);
      }

      const charKey = chatId + '__' + charId;
      let chatChar = await getCharacterStat(charKey) || {};

      const finalValue = chatChar.value || Number(character.price) || Number(character.value) || 5000;
      const rarity = getCharacterRarity(character, chatChar, finalValue);

      let ownerId = chatChar.owner || chatChar.claimedBy || chatChar.user || chatChar.claimed;
      let ownerName = 'Desconocido';

      if (!ownerId) {
        const chatUsersObj = db.data.chat_users?.[chatId] || {};
        for (const [uId, uData] of Object.entries(chatUsersObj)) {
          let userChars = uData?.characters || [];
          if (typeof userChars === 'string') {
            try { userChars = JSON.parse(userChars); } catch { userChars = []; }
          }
          if (Array.isArray(userChars) && (userChars.includes(charId) || userChars.includes(charKey))) {
            ownerId = uId;
            break;
          }
        }
      }

      if (ownerId) {
        const ownerGlobal = db.getUser ? db.getUser(ownerId) : db.data.users?.[ownerId];
        const ownerChatUser = db.getChatUser ? db.getChatUser(chatId, ownerId) : db.data.chat_users?.[chatId]?.[ownerId];
        ownerName = ownerGlobal?.name?.trim() || ownerChatUser?.name?.trim() || (typeof ownerId === 'string' ? ownerId.split('@')[0] : 'Desconocido');
      }

      const statusText = ownerId ? `Reclamado por *${ownerName}*` : '*Libre*';

      chatChar.name = charName;
      chatChar.value = finalValue;
      chatChar.reservedBy = userId;
      chatChar.reservedUntil = now + 20000;
      chatChar.expiresAt = now + 60000;
      await setCharacterStat(charKey, chatChar);

      const age = character.age || '-';
      const height = character.height || '-';
      const gender = character.gender || 'Desconocido';

      const caption = `❀ Nombre » *${chatChar.name}*\n⚥ Género » *${gender}*\n🎂 Edad » *${age}*\n📏 Altura » *${height}*\n✰ Rareza » *${rarity.color} ${rarity.name}*\n💰 Valor » *$${finalValue.toLocaleString()}*\n♡ Estado » ${statusText}\n❖ Serie/Anime » *${series}*\u206c`;

      const sent = await sock.sendMessage(chatId, { image: imageToSend, caption: caption }, { quoted: msg });

      if (!chat.rolls) chat.rolls = {};
      chat.rolls[sent.key.id] = { 
        id: charId, 
        charKey, 
        name: chatChar.name, 
        expiresAt: chatChar.expiresAt, 
        reservedBy: userId, 
        reservedUntil: chatChar.reservedUntil 
      };

      db.data.chats[chatId].rolls = chat.rolls;
      if (typeof db.updateChat === 'function') {
        db.updateChat(chatId, 'rolls', chat.rolls);
      }

      if (!isOwner) {
        const nextRollTime = now + cooldown;
        user.lastRoll = nextRollTime;
        if (!db.data.chat_users) db.data.chat_users = {};
        if (!db.data.chat_users[chatId]) db.data.chat_users[chatId] = {};
        if (!db.data.chat_users[chatId][userId]) db.data.chat_users[chatId][userId] = {};
        db.data.chat_users[chatId][userId].lastRoll = nextRollTime;

        if (typeof db.updateChatUser === 'function') {
          db.updateChatUser(chatId, userId, 'lastRoll', nextRollTime);
        }
      }

      if (typeof db.write === 'function') await db.write();

    } catch (e) {
      await msg.reply(`> Ocurrió un error interno al ejecutar el comando.\n> [Error: *${e.message}*]`);
    } finally {
      rollLocks.delete(userId);
    }
  }
};
