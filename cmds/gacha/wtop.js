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

export default {
  command: ['waifusboard', 'waifustop', 'topwaifus', 'wtop'],
  category: 'gacha',
  description: 'Ver el top de personajes con mayor valor.',
  run: async ({ msg, sock, args, usedPrefix, command }) => {
    try {
      if (typeof db.read === 'function') await db.read();
      const chatId = msg.chat;

      if (!db.data) db.data = {};
      if (!db.data.chats) db.data.chats = {};
      if (!db.data.chats[chatId]) db.data.chats[chatId] = {};
      let chat = db.getChat ? db.getChat(chatId) : db.data.chats[chatId];

      if (chat?.adminonly || chat?.gacha === false) {
        return msg.reply(`ꕥ Los comandos de *Gacha* están desactivados en este grupo.\n\nUn *administrador* puede activarlos con el comando:\n» *${usedPrefix}gacha on*`);
      }

      const [rawStructure, allStats] = await Promise.all([
        loadCharacters(),
        loadAllStats()
      ]);

      const allCharacters = flattenCharacters(rawStructure);
      if (!allCharacters || !allCharacters.length) {
        return msg.reply(`ꕥ No hay personajes registrados en el sistema (*lib/characters.js*).`);
      }

      const enriched = [];

      for (const c of allCharacters) {
        if (!c || !c.id) continue;
        const charKey = chatId + '__' + c.id;
        const statVal = allStats[charKey]?.value;
        const value = Number(statVal) || Number(c.value) || 100;
        enriched.push({ name: c.name || 'Desconocido', value, id: c.id });
      }

      if (enriched.length === 0) {
        return msg.reply(`ꕥ No hay personajes registrados en el sistema.`);
      }

      enriched.sort((a, b) => b.value - a.value);

      const page = parseInt(args[0]) || 1;
      const perPage = 10;
      const totalPages = Math.max(1, Math.ceil(enriched.length / perPage));

      if (page < 1 || page > totalPages) {
        return msg.reply(`ꕥ Página no válida. Hay un total de *${totalPages}* páginas.`);
      }

      const sliced = enriched.slice((page - 1) * perPage, page * perPage);

      let message = '❀ *Personajes con más valor:*\n\n';
      sliced.forEach((char, i) => {
        const rank = ((page - 1) * perPage) + i + 1;
        message += `✰ #${rank} » *${char.name}*\n`;
        message += `    → Valor: *¥${char.value.toLocaleString()}*\n`;
      });

      message += `\n⌦ Página *${page}* de *${totalPages}*`;
      if (page < totalPages) {
        message += `\n> Para ver la siguiente página › *${usedPrefix + command} ${page + 1}*`;
      }

      if (sock && typeof sock.sendMessage === 'function') {
        await sock.sendMessage(chatId, { text: message.trim() }, { quoted: msg });
      } else {
        await msg.reply(message.trim());
      }
    } catch (e) {
      await msg.reply(`> Ocurrió un error al ejecutar *${usedPrefix + command}*.\n> [Error: *${e.message}*]`);
    }
  }
};
                                    
