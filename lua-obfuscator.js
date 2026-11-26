'use strict';

const { deobfuscateLegacy } = require('./legacy-deobfuscator');
const { compileToLua } = require('./compiler');

const VM2_MARKER = '-- ALLZXRAA:VM2:1';
const {
  VM_V2_MARKER, LUARAPH_V2_MARKER,
  buildVmV2, decodeVmV2, buildLuaRaphV2, decodeLuaRaphV2,
} = require('./lua-layers-v2');

const MODE_CHOICES = Object.freeze([
  { name: 'ALLZXRAA lama', value: 'allzxraa' },
  { name: 'LuaRaph-style', value: 'luaraph' },
  { name: 'VM wrapper', value: 'vm' },
  { name: 'Kombinasi', value: 'combined' },
  { name: 'VM register (subset Lua, bisa di-disassemble saja)', value: 'vm2' },
]);

const LUARAPH_MARKER = '-- ALLZXRAA:LUARAPH:1';
const VM_MARKER = '-- ALLZXRAA:VM:1';
const WRAPPER_EXPANSION_LIMIT = 12;
const LUARAPH_LOADER = `local _PARTS = {}
for _, _C in ipairs(_DATA) do
    for _I = 1, #_C, 2 do
        local _B = (tonumber(string.sub(_C, _I, _I + 1), 16) - _KEY) % 256
        _PARTS[#_PARTS + 1] = string.char(_B)
    end
end
local _SOURCE = table.concat(_PARTS)
local _LOAD = loadstring or load
local _FUNC, _ERR = _LOAD(_SOURCE, "=ALLZXRAA")
if not _FUNC then error(_ERR, 0) end
return _FUNC(...)`;
const VM_LOADER = `local _IP = 1
local _STACK = {}
while true do
    local _OP = _BYTECODE[_IP]
    _IP = _IP + 1
    if _OP == 0 then
        break
    elseif _OP == 1 then
        local _DATA = _BYTECODE[_IP]
        if type(_DATA) ~= "string" then error("ALLZXRAA: bytecode rusak", 0) end
        _IP = _IP + 1
        for _I = 1, #_DATA, 2 do
            local _B = (tonumber(string.sub(_DATA, _I, _I + 1), 16) - _KEY) % 256
            _STACK[#_STACK + 1] = string.char(_B)
        end
    else
        error("ALLZXRAA: opcode tidak valid", 0)
    end
end
local _SOURCE = table.concat(_STACK)
local _LOAD = loadstring or load
local _FUNC, _ERR = _LOAD(_SOURCE, "=ALLZXRAA")
if not _FUNC then error(_ERR, 0) end
return _FUNC(...)`;

function splitChunks(text, size) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  if (chunks.length === 0) chunks.push('');
  return chunks;
}

function encodeBytes(sourceBuf, key) {
  if (!Array.isArray(key) || key.length === 0
    || key.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    throw new TypeError('kunci obfuscate tidak valid');
  }
  const encoded = Buffer.allocUnsafe(sourceBuf.length);
  for (let i = 0; i < sourceBuf.length; i++) {
    encoded[i] = (sourceBuf[i] + key[i % key.length]) % 256;
  }
  return encoded.toString('hex');
}

function buildLegacySource(sourceBuf, { key, chunkHexChars, banner }) {
  const chunksLua = splitChunks(encodeBytes(sourceBuf, key), chunkHexChars)
    .map((chunk) => `    "${chunk}",`).join('\n');

  return `loadstring([=[
${banner}
local _CHUNKS = {
${chunksLua}
}
local _K = {${key.join(', ')}}
local _N = #_K
local _EXPECT = ${sourceBuf.length}

local _parts = {}
local _ki = 1
for _, _c in ipairs(_CHUNKS) do
    for _i = 1, #_c, 2 do
        local _b = (tonumber(string.sub(_c, _i, _i + 1), 16) - _K[_ki]) % 256
        _parts[#_parts + 1] = string.char(_b)
        _ki = _ki % _N + 1
    end
end
local _src = table.concat(_parts)
if #_src ~= _EXPECT then error("ALLZXRAA: payload rusak", 0) end

local _load = loadstring or load
local _chunk, _err = _load(_src, "=ALLZXRAA")
if not _chunk then error(_err, 0) end
return _chunk(...)
]=])()
`;
}

// seed deterministik dari kunci, supaya build yang sama menghasilkan output yang sama
function seedFromKey(key) {
  let s = 0;
  key.forEach((v, i) => { s = (s + v * (i + 7)) >>> 0; });
  return s || 1;
}

