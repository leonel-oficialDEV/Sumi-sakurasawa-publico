import { randomBytes, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { existsSync, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import axios from 'axios';
import fetch from 'node-fetch';
import path from 'node:path';
import os from 'node:os';
import db from '../../lib/system/database.js';

const execFileAsync = promisify(execFile);
const MAX_WEBP_SECONDS = 15;
const MAX_AUDIO_SECONDS = 100;
const MAX_AUDIO_BYTES = 700 * 1024;
const MAX_WEBP_BYTES = 950 * 1024;
const fmtTime = (sec) => Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
const AUDIO_LABEL = fmtTime(MAX_AUDIO_SECONDS);
const SESSION_SECONDS = 60;
const MAX_LINK_SECONDS = 30 * 60;
const MAX_LINK_BYTES = 120 * 1024 * 1024;
const MAX_LINK_ACTIVE = 2;
const API_TIMEOUT = 25000;
const DL_TIMEOUT = 5 * 60 * 1000;
const LINK_QUALITIES = ['360p', '240p'];
const CNV_QUALITIES = [360, 240, 144, 480];
const CNV = 'https://cnv.cx/v2';
const CNV_FRAME = 'https://frame.y2meta-uk.com';
const CNV_UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const CNV_HEADERS = { 'User-Agent': CNV_UA, Referer: CNV_FRAME + '/', Origin: CNV_FRAME };
const CLOCK = '\\d+(?::\\d{1,2})?(?:\\.\\d+)?';
const RANGE_RE = new RegExp('^(' + CLOCK + ')-(' + CLOCK + ')$');
const RANGE_OPEN_RE = new RegExp('^(' + CLOCK + ')-$');
const CLOCK_RE = new RegExp('^' + CLOCK + '$');
const AUDIO_STORE = path.join(process.cwd(), 'storage', 'audiostickers');
const AUDIO_STORE_MAX = 300;
const audioBuffers = new WeakMap();
let linkActive = 0;
const MAX_CONCURRENT_FFMPEG = 2;
const MAX_QUEUE_FFMPEG = 10;
const FFMPEG_RETRIES = 3;
const RETRYABLE = /Resource temporarily unavailable|Cannot allocate memory|pthread|Error while opening (decoder|encoder)|Too many open files/i;

if (!globalThis.__audioStickerSessions) {
  globalThis.__audioStickerSessions = new Map();
}
const sessions = globalThis.__audioStickerSessions;

let running = 0;
const waiting = [];

function acquireSlot() {
  return new Promise((resolve, reject) => {
    if (running < MAX_CONCURRENT_FFMPEG) {
      running++;
      resolve();
      return;
    }
    if (waiting.length >= MAX_QUEUE_FFMPEG) {
      reject(userError('El sistema está saturado ahora mismo, intenta de nuevo en unos segundos.'));
      return;
    }
    waiting.push(resolve);
  });
}

function releaseSlot() {
  const next = waiting.shift();
  if (next) next();
  else running = Math.max(0, running - 1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampRange(range, max, total = 0) {
  if (!range) return { range: null, note: null };
  if (range.open) {
    const room = total > 0 ? Math.max(0, total - range.start) : max;
    const duration = Math.min(max, room);
    const end = range.start + duration;
    const note = duration > 0
      ? '《✧》 Sin fin, usé de *' + fmtTime(Math.round(range.start)) + '* a *' + fmtTime(Math.round(end)) + '* (máximo *' + fmtTime(max) + '*).'
      : null;
    return { range: { start: range.start, end, duration }, note };
  }
  if (range.duration <= max) return { range, note: null };
  const end = range.start + max;
  const note =
    '《✧》 El recorte dura *' + fmtTime(Math.round(range.duration)) + '* (de ' + fmtTime(Math.round(range.start)) + ' a ' + fmtTime(Math.round(range.end)) + ') y el máximo es *' + fmtTime(max) + '*.\n' +
    '> Usé de *' + fmtTime(Math.round(range.start)) + '* a *' + fmtTime(Math.round(end)) + '*.';
  return { range: { start: range.start, end, duration: max }, note };
}

function trimNotice() {
  return '《✧》 El audio se recortó a *' + AUDIO_LABEL + '* para que WhatsApp pueda reproducirlo.';
}

function userError(message) {
  const err = new Error(message);
  err.isUser = true;
  return err;
}

function friendlyError(e) {
  if (e?.isUser) return e.message;
  const raw = String(e?.stderr || e?.message || e || '');
  if (/timeout|ETIMEDOUT|ECONNABORTED|ECONNRESET|aborted|canceled/i.test(raw) && !/ffmpeg/i.test(raw)) {
    return 'El servidor de descarga tardó demasiado, intenta de nuevo.';
  }
  if (RETRYABLE.test(raw)) return 'El servidor está muy ocupado, intenta de nuevo en unos segundos.';
  if (/Invalid data|moov atom|does not contain any stream|Invalid argument/i.test(raw)) {
    return 'El archivo está dañado o no es compatible.';
  }
  return 'No se pudo procesar el archivo, intenta con otro.';
}

const SHAPES = { '-x': 'cover', '-i': 'contain', '-c': 'circle', '-t': 'triangle', '-s': 'star', '-r': 'roundrect', '-h': 'hexagon', '-d': 'diamond', '-f': 'frame', '-b': 'border', '-w': 'wave', '-m': 'mirror', '-o': 'octagon', '-y': 'pentagon', '-e': 'ellipse', '-z': 'cross', '-v': 'heart' };
const EFFECTS = { '-blur': 'blur', '-sepia': 'sepia', '-sharpen': 'sharpen', '-brighten': 'brighten', '-darken': 'darken', '-invert': 'invert', '-grayscale': 'grayscale', '-rotate90': 'rotate90', '-rotate180': 'rotate180', '-flip': 'flip', '-flop': 'flop', '-normalice': 'normalise', '-negate': 'negate', '-tint': 'tint' };

function starAlpha() {
  const R = 258, cx = 256, cy = 277, ri = R * 0.45, ang = Math.PI / 5;
  const num = (R * ri * Math.sin(ang)).toFixed(4);
  const k1 = (ri * Math.sin(ang)).toFixed(4);
  const k2 = (R - ri * Math.cos(ang)).toFixed(4);
  const a1 = ang.toFixed(6);
  const a2 = (2 * ang).toFixed(6);
  const theta = `(atan2(Y-${cy},X-${cx})+PI*2.5)`;
  const phi = `(${a1}-abs(mod(${theta},${a2})-${a1}))`;
  const rho = `(${num}/(${k1}*cos(${phi})+${k2}*sin(${phi})))`;
  return `alpha(X,Y)*clip(${rho}-hypot(X-${cx},Y-${cy})+0.5,0,1)`;
}

function buildFilters(opts, fps) {
  const W = 512, H = 512;
  const shape = opts.shape || 'contain';
  const filters = [];
  if (fps) filters.push('fps=' + fps);
  const fill = !['contain', 'mirror', 'border', 'frame'].includes(shape);
  if (fill) filters.push(`scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H}`);
  else filters.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos`);
  for (const ef of opts.effects || []) {
    switch (ef) {
      case 'blur': filters.push('gblur=sigma=5'); break;
      case 'sepia': filters.push('colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131'); break;
      case 'sharpen': filters.push('unsharp=5:5:1.0:5:5:0.0'); break;
      case 'brighten': filters.push('eq=brightness=0.05'); break;
      case 'darken': filters.push('eq=brightness=-0.05'); break;
      case 'invert': case 'negate': filters.push('negate'); break;
      case 'grayscale': filters.push('hue=s=0'); break;
      case 'rotate90': filters.push('transpose=1'); break;
      case 'rotate180': filters.push('hflip,vflip'); break;
      case 'flip': filters.push('hflip'); break;
      case 'flop': filters.push('vflip'); break;
      case 'normalise': filters.push('normalize'); break;
      case 'tint': filters.push('colorchannelmixer=1:0:0:0:0:0.5:0:0:0:0:0.5'); break;
    }
  }
  if (shape === 'mirror') filters.push('hflip');
  filters.push('format=rgba');
  if (!fill) filters.push(`pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=#00000000`);
  const cx = W / 2, cy = H / 2, r = Math.min(W, H) / 2;
  let a = '';
  switch (shape) {
    case 'circle': a = `if(lte((X-${cx})*(X-${cx})+(Y-${cy})*(Y-${cy}),${r * r}),alpha(X,Y),0)`; break;
    case 'triangle': a = `if(gte(Y,${H * 0.1})*lte(Y,${H * 0.9})*lte(abs(X-${cx}),((${H * 0.9}-Y)*0.6)),alpha(X,Y),0)`; break;
    case 'star': a = starAlpha(); break;
    case 'roundrect': a = `if(lte(hypot(max(abs(X-${cx})-${cx - 60},0),max(abs(Y-${cy})-${cy - 60},0)),60),alpha(X,Y),0)`; break;
    case 'hexagon': a = `if(lte(hypot(X-${cx},Y-${cy}),${W * 0.4}*cos(PI/6)/cos(mod(atan2(Y-${cy},X-${cx})+PI,PI/3)-PI/6)),alpha(X,Y),0)`; break;
    case 'diamond': a = `if(lte(abs(X-${cx})+abs(Y-${cy}),${r}),alpha(X,Y),0)`; break;
    case 'wave': a = `if(lte(abs(Y-(${cy}+${H * 0.05}*sin(X*0.05))),${H * 0.4}),alpha(X,Y),0)`; break;
    case 'octagon': a = `if(lte(hypot(X-${cx},Y-${cy}),${W * 0.45}*cos(PI/8)/cos(mod(atan2(Y-${cy},X-${cx})+PI,PI/4)-PI/8)),alpha(X,Y),0)`; break;
    case 'pentagon': a = `if(lte(hypot(X-${cx},Y-${cy}),${W * 0.45}*cos(PI/5)/cos(mod(atan2(Y-${cy},X-${cx})+PI,2*PI/5)-PI/5)),alpha(X,Y),0)`; break;
    case 'ellipse': a = `if(lte(((X-${cx})*(X-${cx}))/${(W * 0.48) * (W * 0.48)}+((Y-${cy})*(Y-${cy}))/${(H * 0.4) * (H * 0.4)},1),alpha(X,Y),0)`; break;
    case 'cross': a = `if(gt(lte(abs(X-${cx}),${W * 0.15})*lte(abs(Y-${cy}),${H * 0.45})+lte(abs(Y-${cy}),${H * 0.15})*lte(abs(X-${cx}),${W * 0.45}),0),alpha(X,Y),0)`; break;
    case 'heart': a = `if(lte(pow(pow((X-${cx})/${W * 0.38},2)+pow((${cy + 20}-Y)/${H * 0.38},2)-1,3)-pow((X-${cx})/${W * 0.38},2)*pow((${cy + 20}-Y)/${H * 0.38},3),0),alpha(X,Y),0)`; break;
  }
  if (a) filters.push(`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${a}'`);
  if (shape === 'border') filters.push(`drawbox=x=0:y=0:w=${W}:h=${H}:color=white@0.9:t=10`);
  if (shape === 'frame') filters.push(`drawbox=x=15:y=15:w=${W - 30}:h=${H - 30}:color=white@0.7:t=8`);
  filters.push('setsar=1');
  return filters.join(',');
}

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

async function runFfmpeg(args, { stats = false, bin = null, quiet = false } = {}) {
  await acquireSlot();
  try {
    const base = ['-hide_banner', '-loglevel', 'error', ...(stats ? ['-stats'] : [])];
    let lastErr = null;
    for (let attempt = 0; attempt <= FFMPEG_RETRIES; attempt++) {
      try {
        return await execFileAsync(bin || getFfmpegBin(), [...base, ...args], {
          maxBuffer: 16 * 1024 * 1024,
          timeout: 120000,
        });
      } catch (e) {
        lastErr = e;
        const raw = String(e?.stderr || e?.message || '');
        if (attempt < FFMPEG_RETRIES && RETRYABLE.test(raw)) {
          await sleep(700 * (attempt + 1));
          continue;
        }
        break;
      }
    }
    if (!quiet) console.error('[asticker] ffmpeg:', String(lastErr?.stderr || lastErr?.message || lastErr).slice(-600));
    throw lastErr;
  } finally {
    releaseSlot();
  }
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

const LINK_BASE = () => String(global.APIs?.evogb?.url || 'https://api.evogb.org').replace(/\/$/, '');
const LINK_KEY = () => global.APIs?.evogb?.key || 'Apex-Predator2010';
const isYouTube = (t) => /(youtube\.com|youtu\.be)\//i.test(String(t));

function isUrl(t) {
  return /^https?:\/\/\S+$/i.test(String(t));
}

function parseClock(str) {
  const parts = String(str).split(':');
  if (parts.length === 1) return Number(parts[0]);
  return Number(parts[0]) * 60 + Number(parts[1]);
}

function parseRangeWord(word) {
  const m = String(word).match(RANGE_RE);
  if (!m) {
    const o = String(word).match(RANGE_OPEN_RE) || (CLOCK_RE.test(String(word)) ? [null, String(word)] : null);
    if (!o) return null;
    const from = parseClock(o[1]);
    if (!Number.isFinite(from)) return null;
    return { start: from, end: null, duration: null, open: true };
  }
  const start = parseClock(m[1]);
  const end = parseClock(m[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end, duration: end - start };
}

function toSeconds(d) {
  if (d === undefined || d === null || d === '') return 0;
  if (typeof d === 'number') return d;
  const s = String(d).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const p = s.split(':').map(Number);
  if (p.some(isNaN)) return 0;
  return p.reduce((a, v) => a * 60 + v, 0);
}

async function cutClip(input, output, start, duration) {
  const evenScale = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
  const fast = [
    '-y',
    '-threads', '1',
    '-ss', String(start),
    '-i', input,
    '-t', String(duration),
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-vf', evenScale,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '26',
    '-pix_fmt', 'yuv420p',
    '-threads', '1',
    '-c:a', 'aac',
    '-b:a', '96k',
    '-ac', '2',
    '-movflags', '+faststart',
    output,
  ];
  const compat = [
    '-y',
    '-i', input,
    '-ss', String(start),
    '-t', String(duration),
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', 'libx264',
    '-profile:v', 'main',
    '-level', '4.0',
    '-preset', 'veryfast',
    '-crf', '26',
    '-pix_fmt', 'yuv420p',
    '-r', '30',
    '-bf', '0',
    '-vf', evenScale,
    '-c:a', 'aac',
    '-b:a', '96k',
    '-ar', '44100',
    '-ac', '2',
    '-movflags', '+faststart',
    output,
  ];
  const tries = [{ args: fast }, { args: compat }, { args: compat, bin: 'ffmpeg' }];
  let lastErr = null;
  for (let i = 0; i < tries.length; i++) {
    const t = tries[i];
    await fs.unlink(output).catch(() => {});
    try {
      await runFfmpeg(t.args, t.bin ? { bin: t.bin } : {});
    } catch (e) {
      console.error('[asticker] cutClip intento ' + (i + 1) + ' falló:', String(e?.stderr || e?.message || e).slice(-300));
      if (!lastErr || !/ENOENT/.test(String(e?.message))) lastErr = e;
      continue;
    }
    const st = await fs.stat(output).catch(() => null);
    if (st && st.size >= 2048) return;
    throw userError('No hay video en ese rango, revisa los segundos.');
  }
  throw lastErr || userError('No pude cortar ese video.');
}

async function trimVideoBuffer(buffer, range) {
  const id = randomBytes(6).toString('hex');
  const inPath = path.join(os.tmpdir(), 'cut_in_' + id + '.mp4');
  const outPath = path.join(os.tmpdir(), 'cut_out_' + id + '.mp4');
  try {
    await fs.writeFile(inPath, buffer);
    await cutClip(inPath, outPath, range.start, range.duration);
    return await fs.readFile(outPath);
  } finally {
    await fs.unlink(inPath).catch(() => {});
    await fs.unlink(outPath).catch(() => {});
  }
}

async function callEvogb(route, params) {
  try {
    const res = await axios.get(LINK_BASE() + route, {
      params: { ...params, key: LINK_KEY() },
      timeout: API_TIMEOUT,
      headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
    });
    const d = res.data?.data || res.data?.result || null;
    if (!d) return null;
    const dl = d.dl || d.download || d.url || d.video;
    if (!dl || typeof dl !== 'string') return null;
    return {
      dl,
      title: d.title || d.name || 'video',
      seconds: toSeconds(d.seconds ?? d.duration ?? d.timestamp ?? d.lengthSeconds),
      viaCnv: false,
    };
  } catch {
    return null;
  }
}

function extractVideoId(input) {
  const s = String(input).trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  const m = s.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/))([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

async function resolveCnv(url) {
  const id = extractVideoId(url);
  if (!id) throw userError('No pude leer el ID de ese link de YouTube.');
  try {
    const keyRes = await axios.get(CNV + '/sanity/key?id=' + id, { timeout: 30000, headers: CNV_HEADERS });
    const key = keyRes.data?.key;
    if (!key) throw new Error('sin key');
    for (const q of CNV_QUALITIES) {
      const res = await axios
        .post(
          CNV + '/converter',
          new URLSearchParams({
            link: 'https://youtu.be/' + id,
            format: 'mp4',
            audioBitrate: '128',
            videoQuality: String(q),
            filenameStyle: 'pretty',
            vCodec: 'h264',
          }).toString(),
          { timeout: 30000, headers: { ...CNV_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded', accept: '*/*', key } },
        )
        .catch(() => null);
      const dl = res?.data?.url;
      if (dl) return { dl, title: 'video', seconds: 0, viaCnv: true };
    }
  } catch {}
  throw userError('No pude obtener el video de ese link, intenta con otro.');
}

async function looksLikeMedia(file) {
  const fh = await fs.open(file, 'r');
  try {
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(16), 0, 16, 0);
    if (bytesRead < 12) return false;
    const box = buffer.toString('latin1', 4, 8);
    if (['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip'].includes(box)) return true;
    if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return true;
    const head = buffer.toString('latin1', 0, 4);
    return head === 'GIF8' || head === 'RIFF' || head === 'OggS';
  } finally {
    await fh.close();
  }
}

async function downloadLink(info, dest) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DL_TIMEOUT);
  try {
    const res = await fetch(info.dl, {
      headers: info.viaCnv ? CNV_HEADERS : { 'user-agent': 'Mozilla/5.0' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw userError('No pude descargar el video (' + res.status + ').');
    const len = Number(res.headers.get('content-length') || 0);
    if (len && len > MAX_LINK_BYTES) throw userError('El video es demasiado pesado para descargarlo.');
    const body = typeof res.body.pipe === 'function' ? res.body : Readable.fromWeb(res.body);
    await pipeline(body, createWriteStream(dest));
    const st = await fs.stat(dest);
    if (!st.size) throw userError('No pude descargar el video.');
    if (st.size > MAX_LINK_BYTES) throw userError('El video es demasiado pesado para descargarlo.');
  } finally {
    clearTimeout(timer);
  }
}

async function probeAudio(file, start, duration) {
  try {
    const { stderr } = await runFfmpeg([
      '-loglevel', 'info',
      '-ss', String(start),
      '-t', String(Math.min(duration, 10)),
      '-i', file,
      '-vn',
      '-af', 'volumedetect',
      '-f', 'null',
      '-',
    ], { quiet: true });
    const m = String(stderr).match(/max_volume:\s*(-?inf|-?[\d.]+)\s*dB/);
    if (!m) return { hasAudio: false, audible: false, maxDb: null };
    const db = m[1].includes('inf') ? -Infinity : Number(m[1]);
    return { hasAudio: true, audible: db > -50, maxDb: db };
  } catch {
    return { hasAudio: false, audible: false, maxDb: null };
  }
}

async function fetchLinkVideo(url, dest, precheck, probe) {
  const span = probe || { start: 0, duration: MAX_WEBP_SECONDS };
  if (!isYouTube(url)) {
    if (!/\.(mp4|mov|webm|mkv|avi|gif)(\?.*)?$/i.test(url)) {
      throw userError('Solo acepto links de YouTube o enlaces directos a un video (.mp4, .webm, .gif).');
    }
    const info = { dl: url, title: 'video', seconds: 0, viaCnv: false };
    await downloadLink(info, dest);
    if (!(await looksLikeMedia(dest))) throw userError('Ese enlace no devolvió un video.');
    return info;
  }
  const attempts = [
    () => callEvogb('/dl/ytmp4', { url, quality: '360p' }),
    () => callEvogb('/dl/ytmp4', { url, quality: '480p' }),
    () => callEvogb('/dl/ytmp4', { url, quality: '240p' }),
    () => callEvogb('/dl/youtubeplay-private', { query: url, q: url, type: 'video', quality: '360p' }),
    () => resolveCnv(url),
  ];
  const spare = dest + '.fb';
  let spareInfo = null;
  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    let info = null;
    try {
      info = await attempts[i]();
    } catch (e) {
      lastErr = e;
      continue;
    }
    if (!info) continue;
    if (precheck) precheck(info);
    const via = info.viaCnv ? 'cnv' : 'evogb';
    try {
      await downloadLink(info, dest);
      if (!(await looksLikeMedia(dest))) {
        console.error('[asticker] el enlace de descarga no devolvió un video, fuente ' + via + ', intento ' + (i + 1));
        continue;
      }
      const pa = await probeAudio(dest, span.start, span.duration);
      console.log('[asticker] fuente ' + via + ' intento ' + (i + 1) + ', audio: ' + (pa.hasAudio ? 'sí, pico ' + pa.maxDb + ' dB' : 'no'));
      if (pa.audible) return info;
      if (!spareInfo) {
        await fs.copyFile(dest, spare);
        spareInfo = info;
      }
    } catch (e) {
      lastErr = e;
      console.error('[asticker] descarga falló, intento ' + (i + 1) + ':', e?.message || e);
    }
  }
  if (spareInfo) {
    await fs.copyFile(spare, dest);
    console.error('[asticker] ninguna fuente trajo audio audible, se usa el video sin sonido');
    return spareInfo;
  }
  throw lastErr?.isUser ? lastErr : userError('No pude descargar ese video, intenta de nuevo o con otro link.');
}

async function resolvePackAuthor(msg, cleanText) {
  let user = {};
  try {
    user = (await db.getUser(msg.sender)) || {};
  } catch {}
  const userName = user.name || '';
  const meta1 = user.metadatos ? String(user.metadatos).trim() : '';
  const meta2 = user.metadatos2 ? String(user.metadatos2).trim() : '';
  const texto1 = meta1 || '🔮 ✧･ﾟ: *𝙎𝙪𝙢𝙞 𝐁𝐨𝐭*:･ﾟ✧ 🔮';
  const texto2 = meta1 ? (meta2 || '') : '@' + userName;
  const marca = cleanText.split(/[\u2022|]/).map((x) => x.trim());
  const packname = marca[0] || texto1;
  const author = marca.length > 1 ? marca[1] : (cleanText ? (meta1 ? texto2 : '') : texto2);
  return { packname, author };
}

async function sendVideoAudioSticker({ msg, sock, send, react, clip, seconds, packname, author, look, prefix, cmd }) {
  const key = getSessionKey(msg);
  const stickerBuffer = await buildStickerWithExif(clip, 'video', packname, author, seconds, look);
  try {
    const { audioMessage, trimmed } = await buildAudioMessageFromBuffer(sock, clip, 'mp4', seconds);
    await sendCombinedAudioSticker(sock, msg.chat, stickerBuffer, true, audioMessage, msg);
    clearUserSession(key);
    await react('✅');
    if (trimmed) await send(trimNotice());
  } catch (audioErr) {
    if (!audioErr?.isUser && RETRYABLE.test(String(audioErr?.stderr || audioErr?.message || ''))) {
      throw audioErr;
    }
    await startStickerSession({ msg, sock, send, stickerBuffer, isAnimated: true, packname, author, prefix, command: cmd, range: null });
  }
}

async function handleLink({ msg, sock, send, react, urlArg, range, look, cleanText, prefix, cmd }) {
  const linkFit = clampRange(range, MAX_WEBP_SECONDS, 0);
  range = linkFit.range;
  if (linkFit.note) await send(linkFit.note);
  if (linkActive >= MAX_LINK_ACTIVE) {
    return send('《✧》 Hay varias descargas en curso, intenta de nuevo en unos segundos.');
  }
  linkActive++;
  const id = randomBytes(6).toString('hex');
  const rawPath = path.join(os.tmpdir(), 'as_dl_' + id + '.mp4');
  const clipPath = path.join(os.tmpdir(), 'as_clip_' + id + '.mp4');
  await react('⏳');
  try {
    await ensurePatched();
    const { packname, author } = await resolvePackAuthor(msg, cleanText);
    const start = range ? range.start : 0;
    const duration = range ? range.duration : MAX_WEBP_SECONDS;
    await fetchLinkVideo(urlArg, rawPath, (info) => {
      if (info.seconds && info.seconds > MAX_LINK_SECONDS) {
        throw userError('El video dura *' + fmtTime(Math.round(info.seconds)) + '* y el límite es *' + fmtTime(MAX_LINK_SECONDS) + '*.');
      }
      if (info.seconds && start >= info.seconds) {
        throw userError('El inicio del recorte supera la duración del video (' + fmtTime(Math.round(info.seconds)) + ').');
      }
    }, { start, duration });
    await cutClip(rawPath, clipPath, start, duration);
    const clipAudio = await probeAudio(clipPath, 0, duration);
    console.log('[asticker] clip: audio ' + (clipAudio.hasAudio ? 'sí, pico ' + clipAudio.maxDb + ' dB' : 'no'));
    const clip = await fs.readFile(clipPath);
    await sendVideoAudioSticker({ msg, sock, send, react, clip, seconds: duration, packname, author, look, prefix, cmd });
  } catch (err) {
    console.error('[asticker]', err?.message || err);
    await react('❌');
    await send('《✧》 ' + friendlyError(err));
  } finally {
    linkActive = Math.max(0, linkActive - 1);
    await fs.unlink(rawPath).catch(() => {});
    await fs.unlink(rawPath + '.fb').catch(() => {});
    await fs.unlink(clipPath).catch(() => {});
  }
}

function buildListText(prefix, cmd) {
  return (
    'ꕥ *Audio Sticker*\n' +
    'Crea stickers con sonido, estáticos o animados.\n\n' +
    '✦ *Links:*\n' +
    '> Usa un link de YouTube o un enlace directo a un video.\n' +
    '> *' + prefix + cmd + ' https://youtu.be/xxxx*\n' +
    '> *' + prefix + cmd + ' https://youtu.be/xxxx -x 2-10*\n\n' +
    '✧ *Recorte (segundos):*\n' +
    '> *2-8* : Desde el segundo 2 hasta el 8\n' +
    '> *34-1:47* : Del segundo 34 al minuto 1:47 (107 s)\n' +
    '> *34* o *34-* : Solo el inicio, hasta el máximo\n' +
    '> Cuenta *fin - inicio*: 34-107 son 73 s de largo\n' +
    '> En video o link: hasta *' + MAX_WEBP_SECONDS + 's* de largo\n' +
    '> En audio: hasta *' + AUDIO_LABEL + '* de largo\n' +
    '> Si te pasas, se ajusta solo al máximo\n' +
    '> Sin recorte, los links usan los primeros ' + MAX_WEBP_SECONDS + 's\n\n' +
    '✦ *Formas:*\n' +
    '> *-x* : Cuadrado. Rellena todo el sticker y recorta lo que sobra (principal)\n' +
    '> *-i* : Completo. Muestra la imagen entera sin recortar\n' +
    '> *-c* : Círculo\n' +
    '> *-v* : Corazón\n' +
    '> *-s* : Estrella\n' +
    '> *-t* : Triángulo\n' +
    '> *-h* : Hexágono\n' +
    '> *-o* : Octágono\n' +
    '> *-y* : Pentágono\n' +
    '> *-d* : Diamante\n' +
    '> *-e* : Elipse\n' +
    '> *-z* : Cruz\n' +
    '> *-w* : Onda\n' +
    '> *-r* : Esquinas redondeadas\n' +
    '> *-b* : Con borde blanco\n' +
    '> *-f* : Con marco blanco\n' +
    '> *-m* : Espejado\n\n' +
    '✧ *Efectos:*\n' +
    '> *-blur* : Desenfoque\n' +
    '> *-sepia* : Tono antiguo\n' +
    '> *-sharpen* : Más nitidez\n' +
    '> *-brighten* : Más brillo\n' +
    '> *-darken* : Más oscuro\n' +
    '> *-invert* : Colores invertidos\n' +
    '> *-negate* : Negativo\n' +
    '> *-grayscale* : Blanco y negro\n' +
    '> *-tint* : Tinte rojizo\n' +
    '> *-normalice* : Normaliza el contraste\n' +
    '> *-rotate90* : Gira 90 grados\n' +
    '> *-rotate180* : Gira 180 grados\n' +
    '> *-flip* : Voltea horizontal\n' +
    '> *-flop* : Voltea vertical\n\n' +
    '✦ *Ejemplos:*\n' +
    '> *' + prefix + cmd + ' -x 2-8* (citando un video)\n' +
    '> *' + prefix + cmd + ' 7-15* (citando un audio)\n' +
    '> *' + prefix + cmd + ' -x*\n' +
    '> *' + prefix + cmd + ' -c -sepia Pack | Autor*\n\n' +
    '《✧》 Las formas y efectos se aplican al responder a la foto o video. Solo se usa una forma a la vez, los efectos se pueden combinar.'
  );
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

const WEBP_LADDER = [
  [15, 60], [15, 50], [15, 42], [15, 35], [15, 30],
  [12, 35], [12, 30], [12, 25],
  [10, 28], [10, 24], [10, 20],
  [8, 24], [8, 20], [8, 16],
  [6, 18], [6, 14], [5, 12], [4, 9], [3, 6],
];

let webpEncoderCache = null;

async function pickWebpEncoder() {
  if (webpEncoderCache) return webpEncoderCache;
  const bins = [...new Set([getFfmpegBin(), 'ffmpeg'])];
  for (const bin of bins) {
    try {
      const { stdout } = await execFileAsync(bin, ['-hide_banner', '-encoders'], { maxBuffer: 8 * 1024 * 1024, timeout: 15000 });
      if (/libwebp_anim/.test(String(stdout))) {
        webpEncoderCache = { bin, codec: 'libwebp_anim' };
        return webpEncoderCache;
      }
    } catch {}
  }
  webpEncoderCache = { bin: getFfmpegBin(), codec: 'libwebp' };
  return webpEncoderCache;
}

async function getMediaDuration(file) {
  try {
    await execFileAsync(getFfmpegBin(), ['-hide_banner', '-i', file], { maxBuffer: 4 * 1024 * 1024, timeout: 20000 });
  } catch (e) {
    const m = String(e?.stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
  return 0;
}

async function videoBufferToAnimatedWebp(buffer, seconds = 0, look = {}) {
  const tmpId = randomBytes(6).toString('hex');
  const inPath = path.join(os.tmpdir(), 'as_vid_' + tmpId + '.mp4');
  const outPath = path.join(os.tmpdir(), 'as_out_' + tmpId + '.webp');
  const probePath = path.join(os.tmpdir(), 'as_probe_' + tmpId + '.webp');

  try {
    await fs.writeFile(inPath, buffer);
    const real = await getMediaDuration(inPath);
    const known = real > 0 ? real : seconds > 0 ? seconds : MAX_WEBP_SECONDS;
    const total = Math.max(0.5, Math.min(known, MAX_WEBP_SECONDS));
    const enc = await pickWebpEncoder();

    const encodeAt = async (idx, offset, length, dest) => {
      const [fps, qv] = WEBP_LADDER[idx];
      await runFfmpeg(
        [
          '-y',
          '-threads', '1',
          ...(offset > 0 ? ['-ss', String(offset)] : []),
          '-i', inPath,
          '-t', String(length),
          '-vf', buildFilters(look, fps),
          '-an',
          '-c:v', enc.codec,
          '-lossless', '0',
          '-compression_level', '6',
          '-q:v', String(qv),
          '-loop', '0',
          '-preset', 'picture',
          '-vsync', '0',
          '-threads', '1',
          dest,
        ],
        { bin: enc.bin },
      );
    };

    const sampleLen = Math.min(2, total);
    const sampleStart = total > sampleLen ? Math.max(0, total / 2 - sampleLen / 2) : 0;
    const estimate = async (idx) => {
      await encodeAt(idx, sampleStart, sampleLen, probePath);
      const st = await fs.stat(probePath);
      return st.size * (total / sampleLen);
    };

    let lo = 0;
    let hi = WEBP_LADDER.length - 1;
    let best = hi;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const est = await estimate(mid);
      if (est <= MAX_WEBP_BYTES * 0.96) {
        best = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }

    let webp = null;
    for (let idx = best; idx < WEBP_LADDER.length; idx++) {
      await encodeAt(idx, 0, total, outPath);
      webp = await fs.readFile(outPath);
      if (webp.length <= MAX_WEBP_BYTES) break;
    }
    const [fpsUsed, qUsed] = WEBP_LADDER[Math.min(best, WEBP_LADDER.length - 1)];
    console.log('[asticker] webp ' + enc.codec + ' ' + Math.round(webp.length / 1024) + 'KB, ' + fpsUsed + 'fps q' + qUsed + ', ' + total.toFixed(1) + 's');
    return webp;
  } finally {
    await fs.unlink(inPath).catch(() => {});
    await fs.unlink(outPath).catch(() => {});
    await fs.unlink(probePath).catch(() => {});
  }
}

async function imageBufferToWebp(buffer, look = {}) {
  const styled = Boolean(look.shape) || Boolean(look.effects?.length);
  try {
    if (styled) throw new Error('styled');
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
    const tmpId = randomBytes(6).toString('hex');
    const inPath = path.join(os.tmpdir(), 'as_img_' + tmpId + '.jpg');
    const outPath = path.join(os.tmpdir(), 'as_img_out_' + tmpId + '.webp');
    try {
      await fs.writeFile(inPath, buffer);
      await runFfmpeg([
        '-y',
        '-threads', '1',
        '-i', inPath,
        '-vf', buildFilters(look, 0),
        '-c:v', 'libwebp',
        '-lossless', '0',
        '-q:v', '80',
        '-an',
        '-threads', '1',
        outPath,
      ]);
      return await fs.readFile(outPath);
    } finally {
      await fs.unlink(inPath).catch(() => {});
      await fs.unlink(outPath).catch(() => {});
    }
  }
}

async function buildStickerWithExif(buffer, kind, packname, author, seconds = 0, look = {}) {
  let rawWebp = buffer;
  if (kind === 'video') {
    rawWebp = await videoBufferToAnimatedWebp(buffer, seconds, look);
  } else if (kind === 'image') {
    rawWebp = await imageBufferToWebp(buffer, look);
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

async function convertToOggOpus(buffer, ext = 'mp3', range = null) {
  const tmpId = randomBytes(6).toString('hex');
  const inPath = path.join(os.tmpdir(), 'ptt_in_' + tmpId + '.' + ext);
  const outPath = path.join(os.tmpdir(), 'ptt_out_' + tmpId + '.ogg');

  const encode = async (kbps) => {
    let stderr = '';
    try {
      ({ stderr } = await runFfmpeg(
      [
        '-y',
        '-threads', '1',
        ...(range && range.start > 0 ? ['-ss', String(range.start)] : []),
        '-i', inPath,
        '-vn',
        '-map', '0:a:0?',
        '-t', String(range ? range.duration : MAX_AUDIO_SECONDS),
        '-af', 'aresample=48000:async=1:first_pts=0',
        '-c:a', 'libopus',
        '-b:a', kbps + 'k',
        '-vbr', 'on',
        '-compression_level', '10',
        '-ac', '1',
        '-ar', '48000',
        '-application', 'audio',
        '-avoid_negative_ts', 'make_zero',
        '-threads', '1',
        '-f', 'ogg',
        outPath,
      ],
      { stats: true },
      ));
    } catch (e) {
      if (/does not contain any stream|matches no streams/i.test(String(e?.stderr || e?.message || ''))) {
        throw userError('El archivo no tiene una pista de audio válida.');
      }
      throw e;
    }
    const oggBuffer = await fs.readFile(outPath);
    if (!oggBuffer || oggBuffer.length < 200) {
      throw userError(range ? 'No hay audio en ese rango, revisa los segundos.' : 'El archivo no tiene una pista de audio válida.');
    }
    return { oggBuffer, realSeconds: parseFfmpegDuration(stderr) };
  };

  try {
    await fs.writeFile(inPath, buffer);
    let result = await encode(48);
    if (result.oggBuffer.length > MAX_AUDIO_BYTES && result.realSeconds > 0) {
      const kbps = Math.max(12, Math.floor((MAX_AUDIO_BYTES * 8) / result.realSeconds / 1000));
      result = await encode(kbps);
    }
    return result;
  } finally {
    await fs.unlink(inPath).catch(() => {});
    await fs.unlink(outPath).catch(() => {});
  }
}

async function buildAudioMessageFromBuffer(sock, buffer, ext, fallbackSeconds = 0, range = null) {
  const { prepareWAMessageMedia } = await getBaileys();
  const { oggBuffer, realSeconds } = await convertToOggOpus(buffer, ext, range);

  const { audioMessage } = await prepareWAMessageMedia(
    { audio: oggBuffer, mimetype: 'audio/ogg; codecs=opus', ptt: true },
    { upload: sock.waUploadToServer },
  );

  const chosenSec = realSeconds > 0 ? realSeconds : fallbackSeconds > 0 ? fallbackSeconds : 5;
  const finalSeconds = Math.max(1, Math.min(MAX_AUDIO_SECONDS, Math.round(chosenSec)));

  audioBuffers.set(audioMessage, oggBuffer);
  audioMessage.seconds = finalSeconds;
  audioMessage.ptt = true;
  audioMessage.mimetype = 'audio/ogg; codecs=opus';
  if (!audioMessage.waveform || !audioMessage.waveform.length) {
    audioMessage.waveform = generateWaveform(oggBuffer);
  }

  return { audioMessage, trimmed: !range && fallbackSeconds > MAX_AUDIO_SECONDS };
}

function hashBuffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function pruneAudioStore() {
  try {
    const files = (await fs.readdir(AUDIO_STORE)).filter((f) => f.endsWith('.json'));
    if (files.length <= AUDIO_STORE_MAX) return;
    const stats = await Promise.all(
      files.map(async (f) => ({ f, t: (await fs.stat(path.join(AUDIO_STORE, f))).mtimeMs })),
    );
    stats.sort((a, b) => a.t - b.t);
    for (const { f } of stats.slice(0, files.length - AUDIO_STORE_MAX)) {
      const id = f.replace(/\.json$/, '');
      await fs.unlink(path.join(AUDIO_STORE, id + '.json')).catch(() => {});
      await fs.unlink(path.join(AUDIO_STORE, id + '.ogg')).catch(() => {});
    }
  } catch {}
}

async function saveAudioSticker(stickerBuffer, audioMsg) {
  const ogg = audioBuffers.get(audioMsg);
  if (!ogg) return;
  try {
    await fs.mkdir(AUDIO_STORE, { recursive: true });
    const id = hashBuffer(stickerBuffer);
    const meta = {
      seconds: audioMsg.seconds || 0,
      waveform: audioMsg.waveform ? Buffer.from(audioMsg.waveform).toString('base64') : '',
      savedAt: Date.now(),
    };
    await fs.writeFile(path.join(AUDIO_STORE, id + '.ogg'), ogg);
    await fs.writeFile(path.join(AUDIO_STORE, id + '.json'), JSON.stringify(meta));
    await pruneAudioStore();
  } catch (e) {
    console.error('[asticker] no pude guardar el audio del sticker:', e?.message || e);
  }
}

export async function loadAudioSticker(stickerBuffer) {
  try {
    const id = hashBuffer(stickerBuffer);
    const [audio, raw] = await Promise.all([
      fs.readFile(path.join(AUDIO_STORE, id + '.ogg')),
      fs.readFile(path.join(AUDIO_STORE, id + '.json'), 'utf-8'),
    ]);
    const meta = JSON.parse(raw);
    return {
      audio,
      seconds: meta.seconds || 0,
      waveform: meta.waveform ? Buffer.from(meta.waveform, 'base64') : null,
    };
  } catch {
    return null;
  }
}

export async function forwardAudioSticker(sock, jid, stickerBuffer, isAnimated, stored) {
  const { prepareWAMessageMedia } = await ensurePatched();
  const isChannel = String(jid).endsWith('@newsletter');
  const uploadOpts = { upload: sock.waUploadToServer, jid };

  const prepared = await prepareWAMessageMedia({ sticker: stickerBuffer, isAnimated }, uploadOpts);
  const { audioMessage } = await prepareWAMessageMedia(
    { audio: stored.audio, mimetype: 'audio/ogg; codecs=opus', ptt: true },
    uploadOpts,
  );

  audioMessage.seconds = Math.max(1, Math.round(stored.seconds || 1));
  audioMessage.ptt = true;
  audioMessage.mimetype = 'audio/ogg; codecs=opus';
  audioMessage.waveform = stored.waveform && stored.waveform.length ? stored.waveform : generateWaveform(stored.audio);

  prepared.stickerMessage.isAnimated = Boolean(isAnimated);
  prepared.stickerMessage.audioMessage = audioMessage;

  const payload = {
    __proto__: prepared,
    audioStickerMessage: { message: prepared },
    ...(isChannel ? {} : { messageContextInfo: { messageSecret: randomBytes(32) } }),
  };

  await sock.relayMessage(jid, payload, {});
}

function buildQuotedContext(quotedMsg, jidNormalize) {
  try {
    const key = quotedMsg?.key;
    if (!key?.id) return null;
    const content = unwrapMessageContainer(quotedMsg.message || {});
    const type = Object.keys(content).find((k) => k !== 'messageContextInfo' && content[k]);
    const rawParticipant = key.participant || quotedMsg.sender || key.remoteJid;
    const ctx = {
      stanzaId: key.id,
      participant: typeof jidNormalize === 'function' ? jidNormalize(rawParticipant) : rawParticipant,
    };
    if (type) {
      const inner = content[type];
      const copy = inner && typeof inner === 'object' ? { ...inner } : inner;
      if (copy && typeof copy === 'object') delete copy.contextInfo;
      ctx.quotedMessage = { [type]: copy };
    }
    if (key.remoteJid && quotedMsg.chat && key.remoteJid !== quotedMsg.chat) ctx.remoteJid = key.remoteJid;
    return ctx;
  } catch {
    return null;
  }
}

async function sendCombinedAudioSticker(sock, chat, stickerBuffer, isAnimated, audioMsg, quotedMsg = null) {
  const { prepareWAMessageMedia, jidNormalizedUser } = await ensurePatched();

  const prepared = await prepareWAMessageMedia(
    { sticker: stickerBuffer, isAnimated },
    { upload: sock.waUploadToServer },
  );

  prepared.stickerMessage.isAnimated = Boolean(isAnimated);
  prepared.stickerMessage.audioMessage = audioMsg;

  const quotedCtx = quotedMsg ? buildQuotedContext(quotedMsg, jidNormalizedUser) : null;
  if (quotedCtx) prepared.stickerMessage.contextInfo = quotedCtx;

  const payload = {
    __proto__: prepared,
    audioStickerMessage: { message: prepared },
    messageContextInfo: { messageSecret: randomBytes(32) },
  };

  await sock.relayMessage(chat, payload, {});
  await saveAudioSticker(stickerBuffer, audioMsg);
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
  range = null,
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
              '《✧》 Se acabó el tiempo (' + SESSION_SECONDS + 's).\n' +
              '> Vuelve a enviar la foto o el sticker para crear tu Audio Sticker.',
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
    range,
    expiresAt: Date.now() + SESSION_SECONDS * 1000,
    processing: false,
    timer,
  });

  return send(
    'ꕥ *Audio Sticker en preparación*\n\n' +
      '✦ Pack: *' + packname + '*\n' +
      '✦ Autor: *' + author + '*\n' +
      '✦ Tipo: *' + (isAnimated ? 'Animado' : 'Estático') + '*\n' +
      '✦ Audio: *hasta ' + AUDIO_LABEL + '*\n' +
      '✦ Tiempo: *' + SESSION_SECONDS + ' segundos*\n\n' +
      '✧ Ahora responde a un *audio, nota de voz o video* con *' + prefix + command + '*\n' +
      '> Para cancelar usa *' + prefix + command + ' cancelar*',
  );
}

async function consumeSessionWithAudio(msg, sock, send, react, session, audioNode, audioInfo, range = null) {
  const key = getSessionKey(msg);
  session.processing = true;
  await react('⏳');

  try {
    const audioBuf = await downloadBuffer(audioNode, audioInfo, sock);
    if (!audioBuf || !audioBuf.length) throw userError('No pude descargar el audio o el video.');

    const ext =
      audioInfo.kind === 'video'
        ? 'mp4'
        : /ogg|opus/i.test(audioInfo.mime)
        ? 'ogg'
        : /mp4|m4a|aac/i.test(audioInfo.mime)
        ? 'm4a'
        : 'mp3';

    const audioFit = clampRange(range || session.range || null, MAX_AUDIO_SECONDS, audioInfo.seconds || 0);
    const useRange = audioFit.range;
    if (audioFit.note) await send(audioFit.note);
    if (useRange && audioInfo.seconds && useRange.start >= audioInfo.seconds) {
      throw userError('El inicio del recorte supera la duración del audio (' + fmtTime(Math.round(audioInfo.seconds)) + ').');
    }

    const { audioMessage: audioMsg, trimmed } = await buildAudioMessageFromBuffer(sock, audioBuf, ext, audioInfo.seconds, useRange);

    await sendCombinedAudioSticker(sock, msg.chat, session.stickerBuffer, session.isAnimated, audioMsg, msg);

    clearUserSession(key);
    await react('✅');
    if (trimmed) await send(trimNotice());
  } catch (err) {
    session.processing = false;
    console.error('[asticker]', err?.message || err);
    await react('❌');
    await send('《✧》 ' + friendlyError(err));
  }
}

export default {
  command: ['audiosticker', 'asticker', 'stickeraudio', 'saudio', 'ss'],
  category: 'stickers',
  description: 'Crea un sticker estático o animado con sonido.',

  run: async ({ msg, sock, args, text, usedPrefix, command }) => {
    const prefix = usedPrefix || '#';
    const cmd = command || 'audiosticker';
    const rawText = String(text || (Array.isArray(args) ? args.join(' ') : '')).trim();
    const flagWords = rawText.split(/\s+/).filter(Boolean);
    const look = { shape: null, effects: [] };
    const restWords = [];
    let wantsList = false;
    let urlArg = null;
    let rangeWord = null;
    for (const word of flagWords) {
      const w = word.toLowerCase();
      if (isUrl(word)) urlArg = word;
      else if (RANGE_RE.test(word) || RANGE_OPEN_RE.test(word)) rangeWord = word;
      else if (w === '-list') wantsList = true;
      else if (SHAPES[w] && !look.shape) look.shape = SHAPES[w];
      else if (EFFECTS[w]) look.effects.push(EFFECTS[w]);
      else restWords.push(word);
    }
    if (!rangeWord && restWords.length === 1 && CLOCK_RE.test(restWords[0])) {
      rangeWord = restWords.pop();
    }
    const cleanText = restWords.join(' ').trim();

    const send = (t) => msg.reply(t);
    const react = async (emoji) => {
      await sock.sendMessage(msg.chat, { react: { text: emoji, key: msg.key } }).catch(() => {});
    };

    if (wantsList) {
      return send(buildListText(prefix, cmd));
    }

    let range = null;
    if (rangeWord) {
      range = parseRangeWord(rangeWord);
      if (!range) {
        return send('《✧》 El recorte no es válido, usa *inicio-fin* en segundos o minutos.\n> Ejemplos: *' + prefix + cmd + ' 2-8*, *' + prefix + cmd + ' 34-1:47* o *' + prefix + cmd + ' 34*');
      }
    }

    const key = getSessionKey(msg);
    const activeSession = sessions.get(key);

    if (/^(cancelar|cancel|batal|stop)$/i.test(cleanText)) {
      if (!activeSession) return send('《✧》 No tienes ninguna sesión de Audio Sticker activa.');
      clearUserSession(key);
      await react('✅');
      return send('ꕥ Sesión de Audio Sticker cancelada.');
    }

    if (urlArg) {
      return await handleLink({ msg, sock, send, react, urlArg, range, look, cleanText, prefix, cmd });
    }

    const ownInfo = detectMediaInfo(msg);
    const quoted = msg.quoted;
    const quotedInfo = detectMediaInfo(quoted);

    const hasOwnVisual = ownInfo.kind === 'video' || ownInfo.kind === 'image' || ownInfo.kind === 'webp';
    const hasQuotedVisual = quotedInfo.kind === 'video' || quotedInfo.kind === 'image' || quotedInfo.kind === 'webp';
    const hasOwnAudio = ownInfo.kind === 'audio';
    const hasQuotedAudio = quotedInfo.kind === 'audio';

    if (activeSession && !activeSession.processing && (hasOwnAudio || hasQuotedAudio) && !hasOwnVisual) {
      const targetAudioNode = hasOwnAudio ? msg : quoted;
      const targetAudioInfo = hasOwnAudio ? ownInfo : quotedInfo;
      return await consumeSessionWithAudio(msg, sock, send, react, activeSession, targetAudioNode, targetAudioInfo, range);
    }

    if (activeSession?.processing) {
      return send('《✧》 Tu Audio Sticker anterior todavía se está procesando, espera un momento.');
    }

    if (!hasOwnVisual && !hasQuotedVisual && !hasOwnAudio && !hasQuotedAudio) {
      if (activeSession) {
        const remSec = Math.max(1, Math.ceil((activeSession.expiresAt - Date.now()) / 1000));
        return send(
          '《✧》 Tienes una sesión activa (' + remSec + 's).\n' +
            '> Responde a un audio o nota de voz con *' + prefix + cmd + '*',
        );
      }

      return send(
        'ꕥ *Audio Sticker*\n\n' +
          'Crea stickers con sonido, estáticos o animados.\n\n' +
          '✦ *Con un video:*\n' +
          '> Responde a un video con *' + prefix + cmd + '*\n' +
          '> Para elegir el tramo: *' + prefix + cmd + ' 2-8*\n\n' +
          '✦ *Con un link:*\n' +
          '> *' + prefix + cmd + ' https://youtu.be/xxxx 2-10*\n\n' +
          '✦ *Con foto o sticker:*\n' +
          '> 1. Responde a la foto o sticker con *' + prefix + cmd + '*\n' +
          '> 2. Responde al audio con *' + prefix + cmd + '* o *' + prefix + cmd + ' 7-15*\n\n' +
          '✧ *Pack personalizado:*\n' +
          '> *' + prefix + cmd + ' Pack | Autor*\n\n' +
          '✦ *Formas y efectos:*\n' +
          '> *' + prefix + cmd + ' -list*',
      );
    }

    if (!hasOwnVisual && !hasQuotedVisual && (hasOwnAudio || hasQuotedAudio)) {
      return send(
        '《✧》 Primero responde a una *foto, video o sticker* con *' + prefix + cmd + '*\n' +
          '> Después responde al audio con el mismo comando.',
      );
    }

    await react('⏳');

    try {
      await ensurePatched();

      const { packname, author } = await resolvePackAuthor(msg, cleanText);

      const visualNode = hasOwnVisual ? msg : quoted;
      const visualInfo = hasOwnVisual ? ownInfo : quotedInfo;
      const isVideo = visualInfo.kind === 'video';
      let videoSeconds = visualInfo.seconds || 0;

      if (isVideo && range) {
        const videoFit = clampRange(range, MAX_WEBP_SECONDS, videoSeconds);
        range = videoFit.range;
        if (videoFit.note) await send(videoFit.note);
      }

      let visualData = await downloadBuffer(visualNode, visualInfo, sock);
      if (!visualData || !visualData.length) {
        throw userError('No pude descargar la imagen o el video.');
      }

      if (isVideo && range) {
        if (videoSeconds && range.start >= videoSeconds) {
          throw userError('El inicio del recorte supera la duración del video (' + fmtTime(Math.round(videoSeconds)) + ').');
        }
        visualData = await trimVideoBuffer(visualData, range);
        videoSeconds = range.duration;
      }

      const stickerBuffer = await buildStickerWithExif(visualData, visualInfo.kind, packname, author, videoSeconds, look);
      const isAnimated = isVideo || isWebpAnimated(stickerBuffer);

      if (hasOwnVisual && hasQuotedAudio) {
        const audioBuf = await downloadBuffer(quoted, quotedInfo, sock);
        if (!audioBuf || !audioBuf.length) throw userError('No pude descargar el audio citado.');
        const ext = /ogg|opus/i.test(quotedInfo.mime)
          ? 'ogg'
          : /mp4|m4a|aac/i.test(quotedInfo.mime)
          ? 'm4a'
          : 'mp3';
        const quotedFit = clampRange(isVideo ? null : range, MAX_AUDIO_SECONDS, quotedInfo.seconds || 0);
        const audioRange = quotedFit.range;
        if (quotedFit.note) await send(quotedFit.note);
        if (audioRange && quotedInfo.seconds && audioRange.start >= quotedInfo.seconds) {
          throw userError('El inicio del recorte supera la duración del audio (' + fmtTime(Math.round(quotedInfo.seconds)) + ').');
        }
        const { audioMessage: audioMsg, trimmed } = await buildAudioMessageFromBuffer(sock, audioBuf, ext, quotedInfo.seconds, audioRange);
        await sendCombinedAudioSticker(sock, msg.chat, stickerBuffer, isAnimated, audioMsg, msg);
        clearUserSession(key);
        await react('✅');
        if (trimmed) await send(trimNotice());
        return;
      }

      if (isVideo) {
        try {
          const { audioMessage: audioMsg, trimmed } = await buildAudioMessageFromBuffer(sock, visualData, 'mp4', videoSeconds);
          await sendCombinedAudioSticker(sock, msg.chat, stickerBuffer, true, audioMsg, msg);
          clearUserSession(key);
          await react('✅');
          if (trimmed) await send(trimNotice());
          return;
        } catch (audioErr) {
          if (!audioErr?.isUser && RETRYABLE.test(String(audioErr?.stderr || audioErr?.message || ''))) {
            throw audioErr;
          }
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
            range: null,
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
        range,
      });
    } catch (e) {
      console.error('[asticker]', e?.message || e);
      await react('❌');
      await send('《✧》 ' + friendlyError(e));
    }
  },
};