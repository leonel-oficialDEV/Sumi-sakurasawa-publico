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

async function loadStats() {
  try {
    await fs.access(STATS_FILE_PATH);
  } catch {
    await fs.writeFile(STATS_FILE_PATH, '{}');
  }
  try {
    const data = await fs.readFile(STATS_FILE_PATH, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function getBaseName(name) {
  if (!name) return 'Desconocido';
  const cleanName = String(name).trim();
  const lower = cleanName.toLowerCase();

  if (
    lower.includes('gotoubun') || 
    lower.includes('gotobun') || 
    lower.includes('goto-boun') || 
    lower.includes('ancianos nakano') ||
    lower.includes('manga concepto original')
  ) {
    return 'Go-Tōbun no Hanayome';
  }

  const franchises = [
    'Dragon Ball', 'Naruto', 'One Piece', 'Bleach', 'Fairy Tail',
    'Fate/', 'Sword Art Online', 'JoJo', 'Evangelion', 'Genshin Impact', 
    'Honkai', 'Pokémon', 'Pokemon', 'Digimon', 'Yu-Gi-Oh!', 'Sailor Moon',
    'Sonic', 'Super Mario', 'The Legend of Zelda', 'Final Fantasy', 'Persona',
    'Boku no Hero', 'My Hero Academia', 'Kimetsu no Yaiba', 'Demon Slayer',
    'Jujutsu Kaisen', 'Chainsaw Man', 'Blue Archive', 'Doraemon',
    'Spider-Man', 'Spiderman', 'Zenless Zone Zero', 'Baki', 'Maid Dragon', 'Spy x Family', 'Rick and Morty',
    'High School DxD', 'Mob Psycho 100', 'Mato Seihei No Slave', 'Kaede to Suzu',
    'Solo Leveling', 'Undertale', 'Tate No Yuusha', 'Girls\' Frontline', 'Yofukashi no Uta',
    'Yosuga No Sora', 'Bunny Girl Senpai', 'The Owner Of A Building', 'Modaete Yo, Adam-kun',
    'Adventure Time', 'Academy Sashimi Sword Master', 'Seikatsu Shuukan', 'Blue Lock',
    'Batman', 'Re:Zero', 'Love is War', 'Umamusume', 'Date A Live', 'Akame ga Kill',
    'Regular Show', 'Youjo Senki', 'Owari No Seraph', 'Teaching Feeling', 'Chūnibyō',
    'Vocaloid', 'Mortal Kombat', 'NieR:Automata', 'Bocchi The Rock!',
    'Webtoon Character Na Kang Lim', 'Eromanga-sensei', 'Death Note',
    'Youkoso Jitsuryoku', 'Indie Utaite', 'Boku Wa Chiisana Succubus No Shimobe',
    'Kakegurui', 'Las potras'
  ];

  for (const franchise of franchises) {
    if (lower.includes(franchise.toLowerCase())) {
      if (franchise === 'Pokemon') return 'Pokémon';
      if (franchise === 'Spiderman') return 'Spider-Man';
      if (franchise === 'Goto-boun no Hanayome') return 'Go-Tōbun no Hanayome';
      if (franchise === 'My Hero Academia') return 'Boku no Hero Academia';
      if (franchise === 'Demon Slayer') return 'Kimetsu no Yaiba';
      return franchise;
    }
  }

  if (cleanName.includes(':')) return cleanName.split(':')[0].trim();
  if (cleanName.includes(' - ')) return cleanName.split(' - ')[0].trim();

  return cleanName;
}

function normalizeSeriesStructure(raw) {
  if (!raw) return {};
  const map = {};

  const addCharToSeries = (char, defaultSeries = 'Desconocido') => {
    if (!char || typeof char !== 'object' || typeof char === 'function') return;
    const rawSrc = char.source || char.series || char.anime || defaultSeries;
    const seriesName = getBaseName(rawSrc);
    const seriesKey = normalizeStr(seriesName).replace(/\s+/g, '_') || 'desconocido';

    if (!map[seriesKey]) {
      map[seriesKey] = { name: seriesName, characters: [] };
    }
    map[seriesKey].characters.push({ ...char, source: seriesName });
  };

  let characterList = [];
  let seriesList = [];

  if (Array.isArray(raw)) {
    const isSeriesArray = raw.some(s => s && typeof s === 'object' && Array.isArray(s.characters));
    if (isSeriesArray) {
      seriesList = raw;
    } else {
      characterList = raw;
    }
  } else if (typeof raw === 'object' && raw !== null) {
    if (Array.isArray(raw.characters)) {
      characterList = raw.characters;
    } else {
      for (const [key, val] of Object.entries(raw)) {
        if (!val || typeof val === 'function') continue;
        if (key === 'characters' && Array.isArray(val)) {
          characterList.push(...val);
        } else if (Array.isArray(val)) {
          const seriesName = getBaseName(key);
          const seriesKey = normalizeStr(seriesName).replace(/\s+/g, '_') || normalizeStr(key);
          if (!map[seriesKey]) map[seriesKey] = { name: seriesName, characters: [] };
          for (const c of val) {
            if (c && typeof c === 'object' && typeof c !== 'function') {
              map[seriesKey].characters.push({ ...c, source: c.source || seriesName });
            }
          }
        } else if (Array.isArray(val.characters)) {
          const rawName = val.name || val.title || key;
          const seriesName = getBaseName(rawName);
          const seriesKey = val.id || normalizeStr(seriesName).replace(/\s+/g, '_') || normalizeStr(key);
          if (!map[seriesKey]) map[seriesKey] = { name: seriesName, characters: [] };
          for (const c of val.characters) {
            if (c && typeof c === 'object' && typeof c !== 'function') {
              map[seriesKey].characters.push({ ...c, source: c.source || seriesName });
            }
          }
        } else if (val.name && typeof val.name === 'string') {
          addCharToSeries(val, key);
        }
      }
    }
  }

  for (const c of characterList) {
    if (c && typeof c === 'object' && typeof c !== 'function') {
      addCharToSeries(c);
    }
  }

  for (const [i, s] of seriesList.entries()) {
    if (!s || typeof s !== 'object' || typeof s === 'function') continue;
    const rawName = s.name || s.title || s.series || `Serie ${i + 1}`;
    const seriesName = getBaseName(rawName);
    const seriesKey = normalizeStr(seriesName).replace(/\s+/g, '_') || `serie_${i + 1}`;

    if (!map[seriesKey]) {
      map[seriesKey] = { name: seriesName, characters: [] };
    }
    if (Array.isArray(s.characters)) {
      for (const c of s.characters) {
        if (c && typeof c === 'object' && typeof c !== 'function') {
          map[seriesKey].characters.push({ ...c, source: c.source || seriesName });
        }
      }
    }
  }

  return map;
}

export default {
  command: ['serieinfo', 'ainfo', 'animeinfo'],
  category: 'gacha',
  description: 'Muestra información detallada y personajes de una serie.',
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
        loadStats()
      ]);

      const structure = normalizeSeriesStructure(rawStructure);
      const entries = Object.entries(structure);

      if (entries.length === 0) {
        return msg.reply(`ꕥ No hay series o personajes registrados en *lib/characters/*.`);
      }

      if (!args.length || (args.length === 1 && !isNaN(args[0]))) {
        const page = args.length ? parseInt(args[0]) : 1;
        const perPage = 12;
        const totalPages = Math.max(1, Math.ceil(entries.length / perPage));

        if (page < 1 || page > totalPages) {
          return msg.reply(`❀ Página no válida. Hay un total de *${totalPages}* páginas de series.`);
        }

        const start = (page - 1) * perPage;
        const end = Math.min(start + perPage, entries.length);
        const pageEntries = entries.slice(start, end);

        let text = `╭━━━⳹ 📚 *SERIES DISPONIBLES* 📚 ⳼━━━╮\n`;
        text += `┃ Total registradas: *${entries.length}*\n`;
        text += `╰━━━━━━━━━━━━━━━━━━━━━━╯\n\n`;

        for (const [index, [k, s]] of pageEntries.entries()) {
          const itemNum = start + index + 1;
          const name = s?.name || k;
          const charCount = Array.isArray(s?.characters) ? s.characters.length : 0;
          text += `🔹 *${itemNum}.* ${name}\n   └ 👥 Personajes: \`${charCount}\`\n\n`;
        }

        text += `📄 *Página ${page} de ${totalPages}*\n`;
        if (page < totalPages) {
          text += `> Usa *${usedPrefix + command} ${page + 1}* para ver la siguiente página.\n`;
        }
        text += `> Usa *${usedPrefix + command} [nombre]* para ver los detalles de una serie.`;

        return msg.reply(text.trim());
      }

      let page = 1;
      let seriesNameArgs = args;
      const lastArg = args[args.length - 1];
      if (args.length > 1 && lastArg && !isNaN(lastArg) && parseInt(lastArg) > 0) {
        page = parseInt(lastArg);
        seriesNameArgs = args.slice(0, -1);
      }

      const query = normalizeStr(seriesNameArgs.join(' '));
      if (!query) {
        return msg.reply(`❀ Debes ingresar un nombre válido para buscar.`);
      }

      const matchingEntries = entries.filter(([k, s]) => {
        const name = normalizeStr(s?.name || k);
        const tags = Array.isArray(s?.tags) ? s.tags.map(normalizeStr) : [];
        return name.includes(query) || tags.some(t => t.includes(query));
      });

      if (matchingEntries.length === 0) {
        return msg.reply(`ꕥ No se encontró ninguna serie con el nombre *"${seriesNameArgs.join(' ')}"*.\n> Puedes sugerir su incorporación usando: *${usedPrefix}suggest sugerencia: ${seriesNameArgs.join(' ')}*`);
      }

      if (matchingEntries.length > 1 && !matchingEntries.some(([k, s]) => normalizeStr(s?.name || k) === query)) {
        let text = `╭━━━⳹ 🔍 *COINCIDENCIAS* 🔍 ⳼━━━╮\n`;
        text += `┃ Se encontraron varias variantes:\n`;
        text += `╰━━━━━━━━━━━━━━━━━━━━━━╯\n\n`;
        for (const [index, [k, s]] of matchingEntries.entries()) {
          const name = s?.name || k;
          const charCount = Array.isArray(s?.characters) ? s.characters.length : 0;
          text += `🔹 *${index + 1}.* ${name} (*${charCount}* pers.)\n`;
        }
        text += `\n> Escribe el nombre completo (ej: *${usedPrefix + command} dragon ball*) para ver los detalles.`;
        return msg.reply(text.trim());
      }

      const exactMatch = matchingEntries.find(([k, s]) => normalizeStr(s?.name || k) === query);
      const [seriesKey, seriesData] = exactMatch || matchingEntries[0];

      let list = Array.isArray(seriesData?.characters) ? [...seriesData.characters] : [];
      const total = list.length;

      let claimedCount = 0;
      const processedList = [];

      for (const c of list) {
        const charId = c.id || c.keyword || normalizeStr(c.name || '').replace(/\s+/g, '_');
        const charKey = chatId + '__' + charId;
        const stat = allStats[charKey] || null;

        const value = stat?.value || Number(c?.value || 100);
        let owner = stat?.owner || stat?.claimedBy || stat?.user || stat?.claimed || null;

        if (!owner) {
          const chatUsersObj = db.data.chat_users?.[chatId] || {};
          for (const [uId, uData] of Object.entries(chatUsersObj)) {
            let userChars = uData?.characters || [];
            if (typeof userChars === 'string') {
              try { userChars = JSON.parse(userChars); } catch { userChars = []; }
            }
            if (Array.isArray(userChars) && (userChars.includes(charId) || userChars.includes(charKey))) {
              owner = uId;
              break;
            }
          }
        }

        if (owner) claimedCount++;

        processedList.push({
          ...c,
          id: charId,
          value,
          owner
        });
      }

      processedList.sort((a, b) => b.value - a.value);

      const perPage = 20;
      const totalPages = Math.max(1, Math.ceil(processedList.length / perPage));

      if (page < 1 || page > totalPages) {
        return msg.reply(`❀ Página no válida. Hay un total de *${totalPages}* páginas para esta serie.`);
      }

      const startIndex = (page - 1) * perPage;
      const endIndex = Math.min(startIndex + perPage, processedList.length);
      const pageCharacters = processedList.slice(startIndex, endIndex);

      const percentage = total > 0 ? ((claimedCount / total) * 100).toFixed(1) : '0.0';

      let replyText = `╭━━━⳹ 🏮 *INFO DE SERIE* 🏮 ⳼━━━╮\n`;
      replyText += `┃ 📌 *Fuente:* \`${seriesData?.name || seriesKey}\`\n`;
      replyText += `┃ 👥 *Personajes:* \`${total}\`\n`;
      replyText += `┃ 💍 *Reclamados:* \`${claimedCount}/${total} (${percentage}%)\`\n`;
      replyText += `╰━━━━━━━━━━━━━━━━━━━━━━╯\n\n`;
      replyText += `📋 *Lista de personajes:*\n`;

      for (const [index, c] of pageCharacters.entries()) {
        const itemNum = startIndex + index + 1;
        let ownerName = 'Desconocido';
        if (c.owner) {
          const ownerGlobal = db.getUser ? db.getUser(c.owner) : db.data.users?.[c.owner];
          const ownerChatUser = db.getChatUser ? db.getChatUser(chatId, c.owner) : db.data.chat_users?.[chatId]?.[c.owner];
          ownerName = ownerGlobal?.name?.trim() || ownerChatUser?.name?.trim() || (typeof c.owner === 'string' ? c.owner.split('@')[0] : 'Desconocido');
        }

        const status = c.owner ? `💍 *${ownerName}*` : `🟢 *Libre*`;
        replyText += `\n🔹 *${itemNum}.* ${c?.name || 'Desconocido'}\n`;
        replyText += `   └ Val: \`${(c?.value || 100).toLocaleString()}\` • ${status}\n`;
      }

      replyText += `\n📄 *Página ${page} de ${totalPages}*`;
      if (page < totalPages) {
        replyText += `\n> Usa *${usedPrefix}${command} ${seriesNameArgs.join(' ')} ${page + 1}* para ver la siguiente página.`;
      }

      await msg.reply(replyText.trim());
    } catch (e) {
      await msg.reply(`> Ocurrió un error inesperado al ejecutar el comando *${usedPrefix + command}*.\n> [Error: *${e.message}*]`);
    }
  }
};
                      
