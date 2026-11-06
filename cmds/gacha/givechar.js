import path from 'path';
import { promises as fs } from 'fs';
import { pathToFileURL } from 'url';
import db from '#db';

const STATS_FILE_PATH = path.join(process.cwd(), 'lib', 'character_stats.json');
const CHARACTERS_FILE_PATH = path.join(process.cwd(), 'lib', 'characters.js');
const CHARACTERS_DIR_PATH = path.join(process.cwd(), 'lib', 'characters');

const charactersCache = { signature: '', list: [], index: new Map() };

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
  if (val >= 5000) return { name: 'Mítico' };
  if (val >= 2500) return { name: 'Legendario' };
  if (val >= 1000) return { name: 'Épico' };
  if (val >= 500) return { name: 'Raro' };
  if (val >= 200) return { name: 'Poco Común' };
  return { name: 'Común' };
}

function getCharacterRarity(character, chatChar, baseValue) {
  const rawRarity = chatChar?.rareza || chatChar?.rarity || chatChar?.clase || character?.rareza || character?.rarity || character?.clase || character?.tier;

  if (rawRarity) {
    const cleanRar = String(rawRarity).trim();
    const lowerRar = cleanRar.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    if (lowerRar.includes('secreto') || lowerRar.includes('mitico')) return { name: 'Mítico' };
    if (lowerRar.includes('legendario') || lowerRar.includes('leyenda')) return { name: 'Legendario' };
    if (lowerRar.includes('epico') || lowerRar.includes('especial')) return { name: 'Épico' };
    if (lowerRar.includes('raro')) return { name: 'Raro' };
    if (lowerRar.includes('poco')) return { name: 'Poco Común' };
    if (lowerRar.includes('comun')) return { name: 'Común' };
    return { name: cleanRar };
  }

  return getRarityByValue(baseValue || 100);
}

function resolveValue(baseValue, rarity) {
  const range = RARITY_RANGE[rarity.name];
  if (!range) return baseValue || 100;
  if (baseValue >= range[0] && baseValue <= range[1]) return baseValue;
  return Math.round((range[0] + range[1]) / 2 / 10) * 10;
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
      rarityName: rarity.name,
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
    const fullName = normalizeStr(card.name);
    const noAlias = normalizeStr(card.name.replace(/\s*\(.*?\)\s*/g, ''));
    const alias = normalizeStr((card.name.match(/\(([^)]+)\)/) || [])[1] || '');
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

