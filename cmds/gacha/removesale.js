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
  command: ['removesale', 'removerventa', 'delwshop', 'removeshop'],
  category: 'gacha',
  description: 'Eliminar un personaje en venta y regresarlo a tu harem.',
  run: async ({ msg, args, usedPrefix, command }) => {
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

      if (!chat.sales || typeof chat.sales !== 'object') {
        chat.sales = {};
      }

      if (!args.length) {
        return msg.reply(`❀ Debes especificar un personaje para eliminar de la venta.\n> Ejemplo » *${usedPrefix + command} Appule*`);
      }

      const queryRemove = args.join(' ');
      const queryNorm = normalizeStr(queryRemove);

      let foundKey = null;
      let foundVenta = null;

      for (const [key, venta] of Object.entries(chat.sales)) {
        if (!venta) continue;
        const vName = normalizeStr(venta.name);
        const vId = normalizeStr(venta.id || key);
        if (vName === queryNorm || vId === queryNorm || vName.includes(queryNorm) || queryNorm.includes(vName)) {
          foundKey = key;
          foundVenta = venta;
          break;
        }
      }

      if (!foundKey || !foundVenta) {
        return msg.reply(`ꕥ No se ha encontrado ningún personaje llamado *${queryRemove}* a la venta en este grupo.`);
      }

      const cleanSender = userId.split('@')[0];
      const cleanVentaUser = String(foundVenta.user || '').split('@')[0];

      if (foundVenta.user !== userId && cleanSender !== cleanVentaUser) {
        return msg.reply(`ꕥ El personaje *${foundVenta.name}* no está a la venta por ti.`);
      }

      const structure = await loadCharacters();
      const sourceData = findCharacterInStructure(structure, foundVenta.name || foundVenta.id || queryRemove);
      const characterId = sourceData?.id || foundVenta.id || foundKey.split('_')[0] || normalizeStr(foundVenta.name).replace(/\s+/g, '_');

      delete chat.sales[foundKey];
      db.data.chats[chatId].sales = chat.sales;

      if (typeof db.updateChat === 'function') {
        db.updateChat(chatId, 'sales', chat.sales);
      }

      let chatUser = db.getChatUser ? db.getChatUser(chatId, userId) : db.data.chat_users?.[chatId]?.[userId] || {};
      let userCharacters = chatUser.characters || [];
      if (typeof userCharacters === 'string') {
        try { userCharacters = JSON.parse(userCharacters); } catch { userCharacters = []; }
      }
      if (!Array.isArray(userCharacters)) userCharacters = [];

      if (!userCharacters.includes(characterId)) {
        userCharacters.push(characterId);
      }

      chatUser.characters = userCharacters;

      if (!db.data.chat_users) db.data.chat_users = {};
      if (!db.data.chat_users[chatId]) db.data.chat_users[chatId] = {};
      if (!db.data.chat_users[chatId][userId]) db.data.chat_users[chatId][userId] = {};
      db.data.chat_users[chatId][userId].characters = userCharacters;

      if (typeof db.setCreate === 'function') {
        db.setCreate('chat_users', [chatId, userId], 'characters', userCharacters);
      }

      if (typeof db.write === 'function') await db.write();

      await msg.reply(`❀ *${foundVenta.name}* ha sido retirado de la venta y devuelto a tu harem con éxito.`);
    } catch (e) {
      await msg.reply(`> Ocurrió un error al ejecutar *${usedPrefix + command}*.\n> [Error: *${e.message}*]`);
    }
  }
};
