'use strict';

// Worker thread untuk sandbox deobfuscate. Dijalankan oleh runSandbox() di lua-tools.js.
// Cuma membuka pustaka base, string, table, math, utf8, coroutine, dan debug (io, os, package,
// dofile, loadfile tidak pernah dibuka untuk script target; lihat lua-sandbox-prelude.lua).
// Layer dan log dikirim ke thread utama begitu muncul, supaya tetap ada kalau worker di-terminate.

const fs = require('node:fs');
const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');
const { lua, lauxlib, lualib, to_luastring } = require('fengari');

const pendingLog = [];
function flushLog() {
  if (pendingLog.length > 0) parentPort.postMessage({ t: 'log', lines: pendingLog.splice(0) });
}

function emitLog(L) {
  const bytes = lua.lua_tolstring(L, 1);
  pendingLog.push(bytes ? Buffer.from(bytes).toString('utf8') : '');
  if (pendingLog.length >= 50) flushLog();
  return 0;
}

function emitLayer(L) {
  const n = lua.lua_tointeger(L, 1);
  const bytes = lua.lua_tolstring(L, 2);
  if (bytes) parentPort.postMessage({ t: 'layer', n, bytes: Uint8Array.from(bytes) });
  return 0;
}

function openLib(L, name, opener) {
  if (typeof opener !== 'function') throw new Error(`pustaka ${name} tidak tersedia di fengari`);
  lauxlib.luaL_requiref(L, to_luastring(name), opener, 1);
  lua.lua_pop(L, 1);
}

function lastError(L) {
  try {
    return lua.lua_tojsstring(L, -1);
  } catch {
    return 'error Lua (pesan tidak bisa dibaca)';
  }
}

function main() {
  const { source, limits } = workerData;
  const L = lauxlib.luaL_newstate();
  openLib(L, '_G', lualib.luaopen_base);
  openLib(L, 'string', lualib.luaopen_string);
  openLib(L, 'table', lualib.luaopen_table);
  openLib(L, 'math', lualib.luaopen_math);
  openLib(L, 'utf8', lualib.luaopen_utf8);
  openLib(L, 'coroutine', lualib.luaopen_coroutine);
  openLib(L, 'debug', lualib.luaopen_debug);

  const limitsLua = `__LIMITS = { maxLogLines = ${limits.maxLogLines | 0}, maxLayers = ${limits.maxLayers | 0}, `
    + `maxWaitCalls = ${limits.maxWaitCalls | 0}, maxStringBytes = ${limits.maxStringBytes | 0} }`;
  if (lauxlib.luaL_dostring(L, to_luastring(limitsLua)) !== lua.LUA_OK) throw new Error(`gagal set limit: ${lastError(L)}`);

  lua.lua_pushstring(L, Uint8Array.from(source));
  lua.lua_setglobal(L, to_luastring('__SRC'));
  lua.lua_pushcfunction(L, emitLog);
  lua.lua_setglobal(L, to_luastring('__emit_log'));
  lua.lua_pushcfunction(L, emitLayer);
  lua.lua_setglobal(L, to_luastring('__emit_layer'));

  const prelude = fs.readFileSync(path.join(__dirname, 'lua-sandbox-prelude.lua'));
  if (lauxlib.luaL_loadbuffer(L, prelude, prelude.length, to_luastring('=sandbox')) !== lua.LUA_OK) {
    throw new Error(`prelude tidak bisa dimuat: ${lastError(L)}`);
  }
  if (lua.lua_pcall(L, 0, 0, 0) !== lua.LUA_OK) throw new Error(`harness error: ${lastError(L)}`);
}

let failure = null;
try {
  main();
} catch (err) {
  failure = String((err && err.message) || err);
}
flushLog();
parentPort.postMessage({ t: 'done', error: failure });
