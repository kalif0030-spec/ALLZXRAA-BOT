'use strict';

// Satu file: welcome/goodbye, obfuscator (format sama seperti ALLZRA_main.lua),
// obfu link aman dari SSRF, sistem XP + level + leaderboard, invite log, dan /war (drop file acak).

const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const {
  AttachmentBuilder, Client, EmbedBuilder, Events, GatewayIntentBits,
  MessageFlags, Partials, PermissionFlagsBits, SlashCommandBuilder,
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
    assetCommandChannelId: cleanSnowflake(pick('ASSET_COMMAND_CHANNEL_ID', 'assetCommandChannelId')),
    assetDropChannelId: cleanSnowflake(pick('ASSET_DROP_CHANNEL_ID', 'assetDropChannelId')),
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
function awardXp(guildId, userId, now = Date.now()) {
  const key = `${guildId}:${userId}`;
  const entry = users.get(key) || { xp: 0, lastAt: 0 };
  if (now - entry.lastAt < XP_COOLDOWN_MS) return false;
  entry.xp += XP_MIN + crypto.randomInt(XP_MAX - XP_MIN + 1);
  entry.lastAt = now;
  users.set(key, entry);
  xpSaver.schedule();
  return true;
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

// ============ bot ============
warnIfSecretsInRepoFiles();
const cfg = loadConfig();
loadXpStore();
loadInviteStore();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // welcome/goodbye & invite log: aktifkan "Server Members Intent"
    GatewayIntentBits.GuildInvites, // invite log: lacak invite dan pemakaiannya
    GatewayIntentBits.GuildMessages, // XP dari chat
    GatewayIntentBits.GuildMessageReactions, // /war: hitung reaction
    GatewayIntentBits.MessageContent, // baca teks "ALLZXRAA level" / "Alevel" / "Alb": aktifkan "Message Content Intent"
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User], // reaction di pesan lama setelah restart
});

// ============ war asset (/war) ============
const WAR_STORE_FILE = path.join(__dirname, 'asset-drops.json');
const WAR_FILES_DIR = path.join(__dirname, 'asset-files');
const WAR_COLOR = 0xff7a00;
const WAR_OK = 0x57f287;
const WAR_FAIL = 0xed4245;
const WAR_TEASER = 'WAR YOK KU DROP FILE ACAK YA, TAPI APIIN DULU DONG🔥';
const WAR_MAX_FILE_BYTES = 25 * 1024 * 1024;
const WAR_FETCH_TIMEOUT_MS = 60 * 1000;
const WAR_MAX_OPEN_PER_GUILD = 20;
const WAR_MIN_SEC = 0.1;
const WAR_MAX_SEC = 86400;
const WAR_MAX_JUMLAH = 50; // satu panggilan fetch reaction mengambil maks 100 user, dibatasi 50 supaya hitungannya akurat
// Pola spam sesuai contoh dari owner. Jumlah baris "1" di tengah (19) bisa diubah di sini.
const WAR_SPAM_LINES = [
  'SUNDULAN MAUTTT WHOO',
  ...Array(19).fill('1'),
  '1', '1', '1', '1', '1', '1', '1', '1',
  'MAMPUSSS GUA SUNDULL AWOKAWOAK',
];
const WAR_SPAM_TEXT = WAR_SPAM_LINES.join('\n');
const WAR_SPAM_COUNT = 10;
const WAR_SPAM_GAP_MS = 1500;
const WAR_CUSTOM_EMOJI_RE = /^<a?:([A-Za-z0-9_]{2,32}):(\d{5,25})>$/;
const WAR_ALLOWED_EXT = new Set([
  '.rbxl', '.rbxlx', '.rbxm', '.rbxmx', '.lua', '.luau',
  '.fbx', '.obj', '.mtl', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.tga',
  '.mp3', '.ogg', '.wav', '.mp4', '.ttf', '.otf', '.json', '.txt', '.zip',
]);

const warDrops = new Map(); // messageId -> drop
const warTimers = new Map(); // messageId -> Timeout

// ---------- fungsi murni ----------
function warParseEmoji(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const custom = s.match(WAR_CUSTOM_EMOJI_RE);
  if (custom) return `${custom[1]}:${custom[2]}`;
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)];
  if (graphemes.length !== 1 || !/\p{Extended_Pictographic}/u.test(s)) return null;
  return s;
}

