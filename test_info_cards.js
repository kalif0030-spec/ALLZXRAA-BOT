// Tes dengan mock: @napi-rs/canvas dan discord.js diganti tiruan. Yang diuji adalah logika pembungkus.
const Module = require('module');
const path = require('path');
const origLoad = Module._load;
let fakeRenderFails = false;
const fakeCtx = new Proxy({}, {
  get: (t, k) => {
    if (k === 'measureText') return () => ({ width: 10 });
    if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
    return () => {};
  },
  set: (t, k, v) => { t[k] = v; return true; },
});
const fakeNapi = {
  GlobalFonts: { registerFromPath() {} },
  createCanvas: () => {
    if (fakeRenderFails) throw new Error('render gagal (mock)');
    return { getContext: () => fakeCtx, encode: async () => Buffer.from('png') };
  },
  loadImage: async () => null,
};
class EmbedBuilder {
  constructor(data = {}) { this.data = { ...data }; }
  setImage(u) { this.data.image = { url: u }; return this; }
}
class AttachmentBuilder {
  constructor(buf, { name }) { this.attachment = buf; this.name = name; }
}
class ChatInputCommandInteraction {
  constructor() { this.sent = []; }
  reply(p) { this.sent.push(p); return Promise.resolve('reply'); }
  editReply(p) { this.sent.push(p); return Promise.resolve('edit'); }
}
class TextChannel {
  constructor() { this.sent = []; }
  send(p) { this.sent.push(p); return Promise.resolve('send'); }
}
class ThreadChannel {
  constructor() { this.sent = []; }
  send(p) { this.sent.push(p); return Promise.resolve('thread'); }
}
class DMChannel {
  constructor() { this.sent = []; }
  send(p) { this.sent.push(p); return Promise.resolve('dm'); }
}
class User {
  constructor() { this.sent = []; }
  send(p) { this.sent.push(p); return Promise.resolve('user'); }
}
class Message {
  constructor() { this.sent = []; }
  reply(p) { this.sent.push(p); return Promise.resolve('msg'); }
}
Module._load = function (req, parent, isMain) {
  if (req === '@napi-rs/canvas') return fakeNapi;
  if (req === 'discord.js') return { EmbedBuilder, AttachmentBuilder, ChatInputCommandInteraction, TextChannel, ThreadChannel, DMChannel, User, Message };
  return origLoad.apply(this, arguments);
};
const cards = require(path.join(__dirname, '..', 'cards.js'));
const info = require(path.join(__dirname, '..', 'info_cards.js'));
const discord = { EmbedBuilder, AttachmentBuilder, ChatInputCommandInteraction, TextChannel, ThreadChannel, DMChannel, User, Message };

let ok = 0, fail = 0;
const res = (n, g, x = '') => { g ? ok++ : fail++; console.log(g ? 'OK  ' : 'FAIL', n, x); };

res('cards.isAvailable (mock) true', cards.isAvailable() === true);
res('install memasang pembungkus', info.install({ cards, discord }) === true);

(async () => {
  const i1 = new ChatInputCommandInteraction();
  await i1.reply({ content: 'Halo\nbaris kedua' });
  const p1 = i1.sent[0];
  res('teks biasa dapat file info.png', p1.files.length === 1 && p1.files[0].name === 'info.png');
  res('teks biasa dapat embed dengan gambar', p1.embeds.length === 1 && p1.embeds[0].data.image.url === 'attachment://info.png');
  res('pesan asli tetap ada', p1.content === 'Halo\nbaris kedua');

  const i2 = new ChatInputCommandInteraction();
  await i2.reply('string saja');
  res('payload string dinormalisasi', i2.sent[0].content === 'string saja' && i2.sent[0].files.length === 1);

  const i3 = new ChatInputCommandInteraction();
  const withFile = { content: 'x', files: [{ name: 'a.png' }] };
  await i3.editReply(withFile);
  res('pesan dengan file dibiarkan', i3.sent[0] === withFile);

  const i4 = new ChatInputCommandInteraction();
  const withImg = { embeds: [{ data: { title: 'T', image: { url: 'https://x' } } }] };
  await i4.reply(withImg);
  res('embed yang sudah punya gambar dibiarkan', i4.sent[0] === withImg);

  const i5 = new ChatInputCommandInteraction();
  const v2 = { content: 'v2', flags: 1 << 15 };
  await i5.reply(v2);
  res('Components V2 dibiarkan', i5.sent[0] === v2);

  const ch = new TextChannel();
  const emb = new EmbedBuilder({ title: 'Judul', description: 'Deskripsi pendek' });
  await ch.send({ embeds: [emb] });
  res('channel.send dapat kartu', ch.sent[0].files.length === 1 && emb.data.image.url === 'attachment://info.png');
  res('judul diambil dari embed', ch.sent[0].files[0].name === 'info.png');

  fakeRenderFails = true;
  const i6 = new ChatInputCommandInteraction();
  const plain = { content: 'render gagal' };
  await i6.reply(plain);
  res('render gagal: pesan asli dikirim', i6.sent[0] === plain);
  fakeRenderFails = false;

  const i7 = new ChatInputCommandInteraction();
  await i7.reply({ content: 'sekali lagi' });
  res('pemasangan ulang tidak menumpuk pembungkus', info.install({ cards, discord }) === false);

  // renderer tidak tersedia: tidak ada yang berubah
  const cardsOff = { isAvailable: () => false };
  res('tanpa renderer: install dilewati', info.install({ cards: cardsOff, discord }) === false);

  const th = new ThreadChannel();
  await th.send({ content: 'di thread' });
  res('thread dapat kartu', th.sent[0].files.length === 1);
  const dm = new DMChannel();
  await dm.send('dm teks');
  res('DM dapat kartu', dm.sent[0].files.length === 1 && dm.sent[0].content === 'dm teks');
  const u = new User();
  await u.send({ content: 'ke user' });
  res('user.send dapat kartu', u.sent[0].files.length === 1);
  const m = new Message();
  await m.reply({ content: 'balas pesan' });
  res('message.reply dapat kartu', m.sent[0].files.length === 1);

  console.log({ ok, fail });
})();
