'use strict';

// Satu file: welcome/goodbye, obfuscator (format sama seperti ALLZRA_main.lua),
// obfu link aman dari SSRF, sistem XP + level + leaderboard, dan invite log.

const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const {
  AttachmentBuilder, Client, EmbedBuilder, Events, GatewayIntentBits,
  MessageFlags, PermissionFlagsBits, SlashCommandBuilder,
} = require('discord.js');

// ============ konstanta ============
const COLOR_WELCOME = 0x57f287;
const COLOR_GOODBYE = 0xed4245;
const COLOR_OBFU = 0x5865f2;
const COLOR_LEVEL = 0xfee75c;
const COLOR_INVITE = 0x5865f2;
const COLOR_FAIL = 0xed4245;

const CONFIG_FILE = path.join(__dirname, 'config.json');
const XP_DATA_FILE = path.join(__dirname, 'xp-data.json');
const INVITE_DATA_FILE = path.join(__dirname, 'invite-data.json');

// Kunci default diambil persis dari ALLZRA_main.lua (_K), sudah diverifikasi byte-exact.
const DEFAULT_OBFU_KEY = [231, 239, 163, 220, 149, 7, 70, 62, 248, 167, 96, 58, 38, 110, 2, 142, 238, 40, 50, 244, 103, 29, 252, 216];

const XP_MIN = 15;
const XP_MAX = 25;
const XP_COOLDOWN_MS = 60 * 1000;
const SAVE_DELAY_MS = 5000;
const MAX_LEVEL = 1000;
const LEADERBOARD_SIZE = 10;
const MAX_JOIN_RECORDS = 20000;
// Pemicu teks (tanpa membedakan huruf besar/kecil)
const LEVEL_TRIGGER = /^(allzxraa\s+level|alevel)$/i;
const LEADERBOARD_TRIGGER = /^alb$/i;

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

function loadConfig() {
  const local = readLocalConfig();
  const pick = (envName, key) => process.env[envName] ?? local[key];

  const token = process.env.DISCORD_TOKEN || process.env.TOKEN || process.env.BOT_TOKEN || local.token;
  if (!token) {
    throw new Error('Token belum di-set: isi env DISCORD_TOKEN (atau TOKEN / BOT_TOKEN) atau buat config.json berisi {"token": "..."}');
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
    obfu: Object.freeze({
      key: cleanIntArray(pick('OBFU_KEY', 'obfuKey'), DEFAULT_OBFU_KEY),
      chunkHexChars: 4096,
      maxSourceBytes: Number.parseInt(pick('OBFU_MAX_BYTES', 'obfuMaxBytes'), 10) || 1000000,
      requestTimeoutMs: 10000,
    }),
  });
}

// ============ obfuscator (skema sama persis dengan ALLZRA_main.lua) ============
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

function encodeBytes(buf, key) {
  const n = key.length;
  let ki = 0;
  let hex = '';
  for (let i = 0; i < buf.length; i++) {
    hex += ((buf[i] + key[ki]) % 256).toString(16).padStart(2, '0');
    ki = (ki + 1) % n;
  }
  return hex;
}

function decodeBytes(chunks, key) {
  const n = key.length;
  let ki = 0;
  const total = chunks.reduce((a, c) => a + c.length / 2, 0);
  const out = Buffer.alloc(total);
  let oi = 0;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i += 2) {
      out[oi++] = (parseInt(c.slice(i, i + 2), 16) - key[ki] + 256 * 100) % 256;
      ki = (ki + 1) % n;
    }
  }
  return out;
}

function splitChunks(hex, size) {
  const chunks = [];
  for (let i = 0; i < hex.length; i += size) chunks.push(hex.slice(i, i + size));
  if (chunks.length === 0) chunks.push('');
  return chunks;
}

