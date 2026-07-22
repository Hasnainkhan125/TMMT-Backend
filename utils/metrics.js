'use strict';

/**
 * metrics — lightweight in-process counters + histograms, Prometheus-formatted.
 *
 * We deliberately avoid prom-client to keep deps minimal. Cardinality is
 * bounded by design: we only allow a fixed set of labels per metric, and
 * we drop labels we didn't declare.
 *
 * Counters (monotonically increasing):
 *   http_requests_total{method,route,status}
 *   studio_jobs_total{kind,status}          — bumped by worker
 *   credits_delta_total{reason,sign}        — bumped by creditsService
 *   url_scans_total{status}                 — bumped by urlToAdsService
 *   apify_runs_total                        — Apify wrapper invocations
 *   apify_runs_cached                       — served from Redis cache
 *   apify_runs_failed                       — Apify errors
 *
 * Histograms (bucketed durations):
 *   http_request_duration_ms{method,route}
 *   studio_job_duration_ms{kind,status}
 *
 * All observations are O(1); export is O(labels × metrics). At Qumak's
 * request volumes this fits comfortably in a few hundred KB.
 *
 * Consumers:
 *   require('./metrics').observeHttp({ method, route, status, durationMs })
 *   require('./metrics').incJob(kind, status, { durationMs })
 *   require('./metrics').incCredits({ reason, sign, amount })
 *   require('./metrics').incScan(status)
 *
 *   GET /metrics  → Prometheus text-format exposition
 */

const HTTP_BUCKETS   = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const JOB_BUCKETS    = [500, 1000, 2500, 5000, 10000, 30000, 60000, 120000, 300000];

// Normalise a route path so we don't blow cardinality. We keep the broad
// namespace and strip any numeric / hex segments that look like ids.
function normalizeRoute(route) {
  if (!route || typeof route !== 'string') return 'unknown';
  return route
    .replace(/\/[0-9a-f]{24}(?=\/|$)/gi, '/:id')          // Mongo ObjectIds
    .replace(/\/[0-9a-f-]{36}(?=\/|$)/gi, '/:uuid')       // uuids
    .replace(/\/\d+(?=\/|$)/g, '/:n')                     // numeric segments
    .slice(0, 120);
}

// Simple registries keyed by a stable string "m|k=v,k=v".
const counters   = new Map(); // key → { name, labels, value }
const histograms = new Map(); // key → { name, labels, buckets, counts[], sum, count }

function _counterKey(name, labels) {
  const parts = Object.keys(labels).sort().map((k) => `${k}=${labels[k]}`).join(',');
  return `${name}|${parts}`;
}

function incCounter(name, labels, delta = 1) {
  const key = _counterKey(name, labels);
  const row = counters.get(key);
  if (row) { row.value += delta; return; }
  counters.set(key, { name, labels: { ...labels }, value: delta });
}

function observeHistogram(name, labels, buckets, value) {
  const key = _counterKey(name, labels);
  let row = histograms.get(key);
  if (!row) {
    row = {
      name,
      labels: { ...labels },
      buckets,
      counts: new Array(buckets.length).fill(0),
      sum: 0,
      count: 0,
    };
    histograms.set(key, row);
  }
  row.sum   += value;
  row.count += 1;
  // Cumulative bucket semantics (Prometheus convention).
  for (let i = 0; i < buckets.length; i++) {
    if (value <= buckets[i]) row.counts[i] += 1;
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

function observeHttp({ method, route, status, durationMs }) {
  const labels = {
    method: String(method || 'GET').toUpperCase(),
    route: normalizeRoute(route),
    status: String(status || 0),
  };
  incCounter('http_requests_total', labels);
  observeHistogram(
    'http_request_duration_ms',
    { method: labels.method, route: labels.route },
    HTTP_BUCKETS,
    durationMs || 0,
  );
}

function incJob(kind, status, { durationMs } = {}) {
  const labels = { kind: String(kind || 'unknown'), status: String(status || 'unknown') };
  incCounter('studio_jobs_total', labels);
  if (typeof durationMs === 'number' && durationMs > 0) {
    observeHistogram('studio_job_duration_ms', labels, JOB_BUCKETS, durationMs);
  }
}

function incCredits({ reason, sign, amount }) {
  // sign is 'in' (top-up) or 'out' (charge/refund-forward)
  const labels = { reason: String(reason || 'unknown'), sign: String(sign || 'unknown') };
  incCounter('credits_delta_total', labels, Math.abs(Number(amount) || 0));
}

function incScan(status) {
  incCounter('url_scans_total', { status: String(status || 'unknown') });
}

/** Apify actor runs — total attempts, cache hits, hard failures. */
function incApify(kind) {
  const k = String(kind || 'unknown');
  if (k === 'total') incCounter('apify_runs_total', {});
  else if (k === 'cached') incCounter('apify_runs_cached', {});
  else if (k === 'failed') incCounter('apify_runs_failed', {});
}

// ─── Exposition ─────────────────────────────────────────────────────────────

function escape(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function labelPairs(labels) {
  const keys = Object.keys(labels);
  if (keys.length === 0) return '';
  return '{' + keys.map((k) => `${k}="${escape(labels[k])}"`).join(',') + '}';
}

function render() {
  const lines = [];
  // Group counters by name so each metric has a single HELP/TYPE block.
  const byName = new Map();
  for (const row of counters.values()) {
    if (!byName.has(row.name)) byName.set(row.name, []);
    byName.get(row.name).push(row);
  }
  for (const [name, rows] of byName) {
    lines.push(`# HELP ${name} Qumak counter`);
    lines.push(`# TYPE ${name} counter`);
    for (const r of rows) lines.push(`${name}${labelPairs(r.labels)} ${r.value}`);
  }
  const histByName = new Map();
  for (const row of histograms.values()) {
    if (!histByName.has(row.name)) histByName.set(row.name, []);
    histByName.get(row.name).push(row);
  }
  for (const [name, rows] of histByName) {
    lines.push(`# HELP ${name} Qumak histogram (milliseconds)`);
    lines.push(`# TYPE ${name} histogram`);
    for (const r of rows) {
      for (let i = 0; i < r.buckets.length; i++) {
        lines.push(`${name}_bucket${labelPairs({ ...r.labels, le: r.buckets[i] })} ${r.counts[i]}`);
      }
      lines.push(`${name}_bucket${labelPairs({ ...r.labels, le: '+Inf' })} ${r.count}`);
      lines.push(`${name}_sum${labelPairs(r.labels)} ${r.sum}`);
      lines.push(`${name}_count${labelPairs(r.labels)} ${r.count}`);
    }
  }
  // Process uptime is cheap and useful.
  lines.push('# HELP process_uptime_seconds Seconds since process start');
  lines.push('# TYPE process_uptime_seconds gauge');
  lines.push(`process_uptime_seconds ${Math.round(process.uptime())}`);

  return lines.join('\n') + '\n';
}

function handler(_req, res) {
  res.setHeader('content-type', 'text/plain; version=0.0.4');
  res.status(200).send(render());
}

// Tests need to reset between suites.
function _reset() {
  counters.clear();
  histograms.clear();
}

module.exports = {
  observeHttp,
  incJob,
  incCredits,
  incScan,
  incApify,
  render,
  handler,
  _reset,
  _counters: counters,      // exposed for unit tests only
  _histograms: histograms,
};
