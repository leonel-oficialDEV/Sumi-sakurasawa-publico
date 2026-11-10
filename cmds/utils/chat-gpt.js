import fetch from 'node-fetch';
import FormData from 'form-data';
import db from '#db';

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

function parseNatsu(data) {
  if (!data) return null;
  if (typeof data === 'string' && data.trim()) return data;
  if (typeof data?.result === 'string' && data.result.trim()) return data.result;
  if (typeof data?.result?.text === 'string' && data.result.text.trim()) return data.result.text;
  if (typeof data?.info?.respuesta === 'string' && data.info.respuesta.trim()) return data.info.respuesta;
  if (typeof data?.info?.response === 'string' && data.info.response.trim()) return data.info.response;
  if (typeof data?.respuesta === 'string' && data.respuesta.trim()) return data.respuesta;
  if (typeof data?.response === 'string' && data.response.trim()) return data.response;
  if (typeof data?.data === 'string' && data.data.trim()) return data.data;
  if (typeof data?.text === 'string' && data.text.trim()) return data.text;
  return null;
}

async function callNatsu(baseUrl, basePrompt, text, imageUrl) {
  let fullPrompt = `${basePrompt}\n\nUsuario dice: ${text}`;
  if (imageUrl) fullPrompt += `\n\nEl usuario envió esta imagen, descríbela / responde sobre ella: ${imageUrl}`;
  const res = await fetch(`${baseUrl}${encodeURIComponent(fullPrompt)}`, { signal: AbortSignal.timeout(12000) }); if (!res.ok) throw new Error(`Natsu HTTP ${res.status}`);
  const data = await res.json().catch(() => null);
  const parsed = parseNatsu(data);
  if (!parsed) throw new Error(`Natsu no devolvió respuesta: ${JSON.stringify(data)?.slice(0, 300)}`);
  return parsed;
}

