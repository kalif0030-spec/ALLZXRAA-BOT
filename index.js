'use strict';

// Satu file: welcome/goodbye, obfuscator Lua multi-mode,
// obfu link aman dari SSRF, sistem XP + level + leaderboard, dan invite log.

const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const cards = require('./cards');
const {
  MODE_CHOICES,
  WRAPPER_EXPANSION_LIMIT,
  obfuscateLua,
} = require('./lua-obfuscator');
const {
  ContainerBuilder, SectionBuilder, TextDisplayBuilder, ThumbnailBuilder,
  AttachmentBuilder, Client, EmbedBuilder, Events, GatewayIntentBits,
  ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder, Partials,
} = require('discord.js');
// Setiap balasan bot dapat kartu gambar (lihat info_cards.js). Tanpa @napi-rs/canvas, ini dilewati.
require('./info_cards').install({ cards, discord: require('discord.js') });

// ============ konstanta ============
const COLOR_WELCOME = 0x57f287;
const COLOR_GOODBYE = 0xed4245;
const COLOR_LEVEL = 0xfee75c;
const COLOR_INVITE = 0x5865f2;
const COLOR_FAIL = 0xed4245;
const COLOR_INFO = 0x5865f2;

const CONFIG_FILE = path.join(__dirname, 'config.json');

// Pemisahan bot: BOT_ROLE = level | welcome | obfu, satu proses per bot dengan token sendiri.
// Tanpa BOT_ROLE (atau all) semua fitur jalan dalam satu proses, seperti sebelumnya.
const BOT_ROLE = (process.env.BOT_ROLE || 'all').toLowerCase();
if (!['all', 'level', 'welcome', 'obfu', 'reaction'].includes(BOT_ROLE)) {
  throw new Error(`BOT_ROLE tidak dikenal: ${BOT_ROLE}. Pakai level, welcome, obfu, atau kosongkan.`);
}
const runs = (feature) => BOT_ROLE === 'all' || BOT_ROLE === feature;
// Pemetaan command ke fitur. lock/unlock ikut welcome (manajemen server bersama join/leave/invite).
const COMMAND_FEATURE = {
  level: 'level',
  leaderboard: 'level',
  'level-role': 'level',
  'xp-event': 'level',
  'xp-rate': 'level',
  'xp-only': 'level',
  afk: 'level',
  'afk-admin': 'level',
  lock: 'welcome',
  unlock: 'welcome',
  'obfu-file': 'obfu',
  'obfu-link': 'obfu',
  'reaction-role': 'reaction',
  voice: 'welcome',
};
const XP_DATA_FILE = path.join(__dirname, 'xp-data.json');
const INVITE_DATA_FILE = path.join(__dirname, 'invite-data.json');

// Kunci default diambil persis dari ALLZRA_main.lua (_K), sudah diverifikasi byte-exact.
const DEFAULT_OBFU_KEY = [231, 239, 163, 220, 149, 7, 70, 62, 248, 167, 96, 58, 38, 110, 2, 142, 238, 40, 50, 244, 103, 29, 252, 216];

const SAVE_DELAY_MS = 5000;
const MAX_LEVEL = 1000;
const LEADERBOARD_SIZE = 10;
const MAX_JOIN_RECORDS = 20000;

// ============ config ============
function readLocalConfig() {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function cleanUrl(v) {
  if (typeof v !== 'string' || !v.trim()) return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

function cleanText(v, fallback) {
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

function cleanSnowflake(v) {
  return typeof v === 'string' && /^[0-9]{5,25}$/.test(v.trim()) ? v.trim() : null;
}

function cleanIntArray(v, fallback) {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',').map((s) => s.trim()) : null;
  if (!arr) return fallback;
  const nums = arr.map((x) => Number.parseInt(x, 10));
  if (nums.length === 0 || nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return fallback;
  return nums;
}

function cleanPosInt(v, fallback) {
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function loadConfig() {
  const local = readLocalConfig();
  const pick = (envName, key) => process.env[envName] ?? local[key];

  // Mode per-bot: env TOKEN_<ROLE> dulu, lalu config.json "tokens": { "<role>": "..." }.
  // Mode satu proses: env DISCORD_TOKEN/TOKEN/BOT_TOKEN, lalu config.json "token".
  const localTokens = local.tokens && typeof local.tokens === 'object' ? local.tokens : {};
  const token = BOT_ROLE === 'all'
    ? (process.env.DISCORD_TOKEN || process.env.TOKEN || process.env.BOT_TOKEN || local.token)
    : (process.env[`TOKEN_${BOT_ROLE.toUpperCase()}`] || localTokens[BOT_ROLE]);
  if (!token || (typeof token === 'string' && token.startsWith('ISI_'))) {
    throw new Error(BOT_ROLE === 'all'
      ? 'Token belum di-set: isi env DISCORD_TOKEN (atau TOKEN / BOT_TOKEN) atau isi "token" di config.json'
      : `Token belum di-set untuk BOT_ROLE=${BOT_ROLE}: isi env TOKEN_${BOT_ROLE.toUpperCase()} atau "tokens.${BOT_ROLE}" di config.json`);
  }

  return Object.freeze({
    botToken: token,
    brandName: cleanText(pick('BRAND_NAME', 'brandName'), 'ALLZXRAA'),
    poweredBy: cleanText(pick('POWERED_BY', 'poweredBy'), 'ALLZXRAA COMMUNITY'),
    thumbnailUrl: cleanUrl(pick('THUMBNAIL_URL', 'thumbnailUrl')),
    // UNSET kalau kosong: fitur itu nonaktif dan diberi tahu di log saat start.
    welcomeChannelId: cleanSnowflake(pick('WELCOME_CHANNEL_ID', 'welcomeChannelId')),
    goodbyeChannelId: cleanSnowflake(pick('GOODBYE_CHANNEL_ID', 'goodbyeChannelId')),
    inviteLogChannelId: cleanSnowflake(pick('INVITE_LOG_CHANNEL_ID', 'inviteLogChannelId')),
    // UNSET = notif level naik dikirim ke channel tempat chat, dan /level atau /leaderboard bisa dipakai di mana saja.
    levelUpChannelId: cleanSnowflake(pick('LEVEL_UP_CHANNEL_ID', 'levelUpChannelId')),
    levelCommandChannelId: cleanSnowflake(pick('LEVEL_COMMAND_CHANNEL_ID', 'levelCommandChannelId')),
    // UNSET = XP didapat dari chat di channel mana saja. Kalau diisi, XP hanya dari channel ini.
    xpChannelId: cleanSnowflake(pick('LEVEL_XP_CHANNEL_ID', 'xpChannelId')),
    obfu: Object.freeze({
      key: cleanIntArray(pick('OBFU_KEY', 'obfuKey'), DEFAULT_OBFU_KEY),
      chunkHexChars: 4096,
      maxSourceBytes: Number.parseInt(pick('OBFU_MAX_BYTES', 'obfuMaxBytes'), 10) || 25 * 1024 * 1024,
      requestTimeoutMs: 10000,
    }),
    // Kecepatan naik level: bawaan 1 XP per 60 detik per member. Kebutuhan XP per level ada di cumulativeXp.
    xp: (() => {
      const min = cleanPosInt(pick('XP_MIN', 'xpMin'), 1);
      const max = Math.max(min, cleanPosInt(pick('XP_MAX', 'xpMax'), min));
      return Object.freeze({ min, max, cooldownMs: cleanPosInt(pick('XP_COOLDOWN_SECONDS', 'xpCooldownSeconds'), 60) * 1000 });
    })(),
  });
}

// ============ obfuscator Lua ============
// decode Lua: byte = (hex - K[ki]) % 256, ki berputar lewat seluruh K.
// encode = inversnya. Sudah diverifikasi byte-exact terhadap file asli.
const BANNER = `--[[
  █████╗  ██╗      ██╗      ███████╗ ██╗  ██╗ ██████╗    █████╗    █████╗  
 ██╔══██╗ ██║      ██║      ╚══███╔╝ ╚██╗██╔╝ ██╔══██╗  ██╔══██╗  ██╔══██╗ 
 ███████║ ██║      ██║        ███╔╝   ╚███╔╝  ██████╔╝  ███████║  ███████║ 
 ██╔══██║ ██║      ██║       ███╔╝    ██╔██╗  ██╔══██╗  ██╔══██║  ██╔══██║ 
 ██║  ██║ ███████╗ ███████╗ ███████╗ ██╔╝ ██╗ ██║  ██║  ██║  ██║  ██║  ██║ 
 ╚═╝  ╚═╝ ╚══════╝ ╚══════╝ ╚══════╝ ╚═╝  ╚═╝ ╚═╝  ╚═╝  ╚═╝  ╚═╝  ╚═╝  ╚═╝ 

 ██████╗  ██████╗  ███╗   ███╗ ███╗   ███╗ ██╗   ██╗ ███╗   ██╗ ██╗ ████████╗ ██╗   ██╗ 
██╔════╝ ██╔═══██╗ ████╗ ████║ ████╗ ████║ ██║   ██║ ████╗  ██║ ██║ ╚══██╔══╝ ╚██╗ ██╔╝ 
██║      ██║   ██║ ██╔████╔██║ ██╔████╔██║ ██║   ██║ ██╔██╗ ██║ ██║    ██║     ╚████╔╝  
██║      ██║   ██║ ██║╚██╔╝██║ ██║╚██╔╝██║ ██║   ██║ ██║╚██╗██║ ██║    ██║      ╚██╔╝   
╚██████╗ ╚██████╔╝ ██║ ╚═╝ ██║ ██║ ╚═╝ ██║ ╚██████╔╝ ██║ ╚████║ ██║    ██║       ██║    
 ╚═════╝  ╚═════╝  ╚═╝     ╚═╝ ╚═╝     ╚═╝  ╚═════╝  ╚═╝  ╚═══╝ ╚═╝    ╚═╝       ╚═╝    
          Script ini diproteksi — Obfu Lua by ALLZXRAA COMMUNITY
]]`;

function obfuscate(sourceBuf, cfg, mode = 'allzxraa') {
  return obfuscateLua(sourceBuf, {
    ...cfg.obfu,
    banner: BANNER,
  }, mode);
}

const OBFU_MODE = 'vm2';

// ============ SSRF guard untuk /obfu-link ============
const blocked = new net.BlockList();
[
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
].forEach(([addr, prefix]) => blocked.addSubnet(addr, prefix, 'ipv4'));
[
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10],
  ['ff00::', 8],
].forEach(([addr, prefix]) => blocked.addSubnet(addr, prefix, 'ipv6'));

function parseHttpUrl(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return null;
  }
  return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
}

// IPv4-mapped IPv6 (::ffff:1.2.3.4) dicek sebagai IPv4 biasa. Aturan IPv4 tidak boleh dicek lewat aturan IPv6 ::ffff:, karena itu menangkap semua IPv4.
function isBlockedAddress(address, family) {
  let addr = address;
  let fam = family === 6 ? 'ipv6' : 'ipv4';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  if (mapped) {
    addr = mapped[1];
    fam = 'ipv4';
  }
  return blocked.check(addr, fam);
}

// Mengembalikan { ok, reason }. reason menjelaskan kenapa host ditolak, supaya admin bisa mengecek sendiri.
async function resolvePublic(hostname) {
  const bare = hostname.replace(/^\[|\]$/g, '');
  let infos;
  try {
    infos = await dns.lookup(bare, { all: true });
  } catch (err) {
    return { ok: false, reason: `DNS gagal resolve (${err.code || err.message})` };
  }
  if (infos.length === 0) return { ok: false, reason: 'DNS tidak mengembalikan alamat' };
  const bad = infos.find((i) => isBlockedAddress(i.address, i.family));
  if (bad) return { ok: false, reason: `alamat ${bad.address} termasuk jaringan internal` };
  return { ok: true, reason: null };
}

async function fetchTextSafe(raw, { maxBytes, timeoutMs }) {
  const url = parseHttpUrl(raw);
  if (url === null) throw new Error('itu bukan link http(s) yang valid');
  const check = await resolvePublic(url.hostname);
  if (!check.ok) throw new Error(`host ${url.hostname} ditolak: ${check.reason}`);
  let res;
  try {
    res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new Error(`request gagal: ${err.name}`);
  }
  if (!res.ok) throw new Error(`server membalas HTTP ${res.status}`);

  const lenHeader = res.headers.get('content-length');
  if (lenHeader && Number.parseInt(lenHeader, 10) > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`isi terlalu besar (Content-Length ${lenHeader} byte > batas ${maxBytes} byte)`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error('respons tidak punya body yang bisa dibaca');
  const buffers = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`isi terlalu besar (> batas ${maxBytes} byte)`);
    }
    buffers.push(value);
  }
  return Buffer.concat(buffers);
}

