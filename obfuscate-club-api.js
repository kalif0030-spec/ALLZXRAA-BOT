'use strict';

const fs = require('node:fs');
const path = require('node:path');
// Backend api.obfuscate.club. Satu request: POST /v1/obfuscate, body {source, target}, auth Bearer.
// Format respons belum diverifikasi ke server asli: kode ambil field teks pertama yang ada
// (code, output, result, obfuscated, source), dan error dari server ikut ditampilkan.

const ENDPOINT = 'https://api.obfuscate.club/v1/obfuscate';
const DEFAULT_TARGET = 'lua54';
const REQUEST_TIMEOUT_MS = 60_000;
const RESULT_FIELDS = ['code', 'output', 'result', 'obfuscated', 'source'];

function normalizeLua(text) {
  return text
    .replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, '')
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, '');
}

async function obfuscateWithObfClub(buf, {
  apiKey,
  target = DEFAULT_TARGET,
  fetchImpl = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  if (!apiKey) throw new Error('OBF_API_KEY belum diisi');
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw new Error('source kosong');

  const source = buf.toString('utf8');
  const res = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, target }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`respons bukan JSON (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const detail = data?.error?.message || data?.error || data?.message || '';
    throw new Error(`HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
  }

  const field = RESULT_FIELDS.find((f) => typeof data?.[f] === 'string' && data[f].length > 0);
  if (!field) throw new Error('respons tidak berisi kode hasil obfuscate');
  const out = Buffer.from(data[field], 'utf8');

  // Hasil yang cuma beda komentar atau spasi dari source berarti tidak ada obfuscation.
  if (normalizeLua(out.toString('utf8')) === normalizeLua(source)) {
    throw new Error('obfuscate.club mengembalikan script tanpa perubahan. Cek key dan target');
  }
  return out;
}

// Banner di dalam file hasil obfuscate: blok komentar Lua dengan ASCII art dari assets/banner.txt.
// Teks "ALLZXRAA COMMUNITY" di baris terakhir diganti nama brand. Tanda ']' dibuang supaya tidak menutup komentar.
const BANNER_FILE = path.join(__dirname, 'assets', 'banner.txt');
let bannerArt = null;

function getBannerArt() {
  if (bannerArt === null) {
    bannerArt = fs.existsSync(BANNER_FILE)
      ? fs.readFileSync(BANNER_FILE, 'utf8').replace(/\r/g, '').replace(/\s+$/, '')
      : 'ALLZXRAA COMMUNITY';
  }
  return bannerArt;
}

function addLuaBanner(buf, brandName) {
  const brand = String(brandName || '').replace(/[\r\n\]]+/g, ' ').trim() || 'ALLZXRAA COMMUNITY';
  const art = getBannerArt().replace(/ALLZXRAA COMMUNITY/g, brand);
  const header = `--[[\n${art}\n]]\n`;
  return Buffer.concat([Buffer.from(header, 'utf8'), buf]);
}

module.exports = { obfuscateWithObfClub, addLuaBanner, ENDPOINT, DEFAULT_TARGET };