// vm2 hanya menerima subset Lua (angka, local, if, while, print, operator, not/and/or/==).
// Source di luar subset ditolak dengan pesan dari compiler.
function buildVm2(sourceBuf, { key, banner }) {
  const { lua } = compileToLua(sourceBuf.toString('utf8'), seedFromKey(key));
  return `${VM2_MARKER}\n${banner}\n${lua}`;
}

function buildLayer(sourceBuf, mode, options) {
  if (mode === 'allzxraa') return Buffer.from(buildLegacySource(sourceBuf, options), 'utf8');
  if (mode === 'luaraph') return Buffer.from(buildLuaRaphV2(sourceBuf, options), 'utf8');
  if (mode === 'vm') return Buffer.from(buildVmV2(sourceBuf, options), 'utf8');
  if (mode === 'vm2') return Buffer.from(buildVm2(sourceBuf, options), 'utf8');
  throw new Error(`mode obfuscate tidak dikenal: ${mode}`);
}

function obfuscateLua(sourceBuf, options, mode = 'allzxraa') {
  if (!Buffer.isBuffer(sourceBuf)) throw new TypeError('sourceBuf harus Buffer');
  if (sourceBuf.length === 0) throw new Error('source kosong');
  if (!Number.isSafeInteger(options.maxSourceBytes) || options.maxSourceBytes < 1) {
    throw new TypeError('maxSourceBytes tidak valid');
  }
  if (sourceBuf.length > options.maxSourceBytes) {
    throw new Error(`source terlalu besar (${sourceBuf.length} byte > batas ${options.maxSourceBytes} byte)`);
  }
  if (!Number.isSafeInteger(options.chunkHexChars) || options.chunkHexChars < 2 || options.chunkHexChars % 2 !== 0) {
    throw new TypeError('chunkHexChars tidak valid');
  }

  const layers = mode === 'combined' ? ['luaraph', 'vm', 'allzxraa'] : [mode];
  let output = sourceBuf;
  for (const layer of layers) output = buildLayer(output, layer, options);

  const maxOutputBytes = options.maxSourceBytes * WRAPPER_EXPANSION_LIMIT + 64 * 1024;
  if (output.length > maxOutputBytes) {
    throw new Error(`hasil obfuscate terlalu besar (${output.length} byte > batas ${maxOutputBytes} byte)`);
  }
  return output.toString('utf8');
}

const CHUNK_LINE = /^[ \t]*"([0-9a-fA-F]*)"[ \t]*,?[ \t]*$/;
const VM_CHUNK_LINE = /^[ \t]*1,[ \t]*"([0-9a-fA-F]*)"[ \t]*,?[ \t]*$/;

function parseChunks(text, start, endMarker) {
  const end = text.indexOf(endMarker, start);
  if (end < 0) return null;
  const lines = text.slice(start, end).split('\n');
  if (lines.length === 0 || lines.some((line) => !CHUNK_LINE.test(line))) return null;
  return {
    chunks: lines.map((line) => CHUNK_LINE.exec(line)[1]),
    end,
  };
}

function decodeHexChunks(chunks, key, maxSourceBytes) {
  if (!Number.isInteger(key) || key < 0 || key > 255) throw new Error('kunci wrapper tidak valid');
  const hex = chunks.join('');
  if (hex.length === 0 || hex.length % 2 !== 0 || hex.length / 2 > maxSourceBytes) {
    throw new Error('ukuran payload wrapper tidak valid atau melebihi batas');
  }
  const encoded = Buffer.from(hex, 'hex');
  for (let i = 0; i < encoded.length; i++) encoded[i] = (encoded[i] - key + 256) % 256;
  return encoded;
}

function decodeLuaRaph(sourceBuf, { banner, maxSourceBytes }) {
  const text = sourceBuf.toString('utf8').replace(/\r\n/g, '\n');
  const prefix = `${LUARAPH_MARKER}\n${banner}\nlocal _DATA = {\n`;
  if (!text.startsWith(prefix)) return null;

  const parsed = parseChunks(text, prefix.length, '\n}\nlocal _KEY = ');
  if (!parsed) throw new Error('chunk LuaRaph-style tidak valid');
  const tail = /^\n\}\nlocal _KEY = (\d+)\n([\s\S]*)$/.exec(text.slice(parsed.end));
  const match = tail && tail[2] === `${LUARAPH_LOADER}\n` ? tail : null;
  if (!match) throw new Error('loader LuaRaph-style tidak valid');
  return decodeHexChunks(parsed.chunks, Number(match[1]), maxSourceBytes);
}

