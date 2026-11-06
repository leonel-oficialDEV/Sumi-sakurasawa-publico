import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pathToFileURL } from 'url';
import axios from 'axios';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import db from '#db';

const STATS_FILE_PATH = path.join(process.cwd(), 'lib', 'character_stats.json');
const CHARACTERS_FILE_PATH = path.join(process.cwd(), 'lib', 'characters.js');
const CHARACTERS_DIR_PATH = path.join(process.cwd(), 'lib', 'characters');
const IMG_CACHE_DIR = path.join(process.cwd(), 'tmp', 'harem_cache');

const EVO_KEY = process.env.EVO_API_KEY || 'Apex-Predator2010';
const GELBOORU_USER_ID = process.env.GELBOORU_USER_ID || '';
const GELBOORU_API_KEY = process.env.GELBOORU_API_KEY || '';

const THUMB_SIZE = 280;
const RENDER_BUDGET_MS = 7000;
const HTTP_CONCURRENCY = 8;
const MEM_THUMBS_MAX = 400;
const MISS_TTL_MS = 10 * 60 * 1000;
const META_TTL_MS = 20 * 1000;
const RENDER_CACHE_MAX = 40;
const RENDER_CACHE_TTL_MS = 5 * 60 * 1000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
const ANILIST_URL = 'https://graphql.anilist.co';
const USE_EVO_FALLBACK = process.env.HAREM_EVO_FALLBACK !== 'off';

const SALE_DURATION_MS = 3 * 864e5;
const ITEMS_PER_PAGE = 10;
const CAPTION_LIMIT = 1000;

const charactersCache = { signature: '', list: [], index: new Map() };
const statsCache = { mtimeMs: -1, data: {} };
let lastSignatureCheck = 0;
let anilistBlockedUntil = 0;

const memThumbs = new Map();
const inflight = new Map();
const missCache = new Map();
const renderCache = new Map();

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

const RARITY_WEIGHT = {
  'Común': 50,
  'Poco Común': 30,
  'Raro': 15,
  'Épico': 7,
  'Legendario': 2,
  'Mítico': 0.5
};

const RARITY_COLORS = {
  'Común': '#d1d5db',
  'Poco Común': '#22c55e',
  'Raro': '#3b82f6',
  'Épico': '#a855f7',
  'Legendario': '#facc15',
  'Mítico': '#ef4444'
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

const http = axios.create({ headers: { 'User-Agent': USER_AGENT } });

function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
      active--;
      next();
    });
  };
  return fn => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}

const limitHttp = createLimiter(HTTP_CONCURRENCY);

async function getJson(url, timeout = 4000) {
  const { data } = await limitHttp(() => http.get(url, { timeout }));
  return data;
}

function firstNonEmpty(promises) {
  return new Promise(resolve => {
    let pending = promises.length;
    if (!pending) return resolve([]);
    for (const p of promises) {
      p.then(r => { if (r?.length) resolve(r); }, () => {})
        .finally(() => { if (--pending === 0) resolve([]); });
    }
  });
}

