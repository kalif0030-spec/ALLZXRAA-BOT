'use strict';
// Uji logika voice stay dengan stub discord.js dan @discordjs/voice (tanpa jaringan, tanpa token asli).
process.env.BOT_ROLE = 'welcome';
process.env.TOKEN_WELCOME = 'stub-token';
const Module = require('module');
const { EventEmitter } = require('events');
const path = require('path');

const deep = () => new Proxy(function () {}, { get: (_t, k) => (k === Symbol.toPrimitive ? () => 1 : deep()), apply: () => deep(), construct: () => deep() });
class FakeClient extends EventEmitter { constructor() { super(); this.user = { id: 'BOT' }; this.guilds = { cache: new Map() }; } login() {} }
const discordStub = new Proxy({ Client: FakeClient }, { get: (t, k) => (k in t ? t[k] : deep()) });

let entersBehaviour = 'reject';
const conns = [];
const voiceStub = {
  VoiceConnectionStatus: { Disconnected: 'disconnected', Destroyed: 'destroyed', Signalling: 'signalling', Connecting: 'connecting' },
  VoiceConnectionDisconnectReason: { WebSocketClose: 0, AdapterUnavailable: 1, EndpointRemoved: 2, Manual: 3 },
  entersState: async () => { if (entersBehaviour === 'reject') throw new Error('timeout'); },
  joinVoiceChannel: () => { const c = new EventEmitter(); c.state = { status: 'ready' }; c.destroy = () => { c.destroyed = true; }; conns.push(c); return c; },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'discord.js') return discordStub;
  if (req === '@discordjs/voice') return voiceStub;
  return origLoad.call(this, req, ...rest);
};
const timers = [];
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn, ms, ...a) => { if (ms === 10_000) { const t = { fn, cleared: false }; timers.push(t); return t; } return realSetTimeout(fn, ms, ...a); };
const realClear = global.clearTimeout;
global.clearTimeout = (t) => { if (t && 'cleared' in t) t.cleared = true; else realClear(t); };

const idx = require(path.join(__dirname, '..', 'index.js'));
let ok = 0, fail = 0;
const check = (name, cond) => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}`); cond ? ok++ : fail++; };

const meVoice = { channelId: 'VC1' };
const guild = {
  id: 'G1', ownerId: 'OWNER', voiceAdapterCreator: {},
  members: { me: { voice: meVoice, permissionsIn: () => ({ has: () => true }) }, fetch: async () => guild.members.me },
  channels: { fetch: async () => ({ id: 'VC1', name: 'stay', isVoiceBased: () => true }) },
};
const interaction = (sub) => ({
  guild, user: { id: 'OWNER' },
  options: { getSubcommand: () => sub, getChannel: () => ({ id: 'VC1' }) },
  reply: async () => {},
});
const activeTimers = () => timers.filter((t) => !t.cleared).length;
const fs = require('fs');
const fileGuilds = () => Object.keys(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'voice-state.json'), 'utf8')).guilds);

(async () => {
  idx.voiceStates.clear();
  // 1. kick: close code 4014, tidak pulih, bot sudah tidak di voice
  await idx.handleVoice(interaction('join'));
  check('join: tersimpan', idx.voiceStates.has('G1') && fileGuilds().includes('G1'));
  meVoice.channelId = null; entersBehaviour = 'reject';
  conns[0].emit('disconnected', {}, { reason: 0, closeCode: 4014 });
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  check('kick: state dilupakan', !idx.voiceStates.has('G1'));
  check('kick: file voice-state ikut bersih', !fileGuilds().includes('G1'));
  check('kick: tidak ada jadwal masuk lagi', activeTimers() === 0);
  check('kick: koneksi dimatikan', conns[0].destroyed === true && !idx.voiceConnections.has('G1'));

  // 2. putus jaringan (close code lain): harus masuk lagi
  meVoice.channelId = 'VC1';
  await idx.handleVoice(interaction('join'));
  conns[1].emit('disconnected', {}, { reason: 0, closeCode: 1006 });
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  check('jaringan putus: state tetap', idx.voiceStates.has('G1'));
  check('jaringan putus: masuk lagi dijadwalkan', activeTimers() === 1);

  // 3. 4014 tapi bot masih tercatat di voice (bukan kick): harus masuk lagi
  await idx.handleVoice(interaction('leave')); timers.length = 0;
  await idx.handleVoice(interaction('join'));
  meVoice.channelId = 'VC1';
  conns[2].emit('disconnected', {}, { reason: 0, closeCode: 4014 });
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  check('4014 tapi masih di voice: tidak dianggap kick', idx.voiceStates.has('G1') && activeTimers() === 1);

  // 4. dipindah channel: entersState berhasil, tidak ada perubahan
  await idx.handleVoice(interaction('leave')); timers.length = 0;
  await idx.handleVoice(interaction('join'));
  entersBehaviour = 'resolve'; meVoice.channelId = 'VC2';
  const before = conns.length;
  conns[before - 1].emit('disconnected', {}, { reason: 0, closeCode: 4014 });
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  check('dipindah channel: tetap stay, tanpa jadwal', idx.voiceStates.has('G1') && activeTimers() === 0 && !conns[before - 1].destroyed);

  // 5. /voice leave saat menunggu pemulihan: tidak menghidupkan kembali apa pun
  entersBehaviour = 'reject'; meVoice.channelId = null;
  const c = conns[before - 1];
  c.emit('disconnected', {}, { reason: 0, closeCode: 1006 });
  await idx.handleVoice(interaction('leave'));
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  check('leave saat menunggu: tidak ada jadwal baru', !idx.voiceStates.has('G1') && activeTimers() === 0);

  console.log({ ok, fail });
  process.exit(fail ? 1 : 0);
})();