function buildLuaSource(sourceBuf, cfg) {
  const { key, chunkHexChars } = cfg.obfu;
  const chunks = splitChunks(encodeBytes(sourceBuf, key), chunkHexChars);
  const chunksLua = chunks.map((c) => `    "${c}",`).join('\n');

  return `loadstring([=[
${BANNER}
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

function obfuscate(sourceBuf, cfg) {
  if (!Buffer.isBuffer(sourceBuf)) throw new TypeError('sourceBuf harus Buffer');
  if (sourceBuf.length === 0) throw new Error('source kosong');
  if (sourceBuf.length > cfg.obfu.maxSourceBytes) {
    throw new Error(`source terlalu besar (${sourceBuf.length} byte > batas ${cfg.obfu.maxSourceBytes} byte)`);
  }
  return buildLuaSource(sourceBuf, cfg);
}

// ============ SSRF guard untuk /obfu-link ============
const blocked = new net.BlockList();
[
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
].forEach(([addr, prefix]) => blocked.addSubnet(addr, prefix, 'ipv4'));
[
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10],
  ['ff00::', 8], ['::ffff:0:0', 96],
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

async function hostIsPublic(hostname) {
  const bare = hostname.replace(/^\[|\]$/g, '');
  let infos;
  try {
    infos = await dns.lookup(bare, { all: true });
  } catch {
    return false;
  }
  if (infos.length === 0) return false;
  return infos.every((i) => !blocked.check(i.address, i.family === 6 ? 'ipv6' : 'ipv4'));
}

async function fetchTextSafe(raw, { maxBytes, timeoutMs }) {
  const url = parseHttpUrl(raw);
  if (url === null) throw new Error('itu bukan link http(s) yang valid');
  if (!(await hostIsPublic(url.hostname))) {
    throw new Error(`host ditolak (non-publik atau tidak ter-resolve): ${url.hostname}`);
  }
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

// Anti-spam: cuma dapat XP sekali per XP_COOLDOWN_MS per user per server.
// Mengembalikan null kalau masih cooldown. Kalau dapat XP, kembalikan { leveledUp, level }.
function awardXp(guildId, userId, now = Date.now()) {
  const key = `${guildId}:${userId}`;
  const entry = users.get(key) || { xp: 0, lastAt: 0 };
  if (now - entry.lastAt < XP_COOLDOWN_MS) return null;
  const before = levelInfo(entry.xp).level;
  entry.xp += XP_MIN + crypto.randomInt(XP_MAX - XP_MIN + 1);
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

async function postInviteLog(guild, embed) {
  if (!cfg.inviteLogChannelId) return;
  const channel = await guild.channels.fetch(cfg.inviteLogChannelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.warn(`invite: channel ${cfg.inviteLogChannelId} tidak ditemukan atau bukan channel teks`);
    return;
  }
  await channel.send({ embeds: [embed] }).catch((err) => console.error('gagal kirim invite log:', err));
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
  await postInviteLog(guild, inviteJoinEmbed(member, found && found.inviterId !== member.id ? found : null, invitedCount, leftCount));
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
  await postInviteLog(member.guild, inviteLeaveEmbed(member, rec, c.invited, c.left));
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

async function sendWelcome(member) {
  if (!cfg.welcomeChannelId) return;
  const channel = await member.guild.channels.fetch(cfg.welcomeChannelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.warn(`welcome: channel ${cfg.welcomeChannelId} tidak ditemukan atau bukan channel teks`);
    return;
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
  const embed = baseEmbed(COLOR_GOODBYE)
    .setAuthor({ name: 'Member Keluar', iconURL: client.user.displayAvatarURL() })
    .setDescription(`**${member.user.tag}** telah meninggalkan **${member.guild.name}**.`)
    .addFields({ name: 'Sisa Member', value: `${member.guild.memberCount}`, inline: true })
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .setFooter(footerFor(member));
  await channel.send({ embeds: [embed] }).catch((err) => console.error('gagal kirim goodbye:', err));
}

function obfuResultEmbed(interaction, originalBytes, outputBytes, elapsedMs) {
  return new EmbedBuilder()
    .setColor(COLOR_OBFU)
    .setAuthor({ name: 'Obfuscate Successful', iconURL: client.user.displayAvatarURL() })
    .setDescription(`${cfg.brandName} — obfuscator Lua (format sama seperti ALLZRA_main.lua).`)
    .addFields(
      { name: 'Ukuran Asli', value: `${originalBytes} byte`, inline: true },
      { name: 'Ukuran Hasil', value: `${outputBytes} byte`, inline: true },
      { name: 'Waktu Proses', value: `${(elapsedMs / 1000).toFixed(2)}s`, inline: true }
    )
    .setFooter({ text: `Requested by ${interaction.user.username} • Powered by ${cfg.poweredBy}`, iconURL: interaction.user.displayAvatarURL() })
    .setTimestamp();
}

function obfuFailEmbed(interaction, note) {
  return new EmbedBuilder()
    .setColor(COLOR_FAIL)
    .setAuthor({ name: 'Obfuscate Failed', iconURL: client.user.displayAvatarURL() })
    .setDescription(String(note).slice(0, 1500))
    .setFooter({ text: `Requested by ${interaction.user.username} • Powered by ${cfg.poweredBy}`, iconURL: interaction.user.displayAvatarURL() })
    .setTimestamp();
}

async function handleObfuFile(interaction) {
  await interaction.deferReply();
  const attachment = interaction.options.getAttachment('file', true);
  if (attachment.size > cfg.obfu.maxSourceBytes) {
    await interaction.editReply({ embeds: [obfuFailEmbed(interaction, `File terlalu besar: ${attachment.size} byte > batas ${cfg.obfu.maxSourceBytes} byte.`)] });
    return;
  }
  const started = Date.now();
  let buf;
  try {
    const res = await fetch(attachment.url, { signal: AbortSignal.timeout(cfg.obfu.requestTimeoutMs) });
    if (!res.ok) throw new Error(`gagal mengambil attachment (HTTP ${res.status})`);
    buf = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    await interaction.editReply({ embeds: [obfuFailEmbed(interaction, `Gagal membaca file: ${err.message || err.name}`)] });
    return;
  }
  try {
    const outBuf = Buffer.from(obfuscate(buf, cfg), 'utf8');
    const name = attachment.name.replace(/\.lua$/i, '') + '.obf.lua';
    await interaction.editReply({
      embeds: [obfuResultEmbed(interaction, buf.length, outBuf.length, Date.now() - started)],
      files: [new AttachmentBuilder(outBuf, { name })],
    });
  } catch (err) {
    await interaction.editReply({ embeds: [obfuFailEmbed(interaction, err.message || String(err))] });
  }
}

async function handleObfuLink(interaction) {
  await interaction.deferReply();
  const url = interaction.options.getString('url', true);
  const started = Date.now();
  let buf;
  try {
    buf = await fetchTextSafe(url, { maxBytes: cfg.obfu.maxSourceBytes, timeoutMs: cfg.obfu.requestTimeoutMs });
  } catch (err) {
    await interaction.editReply({ embeds: [obfuFailEmbed(interaction, `Gagal mengambil link: ${err.message}`)] });
    return;
  }
  try {
    const outBuf = Buffer.from(obfuscate(buf, cfg), 'utf8');
    await interaction.editReply({
      embeds: [obfuResultEmbed(interaction, buf.length, outBuf.length, Date.now() - started)],
      files: [new AttachmentBuilder(outBuf, { name: 'obfuscated.lua' })],
    });
  } catch (err) {
    await interaction.editReply({ embeds: [obfuFailEmbed(interaction, err.message || String(err))] });
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

// ============ command tambahan: ping, rank, invites, xp-give, level-sync ============
const LEVEL_SYNC_MAX = 500; // batas member yang dicek per /level-sync, supaya tidak kena timeout interaksi

function isServerAdmin(interaction) {
  return interaction.guild.ownerId === interaction.user.id
    || Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
}

async function handlePing(interaction) {
  await interaction.reply({
    embeds: [new EmbedBuilder().setColor(COLOR_INFO).setDescription(`Pong! Latency websocket **${client.ws.ping} ms**.`)
      .setFooter({ text: `Powered by ${cfg.poweredBy}` }).setTimestamp()],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleRank(interaction) {
  if (!interaction.guild) return interaction.reply({ content: 'Perintah ini cuma bisa dipakai di server.', flags: MessageFlags.Ephemeral });
  const user = interaction.options.getUser('user') ?? interaction.user;
  await interaction.reply({ embeds: [levelCardEmbed(user, interaction.guild.id)] });
}

async function handleInvites(interaction) {
  if (!interaction.guild) return interaction.reply({ content: 'Perintah ini cuma bisa dipakai di server.', flags: MessageFlags.Ephemeral });
  const user = interaction.options.getUser('user') ?? interaction.user;
  const c = inviteCounts.get(`${interaction.guild.id}:${user.id}`) || { invited: 0, left: 0 };
  const embed = new EmbedBuilder()
    .setColor(COLOR_INVITE)
    .setAuthor({ name: `Invite — ${user.username}`, iconURL: user.displayAvatarURL() })
    .addFields(
      { name: 'Total diundang', value: `${c.invited}`, inline: true },
      { name: 'Sudah keluar', value: `${c.left}`, inline: true },
      { name: 'Masih bertahan', value: `${Math.max(0, c.invited - c.left)}`, inline: true },
    )
    .setFooter({ text: `Powered by ${cfg.poweredBy}` })
    .setTimestamp();
  await interaction.reply({ embeds: [embed] });
}

async function handleXpGive(interaction) {
  if (!interaction.guild) return interaction.reply({ content: 'Perintah ini cuma bisa dipakai di server.', flags: MessageFlags.Ephemeral });
  if (!isServerAdmin(interaction)) {
    return interaction.reply({ content: 'Cuma owner atau admin yang bisa pakai command ini.', flags: MessageFlags.Ephemeral });
  }
  const user = interaction.options.getUser('user', true);
  const amount = interaction.options.getInteger('jumlah', true);
  const key = `${interaction.guild.id}:${user.id}`;
  const entry = users.get(key) || { xp: 0, lastAt: 0 };
  entry.xp = Math.max(0, entry.xp + amount);
  users.set(key, entry);
  xpSaver.schedule();
  const info = levelInfo(entry.xp);
  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(COLOR_LEVEL)
      .setDescription(`XP ${user} sekarang **${entry.xp}** (Level ${info.level}). Perubahan: ${amount >= 0 ? '+' : ''}${amount}.`)
      .setFooter({ text: `Powered by ${cfg.poweredBy}` })
      .setTimestamp()],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function handleLevelSync(interaction) {
  if (!interaction.guild) return interaction.reply({ content: 'Perintah ini cuma bisa dipakai di server.', flags: MessageFlags.Ephemeral });
  if (!isServerAdmin(interaction)) {
    return interaction.reply({ content: 'Cuma owner atau admin yang bisa pakai command ini.', flags: MessageFlags.Ephemeral });
  }
  const guild = interaction.guild;
  if (levelRolesFor(guild.id).length === 0) {
    return interaction.reply({ content: 'Belum ada role hadiah level. Pasang dulu dengan /level-role set.', flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const prefix = `${guild.id}:`;
  const all = [...users.entries()].filter(([k]) => k.startsWith(prefix));
  const targets = all.slice(0, LEVEL_SYNC_MAX);
  let granted = 0;
  for (const [key, v] of targets) {
    const roles = await applyLevelRoles(guild, key.slice(prefix.length), levelInfo(v.xp).level);
    granted += roles.length;
  }
  const note = all.length > LEVEL_SYNC_MAX ? ` Dibatasi ${LEVEL_SYNC_MAX} member pertama, jalankan lagi untuk sisanya.` : '';
  await interaction.editReply({ content: `Selesai. ${targets.length} member dicek, ${granted} role baru diberikan.${note}` });
}
// ============ akhir command tambahan ============

// ============ command tambahan: help, userinfo, serverinfo, avatar, xp-reset ============
function unixTagged(date, style = 'F') {
  return `<t:${Math.floor(new Date(date).getTime() / 1000)}:${style}>`;
}

async function handleHelp(interaction) {
  const lines = commands.map((c) => `\`/${c.name}\` — ${c.description}`);
  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(COLOR_INFO)
      .setTitle(`Bantuan — ${cfg.brandName}`)
      .setDescription(lines.join('\n'))
      .setFooter({ text: `Powered by ${cfg.poweredBy}` })
      .setTimestamp()],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleUserinfo(interaction) {
  if (!interaction.guild) return interaction.reply({ content: 'Perintah ini cuma bisa dipakai di server.', flags: MessageFlags.Ephemeral });
  const user = interaction.options.getUser('user') ?? interaction.user;
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  const embed = new EmbedBuilder()
    .setColor(COLOR_INFO)
    .setAuthor({ name: user.tag })
    .setThumbnail(user.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: 'ID', value: user.id, inline: true },
      { name: 'Akun dibuat', value: unixTagged(user.createdAt), inline: true },
      { name: 'Bergabung', value: member?.joinedAt ? unixTagged(member.joinedAt) : 'Bukan member', inline: true },
      { name: 'Jumlah role', value: member ? `${member.roles.cache.size - 1}` : '-', inline: true },
      { name: 'Bot', value: user.bot ? 'Ya' : 'Tidak', inline: true },
    )
    .setFooter({ text: `Powered by ${cfg.poweredBy}` })
    .setTimestamp();
  await interaction.reply({ embeds: [embed] });
}