function withDeadline(promise, ms) {
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const ANILIST_QUERY = 'query ($search: String) { Page(page: 1, perPage: 10) { characters(search: $search) { name { full native alternative } image { large } media(perPage: 15) { nodes { title { romaji english native } synonyms } } } } }';

const foldToken = t => t.replace(/ou|oo/g, 'o').replace(/uu/g, 'u').replace(/(.)\1/g, '$1');
const nameTokens = s => normalizeStr(s).split(' ').filter(t => t.length >= 3).map(foldToken);

function mediaMatchesSeries(nodes, seriesNorm) {
  for (const node of nodes || []) {
    const titles = [node?.title?.romaji, node?.title?.english, node?.title?.native, ...(node?.synonyms || [])];
    for (const title of titles) {
      const t = normalizeStr(title);
      if (!t) continue;
      if (t === seriesNorm) return true;
      if (t.length < 5 || seriesNorm.length < 4) continue;
      if (t.includes(seriesNorm) || seriesNorm.includes(t)) return true;
    }
  }
  return false;
}

function pickAnilistImage(characters, targetNames, series) {
  const seriesNorm = normalizeStr(cleanSeriesName(series));
  const targets = targetNames.map(nameTokens).filter(tokens => tokens.length);
  if (!seriesNorm || !targets.length) return null;

  let best = null;
  let bestScore = 0;
  for (const ch of characters || []) {
    const image = ch?.image?.large;
    if (typeof image !== 'string' || !/^https?:\/\//i.test(image) || /\/default\./i.test(image)) continue;
    if (!mediaMatchesSeries(ch?.media?.nodes, seriesNorm)) continue;

    const candidate = new Set(
      [ch?.name?.full, ch?.name?.native, ...(ch?.name?.alternative || [])]
        .filter(Boolean)
        .flatMap(n => nameTokens(n))
    );
    let score = 0;
    for (const tokens of targets) {
      score = Math.max(score, tokens.filter(t => candidate.has(t)).length / tokens.length);
    }
    if (score > bestScore) {
      best = image;
      bestScore = score;
    }
  }
  return best;
}

async function fetchAnilist(search) {
  try {
    const { data } = await limitHttp(() => http.post(
      ANILIST_URL,
      { query: ANILIST_QUERY, variables: { search } },
      { timeout: 5000, headers: { 'Content-Type': 'application/json', Accept: 'application/json' } }
    ));
    return { characters: data?.data?.Page?.characters || [], failed: false };
  } catch (e) {
    if (e?.response?.status === 429) {
      const wait = Number(e.response.headers?.['retry-after']) || 60;
      anilistBlockedUntil = Date.now() + wait * 1000;
    }
    return { characters: [], failed: true };
  }
}

async function searchAnilist(nombre, serie, extraNames = []) {
  const hasSeries = serie && serie !== 'Desconocido';
  if (!hasSeries) return { urls: [], unavailable: false };
  if (Date.now() < anilistBlockedUntil) return { urls: [], unavailable: true };

  const cleanName = nombre.replace(/\s*\(.*?\)\s*/g, '').trim();
  const alias = (nombre.match(/\(([^)]+)\)/) || [])[1] || '';
  const keywords = extraNames.map(k => String(k).replace(/[_-]+/g, ' ').trim());
  const names = [...new Set([cleanName, ...aliasVariants(cleanName), alias, ...keywords].filter(Boolean))];

  let unavailable = false;
  for (const search of names.slice(0, 2)) {
    const { characters, failed } = await fetchAnilist(search);
    if (failed) {
      unavailable = true;
      break;
    }
    const url = pickAnilistImage(characters, names, serie);
    if (url) return { urls: [url], unavailable: false };
  }
  return { urls: [], unavailable };
}

async function fetchSafebooru(tags) {
  const q = encodeURIComponent(tags);
  const data = await getJson(`https://safebooru.org/index.php?page=dapi&s=post&q=index&json=1&limit=20&tags=${q}`);
  if (!Array.isArray(data)) return [];
  return data
    .filter(p => p.directory && p.image && IMG_EXT.test(p.image))
    .map(p => `https://safebooru.org/images/${p.directory}/${p.image}`);
}

async function fetchGelbooru(tags) {
  if (!GELBOORU_USER_ID || !GELBOORU_API_KEY) return [];
  const q = encodeURIComponent(tags);
  const auth = `&user_id=${encodeURIComponent(GELBOORU_USER_ID)}&api_key=${encodeURIComponent(GELBOORU_API_KEY)}`;
  const data = await getJson(`https://gelbooru.com/index.php?page=dapi&s=post&q=index&json=1&limit=20&tags=${q}${auth}`);
  return (data?.post || [])
    .map(p => p.file_url)
    .filter(u => typeof u === 'string' && IMG_EXT.test(u));
}

async function searchBooru(nameTags, seriesTag) {
  const bases = [];
  for (const nameTag of nameTags) {
    if (seriesTag) {
      bases.push(`${nameTag}_(${seriesTag})`);
      const compact = seriesTag.replace(/_/g, '');
      if (compact !== seriesTag) bases.push(`${nameTag}_(${compact})`);
    } else {
      bases.push(nameTag);
    }
  }

  const withSeries = seriesTag ? nameTags.map(n => `${n} ${seriesTag}`) : [];

  const tagSets = [...new Set([
    ...bases.map(b => `${b} solo rating:general`),
    ...withSeries.map(t => `${t} solo rating:general`),
    ...bases.map(b => `${b} rating:general`),
    ...withSeries.map(t => `${t} rating:general`)
  ])].slice(0, 12);

  for (let i = 0; i < tagSets.length; i += 3) {
    const wave = tagSets
      .slice(i, i + 3)
      .flatMap(tags => [fetchSafebooru(tags), fetchGelbooru(tags)]);
    const found = await firstNonEmpty(wave);
    if (found.length) return found;
  }
  return [];
}

function parseImageEntries(data) {
  const items = data?.data || data?.result || data?.results || data;
  if (!Array.isArray(items)) return [];
  return items
    .map(i => {
      if (typeof i === 'string') return { url: i, text: '' };
      const url = i?.hd || i?.image_url || i?.url || i?.image || i?.link;
      const text = [i?.title, i?.description, i?.caption, i?.alt, i?.name, i?.snippet]
        .filter(t => typeof t === 'string')
        .join(' ');
      return { url, text };
    })
    .filter(e => typeof e.url === 'string' && /^https?:\/\//i.test(e.url) && !JUNK_DOMAINS.test(e.url));
}

function rankEntries(entries, name, series) {
  const nameTokenList = nameTokens(name);
  const seriesTokenList = nameTokens(cleanSeriesName(series || ''));

  const scored = entries.map((entry, order) => {
    const textTokens = new Set(nameTokens(entry.text));
    let score = 0;
    if (textTokens.size) {
      if (seriesTokenList.some(t => textTokens.has(t))) score += 2;
      if (nameTokenList.some(t => textTokens.has(t))) score += 1;
    }
    return { entry, score, order };
  });

  scored.sort((a, b) => b.score - a.score || a.order - b.order);

  const seen = new Set();
  const urls = [];
  for (const { entry } of scored) {
    if (seen.has(entry.url)) continue;
    seen.add(entry.url);
    urls.push(entry.url);
  }
  return urls;
}

async function searchEvo(name, series) {
  const queries = [...new Set([
    series ? `${name} ${series}` : '',
    `${name} ${series || 'anime'} anime character`
  ].map(q => q.trim()).filter(Boolean))];

  const requests = [];
  for (const query of queries) {
    const q = encodeURIComponent(query);
    const endpoints = [
      `https://api.evogb.org/search/pinterest?query=${q}&apikey=${EVO_KEY}`,
      `https://api.evogb.org/search/googleimage?query=${q}&apikey=${EVO_KEY}`
    ];
    for (const ep of endpoints) {
      requests.push(getJson(ep, 4500).then(parseImageEntries).catch(() => []));
    }
  }

  const results = await Promise.all(requests);
  return rankEntries(results.flat(), name, series).slice(0, 12);
}

async function buscarImagenPersonaje(nombre, serie, extraNames = [], allowEvo = true) {
  const cleanName = nombre.replace(/\s*\(.*?\)\s*/g, '').trim();
  const alias = (nombre.match(/\(([^)]+)\)/) || [])[1] || '';
  const hasSeries = serie && serie !== 'Desconocido';
  const seriesClean = hasSeries ? cleanSeriesName(serie) : '';
  const seriesTag = hasSeries ? toTag(seriesClean) : '';

  const words = cleanName.split(/\s+/).filter(Boolean);
  const reversed = words.length === 2 ? [words[1], words[0]].join(' ') : '';

  const nameTags = [...new Set([
    toTag(cleanName),
    ...aliasVariants(cleanName).map(toTag),
    toTag(reversed),
    ...extraNames.map(toTag),
    toTag(alias)
  ].filter(Boolean))].slice(0, 6);

  const booru = await searchBooru(nameTags, seriesTag);
  if (booru.length) return booru;

  if (!USE_EVO_FALLBACK || !allowEvo) return [];
  return await searchEvo(cleanName, seriesClean);
}

function getRefererForUrl(url) {
  if (url.includes('safebooru.org')) return 'https://safebooru.org/';
  if (url.includes('danbooru.donmai.us')) return 'https://danbooru.donmai.us/';
  if (url.includes('gelbooru.com')) return 'https://gelbooru.com/';
  return '';
}

function hashKey(key) {
  return crypto.createHash('sha1').update(key).digest('hex');
}

function thumbKey(item) {
  return `v3__${normalizeStr(item.series)}__${item.id}__${item.imageUrl || ''}`;
}

const thumbPath = key => path.join(IMG_CACHE_DIR, `${hashKey(key)}.jpg`);

let cacheDirReady = null;
function ensureCacheDir() {
  if (!cacheDirReady) cacheDirReady = fs.mkdir(IMG_CACHE_DIR, { recursive: true }).catch(() => {});
  return cacheDirReady;
}

function rememberThumb(key, buf) {
  memThumbs.delete(key);
  memThumbs.set(key, buf);
  if (memThumbs.size > MEM_THUMBS_MAX) memThumbs.delete(memThumbs.keys().next().value);
}

async function readCachedThumb(key) {
  const mem = memThumbs.get(key);
  if (mem) {
    rememberThumb(key, mem);
    return mem;
  }
  try {
    const buf = await fs.readFile(thumbPath(key));
    if (buf.length > 500) {
      rememberThumb(key, buf);
      return buf;
    }
  } catch {}
  return null;
}

async function persistThumb(key, buf) {
  try {
    await ensureCacheDir();
    const file = thumbPath(key);
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, file);
  } catch {}
}

