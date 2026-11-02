// Fetches Kimi Code quota from the desktop app's local server.
// Reads the server registry (instances dir, then rc.json) and
// ~/.kimi-code/server.token on every call, so it follows app restarts,
// re-logins, and app updates that move the registry.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const KIMI_DIR = path.join(os.homedir(), '.kimi-code');
const RC_FILE = path.join(KIMI_DIR, 'server', 'rc.json');
const INSTANCES_DIR = path.join(KIMI_DIR, 'server', 'instances');
const TOKEN_FILE = path.join(KIMI_DIR, 'server.token');
const DEFAULT_ORIGIN = 'http://127.0.0.1:23125';

// app >= 2.4.0: registry is server/instances/<id>.json files {host, port,
// pid, heartbeat_at, ...}; rc.json with local_origin is the older layout.
// Pick the instance with the freshest heartbeat — stale files linger after
// app restarts. A bad file must not abort the scan of the rest.
function readServerInfo() {
  let origin = null;
  try {
    let best = null;
    for (const f of fs.readdirSync(INSTANCES_DIR)) {
      if (!f.endsWith('.json')) continue;
      let inst = null;
      try {
        inst = JSON.parse(fs.readFileSync(path.join(INSTANCES_DIR, f), 'utf8'));
      } catch (_) { continue; } // one corrupt file must not kill discovery
      if (!inst || typeof inst.host !== 'string' || !inst.host) continue;
      const port = Number(inst.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
      if (!best || (inst.heartbeat_at || 0) > (best.heartbeat_at || 0)) best = { host: inst.host, port, heartbeat_at: inst.heartbeat_at || 0 };
    }
    if (best) origin = `http://${best.host}:${best.port}`;
  } catch (_) { /* no instances dir -> older app or not running */ }
  if (!origin) {
    try {
      const rc = JSON.parse(fs.readFileSync(RC_FILE, 'utf8'));
      if (rc.local_origin) origin = rc.local_origin;
    } catch (_) { /* rc.json missing -> desktop app not running or default port */ }
  }
  return { origin: origin || DEFAULT_ORIGIN, token: readToken() };
}

function readToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch (_) { return null; /* no token */ }
}

// Strict ratio coercion: real numbers, or numeric strings from the cloud API.
// Rejects '' / null / booleans / objects, which Number() would quietly pass.
function toRatio(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) {
    const n = Number(v);
    return n >= 0 ? n : null;
  }
  return null;
}

function validResetAt(s) {
  if (typeof s !== 'string' || !s) return null;
  return Number.isFinite(new Date(s).getTime()) ? s : null;
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const usedRatio = toRatio(usage.usedRatio);
  if (usedRatio == null) return null;
  return { ...usage, usedRatio, resetAt: validResetAt(usage.resetAt) };
}

async function fetchQuota() {
  const { origin, token } = readServerInfo();
  if (!token) {
    return { ok: false, reason: 'no-token', message: 'Kimi Code not logged in (server.token missing)' };
  }
  let res;
  try {
    res = await fetch(`${origin}/api/v1/oauth/usage`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    return { ok: false, reason: 'unreachable', message: 'Kimi Code desktop app is not running' };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: 'auth', message: 'Usage API rejected the token (re-login in Kimi Code?)' };
  }
  if (!res.ok) {
    return { ok: false, reason: 'http', message: `Usage API returned HTTP ${res.status}` };
  }
  const body = await res.json().catch(() => null);
  // the local server answers 200/code:0 even when ITS upstream fetch fails —
  // it signals that as data.kind === 'error' with no quota payload. This is
  // transient and frequent (upstream network blips), so it gets its own reason.
  if (body && body.code === 0 && body.data && body.data.kind === 'error') {
    return { ok: false, reason: 'upstream', message: 'Kimi usage service temporarily unavailable' };
  }
  if (!body || body.code !== 0 || !body.data || !body.data.quota) {
    return { ok: false, reason: 'shape', message: 'Unexpected usage API response shape', raw: body };
  }
  const q = body.data.quota;
  const usages = q.usages || {};
  return {
    ok: true,
    kind: body.data.kind,
    fetchedAt: Date.now(),
    limit5h: normalizeUsage(usages.limit5h),
    monthCode: normalizeUsage(usages.monthCode),
    monthTotal: normalizeUsage(usages.monthTotal),
    extraUsage: q.extraUsage || null,
  };
}

// ---------- Cloud source: API key from the Kimi Code Console ----------
// Same data the desktop app shows, but straight from Kimi's servers — works
// even when the desktop app is closed. Endpoint and snake_case shape
// recovered from the app's own bundle (the CLI's /usage calls the same URL):
//   GET {base}/usages, Authorization: Bearer <api key>
//   -> { usages: { limit_5h: {used_ratio, reset_time}, ... }, boosterWallet }
const CLOUD_BASES = ['https://api.kimi.com/coding/v1', 'https://api.kimi.ai/coding/v1'];

function normalizeCloudUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const usedRatio = toRatio(u.used_ratio ?? u.usedRatio);
  if (usedRatio == null) return null;
  return { usedRatio, resetAt: validResetAt(u.reset_time ?? u.resetAt) };
}

async function fetchQuotaCloud(apiKey) {
  let lastNetErr = null;
  for (const base of CLOUD_BASES) {
    try {
      const res = await fetch(`${base}/usages`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 401 || res.status === 403) {
        const detail = await res.json().catch(() => null);
        const why = detail && detail.error && detail.error.message ? `: ${detail.error.message}` : '';
        return { ok: false, reason: 'auth', message: `API key rejected (${res.status})${why}` };
      }
      if (res.status === 404) {
        lastNetErr = new Error(`HTTP 404 at ${base}`);
        continue; // endpoint may only exist on the other region's host
      }
      if (!res.ok) {
        return { ok: false, reason: 'http', message: `Usage API returned HTTP ${res.status}` };
      }
      const body = await res.json().catch(() => null);
      if (!body || typeof body !== 'object' || !body.usages) {
        return { ok: false, reason: 'shape', message: 'Unexpected cloud usage response shape', raw: body };
      }
      const u = body.usages || {};
      const result = {
        ok: true,
        kind: 'ok',
        source: 'api',
        fetchedAt: Date.now(),
        limit5h: normalizeCloudUsage(u.limit_5h),
        limit7d: normalizeCloudUsage(u.limit_7d),
        monthCode: normalizeCloudUsage(u.limit_month_code),
        monthTotal: normalizeCloudUsage(u.limit_month_total),
        extraUsage: body.boosterWallet || null,
      };
      // a response with no usable quota fields shows nothing — treat as an error
      if (!result.limit5h && !result.limit7d && !result.monthCode && !result.monthTotal) {
        return { ok: false, reason: 'shape', message: 'Cloud usage response had no quota fields', raw: body };
      }
      return result;
    } catch (err) {
      lastNetErr = err; // network/geo failure — try the other region's host
    }
  }
  return { ok: false, reason: 'unreachable', message: `Cloud usage API unreachable (${lastNetErr ? lastNetErr.message : 'fetch failed'})` };
}

module.exports = { fetchQuota, fetchQuotaCloud, readServerInfo };