function decodeVm(sourceBuf, { banner, maxSourceBytes }) {
  const text = sourceBuf.toString('utf8').replace(/\r\n/g, '\n');
  const prefix = `${VM_MARKER}\n${banner}\nlocal _BYTECODE = {\n`;
  if (!text.startsWith(prefix)) return null;

  const endMarker = '\n    0,\n}\n';
  const end = text.indexOf(endMarker, prefix.length);
  if (end < 0) throw new Error('bytecode VM tidak lengkap');
  const lines = text.slice(prefix.length, end).split('\n');
  if (lines.length === 0 || lines.some((line) => !VM_CHUNK_LINE.test(line))) {
    throw new Error('bytecode VM tidak valid');
  }
  const chunks = lines.map((line) => VM_CHUNK_LINE.exec(line)[1]);

  const tail = /^local _KEY = (\d+)\n([\s\S]*)$/.exec(text.slice(end + endMarker.length));
  const match = tail && tail[2] === `${VM_LOADER}\n` ? tail : null;
  if (!match) throw new Error('interpreter VM tidak valid');
  return decodeHexChunks(chunks, Number(match[1]), maxSourceBytes);
}

function stripBanner(sourceBuf, banner) {
  const prefix = Buffer.from(`${banner}\n`, 'utf8');
  return sourceBuf.subarray(0, prefix.length).equals(prefix) ? sourceBuf.subarray(prefix.length) : sourceBuf;
}

function startsWithSupportedWrapper(sourceBuf, banner) {
  const text = sourceBuf.toString('utf8');
  return text.startsWith('loadstring([=[')
    || text.startsWith(`${VM_V2_MARKER} `)
    || text.startsWith(`${LUARAPH_V2_MARKER}\n`)
    || text.startsWith(`${LUARAPH_MARKER}\n${banner}\n`)
    || text.startsWith(`${VM_MARKER}\n${banner}\n`);
}

// Hanya untuk input terluar (wrapper): buang BOM, samakan newline, buang spasi/baris kosong di awal.
// Tidak dipakai untuk hasil dekode, supaya source asli (termasuk CRLF-nya) tidak berubah.
function normalizeOuter(buf) {
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  text = text.replace(/\r\n?/g, '\n').replace(/^\s+/, '');
  return Buffer.from(text, 'utf8');
}

function deobfuscateLua(sourceBuf, options) {
  if (!Buffer.isBuffer(sourceBuf)) throw new TypeError('sourceBuf harus Buffer');
  if (sourceBuf.toString('utf8', 0, VM2_MARKER.length) === VM2_MARKER) {
    throw new Error('mode vm2 tidak bisa dibalik ke source: bytecode-nya hanya bisa di-disassemble, karena compiler subset membuang struktur asli');
  }
  if (!Number.isSafeInteger(options.maxSourceBytes) || options.maxSourceBytes < 1) {
    throw new TypeError('maxSourceBytes tidak valid');
  }

  const maxDecodedBytes = options.maxSourceBytes * WRAPPER_EXPANSION_LIMIT + 64 * 1024;
  const decodeOptions = { ...options, maxSourceBytes: maxDecodedBytes };
  let current = normalizeOuter(sourceBuf);
  let decodedLayer = false;

  for (let depth = 0; depth < 4; depth++) {
    let next;
    if (current.toString('utf8').startsWith('loadstring([=[')) {
      next = stripBanner(deobfuscateLegacy(current, {
        banner: options.banner,
        maxSourceBytes: maxDecodedBytes,
      }), options.banner);
    } else {
      next = decodeLuaRaph(current, decodeOptions) ?? decodeVm(current, decodeOptions)
        ?? decodeLuaRaphV2(current, decodeOptions) ?? decodeVmV2(current, decodeOptions);
    }

    if (next === null) break;
    decodedLayer = true;
    current = next;
  }

  if (startsWithSupportedWrapper(current, options.banner)) {
    throw new Error('jumlah lapisan obfuscate melebihi batas');
  }
  if (!decodedLayer) {
    throw new Error(`format obfuscate ALLZXRAA tidak dikenali (awal file: ${JSON.stringify(current.toString('utf8', 0, 40))})`);
  }
  if (current.length > options.maxSourceBytes) {
    throw new Error(`source hasil deobfuscate melebihi batas ${options.maxSourceBytes} byte`);
  }
  return Buffer.concat([Buffer.from(`${options.banner}\n`, 'utf8'), current]);
}

module.exports = {
  VM2_MARKER,
  MODE_CHOICES,
  WRAPPER_EXPANSION_LIMIT,
  obfuscateLua,
  deobfuscateLua,
};