function forgetThumb(key) {
  memThumbs.delete(key);
  fs.unlink(thumbPath(key)).catch(() => {});
}

async function makeThumbBuffer(img) {
  const size = THUMB_SIZE;
  const c = createCanvas(size, size);
  const g = c.getContext('2d');
  const scale = Math.max(size / img.width, size / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  g.drawImage(img, (size - w) / 2, (size - h) * 0.15, w, h);
  return c.encode('jpeg', 82);
}

async function downloadThumb(url, signal) {
  const headers = {};
  const referer = getRefererForUrl(url);
  if (referer) headers.Referer = referer;

  const res = await limitHttp(() => http.get(url, {
    responseType: 'arraybuffer',
    timeout: 6000,
    maxContentLength: 6 * 1024 * 1024,
    headers,
    signal
  }));

  if (!res.data || res.data.byteLength < 1000) throw new Error('imagen inválida');
  const img = await loadImage(Buffer.from(res.data));
  return makeThumbBuffer(img);
}

async function firstThumb(urls) {
  const ctrl = new AbortController();
  try {
    return await Promise.any(urls.map(u => downloadThumb(u, ctrl.signal)));
  } catch {
    return null;
  } finally {
    ctrl.abort();
  }
}

async function fetchThumb(item) {
  const tried = new Set();

  const tryUrls = async urls => {
    const fresh = urls.filter(u => !tried.has(u)).slice(0, 9);
    for (let i = 0; i < fresh.length; i += 3) {
      const wave = fresh.slice(i, i + 3);
      wave.forEach(u => tried.add(u));
      const buf = await firstThumb(wave);
      if (buf) return buf;
    }
    return null;
  };

  if (item.imageUrl) {
    const buf = await tryUrls([item.imageUrl]);
    if (buf) return buf;
  }

  const extraNames = item.keyword ? [item.keyword] : [];

  const anilist = await searchAnilist(item.name, item.series, extraNames);
  if (anilist.urls.length) {
    const buf = await tryUrls(anilist.urls);
    if (buf) return buf;
  }

  const urls = await buscarImagenPersonaje(item.name, item.series, extraNames, !anilist.unavailable);
  return tryUrls(urls);
}

function getThumb(item) {
  const key = thumbKey(item);
  const existing = inflight.get(key);
  if (existing) return existing;

  const task = (async () => {
    try {
      const cached = await readCachedThumb(key);
      if (cached) return cached;

      const missAt = missCache.get(key);
      if (missAt && Date.now() - missAt < MISS_TTL_MS) return null;

      const buf = await fetchThumb(item);
      if (buf) {
        missCache.delete(key);
        rememberThumb(key, buf);
        persistThumb(key, buf);
        return buf;
      }
      missCache.set(key, Date.now());
      return null;
    } catch {
      return null;
    }
  })().finally(() => inflight.delete(key));

  inflight.set(key, task);
  return task;
}

async function loadThumbs(items) {
  const bufs = await Promise.all(items.map(item => withDeadline(getThumb(item), RENDER_BUDGET_MS)));
  return Promise.all(bufs.map(async (buf, i) => {
    if (!buf) return null;
    try {
      return await loadImage(buf);
    } catch {
      forgetThumb(thumbKey(items[i]));
      return null;
    }
  }));
}

function getRender(key) {
  const entry = renderCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.t > RENDER_CACHE_TTL_MS) {
    renderCache.delete(key);
    return null;
  }
  return entry.buffer;
}

