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

const MAX_PENDING_URLS = 10;

// Judul untuk link: nama file di path (tanpa ekstensi), atau host kalau path kosong.
function urlTitle(raw) {
  try {
    const u = new URL(raw);
    const seg = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    const base = seg.replace(/\.[^.]+$/, '').replace(/_+/g, ' ').trim();
    return base || u.hostname;
  } catch {
    return String(raw);
  }
}

function destroyQuiet(stream) {
  try {
    if (stream && typeof stream.destroy === 'function') stream.destroy();
  } catch {
    // stream sudah tertutup
  }
}

// openUrl(url) -> Promise<Readable>. Dipasang dari index.js (sudah termasuk SSRF guard).
// Kalau openUrl tidak diberikan, fitur link nonaktif dan lagu dari folder tetap jalan.
function createMusic({ voiceLib, dir, volume, log = console, rng = Math.random, openUrl = null }) {
  const enabled = Boolean(
    voiceLib && typeof voiceLib.createAudioPlayer === 'function' && typeof voiceLib.createAudioResource === 'function',
  );
  const sessions = new Map(); // guildId -> { player, sub, queue, current, label, pending, stream, playingNow, opening, ... }
  const vol = clampVolume(volume);

  function closeStream(s) {
    const st = s.stream;
    s.stream = null;
    destroyQuiet(st);
  }

  function stop(guildId) {
    const s = sessions.get(guildId);
    if (!s) return;
    sessions.delete(guildId);
    s.closed = true;
    if (s.retryTimer) clearTimeout(s.retryTimer);
    closeStream(s);
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
    if (s.closed || s.cooling || s.opening) return;
    if (s.pending.length > 0) {
      const url = s.pending.shift();
      s.opening = true;
      s.current = null;
      s.label = null;
      playUrl(s, url);
      return;
    }
    const file = s.queue.next();
    if (!file) {
      s.current = null;
      s.label = null;
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
      s.label = titleOf(file);
      s.playingNow = true;
      s.player.play(resource);
    } catch (err) {
      s.playingNow = false;
      recordFailure(s, file, err);
      if (!s.cooling) setImmediate(() => playNext(s));
    }
  }

  // Buka link lebih dulu, baru diputar. Selama membuka, playNext ditahan lewat s.opening.
  async function playUrl(s, url) {
    let stream;
    try {
      if (typeof openUrl !== 'function') throw new Error('pemutaran link tidak diaktifkan');
      stream = await openUrl(url);
    } catch (err) {
      s.opening = false;
      recordFailure(s, url, err);
      if (!s.closed && !s.cooling) setImmediate(() => playNext(s));
      return;
    }
    s.opening = false;
    if (s.closed) {
      destroyQuiet(stream);
      return;
    }
    try {
      const resource = voiceLib.createAudioResource(stream, { inlineVolume: true });
      resource.volume?.setVolume(vol);
      s.stream = stream;
      s.current = url;
      s.label = urlTitle(url);
      s.playingNow = true;
      s.player.play(resource);
    } catch (err) {
      destroyQuiet(stream);
      s.playingNow = false;
      recordFailure(s, url, err);
      if (!s.closed && !s.cooling) setImmediate(() => playNext(s));
    }
  }

  // Error stream dari player selalu disusul status Idle, dan Idle yang memanggil playNext.
  function recordFailure(s, item, err) {
    if (s.closed) return;
    s.failures += 1;
    log.warn(`music: gagal memutar ${path.basename(String(item))}: ${err?.message ?? err}`);
    if (s.failures >= MAX_CONSECUTIVE_FAILURES) {
      s.current = null;
      s.label = null;
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
      player, queue: createQueue(() => listTracks(dir), rng), current: null, label: null,
      pending: [], stream: null, playingNow: false, opening: false,
      failures: 0, retryTimer: null, cooling: false, closed: false, warnedEmpty: false, sub: null,
    };
    sessions.set(guildId, s);
    player.on(AudioPlayerStatus.Playing, () => { s.failures = 0; });
    player.on(AudioPlayerStatus.Idle, () => {
      s.playingNow = false;
      closeStream(s);
      playNext(s);
    });
    player.on('error', (err) => recordFailure(s, s.current ?? '?', err));
    s.sub = conn.subscribe(player);
    playNext(s);
    return true;
  }

  // Tambah link ke antrean. Diputar setelah lagu yang sedang jalan, atau langsung kalau bot sedang diam.
  function enqueueUrl(guildId, url) {
    if (!enabled || typeof openUrl !== 'function') return { ok: false, reason: 'pemutaran musik tidak aktif' };
    const s = sessions.get(guildId);
    if (!s) return { ok: false, reason: 'bot belum stay di voice' };
    if (s.pending.length >= MAX_PENDING_URLS) return { ok: false, reason: `antrean link penuh (maks ${MAX_PENDING_URLS})` };
    s.pending.push(url);
    const busy = s.playingNow || s.opening;
    if (!busy) {
      if (s.retryTimer) clearTimeout(s.retryTimer);
      s.retryTimer = null;
      s.cooling = false;
      playNext(s);
    }
    return { ok: true, position: s.pending.length, playingNow: busy };
  }

  // Lewati lagu yang sedang diputar. Idle dari player yang memanggil lagu berikutnya.
  function skip(guildId) {
    const s = sessions.get(guildId);
    if (!s || !s.playingNow) return false;
    s.player.stop(true);
    return true;
  }

  function nowPlaying(guildId) {
    const s = sessions.get(guildId);
    return s?.current ? s.label : null;
  }

  return {
    enabled, start, stop, skip, enqueueUrl, nowPlaying,
    trackCount: () => listTracks(dir).length,
  };
}

module.exports = { createMusic, createQueue, listTracks, shuffle, titleOf, urlTitle, clampVolume, AUDIO_EXT, MAX_PENDING_URLS };
