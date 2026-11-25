import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);
const MAX_DURATION = 90;
const MAX_WEBP_SECONDS = 10;
const SESSION_SECONDS = 60;

// Pon aqui el ID de tu canal de WhatsApp (termina en @newsletter)
const DEFAULT_CHANNEL_JID = '120363421126587923@newsletter';

if (!globalThis.__audioStickerSessions) {
  globalThis.__audioStickerSessions = new Map();
}
const sessions = globalThis.__audioStickerSessions;

let baileysCache = null;

async function getBaileys() {
  if (baileysCache) return baileysCache;
  for (const pkg of ['@whiskeysockets/baileys', 'baileys', '@rexxhayanasi/elaina-baileys']) {
    try {
      const mod = await import(pkg);
      const target = mod?.proto ? mod : mod?.default?.proto ? mod.default : mod;
      if (target?.prepareWAMessageMedia && target?.proto) {
        baileysCache = target;
        return baileysCache;
      }
    } catch {}
  }
  throw new Error('No se encontró ningún paquete de Baileys instalado.');
}

function getFfmpegBin() {
  const localBin = path.join(
    process.cwd(),
    'node_modules',
    '@ffmpeg-installer',
    'linux-x64',
    'ffmpeg',
  );
  return existsSync(localBin) ? localBin : 'ffmpeg';
}

function extractTargetDestination(rawText, fallbackChat) {
  let clean = String(rawText || '').trim();
  let targetChat = fallbackChat;
  let isChannel = false;

  const newsletterMatch = clean.match(/\b(\d+@newsletter)\b/i);
  if (newsletterMatch) {
    targetChat = newsletterMatch[1];
    isChannel = true;
    clean = clean.replace(newsletterMatch[0], '').trim();
  } else if (/\b(canal|channel)\b/i.test(clean)) {
    targetChat = DEFAULT_CHANNEL_JID;
    isChannel = true;
    clean = clean.replace(/\b(canal|channel)\b/i, '').trim();
  }

  return { targetChat, cleanText: clean, isChannel };
}

function patchProtoInstance(p) {
  const M = p?.Message;
  if (!M || M.__audioStickerPatchedV3) return;

  if (M.StickerMessage) {
    const prevStickerEncode = M.StickerMessage.encode;
    M.StickerMessage.encode = function (message, writer) {
      const audio = message?.audioMessage;
      if (audio && Object.prototype.hasOwnProperty.call(message, 'audioMessage')) {
        delete message.audioMessage;
      }
      const w = prevStickerEncode.call(this, message, writer);
      if (audio && M.AudioMessage) {
        message.audioMessage = audio;
        M.AudioMessage.encode(audio, w.uint32(210).fork()).ldelim();
      }
      return w;
    };

    if (typeof M.StickerMessage.fromObject === 'function') {
      const prevStickerFromObj = M.StickerMessage.fromObject;
      M.StickerMessage.fromObject = function (object) {
        const msg = prevStickerFromObj.call(this, object);
        if (object?.audioMessage) {
          msg.audioMessage = M.AudioMessage?.fromObject
            ? M.AudioMessage.fromObject(object.audioMessage)
            : object.audioMessage;
        }
        return msg;
      };
    }
  }

  const prevMsgEncode = M.encode;
  M.encode = function (message, writer) {
    const asm = message?.audioStickerMessage;
    if (asm) {
      if (Object.prototype.hasOwnProperty.call(message, 'stickerMessage')) {
        delete message.stickerMessage;
      }
      if (Object.prototype.hasOwnProperty.call(message, 'audioStickerMessage')) {
        delete message.audioStickerMessage;
      }
    }
    const w = prevMsgEncode.call(this, message, writer);
    if (asm && M.FutureProofMessage) {
      message.audioStickerMessage = asm;
      M.FutureProofMessage.encode(asm, w.uint32(1074).fork()).ldelim();
    }
    return w;
  };

  if (typeof M.fromObject === 'function') {
    const prevMsgFromObj = M.fromObject;
    M.fromObject = function (object) {
      const msg = prevMsgFromObj.call(this, object);
      if (object?.audioStickerMessage) {
        const inner = object.audioStickerMessage.message || object.audioStickerMessage;
        if (inner?.stickerMessage && object.audioStickerMessage.message?.stickerMessage?.audioMessage) {
          inner.stickerMessage.audioMessage = object.audioStickerMessage.message.stickerMessage.audioMessage;
        }
        msg.audioStickerMessage = { message: inner };
        delete msg.stickerMessage;
        if (inner) {
          Object.setPrototypeOf(msg, inner);
        }
      }
      return msg;
    };
  }

  M.__audioStickerPatchedV3 = true;
}