function warEmojiKeyOf(emoji) {
  return emoji.id ? `${emoji.name}:${emoji.id}` : emoji.name;
}

function warIsAllowed(name) {
  return WAR_ALLOWED_EXT.has(path.extname(String(name)).toLowerCase());
}

function warSafeName(name) {
  const base = path.basename(String(name)).replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 100);
  return base && base !== '.' ? base : 'file';
}

function warFormatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function warUnix(ms) {
  return `<t:${Math.floor(ms / 1000)}:R>`;
}

// ---------- penyimpanan ----------
function warLoad() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(WAR_STORE_FILE, 'utf8'));
  } catch {
    return;
  }
  if (!raw || !Array.isArray(raw.drops)) return;
  for (const d of raw.drops) {
    if (d && typeof d.messageId === 'string' && typeof d.channelId === 'string' &&
        typeof d.guildId === 'string' && typeof d.emojiKey === 'string' &&
        typeof d.filePath === 'string' && Number.isFinite(d.expiresAt) && Number.isInteger(d.jumlah)) {
      warDrops.set(d.messageId, {
        ...d,
        count: Number.isInteger(d.count) ? d.count : 0,
        reactors: Array.isArray(d.reactors) ? d.reactors : [],
      });
    }
  }
}

function warSave() {
  const tmp = WAR_STORE_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify({ drops: [...warDrops.values()] }));
    fs.renameSync(tmp, WAR_STORE_FILE);
  } catch (err) {
    console.error('gagal simpan asset-drops:', err.message);
  }
}

