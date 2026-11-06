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

const PER_PAGE = 10;
const TOP_IMAGE_COUNT = 3;
const RANK_STYLES = [
  { num: '1', suffix: 'ro', color: '#f5c542' },
  { num: '2', suffix: 'do', color: '#d0d4da' },
  { num: '3', suffix: 'ro', color: '#cd7f32' }
];

function ensureDbContainers(chatId) {
  if (!db.data) db.data = {};
  if (!db.data.chats) db.data.chats = {};
  if (!db.data.chats[chatId]) db.data.chats[chatId] = {};
  if (!db.data.chat_users) db.data.chat_users = {};
  if (!db.data.chat_users[chatId]) db.data.chat_users[chatId] = {};
  if (!db.data.users) db.data.users = {};
}

function getUserSafe(userId) {
  return (db.getUser ? db.getUser(userId) : db.data.users?.[userId]) || {};
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

function ownerLabel(entry) {
  if (entry.ownerId) {
    return getUserSafe(entry.ownerId).name?.trim() || String(entry.ownerId).split('@')[0];
  }
  return entry.listed ? 'En venta' : 'Libre';
}

function buildRanking({ chatId, chat, allStats, index, owned }) {
  const chatPrefix = chatId + '__';
  const canonicalOf = makeCanonicalOf(index, chatPrefix);

  const listed = new Set();
  for (const sale of Object.values(chat.sales || {})) {
    if (sale) listed.add(canonicalOf(sale.id));
  }
  for (const npc of chat.npcs || []) {
    if (npc) listed.add(canonicalOf(npc.charId || npc.id));
  }

  const byId = new Map();

  for (const [key, stat] of Object.entries(allStats)) {
    if (!key.startsWith(chatPrefix) || !stat || typeof stat !== 'object') continue;
    const rawId = key.slice(chatPrefix.length);
    if (!rawId) continue;

    const character = lookupCharacter(index, rawId) || lookupCharacter(index, stat.name);
    const id = character?.id || canonicalOf(rawId) || rawId;

    const baseValue = Number(stat.value) || Number(character?.price) || Number(character?.value) || 0;
    const rarity = getCharacterRarity(character, stat, baseValue);
    const value = resolveValue(baseValue, rarity);
    const ownerId = owned.get(id) || null;

    const imageCandidate = character?.image || character?.img || character?.avatar || character?.photo || (Array.isArray(character?.images) && character.images.length ? character.images[0] : null);

    const entry = {
      id,
      name: stat.name || character?.name || rawId,
      value,
      rarity,
      ownerId,
      listed: listed.has(id),
      age: character?.age,
      keyword: character?.keyword || '',
      series: character?.source || 'Desconocido',
      imageUrl: typeof imageCandidate === 'string' && /^https?:\/\//i.test(imageCandidate) ? imageCandidate : null
    };

    const prev = byId.get(id);
    const better = !prev
      || (!prev.ownerId && entry.ownerId)
      || (!!prev.ownerId === !!entry.ownerId && entry.value > prev.value);
    if (better) byId.set(id, entry);
  }

  return [...byId.values()].sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
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

async function generateTopImage({ items, total, usedPrefix, command }) {
  const width = 1000;
  const height = 1000;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  const bg = ctx.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, '#0c0c11');
  bg.addColorStop(1, '#1a1a23');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.beginPath();
  ctx.moveTo(620, 0);
  ctx.lineTo(1000, 0);
  ctx.lineTo(1000, 380);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(0, 1000);
  ctx.lineTo(0, 620);
  ctx.lineTo(380, 1000);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = 'rgba(212,175,55,0.55)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(560, 0);
  ctx.lineTo(1000, 440);
  ctx.moveTo(0, 560);
  ctx.lineTo(440, 1000);
  ctx.stroke();

  ctx.textAlign = 'left';
  ctx.fillStyle = '#d4af37';
  ctx.font = 'bold 34px sans-serif';
  ctx.fillText('TOP PERSONAJES', 70, 68);

  ctx.textAlign = 'right';
  ctx.fillStyle = '#a6a4ce';
  ctx.font = 'bold 18px sans-serif';
  ctx.fillText(`${total} en el ranking`, 930, 66);
  ctx.textAlign = 'left';

  const frameX = 70;
  const frameY = 95;
  const frameW = 860;
  const frameH = 810;

  const goldGradient = ctx.createLinearGradient(frameX, frameY, frameX + frameW, frameY + frameH);
  goldGradient.addColorStop(0, '#f5d77a');
  goldGradient.addColorStop(0.5, '#b8902e');
  goldGradient.addColorStop(1, '#f5d77a');

  ctx.fillStyle = '#09090d';
  drawRoundedRect(ctx, frameX, frameY, frameW, frameH, 10);
  ctx.fill();
  ctx.strokeStyle = goldGradient;
  ctx.lineWidth = 8;
  drawRoundedRect(ctx, frameX, frameY, frameW, frameH, 10);
  ctx.stroke();

  const innerLeft = frameX + 8;
  const innerRight = frameX + frameW - 8;
  const slabHeight = 265;
  const firstTop = frameY + 8;

  for (let i = 1; i < TOP_IMAGE_COUNT; i++) {
    const sepY = firstTop + slabHeight * i;
    ctx.strokeStyle = goldGradient;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(innerLeft, sepY + 22);
    ctx.lineTo(innerRight, sepY - 22);
    ctx.stroke();
  }

  for (let i = 0; i < items.length && i < TOP_IMAGE_COUNT; i++) {
    const item = items[i];
    const style = RANK_STYLES[i];
    const st = firstTop + slabHeight * i;

    const cx = 260;
    const cy = st + 124;
    const r = 92;

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    if (item.img) {
      const scale = Math.max((r * 2) / item.img.width, (r * 2) / item.img.height);
      const drawW = item.img.width * scale;
      const drawH = item.img.height * scale;
      ctx.drawImage(item.img, cx - drawW / 2, cy - drawH / 2, drawW, drawH);
    } else {
      ctx.fillStyle = '#322f54';
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
      ctx.fillStyle = '#8f8ea8';
      ctx.font = 'bold 18px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(item.pending ? 'Cargando...' : 'Sin imagen', cx, cy + 6);
      ctx.textAlign = 'left';
    }
    ctx.restore();

    const glow = getRarityGlow(item.rarity.name);
    ctx.save();
    ctx.shadowColor = glow.shadow;
    ctx.shadowBlur = Math.max(glow.blur, 12);
    ctx.strokeStyle = '#d4af37';
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    const shortName = safeText(item.name.replace(/\s*\(.*?\)\s*/g, ' '), 'Personaje').toUpperCase();
    ctx.fillStyle = '#d4af37';
    ctx.font = 'bold 26px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(truncate(shortName, 18), cx, st + 252);
    ctx.textAlign = 'left';

    const labelX = 460;
    ctx.fillStyle = style.color;
    ctx.font = 'bold 104px sans-serif';
    ctx.fillText(style.num, labelX, st + 110);
    const numWidth = ctx.measureText(style.num).width;
    ctx.font = 'bold 44px sans-serif';
    ctx.fillText(style.suffix, labelX + numWidth + 6, st + 48);

    const infoX = 470;
    const ageText = item.age ? `${item.age}` : 'Desconocida';
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '30px sans-serif';
    ctx.fillText(`Edad: ${truncate(ageText, 14)}`, infoX, st + 158);

    ctx.fillStyle = '#ffd700';
    ctx.font = 'bold 30px sans-serif';
    ctx.fillText(`Valor: ¥${item.value.toLocaleString()}`, infoX, st + 198);

    ctx.fillStyle = '#a6a4ce';
    ctx.font = '24px sans-serif';
    const ownerText = item.ownerId ? `Dueño: ${truncate(safeText(item.ownerText, 'Jugador'), 20)}` : item.ownerText;
    ctx.fillText(ownerText, infoX, st + 232);
  }

  ctx.fillStyle = '#6b6890';
  ctx.font = '14px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`Usa "${usedPrefix}${command} 2" para ver el resto del ranking.`, width / 2, 945);

  return canvas.encode('jpeg', 90);
}

function entryLines(entries, startRank, withOwner) {
  return entries
    .map((e, i) => {
      const owner = withOwner ? ` • ${truncate(ownerLabel(e), 16)}` : '';
      return `✰ #${startRank + i} » *${e.name}*\n    → Valor: *¥${e.value.toLocaleString()}*${owner}`;
    })
    .join('\n');
}

const HEADER_LINE = '❀ *Personajes con más valor:*';

function composeText(body, footer) {
  return [HEADER_LINE, body].filter(Boolean).join('\n\n') + footer;
}

function buildFooter({ page, totalPages, usedPrefix, command, anyPending }) {
  let footer = `\n\n⌦ Página *${page}* de *${totalPages}*`;
  if (page < totalPages) {
    footer += `\n> Para ver la siguiente página › *${usedPrefix + command} ${page + 1}*`;
  }
  if (anyPending) {
    footer += `\n> ⏳ Algunas imágenes se siguen descargando, usa el comando de nuevo en unos segundos.`;
  }
  return footer;
}

export default {
  command: ['waifusboard', 'waifustop', 'topwaifus', 'wtop'],
  category: 'gacha',
  description: 'Ver el top de personajes con mayor valor del grupo.',
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

      const { index } = await loadCharacters();
      const allStats = await loadAllStats();
      const owned = buildOwnedMap({ chatId, allStats, index });

      const ranking = buildRanking({ chatId, chat, allStats, index, owned });

      if (ranking.length === 0) {
        return msg.reply(`ꕥ Todavía no hay personajes en el ranking de este grupo.\n> Aquí cuentan los personajes que salieron en el *${usedPrefix}rw* o que fueron reclamados.`);
      }

      const page = args.length ? parseInt(args[0]) : 1;
      const totalPages = Math.max(1, Math.ceil(ranking.length / PER_PAGE));

      if (page < 1 || page > totalPages) {
        return msg.reply(`ꕥ Página no válida. Hay un total de *${totalPages}* páginas.`);
      }

      const startRank = (page - 1) * PER_PAGE + 1;
      const slice = ranking.slice(startRank - 1, startRank - 1 + PER_PAGE);

      if (page > 1) {
        const text = composeText(entryLines(slice, startRank, true), buildFooter({ page, totalPages, usedPrefix, command, anyPending: false }));
        return sock && typeof sock.sendMessage === 'function'
          ? sock.sendMessage(chatId, { text: text.trim() }, { quoted: msg })
          : msg.reply(text.trim());
      }

      const top = slice.slice(0, TOP_IMAGE_COUNT);
      const rest = slice.slice(TOP_IMAGE_COUNT);

      let anyPending = false;
      let sent = false;

      try {
        const images = await loadThumbs(top);
        top.forEach((item, i) => {
          item.img = images[i];
          item.pending = !images[i] && inflight.has(thumbKey(item));
          item.ownerText = ownerLabel(item);
        });
        anyPending = top.some(i => i.pending);

        const renderKey = hashKey(JSON.stringify([
          ranking.length, usedPrefix, command,
          top.map(i => [i.id, i.name, i.value, i.rarity.name, i.age, i.ownerText, !!i.img])
        ]));

        let buffer = anyPending ? null : getRender(renderKey);
        if (!buffer) {
          buffer = await generateTopImage({ items: top, total: ranking.length, usedPrefix, command });
          if (!anyPending) setRender(renderKey, buffer);
        }

        const footer = buildFooter({ page, totalPages, usedPrefix, command, anyPending });
        let caption = composeText(rest.length ? entryLines(rest, startRank + TOP_IMAGE_COUNT, true) : '', footer);
        if (caption.length > CAPTION_LIMIT) {
          caption = composeText(rest.length ? entryLines(rest, startRank + TOP_IMAGE_COUNT, false) : '', footer);
        }

        await sock.sendMessage(chatId, { image: buffer, mimetype: 'image/jpeg', caption: caption.trim() }, { quoted: msg });
        sent = true;
      } catch {
        sent = false;
      }

      if (!sent) {
        const text = composeText(entryLines(slice, startRank, true), buildFooter({ page, totalPages, usedPrefix, command, anyPending: false }));
        await msg.reply(text.trim());
      }
    } catch (e) {
      await msg.reply(`> Ocurrió un error al ejecutar *${usedPrefix + command}*.\n> [Error: *${e.message}*]`);
    }
  }
};
