import db from '#db';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

/* ═════════════ ANIMACIÓN (canvas + ffmpeg) ═════════════ */

const W = 512, H = 640, FPS = 24;
const CX = W / 2, CY = 315, R = 215;
const TAU = Math.PI * 2;
const STEP = TAU / 37;
const SPIN_T = 4.8;
const RESULT_T = 2.8;
const VIDEO_MS = Math.round((SPIN_T + RESULT_T) * 1000);
const FONT = '"DejaVu Sans", "Liberation Sans", Arial, sans-serif';

// intenta registrar una fuente del sistema si existe
for (const p of [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'
]) {
  if (existsSync(p)) { try { GlobalFonts.registerFromPath(p, 'DejaVu Sans'); } catch {} break; }
}

const ORDER = [0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];
const RED = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeOutBack = (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
const mulberry32 = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const colorOf = (n) => n === 0 ? '#0f9d58' : RED.has(n) ? '#d62839' : '#17171f';

let bgCache, baseCache;

function getBg() {
  if (bgCache) return bgCache;
  const c = createCanvas(W, H), x = c.getContext('2d');
  const g = x.createRadialGradient(CX, CY, 40, CX, CY, 470);
  g.addColorStop(0, '#3b1a6e'); g.addColorStop(0.6, '#150a2e'); g.addColorStop(1, '#05030c');
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  const rng = mulberry32(7);
  for (let i = 0; i < 70; i++) {
    x.fillStyle = `rgba(255,255,255,${0.1 + rng() * 0.3})`;
    x.beginPath(); x.arc(rng() * W, rng() * H, rng() * 1.6 + 0.3, 0, TAU); x.fill();
  }
  return (bgCache = c);
}

function getBase() {
  if (baseCache) return baseCache;
  const c = createCanvas(W, H), x = c.getContext('2d');
  x.translate(CX, CY);
  x.shadowColor = 'rgba(0,0,0,.7)'; x.shadowBlur = 25;
  let g = x.createRadialGradient(0, 0, R - 5, 0, 0, R + 16);
  g.addColorStop(0, '#8a5a2b'); g.addColorStop(0.5, '#c98a45'); g.addColorStop(1, '#4a2a10');
  x.fillStyle = g; x.beginPath(); x.arc(0, 0, R + 16, 0, TAU); x.fill();
  x.shadowBlur = 0;
  x.strokeStyle = '#ffd54a'; x.lineWidth = 3;
  x.beginPath(); x.arc(0, 0, R + 16, 0, TAU); x.stroke();
  x.lineWidth = 2; x.beginPath(); x.arc(0, 0, R - 4, 0, TAU); x.stroke();
  g = x.createRadialGradient(0, 0, R - 42, 0, 0, R - 4);
  g.addColorStop(0, '#0d0d14'); g.addColorStop(0.5, '#2c2c3a'); g.addColorStop(1, '#0d0d14');
  x.fillStyle = g; x.beginPath(); x.arc(0, 0, R - 4, 0, TAU); x.arc(0, 0, R - 42, 0, TAU, true); x.fill();
  x.fillStyle = '#ffd54a'; x.beginPath(); x.moveTo(0, -R - 22); x.lineTo(-10, -R - 40); x.lineTo(10, -R - 40); x.closePath(); x.fill();
  return (baseCache = c);
}

function text(ctx, str, x, y, { size = 24, color = '#fff', weight = 'bold', align = 'center', stroke, shadow } = {}) {
  ctx.save();
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.textAlign = align; ctx.textBaseline = 'middle';
  if (shadow) { ctx.shadowColor = shadow; ctx.shadowBlur = 18; }
  if (stroke) { ctx.lineWidth = 5; ctx.strokeStyle = stroke; ctx.lineJoin = 'round'; ctx.strokeText(str, x, y); }
  ctx.fillStyle = color; ctx.fillText(str, x, y);
  ctx.restore();
}

const wheelAt = (s, t) => s.w0 + (s.w1 - s.w0) * easeOutCubic(clamp(t / SPIN_T));

function ballAt(s, t) {
  const p = clamp(t / SPIN_T);
  const phi = s.b0 + s.bd * easeOutCubic(p);
  const rTrack = R - 23, rEnd = R - 90;
  let r = rTrack;
  if (p > 0.6) {
    const q = (p - 0.6) / 0.4;
    r = lerp(rTrack, rEnd, q * q) + Math.sin(q * Math.PI * 4) * (1 - q) * 11 * q;
  }
  return { x: CX + Math.cos(phi) * r, y: CY + Math.sin(phi) * r, p };
}

function drawWheel(ctx, ang, hiIdx, hiAlpha) {
  const rOut = R - 42, rIn = R - 108;
  ctx.save(); ctx.translate(CX, CY); ctx.rotate(ang);
  for (let i = 0; i < 37; i++) {
    const a0 = i * STEP - Math.PI / 2, a1 = a0 + STEP;
    ctx.beginPath(); ctx.arc(0, 0, rOut, a0, a1); ctx.arc(0, 0, rIn, a1, a0, true); ctx.closePath();
    ctx.fillStyle = colorOf(ORDER[i]); ctx.fill();
    ctx.strokeStyle = '#d4af37'; ctx.lineWidth = 1; ctx.stroke();
    if (i === hiIdx && hiAlpha > 0) {
      ctx.fillStyle = `rgba(255,224,102,${hiAlpha * 0.55})`; ctx.fill();
      ctx.strokeStyle = `rgba(255,255,255,${hiAlpha})`; ctx.lineWidth = 3; ctx.stroke();
    }
    ctx.save(); ctx.rotate(a0 + STEP / 2 + Math.PI / 2); ctx.translate(0, -(R - 60));
    text(ctx, String(ORDER[i]), 0, 0, { size: 14 });
    ctx.restore();
  }
  const g = ctx.createRadialGradient(0, 0, 10, 0, 0, rIn);
  g.addColorStop(0, '#f6dd8c'); g.addColorStop(0.55, '#b88a2c'); g.addColorStop(1, '#5a3d0e');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, rIn, 0, TAU); ctx.fill();
  ctx.strokeStyle = 'rgba(60,35,5,.8)'; ctx.lineWidth = 7; ctx.lineCap = 'round';
  for (let k = 0; k < 4; k++) {
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(k * Math.PI / 2) * (rIn - 8), Math.sin(k * Math.PI / 2) * (rIn - 8)); ctx.stroke();
  }
  ctx.restore();
}

