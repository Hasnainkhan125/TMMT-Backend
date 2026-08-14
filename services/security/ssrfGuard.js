'use strict';

/**
 * ssrfGuard — blocks Server-Side Request Forgery attacks on the URL scraper.
 *
 * Without this, a user can paste:
 *   http://169.254.169.254/latest/meta-data/iam/security-credentials/
 * and your EC2 instance dutifully fetches its own IAM credentials and
 * sends them back. Same for http://localhost, internal VPN ranges, etc.
 *
 * Wire into:
 *   - services/urlScraper.js :: scrapeUrl (call FIRST, before fetch)
 *   - services/urlToAdsService.js :: scanUrl (as defense-in-depth)
 */

const dns = require('dns').promises;
const net = require('net');

const PRIVATE_IPV4_RANGES = [
  [0x0A000000, 0x0AFFFFFF],     // 10.0.0.0/8
  [0xAC100000, 0xAC1FFFFF],     // 172.16.0.0/12
  [0xC0A80000, 0xC0A8FFFF],     // 192.168.0.0/16
  [0x7F000000, 0x7FFFFFFF],     // 127.0.0.0/8 (loopback)
  [0xA9FE0000, 0xA9FEFFFF],     // 169.254.0.0/16 (link-local + AWS meta)
  [0x64400000, 0x647FFFFF],     // 100.64.0.0/10 (CGNAT)
];

function ipv4ToLong(ip) {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
}

function isPrivateIPv4(ip) {
  const long = ipv4ToLong(ip);
  return PRIVATE_IPV4_RANGES.some(([start, end]) => long >= start && long <= end);
}

function isPrivateIPv6(ip) {
  // Simplified — block ::1, fc00::/7, fe80::/10
  return /^::1$|^::$|^fc[0-9a-f]{2}:|^fd[0-9a-f]{2}:|^fe[89ab][0-9a-f]:/i.test(ip);
}

const BLOCKED_HOSTNAMES = [
  'localhost', 'metadata.google.internal', 'metadata.aws.internal',
  '169.254.169.254', 'instance-data.ec2.internal',
];

const ALLOWED_PROTOCOLS = ['http:', 'https:'];

/**
 * Validate URL is safe to fetch. Throws on violation.
 */
async function guardUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch (err) {
    const e = new Error('Invalid URL format');
    e.code = 'invalid_url';
    throw e;
  }
  
  // Protocol check
  if (!ALLOWED_PROTOCOLS.includes(url.protocol)) {
    const e = new Error(`Protocol ${url.protocol} not allowed`);
    e.code = 'ssrf_blocked';
    throw e;
  }
  
  const hostname = url.hostname.toLowerCase();
  
  // Hostname blocklist
  if (BLOCKED_HOSTNAMES.includes(hostname)) {
    const e = new Error(`Hostname ${hostname} is blocked`);
    e.code = 'ssrf_blocked';
    throw e;
  }
  
  // Port check — block common internal service ports
  const port = parseInt(url.port, 10);
  const BLOCKED_PORTS = [22, 23, 25, 53, 139, 445, 465, 587, 993, 995, 
                         3306, 5432, 6379, 9200, 9300, 11211, 27017, 27018];
  if (port && BLOCKED_PORTS.includes(port)) {
    const e = new Error(`Port ${port} not allowed`);
    e.code = 'ssrf_blocked';
    throw e;
  }
  
  // Resolve hostname to IP(s) — catches DNS rebinding attacks
  try {
    const addresses = await dns.lookup(hostname, { all: true });
    for (const { address, family } of addresses) {
      if (family === 4 && isPrivateIPv4(address)) {
        const e = new Error(`IP ${address} is in a private range`);
        e.code = 'ssrf_blocked';
        throw e;
      }
      if (family === 6 && isPrivateIPv6(address)) {
        const e = new Error(`IPv6 ${address} is in a private range`);
        e.code = 'ssrf_blocked';
        throw e;
      }
    }
  } catch (err) {
    if (err.code === 'ssrf_blocked') throw err;
    // DNS resolution failed — let the fetch fail naturally
  }
  
  // Direct IP in URL (e.g., http://10.0.0.5/) — catches bypass attempts
  if (net.isIP(hostname)) {
    if (net.isIPv4(hostname) && isPrivateIPv4(hostname)) {
      const e = new Error(`Direct private IP ${hostname} not allowed`);
      e.code = 'ssrf_blocked';
      throw e;
    }
    if (net.isIPv6(hostname) && isPrivateIPv6(hostname)) {
      const e = new Error(`Direct private IPv6 ${hostname} not allowed`);
      e.code = 'ssrf_blocked';
      throw e;
    }
  }
  
  return { url, hostname };
}

module.exports = { guardUrl, isPrivateIPv4, isPrivateIPv6 };