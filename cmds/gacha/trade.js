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
const MIN_IMAGE_SIDE = 150;
const MAX_ASPECT = 3;
const SERIES_CAST_TTL_MS = 6 * 60 * 60 * 1000;
const SERIES_CAST_RETRY_MS = 10 * 60 * 1000;
const SERIES_CAST_MAX_PAGES = 4;

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
const seriesCastCache = new Map();
const seriesCastInflight = new Map();

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

function withDeadline(promise, ms) {
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const ANILIST_QUERY = 'query ($search: String) { Page(page: 1, perPage: 10) { characters(search: $search) { name { full native alternative } image { large } media(perPage: 15) { nodes { title { romaji english native } synonyms } } } } }';
const SERIES_CAST_QUERY = 'query ($search: String, $page: Int) { Media(search: $search) { title { romaji english native } synonyms characters(page: $page, perPage: 50, sort: [ROLE, RELEVANCE]) { pageInfo { hasNextPage } nodes { name { full native alternative } image { large } } } } }';

const foldToken = t => (/^\d+$/.test(t) ? t : t.replace(/ou|oo/g, 'o').replace(/uu/g, 'u').replace(/(.)\1/g, '$1'));
const splitAlnum = s => normalizeStr(s).replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2');
const nameTokens = s => splitAlnum(s).split(' ').filter(t => t.length >= 3 || /^\d+$/.test(t)).map(foldToken);

function tokensMatch(a, b) {
  if (a === b) return true;
  if (/^\d+$/.test(a) || /^\d+$/.test(b)) return false;
  if (a.length < 4 || b.length < 4 || Math.abs(a.length - b.length) > 2) return false;
  return a.startsWith(b) || b.startsWith(a);
}

function matchTokens(tokens, candidateTokens) {
  return tokens.filter(t => candidateTokens.some(c => tokensMatch(t, c)));
}

function neededRatio(tokens) {
  return tokens.length <= 2 ? 1 : 0.67;
}

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

function validAnilistImage(image) {
  return typeof image === 'string' && /^https?:\/\//i.test(image) && !/\/default\./i.test(image);
}

function pickAnilistImage(characters, targets, series) {
  const seriesNorm = normalizeStr(cleanSeriesName(series));
  if (!seriesNorm || !targets.length) return null;

  let best = null;
  let bestRatio = 0;
  for (const ch of characters || []) {
    const image = ch?.image?.large;
    if (!validAnilistImage(image)) continue;
    if (!mediaMatchesSeries(ch?.media?.nodes, seriesNorm)) continue;

    const candidateTokens = [ch?.name?.full, ch?.name?.native, ...(ch?.name?.alternative || [])]
      .filter(Boolean)
      .flatMap(n => nameTokens(n));

    for (const tokens of targets) {
      const ratio = matchTokens(tokens, candidateTokens).length / tokens.length;
      if (ratio >= neededRatio(tokens) && ratio > bestRatio) {
        best = image;
        bestRatio = ratio;
      }
    }
  }
  return best;
}

function pickFromCast(cast, targets) {
  let full = null;
  let fullRatio = 0;
  const partial = [];

  for (const ch of cast) {
    let chFull = 0;
    let chPartial = false;
    for (const tokens of targets) {
      const matched = matchTokens(tokens, ch.tokens);
      if (!matched.length) continue;
      const ratio = matched.length / tokens.length;
      if (ratio >= neededRatio(tokens)) chFull = Math.max(chFull, ratio);
      else if (matched.some(t => t.length >= 5 && !/^\d+$/.test(t))) chPartial = true;
    }
    if (chFull > fullRatio) {
      full = ch;
      fullRatio = chFull;
    } else if (!chFull && chPartial) {
      partial.push(ch);
    }
  }

  if (full) return full.image;
  if (partial.length === 1) return partial[0].image;
  return null;
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

async function loadSeriesCast(seriesClean) {
  const key = normalizeStr(seriesClean);
  if (!key) return null;

  const cached = seriesCastCache.get(key);
  if (cached) {
    const ttl = cached.chars.length ? SERIES_CAST_TTL_MS : SERIES_CAST_RETRY_MS;
    if (Date.now() - cached.at < ttl) return cached.chars.length ? cached.chars : null;
  }

  const pending = seriesCastInflight.get(key);
  if (pending) return pending;

  const task = (async () => {
    const chars = [];
    for (let page = 1; page <= SERIES_CAST_MAX_PAGES; page++) {
      let media = null;
      try {
        const { data } = await limitHttp(() => http.post(
          ANILIST_URL,
          { query: SERIES_CAST_QUERY, variables: { search: seriesClean, page } },
          { timeout: 6000, headers: { 'Content-Type': 'application/json', Accept: 'application/json' } }
        ));
        media = data?.data?.Media || null;
      } catch (e) {
        if (e?.response?.status === 429) {
          const wait = Number(e.response.headers?.['retry-after']) || 60;
          anilistBlockedUntil = Date.now() + wait * 1000;
        }
        break;
      }

      if (!media) break;
      if (page === 1 && !mediaMatchesSeries([media], key)) break;

      for (const node of media.characters?.nodes || []) {
        const image = node?.image?.large;
        if (!validAnilistImage(image)) continue;
        const tokens = [node?.name?.full, node?.name?.native, ...(node?.name?.alternative || [])]
          .filter(Boolean)
          .flatMap(n => nameTokens(n));
        if (tokens.length) chars.push({ image, tokens });
      }

      if (!media.characters?.pageInfo?.hasNextPage) break;
    }

    seriesCastCache.set(key, { at: Date.now(), chars });
    return chars.length ? chars : null;
  })().finally(() => seriesCastInflight.delete(key));

  seriesCastInflight.set(key, task);
  return task;
}

async function searchAnilist(nombre, serie, extraNames = []) {
  const hasSeries = serie && serie !== 'Desconocido';
  if (!hasSeries) return { urls: [], unavailable: false };
  if (Date.now() < anilistBlockedUntil) return { urls: [], unavailable: true };

  const cleanName = nombre.replace(/\s*\(.*?\)\s*/g, '').trim();
  const alias = (nombre.match(/\(([^)]+)\)/) || [])[1] || '';
  const keywords = extraNames.map(k => String(k).replace(/[_-]+/g, ' ').trim());
  const names = [...new Set([
    cleanName,
    ...aliasVariants(cleanName),
    alias,
    ...aliasVariants(alias),
    ...keywords
  ].filter(Boolean))];
  const targets = names.map(nameTokens).filter(tokens => tokens.length);
  if (!targets.length) return { urls: [], unavailable: false };

  const cast = await loadSeriesCast(cleanSeriesName(serie));
  if (cast) {
    const image = pickFromCast(cast, targets);
    if (image) return { urls: [image], unavailable: false };
  }

  let unavailable = false;
  for (const search of names.slice(0, 3)) {
    const { characters, failed } = await fetchAnilist(search);
    if (failed) {
      unavailable = true;
      break;
    }
    const url = pickAnilistImage(characters, targets, serie);
    if (url) return { urls: [url], unavailable: false };
  }
  return { urls: [], unavailable };
}

function scoreBooruPost(p) {
  const tags = ` ${String(p?.tags || '')} `;
  let score = 0;

  if (/ solo /.test(tags)) score += 4;
  if (/ (multiple_girls|multiple_boys|2girls|3girls|4girls|5girls|6\+girls|2boys|3boys|4boys|5boys|group) /.test(tags)) score -= 4;
  if (/ (comic|4koma|monochrome|greyscale|chibi|sketch|text_focus|speech_bubble|english_text|translation_request) /.test(tags)) score -= 3;
  if (/ (looking_at_viewer|portrait|upper_body|face) /.test(tags)) score += 1;

  const w = Number(p?.width) || 0;
  const h = Number(p?.height) || 0;
  if (w && h) {
    const ratio = w / h;
    if (ratio >= 0.5 && ratio <= 1.6) score += 1;
    if (Math.min(w, h) >= 600) score += 1;
    if (ratio > 2.2 || ratio < 0.35) score -= 3;
  }

  score += Math.min(3, (Number(p?.score) || 0) / 10);
  return score;
}

async function fetchSafebooru(tags) {
  const q = encodeURIComponent(tags);
  const data = await getJson(`https://safebooru.org/index.php?page=dapi&s=post&q=index&json=1&limit=50&tags=${q}`);
  if (!Array.isArray(data)) return [];
  return data
    .filter(p => p.directory && p.image && IMG_EXT.test(p.image))
    .map(p => ({ url: `https://safebooru.org/images/${p.directory}/${p.image}`, score: scoreBooruPost(p) }));
}

async function fetchGelbooru(tags) {
  if (!GELBOORU_USER_ID || !GELBOORU_API_KEY) return [];
  const q = encodeURIComponent(tags);
  const auth = `&user_id=${encodeURIComponent(GELBOORU_USER_ID)}&api_key=${encodeURIComponent(GELBOORU_API_KEY)}`;
  const data = await getJson(`https://gelbooru.com/index.php?page=dapi&s=post&q=index&json=1&limit=50&tags=${q}${auth}`);
  return (data?.post || [])
    .filter(p => typeof p.file_url === 'string' && IMG_EXT.test(p.file_url))
    .map(p => ({ url: p.file_url, score: scoreBooruPost(p) }));
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
    const wave = tagSets.slice(i, i + 3);
    const results = await Promise.all(wave.map(async (tags, offset) => {
      const lists = await Promise.all([
        fetchSafebooru(tags).catch(() => []),
        fetchGelbooru(tags).catch(() => [])
      ]);
      return { priority: tagSets.length - (i + offset), posts: lists.flat() };
    }));

    const merged = new Map();
    for (const { priority, posts } of results) {
      for (const post of posts) {
        const score = post.score + priority * 0.25;
        const previous = merged.get(post.url);
        if (previous === undefined || score > previous) merged.set(post.url, score);
      }
    }

    if (merged.size) {
      return [...merged.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([url]) => url);
    }
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

function urlText(url) {
  try {
    return decodeURIComponent(new URL(url).pathname).replace(/[-_./]+/g, ' ');
  } catch {
    return '';
  }
}

const PENALTY_WORDS = /\b(cosplay|figure|figurine|funko|toy|plush|poster|logo|meme|merch|shirt|keychain)\b/i;

function rankEntries(entries, names, series) {
  const nameTokenLists = names.map(nameTokens).filter(tokens => tokens.length);
  const seriesTokenList = nameTokens(cleanSeriesName(series || ''));

  const scored = entries.map((entry, order) => {
    const raw = `${entry.text || ''} ${urlText(entry.url)}`;
    const textTokens = nameTokens(raw);
    let score = 0;

    if (textTokens.length) {
      if (seriesTokenList.length) {
        score += 3 * (matchTokens(seriesTokenList, textTokens).length / seriesTokenList.length);
      }
      let nameRatio = 0;
      for (const tokens of nameTokenLists) {
        nameRatio = Math.max(nameRatio, matchTokens(tokens, textTokens).length / tokens.length);
      }
      score += 4 * nameRatio;
    }

    if (PENALTY_WORDS.test(raw)) score -= 3;
    score -= order * 0.02;

    return { entry, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const seen = new Set();
  const urls = [];
  for (const { entry } of scored) {
    if (seen.has(entry.url)) continue;
    seen.add(entry.url);
    urls.push(entry.url);
  }
  return urls;
}

async function searchEvo(name, series, alt = '') {
  const base = series || 'anime';
  const queries = [...new Set([
    series ? `${name} ${series}` : '',
    `${name} ${base} anime character`,
    series ? `${name} ${series} official art` : '',
    alt ? `${alt} ${base}` : ''
  ].map(q => q.trim()).filter(Boolean))].slice(0, 4);

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
  return rankEntries(results.flat(), [name, alt].filter(Boolean), series).slice(0, 24);
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
  return await searchEvo(cleanName, seriesClean, alias || aliasVariants(cleanName)[0] || '');
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
  return `v4__${normalizeStr(item.series)}__${item.id}__${item.imageUrl || ''}`;
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
  if (img.width < MIN_IMAGE_SIDE || img.height < MIN_IMAGE_SIDE) throw new Error('imagen muy pequeña');
  const ratio = img.width / img.height;
  if (ratio > MAX_ASPECT || ratio < 1 / MAX_ASPECT) throw new Error('proporción no válida');
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

function saveUserField(userId, key, value) {
  if (!db.data.users[userId]) db.data.users[userId] = {};
  db.data.users[userId][key] = value;
  if (typeof db.updateUser === 'function') db.updateUser(userId, key, value);
}

function getChatUserSafe(chatId, userId) {
  return (db.getChatUser ? db.getChatUser(chatId, userId) : db.data.chat_users?.[chatId]?.[userId]) || {};
}

function getUserSafe(userId) {
  return (db.getUser ? db.getUser(userId) : db.data.users?.[userId]) || {};
}

function buildUserCards({ index, allStats, chatId, userId, characterEntries, favoriteEntries }) {
  const chatPrefix = chatId + '__';

  const favoriteSet = new Set();
  for (const f of favoriteEntries) {
    const raw = entryToRaw(f, chatPrefix);
    if (raw) favoriteSet.add(raw);
  }

  const ownedRaw = new Set();
  for (const entry of characterEntries) {
    const raw = entryToRaw(entry, chatPrefix);
    if (raw) ownedRaw.add(raw);
  }

  for (const [key, stat] of Object.entries(allStats)) {
    if (!key.startsWith(chatPrefix)) continue;
    if (stat?.user === userId || stat?.owner === userId || stat?.claimedBy === userId || stat?.claimed === userId) {
      ownedRaw.add(key.slice(chatPrefix.length));
    }
  }

  const cards = [];
  const seen = new Set();

  for (const rawId of ownedRaw) {
    const source = lookupCharacter(index, rawId);
    const id = source?.id || rawId;
    if (seen.has(id)) continue;
    seen.add(id);

    const statCandidates = [rawId, source?.id, source?.keyword].filter(Boolean);
    let statId = null;
    let savedStat = null;
    for (const k of statCandidates) {
      if (allStats[chatPrefix + k]) {
        statId = k;
        savedStat = allStats[chatPrefix + k];
        break;
      }
    }
    if (!savedStat && allStats[rawId]) savedStat = allStats[rawId];

    const baseValue = Number(savedStat?.value) || Number(source?.price) || Number(source?.value) || 0;
    const rarity = getCharacterRarity(source, savedStat, baseValue);
    const value = resolveValue(baseValue, rarity);
    const isFavorite = favoriteSet.has(id) || favoriteSet.has(rawId) || (source?.keyword ? favoriteSet.has(String(source.keyword)) : false);

    cards.push({
      id,
      rawId,
      statId: statId || rawId,
      keyword: source?.keyword || '',
      name: savedStat?.name || source?.name || `ID:${rawId}`,
      value,
      rarity,
      isFavorite
    });
  }

  cards.sort((a, b) => {
    if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
    if (b.value !== a.value) return b.value - a.value;
    return a.name.localeCompare(b.name);
  });

  return cards;
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

const TRADE_TTL_MS = 60 * 1000;

async function updateStatsBatch(entries) {
  let json = {};
  try {
    const data = await fs.readFile(STATS_FILE_PATH, 'utf-8');
    json = JSON.parse(data);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  for (const { key, fallback, apply } of entries) {
    json[key] = apply(json[key] || fallback);
  }
  await fs.writeFile(STATS_FILE_PATH, JSON.stringify(json, null, 2));
}

function getChatTrades(chatId) {
  if (!global.tradeProposals) global.tradeProposals = {};
  if (!global.tradeProposals[chatId]) global.tradeProposals[chatId] = {};
  const now = Date.now();
  for (const [to, trade] of Object.entries(global.tradeProposals[chatId])) {
    if (!trade || now - trade.time > TRADE_TTL_MS) delete global.tradeProposals[chatId][to];
  }
  return global.tradeProposals[chatId];
}

function userName(userId) {
  return getUserSafe(userId).name?.trim() || String(userId).split('@')[0];
}

function mentionTag(userId) {
  return `@${String(userId).split('@')[0]}`;
}

function buildTradeItem(card, index) {
  const character = lookupCharacter(index, card.rawId) || lookupCharacter(index, card.name);
  const imageCandidate = character?.image || character?.img || character?.avatar || character?.photo || (Array.isArray(character?.images) && character.images.length ? character.images[0] : null);
  return {
    id: card.id,
    name: card.name,
    value: card.value,
    rarity: card.rarity,
    series: character?.source || 'Desconocido',
    keyword: character?.keyword || card.keyword || '',
    imageUrl: typeof imageCandidate === 'string' && /^https?:\/\//i.test(imageCandidate) ? imageCandidate : null
  };
}

function toTradeSnapshot(card, item) {
  return {
    id: card.id,
    rawId: card.rawId,
    statId: card.statId,
    name: card.name,
    value: card.value,
    rarityName: card.rarity.name,
    series: item.series
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

function drawExchangeSymbol(ctx, cx, cy) {
  ctx.save();
  ctx.shadowColor = '#d4af37';
  ctx.shadowBlur = 24;
  ctx.fillStyle = '#17152d';
  ctx.beginPath();
  ctx.arc(cx, cy, 58, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = '#d4af37';
  ctx.stroke();
  ctx.restore();

  ctx.strokeStyle = '#ffd700';
  ctx.fillStyle = '#ffd700';
  ctx.lineWidth = 7;
  ctx.lineCap = 'round';

  ctx.beginPath();
  ctx.moveTo(cx - 28, cy - 14);
  ctx.lineTo(cx + 22, cy - 14);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx + 36, cy - 14);
  ctx.lineTo(cx + 16, cy - 30);
  ctx.lineTo(cx + 16, cy + 2);
  ctx.closePath();
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(cx + 28, cy + 14);
  ctx.lineTo(cx - 22, cy + 14);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - 36, cy + 14);
  ctx.lineTo(cx - 16, cy - 2);
  ctx.lineTo(cx - 16, cy + 30);
  ctx.closePath();
  ctx.fill();
}

function drawTradeCard(ctx, x, y, side) {
  const { label, item } = side;
  const cardW = 320;
  const cardH = 430;

  ctx.fillStyle = '#1f1d3a';
  drawRoundedRect(ctx, x, y, cardW, cardH, 14);
  ctx.fill();

  ctx.fillStyle = '#a6a4ce';
  ctx.font = 'bold 18px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(truncate(safeText(label, 'Jugador'), 30), x + 20, y + 34);

  const imgX = x + 20;
  const imgY = y + 52;
  const imgSize = 280;

  ctx.save();
  drawRoundedRect(ctx, imgX, imgY, imgSize, imgSize, 10);
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
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(item.pending ? 'Cargando...' : 'Sin imagen', imgX + imgSize / 2, imgY + imgSize / 2);
    ctx.textAlign = 'left';
  }
  ctx.restore();

  const glow = getRarityGlow(item.rarity.name);
  ctx.save();
  ctx.shadowColor = glow.shadow;
  ctx.shadowBlur = glow.blur;
  ctx.strokeStyle = glow.stroke;
  ctx.lineWidth = Math.max(glow.width, 2);
  drawRoundedRect(ctx, imgX, imgY, imgSize, imgSize, 10);
  ctx.stroke();
  ctx.restore();

  const shortName = safeText(item.name.replace(/\s*\(.*?\)\s*/g, ' '), 'Personaje');
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 24px sans-serif';
  ctx.fillText(truncate(shortName, 21), x + 20, y + 372);

  ctx.fillStyle = RARITY_COLORS[item.rarity.name] || '#f59e0b';
  ctx.beginPath();
  ctx.arc(x + 28, y + 396, 7, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#ffd700';
  ctx.font = 'bold 20px sans-serif';
  ctx.fillText(`Valor $${item.value.toLocaleString()}`, x + 44, y + 403);

  ctx.fillStyle = '#8f8ea8';
  ctx.font = '14px sans-serif';
  ctx.fillText(truncate(safeText(cleanSeriesName(item.series), 'Desconocido'), 38), x + 20, y + 424);
}

async function generateTradeImage({ title, pill, left, right, footer }) {
  const width = 1000;
  const height = 640;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  const bg = ctx.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, '#0f0e1e');
  bg.addColorStop(1, '#1b1834');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 32px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(title, 40, 58);

  ctx.fillStyle = '#222040';
  drawRoundedRect(ctx, 780, 26, 180, 38, 19);
  ctx.fill();
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 16px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(pill, 870, 51);
  ctx.textAlign = 'left';

  drawTradeCard(ctx, 60, 100, left);
  drawTradeCard(ctx, 620, 100, right);
  drawExchangeSymbol(ctx, 500, 302);

  ctx.fillStyle = '#535075';
  ctx.font = '14px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(footer, width / 2, 610);

  return canvas.encode('jpeg', 90);
}

async function sendTradeMessage({ sock, msg, chatId, image, caption, mentions }) {
  if (image) {
    try {
      await sock.sendMessage(chatId, { image, mimetype: 'image/jpeg', caption, mentions }, { quoted: msg });
      return;
    } catch {}
  }
  await sock.sendMessage(chatId, { text: caption, mentions }, { quoted: msg });
}

async function renderTrade({ title, pill, leftLabel, leftItem, rightLabel, rightItem, footer }) {
  try {
    const images = await loadThumbs([leftItem, rightItem]);
    leftItem.img = images[0];
    rightItem.img = images[1];
    leftItem.pending = !images[0] && inflight.has(thumbKey(leftItem));
    rightItem.pending = !images[1] && inflight.has(thumbKey(rightItem));
    return await generateTradeImage({
      title,
      pill,
      left: { label: leftLabel, item: leftItem },
      right: { label: rightLabel, item: rightItem },
      footer
    });
  } catch {
    return null;
  }
}

function valueDifferenceLine(fromId, fromValue, toId, toValue) {
  const diff = Math.abs(fromValue - toValue);
  if (diff === 0) return '⚖️ Ambos personajes valen lo mismo.';
  const richer = fromValue > toValue ? fromId : toId;
  return `⚖️ El personaje de ${mentionTag(richer)} vale *¥${diff.toLocaleString()}* más.`;
}

function resolveCard(cards, query, where) {
  if (/^#?\d+$/.test(query)) {
    const number = parseInt(query.replace('#', ''));
    if (number < 1 || number > cards.length) {
      return { error: `ꕥ Número no válido para ${where}. Tiene *${cards.length}* personaje${cards.length !== 1 ? 's' : ''}.` };
    }
    return { card: cards[number - 1] };
  }

  const matches = findCards(cards, query);
  if (matches.length === 0) {
    return { error: `ꕥ No se encontró a *${query}* en ${where}.` };
  }
  if (matches.length > 1) {
    const lines = matches.slice(0, 8).map(c => `» *${cards.indexOf(c) + 1}.* ${c.name}`).join('\n');
    const extra = matches.length > 8 ? `\n… y *${matches.length - 8}* más.` : '';
    return { error: `ꕥ Hay varios personajes en ${where} que coinciden con *${query}*:\n\n${lines}${extra}\n\n> Usa el número del harem en lugar del nombre.` };
  }
  return { card: matches[0] };
}

function userContext(chatId, userId, allStats, index) {
  const chatUser = getChatUserSafe(chatId, userId);
  const userGlobal = getUserSafe(userId);
  const favorites = toList(chatUser.favorites || chatUser.favorite || userGlobal.favorites || userGlobal.favorite);
  const cards = buildUserCards({
    index,
    allStats,
    chatId,
    userId,
    characterEntries: toList(chatUser.characters),
    favoriteEntries: favorites
  });
  return { chatUser, favorites, cards };
}

export default {
  command: ['trade', 'intercambiar', 'comerciar'],
  category: 'gacha',
  description: 'Proponer o aceptar un intercambio de personajes (por nombre o número del harem).',
  run: async ({ msg, sock, args, usedPrefix, command }) => {
    try {
      if (typeof db.read === 'function') await db.read();
      const chatId = msg.chat;
      const senderId = msg.sender;

      ensureDbContainers(chatId);
      const chat = db.getChat ? db.getChat(chatId) : db.data.chats[chatId];
      if (chat?.adminonly || !chat?.gacha) {
        return msg.reply(`ꕥ Los comandos de *Gacha* están desactivados en este grupo.\n\nUn *administrador* puede activarlos con el comando:\n» *${usedPrefix}gacha on*`);
      }

      const trades = getChatTrades(chatId);
      const subCommand = args[0]?.toLowerCase();
      const chatPrefix = chatId + '__';

      if (['accept', 'aceptar', 'confirm', 'confirmar'].includes(subCommand)) {
        const trade = trades[senderId];
        if (!trade) {
          const own = Object.values(trades).find(t => t.from === senderId);
          return msg.reply(own
            ? `ꕥ Tu propuesta todavía no fue aceptada. Solo *${userName(own.to)}* puede aceptarla.`
            : 'ꕥ No tienes ninguna propuesta de intercambio pendiente en este grupo.');
        }

        delete trades[senderId];

        const { index } = await loadCharacters();
        const canonicalOf = makeCanonicalOf(index, chatPrefix);
        const allStats = await loadAllStats();

        const fromCtx = userContext(chatId, trade.from, allStats, index);
        const toCtx = userContext(chatId, trade.to, allStats, index);

        const fromCard = fromCtx.cards.find(c => c.id === trade.fromChar.id);
        const toCard = toCtx.cards.find(c => c.id === trade.toChar.id);

        if (!fromCard) {
          return msg.reply(`ꕥ *${userName(trade.from)}* ya no posee a *${trade.fromChar.name}*. Intercambio cancelado.`);
        }
        if (!toCard) {
          return msg.reply(`ꕥ Ya no posees a *${trade.toChar.name}*. Intercambio cancelado.`);
        }

        const now = Date.now();

        await updateStatsBatch([
          {
            key: chatPrefix + fromCard.statId,
            fallback: { name: fromCard.name, value: fromCard.value, votes: 0 },
            apply: stat => {
              const next = { ...stat, user: trade.to, owner: trade.to, claimedBy: trade.to, claimedAt: now };
              delete next.reservedBy;
              delete next.reservedUntil;
              return next;
            }
          },
          {
            key: chatPrefix + toCard.statId,
            fallback: { name: toCard.name, value: toCard.value, votes: 0 },
            apply: stat => {
              const next = { ...stat, user: trade.from, owner: trade.from, claimedBy: trade.from, claimedAt: now };
              delete next.reservedBy;
              delete next.reservedUntil;
              return next;
            }
          }
        ]);

        const fromList = toList(fromCtx.chatUser.characters).filter(e => canonicalOf(e) !== fromCard.id);
        if (!fromList.some(e => canonicalOf(e) === toCard.id)) fromList.push(toCard.rawId);

        const toListNew = toList(toCtx.chatUser.characters).filter(e => canonicalOf(e) !== toCard.id);
        if (!toListNew.some(e => canonicalOf(e) === fromCard.id)) toListNew.push(fromCard.rawId);

        saveChatUserField(chatId, trade.from, 'characters', fromList);
        saveChatUserField(chatId, trade.to, 'characters', toListNew);

        const fromFavs = fromCtx.favorites.filter(e => canonicalOf(e) !== fromCard.id);
        if (fromFavs.length !== fromCtx.favorites.length) {
          saveChatUserField(chatId, trade.from, 'favorites', fromFavs);
          saveUserField(trade.from, 'favorites', fromFavs);
        }
        const toFavs = toCtx.favorites.filter(e => canonicalOf(e) !== toCard.id);
        if (toFavs.length !== toCtx.favorites.length) {
          saveChatUserField(chatId, trade.to, 'favorites', toFavs);
          saveUserField(trade.to, 'favorites', toFavs);
        }

        if (db.getCharacter && db.setCharacter) {
          for (const [card, owner] of [[fromCard, trade.to], [toCard, trade.from]]) {
            const charKey = chatPrefix + card.statId;
            const cData = db.getCharacter(charKey);
            if (!cData) continue;
            cData.user = owner;
            cData.owner = owner;
            cData.claimedBy = owner;
            cData.claimedAt = now;
            db.setCharacter(charKey, cData);
          }
        }

        if (typeof db.write === 'function') await db.write();

        const fromItem = buildTradeItem(fromCard, index);
        const toItem = buildTradeItem(toCard, index);

        const image = await renderTrade({
          title: 'INTERCAMBIO COMPLETADO',
          pill: 'Completado',
          leftLabel: `${truncate(safeText(userName(trade.from), 'Jugador'), 16)} recibió`,
          leftItem: toItem,
          rightLabel: `${truncate(safeText(userName(trade.to), 'Jugador'), 16)} recibió`,
          rightItem: fromItem,
          footer: 'Los personajes ya están en sus nuevos harems.'
        });

        const caption = `❀ *INTERCAMBIO COMPLETADO CON ÉXITO* ❀\n\n` +
          `✦ *${mentionTag(trade.from)}* recibió a *${toCard.name}* (${toItem.series})\n` +
          `✦ *${mentionTag(trade.to)}* recibió a *${fromCard.name}* (${fromItem.series})`;

        return sendTradeMessage({ sock, msg, chatId, image, caption, mentions: [trade.from, trade.to] });
      }

      if (['reject', 'rechazar', 'cancel', 'cancelar'].includes(subCommand)) {
        const asTarget = trades[senderId];
        const asProposer = Object.entries(trades).find(([, t]) => t.from === senderId);

        if (asTarget) {
          delete trades[senderId];
          return msg.reply(`❀ Has rechazado la propuesta de intercambio de *${userName(asTarget.from)}*.`);
        }
        if (asProposer) {
          delete trades[asProposer[0]];
          return msg.reply('❀ Tu propuesta de intercambio ha sido cancelada.');
        }
        return msg.reply('ꕥ No tienes ninguna propuesta de intercambio pendiente.');
      }

      const targetUser = msg.mentionedJid?.[0] || msg.quoted?.sender;
      const usage = `❀ Uso del comando:\n> *${usedPrefix + command} @usuario mi_personaje | su_personaje*\n> Puedes usar el nombre o el número del harem de cada uno.\n> Ejemplo » *${usedPrefix + command} @usuario 2 | Nezuko*\n\n> Para responder a una oferta:\n> *${usedPrefix + command} aceptar*\n> *${usedPrefix + command} rechazar*`;

      if (!targetUser) return msg.reply(usage);
      if (targetUser === senderId) return msg.reply('ꕥ No puedes intercambiar personajes contigo mismo.');

      const rawTarget = db.getChatUser ? db.getChatUser(chatId, targetUser) : db.data.chat_users?.[chatId]?.[targetUser];
      if (!rawTarget) return msg.reply('「✎」 El usuario mencionado no está registrado en el bot.');

      const rawText = args.join(' ').replace(/@\S+/g, ' ').replace(/\s+/g, ' ').trim();
      const parts = rawText.split('|').map(p => p.trim());

      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        return msg.reply(`ꕥ Debes especificar ambos personajes separados por *|*.\n> Ejemplo: *${usedPrefix + command} @usuario Elaina | Nezuko*`);
      }

      const existing = trades[targetUser];
      if (existing && existing.from !== senderId) {
        return msg.reply(`ꕥ *${userName(targetUser)}* ya tiene una propuesta de intercambio pendiente de otra persona. Espera a que responda o expire.`);
      }

      const { index } = await loadCharacters();
      const allStats = await loadAllStats();

      const mine = userContext(chatId, senderId, allStats, index);
      const theirs = userContext(chatId, targetUser, allStats, index);

      if (mine.cards.length === 0) return msg.reply('ꕥ No tienes personajes para intercambiar.');
      if (theirs.cards.length === 0) return msg.reply(`ꕥ *${userName(targetUser)}* no tiene personajes para intercambiar.`);

      const myResult = resolveCard(mine.cards, parts[0], 'tu harem');
      if (myResult.error) return msg.reply(myResult.error);

      const theirResult = resolveCard(theirs.cards, parts[1], `el harem de *${userName(targetUser)}*`);
      if (theirResult.error) return msg.reply(theirResult.error);

      const myCard = myResult.card;
      const theirCard = theirResult.card;

      for (const [to, t] of Object.entries(trades)) {
        if (t.from === senderId) delete trades[to];
      }

      const myItem = buildTradeItem(myCard, index);
      const theirItem = buildTradeItem(theirCard, index);

      trades[targetUser] = {
        from: senderId,
        to: targetUser,
        fromChar: toTradeSnapshot(myCard, myItem),
        toChar: toTradeSnapshot(theirCard, theirItem),
        time: Date.now()
      };

      const image = await renderTrade({
        title: 'INTERCAMBIO',
        pill: `Expira en ${Math.round(TRADE_TTL_MS / 1000)}s`,
        leftLabel: `${truncate(safeText(userName(senderId), 'Jugador'), 16)} ofrece`,
        leftItem: myItem,
        rightLabel: `${truncate(safeText(userName(targetUser), 'Jugador'), 16)} entrega`,
        rightItem: theirItem,
        footer: `Responde con "${usedPrefix + command} aceptar" o "${usedPrefix + command} rechazar".`
      });

      const caption = `╭─❖ *PROPUESTA DE INTERCAMBIO* ❖─╮\n│\n` +
        `│ 👤 *${mentionTag(senderId)}* ofrece:\n` +
        `│ ✦ *${myCard.name}* (${myItem.series}) • ¥${myCard.value.toLocaleString()}\n│\n` +
        `│ 👤 *${mentionTag(targetUser)}* entregaría:\n` +
        `│ ✦ *${theirCard.name}* (${theirItem.series}) • ¥${theirCard.value.toLocaleString()}\n│\n` +
        `╰─────────────────────────╯\n\n` +
        `${valueDifferenceLine(senderId, myCard.value, targetUser, theirCard.value)}\n\n` +
        `> *${mentionTag(targetUser)}*, responde con *${usedPrefix + command} aceptar* o *${usedPrefix + command} rechazar* (tienes ${Math.round(TRADE_TTL_MS / 1000)}s).`;

      return sendTradeMessage({ sock, msg, chatId, image, caption, mentions: [senderId, targetUser] });
    } catch (e) {
      await msg.reply(`> Ha ocurrido un error al ejecutar el comando *${usedPrefix + command}*.\n> [Error: *${e.message}*]`);
    }
  }
};
