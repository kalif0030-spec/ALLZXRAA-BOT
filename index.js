'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, Client,
  EmbedBuilder, Events, GatewayIntentBits, MessageFlags, SlashCommandBuilder,
} = require('discord.js');

// ===== config =====
function readLocalConfig() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8');
    const data = JSON.parse(raw);
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

function cleanInt(v, fallback) {
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n > 0 && n <= 1000 ? n : fallback;
}

function loadConfig() {
  const local = readLocalConfig();
  const pick = (envName, key) => process.env[envName] || local[key];
  const links = local.links && typeof local.links === 'object' ? local.links : {};

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

  const gated = process.env.GATED_HOSTS ||
    (Array.isArray(local.gatedHosts) ? local.gatedHosts.join(',') : '');

  return Object.freeze({
    botToken: token,
    maxHops: 10,
    requestTimeoutMs: 10000,
    // UNSET: belum ada endpoint provider terverifikasi. null != string kosong.
    providerUrl: pick('BYPASS_PROVIDER_URL', 'providerUrl') || null,
    // UNSET: key JSON di respons provider yang berisi link hasil.
    providerResultKey: pick('BYPASS_PROVIDER_KEY', 'providerResultKey') || null,
    gatedHosts: new Set(
      gated.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)
    ),
    // Tampilan embed. Default merek = ASUMSI dari nama bot/repo-mu, ganti kalau salah.
    brandName: cleanText(pick('BRAND_NAME', 'brandName'), 'ALLZXRAA'),
    poweredBy: cleanText(pick('POWERED_BY', 'poweredBy'), 'ALLZXRAA Ecosystem'),
    sourceLabel: cleanText(pick('SOURCE_LABEL', 'sourceLabel'), 'ALLZXRAA Bypass').slice(0, 80),
    thumbnailUrl: cleanUrl(pick('THUMBNAIL_URL', 'thumbnailUrl')),
    // Default 3 diambil dari screenshot ("2/3 Kuota"). Reset harian 00:00 WIB = asumsiku.
    quotaPerDay: cleanInt(pick('QUOTA_PER_DAY', 'quotaPerDay'), 3),
    // UNSET kalau kosong: tombolnya tidak ditampilkan, tidak ada URL karangan.
    links: Object.freeze({
      server: cleanUrl(pick('LINK_SERVER', '') || links.server),
      bot: cleanUrl(pick('LINK_BOT', '') || links.bot),
      website: cleanUrl(pick('LINK_WEBSITE', '') || links.website),
      feedback: cleanUrl(pick('LINK_FEEDBACK', '') || links.feedback),
    }),
  });
}

// ===== kuota =====
const DEFAULT_FILE = path.join(__dirname, 'quota.json');

function dayKey() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());
}

function createQuota(limit, file = DEFAULT_FILE) {
  let state = { day: dayKey(), used: {} };
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (d && typeof d.day === 'string' && d.used && typeof d.used === 'object') state = d;
  } catch {
    // belum ada file kuota: mulai dari nol
  }

  function roll() {
    const k = dayKey();
    if (state.day !== k) state = { day: k, used: {} };
  }

  function save() {
    try {
      fs.writeFileSync(file, JSON.stringify(state));
    } catch {
      // penyimpanan best-effort: kuota tetap jalan di memori
    }
  }

  return {
    limit,
    remaining(userId) {
      roll();
      return Math.max(0, limit - (state.used[userId] || 0));
    },
    consume(userId) {
      roll();
      const used = state.used[userId] || 0;
      if (used >= limit) return false;
      state.used[userId] = used + 1;
      save();
      return true;
    },
    refund(userId) {
      roll();
      const used = state.used[userId] || 0;
      if (used > 0) {
        state.used[userId] = used - 1;
        save();
      }
    },
  };
}

// ===== resolver link =====
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

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
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return u.href;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

async function checkHost(host) {
  if (!host) return { ok: false, reason: 'host kosong' };
  const bare = host.replace(/^\[|\]$/g, '');
  let infos;
  try {
    infos = await dns.lookup(bare, { all: true });
  } catch (err) {
    return { ok: false, reason: `DNS gagal (${err.code || err.name})` };
  }
  if (infos.length === 0) return { ok: false, reason: 'DNS tidak mengembalikan alamat' };
  const bad = infos.find(
    (i) => blocked.check(i.address, i.family === 6 ? 'ipv6' : 'ipv4')
  );
  if (bad) return { ok: false, reason: `resolve ke IP non-publik ${bad.address}` };
  return { ok: true, reason: '' };
}

