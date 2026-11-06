import path from 'path';
import { promises as fs } from 'fs';
import { pathToFileURL } from 'url';
import db from '#db';

const STATS_FILE_PATH = path.join(process.cwd(), 'lib', 'character_stats.json');
const CHARACTERS_FILE_PATH = path.join(process.cwd(), 'lib', 'characters.js');
const CHARACTERS_DIR_PATH = path.join(process.cwd(), 'lib', 'characters');

const SALE_DURATION_MS = 3 * 864e5;
const MIN_PRICE = 100;
const MAX_PRICE_MULTIPLIER = 2;
const FEE_RATE = 0.05;
const MAX_LISTINGS_PER_USER = 5;

const charactersCache = { signature: '', list: [], index: new Map() };

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

function normalizeStr(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
    if (charactersCache.list.length && charactersCache.signature === signature) {
      return charactersCache;
    }
    const module = await import(`${pathToFileURL(CHARACTERS_FILE_PATH).href}?update=${signature}`);
    const raw = module.default || module.characters || module.data || module;
    const list = flattenCharacters(raw);
    charactersCache.signature = signature;
    charactersCache.list = list;
    charactersCache.index = buildIndex(list);
    return charactersCache;
  } catch {
    return { signature: '', list: [], index: new Map() };
  }
}

