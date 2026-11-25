'use strict';

// Alat Lua tambahan untuk bot: obfuscate lewat Luraph (API resmi) dan Prometheus (lokal),
// serta deobfuscate generik: peel statis dan sandbox dinamis (fengari di worker thread).
// Semua fungsi murni (parser, peel) bisa dites tanpa Discord: lihat test/lua-tools.test.js.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { Worker } = require('node:worker_threads');

const execFileP = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Hanya melayani satu pekerjaan berat per slot; kalau penuh langsung ditolak, tidak diantre.
function createLimiter(max) {
  let active = 0;
  return async function run(fn, busyMessage) {
    if (active >= max) throw new Error(busyMessage);
    active += 1;
    try {
      return await fn();
    } finally {
      active -= 1;
    }
  };
}

// ============ parser string literal Lua (murni) ============
// Teks dibaca sebagai latin1 supaya satu karakter = satu byte dan posisi cocok dengan Buffer.
const SIMPLE_ESCAPES = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34, "'": 39 };

function utf8Bytes(cp) {
  if (cp > 0x10ffff) return null;
  return [...Buffer.from(String.fromCodePoint(cp), 'utf8')];
}

// text[start] adalah tanda kutip pembuka. Mengembalikan { bytes, end } atau null kalau bukan literal valid.
function readQuoted(text, start) {
  const quote = text[start];
  const out = [];
  let i = start + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === quote) return { bytes: Buffer.from(out), end: i + 1 };
    if (c === '\n' || c === '\r') return null;
    if (c !== '\\') {
      out.push(text.charCodeAt(i));
      i += 1;
      continue;
    }
    i += 1;
    const e = text[i];
    if (e === undefined) return null;
    if (Object.hasOwn(SIMPLE_ESCAPES, e)) {
      out.push(SIMPLE_ESCAPES[e]);
      i += 1;
    } else if (e === '\n' || e === '\r') {
      out.push(10);
      i += (e === '\r' && text[i + 1] === '\n') ? 2 : 1;
    } else if (e === 'x') {
      const hex = text.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
      out.push(Number.parseInt(hex, 16));
      i += 3;
    } else if (e === 'z') {
      i += 1;
      while (i < text.length && /[ \t\r\n\f\v]/.test(text[i])) i += 1;
    } else if (e === 'u') {
      const m = /^\{([0-9a-fA-F]{1,8})\}/.exec(text.slice(i + 1, i + 11));
      if (!m) return null;
      const bytes = utf8Bytes(Number.parseInt(m[1], 16));
      if (!bytes) return null;
      out.push(...bytes);
      i += 1 + m[0].length;
    } else if (e >= '0' && e <= '9') {
      const m = /^[0-9]{1,3}/.exec(text.slice(i, i + 3));
      const v = Number.parseInt(m[0], 10);
      if (v > 255) return null;
      out.push(v);
      i += m[0].length;
    } else {
      return null;
    }
  }
  return null;
}

