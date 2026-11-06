import axios from 'axios';
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

function getRarityByValue(val) {
  if (val >= 300000) return { name: 'Mítico', color: '🔴' };
  if (val >= 100001) return { name: 'Legendario', color: '🟡' };
  if (val >= 40001) return { name: 'Épico', color: '🟣' };
  if (val >= 15001) return { name: 'Raro', color: '🔵' };
  if (val >= 5001) return { name: 'Poco Común', color: '🟢' };
  return { name: 'Común', color: '⚪' };
}

function flattenCharacters(raw) {
  if (!raw) return [];
  const list = [];

  const processChar = (c, defaultSeries = 'Desconocido') => {
    if (!c) return;
    const source = c.source || c.series || c.anime || defaultSeries;
    const charId = c.id || c.keyword || normalizeStr(c.name || '').replace(/\s+/g, '_');
    list.push({ ...c, source, id: charId });
  };

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item) continue;
      if (Array.isArray(item.characters)) {
        const sName = item.name || item.title || item.series || 'Desconocido';
        for (const c of item.characters) processChar(c, sName);
      } else {
        processChar(item);
      }
    }
  } else if (typeof raw === 'object') {
    for (const [key, val] of Object.entries(raw)) {
      if (!val) continue;
      if (Array.isArray(val)) {
        for (const c of val) processChar(c, key);
      } else if (Array.isArray(val.characters)) {
        const sName = val.name || val.title || key;
        for (const c of val.characters) processChar(c, sName);
      } else if (val.name) {
        processChar(val, key);
      }
    }
  }

  return list;
}

function getRefererForUrl(url) {
  if (url.includes('safebooru.org')) return 'https://safebooru.org/';
  if (url.includes('danbooru.donmai.us')) return 'https://danbooru.donmai.us/';
  if (url.includes('gelbooru.com')) return 'https://gelbooru.com/';
  return '';
}