// ============ penyimpanan (atomic write + debounce) ============
function createSaver(file, getData) {
  let timer = null;
  function save() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const tmp = file + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(getData()));
      fs.renameSync(tmp, file); // tulis ke tmp dulu, lalu rename: file utama aman kalau mati di tengah
    } catch (err) {
      console.error(`gagal simpan ${path.basename(file)}:`, err.message);
    }
  }
  function schedule() {
    if (timer) return;
    timer = setTimeout(save, SAVE_DELAY_MS);
    timer.unref?.();
  }
  return { save, schedule };
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null; // belum ada file atau rusak: mulai kosong
  }
}

// ============ XP & level ============
// Rumus level = pilihan desain saya: dari level l ke l+1 butuh 5l² + 50l + 100 XP.
const cumulativeXp = [0];
for (let l = 0; l < MAX_LEVEL; l++) {
  cumulativeXp.push(cumulativeXp[l] + 5 * l * l + 50 * l + 100);
}

function levelInfo(xp) {
  let level = 0;
  while (level < MAX_LEVEL && cumulativeXp[level + 1] <= xp) level++;
  const floor = cumulativeXp[level];
  const next = cumulativeXp[level + 1];
  const span = next - floor;
  const into = xp - floor;
  return { level, into, span, toNext: next - xp, ratio: span > 0 ? into / span : 0 };
}

function progressBar(ratio, width = 12) {
  const filled = Math.round(Math.min(1, Math.max(0, ratio)) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// Kunci: `${guildId}:${userId}` -> { xp, lastAt }
const users = new Map();

function loadXpStore() {
  const raw = readJsonFile(XP_DATA_FILE);
  if (!raw || typeof raw.users !== 'object' || raw.users === null) return;
  for (const [key, v] of Object.entries(raw.users)) {
    if (v && Number.isFinite(v.xp) && v.xp >= 0) {
      users.set(key, { xp: Math.floor(v.xp), lastAt: Number.isFinite(v.lastAt) ? v.lastAt : 0 });
    }
  }
}

const xpSaver = createSaver(XP_DATA_FILE, () => ({ users: Object.fromEntries(users) }));

// ============ pengaturan XP per server (admin) ============
// Event XP ganda dan besar XP/cooldown bisa diubah lewat /xp-event dan /xp-rate. Yang tidak diisi memakai cfg.xp.
const XP_SETTINGS_FILE = path.join(__dirname, 'xp-settings.json');
const XP_EVENT_MAX_MULTIPLIER = 10;
const XP_EVENT_MAX_HOURS = 168;
const XP_RATE_MAX = 1000;
const XP_COOLDOWN_MAX_SECONDS = 3600;
const xpSettings = new Map(); // guildId -> { multiplier?, eventEndsAt?, min?, max?, cooldownMs? }

function loadXpSettings() {
  const raw = readJsonFile(XP_SETTINGS_FILE);
  if (!raw || typeof raw.guilds !== 'object' || raw.guilds === null) return;
  for (const [guildId, v] of Object.entries(raw.guilds)) {
    if (!v || typeof v !== 'object') continue;
    const entry = {};
    if (Number.isInteger(v.multiplier) && v.multiplier >= 2 && v.multiplier <= XP_EVENT_MAX_MULTIPLIER) entry.multiplier = v.multiplier;
    if (Number.isFinite(v.eventEndsAt) && v.eventEndsAt > 0) entry.eventEndsAt = v.eventEndsAt;
    if (Number.isInteger(v.min) && Number.isInteger(v.max) && v.min >= 1 && v.max >= v.min && v.max <= XP_RATE_MAX) {
      entry.min = v.min;
      entry.max = v.max;
    }
    if (Number.isInteger(v.cooldownMs) && v.cooldownMs >= 1000 && v.cooldownMs <= XP_COOLDOWN_MAX_SECONDS * 1000) {
      entry.cooldownMs = v.cooldownMs;
    }
    if (Object.keys(entry).length > 0) xpSettings.set(guildId, entry);
  }
}

const xpSettingsSaver = createSaver(XP_SETTINGS_FILE, () => ({ guilds: Object.fromEntries(xpSettings) }));

// Aturan efektif untuk satu server saat ini. Event yang sudah lewat waktunya dianggap tidak aktif.
function xpRulesFor(guildId, now = Date.now()) {
  const s = xpSettings.get(guildId) || {};
  const eventActive = Boolean(s.multiplier && s.eventEndsAt && s.eventEndsAt > now);
  return {
    min: s.min ?? cfg.xp.min,
    max: s.max ?? cfg.xp.max,
    cooldownMs: s.cooldownMs ?? cfg.xp.cooldownMs,
    multiplier: eventActive ? s.multiplier : 1,
    eventEndsAt: eventActive ? s.eventEndsAt : null,
  };
}

// Anti-spam: cuma dapat XP sekali per cooldown per user per server.
// Mengembalikan null kalau masih cooldown. Kalau dapat XP, kembalikan { leveledUp, level }.
function awardXp(guildId, userId, now = Date.now()) {
  const key = `${guildId}:${userId}`;
  const entry = users.get(key) || { xp: 0, lastAt: 0 };
  const rules = xpRulesFor(guildId, now);
  if (now - entry.lastAt < rules.cooldownMs) return null;
  const before = levelInfo(entry.xp).level;
  const base = rules.min + crypto.randomInt(rules.max - rules.min + 1);
  entry.xp += base * rules.multiplier;
  entry.lastAt = now;
  users.set(key, entry);
  xpSaver.schedule();
  const after = levelInfo(entry.xp).level;
  return { leveledUp: after > before, level: after };
}

function guildRanking(guildId) {
  const prefix = `${guildId}:`;
  const rows = [];
  for (const [key, v] of users) {
    if (key.startsWith(prefix)) rows.push({ userId: key.slice(prefix.length), xp: v.xp });
  }
  rows.sort((a, b) => b.xp - a.xp || a.userId.localeCompare(b.userId));
  return rows;
}

// Berikan semua role yang levelnya sudah tercapai dan belum dimiliki. Mengembalikan role yang baru diberikan.
async function applyLevelRoles(guild, userId, level) {
  const due = levelRolesFor(guild.id).filter((r) => r.level <= level);
  if (due.length === 0) return [];
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return [];
  const granted = [];
  for (const r of due) {
    if (member.roles.cache.has(r.roleId)) continue;
    const role = guild.roles.cache.get(r.roleId) ?? (await guild.roles.fetch(r.roleId).catch(() => null));
    if (!role) {
      console.warn(`level role: role ${r.roleId} (level ${r.level}) tidak ditemukan`);
      continue;
    }
    if (!role.editable) {
      console.warn(`level role: bot tidak bisa mengelola role ${role.name} (butuh izin Manage Roles dan role bot di atas role ini)`);
      continue;
    }
    try {
      await member.roles.add(role, `Naik ke level ${level}`);
      granted.push(role);
    } catch (err) {
      console.warn(`level role: gagal memberi ${role.name} (${err.message})`);
    }
  }
  return granted;
}

function levelUpEmbed(user, level, roles = []) {
  const roleLine = roles.length ? `\nRole baru: ${roles.map((r) => `<@&${r.id}>`).join(' ')}` : '';
  return new EmbedBuilder()
    .setColor(COLOR_LEVEL)
    .setAuthor({ name: 'Level Up!', iconURL: user.displayAvatarURL() })
    .setDescription(`Selamat ${user}, kamu naik ke **Level ${level}**!${roleLine}`)
    .setThumbnail(user.displayAvatarURL({ size: 256 }))
    .setFooter({ text: `Powered by ${cfg.poweredBy}` })
    .setTimestamp();
}

function levelCardEmbed(user, guildId) {
  const entry = users.get(`${guildId}:${user.id}`) || { xp: 0 };
  const info = levelInfo(entry.xp);
  const rank = guildRanking(guildId).findIndex((r) => r.userId === user.id) + 1;
  return new EmbedBuilder()
    .setColor(COLOR_LEVEL)
    .setAuthor({ name: `Level Card — ${user.username}`, iconURL: user.displayAvatarURL() })
    .setDescription(`Level **${info.level}**`)
    .addFields(
      { name: 'Total XP', value: `${entry.xp}`, inline: true },
      { name: 'Rank', value: rank > 0 ? `#${rank}` : 'Belum ada', inline: true },
      { name: 'Progress', value: `\`${progressBar(info.ratio)}\` ${Math.floor(info.ratio * 100)}%` },
      { name: 'Ke Level Berikutnya', value: `${info.toNext} XP lagi` }
    )
    .setThumbnail(user.displayAvatarURL({ size: 256 }))
    .setFooter({ text: `Powered by ${cfg.poweredBy}` })
    .setTimestamp();
}

// Gaya dibuat sama dengan Level Card: warna, author, progress bar, dan footer.
function leaderboardEmbed(guild) {
  const rows = guildRanking(guild.id).slice(0, LEADERBOARD_SIZE);
  const medals = ['🥇', '🥈', '🥉'];
  const lines = rows.map((r, i) => {
    const info = levelInfo(r.xp);
    const pos = medals[i] || `**#${i + 1}**`;
    return `${pos} <@${r.userId}> — Level **${info.level}** • ${r.xp} XP\n\`${progressBar(info.ratio, 10)}\` ${Math.floor(info.ratio * 100)}%`;
  });
  const embed = new EmbedBuilder()
    .setColor(COLOR_LEVEL)
    .setAuthor({ name: `Leaderboard — ${guild.name}`, iconURL: guild.iconURL() || undefined })
    .setDescription(lines.length ? lines.join('\n') : 'Belum ada yang dapat XP.')
    .setFooter({ text: `Powered by ${cfg.poweredBy}` })
    .setTimestamp();
  const icon = guild.iconURL();
  if (icon) embed.setThumbnail(icon);
  return embed;
}

// Tampilan leaderboard Components V2 (container + baris dengan avatar). Butuh discord.js yang punya
// builder V2 (tutorial yang kubaca menyebut 14.19.3 atau lebih baru); kalau tidak ada, jatuh ke embed.
const LEADERBOARD_V2_ROWS = 10; // batas Discord 40 komponen per pesan: 10 baris x 3 + container + judul = 32

function leaderboardV2Available() {
  return [ContainerBuilder, SectionBuilder, TextDisplayBuilder, ThumbnailBuilder].every((c) => typeof c === 'function')
    && MessageFlags.IsComponentsV2 !== undefined;
}

async function userAvatarUrl(userId) {
  try {
    const user = client.users.cache.get(userId) ?? await client.users.fetch(userId);
    return user.displayAvatarURL({ extension: 'png', size: 128 });
  } catch {
    return `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(userId) >> 22n) % 6n)}.png`;
  }
}

async function leaderboardContainer(guild) {
  const rows = guildRanking(guild.id).slice(0, Math.min(LEADERBOARD_SIZE, LEADERBOARD_V2_ROWS));
  const avatars = await Promise.all(rows.map((r) => userAvatarUrl(r.userId)));
  const container = new ContainerBuilder()
    .setAccentColor(COLOR_LEVEL)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${guild.name}\n-# Leaderboard level • Powered by ${cfg.poweredBy}`));
  if (rows.length === 0) {
    return container.addTextDisplayComponents(new TextDisplayBuilder().setContent('Belum ada yang dapat XP.'));
  }
  rows.forEach((r, i) => {
    const info = levelInfo(r.xp);
    const text = `**#${i + 1}** • <@${r.userId}> • LVL: ${info.level}\n\`${progressBar(info.ratio, 14)}\` ${Math.floor(info.ratio * 100)}% • ${r.xp} XP`;
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(text))
        .setThumbnailAccessory(new ThumbnailBuilder({ media: { url: avatars[i] } })),
    );
  });
  return container;
}

