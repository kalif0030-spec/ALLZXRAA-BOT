'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MODE_CHOICES, obfuscateLua, deobfuscateLua } = require('../lua-obfuscator');

const BANNER = '-- ALLZXRAA test banner';
const options = {
  banner: BANNER,
  key: [7, 42, 19],
  chunkHexChars: 16,
  maxSourceBytes: 1024,
};

test('preserves the legacy output format when no mode is supplied', () => {
  const source = Buffer.from('print("legacy")\n');
  const output = obfuscateLua(source, options);

  assert.match(output, /^loadstring\(\[=\[\n-- ALLZXRAA test banner\nlocal _CHUNKS = \{/);
  assert.deepEqual(deobfuscateLua(Buffer.from(output), options), Buffer.concat([Buffer.from(`${BANNER}\n`), source]));
});

test('exposes all requested modes and round-trips each without executing Lua', () => {
  const source = Buffer.from('return "hello"\r\n-- preserved source\r\n');

  assert.deepEqual(MODE_CHOICES.map(({ value }) => value), ['allzxraa', 'luaraph', 'vm', 'combined']);
  for (const mode of MODE_CHOICES.map(({ value }) => value)) {
    const output = Buffer.from(obfuscateLua(source, options, mode));
    const decoded = deobfuscateLua(output, options);
    assert.deepEqual(decoded, Buffer.concat([Buffer.from(`${BANNER}\n`), source]), `${mode} mode`);
  }
});

test('rejects altered wrapper loaders and unknown formats', () => {
  const output = obfuscateLua(Buffer.from('return true'), options, 'luaraph');
  const altered = Buffer.from(output.replace('return _FUNC(...)', 'os.execute("bad")'));

  assert.throws(() => deobfuscateLua(altered, options), /loader LuaRaph-style tidak valid/);
  assert.throws(() => deobfuscateLua(Buffer.from('print("not wrapped")'), options), /format obfuscate.*tidak dikenali/);
});

test('enforces input and output limits', () => {
  assert.throws(
    () => obfuscateLua(Buffer.alloc(options.maxSourceBytes + 1, 0x61), options, 'allzxraa'),
    /source terlalu besar/,
  );
  assert.throws(
    () => deobfuscateLua(Buffer.from(obfuscateLua(Buffer.from('return true'), options)), {
      ...options,
      maxSourceBytes: 2,
    }),
    /melebihi batas/,
  );
});
