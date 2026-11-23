"use strict";
/*
 * Naya bot (discord.js v14). Port dari BOT_ALLZXRAA.py.
 * Install: npm install
 * Jalankan: npm start
 * Privileged intents yang harus aktif di Developer Portal: Server Members Intent, Message Content Intent.
 * Data disimpan di folder data/, gambar di folder assets/ (sebelah file ini).
 * Drop, giveaway, dan AFK yang sedang berjalan hanya di memori, hilang kalau bot restart.
 */
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  EmbedBuilder,
  AttachmentBuilder,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ChannelType,
  MessageFlags,
} = require("discord.js");
const { joinVoiceChannel, getVoiceConnection, entersState, VoiceConnectionStatus } = require("@discordjs/voice");

// ---------------------------------------------------------------------------
// Konstanta, helper, dan penyimpanan
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Konfigurasi. Isi TOKEN di sini. File ini berisi token, jangan dibagikan.
// ID Discord ditulis sebagai string supaya tidak kehilangan presisi di JavaScript.
// ---------------------------------------------------------------------------
const cfg = {
  TOKEN: process.env.TOKEN ?? "", // dari environment variable TOKEN di panel hosting
  GUILD_ID: "1540584064464191599", // ID server untuk sync slash command cepat, "" = sync global
  WELCOME_CHANNEL_ID: "1540584065068048405", // ID channel welcome dan goodbye, "" = nonaktif
  INVITE_LOG_CHANNEL_ID: "1574202934365790258", // ID channel log invite, "" = nonaktif
  WELCOME_BG: "welcome.png", // nama file di folder assets/, "" = pesan teks saja
  GOODBYE_BG: "goodbye.png", // nama file di folder assets/, "" = pesan teks saja
  BANNER_NAME: "banner.png", // nama file banner di folder assets/, "" = tanpa banner
  GAMBAR_JENIS: { welcome: "welcome.png", goodbye: "goodbye.png", banner: "banner.png" },
  BOT_NAME: "Naya", // nickname bot di setiap server
  WELCOME_TITLE: "🎉 SELAMAT DATANG DI {server} 🎉",
  WELCOME_TEXT: "Halo {user}, welcome to **{server}**!\nSemoga betah dan jadi bagian dari keluarga kita! 🎉",
  GOODBYE_TITLE: "👋 SAMPAI JUMPA!",
  GOODBYE_TEXT:
    "❗ **{user}** udah keluar dari **{server}**.\n" +
    "Makasih udah mampir. Pintu kami tetap terbuka kalau kamu mau balik lagi. 🙏\n\n" +
    "Semoga sukses dan sehat selalu di mana pun kamu berada! ✨",
  // Daftar link channel di embed welcome: [label, ID channel]. ID "" = dilewati.
  CHANNEL_LINKS: [
    ["📜 Baca aturan dulu di", "1543953082507989052"],
    ["⭐ Ambil role di", "1541799302098325564"],
    ["💬 Ngobrol santai di", ""],
  ],
};

const EPHEMERAL = { flags: MessageFlags.Ephemeral };
const BASE = path.join(__dirname, "data");
const DROP_DIR = path.join(BASE, "drops");
const ASSET_DIR = path.join(__dirname, "assets");
fs.mkdirSync(DROP_DIR, { recursive: true });