export default {
  command: ['givechar', 'givewaifu', 'regalar'],
  category: 'gacha',
  description: 'Regalar un personaje del harem a otro usuario.',
  run: async ({ msg, sock, args, usedPrefix, command }) => {
    try {
      if (typeof db.read === 'function') await db.read();
      const chatId = msg.chat;
      const userId = msg.sender;

      if (!db.data) db.data = {};
      if (!db.data.chats) db.data.chats = {};
      if (!db.data.chats[chatId]) db.data.chats[chatId] = {};

      const chat = db.getChat ? db.getChat(chatId) : db.data.chats[chatId];
      if (chat?.adminonly || !chat?.gacha) {
        return msg.reply(`ꕥ Los comandos de *Gacha* están desactivados en este grupo.\n\nUn *administrador* puede activarlos con el comando:\n» *${usedPrefix}gacha on*`);
      }

      const targetId = msg.mentionedJid?.[0] || msg.quoted?.sender || null;

      const input = args.filter(arg => !arg.startsWith('@')).join(' ').trim();

      if (!input) {
        return msg.reply(`❀ Debes escribir el nombre o el número del personaje (el que sale en *${usedPrefix}harem*) y citar o mencionar al usuario que lo recibirá.\n> Ejemplo » *${usedPrefix + command} 3 @usuario*`);
      }

      if (!targetId) return msg.reply(`❀ Debes mencionar o citar el mensaje del destinatario.`);

      if (targetId === userId) {
        return msg.reply(`ꕥ No puedes regalarte un personaje a ti mismo.`);
      }

      const sender = db.getChatUser ? db.getChatUser(chatId, userId) : db.data.chat_users?.[chatId]?.[userId];
      const target = db.getChatUser ? db.getChatUser(chatId, targetId) : db.data.chat_users?.[chatId]?.[targetId];
      const senderGlobal = (db.getUser ? db.getUser(userId) : db.data.users?.[userId]) || {};
      const targetGlobal = (db.getUser ? db.getUser(targetId) : db.data.users?.[targetId]) || {};

      if (!target) {
        return msg.reply(`「✎」 El usuario mencionado no está registrado en el bot.`);
      }

      const senderCharacters = toList(sender?.characters);
      const targetCharacters = toList(target?.characters);
      const senderFavorites = toList(sender?.favorites || sender?.favorite || senderGlobal.favorites || senderGlobal.favorite);

      const [{ index }, allStats] = await Promise.all([
        loadCharacters(),
        loadAllStats()
      ]);

      const chatPrefix = chatId + '__';

      const cards = buildUserCards({
        index,
        allStats,
        chatId,
        userId,
        characterEntries: senderCharacters,
        favoriteEntries: senderFavorites
      });

      if (cards.length === 0) {
        return msg.reply(`ꕥ No tienes personajes en tu harem.`);
      }

      let card = null;

      if (/^#?\d+$/.test(input)) {
        const number = parseInt(input.replace('#', ''));
        if (number < 1 || number > cards.length) {
          return msg.reply(`ꕥ Número no válido. Tienes *${cards.length}* personaje${cards.length !== 1 ? 's' : ''} en tu harem.`);
        }
        card = cards[number - 1];
      } else {
        const matches = findCards(cards, input);

        if (matches.length === 0) {
          return msg.reply(`ꕥ No se encontró el personaje *${input}* o no está reclamado por ti.`);
        }

        if (matches.length > 1) {
          const lines = matches.slice(0, 8).map(c => `» *${cards.indexOf(c) + 1}.* ${c.name}`).join('\n');
          const extra = matches.length > 8 ? `\n… y *${matches.length - 8}* más.` : '';
          return msg.reply(`ꕥ Hay varios personajes que coinciden con *${input}*:\n\n${lines}${extra}\n\n> Usa el número del harem, por ejemplo: *${usedPrefix + command} ${cards.indexOf(matches[0]) + 1} @usuario*`);
        }

        card = matches[0];
      }

      const canonicalOf = entry => {
        const raw = entryToRaw(entry, chatPrefix);
        const source = lookupCharacter(index, raw);
        return source?.id || raw;
      };

      const charKey = chatPrefix + card.statId;
      const now = Date.now();

      await updateStat(
        charKey,
        { name: card.name, value: card.value, votes: 0 },
        stat => ({
          ...stat,
          name: stat.name || card.name,
          value: Number(stat.value) > 0 ? stat.value : card.value,
          user: targetId,
          owner: targetId,
          claimedBy: targetId,
          claimedAt: now
        })
      );

      const newSenderCharacters = senderCharacters.filter(entry => canonicalOf(entry) !== card.id);
      if (db.updateChatUser) db.updateChatUser(chatId, userId, 'characters', newSenderCharacters);

      if (!targetCharacters.some(entry => canonicalOf(entry) === card.id)) {
        const newTargetCharacters = [...targetCharacters, card.rawId];
        if (db.updateChatUser) db.updateChatUser(chatId, targetId, 'characters', newTargetCharacters);
      }

      if (db.getCharacter && db.setCharacter) {
        let characterData = db.getCharacter(charKey);
        if (!characterData) characterData = { name: card.name, value: card.value, votes: 0 };
        characterData.user = targetId;
        characterData.owner = targetId;
        characterData.claimedBy = targetId;
        characterData.claimedAt = now;
        db.setCharacter(charKey, characterData);
      }

      const newFavorites = senderFavorites.filter(entry => canonicalOf(entry) !== card.id);
      if (newFavorites.length !== senderFavorites.length) {
        if (db.updateChatUser) db.updateChatUser(chatId, userId, 'favorites', newFavorites);
        if (db.updateUser) db.updateUser(userId, 'favorites', newFavorites);
      }

      if (typeof db.write === 'function') await db.write();

      const senderNameStr = senderGlobal?.name?.trim() || userId.split('@')[0];
      const receiverNameStr = targetGlobal?.name?.trim() || targetId.split('@')[0];

      const replyText = `❀ *${card.name}* ha sido regalado a *${receiverNameStr}* por *${senderNameStr}*.`;
      if (typeof sock.reply === 'function') {
        await sock.reply(chatId, replyText, msg, { mentions: [targetId] });
      } else {
        await sock.sendMessage(chatId, { text: replyText, mentions: [targetId] }, { quoted: msg });
      }
    } catch (e) {
      await msg.reply(`> Ocurrió un error al ejecutar el comando *${usedPrefix + command}*.\n> [Error: *${e.message}*]`);
    }
  },
};