async function loadAllStats() {
  try {
    const data = await fs.readFile(STATS_FILE_PATH, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
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

function setCoins(chatId, userId, amount) {
  saveChatUserField(chatId, userId, 'coins', amount);
  saveUserField(userId, 'coins', amount);
}

export default {
  command: ['buyc', 'buycharacter', 'buychar'],
  category: 'gacha',
  description: 'Comprar un personaje en venta.',
  run: async ({ msg, sock, args, usedPrefix, command }) => {
    try {
      if (typeof db.read === 'function') await db.read();
      const chatId = msg.chat;
      const userId = msg.sender;

      ensureDbContainers(chatId);
      const chat = db.getChat(msg.chat);
      if (chat?.adminonly || !chat?.gacha) {
        return msg.reply(`ꕥ Los comandos de *Gacha* están desactivados en este grupo.\n\nUn *administrador* puede activarlos con el comando:\n» *${usedPrefix}gacha on*`);
      }

      if (!args.length) {
        return msg.reply(`❀ Debes especificar un personaje para comprar (nombre o número de la tienda).\n> Ejemplos:\n> ${usedPrefix + command} Elaina\n> ${usedPrefix + command} 2`);
      }

      const input = args.join(' ').trim();
      const { index } = await loadCharacters();
      const chatPrefix = chatId + '__';
      const canonicalOf = makeCanonicalOf(index, chatPrefix);
      const now = Date.now();

      if (await processExpired({ chat, chatId, now, index })) {
        await persistShop(chatId, chat);
      }

      const listings = getShopListings(chat);

      if (listings.length === 0) {
        return msg.reply(`ꕥ No hay personajes en venta en este grupo en este momento.\n> Revisa la tienda con *${usedPrefix}wshop*`);
      }

      let listing = null;

      if (/^#?\d+$/.test(input)) {
        const number = parseInt(input.replace('#', ''));
        if (number < 1 || number > listings.length) {
          return msg.reply(`ꕥ Número no válido. Hay *${listings.length}* personaje${listings.length !== 1 ? 's' : ''} en venta.\n> Mira los números con *${usedPrefix}wshop*`);
        }
        listing = listings[number - 1];
      } else {
        const pseudoCards = listings.map(l => ({
          name: l.item.name || '',
          id: l.item.charId || l.item.id || '',
          keyword: '',
          rawId: l.item.charId || l.item.id || '',
          listing: l
        }));
        const matches = findCards(pseudoCards, input);

        if (matches.length === 0) {
          return msg.reply(`ꕥ No se ha encontrado al personaje *${input}* en venta en este grupo.`);
        }

        if (matches.length > 1) {
          const lines = matches.slice(0, 8).map(p => `» *${listings.indexOf(p.listing) + 1}.* ${p.name} — ¥${Number(p.listing.item.price).toLocaleString()}`).join('\n');
          const extra = matches.length > 8 ? `\n… y *${matches.length - 8}* más.` : '';
          return msg.reply(`ꕥ Hay varios personajes en venta que coinciden con *${input}*:\n\n${lines}${extra}\n\n> Usa el número de la tienda, por ejemplo: *${usedPrefix + command} ${listings.indexOf(matches[0].listing) + 1}*`);
        }

        listing = matches[0].listing;
      }

      const item = listing.item;
      const isNpc = listing.kind === 'npc';
      const price = Number(item.price);

      if (!Number.isFinite(price) || price <= 0) {
        return msg.reply(`ꕥ Esta venta tiene un precio no válido y no se puede comprar.`);
      }

      if (!isNpc && item.user === userId) {
        return msg.reply(`ꕥ No puedes comprar tu propio personaje.`);
      }

      let charId = item.charId || (isNpc ? '' : item.id);
      if (!charId) {
        const source = lookupCharacter(index, item.name);
        charId = source ? (source.keyword || source.id) : normalizeStr(item.name).replace(/\s+/g, '_');
      }
      const canonical = canonicalOf(charId);

      const allStats = await loadAllStats();
      const owned = buildOwnedMap({ chatId, allStats, index });
      const currentOwner = owned.get(canonical);

      if (currentOwner && currentOwner !== (isNpc ? null : item.user)) {
        if (isNpc) {
          chat.npcs = chat.npcs.filter(n => n && n.id !== item.id);
        } else {
          delete chat.sales[listing.key];
        }
        await persistShop(chatId, chat);
        return msg.reply(`ꕥ *${item.name}* ya fue reclamado por otra persona, así que esa venta se canceló.`);
      }

      const buyerChatUser = getChatUserSafe(chatId, userId);
      const buyerGlobal = getUserSafe(userId);

      const saldo = Number(buyerChatUser.coins ?? buyerGlobal.coins ?? 0);
      const botId = sock?.user?.id ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : '';
      const settings = (db.getSettings ? db.getSettings(botId) : {}) || {};
      const currency = settings.currency || 'coins';

      if (saldo < price) {
        return msg.reply(`ꕥ No tienes suficientes *${currency}* para comprar a *${item.name}*.\n> Tienes: ¥${saldo.toLocaleString()}\n> Necesitas: ¥${price.toLocaleString()}`);
      }

      const statKey = chatPrefix + (item.statId || charId);
      const baseValue = Number(item.value) || 100;

      await updateStat(
        statKey,
        { name: item.name, value: baseValue, votes: 0 },
        stat => {
          const next = {
            ...stat,
            value: baseValue,
            user: userId,
            owner: userId,
            claimedBy: userId,
            claimedAt: now
          };
          delete next.reservedBy;
          delete next.reservedUntil;
          return next;
        }
      );

      setCoins(chatId, userId, saldo - price);

      const buyerCharacters = toList(buyerChatUser.characters);
      if (!buyerCharacters.some(entry => canonicalOf(entry) === canonical)) {
        saveChatUserField(chatId, userId, 'characters', [...buyerCharacters, charId]);
      }

      let sellerProceeds = 0;
      if (!isNpc && item.user) {
        const fee = Math.min(Number(item.fee) || 0, price);
        sellerProceeds = price - fee;
        const sellerChatUser = getChatUserSafe(chatId, item.user);
        const sellerGlobal = getUserSafe(item.user);
        const sellerSaldo = Number(sellerChatUser.coins ?? sellerGlobal.coins ?? 0) + sellerProceeds;
        setCoins(chatId, item.user, sellerSaldo);
      }

      if (isNpc) {
        chat.npcs = chat.npcs.filter(n => n && n.id !== item.id);
      } else {
        delete chat.sales[listing.key];
      }

      await persistShop(chatId, chat);

      const compradorNombre = buyerGlobal.name?.trim() || userId.split('@')[0];

      if (!isNpc && item.user) {
        const vendedorGlobal = getUserSafe(item.user);
        const vendedorNombre = vendedorGlobal.name?.trim() || String(item.user).split('@')[0];
        const feeText = Number(item.fee) > 0 ? ` (comisión: ¥${Math.min(Number(item.fee), price).toLocaleString()})` : '';
        return msg.reply(`❀ *${item.name}* ha sido comprado por *${compradorNombre}*, eliminado de la tienda y añadido a tu harem con éxito!\n> Se han transferido *¥${sellerProceeds.toLocaleString()} ${currency}* a *${vendedorNombre}*${feeText}`);
      }

      return msg.reply(`❀ *${item.name}* ha sido comprado por *${compradorNombre}*, eliminado de la tienda y añadido a tu harem con éxito!`);
    } catch (e) {
      await msg.reply(`> Ocurrió un error al ejecutar *${usedPrefix + command}*.\n> [Error: *${e.message}*]`);
    }
  }
};