const DROP_EMOJI = "🔥";
const DROP_MAX_BYTES = 8 * 1024 * 1024;
const GIVEAWAY_BUTTON_ID = "naya:giveaway";
const FLAG_PERM = {
  manage_roles: PermissionFlagsBits.ManageRoles,
  manage_guild: PermissionFlagsBits.ManageGuild,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const nowSec = () => Date.now() / 1000;
const isSnowflake = (s) => /^\d+$/.test(s);
const ephemeral = (content) => ({ content, ...EPHEMERAL });
const logErr = (where) => (err) => console.error(where, err);

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function fmt(tpl, vars) {
  let s = tpl;
  for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

function levelDariXp(xp) {
  return Math.floor(Math.sqrt(xp / 100));
}

function fmtTanggal(date) {
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function fileAda(file) {
  try {
    const s = fs.statSync(file);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

function load(name, fallback) {
  const p = path.join(BASE, name);
  if (!fs.existsSync(p)) return fallback;
  // ID Discord 16 digit ke atas di file lama dibaca sebagai string supaya tidak kehilangan presisi
  const teks = fs.readFileSync(p, "utf8").replace(/("\s*:\s*)(\d{16,})(?=\s*[,}\]])/g, '$1"$2"');
  return JSON.parse(teks);
}

function save(name, data) {
  fs.mkdirSync(BASE, { recursive: true });
  fs.writeFileSync(path.join(BASE, name), JSON.stringify(data, null, 1), "utf8");
}

function isAdmin(i) {
  return !!i.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

function punya(i, perm) {
  const p = i.memberPermissions;
  return !!p && (p.has(PermissionFlagsBits.Administrator) || p.has(FLAG_PERM[perm]));
}

// Target = member yang dipilih di opsi, atau pemanggil sendiri
async function getTarget(i, name = "member") {
  const u = i.options.getUser(name);
  return i.guild.members.fetch(u ? u.id : i.user.id);
}

// Emoji disimpan sebagai "🔥" atau "nama:id" untuk emoji custom
function normEmoji(s) {
  const m = /^<a?:(\w+):(\d+)>$/.exec(s.trim());
  return m ? `${m[1]}:${m[2]}` : s.trim();
}

function emojiDariReaction(e) {
  return e.id ? `${e.name}:${e.id}` : e.name;
}

const rrKey = (msgId, emoji) => `${msgId}:${emoji}`;

// Data tersimpan (format sama dengan versi Python)
const rr = load("reaction_role.json", {}); // "msgid:emoji" -> role_id
const afk = load("afk.json", {}); // "gid:uid" -> {alasan, sejak}
const xpData = load("xp.json", {}); // "gid:uid" -> {xp, last}
const hitung = load("invites.json", {}); // gid -> {inviter_id: jumlah}

// State di memori saja
const giveaways = new Map(); // message_id -> state
const drops = new Map(); // message_id -> state
const inviteCache = new Map(); // gid -> Map(code -> uses)

// ---------------------------------------------------------------------------
// Sambutan: welcome dan goodbye
// ---------------------------------------------------------------------------

function barisLink() {
  return cfg.CHANNEL_LINKS.filter(([, cid]) => cid)
    .map(([label, cid]) => `» ${label} <#${cid}>`)
    .join("\n");
}

async function kirimSambutan(channel, member, judulTpl, teksTpl, gambarName, welcome) {
  const guild = member.guild;
  const user = welcome ? `<@${member.id}>` : member.displayName ?? member.user.username;
  let deskripsi = fmt(teksTpl, { user, server: guild.name });
  if (welcome) {
    const links = barisLink();
    if (links) deskripsi += "\n\n" + links;
  }

  const embed = new EmbedBuilder()
    .setTitle(fmt(judulTpl, { server: guild.name }))
    .setDescription(deskripsi)
    .setColor(welcome ? 0xfaa61a : 0xed4245);

  if (welcome) {
    if (guild.icon) embed.setThumbnail(guild.iconURL());
    embed.setFooter({ text: `👥 Jumlah member: ${guild.memberCount}` });
  } else {
    embed.setThumbnail(
      typeof member.displayAvatarURL === "function" ? member.displayAvatarURL() : member.user.displayAvatarURL()
    );
  }

  const payload = { content: welcome ? `<@${member.id}>` : undefined, embeds: [embed], files: [] };
  // Kalau gambar tidak ada atau kosong (0 byte), embed tetap dikirim tanpa gambar
  const gambar = gambarName ? path.join(ASSET_DIR, gambarName) : null;
  if (gambar && fileAda(gambar)) {
    payload.files = [new AttachmentBuilder(gambar, { name: path.basename(gambar) })];
    embed.setImage(`attachment://${path.basename(gambar)}`);
  }
  await channel.send(payload);
}

async function onMemberJoinSambutan(member) {
  if (member.user.bot || !cfg.WELCOME_CHANNEL_ID) return;
  const ch = member.guild.channels.cache.get(cfg.WELCOME_CHANNEL_ID);
  if (!ch) return;
  await kirimSambutan(ch, member, cfg.WELCOME_TITLE, cfg.WELCOME_TEXT, cfg.WELCOME_BG, true).catch(logErr("welcome:"));
}

async function onMemberRemoveSambutan(member) {
  if (member.user?.bot || !cfg.WELCOME_CHANNEL_ID) return;
  const ch = member.guild.channels.cache.get(cfg.WELCOME_CHANNEL_ID);
  if (!ch) return;
  await kirimSambutan(ch, member, cfg.GOODBYE_TITLE, cfg.GOODBYE_TEXT, cfg.GOODBYE_BG, false).catch(logErr("goodbye:"));
}

async function cmdSetGambar(i) {
  if (!isAdmin(i)) return i.reply(ephemeral("khusus admin ya, sayang"));
  const canal = i.options.getChannel("canal", true);
  const pesanId = i.options.getString("pesan_id", true);
  const jenis = i.options.getString("jenis", true);
  if (!isSnowflake(pesanId)) return i.reply(ephemeral("ID pesan harus angka, sayang"));

  await i.deferReply(EPHEMERAL);
  let msg;
  try {
    msg = await canal.messages.fetch(pesanId);
  } catch {
    return i.editReply("pesan itu nggak ketemu, cek lagi channel dan ID-nya ya");
  }
  const gambar = msg.attachments.find((a) => (a.contentType ?? "").startsWith("image/"));
  if (!gambar) return i.editReply("pesan itu nggak punya gambar, sayang");
  if (gambar.size > 8 * 1024 * 1024) return i.editReply("gambarnya kebesaran, maksimal 8 MB ya");

  const namaFile = cfg.GAMBAR_JENIS[jenis];
  try {
    fs.mkdirSync(ASSET_DIR, { recursive: true });
    const res = await fetch(gambar.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fs.writeFileSync(path.join(ASSET_DIR, namaFile), Buffer.from(await res.arrayBuffer()));
  } catch {
    return i.editReply("aduh, gambar gagal diunduh, coba lagi ya");
  }
  return i.editReply(`gambar ${jenis} tersimpan sebagai \`${namaFile}\` dari pesan \`${msg.id}\` ✨`);
}

// ---------------------------------------------------------------------------
// Reaction role
// ---------------------------------------------------------------------------

async function cmdReactionRole(i) {
  if (!punya(i, "manage_roles")) return i.reply(ephemeral("butuh izin manage roles ya, beb"));
  const canal = i.options.getChannel("canal", true);
  const pesanId = i.options.getString("pesan_id", true);
  const emojiInput = i.options.getString("emoji", true);
  const role = i.options.getRole("role", true);
  if (!isSnowflake(pesanId)) return i.reply(ephemeral("ID pesan harus angka, sayang"));

  await i.deferReply(EPHEMERAL);
  const key = normEmoji(emojiInput);
  let msg;
  try {
    msg = await canal.messages.fetch(pesanId);
    await msg.react(key);
  } catch {
    return i.editReply("aduh, pesan atau emoji nggak valid");
  }
  rr[rrKey(msg.id, key)] = role.id;
  save("reaction_role.json", rr);
  return i.editReply(`oke, ${emojiInput} sekarang kasih role <@&${role.id}> ✨`);
}

// Partial reaction bisa datang dari pesan yang tidak ada di cache
async function siapkanReaksi(reaction, user) {
  if (reaction.partial) await reaction.fetch();
  if (reaction.message.partial) await reaction.message.fetch();
  if (user.partial) await user.fetch();
  return reaction.message.guild ?? null;
}

async function onReactionAdd(reaction, user) {
  try {
    const guild = await siapkanReaksi(reaction, user);
    if (!guild || user.id === client.user.id) return;

    const roleId = rr[rrKey(reaction.message.id, emojiDariReaction(reaction.emoji))];
    if (roleId) {
      const member = await guild.members.fetch(user.id).catch(() => null);
      const role = guild.roles.cache.get(roleId);
      if (member && !member.user.bot && role) {
        await member.roles.add(role, "reaction role").catch(() => {});
      }
    }

    if (reaction.emoji.name === DROP_EMOJI) {
      const d = drops.get(reaction.message.id);
      if (d && !d.selesai) {
        d.peserta.add(user.id);
        await cekDrop(d);
      }
    }
  } catch (err) {
    console.warn("reaksi add:", err.message);
  }
}

async function onReactionRemove(reaction, user) {
  try {
    const guild = await siapkanReaksi(reaction, user);
    if (!guild) return;

    const roleId = rr[rrKey(reaction.message.id, emojiDariReaction(reaction.emoji))];
    if (roleId) {
      const member = guild.members.cache.get(user.id);
      const role = guild.roles.cache.get(roleId);
      if (member && role && !member.user.bot) {
        await member.roles.remove(role, "reaction role dilepas").catch(() => {});
      }
    }

    if (reaction.emoji.name === DROP_EMOJI) {
      const d = drops.get(reaction.message.id);
      if (d && !d.selesai) d.peserta.delete(user.id);
    }
  } catch (err) {
    console.warn("reaksi remove:", err.message);
  }
}

// ---------------------------------------------------------------------------
// AFK
// ---------------------------------------------------------------------------

async function cmdAfk(i) {
  const alasan = Array.from(i.options.getString("alasan") ?? "lagi sibuk").slice(0, 150).join("");
  afk[`${i.guildId}:${i.user.id}`] = { alasan, sejak: nowSec() };
  save("afk.json", afk);
  return i.reply(ephemeral(`oke, kamu AFK: ${alasan} ✨`));
}

async function onMessageAfk(msg) {
  if (msg.author.bot || !msg.guild) return;
  const gid = msg.guild.id;
  const key = `${gid}:${msg.author.id}`;
  if (afk[key]) {
    delete afk[key];
    save("afk.json", afk);
    await msg.channel.send(`selamat datang kembali <@${msg.author.id}>, status AFK-mu dihapus ✨`).catch(() => {});
  }
  for (const user of msg.mentions.users.values()) {
    if (user.bot) continue;
    const info = afk[`${gid}:${user.id}`];
    if (!info) continue;
    const nama = msg.guild.members.cache.get(user.id)?.displayName ?? user.username;
    await msg.channel.send(`${nama} lagi AFK: ${info.alasan}`).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// XP, level, dan leaderboard
// ---------------------------------------------------------------------------

async function onMessageLevel(msg) {
  if (msg.author.bot || !msg.guild) return;
  const key = `${msg.guild.id}:${msg.author.id}`;
  const rec = xpData[key] ?? { xp: 0, last: 0 };
  const now = nowSec();
  if (now - rec.last < 60) return;

  const lama = rec.xp;
  rec.xp += randInt(15, 25);
  rec.last = now;
  xpData[key] = rec;
  save("xp.json", xpData);

  if (levelDariXp(rec.xp) > levelDariXp(lama)) {
    await msg
      .channel.send(`selamat <@${msg.author.id}>, naik ke level ${levelDariXp(rec.xp)} ✨`)
      .catch(() => {});
  }
}

async function cmdLevel(i) {
  const target = await getTarget(i);
  const xp = (xpData[`${i.guildId}:${target.id}`] ?? { xp: 0 }).xp;
  const lvl = levelDariXp(xp);
  const butuh = 100 * (lvl + 1) ** 2;
  return i.reply(
    `${target.displayName}: level **${lvl}**, XP **${xp}**, butuh **${butuh - xp}** XP lagi untuk naik`
  );
}

async function cmdLeaderboard(i) {
  const prefix = `${i.guildId}:`;
  const rows = Object.entries(xpData)
    .filter(([k]) => k.startsWith(prefix))
    .map(([k, v]) => [k.split(":")[1], v.xp])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  if (rows.length === 0) return i.reply("belum ada yang punya XP di server ini, ayo chat dulu ✨");
  const baris = rows.map(([uid, xp], idx) => `${idx + 1}. <@${uid}>: level ${levelDariXp(xp)} (${xp} XP)`);
  return i.reply("**Leaderboard**\n" + baris.join("\n"));
}

// ---------------------------------------------------------------------------
// Penghitung invite
// ---------------------------------------------------------------------------

async function segarkanInvite(guild) {
  try {
    const invs = await guild.invites.fetch();
    inviteCache.set(guild.id, new Map(invs.map((inv) => [inv.code, inv.uses ?? 0])));
  } catch {
    // tanpa izin Manage Server, cache dibiarkan
  }
}

async function onMemberJoinInvite(member) {
  if (member.user.bot) return;
  const guild = member.guild;
  const sebelum = inviteCache.get(guild.id) ?? new Map();

  let sesudah = null;
  try {
    sesudah = await guild.invites.fetch();
  } catch {
    sesudah = null;
  }

  let pengundang = null;
  if (sesudah) {
    for (const inv of sesudah.values()) {
      if ((inv.uses ?? 0) > (sebelum.get(inv.code) ?? 0) && inv.inviter) {
        pengundang = inv.inviter;
        break;
      }
    }
    inviteCache.set(guild.id, new Map([...sesudah.values()].map((inv) => [inv.code, inv.uses ?? 0])));
  }

  let total = 0;
  if (pengundang) {
    const g = (hitung[guild.id] ??= {});
    const k = pengundang.id;
    g[k] = (g[k] ?? 0) + 1;
    save("invites.json", hitung);
    total = g[k];
  }
  await logInvite(guild, member, pengundang, total);
}

async function logInvite(guild, member, pengundang, total) {
  if (!cfg.INVITE_LOG_CHANNEL_ID) return;
  const ch = guild.channels.cache.get(cfg.INVITE_LOG_CHANNEL_ID);
  if (!ch) return;

  const embed = new EmbedBuilder()
    .setTitle("Invite Tracker")
    .setColor(0x5865f2)
    .addFields(
      { name: "Welcome", value: `<@${member.id}>`, inline: false },
      { name: "Invite By", value: pengundang ? `<@${pengundang.id}>` : "tidak diketahui", inline: false },
      { name: "Total Invite", value: pengundang ? String(total) : "-", inline: false },
      { name: "Total Member", value: String(guild.memberCount), inline: false }
    );

  const payload = { embeds: [embed], files: [] };
  const banner = cfg.BANNER_NAME ? path.join(ASSET_DIR, cfg.BANNER_NAME) : null;
  if (banner && fs.existsSync(banner)) {
    payload.files = [new AttachmentBuilder(banner, { name: path.basename(banner) })];
    embed.setImage(`attachment://${path.basename(banner)}`);
  }
  await ch.send(payload).catch(() => {});
}

async function cmdInviteCount(i) {
  const target = await getTarget(i);
  const n = hitung[i.guildId]?.[target.id] ?? 0;
  return i.reply(`${target.displayName} sudah mengundang **${n}** member ✨`);
}

// ---------------------------------------------------------------------------
// Giveaway
// ---------------------------------------------------------------------------

function giveawayTombol() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(GIVEAWAY_BUTTON_ID)
        .setLabel("Ikut")
        .setEmoji("🎉")
        .setStyle(ButtonStyle.Success)
    ),
  ];
}

async function cmdGiveaway(i) {
  if (!punya(i, "manage_guild")) return i.reply(ephemeral("butuh izin manage server ya, beb"));
  const hadiah = i.options.getString("hadiah", true);
  const menit = i.options.getInteger("menit", true);
  const pemenang = i.options.getInteger("pemenang") ?? 1;

  const embed = new EmbedBuilder()
    .setTitle("🎉 GIVEAWAY")
    .setDescription(
      `hadiah: **${hadiah}**\njumlah pemenang: ${pemenang}\nberakhir dalam ${menit} menit\nklik tombol untuk ikut`
    )
    .setColor(0xff69b4);

  const msg = await i.reply({ embeds: [embed], components: giveawayTombol(), fetchReply: true });
  giveaways.set(msg.id, {
    hadiah,
    peserta: new Set(),
    selesai: false,
    end: Date.now() + menit * 60000,
    pemenang,
    channel: i.channelId,
  });
}

async function onGiveawayButton(i) {
  const g = giveaways.get(i.message.id);
  if (!g || g.selesai) return i.reply(ephemeral("giveaway ini udah selesai, sayang"));
  if (g.peserta.has(i.user.id)) return i.reply(ephemeral("kamu udah ikut kok, beb ✨"));
  g.peserta.add(i.user.id);
  return i.reply(ephemeral("kamu udah ikut, semoga beruntung ✨"));
}

async function cekGiveaway() {
  const now = Date.now();
  for (const g of giveaways.values()) {
    if (g.selesai || now < g.end) continue;
    g.selesai = true;
    const peserta = [...g.peserta];
    const ch = client.channels.cache.get(g.channel);
    if (!ch) continue;
    let teks;
    if (peserta.length > 0) {
      const menang = shuffle(peserta).slice(0, Math.min(g.pemenang, peserta.length));
      teks = menang.map((u) => `<@${u}>`).join(" ") + ` menang **${g.hadiah}** 🎉`;
    } else {
      teks = `giveaway **${g.hadiah}** selesai, tidak ada peserta 🥺`;
    }
    await ch.send(teks).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Drop file dengan reaction 🔥 (khusus admin)
// ---------------------------------------------------------------------------

function teksDrop(nama, butuh) {
  return (
    `pada mau war ga? naya mau drop **${nama}** nih, tapi apiin dulu dong sampe ` +
    `**${butuh}** ${DROP_EMOJI} api ya... @everyone`
  );
}

async function hapusPesanDrop(d) {
  await d.msg.delete().catch(() => {});
}

async function cekDrop(d) {
  if (d.selesai || d.peserta.size < d.butuh) return;
  d.selesai = true;
  try {
    await d.ch.send({ files: [new AttachmentBuilder(d.path, { name: d.nama })] });
  } catch {
    d.selesai = false; // belum berhasil, boleh dicoba lagi saat ada 🔥 berikutnya
    return;
  }
  drops.delete(d.id);
  fs.rmSync(d.path, { force: true });
  await hapusPesanDrop(d);
}

async function cmdDrop(i) {
  if (!isAdmin(i)) return i.reply(ephemeral("khusus admin ya, sayang"));
  const file = i.options.getAttachment("file", true);
  const detik = i.options.getInteger("detik") ?? 1;
  const jumlahApi = i.options.getInteger("jumlah_api") ?? 5;
  if (file.size > DROP_MAX_BYTES) return i.reply(ephemeral("file-nya kebesaran, maksimal 8 MB ya"));

  await i.deferReply(EPHEMERAL);
  const filePath = path.join(DROP_DIR, `${randomUUID().replace(/-/g, "").slice(0, 8)}_${file.name}`);
  try {
    const res = await fetch(file.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fs.writeFileSync(filePath, Buffer.from(await res.arrayBuffer()));
  } catch {
    return i.editReply("aduh, file gagal diunduh, coba lagi ya");
  }

  const channel = i.channel;
  if (!channel?.send) {
    fs.rmSync(filePath, { force: true });
    return i.editReply("aku nggak bisa kirim pesan di channel ini, sayang");
  }

  await channel.sendTyping().catch(() => {});
  await sleep(1000);

  let msg;
  try {
    msg = await channel.send({
      content: teksDrop(file.name, jumlahApi),
      allowedMentions: { parse: ["everyone"] },
    });
    await msg.react(DROP_EMOJI);
  } catch {
    fs.rmSync(filePath, { force: true });
    return i.editReply("aduh, pesan drop gagal dipasang, cek izin bot ya");
  }

  const d = {
    id: msg.id,
    msg,
    ch: channel,
    nama: file.name,
    path: filePath,
    butuh: jumlahApi,
    peserta: new Set(),
    selesai: false,
  };
  drops.set(msg.id, d);
  await i.editReply(`drop \`${file.name}\` dipasang selama ${detik} detik ✨`);

  // Waktu habis: kalau belum terbuka, drop dibatalkan dan file dibuang
  setTimeout(async () => {
    if (d.selesai) return;
    d.selesai = true;
    drops.delete(d.id);
    fs.rmSync(d.path, { force: true });
    await hapusPesanDrop(d);
  }, detik * 1000);
}

// ---------------------------------------------------------------------------
// Pendamping voice
// ---------------------------------------------------------------------------

async function cmdVoiceMasuk(i) {
  const member = await i.guild.members.fetch(i.user.id);
  const vc = member.voice?.channel;
  if (!vc) return i.reply(ephemeral("kamu harus di voice channel dulu, sayang"));
  if (getVoiceConnection(i.guildId)) return i.reply(ephemeral("aku udah di voice channel lain, beb"));

  await i.deferReply();
  const conn = joinVoiceChannel({
    channelId: vc.id,
    guildId: i.guildId,
    adapterCreator: i.guild.voiceAdapterCreator,
    selfDeaf: true,
  });
  try {
    await entersState(conn, VoiceConnectionStatus.Ready, 20000);
  } catch (err) {
    conn.destroy();
    return i.editReply(`aduh, gagal masuk voice: ${err.message}`);
  }
  return i.editReply(`aku udah di ${vc} ✨`);
}

async function cmdVoiceKeluar(i) {
  const conn = getVoiceConnection(i.guildId);
  if (!conn) return i.reply(ephemeral("aku nggak lagi di voice channel, sayang"));
  conn.destroy();
  return i.reply("dadah, aku keluar dari voice ✨");
}

// ---------------------------------------------------------------------------
// Pemantau server dan KTM
// ---------------------------------------------------------------------------

async function cmdPantau(i) {
  const g = i.guild;
  const embed = new EmbedBuilder()
    .setTitle(`Pemantau ${g.name}`)
    .setColor(0x7289da)
    .addFields(
      { name: "Anggota", value: String(g.memberCount) },
      {
        name: "Channel teks",
        value: String(
          g.channels.cache.filter(
            (c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement
          ).size
        ),
      },
      { name: "Channel voice", value: String(g.channels.cache.filter((c) => c.type === ChannelType.GuildVoice).size) },
      { name: "Role", value: String(g.roles.cache.size - 1) },
      { name: "Boost", value: String(g.premiumSubscriptionCount ?? 0) },
      { name: "Dibuat", value: fmtTanggal(g.createdAt) }
    )
    .setFooter({ text: "jumlah online belum dihitung, butuh presence intent" });
  return i.reply({ embeds: [embed] });
}

async function cmdKtm(i) {
  const target = await getTarget(i);
  const gid = i.guildId;
  const xp = (xpData[`${gid}:${target.id}`] ?? { xp: 0 }).xp;
  const invites = hitung[gid]?.[target.id] ?? 0;

  const embed = new EmbedBuilder()
    .setTitle("KARTU TANDA MEMBER")
    .setColor(0xff69b4)
    .setThumbnail(target.displayAvatarURL())
    .addFields(
      { name: "Nama", value: target.displayName },
      { name: "ID", value: target.id },
      { name: "Akun dibuat", value: fmtTanggal(target.user.createdAt) },
      { name: "Gabung server", value: target.joinedAt ? fmtTanggal(target.joinedAt) : "-" },
      { name: "Level", value: String(levelDariXp(xp)) },
      { name: "XP", value: String(xp) },
      { name: "Undangan", value: String(invites) },
      { name: "Role teratas", value: `${target.roles.highest}` }
    );
  return i.reply({ embeds: [embed] });
}

// ---------------------------------------------------------------------------
// Daftar slash command
// ---------------------------------------------------------------------------

const commands = [
  new SlashCommandBuilder()
    .setName("set_gambar")
    .setDescription("Ambil gambar dari pesan (pakai ID) untuk welcome, goodbye, atau banner (khusus admin)")
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption((o) =>
      o.setName("canal").setDescription("Channel tempat pesan berada").addChannelTypes(ChannelType.GuildText).setRequired(true)
    )
    .addStringOption((o) => o.setName("pesan_id").setDescription("ID pesan yang punya gambar").setRequired(true))
    .addStringOption((o) =>
      o
        .setName("jenis")
        .setDescription("Gambar untuk apa")
        .setRequired(true)
        .addChoices({ name: "welcome", value: "welcome" }, { name: "goodbye", value: "goodbye" }, { name: "banner", value: "banner" })
    ),
  new SlashCommandBuilder()
    .setName("reaction_role")
    .setDescription("Pasang role untuk emoji di sebuah pesan")
    .setDMPermission(false)
    .addChannelOption((o) =>
      o.setName("canal").setDescription("Channel pesan").addChannelTypes(ChannelType.GuildText).setRequired(true)
    )
    .addStringOption((o) => o.setName("pesan_id").setDescription("ID pesan").setRequired(true))
    .addStringOption((o) => o.setName("emoji").setDescription("Emoji yang dipakai").setRequired(true))
    .addRoleOption((o) => o.setName("role").setDescription("Role yang diberikan").setRequired(true)),
  new SlashCommandBuilder()
    .setName("afk")
    .setDescription("Tandai dirimu AFK dengan alasan")
    .setDMPermission(false)
    .addStringOption((o) => o.setName("alasan").setDescription("Alasan AFK").setRequired(false)),
  new SlashCommandBuilder()
    .setName("level")
    .setDescription("Lihat XP dan level kamu atau member lain")
    .setDMPermission(false)
    .addUserOption((o) => o.setName("member").setDescription("Member yang mau dilihat").setRequired(false)),
  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("10 member dengan XP tertinggi di server ini")
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName("invite_count")
    .setDescription("Berapa member yang masuk lewat undangan seseorang")
    .setDMPermission(false)
    .addUserOption((o) => o.setName("member").setDescription("Member yang mau dicek").setRequired(false)),
  new SlashCommandBuilder()
    .setName("giveaway")
    .setDescription("Buat giveaway dengan tombol ikut")
    .setDMPermission(false)
    .addStringOption((o) => o.setName("hadiah").setDescription("Nama hadiah").setRequired(true))
    .addIntegerOption((o) =>
      o.setName("menit").setDescription("1 sampai 10080").setRequired(true).setMinValue(1).setMaxValue(10080)
    )
    .addIntegerOption((o) =>
      o.setName("pemenang").setDescription("Jumlah pemenang, 1 sampai 10").setRequired(false).setMinValue(1).setMaxValue(10)
    ),
  new SlashCommandBuilder()
    .setName("drop")
    .setDescription("Drop file, dibuka kalau 🔥 cukup dalam waktu tertentu")
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addAttachmentOption((o) => o.setName("file").setDescription("File yang di-drop, maksimal 8 MB").setRequired(true))
    .addIntegerOption((o) =>
      o.setName("detik").setDescription("Berapa detik pesan drop bertahan, 1 sampai 60").setRequired(false).setMinValue(1).setMaxValue(60)
    )
    .addIntegerOption((o) =>
      o.setName("jumlah_api").setDescription("Jumlah 🔥 yang dibutuhkan, 1 sampai 100").setRequired(false).setMinValue(1).setMaxValue(100)
    ),
  new SlashCommandBuilder()
    .setName("voice_masuk")
    .setDescription("Bot masuk ke voice channel kamu")
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName("voice_keluar")
    .setDescription("Bot keluar dari voice channel")
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName("pantau")
    .setDescription("Ringkasan kondisi server ini")
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName("ktm")
    .setDescription("Kartu tanda member (embed)")
    .setDMPermission(false)
    .addUserOption((o) => o.setName("member").setDescription("Member yang mau dilihat").setRequired(false)),
];

const handlers = {
  set_gambar: cmdSetGambar,
  reaction_role: cmdReactionRole,
  afk: cmdAfk,
  level: cmdLevel,
  leaderboard: cmdLeaderboard,
  invite_count: cmdInviteCount,
  giveaway: cmdGiveaway,
  drop: cmdDrop,
  voice_masuk: cmdVoiceMasuk,
  voice_keluar: cmdVoiceKeluar,
  pantau: cmdPantau,
  ktm: cmdKtm,
};

// ---------------------------------------------------------------------------
// Bot dan entry point
// ---------------------------------------------------------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User, Partials.GuildMember],
});

client.once(Events.ClientReady, async (c) => {
  console.log(`Naya online sebagai ${c.user.tag} (id=${c.user.id})`);

  for (const guild of c.guilds.cache.values()) {
    await segarkanInvite(guild);
    const me = guild.members.me;
    if (me && me.displayName !== cfg.BOT_NAME) {
      await me.setNickname(cfg.BOT_NAME, "nama bot Naya").catch(() => {});
    }
  }

  const data = commands.map((cmd) => cmd.toJSON());
  if (cfg.GUILD_ID) await c.application.commands.set(data, cfg.GUILD_ID);
  else await c.application.commands.set(data);
});

client.on(Events.GuildCreate, (guild) => {
  segarkanInvite(guild).catch(logErr("guildCreate:"));
});

client.on(Events.InviteCreate, (invite) => {
  if (invite.guild) segarkanInvite(invite.guild).catch(logErr("inviteCreate:"));
});

client.on(Events.InviteDelete, (invite) => {
  if (invite.guild) segarkanInvite(invite.guild).catch(logErr("inviteDelete:"));
});

client.on(Events.GuildMemberAdd, (member) => {
  onMemberJoinSambutan(member).catch(logErr("memberAdd sambutan:"));
  onMemberJoinInvite(member).catch(logErr("memberAdd invite:"));
});

client.on(Events.GuildMemberRemove, (member) => {
  onMemberRemoveSambutan(member).catch(logErr("memberRemove:"));
});

client.on(Events.MessageCreate, (msg) => {
  onMessageAfk(msg).catch(logErr("afk:"));
  onMessageLevel(msg).catch(logErr("level:"));
});

client.on(Events.MessageReactionAdd, (reaction, user) => {
  onReactionAdd(reaction, user);
});

client.on(Events.MessageReactionRemove, (reaction, user) => {
  onReactionRemove(reaction, user);
});

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isButton() && i.customId === GIVEAWAY_BUTTON_ID) {
      await onGiveawayButton(i);
      return;
    }
    if (!i.isChatInputCommand()) return;
    const handler = handlers[i.commandName];
    if (!handler) return;
    if (!i.inGuild()) {
      await i.reply(ephemeral("perintah ini cuma bisa dipakai di server, sayang"));
      return;
    }
    await handler(i);
  } catch (err) {
    console.error("interaksi:", err);
    const payload = ephemeral("aduh, ada yang error di aku, coba lagi ya");
    if (i.replied || i.deferred) await i.followUp(payload).catch(() => {});
    else await i.reply(payload).catch(() => {});
  }
});

// Giveaway: cek waktu habis tiap 10 detik
setInterval(() => {
  cekGiveaway().catch(logErr("giveaway:"));
}, 10000);

client.on(Events.ShardError, (err) => console.error("shard error:", err));

function jalankan() {
  if (!cfg.TOKEN || cfg.TOKEN.startsWith("ISI_")) {
    console.error("TOKEN di config.js belum diisi, sayang");
    process.exit(1);
  }
  client.login(cfg.TOKEN).catch((err) => {
    const pesan = String(err?.message ?? err);
    if (err?.code === "TokenInvalid" || /invalid token/i.test(pesan)) {
      console.error("token ditolak Discord: reset token di Developer Portal lalu ganti TOKEN di config.js");
    } else if (/disallowed intents/i.test(pesan)) {
      console.error("nyalakan Server Members Intent dan Message Content Intent di Developer Portal > Bot");
    } else {
      console.error("login gagal:", err);
    }
    process.exit(1);
  });
}

jalankan();
