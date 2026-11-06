import { promises as fs } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import db from '#db';

const STATS_FILE_PATH = path.join(process.cwd(), 'lib', 'character_stats.json');
const CHARACTERS_FILE_PATH = path.join(process.cwd(), 'lib', 'characters.js');
const CHARACTERS_DIR_PATH = path.join(process.cwd(), 'lib', 'characters');

const META_TTL_MS = 20 * 1000;
const USER_COOLDOWN_MS = 60 * 60 * 1000;
const CHARACTER_COOLDOWN_MS = 60 * 60 * 1000;

const charactersCache = { signature: '', list: [], index: new Map() };
const statsCache = { mtimeMs: -1, data: {} };
let lastSignatureCheck = 0;

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

function safeText(str, fallback = '') {
  const clean = String(str ?? '')
    .normalize('NFKC')
    .replace(/[^\p{Script=Latin}\p{N}\s.,'’&!?:()+\-_]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean || fallback;
}

const NAME_ALIASES = [
  [/\bandroide\b/gi, 'android']
];

function aliasVariants(name) {
  const variants = new Set();
  for (const [pattern, replacement] of NAME_ALIASES) {
    const replaced = String(name).replace(pattern, replacement);
    if (replaced !== name) variants.add(replaced);
  }
  return [...variants];
}

function prettySeriesFromFile(file) {
  return file
    .replace(/\.js$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, m => m.toUpperCase());
}

function truncate(str, max) {
  const s = String(str ?? '');
  return s.length > max ? s.slice(0, max - 2) + '..' : s;
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
      if (!val || typeof val === 'function') continue;
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

function keyVariants(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return [];
  const norm = normalizeStr(raw);
  return [...new Set([raw, norm, norm.replace(/\s+/g, '_'), norm.replace(/\s+/g, '')].filter(Boolean))];
}

function buildIndex(list) {
  const index = new Map();
  const add = (value, c) => {
    for (const k of keyVariants(value)) {
      if (!index.has(k)) index.set(k, c);
    }
  };
  for (const c of list) {
    add(c.id, c);
    add(c.keyword, c);
  }
  for (const c of list) add(c.name, c);
  return index;
}

function lookupCharacter(index, id) {
  for (const k of keyVariants(id)) {
    const c = index.get(k);
    if (c) return c;
  }
  return null;
}

async function getCharactersSignature() {
  const files = [CHARACTERS_FILE_PATH];
  try {
    const dir = await fs.readdir(CHARACTERS_DIR_PATH);
    for (const f of dir) {
      if (f.endsWith('.js')) files.push(path.join(CHARACTERS_DIR_PATH, f));
    }
  } catch {}

  const stats = await Promise.all(files.map(f => fs.stat(f).catch(() => null)));
  let latest = 0;
  for (const s of stats) if (s) latest = Math.max(latest, s.mtimeMs);
  return `${Math.floor(latest)}-${files.length}`;
}

async function loadFileSeriesMap(signature) {
  const map = new Map();
  let files = [];
  try {
    files = (await fs.readdir(CHARACTERS_DIR_PATH)).filter(f => f.endsWith('.js'));
  } catch {
    return map;
  }

  for (const file of files) {
    const series = prettySeriesFromFile(file);
    try {
      const mod = await import(`${pathToFileURL(path.join(CHARACTERS_DIR_PATH, file)).href}?update=${signature}`);
      const raw = mod.default || mod.characters || mod.data || mod;
      for (const c of flattenCharacters(raw)) {
        for (const value of [c.id, c.keyword, c.name]) {
          for (const k of keyVariants(value)) {
            if (!map.has(k)) map.set(k, series);
          }
        }
      }
    } catch {}
  }
  return map;
}

async function fillMissingSeries(list, signature) {
  if (!list.some(c => c.source === 'Desconocido')) return;
  const fileSeries = await loadFileSeriesMap(signature);
  if (!fileSeries.size) return;
  for (const c of list) {
    if (c.source !== 'Desconocido') continue;
    for (const value of [c.id, c.keyword, c.name]) {
      const found = keyVariants(value).map(k => fileSeries.get(k)).find(Boolean);
      if (found) {
        c.source = found;
        break;
      }
    }
  }
}

async function loadCharacters() {
  const now = Date.now();
  if (charactersCache.list.length && now - lastSignatureCheck < META_TTL_MS) return charactersCache;

  try {
    const signature = await getCharactersSignature();
    lastSignatureCheck = now;
    if (charactersCache.list.length && charactersCache.signature === signature) return charactersCache;

    const module = await import(`${pathToFileURL(CHARACTERS_FILE_PATH).href}?update=${signature}`);
    const raw = module.default || module.characters || module.data || module;
    const list = flattenCharacters(raw);
    await fillMissingSeries(list, signature);
    charactersCache.signature = signature;
    charactersCache.list = list;
    charactersCache.index = buildIndex(list);
    return charactersCache;
  } catch {
    return charactersCache;
  }
}

async function loadAllStats() {
  try {
    const { mtimeMs } = await fs.stat(STATS_FILE_PATH);
    if (mtimeMs === statsCache.mtimeMs) return statsCache.data;
    const data = JSON.parse(await fs.readFile(STATS_FILE_PATH, 'utf-8'));
    statsCache.mtimeMs = mtimeMs;
    statsCache.data = data;
    return data;
  } catch {
    return statsCache.data;
  }
}

async function updateStat(key, fallback, mutate) {
  let json = {};
  try {
    const data = await fs.readFile(STATS_FILE_PATH, 'utf-8');
    json = JSON.parse(data);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  json[key] = mutate(json[key] || fallback);
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

function getCharacterRarity(character, chatChar, baseValue) {
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

function resolveValue(baseValue, rarity) {
  const range = RARITY_RANGE[rarity.name];
  if (!range) return baseValue || 100;
  if (baseValue >= range[0] && baseValue <= range[1]) return baseValue;
  return Math.round((range[0] + range[1]) / 2 / 10) * 10;
}

function randomInRange(min, max) {
  const value = Math.floor(Math.random() * (max - min + 1)) + min;
  return Math.round(value / 10) * 10;
}

function getRarityGlow(rarityName) {
  const name = rarityName.toLowerCase();

  if (name.includes('mítico') || name.includes('mitico')) return { shadow: '#800080', stroke: '#FFD700', blur: 30, width: 4 };
  if (name.includes('legendario') || name.includes('leyenda')) return { shadow: '#FFD700', stroke: '#FFD700', blur: 22, width: 3.5 };
  if (name.includes('épico') || name.includes('epico') || name.includes('especial')) return { shadow: '#800080', stroke: '#800080', blur: 16, width: 3 };
  if (name.includes('raro')) return { shadow: '#0000FF', stroke: '#0000FF', blur: 8, width: 2 };
  if (name.includes('poco')) return { shadow: '#0000FF', stroke: '#FFFFFF', blur: 4, width: 1.5 };

  return { shadow: 'transparent', stroke: '#8f8ea8', blur: 0, width: 1 };
}

function toList(value) {
  let list = value || [];
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { list = list ? [list] : []; }
  }
  if (!Array.isArray(list)) list = list ? [list] : [];
  return list;
}

function entryToRaw(entry, chatPrefix) {
  let id = entry && typeof entry === 'object' ? (entry.id || entry.keyword || entry.name) : entry;
  id = String(id ?? '').trim();
  if (id.startsWith(chatPrefix)) id = id.slice(chatPrefix.length);
  return id;
}

function makeCanonicalOf(index, chatPrefix) {
  return entry => {
    const raw = entryToRaw(entry, chatPrefix);
    if (!raw) return '';
    const source = lookupCharacter(index, raw);
    return source?.id || raw;
  };
}


function findCards(cards, input) {
  const q = normalizeStr(input);
  if (!q) return [];
  const queryWords = q.split(' ');

  const tiers = [[], [], [], []];

  for (const card of cards) {
    const cardName = String(card.name || '');
    const fullName = normalizeStr(cardName);
    const noAlias = normalizeStr(cardName.replace(/\s*\(.*?\)\s*/g, ''));
    const alias = normalizeStr((cardName.match(/\(([^)]+)\)/) || [])[1] || '');
    const exactKeys = [fullName, noAlias, alias, normalizeStr(card.id), normalizeStr(card.keyword), normalizeStr(card.rawId)].filter(Boolean);

    if (exactKeys.includes(q)) {
      tiers[0].push(card);
      continue;
    }

    if (` ${fullName} `.includes(` ${q} `)) {
      tiers[1].push(card);
      continue;
    }

    const nameWords = fullName.split(' ');
    if (queryWords.every(qw => nameWords.some(nw => nw === qw || (qw.length >= 3 && nw.startsWith(qw))))) {
      tiers[2].push(card);
      continue;
    }

    if (q.length >= 3 && fullName.includes(q)) {
      tiers[3].push(card);
    }
  }

  for (const tier of tiers) {
    if (tier.length) return tier;
  }
  return [];
}

function formatWait(ms) {
  const totalSec = Math.max(1, Math.ceil(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  let text = '';
  if (h > 0) text += `${h} hora${h !== 1 ? 's' : ''} `;
  if (m > 0) text += `${m} minuto${m !== 1 ? 's' : ''} `;
  if (s > 0 || text === '') text += `${s} segundo${s !== 1 ? 's' : ''}`;
  return text.trim();
}

function voteLimits(range) {
  const width = range[1] - range[0];
  const minStep = Math.max(10, Math.round((width * 0.02) / 10) * 10);
  const maxStep = Math.max(minStep, Math.round((width * 0.06) / 10) * 10);
  const dailyCap = Math.max(minStep * 2, Math.round((width * 0.2) / 10) * 10);
  return { minStep, maxStep, dailyCap };
}

function pickStep({ minStep, maxStep }) {
  const slots = Math.floor((maxStep - minStep) / 10) + 1;
  return minStep + 10 * Math.floor(Math.random() * slots);
}

function saveUserField(userId, key, value) {
  if (!db.data) db.data = {};
  if (!db.data.users) db.data.users = {};
  if (!db.data.users[userId]) db.data.users[userId] = {};
  db.data.users[userId][key] = value;
  if (typeof db.updateUser === 'function') db.updateUser(userId, key, value);
  else if (typeof db.setUser === 'function') db.setUser(userId, key, value);
}

export default {
  command: ['vote', 'votar'],
  category: 'gacha',
  description: 'Votar por un personaje del grupo para subir su valor.',
  run: async ({ msg, sock, args, usedPrefix, command }) => {
    try {
      if (typeof db.read === 'function') await db.read();

      const chatId = msg.chat;
      if (!db.data) db.data = {};
      if (!db.data.chats) db.data.chats = {};
      if (!db.data.chats[chatId]) db.data.chats[chatId] = {};

      const chat = (typeof db.getChat === 'function' ? db.getChat(chatId) : db.data.chats[chatId]) || {};
      if (chat.adminonly || !chat.gacha) {
        return msg.reply(`ꕥ Los comandos de *Gacha* están desactivados en este grupo.\n\nUn *administrador* puede activarlos con el comando:\n» *${usedPrefix}gacha on*`);
      }

      const nameArg = args.join(' ').trim();
      if (!nameArg) {
        return msg.reply(`❀ Debes especificar un personaje para votarlo.\n> Ejemplo » *${usedPrefix + command} Anby*`);
      }

      if (typeof db.setCreate === 'function') db.setCreate('users', msg.sender, 'lastVote', 0);
      const user = (typeof db.getUser === 'function' ? db.getUser(msg.sender) : db.data.users?.[msg.sender]) || {};

      const now = Date.now();
      const lastVote = Number(user.lastVote) || 0;

      if (lastVote > 0 && now < lastVote) {
        return msg.reply(`ꕥ Debes esperar *${formatWait(lastVote - now)}* para usar *${command}* de nuevo.`);
      }

      const { list, index } = await loadCharacters();
      const allStats = await loadAllStats();

      const chatPrefix = chatId + '__';
      const canonicalOf = makeCanonicalOf(index, chatPrefix);

      const entries = [];
      const seen = new Set();
      for (const [key, stat] of Object.entries(allStats)) {
        if (!key.startsWith(chatPrefix) || !stat || typeof stat !== 'object') continue;
        const rawId = key.slice(chatPrefix.length);
        if (!rawId) continue;

        const character = lookupCharacter(index, rawId) || lookupCharacter(index, stat.name);
        const id = character?.id || canonicalOf(rawId) || rawId;
        if (seen.has(id)) continue;
        seen.add(id);

        entries.push({
          id,
          rawId,
          statKey: key,
          keyword: character?.keyword || '',
          name: stat.name || character?.name || rawId,
          character
        });
      }

      const matches = findCards(entries, nameArg);

      if (matches.length === 0) {
        const catalogMatches = findCards(
          list.map(c => ({ name: c.name, id: c.id, keyword: c.keyword || '', rawId: c.id })),
          nameArg
        );
        if (catalogMatches.length > 0) {
          const first = catalogMatches[0];
          return msg.reply(`ꕥ *${first.name}* todavía no ha salido en este grupo.\n> Solo puedes votar por personajes que hayan salido en el *${usedPrefix}rw* o que ya hayan sido reclamados aquí.`);
        }
        return msg.reply(`ꕥ Personaje no encontrado. Asegúrate de que el nombre esté correcto.`);
      }

      if (matches.length > 1) {
        const lines = matches.slice(0, 8).map(c => `» *${c.name}*`).join('\n');
        const extra = matches.length > 8 ? `\n… y *${matches.length - 8}* más.` : '';
        return msg.reply(`ꕥ Hay varios personajes que coinciden con *${nameArg}*:\n\n${lines}${extra}\n\n> Escribe el nombre completo, por ejemplo: *${usedPrefix + command} ${matches[0].name.replace(/\s*\(.*?\)\s*/g, ' ').trim()}*`);
      }

      const entry = matches[0];
      const character = entry.character;
      const today = new Date(now).toISOString().slice(0, 10);

      let outcome = null;

      await updateStat(
        entry.statKey,
        { name: entry.name, value: Number(character?.value) || 100, votes: 0 },
        stat => {
          const baseValue = Number(stat.value) || Number(character?.price) || Number(character?.value) || 0;
          const rarity = getCharacterRarity(character, stat, baseValue);
          const range = RARITY_RANGE[rarity.name] || [100, 10000];
          const current = Math.min(Math.max(resolveValue(baseValue, rarity), range[0]), range[1]);
          const limits = voteLimits(range);
          const charName = stat.name || entry.name;

          const lastVotedAt = Number(stat.lastVotedAt) || 0;
          if (lastVotedAt > 0 && now < lastVotedAt + CHARACTER_COOLDOWN_MS) {
            outcome = { blocked: 'character', name: charName, wait: lastVotedAt + CHARACTER_COOLDOWN_MS - now };
            return stat;
          }

          const daily = stat.dailyIncrement && typeof stat.dailyIncrement === 'object' ? stat.dailyIncrement : {};
          const todayInc = Number(daily[today]) || 0;

          if (todayInc >= limits.dailyCap) {
            outcome = { blocked: 'daily', name: charName, cap: limits.dailyCap };
            return stat;
          }

          if (current >= range[1]) {
            outcome = { blocked: 'max', name: charName, max: range[1] };
            return stat;
          }

          const inc = Math.min(pickStep(limits), limits.dailyCap - todayInc, range[1] - current);
          const newValue = current + inc;
          const votes = (Number(stat.votes) || 0) + 1;

          outcome = { ok: true, name: charName, inc, newValue, votes, todayInc: todayInc + inc, cap: limits.dailyCap };

          return {
            ...stat,
            name: charName,
            value: newValue,
            votes,
            lastVotedAt: now,
            dailyIncrement: { [today]: todayInc + inc }
          };
        }
      );

      if (!outcome) {
        return msg.reply(`ꕥ No se pudo registrar el voto, intenta de nuevo.`);
      }

      if (outcome.blocked === 'character') {
        return msg.reply(`ꕥ *${outcome.name}* ha sido votada recientemente.\n> Debes esperar *${formatWait(outcome.wait)}* para votarla de nuevo.`);
      }

      if (outcome.blocked === 'daily') {
        return msg.reply(`ꕥ *${outcome.name}* ya alcanzó el límite de votos de hoy (+¥${outcome.cap.toLocaleString()}).\n> Vuelve a intentarlo mañana.`);
      }

      if (outcome.blocked === 'max') {
        return msg.reply(`ꕥ *${outcome.name}* ya tiene el valor máximo de su rareza (¥${outcome.max.toLocaleString()}).`);
      }

      saveUserField(msg.sender, 'lastVote', now + USER_COOLDOWN_MS);
      if (typeof db.write === 'function') await db.write();

      const series = character?.source || 'Desconocido';
      const replyText = `❀ Votaste por *${outcome.name}* (*${series}*)\n> Su nuevo valor es *¥${outcome.newValue.toLocaleString()}* (+${outcome.inc.toLocaleString()})\n> Votos totales: *${outcome.votes.toLocaleString()}* • Hoy: *+${outcome.todayInc.toLocaleString()}* de *+${outcome.cap.toLocaleString()}*`;

      const imageCandidate = character?.image || character?.img || character?.avatar || character?.photo || (Array.isArray(character?.images) && character.images.length ? character.images[0] : null);
      const imageUrl = typeof imageCandidate === 'string' && /^https?:\/\//i.test(imageCandidate) ? imageCandidate : null;

      if (imageUrl) {
        try {
          await sock.sendMessage(chatId, { image: { url: imageUrl }, caption: replyText }, { quoted: msg });
          return;
        } catch {}
      }

      await sock.sendMessage(chatId, { text: replyText }, { quoted: msg });
    } catch (e) {
      await msg.reply(`> Ha ocurrido un error inesperado al ejecutar *${usedPrefix + command}*.\n> [Error: *${e.message}*]`);
    }
  }
};
