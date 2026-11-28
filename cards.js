'use strict';

// Kartu gambar untuk welcome, goodbye, level, leaderboard, obfuscate, dan info.
// Bergaya banner: latarnya frame banner.gif, jadi kartu keluar sebagai GIF animasi (lihat animate.js).
// Hanya bot level dan obfu yang membuat GIF; bot lain (dan kalau ffmpeg atau banner.gif tidak ada) kartu keluar
// sebagai PNG statis dengan latar assets/banner.png (atau laut gambar sendiri kalau file itu tidak ada).
// Pakai @napi-rs/canvas (binary prebuilt, tanpa dependency sistem). Kalau paketnya belum
// terpasang, isAvailable() bernilai false dan index.js jatuh ke embed lama.
//
// Font: taruh file .ttf di ./font.ttf (folder bot, sejajar index.js). Tanpa file itu dipakai 'sans-serif' sistem,
// dan di host yang tidak punya font, huruf akan jadi kotak kosong.

const fs = require('node:fs');
const path = require('node:path');
const animate = require('./animate');

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

// ============ latar bergaya banner.gif (laut biru) ============
// Mode animasi: kanvas kartu hanya berisi lapisan (scrim, panel, teks, avatar) dengan alpha,
// lalu animate.js menumpuknya di atas frame banner.gif.
// Mode statis: dasar laut digambar dulu di kanvas yang sama. Acaknya pakai seed tetap.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Latar kartu statis: assets/banner.png (cover-crop sama seperti filter ffmpeg: ke tengah, agak condong ke atas).
// Dimuat sekali di belakang layar; selama belum siap atau file tidak ada, dipakai laut gambar sendiri.
const BANNER_PNG = process.env.CARD_BANNER_PNG || path.join(__dirname, 'assets', 'banner.png');
let bannerImage = null;
if (napi && typeof napi.loadImage === 'function' && fs.existsSync(BANNER_PNG)) {
  napi.loadImage(BANNER_PNG).then((img) => { bannerImage = img; }).catch(() => { bannerImage = null; });
}