function setRender(key, buffer) {
  renderCache.set(key, { t: Date.now(), buffer });
  if (renderCache.size > RENDER_CACHE_MAX) renderCache.delete(renderCache.keys().next().value);
}

function ensureDbContainers(chatId) {
  if (!db.data) db.data = {};
  if (!db.data.chats) db.data.chats = {};
  if (!db.data.chats[chatId]) db.data.chats[chatId] = {};
  if (!db.data.chat_users) db.data.chat_users = {};
  if (!db.data.chat_users[chatId]) db.data.chat_users[chatId] = {};
  if (!db.data.users) db.data.users = {};
}

function saveChatUserField(chatId, userId, key, value) {
  if (!db.data.chat_users[chatId][userId]) db.data.chat_users[chatId][userId] = {};
  db.data.chat_users[chatId][userId][key] = value;
  if (typeof db.updateChatUser === 'function') db.updateChatUser(chatId, userId, key, value);
  else if (typeof db.setCreate === 'function') db.setCreate('chat_users', [chatId, userId], key, value);
}

function saveChatField(chatId, key, value) {
  db.data.chats[chatId][key] = value;
  if (typeof db.updateChat === 'function') db.updateChat(chatId, key, value);
}

function getChatUserSafe(chatId, userId) {
  return (db.getChatUser ? db.getChatUser(chatId, userId) : db.data.chat_users?.[chatId]?.[userId]) || {};
}