async function followRedirects(url, cfg) {
  const hops = [url];
  let current = url;
  for (let i = 0; i < cfg.maxHops; i++) {
    const host = hostOf(current);
    const check = await checkHost(host);
    if (!check.ok) {
      return { ok: false, finalUrl: null, hops, note: `host ${host} ditolak: ${check.reason}` };
    }
    let res;
    try {
      res = await fetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(cfg.requestTimeoutMs),
      });
    } catch (err) {
      return { ok: false, finalUrl: null, hops, note: `request gagal: ${err.name}` };
    }
    const location = res.headers.get('location');
    const status = res.status;
    await res.body?.cancel().catch(() => {});
    if (REDIRECT_CODES.has(status) && location) {
      const next = parseHttpUrl(new URL(location, current).href);
      if (next === null) {
        return { ok: false, finalUrl: null, hops, note: 'redirect ke target non-http' };
      }
      hops.push(next);
      current = next;
      continue;
    }
    return { ok: true, finalUrl: current, hops, note: `status akhir ${status}` };
  }
  return { ok: false, finalUrl: null, hops, note: `menyerah setelah ${cfg.maxHops} hop` };
}

async function askProvider(url, cfg) {
  if (cfg.providerUrl === null || cfg.providerResultKey === null) {
    return {
      ok: false, finalUrl: null, hops: [url],
      note: 'provider belum dikonfigurasi (BYPASS_PROVIDER_URL / BYPASS_PROVIDER_KEY belum di-set)',
    };
  }
  let data;
  try {
    const endpoint = new URL(cfg.providerUrl);
    endpoint.searchParams.set('url', url);
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(cfg.requestTimeoutMs) });
    if (!res.ok) {
      return { ok: false, finalUrl: null, hops: [url], note: `provider membalas HTTP ${res.status}` };
    }
    data = await res.json();
  } catch (err) {
    return { ok: false, finalUrl: null, hops: [url], note: `provider gagal: ${err.name}` };
  }
  const out = data && typeof data === 'object' ? data[cfg.providerResultKey] : null;
  const target = typeof out === 'string' ? parseHttpUrl(out) : null;
  if (target === null) {
    return { ok: false, finalUrl: null, hops: [url], note: 'respons provider tidak berisi link yang valid' };
  }
  return { ok: true, finalUrl: target, hops: [url, target], note: 'di-resolve lewat provider' };
}

async function resolve(raw, cfg) {
  const url = parseHttpUrl(raw);
  if (url === null) {
    return { ok: false, finalUrl: null, hops: [], note: 'itu bukan link http(s)' };
  }
  if (cfg.gatedHosts.has(hostOf(url))) {
    return askProvider(url, cfg);
  }
  const res = await followRedirects(url, cfg);
  if (res.ok && cfg.gatedHosts.has(hostOf(res.finalUrl))) {
    return askProvider(res.finalUrl, cfg);
  }
  if (res.ok && res.hops.length === 1) {
    return {
      ok: false, finalUrl: null, hops: res.hops,
      note: 'link ini tidak mengarah ke tujuan lain (tidak ada redirect). Kalau ini link berpagar, butuh provider: isi GATED_HOSTS + BYPASS_PROVIDER_URL + BYPASS_PROVIDER_KEY.',
    };
  }
  return res;
}

// ===== bot =====
const COLOR_OK = 0x57f287;
const COLOR_FAIL = 0xed4245;
const COPY_TTL_MS = 6 * 60 * 60 * 1000;
const COPY_MAX_ENTRIES = 500;

const cfg = loadConfig();
const quota = createQuota(cfg.quotaPerDay);
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const command = new SlashCommandBuilder()
  .setName('bypass')
  .setDescription('Resolve link ke tujuan akhirnya')
  .addStringOption((o) =>
    o.setName('link').setDescription('Link yang mau di-resolve').setRequired(true)
  );

const copyStore = new Map();

function rememberResult(text) {
  const now = Date.now();
  for (const [key, value] of copyStore) {
    if (value.expires <= now) copyStore.delete(key);
  }
  while (copyStore.size >= COPY_MAX_ENTRIES) {
    copyStore.delete(copyStore.keys().next().value);
  }
  const id = crypto.randomUUID();
  copyStore.set(id, { text, expires: now + COPY_TTL_MS });
  return id;
}

