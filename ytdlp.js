'use strict';
// Putar YouTube, SoundCloud, dll lewat yt-dlp. Binary standalone diunduh sekali ke ./bin (atau pakai YTDLP_PATH).
// Hanya host di allowlist yang boleh masuk ke yt-dlp: yt-dlp mengikuti redirect sendiri, jadi host bebas = celah SSRF.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const BIN_DIR = path.join(__dirname, 'bin');
const OPEN_TIMEOUT_MS = 60_000;
const UPDATE_AFTER_MS = 3 * 24 * 3600_000;
const BASE_HOSTS = ['youtube.com', 'youtu.be', 'youtube-nocookie.com', 'soundcloud.com', 'bandcamp.com', 'mixcloud.com', 'vimeo.com', 'dailymotion.com', 'twitch.tv'];

function hosts() {
  const extra = (process.env.MUSIC_YTDLP_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  return [...BASE_HOSTS, ...extra];
}

// url: objek URL. Cocok kalau host sama persis atau subdomain dari host allowlist (music.youtube.com, m.youtube.com, ...).
function supports(url) {
  const host = String(url?.hostname || '').toLowerCase();
  return hosts().some((h) => host === h || host.endsWith(`.${h}`));
}

function assetName() {
  if (process.platform === 'win32') return 'yt-dlp.exe';
  if (process.platform === 'darwin') return 'yt-dlp_macos';
  return process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
}

const localBin = () => path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

let binPromise = null;
let updateTried = false;

function maybeUpdate(bin) {
  if (updateTried) return;
  updateTried = true;
  try {
    if (Date.now() - fs.statSync(bin).mtimeMs < UPDATE_AFTER_MS) return;
    spawn(bin, ['-U'], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    // update gagal tidak boleh ganggu pemutaran
  }
}

async function download() {
  const dest = localBin();
  if (fs.existsSync(dest)) {
    maybeUpdate(dest);
    return dest;
  }
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const res = await fetch(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${assetName()}`, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok || !res.body) throw new Error(`unduh yt-dlp gagal (HTTP ${res.status})`);
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, dest);
  return dest;
}

function ensureBinary() {
  if (process.env.YTDLP_PATH) return Promise.resolve(process.env.YTDLP_PATH);
  if (!binPromise) binPromise = download().catch((err) => { binPromise = null; throw err; });
  return binPromise;
}

// npm 11 memblokir install script ffmpeg-static, jadi binary ffmpeg-nya tidak ikut terunduh. Unduh manual kalau belum ada.
function ensureFfmpeg(log = console) {
  try {
    const p = require('ffmpeg-static');
    if (!p || fs.existsSync(p)) return;
    log.warn('music: binary ffmpeg belum ada, mengunduh lewat ffmpeg-static/install.js');
    spawnSync(process.execPath, [path.join(path.dirname(p), 'install.js')], { stdio: 'inherit', timeout: 180_000 });
  } catch {
    // ffmpeg-static tidak terpasang, prism-media akan coba ffmpeg sistem
  }
}

function lastLine(text) {
  const line = String(text).split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
  let msg = line.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/i, '').slice(0, 200);
  if (/sign in|not a bot|cookies/i.test(msg)) msg += ' (IP server kena cek bot YouTube, isi YTDLP_COOKIES dengan file cookies.txt)';
  return msg;
}

// Mengembalikan Readable audio mentah (webm/opus atau m4a) setelah data pertama datang.
// destroy() pada stream ikut membunuh proses yt-dlp.
async function open(rawUrl) {
  const bin = await ensureBinary();
  const args = [
    '-f', 'bestaudio/best', '--no-playlist', '-o', '-', '-q', '--no-warnings', '--no-progress', '--no-part',
    '--retries', '3', '--socket-timeout', '15',
    '--js-runtimes', `node:${process.execPath}`, // YouTube butuh JS runtime untuk solve signature
  ];
  if (process.env.YTDLP_COOKIES) args.push('--cookies', process.env.YTDLP_COOKIES);
  args.push('--', rawUrl);

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = child.stdout;
    let err = '';
    let settled = false;
    const kill = () => { try { child.kill('SIGKILL'); } catch { /* sudah mati */ } };
    const origDestroy = out.destroy.bind(out);
    out.destroy = (e) => { kill(); return origDestroy(e); };
    out.on('error', () => {});
    child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    const fail = (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      kill();
      reject(new Error(msg));
    };
    const timer = setTimeout(() => fail('yt-dlp kelamaan (60 detik) tanpa hasil'), OPEN_TIMEOUT_MS);
    timer.unref?.();
    child.once('error', (e) => fail(`yt-dlp tidak bisa dijalankan: ${e.message}`));
    child.once('close', (code) => fail(lastLine(err) || `yt-dlp berhenti tanpa audio (kode ${code})`));
    // 'readable' juga muncul saat EOF tanpa data (yt-dlp gagal): hanya lanjut kalau memang ada byte audio, sisanya ditangani 'close'.
    const onReadable = () => {
      if (settled || out.readableLength === 0) return;
      settled = true;
      clearTimeout(timer);
      out.off('readable', onReadable);
      resolve(out);
    };
    out.on('readable', onReadable);
  });
}

module.exports = { supports, open, ensureBinary, ensureFfmpeg, hosts, assetName };
