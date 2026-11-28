'use strict';
// Menambahkan kartu gambar ke setiap balasan bot yang belum punya gambar.
// Dipasang sekali lewat install(). Kalau renderer tidak tersedia, tidak ada yang diubah.
// Pesan yang sudah punya file/gambar, atau memakai Components V2, dibiarkan apa adanya.
// Kalau render kartu gagal, pesan asli tetap dikirim.

const MARK = Symbol('infoCardInstalled');
const IS_COMPONENTS_V2 = 1 << 15;   // MessageFlags.IsComponentsV2
const IMAGE_BASE = 'info';   // ekstensi (.gif atau .png) mengikuti isi hasil render
// Balasan pertama ke interaksi harus terkirim dalam 3 detik. Anggaran render GIF dibuat ketat di jalur itu;
// terlewati, kartu jatuh ke PNG statis. Nilai ini belum dikalibrasi di server nyata.
const TIGHT_BUDGET_MS = 1600;
const ACK_WINDOW_MS = 3000;   // batas Discord untuk balasan pertama
const ACK_SAFETY_MS = 400;    // sisa untuk selisih jam dan jaringan
const MIN_CARD_MS = 600;      // sama dengan MIN_ATTEMPT_MS di animate.js

function normalize(payload) {
  if (payload === undefined || payload === null) return { content: '' };
  if (typeof payload === 'string') return { content: payload };
  return payload;
}

function embedData(e) {
  return e && (e.data || e);
}

function firstLine(text) {
  return String(text || '').split('\n')[0].trim();
}