async function buscarImagenDelirius(tag, serieTag = '') {
  const cleanName = tag.replace(/\s*\(.*?\)\s*/g, '').trim();
  const cleanSeries = (serieTag && serieTag !== 'Desconocido') ? serieTag.trim() : 'anime';
  const query = normalizeStr(cleanName).replace(/\s+/g, '_');
  const booruTag = query;
  
  let results = [];

  try {
    const { data } = await axios.get(`https://safebooru.org/index.php?page=dapi&s=post&q=index&json=1&tags=${encodeURIComponent(booruTag)}`, { timeout: 5000 });
    if (Array.isArray(data) && data.length > 0) {
      results = data.map(p => `https://safebooru.org/images/${p.directory}/${p.image}`);
      if (results.length > 0) return results;
    }
  } catch {}

  try {
    const { data } = await axios.get(`https://gelbooru.com/index.php?page=dapi&s=post&q=index&json=1&tags=${encodeURIComponent(booruTag)}+rating:general`, { timeout: 5000 });
    if (data?.post?.length > 0) {
      results = data.post.map(p => p.file_url);
      if (results.length > 0) return results;
    }
  } catch {}

  try {
    const { data } = await axios.get(`https://danbooru.donmai.us/posts.json?tags=${encodeURIComponent(booruTag)}+rating:general`, { timeout: 5000 });
    if (Array.isArray(data) && data.length > 0) {
      results = data.map(p => p.file_url).filter(Boolean);
      if (results.length > 0) return results;
    }
  } catch {}

  const queries = [
    `${cleanName} ${cleanSeries} anime render`.trim(),
    `${cleanName} de ${cleanSeries} personaje`.trim(),
    `${cleanName} ${cleanSeries} official art`.trim(),
    `${cleanName} anime character`.trim()
  ];

  for (const q of queries) {
    const endpoints = [
      `https://api.evogb.org/search/pinterest?query=${encodeURIComponent(q)}&apikey=Mai301520-art`,
      `https://api.evogb.org/search/pinterestv2?query=${encodeURIComponent(q)}&apikey=Mai301520-art`,
      `https://delirius-apiofc.vercel.app/search/pinterestv2?text=${encodeURIComponent(q)}`,
      `https://api.vreden.web.id/api/v1/search/pinterest?query=${encodeURIComponent(q)}`,
      `https://api.evogb.org/search/googleimage?query=${encodeURIComponent(q)}&apikey=Mai301520-art`,
      `https://bk9.fun/search/gimage?q=${encodeURIComponent(q)}`
    ];

    for (const ep of endpoints) {
      try {
        const { data } = await axios.get(ep, { timeout: 5000 });
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

function formatElapsed(ms) {
  if (!ms || ms <= 0) return '—';
  const sec = Math.floor(ms / 1000);
  const w = Math.floor(sec / 604800);
  const d = Math.floor((sec % 604800) / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts = [];
  if (w > 0) parts.push(`${w}w`);
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0) parts.push(`${s}s`);
  return parts.join(' ');
}

export default {
  command: ['charinfo', 'winfo', 'waifuinfo'],
  category: 'gacha',
  description: 'Ver información e imagen de un personaje.',
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

      if (!args.length) {
        return msg.reply(`❀ Por favor, proporciona el nombre de un personaje.\n> Ejemplo » *${usedPrefix + command} Nagi Seishiro*`);
      }

      const [rawStructure, allStats] = await Promise.all([
        loadCharacters(),
        loadAllStats()
      ]);

      const charactersList = flattenCharacters(rawStructure);
      if (!charactersList || !charactersList.length) {
        return msg.reply(`ꕥ No hay personajes disponibles en *lib/characters.js*.`);
      }

      const rawQuery = args.join(' ');
      const queryText = normalizeStr(rawQuery);
      const queryWords = queryText.split(' ').filter(Boolean);

      let character = null;

      for (const c of charactersList) {
        const charNameNorm = normalizeStr(c?.name);
        const charIdNorm = normalizeStr(c?.id);
        const tagsNorm = Array.isArray(c?.tags) ? c.tags.map(normalizeStr) : [];
        const aliasesNorm = Array.isArray(c?.aliases) ? c.aliases.map(normalizeStr) : [];

        if (charNameNorm === queryText || charIdNorm === queryText) {
          character = c;
          break;
        }
        if (charNameNorm.includes(queryText) || queryText.includes(charNameNorm)) {
          character = c;
          break;
        }
        if (tagsNorm.some(t => t === queryText || t.includes(queryText)) || aliasesNorm.some(a => a === queryText || a.includes(queryText))) {
          character = c;
          break;
        }

        const nameWords = charNameNorm.split(' ').filter(Boolean);
        const matchesAllWords = queryWords.every(qw => nameWords.some(nw => nw.includes(qw) || qw.includes(nw)));
        if (matchesAllWords && queryWords.length > 0) {
          character = c;
          break;
        }
      }

      if (!character) {
        return msg.reply(`ꕥ No se encontró el personaje *${rawQuery}* en ninguna serie.`);
      }

      const source = character.source || character.series || character.anime || 'Desconocido';
      const charId = character.id || character.keyword || normalizeStr(character.name || '').replace(/\s+/g, '_');
      const characterImage = character.image || character.img || character.avatar || character.photo || character.url;
      let mediaList = [];

      if (characterImage && typeof characterImage === 'string' && /^https?:\/\//i.test(characterImage)) {
        mediaList = [characterImage];
      } else {
        const tag = Array.isArray(character.tags) && character.tags.length ? character.tags[0] : character.name;
        mediaList = await buscarImagenDelirius(tag, source);
      }

      const media = mediaList[Math.floor(Math.random() * mediaList.length)];
      
      const charKey = chatId + '__' + charId;
      let chatChar = allStats[charKey] || {};
      const finalValue = Number(chatChar.value) || Number(character.value) || 100;

      const rawRarity = chatChar?.rareza || chatChar?.rarity || chatChar?.clase || character?.rareza || character?.rarity || character?.clase || character?.tier;

      let rarity;
      if (rawRarity) {
        const cleanRar = String(rawRarity).trim();
        if (cleanRar.includes('🔴') || cleanRar.toLowerCase().includes('mitico') || cleanRar.toLowerCase().includes('mítico')) {
          rarity = { name: 'Mítico', color: '🔴' };
        } else if (cleanRar.includes('🟡') || cleanRar.toLowerCase().includes('legendario')) {
          rarity = { name: 'Legendario', color: '🟡' };
        } else if (cleanRar.includes('🟣') || cleanRar.toLowerCase().includes('epico') || cleanRar.toLowerCase().includes('épico')) {
          rarity = { name: 'Épico', color: '🟣' };
        } else if (cleanRar.includes('🔵') || cleanRar.toLowerCase().includes('raro')) {
          rarity = { name: 'Raro', color: '🔵' };
        } else if (cleanRar.includes('🟢') || cleanRar.toLowerCase().includes('poco')) {
          rarity = { name: 'Poco Común', color: '🟢' };
        } else if (cleanRar.includes('⚪') || cleanRar.toLowerCase().includes('comun') || cleanRar.toLowerCase().includes('común')) {
          rarity = { name: 'Común', color: '⚪' };
        } else {
          rarity = { name: cleanRar, color: '⭐' };
        }
      } else {
        rarity = getRarityByValue(finalValue);
      }

      let ownerId = chatChar.owner || chatChar.claimedBy || chatChar.user || chatChar.claimed;
      
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

      let ownerName = 'Desconocido';
      if (ownerId) {
        const ownerGlobal = db.getUser ? db.getUser(ownerId) : db.data.users?.[ownerId];
        const ownerChatUser = db.getChatUser ? db.getChatUser(chatId, ownerId) : db.data.chat_users?.[chatId]?.[ownerId];
        ownerName = ownerGlobal?.name?.trim() || ownerChatUser?.name?.trim() || (typeof ownerId === 'string' ? ownerId.split('@')[0] : 'Desconocido');
      }

      let claimedDateLine = '';
      if (chatChar?.claimedAt) {
        claimedDateLine = `\nⴵ Fecha de reclamo » *${new Date(chatChar.claimedAt).toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}*`;
      }

      const statusText = ownerId ? `Reclamado por *${ownerName}*` : '*Libre*';
      const lastVoteAgo = typeof chatChar.lastVotedAt === 'number' ? `hace *${formatElapsed(Date.now() - chatChar.lastVotedAt)}*` : '*Nunca*';

      const sorted = charactersList.map(c => {
        const cKey = chatId + '__' + c.id;
        const statVal = allStats[cKey]?.value;
        return { id: c.id, value: Number(statVal) || Number(c.value) || 100 };
      }).sort((a, b) => b.value - a.value);

      const rankIndex = sorted.findIndex(c => c.id === character.id);
      const rank = rankIndex !== -1 ? `#${rankIndex + 1}` : '—';

      const age = character.age || 'Desconocida';
      const height = character.height || 'Desconocida';
      const gender = character.gender || 'Desconocido';

      const caption = `❀ Nombre » *${character.name}*
⚥ Género » *${gender}*
🎂 Edad » *${age}*
📏 Altura » *${height}*
✰ Rareza » *${rarity.color} ${rarity.name}*
💰 Valor » *${finalValue.toLocaleString()}*
♡ Estado » ${statusText}${claimedDateLine}
❖ Serie/Anime » *${source}*
❏ Puesto » *${rank}*
ⴵ Último voto » ${lastVoteAgo}`.trim();

      if (media) {
        try {
          const imgRes = await axios.get(media, { 
            responseType: 'arraybuffer', 
            timeout: 15000, 
            headers: { 
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 
              'Referer': getRefererForUrl(media) 
            }
          });
          const buffer = Buffer.from(imgRes.data);
          return await sock.sendMessage(chatId, { image: buffer, caption }, { quoted: msg });
        } catch {
          // Si falla la descarga de imagen, envía el texto solo con fallback
        }
      }

      await msg.reply(caption);
    } catch (e) {
      await msg.reply(`> Ocurrió un error al ejecutar el comando *${usedPrefix + command}*.\n> [Error: *${e.message}*]`);
    }
  }
};
                        
