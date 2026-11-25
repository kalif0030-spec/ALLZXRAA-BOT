'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deobfuscateLegacy } = require('../legacy-deobfuscator');
const { deobfuscateLua } = require('../lua-obfuscator');

const BANNER = '-- ALLZXRAA legacy test banner';
const LOADER_BODY = `local _parts = {}
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

function legacyWrapper(source, key = [7, 42]) {
  const bytes = Buffer.from(source);
  let encoded = '';
  for (let i = 0; i < bytes.length; i++) {
    encoded += ((bytes[i] + key[i % key.length]) % 256).toString(16).padStart(2, '0');
  }
  const chunks = encoded.match(/.{1,16}/g) || [''];
  return Buffer.from(`loadstring([=[
${BANNER}
local _CHUNKS = {
${chunks.map((chunk) => `    "${chunk}",`).join('\n')}
}
local _K = {${key.join(', ')}}
local _N = #_K
local _EXPECT = ${bytes.length}

${LOADER_BODY}
]=])()
`);
}

test('decodes the legacy wrapper, preserves banner, and does not execute Lua', () => {
  const source = Buffer.from('print("legacy")\n');
  const output = deobfuscateLegacy(legacyWrapper(source), {
    banner: BANNER,
    maxSourceBytes: 1024,
  });

  assert.deepEqual(output, Buffer.concat([Buffer.from(`${BANNER}\n`), source]));
  assert.deepEqual(deobfuscateLua(legacyWrapper(source), { banner: BANNER, maxSourceBytes: 1024 }), output);
});

test('rejects altered loader code and payload length mismatches', () => {
  const wrapper = legacyWrapper('return true');
  const alteredLoader = Buffer.from(wrapper.toString().replace('return _chunk(...)', 'os.execute("bad")'));
  assert.throws(() => deobfuscateLegacy(alteredLoader, { banner: BANNER, maxSourceBytes: 1024 }), /loader/);

  const wrongLength = Buffer.from(wrapper.toString().replace('_EXPECT = 11', '_EXPECT = 12'));
  assert.throws(() => deobfuscateLegacy(wrongLength, { banner: BANNER, maxSourceBytes: 1024 }), /panjang payload/);
});

test('rejects payloads larger than the configured limit', () => {
  assert.throws(
    () => deobfuscateLegacy(legacyWrapper('return true'), { banner: BANNER, maxSourceBytes: 2 }),
    /melebihi batas/,
  );
});
