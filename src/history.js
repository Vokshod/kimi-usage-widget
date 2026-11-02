// Keeps a rolling sample history of quota ratios so the widget can answer
// "how much of the monthly quota was consumed today": current ratio minus the
// ratio at the most recent local midnight (linear interpolation between the
// samples straddling midnight).
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_SAMPLES = 3000; // ~2 days at 1/min

function toFiniteOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// crash-safe persistence: write a temp file, then rename over the target —
// a crash mid-write can never leave a truncated JSON file
function writeJsonAtomic(file, obj) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

class QuotaHistory {
  constructor(file) {
    this.file = file;
    this.samples = [];
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(raw)) {
        this.samples = raw
          .filter(s => s && Number.isFinite(s.t))
          .map(s => ({
            t: s.t,
            h5: toFiniteOrNull(s.h5),
            mc: toFiniteOrNull(s.mc),
            mt: toFiniteOrNull(s.mt),
          }))
          .sort((a, b) => a.t - b.t); // interpolation assumes sorted samples
      }
    } catch (_) { /* first run */ }
  }

  record(quota) {
    if (!quota || !quota.ok) return;
    const s = {
      t: quota.fetchedAt,
      h5: quota.limit5h ? quota.limit5h.usedRatio : null,
      mc: quota.monthCode ? quota.monthCode.usedRatio : null,
      mt: quota.monthTotal ? quota.monthTotal.usedRatio : null,
    };
    const last = this.samples[this.samples.length - 1];
    if (last && last.t > s.t - 30000) { this.samples[this.samples.length - 1] = s; } else { this.samples.push(s); }
    if (this.samples.length > MAX_SAMPLES) {
      this.samples = this.samples.slice(this.samples.length - MAX_SAMPLES);
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      writeJsonAtomic(this.file, this.samples);
    } catch (_) { /* best effort */ }
  }

  // Value of field `key` ('mc'|'mt'|'h5') at local-midnight boundary `dayStartMs`.
  valueAt(key, dayStartMs) {
    const vals = this.samples.filter(s => s[key] != null);
    if (vals.length === 0) return null;
    let prev = null;
    for (const s of vals) {
      if (s.t >= dayStartMs) {
        if (s.t === dayStartMs) return s[key];
        if (prev === null) return null; // no sample before midnight -> unknown
        if (s.t === prev.t) return prev[key];
        // linear interpolation between prev and s
        const f = (dayStartMs - prev.t) / (s.t - prev.t);
        return prev[key] + (s[key] - prev[key]) * f;
      }
      prev = s;
    }
    return null; // all samples before midnight (shouldn't happen for "today")
  }
}

module.exports = { QuotaHistory };
