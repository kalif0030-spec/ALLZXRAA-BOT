'use strict';
// Obfuscate lokal, bentuk mengikuti sampel ALLZRA_main.lua, dengan lapisan:
// 1. XOR per byte dengan kunci berulang (24 byte, acak per job).
// 2. Base64 per chunk (chunk 3072 byte, supaya tidak ada padding di tengah).
// 3. Nama identifier di loader diacak per job.
// Decoder Lua memakai aritmatika saja (tanpa operator bitwise), jadi jalan di Lua 5.1+ dan Luau.
// Tanpa API key, tanpa jaringan. Ini obfuscation, bukan enkripsi: kunci tetap ikut di output,
// dan tidak ada jaminan hasilnya tahan terhadap deobfuscator tertentu.
// BELUM DIJALANKAN: sandbox tidak punya interpreter Lua. Decoder hanya dicek lewat mirror di JavaScript.

const crypto = require('node:crypto');
const { bannerBlock } = require('./banner');

const CHUNK_BYTES = 3072;
const KEY_BYTES = 24;
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

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
  let ki = 0;
  for (let start = 0; start < buf.length; start += CHUNK_BYTES) {
    const part = Buffer.alloc(Math.min(CHUNK_BYTES, buf.length - start));
    for (let i = 0; i < part.length; i++) {
      part[i] = xorByte(buf[start + i], key[ki]);
      ki = (ki + 1) % key.length;
    }
    chunks.push(part.toString('base64'));
  }
  return chunks;
}

// Nama acak: awalan "_" + 7 huruf/angka. Dibuat unik per job.
function randomNames(count) {
  const names = new Set();
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  while (names.size < count) {
    let n = '_';
    const bytes = crypto.randomBytes(7);
    for (const b of bytes) n += alphabet[b % alphabet.length];
    names.add(n);
  }
  return [...names];
}

function buildLoader(chunks, key, banner, total, names = randomNames(16)) {
  const [CH, KE, NN, EE, PP, II, XF, AA, B6, BB, SS, LL, FF, ZZ, CC, JJ] = names;
  const chunkLines = chunks.map((c) => `"${c}",`).join('\n');
  const keyList = [...key].join(',');
  const decoder = [
    `local ${AA}="${B64_ALPHABET}"`,
    `local ${B6}=function(s)local o={}for i=1,#s,4 do local v,pad=0,0 for j=0,3 do local ch=string.sub(s,i+j,i+j)local d if ch=="=" then d=0 pad=pad+1 else d=string.find(${AA},ch,1,true)-1 end v=v*64+d end local b1=math.floor(v/65536)local b2=math.floor(v/256)%256 local b3=v%256 o[#o+1]=string.char(b1)if pad<2 then o[#o+1]=string.char(b2)end if pad<1 then o[#o+1]=string.char(b3)end end return table.concat(o)end`,
    `local ${CH}={`,
    chunkLines,
    `}`,
    `local ${KE}={${keyList}}`,
    `local ${NN}=#${KE};local ${EE}=${total};local ${PP}={};local ${II}=1`,
    `local ${XF}=function(a,b)local r,p=0,1 for _=1,8 do local x,y=a%2,b%2 if x~=y then r=r+p end a=(a-x)/2 b=(b-y)/2 p=p*2 end return r end`,
    `for _,${CC} in ipairs(${CH})do local ${BB}=${B6}(${CC})for ${JJ}=1,#${BB} do local _b=${XF}(string.byte(${BB},${JJ}),${KE}[${II}]);${PP}[#${PP}+1]=string.char(_b);${II}=${II}%${NN}+1 end end`,
    `local ${SS}=table.concat(${PP});if #${SS}~=${EE} then error("ALLZXRAA: payload rusak",0)end`,
    `local ${LL}=loadstring or load;local ${FF},${ZZ}=${LL}(${SS},"=ALLZXRAA");if not ${FF} then error(${ZZ},0)end;return ${FF}(...)`,
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

module.exports = { obfuscateWithChunks, encodePayload, buildLoader, randomNames, xorByte, CHUNK_BYTES, KEY_BYTES };
