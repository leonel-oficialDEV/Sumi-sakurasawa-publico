import axios from 'axios';
import { promises as fs } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import db from '#db';

const rollLocks = new Map();
const STATS_FILE_PATH = path.join(process.cwd(), 'lib', 'character_stats.json');

const EVO_KEY = 'Apex-Predator2010';

const imageCache = new Map();

const IMG_EXT = /\.(jpe?g|png|webp)(\?.*)?$/i;
const JUNK_DOMAINS = /(adobe|shutterstock|alamy|istockphoto|gettyimages|dreamstime|123rf|depositphotos|stock\.|ticketmaster|facebook|instagram|youtube|ytimg|amazon|ebay|etsy)/i;

const RARITY_RANGE = {
  'Común': [100, 200],
  'Poco Común': [200, 500],
  'Raro': [500, 1000],
  'Épico': [1000, 2500],
  'Legendario': [2500, 5000],
  'Mítico': [5000, 10000]
};

function randomInRange(min, max) {
  const value = Math.floor(Math.random() * (max - min + 1)) + min;
  return Math.round(value / 10) * 10;
}

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

function toTag(s) {
  return normalizeStr(s).replace(/\s+/g, '_');
}

function cleanSeriesName(serie) {
  const original = String(serie || '').trim();
  const cleaned = original
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/\s+(manga|anime)(\s+(y|and|e|&)\s+(manga|anime))?\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || original;
}

function shuffle(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
}

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

function getRarityByValue(val) {
  if (val >= 5000) return { name: 'Mítico', color: '🔴' };
  if (val >= 2500) return { name: 'Legendario', color: '🟡' };
  if (val >= 1000) return { name: 'Épico', color: '🟣' };
  if (val >= 500) return { name: 'Raro', color: '🔵' };
  if (val >= 200) return { name: 'Poco Común', color: '🟢' };
  return { name: 'Común', color: '⚪' };
}

function getCharacterRarity(character, chatChar, finalValue) {
  const rawRarity = chatChar?.rareza || chatChar?.rarity || chatChar?.clase || character?.rareza || character?.rarity || character?.clase || character?.tier;

  if (rawRarity) {
    const cleanRar = String(rawRarity).trim();
    const lowerRar = cleanRar.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

    if (lowerRar.includes('secreto') || lowerRar.includes('mitico')) return { name: 'Mítico', color: '🔴' };
    if (lowerRar.includes('legendario') || lowerRar.includes('leyenda')) return { name: 'Legendario', color: '🟡' };
    if (lowerRar.includes('epico') || lowerRar.includes('especial')) return { name: 'Épico', color: '🟣' };
    if (lowerRar.includes('raro')) return { name: 'Raro', color: '🔵' };
    if (lowerRar.includes('poco')) return { name: 'Poco Común', color: '🟢' };
    if (lowerRar.includes('comun')) return { name: 'Común', color: '⚪' };
    return { name: cleanRar, color: '⭐' };
  }

  return getRarityByValue(finalValue);
}

async function getJson(url, timeout = 3500) {
  const { data } = await axios.get(url, { timeout });
  return data;
}

async function fetchBooru(site, tags) {
  const q = encodeURIComponent(tags);
  if (site === 'safebooru') {
    const data = await getJson(`https://safebooru.org/index.php?page=dapi&s=post&q=index&json=1&limit=40&tags=${q}`);
    if (!Array.isArray(data)) return [];
    return data
      .filter(p => p.directory && p.image && IMG_EXT.test(p.image))
      .map(p => `https://safebooru.org/images/${p.directory}/${p.image}`);
  }
  const data = await getJson(`https://gelbooru.com/index.php?page=dapi&s=post&q=index&json=1&limit=40&tags=${q}`);
  return (data?.post || [])
    .map(p => p.file_url)
    .filter(u => typeof u === 'string' && IMG_EXT.test(u));
}

async function searchBooru(nameTags, seriesTag) {
  const bases = [];
  for (const nameTag of nameTags) {
    if (seriesTag) {
      bases.push(`${nameTag}_(${seriesTag})`, `${nameTag}_(${seriesTag.replace(/_/g, '')})`);
    } else {
      bases.push(nameTag);
    }
  }

  const jobs = [];
  for (const base of bases) {
    for (const extra of ['solo', '']) {
      for (const site of ['safebooru', 'gelbooru']) {
        const tags = `${base} ${extra} rating:general`.replace(/\s+/g, ' ').trim();
        jobs.push(fetchBooru(site, tags).catch(() => []));
      }
    }
  }

  const results = await Promise.all(jobs);
  const first = results.find(r => r.length);
  return first ? shuffle(first) : [];
}

