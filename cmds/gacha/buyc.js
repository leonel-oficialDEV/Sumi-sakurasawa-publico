import { promises as fs } from 'fs';
import path from 'path';
import db from '#db';

const STATS_FILE_PATH = path.join(process.cwd(), 'lib', 'character_stats.json');

async function loadCharacters() {
  const filePath = path.join(process.cwd(), 'lib', 'characters.js');
  try {
    const module = await import(`file://${filePath}?update=${Date.now()}`);
    return module.default || module;
  } catch {
    return [];
  }
}

async function getCharacterStat(id) {
  try {
    await fs.access(STATS_FILE_PATH);
  } catch {
    await fs.writeFile(STATS_FILE_PATH, '{}');
  }
  try {
    const data = await fs.readFile(STATS_FILE_PATH, 'utf-8');
    const json = JSON.parse(data);
    return json[id] || null;
  } catch {
    return null;
  }
}

async function setCharacterStat(id, val) {
  let json = {};
  try {
    await fs.access(STATS_FILE_PATH);
    const data = await fs.readFile(STATS_FILE_PATH, 'utf-8');
    json = JSON.parse(data);
  } catch {
    json = {};
  }
  json[id] = val;
  await fs.writeFile(STATS_FILE_PATH, JSON.stringify(json, null, 2));
}

