import { promises as fs } from 'fs';
import path from 'path';
import db from '#db';

const STATS_FILE_PATH = path.join(process.cwd(), 'lib', 'character_stats.json');

function normalizeStr(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function loadCharacters() {
  const filePath = path.join(process.cwd(), 'lib', 'characters.js');
  try {
    const module = await import(`file://${filePath}?update=${Date.now()}`);
    return module.default || module;
  } catch {
    return [];
  }
}

async function loadAllStats() {
  try {
    await fs.access(STATS_FILE_PATH);
    const data = await fs.readFile(STATS_FILE_PATH, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function flattenCharacters(raw) {
  if (!raw) return [];
  const list = [];

  const processChar = (c, defaultSeries = 'Desconocido') => {
    if (!c) return;
    const source = c.source || c.series || c.anime || defaultSeries;
    const charId = c.id || c.keyword || normalizeStr(c.name || '').replace(/\s+/g, '_');
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
      if (!val) continue;
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

function isCharacterClaimed(chatId, characterId, allStats) {
  const chatUsers = db.data?.chat_users?.[chatId] || {};
  for (const userObj of Object.values(chatUsers)) {
    let chars = userObj?.characters || [];
    if (typeof chars === 'string') {
      try { chars = JSON.parse(chars); } catch { chars = []; }
    }
    if (Array.isArray(chars) && chars.includes(characterId)) {
      return true;
    }
  }

  const charKey = chatId + '__' + characterId;
  const stat = allStats?.[charKey];
  if (stat && (stat.user || stat.owner || stat.claimedBy || stat.claimed)) {
    return true;
  }
  return false;
}

function getRarityByValue(val) {
  if (val >= 500000) return { name: 'Secreto', color: '⬛' };
  if (val >= 300000) return { name: 'Mítico', color: '🔴' };
  if (val >= 100001) return { name: 'Legendario', color: '🟡' };
  if (val >= 40001) return { name: 'Épico', color: '🟣' };
  if (val >= 25001) return { name: 'Muy raro', color: '🩵' };
  if (val >= 15001) return { name: 'Raro', color: '🔵' };
  if (val >= 5001) return { name: 'Poco común', color: '🟢' };
  return { name: 'Común', color: '⚪' };
}

function getWeightedRandomCharacter(characters) {
  if (!characters.length) return null;
  const weightedList = characters.map(c => {
    const val = Number(c.value) || 100;
    let weight = 50;
    if (val >= 500000) weight = 0.1;
    else if (val >= 300000) weight = 0.5;
    else if (val >= 100001) weight = 1.5;
    else if (val >= 40001) weight = 5;
    else if (val >= 25001) weight = 10;
    else if (val >= 15001) weight = 15;
    else if (val >= 5001) weight = 30;
    return { character: c, weight };
  });

  const totalWeight = weightedList.reduce((sum, item) => sum + item.weight, 0);
  let randomNum = Math.random() * totalWeight;

  for (const item of weightedList) {
    if (randomNum < item.weight) return item.character;
    randomNum -= item.weight;
  }
  return characters[0];
}

export default {
  command: ['wshop', 'haremshop', 'tiendawaifus'],
  category: 'gacha',
  description: 'Ver los personajes en venta en el mercado.',
  run: async ({ msg, sock, args, usedPrefix, command }) => {
    try {
      if (typeof db.read === 'function') await db.read();
      const chatId = msg.chat;

      if (!db.data) db.data = {};
      if (!db.data.chats) db.data.chats = {};
      if (!db.data.chats[chatId]) db.data.chats[chatId] = {};
      let chat = db.getChat ? db.getChat(chatId) : db.data.chats[chatId];

      if (chat?.adminonly || chat?.gacha === false) {
        return msg.reply(`ꕥ Los comandos de *Gacha* están desactivados en este grupo.\n\nUn *administrador* puede activarlos con:\n» *${usedPrefix}gacha on*`);
      }

      const [rawStructure, allStats] = await Promise.all([
        loadCharacters(),
        loadAllStats()
      ]);

      const allChars = flattenCharacters(rawStructure);
      const now = Date.now();

      if (!chat.sales || typeof chat.sales !== 'object') {
        chat.sales = {};
      }

      let salesChanged = false;
      for (const [id, venta] of Object.entries(chat.sales)) {
        if (now - (venta?.time || 0) >= 3 * 864e5) {
          delete chat.sales[id];
          salesChanged = true;
        }
      }

      if (!Array.isArray(chat.npcs)) {
        chat.npcs = [];
      }

      const initialNpcCount = chat.npcs.length;
      chat.npcs = chat.npcs.filter(npc => npc && npc.expiresAt && now < npc.expiresAt);

      if (chat.npcs.length === 0 || Math.random() < 0.45) {
        const targetCount = Math.floor(Math.random() * 7);
        if (chat.npcs.length < targetCount && allChars.length > 0) {
          const needed = targetCount - chat.npcs.length;
          for (let i = 0; i < needed; i++) {
            let npcChar = null;
            let realCharId = '';
            for (let intento = 0; intento < 10; intento++) {
              const candidate = getWeightedRandomCharacter(allChars);
              if (!candidate) continue;
              const candId = candidate.id || candidate.keyword || normalizeStr(candidate.name || '').replace(/\s+/g, '_');
              const alreadyClaimed = isCharacterClaimed(chatId, candId, allStats);
              if (!alreadyClaimed) {
                npcChar = candidate;
                realCharId = candId;
                break;
              }
            }

            if (npcChar && realCharId) {
              const baseVal = Number(npcChar.value) || 100;
              const npcPrice = Math.round(baseVal * (1.05 + Math.random() * 0.2));
              const randomDurationMs = (15 + Math.random() * 15) * 60 * 1000;

              chat.npcs.push({
                id: realCharId + '_' + Math.random().toString(36).substring(2, 7),
                name: npcChar.name,
                price: npcPrice,
                value: baseVal,
                user: 'NPC',
                time: now,
                expiresAt: now + randomDurationMs,
                isNpc: true
              });
              salesChanged = true;
            }
          }
        }
      }

      if (salesChanged || chat.npcs.length !== initialNpcCount) {
        db.data.chats[chatId] = chat;
        if (typeof db.write === 'function') await db.write();
      }

      const ventas = [];
      for (const [id, venta] of Object.entries(chat.sales)) {
        ventas.push([id, venta]);
      }
      for (const npc of chat.npcs) {
        ventas.push([npc.id, npc]);
      }

      if (!ventas.length) {
        let groupName = 'este grupo';
        try {
          if (chatId.endsWith('@g.us')) {
            const grupo = await sock.groupMetadata(chatId);
            groupName = grupo?.subject || groupName;
          }
        } catch {}
        return msg.reply(`ꕥ No hay personajes en venta en *${groupName}* en este momento.`);
      }

      const page = parseInt(args[0]) || 1;
      const porPagina = 10;
      const totalPaginas = Math.ceil(ventas.length / porPagina);
      if (page < 1 || page > totalPaginas) {
        return msg.reply(`ꕥ Página inválida. Solo hay *${totalPaginas}* página${totalPaginas > 1 ? 's' : ''} disponible${totalPaginas > 1 ? 's' : ''}.`);
      }

      const listado = [];
      for (const [id, venta] of ventas.slice((page - 1) * porPagina, page * porPagina)) {
        const precios = typeof venta?.price === 'number' ? `¥${venta.price.toLocaleString()}` : 'Precio no disponible';

        let vendedor = 'Desconocido';
        if (venta?.isNpc || venta?.user === 'NPC') {
          vendedor = '🤖 NPC (Mercader)';
        } else if (venta?.user) {
          const vendedorGlobal = db.getUser ? db.getUser(venta.user) : db.data.users?.[venta.user];
          vendedor = vendedorGlobal?.name?.trim() || (typeof venta.user === 'string' ? venta.user.split('@')[0] : 'Desconocido');
        }

        const targetName = venta?.name;
        const character = allChars.find(c => {
          const cId = c.id || c.keyword || normalizeStr(c.name || '').replace(/\s+/g, '_');
          return cId === id || cId === venta?.id || normalizeStr(c.name) === normalizeStr(targetName);
        });

        const charKey = chatId + '__' + (character?.id || id);
        const chatCharVal = allStats[charKey]?.value;
        const valorFinal = Number(chatCharVal) || Number(venta?.value) || Number(character?.value) || Number(venta?.price) || 100;
        const rarity = getRarityByValue(valorFinal);

        let tiempoTexto = '';
        if (venta?.isNpc) {
          const tiempoRestante = Math.max(0, (venta.expiresAt || now) - now);
          const m_ = Math.floor((tiempoRestante % 3600000) / 60000);
          const s = Math.floor((tiempoRestante % 60000) / 1000);
          tiempoTexto = `Expira en ${m_}m ${s}s`;
        } else {
          const tiempoRestante = Math.max(0, 3 * 864e5 - (now - (venta?.time || now)));
          const d = Math.floor(tiempoRestante / 86400000);
          const h = Math.floor((tiempoRestante % 86400000) / 3600000);
          const m_ = Math.floor((tiempoRestante % 3600000) / 60000);
          const s = Math.floor((tiempoRestante % 60000) / 1000);
          tiempoTexto = `${d}d ${h}h ${m_}m ${s}s`;
        }

        listado.push(`❀ *${venta?.name || 'Personaje'}* (${rarity.color} ${rarity.name} | ✰ ${valorFinal.toLocaleString()}):\n⛁ Precio » *${precios}*\n❖ Vendedor » *${vendedor}*\nⴵ Estado » *${tiempoTexto}*`);
      }

      let eventBanner = '';
      if (chat.activeEvent) {
        const remainingEventMs = Math.max(0, (chat.eventExpiresAt || 0) - now);
        const eMin = Math.floor(remainingEventMs / 60000);
        const eSec = Math.floor((remainingEventMs % 60000) / 1000);
        const icon = chat.activeEvent.type === 'good' ? '✨ [EVENTO BUENO]' : '⚠️ [EVENTO MALO]';
        eventBanner = `\n\n╭━━━ *${icon}* ━━━⬣\n┃ *${chat.activeEvent.name}*\n┃ ${chat.activeEvent.description}\n┃ ⏱️ *Expira en:* ${eMin}m ${eSec}s\n╰━━━━━━━━━━━━━━━╯`;
      }

      const replyText = `*☆ HaremShop \`≧◠ᴥ◠≦\`*\n❏ Personajes en venta <${ventas.length}>:\n\n` + listado.join('\n\n') + `\n\n> • Página *${page}* de *${totalPaginas}*${eventBanner}`;
      await msg.reply(replyText);
    } catch (e) {
      await msg.reply(`> Ocurrió un error al ejecutar *${usedPrefix + command}*.\n> [Error: *${e.message}*]`);
    }
  }
};
                  