async function ensurePatched() {
  const b = await getBaileys();
  patchProtoInstance(b.proto);
  for (const pkg of ['@whiskeysockets/baileys', 'baileys', '@rexxhayanasi/elaina-baileys']) {
    try {
      const mod = await import(pkg);
      if (mod?.proto) patchProtoInstance(mod.proto);
      if (mod?.default?.proto) patchProtoInstance(mod.default.proto);
    } catch {}
  }
  return b;
}

function getSessionKey(msg) {
  return String(msg.chat || msg.key?.remoteJid) + ':' + String(msg.sender || msg.key?.participant || '');
}

function clearUserSession(key) {
  const existing = sessions.get(key);
  if (existing?.timer) clearTimeout(existing.timer);
  sessions.delete(key);
}

function unwrapMessageContainer(raw) {
  let cur = raw;
  for (let i = 0; i < 6 && cur; i++) {
    const next =
      cur.ephemeralMessage?.message ||
      cur.viewOnceMessageV2?.message ||
      cur.viewOnceMessageV2Extension?.message ||
      cur.viewOnceMessage?.message ||
      cur.documentWithCaptionMessage?.message ||
      cur.editedMessage?.message;
    if (!next) break;
    cur = next;
  }
  return cur || {};
}

function detectMediaInfo(node) {
  if (!node) return { kind: null, mime: '', seconds: 0, mediaObj: null, dlType: null };

  const container = unwrapMessageContainer(node.message || node.fakeObj?.message || {});
  const mtype =
    node.mtype ||
    node.type ||
    Object.keys(container).find((k) =>
      /imageMessage|videoMessage|stickerMessage|audioMessage|documentMessage/i.test(k),
    ) ||
    '';

  const directMsg =
    node.msg &&
    typeof node.msg === 'object' &&
    (node.msg.mediaKey || node.msg.url || node.msg.directPath || node.msg.mimetype)
      ? node.msg
      : null;

  const mediaObj =
    directMsg ||
    container[mtype] ||
    container.videoMessage ||
    container.imageMessage ||
    container.stickerMessage ||
    container.audioMessage ||
    container.documentMessage ||
    (node.mediaKey || node.url || node.directPath ? node : null);

  const mime = String(node.mimetype || mediaObj?.mimetype || '').toLowerCase();
  const seconds = Number(mediaObj?.seconds || node.seconds || node.msg?.seconds || 0);

  if (/video/i.test(mime) || /videoMessage/i.test(mtype)) {
    const dlType = /documentMessage/i.test(mtype) ? 'document' : 'video';
    return { kind: 'video', mime: mime || 'video/mp4', seconds, mediaObj, dlType };
  }
  if (/webp/i.test(mime) || /stickerMessage/i.test(mtype)) {
    const isAnim = Boolean(mediaObj?.isAnimated);
    return { kind: 'webp', mime: 'image/webp', seconds, isAnimated: isAnim, mediaObj, dlType: 'sticker' };
  }
  if (/image/i.test(mime) || /imageMessage/i.test(mtype)) {
    const dlType = /documentMessage/i.test(mtype) ? 'document' : 'image';
    return { kind: 'image', mime: mime || 'image/jpeg', seconds: 0, mediaObj, dlType };
  }
  if (/audio|ogg|opus|mpeg|mp3|wav|m4a|aac/i.test(mime) || /audioMessage/i.test(mtype)) {
    const dlType = /documentMessage/i.test(mtype) ? 'document' : 'audio';
    return { kind: 'audio', mime: mime || 'audio/mpeg', seconds, mediaObj, dlType };
  }
  return { kind: null, mime: '', seconds: 0, mediaObj: null, dlType: null };
}