// text[start] adalah '[' pembuka long bracket ([[ ]], [=[ ]=], dst).
function readLongBracket(text, start) {
  const m = /^\[(=*)\[/.exec(text.slice(start, start + 64));
  if (!m) return null;
  const close = `]${m[1]}]`;
  const bodyStart = start + m[0].length;
  const endIdx = text.indexOf(close, bodyStart);
  if (endIdx < 0) return null;
  let body = text.slice(bodyStart, endIdx).replace(/\r\n|\n\r|\r/g, '\n');
  if (body.startsWith('\n')) body = body.slice(1);
  return { bytes: Buffer.from(body, 'latin1'), end: endIdx + close.length };
}

// string.char(112, 114, ...) dengan angka desimal saja.
function readStringChar(text, start) {
  const head = /^string\s*\.\s*char\s*\(/.exec(text.slice(start, start + 48));
  if (!head) return null;
  let i = start + head[0].length;
  const out = [];
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i += 1;
    const num = /^[0-9]{1,3}/.exec(text.slice(i, i + 3));
    if (!num) return null;
    const v = Number.parseInt(num[0], 10);
    if (v > 255) return null;
    out.push(v);
    i += num[0].length;
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (text[i] === ',') { i += 1; continue; }
    if (text[i] === ')') return { bytes: Buffer.from(out), end: i + 1 };
    return null;
  }
}

function looksLikeText(buf) {
  if (buf.length < 16 || buf[0] === 0x1b) return false;
  const sample = buf.length > 65536 ? buf.subarray(0, 65536) : buf;
  let bad = 0;
  for (const b of sample) if ((b < 32 && b !== 9 && b !== 10 && b !== 13) || b === 127) bad += 1;
  return bad / sample.length <= 0.01;
}

// Cari semua payload literal yang langsung jadi argumen pertama loadstring(...) / load(...).
// Literal yang disambung ("a" .. "b") tidak dihitung: setelah literal harus langsung ')' atau ','.
function findLoadPayloads(buf) {
  const text = buf.toString('latin1');
  const found = [];
  for (const m of text.matchAll(/\b(?:loadstring|load)\s*\(\s*/g)) {
    const at = m.index + m[0].length;
    const c = text[at];
    let lit = null;
    if (c === '"' || c === "'") lit = readQuoted(text, at);
    else if (c === '[') lit = readLongBracket(text, at);
    else if (c === 's') lit = readStringChar(text, at);
    if (!lit) continue;
    let j = lit.end;
    while (j < text.length && /\s/.test(text[j])) j += 1;
    if (text[j] !== ')' && text[j] !== ',') continue;
    found.push(lit.bytes);
  }
  return found;
}

// Kupas lapisan loadstring("...") berantai. Hanya literal; tidak menjalankan apa pun.
function peelStatic(buf, { maxLayers = 8 } = {}) {
  const layers = [];
  const notes = [];
  let current = buf;
  for (let i = 0; i < maxLayers; i += 1) {
    const candidates = findLoadPayloads(current);
    const texts = candidates.filter(looksLikeText).sort((a, b) => b.length - a.length);
    const bytecode = candidates.find((c) => c.length >= 16 && c[0] === 0x1b);
    if (texts.length === 0) {
      if (bytecode) notes.push(`payload bytecode Lua (${bytecode.length} byte) ditemukan; bot tidak bisa mengubah bytecode jadi source`);
      break;
    }
    if (texts[0].equals(current)) break;
    layers.push(texts[0]);
    current = texts[0];
  }
  return { layers, notes };
}

// ============ Luraph (API resmi) ============
// Endpoint dan bentuk body dari SDK resmi luraph-node: GET obfuscate/nodes, POST obfuscate/new
// (node, script base64, fileName, options, useTokens, enforceSettings), GET obfuscate/status/<id>,
// GET obfuscate/download/<id>, header Luraph-API-Key. Perilaku status (menunggu atau langsung
// balik) belum terverifikasi, jadi download diulang beberapa kali.
function safeFileName(name) {
  const cleaned = String(name || '').replace(/[^\w.-]/g, '_').slice(0, 80);
  return cleaned || 'script.lua';
}

async function luraphObfuscate(sourceBuf, opts) {
  const {
    apiKey, baseUrl = 'https://api.lura.ph/v1/', node = null, options = {},
    fileName = 'script.lua', timeoutMs = 300000, maxBytes, fetchImpl = fetch,
    retryDelayMs = 3000, downloadAttempts = 5,
  } = opts;
  if (!apiKey) throw new Error('Luraph: API key belum di-set (LURAPH_API_KEY atau luraphApiKey di config.json)');
  const deadline = Date.now() + timeoutMs;
  const remaining = () => {
    const r = deadline - Date.now();
    if (r <= 0) throw new Error('Luraph: waktu tunggu habis');
    return r;
  };
  const request = async (method, rel, body) => {
    const headers = { 'Luraph-API-Key': apiKey };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      return await fetchImpl(new URL(rel, baseUrl), {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(remaining()),
      });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Luraph:')) throw err;
      throw new Error(`Luraph: request gagal (${err.name})`);
    }
  };
  const failure = async (res, what) => {
    const text = (await res.text().catch(() => '')).slice(0, 300);
    return new Error(`Luraph: ${what} gagal, HTTP ${res.status}${text ? `: ${text}` : ''}`);
  };
  const json = async (res, what) => {
    if (!res.ok) throw await failure(res, what);
    try {
      return await res.json();
    } catch {
      throw new Error(`Luraph: ${what} membalas JSON yang tidak valid`);
    }
  };

  let nodeId = node;
  if (!nodeId) {
    const nodes = await json(await request('GET', 'obfuscate/nodes'), 'daftar node');
    nodeId = nodes && typeof nodes.recommendedId === 'string' ? nodes.recommendedId : null;
    if (!nodeId) throw new Error('Luraph: API tidak memberi recommended node, isi LURAPH_NODE');
  }

  const created = await json(await request('POST', 'obfuscate/new', {
    node: nodeId,
    script: Buffer.from(sourceBuf).toString('base64'),
    fileName: safeFileName(fileName),
    options,
    useTokens: false,
    enforceSettings: false,
  }), 'membuat job');
  if (!created || typeof created.jobId !== 'string' || !created.jobId) throw new Error('Luraph: balasan tidak berisi jobId');
  const jobId = encodeURIComponent(created.jobId);

  const status = await json(await request('GET', `obfuscate/status/${jobId}`), 'cek status job');
  if (status && status.error) throw new Error(`Luraph: obfuscate gagal: ${String(status.error).slice(0, 300)}`);

  let lastError = null;
  for (let attempt = 1; attempt <= downloadAttempts; attempt += 1) {
    const res = await request('GET', `obfuscate/download/${jobId}`);
    if (res.ok) {
      const len = Number.parseInt(res.headers.get('content-length') ?? '', 10);
      if (Number.isFinite(len) && maxBytes && len > maxBytes) throw new Error(`Luraph: hasil terlalu besar (${len} byte)`);
      const data = Buffer.from(await res.arrayBuffer());
      if (maxBytes && data.length > maxBytes) throw new Error(`Luraph: hasil terlalu besar (${data.length} byte)`);
      if (data.length === 0) throw new Error('Luraph: hasil download kosong');
      return data;
    }
    lastError = await failure(res, 'download hasil');
    if (attempt < downloadAttempts) {
      remaining();
      await sleep(Math.min(retryDelayMs, remaining()));
    }
  }
  throw lastError;
}

// ============ Prometheus (CLI lokal) ============
// Perintah dari README resmi: lua ./cli.lua --preset Medium ./your_file.lua; hasilnya ditulis di
// sebelah input dengan nama <nama>.obfuscated.lua. Butuh Lua 5.1 atau LuaJIT dan klon repo Prometheus.
const prometheusLimiter = createLimiter(2);

async function prometheusObfuscate(sourceBuf, opts) {
  const { dir, luaBin = 'lua', preset = 'Medium', allowedPresets = ['Medium', 'Strong'], timeoutMs = 60000, maxBytes } = opts;
  if (!dir) throw new Error('Prometheus: folder Prometheus belum di-set (PROMETHEUS_DIR atau prometheusDir)');
  if (!allowedPresets.includes(preset)) throw new Error(`Prometheus: preset ${preset} tidak diizinkan`);
  const cli = path.join(dir, 'cli.lua');
  if (!fs.existsSync(cli)) throw new Error(`Prometheus: ${cli} tidak ditemukan`);
  return prometheusLimiter(async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'allzxraa-prom-'));
    try {
      const input = path.join(tmp, 'input.lua');
      await fs.promises.writeFile(input, sourceBuf);
      try {
        await execFileP(luaBin, [cli, '--preset', preset, input], { cwd: dir, timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true });
      } catch (err) {
        if (err.code === 'ENOENT') throw new Error(`Prometheus: interpreter "${luaBin}" tidak ditemukan`);
        if (err.killed) throw new Error('Prometheus: waktu habis');
        throw new Error(`Prometheus: gagal${err.stderr ? `: ${String(err.stderr).trim().slice(0, 300)}` : ''}`);
      }
      let out;
      try {
        out = await fs.promises.readFile(path.join(tmp, 'input.obfuscated.lua'));
      } catch {
        throw new Error('Prometheus: file hasil input.obfuscated.lua tidak muncul');
      }
      if (out.length === 0) throw new Error('Prometheus: hasil kosong');
      if (maxBytes && out.length > maxBytes) throw new Error(`Prometheus: hasil terlalu besar (${out.length} byte)`);
      return out;
    } finally {
      await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }, 'Prometheus sedang penuh, coba lagi sebentar');
}

