'use strict';
// Pace-phase verification: drives the REAL renderer with synthetic payloads.
const PORT = process.argv[2] || '9228';

async function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.onopen = () => resolve({
      send: (m, p = {}) => new Promise((res, rej) => {
        const mid = ++id;
        pending.set(mid, { res, rej });
        ws.send(JSON.stringify({ id: mid, method: m, params: p }));
      }),
      close: () => ws.close(),
    });
    ws.onerror = () => reject(new Error('ws error'));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      }
    };
  });
}

let passed = 0, failed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  PASS ${name}${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  const evalJs = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };

  console.log('== 1. payload carries pace inputs ==');
  await evalJs('window.widget.refresh()');
  await new Promise((r) => setTimeout(r, 3000));
  const init = await evalJs('window.widget.getInitial()');
  check('windowElapsedMs is finite', Number.isFinite(init.quota.windowElapsedMs), String(init.quota.windowElapsedMs));
  check('elapsed within [0, 5h]', init.quota.windowElapsedMs >= 0 && init.quota.windowElapsedMs <= 5 * 3600000, (init.quota.windowElapsedMs / 60000).toFixed(1) + ' min');
  check('h5Ratio30mAgo is number or null', typeof init.quota.h5Ratio30mAgo === 'number' || init.quota.h5Ratio30mAgo === null, String(init.quota.h5Ratio30mAgo));

  console.log('== 2. phase A: first 5 min -> flat on pace ==');
  await evalJs(`(() => {
    const now = Date.now();
    renderQuota({ ok: true, fetchedAt: now, settings: {},
      limit5h: { usedRatio: 0.4, resetAt: new Date(now + 4.7 * 3600000).toISOString() },
      windowElapsedMs: 3 * 60000, h5Ratio30mAgo: 0.1 });
    return 1; })()`);
  const phaseA = await evalJs(`document.getElementById('sess-pace').textContent`);
  check('shows flat on pace', phaseA === 'pace ok · on pace', phaseA);

  console.log('== 3. phase B: 5-30 min -> window average ==');
  await evalJs(`(() => {
    const now = Date.now();
    renderQuota({ ok: true, fetchedAt: now, settings: {},
      limit5h: { usedRatio: 0.25, resetAt: new Date(now + 4 * 3600000).toISOString() },
      windowElapsedMs: 60 * 60000, h5Ratio30mAgo: null });
    return 1; })()`);
  // elapsed 1h of 5h -> projected = 0.25/0.2 = 125% -> over pace (fallback when no 30m sample)
  const phaseB = await evalJs(`document.getElementById('sess-pace').textContent`);
  check('window-average fallback when no 30m sample', /over pace · would hit 125% before reset/.test(phaseB), phaseB);

  console.log('== 4. phase C: 30m+ -> recent-burn extrapolation ==');
  await evalJs(`(() => {
    const now = Date.now();
    renderQuota({ ok: true, fetchedAt: now, settings: {},
      limit5h: { usedRatio: 0.5, resetAt: new Date(now + 4 * 3600000).toISOString() },
      windowElapsedMs: 60 * 60000, h5Ratio30mAgo: 0.3 });
    return 1; })()`);
  // recentDelta = 0.2 over 30min; remaining 4h = 8x -> projected = 0.5 + 1.6 = 210%
  const phaseC = await evalJs(`document.getElementById('sess-pace').textContent`);
  check('recent-burn extrapolation (early burst ignored)', /would hit 210% before reset/.test(phaseC), phaseC);
  await evalJs(`(() => {
    const now = Date.now();
    renderQuota({ ok: true, fetchedAt: now, settings: {},
      limit5h: { usedRatio: 0.5, resetAt: new Date(now + 4 * 3600000).toISOString() },
      windowElapsedMs: 60 * 60000, h5Ratio30mAgo: 0.45 });
    return 1; })()`);
  // recentDelta = 0.05 -> projected = 0.5 + 0.4 = 90% -> tight
  const phaseC2 = await evalJs(`document.getElementById('sess-pace').textContent`);
  check('calm recent burn -> tight at 90%', /tight · ~90% by reset at current pace/.test(phaseC2), phaseC2);
  await evalJs(`(() => {
    const now = Date.now();
    renderQuota({ ok: true, fetchedAt: now, settings: {},
      limit5h: { usedRatio: 0.4, resetAt: new Date(now + 4 * 3600000).toISOString() },
      windowElapsedMs: 60 * 60000, h5Ratio30mAgo: 0.39 });
    return 1; })()`);
  // recentDelta = 0.01 -> projected = 0.4 + 0.08 = 48% -> pace ok
  const phaseC3 = await evalJs(`document.getElementById('sess-pace').textContent`);
  check('slow recent burn -> pace ok at 48%', /pace ok · on track to use 48% at current pace/.test(phaseC3), phaseC3);

  console.log('== 5. negative recent delta clamps to 0 ==');
  await evalJs(`(() => {
    const now = Date.now();
    renderQuota({ ok: true, fetchedAt: now, settings: {},
      limit5h: { usedRatio: 0.3, resetAt: new Date(now + 4 * 3600000).toISOString() },
      windowElapsedMs: 60 * 60000, h5Ratio30mAgo: 0.5 });
    return 1; })()`);
  // recentDelta clamps to 0 -> projected = 0.3 -> pace ok 30%
  const phaseNeg = await evalJs(`document.getElementById('sess-pace').textContent`);
  check('negative delta clamps, projected = current 30%', /on track to use 30% at current pace/.test(phaseNeg), phaseNeg);

  console.log(`\n${passed} passed, ${failed} failed`);
  cdp.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