// ============ invite log ============
// cache per server: code -> { uses, maxUses, inviterId, inviterTag }
const inviteCache = new Map();
// `${guildId}:${inviterId}` -> { invited, left }
const inviteCounts = new Map();
// `${guildId}:${memberId}` -> { inviterId, inviterTag, code, at }
const joinedBy = new Map();

function loadInviteStore() {
  const raw = readJsonFile(INVITE_DATA_FILE);
  if (!raw) return;
  if (raw.counts && typeof raw.counts === 'object') {
    for (const [k, v] of Object.entries(raw.counts)) {
      if (v && Number.isInteger(v.invited) && Number.isInteger(v.left)) inviteCounts.set(k, v);
    }
  }
  if (raw.joins && typeof raw.joins === 'object') {
    for (const [k, v] of Object.entries(raw.joins)) {
      if (v && typeof v.inviterId === 'string') joinedBy.set(k, v);
    }
  }
}

const inviteSaver = createSaver(INVITE_DATA_FILE, () => ({
  counts: Object.fromEntries(inviteCounts),
  joins: Object.fromEntries(joinedBy),
}));

function trimJoinRecords() {
  while (joinedBy.size > MAX_JOIN_RECORDS) {
    joinedBy.delete(joinedBy.keys().next().value);
  }
}

function cacheInvites(guildId, invites) {
  const map = new Map();
  for (const inv of invites.values()) {
    map.set(inv.code, {
      uses: inv.uses ?? 0,
      maxUses: inv.maxUses ?? 0,
      inviterId: inv.inviter?.id ?? null,
      inviterTag: inv.inviter?.tag ?? null,
    });
  }
  inviteCache.set(guildId, map);
}

// Cari invite yang pemakaiannya naik sejak terakhir dicek.
// Kalau tidak ketemu, cek invite sekali-pakai yang sudah dihapus otomatis Discord.
function detectInviter(guildId, fresh) {
  const cache = inviteCache.get(guildId) || new Map();
  for (const inv of fresh.values()) {
    const prev = cache.get(inv.code);
    if ((inv.uses ?? 0) > (prev ? prev.uses : 0)) {
      return { code: inv.code, inviterId: inv.inviter?.id ?? null, inviterTag: inv.inviter?.tag ?? null };
    }
  }
  for (const [code, prev] of cache) {
    if (!fresh.has(code) && prev.maxUses === 1) {
      return { code, inviterId: prev.inviterId, inviterTag: prev.inviterTag };
    }
  }
  return null;
}

// Invite log: embed seperti biasa, dan kartu galaksi dikirim sebagai lampiran terpisah (bukan di dalam embed).
async function postInviteLog(guild, embed, card) {
  if (!cfg.inviteLogChannelId) return;
  const channel = await guild.channels.fetch(cfg.inviteLogChannelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.warn(`invite: channel ${cfg.inviteLogChannelId} tidak ditemukan atau bukan channel teks`);
    return;
  }
  const payload = { embeds: [embed] };
  if (cards.isAvailable()) {
    try {
      const png = await cards.renderInfoCard({
        title: card.title,
        subtitle: card.subtitle,
        accent: '#' + COLOR_INVITE.toString(16).padStart(6, '0'),
      });
      payload.files = [new AttachmentBuilder(png, { name: 'invite.png' })];
    } catch (err) {
      console.error('kartu invite gagal, kirim embed saja:', err.message);
    }
  }
  await channel.send(payload).catch((err) => console.error('gagal kirim invite log:', err));
}

function inviteJoinEmbed(member, found, invitedCount, leftCount) {
  const known = found && found.inviterId;
  const embed = new EmbedBuilder()
    .setColor(COLOR_INVITE)
    .setAuthor({ name: 'Member Diundang', iconURL: client.user.displayAvatarURL() })
    .setDescription(
      known
        ? `${member} bergabung lewat undangan dari <@${found.inviterId}>.`
        : `${member} bergabung, tapi pengundangnya tidak diketahui.`
    )
    .addFields(
      { name: 'Pengundang', value: known ? `<@${found.inviterId}> (${found.inviterTag})` : 'Tidak diketahui', inline: true },
      { name: 'Kode Invite', value: found ? `\`${found.code}\`` : 'Tidak diketahui', inline: true }
    );
  if (known) {
    embed.addFields(
      { name: 'Total Diundang', value: `${invitedCount}`, inline: true },
      { name: 'Masih Bertahan', value: `${Math.max(0, invitedCount - leftCount)}`, inline: true }
    );
  } else {
    embed.addFields({
      name: 'Catatan',
      value: 'Bisa karena vanity URL, invite yang sudah terhapus, atau bot belum punya izin Kelola Server.',
    });
  }
  embed.setThumbnail(member.user.displayAvatarURL({ size: 256 })).setFooter(footerFor(member)).setTimestamp();
  return embed;
}

function inviteLeaveEmbed(member, rec, invitedCount, leftCount) {
  return new EmbedBuilder()
    .setColor(COLOR_GOODBYE)
    .setAuthor({ name: 'Member Keluar (Diundang)', iconURL: client.user.displayAvatarURL() })
    .setDescription(`**${member.user.tag}** keluar. Dia diundang oleh <@${rec.inviterId}>.`)
    .addFields(
      { name: 'Pengundang', value: `<@${rec.inviterId}> (${rec.inviterTag})`, inline: true },
      { name: 'Total Diundang', value: `${invitedCount}`, inline: true },
      { name: 'Sudah Keluar', value: `${leftCount}`, inline: true }
    )
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .setFooter(footerFor(member))
    .setTimestamp();
}

async function initGuildInvites(guild) {
  try {
    cacheInvites(guild.id, await guild.invites.fetch());
  } catch (err) {
    console.warn(`invite: gagal ambil daftar invite server ${guild.id} (${err.message}). Pastikan bot punya izin Kelola Server.`);
  }
}

async function handleInviteJoin(member) {
  const guild = member.guild;
  let fresh = null;
  try {
    fresh = await guild.invites.fetch();
  } catch (err) {
    console.warn(`invite: gagal ambil invite saat join (${err.message})`);
  }
  let found = null;
  if (fresh) {
    found = detectInviter(guild.id, fresh);
    cacheInvites(guild.id, fresh);
  }

  let invitedCount = 0;
  let leftCount = 0;
  if (found && found.inviterId && found.inviterId !== member.id) {
    const ck = `${guild.id}:${found.inviterId}`;
    const c = inviteCounts.get(ck) || { invited: 0, left: 0 };
    c.invited += 1;
    inviteCounts.set(ck, c);
    joinedBy.set(`${guild.id}:${member.id}`, {
      inviterId: found.inviterId,
      inviterTag: found.inviterTag,
      code: found.code,
      at: Date.now(),
    });
    trimJoinRecords();
    inviteSaver.schedule();
    invitedCount = c.invited;
    leftCount = c.left;
  }
  const joinFound = found && found.inviterId !== member.id ? found : null;
  await postInviteLog(
    guild,
    inviteJoinEmbed(member, joinFound, invitedCount, leftCount),
    {
      title: `${cardName(member.user)} bergabung`,
      subtitle: joinFound ? `Diundang oleh ${joinFound.inviterTag}` : 'Pengundang tidak diketahui',
    },
  );
}

async function handleInviteLeave(member) {
  const key = `${member.guild.id}:${member.id}`;
  const rec = joinedBy.get(key);
  if (!rec) return; // tidak tercatat (join sebelum fitur ini aktif, atau pengundang tidak diketahui)
  joinedBy.delete(key);
  const ck = `${member.guild.id}:${rec.inviterId}`;
  const c = inviteCounts.get(ck) || { invited: 0, left: 0 };
  c.left += 1;
  inviteCounts.set(ck, c);
  inviteSaver.schedule();
  await postInviteLog(member.guild, inviteLeaveEmbed(member, rec, c.invited, c.left), {
    title: `${cardName(member.user)} keluar`,
    subtitle: `Sisa member: ${member.guild.memberCount}`,
  });
}

// Serialisasi per server supaya dua join yang datang bersamaan tidak saling menghitung dobel.
const guildLocks = new Map();
function withGuildLock(guildId, fn) {
  const prev = guildLocks.get(guildId) || Promise.resolve();
  const next = prev.then(() => fn()).catch((err) => console.error('invite lock error:', err));
  guildLocks.set(guildId, next);
  return next;
}

// ============ welcome / goodbye / obfu ============
function footerFor(member) {
  return { text: `Powered by ${cfg.poweredBy}`, iconURL: member.user.displayAvatarURL() };
}

function baseEmbed(color) {
  const e = new EmbedBuilder().setColor(color).setTimestamp();
  if (cfg.thumbnailUrl) e.setThumbnail(cfg.thumbnailUrl);
  return e;
}

function cardAvatarUrl(user) {
  return user.displayAvatarURL({ extension: 'png', size: 256, forceStatic: true });
}

function cardName(user) {
  return user.globalName ?? user.username;
}

async function sendWelcome(member) {
  if (!cfg.welcomeChannelId) return;
  const channel = await member.guild.channels.fetch(cfg.welcomeChannelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.warn(`welcome: channel ${cfg.welcomeChannelId} tidak ditemukan atau bukan channel teks`);
    return;
  }
  if (cards.isAvailable()) {
    try {
      const png = await cards.renderWelcomeCard({
        avatarUrl: cardAvatarUrl(member.user),
        name: cardName(member.user),
        memberCount: member.guild.memberCount,
      });
      // Teks (dengan mention) di atas gambar, tanpa embed.
      await channel.send({
        content: `## Selamat datang ${member} di **${member.guild.name}**!\nSemoga betah ya, kamu member ke-${member.guild.memberCount}.`,
        files: [new AttachmentBuilder(png, { name: 'welcome.png' })],
        allowedMentions: { parse: [] },
      });
      return;
    } catch (err) {
      console.error('welcome card gagal, pakai embed biasa:', err);
    }
  }
  const embed = baseEmbed(COLOR_WELCOME)
    .setAuthor({ name: 'Member Baru Bergabung', iconURL: client.user.displayAvatarURL() })
    .setDescription(`Selamat datang di **${member.guild.name}**, ${member}!`)
    .addFields(
      { name: 'Pengguna', value: `${member.user.tag}`, inline: true },
      { name: 'Member ke', value: `${member.guild.memberCount}`, inline: true }
    )
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .setFooter(footerFor(member));
  await channel.send({ embeds: [embed] }).catch((err) => console.error('gagal kirim welcome:', err));
}

async function sendGoodbye(member) {
  if (!cfg.goodbyeChannelId) return;
  const channel = await member.guild.channels.fetch(cfg.goodbyeChannelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.warn(`goodbye: channel ${cfg.goodbyeChannelId} tidak ditemukan atau bukan channel teks`);
    return;
  }
  if (cards.isAvailable()) {
    try {
      const png = await cards.renderGoodbyeCard({
        avatarUrl: cardAvatarUrl(member.user),
        name: cardName(member.user),
        memberCount: member.guild.memberCount,
      });
      await channel.send({
        content: `## **${cardName(member.user)}** telah keluar dari server\nSampai jumpa lagi! ❤️`,
        files: [new AttachmentBuilder(png, { name: 'goodbye.png' })],
        allowedMentions: { parse: [] },
      });
      return;
    } catch (err) {
      console.error('goodbye card gagal, pakai embed biasa:', err);
    }
  }
  const embed = baseEmbed(COLOR_GOODBYE)
    .setAuthor({ name: 'Member Keluar', iconURL: client.user.displayAvatarURL() })
    .setDescription(`**${member.user.tag}** telah meninggalkan **${member.guild.name}**.`)
    .addFields({ name: 'Sisa Member', value: `${member.guild.memberCount}`, inline: true })
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .setFooter(footerFor(member));
  await channel.send({ embeds: [embed] }).catch((err) => console.error('gagal kirim goodbye:', err));
}