function parseImageItems(data) {
  const items = data?.data || data?.result || data?.results || data;
  if (!Array.isArray(items)) return [];
  return items
    .map(i => (typeof i === 'string' ? i : i?.hd || i?.image_url || i?.url || i?.image || i?.link))
    .filter(u => typeof u === 'string' && /^https?:\/\//i.test(u) && !JUNK_DOMAINS.test(u));
}

async function searchEvo(name, series) {
  const query = `${name} ${series || 'anime'} anime character`.trim();
  const q = encodeURIComponent(query);
  const endpoints = [
    `https://api.evogb.org/search/pinterest?query=${q}&apikey=${EVO_KEY}`,
    `https://api.evogb.org/search/googleimage?query=${q}&apikey=${EVO_KEY}`
  ];

  const results = await Promise.all(
    endpoints.map(ep => getJson(ep, 4500).then(parseImageItems).catch(() => []))
  );
  return [...new Set(results.flat())].slice(0, 12);
}

async function buscarImagenPersonaje(nombre, serie, keyword) {
  const cleanName = nombre.replace(/\s*\(.*?\)\s*/g, '').trim();
  const alias = (nombre.match(/\(([^)]+)\)/) || [])[1] || '';
  const hasSeries = serie && serie !== 'Desconocido';
  const seriesClean = hasSeries ? cleanSeriesName(serie) : '';
  const seriesTag = hasSeries ? toTag(seriesClean) : '';

  const nameTags = [...new Set([toTag(cleanName), toTag(keyword), toTag(alias)].filter(Boolean))].slice(0, 3);

  const booru = await searchBooru(nameTags, seriesTag);
  if (booru.length) return booru;

  return await searchEvo(cleanName, seriesClean);
}

async function descargarPrimera(urls) {
  const chunkSize = 4;
  for (let i = 0; i < urls.length && i < 12; i += chunkSize) {
    const chunk = urls.slice(i, i + chunkSize);
    try {
      return await Promise.any(
        chunk.map(async url => {
          const res = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 6000,
            maxContentLength: 8 * 1024 * 1024,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
          });
          const type = String(res.headers?.['content-type'] || '');
          if (!type.startsWith('image/') || !res.data || res.data.byteLength < 1000) {
            throw new Error('imagen inválida');
          }
          return { buffer: Buffer.from(res.data), url };
        })
      );
    } catch {}
  }
  return null;
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

      const chat = db.getChat(msg.chat);
      if (chat?.adminonly || !chat?.gacha) {
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

      const character = getRandom ? getRandom() : dbChars[Math.floor(Math.random() * dbChars.length)];
      if (!character) {
        rollLocks.delete(userId);
        return msg.reply(`ꕥ Error al seleccionar un personaje aleatorio.`);
      }

      const series = character.source || character.series || character.anime || 'Desconocido';
      const charId = character.keyword || character.id || normalizeStr(character.name || 'char').replace(/\s+/g, '_');
      const charName = character.name || 'Sin nombre';

      const characterImage = character.image || character.img || character.avatar || character.photo || character.url;
      const hasOwnImage = characterImage && typeof characterImage === 'string' && /^https?:\/\//i.test(characterImage);
      const cacheKey = `${normalizeStr(series)}__${charId}`;

      let mediaList = [];
      let fromCache = false;

      if (hasOwnImage) {
        mediaList = [characterImage];
      } else if (imageCache.has(cacheKey)) {
        mediaList = shuffle(imageCache.get(cacheKey));
        fromCache = true;
      } else {
        mediaList = await buscarImagenPersonaje(charName, series, character.keyword);
      }

      let dl = mediaList.length ? await descargarPrimera(mediaList) : null;

      if (!dl && fromCache) {
        imageCache.delete(cacheKey);
        mediaList = await buscarImagenPersonaje(charName, series, character.keyword);
        dl = mediaList.length ? await descargarPrimera(mediaList) : null;
      }

      if (!dl) {
        rollLocks.delete(userId);
        return msg.reply(`ꕥ No se encontraron imágenes válidas para *${charName}*.`);
      }

      if (!hasOwnImage) {
        imageCache.set(cacheKey, [dl.url, ...mediaList.filter(u => u !== dl.url)].slice(0, 15));
      }
      const imageToSend = dl.buffer;

      const charKey = chatId + '__' + charId;
      let chatChar = await getCharacterStat(charKey) || {};

      let finalValue = Number(chatChar.value) || Number(character.price) || Number(character.value) || 0;
      const rarity = getCharacterRarity(character, chatChar, finalValue || 100);

      const range = RARITY_RANGE[rarity.name];
      if (range && (finalValue < range[0] || finalValue > range[1])) {
        finalValue = randomInRange(range[0], range[1]);
      }
      if (!finalValue) finalValue = 100;

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
