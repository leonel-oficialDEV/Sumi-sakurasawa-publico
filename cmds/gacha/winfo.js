import axios from 'axios';
import { promises as fs } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import db from '#db';

const STATS_FILE_PATH = path.join(process.cwd(), 'lib', 'character_stats.json');
const CHARACTERS_FILE_PATH = path.join(process.cwd(), 'lib', 'characters.js');
const CHARACTERS_DIR_PATH = path.join(process.cwd(), 'lib', 'characters');

const EVO_KEY = 'Apex-Predator2010';
const SUGGEST_COMMAND = 'suggest';

const imageCache = new Map();
const charactersCache = { mtime: 0, list: [] };

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

function shuffle(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
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

function flattenCharacters(raw) {
  if (!raw) return [];
  const list = [];

  const processChar = (c, defaultSeries = 'Desconocido') => {
    if (!c || !c.name) return;
    const source = c.source || c.series || c.anime || defaultSeries;
    const charId = c.id || c.keyword || normalizeStr(c.name).replace(/\s+/g, '_');
    const norm = normalizeStr(c.name);
    if (!norm) return;
    list.push({ ...c, source, id: charId, _norm: norm });
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

async function getCharactersSignature() {
  const files = [CHARACTERS_FILE_PATH];
  try {
    const dir = await fs.readdir(CHARACTERS_DIR_PATH);
    for (const f of dir) {
      if (f.endsWith('.js')) files.push(path.join(CHARACTERS_DIR_PATH, f));
    }
  } catch {}

  let latest = 0;
  for (const f of files) {
    try {
      const { mtimeMs } = await fs.stat(f);
      latest = Math.max(latest, mtimeMs);
    } catch {}
  }
  return `${Math.floor(latest)}-${files.length}`;
}

async function loadCharacters() {
  try {
    const signature = await getCharactersSignature();
    if (charactersCache.list.length && charactersCache.mtime === signature) {
      return charactersCache.list;
    }
    const module = await import(`${pathToFileURL(CHARACTERS_FILE_PATH).href}?update=${signature}`);
    const raw = module.default || module.characters || module.data || module;
    const list = flattenCharacters(raw);
    charactersCache.mtime = signature;
    charactersCache.list = list;
    return list;
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

function toNormList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeStr).filter(Boolean);
}

function findCharacter(list, queryText) {
  if (!queryText || queryText.length < 2) return null;
  const queryWords = queryText.split(' ').filter(Boolean);

  const tiers = [[], [], [], []];

  for (const c of list) {
    const name = c._norm;
    const id = normalizeStr(c.id);
    const extras = [...toNormList(c.tags), ...toNormList(c.aliases)];

    if (name === queryText || id === queryText || extras.includes(queryText)) {
      tiers[0].push(c);
      continue;
    }

    if (` ${name} `.includes(` ${queryText} `) || extras.some(e => ` ${e} `.includes(` ${queryText} `))) {
      tiers[1].push(c);
      continue;
    }

    const nameWords = name.split(' ');
    const allWordsMatch = queryWords.every(qw => nameWords.some(nw => nw === qw || (qw.length >= 3 && nw.startsWith(qw))));
    if (allWordsMatch) {
      tiers[2].push(c);
      continue;
    }

    if (queryText.length >= 4 && (name.includes(queryText) || extras.some(e => e.includes(queryText)))) {
      tiers[3].push(c);
    }
  }

  for (const tier of tiers) {
    if (tier.length) {
      return tier.sort((a, b) => a._norm.length - b._norm.length)[0];
    }
  }
  return null;
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const m = a.length;
  const n = b.length;
  const prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? last : 1 + Math.min(last, prev[j], prev[j - 1]);
      last = tmp;
    }
  }
  return 1 - prev[n] / Math.max(m, n);
}

function suggestCharacters(list, queryText) {
  const queryWords = queryText.split(' ').filter(Boolean);
  const scored = [];

  for (const c of list) {
    const nameWords = c._norm.split(' ');
    let score = similarity(queryText, c._norm);

    for (const w of nameWords) {
      if (w.length >= 3) score = Math.max(score, similarity(queryText, w) * 0.95);
    }

    if (queryWords.length) {
      let total = 0;
      for (const qw of queryWords) {
        let best = 0;
        for (const nw of nameWords) best = Math.max(best, similarity(qw, nw));
        total += best;
      }
      score = Math.max(score, (total / queryWords.length) * 0.9);
    }

    if (queryText.length >= 3 && c._norm.includes(queryText)) score = Math.max(score, 0.8);

    if (score >= 0.55) scored.push({ c, score });
  }

  scored.sort((a, b) => b.score - a.score);

  const seen = new Set();
  const result = [];
  for (const { c } of scored) {
    const key = `${c._norm}__${normalizeStr(c.source)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(c);
    if (result.length >= 5) break;
  }
  return result;
}

function getRarityByValue(val) {
  if (val >= 5000) return { name: 'Mítico', color: '🔴' };
  if (val >= 2500) return { name: 'Legendario', color: '🟡' };
  if (val >= 1000) return { name: 'Épico', color: '🟣' };
  if (val >= 500) return { name: 'Raro', color: '🔵' };
  if (val >= 200) return { name: 'Poco Común', color: '🟢' };
  return { name: 'Común', color: '⚪' };
}

function getRarity(character, chatChar, baseValue) {
  const rawRarity = chatChar?.rareza || chatChar?.rarity || chatChar?.clase || character?.rareza || character?.rarity || character?.clase || character?.tier;

  if (rawRarity) {
    const cleanRar = String(rawRarity).trim();
    const lowerRar = cleanRar.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    if (lowerRar.includes('secreto') || lowerRar.includes('mitico')) return { name: 'Mítico', color: '🔴' };
    if (lowerRar.includes('legendario') || lowerRar.includes('leyenda')) return { name: 'Legendario', color: '🟡' };
    if (lowerRar.includes('epico') || lowerRar.includes('especial')) return { name: 'Épico', color: '🟣' };
    if (lowerRar.includes('raro')) return { name: 'Raro', color: '🔵' };
    if (lowerRar.includes('poco')) return { name: 'Poco Común', color: '🟢' };
    if (lowerRar.includes('comun')) return { name: 'Común', color: '⚪' };
    return { name: cleanRar, color: '⭐' };
  }

  return getRarityByValue(baseValue || 100);
}

function getBaseValue(character, chatChar) {
  return Number(chatChar?.value) || Number(character?.price) || Number(character?.value) || 0;
}

function resolveValue(baseValue, rarity) {
  const range = RARITY_RANGE[rarity.name];
  if (!range) return { value: baseValue || 100, range: null };
  if (baseValue >= range[0] && baseValue <= range[1]) return { value: baseValue, range: null };
  const mid = Math.round((range[0] + range[1]) / 2 / 10) * 10;
  return { value: mid, range };
}

function getRefererForUrl(url) {
  if (url.includes('safebooru.org')) return 'https://safebooru.org/';
  if (url.includes('danbooru.donmai.us')) return 'https://danbooru.donmai.us/';
  if (url.includes('gelbooru.com')) return 'https://gelbooru.com/';
  return '';
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

async function buscarImagenPersonaje(nombre, serie, extraNames = []) {
  const cleanName = nombre.replace(/\s*\(.*?\)\s*/g, '').trim();
  const alias = (nombre.match(/\(([^)]+)\)/) || [])[1] || '';
  const hasSeries = serie && serie !== 'Desconocido';
  const seriesClean = hasSeries ? cleanSeriesName(serie) : '';
  const seriesTag = hasSeries ? toTag(seriesClean) : '';

  const nameTags = [...new Set([toTag(cleanName), ...extraNames.map(toTag), toTag(alias)].filter(Boolean))].slice(0, 4);

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
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
              'Referer': getRefererForUrl(url)
            }
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
      const chat = db.getChat(msg.chat);
      if (chat?.adminonly || !chat?.gacha) {
        return msg.reply(`ꕥ Los comandos de *Gacha* están desactivados en este grupo.\n\nUn *administrador* puede activarlos con el comando:\n» *${usedPrefix}gacha on*`);
      }

      if (!args.length) {
        return msg.reply(`❀ Por favor, proporciona el nombre de un personaje.\n> Ejemplo » *${usedPrefix + command} Nagi Seishiro*`);
      }

      const [charactersList, allStats] = await Promise.all([
        loadCharacters(),
        loadAllStats()
      ]);

      if (!charactersList.length) {
        return msg.reply(`ꕥ No hay personajes disponibles en *lib/characters.js*.`);
      }

      const rawQuery = args.join(' ');
      const queryText = normalizeStr(rawQuery);

      const character = findCharacter(charactersList, queryText);

      if (!character) {
        const suggestions = suggestCharacters(charactersList, queryText);
        let text = `ꕥ El personaje *${rawQuery}* no se encuentra en la lista.`;
        if (suggestions.length) {
          const lines = suggestions.map(c => `» *${c.name}* — ${c.source}`).join('\n');
          text += `\n\n❀ ¿Quisiste decir alguno de estos?\n${lines}`;
        }
        text += `\n\n> Si no está, puedes sugerir el personaje o anime con *${usedPrefix}${SUGGEST_COMMAND} sugerencia: ${rawQuery}*`;
        return msg.reply(text);
      }

      const source = character.source || 'Desconocido';
      const charId = character.id;
      const charKey = chatId + '__' + charId;
      const chatChar = allStats[charKey] || {};

      const characterImage = character.image || character.img || character.avatar || character.photo || character.url;
      const hasOwnImage = characterImage && typeof characterImage === 'string' && /^https?:\/\//i.test(characterImage);
      const cacheKey = `${normalizeStr(source)}__${charId}`;
      const extraNames = [character.keyword, ...(Array.isArray(character.tags) ? character.tags.slice(0, 1) : [])].filter(Boolean);

      let mediaList = [];
      let fromCache = false;

      if (hasOwnImage) {
        mediaList = [characterImage];
      } else if (imageCache.has(cacheKey)) {
        mediaList = shuffle(imageCache.get(cacheKey));
        fromCache = true;
      } else {
        mediaList = await buscarImagenPersonaje(character.name, source, extraNames);
      }

      let dl = mediaList.length ? await descargarPrimera(mediaList) : null;

      if (!dl && fromCache) {
        imageCache.delete(cacheKey);
        mediaList = await buscarImagenPersonaje(character.name, source, extraNames);
        dl = mediaList.length ? await descargarPrimera(mediaList) : null;
      }

      if (dl && !hasOwnImage) {
        imageCache.set(cacheKey, [dl.url, ...mediaList.filter(u => u !== dl.url)].slice(0, 15));
      }

      const baseValue = getBaseValue(character, chatChar);
      const rarity = getRarity(character, chatChar, baseValue);
      const valueInfo = resolveValue(baseValue, rarity);
      const valueText = valueInfo.range
        ? `$${valueInfo.range[0].toLocaleString()} - $${valueInfo.range[1].toLocaleString()}`
        : `$${valueInfo.value.toLocaleString()}`;

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
      if (chatChar.claimedAt) {
        claimedDateLine = `\nⴵ Fecha de reclamo » *${new Date(chatChar.claimedAt).toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}*`;
      }

      const statusText = ownerId ? `Reclamado por *${ownerName}*` : '*Libre*';
      const lastVoteAgo = typeof chatChar.lastVotedAt === 'number' ? `hace *${formatElapsed(Date.now() - chatChar.lastVotedAt)}*` : '*Nunca*';

      const ranking = charactersList.map(c => {
        const stat = allStats[chatId + '__' + c.id];
        const base = getBaseValue(c, stat);
        const r = getRarity(c, stat, base);
        return { ref: c, value: resolveValue(base, r).value };
      }).sort((a, b) => b.value - a.value);

      const rankIndex = ranking.findIndex(x => x.ref === character);
      const rank = rankIndex !== -1 ? `#${rankIndex + 1}` : '—';

      const age = character.age || 'Desconocida';
      const height = character.height || 'Desconocida';
      const gender = character.gender || 'Desconocido';

      const caption = `❀ Nombre » *${character.name}*
⚥ Género » *${gender}*
🎂 Edad » *${age}*
📏 Altura » *${height}*
✰ Rareza » *${rarity.color} ${rarity.name}*
💰 Valor » *${valueText}*
♡ Estado » ${statusText}${claimedDateLine}
❖ Serie/Anime » *${source}*
❏ Puesto » *${rank}*
ⴵ Último voto » ${lastVoteAgo}`.trim();

      if (dl) {
        try {
          return await sock.sendMessage(chatId, { image: dl.buffer, caption }, { quoted: msg });
        } catch {}
      }

      await msg.reply(caption);
    } catch (e) {
      await msg.reply(`> Ocurrió un error al ejecutar el comando *${usedPrefix + command}*.\n> [Error: *${e.message}*]`);
    }
  }
};
