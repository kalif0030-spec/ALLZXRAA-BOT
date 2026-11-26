'use strict';

// Kartu gambar PNG untuk welcome, goodbye, level, dan leaderboard.
// Pakai @napi-rs/canvas (binary prebuilt, tanpa dependency sistem). Kalau paketnya belum
// terpasang, isAvailable() bernilai false dan index.js jatuh ke embed lama.
//
// Font: taruh file .ttf di ./assets/font.ttf. Tanpa file itu dipakai 'sans-serif' sistem,
// dan di host yang tidak punya font, huruf akan jadi kotak kosong.

const fs = require('node:fs');
const path = require('node:path');

let napi = null;
try {
  napi = require('@napi-rs/canvas');
} catch {
  napi = null;
}

const FONT_FILE = path.join(__dirname, 'font.ttf');
const FONT_FAMILY = 'CardFont';
let fontReady = false;
if (napi && fs.existsSync(FONT_FILE)) {
  try {
    napi.GlobalFonts.registerFromPath(FONT_FILE, FONT_FAMILY);
    fontReady = true;
  } catch {
    fontReady = false;
  }
}

const AVATAR_TIMEOUT_MS = 5000;
const MAX_AVATAR_BYTES = 4 * 1024 * 1024;

// Teks kartu welcome dan goodbye: ubah di sini kalau mau bahasa lain.
const EVENT_TEXT = Object.freeze({
  welcomeTitle: (name) => `${name} has logged into the server!`,
  welcomeSub: (count) => `We are now ${formatNumber(count)} members`,
  goodbyeTitle: (name) => `${name} left the server`,
  goodbyeSub: (count) => `Now we are ${formatNumber(count)} members`,
});

const GOLD = '#fee75c';
const MEDAL_COLORS = ['#f5c542', '#c0c7d1', '#cd7f32'];

// ============ fungsi murni (bisa dicek tanpa canvas) ============
function formatNumber(n) {
  return Number.isFinite(n) ? Math.trunc(n).toLocaleString('en-US') : '0';
}

function clamp01(v) {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

function isAvailable() {
  return napi !== null;
}

// ============ helper gambar ============
function font(weight, px) {
  return `${weight} ${px}px ${fontReady ? `"${FONT_FAMILY}", ` : ''}sans-serif`;
}

function fitText(ctx, text, maxWidth) {
  const s = String(text ?? '');
  if (ctx.measureText(s).width <= maxWidth) return s;
  let t = s;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

async function loadAvatar(url) {
  if (!napi || typeof url !== 'string' || !url.startsWith('https://')) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(AVATAR_TIMEOUT_MS) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_AVATAR_BYTES) return null;
    return await napi.loadImage(buf);
  } catch {
    return null; // avatar gagal dimuat: kartu tetap jadi, pakai lingkaran inisial
  }
}

function drawAvatar(ctx, img, cx, cy, r, ringWidth, ringColor, label) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r + ringWidth, 0, Math.PI * 2);
  ctx.fillStyle = ringColor;
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (img) {
    ctx.drawImage(img, cx - r, cy - r, r * 2, r * 2);
  } else {
    ctx.fillStyle = '#4752c4';
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.fillStyle = '#ffffff';
    ctx.font = font('bold', Math.round(r * 0.9));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(label ?? '?').slice(0, 1).toUpperCase(), cx, cy);
  }
  ctx.restore();
}

function drawGlowLine(ctx, x0, y0, x1, y1) {
  ctx.save();
  ctx.strokeStyle = '#4d94ff';
  ctx.lineWidth = 3;
  ctx.shadowColor = '#2f7bff';
  ctx.shadowBlur = 14;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.restore();
}