function obfuscateWithFallback(buf, cfg, mode) {
  try {
    return { out: Buffer.from(obfuscate(buf, cfg, mode), 'utf8'), usedMode: mode, fallbackReason: null };
  } catch (err) {
    // vm2 hanya menerima subset Lua dan batas 256 instruksi. Script di luar itu jatuh ke allzxraa (Lua penuh).
    if (mode !== 'vm2') throw err;
    const reason = err.message || String(err);
    return { out: Buffer.from(obfuscate(buf, cfg, 'allzxraa'), 'utf8'), usedMode: 'allzxraa', fallbackReason: reason };
  }
}

// Balasan obfuscate dikirim sebagai teks biasa; info_cards.js mengubahnya jadi kartu gambar tanpa embed.
// Kartu hasil obfuscate memakai avatar dan nama pemohon seperti kartu /level. Kalau renderer tidak ada,
// dikirim teks biasa (info_cards.js lalu mengubahnya jadi kartu gambar).
async function obfuPayload(interaction, { ok, title, lines, files = [] }) {
  const payload = { content: '', embeds: [], files: [...files] };
  if (cards.isAvailable()) {
    try {
      const png = await cards.renderObfuCard({
        avatarUrl: cardAvatarUrl(interaction.user),
        requester: cardName(interaction.user),
        ok,
        title,
        lines,
      });
      payload.files.unshift(new AttachmentBuilder(png, { name: 'obfu.png' }));
      return payload;
    } catch (err) {
      console.error('obfu card gagal, kirim teks:', err.message);
    }
  }
  payload.content = [title, ...lines, `Request by ${cardName(interaction.user)}`].join('\n');
  return payload;
}

async function obfuSuccessMessage(interaction, usedMode, originalBytes, outputBytes, elapsedMs, fallbackReason, files) {
  const modeName = MODE_CHOICES.find((choice) => choice.value === usedMode)?.name || usedMode;
  const lines = [
    `${cfg.brandName} — mode obfuscate: ${modeName}.`,
    `Ukuran Asli ${originalBytes} byte • Ukuran Hasil ${outputBytes} byte • Waktu ${(elapsedMs / 1000).toFixed(2)}s`,
  ];
  if (fallbackReason) lines.push(`vm2 menolak script ini (${fallbackReason}), dipakai allzxraa.`);
  return obfuPayload(interaction, { ok: true, title: 'Obfuscate Successful', lines, files });
}

async function obfuFailMessage(interaction, note) {
  return obfuPayload(interaction, { ok: false, title: 'Obfuscate Failed', lines: [String(note).slice(0, 300)] });
}

async function handleObfuFile(interaction) {
  await interaction.deferReply();
  const attachment = interaction.options.getAttachment('file', true);
  const mode = OBFU_MODE; // satu-satunya mode: VM asli (vm2), tanpa pilihan lain
  if (attachment.size > cfg.obfu.maxSourceBytes) {
    await interaction.editReply(await obfuFailMessage(interaction, `File terlalu besar: ${attachment.size} byte > batas ${cfg.obfu.maxSourceBytes} byte.`));
    return;
  }
  const started = Date.now();
  let buf;
  try {
    const res = await fetch(attachment.url, { signal: AbortSignal.timeout(cfg.obfu.requestTimeoutMs) });
    if (!res.ok) throw new Error(`gagal mengambil attachment (HTTP ${res.status})`);
    buf = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    await interaction.editReply(await obfuFailMessage(interaction, `Gagal membaca file: ${err.message || err.name}`));
    return;
  }
  try {
    const { out: outBuf, usedMode, fallbackReason } = obfuscateWithFallback(buf, cfg, mode);
    const name = attachment.name.replace(/\.lua$/i, '') + '.obf.lua';
    await interaction.editReply(await obfuSuccessMessage(interaction, usedMode, buf.length, outBuf.length, Date.now() - started, fallbackReason, [new AttachmentBuilder(outBuf, { name })]));
  } catch (err) {
    await interaction.editReply(await obfuFailMessage(interaction, err.message || String(err)));
  }
}

async function handleObfuLink(interaction) {
  await interaction.deferReply();
  const url = interaction.options.getString('url', true);
  const mode = OBFU_MODE; // satu-satunya mode: VM asli (vm2), tanpa pilihan lain
  const started = Date.now();
  let buf;
  try {
    buf = await fetchTextSafe(url, { maxBytes: cfg.obfu.maxSourceBytes, timeoutMs: cfg.obfu.requestTimeoutMs });
  } catch (err) {
    await interaction.editReply(await obfuFailMessage(interaction, `Gagal mengambil link: ${err.message}`));
    return;
  }
  try {
    const { out: outBuf, usedMode, fallbackReason } = obfuscateWithFallback(buf, cfg, mode);
    await interaction.editReply(await obfuSuccessMessage(interaction, usedMode, buf.length, outBuf.length, Date.now() - started, fallbackReason, [new AttachmentBuilder(outBuf, { name: 'obfuscated.lua' })]));
  } catch (err) {
    await interaction.editReply(await obfuFailMessage(interaction, err.message || String(err)));
  }
}

// ============ peringatan token di file repo ============
// Pola kasar untuk token bot Discord: tiga bagian dipisah titik.
const TOKEN_PATTERN = /[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/;

function warnIfSecretsInRepoFiles() {
  const exampleFile = path.join(__dirname, 'config.example.json');
  for (const file of [__filename, exampleFile]) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (TOKEN_PATTERN.test(text)) {
      console.warn(
        `PERINGATAN KEAMANAN: ${path.basename(file)} berisi sesuatu yang mirip token Discord. ` +
        'Jangan commit file ini ke repo. Hapus tokennya, lalu Reset Token di Discord Developer Portal karena token itu sudah terekspos.'
      );
    }
  }
  const example = readJsonFile(exampleFile);
  if (example && typeof example.token === 'string' && example.token.trim() && !example.token.startsWith('ISI_')) {
    console.warn('PERINGATAN KEAMANAN: config.example.json berisi nilai "token" yang bukan placeholder. Kosongkan nilai itu sebelum di-push.');
  }
}

// ============ role hadiah level (/level-role) ============
const LEVEL_ROLES_FILE = path.join(__dirname, 'level-roles.json');
const levelRoleStore = new Map(); // guildId -> Map<level, roleId>

function loadLevelRoles() {
  const raw = readJsonFile(LEVEL_ROLES_FILE);
  if (!raw || typeof raw !== 'object') return;
  for (const [guildId, map] of Object.entries(raw)) {
    if (!cleanSnowflake(guildId) || !map || typeof map !== 'object') continue;
    const m = new Map();
    for (const [lvl, roleId] of Object.entries(map)) {
      const level = Number.parseInt(lvl, 10);
      if (Number.isInteger(level) && level >= 1 && level <= MAX_LEVEL && cleanSnowflake(String(roleId))) {
        m.set(level, String(roleId));
      }
    }
    levelRoleStore.set(guildId, m);
  }
}

const levelRoleSaver = createSaver(LEVEL_ROLES_FILE, () =>
  Object.fromEntries([...levelRoleStore].map(([g, m]) => [g, Object.fromEntries(m)])));

function levelRolesFor(guildId) {
  const m = levelRoleStore.get(guildId) ?? new Map();
  return [...m.entries()].map(([level, roleId]) => ({ level, roleId })).sort((a, b) => a.level - b.level);
}

