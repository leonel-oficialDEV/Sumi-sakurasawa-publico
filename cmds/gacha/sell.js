import path from 'path';
import db from '#db';

async function loadCharacters() {
  const filePath = path.join(process.cwd(), 'lib', 'characters.js');
  try {
    const module = await import(`file://${filePath}?update=${Date.now()}`);
    return module.default || module;
  } catch {
    return [];
  }
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
    return {
      ...found,
      id: found.id || found.keyword || normalizeStr(found.name).replace(/\s+/g, '_')
    };
  }

  return null;
}

export default {
  command: ['sell', 'vender', 'waddshop', 'addshop'],
  category: 'gacha',
  description: 'Poner un personaje a la venta en la tienda del grupo.',
  run: async ({ msg, sock, args, usedPrefix, command }) => {
    try {
      if (typeof db.read === 'function') await db.read();
      const chatId = msg.chat;
      const userId = msg.sender;

      if (!db.data) db.data = {};
      if (!db.data.chats) db.data.chats = {};
      if (!db.data.chats[chatId]) db.data.chats[chatId] = {};
      let chat = db.getChat ? db.getChat(chatId) : db.data.chats[chatId];

      if (chat?.adminonly || chat?.gacha === false) {
        return msg.reply(`ꕥ Los comandos de *Gacha* están desactivados en este grupo.\n\nUn *administrador* puede activarlos con:\n» *${usedPrefix}gacha on*`);
      }

      if (args.length < 2) {
        return msg.reply(`❀ Debes especificar un precio y el nombre del personaje.\n> Ejemplo » *${usedPrefix + command} 5000 Elaina*`);
      }

      const price = parseInt(args[0]);
      if (isNaN(price) || price < 2000) {
        return msg.reply(`ꕥ El precio mínimo para vender un personaje es de *¥2,000*.`);
      }
      if (price > 100_000_000) {
        return msg.reply(`ꕥ El precio máximo permitido es de *¥100,000,000*.`);
      }

      const searchName = args.slice(1).join(' ');
      const queryNorm = normalizeStr(searchName);

      let chatUser = db.getChatUser ? db.getChatUser(chatId, userId) : db.data.chat_users?.[chatId]?.[userId] || {};
      let userCharacters = chatUser.characters || [];
      if (typeof userCharacters === 'string') {
        try { userCharacters = JSON.parse(userCharacters); } catch { userCharacters = []; }
      }
      if (!Array.isArray(userCharacters)) userCharacters = [];

      if (userCharacters.length === 0) {
        return msg.reply(`ꕥ No tienes ningún personaje reclamado en tu harem para poner a la venta.`);
      }

      const structure = await loadCharacters();

      let matchedId = null;
      let matchedName = null;
      let matchedValue = 100;

      for (const ownedId of userCharacters) {
        const charInfo = findCharacterInStructure(structure, ownedId);
        const cName = charInfo?.name || ownedId;
        const normName = normalizeStr(cName);
        const normId = normalizeStr(ownedId);

        if (normName === queryNorm || normId === queryNorm || normName.includes(queryNorm) || queryNorm.includes(normName)) {
          matchedId = ownedId;
          matchedName = charInfo?.name || ownedId;
          matchedValue = Number(charInfo?.value) || 100;
          break;
        }
      }

      if (!matchedId) {
        const generalMatch = findCharacterInStructure(structure, searchName);
        if (generalMatch && userCharacters.includes(generalMatch.id)) {
          matchedId = generalMatch.id;
          matchedName = generalMatch.name;
          matchedValue = Number(generalMatch.value) || 100;
        }
      }

      if (!matchedId) {
        return msg.reply(`ꕥ No se encontró a *${searchName}* en tu harem o no te pertenece.`);
      }

      const charIndex = userCharacters.indexOf(matchedId);
      if (charIndex !== -1) {
        userCharacters.splice(charIndex, 1);
      }

      if (!db.data.chat_users) db.data.chat_users = {};
      if (!db.data.chat_users[chatId]) db.data.chat_users[chatId] = {};
      if (!db.data.chat_users[chatId][userId]) db.data.chat_users[chatId][userId] = {};
      db.data.chat_users[chatId][userId].characters = userCharacters;

      if (typeof db.setCreate === 'function') {
        db.setCreate('chat_users', [chatId, userId], 'characters', userCharacters);
      }

      const baseValue = matchedValue;
      const profit = Math.max(0, price - baseValue);
      const fee = Math.round(profit * 0.05);

      if (!chat.sales || typeof chat.sales !== 'object') {
        chat.sales = {};
      }

      const saleKey = `${userId}_${matchedId}_${Date.now()}`;
      chat.sales[saleKey] = {
        id: matchedId,
        name: matchedName,
        user: userId,
        price,
        fee,
        time: Date.now()
      };

      db.data.chats[chatId].sales = chat.sales;
      if (typeof db.updateChat === 'function') {
        db.updateChat(chatId, 'sales', chat.sales);
      }

      if (typeof db.write === 'function') {
        await db.write();
      }

      const sellerGlobal = db.getUser ? db.getUser(userId) : db.data.users?.[userId];
      let sellerName = sellerGlobal?.name?.trim() || userId.split('@')[0];

      await msg.reply(`✎ *${matchedName}* ha sido retirado de tu harem y puesto a la venta con éxito!\n❀ Vendedor » *${sellerName}*\n⛁ Precio » *¥${price.toLocaleString()}*\n💸 Comisión (5% ganancia) » *¥${fee.toLocaleString()}*\nⴵ Expira en » *3 días*\n> Ya puedes verlo en la tienda usando *${usedPrefix}wshop*`);
    } catch (e) {
      await msg.reply(`> Ocurrió un error al ejecutar *${usedPrefix + command}*.\n> [Error: *${e.message}*]`);
    }
  }
};