async function downloadBuffer(node, info, sock) {
  if (!node) return null;
  const { downloadContentFromMessage, downloadMediaMessage } = await getBaileys();

  if (typeof node.download === 'function') {
    try {
      const buf = await node.download();
      if (buf?.length) return buf;
    } catch {}
  }

  if (
    downloadContentFromMessage &&
    info?.mediaObj &&
    info?.dlType &&
    (info.mediaObj.mediaKey || info.mediaObj.directPath || info.mediaObj.url)
  ) {
    try {
      const stream = await downloadContentFromMessage(info.mediaObj, info.dlType);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      if (buf.length) return buf;
    } catch {}
  }

  if (downloadMediaMessage && (node.fakeObj?.message || node.message)) {
    try {
      const msgObj = node.fakeObj?.message ? node.fakeObj : node;
      const buf = await downloadMediaMessage(
        msgObj,
        'buffer',
        {},
        {
          logger: { info: () => {}, error: () => {}, warn: () => {} },
          reuploadRequest: sock?.updateMediaMessage,
        },
      );
      if (buf?.length) return buf;
    } catch {}
  }

  return null;
}

function buildExifPayload(packname, author) {
  const json = {
    'sticker-pack-id': 'com.tohka.bot.audiosticker',
    'sticker-pack-name': String(packname ?? ''),
    'sticker-pack-publisher': String(author ?? ''),
    emojis: ['🔊'],
  };
  const exifAttr = Buffer.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
  ]);
  const jsonBuff = Buffer.from(JSON.stringify(json), 'utf-8');
  const exif = Buffer.concat([exifAttr, jsonBuff]);
  exif.writeUIntLE(jsonBuff.length, 14, 4);
  return exif;
}

function injectExifRiffFallback(webpBuffer, exifData) {
  if (
    !Buffer.isBuffer(webpBuffer) ||
    webpBuffer.length < 16 ||
    webpBuffer.toString('ascii', 0, 4) !== 'RIFF' ||
    webpBuffer.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    return webpBuffer;
  }

  const chunks = [];
  let offset = 12;
  let hasVp8x = false;
  let isAnim = false;

  while (offset + 8 <= webpBuffer.length) {
    const id = webpBuffer.toString('ascii', offset, offset + 4);
    const size = webpBuffer.readUInt32LE(offset + 4);
    const padded = size + (size % 2);
    const end = Math.min(webpBuffer.length, offset + 8 + padded);
    const rawChunk = Buffer.from(webpBuffer.subarray(offset, end));

    if (id === 'VP8X') hasVp8x = true;
    if (id === 'ANIM' || id === 'ANMF') isAnim = true;
    if (id !== 'EXIF') chunks.push({ id, rawChunk });

    offset = end;
  }

  if (!hasVp8x) {
    const vp8x = Buffer.alloc(18);
    vp8x.write('VP8X', 0, 4, 'ascii');
    vp8x.writeUInt32LE(10, 4);
    vp8x[8] = 0x18;
    vp8x.writeUIntLE(511, 12, 3);
    vp8x.writeUIntLE(511, 15, 3);
    chunks.unshift({ id: 'VP8X', rawChunk: vp8x });
  } else {
    const vp8xEntry = chunks.find((c) => c.id === 'VP8X');
    if (vp8xEntry && vp8xEntry.rawChunk.length >= 18) {
      vp8xEntry.rawChunk[8] |= 0x08;
      if (isAnim) vp8xEntry.rawChunk[8] |= 0x02;
    }
  }

  const padByte = exifData.length % 2 === 1 ? Buffer.from([0x00]) : Buffer.alloc(0);
  const exifHeader = Buffer.alloc(8);
  exifHeader.write('EXIF', 0, 4, 'ascii');
  exifHeader.writeUInt32LE(exifData.length, 4);
  chunks.push({ id: 'EXIF', rawChunk: Buffer.concat([exifHeader, exifData, padByte]) });

  const body = Buffer.concat(chunks.map((c) => c.rawChunk));
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 4, 'ascii');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 4, 'ascii');

  return Buffer.concat([header, body]);
}

async function addStickerExif(webpBuffer, packname, author) {
  const exifData = buildExifPayload(packname, author);
  try {
    const webpMod = await import('node-webpmux');
    const WebpImage = webpMod.default?.Image || webpMod.Image || webpMod.default;
    if (WebpImage) {
      const img = new WebpImage();
      await img.load(webpBuffer);
      img.exif = exifData;
      return await img.save(null);
    }
  } catch {}
  return injectExifRiffFallback(webpBuffer, exifData);
}

function isWebpAnimated(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) return false;
  if (buf.toString('ascii', 12, 16) === 'VP8X' && (buf[20] & 0x02) !== 0) return true;
  return buf.includes(Buffer.from('ANIM'));
}