// Font kartu tidak punya glyph emoji, jadi emoji dibuang. Markup Discord diganti teks biasa.
// Markdown (**, ##, `) juga dibuang supaya tidak tampil mentah di gambar.
function cleanText(text) {
  return String(text || '')
    .replace(/<@&\d+>/g, '@role')
    .replace(/<@!?\d+>/g, '@user')
    .replace(/<#\d+>/g, '#channel')
    .replace(/<a?:\w+:\d+>/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[*_`~#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Batas panjang teks kartu. Di atas batas ini dipotong "…", di bawahnya seluruh teks ditampilkan.
const TITLE_MAX = 300;
const SUBTITLE_MAX = 900;

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

// Penjelas = seluruh deskripsi embed (semua baris), bukan cuma baris pertama.
function pickTexts(payload) {
  const emb = embedData((payload.embeds || [])[0]);
  const title = cleanText((emb && emb.title) || (emb && emb.author && emb.author.name)
    || firstLine(payload.content) || 'ALLZXRAA');
  const body = (emb && emb.description)
    ? cleanText(emb.description)
    : cleanText(String(payload.content || '').split('\n').slice(1).join(' '));
  return { title: clip(title, TITLE_MAX) || 'ALLZXRAA', subtitle: clip(body, SUBTITLE_MAX) };
}

// Warna aksen diambil dari warna embed pertama (integer Discord -> hex). Tanpa warna: null.
function pickAccent(payload) {
  const emb = embedData((payload.embeds || [])[0]);
  const c = emb && emb.color;
  if (!Number.isInteger(c) || c < 0 || c > 0xffffff) return null;
  return '#' + c.toString(16).padStart(6, '0');
}

// Hanya lampiran gambar yang dihitung. Lampiran lain (mis. file .obf.lua) tidak membuat kartu dilewati.
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
function isImageFile(file) {
  const name = file && (file.name || (file.data && file.data.name));
  return typeof name === 'string' && IMAGE_EXT.test(name);
}

// Mention (user, role, channel) harus tetap berupa mention Discord asli, jadi tidak boleh diubah jadi teks biasa.
const MENTION = /<(?:@[!&]?|#)\d+>/;
// Baris yang berisi mention (teks asli, belum dibersihkan) dari content dan embed.
function mentionLines(payload) {
  const lines = [];
  const take = (text) => String(text || '').split('\n').forEach((l) => { if (MENTION.test(l)) lines.push(l); });
  take(payload.content);
  for (const e of payload.embeds || []) {
    const d = embedData(e);
    if (d) { take(d.title); take(d.description); }
  }
  return lines.join('\n');
}

// Teks kartu tidak boleh memuat mention: nama member sudah ada di baris teks di atas gambar.
// Mention dibuang dari teks kartu (bukan diganti '@user' seperti cleanText).
const MENTION_ANY = /<(?:@[!&]?|#)\d+>/g;
function stripMentions(text) {
  return String(text ?? '').replace(MENTION_ANY, '').replace(/[ \t]{2,}/g, ' ').replace(/ +([,.!?:])/g, '$1').trim();
}

function forCard(payload) {
  const embeds = (payload.embeds || []).map((e) => {
    const d = embedData(e);
    if (!d) return e;
    return {
      ...e,
      data: {
        ...d,
        title: d.title ? stripMentions(d.title) : d.title,
        description: d.description ? stripMentions(d.description) : d.description,
      },
    };
  });
  return { ...payload, content: stripMentions(payload.content), embeds };
}

function alreadyHasImage(payload) {
  if (Array.isArray(payload.files) && payload.files.some(isImageFile)) return true;
  return (payload.embeds || []).some((e) => {
    const d = embedData(e);
    return Boolean(d && d.image);
  });
}

function isComponentsV2(payload) {
  return Boolean(payload.flags && (Number(payload.flags) & IS_COMPONENTS_V2));
}

async function addCard(rawPayload, { cards, discord, budgetMs }) {
  // keepEmbed: pesan ini tetap embed (mis. panel obfuscate). Penanda dibuang sebelum dikirim.
  if (rawPayload && typeof rawPayload === 'object' && rawPayload.keepEmbed) {
    const { keepEmbed, ...rest } = rawPayload;
    return rest;
  }
  const payload = normalize(rawPayload);
  if (alreadyHasImage(payload) || isComponentsV2(payload)) return rawPayload;
  const { title, subtitle } = pickTexts(forCard(payload));
  let png;
  try {
    png = await cards.renderInfoCard({ title, subtitle, accent: pickAccent(payload), budgetMs });
  } catch {
    return rawPayload;   // render gagal: kirim pesan asli
  }
  const { AttachmentBuilder } = discord;
  const name = typeof cards.cardFileName === 'function' ? cards.cardFileName(IMAGE_BASE, png) : `${IMAGE_BASE}.png`;
  const files = [...(payload.files || []), new AttachmentBuilder(png, { name })];
  // Tanpa embed: kartu jadi gambar. Baris yang berisi mention ditaruh sebagai teks di atas gambar.
  return { ...payload, content: mentionLines(payload), embeds: [], files };
}

// Semua jalur kirim pesan bot. Class yang tidak ada di versi discord.js ini dilewati.
const TARGETS = [
  ['ChatInputCommandInteraction', ['reply', 'editReply', 'followUp']],
  ['MessageComponentInteraction', ['reply', 'editReply', 'followUp']],
  ['ModalSubmitInteraction', ['reply', 'editReply', 'followUp']],
  ['Message', ['reply']],
  ['User', ['send']],
  ['GuildMember', ['send']],
  ['TextChannel', ['send']],
  ['NewsChannel', ['send']],
  ['ThreadChannel', ['send']],
  ['DMChannel', ['send']],
  ['VoiceChannel', ['send']],
];

function install({ cards, discord }) {
  if (!cards || typeof cards.isAvailable !== 'function' || !cards.isAvailable()) return false;
  let installed = 0;
  for (const [className, methods] of TARGETS) {
    const cls = discord[className];
    const proto = cls && cls.prototype;
    if (!proto) continue;
    for (const method of methods) {
      if (typeof proto[method] !== 'function' || proto[method][MARK]) continue;
      const orig = proto[method];
      const wrapped = async function wrappedWithCard(payload, ...rest) {
        const firstReply = method === 'reply' && this.deferred === false && this.replied === false;
        let budgetMs;
        if (firstReply) {
          // Balasan pertama harus sampai ke Discord dalam 3 detik sejak interaction dibuat.
          const age = Date.now() - (Number.isFinite(this.createdTimestamp) ? this.createdTimestamp : Date.now());
          budgetMs = Math.min(TIGHT_BUDGET_MS, ACK_WINDOW_MS - ACK_SAFETY_MS - age);
          if (!(budgetMs >= MIN_CARD_MS)) return orig.call(this, payload, ...rest);   // waktu habis: kirim tanpa kartu
        }
        let next = payload;
        try {
          next = await addCard(payload, { cards, discord, budgetMs });
        } catch {
          next = payload;
        }
        return orig.call(this, next, ...rest);
      };
      wrapped[MARK] = true;
      proto[method] = wrapped;
      installed += 1;
    }
  }
  return installed > 0;
}

module.exports = { install, addCard, pickTexts, pickAccent, cleanText, alreadyHasImage, isComponentsV2, forCard, stripMentions };
