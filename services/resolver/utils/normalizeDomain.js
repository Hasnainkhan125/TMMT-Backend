// services/resolver/utils/normalizeDomain.js
const psl = require('psl');  // npm i psl

function normalizeDomain(input) {
  if (!input) return null;
  
  let url = input.trim().toLowerCase();
  
  // Strip protocol
  url = url.replace(/^https?:\/\//, '');
  // Strip www
  url = url.replace(/^www\./, '');
  // Strip path, query, fragment
  url = url.split('/')[0].split('?')[0].split('#')[0];
  // Strip trailing dot
  url = url.replace(/\.$/, '');
  
  return url;
}

function rootDomain(input) {
  const normalized = normalizeDomain(input);
  if (!normalized) return null;
  
  const parsed = psl.parse(normalized);
  return parsed.domain || normalized;  // e.g., "nike.com" from "store.nike.com"
}

function sharesRootDomain(urlA, urlB) {
  const rootA = rootDomain(urlA);
  const rootB = rootDomain(urlB);
  return rootA && rootB && rootA === rootB;
}

function ensureHttps(url) {
  if (!url) return null;
  if (/^https?:\/\//.test(url)) return url;
  return `https://${normalizeDomain(url)}`;
}

module.exports = { normalizeDomain, rootDomain, sharesRootDomain, ensureHttps };