async function handleLevelRole(interaction) {
  const guild = interaction.guild;
  const reply = (description, color = COLOR_LEVEL) => interaction.reply({
    embeds: [new EmbedBuilder().setColor(color).setDescription(description).setFooter({ text: `Powered by ${cfg.poweredBy}` })],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
  if (!guild) return reply('Perintah ini cuma bisa dipakai di server.', COLOR_FAIL);
  const isAdmin = guild.ownerId === interaction.user.id
    || Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
  if (!isAdmin) return reply('Cuma owner atau admin yang bisa atur role level.', COLOR_FAIL);

  const sub = interaction.options.getSubcommand();
  const roles = levelRoleStore.get(guild.id) ?? new Map();

  if (sub === 'list') {
    const rows = levelRolesFor(guild.id).map((r) => `Level **${r.level}** → <@&${r.roleId}>`);
    return reply(rows.length ? rows.join('\n') : 'Belum ada role hadiah level.');
  }

  const level = interaction.options.getInteger('level', true);
  if (sub === 'remove') {
    if (!roles.has(level)) return reply(`Level ${level} belum punya role hadiah.`, COLOR_FAIL);
    roles.delete(level);
    levelRoleStore.set(guild.id, roles);
    levelRoleSaver.save();
    return reply(`Role hadiah level ${level} dihapus.`);
  }

  // sub === 'set'
  const role = interaction.options.getRole('role', true);
  if (role.managed || role.id === guild.id) return reply('Role itu tidak bisa dipakai sebagai hadiah.', COLOR_FAIL);
  if (!role.editable) {
    return reply('Bot tidak bisa mengelola role itu. Pastikan bot punya izin Manage Roles dan role bot ada di atas role tersebut.', COLOR_FAIL);
  }
  roles.set(level, role.id);
  levelRoleStore.set(guild.id, roles);
  levelRoleSaver.save();
  return reply(`Level ${level} sekarang memberi role <@&${role.id}>.`);
}
// ============ akhir role hadiah level ============

// ============ channel khusus level ============
// Mengembalikan channel teks dengan id itu, atau null kalau tidak ada / bukan channel teks.
async function resolveTextChannel(guild, channelId) {
  const channel = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null);
  return channel && channel.isTextBased() ? channel : null;
}

// Kalau channelId di-set dan perintah dipakai di channel lain, balas ephemeral dan kembalikan false.
function allowedInChannel(interaction, channelId) {
  if (!channelId || interaction.channelId === channelId) return true;
  interaction.reply({ content: `Perintah ini cuma bisa dipakai di <#${channelId}>.`, flags: MessageFlags.Ephemeral }).catch(() => {});
  return false;
}

// ============ /level dan /leaderboard ============
async function userCardInfo(userId) {
  try {
    const user = client.users.cache.get(userId) ?? await client.users.fetch(userId);
    return { name: cardName(user), avatarUrl: cardAvatarUrl(user) };
  } catch {
    return {
      name: 'Unknown',
      avatarUrl: `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(userId) >> 22n) % 6n)}.png`,
    };
  }
}

async function levelCardFile(user, guildId) {
  const entry = users.get(`${guildId}:${user.id}`) || { xp: 0 };
  const info = levelInfo(entry.xp);
  const rank = guildRanking(guildId).findIndex((r) => r.userId === user.id) + 1;
  const png = await cards.renderLevelCard({
    avatarUrl: cardAvatarUrl(user),
    name: cardName(user),
    level: info.level,
    rank,
    xp: entry.xp,
    into: info.into,
    span: info.span,
    ratio: info.ratio,
  });
  return new AttachmentBuilder(png, { name: 'level.png' });
}

async function leaderboardCardFile(guild) {
  const top = guildRanking(guild.id).slice(0, LEADERBOARD_SIZE);
  const rows = await Promise.all(top.map(async (r) => {
    const info = levelInfo(r.xp);
    const who = await userCardInfo(r.userId);
    return { name: who.name, avatarUrl: who.avatarUrl, level: info.level, xp: r.xp, ratio: info.ratio };
  }));
  const png = await cards.renderLeaderboardCard({ guildName: guild.name, rows });
  return new AttachmentBuilder(png, { name: 'leaderboard.png' });
}

async function handleLevel(interaction) {
  if (!interaction.guild) return interaction.reply({ content: 'Perintah ini cuma bisa dipakai di server.', flags: MessageFlags.Ephemeral });
  if (!allowedInChannel(interaction, cfg.levelCommandChannelId)) return;
  const target = interaction.options.getUser('user') ?? interaction.user;
  if (cards.isAvailable()) {
    await interaction.deferReply(); // render gambar + unduh avatar bisa lewat 3 detik
    try {
      const file = await levelCardFile(target, interaction.guild.id);
      return await interaction.editReply({ files: [file], allowedMentions: { parse: [] } });
    } catch (err) {
      console.error('level card gagal, pakai embed biasa:', err);
      return interaction.editReply({ embeds: [levelCardEmbed(target, interaction.guild.id)], allowedMentions: { parse: [] } });
    }
  }
  return interaction.reply({ embeds: [levelCardEmbed(target, interaction.guild.id)], allowedMentions: { parse: [] } });
}

async function handleLeaderboard(interaction) {
  if (!interaction.guild) return interaction.reply({ content: 'Perintah ini cuma bisa dipakai di server.', flags: MessageFlags.Ephemeral });
  if (!allowedInChannel(interaction, cfg.levelCommandChannelId)) return;
  if (cards.isAvailable()) {
    await interaction.deferReply();
    try {
      const file = await leaderboardCardFile(interaction.guild);
      return await interaction.editReply({ files: [file], allowedMentions: { parse: [] } });
    } catch (err) {
      console.error('leaderboard card gagal, pakai embed biasa:', err);
      return interaction.editReply({ embeds: [leaderboardEmbed(interaction.guild)], allowedMentions: { parse: [] } });
    }
  }
  if (leaderboardV2Available()) {
    try {
      const container = await leaderboardContainer(interaction.guild);
      return await interaction.reply({ components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
    } catch (err) {
      console.error('leaderboard V2 gagal, pakai embed biasa:', err.message);
    }
  }
  return interaction.reply({ embeds: [leaderboardEmbed(interaction.guild)], allowedMentions: { parse: [] } });
}
// ============ akhir /level dan /leaderboard ============

// ============ lock & unlock channel ============
function isServerAdmin(interaction) {
  return interaction.guild.ownerId === interaction.user.id
    || Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
}

// Khusus owner server: dipakai untuk /xp-event dan /xp-rate.
function isServerOwner(interaction) {
  return interaction.guild.ownerId === interaction.user.id;
}

async function setChannelLock(interaction, locked) {
  if (!interaction.guild) return interaction.reply({ content: 'Perintah ini cuma bisa dipakai di server.', flags: MessageFlags.Ephemeral });
  if (!isServerAdmin(interaction)) return interaction.reply({ content: 'Cuma owner atau admin yang bisa pakai command ini.', flags: MessageFlags.Ephemeral });
  const channel = interaction.channel;
  if (typeof channel?.permissionOverwrites?.edit !== 'function') {
    return interaction.reply({ content: 'Channel ini tidak bisa dikunci.', flags: MessageFlags.Ephemeral });
  }
  const me = interaction.guild.members.me ?? (await interaction.guild.members.fetchMe().catch(() => null));
  if (!me || !channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageChannels)) {
    return interaction.reply({ content: 'Bot butuh izin Manage Channels di channel ini.', flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply();
  await channel.permissionOverwrites.edit(
    interaction.guild.roles.everyone,
    { SendMessages: locked ? false : null }, // null = kembali ke aturan default channel
    { reason: `${locked ? 'Lock' : 'Unlock'} oleh ${interaction.user.tag}` },
  );
  await interaction.editReply({
    content: locked ? '🔒 Channel dikunci. Member tidak bisa kirim pesan.' : '🔓 Channel dibuka lagi.',
  });
}

async function handleLock(interaction) { return setChannelLock(interaction, true); }
async function handleUnlock(interaction) { return setChannelLock(interaction, false); }
// ============ akhir lock & unlock ============

// ============ AFK ============
const AFK_FILE = path.join(__dirname, 'afk-data.json');
const AFK_MAX_MENTIONS = 3;
const afkMap = new Map(); // `${guildId}:${userId}` -> { reason, since }

function loadAfk() {
  const raw = readJsonFile(AFK_FILE);
  if (!raw || typeof raw !== 'object') return;
  for (const [k, v] of Object.entries(raw)) {
    if (v && typeof v.reason === 'string' && Number.isFinite(v.since)) {
      afkMap.set(k, { reason: v.reason, since: v.since });
    }
  }
}

const afkSaver = createSaver(AFK_FILE, () => Object.fromEntries(afkMap));

function afkTime(ms) {
  return `<t:${Math.floor(ms / 1000)}:R>`;
}

async function handleAfk(interaction) {
  if (!interaction.guild) return interaction.reply({ content: 'Perintah ini cuma bisa dipakai di server.', flags: MessageFlags.Ephemeral });
  const guildId = interaction.guild.id;
  const sub = interaction.options.getSubcommand();

  if (sub === 'set') {
    const reason = (interaction.options.getString('alasan') ?? '').trim().slice(0, 200) || 'AFK';
    afkMap.set(`${guildId}:${interaction.user.id}`, { reason, since: Date.now() });
    afkSaver.save();
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(COLOR_INFO)
        .setDescription(`💤 ${interaction.user} sekarang AFK: ${reason}`)
        .setFooter({ text: `Powered by ${cfg.poweredBy}` })
        .setTimestamp()],
      allowedMentions: { parse: [] },
    });
  }

  if (sub === 'remove') {
    const target = interaction.options.getUser('user') ?? interaction.user;
    if (target.id !== interaction.user.id && !isServerAdmin(interaction)) {
      return interaction.reply({ content: 'Cuma owner atau admin yang bisa menghapus AFK member lain.', flags: MessageFlags.Ephemeral });
    }
    const existed = afkMap.delete(`${guildId}:${target.id}`);
    if (existed) afkSaver.save();
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(existed ? COLOR_INFO : COLOR_FAIL)
        .setDescription(existed ? `✅ Status AFK ${target} dihapus.` : `${target} tidak sedang AFK.`)
        .setFooter({ text: `Powered by ${cfg.poweredBy}` })
        .setTimestamp()],
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }

  // sub === 'list'
  const prefix = `${guildId}:`;
  const rows = [...afkMap.entries()]
    .filter(([k]) => k.startsWith(prefix))
    .sort((a, b) => a[1].since - b[1].since)
    .slice(0, 25)
    .map(([k, v]) => `• <@${k.slice(prefix.length)}> — ${v.reason} (sejak ${afkTime(v.since)})`);
  const total = [...afkMap.keys()].filter((k) => k.startsWith(prefix)).length;
  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(COLOR_INFO)
      .setTitle(`Sedang AFK (${total})`)
      .setDescription(rows.length ? rows.join('\n') : 'Tidak ada yang sedang AFK.')
      .setFooter({ text: `Powered by ${cfg.poweredBy}` })
      .setTimestamp()],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

// Dipanggil dari MessageCreate. Menghapus AFK saat pemiliknya chat lagi, dan memberi tahu saat AFK user di-mention.
async function afkHandle(message) {
  const guildId = message.guild.id;
  const selfKey = `${guildId}:${message.author.id}`;
  if (afkMap.has(selfKey)) {
    afkMap.delete(selfKey);
    afkSaver.save();
    await message.reply({
      content: `Selamat datang kembali, ${message.author}! Status AFK kamu dihapus.`,
      allowedMentions: { users: [message.author.id], repliedUser: false },
    }).catch(() => {});
  }
  const targets = [...message.mentions.users.values()]
    .filter((u) => !u.bot && u.id !== message.author.id)
    .slice(0, AFK_MAX_MENTIONS);
  for (const u of targets) {
    const rec = afkMap.get(`${guildId}:${u.id}`);
    if (!rec) continue;
    await message.channel.send({
      embeds: [new EmbedBuilder()
        .setColor(COLOR_INFO)
        .setDescription(`💤 ${u} lagi AFK: ${rec.reason}\nSejak ${afkTime(rec.since)}.`)
        .setFooter({ text: `Powered by ${cfg.poweredBy}` })
        .setTimestamp()],
      allowedMentions: { parse: [] },
    }).catch(() => {});
  }
}
// ============ akhir AFK ============

// ============ /xp-only preview: lihat channel yang akan dikunci (tanpa mengubah apa pun) ============
const XP_ONLY_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const XP_ONLY_FLAGS = [PermissionFlagsBits.SendMessages, PermissionFlagsBits.SendMessagesInThreads];

function botCanEditChannel(channel) {
  const me = channel.guild.members.me;
  return !!me && channel.permissionsFor(me).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels]);
}

function fmtWib(ms) {
  return new Date(ms).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'short' }) + ' WIB';
}

function xpAdminDenied(interaction) {
  if (!interaction.guild) return interaction.reply({ content: 'Perintah ini cuma bisa dipakai di server.', flags: MessageFlags.Ephemeral });
  if (!isServerOwner(interaction)) return interaction.reply({ content: 'Cuma owner server yang bisa atur XP.', flags: MessageFlags.Ephemeral });
  return null;
}

async function handleXpEvent(interaction) {
  const denied = xpAdminDenied(interaction);
  if (denied) return denied;
  const guildId = interaction.guild.id;
  const sub = interaction.options.getSubcommand();
  const now = Date.now();

  if (sub === 'start') {
    const multiplier = interaction.options.getInteger('multiplier', true);
    const hours = interaction.options.getInteger('jam', true);
    const endsAt = now + hours * 3600 * 1000;
    xpSettings.set(guildId, { ...(xpSettings.get(guildId) || {}), multiplier, eventEndsAt: endsAt });
    xpSettingsSaver.save();
    return interaction.reply({ content: `Event XP x${multiplier} aktif selama ${hours} jam, sampai ${fmtWib(endsAt)}.`, allowedMentions: { parse: [] } });
  }

  if (sub === 'stop') {
    const current = xpSettings.get(guildId) || {};
    const { multiplier, eventEndsAt, ...rest } = current;
    if (Object.keys(rest).length > 0) xpSettings.set(guildId, rest); else xpSettings.delete(guildId);
    xpSettingsSaver.save();
    return interaction.reply({ content: 'Event XP dihentikan. XP kembali normal.', allowedMentions: { parse: [] } });
  }

  // status
  const rules = xpRulesFor(guildId, now);
  const text = rules.eventEndsAt
    ? `Event XP x${rules.multiplier} aktif sampai ${fmtWib(rules.eventEndsAt)}.`
    : 'Tidak ada event XP yang aktif sekarang.';
  return interaction.reply({ content: text, allowedMentions: { parse: [] } });
}

async function handleXpRate(interaction) {
  const denied = xpAdminDenied(interaction);
  if (denied) return denied;
  const guildId = interaction.guild.id;
  const sub = interaction.options.getSubcommand();

  if (sub === 'set') {
    const min = interaction.options.getInteger('min', true);
    const max = interaction.options.getInteger('max', true);
    const cooldownSec = interaction.options.getInteger('cooldown');
    if (max < min) {
      return interaction.reply({ content: `Maksimum (${max}) tidak boleh lebih kecil dari minimum (${min}).`, flags: MessageFlags.Ephemeral });
    }
    const current = xpSettings.get(guildId) || {};
    const next = { ...current, min, max };
    if (cooldownSec !== null) next.cooldownMs = cooldownSec * 1000;
    xpSettings.set(guildId, next);
    xpSettingsSaver.save();
    const rules = xpRulesFor(guildId);
    return interaction.reply({ content: `XP per pesan: ${rules.min}-${rules.max}. Cooldown: ${rules.cooldownMs / 1000} detik.`, allowedMentions: { parse: [] } });
  }

  if (sub === 'reset') {
    const current = xpSettings.get(guildId) || {};
    const { min, max, cooldownMs, ...rest } = current;
    if (Object.keys(rest).length > 0) xpSettings.set(guildId, rest); else xpSettings.delete(guildId);
    xpSettingsSaver.save();
    return interaction.reply({ content: 'XP per pesan dan cooldown dikembalikan ke bawaan.', allowedMentions: { parse: [] } });
  }

  // status
  const rules = xpRulesFor(guildId);
  return interaction.reply({ content: `XP per pesan: ${rules.min}-${rules.max}. Cooldown: ${rules.cooldownMs / 1000} detik.`, allowedMentions: { parse: [] } });
}