async function videoBufferToAnimatedWebp(buffer) {
  const ffmpeg = getFfmpegBin();
  const tmpId = randomBytes(6).toString('hex');
  const inPath = path.join(os.tmpdir(), 'as_vid_' + tmpId + '.mp4');
  const outPath = path.join(os.tmpdir(), 'as_out_' + tmpId + '.webp');

  const encodeAttempt = async (fps, qv) => {
    await execFileAsync(ffmpeg, [
      '-y',
      '-i', inPath,
      '-t', String(MAX_WEBP_SECONDS),
      '-vf', 'fps=' + fps + ',scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000,setsar=1',
      '-c:v', 'libwebp',
      '-lossless', '0',
      '-compression_level', '6',
      '-q:v', String(qv),
      '-loop', '0',
      '-preset', 'picture',
      '-an',
      '-vsync', '0',
      outPath,
    ]);
    return await fs.readFile(outPath);
  };

  try {
    await fs.writeFile(inPath, buffer);
    const profiles = [
      [10, 50],
      [8, 36],
      [6, 24],
      [5, 16],
    ];
    let webp = null;
    for (const [fps, qv] of profiles) {
      webp = await encodeAttempt(fps, qv);
      if (webp.length <= 880 * 1024) break;
    }
    return webp;
  } finally {
    await fs.unlink(inPath).catch(() => {});
    await fs.unlink(outPath).catch(() => {});
  }
}

