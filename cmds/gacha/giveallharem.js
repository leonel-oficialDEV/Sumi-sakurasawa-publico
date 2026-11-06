import path from 'path';
import { promises as fs } from 'fs';
import { pathToFileURL } from 'url';
import db from '#db';

const STATS_FILE_PATH = path.join(process.cwd(), 'lib', 'character_stats.json');
const CHARACTERS_FILE_PATH = path.join(process.cwd(), 'lib', 'characters.js');
const CHARACTERS_DIR_PATH = path.join(process.cwd(), 'lib', 'characters');

const SALE_DURATION_MS = 3 * 864e5;
const MIN_PRICE = 100;
const MAX_PRICE = 100000;
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

async function updateStatsBatch(entries, mutate) {
  let json = {};
  try {
    const data = await fs.readFile(STATS_FILE_PATH, 'utf-8');
    json = JSON.parse(data);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  for (const { key, fallback } of entries) {
    json[key] = mutate(json[key] || fallback);
  }
  await fs.writeFile(STATS_FILE_PATH, JSON.stringify(json, null, 2));
}

function readMessageText(msg) {
  const body = typeof msg.text === 'string'
    ? msg.text
    : (msg.body || msg.message?.conversation || msg.message?.extendedTextMessage?.text || '');
  return String(body || '').trim().toLowerCase();
}

export default {
  command: ['giveallharem', 'giveharem'],
  category: 'gacha',
  description: 'Regalar todos tus personajes a otro usuario.',
  before: async ({ msg }) => {
    const pending = global.pendingGiveHarem;
    if (!pending) return;

    const data = pending[msg.sender];
    if (!data || data.chat !== msg.chat) return;

    const answer = readMessageText(msg);
    if (answer !== 'aceptar' && answer !== 'cancelar') return;

    clearTimeout(data.timeout);
    delete pending[msg.sender];

    if (answer === 'cancelar') {
      await msg.reply('❀ Regalo cancelado.');
      return true;
    }

    try {
      if (typeof db.read === 'function') await db.read();
      const chatId = msg.chat;
      const senderId = data.sender;
      const receiverId = data.to;

      ensureDbContainers(chatId);
      const { index } = await loadCharacters();
      const chatPrefix = chatId + '__';
      const canonicalOf = makeCanonicalOf(index, chatPrefix);
      const allStats = await loadAllStats();

      const sender = getChatUserSafe(chatId, senderId);
      const receiver = getChatUserSafe(chatId, receiverId);
      const senderGlobal = getUserSafe(senderId);
      const receiverGlobal = getUserSafe(receiverId);

      const favorites = toList(sender.favorites || sender.favorite || senderGlobal.favorites || senderGlobal.favorite);

      const cards = buildUserCards({
        index,
        allStats,
        chatId,
        userId: senderId,
        characterEntries: toList(sender.characters),
        favoriteEntries: favorites
      });

      if (cards.length === 0) {
        await msg.reply('ꕥ Ya no tienes personajes para regalar.');
        return true;
      }

      const now = Date.now();
      const totalValue = cards.reduce((sum, c) => sum + c.value, 0);
      const giftedIds = new Set(cards.map(c => c.id));

      await updateStatsBatch(
        cards.map(c => ({ key: chatPrefix + c.statId, fallback: { name: c.name, value: c.value, votes: 0 } })),
        stat => {
          const next = {
            ...stat,
            user: receiverId,
            owner: receiverId,
            claimedBy: receiverId,
            claimedAt: now
          };
          delete next.reservedBy;
          delete next.reservedUntil;
          return next;
        }
      );

      const receiverList = toList(receiver.characters);
      const receiverHas = new Set(receiverList.map(canonicalOf));
      const newReceiverList = [...receiverList];
      for (const c of cards) {
        if (!receiverHas.has(c.id)) {
          newReceiverList.push(c.rawId);
          receiverHas.add(c.id);
        }
      }

      const newSenderList = toList(sender.characters).filter(entry => !giftedIds.has(canonicalOf(entry)));
      const newFavorites = favorites.filter(entry => !giftedIds.has(canonicalOf(entry)));

      saveChatUserField(chatId, senderId, 'characters', newSenderList);
      saveChatUserField(chatId, receiverId, 'characters', newReceiverList);
      if (newFavorites.length !== favorites.length) {
        saveChatUserField(chatId, senderId, 'favorites', newFavorites);
        saveUserField(senderId, 'favorites', newFavorites);
      }

      if (db.getCharacter && db.setCharacter) {
        for (const c of cards) {
          const charKey = chatPrefix + c.statId;
          const cData = db.getCharacter(charKey);
          if (!cData) continue;
          cData.user = receiverId;
          cData.owner = receiverId;
          cData.claimedBy = receiverId;
          cData.claimedAt = now;
          db.setCharacter(charKey, cData);
        }
      }

      if (typeof db.write === 'function') await db.write();

      const name = receiverGlobal.name?.trim() || receiverId.split('@')[0];

      await msg.reply(`「✿」 Has regalado con éxito todos tus personajes a *${name}*!\n\n> ❏ Personajes regalados: *${cards.length}*\n> ⴵ Valor total: *${totalValue.toLocaleString()}*`);
    } catch (e) {
      await msg.reply(`⚠︎ Se ha producido un problema.\n> [Error: *${e.message}*]`);
    }
    return true;
  },
  run: async ({ msg, sock, usedPrefix, command }) => {
    try {
      if (typeof db.read === 'function') await db.read();
      const chatId = msg.chat;
      const senderId = msg.sender;

      ensureDbContainers(chatId);
      const chat = db.getChat ? db.getChat(chatId) : db.data.chats[chatId];
      if (chat?.adminonly || !chat?.gacha) {
        return msg.reply(`ꕥ Los comandos de *Gacha* están desactivados en este grupo.\n\nUn *administrador* puede activarlos con el comando:\n» *${usedPrefix}gacha on*`);
      }

      const targetId = msg.mentionedJid?.[0] || msg.quoted?.sender || null;
      if (!targetId) return msg.reply('❀ Debes mencionar a quien quieras regalarle tus personajes.');
      if (targetId === senderId) return msg.reply('ꕥ No puedes regalarte personajes a ti mismo.');

      const rawTarget = db.getChatUser ? db.getChatUser(chatId, targetId) : db.data.chat_users?.[chatId]?.[targetId];
      if (!rawTarget) {
        return msg.reply('「✎」 El usuario mencionado no está registrado en el bot.');
      }

      const { index } = await loadCharacters();
      const allStats = await loadAllStats();

      const sender = getChatUserSafe(chatId, senderId);
      const senderGlobal = getUserSafe(senderId);
      const targetGlobal = getUserSafe(targetId);
      const favorites = toList(sender.favorites || sender.favorite || senderGlobal.favorites || senderGlobal.favorite);

      const cards = buildUserCards({
        index,
        allStats,
        chatId,
        userId: senderId,
        characterEntries: toList(sender.characters),
        favoriteEntries: favorites
      });

      if (cards.length === 0) {
        return msg.reply('ꕥ No tienes personajes para regalar.');
      }

      const totalValue = cards.reduce((sum, c) => sum + c.value, 0);

      const nameSender = senderGlobal.name?.trim() || senderId.split('@')[0];
      const nameTarget = targetGlobal.name?.trim() || targetId.split('@')[0];

      const confirmText = `「✿」 *${nameSender}*, ¿confirmas regalar todo tu harem a *${nameTarget}*?\n\n❏ Personajes a transferir: *${cards.length}*\n❏ Valor total: *${totalValue.toLocaleString()}*\n\n✐ Para confirmar responde con *aceptar* (o *cancelar*). Tienes 60 segundos.\n> Esta acción no se puede deshacer.`;

      if (typeof sock.reply === 'function') {
        await sock.reply(chatId, confirmText, msg, { mentions: [targetId] });
      } else {
        await sock.sendMessage(chatId, { text: confirmText, mentions: [targetId] }, { quoted: msg });
      }

      global.pendingGiveHarem = global.pendingGiveHarem || {};
      const previous = global.pendingGiveHarem[senderId];
      if (previous?.timeout) clearTimeout(previous.timeout);

      const timeout = setTimeout(() => {
        const current = global.pendingGiveHarem?.[senderId];
        if (current && current.timeout === timeout) delete global.pendingGiveHarem[senderId];
      }, 60000);
      if (typeof timeout.unref === 'function') timeout.unref();

      global.pendingGiveHarem[senderId] = {
        sender: senderId,
        to: targetId,
        chat: chatId,
        timeout
      };
    } catch (e) {
      return msg.reply(`> Ocurrió un error al ejecutar el comando *${usedPrefix + command}*.\n> [Error: *${e.message}*]`);
    }
  }
};