function xpOnlyPlan(guild) {
  const everyone = guild.roles.everyone;
  const plan = { toLock: [], skipped: [] };
  for (const ch of guild.channels.cache.values()) {
    if (!XP_ONLY_CHANNEL_TYPES.includes(ch.type)) continue;
    if (ch.id === cfg.xpChannelId) continue;
    if (!botCanEditChannel(ch)) {
      plan.skipped.push({ ch, reason: 'bot tidak punya izin View dan Manage Channels' });
      continue;
    }
    const ow = ch.permissionOverwrites.cache.get(everyone.id);
    const hasOwnRule = !!ow && XP_ONLY_FLAGS.some((f) => ow.allow.has(f) || ow.deny.has(f));
    if (hasOwnRule) plan.skipped.push({ ch, reason: 'sudah punya aturan Send Messages sendiri' });
    else plan.toLock.push(ch);
  }
  return plan;
}

function listChannels(channels, max = 25) {
  if (channels.length === 0) return '-';
  const shown = channels.slice(0, max).map((c) => `${c}`).join(', ');
  return channels.length > max ? `${shown} dan ${channels.length - max} lagi` : shown;
}

async function handleXpOnly(interaction) {
  if (!interaction.guild) return interaction.reply({ content: 'Perintah ini cuma bisa dipakai di server.', flags: MessageFlags.Ephemeral });
  if (!isServerAdmin(interaction)) return interaction.reply({ content: 'Cuma owner atau admin yang bisa pakai command ini.', flags: MessageFlags.Ephemeral });
  if (!cfg.xpChannelId) {
    return interaction.reply({ content: 'Isi `xpChannelId` (env LEVEL_XP_CHANNEL_ID) dulu, bot perlu tahu channel XP.', flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    await interaction.guild.channels.fetch();
    const plan = xpOnlyPlan(interaction.guild);
    const lines = [
      '**Rencana (tidak ada yang diubah)**',
      `Akan dikunci (${plan.toLock.length}): ${listChannels(plan.toLock)}`,
      `Dilewati (${plan.skipped.length}):`,
    ];
    for (const x of plan.skipped.slice(0, 15)) lines.push(`• ${x.ch}: ${x.reason}`);
    if (plan.skipped.length > 15) lines.push(`• dan ${plan.skipped.length - 15} lagi`);
    return await interaction.editReply({ content: lines.join('\n').slice(0, 1900) });
  } catch (err) {
    console.error('xp-only error:', err);
    return interaction.editReply({ content: `Gagal: ${err.message}` }).catch(() => {});
  }
}
// ============ akhir /xp-only ============

// ============ bot ============
warnIfSecretsInRepoFiles();
const cfg = loadConfig();
loadXpStore();
loadXpSettings();
loadInviteStore();
loadLevelRoles();
loadAfk();

const ROLE_INTENTS = {
  level: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  welcome: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildInvites, GatewayIntentBits.GuildVoiceStates],
  obfu: [GatewayIntentBits.Guilds],
  reaction: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessageReactions],
};

const client = new Client({
  // Partials: reaction pada pesan lama dan di luar cache tetap diterima.
  partials: BOT_ROLE === 'all' || BOT_ROLE === 'reaction' ? [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User] : [],
  intents: BOT_ROLE !== 'all' ? ROLE_INTENTS[BOT_ROLE] : [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // welcome/goodbye & invite log: aktifkan "Server Members Intent"
    GatewayIntentBits.GuildInvites, // invite log: lacak invite dan pemakaiannya
    GatewayIntentBits.GuildVoiceStates, // voice stay
    GatewayIntentBits.GuildMessages, // XP dari chat
    GatewayIntentBits.MessageContent, // tidak lagi dipakai untuk level/lb (sekarang /level dan /leaderboard); boleh dihapus kalau tidak butuh baca isi pesan
  ],
});


// ============ reaction role ============
// messageId -> Map(emojiKey -> { guildId, roleId, channelId }). emojiKey: id untuk emoji server, nama untuk emoji biasa.
const REACTION_FILE = path.join(__dirname, 'reaction-roles.json');
const reactionRoles = new Map();

function loadReactionRoles() {
  const raw = readJsonFile(REACTION_FILE);
  if (!raw || typeof raw.messages !== 'object' || raw.messages === null) return;
  for (const [messageId, emojis] of Object.entries(raw.messages)) {
    if (!emojis || typeof emojis !== 'object') continue;
    const m = new Map();
    for (const [key, v] of Object.entries(emojis)) {
      if (v && typeof v.guildId === 'string' && typeof v.roleId === 'string' && typeof v.channelId === 'string') {
        m.set(key, { guildId: v.guildId, roleId: v.roleId, channelId: v.channelId });
      }
    }
    if (m.size > 0) reactionRoles.set(messageId, m);
  }
}

const reactionSaver = createSaver(REACTION_FILE, () => ({
  messages: Object.fromEntries([...reactionRoles].map(([id, m]) => [id, Object.fromEntries(m)])),
}));

function emojiKeyOf(emoji) {
  return emoji.id ?? emoji.name;
}

// Input: "👍" -> "👍", "<:nama:123>" -> "123". Dipakai untuk mencocokkan dengan emojiKeyOf.
function emojiKeyFromInput(text) {
  const custom = /^<a?:\w+:(\d+)>$/.exec(text);
  return custom ? custom[1] : text;
}

async function applyReaction(reaction, user, add) {
  if (user.bot) return;
  if (reaction.partial) await reaction.fetch().catch(() => null);
  const message = reaction.message?.partial ? await reaction.message.fetch().catch(() => null) : reaction.message;
  if (!message || !message.guild) return;
  const entry = reactionRoles.get(message.id)?.get(emojiKeyOf(reaction.emoji));
  if (!entry || entry.guildId !== message.guild.id) return;

  const guild = message.guild;
  const member = await guild.members.fetch(user.id).catch(() => null);
  const role = await guild.roles.fetch(entry.roleId).catch(() => null);
  if (!member || !role) return;

  const me = guild.members.me ?? await guild.members.fetch(client.user.id).catch(() => null);
  if (!me || role.position >= me.roles.highest.position) {
    console.warn(`reaction-role: role ${role.name} tidak bisa diatur bot (di atas role bot atau bot tidak punya izin)`);
    return;
  }
  try {
    if (add) await member.roles.add(role);
    else await member.roles.remove(role);
  } catch (err) {
    console.error('reaction-role gagal:', err.message);
  }
}

async function handleReactionRole(interaction) {
  if (!interaction.guild) return interaction.reply({ content: 'Perintah ini cuma bisa dipakai di server.', flags: MessageFlags.Ephemeral });
  if (!isServerAdmin(interaction)) return interaction.reply({ content: 'Cuma owner atau admin yang bisa atur reaction role.', flags: MessageFlags.Ephemeral });
  const guild = interaction.guild;
  const sub = interaction.options.getSubcommand();
  const fail = (text) => interaction.reply({ content: text, flags: MessageFlags.Ephemeral });

  if (sub === 'add') {
    const channel = interaction.options.getChannel('kanal', true);
    const messageId = interaction.options.getString('message_id', true).trim();
    const emojiText = interaction.options.getString('emoji', true).trim();
    const role = interaction.options.getRole('role', true);
    if (!/^\d{17,20}$/.test(messageId)) return fail('ID pesan tidak valid.');
    if (!channel.isTextBased()) return fail('Kanal harus channel teks.');
    if (role.managed || role.id === guild.id) return fail('Role ini tidak bisa diberikan lewat reaction.');
    const me = guild.members.me ?? await guild.members.fetch(client.user.id).catch(() => null);
    if (!me || !me.permissions.has(PermissionFlagsBits.ManageRoles) || role.position >= me.roles.highest.position) {
      return fail('Bot harus punya izin Manage Roles dan role-nya harus di atas role yang mau diberikan.');
    }
    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (!message) return fail('Pesan itu tidak ditemukan di kanal yang dipilih.');
    try {
      await message.react(emojiText);
    } catch (err) {
      return fail(`Emoji tidak bisa dipasang: ${err.message}`);
    }
    const emojis = reactionRoles.get(messageId) || new Map();
    emojis.set(emojiKeyFromInput(emojiText), { guildId: guild.id, roleId: role.id, channelId: channel.id });
    reactionRoles.set(messageId, emojis);
    reactionSaver.save();
    return interaction.reply({ content: `Reaction role aktif: ${emojiText} memberi <@&${role.id}> di pesan ini.`, allowedMentions: { parse: [] } });
  }

  if (sub === 'panel') {
    const channel = interaction.options.getChannel('kanal', true);
    const title = interaction.options.getString('judul', true).slice(0, 256);
    const desc = (interaction.options.getString('deskripsi') ?? '').slice(0, 1000);
    if (!channel.isTextBased()) return fail('Kanal harus channel teks.');

    const pairs = [];
    for (let i = 1; i <= 4; i++) {
      const emojiText = interaction.options.getString(`emoji_${i}`)?.trim() ?? null;
      const role = interaction.options.getRole(`role_${i}`);
      if (!emojiText && !role) continue;
      if (!emojiText || !role) return fail(`Pasangan ke-${i}: emoji dan role harus diisi berdua.`);
      pairs.push({ emojiText, key: emojiKeyFromInput(emojiText), role });
    }
    if (pairs.length === 0) return fail('Isi minimal satu pasangan emoji dan role.');
    if (new Set(pairs.map((p) => p.key)).size !== pairs.length) return fail('Emoji tidak boleh dipakai dua kali di satu panel.');

    const me = guild.members.me ?? await guild.members.fetch(client.user.id).catch(() => null);
    for (const p of pairs) {
      if (p.role.managed || p.role.id === guild.id) return fail(`Role ${p.role.name} tidak bisa diberikan lewat reaction.`);
      if (!me || !me.permissions.has(PermissionFlagsBits.ManageRoles) || p.role.position >= me.roles.highest.position) {
        return fail('Bot harus punya izin Manage Roles dan role-nya harus di atas semua role di panel.');
      }
    }

    const body = [desc, ...pairs.map((p) => `${p.emojiText} — <@&${p.role.id}>`)].filter(Boolean).join('\n\n');
    const embed = new EmbedBuilder().setTitle(title).setDescription(body).setColor(COLOR_INFO);
    const panel = await channel.send({ embeds: [embed], keepEmbed: true, allowedMentions: { parse: [] } }).catch(() => null);
    if (!panel) return fail('Panel gagal dikirim ke kanal itu.');

    const emojis = new Map();
    const failedEmoji = [];
    for (const p of pairs) {
      try {
        await panel.react(p.emojiText);
        emojis.set(p.key, { guildId: guild.id, roleId: p.role.id, channelId: channel.id });
      } catch {
        failedEmoji.push(p.emojiText);
      }
    }
    if (emojis.size > 0) {
      reactionRoles.set(panel.id, emojis);
      reactionSaver.save();
    }
    const note = failedEmoji.length ? ` Emoji yang gagal dipasang: ${failedEmoji.join(' ')}.` : '';
    return interaction.reply({ content: `Panel dibuat di <#${channel.id}> dengan ID pesan ${panel.id}.${note}`, allowedMentions: { parse: [] } });
  }

  if (sub === 'remove') {
    const messageId = interaction.options.getString('message_id', true).trim();
    const emojiText = interaction.options.getString('emoji', true).trim();
    const emojis = reactionRoles.get(messageId);
    const key = emojiKeyFromInput(emojiText);
    if (!emojis || !emojis.has(key)) return fail('Tidak ada reaction role dengan pesan dan emoji itu.');
    emojis.delete(key);
    if (emojis.size === 0) reactionRoles.delete(messageId);
    reactionSaver.save();
    return interaction.reply({ content: `Reaction role ${emojiText} dihapus. Emoji di pesan tidak ikut dihapus.`, allowedMentions: { parse: [] } });
  }

  // list
  const lines = [];
  for (const [messageId, emojis] of reactionRoles) {
    for (const [key, entry] of emojis) {
      if (entry.guildId !== guild.id) continue;
      lines.push(`pesan ${messageId} • emoji ${key} → <@&${entry.roleId}> • <#${entry.channelId}>`);
    }
  }
  if (lines.length === 0) return interaction.reply({ content: 'Belum ada reaction role di server ini.', flags: MessageFlags.Ephemeral });
  return interaction.reply({ content: lines.slice(0, 20).join('\n'), allowedMentions: { parse: [] } });
}

