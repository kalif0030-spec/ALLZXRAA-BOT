'use strict';

// Layer VM v2 dan LuaRaph v2 untuk ALLZXRAA.
// Payload dienkode per byte dengan kunci penuh (berputar), lalu dibungkus loader Lua yang berisi
// dispatcher (VM v2) atau state machine dengan segmen acak (LuaRaph v2).
// Semua pilihan acak diturunkan deterministik dari kunci, jadi build yang sama selalu sama.
// Yang TIDAK dilindungi: kunci, mapping opcode, dan urutan segmen ada di file. Ini obfuscation tingkat 1, bukan kriptografi.

const VM_V2_MARKER = '-- ALLZXRAA:VM:2';
const LUARAPH_V2_MARKER = '-- ALLZXRAA:LUARAPH:2';
const MAX_OPCODE = 250;

// ---------- utilitas ----------
function makeRng(key) {
  let s = 0x9e3779b9;
  for (let i = 0; i < key.length; i++) s = (Math.imul(s ^ key[i], 0x01000193) + i + 1) >>> 0;
  if (s === 0) s = 0x6a09e667;
  return () => {
    s = (s ^ (s << 13)) >>> 0;
    s = (s ^ (s >>> 17)) >>> 0;
    s = (s ^ (s << 5)) >>> 0;
    return s;
  };
}

function shuffle(rng, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng() % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function splitChunks(text, size) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  if (chunks.length === 0) chunks.push('');
  return chunks;
}

// byte ke-i dari buf adalah byte global (start + i), kuncinya key[(start + i) % N]
function encodeAt(buf, start, key) {
  const out = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = (buf[i] + key[(start + i) % key.length]) % 256;
  return out.toString('hex');
}

function decodeAt(hex, start, key) {
  const enc = Buffer.from(hex, 'hex');
  const out = Buffer.allocUnsafe(enc.length);
  for (let i = 0; i < enc.length; i++) out[i] = (enc[i] - key[(start + i) % key.length] + 256) % 256;
  return out;
}

function parseKey(s) {
  const parts = s.split(',').map((x) => x.trim());
  if (parts.some((x) => !/^\d+$/.test(x))) throw new Error('kunci tidak valid');
  const key = parts.map(Number);
  if (key.some((v) => v > 255)) throw new Error('kunci tidak valid');
  return key;
}

function parseIntList(s) {
  const parts = s.split(',').map((x) => x.trim());
  if (parts.some((x) => !/^\d+$/.test(x))) throw new Error('daftar angka tidak valid');
  return parts.map(Number);
}

// ---------- VM v2 ----------
// Dispatcher: _BC berisi pasangan (op, arg). PUSH membawa chunk hex, JUNK tidak mengubah state,
// HALT berhenti. Ada predikat (_SEED * (_SEED + 1)) % 2 yang selalu benar, dicek di tiap langkah.
function vmLoaderText({ push, halt, junk, seed, key }) {
  const junkTest = junk.map((op) => `_OP == ${op}`).join(' or ');
  return `local _K = {${key.join(', ')}}
local _N = #_K
local _SEED = ${seed}
local _KI = 1
local _OUT = {}
local _IP = 1
while true do
    local _OP = _BC[_IP]
    local _ARG = _BC[_IP + 1]
    _IP = _IP + 2
    if (_SEED * (_SEED + 1)) % 2 ~= 0 then error("ALLZXRAA: predikat rusak", 0) end
    if _OP == ${push} then
        if type(_ARG) ~= "string" or #_ARG % 2 ~= 0 then error("ALLZXRAA: bytecode rusak", 0) end
        for _I = 1, #_ARG, 2 do
            local _B = (tonumber(string.sub(_ARG, _I, _I + 1), 16) - _K[_KI]) % 256
            _OUT[#_OUT + 1] = string.char(_B)
            _KI = _KI % _N + 1
        end
    elseif ${junkTest} then
        -- junk: tidak mengubah state
    elseif _OP == ${halt} then
        break
    else
        error("ALLZXRAA: opcode tidak valid", 0)
    end
end
local _SRC = table.concat(_OUT)
local _LOAD = loadstring or load
local _FUNC, _ERR = _LOAD(_SRC, "=ALLZXRAA")
if not _FUNC then error(_ERR, 0) end
return _FUNC(...)`;
}

function assignOps(key) {
  const rng = makeRng(key);
  const pool = shuffle(rng, Array.from({ length: MAX_OPCODE }, (_, i) => i + 1));
  return {
    rng,
    ops: {
      push: pool[0],
      halt: pool[1],
      junk: [pool[2], pool[3], pool[4]],
      seed: 1 + (rng() % 997),
    },
  };
}

