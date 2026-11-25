'use strict';

const LEGACY_LOADER_BODY = `local _parts = {}
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
return _chunk(...)`;

function deobfuscateLegacy(sourceBuf, { banner, maxSourceBytes }) {
  if (!Buffer.isBuffer(sourceBuf)) throw new TypeError('sourceBuf harus Buffer');
  if (typeof banner !== 'string' || !banner) throw new TypeError('banner tidak valid');
  if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes < 1) {
    throw new TypeError('maxSourceBytes tidak valid');
  }

  const text = sourceBuf.toString('utf8').replace(/\r\n/g, '\n');
  const wrapper = /^loadstring\(\[=\[\n([\s\S]*?)\n\]=\]\)\(\)\s*$/.exec(text);
  if (!wrapper) throw new Error('format ALLZXRAA lama tidak dikenali');

  const inner = wrapper[1];
  const head = `${banner.replace(/\r\n/g, '\n')}\nlocal _CHUNKS = {\n`;
  if (!inner.startsWith(head)) throw new Error('banner atau header ALLZXRAA tidak valid');

  const chunksEnd = inner.indexOf('\n}\nlocal _K = {', head.length);
  if (chunksEnd < 0) throw new Error('daftar chunk ALLZXRAA tidak lengkap');
  const chunksText = inner.slice(head.length, chunksEnd);
  const chunkLines = chunksText.split('\n');
  if (chunkLines.length === 0 || chunkLines.some((line) => !/^    "[0-9a-f]*",$/.test(line))) {
    throw new Error('chunk ALLZXRAA tidak valid');
  }

  const metadata = /^\}\nlocal _K = \{([^\n]*)\}\nlocal _N = #_K\nlocal _EXPECT = ([0-9]+)\n\n([\s\S]*)$/.exec(inner.slice(chunksEnd + 1));
  if (!metadata || metadata[3] !== LEGACY_LOADER_BODY) {
    throw new Error('loader ALLZXRAA tidak valid');
  }

  const keyText = metadata[1];
  if (!/^\d+(?:\s*,\s*\d+)*$/.test(keyText)) throw new Error('kunci ALLZXRAA tidak valid');
  const key = keyText.split(',').map((part) => Number(part.trim()));
  if (key.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    throw new Error('kunci ALLZXRAA tidak valid');
  }

  const expectedLength = Number(metadata[2]);
  if (!Number.isSafeInteger(expectedLength) || expectedLength < 1 || expectedLength > maxSourceBytes) {
    throw new Error('ukuran payload ALLZXRAA tidak valid atau melebihi batas');
  }

  const chunks = chunkLines.map((line) => /^    "([0-9a-f]*)",$/.exec(line)[1]);
  const hex = chunks.join('');
  if (hex.length !== expectedLength * 2 || hex.length % 2 !== 0) {
    throw new Error('panjang payload ALLZXRAA tidak cocok');
  }

  const encoded = Buffer.from(hex, 'hex');
  const decoded = Buffer.alloc(expectedLength);
  for (let i = 0; i < expectedLength; i++) {
    decoded[i] = (encoded[i] - key[i % key.length] + 256) % 256;
  }

  return Buffer.concat([Buffer.from(`${banner}\n`, 'utf8'), decoded]);
}

module.exports = { deobfuscateLegacy };
