import { sendChannelMessage } from '../../lib/channel.js'
import db from "#db"
import fetch from 'node-fetch';

export default {
  command: ['mf', 'mediafire'],
  category: 'downloader',
  run: async ({ msg, sock, args }) => {
    try {
      let text = args.join(' ')
      if (!text) return msg.reply('✐ Ingresa una URL de Mediafire.');
      if (!/^https?:\/\/(www\.)?mediafire\.com/.test(text)) {
        return msg.reply('✦ Solo se aceptan enlaces de Mediafire.');
      }

      const apiUrl = `${api.url}/dl/mediafire?url=${encodeURIComponent(text)}&key=${api.key}`;
      const res = await fetch(apiUrl);
      const json = await res.json();

      if (!json.status) return msg.reply('✦ No se pudo obtener el archivo.');

      const { filename, filetype, filesize, uploaded, download } = json.result;

      let info = `📢 Canal: ${global.links?.channel || 'https://whatsapp.com/channel/0029Vagdmfv1SWt5nfdR4z3w'}\n\n˚ʚ♡ɞ₊ *MEDIAFIRE - DL* ෆ╹ .̮ ╹ෆ\n\n`;
      info += `➩ Descargando › *${filename}*\n`;
      info += `> ❖ Tipo › *${filetype}*\n`;
      info += `> ❖ Tamaño › *${filesize}*\n`;
      info += `> ❖ Subido › *${uploaded}*\n\n`;
      info += `⇢ Descargando y enviando archivo...`;

    await sendChannelMessage(sock, msg.chat, { text: info }, { quoted: msg })

      await sendChannelMessage(sock, 
        msg.chat,
        {
          document: { url: download },
          mimetype: 'application/octet-stream',
          fileName: filename,
        },
        { quoted: msg }
      );
    } catch (e) {
      console.error(e);
      msg.reply(msgglobal);
    }
  },
};