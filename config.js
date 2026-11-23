'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readLocalConfig() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function load() {
  const local = readLocalConfig();
  const token =
    process.env.DISCORD_TOKEN ||
    process.env.TOKEN ||
    process.env.BOT_TOKEN ||
    local.token;
  if (!token) {
    throw new Error(
      'Token belum di-set: isi env DISCORD_TOKEN (atau TOKEN / BOT_TOKEN) atau buat config.json berisi {"token": "..."}'
    );
  }
  return Object.freeze({
    botToken: token,
    maxHops: 10,
    requestTimeoutMs: 10000,
    // UNSET: belum ada endpoint provider terverifikasi. null != string kosong.
    providerUrl: process.env.BYPASS_PROVIDER_URL || local.providerUrl || null,
    // UNSET: key JSON di respons provider yang berisi link hasil.
    providerResultKey: process.env.BYPASS_PROVIDER_KEY || local.providerResultKey || null,
    gatedHosts: new Set(
      (process.env.GATED_HOSTS || (Array.isArray(local.gatedHosts) ? local.gatedHosts.join(',') : ''))
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean)
    ),
  });
}

module.exports = { load };
