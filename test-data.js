'use strict';
// Smoke test for the data modules: node test-data.js
// Local checks are hard assertions (exit 1 on failure); live API checks are
// warn-only because this machine's quota/network can legitimately fail them.
const { fetchQuota, fetchQuotaCloud } = require('./src/quota');
const { aggregateWireStats } = require('./src/wirestats');
const { QuotaHistory } = require('./src/history');

let passed = 0, failed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  PASS ${name}${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const ratioOk = (r) => r === null || (Number.isFinite(r) && r >= 0);

(async () => {
  console.log('== quota (local source) ==');
  const quota = await fetchQuota();
  console.log(JSON.stringify(quota, null, 1));
  if (quota.ok) {
    check('5h ratio valid', ratioOk(quota.limit5h && quota.limit5h.usedRatio), String(quota.limit5h && quota.limit5h.usedRatio));
    check('month ratio valid', ratioOk(quota.monthCode && quota.monthCode.usedRatio), String(quota.monthCode && quota.monthCode.usedRatio));
  } else {
    console.log(`  WARN local quota fetch failed (${quota.reason}): ${quota.message}`);
  }

  console.log('\n== wire stats ==');
  const t0 = Date.now();
  const stats = aggregateWireStats();
  console.log(`scanned ${stats.scannedFiles} wire files in ${Date.now() - t0}ms`);
  for (const [m, v] of Object.entries(stats.models)) {
    console.log(`  ${m}: today=${v.today} 7d=${v.last7d} total=${v.totalTokens} req=${v.requests}`);
  }
  console.log('daily:', stats.daily.map(d => `${new Date(d.dayStartMs).toISOString().slice(5, 10)}=${d.totalTokens}`).join(' '));
  check('daily has exactly 7 buckets', stats.daily.length === 7, String(stats.daily.length));
  check('daily sorted ascending', stats.daily.every((d, i) => i === 0 || d.dayStartMs > stats.daily[i - 1].dayStartMs));
  check('daily buckets are local midnights', stats.daily.every((d) => {
    const x = new Date(d.dayStartMs); return x.getHours() === 0 && x.getMinutes() === 0 && x.getSeconds() === 0;
  }));
  check('no __proto__ pollution in models', !('__proto__' in stats.models));

  console.log('\n== history (in-memory round-trip) ==');
  const fs = require('fs');
  const tmp = require('path').join(require('os').tmpdir(), 'quota-history-test.json');
  try { fs.unlinkSync(tmp); } catch (_) {}
  const h = new QuotaHistory(tmp);
  const now = Date.now();
  h.record({ ok: true, fetchedAt: now - 86400000, monthCode: { usedRatio: 0.04 } });
  h.record({ ok: true, fetchedAt: now, monthCode: { usedRatio: 0.067 } });
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const base = h.valueAt('mc', dayStart.getTime());
  // expected: linear interpolation between the two samples straddling midnight
  const f = (dayStart.getTime() - (now - 86400000)) / 86400000;
  const expectedBase = 0.04 + (0.067 - 0.04) * f;
  check('midnight baseline interpolates between samples', base !== null && Math.abs(base - expectedBase) < 1e-9, `base=${base} expected=${expectedBase}`);
  const h2 = new QuotaHistory(tmp);
  check('2 samples persisted', h2.samples.length === 2, String(h2.samples.length));
  check('persisted ratios survive round-trip', h2.samples.every(s => ratioOk(s.mc)), JSON.stringify(h2.samples.map(s => s.mc)));
  try { fs.unlinkSync(tmp); } catch (_) {}

  console.log('\n== cloud source (only if an apiToken is configured) ==');
  const settingsPath = require('path').join(require('os').homedir(), 'AppData', 'Roaming', 'kimi-usage-widget', 'settings.json');
  let apiToken = null;
  try { apiToken = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).apiToken; } catch (_) { /* no settings */ }
  if (apiToken) {
    const cloud = await fetchQuotaCloud(apiToken);
    console.log(cloud.ok
      ? `ok: 5h=${cloud.limit5h && cloud.limit5h.usedRatio} month=${cloud.monthCode && cloud.monthCode.usedRatio} extra=${cloud.extraUsage ? 'yes' : 'no'}`
      : `FAILED (${cloud.reason}): ${cloud.message}`);
    if (cloud.ok) {
      check('cloud 5h ratio valid', ratioOk(cloud.limit5h && cloud.limit5h.usedRatio), String(cloud.limit5h && cloud.limit5h.usedRatio));
      check('cloud month ratio valid', ratioOk(cloud.monthCode && cloud.monthCode.usedRatio), String(cloud.monthCode && cloud.monthCode.usedRatio));
    }
  } else {
    console.log('no apiToken in settings.json — skipped (set one in the widget to test)');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
