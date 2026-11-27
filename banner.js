'use strict';
// Blok banner Lua: komentar --[[ ... ]] berisi ASCII art dari assets/banner.txt.
// Nama brand menggantikan "ALLZXRAA COMMUNITY". Tanda ']' dibuang supaya tidak menutup komentar atau long string.
const fs = require('node:fs');
const path = require('node:path');

const BANNER_FILE = path.join(__dirname, 'assets', 'banner.txt');
let bannerArt = null;

function getBannerArt() {
  if (bannerArt === null) {
    bannerArt = fs.existsSync(BANNER_FILE)
      ? fs.readFileSync(BANNER_FILE, 'utf8').replace(/\r/g, '').replace(/\s+$/, '')
      : 'ALLZXRAA COMMUNITY';
  }
  return bannerArt;
}

function sanitizeBrand(brandName) {
  return String(brandName || '').replace(/[\r\n\]]+/g, ' ').trim() || 'ALLZXRAA COMMUNITY';
}

function bannerBlock(brandName) {
  const art = getBannerArt().replace(/ALLZXRAA COMMUNITY/g, sanitizeBrand(brandName));
  return `--[[\n${art}\n]]`;
}

module.exports = { bannerBlock, sanitizeBrand };
