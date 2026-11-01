'use strict';
// Smoke test for the data modules: node test-data.js
const { fetchQuota, fetchQuotaCloud } = require('./src/quota');
const { aggregateWireStats } = require('./src/wirestats');
const { QuotaHistory } = require('./src/history');

(async () => {
  const quota = await fetchQuota();
  console.log('== quota ==');
  console.log(JSON.stringify(quota, null, 1));

  console.log('\n== wire stats ==');
  const t0 = Date.now();
  const stats = aggregateWireStats();
  console.log(`scanned ${stats.scannedFiles} wire files in ${Date.now() - t0}ms`);
  for (const [m, v] of Object.entries(stats.models)) {
    console.log(`  ${m}: today=${v.today} 7d=${v.last7d} total=${v.totalTokens} req=${v.requests}`);
  }
  console.log('daily:', stats.daily.map(d => `${new Date(d.dayStartMs).toISOString().slice(5, 10)}=${d.totalTokens}`).join(' '));

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
  console.log(`midnight baseline for today: ${base === null ? 'null (expected: no sample before midnight)' : base}`);
  const h2 = new QuotaHistory(tmp);
  console.log(`persisted samples: ${h2.samples.length} (expected 2)`);
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
  } else {
    console.log('no apiToken in settings.json — skipped (set one in the widget to test)');
  }
})();