async function handleServerinfo(interaction) {
  if (!interaction.guild) return interaction.reply({ content: 'Perintah ini cuma bisa dipakai di server.', flags: MessageFlags.Ephemeral });
  const g = interaction.guild;
  const embed = new EmbedBuilder()
    .setColor(COLOR_INFO)
    .setAuthor({ name: g.name })
    .addFields(
      { name: 'ID', value: g.id, inline: true },
      { name: 'Owner', value: `<@${g.ownerId}>`, inline: true },
      { name: 'Member', value: `${g.memberCount}`, inline: true },
      { name: 'Channel (cache)', value: `${g.channels.cache.size}`, inline: true },
      { name: 'Role (cache)', value: `${g.roles.cache.size}`, inline: true },
      { name: 'Dibuat', value: unixTagged(g.createdAt), inline: true },
      { name: 'Boost', value: `Tier ${g.premiumTier}, ${g.premiumSubscriptionCount ?? 0} boost`, inline: true },
    )
    .setFooter({ text: `Powered by ${cfg.poweredBy}` })
    .setTimestamp();
  const icon = g.iconURL();
  if (icon) embed.setThumbnail(icon);
  await interaction.reply({ embeds: [embed] });
}

async function handleAvatar(interaction) {
  const user = interaction.options.getUser('user') ?? interaction.user;
  const embed = new EmbedBuilder()
    .setColor(COLOR_INFO)
    .setAuthor({ name: user.tag })
    .setImage(user.displayAvatarURL({ size: 1024 }))
    .setFooter({ text: `Powered by ${cfg.poweredBy}` })
    .setTimestamp();
  await interaction.reply({ embeds: [embed] });
}