function footerText(user, remaining) {
  return `Requested by ${user.username} • Sisa: ${remaining}/${cfg.quotaPerDay} Kuota • Powered by ${cfg.poweredBy}`;
}

function successEmbed(interaction, finalUrl, remaining) {
  const shown = finalUrl.replaceAll('`', '%60').slice(0, 980);
  const embed = new EmbedBuilder()
    .setColor(COLOR_OK)
    .setAuthor({ name: 'Bypass Successful', iconURL: client.user.displayAvatarURL() })
    .setDescription(`${cfg.brandName} — Fast and simple link processing.`)
    .addFields({ name: 'Result', value: '```\n' + shown + '\n```' })
    .setFooter({ text: footerText(interaction.user, remaining), iconURL: interaction.user.displayAvatarURL() })
    .setTimestamp();
  if (cfg.thumbnailUrl) embed.setThumbnail(cfg.thumbnailUrl);
  return embed;
}

function failEmbed(interaction, title, note, remaining) {
  return new EmbedBuilder()
    .setColor(COLOR_FAIL)
    .setAuthor({ name: title, iconURL: client.user.displayAvatarURL() })
    .setDescription(String(note).slice(0, 1500))
    .setFooter({ text: footerText(interaction.user, remaining), iconURL: interaction.user.displayAvatarURL() })
    .setTimestamp();
}

function linkButton(label, url) {
  return new ButtonBuilder().setLabel(label).setStyle(ButtonStyle.Link).setURL(url);
}

function buildRows(copyId, elapsedMs) {
  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`copy:${copyId}`).setLabel('Copy').setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('noop:time')
        .setLabel(`${(elapsedMs / 1000).toFixed(2)}s`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId('noop:source')
        .setLabel(cfg.sourceLabel)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true)
    ),
  ];
  const middle = [
    ['Server', cfg.links.server],
    ['Bot', cfg.links.bot],
    ['Website', cfg.links.website],
  ].filter(([, url]) => url).map(([label, url]) => linkButton(label, url));
  if (middle.length > 0) rows.push(new ActionRowBuilder().addComponents(middle));
  if (cfg.links.feedback) {
    rows.push(new ActionRowBuilder().addComponents(linkButton('Feedback', cfg.links.feedback)));
  }
  return rows;
}

async function handleBypass(interaction) {
  await interaction.deferReply();
  const started = Date.now();
  const userId = interaction.user.id;

  if (!quota.consume(userId)) {
    await interaction.editReply({
      embeds: [failEmbed(
        interaction,
        'Kuota Habis',
        `Kuota harian kamu sudah habis (0/${cfg.quotaPerDay}). Kuota di-reset tiap hari pukul 00:00 WIB.`,
        0
      )],
    });
    return;
  }

  let res;
  try {
    res = await resolve(interaction.options.getString('link', true), cfg);
  } catch (err) {
    console.error('resolve error:', err);
    res = { ok: false, finalUrl: null, hops: [], note: `error internal: ${err.name}` };
  }

  if (!res.ok) {
    quota.refund(userId);
    await interaction.editReply({
      embeds: [failEmbed(interaction, 'Bypass Failed', res.note, quota.remaining(userId))],
    });
    return;
  }

  await interaction.editReply({
    embeds: [successEmbed(interaction, res.finalUrl, quota.remaining(userId))],
    components: buildRows(rememberResult(res.finalUrl), Date.now() - started),
  });
}

async function handleCopy(interaction) {
  const entry = copyStore.get(interaction.customId.slice('copy:'.length));
  if (!entry || entry.expires <= Date.now()) {
    await interaction.reply({
      content: 'Hasil ini sudah kedaluwarsa, jalankan /bypass lagi.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (entry.text.length <= 1900) {
    await interaction.reply({ content: entry.text, flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.reply({
    content: 'Hasilnya panjang, ini dalam bentuk file:',
    files: [new AttachmentBuilder(Buffer.from(entry.text, 'utf8'), { name: 'result.txt' })],
    flags: MessageFlags.Ephemeral,
  });
}

client.once(Events.ClientReady, async (c) => {
  await c.application.commands.set([command.toJSON()]);
  console.log(`Login sebagai ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'bypass') {
      await handleBypass(interaction);
    } else if (interaction.isButton() && interaction.customId.startsWith('copy:')) {
      await handleCopy(interaction);
    }
  } catch (err) {
    console.error('interaction error:', err);
  }
});

process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));

client.login(cfg.botToken);
