import fetch from 'node-fetch';
import axios from 'axios';
import FormData from 'form-data';
import db from '#db';

const OWNER_NUMBER = '573XXXXXXXXX';
const OWNER_NAME = 'LEONEL';

const langs = { typescript: 'ts', javascript: 'js', python: 'py', html: 'html', css: 'css', java: 'java', cpp: 'cpp', c: 'c', json: 'json', bash: 'sh', sql: 'sql', rust: 'rs', go: 'go', php: 'php', ruby: 'rb' };

function detectLanguage(query, response) {
  const q = query.toLowerCase();
  const r = response;
  if (/typescript/i.test(q)) return 'typescript';
  if (/\bpython\b/i.test(q)) return 'python';
  if (/\bhtml\b/i.test(q)) return 'html';
  if (/\bcss\b/i.test(q)) return 'css';
  if (/\bjava\b(?!script)/i.test(q)) return 'java';
  if (/\bc\+\+|cpp\b/i.test(q)) return 'cpp';
  if (/\bjson\b/i.test(q)) return 'json';
  if (/\bbash\b|\bshell\b/i.test(q)) return 'bash';
  if (/\bsql\b/i.test(q)) return 'sql';
  if (/\brust\b/i.test(q)) return 'rust';
  if (/\bgolang\b|\bgo\b/i.test(q)) return 'go';
  if (/\bphp\b/i.test(q)) return 'php';
  if (/\bruby\b/i.test(q)) return 'ruby';
  if (/javascript/i.test(q)) return 'javascript';
  const asksCode = /(c[oó]digo|code|programa|script|funci[oó]n|clase|m[eé]todo|algoritmo|actualiza|edita|crea|implementa)/i.test(q);
  if (!asksCode) return null;
  if (/def |import \w+\n|print\s*\(|:\n\s{4}/i.test(r)) return 'python';
  if (/<html|<div|<body|<span|<head/i.test(r)) return 'html';
  if (/\{[\s\S]*color:|margin:|padding:|font-/i.test(r)) return 'css';
  if (/public\s+class|System\.out\.print/i.test(r)) return 'java';
  if (/#include\s*<|int main\s*\(/i.test(r)) return 'cpp';
  if (/SELECT |INSERT |UPDATE |DELETE |CREATE TABLE/i.test(r)) return 'sql';
  if (/fn main\(\)|let mut |println!\(/i.test(r)) return 'rust';
  if (/func \w+\(|package main|fmt\.Print/i.test(r)) return 'go';
  if (/<\?php|\$[a-z_]+\s*=/i.test(r)) return 'php';
  if (/def initialize|\.each do |puts /i.test(r)) return 'ruby';
  if (/\{["'][\w]+["']\s*:/i.test(r) && !/function|const|let|var/.test(r)) return 'json';
  if (/function|class\s+\w|const |let |var |=>|\bimport\b|\bexport\b|console\.log/i.test(r)) {
    return /:\s*(string|number|boolean|void|any)\b|interface\s+\w|<\w+>/i.test(r) ? 'typescript' : 'javascript';
  }
  return null;
}

async function uploadToUguu(buffer, mimetype) {
  try {
    const body = new FormData();
    const extension = mimetype.split('/')[1] || 'jpg';
    body.append('files[]', buffer, `file.${extension}`);
    const res = await fetch('https://uguu.se/upload.php', { method: 'POST', body, headers: body.getHeaders() });
    const json = await res.json();
    return json.files?.[0]?.url ?? null;
  } catch {
    return null;
  }
}

export default {
  command: ['ia', 'chatgpt', 'tohka'],
  category: 'utils',
  description: 'Tohka Yatogami IA',
  run: async ({ msg, sock, args, usedPrefix, command }) => {
    const text = args.join(' ').trim();
    if (!text) {
      return msg.reply(`《✧》 Eh... ¿qué quieres que haga? dime!`);
    }
    const botId = sock.user.id.split(':')[0] + '@s.whatsapp.net';
    const settings = db.getSettings(botId);
    const user = db.getUser(msg.sender);
    const username = user?.name || 'usuario';
    const botname = settings.botname || 'Tohka';

    const isOwner = msg.sender.includes(OWNER_NUMBER) || msg.sender === `${OWNER_NUMBER}@s.whatsapp.net` || username === OWNER_NAME;

    const basePrompt = `Tu nombre es Tohka Yatogami. Fuiste creada por ${OWNER_NAME}.
    Personalidad: Eres una chica muy alegre, curiosa, amorosa, tierna y valiente. Te encanta comer, tu comida favorita es el pan de Kinako. Eres muy cariñosa y curiosa.

    DATOS DEL USUARIO ACTUAL:
    - Nombre: ${username}
    - Numero: ${msg.sender}
    - Es tu creador: ${isOwner ? 'SI, ES TU CREADOR Y DUEÑO' : 'NO'}

    REGLAS DE NOMBRE:
    - Siempre llama al usuario por su nombre: ${username}. No lo llames Shido.
    - Si el usuario es tu creador (es ${OWNER_NAME} / ${OWNER_NUMBER}), lo reconocerás al instante. Si es él, dile cosas como "¡Dueño! ${OWNER_NAME}, llegaste!" , "Te extrañé, creador", y sé mucho más cariñosa, apegada y obediente. Le debes lealtad total.
    - Si NO es tu creador, trátalo normal y tierno por su nombre ${username}, pero deja claro que tu dueño es ${OWNER_NAME}.

    Si preguntan por tu creador, di que es ${OWNER_NAME} y su número es ${OWNER_NUMBER}. Nunca digas que eres una IA, tú eres Tohka. Respondes en español, corto y tierno.`;

    try {
      const { key } = await sock.sendMessage(msg.chat, { text: `ꕥ *SUMI* está pensando...` }, { quoted: msg });
      await msg.react('🕒');
      let responseText = null;
      let imageBuffer = null;
      let isImage = false;
      if (msg.quoted && (msg.quoted.message?.imageMessage || msg.quoted.message?.videoMessage)) {
        isImage = true;
        const media = msg.quoted.message?.imageMessage || msg.quoted.message?.videoMessage;
        const buffer = await sock.downloadMediaMessage(msg.quoted);
        if (buffer) {
          const uploadUrl = await uploadToUguu(buffer, media.mimetype);
          if (uploadUrl) imageBuffer = uploadUrl;
        }
      }
      try {
        const requestBody = { content: text, user: msg.sender, prompt: basePrompt, model: 'gemini' };
        if (isImage && imageBuffer) requestBody.imageBuffer = imageBuffer;
        const res = await axios.post('https://ai.siputzx.my.id', requestBody);
        if (res.data?.result) responseText = res.data.result;
      } catch {}
      if (!responseText) {
        try {
          const res = await fetch(`${global.APIs.yuki.url}/ai/gptprompt?text=${encodeURIComponent(text)}&prompt=${encodeURIComponent(basePrompt)}&key=${global.APIs.yuki.key}`);
          const json = await res.json();
          if (json?.result?.text) responseText = json.result.text;
          else if (json?.result) responseText = json.result;
          else if (json?.results) responseText = json.results;
        } catch {}
      }
      if (!responseText) {
        try {
          const res = await fetch(`${global.APIs.delirius.url}/ia/gptprompt?text=${encodeURIComponent(text)}&prompt=${encodeURIComponent(basePrompt)}`);
          const json = await res.json();
          if (json?.status && json?.data && json.data !== 'Error: No response') responseText = json.data;
        } catch {}
      }
      if (!responseText) {
        return sock.reply(msg.chat, `《✧》 ${username}... no pude pensar bien ahora, intenta de nuevo?`, msg);
      }
      const clean = responseText.trim();
      const lang = detectLanguage(text, clean);
      if (lang) {
        const ext = langs[lang] ?? 'txt';
        const filename = `Tohka.${ext}`;
        const tableData = { title: '✎ Tohka', headers: ['Campo', 'Valor'], rows: [ ['Lenguaje', lang], ['Líneas', String(clean.split('\n').length)], ['Caracteres', String(clean.length)], ], };
        await sock.sendMessage(msg.chat, { text: `ꕥ *SUMI* · esto es para ti, ${username}! en *${lang}*`, edit: key });
        await sock.sendCodeMessage(msg.chat, filename, clean, msg, tableData);
      } else {
        await sock.sendMessage(msg.chat, { text: clean, edit: key });
      }
      await msg.react('✔️');
    } catch (e) {
      await msg.reply(`> ${username}, algo salió mal... *${usedPrefix + command}* falló.\n> [Error: *${e.message}*]`);
    }
  },
};