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
const DANBOORU_URL = 'https://danbooru.donmai.us/posts.json';
const MIN_IMAGE_SIDE = 150;
const MAX_ASPECT = 3;
const TRY_URLS_LIMIT = 12;
const SERIES_CAST_TTL_MS = 6 * 60 * 60 * 1000;
const SERIES_CAST_RETRY_MS = 10 * 60 * 1000;
const SERIES_CAST_MAX_PAGES = 4;

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
  [/\bandroide\b/g, 'android'],
  [/\bmaestro\b/g, 'master'],
  [/\babuela\b/g, 'granny'],
  [/\bcapitan\b/g, 'captain'],
  [/\bprincipe\b/g, 'prince'],
  [/\bprincesa\b/g, 'princess'],
  [/\breina\b/g, 'queen'],
  [/\brey\b/g, 'king'],
  [/\bdiosa\b/g, 'goddess'],
  [/\bdios\b/g, 'god']
];

function aliasVariants(name) {
  const base = normalizeStr(name);
  const variants = new Set();
  let all = base;
  for (const [pattern, replacement] of NAME_ALIASES) {
    const replaced = base.replace(pattern, replacement);
    if (replaced !== base) variants.add(replaced);
    all = all.replace(pattern, replacement);
  }
  if (all !== base) variants.add(all);
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

function getRarityGlow(rarityName, isFavorite = false) {
  if (isFavorite) {
    return { shadow: '#FF0033', stroke: '#FF1A1A', blur: 50, width: 5.5 };
  }

  const name = rarityName.toLowerCase();

  if (name.includes('mítico') || name.includes('mitico')) return { shadow: '#800080', stroke: '#FFD700', blur: 30, width: 4 };
  if (name.includes('legendario') || name.includes('leyenda')) return { shadow: '#FFD700', stroke: '#FFD700', blur: 22, width: 3.5 };
  if (name.includes('épico') || name.includes('epico') || name.includes('especial')) return { shadow: '#800080', stroke: '#800080', blur: 16, width: 3 };
  if (name.includes('raro')) return { shadow: '#0000FF', stroke: '#0000FF', blur: 8, width: 2 };
  if (name.includes('poco')) return { shadow: '#0000FF', stroke: '#FFFFFF', blur: 4, width: 1.5 };

  return { shadow: 'transparent', stroke: '#8f8ea8', blur: 0, width: 1 };
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

const limitEvo = createLimiter(3);

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

function uniqueNames(list) {
  const seen = new Set();
  const out = [];
  for (const n of list) {
    const key = normalizeStr(n);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

async function searchAnilist(nombre, serie, extraNames = []) {
  const hasSeries = serie && serie !== 'Desconocido';
  if (!hasSeries) return { urls: [], unavailable: false };
  if (Date.now() < anilistBlockedUntil) return { urls: [], unavailable: true };

  const cleanName = nombre.replace(/\s*\(.*?\)\s*/g, '').trim();
  const alias = (nombre.match(/\(([^)]+)\)/) || [])[1] || '';
  const keywords = extraNames.map(k => String(k).replace(/[_-]+/g, ' ').trim());
  const names = uniqueNames([
    cleanName,
    ...aliasVariants(cleanName),
    alias,
    ...aliasVariants(alias),
    ...keywords
  ]);
  const targets = names.map(n => nameTokens(n)).filter(tokens => tokens.length);
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
  return { urls: [], unavailable: unavailable || Date.now() < anilistBlockedUntil };
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

async function fetchDanbooru(tags) {
  const q = encodeURIComponent(tags);
  const data = await getJson(`${DANBOORU_URL}?limit=40&tags=${q}`);
  if (!Array.isArray(data)) return [];
  return data
    .filter(p => /^(jpe?g|png|webp)$/i.test(String(p?.file_ext || '')) && (p?.large_file_url || p?.file_url))
    .map(p => ({
      url: p.large_file_url || p.file_url,
      score: scoreBooruPost({ tags: p.tag_string, width: p.image_width, height: p.image_height, score: p.score })
    }));
}

function mergeRanked(results, limit = 15) {
  const merged = new Map();
  for (const { priority, posts } of results) {
    for (const post of posts) {
      const score = post.score + priority * 0.25;
      const previous = merged.get(post.url);
      if (previous === undefined || score > previous) merged.set(post.url, score);
    }
  }
  return [...merged.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([url]) => url);
}

function booruBases(nameTags, seriesTag) {
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
  return bases;
}

async function searchBooru(nameTags, seriesTag) {
  const bases = booruBases(nameTags, seriesTag);
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

    const urls = mergeRanked(results);
    if (urls.length) return urls;
  }
  return [];
}

async function searchDanbooru(nameTags, seriesTag) {
  const queries = [...new Set(booruBases(nameTags, seriesTag))]
    .slice(0, 6)
    .map(b => `${b} rating:general`);

  for (let i = 0; i < queries.length; i += 3) {
    const wave = queries.slice(i, i + 3);
    const results = await Promise.all(wave.map(async (tags, offset) => ({
      priority: queries.length - (i + offset),
      posts: await fetchDanbooru(tags).catch(() => [])
    })));

    const urls = mergeRanked(results);
    if (urls.length) return urls;
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
  const nameTokenLists = names.map(n => nameTokens(n)).filter(tokens => tokens.length);
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
      requests.push(limitEvo(() => getJson(ep, 4500)).then(parseImageEntries).catch(() => []));
    }
  }

  const results = await Promise.all(requests);
  return rankEntries(results.flat(), [name, alt].filter(Boolean), series).slice(0, 24);
}

async function* buscarImagenPersonaje(nombre, serie, extraNames = [], allowEvo = true) {
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
  if (booru.length) yield booru;

  const danbooru = await searchDanbooru(nameTags, seriesTag);
  if (danbooru.length) yield danbooru;

  if (!USE_EVO_FALLBACK || !allowEvo) return;
  const evo = await searchEvo(cleanName, seriesClean, alias || aliasVariants(cleanName)[0] || '');
  if (evo.length) yield evo;
}

function getRefererForUrl(url) {
  if (url.includes('safebooru.org')) return 'https://safebooru.org/';
  if (url.includes('donmai.us')) return 'https://danbooru.donmai.us/';
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
    const tasks = urls.map(u => downloadThumb(u, ctrl.signal).catch(() => null));
    for (const task of tasks) {
      const buf = await task;
      if (buf) return buf;
    }
    return null;
  } finally {
    ctrl.abort();
  }
}

async function fetchThumb(item) {
  const tried = new Set();

  const tryUrls = async urls => {
    const fresh = urls.filter(u => !tried.has(u)).slice(0, TRY_URLS_LIMIT);
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
    if (buf) return { buf, transient: false };
  }

  const extraNames = item.keyword ? [item.keyword] : [];

  const anilist = await searchAnilist(item.name, item.series, extraNames);
  if (anilist.urls.length) {
    const buf = await tryUrls(anilist.urls);
    if (buf) return { buf, transient: false };
  }

  for await (const urls of buscarImagenPersonaje(item.name, item.series, extraNames, !anilist.unavailable)) {
    const buf = await tryUrls(urls);
    if (buf) return { buf, transient: false };
  }

  return { buf: null, transient: anilist.unavailable };
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

      const result = await fetchThumb(item);
      if (result.buf) {
        missCache.delete(key);
        rememberThumb(key, result.buf);
        persistThumb(key, result.buf);
        return result.buf;
      }
      if (!result.transient) missCache.set(key, Date.now());
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

function drawHeart(ctx, cx, cy, size) {
  ctx.beginPath();
  ctx.moveTo(cx, cy + size * 0.6);
  ctx.bezierCurveTo(cx - size * 1.2, cy - size * 0.1, cx - size * 0.6, cy - size * 0.9, cx, cy - size * 0.3);
  ctx.bezierCurveTo(cx + size * 0.6, cy - size * 0.9, cx + size * 1.2, cy - size * 0.1, cx, cy + size * 0.6);
  ctx.closePath();
}

async function generateAlbumImage({ userName, totalCards, netValue, page, totalPages, items, usedPrefix, command }) {
  const width = 1000;
  const height = 650;
  const perPage = 10;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  const bgGradient = ctx.createLinearGradient(0, 0, 0, height);
  bgGradient.addColorStop(0, '#0f0e1e');
  bgGradient.addColorStop(1, '#1b1834');
  ctx.fillStyle = bgGradient;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 32px sans-serif';
  ctx.fillText(`TU ÁLBUM (${userName.toUpperCase()})`, 40, 55);

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
  ctx.fillText('CARTAS', 65, 105);
  ctx.fillText('VALOR NETO', 220, 105);

  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 24px sans-serif';
  ctx.fillText(`${totalCards}`, 65, 135);

  ctx.fillStyle = '#ffd700';
  ctx.fillText(`$${netValue.toLocaleString()}`, 220, 135);

  const columns = 5;
  const cardW = 160;
  const cardH = 200;
  const startX = 40;
  const startY = 175;
  const gapX = 30;
  const gapY = 20;

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
    const glow = getRarityGlow(item.rarity.name, item.isFavorite);
    ctx.shadowColor = glow.shadow;
    ctx.shadowBlur = glow.blur;
    ctx.strokeStyle = glow.stroke;
    ctx.lineWidth = glow.width;
    drawRoundedRect(ctx, imgX, imgY, imgSize, imgSize, 8);
    ctx.stroke();
    ctx.restore();

    if (item.isFavorite) {
      ctx.save();
      ctx.fillStyle = '#FF0033';
      ctx.beginPath();
      ctx.arc(imgX + imgSize - 14, imgY + 14, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#FFFFFF';
      drawHeart(ctx, imgX + imgSize - 14, imgY + 14, 6);
      ctx.fill();
      ctx.restore();
    }

    const globalIdx = (page - 1) * perPage + i + 1;
    ctx.fillStyle = 'rgba(0,0,0,0.67)';
    drawRoundedRect(ctx, imgX + 6, imgY + 6, 28, 22, 6);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${globalIdx}`, imgX + 20, imgY + 21);
    ctx.textAlign = 'left';

    const shortName = safeText(item.name.replace(/\s*\(.*?\)\s*/g, ' '), 'Personaje');
    const truncatedName = shortName.length > 15 ? shortName.substring(0, 13) + '..' : shortName;
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText(truncatedName, x + 10, y + 168);

    ctx.fillStyle = RARITY_COLORS[item.rarity.name] || '#f59e0b';
    ctx.beginPath();
    ctx.arc(x + 15, y + 184, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#a6a4ce';
    ctx.font = 'bold 12px sans-serif';
    ctx.fillText(`$${item.value.toLocaleString()}`, x + 26, y + 188);
  }

  ctx.fillStyle = '#535075';
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`Usa "${usedPrefix}${command} <página>" para navegar entre las páginas.`, width / 2, height - 15);

  return canvas.encode('jpeg', 90);
}

export default {
  command: ['harem', 'waifus', 'claims', 'album'],
  category: 'gacha',
  description: 'Ver tus personajes reclamados.',
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

      const userId = msg.mentionedJid?.[0] || msg.quoted?.sender || msg.sender;
      const userGlobal = db.getUser ? db.getUser(userId) : db.data.users?.[userId];
      const name = userGlobal?.name?.trim() || userId.split('@')[0];

      const [{ index }, allStats] = await Promise.all([
        loadCharacters(),
        loadAllStats()
      ]);

      const chatUser = (db.getChatUser ? db.getChatUser(chatId, userId) : db.data.chat_users?.[chatId]?.[userId]) || {};
      let userCharacters = chatUser.characters || [];
      if (typeof userCharacters === 'string') {
        try { userCharacters = JSON.parse(userCharacters); } catch { userCharacters = []; }
      }
      if (!Array.isArray(userCharacters)) userCharacters = [];

      let userFavorites = chatUser.favorites || chatUser.favorite || userGlobal?.favorites || userGlobal?.favorite || [];
      if (typeof userFavorites === 'string') {
        try { userFavorites = JSON.parse(userFavorites); } catch { userFavorites = userFavorites ? [userFavorites] : []; }
      }
      if (!Array.isArray(userFavorites)) userFavorites = userFavorites ? [userFavorites] : [];

      const chatPrefix = chatId + '__';
      const favoriteSet = new Set();
      for (const f of userFavorites) {
        const raw = String(f);
        favoriteSet.add(raw.startsWith(chatPrefix) ? raw.slice(chatPrefix.length) : raw);
      }

      const ownedRaw = new Set();
      const addOwned = entry => {
        let id = entry && typeof entry === 'object' ? (entry.id || entry.keyword || entry.name) : entry;
        id = String(id ?? '').trim();
        if (!id) return;
        if (id.startsWith(chatPrefix)) id = id.slice(chatPrefix.length);
        ownedRaw.add(id);
      };

      userCharacters.forEach(addOwned);

      for (const [key, stat] of Object.entries(allStats)) {
        if (!key.startsWith(chatPrefix)) continue;
        if (stat?.user === userId || stat?.owner === userId || stat?.claimedBy === userId || stat?.claimed === userId) {
          addOwned(key.slice(chatPrefix.length));
        }
      }

      if (ownedRaw.size === 0) {
        const isSelf = userId === msg.sender;
        const replyText = isSelf ? 'ꕥ No tienes personajes reclamados en tu harem.' : `ꕥ *${name}* no tiene personajes reclamados en su harem.`;
        return sock.sendMessage(chatId, { text: replyText, mentions: [userId] }, { quoted: msg });
      }

      const userCards = [];
      const seen = new Set();
      let totalNetValue = 0;

      for (const rawId of ownedRaw) {
        const source = lookupCharacter(index, rawId);
        const id = source?.id || rawId;
        if (seen.has(id)) continue;
        seen.add(id);

        const statKeys = [rawId, source?.id, source?.keyword].filter(Boolean);
        let savedStat = null;
        for (const k of statKeys) {
          if (allStats[chatPrefix + k]) {
            savedStat = allStats[chatPrefix + k];
            break;
          }
        }
        if (!savedStat) savedStat = allStats[rawId] || null;

        const seriesName = source?.source || 'Desconocido';
        const charName = savedStat?.name || source?.name || `ID:${rawId}`;

        const baseValue = Number(savedStat?.value) || Number(source?.price) || Number(source?.value) || 0;
        const rarity = getCharacterRarity(source, savedStat, baseValue);
        const value = resolveValue(baseValue, rarity);

        const imageUrl = source?.image || source?.img || source?.avatar || source?.photo || (Array.isArray(source?.images) && source.images.length ? source.images[0] : null);
        const isFavorite = favoriteSet.has(id) || favoriteSet.has(rawId) || (source?.keyword ? favoriteSet.has(String(source.keyword)) : false);

        totalNetValue += value;
        userCards.push({
          id,
          keyword: source?.keyword || '',
          name: charName,
          value,
          series: seriesName,
          imageUrl: typeof imageUrl === 'string' && /^https?:\/\//i.test(imageUrl) ? imageUrl : null,
          rarity,
          isFavorite
        });
      }

      userCards.sort((a, b) => {
        if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
        if (b.value !== a.value) return b.value - a.value;
        return a.name.localeCompare(b.name);
      });

      const perPage = 10;
      const pageArg = args.find(arg => /^\d{1,4}$/.test(arg));
      const page = pageArg ? parseInt(pageArg) : 1;
      const totalPages = Math.ceil(userCards.length / perPage) || 1;

      if (page < 1 || page > totalPages) {
        return msg.reply(`❀ Página no válida. Hay un total de *${totalPages}* páginas.`);
      }

      const start = (page - 1) * perPage;
      const pageItems = userCards.slice(start, start + perPage);

      const images = await loadThumbs(pageItems);
      pageItems.forEach((item, i) => {
        item.img = images[i];
        item.pending = !images[i] && inflight.has(thumbKey(item));
      });
      const anyPending = pageItems.some(i => i.pending);

      const albumName = safeText(name, userId.split('@')[0]).slice(0, 22);

      const renderKey = hashKey(JSON.stringify([
        albumName, userCards.length, totalNetValue, page, totalPages, usedPrefix, command,
        pageItems.map(i => [i.id, i.name, i.value, i.rarity.name, i.isFavorite, !!i.img])
      ]));

      let buffer = anyPending ? null : getRender(renderKey);
      if (!buffer) {
        buffer = await generateAlbumImage({
          userName: albumName,
          totalCards: userCards.length,
          netValue: totalNetValue,
          page,
          totalPages,
          items: pageItems,
          usedPrefix,
          command
        });
        if (!anyPending) setRender(renderKey, buffer);
      }

      let caption = `✿ *HAREM DE ${name.toUpperCase()}* ✿\n\n`;
      caption += `♡ Personajes en total: *${userCards.length}*\n`;
      caption += `💰 Valor Neto: *$${totalNetValue.toLocaleString()}*\n`;
      caption += `───────────────\n\n`;

      for (let i = 0; i < pageItems.length; i++) {
        const item = pageItems[i];
        const globalIdx = start + i + 1;
        const favIcon = item.isFavorite ? '❤️ ' : '';
        caption += `*${globalIdx}.* ${favIcon}${item.name}\n`;
        caption += `❖ Serie: ${item.series}\n`;
        caption += `✰ Rareza: ${item.rarity.color} ${item.rarity.name}\n`;
        caption += `💰 Valor: $${item.value.toLocaleString()}\n\n`;
      }

      caption += `───────────────\n`;
      caption += `⌦ _Página *${page}* de *${totalPages}*_\n`;

      const nameArgs = args.filter(arg => !/^\d{1,4}$/.test(arg)).join(' ');
      const paginationCmd = nameArgs ? `${usedPrefix}${command} ${nameArgs} ${page + 1}` : `${usedPrefix}${command} ${page + 1}`;

      if (page < totalPages) {
        caption += `> 💡 Escribe *${paginationCmd}* para ver más.`;
      }
      if (anyPending) {
        caption += `\n> ⏳ Algunas imágenes se siguen descargando, usa el comando de nuevo en unos segundos.`;
      }

      await sock.sendMessage(chatId, { image: buffer, mimetype: 'image/jpeg', caption, mentions: [userId] }, { quoted: msg });

      if (page < totalPages) {
        for (const item of userCards.slice(start + perPage, start + perPage * 2)) getThumb(item);
      }
    } catch (e) {
      await msg.reply(`> Ocurrió un error al ejecutar el comando *${usedPrefix + command}*.\n> [Error: *${e.message}*]`);
    }
  }
};