function getUserSafe(userId) {
  return (db.getUser ? db.getUser(userId) : db.data.users?.[userId]) || {};
}

function getShopListings(chat) {
  const sales = Object.entries(chat.sales || {})
    .filter(([, sale]) => sale)
    .sort((a, b) => (a[1].time || 0) - (b[1].time || 0))
    .map(([key, item]) => ({ kind: 'sale', key, item }));
  const npcs = (chat.npcs || [])
    .filter(Boolean)
    .map(item => ({ kind: 'npc', key: item.id, item }));
  return [...sales, ...npcs];
}

function buildOwnedMap({ chatId, allStats, index }) {
  const chatPrefix = chatId + '__';
  const canonicalOf = makeCanonicalOf(index, chatPrefix);
  const map = new Map();

  const chatUsers = db.data?.chat_users?.[chatId] || {};
  for (const [uId, uData] of Object.entries(chatUsers)) {
    for (const entry of toList(uData?.characters)) {
      const id = canonicalOf(entry);
      if (id && !map.has(id)) map.set(id, uId);
    }
  }

  for (const [key, stat] of Object.entries(allStats)) {
    if (!key.startsWith(chatPrefix)) continue;
    const owner = stat?.owner || stat?.claimedBy || stat?.user || stat?.claimed;
    if (!owner) continue;
    const id = canonicalOf(key.slice(chatPrefix.length));
    if (id && !map.has(id)) map.set(id, owner);
  }

  return map;
}

async function returnSaleToSeller({ sale, chatId, index }) {
  if (!sale?.user) return;
  const chatPrefix = chatId + '__';
  const canonicalOf = makeCanonicalOf(index, chatPrefix);
  const statKey = chatPrefix + (sale.statId || sale.id);

  let restored = true;
  await updateStat(
    statKey,
    { name: sale.name, value: sale.value || 100, votes: 0 },
    stat => {
      const other = stat.owner || stat.claimedBy || stat.user || stat.claimed;
      if (other && other !== sale.user) {
        restored = false;
        return stat;
      }
      return { ...stat, user: sale.user, owner: sale.user, claimedBy: sale.user };
    }
  );

  if (!restored) return;

  const seller = getChatUserSafe(chatId, sale.user);
  const characters = toList(seller.characters);
  const saleCanonical = canonicalOf(sale.id);
  if (!characters.some(entry => canonicalOf(entry) === saleCanonical)) {
    saveChatUserField(chatId, sale.user, 'characters', [...characters, sale.id]);
  }
}

async function processExpired({ chat, chatId, now, index }) {
  let changed = false;

  if (!chat.sales || typeof chat.sales !== 'object') chat.sales = {};
  if (!Array.isArray(chat.npcs)) chat.npcs = [];

  for (const [key, sale] of Object.entries(chat.sales)) {
    if (sale && now - (sale.time || 0) < SALE_DURATION_MS) continue;
    delete chat.sales[key];
    changed = true;
    if (sale) await returnSaleToSeller({ sale, chatId, index });
  }

  const before = chat.npcs.length;
  chat.npcs = chat.npcs.filter(npc => npc && npc.expiresAt && now < npc.expiresAt);
  if (chat.npcs.length !== before) changed = true;

  return changed;
}

async function persistShop(chatId, chat) {
  saveChatField(chatId, 'sales', chat.sales);
  saveChatField(chatId, 'npcs', chat.npcs);
  if (typeof db.write === 'function') await db.write();
}

function buildWeightedPool(characters) {
  const pool = characters.map(c => {
    const rarity = getCharacterRarity(c, null, Number(c.value) || 0);
    return { character: c, weight: RARITY_WEIGHT[rarity.name] ?? 10, rarity };
  });
  const total = pool.reduce((sum, item) => sum + item.weight, 0);
  return { pool, total };
}

function pickWeighted({ pool, total }) {
  if (!pool.length) return null;
  let r = Math.random() * total;
  for (const item of pool) {
    if (r < item.weight) return item;
    r -= item.weight;
  }
  return pool[0];
}

function formatRemaining(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return '<1m';
}

function formatPrice(item) {
  return item.priceValid ? `¥${item.price.toLocaleString()}` : 'N/D';
}

