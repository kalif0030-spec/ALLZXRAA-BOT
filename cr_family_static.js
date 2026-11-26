'use strict';
// Pengenal dan pembaca statis untuk keluarga VM CR_* (string decryptor + dispatcher if/elseif).
// TIDAK memulihkan source. Hanya menghasilkan laporan: nama decryptor, string hasil dekripsi,
// jumlah cabang opcode, dan variabel dispatcher. Tidak menjalankan script apa pun.

const MAX_REPORT_STRINGS = 12;

const LUA_ESC = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '\\': 92, '"': 34, "'": 39, '\n': 10 };

// src[i] adalah kutip pembuka. Mengembalikan { bytes, next } atau null bila tidak valid.
function parseLuaString(src, i) {
  const q = src[i];
  let j = i + 1;
  const out = [];
  while (j < src.length) {
    const c = src[j];
    if (c === q) return { bytes: out, next: j + 1 };
    if (c === '\\') {
      const n = src[j + 1];
      if (n === undefined) return null;
      if (/\d/.test(n)) {
        const m = /^\d{1,3}/.exec(src.slice(j + 1));
        out.push(Number(m[0]) & 0xff);
        j += 1 + m[0].length;
      } else {
        out.push(LUA_ESC[n] !== undefined ? LUA_ESC[n] : n.charCodeAt(0));
        j += 2;
      }
    } else {
      out.push(c.charCodeAt(0) & 0xff);
      j += 1;
    }
  }
  return null;
}

function findDecryptor(src) {
  const re = /local function (\w+)\((\w+),(\w+)\)([\s\S]*?)\nend/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m[4].includes('%256') && m[4].includes('#')) return m[1];
  }
  return null;
}

// (byte(data,i) - byte(key,(i-1)%#key+1)) % 256, versi 0-based
function decrypt(data, key) {
  return data.map((b, i) => (b - key[i % key.length] + 256) % 256);
}

function decodeStrings(src, fname) {
  const out = [];
  const re = new RegExp(`${fname}\\(`, 'g');
  let m;
  while ((m = re.exec(src)) !== null) {
    let i = m.index + m[0].length;
    if (src[i] !== '"' && src[i] !== "'") continue;
    const a = parseLuaString(src, i);
    if (!a) continue;
    let j = a.next;
    while (src[j] === ' ') j++;
    if (src[j] !== ',') continue;
    j++;
    while (src[j] === ' ') j++;
    if (src[j] !== '"' && src[j] !== "'") continue;
    const b = parseLuaString(src, j);
    if (!b) continue;
    if (src[b.next] !== ')') continue;
    out.push(String.fromCharCode(...decrypt(a.bytes, b.bytes)));
  }
  return out;
}

function dispatcher(src) {
  const counts = new Map();
  const re = /\b(?:if|elseif) (\w+)==(\d+) then/g;
  let m;
  while ((m = re.exec(src)) !== null) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  if (counts.size === 0) return null;
  let best = null;
  for (const [name, n] of counts) if (!best || n > best.n) best = { name, n };
  return best;
}

// Mengembalikan null bila bukan keluarga CR_*. Bila cocok, mengembalikan objek laporan.
function analyzeCrFamily(sourceBuf) {
  const src = sourceBuf.toString('latin1');
  const fname = findDecryptor(src);
  if (!fname) return null;
  const disp = dispatcher(src);
  if (!disp || disp.n < 8) return null;   // dispatcher yang terlalu kecil bukan pola ini
  const strings = decodeStrings(src, fname);
  return {
    decryptor: fname,
    decodedStrings: strings.length,
    distinctStrings: [...new Set(strings)].slice(0, MAX_REPORT_STRINGS),
    dispatcherVar: disp.name,
    opcodeBranches: disp.n,
  };
}

// Teks singkat untuk pesan error bot. Source tidak dipulihkan, jadi laporan ini adalah hasil akhirnya.
function crReportText(r) {
  const names = r.distinctStrings.map((s) => JSON.stringify(s)).join(', ');
  return `keluarga VM CR terdeteksi: decryptor ${r.decryptor}, ${r.decodedStrings} string terdekripsi, `
    + `${r.opcodeBranches} cabang opcode (variabel ${r.dispatcherVar}). `
    + `Source TIDAK dipulihkan: bytecode VM belum terpetakan. String awal: ${names}`;
}

module.exports = { analyzeCrFamily, crReportText };
