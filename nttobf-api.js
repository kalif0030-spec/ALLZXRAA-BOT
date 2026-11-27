'use strict';
// Backend api.nttobf.com. Dari snippet user: POST /obfuscate, body JSON, respons JSON { result } atau { error }.
// Nama field body: "code". Terkonfirmasi dari respons server: "Missing 'code' field" (screenshot user).
// Tidak ada API key di snippet, jadi tidak ada header auth.

const ENDPOINT = 'https://api.nttobf.com/obfuscate';
const QUEUE_ENDPOINT = 'https://api.nttobf.com/queue';
const PAYLOAD_KEY = 'code';
// Timeout obfuscate: 1 menit (permintaan user). Bisa diubah lewat env NTTOBF_TIMEOUT_MS.
const DEFAULT_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.NTTOBF_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS;

// Buang komentar dan spasi, supaya header atau rapihan dari server tidak menyembunyikan script yang tidak berubah.
function normalizeLua(text) {
  return text
    .replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, '')
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, '');
}

async function obfuscateWithNtt(buf, { fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw new Error('source kosong');

  const started = Date.now();
  let response;
  try {
    response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [PAYLOAD_KEY]: buf.toString('utf8') }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    console.log(`[obfu] nttobf gagal setelah ${Date.now() - started} ms: ${err.message}`);
    throw new Error(`nttobf: request gagal setelah ${Date.now() - started} ms (${err.message})`);
  }
  console.log(`[obfu] nttobf HTTP ${response.status} setelah ${Date.now() - started} ms, bytes=${buf.length}`);

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`nttobf: respons bukan JSON (HTTP ${response.status})`);
  }
  if (!response.ok) throw new Error(data?.error || `nttobf: HTTP ${response.status}`);

  if (typeof data?.result !== 'string' || data.result.length === 0) {
    throw new Error('nttobf: result tidak ada di respons');
  }
  const out = Buffer.from(data.result, 'utf8');
  if (normalizeLua(out.toString('utf8')) === normalizeLua(buf.toString('utf8'))) {
    throw new Error('api.nttobf.com mengembalikan script tanpa perubahan');
  }
  return out;
}

// Antrean dari snippet user: GET /queue, ambil field queue. BELUM DIVERIFIKASI bentuk nilainya (angka, array, atau objek).
// Nilai dikembalikan apa adanya. Gagal ambil antrean TIDAK menghentikan obfuscate: hasilnya null.
async function getNttQueue({ fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  try {
    const response = await fetchImpl(QUEUE_ENDPOINT, { signal: AbortSignal.timeout(timeoutMs) });
    const data = await response.json();
    return data?.queue ?? null;
  } catch {
    return null;
  }
}

module.exports = { obfuscateWithNtt, getNttQueue, ENDPOINT, QUEUE_ENDPOINT, PAYLOAD_KEY };