function buildVmV2(sourceBuf, { key, chunkHexChars, banner }) {
  const { rng, ops } = assignOps(key);
  const hex = encodeAt(sourceBuf, 0, key);
  const instr = [];
  for (const chunk of splitChunks(hex, chunkHexChars)) {
    if (rng() % 3 === 0) instr.push(`    ${ops.junk[rng() % ops.junk.length]}, ${rng() % 100000},`);
    instr.push(`    ${ops.push}, "${chunk}",`);
  }
  instr.push(`    ${ops.halt}, 0,`);
  const header = `${VM_V2_MARKER} push=${ops.push} halt=${ops.halt} junk=${ops.junk.join(',')} seed=${ops.seed}`;
  return `${header}\n${banner}\nlocal _BC = {\n${instr.join('\n')}\n}\n${vmLoaderText({ ...ops, key })}\n`;
}

function decodeVmV2(sourceBuf, { banner, maxSourceBytes }) {
  const text = sourceBuf.toString('utf8');
  if (!text.startsWith(`${VM_V2_MARKER} `)) return null;
  const nl = text.indexOf('\n');
  if (nl < 0) throw new Error('header VM v2 tidak lengkap');
  const hm = /^-- ALLZXRAA:VM:2 push=(\d+) halt=(\d+) junk=(\d+(?:,\d+)*) seed=(\d+)$/.exec(text.slice(0, nl));
  if (!hm) throw new Error('header VM v2 tidak valid');
  const ops = { push: Number(hm[1]), halt: Number(hm[2]), junk: hm[3].split(',').map(Number), seed: Number(hm[4]) };

  const bcHead = `${banner}\nlocal _BC = {\n`;
  if (!text.startsWith(bcHead, nl + 1)) throw new Error('banner atau header bytecode VM v2 tidak valid');
  const instrStart = nl + 1 + bcHead.length;
  const instrEnd = text.indexOf('\n}\n', instrStart);
  if (instrEnd < 0) throw new Error('bytecode VM v2 tidak lengkap');
  const lines = text.slice(instrStart, instrEnd).split('\n');
  const tail = text.slice(instrEnd + 3);

  const re = /^    (\d+), (?:"([0-9a-fA-F]*)"|(\d+)),$/;
  const chunks = [];
  let sawHalt = false;
  lines.forEach((line, idx) => {
    const m = re.exec(line);
    if (!m) throw new Error(`instruksi VM v2 tidak valid (baris ${idx + 1})`);
    const op = Number(m[1]);
    if (op === ops.push) {
      if (m[2] === undefined) throw new Error(`argumen PUSH VM v2 tidak valid (baris ${idx + 1})`);
      chunks.push(m[2]);
    } else if (ops.junk.includes(op)) {
      if (m[3] === undefined) throw new Error(`argumen JUNK VM v2 tidak valid (baris ${idx + 1})`);
    } else if (op === ops.halt) {
      if (idx !== lines.length - 1 || m[3] !== '0') throw new Error('instruksi HALT tidak di akhir');
      sawHalt = true;
    } else {
      throw new Error(`opcode VM v2 tidak dikenal (${op}, baris ${idx + 1})`);
    }
  });
  if (!sawHalt) throw new Error('instruksi HALT VM v2 hilang');

  const km = /^local _K = \{([^}]*)\}\n/.exec(tail);
  if (!km) throw new Error('kunci VM v2 tidak ditemukan');
  const key = parseKey(km[1]);
  if (tail !== `${vmLoaderText({ ...ops, key })}\n`) throw new Error('interpreter VM v2 tidak valid');

  const hex = chunks.join('');
  if (hex.length === 0 || hex.length % 2 !== 0 || hex.length / 2 > maxSourceBytes) {
    throw new Error('ukuran payload VM v2 tidak valid atau melebihi batas');
  }
  return decodeAt(hex, 0, key);
}

// ---------- LuaRaph v2 ----------
// State machine: STATE 1 cek selesai, STATE 2 dekode satu segmen sesuai _ORDER, STATE 3 selesai.
// _SEG berisi segmen asli plus decoy (id di luar 1.._COUNT) yang tidak pernah dipakai.
const LUARAPH_V2_LOADER = `local _OUT = {}
local _STATE, _I = 1, 1
while true do
    if _STATE == 1 then
        if _I > #_ORDER then _STATE = 3 else _STATE = 2 end
    elseif _STATE == 2 then
        local _J = _ORDER[_I]
        local _HEX = _SEG[_J]
        if type(_HEX) ~= "string" or #_HEX % 2 ~= 0 then error("ALLZXRAA: segmen rusak", 0) end
        local _PIECE = {}
        for _Q = 1, #_HEX, 2 do
            local _GI = (_J - 1) * _SEGSIZE + (_Q - 1) / 2
            _PIECE[#_PIECE + 1] = string.char((tonumber(string.sub(_HEX, _Q, _Q + 1), 16) - _K[_GI % _N + 1]) % 256)
        end
        _OUT[_J] = table.concat(_PIECE)
        _I = _I + 1
        _STATE = 1
    elseif _STATE == 3 then
        break
    else
        error("ALLZXRAA: state tidak valid", 0)
    end
end
local _SRC = {}
for _J = 1, _COUNT do
    if _OUT[_J] == nil then error("ALLZXRAA: segmen hilang", 0) end
    _SRC[_J] = _OUT[_J]
end
local _SRC_STR = table.concat(_SRC)
if #_SRC_STR ~= _EXPECT then error("ALLZXRAA: payload rusak", 0) end
local _LOAD = loadstring or load
local _FUNC, _ERR = _LOAD(_SRC_STR, "=ALLZXRAA")
if not _FUNC then error(_ERR, 0) end
return _FUNC(...)`;