async function handleXpReset(interaction) {
  if (!interaction.guild) return interaction.reply({ content: 'Perintah ini cuma bisa dipakai di server.', flags: MessageFlags.Ephemeral });
  if (!isServerAdmin(interaction)) {
    return interaction.reply({ content: 'Cuma owner atau admin yang bisa pakai command ini.', flags: MessageFlags.Ephemeral });
  }
  const user = interaction.options.getUser('user', true);
  const existed = users.delete(`${interaction.guild.id}:${user.id}`);
  xpSaver.schedule();
  await interaction.reply({
    content: existed ? `XP ${user} direset ke 0. Role hadiah yang sudah diberikan tidak ikut dicabut.` : `${user} belum punya XP.`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}
// ============ akhir command tambahan ============

// ============ command tambahan: invite-top ============
async function handleInviteTop(interaction) {
  if (!interaction.guild) return interaction.reply({ content: 'Perintah ini cuma bisa dipakai di server.', flags: MessageFlags.Ephemeral });
  const prefix = `${interaction.guild.id}:`;
  const rows = [...inviteCounts.entries()]
    .filter(([k, v]) => k.startsWith(prefix) && v.invited > 0)
    .map(([k, v]) => ({ id: k.slice(prefix.length), invited: v.invited, stay: Math.max(0, v.invited - v.left) }))
    .sort((a, b) => b.stay - a.stay || b.invited - a.invited)
    .slice(0, 10);
  const lines = rows.map((r, i) => `**#${i + 1}** <@${r.id}> — ${r.stay} bertahan dari ${r.invited} undangan`);
  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(COLOR_INVITE)
      .setTitle('Top Pengundang')
      .setDescription(lines.length ? lines.join('\n') : 'Belum ada data undangan.')
      .setFooter({ text: `Powered by ${cfg.poweredBy}` })
      .setTimestamp()],
    allowedMentions: { parse: [] },
  });
}

// ============ akhir command tambahan ============

// ============ command tambahan: poll ============
const POLL_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];
async function handlePoll(interaction) {
  const question = interaction.options.getString('pertanyaan', true).slice(0, 256);
  const options = [];
  for (let i = 1; i <= POLL_EMOJI.length; i++) {
    const v = interaction.options.getString(`pilihan_${i}`);
    if (v && v.trim()) options.push(v.trim().slice(0, 100));
  }
  if (options.length < 2) {
    return interaction.reply({ content: 'Poll butuh minimal dua pilihan.', flags: MessageFlags.Ephemeral });
  }
  const lines = options.map((o, i) => `${POLL_EMOJI[i]} ${o}`).join('\n');
  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(COLOR_INFO)
      .setTitle('📊 Poll')
      .setDescription(`**${question}**\n\n${lines}`)
      .setFooter({ text: `Powered by ${cfg.poweredBy}` })
      .setTimestamp()],
    allowedMentions: { parse: [] },
  });
  const msg = await interaction.fetchReply();
  for (let i = 0; i < options.length; i++) await msg.react(POLL_EMOJI[i]).catch(() => {});
}

// ============ akhir command tambahan ============