// Latar biru gelap bergaya "tech": gradasi, cahaya tengah, dan garis neon di tepi kiri dan kanan.
function drawTechBackground(ctx, w, h) {
  const base = ctx.createLinearGradient(0, 0, 0, h);
  base.addColorStop(0, '#020817');
  base.addColorStop(0.5, '#08246f');
  base.addColorStop(1, '#020817');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);

  const glow = ctx.createRadialGradient(w / 2, h * 0.45, 10, w / 2, h * 0.45, w * 0.55);
  glow.addColorStop(0, 'rgba(40, 110, 255, 0.35)');
  glow.addColorStop(1, 'rgba(40, 110, 255, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  const mid = h * 0.52;
  drawGlowLine(ctx, 0, mid, w * 0.2, mid);
  drawGlowLine(ctx, w * 0.8, mid, w, mid);
  drawGlowLine(ctx, 0, h * 0.18, w * 0.08, h * 0.18);
  drawGlowLine(ctx, w * 0.92, h * 0.82, w, h * 0.82);

  ctx.save();
  ctx.strokeStyle = 'rgba(77, 148, 255, 0.45)';
  ctx.lineWidth = 2;
  roundRectPath(ctx, 6, 6, w - 12, h - 12, 26);
  ctx.stroke();
  ctx.restore();
}

function drawBar(ctx, x, y, w, h, ratio, fillFrom, fillTo) {
  ctx.save();
  roundRectPath(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
  ctx.fill();
  const r = clamp01(ratio);
  if (r > 0) {
    const fw = Math.max(h, w * r);
    const g = ctx.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0, fillFrom);
    g.addColorStop(1, fillTo);
    roundRectPath(ctx, x, y, fw, h, h / 2);
    ctx.fillStyle = g;
    ctx.fill();
  }
  ctx.restore();
}

// ============ kartu welcome / goodbye ============
async function renderEventCard({ avatarUrl, name, title, subtitle }) {
  const W = 1000;
  const H = 450;
  const canvas = napi.createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  drawTechBackground(ctx, W, H);

  const img = await loadAvatar(avatarUrl);
  drawAvatar(ctx, img, W / 2, H * 0.37, 100, 7, '#ffffff', name);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#ffffff';
  ctx.font = font('bold', 38);
  ctx.fillText(fitText(ctx, title, W * 0.9), W / 2, H * 0.78);
  ctx.fillStyle = '#b8c7ff';
  ctx.font = font('normal', 26);
  ctx.fillText(fitText(ctx, subtitle, W * 0.9), W / 2, H * 0.88);
  return canvas.encode('png');
}

function renderWelcomeCard({ avatarUrl, name, memberCount }) {
  return renderEventCard({
    avatarUrl, name,
    title: EVENT_TEXT.welcomeTitle(name),
    subtitle: EVENT_TEXT.welcomeSub(memberCount),
  });
}

function renderGoodbyeCard({ avatarUrl, name, memberCount }) {
  return renderEventCard({
    avatarUrl, name,
    title: EVENT_TEXT.goodbyeTitle(name),
    subtitle: EVENT_TEXT.goodbyeSub(memberCount),
  });
}

// ============ kartu level ============
// data: { avatarUrl, name, level, rank (0 = belum ada), xp, into, span, ratio }
async function renderLevelCard(data) {
  const W = 934;
  const H = 300;
  const canvas = napi.createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#0b1230');
  bg.addColorStop(1, '#0f2a6b');
  roundRectPath(ctx, 0, 0, W, H, 28);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.save();
  ctx.strokeStyle = 'rgba(77, 148, 255, 0.5)';
  ctx.lineWidth = 2;
  roundRectPath(ctx, 3, 3, W - 6, H - 6, 26);
  ctx.stroke();
  ctx.restore();

  const img = await loadAvatar(data.avatarUrl);
  drawAvatar(ctx, img, 150, H / 2, 85, 6, '#ffffff', data.name);

  const left = 280;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#ffffff';
  ctx.font = font('bold', 40);
  ctx.fillText(fitText(ctx, data.name, W - left - 40), left, 95);

  ctx.font = font('bold', 30);
  ctx.fillStyle = '#b8c7ff';
  const rankText = data.rank > 0 ? `RANK #${data.rank}` : 'RANK -';
  ctx.fillText(rankText, left, 145);
  const rankWidth = ctx.measureText(rankText).width;
  ctx.fillStyle = GOLD;
  ctx.fillText(`LEVEL ${data.level}`, left + rankWidth + 40, 145);

  ctx.font = font('normal', 22);
  ctx.fillStyle = '#b8c7ff';
  ctx.textAlign = 'left';
  ctx.fillText(`Total ${formatNumber(data.xp)} XP`, left, 200);
  ctx.textAlign = 'right';
  ctx.fillText(
    Number.isFinite(data.span) && data.span > 0
      ? `${formatNumber(data.into)} / ${formatNumber(data.span)} XP`
      : 'MAX',
    W - 40, 200,
  );

  drawBar(ctx, left, 215, W - left - 40, 34, data.ratio, '#3d8bff', '#8fd0ff');
  return canvas.encode('png');
}