function buildLuaRaphV2(sourceBuf, { key, chunkHexChars, banner }) {
  const rng = makeRng(key);
  const SEG = chunkHexChars / 2;
  const count = Math.ceil(sourceBuf.length / SEG);
  const entries = [];
  for (let j = 1; j <= count; j++) {
    const start = (j - 1) * SEG;
    entries.push([j, encodeAt(sourceBuf.subarray(start, start + SEG), start, key)]);
  }
  const decoys = 1 + (rng() % 3);
  for (let d = 0; d < decoys; d++) {
    const len = 1 + (rng() % SEG);
    const bytes = Buffer.alloc(len);
    for (let i = 0; i < len; i++) bytes[i] = rng() & 0xff;
    entries.push([count + 1 + d, bytes.toString('hex')]);
  }
  const order = shuffle(rng, Array.from({ length: count }, (_, i) => i + 1));
  shuffle(rng, entries);
  const segLines = entries.map(([id, hex]) => `    [${id}] = "${hex}",`).join('\n');
  return `${LUARAPH_V2_MARKER}\n${banner}\nlocal _SEG = {\n${segLines}\n}\n`
    + `local _ORDER = {${order.join(', ')}}\n`
    + `local _K = {${key.join(', ')}}\n`
    + `local _N = #_K\n`
    + `local _SEGSIZE = ${SEG}\n`
    + `local _COUNT = ${count}\n`
    + `local _EXPECT = ${sourceBuf.length}\n`
    + `${LUARAPH_V2_LOADER}\n`;
}

function decodeLuaRaphV2(sourceBuf, { banner, maxSourceBytes }) {
  const text = sourceBuf.toString('utf8');
  const head = `${LUARAPH_V2_MARKER}\n${banner}\nlocal _SEG = {\n`;
  if (!text.startsWith(head)) return null;

  const segEnd = text.indexOf('\n}\n', head.length);
  if (segEnd < 0) throw new Error('segmen LuaRaph v2 tidak lengkap');
  const segRe = /^    \[(\d+)\] = "([0-9a-fA-F]*)",$/;
  const segs = new Map();
  for (const line of text.slice(head.length, segEnd).split('\n')) {
    const m = segRe.exec(line);
    if (!m) throw new Error('segmen LuaRaph v2 tidak valid');
    const id = Number(m[1]);
    if (segs.has(id)) throw new Error(`segmen LuaRaph v2 duplikat (id ${id})`);
    segs.set(id, m[2]);
  }

  const rest = text.slice(segEnd + 3);
  const tm = /^local _ORDER = \{([^}]*)\}\nlocal _K = \{([^}]*)\}\nlocal _N = #_K\nlocal _SEGSIZE = (\d+)\nlocal _COUNT = (\d+)\nlocal _EXPECT = (\d+)\n([\s\S]*)$/.exec(rest);
  if (!tm || tm[6] !== `${LUARAPH_V2_LOADER}\n`) throw new Error('loader LuaRaph v2 tidak valid');

  const order = parseIntList(tm[1]);
  const key = parseKey(tm[2]);
  const seg = Number(tm[3]);
  const count = Number(tm[4]);
  const expect = Number(tm[5]);
  if (!(seg > 0 && count > 0 && expect > 0) || expect > maxSourceBytes || count !== Math.ceil(expect / seg)) {
    throw new Error('metadata LuaRaph v2 tidak valid');
  }
  if (order.length !== count || order.slice().sort((a, b) => a - b).some((v, i) => v !== i + 1)) {
    throw new Error('urutan segmen LuaRaph v2 bukan permutasi 1..N');
  }

  const out = Buffer.alloc(expect);
  for (let j = 1; j <= count; j++) {
    const hex = segs.get(j);
    if (hex === undefined) throw new Error(`segmen ${j} hilang`);
    const len = j < count ? seg : expect - (count - 1) * seg;
    if (hex.length !== len * 2) throw new Error(`panjang segmen ${j} tidak cocok`);
    decodeAt(hex, (j - 1) * seg, key).copy(out, (j - 1) * seg);
  }
  return out;
}

module.exports = {
  VM_V2_MARKER, LUARAPH_V2_MARKER,
  buildVmV2, decodeVmV2, buildLuaRaphV2, decodeLuaRaphV2,
};