loadReactionRoles();

// ============ voice stay (bot tetap di voice channel) ============
// Pakai paket @discordjs/voice. Dimuat lazy: kalau belum terpasang, bot tetap jalan dan voice dinonaktifkan.
const VOICE_FILE = path.join(__dirname, 'voice-state.json');
const VOICE_REJOIN_DELAY_MS = 10_000;
const VOICE_WATCH_MS = 60_000;
let voiceLib = null;
try {
  voiceLib = require('@discordjs/voice');
} catch {
  voiceLib = null;
}
const musicOff = /^(off|0|false|no)$/i.test(process.env.MUSIC_ENABLED ?? '');
const music = require('./music').createMusic({
  voiceLib: musicOff ? null : voiceLib,
  dir: process.env.MUSIC_DIR || path.join(__dirname, 'music'),
  volume: process.env.MUSIC_VOLUME,
});
const voiceStates = new Map(); // guildId -> { channelId }
const voiceConnections = new Map(); // guildId -> connection
const voiceRejoinTimers = new Map(); // guildId -> timer

function loadVoiceState() {
  const raw = readJsonFile(VOICE_FILE);
  if (!raw || typeof raw.guilds !== 'object' || raw.guilds === null) return;
  for (const [guildId, v] of Object.entries(raw.guilds)) {
    if (v && typeof v.channelId === 'string') voiceStates.set(guildId, { channelId: v.channelId });
  }
}

const voiceSaver = createSaver(VOICE_FILE, () => ({ guilds: Object.fromEntries(voiceStates) }));

function destroyVoice(guildId) {
  music.stop(guildId);
  const conn = voiceConnections.get(guildId);
  voiceConnections.delete(guildId);
  if (conn) {
    try {
      conn.destroy();
    } catch {
      // koneksi sudah mati
    }
  }
}

// Berhenti stay total: lupakan channel, batalkan jadwal masuk lagi, putus koneksi, simpan ke file.
// Dipakai untuk /voice leave dan saat bot di-kick dari voice.
function forgetVoice(guildId) {
  voiceStates.delete(guildId);
  const timer = voiceRejoinTimers.get(guildId);
  if (timer) clearTimeout(timer);
  voiceRejoinTimers.delete(guildId);
  destroyVoice(guildId);
  voiceSaver.save();
}

function scheduleRejoin(guildId) {
  if (voiceRejoinTimers.has(guildId) || !voiceStates.has(guildId)) return;
  const timer = setTimeout(async () => {
    voiceRejoinTimers.delete(guildId);
    const st = voiceStates.get(guildId);
    if (!st) return;
    const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
    if (guild) await joinStay(guild, st.channelId);
  }, VOICE_REJOIN_DELAY_MS);
  voiceRejoinTimers.set(guildId, timer);
}