// ============ sandbox dinamis ============
const WORKER_FILE = path.join(__dirname, 'lua-sandbox-worker.js');
const sandboxLimiter = createLimiter(2);

function sandboxAvailable() {
  try {
    require.resolve('fengari');
    return true;
  } catch {
    return false;
  }
}

// Menjalankan script di worker thread terpisah. Hasil sebagian tetap dikembalikan walau worker
// kena timeout atau kehabisan memori: layer dan log dikirim worker begitu muncul.
function runSandbox(sourceBuf, opts = {}) {
  const {
    timeoutMs = 20000, maxLayers = 16, maxLogLines = 2000, memoryMb = 192,
    maxLayerBytes = 25 * 1024 * 1024, workerFile = WORKER_FILE,
  } = opts;
  return sandboxLimiter(() => new Promise((resolve, reject) => {
    const layers = [];
    const log = [];
    let layerBytes = 0;
    let timedOut = false;
    let workerError = null;
    let settled = false;
    let worker;
    try {
      worker = new Worker(workerFile, {
        workerData: {
          source: new Uint8Array(sourceBuf),
          limits: { maxLogLines, maxLayers, maxWaitCalls: 2000, maxStringBytes: 16 * 1024 * 1024 },
        },
        resourceLimits: { maxOldGenerationSizeMb: memoryMb, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
      });
    } catch (err) {
      reject(err);
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      worker.terminate().catch(() => {});
    }, timeoutMs);
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ layers, log, timedOut, workerError });
    };
    worker.on('message', (m) => {
      if (!m || typeof m !== 'object') return;
      if (m.t === 'layer' && m.bytes) {
        layerBytes += m.bytes.length;
        if (layerBytes <= maxLayerBytes && layers.length < maxLayers) layers.push(Buffer.from(m.bytes));
      } else if (m.t === 'log' && Array.isArray(m.lines)) {
        for (const line of m.lines) if (log.length < maxLogLines + 5) log.push(String(line));
      } else if (m.t === 'done' && m.error) {
        workerError = String(m.error).slice(0, 300);
      }
    });
    worker.on('error', (err) => {
      if (err && err.code === 'ERR_WORKER_OUT_OF_MEMORY') workerError = 'memori sandbox habis';
      else if (err && /Cannot find module 'fengari'/.test(err.message)) workerError = 'paket fengari belum terpasang (npm install fengari)';
      else workerError = String((err && err.message) || err).slice(0, 300);
    });
    worker.on('exit', finish);
  }), 'sandbox sedang penuh, coba lagi sebentar');
}

