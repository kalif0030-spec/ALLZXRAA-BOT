'use strict';
// Putar lagu acak dari folder musik selama bot ada di voice channel.
// Sumber lagu: file audio di folder MUSIC_DIR (default ./music). Tidak ada daftar lagu atau URL bawaan.
const fs = require('node:fs');
const path = require('node:path');

const AUDIO_EXT = new Set(['.mp3', '.ogg', '.opus', '.wav', '.m4a', '.flac', '.webm']);
const MAX_CONSECUTIVE_FAILURES = 5;
const RETRY_AFTER_STOP_MS = 5 * 60_000;

function listTracks(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => AUDIO_EXT.has(path.extname(n).toLowerCase()))
    .sort()
    .map((n) => path.join(dir, n));
}

function titleOf(file) {
  return path.basename(file, path.extname(file)).replace(/[_]+/g, ' ').trim();
}

// Fisher-Yates, mengembalikan array baru.
function shuffle(items, rng = Math.random) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Antrean acak tanpa pengulangan sampai semua lagu terputar sekali ("shuffle bag").
// Daftar lagu dibaca ulang tiap bag habis, jadi file yang baru di-upload ikut kepakai.
// Lagu pertama bag baru tidak sama dengan lagu terakhir bag lama (kalau lagunya lebih dari satu).
function createQueue(loadTracks, rng = Math.random) {
  let bag = [];
  let last = null;
  return {
    next() {
      if (bag.length === 0) {
        const tracks = loadTracks();
        if (tracks.length === 0) return null;
        bag = shuffle(tracks, rng);
        if (tracks.length > 1 && bag[0] === last) {
          const swapWith = 1 + Math.floor(rng() * (bag.length - 1));
          [bag[0], bag[swapWith]] = [bag[swapWith], bag[0]];
        }
      }
      last = bag.shift();
      return last;
    },
  };
}

function clampVolume(raw, fallback = 0.5) {
  const n = Number(raw);
  if (raw === undefined || raw === null || raw === '' || !Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

function createMusic({ voiceLib, dir, volume, log = console, rng = Math.random }) {
  const enabled = Boolean(
    voiceLib && typeof voiceLib.createAudioPlayer === 'function' && typeof voiceLib.createAudioResource === 'function',
  );
  const sessions = new Map(); // guildId -> { player, sub, queue, current, failures, retryTimer, cooling, closed }
  const vol = clampVolume(volume);

  function stop(guildId) {
    const s = sessions.get(guildId);
    if (!s) return;
    sessions.delete(guildId);
    s.closed = true;
    if (s.retryTimer) clearTimeout(s.retryTimer);
    try {
      s.player.removeAllListeners();
      s.player.on('error', () => {}); // error terlambat dari stream yang sedang ditutup
      s.player.stop(true);
    } catch {
      // player sudah mati
    }
    try {
      s.sub?.unsubscribe();
    } catch {
      // koneksi sudah mati
    }
  }

  function scheduleRetry(s) {
    s.cooling = true;
    s.retryTimer = setTimeout(() => {
      s.retryTimer = null;
      s.cooling = false;
      playNext(s);
    }, RETRY_AFTER_STOP_MS);
    s.retryTimer.unref?.();
  }

  function playNext(s) {
    if (s.closed || s.cooling) return;
    const file = s.queue.next();
    if (!file) {
      s.current = null;
      if (!s.warnedEmpty) {
        s.warnedEmpty = true;
        log.warn(`music: tidak ada file audio di ${dir}, bot stay tanpa musik (dicek lagi tiap 5 menit)`);
      }
      scheduleRetry(s);
      return;
    }
    s.warnedEmpty = false;
    try {
      const resource = voiceLib.createAudioResource(file, { inlineVolume: true });
      resource.volume?.setVolume(vol);
      s.current = file;
      s.player.play(resource);
    } catch (err) {
      recordFailure(s, file, err);
      if (!s.cooling) setImmediate(() => playNext(s));
    }
  }

  // Error stream dari player selalu disusul status Idle, dan Idle yang memanggil playNext.
  function recordFailure(s, file, err) {
    if (s.closed) return;
    s.failures += 1;
    log.warn(`music: gagal memutar ${path.basename(String(file))}: ${err?.message ?? err}`);
    if (s.failures >= MAX_CONSECUTIVE_FAILURES) {
      s.current = null;
      s.failures = 0;
      log.warn('music: 5 lagu gagal berturut-turut, berhenti dulu (cek ffmpeg-static, opusscript, dan format file). Dicoba lagi 5 menit lagi');
      scheduleRetry(s);
    }
  }

  // Dipanggil tiap bot membuat koneksi voice baru. Aman dipanggil berulang untuk guild yang sama.
  function start(guildId, conn) {
    if (!enabled) return false;
    stop(guildId);
    const { AudioPlayerStatus, NoSubscriberBehavior } = voiceLib;
    const player = voiceLib.createAudioPlayer(
      NoSubscriberBehavior ? { behaviors: { noSubscriber: NoSubscriberBehavior.Pause } } : undefined,
    );
    const s = {
      player, queue: createQueue(() => listTracks(dir), rng), current: null,
      failures: 0, retryTimer: null, cooling: false, closed: false, warnedEmpty: false, sub: null,
    };
    sessions.set(guildId, s);
    player.on(AudioPlayerStatus.Playing, () => { s.failures = 0; });
    player.on(AudioPlayerStatus.Idle, () => playNext(s));
    player.on('error', (err) => recordFailure(s, s.current ?? '?', err));
    s.sub = conn.subscribe(player);
    playNext(s);
    return true;
  }

  function nowPlaying(guildId) {
    const s = sessions.get(guildId);
    return s?.current ? titleOf(s.current) : null;
  }

  return { enabled, start, stop, nowPlaying, trackCount: () => listTracks(dir).length };
}

module.exports = { createMusic, createQueue, listTracks, shuffle, titleOf, clampVolume, AUDIO_EXT };