function drawBall(ctx, x, y, size = 7, alpha = 1) {
  ctx.save(); ctx.globalAlpha = alpha;
  ctx.shadowColor = 'rgba(0,0,0,.7)'; ctx.shadowBlur = 6;
  const g = ctx.createRadialGradient(x - 2, y - 2, 1, x, y, size);
  g.addColorStop(0, '#fff'); g.addColorStop(1, '#bfc6d6');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, size, 0, TAU); ctx.fill();
  ctx.restore();
}

function makeFx(s) {
  const rng = mulberry32(s.seed);
  const colors = ['#ffd54a', '#ff4d6d', '#4dd2ff', '#7cff6b', '#c77dff', '#ffffff'];
  const n = s.outcome === 'jackpot' ? 170 : s.outcome === 'win' ? 80 : 0;
  s.confetti = Array.from({ length: n }, () => ({
    x0: rng() * W, y0: -20 - rng() * 160, vx: (rng() - 0.5) * 120, vy: 90 + rng() * 140, g: 130,
    rot: rng() * TAU, vr: (rng() - 0.5) * 14, w: 6 + rng() * 6, h: 10 + rng() * 8,
    c: colors[Math.floor(rng() * colors.length)], delay: rng() * 0.9
  }));
  s.fireworks = s.outcome !== 'jackpot' ? [] : [0.1, 0.6, 1.1, 1.6, 2.1].map((t0) => {
    const color = colors[Math.floor(rng() * 5)];
    return { t0, x: 90 + rng() * 330, y: 90 + rng() * 230, color,
      sparks: Array.from({ length: 36 }, (_, i) => ({ a: (i / 36) * TAU + rng() * 0.2, sp: 90 + rng() * 120 })) };
  });
}

