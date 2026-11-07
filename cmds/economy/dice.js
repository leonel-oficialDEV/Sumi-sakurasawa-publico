import db from '#db';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const W = 512, H = 640, FPS = 20;
const CX = W / 2, DY = 285;
const TAU = Math.PI * 2;
const RESULT_T = 2.6;
const SANS = '"DejaVu Sans", "Liberation Sans", Arial, sans-serif';
const SERIF = '"DejaVu Serif", "Liberation Serif", Georgia, serif';

for (const [p, name] of [
  ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 'DejaVu Sans'],
  ['/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf', 'DejaVu Sans'],
  ['/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf', 'DejaVu Serif'],
  ['/usr/share/fonts/dejavu/DejaVuSerif-Bold.ttf', 'DejaVu Serif'],
  ['/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf', 'Liberation Sans'],
  ['/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf', 'Liberation Serif']
]) {
  if (existsSync(p)) { try { GlobalFonts.registerFromPath(p, name); } catch {} }
}

const PIPS = {
  1: [[0, 0]],
  2: [[-1, -1], [1, 1]],
  3: [[-1, -1], [0, 0], [1, 1]],
  4: [[-1, -1], [1, -1], [-1, 1], [1, 1]],
  5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]],
  6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]]
};

const FACES = [
  { val: 1, n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { val: 6, n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
  { val: 2, n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  { val: 5, n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { val: 3, n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  { val: 4, n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] }
];
const NORMAL_OF = Object.fromEntries(FACES.map((f) => [f.val, f.n]));
const VERTS = [];
for (const a of [-0.5, 0.5]) for (const b of [-0.5, 0.5]) for (const c of [-0.5, 0.5]) VERTS.push([a, b, c]);

const RAD = 0.1;
const SZ = 0.42;
const INNER = 0.5 - RAD;
const GC = [-0.5, -0.5 + RAD / 2, -0.5 + RAD, 0.5 - RAD, 0.5 - RAD / 2, 0.5];
const clampI = (x) => Math.max(-INNER, Math.min(INNER, x));
const MESH = FACES.map((f) => {
  const verts = [];
  for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
    const p = [0, 1, 2].map((k) => f.n[k] * 0.5 + f.u[k] * GC[i] + f.v[k] * GC[j]);
    const q = p.map(clampI);
    const d = [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
    const l = Math.hypot(d[0], d[1], d[2]);
    const nn = [d[0] / l, d[1] / l, d[2] / l];
    verts.push({ pos: [q[0] + nn[0] * RAD, q[1] + nn[1] * RAD, q[2] + nn[2] * RAD], n: nn });
  }
  const quads = [];
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) quads.push([i * 6 + j, (i + 1) * 6 + j, (i + 1) * 6 + j + 1, i * 6 + j + 1]);
  return { f, verts, quads };
});

const CAM_D = 9.2, FOCAL = 930, OY = 310;
const PITCH = 56 * Math.PI / 180;
const SP = Math.sin(PITCH), CP = Math.cos(PITCH);
const CAM = [0, CAM_D * SP, CAM_D * CP];
const VDIR = [0, SP, CP];
const LIGHT = (() => { const v = [-0.35, 1, 0.45]; const l = Math.hypot(...v); return v.map((x) => x / l); })();
const HALF = (() => { const v = [LIGHT[0] + VDIR[0], LIGHT[1] + VDIR[1], LIGHT[2] + VDIR[2]]; const l = Math.hypot(...v); return v.map((x) => x / l); })();

const BET_CHIP = { top: '#1d4a9c', side: '#10285a', dash: '#f1f1f1' };
const PAY_CHIP = { top: '#17171d', side: '#07070a', dash: '#d4af37' };

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const mulberry32 = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const LABELS = { '<7': 'MENOR A 7', '>7': 'MAYOR A 7', '7': 'SIETE EXACTO', snake: 'SNAKE EYES', boxcars: 'BOXCARS' };

const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const mm = (A, B) => {
  const r = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
  return r;
};
const mv = (M, v) => [
  M[0] * v[0] + M[1] * v[1] + M[2] * v[2],
  M[3] * v[0] + M[4] * v[1] + M[5] * v[2],
  M[6] * v[0] + M[7] * v[1] + M[8] * v[2]
];
const rot = (ax, a) => {
  const l = Math.hypot(ax[0], ax[1], ax[2]) || 1;
  const x = ax[0] / l, y = ax[1] / l, z = ax[2] / l;
  const c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  return [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c
  ];
};
const alignUp = (n) => {
  if (n[1] > 0.999) return IDENT;
  if (n[1] < -0.999) return rot([1, 0, 0], Math.PI);
  return rot([-n[2], 0, n[0]], Math.acos(n[1]));
};

function proj(x, y, z) {
  const depth = CAM_D - (y * SP + z * CP);
  const k = FOCAL / depth;
  return [CX + x * k, OY - (y * CP - z * SP) * k, depth, k];
}

function pp(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function rr(ctx, x, y, w, h, r) { ctx.beginPath(); pp(ctx, x, y, w, h, r); }

function stext(ctx, str, x, y, { size = 20, color = '#fff', spacing = 3, weight = 'bold', font = SANS, alpha = 1, shadow } = {}) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `${weight} ${size}px ${font}`;
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  const chars = [...str];
  const widths = chars.map((c) => ctx.measureText(c).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * (chars.length - 1);
  let cx = x - total / 2;
  if (shadow) { ctx.shadowColor = shadow; ctx.shadowBlur = 14; }
  ctx.fillStyle = color;
  chars.forEach((c, i) => { ctx.fillText(c, cx, y); cx += widths[i] + spacing; });
  ctx.restore();
}

let bgCache;

function getBg() {
  if (bgCache) return bgCache;
  const c = createCanvas(W, H), x = c.getContext('2d');
  let g = x.createRadialGradient(CX, 270, 20, CX, 310, 470);
  g.addColorStop(0, '#1f7048'); g.addColorStop(0.5, '#135034'); g.addColorStop(1, '#06180f');
  x.fillStyle = g; x.fillRect(0, 0, W, H);

  const rng = mulberry32(21);
  for (let i = 0; i < 2800; i++) {
    const light = rng() > 0.5;
    x.fillStyle = light ? `rgba(255,255,255,${0.012 + rng() * 0.035})` : `rgba(0,0,0,${0.03 + rng() * 0.08})`;
    x.fillRect(rng() * W, rng() * H, 1.5, 1.5);
  }

  const ring = (rx, rz, color, lw) => {
    x.strokeStyle = color; x.lineWidth = lw; x.beginPath();
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * TAU;
      const p = proj(Math.cos(a) * rx, 0, Math.sin(a) * rz);
      if (i) x.lineTo(p[0], p[1]); else x.moveTo(p[0], p[1]);
    }
    x.stroke();
  };
  ring(3.3, 1.45, 'rgba(224,190,100,.32)', 2);
  ring(3.5, 1.62, 'rgba(224,190,100,.15)', 1.2);

  stext(x, 'SNAKE EYES  1-1  ·  PAGA 10', CX, 98, { size: 11, color: 'rgba(224,190,100,.35)', spacing: 3, font: SERIF });
  stext(x, 'BOXCARS  6-6  ·  PAGA 12', CX, 118, { size: 11, color: 'rgba(224,190,100,.35)', spacing: 3, font: SERIF });

  g = x.createRadialGradient(CX, 240, 40, CX, 240, 340);
  g.addColorStop(0, 'rgba(255,244,214,.14)'); g.addColorStop(1, 'rgba(255,244,214,0)');
  x.fillStyle = g; x.fillRect(0, 0, W, H);

  g = x.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#4a2c1c'); g.addColorStop(0.5, '#2a160d'); g.addColorStop(1, '#3d2416');
  x.fillStyle = g;
  x.beginPath(); x.rect(0, 0, W, H); pp(x, 24, 24, W - 48, H - 48, 34);
  x.fill('evenodd');
  x.strokeStyle = 'rgba(255,255,255,.1)'; x.lineWidth = 1.5; rr(x, 24, 24, W - 48, H - 48, 34); x.stroke();
  x.strokeStyle = 'rgba(0,0,0,.6)'; x.lineWidth = 3; rr(x, 26.5, 26.5, W - 53, H - 53, 32); x.stroke();
  x.strokeStyle = '#b8923a'; x.lineWidth = 1.5; rr(x, 12, 12, W - 24, H - 24, 40); x.stroke();

  g = x.createRadialGradient(CX, H / 2, 200, CX, H / 2, 470);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.5)');
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  return (bgCache = c);
}

function convexHull(pts) {
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [];
  for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  const up = [];
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  up.pop(); lo.pop();
  return lo.concat(up);
}

function drawDieShadow(ctx, st) {
  const { pos, R } = st;
  const pts = [];
  for (const v of VERTS) {
    const w = mv(R, v).map((c) => c * SZ);
    const y = Math.max(0, pos[1] + w[1]);
    const sp = 1 + y * 0.12;
    const p = proj(pos[0] + w[0] * sp * 0.94 + 0.32 * y, 0, pos[2] + w[2] * sp * 0.94 - 0.2 * y);
    pts.push([p[0], p[1]]);
  }
  const hull = convexHull(pts);
  let cx = 0, cy = 0;
  for (const p of hull) { cx += p[0]; cy += p[1]; }
  cx /= hull.length; cy /= hull.length;
  const a = 0.62 / (1 + Math.max(0, pos[1] - 0.5 * SZ) * 0.9);
  for (const sc of [1.3, 1.16, 1.04, 0.94]) {
    ctx.fillStyle = `rgba(0,0,0,${a * 0.3})`;
    ctx.beginPath();
    hull.forEach((p, i) => {
      const px = cx + (p[0] - cx) * sc, py = cy + (p[1] - cy) * sc;
      if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    });
    ctx.closePath(); ctx.fill();
  }
}

function goldShade(n) {
  const d = Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
  const s = Math.pow(Math.max(0, n[0] * HALF[0] + n[1] * HALF[1] + n[2] * HALF[2]), 40);
  const dv = n[0] * VDIR[0] + n[1] * VDIR[1] + n[2] * VDIR[2];
  const ry = 2 * dv * n[1] - VDIR[1];
  const sky = clamp(ry * 0.5 + 0.5);
  const base = 0.2 + 0.58 * d + 0.32 * sky * sky;
  const r = Math.min(255, Math.round(240 * base + 255 * s * 0.85));
  const g = Math.min(255, Math.round(172 * base + 236 * s * 0.85));
  const b = Math.min(255, Math.round(34 * base + 175 * s * 0.85));
  return `rgb(${r},${g},${b})`;
}

function drawDie3D(ctx, st, glow, alpha = 1) {
  const { pos, R } = st;
  ctx.save();
  ctx.globalAlpha = alpha; ctx.lineJoin = 'round';

  if (glow) {
    const c = proj(pos[0], pos[1], pos[2]);
    const rad = c[3] * 1.5 * SZ;
    const g = ctx.createRadialGradient(c[0], c[1], 5, c[0], c[1], rad);
    g.addColorStop(0, 'rgba(255,205,100,.4)'); g.addColorStop(1, 'rgba(255,205,100,0)');
    ctx.fillStyle = g; ctx.fillRect(c[0] - rad * 1.1, c[1] - rad * 1.1, rad * 2.2, rad * 2.2);
  }

  const quads = [];
  const vis = [];
  for (const m of MESH) {
    const nF = mv(R, m.f.n);
    const cF = [pos[0] + nF[0] * 0.5 * SZ, pos[1] + nF[1] * 0.5 * SZ, pos[2] + nF[2] * 0.5 * SZ];
    if (nF[0] * (CAM[0] - cF[0]) + nF[1] * (CAM[1] - cF[1]) + nF[2] * (CAM[2] - cF[2]) > 0.05) vis.push({ m, cF });

    const sv = m.verts.map((v) => {
      const w = mv(R, v.pos).map((c) => c * SZ);
      const wp = [pos[0] + w[0], pos[1] + w[1], pos[2] + w[2]];
      return { wp, n: mv(R, v.n), pr: proj(wp[0], wp[1], wp[2]) };
    });
    for (const q of m.quads) {
      const a = sv[q[0]], b = sv[q[1]], c = sv[q[2]], d = sv[q[3]];
      let n = [a.n[0] + b.n[0] + c.n[0] + d.n[0], a.n[1] + b.n[1] + c.n[1] + d.n[1], a.n[2] + b.n[2] + c.n[2] + d.n[2]];
      const nl = Math.hypot(n[0], n[1], n[2]) || 1;
      n = [n[0] / nl, n[1] / nl, n[2] / nl];
      const cx = (a.wp[0] + b.wp[0] + c.wp[0] + d.wp[0]) / 4;
      const cy = (a.wp[1] + b.wp[1] + c.wp[1] + d.wp[1]) / 4;
      const cz = (a.wp[2] + b.wp[2] + c.wp[2] + d.wp[2]) / 4;
      const vx = CAM[0] - cx, vy = CAM[1] - cy, vz = CAM[2] - cz;
      const vl = Math.hypot(vx, vy, vz) || 1;
      if ((n[0] * vx + n[1] * vy + n[2] * vz) / vl <= -0.1) continue;
      quads.push({ pts: [a.pr, b.pr, c.pr, d.pr], n, depth: (a.pr[2] + b.pr[2] + c.pr[2] + d.pr[2]) / 4 });
    }
  }

  quads.sort((p, q) => q.depth - p.depth);
  ctx.lineWidth = 1;
  for (const q of quads) {
    const col = goldShade(q.n);
    ctx.beginPath();
    q.pts.forEach((p, i) => { if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); });
    ctx.closePath();
    ctx.fillStyle = col; ctx.strokeStyle = col;
    ctx.fill(); ctx.stroke();
  }

  for (const { m, cF } of vis) {
    const uw = mv(R, m.f.u), vw = mv(R, m.f.v);
    const P = (a, b) => {
      a *= SZ; b *= SZ;
      return proj(cF[0] + uw[0] * a + vw[0] * b, cF[1] + uw[1] * a + vw[1] * b, cF[2] + uw[2] * a + vw[2] * b);
    };
    const c = P(0, 0), pu = P(1, 0), pv = P(0, 1);
    const cs = [P(-INNER, -INNER), P(INNER, -INNER), P(INNER, INNER), P(-INNER, INNER)];

    ctx.save();
    ctx.beginPath();
    cs.forEach((p, i) => { if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); });
    ctx.closePath(); ctx.clip();
    ctx.transform(pu[0] - c[0], pu[1] - c[1], pv[0] - c[0], pv[1] - c[1], c[0], c[1]);

    const sg = ctx.createLinearGradient(-0.4, -0.4, 0.4, 0.4);
    sg.addColorStop(0, 'rgba(255,238,175,.16)'); sg.addColorStop(0.5, 'rgba(255,255,255,0)'); sg.addColorStop(1, 'rgba(60,28,0,.2)');
    ctx.fillStyle = sg; ctx.fillRect(-0.5, -0.5, 1, 1);

    for (const [px0, py0] of PIPS[m.f.val]) {
      const x = px0 * 0.27, y = py0 * 0.27;
      ctx.fillStyle = 'rgba(255,225,140,.5)';
      ctx.beginPath(); ctx.arc(x + 0.012, y + 0.015, 0.106, 0, TAU); ctx.fill();
      const pg = ctx.createRadialGradient(x - 0.03, y - 0.03, 0.01, x, y, 0.1);
      pg.addColorStop(0, '#040405'); pg.addColorStop(0.7, '#101013'); pg.addColorStop(1, '#3d3d42');
      ctx.fillStyle = pg;
      ctx.beginPath(); ctx.arc(x, y, 0.097, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.65)'; ctx.lineWidth = 0.014;
      ctx.beginPath(); ctx.arc(x, y, 0.097, Math.PI * 0.75, Math.PI * 1.75); ctx.stroke();
    }
    ctx.restore();
  }
  ctx.restore();
}

