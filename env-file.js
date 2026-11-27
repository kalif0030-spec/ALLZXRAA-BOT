'use strict';
// Baca file .env (KEY=VALUE per baris) ke process.env. Env yang sudah ada tidak ditimpa.
// Tanpa dependency. Baris kosong dan baris diawali # diabaikan. Tanda kutip di nilai dibuang.
const fs = require('node:fs');

function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = value;
  }
  return out;
}

function loadEnvFile(file, env = process.env, read = fs.readFileSync, exists = fs.existsSync) {
  if (!exists(file)) return 0;
  const values = parseEnv(read(file, 'utf8'));
  let loaded = 0;
  for (const [key, value] of Object.entries(values)) {
    if (env[key] === undefined || env[key] === '') {
      env[key] = value;
      loaded++;
    }
  }
  return loaded;
}

module.exports = { parseEnv, loadEnvFile };