async function warDownload(url, dest, maxBytes) {
  const res = await fetch(url, { signal: AbortSignal.timeout(WAR_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`gagal mengambil file (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`file terlalu besar (${buf.length} byte)`);
  const tmp = dest + '.tmp';
  await fs.promises.writeFile(tmp, buf);
  await fs.promises.rename(tmp, dest);
}

// ---------- embed ----------
function warCard(color) {
  return new EmbedBuilder()
    .setColor(color)
    .setFooter({ text: `Powered by ${cfg.poweredBy}` })
    .setTimestamp();
}

function warCardFor(drop, status) {
  const color = status === 'open' ? WAR_COLOR : status === 'done' ? WAR_OK : WAR_FAIL;
  const headline = {
    open: `React ${drop.emojiLabel} sampai **${drop.jumlah}** member unik agar file terbuka.`,
    done: 'Target tercapai, file sudah dibuka di channel ini.',
    expired: 'Waktu habis, target belum tercapai. File dihapus.',
    closed: 'War ditutup. File dihapus.',
  }[status];
  const embed = warCard(color)
    .setTitle('📦 File acak')
    .setDescription(`${drop.note ? `${drop.note}\n\n` : ''}${headline}`)
    .addFields(
      { name: 'Terkumpul', value: `${drop.count}/${drop.jumlah}`, inline: true },
      { name: 'Durasi', value: `${drop.durasi} detik`, inline: true },
      { name: 'Dibagikan oleh', value: `<@${drop.dropBy}>`, inline: true },
    );
  if (status === 'open') embed.addFields({ name: 'Berakhir', value: warUnix(drop.expiresAt), inline: true });
  return embed;
}

async function warEditCard(drop, status) {
  const channel = await client.channels.fetch(drop.channelId).catch(() => null);
  const msg = await channel?.messages?.fetch(drop.messageId).catch(() => null);
  if (msg) await msg.edit({ embeds: [warCardFor(drop, status)] }).catch(() => {});
  return msg;
}

async function warFinish(drop, status) {
  const msg = await warEditCard(drop, status);
  if (msg) await msg.reactions.removeAll().catch(() => {}); // butuh Manage Messages, kalau tidak ada dilewati
}

// ---------- siklus hidup drop ----------
// Keluarkan drop dari store dan batalkan timer. Sinkron, jadi dua pemicu bersamaan tidak jalan dua kali.
function warDetach(drop) {
  if (!warDrops.has(drop.messageId)) return false;
  warDrops.delete(drop.messageId);
  const t = warTimers.get(drop.messageId);
  if (t) clearTimeout(t);
  warTimers.delete(drop.messageId);
  warSave();
  return true;
}

async function warEnd(drop, status) {
  if (!warDetach(drop)) return;
  await fs.promises.rm(drop.filePath, { force: true }).catch(() => {});
  await warFinish(drop, status);
}

async function warRelease(drop) {
  if (!warDetach(drop)) return;
  let sent = false;
  const winners = (drop.reactors ?? []).slice(0, WAR_MAX_JUMLAH);
  try {
    const buf = await fs.promises.readFile(drop.filePath);
    const channel = await client.channels.fetch(drop.channelId).catch(() => null);
    if (channel?.isTextBased()) {
      const tags = winners.map((id) => `<@${id}>`).join(' ');
      await channel.send({
        content: `🔥 Target **${drop.jumlah}** ${drop.emojiLabel} tercapai! File dibuka. ${tags}`.trim(),
        files: [new AttachmentBuilder(buf, { name: drop.fileName })],
        allowedMentions: { users: winners },
      });
      sent = true;
    }
  } catch (err) {
    console.error('war: kirim file gagal:', err.message);
  }
  await fs.promises.rm(drop.filePath, { force: true }).catch(() => {});
  await warFinish(drop, sent ? 'done' : 'closed');
  if (sent) warSpam(drop.channelId); // tidak di-await: file sudah terkirim dan terhapus, spam jalan di belakang
}

// Kirim WAR_SPAM_TEXT sebanyak WAR_SPAM_COUNT kali, dengan jeda supaya tidak kena rate limit.
async function warSpam(channelId) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  for (let i = 0; i < WAR_SPAM_COUNT; i++) {
    await channel.send({ content: WAR_SPAM_TEXT, allowedMentions: { parse: [] } }).catch(() => {});
    if (i < WAR_SPAM_COUNT - 1) await new Promise((r) => setTimeout(r, WAR_SPAM_GAP_MS));
  }
}

function warSchedule(drop) {
  const old = warTimers.get(drop.messageId);
  if (old) clearTimeout(old);
  const t = setTimeout(() => {
    warTimers.delete(drop.messageId);
    const current = warDrops.get(drop.messageId);
    if (current) warEnd(current, 'expired').catch((err) => console.error('war expire error:', err));
  }, Math.max(0, drop.expiresAt - Date.now()));
  warTimers.set(drop.messageId, t);
}

// ---------- reaction ----------
async function warOnReaction(reaction, user) {
  if (user.bot) return;
  if (reaction.partial) await reaction.fetch().catch(() => null);
  if (reaction.partial) return;

  const drop = warDrops.get(reaction.message.id);
  if (!drop || Date.now() >= drop.expiresAt) return;
  if (warEmojiKeyOf(reaction.emoji) !== drop.emojiKey) return;

  const users = await reaction.users.fetch({ limit: 100 }).catch(() => null);
  if (!users || !warDrops.has(drop.messageId)) return;
  const humans = [...users.values()].filter((u) => !u.bot).map((u) => u.id);
  drop.reactors = humans;
  if (humans.length !== drop.count) {
    drop.count = humans.length;
    warSave();
    await warEditCard(drop, 'open');
  }
  if (humans.length >= drop.jumlah) await warRelease(drop);
}

// ---------- perintah ----------
async function warIsAdmin(interaction) {
  if (interaction.guild.ownerId === interaction.user.id) return true;
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
}

function warReplyFail(interaction, description) {
  const payload = { embeds: [warCard(WAR_FAIL).setDescription(description)] };
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
  return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

function warChannelProblem(interaction) {
  if (!cfg.assetCommandChannelId || !cfg.assetDropChannelId) {
    return 'Channel war belum di-set. Isi ASSET_COMMAND_CHANNEL_ID dan ASSET_DROP_CHANNEL_ID.';
  }
  if (interaction.channelId !== cfg.assetCommandChannelId) {
    return `Perintah ini cuma bisa dipakai di <#${cfg.assetCommandChannelId}>.`;
  }
  return null;
}

async function warCmd(interaction) {
  // Balas secepatnya: Discord menganggap interaksi gagal kalau tidak dibalas dalam 3 detik.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const problem = warChannelProblem(interaction);
  if (problem) return warReplyFail(interaction, problem);
  if (!(await warIsAdmin(interaction))) return warReplyFail(interaction, 'Cuma owner atau admin (izin Administrator) yang bisa bikin war.');

  const dropChannel = await client.channels.fetch(cfg.assetDropChannelId).catch(() => null);
  if (!dropChannel?.isTextBased() || dropChannel.guildId !== interaction.guild.id) {
    return warReplyFail(interaction, 'Channel drop tidak ditemukan di server ini.');
  }
  const perms = dropChannel.permissionsFor(interaction.guild.members.me);
  const needed = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.AddReactions,
    PermissionFlagsBits.ReadMessageHistory,
  ];
  if (!perms?.has(needed)) {
    return warReplyFail(interaction, 'Bot butuh izin View Channel, Send Messages, Embed Links, Attach Files, Add Reactions, dan Read Message History di channel drop.');
  }

  const attachment = interaction.options.getAttachment('file', true);
  const detik = interaction.options.getNumber('detik', true);
  const reactionRaw = interaction.options.getString('reaction', true).trim();
  const jumlah = interaction.options.getInteger('jumlah', true);
  const tag = interaction.options.getString('tag') ?? 'none';
  const note = String(interaction.options.getString('keterangan') ?? '').trim().slice(0, 500);

  const emojiKey = warParseEmoji(reactionRaw);
  if (!emojiKey) return warReplyFail(interaction, 'Reaction tidak valid. Pakai satu emoji biasa atau emoji custom dari server ini.');
  if (!Number.isFinite(detik) || detik < WAR_MIN_SEC || detik > WAR_MAX_SEC) {
    return warReplyFail(interaction, `Detik harus ${WAR_MIN_SEC}-${WAR_MAX_SEC}.`);
  }
  if (jumlah < 1 || jumlah > WAR_MAX_JUMLAH) return warReplyFail(interaction, `Jumlah harus 1-${WAR_MAX_JUMLAH}.`);
  if (!warIsAllowed(attachment.name)) {
    return warReplyFail(interaction, `Tipe file tidak didukung. Yang boleh: ${[...WAR_ALLOWED_EXT].join(', ')}`);
  }
  if (attachment.size > WAR_MAX_FILE_BYTES) {
    return warReplyFail(interaction, `File terlalu besar: ${warFormatBytes(attachment.size)}. Batas ${warFormatBytes(WAR_MAX_FILE_BYTES)}.`);
  }
  const openHere = [...warDrops.values()].filter((d) => d.guildId === interaction.guild.id).length;
  if (openHere >= WAR_MAX_OPEN_PER_GUILD) {
    return warReplyFail(interaction, `Sudah ada ${WAR_MAX_OPEN_PER_GUILD} war terbuka. Tunggu sampai ada yang habis waktu.`);
  }

  const dropId = crypto.randomUUID();
  const fileName = warSafeName(attachment.name);
  const filePath = path.join(WAR_FILES_DIR, `${dropId}-${fileName}`);
  try {
    await fs.promises.mkdir(WAR_FILES_DIR, { recursive: true });
    await warDownload(attachment.url, filePath, WAR_MAX_FILE_BYTES);
  } catch (err) {
    await fs.promises.rm(filePath, { force: true }).catch(() => {});
    return interaction.editReply({ embeds: [warCard(WAR_FAIL).setDescription(`Gagal menyimpan file: ${err.message}`)] });
  }

  // Waktu dihitung saat pesan drop dipasang, bukan saat command diterima.
  const drop = {
    messageId: null,
    id: dropId,
    guildId: interaction.guild.id,
    guildName: interaction.guild.name,
    channelId: dropChannel.id,
    emojiKey,
    emojiLabel: reactionRaw,
    jumlah,
    durasi: detik,
    note,
    fileName,
    filePath,
    dropBy: interaction.user.id,
    createdAt: Date.now(),
    expiresAt: Date.now() + Math.round(detik * 1000),
    count: 0,
    reactors: [],
  };

  const tagText = tag === 'everyone' ? '@everyone' : tag === 'here' ? '@here' : '';
  let msg = null;
  try {
    await dropChannel.send({
      content: [tagText, WAR_TEASER].filter(Boolean).join(' '),
      allowedMentions: { parse: tag === 'none' ? [] : ['everyone'] },
    });
    msg = await dropChannel.send({ embeds: [warCardFor(drop, 'open')], allowedMentions: { parse: [] } });
    drop.messageId = msg.id;
    warDrops.set(msg.id, drop);
    warSave();
    warSchedule(drop);
  } catch (err) {
    if (msg) {
      warDetach(drop);
      await msg.delete().catch(() => {});
    }
    await fs.promises.rm(filePath, { force: true }).catch(() => {});
    return interaction.editReply({ embeds: [warCard(WAR_FAIL).setDescription(`Gagal pasang drop: ${err.message}`)] });
  }

  await interaction.editReply({ embeds: [warCard(WAR_OK).setDescription(`War dipasang di <#${dropChannel.id}>: ${msg.url}`)] });

  // Reaction dipasang di belakang, supaya admin tidak menunggu rate limit Discord.
  msg.react(emojiKey).catch(async (err) => {
    console.error('war: pasang reaction gagal:', err.message);
    const current = warDrops.get(msg.id);
    if (current) await warEnd(current, 'closed');
  });
}

const warCommands = [
  new SlashCommandBuilder().setName('war')
    .setDescription('Drop file acak: member react sampai jumlah target tercapai')
    .addAttachmentOption((o) => o.setName('file').setDescription('File yang di-drop (maks 25 MB)').setRequired(true))
    .addNumberOption((o) => o.setName('detik').setDescription(`Lama war aktif dalam detik, ${WAR_MIN_SEC}-${WAR_MAX_SEC}`).setRequired(true).setMinValue(WAR_MIN_SEC).setMaxValue(WAR_MAX_SEC))
    .addStringOption((o) => o.setName('reaction').setDescription('Emoji yang harus di-react, boleh emoji custom server').setRequired(true).setMaxLength(100))
    .addIntegerOption((o) => o.setName('jumlah').setDescription(`Berapa member unik harus react (1-${WAR_MAX_JUMLAH})`).setRequired(true).setMinValue(1).setMaxValue(WAR_MAX_JUMLAH))
    .addStringOption((o) => o.setName('tag').setDescription('Tag di pesan teaser')
      .addChoices({ name: 'Tidak ada', value: 'none' }, { name: '@here', value: 'here' }, { name: '@everyone', value: 'everyone' }))
    .addStringOption((o) => o.setName('keterangan').setDescription('Teks tambahan di pesan drop').setMaxLength(500))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),
];

