'use strict';
// DevTools-protocol helper: dumps widget DOM state, captures screenshots.
// usage: node cdp-shot.js [9223]
const PORT = process.argv[2] || '9223';
const fs = require('fs');

async function getWsUrl() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
  if (!page) throw new Error('widget page target not found');
  return page.webSocketDebuggerUrl;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.onopen = () => resolve({
      send: (method, params = {}) => new Promise((res, rej) => {
        const mid = ++id;
        pending.set(mid, { res, rej });
        ws.send(JSON.stringify({ id: mid, method, params }));
      }),
      close: () => ws.close(),
    });
    ws.onerror = (e) => reject(new Error('ws error'));
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

(async () => {
  const cdp = await connect(await getWsUrl());
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  const evalJs = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r.result.value;
  };

  // let it settle, then dump state
  await new Promise((r) => setTimeout(r, 1500));
  const state = await evalJs(`JSON.stringify({
    error: document.getElementById('error').textContent,
    sessPct: document.getElementById('sess-pct').textContent,
    sessReset: document.getElementById('sess-reset').textContent,
    sessFill: document.getElementById('sess-fill').style.width,
    sessPace: document.getElementById('sess-pace').textContent,
    monthPct: document.getElementById('month-pct').textContent,
    monthReset: document.getElementById('month-reset').textContent,
    monthFill: document.getElementById('month-fill').style.width,
    monthDaily: document.getElementById('month-daily').textContent,
    bodyH: document.body.scrollHeight,
  })`);
  console.log('STATE:', state);

  const shot = async (file) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    console.log('saved', file);
  };

  await shot('shot-collapsed.png');

  // expand details
  await evalJs(`document.getElementById('btn-expand').click(); 'ok'`);
  await new Promise((r) => setTimeout(r, 2500)); // stats fetch + render
  const statsState = await evalJs(`JSON.stringify({
    models: document.getElementById('model-list').innerText,
    chartCols: document.querySelectorAll('#week-chart .wcol').length,
  })`);
  console.log('STATS:', statsState);
  await shot('shot-expanded.png');

  // open settings
  await evalJs(`document.getElementById('btn-settings').click(); 'ok'`);
  await new Promise((r) => setTimeout(r, 400));
  await shot('shot-settings.png');

  cdp.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