async function imageBufferToWebp(buffer) {
  try {
    const sharp = (await import('sharp')).default;
    return await sharp(buffer, { animated: true })
      .rotate()
      .resize(512, 512, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .webp({ quality: 82 })
      .toBuffer();
  } catch {
    const ffmpeg = getFfmpegBin();
    const tmpId = randomBytes(6).toString('hex');
    const inPath = path.join(os.tmpdir(), 'as_img_' + tmpId + '.jpg');
    const outPath = path.join(os.tmpdir(), 'as_img_out_' + tmpId + '.webp');
    try {
      await fs.writeFile(inPath, buffer);
      await execFileAsync(ffmpeg, [
        '-y',
        '-i', inPath,
        '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000,setsar=1',
        '-c:v', 'libwebp',
        '-lossless', '0',
        '-q:v', '80',
        '-an',
        outPath,
      ]);
      return await fs.readFile(outPath);
    } finally {
      await fs.unlink(inPath).catch(() => {});
      await fs.unlink(outPath).catch(() => {});
    }
  }
}

async function buildStickerWithExif(buffer, kind, packname, author) {
  let rawWebp = buffer;
  if (kind === 'video') {
    rawWebp = await videoBufferToAnimatedWebp(buffer);
  } else if (kind === 'image') {
    rawWebp = await imageBufferToWebp(buffer);
  }
  return await addStickerExif(rawWebp, packname, author);
}

function parseFfmpegDuration(stderrText) {
  const matches = [...String(stderrText || '').matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  if (!matches.length) return 0;
  const last = matches[matches.length - 1];
  const sec = Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
  return Number.isFinite(sec) ? sec : 0;
}

function generateWaveform(seedBuf, length = 64) {
  const wf = Buffer.alloc(length);
  for (let i = 0; i < length; i++) {
    const b = seedBuf && seedBuf.length ? seedBuf[(i * 19 + 7) % seedBuf.length] : i * 11;
    wf[i] = 18 + (b % 76);
  }
  return wf;
}

async function convertToOggOpus(buffer, ext = 'mp3') {
  const ffmpeg = getFfmpegBin();
  const tmpId = randomBytes(6).toString('hex');
  const inPath = path.join(os.tmpdir(), 'ptt_in_' + tmpId + '.' + ext);
  const outPath = path.join(os.tmpdir(), 'ptt_out_' + tmpId + '.ogg');
  try {
    await fs.writeFile(inPath, buffer);
    const { stderr } = await execFileAsync(ffmpeg, [
      '-y',
      '-i', inPath,
      '-vn',
      '-map', '0:a:0',
      '-t', String(MAX_DURATION),
      '-af', 'aresample=48000:async=1:first_pts=0',
      '-c:a', 'libopus',
      '-b:a', '48k',
      '-vbr', 'on',
      '-compression_level', '10',
      '-ac', '1',
      '-ar', '48000',
      '-application', 'audio',
      '-avoid_negative_ts', 'make_zero',
      '-f', 'ogg',
      outPath,
    ]);
    const oggBuffer = await fs.readFile(outPath);
    if (!oggBuffer || oggBuffer.length < 200) {
      throw new Error('Pista de audio vacía o demasiado corta.');
    }
    const realSeconds = parseFfmpegDuration(stderr);
    return { oggBuffer, realSeconds };
  } finally {
    await fs.unlink(inPath).catch(() => {});
    await fs.unlink(outPath).catch(() => {});
  }
}

async function buildAudioMessageFromBuffer(sock, buffer, ext, fallbackSeconds = 0, targetChat = '') {
  const { prepareWAMessageMedia } = await getBaileys();
  const { oggBuffer, realSeconds } = await convertToOggOpus(buffer, ext);
  const isNewsletter = String(targetChat || '').endsWith('@newsletter');

  const uploadOptions = {
    upload: sock.waUploadToServer,
    ...(isNewsletter ? { jid: targetChat, isNewsletter: true } : {}),
  };

  const { audioMessage } = await prepareWAMessageMedia(
    { audio: oggBuffer, mimetype: 'audio/ogg; codecs=opus', ptt: true },
    uploadOptions,
  );

  const chosenSec = realSeconds > 0 ? realSeconds : fallbackSeconds > 0 ? fallbackSeconds : 5;
  const finalSeconds = Math.max(1, Math.min(MAX_DURATION, Math.round(chosenSec)));

  audioMessage.seconds = finalSeconds;
  audioMessage.ptt = true;
  audioMessage.mimetype = 'audio/ogg; codecs=opus';
  if (!audioMessage.waveform || !audioMessage.waveform.length) {
    audioMessage.waveform = generateWaveform(oggBuffer);
  }

  return audioMessage;
}

async function sendCombinedAudioSticker(sock, targetChat, stickerBuffer, isAnimated, audioMsg) {
  const { prepareWAMessageMedia } = await ensurePatched();
  const isNewsletter = String(targetChat || '').endsWith('@newsletter');

  const uploadOptions = {
    upload: sock.waUploadToServer,
    ...(isNewsletter ? { jid: targetChat, isNewsletter: true } : {}),
  };

  const prepared = await prepareWAMessageMedia(
    { sticker: stickerBuffer, isAnimated },
    uploadOptions,
  );

  prepared.stickerMessage.isAnimated = Boolean(isAnimated);
  prepared.stickerMessage.audioMessage = audioMsg;

  const payload = {
    __proto__: prepared,
    audioStickerMessage: { message: prepared },
    ...(isNewsletter ? {} : { messageContextInfo: { messageSecret: randomBytes(32) } }),
  };

  await sock.relayMessage(targetChat, payload, {});
}

function startStickerSession({
  msg,
  sock,
  send,
  stickerBuffer,
  isAnimated,
  packname,
  author,
  prefix,
  command,
  targetChat,
}) {
  const key = getSessionKey(msg);
  clearUserSession(key);

  const timer = setTimeout(() => {
    if (sessions.has(key)) {
      sessions.delete(key);
      sock
        .sendMessage(
          msg.chat,
          {
            text:
              'Tiempo agotado (' +
              SESSION_SECONDS +
              's). Si deseas crear el Audio Sticker, vuelve a enviar o responder a una foto/sticker.',
          },
          { quoted: msg },
        )
        .catch(() => {});
    }
  }, SESSION_SECONDS * 1000);

  sessions.set(key, {
    stickerBuffer,
    isAnimated,
    packname,
    author,
    targetChat,
    expiresAt: Date.now() + SESSION_SECONDS * 1000,
    processing: false,
    timer,
  });

  const destinoLabel = String(targetChat).endsWith('@newsletter')
    ? 'Canal (' + targetChat + ')'
    : 'Este chat';

  return send(
    '*SESION AUDIO STICKER ACTIVA*\n' +
      'Destino: *' + destinoLabel + '*\n' +
      'Pack: *' + packname + '* | Autor: *' + author + '*\n' +
      'Tipo: ' + (isAnimated ? 'Animado' : 'Estático') + '\n' +
      'Tiempo restante: *' + SESSION_SECONDS + ' segundos*\n\n' +
      'Ahora responde a un *Audio / Nota de voz / Video* (máx ' +
      MAX_DURATION +
      's) con `' +
      prefix +
      command +
      '`.\n' +
      'Para cancelar escribe `' +
      prefix +
      command +
      ' cancelar`.',
  );
}

async function consumeSessionWithAudio(msg, sock, send, react, session, audioNode, audioInfo, overrideTarget) {
  const key = getSessionKey(msg);
  const finalTarget = overrideTarget || session.targetChat || msg.chat;
  session.processing = true;
  await react('⏳');

  try {
    const audioBuf = await downloadBuffer(audioNode, audioInfo, sock);
    if (!audioBuf || !audioBuf.length) throw new Error('No se pudo descargar el audio/video.');

    const ext =
      audioInfo.kind === 'video'
        ? 'mp4'
        : /ogg|opus/i.test(audioInfo.mime)
        ? 'ogg'
        : /mp4|m4a|aac/i.test(audioInfo.mime)
        ? 'm4a'
        : 'mp3';

    const audioMsg = await buildAudioMessageFromBuffer(sock, audioBuf, ext, audioInfo.seconds, finalTarget);

    await sendCombinedAudioSticker(
      sock,
      finalTarget,
      session.stickerBuffer,
      session.isAnimated,
      audioMsg,
    );

    clearUserSession(key);
    await react('✅');

    if (finalTarget !== msg.chat) {
      await send('Audio Sticker enviado al canal correctamente (' + finalTarget + ').');
    }
  } catch (err) {
    session.processing = false;
    await react('❌');
    await send('Error al enviar el Audio Sticker: ' + (err?.message || String(err)));
  }
}

export default {
  command: ['audiosticker', 'asticker', 'stickeraudio', 'saudio','as'],
  category: 'stickers',
  description: 'Crea un sticker estático o animado con sonido (máx 90s) para chats o canales.',

  run: async ({ msg, sock, args, text, usedPrefix, command }) => {
    const prefix = usedPrefix || '#';
    const cmd = command || 'audiosticker';
    const rawInput = String(text || (Array.isArray(args) ? args.join(' ') : '')).trim();
    const { targetChat, cleanText, isChannel } = extractTargetDestination(rawInput, msg.chat);

    const send = (t) => msg.reply(t);
    const react = async (emoji) => {
      await sock.sendMessage(msg.chat, { react: { text: emoji, key: msg.key } }).catch(() => {});
    };

    if (isChannel && targetChat === '120363000000000000@newsletter') {
      return send(
        'Configura tu DEFAULT_CHANNEL_JID en audiosticker.js o escribe el ID directo:\n' +
          '`' + prefix + cmd + ' 120363XXXXXXXXXXXX@newsletter`',
      );
    }

    const key = getSessionKey(msg);
    const activeSession = sessions.get(key);

    if (/^(cancelar|cancel|batal|stop)$/i.test(cleanText)) {
      if (!activeSession) return send('No tienes ninguna sesión de Audio Sticker activa.');
      clearUserSession(key);
      await react('✅');
      return send('Sesión de Audio Sticker cancelada.');
    }

    const ownInfo = detectMediaInfo(msg);
    const quoted = msg.quoted;
    const quotedInfo = detectMediaInfo(quoted);

    const hasOwnVisual = ownInfo.kind === 'video' || ownInfo.kind === 'image' || ownInfo.kind === 'webp';
    const hasQuotedVisual = quotedInfo.kind === 'video' || quotedInfo.kind === 'image' || quotedInfo.kind === 'webp';
    const hasOwnAudio = ownInfo.kind === 'audio';
    const hasQuotedAudio = quotedInfo.kind === 'audio';

    // Paso 2: Si ya hay sesión activa y ahora responde a un audio
    if (activeSession && !activeSession.processing && (hasOwnAudio || hasQuotedAudio) && !hasOwnVisual) {
      const targetAudioNode = hasOwnAudio ? msg : quoted;
      const targetAudioInfo = hasOwnAudio ? ownInfo : quotedInfo;
      const overrideTarget = isChannel ? targetChat : null;
      return await consumeSessionWithAudio(
        msg,
        sock,
        send,
        react,
        activeSession,
        targetAudioNode,
        targetAudioInfo,
        overrideTarget,
      );
    }

    if (!hasOwnVisual && !hasQuotedVisual && !hasOwnAudio && !hasQuotedAudio) {
      if (activeSession) {
        const remSec = Math.max(1, Math.ceil((activeSession.expiresAt - Date.now()) / 1000));
        return send(
          'Sesión activa (' +
            remSec +
            's). Responde a un audio o nota de voz con `' +
            prefix +
            cmd +
            '` (o `' +
            prefix +
            cmd +
            ' canal` para enviarlo a tu canal).',
        );
      }

      return send(
        '*AUDIO STICKER (CHATS Y CANALES)*\n\n' +
          '*En el chat actual:*\n' +
          '- Responde a un video (máx ' + MAX_DURATION + 's) con `' + prefix + cmd + '`\n' +
          '- O responde a una foto/sticker y luego al audio con `' + prefix + cmd + '`\n\n' +
          '*Enviar directo a tu Canal:*\n' +
          '- `' + prefix + cmd + ' canal`\n' +
          '- `' + prefix + cmd + ' 120363XXXXXXXXXXXX@newsletter`\n\n' +
          'Pack personalizado: `' + prefix + cmd + ' canal Pack|Autor`',
      );
    }

    if (!hasOwnVisual && !hasQuotedVisual && (hasOwnAudio || hasQuotedAudio)) {
      return send(
        'Primero envía o responde a una *foto o sticker* con `' +
          prefix +
          cmd +
          '`' +
          (isChannel ? ' canal' : '') +
          ', y luego responde al audio.',
      );
    }

    await react('⏳');

    try {
      await ensurePatched();

      const [customPack, customAuth] = cleanText.includes('|')
        ? cleanText.split('|').map((s) => s.trim())
        : [cleanText, ''];

      const packname = customPack || global.packname || 'SUMI BOT';
      const author = customAuth || global.author || msg.pushName || 'Sticker';

      const visualNode = hasOwnVisual ? msg : quoted;
      const visualInfo = hasOwnVisual ? ownInfo : quotedInfo;
      const isVideo = visualInfo.kind === 'video';
      const videoSeconds = visualInfo.seconds || 0;

      if (isVideo && videoSeconds > MAX_DURATION) {
        await react('❌');
        return send('La duración máxima del video es de *' + MAX_DURATION + ' segundos*.');
      }

      const visualData = await downloadBuffer(visualNode, visualInfo, sock);
      if (!visualData || !visualData.length) {
        throw new Error('No se pudo descargar la imagen o video.');
      }

      const stickerBuffer = await buildStickerWithExif(visualData, visualInfo.kind, packname, author);
      const isAnimated = isVideo || isWebpAnimated(stickerBuffer);

      // Si envió imagen/video citando un audio directamente
      if (hasOwnVisual && hasQuotedAudio) {
        const audioBuf = await downloadBuffer(quoted, quotedInfo, sock);
        if (!audioBuf || !audioBuf.length) throw new Error('No se pudo descargar el audio citado.');
        const ext = /ogg|opus/i.test(quotedInfo.mime)
          ? 'ogg'
          : /mp4|m4a|aac/i.test(quotedInfo.mime)
          ? 'm4a'
          : 'mp3';
        const audioMsg = await buildAudioMessageFromBuffer(sock, audioBuf, ext, quotedInfo.seconds, targetChat);
        await sendCombinedAudioSticker(sock, targetChat, stickerBuffer, isAnimated, audioMsg);
        clearUserSession(key);
        await react('✅');
        if (targetChat !== msg.chat) {
          await send('Audio Sticker enviado al canal correctamente (' + targetChat + ').');
        }
        return;
      }

      // Si es video, extrae su propio audio y lo manda directo en 1 paso
      if (isVideo) {
        try {
          const audioMsg = await buildAudioMessageFromBuffer(sock, visualData, 'mp4', videoSeconds, targetChat);
          await sendCombinedAudioSticker(sock, targetChat, stickerBuffer, true, audioMsg);
          clearUserSession(key);
          await react('✅');
          if (targetChat !== msg.chat) {
            await send('Audio Sticker enviado al canal correctamente (' + targetChat + ').');
          }
          return;
        } catch {
          return await startStickerSession({
            msg,
            sock,
            send,
            stickerBuffer,
            isAnimated: true,
            packname,
            author,
            prefix,
            command: cmd,
            targetChat,
          });
        }
      }

      return await startStickerSession({
        msg,
        sock,
        send,
        stickerBuffer,
        isAnimated,
        packname,
        author,
        prefix,
        command: cmd,
        targetChat,
      });
    } catch (e) {
      await react('❌');
      await send('Error al procesar el Audio Sticker: ' + (e?.message || String(e)));
    }
  },
};