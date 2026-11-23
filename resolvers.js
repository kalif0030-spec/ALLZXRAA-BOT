'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

const blocked = new net.BlockList();
[
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
].forEach(([addr, prefix]) => blocked.addSubnet(addr, prefix, 'ipv4'));
[
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10],
  ['ff00::', 8], ['::ffff:0:0', 96],
].forEach(([addr, prefix]) => blocked.addSubnet(addr, prefix, 'ipv6'));

function parseHttpUrl(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return u.href;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

async function hostIsPublic(host) {
  if (!host) return false;
  const bare = host.replace(/^\[|\]$/g, '');
  let infos;
  try {
    infos = await dns.lookup(bare, { all: true });
  } catch {
    return false;
  }
  if (infos.length === 0) return false;
  return infos.every(
    (i) => !blocked.check(i.address, i.family === 6 ? 'ipv6' : 'ipv4')
  );
}

async function followRedirects(url, cfg) {
  const hops = [url];
  let current = url;
  for (let i = 0; i < cfg.maxHops; i++) {
    const host = hostOf(current);
    if (!(await hostIsPublic(host))) {
      return { ok: false, finalUrl: null, hops, note: `host non-publik atau tidak ter-resolve diblok: ${host}` };
    }
    let res;
    try {
      res = await fetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(cfg.requestTimeoutMs),
      });
    } catch (err) {
      return { ok: false, finalUrl: null, hops, note: `request gagal: ${err.name}` };
    }
    const location = res.headers.get('location');
    const status = res.status;
    await res.body?.cancel().catch(() => {});
    if (REDIRECT_CODES.has(status) && location) {
      const next = parseHttpUrl(new URL(location, current).href);
      if (next === null) {
        return { ok: false, finalUrl: null, hops, note: 'redirect ke target non-http' };
      }
      hops.push(next);
      current = next;
      continue;
    }
    return { ok: true, finalUrl: current, hops, note: `status akhir ${status}` };
  }
  return { ok: false, finalUrl: null, hops, note: `menyerah setelah ${cfg.maxHops} hop` };
}

async function askProvider(url, cfg) {
  if (cfg.providerUrl === null || cfg.providerResultKey === null) {
    return {
      ok: false, finalUrl: null, hops: [url],
      note: 'provider belum dikonfigurasi (BYPASS_PROVIDER_URL / BYPASS_PROVIDER_KEY belum di-set)',
    };
  }
  let data;
  try {
    const endpoint = new URL(cfg.providerUrl);
    endpoint.searchParams.set('url', url);
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(cfg.requestTimeoutMs) });
    if (!res.ok) {
      return { ok: false, finalUrl: null, hops: [url], note: `provider membalas HTTP ${res.status}` };
    }
    data = await res.json();
  } catch (err) {
    return { ok: false, finalUrl: null, hops: [url], note: `provider gagal: ${err.name}` };
  }
  const out = data && typeof data === 'object' ? data[cfg.providerResultKey] : null;
  const target = typeof out === 'string' ? parseHttpUrl(out) : null;
  if (target === null) {
    return { ok: false, finalUrl: null, hops: [url], note: 'respons provider tidak berisi link yang valid' };
  }
  return { ok: true, finalUrl: target, hops: [url, target], note: 'di-resolve lewat provider' };
}

async function resolve(raw, cfg) {
  const url = parseHttpUrl(raw);
  if (url === null) {
    return { ok: false, finalUrl: null, hops: [], note: 'itu bukan link http(s)' };
  }
  if (cfg.gatedHosts.has(hostOf(url))) {
    return askProvider(url, cfg);
  }
  const res = await followRedirects(url, cfg);
  if (res.ok && cfg.gatedHosts.has(hostOf(res.finalUrl))) {
    return askProvider(res.finalUrl, cfg);
  }
  return res;
}

module.exports = { resolve, parseHttpUrl };