function sandboxLogText(result) {
  const head = [];
  if (result.timedOut) head.push('# sandbox dihentikan karena waktu habis; log di bawah belum tentu lengkap');
  if (result.workerError) head.push(`# error worker: ${result.workerError}`);
  return [...head, ...result.log].join('\n');
}

// ============ deobfuscate: gabungan metode ============
// allzra: fungsi (text) => Buffer milik index.js. Mengembalikan
// { engine, primary: Buffer|null, extras: [{ suffix, data }], notes: [] }.
function layerExtras(layers) {
  const earlier = layers.slice(0, -1).slice(-6);
  const offset = layers.length - 1 - earlier.length;
  return earlier.map((data, i) => ({ suffix: `layer${offset + i + 1}.lua`, data }));
}

async function deobfuscateWith(engine, buf, { allzra, sandbox = {}, sandboxInAuto = true }) {
  const reasons = [];

  if (engine === 'allzra' || engine === 'auto') {
    try {
      return { engine: 'allzra', primary: allzra(buf.toString('utf8')), extras: [], notes: [] };
    } catch (err) {
      if (engine === 'allzra') throw err;
      reasons.push(`ALLZRA: ${err.message}`);
    }
  }

  if (engine === 'peel' || engine === 'auto') {
    const peeled = peelStatic(buf);
    if (peeled.layers.length > 0) {
      return {
        engine: 'peel',
        primary: peeled.layers[peeled.layers.length - 1],
        extras: layerExtras(peeled.layers),
        notes: [`${peeled.layers.length} lapisan loadstring literal dikupas tanpa menjalankan apa pun`, ...peeled.notes],
      };
    }
    if (engine === 'peel') throw new Error(`tidak ada payload loadstring literal yang bisa dikupas${peeled.notes.length ? ` (${peeled.notes[0]})` : ''}`);
    reasons.push('peel statis: tidak ada payload literal');
  }

  if (engine === 'sandbox' || (engine === 'auto' && sandboxInAuto)) {
    if (!sandboxAvailable()) {
      if (engine === 'sandbox') throw new Error('sandbox butuh paket fengari: jalankan npm install fengari lalu restart bot');
      reasons.push('sandbox: fengari belum terpasang');
    } else {
      const res = await runSandbox(buf, sandbox);
      const logText = sandboxLogText(res);
      const notes = [];
      if (res.timedOut) notes.push('sandbox kena batas waktu, hasil mungkin sebagian');
      if (res.workerError) notes.push(`worker: ${res.workerError}`);
      const compileFail = res.log.find((l) => l.startsWith('[error] script target tidak bisa dikompilasi'));
      if (compileFail) notes.push('script target memakai sintaks yang tidak bisa dikompilasi Lua 5.3 (kemungkinan Luau)');
      if (res.layers.length > 0) {
        notes.unshift(`${res.layers.length} payload tertangkap dari loadstring/load saat dijalankan di sandbox`);
        return {
          engine: 'sandbox',
          primary: res.layers[res.layers.length - 1],
          extras: [...layerExtras(res.layers), { suffix: 'envlog.txt', data: Buffer.from(logText, 'utf8') }],
          notes,
        };
      }
      notes.unshift('tidak ada payload loadstring yang tertangkap; yang tersedia cuma log perilaku (global, panggilan, string, URL)');
      if (engine === 'sandbox' || res.log.length > 0) {
        return { engine: 'sandbox', primary: null, extras: [{ suffix: 'envlog.txt', data: Buffer.from(logText, 'utf8') }], notes };
      }
      reasons.push('sandbox: tidak menangkap apa pun');
    }
  }

  throw new Error(`tidak ada metode yang berhasil. ${reasons.join('; ')}`);
}