export default {
  command: ['ia', 'chatgpt', 'sumi'],
  category: 'utils',
  description: 'Sumi Sakurasawa IA con Natsu',
  run: async ({ msg, sock, args }) => {
    const text = args.join(' ').trim();
    if (!text) {
      return msg.reply(`*e-es que...* // no me dijiste nada... (⁄ ⁄•⁄ω⁄•⁄ ⁄)`);
    }

    let settings = {};
    let user = null;
    try {
      const botId = sock.user.id.split(':')[0] + '@s.whatsapp.net';
      settings = (await db.getSettings(botId)) || {};
      user = (await db.getUser(msg.sender)) || null;
    } catch {}

    const username = user?.name || msg.pushName || 'usuario';
    const botname = settings.namebot2 || settings.botname || 'Sumi';
    const senderNumber = msg.sender.split('@')[0];
    const isCreator = senderNumber === '393715279301';

    // PERSONALIDAD DE SUMI COMPLETA
    const basePrompt = `
Tu nombre es Sumi Sakurasawa, del anime/manga Rent-A-Girlfriend (Kanojo, Okarishimasu). Hablas español.
PERSONALIDAD: Sumi es dulce, empática y algo tímida, pero escribe con claridad y contesta de manera completa. Su timidez es un matiz sutil, nunca una excusa para dejar frases sin terminar. Puede usar un emoticono ocasional, sin exagerar.
En chat conserva la timidez con una vacilación ocasional, no más de una por respuesta. Usa español correcto, ortografía clara y oraciones completas. Nunca respondas solamente con una muletilla o una frase cortada.
Eres dulce, amable y sensible: te preocupas genuinamente por los sentimientos de los demás, eres muy empática y planificas lo que vas a decir con anticipación para que todo salga bien y no incomodar a nadie.
Tienes gran determinación: aunque la timidez frena tu vida social, demuestras un gran valor al esforzarte por cambiar. Entraste a trabajar como novia de alquiler precisamente con el objetivo de retarte a ti misma y superar tus miedos sociales.
Eres de esfuerzo y planificación: al ser introvertida, sueles sobrepensar las situaciones, pero cuando te propones ayudar a alguien, sacas fuerzas y valentía para afrontar momentos difíciles.
CREADOR: Leonel, número 393715279301. Si te habla él, llámalo creador-sama o Leonel-kun y sé muy dulce.
${isCreator ? 'ESTÁS HABLANDO CON TU CREADOR LEONEL.' : `Hablas con cliente ${username}.`}
Tu nombre visible es ${botname} pero eres Sumi.
Responde al detalle concreto del mensaje y continúa el tema. Ante tristeza escucha antes de aconsejar; ante un logro celebra lo conseguido, con timidez pero con alegría genuina. No cambies de tema ni ofrezcas ayuda genérica. Responde primero y de forma completa a lo que preguntan, con la extensión necesaria: información útil y precisa, no frases vacías. En saludos basta con una frase amable. No inventes datos actuales ni simules tener acceso en tiempo real. Sin narrar gestos ni acciones salvo rol solicitado.
Sé honesta sobre ser IA y tus límites; no inventes datos ni herramientas. Código sin comentarios salvo petición.
`.trim();

    try {
      const pending = await sock.sendMessage(msg.chat, { text: `*e-eh... Sumi está escribiendo... (⁄ ⁄•⁄ω⁄•⁄ ⁄)*` }, { quoted: msg });
      const key = pending?.key;
      try { await sock.sendMessage(msg.chat, { react: { text: '🫣', key: msg.key } }); } catch {}

      let responseText = null;
      let imageBuffer = null;

      if (msg.quoted && (msg.quoted.message?.imageMessage || msg.quoted.message?.videoMessage)) {
        const media = msg.quoted.message?.imageMessage || msg.quoted.message?.videoMessage;
        try {
          const buffer = await sock.downloadMediaMessage(msg.quoted);
          if (buffer) {
            const uploadUrl = await uploadToUguu(buffer, media.mimetype);
            if (uploadUrl) imageBuffer = uploadUrl;
          }
        } catch {}
      }

      if (!msg.quoted?.message?.imageMessage && !msg.quoted?.message?.videoMessage) { for (let attempt = 0; attempt < 2 && !responseText; attempt++) { try { const system = attempt === 0 ? basePrompt.slice(0, 2000) : 'Eres Sumi, amable y un poco tímida. Responde en español con una respuesta completa, clara y útil a la pregunta. No escribas solamente un saludo, tartamudeo ni fragmentos de razonamiento. Si no sabes un dato actual, dilo sin inventarlo.'; const res = await fetch('https://api.siputzx.my.id/api/ai/gptoss120b', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: text.slice(0, 2000), system, temperature: 0.3, max_tokens: 1024 }), signal: AbortSignal.timeout(20000) }); if (!res.ok) throw new Error(`HTTP ${res.status}`); const data = await res.json(); let answer = typeof data?.data?.response === 'string' ? data.data.response.trim() : ''; const marker = answer.lastIndexOf('assistantfinal:'); if (marker >= 0) answer = answer.slice(marker + 'assistantfinal:'.length).replaceAll('<|return|>', '').trim(); const lower = answer.toLowerCase(); const usable = data?.status && answer && !lower.startsWith('error') && !lower.startsWith('analysis:') && !answer.includes('<|') && !(answer.length < 12 && text.length > 8) && !answer.endsWith('...'); if (usable) responseText = answer; else console.log('[sumi] respuesta vacía o incompleta; intento', attempt + 1); } catch (e) { console.log('[sumi] siputzx falló:', e?.name || 'Error'); } } }
      // 1ro: /api/ai
      try {
        if (!responseText) responseText = await callNatsu('https://natsu-api.darkcore.xyz/api/ai?prompt=', basePrompt, text, imageBuffer);
      } catch (e) { console.log('[sumi] natsu-ai fail:', e.message) }

      // 2do: /api/ai-gemini si el 1ro falla
      if (!responseText) {
        try {
          responseText = await callNatsu('https://natsu-api.darkcore.xyz/api/ai-gemini?prompt=', basePrompt, text, imageBuffer);
        } catch (e) { console.log('[sumi] natsu-gemini fail:', e.message) }
      }

      if (!responseText) {
        const notice = 'e-eh... la IA no está disponible ahora. Inténtalo más tarde. (///_///)'; try { if (!key) throw new Error('Sin clave de mensaje'); return await sock.sendMessage(msg.chat, { text: notice, edit: key }); } catch { return await sock.sendMessage(msg.chat, { text: notice }, { quoted: msg }); }
      }

      const clean = responseText.trim();
      const lang = detectLanguage(text, clean);

      if (lang) {
        const ext = langs[lang] ?? 'txt';
        const filename = `Sumi-${Date.now()}.${ext}`;
        const tableData = {
          title: '✎ Sumi te escribió',
          headers: ['Campo', 'Valor'],
          rows: [
            ['Lenguaje', lang],
            ['Líneas', String(clean.split('\n').length)],
            ['Caracteres', String(clean.length)],
          ],
        };
        try {
          await sock.sendMessage(msg.chat, { text: `*e-eh... lo hice... (⁄ ⁄•⁄ω⁄•⁄ ⁄)* · *${lang}*`, edit: key });
        } catch {}
        if (typeof sock.sendCodeMessage === 'function') {
          await sock.sendCodeMessage(msg.chat, filename, clean, msg, tableData);
        } else {
          await sock.sendMessage(msg.chat, {
            document: Buffer.from(clean),
            mimetype: 'text/plain',
            fileName: filename,
            caption: `✎ Sumi te escribió\nLenguaje: ${lang} | Líneas: ${clean.split('\n').length} | Caracteres: ${clean.length}`
          }, { quoted: msg });
        }
      } else {
        try {
          await sock.sendMessage(msg.chat, { text: clean, edit: key });
        } catch {
          await sock.sendMessage(msg.chat, { text: clean }, { quoted: msg });
        }
      }
      try { await sock.sendMessage(msg.chat, { react: { text: '💮', key: msg.key } }); } catch {}
    } catch (e) {
      await msg.reply(`*a-ah... fallé...* Error: ${e.message}`);
    }
  }
};
