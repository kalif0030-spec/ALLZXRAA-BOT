'use strict';

function load() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    throw new Error('DISCORD_TOKEN belum di-set');
  }
  return Object.freeze({
    botToken: token,
    maxHops: 10,
    requestTimeoutMs: 10000,
    // UNSET: belum ada endpoint provider terverifikasi. null != string kosong.
    providerUrl: process.env.BYPASS_PROVIDER_URL || null,
    // UNSET: key JSON di respons provider yang berisi link hasil.
    providerResultKey: process.env.BYPASS_PROVIDER_KEY || null,
    gatedHosts: new Set(
      (process.env.GATED_HOSTS || '')
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean)
    ),
  });
}

module.exports = { load };
