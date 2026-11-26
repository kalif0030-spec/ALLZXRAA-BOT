'use strict';
// Uji logika musik dengan stub @discordjs/voice (tanpa jaringan, tanpa ffmpeg, tanpa token).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const m = require('../music');

let ok = 0, fail = 0;
const check = (name, cond) => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}`); cond ? ok++ : fail++; };
const tick = () => new Promise((r) => setImmediate(r));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-'));
for (const n of ['a.mp3', 'b.ogg', 'c_lagu_indo.MP3', 'd.opus', 'readme.txt', 'cover.jpg']) fs.writeFileSync(path.join(dir, n), '');

const fakeVoice = () => {
  const players = [];
  const lib = {
    AudioPlayerStatus: { Idle: 'idle', Playing: 'playing' },
    NoSubscriberBehavior: { Pause: 'pause' },
    played: [],
    failCreate: false,
    createAudioResource: (file) => {
      if (lib.failCreate) throw new Error('ffmpeg tidak ada');
      return { file, volume: { v: null, setVolume(x) { this.v = x; } } };
    },
    createAudioPlayer: () => {
      const p = new EventEmitter();
      p.play = (r) => { lib.played.push(r); };
      p.stop = () => { p.stopped = true; };
      players.push(p);
      return p;
    },
  };
  return { lib, players };
};
const fakeConn = () => ({ subscribed: null, unsub: false, subscribe(p) { this.subscribed = p; return { unsubscribe: () => { this.unsub = true; } }; } });
const quietLog = { warns: [], warn(x) { this.warns.push(x); } };

// fungsi murni
const tracks = m.listTracks(dir).map((f) => path.basename(f));
check('listTracks: hanya file audio, huruf besar ikut', JSON.stringify(tracks) === JSON.stringify(['a.mp3', 'b.ogg', 'c_lagu_indo.MP3', 'd.opus']));
check('listTracks: folder tidak ada = []', m.listTracks(path.join(dir, 'nope')).length === 0);
check('titleOf: underscore jadi spasi, ekstensi dibuang', m.titleOf('/x/c_lagu_indo.MP3') === 'c lagu indo');
check('clampVolume', m.clampVolume(undefined) === 0.5 && m.clampVolume('2') === 1 && m.clampVolume('-1') === 0 && m.clampVolume('abc') === 0.5 && m.clampVolume('0.3') === 0.3);
const sh = m.shuffle([1, 2, 3, 4, 5]);
check('shuffle: isi sama, array baru', sh.slice().sort().join() === '1,2,3,4,5');

let seed = 7; const rng = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const q = m.createQueue(() => ['A', 'B', 'C'], rng);
let noDup = true, boundaryOk = true, prev = null;
for (let bag = 0; bag < 200; bag++) {
  const got = [q.next(), q.next(), q.next()];
  if (new Set(got).size !== 3) noDup = false;
  if (prev && got[0] === prev) boundaryOk = false;
  prev = got[2];
}
check('queue: tiap bag memuat semua lagu tepat sekali', noDup);
check('queue: lagu tidak berulang di batas bag', boundaryOk);
check('queue: satu lagu boleh berulang', (() => { const one = m.createQueue(() => ['X']); return one.next() === 'X' && one.next() === 'X'; })());
check('queue: kosong = null', m.createQueue(() => []).next() === null);

(async () => {
  // disabled kalau voiceLib tidak punya player
  check('disabled: tanpa createAudioPlayer', m.createMusic({ voiceLib: {}, dir }).enabled === false && m.createMusic({ voiceLib: null, dir }).start('G', fakeConn()) === false);

  // jalan normal
  const { lib, players } = fakeVoice();
  const mu = m.createMusic({ voiceLib: lib, dir, volume: '0.4', log: quietLog });
  const conn = fakeConn();
  check('start: true dan player disubscribe ke koneksi', mu.start('G1', conn) === true && conn.subscribed === players[0]);
  check('start: langsung memutar satu lagu, volume diset', lib.played.length === 1 && lib.played[0].volume.v === 0.4);
  check('nowPlaying: ada judul', typeof mu.nowPlaying('G1') === 'string' && mu.nowPlaying('G1').length > 0);
  players[0].emit('idle');
  check('selesai lagu (Idle): lagu berikutnya', lib.played.length === 2 && lib.played[0].file !== lib.played[1].file);
  for (let i = 0; i < 6; i++) players[0].emit('idle');
  const files = lib.played.map((r) => path.basename(r.file));
  check('8 lagu berturut-turut: tiap 4 lagu semua file terputar', new Set(files.slice(0, 4)).size === 4 && new Set(files.slice(4, 8)).size === 4);

  // error + Idle (urutan asli library) memutar satu lagu, bukan dua
  const before = lib.played.length;
  players[0].emit('error', new Error('stream rusak'));
  players[0].emit('idle');
  check('error lalu Idle: hanya satu lagu baru', lib.played.length === before + 1 && quietLog.warns.length === 1);

  // start ulang untuk guild yang sama menutup sesi lama
  const conn2 = fakeConn();
  mu.start('G1', conn2);
  check('start ulang: player lama berhenti, listener dibuang, sub lama dilepas', players[0].stopped === true && players[0].listenerCount('idle') === 0 && conn.unsub === true && conn2.subscribed === players[1]);
  const n = lib.played.length;
  players[0].emit('idle');
  check('player lama tidak memutar apa pun lagi', lib.played.length === n);

  // stop
  mu.stop('G1');
  check('stop: nowPlaying kosong dan player berhenti', mu.nowPlaying('G1') === null && players[1].stopped === true);
  mu.stop('G1'); mu.stop('tidak-ada');
  check('stop ganda aman', true);

  // gagal berturut-turut: berhenti, tidak loop panas
  const f = fakeVoice(); f.lib.failCreate = true;
  const log2 = { warns: [], warn(x) { this.warns.push(x); } };
  const mu2 = m.createMusic({ voiceLib: f.lib, dir, log: log2 });
  mu2.start('G2', fakeConn());
  for (let i = 0; i < 20; i++) await tick();
  check('gagal terus: berhenti setelah 5 kali, tidak loop tanpa akhir', log2.warns.filter((w) => w.startsWith('music: gagal')).length === 5 && log2.warns.some((w) => w.includes('berhenti dulu')));
  mu2.stop('G2'); // membersihkan timer retry

  // folder kosong
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'music-empty-'));
  const f3 = fakeVoice(); const log3 = { warns: [], warn(x) { this.warns.push(x); } };
  const mu3 = m.createMusic({ voiceLib: f3.lib, dir: empty, log: log3 });
  mu3.start('G3', fakeConn());
  check('folder kosong: tidak crash, ada peringatan, tidak ada yang diputar', f3.lib.played.length === 0 && log3.warns.length === 1);
  mu3.stop('G3');

  console.log({ ok, fail });
  process.exit(fail ? 1 : 0);
})();
