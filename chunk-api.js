'use strict';
// Obfuscate lokal, bentuk mengikuti sampel ALLZRA_main.lua, cipher XOR:
// - loader: loadstring([=[ ... ]=])() berisi banner, lalu decoder.
// - payload: hex per byte, dipecah jadi chunk 2048 byte (4096 hex), tiap byte = plain XOR kunci berulang.
// - decoder: XOR lagi dengan kunci berulang, cek panjang, lalu loadstring(source, "=ALLZXRAA") dan jalankan.
// XOR di Lua dibuat aritmatika (tanpa operator bitwise), supaya jalan di Lua 5.1+ dan Luau.
// Tanpa API key, tanpa jaringan. Kunci acak 24 byte per job, disimpan di output. XOR ini bukan enkripsi kuat.
// Spasi di kode dibuang sebisa mungkin. Spasi yang wajib (contoh "local _b", "in ipairs", "end end") tetap ada,
// karena Lua tidak bisa membaca keyword yang menempel ke nama.
// BELUM DIJALANKAN: sandbox tidak punya interpreter Lua. Verifikasi decode dilakukan di JavaScript.

const crypto = require('node:crypto');
const { bannerBlock } = require('./banner');

const CHUNK_BYTES = 2048;
const KEY_BYTES = 24;

function xorByte(a, b) {
  let r = 0, p = 1;
  for (let i = 0; i < 8; i++) {
    const x = a % 2, y = b % 2;
    if (x !== y) r += p;
    a = (a - x) / 2;
    b = (b - y) / 2;
    p *= 2;
  }
  return r;
}

function encodePayload(buf, key) {
  const chunks = [];
  let cur = '';
  let ki = 0;
  for (let i = 0; i < buf.length; i++) {
    cur += xorByte(buf[i], key[ki]).toString(16).padStart(2, '0');
    ki = (ki + 1) % key.length;
    if ((i + 1) % CHUNK_BYTES === 0) { chunks.push(cur); cur = ''; }
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

function buildLoader(chunks, key, banner, total) {
  const chunkLines = chunks.map((c) => `"${c}",`).join('\n');
  const keyList = [...key].join(',');
  const decoder = [
    `local _C={`,
    chunkLines,
    `}`,
    `local _K={${keyList}}`,
    `local _N=#_K;local _E=${total};local _P={};local _I=1`,
    `local _X=function(a,b)local r,p=0,1 for _=1,8 do local x,y=a%2,b%2 if x~=y then r=r+p end a=(a-x)/2 b=(b-y)/2 p=p*2 end return r end`,
    `for _,_c in ipairs(_C)do for _i=1,#_c,2 do local _b=_X(tonumber(string.sub(_c,_i,_i+1),16),_K[_I]);_P[#_P+1]=string.char(_b);_I=_I%_N+1 end end`,
    `local _S=table.concat(_P);if #_S~=_E then error("ALLZXRAA: payload rusak",0)end`,
    `local _L=loadstring or load;local _F,_Z=_L(_S,"=ALLZXRAA");if not _F then error(_Z,0)end;return _F(...)`,
  ].join('\n');
  const body = `${banner}\n${decoder}`;
  if (body.includes(']=]')) throw new Error('isi loader memuat ]=] dan akan menutup long string');
  return `loadstring([=[\n${body}\n]=])()\n`;
}

function obfuscateWithChunks(buf, { brandName, keyBytes } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw new Error('source kosong');
  const key = keyBytes ?? crypto.randomBytes(KEY_BYTES);
  if (!Buffer.isBuffer(key) || key.length === 0) throw new Error('kunci kosong');
  const chunks = encodePayload(buf, key);
  return Buffer.from(buildLoader(chunks, key, bannerBlock(brandName), buf.length), 'utf8');
}

module.exports = { obfuscateWithChunks, encodePayload, buildLoader, xorByte, CHUNK_BYTES, KEY_BYTES };
