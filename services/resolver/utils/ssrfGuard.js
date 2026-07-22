// services/resolver/utils/ssrfGuard.js
const dns = require('dns').promises;
const net = require('net');
const { URL } = require('url');

const PRIVATE_IP_RANGES = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^192\.168\./,
  /^127\./,
  /^169\.254\./,           // Link-local + AWS/GCP metadata
  /^0\./,
  /^224\./,                // Multicast
  /^240\./,                // Reserved
  /^::1$/,                 // IPv6 loopback
  /^fc00:/i,               // IPv6 private
  /^fe80:/i,               // IPv6 link-local
];

const BLOCKED_HOSTS = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.goog',
  '100.100.100.200',       // Alibaba metadata
  '169.254.169.254',       // AWS/Azure metadata
  'fd00:ec2::254',
]);

async function isSafeUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { safe: false, reason: 'invalid_url' };
  }
  
  // Only http/https
  if (!['http:', 'https:'].includes(url.protocol)) {
    return { safe: false, reason: 'invalid_protocol' };
  }
  
  const hostname = url.hostname.toLowerCase();
  
  // Blocklist check
  if (BLOCKED_HOSTS.has(hostname)) {
    return { safe: false, reason: 'blocked_host' };
  }
  
  // If it's already an IP literal, check directly
  if (net.isIP(hostname)) {
    if (isPrivateIP(hostname)) {
      return { safe: false, reason: 'private_ip_literal' };
    }
    return { safe: true };
  }
  
  // DNS resolve and check every A/AAAA
  try {
    const addresses = await dns.lookup(hostname, { all: true, family: 0 });
    for (const { address } of addresses) {
      if (isPrivateIP(address)) {
        return { safe: false, reason: 'resolves_to_private_ip', details: address };
      }
    }
    return { safe: true };
  } catch (err) {
    return { safe: false, reason: 'dns_failure', details: err.code };
  }
}

function isPrivateIP(ip) {
  return PRIVATE_IP_RANGES.some(re => re.test(ip));
}

module.exports = { isSafeUrl };