function drawStaticBackground(ctx, w, h) {
  const iw = bannerImage && bannerImage.width;
  const ih = bannerImage && bannerImage.height;
  if (!(iw > 0 && ih > 0)) { drawStaticSea(ctx, w, h); return; }
  const scale = Math.max(w / iw, h / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  ctx.drawImage(bannerImage, (w - dw) / 2, -(dh - h) * 0.25, dw, dh);
}

function drawStaticSea(ctx, w, h) {
  const rand = mulberry32(0x51ea5eed);
  const base = ctx.createLinearGradient(0, 0, 0, h);
  base.addColorStop(0, '#2d6fd0');
  base.addColorStop(0.55, '#1b4aa6');
  base.addColorStop(1, '#0c2a6b');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);

  const light = ctx.createRadialGradient(w * 0.72, h * 0.1, 0, w * 0.72, h * 0.1, w * 0.6);
  light.addColorStop(0, 'rgba(170, 220, 255, 0.5)');
  light.addColorStop(1, 'rgba(170, 220, 255, 0)');
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, w, h);

  ctx.lineWidth = 1.5;
  for (let i = 0; i < 40; i++) {
    const x = rand() * w;
    const y = rand() * h;
    const r = rand() * 5 + 1.5;
    ctx.strokeStyle = `rgba(220, 240, 255, ${(0.2 + rand() * 0.4).toFixed(2)})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// Lapisan penggelap supaya teks putih terbaca di atas banner yang terang.
// variant 'left': gelap di kiri (teks rata kiri). 'even': merata (teks di tengah atau selebar kartu).
function drawScrim(ctx, w, h, variant) {
  ctx.save();
  if (variant === 'even') {
    ctx.fillStyle = 'rgba(5, 18, 52, 0.6)';
  } else {
    const g = ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, 'rgba(4, 14, 40, 0.9)');
    g.addColorStop(0.5, 'rgba(6, 24, 66, 0.66)');
    g.addColorStop(1, 'rgba(8, 40, 96, 0.45)');
    ctx.fillStyle = g;
  }
  ctx.fillRect(0, 0, w, h);
  const bottom = ctx.createLinearGradient(0, h * 0.55, 0, h);
  bottom.addColorStop(0, 'rgba(3, 10, 30, 0)');
  bottom.addColorStop(1, 'rgba(3, 10, 30, 0.72)');
  ctx.fillStyle = bottom;
  ctx.fillRect(0, h * 0.55, w, h * 0.45);
  ctx.restore();
}

function beginCard(W, H, variant = 'left') {
  const animated = animate.isReady();
  const canvas = napi.createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  if (!animated) drawStaticBackground(ctx, W, H);
  drawScrim(ctx, W, H, variant);
  return { canvas, ctx, animated };
}

// Mengembalikan Buffer GIF (mode animasi) atau PNG. Pakai cardFileName() untuk nama file yang cocok.
// budgetMs: batas waktu render GIF; terlewati, kartu jatuh ke PNG statis.
async function finishCard({ canvas, animated }, { budgetMs } = {}) {
  const png = await canvas.encode('png');
  if (!animated) return png;
  try {
    return await animate.composeGif(png, canvas.width, canvas.height, { budgetMs });
  } catch (err) {
    console.warn('kartu animasi gagal, pakai PNG statis:', err.message);
    const flat = napi.createCanvas(canvas.width, canvas.height);
    const fctx = flat.getContext('2d');
    drawStaticBackground(fctx, canvas.width, canvas.height);
    fctx.drawImage(canvas, 0, 0);
    return flat.encode('png');
  }
}

// Nama file lampiran mengikuti isi sebenarnya (GIF atau PNG), supaya Discord menampilkannya dengan benar.
function cardFileName(base, buf) {
  return `${base}.${animate.isGif(buf) ? 'gif' : 'png'}`;
}

// Kartu hasil obfuscate: avatar pemohon, status, detail, dan footer "Request by <nama>" dengan centang.
// Centang digambar dengan path, bukan emoji, karena font kartu tidak punya glyph emoji.
// Baseline baris penjelas kartu obfuscate: baris pertama di 170, tiap baris +32.
const OBFU_SUB_TOP = 170;
const OBFU_SUB_LINE = 32;

async function renderObfuCard({ avatarUrl, requester, ok, title, lines, budgetMs }) {
  const W = 934;
  const maxW = W - 280 - 40;
  // Ukur dulu di kanvas kecil, lalu tinggi kartu dihitung dari jumlah baris (tidak ada yang dipotong).
  const probe = napi.createCanvas(W, 10).getContext('2d');
  probe.font = font('normal', 24);
  const subLines = wrapLines(probe, (lines || []).join(' • '), maxW);
  const lastBaseline = OBFU_SUB_TOP + Math.max(0, subLines.length - 1) * OBFU_SUB_LINE;
  const H = Math.max(300, Math.ceil(lastBaseline + 90));
  const card = beginCard(W, H, 'left');
  const { ctx } = card;
  const accent = ok ? '#57f287' : '#ed4245';

  ctx.save();
  ctx.strokeStyle = accent;
  ctx.globalAlpha = 0.6;
  ctx.lineWidth = 2;
  roundRectPath(ctx, 3, 3, W - 6, H - 6, 26);
  ctx.stroke();
  ctx.restore();

  const img = await loadAvatar(avatarUrl);
  drawAvatar(ctx, img, 150, H / 2, 85, 6, accent, requester);

  const left = 280;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  const label = ok ? 'BERHASIL' : 'GAGAL';
  ctx.font = font('bold', 20);
  const pillW = ctx.measureText(label).width + 30;
  ctx.save();
  roundRectPath(ctx, left, 50, pillW, 34, 17);
  ctx.fillStyle = accent;
  ctx.globalAlpha = 0.22;
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = accent;
  ctx.fillText(label, left + 15, 74);

  ctx.fillStyle = '#ffffff';
  ctx.font = font('bold', 40);
  ctx.fillText(fitText(ctx, title || 'Obfuscate', maxW), left, 128);

  ctx.fillStyle = '#c9d6ff';
  ctx.font = font('normal', 24);
  subLines.forEach((line, i) => ctx.fillText(line, left, OBFU_SUB_TOP + i * OBFU_SUB_LINE));

  // footer: centang + Request by <nama>
  const fy = H - 52;
  const cx = left + 14;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, fy, 14, 0, Math.PI * 2);
  ctx.fillStyle = '#3d8bff';
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 3.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - 7, fy + 1);
  ctx.lineTo(cx - 1.5, fy + 7);
  ctx.lineTo(cx + 7.5, fy - 5);
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = '#ffffff';
  ctx.font = font('bold', 26);
  ctx.fillText(fitText(ctx, `Request by ${requester || 'member'}`, maxW - 40), left + 40, fy + 9);

  ctx.fillStyle = '#8fa6d9';
  ctx.font = font('bold', 16);
  ctx.fillText('ALLZXRAA COMMUNITY', left, H - 18);
  return finishCard(card, { budgetMs });
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
async function renderEventCard({ avatarUrl, name, title, subtitle, budgetMs }) {
  const W = 1000;
  const H = 450;
  const card = beginCard(W, H, 'even');
  const { ctx } = card;

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
  return finishCard(card, { budgetMs });
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
  const card = beginCard(W, H, 'left');
  const { ctx } = card;

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
  return finishCard(card, { budgetMs: data.budgetMs });
}

// ============ kartu leaderboard ============
// rows: [{ name, avatarUrl, level, xp, ratio }] sudah terurut
async function renderLeaderboardCard({ guildName, rows, budgetMs }) {
  const W = 900;
  const ROW_STEP = 84;
  const HEADER = 140;
  const count = Math.max(1, rows.length);
  const H = HEADER + count * ROW_STEP + 20;
  const card = beginCard(W, H, 'even');
  const { ctx } = card;

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
    return finishCard(card, { budgetMs });
  }

  const avatars = await Promise.all(rows.map((r) => loadAvatar(r.avatarUrl)));
  rows.forEach((r, i) => {
    const y = HEADER + i * ROW_STEP;
    roundRectPath(ctx, 30, y, W - 60, 72, 18);
    ctx.fillStyle = 'rgba(6, 20, 56, 0.5)';
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
  return finishCard(card, { budgetMs });
}

// ============ kartu info (dipakai untuk balasan bot yang belum punya gambar) ============
// title: judul utama (maks 2 baris). subtitle: penjelas (maks 3 baris). accent: warna aksen hex.
const DEFAULT_ACCENT = '#4d94ff';

// Pecah satu kata yang lebih lebar dari kartu (URL, token) per karakter, supaya tidak terpotong.
function breakWord(ctx, word, maxWidth) {
  const parts = [];
  let cur = '';
  for (const ch of word) {
    const trial = cur + ch;
    if (cur && ctx.measureText(trial).width > maxWidth) {
      parts.push(cur);
      cur = ch;
    } else {
      cur = trial;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

// Pecah teks ke beberapa baris sesuai lebar. maxLines default tak terbatas: tinggi kartu menyesuaikan.
// Hanya kalau maxLines diberi dan terlampaui, baris terakhir dipotong "…".
function wrapLines(ctx, text, maxWidth, maxLines = Infinity) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (ctx.measureText(w).width > maxWidth) {
      if (cur) {
        lines.push(cur);
        cur = '';
      }
      const pieces = breakWord(ctx, w, maxWidth);
      lines.push(...pieces.slice(0, -1));
      cur = pieces[pieces.length - 1];
      continue;
    }
    const trial = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(trial).width <= maxWidth) {
      cur = trial;
    } else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = fitText(ctx, `${kept[maxLines - 1]} ${lines.slice(maxLines).join(' ')}`, maxWidth);
    return kept;
  }
  return lines;
}

// Label status dari warna aksen: merah = GAGAL, kuning/oranye = PERINGATAN, hijau = BERHASIL, lainnya = INFO.
function statusLabel(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  if (r > 180 && g < 110 && b < 110) return 'GAGAL';
  if (r > 180 && g > 140 && b < 120) return 'PERINGATAN';
  if (g > r + 40 && g > b) return 'BERHASIL';
  return 'INFO';
}

function drawAccentGlow(ctx, x, y, r, color) {
  ctx.save();
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, color);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
  ctx.restore();
}

// Layout kartu info: judul baris 1 di y=135 (relatif panel), +60 per baris; penjelas +72 dari judul terakhir, +38 per baris.
const INFO_W = 1000;
const INFO_MIN_H = 400;
const INFO_PANEL_PAD = 30;

async function renderInfoCard({ title, subtitle, accent, budgetMs }) {
  const W = INFO_W;
  const color = /^#[0-9a-fA-F]{6}$/.test(accent || '') ? accent : DEFAULT_ACCENT;
  const maxW = W - 60 - 120;
  // Ukur dulu di kanvas kecil: tinggi kartu mengikuti jumlah baris judul dan penjelas.
  const probe = napi.createCanvas(W, 10).getContext('2d');
  probe.font = font('bold', 50);
  const titleLines = wrapLines(probe, title || 'ALLZXRAA', maxW);
  probe.font = font('normal', 28);
  const subLines = subtitle ? wrapLines(probe, subtitle, maxW) : [];
  const titleLast = INFO_PANEL_PAD + 135 + (titleLines.length - 1) * 60;
  const contentLast = subLines.length > 0 ? titleLast + 72 + (subLines.length - 1) * 38 : titleLast;
  // footer ada di H - 56; harus berada di bawah baris terakhir dengan jarak aman.
  const H = Math.max(INFO_MIN_H, Math.ceil(contentLast + 96));
  const card = beginCard(W, H, 'even');
  const { ctx } = card;
  drawAccentGlow(ctx, W - 80, 60, 320, color);
  drawAccentGlow(ctx, 60, H - 40, 220, color);

  // panel kaca dengan border aksen dan cahaya
  const PX = 30, PY = 30, PW = W - 60, PH = H - 60;
  ctx.save();
  roundRectPath(ctx, PX, PY, PW, PH, 24);
  ctx.fillStyle = 'rgba(8, 18, 45, 0.55)';
  ctx.fill();
  ctx.shadowColor = color;
  ctx.shadowBlur = 22;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.restore();

  // bilah aksen tebal di kiri panel
  ctx.save();
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 16;
  roundRectPath(ctx, PX + 22, PY + 34, 6, PH - 68, 3);
  ctx.fill();
  ctx.restore();

  const left = PX + 60;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // label status (pill) di atas
  const label = statusLabel(color);
  ctx.font = font('bold', 18);
  const pillW = ctx.measureText(label).width + 30;
  ctx.save();
  roundRectPath(ctx, left, PY + 36, pillW, 34, 17);
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.22;
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = color;
  ctx.fillText(label, left + 15, PY + 59);

  // judul
  ctx.fillStyle = '#ffffff';
  ctx.font = font('bold', 50);
  let y = PY + 135;
  titleLines.forEach((line, i) => ctx.fillText(line, left, y + i * 60));
  y += (titleLines.length - 1) * 60;

  // garis pemisah gradasi
  const sep = ctx.createLinearGradient(left, 0, left + maxW, 0);
  sep.addColorStop(0, color);
  sep.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = sep;
  ctx.fillRect(left, y + 28, maxW * 0.7, 2);

  // penjelas
  if (subtitle) {
    ctx.fillStyle = '#c9d6ff';
    ctx.font = font('normal', 28);
    subLines.forEach((line, i) => ctx.fillText(line, left, y + 72 + i * 38));
  }

  // footer
  ctx.fillStyle = color;
  ctx.font = font('bold', 16);
  ctx.fillText('ALLZXRAA COMMUNITY', left, PY + PH - 26);
  return finishCard(card, { budgetMs });
}

module.exports = {
  isAvailable,
  cardFileName,
  renderWelcomeCard,
  renderGoodbyeCard,
  renderLevelCard,
  renderLeaderboardCard,
  renderInfoCard,
  renderObfuCard,
  wrapLines,
  breakWord,
  formatNumber,
  clamp01,
};
