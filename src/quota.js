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
// app restarts.
function readServerInfo() {
  let origin = null;
  try {
    let best = null;
    for (const f of fs.readdirSync(INSTANCES_DIR)) {
      if (!f.endsWith('.json')) continue;
      const inst = JSON.parse(fs.readFileSync(path.join(INSTANCES_DIR, f), 'utf8'));
      if (!inst.host || !inst.port) continue;
      if (!best || (inst.heartbeat_at || 0) > (best.heartbeat_at || 0)) best = inst;
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

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const usedRatio = Number(usage.usedRatio);
  if (!Number.isFinite(usedRatio)) return null;
  const resetMs = new Date(usage.resetAt).getTime();
  return { ...usage, usedRatio, resetAt: Number.isFinite(resetMs) ? usage.resetAt : null };
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

module.exports = { fetchQuota, readServerInfo };