function chipStack(ctx, x, y, n, c) {
  const r = 30, ry = 16, th = 5;
  ctx.save();
  ctx.translate(x + 4, y + th + 4); ctx.scale(1, 0.5);
  const sg = ctx.createRadialGradient(0, 0, 2, 0, 0, r * 1.3);
  sg.addColorStop(0, 'rgba(0,0,0,.5)'); sg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = sg; ctx.beginPath(); ctx.arc(0, 0, r * 1.3, 0, TAU); ctx.fill();
  ctx.restore();
  for (let i = 0; i < n; i++) {
    const cy = y - i * th;
    ctx.fillStyle = c.side;
    ctx.beginPath(); ctx.ellipse(x, cy + th, r, ry, 0, 0, TAU); ctx.fill();
    ctx.fillRect(x - r, cy, 2 * r, th);
    ctx.fillStyle = c.dash;
    for (let k = 0; k < 6; k++) {
      const a = k * TAU / 6 + 0.25;
      if (Math.sin(a) > 0.15) ctx.fillRect(x + Math.cos(a) * r - 2.5, cy + 1, 5, th - 1.5);
    }
    ctx.fillStyle = c.top;
    ctx.beginPath(); ctx.ellipse(x, cy, r, ry, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = c.dash; ctx.lineWidth = 5;
    for (let k = 0; k < 6; k++) {
      ctx.beginPath(); ctx.ellipse(x, cy, r * 0.92, ry * 0.92, 0, k * TAU / 6, k * TAU / 6 + 0.5); ctx.stroke();
    }
    if (i === n - 1) {
      ctx.strokeStyle = c.dash; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.7;
      ctx.beginPath(); ctx.ellipse(x, cy, r * 0.6, ry * 0.6, 0, 0, TAU); ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
}

function glintStar(ctx, x, y, r, a) {
  ctx.save(); ctx.translate(x, y); ctx.globalAlpha = a;
  ctx.fillStyle = '#ffe9a6'; ctx.shadowColor = '#ffd36b'; ctx.shadowBlur = 10;
  ctx.beginPath();
  ctx.moveTo(0, -r); ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.quadraticCurveTo(0, 0, 0, r); ctx.quadraticCurveTo(0, 0, -r, 0);
  ctx.quadraticCurveTo(0, 0, 0, -r); ctx.fill();
  ctx.restore();
}

function dieState(d, t, hop = 0) {
  let tl = Math.max(0, t - d.t0);
  if (d.slow && tl > d.slow.from) {
    const x = clamp((tl - d.slow.from) / d.slow.real);
    tl = d.slow.from + (d.end - d.slow.from) * (1 - Math.pow(1 - x, d.slow.n));
  }
  const p = clamp(tl / d.end);

  let h = 0;
  for (const sg of d.segs) {
    if (p >= sg.a && p <= sg.b) {
      const u = (p - sg.a) / (sg.b - sg.a);
      h = sg.h0 * (1 - u) + sg.peak * 4 * u * (1 - u);
      break;
    }
  }

  const q = 1 - Math.pow(1 - p, 1.5);
  const m = p < d.pe ? Math.pow(1 - p / d.pe, 2.2) : 0;
  const R = mm(rot(d.a1, d.th1 * m), mm(rot(d.a2, d.th2 * m), d.Qf));

  const ext = (INNER * (Math.abs(R[3]) + Math.abs(R[4]) + Math.abs(R[5])) + RAD) * SZ;
  const x = lerp(d.sx, d.ex, q), z = lerp(d.sz, d.ez, q);
  const y = Math.max(0.5 * SZ + h * SZ + hop, ext + hop);
  const sc = proj(x, y, z);
  return { R, pos: [x, y, z], p, depth: sc[2], sx: sc[0], sy: sc[1], k: sc[3] };
}

function makeFx(s) {
  const rng = mulberry32(s.seed);
  s.glints = s.outcome !== 'big' ? [] : Array.from({ length: 26 }, () => ({
    x: CX + (rng() - 0.5) * 420, y: DY + (rng() - 0.5) * 320, r: 6 + rng() * 9, t0: rng() * 1.8
  }));
}

function drawFrame(ctx, t, s) {
  const endAll = s.endAll;
  const tr = t - endAll, landed = tr >= 0, trp = Math.max(0, tr);
  const inten = s.suspense ? clamp((t - s.susStart) / (endAll - s.susStart)) : 0;
  const shake = s.outcome === 'lose' && landed && trp < 0.4 ? Math.sin(trp * 70) * 4 * (1 - trp / 0.4) : 0;
  let zoom = 1;
  if (s.suspense) {
    const z = landed ? 0.06 * (1 - clamp(trp / 0.8)) : 0.06 * inten * inten;
    zoom = 1 + z + (landed ? 0 : 0.005 * inten * Math.sin(t * (4 + 6 * inten)));
  }
  const hop = (s.outcome === 'win' || s.outcome === 'big') && landed
    ? Math.abs(Math.sin(trp * 9)) * (s.outcome === 'big' ? 0.4 : 0.25) * Math.exp(-trp * 2.4) : 0;

  ctx.fillStyle = '#06180f'; ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.translate(CX + shake, DY); ctx.scale(zoom, zoom); ctx.translate(-CX, -DY);
  ctx.drawImage(getBg(), 0, 0);

  if (landed && s.outcome !== 'lose') {
    const a = clamp(trp / 0.5) * (0.6 + 0.4 * Math.sin(trp * 4));
    const big = s.outcome === 'big';
    const g = ctx.createRadialGradient(CX, DY, 20, CX, DY, big ? 360 : 280);
    g.addColorStop(0, `rgba(255,214,120,${(big ? 0.3 : 0.18) * a})`); g.addColorStop(1, 'rgba(255,214,120,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }

  const states = s.d.map((d) => dieState(d, t, hop));
  const order = states.map((st, i) => i).sort((a, b) => states[b].depth - states[a].depth);

  for (const i of order) drawDieShadow(ctx, states[i]);

  for (const i of order) {
    const d = s.d[i], st = states[i];
    if (t < d.tEnd && st.p < 0.7 && t > d.t0) {
      for (let k = 2; k >= 1; k--) {
        const tt = t - k * 0.03;
        if (tt <= d.t0) continue;
        drawDie3D(ctx, dieState(d, tt, 0), false, 0.1);
      }
    }
    const glow = landed ? s.outcome !== 'lose' : (s.suspense && t >= d.tEnd && d.hit);
    drawDie3D(ctx, st, glow);
  }

  if (landed) {
    stext(ctx, `TOTAL  ${s.suma}`, CX, 312, { size: 17, color: '#f2efe6', spacing: 5, font: SERIF, alpha: clamp(trp / 0.5), shadow: '#000' });
  }

  const betX = CX - 72, payX = CX + 72, cy0 = 490;
  if (!landed) {
    chipStack(ctx, betX, cy0, 4, BET_CHIP);
  } else if (s.outcome === 'lose') {
    const q = clamp((trp - 0.4) / 0.8);
    chipStack(ctx, betX + q * q * 340, cy0 - q * q * 150, 4, BET_CHIP);
  } else {
    const q = easeOutCubic(clamp((trp - 0.3) / 0.6));
    const c = clamp((trp - 1.5) / 0.8);
    const dy = c * c * 230;
    chipStack(ctx, betX, cy0 + dy, 4, BET_CHIP);
    if (trp > 0.3) chipStack(ctx, payX + (1 - q) * 280, cy0 + dy, s.payChips, PAY_CHIP);
  }

  for (const g of s.glints) {
    if (!landed || trp < g.t0) continue;
    const ph = (trp - g.t0) % 1.2;
    glintStar(ctx, g.x, g.y, g.r, Math.sin(Math.PI * ph / 1.2));
  }
  ctx.restore();

  if (!landed && s.suspense && t > s.susStart) {
    const idx = s.d.findIndex((d) => t < d.tEnd);
    if (idx >= 0) {
      const st = states[idx];
      const g = ctx.createRadialGradient(st.sx, st.sy, 40, st.sx, st.sy, lerp(300, 150, inten));
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${0.78 * inten})`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
  }
  if (landed && s.suspense) {
    const a = 0.78 * (1 - clamp(trp / 0.6));
    if (a > 0) {
      const g = ctx.createRadialGradient(CX, DY, 40, CX, DY, 150);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${a})`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
  }
  if (landed && s.outcome === 'lose') {
    ctx.fillStyle = `rgba(0,0,0,${0.32 * clamp(trp / 0.5)})`; ctx.fillRect(0, 0, W, H);
  }
  if (landed && s.outcome === 'big' && trp < 0.25) {
    ctx.fillStyle = `rgba(255,248,225,${0.55 * (1 - trp / 0.25)})`; ctx.fillRect(0, 0, W, H);
  }

  const lg = ctx.createLinearGradient(0, 520, 0, H);
  lg.addColorStop(0, 'rgba(0,0,0,0)'); lg.addColorStop(1, 'rgba(0,0,0,.78)');
  ctx.fillStyle = lg; ctx.fillRect(0, 520, W, H - 520);

  stext(ctx, 'MESA DE DADOS', CX, 56, { size: 16, color: '#e4c46a', spacing: 7, font: SERIF, shadow: 'rgba(0,0,0,.8)' });

  if (!landed) {
    const dots = '.'.repeat(1 + (Math.floor(t * 3) % 3));
    let top = `LANZANDO${dots}`, sub = s.betLine, col = '#f2efe6';
    if (s.suspense && t >= s.d[0].tEnd) {
      top = s.d[0].hit ? 'UNO LISTO' : `ÚLTIMO DADO${dots}`;
      sub = `¿SERÁ ${s.label}?`; col = '#e4c46a';
    }
    stext(ctx, top, CX, 586, { size: 22, color: col, spacing: 6, font: SERIF });
    stext(ctx, sub, CX, 617, { size: 14, color: '#b9c9bf', spacing: 2, weight: 'normal' });
  } else {
    const a = clamp(trp / 0.5);
    const rise = (1 - easeOutCubic(a)) * 14;
    const pal = { big: '#f5d77a', win: '#e4c46a', lose: '#c9c9c9' }[s.outcome];
    stext(ctx, s.title, CX + shake, 584 + rise, { size: s.outcome === 'big' ? 30 : 28, color: pal, spacing: 7, font: SERIF, alpha: a, shadow: s.outcome === 'lose' ? undefined : 'rgba(228,196,106,.6)' });
    stext(ctx, s.sub, CX, 616 + rise, { size: 18, color: s.outcome === 'lose' ? '#d98a8a' : '#f2efe6', spacing: 2, alpha: a });
  }
}

function buildSegs(h0, peak) {
  const raw = [{ h0, peak, w: 2 * Math.sqrt(h0 + peak) }];
  for (const pk of [0.9, 0.4, 0.17, 0.06]) raw.push({ h0: 0, peak: pk, w: 2 * Math.sqrt(pk) });
  const total = raw.reduce((a, r) => a + r.w, 0);
  let acc = 0;
  return raw.map((r) => {
    const a = acc / total; acc += r.w;
    return { a, b: acc / total, h0: r.h0, peak: r.peak };
  });
}

async function renderDiceVideo({ dice, eleccion, amount, outcome, net, multiplier, suma }) {
  const rng = mulberry32((Date.now() % 100000) + dice[0] * 7 + dice[1] * 13);
  const suspense = eleccion === 'snake' || eleccion === 'boxcars';
  const target = eleccion === 'snake' ? 1 : 6;

  let [a, b] = dice;
  if (suspense && b === target && a !== target) [a, b] = [b, a];

  const mk = (i, final) => {
    const sx = i ? 0.7 : -0.7, sz = i ? 4.0 : 4.4;
    const ex = (i ? 1 : -1) * (0.7 + rng() * 0.12), ez = -0.6 + (rng() - 0.5) * 0.4;
    const tx = ex - sx, tz = ez - sz, l = Math.hypot(tx, tz);
    const a2 = [rng() - 0.5, rng() - 0.5, rng() - 0.5];
    const Qf = mm(rot([0, 1, 0], rng() * TAU), alignUp(NORMAL_OF[final]));
    const d = {
      sx, sz, ex, ez, Qf, a1: [tz / l, 0, -tx / l], a2,
      th1: TAU * (2 + rng() * 1.2), th2: TAU * (0.5 + rng() * 0.6),
      segs: buildSegs(0.8 + rng() * 0.5, 1.5 + rng() * 0.8), hit: final === target
    };
    if (!suspense) {
      d.t0 = i ? 0.05 : 0; d.end = i ? 1.7 : 1.4; d.pe = 0.8; d.tEnd = d.t0 + d.end;
    } else if (i === 0) {
      d.t0 = 0; d.end = 1.9; d.pe = 0.82; d.tEnd = 1.9;
    } else {
      d.t0 = 0.3; d.end = 2.0; d.pe = 0.9;
      d.slow = { from: 1.2, real: 2.0, n: 2.0 / 0.8 };
      d.tEnd = d.t0 + d.slow.from + d.slow.real;
    }
    return d;
  };

  const label = LABELS[eleccion];
  const ds = [mk(0, a), mk(1, b)];
  const s = {
    d: ds, outcome, suspense, suma, label,
    endAll: Math.max(ds[0].tEnd, ds[1].tEnd), susStart: suspense ? 1.5 : 0,
    seed: dice[0] * 10 + dice[1] + 5,
    payChips: Math.min(10, 3 + multiplier),
    betLine: `¥${amount.toLocaleString()}  ·  ${label}`,
    title: outcome === 'big' ? (eleccion === 'snake' ? 'SNAKE EYES' : 'BOXCARS') : outcome === 'win' ? 'GANASTE' : 'PERDISTE',
    sub: outcome === 'lose' ? `-¥${amount.toLocaleString()}` : `+¥${net.toLocaleString()}   (x${multiplier})`
  };
  makeFx(s);

  const out = join(tmpdir(), `dice-${randomUUID()}.mp4`);
  const ff = spawn(ffmpegInstaller.path, ['-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-',
    '-an', '-c:v', 'libx264', '-profile:v', 'baseline', '-level', '3.0', '-preset', 'veryfast', '-crf', '22',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  ff.stderr.on('data', (c) => { err += c; });
  ff.stdin.on('error', () => {});
  const done = new Promise((res, rej) => {
    ff.on('error', rej);
    ff.on('close', (code) => code === 0 ? res() : rej(new Error(`ffmpeg ${code}: ${err.slice(-300)}`)));
  });

  const canvas = createCanvas(W, H), ctx = canvas.getContext('2d');
  const total = Math.round((s.endAll + RESULT_T) * FPS);
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
    return { buffer: await readFile(out), ms: Math.round((s.endAll + RESULT_T) * 1000) };
  } finally {
    ff.kill('SIGKILL');
    unlink(out).catch(() => {});
  }
}

function formatTime(ms) {
  if (ms <= 0 || isNaN(ms)) return 'Ahora';
  const totalSec = Math.ceil(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  const partes = [];
  if (min) partes.push(`${min} min`);
  partes.push(`${sec} seg`);
  return partes.join(' ');
}

export default {
  command: ['dice', 'dados'],
  category: 'economy',
  description: 'Apostar coins en la mesa de dados.',
  run: async ({ msg, sock, args, usedPrefix, command }) => {
    const chatId = msg.chat;
    const senderId = msg.sender;
    const chatData = db.getChat(chatId);

    if (chatData?.adminonly || !chatData?.economy) {
      return msg.reply(`ꕥ Los comandos de *Economía* están desactivados en este grupo.\n\nUn *administrador* puede activarlos con el comando:\n» *${usedPrefix}economy on*`);
    }

    db.setCreate('chat_users', [chatId, senderId], 'lastDice', 0);

    let user = db.getChatUser(chatId, senderId) || {};
    const userCoins = user.coins || 0;

    const tiempoEspera = 30 * 1000;
    const ahora = Date.now();

    if (user.lastDice && ahora - user.lastDice < tiempoEspera) {
      const restante = user.lastDice + tiempoEspera - ahora;
      return msg.reply(`ꕥ Debes esperar *${formatTime(restante)}* para volver a tirar los dados.`);
    }

    if (!args[0] || !args[1]) {
      return msg.reply(`ꕥ Uso correcto del comando:\n> *${usedPrefix + command} <monto> <opcion>*\n\n✦ ┊ 𝙾𝚙𝚌𝚒𝚘𝚗𝚎𝚜 𝚍𝚎 𝚊𝚙𝚞𝚎𝚜𝚝𝚊:\n> ◈ *<7* » Menor a 7 (x2)\n> ◈ *>7* » Mayor a 7 (x2)\n> ◈ *7* » Siete exacto (x5)\n> ◈ *snake* » Par de unos [1-1] (x10)\n> ◈ *boxcars* » Par de seises [6-6] (x12)\n\n*Ejemplo:* ${usedPrefix + command} 500 >7`);
    }

    const apuesta = /^(all|todo)$/i.test(args[0]) ? userCoins : parseInt(args[0]);

    if (isNaN(apuesta) || apuesta <= 0) {
      return msg.reply(`ꕥ Ingresa un monto válido para apostar.`);
    }

    if (userCoins < apuesta) {
      return msg.reply(`ꕥ No tienes suficiente saldo en tu cartera. Tienes *¥${userCoins.toLocaleString()}*.`);
    }

    const eleccion = args[1].toLowerCase();
    if (!['<7', '>7', '7', 'snake', 'boxcars'].includes(eleccion)) {
      return msg.reply(`ꕥ Opción no válida. Elige entre: *<7*, *>7*, *7*, *snake*, *boxcars*.`);
    }

    db.updateChatUser(chatId, senderId, 'lastDice', ahora);

    const dado1 = Math.floor(Math.random() * 6) + 1;
    const dado2 = Math.floor(Math.random() * 6) + 1;
    const suma = dado1 + dado2;

    const dadosEmojis = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
    const emoji1 = dadosEmojis[dado1 - 1];
    const emoji2 = dadosEmojis[dado2 - 1];

    let multiplicador = 0;
    if (eleccion === '<7' && suma < 7) multiplicador = 2;
    else if (eleccion === '>7' && suma > 7) multiplicador = 2;
    else if (eleccion === '7' && suma === 7) multiplicador = 5;
    else if (eleccion === 'snake' && dado1 === 1 && dado2 === 1) multiplicador = 10;
    else if (eleccion === 'boxcars' && dado1 === 6 && dado2 === 6) multiplicador = 12;

    const gano = multiplicador > 0;
    const big = gano && (eleccion === 'snake' || eleccion === 'boxcars');
    const outcome = big ? 'big' : gano ? 'win' : 'lose';
    const net = gano ? apuesta * (multiplicador - 1) : 0;

    user = db.getChatUser(chatId, senderId) || {};
    const freshCoins = user.coins || 0;
    if (freshCoins < apuesta) {
      return msg.reply(`ꕥ No tienes suficiente saldo en tu cartera. Tienes *¥${freshCoins.toLocaleString()}*.`);
    }

    const nuevoSaldo = gano ? freshCoins + net : Math.max(0, freshCoins - apuesta);
    db.updateChatUser(chatId, senderId, 'coins', nuevoSaldo);

    const resultadoTexto = big
      ? `✦ ┊ 𝚁𝚎𝚜𝚞𝚕𝚝𝚊𝚍𝚘 » *¡¡${eleccion === 'snake' ? 'SNAKE EYES' : 'BOXCARS'}!!* (x${multiplicador})\n> Combinación legendaria en la mesa.\n> ◈ Ganancia » *+¥${net.toLocaleString()}*`
      : gano
        ? `✦ ┊ 𝚁𝚎𝚜𝚞𝚕𝚝𝚊𝚍𝚘 » *¡VICTORIA!* (x${multiplicador})\n> Has acertado tu pronóstico en la mesa.\n> ◈ Ganancia » *+¥${net.toLocaleString()}*`
        : `✦ ┊ 𝚁𝚎𝚜𝚞𝚕𝚝𝚊𝚍𝚘 » *DERROTA*\n> La combinación no coincidió con tu apuesta.\n> ◈ Pérdida » *-¥${apuesta.toLocaleString()}*`;

    const finalText = `─── ❖ 𝙼𝙴𝚂𝙰 𝙳𝙴 𝙳𝙰𝙳𝙾𝚂 ❖ ───

✦ ┊ 𝙹𝚞𝚐𝚊𝚍𝚊
> ◈ Dados » \`\`\`[ ${emoji1} ${emoji2} ] =${suma}\`\`\`
> ◈ Tu apuesta » \`\`\`${eleccion.toUpperCase()}\`\`\`

${resultadoTexto}

───────────────
❖ Saldo en cuenta » *¥${nuevoSaldo.toLocaleString()}*`;

    const rollingCaption = `─── ❖ 𝙼𝙴𝚂𝙰 𝙳𝙴 𝙳𝙰𝙳𝙾𝚂 ❖ ───

🎲 _Los dados ruedan por la mesa..._

❖ Apuesta » *¥${apuesta.toLocaleString()}*
❖ Elección » *${LABELS[eleccion]}*`;

    let sent, ms;
    try {
      const video = await renderDiceVideo({ dice: [dado1, dado2], eleccion, amount: apuesta, outcome, net, multiplier: multiplicador, suma });
      ms = video.ms;
      sent = await sock.sendMessage(chatId, {
        video: video.buffer, mimetype: 'video/mp4', gifPlayback: true, caption: rollingCaption
      }, { quoted: msg });
    } catch (e) {
      console.error('[dice] error animación:', e);
      return sock.sendMessage(chatId, { text: finalText }, { quoted: msg });
    }

    await delay(ms + 800);
    try {
      await sock.sendMessage(chatId, { caption: finalText, edit: sent.key });
    } catch (e) {
      console.error('[dice] no se pudo editar, enviando mensaje nuevo:', e);
      await sock.sendMessage(chatId, { text: finalText }, { quoted: msg });
    }
  }
};