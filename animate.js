'use strict';

// Kartu animasi bergaya banner: lapisan kartu (panel, teks, avatar) berupa PNG dengan alpha
// ditumpuk di atas assets/banner.gif oleh ffmpeg, lalu dikeluarkan sebagai GIF.
// Tidak ada dependency baru: ffmpeg-static sudah ada di package.json (dipakai musik).
//
// Kalau ffmpeg atau banner.gif tidak ada, isReady() bernilai false dan cards.js memakai PNG statis.
// CARD_ANIMATED=off mematikan mode animasi. FFMPEG_PATH memakai binary ffmpeg sendiri.
// CARD_BANNER_GIF mengganti sumber animasi (default: assets/banner.gif).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const BANNER_GIF = process.env.CARD_BANNER_GIF || path.join(__dirname, 'assets', 'banner.gif');

// Asumsi, belum dikonfirmasi di server ini: batas upload bot 10 MB. Sisakan ruang untuk overhead multipart.
const MAX_GIF_BYTES = 7 * 1024 * 1024;
// proses ffmpeg bersamaan per bot; satu saja kalau batas memori server di bawah 1 GB (palettegen menahan semua frame di RAM)
const MAX_PARALLEL = (() => { const l = memoryLimitBytes(); return l > 0 && l < 1024 ** 3 ? 1 : 2; })();
const CACHE_MAX = 12;            // GIF identik (mis. pesan error yang sama) tidak dirender ulang
const DEFAULT_BUDGET_MS = 20000;
const MIN_ATTEMPT_MS = 600;      // sisa waktu di bawah ini: tidak mulai percobaan baru

// Tangga kualitas: kalau hasilnya melebihi MAX_GIF_BYTES, coba fps dan warna yang lebih rendah.
const QUALITY_LADDER = Object.freeze([
  Object.freeze({ fps: 8, colors: 96 }),
  Object.freeze({ fps: 6, colors: 64 }),
  Object.freeze({ fps: 5, colors: 48 }),
]);

// ============ fungsi murni (bisa dicek tanpa ffmpeg) ============
function isGif(buf) {
  return Buffer.isBuffer(buf) && buf.length > 6 && buf.toString('latin1', 0, 4) === 'GIF8';
}

// Graf filter: banner di-cover-crop ke ukuran kartu (agak condong ke atas supaya orb tetap terlihat),
// lapisan kartu ditumpuk, lalu palet dibuat dari frame yang sudah jadi.
function buildFilter(w, h, { fps, colors }) {
  const okInt = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;
  if (!okInt(w, 16, 4096) || !okInt(h, 16, 4096)) throw new RangeError(`ukuran kartu tidak valid: ${w}x${h}`);
  if (!(Number.isFinite(fps) && fps >= 1 && fps <= 25)) throw new RangeError(`fps tidak valid: ${fps}`);
  if (!okInt(colors, 2, 256)) throw new RangeError(`jumlah warna tidak valid: ${colors}`);
  return [
    `[0:v]fps=${fps},scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}:(iw-ow)/2:(ih-oh)*0.25[bg]`,
    '[bg][1:v]overlay=0:0:format=auto,split[a][b]',
    `[a]palettegen=max_colors=${colors}:stats_mode=diff[p]`,
    '[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
  ].join(';');
}

function buildArgs(w, h, quality) {
  return [
    '-v', 'error', '-y',
    '-i', BANNER_GIF,
    '-f', 'image2pipe', '-c:v', 'png', '-i', 'pipe:0',
    '-filter_complex', buildFilter(w, h, quality),
    '-loop', '0',
    '-f', 'gif', 'pipe:1',
  ];
}

// ============ ffmpeg ============
let ffmpegPath;   // undefined = belum dicari, null = tidak ada

function resolveFfmpeg() {
  if (ffmpegPath !== undefined) return ffmpegPath;
  const candidates = [];
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);
  try {
    const bundled = require('ffmpeg-static');
    if (typeof bundled === 'string' && bundled) candidates.push(bundled);
  } catch { /* paket tidak terpasang */ }
  candidates.push('ffmpeg');
  ffmpegPath = null;
  for (const bin of candidates) {
    try {
      const r = spawnSync(bin, ['-version'], { timeout: 5000, windowsHide: true });
      if (r.status === 0) { ffmpegPath = bin; break; }
    } catch { /* coba kandidat berikutnya */ }
  }
  return ffmpegPath;
}

// Batas memori proses (cgroup/container) dalam byte, atau 0 kalau tidak diketahui.
function memoryLimitBytes() {
  try {
    const v = typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : 0;
    return Number.isFinite(v) && v > 0 && v < 2 ** 52 ? v : 0;   // nilai raksasa = tanpa batas
  } catch {
    return 0;
  }
}