// Obfuscate lewat mesin eksternal. Mesin allzra tetap ditangani index.js.
async function obfuscateExternal(engine, buf, cfg, fileName) {
  if (engine === 'luraph') {
    return luraphObfuscate(buf, {
      apiKey: cfg.luraph.apiKey, baseUrl: cfg.luraph.baseUrl, node: cfg.luraph.node, options: cfg.luraph.options,
      fileName, timeoutMs: cfg.luraph.jobTimeoutMs, maxBytes: cfg.obfu.maxSourceBytes,
    });
  }
  if (engine === 'prometheus') {
    return prometheusObfuscate(buf, {
      dir: cfg.prometheus.dir, luaBin: cfg.prometheus.luaBin, preset: cfg.prometheus.preset,
      timeoutMs: cfg.prometheus.timeoutMs, maxBytes: cfg.obfu.maxSourceBytes,
    });
  }
  throw new Error(`mesin obfuscate tidak dikenal: ${engine}`);
}

module.exports = {
  createLimiter, readQuoted, readLongBracket, readStringChar, looksLikeText, findLoadPayloads, peelStatic,
  safeFileName, luraphObfuscate, prometheusObfuscate, runSandbox, sandboxAvailable, sandboxLogText,
  deobfuscateWith, obfuscateExternal,
};
