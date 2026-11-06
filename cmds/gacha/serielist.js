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

function getSeriesList(structure) {
  if (!structure) return [];

  const map = {};

  const processCharacter = (c, defaultSource = 'Desconocido') => {
    if (!c || typeof c !== 'object') return;
    const rawSrc = c.source || c.series || c.anime || defaultSource;
    const src = getBaseName(rawSrc);
    map[src] = (map[src] || 0) + 1;
  };

  if (Array.isArray(structure)) {
    const isSeriesArray = structure.some(s => s && Array.isArray(s.characters));
    if (isSeriesArray) {
      for (const [i, s] of structure.entries()) {
        if (!s || typeof s !== 'object') continue;
        const rawName = s.name || s.title || s.series || `Serie ${i + 1}`;
        if (Array.isArray(s.characters)) {
          for (const c of s.characters) {
            processCharacter(c, rawName);
          }
        }
      }
    } else {
      for (const c of structure) {
        processCharacter(c);
      }
    }
  } else if (typeof structure === 'object' && structure !== null) {
    for (const [key, serie] of Object.entries(structure)) {
      if (!serie || typeof serie === 'function') continue;

      if (Array.isArray(serie)) {
        for (const c of serie) {
          processCharacter(c, key);
        }
      } else if (Array.isArray(serie.characters)) {
        const rawName = serie.name || serie.title || key;
        for (const c of serie.characters) {
          processCharacter(c, rawName);
        }
      } else if (typeof serie.characters === 'object' && serie.characters !== null) {
        const rawName = serie.name || serie.title || key;
        for (const c of Object.values(serie.characters)) {
          processCharacter(c, rawName);
        }
      } else if (serie.name && typeof serie.name === 'string' && (serie.source || serie.series || serie.anime)) {
        processCharacter(serie, key);
      }
    }
  }

  return Object.entries(map)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export default {
  command: ['serielist', 'slist', 'animelist'],
  category: 'gacha',
  description: 'Listar series registradas en el sistema.',
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

      const structure = await loadCharacters();
      const seriesList = getSeriesList(structure);
      const totalSeries = seriesList.length;

      if (totalSeries === 0) {
        return msg.reply(`ꕥ No hay series registradas en *lib/characters.js*.`);
      }

      const page = parseInt(args[0]) || 1;
      const perPage = 15;
      const totalPages = Math.max(1, Math.ceil(totalSeries / perPage));

      if (page < 1 || page > totalPages) {
        return msg.reply(`ꕥ Página no válida. Hay un total de *${totalPages}* páginas disponibles.`);
      }

      const start = (page - 1) * perPage;
      const end = Math.min(start + perPage, totalSeries);
      const seriesPage = seriesList.slice(start, end);

      let replyText = `╭──╢ 📚 *LISTA DE SERIES* 📚 ╟──╮\n`;
      replyText += `│ Total registradas: *${totalSeries}*\n`;
      replyText += `╰────────────────────────╯\n\n`;

      for (const [index, serie] of seriesPage.entries()) {
        const itemNum = start + index + 1;
        replyText += `│ *${itemNum}.* ${serie.name} ──> *${serie.count}* pers.\n`;
      }

      replyText += `\n> 📄 *Página ${page}/${totalPages}* • Usa *${usedPrefix + command} [página]* para ver más.`;
      
      await msg.reply(replyText.trim());
    } catch (e) {
      await msg.reply(`> Ocurrió un error inesperado al ejecutar el comando *${usedPrefix + command}*.\n> [Error: *${e.message}*]`);
    }
  }
};
    