function buildShopItem({ listing, number, index, allStats, chatPrefix, canonicalOf, now }) {
  const venta = listing.item;
  const isNpc = listing.kind === 'npc';
  const rawId = venta.charId || venta.id || '';

  const character = lookupCharacter(index, rawId) || lookupCharacter(index, venta.name);
  const stat = allStats[chatPrefix + (venta.statId || venta.charId || venta.id || '')] || allStats[chatPrefix + (character?.id || '')] || null;
  const baseVal = Number(stat?.value) || Number(venta.value) || Number(character?.price) || Number(character?.value) || 0;
  const rarity = getCharacterRarity(character, stat, baseVal);
  const value = resolveValue(baseVal, rarity);

  let seller = 'Mercader';
  if (!isNpc) {
    seller = getUserSafe(venta.user).name?.trim() || String(venta.user || 'Desconocido').split('@')[0];
  }

  const remaining = isNpc
    ? (venta.expiresAt || now) - now
    : SALE_DURATION_MS - (now - (venta.time || now));

  const price = Number(venta.price);
  const imageCandidate = character?.image || character?.img || character?.avatar || character?.photo || (Array.isArray(character?.images) && character.images.length ? character.images[0] : null);

  return {
    number,
    name: venta.name || character?.name || 'Personaje',
    price,
    priceValid: Number.isFinite(price) && price > 0,
    value,
    rarity,
    isNpc,
    seller,
    timeText: formatRemaining(remaining),
    id: character?.id || canonicalOf(rawId) || String(rawId),
    keyword: character?.keyword || '',
    series: character?.source || 'Desconocido',
    imageUrl: typeof imageCandidate === 'string' && /^https?:\/\//i.test(imageCandidate) ? imageCandidate : null
  };
}

function drawRoundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

async function generateShopImage({ total, players, npcs, page, totalPages, items, usedPrefix }) {
  const width = 1000;
  const height = 700;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  const bgGradient = ctx.createLinearGradient(0, 0, 0, height);
  bgGradient.addColorStop(0, '#0f0e1e');
  bgGradient.addColorStop(1, '#1b1834');
  ctx.fillStyle = bgGradient;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 32px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('HAREMSHOP', 40, 55);

  ctx.fillStyle = '#222040';
  drawRoundedRect(ctx, 840, 25, 120, 38, 19);
  ctx.fill();
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 16px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`Pág ${page} / ${totalPages}`, 900, 50);
  ctx.textAlign = 'left';

  ctx.fillStyle = '#17152d';
  drawRoundedRect(ctx, 40, 80, 920, 70, 12);
  ctx.fill();

  ctx.fillStyle = '#8f8ea8';
  ctx.font = 'bold 13px sans-serif';
  ctx.fillText('EN VENTA', 65, 105);
  ctx.fillText('JUGADORES', 220, 105);
  ctx.fillText('MERCADER (NPC)', 375, 105);

  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 24px sans-serif';
  ctx.fillText(`${total}`, 65, 135);
  ctx.fillText(`${players}`, 220, 135);
  ctx.fillText(`${npcs}`, 375, 135);

  const columns = 5;
  const cardW = 160;
  const cardH = 235;
  const startX = 40;
  const startY = 170;
  const gapX = 30;
  const gapY = 18;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const col = i % columns;
    const row = Math.floor(i / columns);
    const x = startX + col * (cardW + gapX);
    const y = startY + row * (cardH + gapY);

    ctx.fillStyle = '#1f1d3a';
    drawRoundedRect(ctx, x, y, cardW, cardH, 12);
    ctx.fill();

    const imgX = x + 10;
    const imgY = y + 10;
    const imgSize = 140;

    ctx.save();
    drawRoundedRect(ctx, imgX, imgY, imgSize, imgSize, 8);
    ctx.clip();
    if (item.img) {
      const scale = Math.max(imgSize / item.img.width, imgSize / item.img.height);
      const drawW = item.img.width * scale;
      const drawH = item.img.height * scale;
      ctx.drawImage(item.img, imgX + (imgSize - drawW) / 2, imgY + (imgSize - drawH) / 2, drawW, drawH);
    } else {
      ctx.fillStyle = '#322f54';
      ctx.fillRect(imgX, imgY, imgSize, imgSize);
      ctx.fillStyle = '#8f8ea8';
      ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(item.pending ? 'Cargando...' : 'Sin imagen', imgX + imgSize / 2, imgY + imgSize / 2);
      ctx.textAlign = 'left';
    }
    ctx.restore();

    ctx.save();
    const glow = getRarityGlow(item.rarity.name);
    ctx.shadowColor = glow.shadow;
    ctx.shadowBlur = glow.blur;
    ctx.strokeStyle = glow.stroke;
    ctx.lineWidth = glow.width;
    drawRoundedRect(ctx, imgX, imgY, imgSize, imgSize, 8);
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = 'rgba(0,0,0,0.67)';
    drawRoundedRect(ctx, imgX + 6, imgY + 6, 28, 22, 6);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${item.number}`, imgX + 20, imgY + 21);
    ctx.textAlign = 'left';

    if (item.isNpc) {
      ctx.fillStyle = 'rgba(0,0,0,0.67)';
      drawRoundedRect(ctx, imgX + imgSize - 40, imgY + 6, 34, 22, 6);
      ctx.fill();
      ctx.fillStyle = '#7dd3fc';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('NPC', imgX + imgSize - 23, imgY + 21);
      ctx.textAlign = 'left';
    }

    const shortName = safeText(item.name.replace(/\s*\(.*?\)\s*/g, ' '), 'Personaje');
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText(truncate(shortName, 15), x + 10, y + 168);

    ctx.fillStyle = RARITY_COLORS[item.rarity.name] || '#f59e0b';
    ctx.beginPath();
    ctx.arc(x + 15, y + 184, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#a6a4ce';
    ctx.font = 'bold 12px sans-serif';
    ctx.fillText(`Valor $${item.value.toLocaleString()}`, x + 26, y + 188);

    ctx.fillStyle = '#ffd700';
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText(formatPrice(item), x + 10, y + 210);

    const sellerLine = `${truncate(safeText(item.seller, 'Jugador'), 11)} · ${item.timeText}`;
    ctx.fillStyle = '#8f8ea8';
    ctx.font = '11px sans-serif';
    ctx.fillText(truncate(sellerLine, 24), x + 10, y + 227);
  }

  ctx.fillStyle = '#535075';
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`Compra con "${usedPrefix}buyc <número>" usando el número de cada carta.`, width / 2, height - 15);

  return canvas.encode('jpeg', 90);
}

function buildCaption({ total, page, totalPages, items, usedPrefix, command, anyPending }) {
  const header = `*☆ HaremShop \`≧◠ᴥ◠≦\`*\n❏ Personajes en venta <${total}> • Página *${page}* de *${totalPages}*\n\n`;

  const footerParts = [`> Compra con *${usedPrefix}buyc <número o nombre>*`];
  if (page < totalPages) footerParts.push(`> Siguiente página: *${usedPrefix}${command} ${page + 1}*`);
  if (anyPending) footerParts.push('> ⏳ Algunas imágenes se siguen descargando, usa el comando de nuevo en unos segundos.');
  const footer = '\n\n' + footerParts.join('\n');

  const build = (withSeller, nameMax) => items
    .map(it => `*${it.number}.* ${truncate(it.name, nameMax)} ${it.rarity.color} ${formatPrice(it)}${withSeller ? ` • ${truncate(it.seller, 14)}` : ''}`)
    .join('\n');

  let body = build(true, 40);
  if ((header + body + footer).length > CAPTION_LIMIT) body = build(false, 40);
  if ((header + body + footer).length > CAPTION_LIMIT) body = build(false, 22);
  return header + body + footer;
}

