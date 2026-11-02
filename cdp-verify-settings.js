'use strict';
// Full settings verification: simulates REAL UI interaction (slider drags,
// checkbox clicks) for renderer-side effects; direct setSetting for main-side.
const PORT = process.argv[2] || '9224';

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
  const setDirect = (key, val) => evalJs(`window.widget.setSetting('${key}', ${JSON.stringify(val)}).then(s => JSON.stringify(s))`).then(JSON.parse);
  const drag = (id, value) => evalJs(`(() => {
    const el = document.getElementById('${id}');
    el.value = '${value}';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);
  const click = (id) => evalJs(`(() => { document.getElementById('${id}').click(); return 'ok'; })()`);
  const shot = async (file) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    require('fs').writeFileSync(file, Buffer.from(data, 'base64'));
  };
  const metrics = async () => JSON.parse(await evalJs(`JSON.stringify({
    innerW: window.innerWidth, dpr: window.devicePixelRatio,
    bodyFont: getComputedStyle(document.body).fontSize,
  })`));

  await click('btn-settings'); // open panel so sliders exist & are visible
  await new Promise((r) => setTimeout(r, 300));
  // establish the true base dpr at zoom 1.0 first (window may sit on either monitor)
  await drag('set-scale', '1.0');
  await new Promise((r) => setTimeout(r, 800));
  const baseDpr = (await metrics()).dpr;
  console.log(`  (base dpr at zoom 1.0: ${baseDpr})`);

  console.log('== 1. scale (slider drag, both directions) ==');
  await drag('set-scale', '0.6');
  await new Promise((r) => setTimeout(r, 800));
  let m = await metrics();
  const physAt06 = m.innerW * m.dpr;
  check('zoom applied (dpr scales)', Math.abs(m.dpr - baseDpr * 0.6) < 0.02, `dpr ${m.dpr} vs base ${baseDpr}`);
  check('physical width ~340*0.6*dpr', Math.abs(physAt06 - 340 * 0.6 * baseDpr) <= 12, `${Math.round(physAt06)} vs ${Math.round(340 * 0.6 * baseDpr)}`);
  await drag('set-scale', '1.5');
  await new Promise((r) => setTimeout(r, 800));
  m = await metrics();
  const physAt15 = m.innerW * m.dpr;
  check('grow to 1.5', Math.abs(physAt15 - 340 * 1.5 * baseDpr) <= 12, `${Math.round(physAt15)} vs ${Math.round(340 * 1.5 * baseDpr)}`);
  await drag('set-scale', '0.6'); // shrink again — the original bug
  await new Promise((r) => setTimeout(r, 800));
  m = await metrics();
  const physAt06b = m.innerW * m.dpr;
  check('shrink back to 0.6 works', Math.abs(physAt06b - 340 * 0.6 * baseDpr) <= 12, `${Math.round(physAt06b)}`);
  await shot('verify-scale-small.png');
  await drag('set-scale', '1.0');
  await new Promise((r) => setTimeout(r, 800));
  m = await metrics();
  check('restore 1.0', Math.abs(m.innerW * m.dpr - 340 * baseDpr) <= 12, `${Math.round(m.innerW * m.dpr)}`);

  console.log('== 2. fontSize ==');
  await drag('set-font', '18');
  await new Promise((r) => setTimeout(r, 300));
  check('font 18px', (await metrics()).bodyFont === '18px');
  // the largest font must not clip the wrap-allowed sub row (audit #9)
  check('month-daily not clipped at font 18', await evalJs(`(() => {
    const el = document.getElementById('month-daily');
    return el.scrollWidth <= el.clientWidth + 2;
  })()`), await evalJs(`document.getElementById('month-daily').scrollWidth + '/' + document.getElementById('month-daily').clientWidth`));
  await drag('set-font', '13');
  await new Promise((r) => setTimeout(r, 300));
  check('font back 13px', (await metrics()).bodyFont === '13px');

  console.log('== 3. opacity ==');
  await drag('set-opacity', '0.5');
  await new Promise((r) => setTimeout(r, 400));
  await shot('verify-opacity.png');
  const s3 = await setDirect('opacity', 1);
  check('opacity restored to 1', s3.opacity === 1);

  console.log('== 4. compact ==');
  await click('set-compact');
  await new Promise((r) => setTimeout(r, 300));
  check('compact hides sub rows', await evalJs(`document.getElementById('app').classList.contains('compact') && getComputedStyle(document.querySelector('.sub')).display === 'none'`));
  await click('set-compact');
  await new Promise((r) => setTimeout(r, 300));
  check('compact off restores rows', await evalJs(`!document.getElementById('app').classList.contains('compact') && getComputedStyle(document.querySelector('.sub')).display !== 'none'`));

  console.log('== 5. theme ==');
  await click('set-theme');
  await new Promise((r) => setTimeout(r, 300));
  check('light theme applied', await evalJs(`document.getElementById('app').classList.contains('theme-light')`));
  await shot('verify-theme-light.png');
  await click('set-theme');
  await new Promise((r) => setTimeout(r, 300));

  console.log('== 6. warn/danger thresholds recolor bars ==');
  // threshold assertions must not depend on the CURRENT live usage: derive
  // them from the bar's actual fill so the suite passes at any usage level
  const rNow = await evalJs(`parseFloat(document.getElementById('sess-fill').style.width) / 100`);
  const warnProbe = Math.max(0.05, Math.min(0.95, rNow - 0.02));
  const dangerProbe = Math.max(0.1, Math.min(1, rNow - 0.01));
  await evalJs(`(() => { const el = document.getElementById('set-warn'); el.value = '${warnProbe}'; el.dispatchEvent(new Event('input', {bubbles:true})); return 1; })()`);
  await new Promise((r) => setTimeout(r, 400));
  let st = await setDirect('noop', 0).catch(() => null);
  const clsW = await evalJs(`document.getElementById('sess-fill').className + ' | warnAt=' + document.getElementById('set-warn').value + ' | r=${rNow}'`);
  check('warn below current usage colors bar warn', clsW.startsWith('fill warn'), clsW);
  await evalJs(`(() => { const el = document.getElementById('set-danger'); el.value = '${dangerProbe}'; el.dispatchEvent(new Event('input', {bubbles:true})); return 1; })()`);
  await new Promise((r) => setTimeout(r, 400));
  const clsD = await evalJs(`document.getElementById('sess-fill').className + ' | danger=' + document.getElementById('set-danger').value + ' | r=${rNow}'`);
  check('danger below current usage colors bar danger', clsD.startsWith('fill danger'), clsD);
  // restore: danger FIRST (higher), then warn — restoring in the opposite
  // order makes the pair clamp pull warn below the still-low danger probe
  await evalJs(`(() => { const el = document.getElementById('set-danger'); el.value = '0.9'; el.dispatchEvent(new Event('input', {bubbles:true})); return 1; })()`);
  await new Promise((r) => setTimeout(r, 400));
  await evalJs(`(() => { const el = document.getElementById('set-warn'); el.value = '0.75'; el.dispatchEvent(new Event('input', {bubbles:true})); return 1; })()`);
  await new Promise((r) => setTimeout(r, 400));

  console.log('== 7. clamping ==');
  let s = await setDirect('opacity', 0); check('opacity 0 -> 0.2', s.opacity === 0.2, String(s.opacity));
  s = await setDirect('scale', 99); check('scale 99 -> 1.6', s.scale === 1.6, String(s.scale));
  s = await setDirect('warnAt', 'abc'); check('warnAt abc rejected', s.warnAt === 0.75, String(s.warnAt));
  s = await setDirect('pollMinutes', 0.2); check('poll 0.2 -> 1', s.pollMinutes === 1, String(s.pollMinutes));
  s = await setDirect('fontSize', 99); check('font 99 -> 18', s.fontSize === 18, String(s.fontSize));
  // warnAt must never end up >= dangerAt — the pair clamp pulls warn below danger (audit #12)
  s = await setDirect('dangerAt', 0.3);
  check('dangerAt 0.3 pulls warnAt below it', s.dangerAt === 0.3 && s.warnAt < s.dangerAt, `warnAt=${s.warnAt} dangerAt=${s.dangerAt}`);
  s = await setDirect('dangerAt', 0.9);
  s = await setDirect('warnAt', 0.75);
  check('thresholds restored 0.75/0.9', s.warnAt === 0.75 && s.dangerAt === 0.9, `warnAt=${s.warnAt} dangerAt=${s.dangerAt}`);
  s = await setDirect('scale', 1);
  await new Promise((r) => setTimeout(r, 800));
  check('scale restored to 1 after clamp tests', s.scale === 1, String(s.scale));

  console.log('== 8. pollMinutes ==');
  s = await setDirect('pollMinutes', 2);
  check('poll 2 accepted', s.pollMinutes === 2, String(s.pollMinutes));
  await setDirect('pollMinutes', 1);

  console.log('== 9. apiToken (cloud source) ==');
  await drag('set-apitoken', '  test-token-abc  ');
  await new Promise((r) => setTimeout(r, 300));
  s = await setDirect('noop', 0);
  check('token typed + trimmed', s.apiToken === 'test-token-abc', JSON.stringify(s.apiToken));
  check('UI input shows trimmed value', await evalJs(`document.getElementById('set-apitoken').value`) === 'test-token-abc');
  check('non-string rejected', (await setDirect('apiToken', 42)).apiToken === 'test-token-abc');
  await drag('set-apitoken', '');
  await new Promise((r) => setTimeout(r, 300));
  s = await setDirect('noop', 0);
  check('cleared -> empty (back to local source)', s.apiToken === '', JSON.stringify(s.apiToken));
  await shot('verify-apitoken.png');

  console.log('== 10. vertical (slim) layout ==');
  // force a known state through the UI: setDirect bypasses the renderer's
  // in-memory settings, and the user may have left vertical on — the panel
  // must be open for the checkbox anyway
  if (!(await evalJs(`document.getElementById('settings-panel').classList.contains('hidden')`))) {
    await click('btn-settings'); // close if the suite left it open
    await new Promise((r) => setTimeout(r, 400));
  }
  await click('btn-settings'); // open
  await new Promise((r) => setTimeout(r, 300));
  if (await evalJs(`document.getElementById('set-vertical').checked`)) {
    await click('set-vertical'); // ensure OFF before the assertions begin
    await new Promise((r) => setTimeout(r, 400));
  }
  const physW = async () => (await metrics()).innerW * (await metrics()).dpr;
  const expectSlim = 170 * baseDpr, expectWide = 340 * baseDpr; // scale is 1.0 here
  await click('set-vertical');
  await new Promise((r) => setTimeout(r, 400));
  check('vertical class applied', await evalJs(`document.getElementById('app').classList.contains('vertical')`));
  await new Promise((r) => setTimeout(r, 1500));
  let w = await physW();
  check('stays wide while settings open', Math.abs(w - expectWide) <= 14, `${Math.round(w)} vs ${Math.round(expectWide)}`);
  await shot('verify-vertical-settings-wide.png');
  await click('btn-settings'); // close panel -> slim
  await new Promise((r) => setTimeout(r, 2000));
  w = await physW();
  check('slims to ~170 when panel closed', Math.abs(w - expectSlim) <= 14, `${Math.round(w)} vs ${Math.round(expectSlim)}`);
  const vFillW = await evalJs(`document.getElementById('month-fill').style.width`);
  check('monthly fill still width-driven in vertical mode', /%$/.test(vFillW), vFillW);
  await shot('verify-vertical-slim.png');
  await click('btn-expand'); // details -> wide
  await new Promise((r) => setTimeout(r, 2000));
  w = await physW();
  check('goes wide for details', Math.abs(w - expectWide) <= 14, `${Math.round(w)} vs ${Math.round(expectWide)}`);
  await click('btn-expand'); // close details -> slim again
  await new Promise((r) => setTimeout(r, 2000));
  w = await physW();
  check('slims again when details closed', Math.abs(w - expectSlim) <= 14, `${Math.round(w)} vs ${Math.round(expectSlim)}`);
  await click('set-vertical'); // checkbox works hidden — no need to open the panel
  await new Promise((r) => setTimeout(r, 400));
  check('vertical class removed', await evalJs(`!document.getElementById('app').classList.contains('vertical')`));
  await new Promise((r) => setTimeout(r, 2000));
  w = await physW();
  check('width restored to 340', Math.abs(w - expectWide) <= 14, `${Math.round(w)} vs ${Math.round(expectWide)}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  cdp.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