function drawFrame(ctx, t, s) {
  const tr = t - SPIN_T, landed = tr >= 0, trp = Math.max(0, tr);
  const shake = s.outcome === 'lose' && landed && trp < 0.7 ? Math.sin(trp * 55) * 9 * (1 - trp / 0.7) : 0;
  const zoom = s.outcome === 'jackpot' && landed ? 1 + 0.035 * Math.abs(Math.sin(trp * 6)) * Math.exp(-trp * 0.5) : 1;

  ctx.fillStyle = '#05030c'; ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.translate(CX + shake, CY); ctx.scale(zoom, zoom); ctx.translate(-CX, -CY);
  ctx.drawImage(getBg(), 0, 0);

  if (s.outcome === 'jackpot' && landed) {
    const a = clamp(trp / 0.4);
    ctx.save(); ctx.translate(CX, CY); ctx.rotate(trp * 0.6);
    for (let k = 0; k < 14; k++) {
      ctx.fillStyle = `rgba(255,213,74,${0.2 * a})`;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, 560, k * (TAU / 14), k * (TAU / 14) + 0.17); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  ctx.drawImage(getBase(), 0, 0);
  const hiAlpha = landed ? 0.5 + 0.5 * Math.sin(trp * 10) : 0;
  drawWheel(ctx, wheelAt(s, t), s.idx, hiAlpha);

  const b = ballAt(s, t);
  if (b.p < 0.97) {
    for (let k = 6; k >= 1; k--) {
      const tt = t - k * 0.022; if (tt < 0) continue;
      const bp = ballAt(s, tt); drawBall(ctx, bp.x, bp.y, 7 - k * 0.6, (1 - k / 7) * 0.45);
    }
  }
  drawBall(ctx, b.x, b.y);

  if (landed && s.outcome !== 'lose') {
    const col = s.outcome === 'jackpot' ? '#ffd54a' : '#5cff9d';
    ctx.save(); ctx.strokeStyle = col; ctx.shadowColor = col;
    ctx.shadowBlur = 28 + 18 * Math.sin(trp * 9); ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(CX, CY, R + 22, 0, TAU); ctx.stroke(); ctx.restore();
  }

  if (landed) {
    const sc = easeOutBack(clamp(trp / 0.35));
    ctx.save(); ctx.translate(CX, CY); ctx.scale(sc, sc);
    ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 12;
    ctx.fillStyle = colorOf(s.number); ctx.beginPath(); ctx.arc(0, 0, 46, 0, TAU); ctx.fill();
    ctx.shadowBlur = 0; ctx.strokeStyle = '#ffd54a'; ctx.lineWidth = 4; ctx.stroke();
    text(ctx, String(s.number), 0, 2, { size: 40 });
    ctx.restore();
  }

  for (const f of s.fireworks) {
    const ts = trp - f.t0; if (!landed || ts < 0 || ts > 1.2) continue;
    const d = (1 - Math.exp(-2.2 * ts)) / 2.2;
    ctx.fillStyle = f.color; ctx.globalAlpha = 1 - ts / 1.2;
    for (const sp of f.sparks) {
      ctx.beginPath(); ctx.arc(f.x + Math.cos(sp.a) * sp.sp * d, f.y + Math.sin(sp.a) * sp.sp * d + 60 * ts * ts, 2.6, 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  if (landed) for (const c of s.confetti) {
    const ts = trp - c.delay; if (ts < 0) continue;
    const x = c.x0 + c.vx * ts + Math.sin(ts * 3 + c.rot) * 20;
    const y = c.y0 + c.vy * ts + 0.5 * c.g * ts * ts;
    if (y > H + 20) continue;
    ctx.save(); ctx.translate(x, y); ctx.rotate(c.rot + c.vr * ts);
    ctx.fillStyle = c.c; ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h); ctx.restore();
  }
  ctx.restore();

  if (landed && s.outcome === 'lose') {
    const a = clamp(trp / 0.35);
    ctx.fillStyle = `rgba(0,0,0,${0.3 * a})`; ctx.fillRect(0, 0, W, H);
    const g = ctx.createRadialGradient(CX, CY, 150, CX, CY, 420);
    g.addColorStop(0, 'rgba(255,0,0,0)'); g.addColorStop(1, `rgba(255,20,40,${(0.35 + 0.15 * Math.sin(trp * 8)) * a})`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }
  if (landed && s.outcome === 'jackpot' && trp < 0.3) {
    ctx.fillStyle = `rgba(255,255,255,${0.85 * (1 - trp / 0.3)})`; ctx.fillRect(0, 0, W, H);
  }

  text(ctx, 'RULETA', CX, 38, { size: 34, color: '#ffd54a', shadow: 'rgba(255,213,74,.7)' });
  if (!landed) {
    const dots = '.'.repeat(1 + (Math.floor(t * 3) % 3));
    text(ctx, `GIRANDO${dots}`, CX, 588, { size: 30, stroke: '#000' });
    text(ctx, s.betLine, CX, 625, { size: 18, color: '#cfc6e8', weight: 'normal' });
  } else {
    const sc = easeOutBack(clamp(trp / 0.4));
    const pal = { jackpot: '#ffd54a', win: '#5cff9d', lose: '#ff5468' }[s.outcome];
    ctx.save(); ctx.translate(CX + shake, 585); ctx.scale(sc, sc);
    text(ctx, s.title, 0, 0, { size: s.outcome === 'jackpot' ? 44 : 40, color: pal, stroke: '#000', shadow: pal });
    ctx.restore();
    text(ctx, s.sub, CX, 625, { size: 22, color: '#fff', stroke: '#000' });
  }
}

async function renderRouletteVideo({ winningNumber, betLabel, amount, outcome, net, multiplier }) {
  const plain = betLabel.replace(/[^\p{L}\p{N}\s()\-]/gu, '').trim();
  const idx = ORDER.indexOf(winningNumber);
  const rng = mulberry32(winningNumber * 977 + (amount % 1000) + Date.now() % 997);

  const w0 = rng() * TAU, w1 = w0 + TAU * (3 + rng());
  const b0 = rng() * TAU;
  const phiF = w1 + (idx + 0.5) * STEP - Math.PI / 2;
  const d = (((phiF - b0) % TAU) + TAU) % TAU;

  const s = {
    number: winningNumber, idx, outcome, w0, w1, b0, bd: d - TAU * 6, seed: winningNumber + 31,
    betLine: `¥${amount.toLocaleString()} · ${plain}`,
    title: outcome === 'jackpot' ? '¡¡JACKPOT!!' : outcome === 'win' ? '¡GANASTE!' : 'PERDISTE',
    sub: outcome === 'lose' ? `-¥${amount.toLocaleString()}` : `+¥${net.toLocaleString()}  (x${multiplier})`
  };
  makeFx(s);

  const out = join(tmpdir(), `rt-${randomUUID()}.mp4`);
  const ff = spawn(ffmpegInstaller.path, ['-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-',
    '-an', '-c:v', 'libx264', '-profile:v', 'baseline', '-level', '3.0', '-preset', 'veryfast', '-crf', '26',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  ff.stderr.on('data', (c) => { err += c; });
  ff.stdin.on('error', () => {});
  const done = new Promise((res, rej) => {
    ff.on('error', rej);
    ff.on('close', (code) => code === 0 ? res() : rej(new Error(`ffmpeg ${code}: ${err.slice(-300)}`)));
  });

  const canvas = createCanvas(W, H), ctx = canvas.getContext('2d');
  const total = Math.round((SPIN_T + RESULT_T) * FPS);
  try {
    for (let i = 0; i < total; i++) {
      drawFrame(ctx, i / FPS, s);
      const img = ctx.getImageData(0, 0, W, H);
      const buf = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
      if (i % 4 === 0) await new Promise((r) => setImmediate(r));
    }
    ff.stdin.end();
    await done;
    return await readFile(out);
  } finally {
    ff.kill('SIGKILL');
    unlink(out).catch(() => {});
  }
}

/* ═════════════ COMANDO ═════════════ */

function msToTime(duration) {
  const totalSec = Math.ceil(duration / 1000);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const parts = [];
  if (minutes > 0) parts.push(`${minutes} min`);
  parts.push(`${seconds} seg`);
  return parts.join(' ');
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const redNumbers = [...RED];
const blackNumbers = [2, 4, 6, 8, 10, 11, 13, 15, 17, 20, 22, 24, 26, 28, 29, 31, 33, 35];
const emojiOf = (n) => RED.has(n) ? '🔴' : blackNumbers.includes(n) ? '⚫' : '🟢';
const fmt = (n) => (n < 10 ? '0' + n : n);

export default {
  command: ['rt', 'roulette', 'ruleta', 'helprt'],
  category: 'economy',
  description: 'Juego de ruleta, usa helprt para ver las diferentes probabilidades y multiplicadores.',
  run: async ({ msg, sock, args, usedPrefix, command }) => {
    const chatId = msg.chat;
    const senderId = msg.sender;
    const chatData = db.getChat(chatId);

    if (chatData?.adminonly || !chatData?.economy) {
      return msg.reply(`ꕥ Los comandos de *Economía* están desactivados en este grupo.\n\nUn *administrador* puede activarlos con el comando:\n» *${usedPrefix}economy on*`);
    }

    if (command === 'helprt' || (args[0] && /help|ayuda/i.test(args[0]))) {
      const helpText = `─── ❛ *GUÍA RULETA* ❜ ───

✦ ┊ *MULTIPLICADORES Y PROBABILIDADES*
> ◈ *Número exacto (0-36)* » Pago *x36* | Prob. ~2.7%
> ◈ *Verde (green)* » Pago *x36* | Prob. ~2.7%
> ◈ *Rojo / Negro (red/black)* » Pago *x2* | Prob. ~48.6%
> ◈ *Par / Impar (par/impar)* » Pago *x2* | Prob. ~48.6%
> ◈ *Alto / Bajo (alto/bajo)* » Pago *x2* | Prob. ~48.6%

✦ ┊ *EJEMPLOS DE USO*
> ◈ Apostar número » *${usedPrefix}rt 5000 7*
> ◈ Apostar color » *${usedPrefix}rt 2000 red*
> ◈ Apostar todo » *${usedPrefix}rt all par*

───────────────
❖ Apuesta mínima » *¥200*`;
      return sock.sendMessage(chatId, { text: helpText }, { quoted: msg });
    }

    if (args.length < 2) {
      return msg.reply(`ꕥ Ingresa una cantidad a apostar y tu elección.\n> Usa *${usedPrefix}helprt* para ver las opciones y multiplicadores.`);
    }

    db.setCreate('chat_users', [chatId, senderId], 'lastroulette', 0);
    let user = db.getChatUser(chatId, senderId) || {};
    const userCoins = user.coins || 0;
    const lastRoulette = user.lastroulette || 0;

    const cooldown = 30000;
    if (Date.now() - lastRoulette < cooldown) {
      const restante = lastRoulette + cooldown - Date.now();
      return msg.reply(`ꕥ Debes esperar *${msToTime(restante)}* para volver a girar la ruleta.`);
    }

    let amountInput = args[0];
    let targetInput = args[1].toLowerCase();
    if (isNaN(parseInt(args[0])) && !['all', 'todo'].includes(args[0].toLowerCase())) {
      targetInput = args[0].toLowerCase();
      amountInput = args[1];
    }

    const amount = ['all', 'todo'].includes(amountInput.toLowerCase()) ? userCoins : parseInt(amountInput);
    if (isNaN(amount) || amount < 200) return msg.reply(`ꕥ La apuesta mínima es de *¥200*.`);
    if (userCoins < amount) return msg.reply(`ꕥ Tus fondos no son suficientes. Tienes *¥${userCoins.toLocaleString()}*.`);

    let betType, betValue, betLabel;
    if (!isNaN(parseInt(targetInput))) {
      const n = parseInt(targetInput);
      if (n < 0 || n > 36) return msg.reply(`ꕥ El número debe estar en el rango de *0 a 36*.`);
      betType = 'number'; betValue = n; betLabel = `${emojiOf(n)} NÚMERO ${n}`;
    } else if (['red', 'rojo'].includes(targetInput)) { betType = 'color'; betValue = 'red'; betLabel = '🔴 ROJO'; }
    else if (['black', 'negro'].includes(targetInput)) { betType = 'color'; betValue = 'black'; betLabel = '⚫ NEGRO'; }
    else if (['green', 'verde'].includes(targetInput)) { betType = 'color'; betValue = 'green'; betLabel = '🟢 VERDE'; }
    else if (['par', 'even'].includes(targetInput)) { betType = 'parity'; betValue = 'even'; betLabel = '🎰 PAR'; }
    else if (['impar', 'odd'].includes(targetInput)) { betType = 'parity'; betValue = 'odd'; betLabel = '🎰 IMPAR'; }
    else if (['bajo', 'low'].includes(targetInput)) { betType = 'range'; betValue = 'low'; betLabel = '📉 BAJO (1-18)'; }
    else if (['alto', 'high'].includes(targetInput)) { betType = 'range'; betValue = 'high'; betLabel = '📈 ALTO (19-36)'; }
    else return msg.reply(`ꕥ Opción no válida. Usa *${usedPrefix}helprt* para ver las opciones disponibles.`);

    // Se decide y se cobra YA; la animación es solo visual
    db.updateChatUser(chatId, senderId, 'lastroulette', Date.now());

    const winningNumber = Math.floor(Math.random() * 37);
    const winningColor = winningNumber === 0 ? 'green' : RED.has(winningNumber) ? 'red' : 'black';

    let multiplier = 0;
    if (betType === 'number' && winningNumber === betValue) multiplier = 36;
    else if (betType === 'color' && winningColor === betValue) multiplier = betValue === 'green' ? 36 : 2;
    else if (betType === 'parity' && winningNumber !== 0 && (winningNumber % 2 === 0) === (betValue === 'even')) multiplier = 2;
    else if (betType === 'range' && winningNumber !== 0 &&
      ((betValue === 'low' && winningNumber <= 18) || (betValue === 'high' && winningNumber >= 19))) multiplier = 2;

    const isWin = multiplier > 0;
    const jackpot = isWin && multiplier === 36;
    const outcome = jackpot ? 'jackpot' : isWin ? 'win' : 'lose';
    const net = isWin ? amount * multiplier - amount : 0;

    user = db.getChatUser(chatId, senderId) || {};
    const current = user.coins || 0;
    if (current < amount) return msg.reply(`ꕥ Tus fondos no son suficientes. Tienes *¥${current.toLocaleString()}*.`);
    const newCoins = isWin ? current + net : Math.max(0, current - amount);
    db.updateChatUser(chatId, senderId, 'coins', newCoins);

    const resultStatus = jackpot
      ? `🎰✨ *¡¡JACKPOT!!* ✨🎰\n> ◈ Multiplicador » *x${multiplier}*\n> ◈ Ganancia neta » *+¥${net.toLocaleString()}*`
      : isWin
        ? `🥳 *¡VICTORIA!*\n> ◈ Multiplicador » *x${multiplier}*\n> ◈ Ganancia neta » *+¥${net.toLocaleString()}*`
        : `💔 *Mala suerte, has perdido.*\n> ◈ Pérdida » *-¥${amount.toLocaleString()}*`;

    const finalText = `─── ❛ *RULETA* ❜ ───

🎯 ┊ *Resultado final:* [ ${emojiOf(winningNumber)} ${fmt(winningNumber)} ]

❖ Tu apuesta » *¥${amount.toLocaleString()}*
❖ Tu elección » *${betLabel}*

${resultStatus}

───────────────
❖ Saldo actual » *¥${newCoins.toLocaleString()}*`;

    const spinningCaption = `─── ❛ *RULETA* ❜ ───

🎡 _La bola está girando..._

❖ Apuesta » *¥${amount.toLocaleString()}*
❖ Elección » *${betLabel}*`;

    let sent;
    try {
      const video = await renderRouletteVideo({ winningNumber, betLabel, amount, outcome, net, multiplier });
      sent = await sock.sendMessage(chatId, {
        video, mimetype: 'video/mp4', gifPlayback: true, caption: spinningCaption
      }, { quoted: msg });
    } catch (e) {
      console.error('[ruleta] error animación:', e);
      return sock.sendMessage(chatId, { text: finalText }, { quoted: msg });
    }

    await delay(VIDEO_MS + 1500);
    try {
      await sock.sendMessage(chatId, { caption: finalText, edit: sent.key });
    } catch (e) {
      console.error('[ruleta] no se pudo editar, enviando mensaje nuevo:', e);
      await sock.sendMessage(chatId, { text: finalText }, { quoted: msg });
    }
  }
};