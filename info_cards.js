'use strict';
// Menambahkan kartu gambar ke setiap balasan bot yang belum punya gambar.
// Dipasang sekali lewat install(). Kalau renderer tidak tersedia, tidak ada yang diubah.
// Pesan yang sudah punya file/gambar, atau memakai Components V2, dibiarkan apa adanya.
// Kalau render kartu gagal, pesan asli tetap dikirim.

const MARK = Symbol('infoCardInstalled');
const IS_COMPONENTS_V2 = 1 << 15;   // MessageFlags.IsComponentsV2
const IMAGE_NAME = 'info.png';
const IMAGE_REF = `attachment://${IMAGE_NAME}`;

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

function pickTexts(payload) {
  const emb = embedData((payload.embeds || [])[0]);
  const title = (emb && emb.title) || (emb && emb.author && emb.author.name)
    || firstLine(payload.content) || 'ALLZXRAA';
  const subtitle = (emb && emb.description && firstLine(emb.description))
    || String(payload.content || '').split('\n').slice(1).join(' ').trim().slice(0, 120)
    || '';
  return { title: String(title).slice(0, 80), subtitle: subtitle.slice(0, 120) };
}

function alreadyHasImage(payload) {
  if (Array.isArray(payload.files) && payload.files.length > 0) return true;
  return (payload.embeds || []).some((e) => {
    const d = embedData(e);
    return Boolean(d && d.image);
  });
}

function isComponentsV2(payload) {
  return Boolean(payload.flags && (Number(payload.flags) & IS_COMPONENTS_V2));
}

async function addCard(rawPayload, { cards, discord }) {
  const payload = normalize(rawPayload);
  if (alreadyHasImage(payload) || isComponentsV2(payload)) return rawPayload;
  const { title, subtitle } = pickTexts(payload);
  let png;
  try {
    png = await cards.renderInfoCard({ title, subtitle });
  } catch {
    return rawPayload;   // render gagal: kirim pesan asli
  }
  const { EmbedBuilder, AttachmentBuilder } = discord;
  const files = [...(payload.files || []), new AttachmentBuilder(png, { name: IMAGE_NAME })];
  const embeds = [...(payload.embeds || [])];
  if (embeds.length > 0) {
    const first = embeds[0];
    if (typeof first.setImage === 'function') {
      first.setImage(IMAGE_REF);
    } else {
      embeds[0] = { ...first, image: { url: IMAGE_REF } };
    }
  } else {
    embeds.push(new EmbedBuilder().setImage(IMAGE_REF));
  }
  return { ...payload, embeds, files };
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
        let next = payload;
        try {
          next = await addCard(payload, { cards, discord });
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

module.exports = { install, addCard, pickTexts, alreadyHasImage, isComponentsV2 };