// Masuk ke voice channel dan tetap di sana. Putus koneksi: masuk lagi otomatis. Di-kick dari voice atau /voice leave: berhenti.
async function joinStay(guild, channelId) {
  if (!voiceLib) return { ok: false, reason: 'paket @discordjs/voice belum terpasang di server bot' };
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isVoiceBased()) return { ok: false, reason: 'channel voice itu tidak ditemukan' };
  const me = guild.members.me ?? await guild.members.fetch(client.user.id).catch(() => null);
  if (!me || !me.permissionsIn(channel).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect])) {
    return { ok: false, reason: 'bot butuh izin View Channel dan Connect di channel itu' };
  }

  destroyVoice(guild.id);
  const conn = voiceLib.joinVoiceChannel({
    channelId,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: !music.enabled,
  });
  voiceConnections.set(guild.id, conn);
  music.start(guild.id, conn);
  const { VoiceConnectionStatus, VoiceConnectionDisconnectReason, entersState } = voiceLib;

  conn.on(VoiceConnectionStatus.Disconnected, async (_oldState, newState) => {
    if (voiceConnections.get(guild.id) !== conn) return;
    // Close code 4014 = bot dikeluarkan dari channel (kick, channel dihapus) atau dipindah.
    const removedCode = newState.reason === VoiceConnectionDisconnectReason.WebSocketClose && newState.closeCode === 4014;
    try {
      await Promise.race([
        entersState(conn, VoiceConnectionStatus.Signalling, 5_000),
        entersState(conn, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      return; // dipindah channel atau server voice berganti: library menyambung sendiri
    } catch {
      // tidak pulih sendiri
    }
    if (voiceConnections.get(guild.id) !== conn) return; // sudah dihentikan sengaja selama menunggu
    const stillInVoice = Boolean((guild.members.me ?? await guild.members.fetch(client.user.id).catch(() => null))?.voice?.channelId);
    if (removedCode && !stillInVoice) {
      console.log(`voice: bot dikeluarkan dari voice di guild ${guild.id}, berhenti stay sampai /voice join lagi`);
      forgetVoice(guild.id);
      return;
    }
    // putus karena jaringan atau voice server: masuk lagi setelah jeda
    destroyVoice(guild.id);
    scheduleRejoin(guild.id);
  });
  conn.on(VoiceConnectionStatus.Destroyed, () => {
    if (voiceConnections.get(guild.id) !== conn) return; // dihentikan sengaja (leave atau join ulang)
    voiceConnections.delete(guild.id);
    scheduleRejoin(guild.id);
  });
  return { ok: true, channelName: channel.name };
}

async function handleVoice(interaction) {
  if (!interaction.guild) return interaction.reply({ content: 'Perintah ini cuma bisa dipakai di server.', flags: MessageFlags.Ephemeral });
  if (!isServerAdmin(interaction)) return interaction.reply({ content: 'Cuma owner atau admin yang bisa atur voice bot.', flags: MessageFlags.Ephemeral });
  const guild = interaction.guild;
  const sub = interaction.options.getSubcommand();
  const fail = (text) => interaction.reply({ content: text, flags: MessageFlags.Ephemeral });

  if (sub === 'join') {
    const channel = interaction.options.getChannel('kanal', true);
    voiceStates.set(guild.id, { channelId: channel.id });
    const res = await joinStay(guild, channel.id);
    if (!res.ok) {
      voiceStates.delete(guild.id);
      return fail(`Bot tidak bisa masuk voice: ${res.reason}.`);
    }
    voiceSaver.save();
    const musicNote = !music.enabled ? ''
      : music.trackCount() > 0 ? ` Lagu diputar acak dari folder music (${music.trackCount()} file).`
        : ' Folder music masih kosong, taruh file lagu di sana supaya bot mulai memutar.';
    return interaction.reply({ content: `Bot sekarang stay di voice ${res.channelName}. Bot tetap di sana sampai di-kick dari voice atau kamu pakai /voice leave. Kalau cuma putus koneksi, bot masuk lagi otomatis.${musicNote}`, allowedMentions: { parse: [] } });
  }

  if (sub === 'leave') {
    forgetVoice(guild.id);
    return interaction.reply({ content: 'Bot keluar dari voice dan tidak akan masuk lagi sampai diatur ulang.', allowedMentions: { parse: [] } });
  }

  // status
  const st = voiceStates.get(guild.id);
  if (!st) return interaction.reply({ content: 'Bot tidak sedang stay di voice.', allowedMentions: { parse: [] } });
  const conn = voiceConnections.get(guild.id);
  const status = conn ? conn.state.status : 'belum terhubung';
  const playing = music.nowPlaying(guild.id);
  return interaction.reply({ content: `Bot stay di channel ${st.channelId}. Status: ${status}.${playing ? ` Sedang memutar: ${playing}.` : ''}`, allowedMentions: { parse: [] } });
}

loadVoiceState();

const commands = [
  new SlashCommandBuilder()
    .setName('obfu-file')
    .setDescription('Obfuscate file Lua ke VM asli (vm2)')
    .addAttachmentOption((o) => o.setName('file').setDescription('File .lua yang mau di-obfuscate').setRequired(true)),
  new SlashCommandBuilder()
    .setName('obfu-link')
    .setDescription('Obfuscate source Lua dari link ke VM asli (vm2)')
    .addStringOption((o) => o.setName('url').setDescription('Link raw berisi source Lua').setRequired(true)),
  new SlashCommandBuilder()
    .setName('level')
    .setDescription('Lihat level dan XP kamu (atau member lain)')
    .addUserOption((o) => o.setName('user').setDescription('Member lain (kosong = kamu)'))
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Lihat leaderboard level server ini')
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('level-role')
    .setDescription('Atur role hadiah tiap level')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addSubcommand((sub) => sub.setName('set').setDescription('Pasang role hadiah untuk level tertentu')
      .addIntegerOption((o) => o.setName('level').setDescription('Level 1-1000').setRequired(true).setMinValue(1).setMaxValue(MAX_LEVEL))
      .addRoleOption((o) => o.setName('role').setDescription('Role yang diberikan').setRequired(true)))
    .addSubcommand((sub) => sub.setName('remove').setDescription('Hapus role hadiah untuk level tertentu')
      .addIntegerOption((o) => o.setName('level').setDescription('Level 1-1000').setRequired(true).setMinValue(1).setMaxValue(MAX_LEVEL)))
    .addSubcommand((sub) => sub.setName('list').setDescription('Lihat semua role hadiah level')),
  new SlashCommandBuilder()
    .setName('afk-admin')
    .setDescription('Hapus status AFK member lain (admin)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addSubcommand((sub) => sub.setName('remove').setDescription('Hapus status AFK member tertentu')
      .addUserOption((o) => o.setName('user').setDescription('Member yang AFK-nya mau dihapus').setRequired(true))),
  new SlashCommandBuilder()
    .setName('lock')
    .setDescription('Kunci channel ini: member tidak bisa kirim pesan (admin)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('unlock')
    .setDescription('Buka lagi channel yang dikunci (admin)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('afk')
    .setDescription('Kelola status AFK')
    .addSubcommand((sub) => sub.setName('set').setDescription('Tandai dirimu AFK')
      .addStringOption((o) => o.setName('alasan').setDescription('Alasan AFK').setMaxLength(200)))
    .addSubcommand((sub) => sub.setName('remove').setDescription('Hapus status AFK kamu sendiri'))
    .addSubcommand((sub) => sub.setName('list').setDescription('Lihat siapa yang sedang AFK di server ini'))
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('xp-only')
    .setDescription('Kunci kirim pesan di channel selain channel XP (admin)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addSubcommand((sub) => sub.setName('preview').setDescription('Lihat channel yang akan dikunci, tanpa mengubah apa pun')),
  new SlashCommandBuilder()
    .setName('xp-event')
    .setDescription('Atur event XP ganda (admin)')
    .setDefaultMemberPermissions(0)
    .setDMPermission(false)
    .addSubcommand((sub) => sub.setName('start').setDescription('Mulai event XP ganda')
      .addIntegerOption((o) => o.setName('multiplier').setDescription('Pengali XP, misal 2 untuk x2').setRequired(true).setMinValue(2).setMaxValue(XP_EVENT_MAX_MULTIPLIER))
      .addIntegerOption((o) => o.setName('jam').setDescription('Lama event dalam jam').setRequired(true).setMinValue(1).setMaxValue(XP_EVENT_MAX_HOURS)))
    .addSubcommand((sub) => sub.setName('stop').setDescription('Hentikan event XP sekarang'))
    .addSubcommand((sub) => sub.setName('status').setDescription('Lihat event XP yang sedang aktif')),
  new SlashCommandBuilder()
    .setName('xp-rate')
    .setDescription('Atur besar XP per pesan dan cooldown (admin)')
    .setDefaultMemberPermissions(0)
    .setDMPermission(false)
    .addSubcommand((sub) => sub.setName('set').setDescription('Atur XP minimum, maksimum, dan cooldown')
      .addIntegerOption((o) => o.setName('min').setDescription('XP minimum per pesan').setRequired(true).setMinValue(1).setMaxValue(XP_RATE_MAX))
      .addIntegerOption((o) => o.setName('max').setDescription('XP maksimum per pesan').setRequired(true).setMinValue(1).setMaxValue(XP_RATE_MAX))
      .addIntegerOption((o) => o.setName('cooldown').setDescription('Jeda antar XP dalam detik (kosong = tidak diubah)').setMinValue(1).setMaxValue(XP_COOLDOWN_MAX_SECONDS)))
    .addSubcommand((sub) => sub.setName('reset').setDescription('Kembalikan XP dan cooldown ke bawaan'))
    .addSubcommand((sub) => sub.setName('status').setDescription('Lihat XP per pesan dan cooldown sekarang')),
  new SlashCommandBuilder()
    .setName('reaction-role')
    .setDescription('Atur reaction role (admin)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addSubcommand((sub) => sub.setName('add').setDescription('Pasang reaction role di sebuah pesan')
      .addChannelOption((o) => o.setName('kanal').setDescription('Kanal pesannya').setRequired(true).addChannelTypes(ChannelType.GuildText))
      .addStringOption((o) => o.setName('message_id').setDescription('ID pesan').setRequired(true))
      .addStringOption((o) => o.setName('emoji').setDescription('Emoji, misal 👍 atau emoji server').setRequired(true))
      .addRoleOption((o) => o.setName('role').setDescription('Role yang diberikan').setRequired(true)))
    .addSubcommand((sub) => sub.setName('remove').setDescription('Hapus reaction role dari sebuah pesan')
      .addStringOption((o) => o.setName('message_id').setDescription('ID pesan').setRequired(true))
      .addStringOption((o) => o.setName('emoji').setDescription('Emoji yang dihapus').setRequired(true)))
    .addSubcommand((sub) => {
      sub.setName('panel').setDescription('Posting panel embed dengan beberapa reaction role')
        .addChannelOption((o) => o.setName('kanal').setDescription('Kanal tujuan panel').setRequired(true).addChannelTypes(ChannelType.GuildText))
        .addStringOption((o) => o.setName('judul').setDescription('Judul panel').setRequired(true))
        .addStringOption((o) => o.setName('emoji_1').setDescription('Emoji pertama').setRequired(true))
        .addRoleOption((o) => o.setName('role_1').setDescription('Role untuk emoji pertama').setRequired(true));
      sub.addStringOption((o) => o.setName('deskripsi').setDescription('Teks di atas daftar role (opsional)').setMaxLength(1000));
      for (let i = 2; i <= 4; i++) {
        sub.addStringOption((o) => o.setName(`emoji_${i}`).setDescription(`Emoji ke-${i} (opsional)`));
        sub.addRoleOption((o) => o.setName(`role_${i}`).setDescription(`Role untuk emoji ke-${i} (opsional)`));
      }
      return sub;
    })
    .addSubcommand((sub) => sub.setName('list').setDescription('Lihat reaction role yang aktif')),
  new SlashCommandBuilder()
    .setName('voice')
    .setDescription('Bot stay di voice channel (admin)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addSubcommand((sub) => sub.setName('join').setDescription('Bot masuk dan stay di voice channel ini')
      .addChannelOption((o) => o.setName('kanal').setDescription('Voice channel').setRequired(true).addChannelTypes(ChannelType.GuildVoice)))
    .addSubcommand((sub) => sub.setName('leave').setDescription('Bot keluar dari voice dan berhenti stay'))
    .addSubcommand((sub) => sub.setName('status').setDescription('Lihat status stay bot')),
];

if (runs('reaction')) client.on(Events.MessageReactionAdd, (reaction, user) => applyReaction(reaction, user, true).catch((err) => console.error('reaction-role:', err)));
if (runs('reaction')) client.on(Events.MessageReactionRemove, (reaction, user) => applyReaction(reaction, user, false).catch((err) => console.error('reaction-role:', err)));

client.once(Events.ClientReady, async (c) => {
  await c.application.commands.set(commands.filter((cmd) => runs(COMMAND_FEATURE[cmd.name])).map((cmd) => cmd.toJSON()));
  if (runs('welcome')) for (const guild of c.guilds.cache.values()) await initGuildInvites(guild);
  if (runs('welcome') && voiceLib) {
    for (const [guildId, st] of voiceStates) {
      const guild = c.guilds.cache.get(guildId);
      if (!guild) continue;
      const res = await joinStay(guild, st.channelId);
      if (!res.ok) console.warn(`voice: gagal masuk lagi ke ${st.channelId}: ${res.reason}`);
    }
    // pengawas: kalau ada yang belum terhubung dan belum dijadwalkan, jadwalkan masuk lagi
    setInterval(() => {
      for (const guildId of voiceStates.keys()) {
        if (!voiceConnections.has(guildId)) scheduleRejoin(guildId);
      }
    }, VOICE_WATCH_MS).unref();
  }
  console.log(`Login sebagai ${c.user.tag}`);
  if (!cfg.welcomeChannelId) console.warn('welcome: WELCOME_CHANNEL_ID belum di-set, fitur welcome nonaktif');
  if (!cfg.goodbyeChannelId) console.warn('goodbye: GOODBYE_CHANNEL_ID belum di-set, fitur goodbye nonaktif');
  if (!cfg.inviteLogChannelId) console.warn('invite: INVITE_LOG_CHANNEL_ID belum di-set, invite log tidak diposting (hitungan tetap dicatat)');
  if (!cfg.levelUpChannelId) console.warn('level: LEVEL_UP_CHANNEL_ID belum di-set, notif level naik dikirim ke channel chat');
  if (!cfg.xpChannelId) console.warn('level: LEVEL_XP_CHANNEL_ID belum di-set, XP didapat dari chat di channel mana saja');
  if (!cfg.levelCommandChannelId) console.warn('level: LEVEL_COMMAND_CHANNEL_ID belum di-set, /level dan /leaderboard bisa dipakai di channel mana saja');
});

if (runs('welcome')) client.on(Events.GuildCreate, (guild) => {
  initGuildInvites(guild).catch((err) => console.error('GuildCreate invite error:', err));
});

if (runs('welcome')) client.on(Events.InviteCreate, (invite) => {
  const guildId = invite.guild?.id;
  if (!guildId) return;
  const map = inviteCache.get(guildId) || new Map();
  map.set(invite.code, {
    uses: invite.uses ?? 0,
    maxUses: invite.maxUses ?? 0,
    inviterId: invite.inviter?.id ?? null,
    inviterTag: invite.inviter?.tag ?? null,
  });
  inviteCache.set(guildId, map);
});

if (runs('welcome')) client.on(Events.InviteDelete, (invite) => {
  const guildId = invite.guild?.id;
  if (!guildId) return;
  inviteCache.get(guildId)?.delete(invite.code);
});

if (runs('welcome')) client.on(Events.GuildMemberAdd, (member) => {
  sendWelcome(member).catch((err) => console.error('sendWelcome error:', err));
  withGuildLock(member.guild.id, () => handleInviteJoin(member));
});

if (runs('welcome')) client.on(Events.GuildMemberRemove, (member) => {
  sendGoodbye(member).catch((err) => console.error('sendGoodbye error:', err));
  withGuildLock(member.guild.id, () => handleInviteLeave(member));
});

if (runs('level')) client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot || !message.guild) return;
    await afkHandle(message);
    if (cfg.xpChannelId && message.channelId !== cfg.xpChannelId) return;
    const gain = awardXp(message.guild.id, message.author.id);
    if (gain?.leveledUp) {
      const granted = await applyLevelRoles(message.guild, message.author.id, gain.level);
      const target = cfg.levelUpChannelId
        ? await resolveTextChannel(message.guild, cfg.levelUpChannelId)
        : message.channel;
      if (!target) {
        console.warn(`level up: channel ${cfg.levelUpChannelId} tidak ditemukan atau bukan channel teks`);
      } else {
        // Notifikasi naik level pakai kartu profil seperti /level (avatar, level, XP). Kalau render gagal, pakai embed lama.
        const roleText = granted.length ? ` Role baru: ${granted.map((r) => `<@&${r.id}>`).join(' ')}.` : '';
        let card = null;
        try {
          card = await levelCardFile(message.author, message.guild.id);
        } catch (err) {
          console.error('level up card gagal, pakai embed:', err.message);
        }
        const payload = card
          ? {
              content: `Selamat ${message.author}, kamu naik ke Level ${gain.level}!${roleText}`,
              files: [card],
              allowedMentions: { users: [message.author.id], roles: granted.map((r) => r.id) },
            }
          : { embeds: [levelUpEmbed(message.author, gain.level, granted)], allowedMentions: { parse: [] } };
        await target.send(payload).catch((err) => console.error('gagal kirim level up:', err.message));
      }
    }
  } catch (err) {
    console.error('message handler error:', err);
  }
});


client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!runs(COMMAND_FEATURE[interaction.commandName])) return;
  try {
    if (interaction.commandName === 'obfu-file') {
      await handleObfuFile(interaction);
    } else if (interaction.commandName === 'obfu-link') {
      await handleObfuLink(interaction);
    } else if (interaction.commandName === 'level') {
      await handleLevel(interaction);
    } else if (interaction.commandName === 'leaderboard') {
      await handleLeaderboard(interaction);
    } else if (interaction.commandName === 'level-role') {
      await handleLevelRole(interaction);
    } else if (interaction.commandName === 'lock') {
      await handleLock(interaction);
    } else if (interaction.commandName === 'unlock') {
      await handleUnlock(interaction);
    } else if (interaction.commandName === 'afk' || interaction.commandName === 'afk-admin') {
      await handleAfk(interaction);
    } else if (interaction.commandName === 'xp-only') {
      await handleXpOnly(interaction);
    } else if (interaction.commandName === 'xp-event') {
      await handleXpEvent(interaction);
    } else if (interaction.commandName === 'xp-rate') {
      await handleXpRate(interaction);
    } else if (interaction.commandName === 'reaction-role') {
      await handleReactionRole(interaction);
    } else if (interaction.commandName === 'voice') {
      await handleVoice(interaction);
    }
  } catch (err) {
    console.error('interaction error:', err);
    const payload = { content: 'Terjadi error internal, coba lagi.', flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
  }
});

function saveAll() {
  if (runs('level')) {
    xpSaver.save();
    levelRoleSaver.save();
    afkSaver.save();
  }
  if (runs('welcome')) {
    inviteSaver.save();
    voiceSaver.save();
  }
  if (runs('reaction')) reactionSaver.save();
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    saveAll();
    process.exit(0);
  });
}
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));

module.exports = {
  obfuscate, handleObfuFile, handleObfuLink,
  levelInfo, progressBar, awardXp, guildRanking,
  handleLevel, handleLeaderboard, awardXp, users, inviteCache, inviteCounts, joinedBy,
  detectInviter, cacheInvites, handleInviteJoin, handleInviteLeave, saveAll,
  loadConfig, fetchTextSafe,
  applyReaction, handleReactionRole, reactionRoles, emojiKeyFromInput,
  handleVoice, voiceStates, voiceConnections,
};

if (require.main === module) {
  client.login(cfg.botToken);
}