export default {
  command: ['wshop', 'haremshop', 'tiendawaifus'],
  category: 'gacha',
  description: 'Ver los personajes en venta en el mercado.',
  run: async ({ msg, sock, args, usedPrefix, command }) => {
    try {
      if (typeof db.read === 'function') await db.read();
      const chatId = msg.chat;

      ensureDbContainers(chatId);
      const chat = db.getChat(msg.chat);
      if (chat?.adminonly || !chat?.gacha) {
        return msg.reply(`ꕥ Los comandos de *Gacha* están desactivados en este grupo.\n\nUn *administrador* puede activarlos con el comando:\n» *${usedPrefix}gacha on*`);
      }

      if (args.length && !/^\d+$/.test(args[0])) {
        return msg.reply(`ꕥ Debes escribir un número de página válido.\n> Ejemplo » *${usedPrefix + command} 2*`);
      }

      const { list: allChars, index } = await loadCharacters();

      const chatPrefix = chatId + '__';
      const canonicalOf = makeCanonicalOf(index, chatPrefix);
      const now = Date.now();

      let changed = await processExpired({ chat, chatId, now, index });
      const allStats = await loadAllStats();

      if (chat.npcs.length === 0 || Math.random() < 0.45) {
        const targetCount = Math.floor(Math.random() * 7);
        if (chat.npcs.length < targetCount && allChars.length > 0) {
          const owned = buildOwnedMap({ chatId, allStats, index });
          const listed = new Set(getShopListings(chat).map(l => canonicalOf(l.item.charId || l.item.id)));
          const weighted = buildWeightedPool(allChars);
          const needed = targetCount - chat.npcs.length;

          for (let i = 0; i < needed; i++) {
            let picked = null;
            for (let attempt = 0; attempt < 10; attempt++) {
              const candidate = pickWeighted(weighted);
              if (!candidate) break;
              const canonical = candidate.character.id;
              if (!owned.has(canonical) && !listed.has(canonical)) {
                picked = candidate;
                break;
              }
            }

            if (!picked) continue;

            const npcChar = picked.character;
            const canonical = npcChar.id;
            const range = RARITY_RANGE[picked.rarity.name];
            const rawCharId = npcChar.keyword || npcChar.id;
            const statValue = Number(allStats[chatPrefix + rawCharId]?.value);
            const baseVal = range
              ? (statValue >= range[0] && statValue <= range[1] ? statValue : randomInRange(range[0], range[1]))
              : (Number(npcChar.value) || 100);
            const npcPrice = Math.round(baseVal * (1.05 + Math.random() * 0.2));
            const durationMs = (15 + Math.random() * 15) * 60 * 1000;

            chat.npcs.push({
              id: rawCharId + '_' + Math.random().toString(36).substring(2, 7),
              charId: rawCharId,
              name: npcChar.name,
              price: npcPrice,
              value: baseVal,
              user: 'NPC',
              time: now,
              expiresAt: now + durationMs,
              isNpc: true
            });
            listed.add(canonical);
            changed = true;
          }
        }
      }

      if (changed) await persistShop(chatId, chat);

      const listings = getShopListings(chat);

      if (!listings.length) {
        let groupName = 'este grupo';
        try {
          if (chatId.endsWith('@g.us')) {
            const grupo = await sock.groupMetadata(chatId);
            groupName = grupo?.subject || groupName;
          }
        } catch {}
        return msg.reply(`ꕥ No hay personajes en venta en *${groupName}* en este momento.`);
      }

      const page = args.length ? parseInt(args[0]) : 1;
      const totalPages = Math.ceil(listings.length / ITEMS_PER_PAGE);
      if (page < 1 || page > totalPages) {
        return msg.reply(`ꕥ Página inválida. Solo hay *${totalPages}* página${totalPages > 1 ? 's' : ''} disponible${totalPages > 1 ? 's' : ''}.`);
      }

      const toItems = (from, to) => listings.slice(from, to).map((listing, offset) => buildShopItem({
        listing,
        number: from + offset + 1,
        index,
        allStats,
        chatPrefix,
        canonicalOf,
        now
      }));

      const startIndex = (page - 1) * ITEMS_PER_PAGE;
      const pageItems = toItems(startIndex, startIndex + ITEMS_PER_PAGE);

      let eventBanner = '';
      if (chat.activeEvent) {
        const remainingEventMs = Math.max(0, (chat.eventExpiresAt || 0) - now);
        const eMin = Math.floor(remainingEventMs / 60000);
        const eSec = Math.floor((remainingEventMs % 60000) / 1000);
        const icon = chat.activeEvent.type === 'good' ? '✨ [EVENTO BUENO]' : '⚠️ [EVENTO MALO]';
        eventBanner = `╭━━━ *${icon}* ━━━⬣\n┃ *${chat.activeEvent.name}*\n┃ ${chat.activeEvent.description}\n┃ ⏱️ *Expira en:* ${eMin}m ${eSec}s\n╰━━━━━━━━━━━━━━━╯`;
      }

      const total = listings.length;
      const players = listings.filter(l => l.kind === 'sale').length;
      const npcs = total - players;

      let anyPending = false;
      let sent = false;

      try {
        const images = await loadThumbs(pageItems);
        pageItems.forEach((item, i) => {
          item.img = images[i];
          item.pending = !images[i] && inflight.has(thumbKey(item));
        });
        anyPending = pageItems.some(i => i.pending);

        const renderKey = hashKey(JSON.stringify([
          total, players, npcs, page, totalPages, usedPrefix,
          pageItems.map(i => [i.number, i.name, i.price, i.value, i.rarity.name, i.isNpc, i.seller, i.timeText, !!i.img])
        ]));

        let buffer = anyPending ? null : getRender(renderKey);
        if (!buffer) {
          buffer = await generateShopImage({ total, players, npcs, page, totalPages, items: pageItems, usedPrefix });
          if (!anyPending) setRender(renderKey, buffer);
        }

        const caption = buildCaption({ total, page, totalPages, items: pageItems, usedPrefix, command, anyPending });
        await sock.sendMessage(chatId, { image: buffer, mimetype: 'image/jpeg', caption }, { quoted: msg });
        sent = true;
      } catch {
        sent = false;
      }

      if (!sent) {
        const caption = buildCaption({ total, page, totalPages, items: pageItems, usedPrefix, command, anyPending: false });
        await msg.reply(caption);
      }

      if (eventBanner) await msg.reply(eventBanner);

      if (page < totalPages) {
        for (const item of toItems(startIndex + ITEMS_PER_PAGE, startIndex + ITEMS_PER_PAGE * 2)) getThumb(item);
      }
    } catch (e) {
      await msg.reply(`> Ocurrió un error al ejecutar *${usedPrefix + command}*.\n> [Error: *${e.message}*]`);
    }
  }
};