function normalizeStr(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findCharacterInStructure(structure, query) {
  if (!structure) return null;
  const q = normalizeStr(query);
  if (!q) return null;

  let charactersList = [];

  if (Array.isArray(structure)) {
    charactersList = structure;
  } else if (typeof structure === 'object') {
    for (const val of Object.values(structure)) {
      if (Array.isArray(val)) {
        charactersList.push(...val);
      } else if (val && Array.isArray(val.characters)) {
        charactersList.push(...val.characters);
      } else if (val && typeof val === 'object' && val.name) {
        charactersList.push(val);
      }
    }
  }

  const found = charactersList.find(c => {
    const charName = normalizeStr(c?.name);
    const charId = normalizeStr(c?.id || c?.keyword || '').replace(/\s+/g, '_');
    const tags = Array.isArray(c?.tags) ? c.tags.map(normalizeStr) : [];
    const aliases = Array.isArray(c?.aliases) ? c.aliases.map(normalizeStr) : [];

    return charName === q || charName.includes(q) || charId === q || tags.some(t => t === q || t.includes(q)) || aliases.some(a => a === q || a.includes(q));
  });

  if (found) {
    const generatedId = found.id || found.keyword || normalizeStr(found.name).replace(/\s+/g, '_');
    return {
      ...found,
      id: generatedId
    };
  }
  
  return null;
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

      if (!db.data) db.data = {};
      if (!db.data.chats) db.data.chats = {};
      if (!db.data.chats[chatId]) db.data.chats[chatId] = {};
      let chat = db.data.chats[chatId];

      if (chat?.adminonly || chat?.gacha === false) {
        return msg.reply(`ꕥ Los comandos de *Gacha* están desactivados en este grupo.\n\nUn *administrador* puede activarlos con:\n» *${usedPrefix}gacha on*`);
      }

      if (!args.length) {
        return msg.reply(`❀ Debes especificar un personaje para comprar.\n> Ejemplo » *${usedPrefix + command} Elaina*`);
      }

      const queryBuy = args.join(' ');
      const queryNorm = normalizeStr(queryBuy);
      const structure = await loadCharacters();
      const ahora = Date.now();

      if (!chat.sales || typeof chat.sales !== 'object') chat.sales = {};
      if (!Array.isArray(chat.npcs)) chat.npcs = [];

      let foundItem = null;
      let saleKey = null;
      let isNpc = false;

      for (const [key, venta] of Object.entries(chat.sales)) {
        if (!venta) continue;
        const vName = normalizeStr(venta.name);
        const vId = normalizeStr(venta.id || key);
        if (vName === queryNorm || vId === queryNorm || vName.includes(queryNorm)) {
          foundItem = venta;
          saleKey = key;
          isNpc = false;
          break;
        }
      }

      if (!foundItem) {
        const npcIndex = chat.npcs.findIndex(n => {
          if (!n) return false;
          const nName = normalizeStr(n.name);
          const nId = normalizeStr(n.id);
          return nName === queryNorm || nId === queryNorm || nName.includes(queryNorm);
        });
        if (npcIndex !== -1) {
          foundItem = chat.npcs[npcIndex];
          saleKey = npcIndex;
          isNpc = true;
        }
      }

      let sourceData = findCharacterInStructure(structure, queryBuy);
      if (!foundItem && sourceData) {
        const baseVal = Number(sourceData.value) || 4000;
        foundItem = {
          id: sourceData.id,
          name: sourceData.name,
          price: Math.round(baseVal * 1.1),
          value: baseVal,
          user: 'NPC',
          isNpc: true
        };
        isNpc = true;
      }

      if (!foundItem) {
        return msg.reply(`ꕥ No se ha encontrado al personaje *${queryBuy}* en venta en este grupo.`);
      }

      if (!isNpc && foundItem.user === userId) {
        return msg.reply(`ꕥ No puedes comprar tu propio personaje.`);
      }

      if (!sourceData) {
        sourceData = findCharacterInStructure(structure, foundItem.name || foundItem.id);
      }

      const characterId = sourceData?.id || foundItem.id || normalizeStr(foundItem.name).replace(/\s+/g, '_');
      const charKey = chatId + '__' + characterId;

      let chatUser = db.getChatUser ? db.getChatUser(chatId, userId) : db.data.chat_users?.[chatId]?.[userId] || {};
      let globalUser = db.getUser ? db.getUser(userId) : db.data.users?.[userId] || {};

      const saldo = Number(chatUser?.coins ?? globalUser?.coins ?? 0);
      const botId = sock?.user?.id ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : '';
      const settings = db.getSettings ? db.getSettings(botId) : {};
      const currency = settings?.currency || 'coins';

      if (saldo < foundItem.price) {
        return msg.reply(`ꕥ No tienes suficientes *${currency}* para comprar a *${foundItem.name}*.\n> Tienes: ¥${saldo.toLocaleString()}\n> Necesitas: ¥${foundItem.price.toLocaleString()}`);
      }

      const nuevoSaldo = saldo - foundItem.price;
      chatUser.coins = nuevoSaldo;

      if (!db.data.chat_users) db.data.chat_users = {};
      if (!db.data.chat_users[chatId]) db.data.chat_users[chatId] = {};
      if (!db.data.chat_users[chatId][userId]) db.data.chat_users[chatId][userId] = {};
      db.data.chat_users[chatId][userId].coins = nuevoSaldo;

      if (!db.data.users) db.data.users = {};
      if (!db.data.users[userId]) db.data.users[userId] = {};
      db.data.users[userId].coins = nuevoSaldo;

      if (typeof db.updateChatUser === 'function') {
        db.updateChatUser(chatId, userId, 'coins', nuevoSaldo);
      }
      if (typeof db.updateUser === 'function') {
        db.updateUser(userId, 'coins', nuevoSaldo);
      }

      let characterStat = await getCharacterStat(charKey);
      if (!characterStat) {
        characterStat = { name: foundItem.name, value: foundItem.value || sourceData?.value || 100, votes: 0 };
      }
      characterStat.user = userId;
      characterStat.claimedAt = ahora;
      delete characterStat.reservedBy;
      delete characterStat.reservedUntil;
      await setCharacterStat(charKey, characterStat);

      let userCharacters = chatUser.characters || db.data.chat_users[chatId][userId].characters || [];
      if (typeof userCharacters === 'string') {
        try { userCharacters = JSON.parse(userCharacters); } catch { userCharacters = []; }
      }
      if (!Array.isArray(userCharacters)) userCharacters = [];

      if (!userCharacters.includes(characterId)) {
        userCharacters.push(characterId);
      }
      chatUser.characters = userCharacters;
      db.data.chat_users[chatId][userId].characters = userCharacters;

      if (typeof db.setCreate === 'function') {
        db.setCreate('chat_users', [chatId, userId], 'characters', userCharacters);
      }

      if (!isNpc && foundItem.user && foundItem.user !== userId) {
        let seller = db.getChatUser ? db.getChatUser(chatId, foundItem.user) : db.data.chat_users?.[chatId]?.[foundItem.user] || {};
        let sellerGlobal = db.getUser ? db.getUser(foundItem.user) : db.data.users?.[foundItem.user] || {};
        const sellerSaldo = Number(seller?.coins ?? sellerGlobal?.coins ?? 0) + foundItem.price;

        seller.coins = sellerSaldo;

        if (!db.data.chat_users[chatId][foundItem.user]) db.data.chat_users[chatId][foundItem.user] = {};
        db.data.chat_users[chatId][foundItem.user].coins = sellerSaldo;

        if (!db.data.users[foundItem.user]) db.data.users[foundItem.user] = {};
        db.data.users[foundItem.user].coins = sellerSaldo;

        if (typeof db.updateChatUser === 'function') {
          db.updateChatUser(chatId, foundItem.user, 'coins', sellerSaldo);
        }
        if (typeof db.updateUser === 'function') {
          db.updateUser(foundItem.user, 'coins', sellerSaldo);
        }

        let sellerCharacters = seller.characters || db.data.chat_users[chatId][foundItem.user].characters || [];
        if (typeof sellerCharacters === 'string') {
          try { sellerCharacters = JSON.parse(sellerCharacters); } catch { sellerCharacters = []; }
        }
        if (Array.isArray(sellerCharacters)) {
          sellerCharacters = sellerCharacters.filter(id => id !== characterId && id !== foundItem.id);
          seller.characters = sellerCharacters;
          db.data.chat_users[chatId][foundItem.user].characters = sellerCharacters;

          if (typeof db.setCreate === 'function') {
            db.setCreate('chat_users', [chatId, foundItem.user], 'characters', sellerCharacters);
          }
        }

        if (seller.favorite === characterId || seller.favorite === foundItem.id) {
          seller.favorite = '';
          db.data.chat_users[chatId][foundItem.user].favorite = '';
          if (typeof db.setCreate === 'function') {
            db.setCreate('chat_users', [chatId, foundItem.user], 'favorite', '');
          }
        }
      }

      if (isNpc) {
        if (foundItem.id && Array.isArray(chat.npcs)) {
          chat.npcs = chat.npcs.filter(n => n && n.id !== foundItem.id);
        } else if (typeof saleKey === 'number' && saleKey >= 0) {
          chat.npcs.splice(saleKey, 1);
        }
      } else {
        if (saleKey !== null && chat.sales[saleKey]) {
          delete chat.sales[saleKey];
        }
      }

      db.data.chats[chatId].sales = chat.sales;
      db.data.chats[chatId].npcs = chat.npcs;
      if (typeof db.write === 'function') await db.write();

      const compradorGlobal = db.getUser ? db.getUser(userId) : db.data.users?.[userId];
      const compradorNombre = compradorGlobal?.name || userId.split('@')[0];

      if (!isNpc && foundItem.user && foundItem.user !== userId) {
        const vendedorGlobal = db.getUser ? db.getUser(foundItem.user) : db.data.users?.[foundItem.user];
        const vendedorNombre = vendedorGlobal?.name || foundItem.user.split('@')[0];
        return msg.reply(`❀ *${foundItem.name}* ha sido comprado por *${compradorNombre}*, eliminado de la tienda y añadido a tu harem con éxito!\n> Se han transferido *¥${foundItem.price.toLocaleString()} ${currency}* a *${vendedorNombre}*`);
      } else {
        return msg.reply(`❀ *${foundItem.name}* ha sido comprado por *${compradorNombre}*, eliminado de la tienda y añadido a tu harem con éxito!`);
      }
    } catch (e) {
      await msg.reply(`> Ocurrió un error al ejecutar *${usedPrefix + command}*.\n> [Error: *${e.message}*]`);
    }
  }
};
        