// ============ command tambahan: roll, choose, role-info, invite-reset, level-check ============
async function handleRoleInfo(interaction) {
  if (!interaction.guild) return interaction.reply({ content: 'Perintah ini cuma bisa dipakai di server.', flags: MessageFlags.Ephemeral });
  const role = interaction.options.getRole('role', true);
  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(role.color || COLOR_INFO)
      .setTitle(`Role — ${role.name}`)
      .addFields(
        { name: 'ID', value: role.id, inline: true },
        { name: 'Warna', value: role.hexColor, inline: true },
        { name: 'Posisi', value: `${role.position}`, inline: true },
        { name: 'Member (cache)', value: `${role.members.size}`, inline: true },
        { name: 'Bisa di-mention', value: role.mentionable ? 'Ya' : 'Tidak', inline: true },
        { name: 'Dikelola bot', value: role.managed ? 'Ya' : 'Tidak', inline: true },
      )
      .setFooter({ text: `Powered by ${cfg.poweredBy}` })
      .setTimestamp()],
    allowedMentions: { parse: [] },
  });
}

async function handleInviteReset(interaction) {
  if (!interaction.guild) return interaction.reply({ content: 'Perintah ini cuma bisa dipakai di server.', flags: MessageFlags.Ephemeral });
  if (!isServerAdmin(interaction)) {
    return interaction.reply({ content: 'Cuma owner atau admin yang bisa pakai command ini.', flags: MessageFlags.Ephemeral });
  }
  const user = interaction.options.getUser('user', true);
  const existed = inviteCounts.delete(`${interaction.guild.id}:${user.id}`);
  inviteSaver.schedule();
  await interaction.reply({
    content: existed
      ? `Hitungan undangan ${user} direset. Catatan siapa yang masuk lewat dia tidak dihapus.`
      : `${user} belum punya hitungan undangan.`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function handleLevelCheck(interaction) {
  if (!interaction.guild) return interaction.reply({ content: 'Perintah ini cuma bisa dipakai di server.', flags: MessageFlags.Ephemeral });
  if (!isServerAdmin(interaction)) {
    return interaction.reply({ content: 'Cuma owner atau admin yang bisa pakai command ini.', flags: MessageFlags.Ephemeral });
  }
  const guild = interaction.guild;
  const user = interaction.options.getUser('user', true);
  const entry = users.get(`${guild.id}:${user.id}`) || { xp: 0 };
  const level = levelInfo(entry.xp).level;
  const due = levelRolesFor(guild.id).filter((r) => r.level <= level);
  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) {
    return interaction.reply({ content: `${user} bukan member server ini.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }
  const have = due.filter((r) => member.roles.cache.has(r.roleId));
  const missing = due.filter((r) => !member.roles.cache.has(r.roleId));
  const fmt = (list) => (list.length ? list.map((r) => `Level **${r.level}** → <@&${r.roleId}>`).join('\n') : 'Tidak ada');
  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(COLOR_LEVEL)
      .setAuthor({ name: `Cek Level — ${user.username}`, iconURL: user.displayAvatarURL() })
      .setDescription(`Level saat ini **${level}** (${entry.xp} XP).`)
      .addFields(
        { name: 'Sudah punya', value: fmt(have) },
        { name: 'Belum punya (seharusnya dapat)', value: fmt(missing) },
      )
      .setFooter({ text: `Powered by ${cfg.poweredBy}` })
      .setTimestamp()],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}
// ============ akhir command tambahan ============


// ============ anti-phishing & admin tools ============
const PHISH_FILE = path.join(__dirname, 'phish-blocklist.json');
const PHISH_MAX_PER_GUILD = 200;
const PHISH_ALLOWED_DISCORD = ['discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net', 'discord.media', 'discord.gift', 'discord.new', 'discord.dev', 'discordstatus.com'];
const PHISH_SAFE_TLDS_FILES = ['js', 'ts', 'py', 'lua', 'json', 'txt', 'md', 'exe', 'zip', 'png', 'jpg', 'gif'];
const phishBlock = new Map(); // guildId -> Set<domain>

function loadPhish() {
  const raw = readJsonFile(PHISH_FILE);
  if (!raw || typeof raw !== 'object') return;
  for (const [guildId, list] of Object.entries(raw)) {
    if (!cleanSnowflake(guildId) || !Array.isArray(list)) continue;
    const set = new Set(list.filter((d) => typeof d === 'string' && d.length > 0 && d.length <= 253));
    phishBlock.set(guildId, set);
  }
}

const phishSaver = createSaver(PHISH_FILE, () =>
  Object.fromEntries([...phishBlock].map(([g, set]) => [g, [...set]])));

function normalizeDomain(raw) {
  const str = String(raw ?? '').trim();
  if (!str) return null;
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(str) ? str : `http://${str}`);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  return host.includes('.') && /^[a-z0-9.-]+$/.test(host) ? host : null;
}

function hostMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

// Alasan kenapa sebuah host dianggap mencurigakan, atau null kalau aman.
function suspiciousReason(host, blockedSet) {
  for (const d of blockedSet) {
    if (hostMatches(host, d)) return 'domain diblokir';
  }
  if (host.includes('xn--')) return 'domain punycode';
  const isKnownDiscord = PHISH_ALLOWED_DISCORD.some((d) => hostMatches(host, d));
  const lastLabel = host.split('.').pop();
  if (!isKnownDiscord && !PHISH_SAFE_TLDS_FILES.includes(lastLabel) && /disc[o0]rd|d[il1]scord/.test(host)) {
    return 'mirip domain Discord';
  }
  return null;
}

function findPhish(text, guildId) {
  const set = phishBlock.get(guildId) ?? new Set();
  for (const tok of String(text).split(/\s+/)) {
    const t = tok.replace(/^[<(]+|[>)]+$/g, '');
    if (!t.includes('.')) continue;
    const host = normalizeDomain(t);
    if (!host) continue;
    const reason = suspiciousReason(host, set);
    if (reason) return { host, reason };
  }
  return null;
}

// Dipanggil dari MessageCreate. Mengembalikan true kalau pesan dihapus.
async function phishGuard(message) {
  if (!message.guild || !message.content) return false;
  const found = findPhish(message.content, message.guild.id);
  if (!found) return false;
  if (message.guild.ownerId === message.author.id || message.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
    return false; // admin tidak diganggu filter
  }
  await message.delete().catch(() => {});
  await message.channel.send({
    content: `⚠️ Pesan dari <@${message.author.id}> dihapus: link mencurigakan (${found.host}, ${found.reason}).`,
    allowedMentions: { users: [message.author.id] },
  }).catch(() => {});
  return true;
}

async function handlePhishAdd(interaction) {
  if (!interaction.guild) return interaction.reply({ content: 'Perintah ini cuma bisa dipakai di server.', flags: MessageFlags.Ephemeral });
  if (!isServerAdmin(interaction)) return interaction.reply({ content: 'Cuma owner atau admin yang bisa pakai command ini.', flags: MessageFlags.Ephemeral });
  const domain = normalizeDomain(interaction.options.getString('domain', true));
  if (!domain) return interaction.reply({ content: 'Domain tidak valid. Contoh: scam-site.com', flags: MessageFlags.Ephemeral });
  const set = phishBlock.get(interaction.guild.id) ?? new Set();
  if (set.has(domain)) return interaction.reply({ content: `${domain} sudah ada di daftar.`, flags: MessageFlags.Ephemeral });
  if (set.size >= PHISH_MAX_PER_GUILD) return interaction.reply({ content: `Daftar sudah penuh (${PHISH_MAX_PER_GUILD} domain).`, flags: MessageFlags.Ephemeral });
  set.add(domain);
  phishBlock.set(interaction.guild.id, set);
  phishSaver.save();
  await interaction.reply({ content: `Domain **${domain}** diblokir. Link ke domain itu akan dihapus otomatis.`, flags: MessageFlags.Ephemeral });
}

async function handlePhishRemove(interaction) {
  if (!interaction.guild) return interaction.reply({ content: 'Perintah ini cuma bisa dipakai di server.', flags: MessageFlags.Ephemeral });
  if (!isServerAdmin(interaction)) return interaction.reply({ content: 'Cuma owner atau admin yang bisa pakai command ini.', flags: MessageFlags.Ephemeral });
  const domain = normalizeDomain(interaction.options.getString('domain', true));
  const set = phishBlock.get(interaction.guild.id) ?? new Set();
  if (!domain || !set.delete(domain)) {
    return interaction.reply({ content: 'Domain itu tidak ada di daftar.', flags: MessageFlags.Ephemeral });
  }
  phishSaver.save();
  await interaction.reply({ content: `Domain **${domain}** dihapus dari daftar.`, flags: MessageFlags.Ephemeral });
}

async function handlePhishList(interaction) {
  if (!interaction.guild) return interaction.reply({ content: 'Perintah ini cuma bisa dipakai di server.', flags: MessageFlags.Ephemeral });
  if (!isServerAdmin(interaction)) return interaction.reply({ content: 'Cuma owner atau admin yang bisa pakai command ini.', flags: MessageFlags.Ephemeral });
  const list = [...(phishBlock.get(interaction.guild.id) ?? new Set())];
  const shown = list.slice(0, 50).map((d) => `• ${d}`).join('\n');
  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(COLOR_INFO)
      .setTitle(`Daftar Domain Diblokir (${list.length})`)
      .setDescription(list.length ? shown : 'Belum ada domain.')
      .setFooter({ text: `Powered by ${cfg.poweredBy}` })
      .setTimestamp()],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function handlePurge(interaction) {
  if (!interaction.guild) return interaction.reply({ content: 'Perintah ini cuma bisa dipakai di server.', flags: MessageFlags.Ephemeral });
  if (!isServerAdmin(interaction)) return interaction.reply({ content: 'Cuma owner atau admin yang bisa pakai command ini.', flags: MessageFlags.Ephemeral });
  const channel = interaction.channel;
  if (typeof channel?.bulkDelete !== 'function') return interaction.reply({ content: 'Perintah ini cuma bisa dipakai di channel teks.', flags: MessageFlags.Ephemeral });
  const me = interaction.guild.members.me ?? (await interaction.guild.members.fetchMe().catch(() => null));
  if (!me || !channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageMessages)) {
    return interaction.reply({ content: 'Bot butuh izin Manage Messages di channel ini.', flags: MessageFlags.Ephemeral });
  }
  const amount = interaction.options.getInteger('jumlah', true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const deleted = await channel.bulkDelete(amount, true);
  await interaction.editReply({ content: `Menghapus ${deleted.size} pesan. Pesan lebih dari 14 hari tidak bisa dihapus massal.` });
}

async function handleSlowmode(interaction) {
  if (!interaction.guild) return interaction.reply({ content: 'Perintah ini cuma bisa dipakai di server.', flags: MessageFlags.Ephemeral });
  if (!isServerAdmin(interaction)) return interaction.reply({ content: 'Cuma owner atau admin yang bisa pakai command ini.', flags: MessageFlags.Ephemeral });
  const channel = interaction.channel;
  if (typeof channel?.setRateLimitPerUser !== 'function') return interaction.reply({ content: 'Channel ini tidak mendukung slowmode.', flags: MessageFlags.Ephemeral });
  const me = interaction.guild.members.me ?? (await interaction.guild.members.fetchMe().catch(() => null));
  if (!me || !channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageChannels)) {
    return interaction.reply({ content: 'Bot butuh izin Manage Channels di channel ini.', flags: MessageFlags.Ephemeral });
  }
  const detik = interaction.options.getInteger('detik', true);
  await channel.setRateLimitPerUser(detik, `oleh ${interaction.user.tag}`);
  await interaction.reply({
    content: detik > 0 ? `Slowmode diset ke ${detik} detik.` : 'Slowmode dimatikan.',
    flags: MessageFlags.Ephemeral,
  });
}
// ============ akhir anti-phishing & admin tools ============

// ============ bot ============
warnIfSecretsInRepoFiles();
const cfg = loadConfig();
loadXpStore();
loadInviteStore();
loadLevelRoles();
loadPhish();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // welcome/goodbye & invite log: aktifkan "Server Members Intent"
    GatewayIntentBits.GuildInvites, // invite log: lacak invite dan pemakaiannya
    GatewayIntentBits.GuildMessages, // XP dari chat
    GatewayIntentBits.MessageContent, // baca teks "ALLZXRAA level" / "Alevel" / "Alb": aktifkan "Message Content Intent"
  ],
});


const commands = [
  new SlashCommandBuilder()
    .setName('obfu-file')
    .setDescription('Obfuscate file .lua (format sama seperti ALLZRA_main.lua)')
    .addAttachmentOption((o) => o.setName('file').setDescription('File .lua yang mau di-obfuscate').setRequired(true)),
  new SlashCommandBuilder()
    .setName('obfu-link')
    .setDescription('Obfuscate isi dari link raw ke format .lua terproteksi')
    .addStringOption((o) => o.setName('url').setDescription('Link raw berisi source Lua').setRequired(true)),
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
  new SlashCommandBuilder().setName('ping').setDescription('Cek latency bot'),
  new SlashCommandBuilder()
    .setName('rank')
    .setDescription('Lihat level dan XP kamu atau member lain')
    .addUserOption((o) => o.setName('user').setDescription('Target (kosong = kamu)'))
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('invites')
    .setDescription('Lihat jumlah undangan dan yang masih bertahan')
    .addUserOption((o) => o.setName('user').setDescription('Target (kosong = kamu)'))
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('xp-give')
    .setDescription('Tambah atau kurangi XP member (admin)')
    .addUserOption((o) => o.setName('user').setDescription('Target').setRequired(true))
    .addIntegerOption((o) => o.setName('jumlah').setDescription('Bisa negatif, misal -50').setRequired(true).setMinValue(-100000).setMaxValue(100000))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('level-sync')
    .setDescription('Berikan role hadiah ke member yang sudah memenuhi syarat (admin)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),
  new SlashCommandBuilder().setName('help').setDescription('Daftar semua command bot'),
  new SlashCommandBuilder()
    .setName('userinfo')
    .setDescription('Info akun dan keanggotaan user')
    .addUserOption((o) => o.setName('user').setDescription('Target (kosong = kamu)'))
    .setDMPermission(false),
  new SlashCommandBuilder().setName('serverinfo').setDescription('Info server ini').setDMPermission(false),
  new SlashCommandBuilder()
    .setName('avatar')
    .setDescription('Tampilkan avatar user')
    .addUserOption((o) => o.setName('user').setDescription('Target (kosong = kamu)')),
  new SlashCommandBuilder()
    .setName('xp-reset')
    .setDescription('Reset XP member ke 0 (admin)')
    .addUserOption((o) => o.setName('user').setDescription('Target').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),
  new SlashCommandBuilder().setName('invite-top').setDescription('Top 10 pengundang server ini').setDMPermission(false),
  new SlashCommandBuilder()
    .setName('poll')
    .setDescription('Buat poll dengan reaksi 1-4')
    .addStringOption((o) => o.setName('pertanyaan').setDescription('Pertanyaan poll').setRequired(true).setMaxLength(256))
    .addStringOption((o) => o.setName('pilihan_1').setDescription('Pilihan 1').setRequired(true).setMaxLength(100))
    .addStringOption((o) => o.setName('pilihan_2').setDescription('Pilihan 2').setRequired(true).setMaxLength(100))
    .addStringOption((o) => o.setName('pilihan_3').setDescription('Pilihan 3 (opsional)').setMaxLength(100))
    .addStringOption((o) => o.setName('pilihan_4').setDescription('Pilihan 4 (opsional)').setMaxLength(100)),
  new SlashCommandBuilder()
    .setName('role-info')
    .setDescription('Info sebuah role')
    .addRoleOption((o) => o.setName('role').setDescription('Role yang dicek').setRequired(true))
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('invite-reset')
    .setDescription('Reset hitungan undangan member (admin)')
    .addUserOption((o) => o.setName('user').setDescription('Target').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('level-check')
    .setDescription('Cek role hadiah level yang sudah dan belum dimiliki member (admin)')
    .addUserOption((o) => o.setName('user').setDescription('Target').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('antiphish-add')
    .setDescription('Blokir domain: link ke situ akan dihapus otomatis (admin)')
    .addStringOption((o) => o.setName('domain').setDescription('Domain, misal scam-site.com').setRequired(true).setMaxLength(200))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('antiphish-remove')
    .setDescription('Hapus domain dari daftar blokir (admin)')
    .addStringOption((o) => o.setName('domain').setDescription('Domain yang dihapus').setRequired(true).setMaxLength(200))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('antiphish-list')
    .setDescription('Lihat daftar domain yang diblokir (admin)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('purge')
    .setDescription('Hapus banyak pesan di channel ini (admin)')
    .addIntegerOption((o) => o.setName('jumlah').setDescription('1-100').setRequired(true).setMinValue(1).setMaxValue(100))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('slowmode')
    .setDescription('Atur slowmode channel ini (admin)')
    .addIntegerOption((o) => o.setName('detik').setDescription('0 = mati, maks 21600').setRequired(true).setMinValue(0).setMaxValue(21600))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),
];

client.once(Events.ClientReady, async (c) => {
  await c.application.commands.set(commands.map((cmd) => cmd.toJSON()));
  for (const guild of c.guilds.cache.values()) await initGuildInvites(guild);
  console.log(`Login sebagai ${c.user.tag}`);
  if (!cfg.welcomeChannelId) console.warn('welcome: WELCOME_CHANNEL_ID belum di-set, fitur welcome nonaktif');
  if (!cfg.goodbyeChannelId) console.warn('goodbye: GOODBYE_CHANNEL_ID belum di-set, fitur goodbye nonaktif');
  if (!cfg.inviteLogChannelId) console.warn('invite: INVITE_LOG_CHANNEL_ID belum di-set, invite log tidak diposting (hitungan tetap dicatat)');
});

client.on(Events.GuildCreate, (guild) => {
  initGuildInvites(guild).catch((err) => console.error('GuildCreate invite error:', err));
});

client.on(Events.InviteCreate, (invite) => {
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

client.on(Events.InviteDelete, (invite) => {
  const guildId = invite.guild?.id;
  if (!guildId) return;
  inviteCache.get(guildId)?.delete(invite.code);
});

client.on(Events.GuildMemberAdd, (member) => {
  sendWelcome(member).catch((err) => console.error('sendWelcome error:', err));
  withGuildLock(member.guild.id, () => handleInviteJoin(member));
});

client.on(Events.GuildMemberRemove, (member) => {
  sendGoodbye(member).catch((err) => console.error('sendGoodbye error:', err));
  withGuildLock(member.guild.id, () => handleInviteLeave(member));
});

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot || !message.guild) return;
    if (await phishGuard(message)) return;
    const gain = awardXp(message.guild.id, message.author.id);
    if (gain?.leveledUp) {
      const granted = await applyLevelRoles(message.guild, message.author.id, gain.level);
      await message.channel.send({
        content: `${message.author}`,
        embeds: [levelUpEmbed(message.author, gain.level, granted)],
        allowedMentions: { users: [message.author.id] },
      }).catch((err) => console.error('gagal kirim level up:', err.message));
    }
    const text = message.content.trim();
    if (LEVEL_TRIGGER.test(text)) {
      await message.reply({
        embeds: [levelCardEmbed(message.author, message.guild.id)],
        allowedMentions: { repliedUser: false },
      });
    } else if (LEADERBOARD_TRIGGER.test(text)) {
      await message.reply({
        embeds: [leaderboardEmbed(message.guild)],
        allowedMentions: { repliedUser: false },
      });
    }
  } catch (err) {
    console.error('message handler error:', err);
  }
});


client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (interaction.commandName === 'obfu-file') {
      await handleObfuFile(interaction);
    } else if (interaction.commandName === 'obfu-link') {
      await handleObfuLink(interaction);
    } else if (interaction.commandName === 'level-role') {
      await handleLevelRole(interaction);
    } else if (interaction.commandName === 'ping') {
      await handlePing(interaction);
    } else if (interaction.commandName === 'rank') {
      await handleRank(interaction);
    } else if (interaction.commandName === 'invites') {
      await handleInvites(interaction);
    } else if (interaction.commandName === 'xp-give') {
      await handleXpGive(interaction);
    } else if (interaction.commandName === 'level-sync') {
      await handleLevelSync(interaction);
    } else if (interaction.commandName === 'help') {
      await handleHelp(interaction);
    } else if (interaction.commandName === 'userinfo') {
      await handleUserinfo(interaction);
    } else if (interaction.commandName === 'serverinfo') {
      await handleServerinfo(interaction);
    } else if (interaction.commandName === 'avatar') {
      await handleAvatar(interaction);
    } else if (interaction.commandName === 'xp-reset') {
      await handleXpReset(interaction);
    } else if (interaction.commandName === 'invite-top') {
      await handleInviteTop(interaction);
    } else if (interaction.commandName === 'poll') {
      await handlePoll(interaction);
    } else if (interaction.commandName === 'role-info') {
      await handleRoleInfo(interaction);
    } else if (interaction.commandName === 'invite-reset') {
      await handleInviteReset(interaction);
    } else if (interaction.commandName === 'level-check') {
      await handleLevelCheck(interaction);
    } else if (interaction.commandName === 'antiphish-add') {
      await handlePhishAdd(interaction);
    } else if (interaction.commandName === 'antiphish-remove') {
      await handlePhishRemove(interaction);
    } else if (interaction.commandName === 'antiphish-list') {
      await handlePhishList(interaction);
    } else if (interaction.commandName === 'purge') {
      await handlePurge(interaction);
    } else if (interaction.commandName === 'slowmode') {
      await handleSlowmode(interaction);
    }
  } catch (err) {
    console.error('interaction error:', err);
    const payload = { content: 'Terjadi error internal, coba lagi.', flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
  }
});

function saveAll() {
  xpSaver.save();
  inviteSaver.save();
  levelRoleSaver.save();
  phishSaver.save();
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    saveAll();
    process.exit(0);
  });
}
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));

module.exports = {
  obfuscate, decodeBytes, levelInfo, progressBar, awardXp, guildRanking,
  LEVEL_TRIGGER, LEADERBOARD_TRIGGER, users, inviteCache, inviteCounts, joinedBy,
  detectInviter, cacheInvites, handleInviteJoin, handleInviteLeave, saveAll,
  loadConfig, fetchTextSafe,
};

if (require.main === module) {
  client.login(cfg.botToken);
}