async function warHandleCommand(interaction) {
  if (interaction.commandName !== 'war') return false;
  await warCmd(interaction);
  return true;
}

function warStart() {
  warLoad();
  for (const drop of [...warDrops.values()]) {
    if (Date.now() >= drop.expiresAt) {
      warEnd(drop, 'expired').catch((err) => console.error('war start error:', err));
    } else {
      warSchedule(drop);
    }
  }
}

function warStop() {
  for (const t of warTimers.values()) clearTimeout(t);
  warTimers.clear();
  warSave();
}
// ============ akhir war asset ============

const commands = [
  new SlashCommandBuilder()
    .setName('obfu-file')
    .setDescription('Obfuscate file .lua (format sama seperti ALLZRA_main.lua)')
    .addAttachmentOption((o) => o.setName('file').setDescription('File .lua yang mau di-obfuscate').setRequired(true)),
  new SlashCommandBuilder()
    .setName('obfu-link')
    .setDescription('Obfuscate isi dari link raw ke format .lua terproteksi')
    .addStringOption((o) => o.setName('url').setDescription('Link raw berisi source Lua').setRequired(true)),
  ...warCommands,
];

client.once(Events.ClientReady, async (c) => {
  await c.application.commands.set(commands.map((cmd) => cmd.toJSON()));
  for (const guild of c.guilds.cache.values()) await initGuildInvites(guild);
  console.log(`Login sebagai ${c.user.tag}`);
  if (!cfg.welcomeChannelId) console.warn('welcome: WELCOME_CHANNEL_ID belum di-set, fitur welcome nonaktif');
  if (!cfg.goodbyeChannelId) console.warn('goodbye: GOODBYE_CHANNEL_ID belum di-set, fitur goodbye nonaktif');
  if (!cfg.inviteLogChannelId) console.warn('invite: INVITE_LOG_CHANNEL_ID belum di-set, invite log tidak diposting (hitungan tetap dicatat)');
  if (!cfg.assetCommandChannelId || !cfg.assetDropChannelId) console.warn('war: ASSET_COMMAND_CHANNEL_ID / ASSET_DROP_CHANNEL_ID belum di-set, /war nonaktif');
  warStart();
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
    awardXp(message.guild.id, message.author.id);
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

client.on(Events.MessageReactionAdd, (reaction, user) => {
  warOnReaction(reaction, user).catch((err) => console.error('war reaction error:', err));
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (await warHandleCommand(interaction)) return;
    if (interaction.commandName === 'obfu-file') {
      await handleObfuFile(interaction);
    } else if (interaction.commandName === 'obfu-link') {
      await handleObfuLink(interaction);
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
  warStop();
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
