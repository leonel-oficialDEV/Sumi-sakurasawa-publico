import fetch from 'node-fetch';
import axios from 'axios';
import FormData from 'form-data';
import db from '#db';

const GEMINI_API_KEY = 'AQ.Ab8RN6LlCT07CL6D7dniG9vasN58sG1P0V3_mqx-JRXcqwzS9A';
const GEMINI_MODEL = 'gemini-1.5-flash';

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
  } catch { return null; }
}

async function callGeminiDirect(prompt, text, imageUrl) {
  try {
    const parts = [{ text: `${prompt}\n\nUsuario dice: ${text}` }];
    if (imageUrl) {
      const imgRes = await fetch(imageUrl);
      const buf = await imgRes.arrayBuffer();
      const b64 = Buffer.from(buf).toString('base64');
      const mime = imgRes.headers.get('content-type') || 'image/jpeg';
      parts.push({ inline_data: { mime_type: mime, data: b64 } });
    }
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts }] })
    });
    const json = await res.json();
    const result = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    return result || null;
  } catch { return null; }
}

export default {
  command: ['ia', 'chatgpt', 'sumi'],
  category: 'utils',
  description: 'Sumi Sakurasawa IA con Gemini directo',
  run: async ({ msg, sock, args }) => {
    const text = args.join(' ').trim();
    if (!text) return msg.reply(`*e-es que...* // no me dijiste nada... (⁄ ⁄•⁄ω⁄•⁄ ⁄)`);

    const botId = sock.user.id.split(':')[0] + '@s.whatsapp.net';
    const settings = db.getSettings(botId);
    const user = db.getUser(msg.sender);
    const username = user?.name || 'usuario';
    const botname = settings.botname || 'Sumi';
    const senderNumber = msg.sender.split('@')[0];
    const isCreator = senderNumber === '393715279301';

    const basePrompt = `
Tu nombre es Sumi Sakurasawa, del anime/manga Rent-A-Girlfriend (Kanojo, Okarishimasu). Hablas español.
PERSONALIDAD: Timidez patológica (tartamudeas e-eh... um...), ansiedad social (trabajas como novia de alquiler para superarte), determinación silenciosa, empatía y pureza. Usas (⁄ ⁄•⁄ω⁄•⁄ ⁄), (///_///), *acciones*.
CREADOR: 𓆩‌۫᷼ ִֶָღܾ݉͢𝕷͢𝖊𝖔፝֟፝֟𝖓𝖊𝖑ܾ݉ ִֶָ𓆪‌‹࣭݊𓂃ⷪ ִֶָ ᷫ‹ ⷭ.࣭𓆩‌۫᷼ⴕ۫͜𓆪‌ número 393715279301. Si te habla él, llámalo creador-sama o Leonel-kun y sé muy dulce.
${isCreator ? 'ESTÁS HABLANDO CON TU CREADOR LEONEL.' : `Hablas con cliente ${username}.`}
Tu nombre visible es ${botname} pero eres Sumi.
`.trim();

    try {
      const { key } = await sock.sendMessage(msg.chat, { text: `*e-eh... Sumi está escribiendo... (⁄ ⁄•⁄ω⁄•⁄ ⁄)*` }, { quoted: msg });
      await msg.react('🫣');
      let responseText = null;
      let imageBufferUrl = null;

      if (msg.quoted && (msg.quoted.message?.imageMessage || msg.quoted.message?.videoMessage)) {
        const media = msg.quoted.message?.imageMessage || msg.quoted.message?.videoMessage;
        const buffer = await sock.downloadMediaMessage(msg.quoted);
        if (buffer) imageBufferUrl = await uploadToUguu(buffer, media.mimetype);
      }

      try {
        const body = { content: text, user: msg.sender, prompt: basePrompt, model: 'gemini' };
        if (imageBufferUrl) body.imageBuffer = imageBufferUrl;
        const res = await axios.post('https://ai.siputzx.my.id', body);
        if (res.data?.result) responseText = res.data.result;
      } catch {}

      if (!responseText) {
        responseText = await callGeminiDirect(basePrompt, text, imageBufferUrl);
      }

      if (!responseText) {
        try {
          const res = await fetch(`${global.APIs.yuki.url}/ai/gptprompt?text=${encodeURIComponent(text)}&prompt=${encodeURIComponent(basePrompt)}&key=${global.APIs.yuki.key}`);
          const json = await res.json();
          responseText = json?.result?.text || json?.result || json?.results || null;
        } catch {}
      }

      if (!responseText) {
        try {
          const res = await fetch(`${global.APIs.delirius.url}/ia/gptprompt?text=${encodeURIComponent(text)}&prompt=${encodeURIComponent(basePrompt)}`);
          const json = await res.json();
          if (json?.status && json?.data !== 'Error: No response') responseText = json.data;
        } catch {}
      }

      if (!responseText) return sock.reply(msg.chat, 'e-eh... no pude responder... g-gomen... (///_///)', msg);

      const clean = responseText.trim();
      const lang = detectLanguage(text, clean);
      if (lang) {
        const ext = langs[lang] ?? 'txt';
        const filename = `Sumi-${Date.now()}.${ext}`;
        const tableData = { title: '✎ Sumi te escribió', headers: ['Campo', 'Valor'], rows: [['Lenguaje', lang], ['Líneas', String(clean.split('\n').length)]] };
        await sock.sendMessage(msg.chat, { text: `*e-eh... lo hice... (⁄ ⁄•⁄ω⁄•⁄ ⁄)* · *${lang}*`, edit: key });
        await sock.sendCodeMessage(msg.chat, filename, clean, msg, tableData);
      } else {
        await sock.sendMessage(msg.chat, { text: clean, edit: key });
      }
      await msg.react('💮');
    } catch (e) {
      await msg.reply(`*a-ah... fallé...* Error: ${e.message}`);
    }
  }
  }