// ============ kartu leaderboard ============
// rows: [{ name, avatarUrl, level, xp, ratio }] sudah terurut
async function renderLeaderboardCard({ guildName, rows }) {
  const W = 900;
  const ROW_STEP = 84;
  const HEADER = 140;
  const count = Math.max(1, rows.length);
  const H = HEADER + count * ROW_STEP + 20;
  const canvas = napi.createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  drawTechBackground(ctx, W, H);

  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#ffffff';
  ctx.font = font('bold', 42);
  ctx.fillText(fitText(ctx, guildName, W - 80), 40, 70);
  ctx.fillStyle = '#b8c7ff';
  ctx.font = font('normal', 22);
  ctx.fillText('Leaderboard level', 40, 102);

  if (rows.length === 0) {
    ctx.font = font('normal', 26);
    ctx.fillStyle = '#ffffff';
    ctx.fillText('Belum ada yang dapat XP.', 40, HEADER + 50);
    return canvas.encode('png');
  }

  const avatars = await Promise.all(rows.map((r) => loadAvatar(r.avatarUrl)));
  rows.forEach((r, i) => {
    const y = HEADER + i * ROW_STEP;
    roundRectPath(ctx, 30, y, W - 60, 72, 18);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(70, y + 36, 22, 0, Math.PI * 2);
    ctx.fillStyle = MEDAL_COLORS[i] || '#2b3a67';
    ctx.fill();
    ctx.fillStyle = i < 3 ? '#1a1a1a' : '#ffffff';
    ctx.font = font('bold', 22);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), 70, y + 37);

    drawAvatar(ctx, avatars[i], 135, y + 36, 26, 3, '#ffffff', r.name);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#ffffff';
    ctx.font = font('bold', 24);
    ctx.fillText(fitText(ctx, r.name, 400), 185, y + 32);
    drawBar(ctx, 185, y + 44, 340, 10, r.ratio, '#3d8bff', '#8fd0ff');

    ctx.textAlign = 'right';
    ctx.fillStyle = GOLD;
    ctx.font = font('bold', 26);
    ctx.fillText(`LVL ${r.level}`, W - 55, y + 33);
    ctx.fillStyle = '#b8c7ff';
    ctx.font = font('normal', 18);
    ctx.fillText(`${formatNumber(r.xp)} XP`, W - 55, y + 58);
  });
  return canvas.encode('png');
}

// ============ kartu info (dipakai untuk balasan bot yang belum punya gambar) ============
// title: teks utama. subtitle: teks kedua (boleh kosong). Gaya sama dengan kartu welcome.
async function renderInfoCard({ title, subtitle }) {
  const W = 1000;
  const H = 380;
  const canvas = napi.createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  drawTechBackground(ctx, W, H);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#ffffff';
  ctx.font = font('bold', 40);
  ctx.fillText(fitText(ctx, title || 'ALLZXRAA', W * 0.9), W / 2, H * 0.52);
  if (subtitle) {
    ctx.fillStyle = '#b8c7ff';
    ctx.font = font('normal', 26);
    ctx.fillText(fitText(ctx, subtitle, W * 0.9), W / 2, H * 0.66);
  }
  return canvas.encode('png');
}

module.exports = {
  isAvailable,
  renderWelcomeCard,
  renderGoodbyeCard,
  renderLevelCard,
  renderLeaderboardCard,
  renderInfoCard,
  formatNumber,
  clamp01,
};
