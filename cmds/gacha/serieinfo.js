import { promises as fs } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import db from '#db';

const STATS_FILE_PATH = path.join(process.cwd(), 'lib', 'character_stats.json');
const CHARACTERS_FILE_PATH = path.join(process.cwd(), 'lib', 'characters.js');
const CHARACTERS_DIR_PATH = path.join(process.cwd(), 'lib', 'characters');

const SUGGEST_COMMAND = 'suggest';
const MAX_MATCHES_SHOWN = 15;

const structureCache = { mtime: 0, data: null };

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
      if (franchise === 'My Hero Academia') return 'Boku no Hero Academia';
      if (franchise === 'Demon Slayer') return 'Kimetsu no Yaiba';
      return franchise;
    }
  }

  if (cleanName.includes(':')) return cleanName.split(':')[0].trim();
  if (cleanName.includes(' - ')) return cleanName.split(' - ')[0].trim();

  return cleanName;
}

function isCharObject(c) {
  return c && typeof c === 'object' && typeof c !== 'function';
}

function normalizeSeriesStructure(raw) {
  if (!raw) return {};
  const map = {};

  const addCharToSeries = (char, defaultSeries = 'Desconocido') => {
    if (!isCharObject(char)) return;
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
  } else if (typeof raw === 'object') {
    if (Array.isArray(raw.characters)) {
      characterList = raw.characters;
    } else {
      for (const [key, val] of Object.entries(raw)) {
        if (!val || typeof val === 'function') continue;
        if (Array.isArray(val)) {
          const seriesName = getBaseName(key);
          const seriesKey = normalizeStr(seriesName).replace(/\s+/g, '_') || normalizeStr(key);
          if (!map[seriesKey]) map[seriesKey] = { name: seriesName, characters: [] };
          for (const c of val) {
            if (isCharObject(c)) {
              map[seriesKey].characters.push({ ...c, source: c.source || seriesName });
            }
          }
        } else if (Array.isArray(val.characters)) {
          const rawName = val.name || val.title || key;
          const seriesName = getBaseName(rawName);
          const seriesKey = val.id || normalizeStr(seriesName).replace(/\s+/g, '_') || normalizeStr(key);
          if (!map[seriesKey]) map[seriesKey] = { name: seriesName, characters: [] };
          for (const c of val.characters) {
            if (isCharObject(c)) {
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
    addCharToSeries(c);
  }

  for (const [i, s] of seriesList.entries()) {
    if (!isCharObject(s)) continue;
    const rawName = s.name || s.title || s.series || `Serie ${i + 1}`;
    const seriesName = getBaseName(rawName);
    const seriesKey = normalizeStr(seriesName).replace(/\s+/g, '_') || `serie_${i + 1}`;

    if (!map[seriesKey]) {
      map[seriesKey] = { name: seriesName, characters: [] };
    }
    if (Array.isArray(s.characters)) {
      for (const c of s.characters) {
        if (isCharObject(c)) {
          map[seriesKey].characters.push({ ...c, source: c.source || seriesName });
        }
      }
    }
  }

  return map;
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

async function loadStructure() {
  try {
    const signature = await getCharactersSignature();
    if (structureCache.data && structureCache.mtime === signature) {
      return structureCache.data;
    }
    const module = await import(`${pathToFileURL(CHARACTERS_FILE_PATH).href}?update=${signature}`);
    const raw = module.default || module.characters || module.data || module;
    const data = normalizeSeriesStructure(raw);
    structureCache.mtime = signature;
    structureCache.data = data;
    return data;
  } catch {
    return {};
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

function getRarityByValue(val) {
  if (val >= 5000) return { name: 'Mítico', color: '🔴' };
  if (val >= 2500) return { name: 'Legendario', color: '🟡' };
  if (val >= 1000) return { name: 'Épico', color: '🟣' };
  if (val >= 500) return { name: 'Raro', color: '🔵' };
  if (val >= 200) return { name: 'Poco Común', color: '🟢' };
  return { name: 'Común', color: '⚪' };
}

function getRarity(character, stat, baseValue) {
  const rawRarity = stat?.rareza || stat?.rarity || stat?.clase || character?.rareza || character?.rarity || character?.clase || character?.tier;

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

function getBaseValue(character, stat) {
  return Number(stat?.value) || Number(character?.price) || Number(character?.value) || 0;
}

function resolveValue(baseValue, rarity) {
  const range = RARITY_RANGE[rarity.name];
  if (!range) return { value: baseValue || 100, text: `$${(baseValue || 100).toLocaleString()}` };
  if (baseValue >= range[0] && baseValue <= range[1]) {
    return { value: baseValue, text: `$${baseValue.toLocaleString()}` };
  }
  const mid = Math.round((range[0] + range[1]) / 2 / 10) * 10;
  return { value: mid, text: `$${range[0].toLocaleString()} - $${range[1].toLocaleString()}` };
}

function buildOwnerMap(chatUsersObj) {
  const map = new Map();
  for (const [uId, uData] of Object.entries(chatUsersObj || {})) {
    let userChars = uData?.characters || [];
    if (typeof userChars === 'string') {
      try { userChars = JSON.parse(userChars); } catch { userChars = []; }
    }
    if (!Array.isArray(userChars)) continue;
    for (const entry of userChars) {
      if (!map.has(entry)) map.set(entry, uId);
    }
  }
  return map;
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const m = a.length;
  const n = b.length;
  const prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? last : 1 + Math.min(last, prev[j], prev[j - 1]);
      last = tmp;
    }
  }
  return 1 - prev[n] / Math.max(m, n);
}

function suggestSeries(entries, query) {
  const queryWords = query.split(' ').filter(Boolean);
  const scored = [];

  for (const [k, s] of entries) {
    const name = normalizeStr(s?.name || k);
    const nameWords = name.split(' ');
    let score = similarity(query, name);

    if (queryWords.length) {
      let total = 0;
      for (const qw of queryWords) {
        let best = 0;
        for (const nw of nameWords) best = Math.max(best, similarity(qw, nw));
        total += best;
      }
      score = Math.max(score, (total / queryWords.length) * 0.9);
    }

    if (query.length >= 3 && name.includes(query)) score = Math.max(score, 0.8);

    if (score >= 0.55) scored.push({ name: s?.name || k, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 5).map(x => x.name);
}

function findSeriesMatches(entries, query) {
  if (!query) return [];
  return entries
    .filter(([k, s]) => normalizeStr(s?.name || k).includes(query))
    .sort((a, b) => normalizeStr(a[1]?.name || a[0]).length - normalizeStr(b[1]?.name || b[0]).length);
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
      const chat = db.getChat(msg.chat);
      if (chat?.adminonly || !chat?.gacha) {
        return msg.reply(`ꕥ Los comandos de *Gacha* están desactivados en este grupo.\n\nUn *administrador* puede activarlos con el comando:\n» *${usedPrefix}gacha on*`);
      }

      const [structure, allStats] = await Promise.all([
        loadStructure(),
        loadStats()
      ]);

      const entries = Object.entries(structure);

      if (entries.length === 0) {
        return msg.reply(`ꕥ No hay series o personajes registrados en *lib/characters.js*.`);
      }

      if (!args.length || (args.length === 1 && /^\d+$/.test(args[0]))) {
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
      let query = normalizeStr(args.join(' '));
      let matchingEntries = findSeriesMatches(entries, query);

      if (!matchingEntries.length && args.length > 1) {
        const lastArg = args[args.length - 1];
        if (/^\d+$/.test(lastArg) && parseInt(lastArg) > 0) {
          page = parseInt(lastArg);
          seriesNameArgs = args.slice(0, -1);
          query = normalizeStr(seriesNameArgs.join(' '));
          matchingEntries = findSeriesMatches(entries, query);
        }
      }

      if (!query || query.length < 2) {
        return msg.reply(`❀ Debes ingresar un nombre válido para buscar.`);
      }

      const shownName = seriesNameArgs.join(' ');

      if (matchingEntries.length === 0) {
        const suggestions = suggestSeries(entries, query);
        let text = `ꕥ No se encontró ninguna serie con el nombre *"${shownName}"*.`;
        if (suggestions.length) {
          text += `\n\n❀ ¿Quisiste decir alguna de estas?\n${suggestions.map(n => `» *${n}*`).join('\n')}`;
        }
        text += `\n\n> Puedes sugerir su incorporación usando: *${usedPrefix}${SUGGEST_COMMAND} sugerencia: ${shownName}*`;
        return msg.reply(text);
      }

      const exactMatch = matchingEntries.find(([k, s]) => normalizeStr(s?.name || k) === query);

      if (matchingEntries.length > 1 && !exactMatch) {
        const shown = matchingEntries.slice(0, MAX_MATCHES_SHOWN);
        let text = `╭━━━⳹ 🔍 *COINCIDENCIAS* 🔍 ⳼━━━╮\n`;
        text += `┃ Se encontraron varias variantes:\n`;
        text += `╰━━━━━━━━━━━━━━━━━━━━━━╯\n\n`;
        for (const [index, [k, s]] of shown.entries()) {
          const name = s?.name || k;
          const charCount = Array.isArray(s?.characters) ? s.characters.length : 0;
          text += `🔹 *${index + 1}.* ${name} (*${charCount}* pers.)\n`;
        }
        if (matchingEntries.length > shown.length) {
          text += `\n… y *${matchingEntries.length - shown.length}* más.\n`;
        }
        text += `\n> Escribe el nombre completo (ej: *${usedPrefix + command} dragon ball*) para ver los detalles.`;
        return msg.reply(text.trim());
      }

      const [seriesKey, seriesData] = exactMatch || matchingEntries[0];

      const list = Array.isArray(seriesData?.characters) ? seriesData.characters : [];
      const total = list.length;

      const ownerMap = buildOwnerMap(db.data.chat_users?.[chatId]);

      let claimedCount = 0;
      const processedList = [];

      for (const c of list) {
        const charId = c.id || c.keyword || normalizeStr(c.name || '').replace(/\s+/g, '_');
        const charKey = chatId + '__' + charId;
        const stat = allStats[charKey] || null;

        const baseValue = getBaseValue(c, stat);
        const rarity = getRarity(c, stat, baseValue);
        const valueInfo = resolveValue(baseValue, rarity);

        const owner = stat?.owner || stat?.claimedBy || stat?.user || stat?.claimed || ownerMap.get(charId) || ownerMap.get(charKey) || null;

        if (owner) claimedCount++;

        processedList.push({
          ...c,
          id: charId,
          value: valueInfo.value,
          valueText: valueInfo.text,
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
        replyText += `   └ Val: \`${c.valueText}\` • ${status}\n`;
      }

      replyText += `\n📄 *Página ${page} de ${totalPages}*`;
      if (page < totalPages) {
        replyText += `\n> Usa *${usedPrefix}${command} ${shownName} ${page + 1}* para ver la siguiente página.`;
      }

      await msg.reply(replyText.trim());
    } catch (e) {
      await msg.reply(`> Ocurrió un error inesperado al ejecutar el comando *${usedPrefix + command}*.\n> [Error: *${e.message}*]`);
    }
  }
};
