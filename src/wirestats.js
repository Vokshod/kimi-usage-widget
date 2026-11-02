// Aggregates per-model token usage from Kimi Code session wire logs.
// Walks ~/.kimi-code/sessions/**/wire.jsonl and sums `usage.record` events,
// bucketed by local calendar day. Files are cheaply pre-filtered by mtime.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const SESSIONS_DIR = path.join(os.homedir(), '.kimi-code', 'sessions');
const SCAN_DAYS = 35; // only logs touched within this many days are read
const MAX_FILE_BYTES = 16 * 1024 * 1024; // per-file read cap; logs are append-only so the tail holds recent records

function localDayStartMs(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function localDayOffsetMs(dayStartMs, days) {
  const d = new Date(dayStartMs);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

function* walkWireFiles(dir, minMtime) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walkWireFiles(p, minMtime);
    } else if (e.isFile() && e.name === 'wire.jsonl') {
      try {
        if (fs.statSync(p).mtimeMs >= minMtime) yield p;
      } catch (_) { /* ignore */ }
    }
  }
}

// Returns { models: { [model]: { today, last7d, totalTokens, requests } },
//           daily: [ { dayStartMs, totalTokens } ] for the last 7 local days,
//           todayStart, scannedFiles }
function aggregateWireStats(now = Date.now()) {
  const todayStart = localDayStartMs(now);
  const weekStart = localDayOffsetMs(todayStart, -6);
  const minMtime = now - SCAN_DAYS * 86400000;

  const models = new Map();
  const daily = new Map(); // dayStartMs -> tokens
  for (let i = 0; i < 7; i++) daily.set(localDayOffsetMs(todayStart, -i), 0);
  let scannedFiles = 0;

  const bump = (model, ts, tokens) => {
    if (!models.has(model)) {
      models.set(model, { today: 0, last7d: 0, totalTokens: 0, requests: 0 });
    }
    const m = models.get(model);
    m.totalTokens += tokens;
    m.requests += 1;
    if (ts >= todayStart) m.today += tokens;
    if (ts >= weekStart) {
      m.last7d += tokens;
      const day = localDayStartMs(ts);
      if (daily.has(day)) daily.set(day, daily.get(day) + tokens);
    }
  };

  for (const file of walkWireFiles(SESSIONS_DIR, minMtime)) {
    scannedFiles += 1;
    let data;
    try {
      const size = fs.statSync(file).size;
      const readLen = Math.min(size, MAX_FILE_BYTES);
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(readLen);
        fs.readSync(fd, buf, 0, readLen, size - readLen); // tail: recent records live at the end
        data = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch (_) { continue; }
    for (const line of data.split('\n')) {
      if (!line.includes('"usage.record"')) continue;
      let rec;
      try { rec = JSON.parse(line); } catch (_) { continue; }
      if (rec.type !== 'usage.record' || !rec.usage) continue;
      const u = rec.usage;
      const tokens = [u.inputOther, u.inputCacheRead, u.inputCacheCreation, u.output]
        .reduce((sum, n) => sum + (Number.isFinite(n) && n > 0 ? n : 0), 0);
      if (tokens <= 0) continue;
      bump(rec.model || 'unknown', rec.time || 0, tokens);
    }
  }

  const modelsObj = Object.create(null);
  for (const [k, v] of [...models.entries()].sort((a, b) => b[1].totalTokens - a[1].totalTokens)) {
    modelsObj[k] = v;
  }
  const dailyArr = [...daily.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([dayStartMs, totalTokens]) => ({ dayStartMs, totalTokens }));
  return { models: modelsObj, daily: dailyArr, todayStart, scannedFiles };
}

module.exports = { aggregateWireStats };