// GIF hanya untuk bot yang memang butuh (default: level dan obfu). Bot lain memakai kartu PNG statis.
// CARD_ANIMATED=off mematikan semua, CARD_ANIMATED=on menyalakan untuk semua role,
// CARD_ANIMATED_ROLES=level,obfu mengganti daftar role (pisah koma). Role kosong (tidak diketahui) dianggap boleh.
const DEFAULT_ANIMATED_ROLES = 'level,obfu';
function animationEnabled(role = process.env.BOT_ROLE) {
  const v = String(process.env.CARD_ANIMATED || '').toLowerCase();
  if (v === 'off') return false;
  if (v === 'on') return true;
  const r = String(role || '').trim().toLowerCase();
  if (!r) return true;
  const list = String(process.env.CARD_ANIMATED_ROLES ?? DEFAULT_ANIMATED_ROLES).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  return list.includes(r);
}

function isReady() {
  if (!animationEnabled()) return false;
  if (!fs.existsSync(BANNER_GIF)) return false;
  return resolveFfmpeg() !== null;
}

// ============ antrean (batasi proses ffmpeg bersamaan) ============
let active = 0;
const waiters = [];

function acquire(timeoutMs) {
  return new Promise((resolve, reject) => {
    if (active < MAX_PARALLEL) { active += 1; resolve(); return; }
    const waiter = { resolve, timer: null };
    waiter.timer = setTimeout(() => {
      const i = waiters.indexOf(waiter);
      if (i >= 0) waiters.splice(i, 1);
      reject(new Error('antrean ffmpeg penuh'));
    }, Math.max(0, timeoutMs));
    waiters.push(waiter);
  });
}

function release() {
  const next = waiters.shift();
  if (next) { clearTimeout(next.timer); next.resolve(); } else active -= 1;
}

// ============ cache kecil (urutan masuk, yang terlama dibuang) ============
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (hit === undefined) return null;
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function cachePut(key, buf) {
  cache.set(key, buf);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

// ============ eksekusi ============
function runFfmpeg(args, input, { timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveFfmpeg(), args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const out = [];
    let outBytes = 0;
    let errText = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new Error(`ffmpeg melewati batas waktu ${timeoutMs} ms`));
    }, Math.max(1, timeoutMs));

    child.stdout.on('data', (chunk) => {
      outBytes += chunk.length;
      if (outBytes > maxBytes) {
        child.kill('SIGKILL');
        finish(reject, Object.assign(new Error('GIF melebihi batas ukuran'), { tooBig: true }));
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk) => { if (errText.length < 4000) errText += chunk.toString(); });
    child.stdin.on('error', () => { /* ffmpeg berhenti lebih awal; hasilnya ditentukan di 'close' */ });
    child.on('error', (err) => finish(reject, err));
    child.on('close', (code) => {
      if (code === 0 && outBytes > 0) finish(resolve, Buffer.concat(out));
      else finish(reject, new Error(`ffmpeg keluar dengan kode ${code}: ${errText.trim().slice(0, 400)}`));
    });
    child.stdin.end(input);
  });
}

// overlayPng: Buffer PNG berukuran w x h dengan alpha. Mengembalikan Buffer GIF (<= MAX_GIF_BYTES).
// Melempar error kalau tidak muat dalam budgetMs atau tidak ada kualitas yang cukup kecil.
async function composeGif(overlayPng, w, h, { budgetMs = DEFAULT_BUDGET_MS } = {}) {
  if (!isReady()) throw new Error('mode animasi tidak tersedia');
  if (!Buffer.isBuffer(overlayPng) || overlayPng.length === 0) throw new TypeError('overlay PNG kosong');

  const key = `${crypto.createHash('sha1').update(overlayPng).digest('hex')}:${w}x${h}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const deadline = Date.now() + budgetMs;
  await acquire(budgetMs);
  try {
    let lastErr = new Error('tidak ada percobaan yang sempat dijalankan');
    for (const quality of QUALITY_LADDER) {
      const left = deadline - Date.now();
      if (left < MIN_ATTEMPT_MS) break;
      try {
        const gif = await runFfmpeg(buildArgs(w, h, quality), overlayPng, { timeoutMs: left, maxBytes: MAX_GIF_BYTES });
        if (!isGif(gif)) throw new Error('keluaran ffmpeg bukan GIF');
        cachePut(key, gif);
        return gif;
      } catch (err) {
        lastErr = err;
        if (!err.tooBig) break;   // gagal selain ukuran: kualitas lebih rendah tidak akan membantu
      }
    }
    throw lastErr;
  } finally {
    release();
  }
}

module.exports = {
  isReady,
  animationEnabled,
  memoryLimitBytes,
  resolveFfmpeg,
  composeGif,
  buildFilter,
  buildArgs,
  isGif,
  QUALITY_LADDER,
  MAX_GIF_BYTES,
};
