'use strict';

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { fetchQuota } = require('./src/quota');
const { aggregateWireStats } = require('./src/wirestats');
const { QuotaHistory } = require('./src/history');

const POLL_MS = 60000;

const DEFAULT_SETTINGS = {
  scale: 1.1,          // overall UI scale (window content zoom)
  fontSize: 15,        // base font size in px
  opacity: 1.0,        // window opacity 0.2..1
  alwaysOnTop: true,
  autostart: false,    // launch hidden at Windows login (startup-folder shortcut)
  compact: false,      // bars only, no countdown text
  warnAt: 0.75,
  dangerAt: 0.9,
  theme: 'dark',
  pollMinutes: 1,
  expanded: false,
};

let win = null;
let tray = null;
let settings = { ...DEFAULT_SETTINGS };
let settingsFile = null;
let history = null;
let pollTimer = null;
let lastQuota = null;

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    settings = { ...DEFAULT_SETTINGS, ...raw };
    for (const [key, [lo, hi]] of Object.entries(SETTING_CLAMPS)) {
      const n = settings[key];
      settings[key] = Number.isFinite(n)
        ? Math.min(hi, Math.max(lo, key === 'fontSize' || key === 'pollMinutes' ? Math.round(n) : n))
        : DEFAULT_SETTINGS[key];
    }
    for (const key of ['alwaysOnTop', 'autostart', 'compact', 'expanded']) {
      if (typeof settings[key] !== 'boolean') settings[key] = DEFAULT_SETTINGS[key];
    }
    if (settings.theme !== 'dark' && settings.theme !== 'light') settings.theme = DEFAULT_SETTINGS.theme;
  } catch (_) { /* keep defaults */ }
}

function saveSettings() {
  try { fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2)); } catch (_) { /* ignore */ }
}

// ---------- Windows autostart (startup-folder shortcut -> hidden VBS launch) ----------
function autostartLnkPath() {
  return path.join(
    app.getPath('appData'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
    'Kimi Usage Widget.lnk'
  );
}

function autostartEnabled() {
  try { return fs.existsSync(autostartLnkPath()); } catch (_) { return false; }
}

function setAutostart(on) {
  const lnk = autostartLnkPath();
  if (!on) {
    try { fs.unlinkSync(lnk); } catch (_) { /* not there */ }
    return;
  }
  const proj = __dirname;
  const vbs = path.join(proj, 'Kimi Usage Widget.vbs');
  const icon = path.join(proj, 'node_modules', 'electron', 'dist', 'electron.exe');
  const ps = [
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${lnk}')`,
    `$s.TargetPath = 'C:\\Windows\\System32\\wscript.exe'`,
    `$s.Arguments = '"${vbs}"'`,
    `$s.WorkingDirectory = '${proj}'`,
    `$s.IconLocation = '${icon},0'`,
    `$s.Description = 'Kimi Code usage widget'`,
    `$s.Save()`,
  ].join('; ');
  execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], () => { /* best effort */ });
}

function applyWindowSettings() {
  if (!win) return;
  win.setAlwaysOnTop(settings.alwaysOnTop, 'screen-saver');
  win.setOpacity(settings.opacity);
}

// last desired dimensions; the reconcile loop converges the real window onto
// them because some platform paths silently ignore shrinking resizes
let targetW = null;
let targetH = null;

// Resize with read-back verification: some platform paths (transparent windows,
// cross-monitor DPI) silently ignore setSize. Escalate through known-good
// strategies until the size sticks (max 4 attempts).
function setSizeVerified(w, h) {
  if (!win) return;
  // NOTE: never toggle setResizable here — going resizable=false freezes
  // min=max at the current size (Chromium SetMinMaxSizeToCurrent), poisoning
  // every later resize. If the platform ignores the first three strategies,
  // hiding before the resize clears whatever DWM state blocks it.
  const attempts = [
    () => { const b = win.getBounds(); win.setBounds({ ...b, width: w, height: h }); },
    () => win.setSize(w, h),
    () => win.setContentSize(w, h),
    () => { win.hide(); win.setSize(w, h); win.show(); },
  ];
  for (const attempt of attempts) {
    attempt();
    const [aw, ah] = win.getSize();
    if (Math.abs(aw - w) <= 2 && Math.abs(ah - h) <= 2) return;
  }
}

function applyScale() {
  if (!win) return;
  targetW = Math.max(200, Math.round(340 * settings.scale));
  win.webContents.setZoomFactor(settings.scale);
  setSizeVerified(targetW, win.getSize()[1]);
}

// self-healing: converges the window onto targetW/targetH every second
function startReconcileLoop() {
  setInterval(() => {
    if (!win || targetW == null) return;
    const [cw, ch] = win.getSize();
    const wantH = targetH != null ? targetH : ch;
    if (Math.abs(cw - targetW) > 2 || Math.abs(ch - wantH) > 2) {
      console.log(`[dbg] reconcile ${cw}x${ch} -> ${targetW}x${wantH}`);
      setSizeVerified(targetW, wantH);
    }
  }, 1000);
}

// numeric bounds; values outside are clamped, non-numbers rejected
const SETTING_CLAMPS = {
  scale: [0.6, 1.6],
  fontSize: [10, 18],
  opacity: [0.2, 1],
  warnAt: [0.05, 0.95],
  dangerAt: [0.1, 1],
  pollMinutes: [1, 15],
};

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

let pollPromise = null;
function pollOnce() {
  if (pollPromise) return pollPromise;
  pollPromise = (async () => {
    try {
      const quota = await fetchQuota();
      if (quota.ok) {
        history.record(quota);
        lastQuota = quota;
      }
      send('quota', buildPayload(quota));
    } catch (err) {
      send('quota', buildPayload({ ok: false, message: err.message || 'Quota refresh failed' }));
    } finally {
      pollPromise = null;
    }
  })();
  return pollPromise;
}

function buildPayload(quota) {
  const now = Date.now();
  const payload = { ok: quota.ok, fetchedAt: now, settings };
  if (!quota.ok) {
    payload.error = quota.message || 'Unknown error';
    return payload;
  }
  payload.kind = quota.kind;
  payload.limit5h = quota.limit5h;
  payload.monthCode = quota.monthCode;
  payload.monthTotal = quota.monthTotal;
  payload.extraUsage = quota.extraUsage;

  // "consumed today" for the monthly quota, from midnight baseline
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  payload.dayStartMs = dayStart.getTime();
  const base = history.valueAt('mc', dayStart.getTime());
  payload.monthConsumedToday = (base != null && quota.monthCode)
    ? Math.max(0, quota.monthCode.usedRatio - base) : null;

  // sustainable daily budget until monthly reset
  if (quota.monthCode && quota.monthCode.resetAt) {
    const resetMs = new Date(quota.monthCode.resetAt).getTime();
    const daysLeft = Math.max(1, Math.ceil((resetMs - now) / 86400000));
    payload.monthDaysLeft = daysLeft;
    payload.monthSustainablePerDay = Math.max(0, 1 - quota.monthCode.usedRatio) / daysLeft;
  }
  return payload;
}

function buildStatsPayload() {
  const now = Date.now();
  const stats = aggregateWireStats(now);
  return { ...stats, fetchedAt: now };
}

function restartPolling() {
  if (pollTimer) clearInterval(pollTimer);
  const interval = Math.max(0.25, settings.pollMinutes || 1) * 60000;
  pollTimer = setInterval(pollOnce, interval);
}

function createWindow() {
  win = new BrowserWindow({
    width: Math.round(340 * settings.scale),
    height: Math.round(200 * settings.scale),
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#00000000',
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
    applyWindowSettings();
    applyScale();
    pollOnce();
  });
  win.on('closed', () => { win = null; });
}

function createTray() {
  // 16x16-ish empty template; text tray icons need a native build, keep simple
  const img = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAWElEQVR4nGNgGAWDHjAyMDAw/P//nxGXAkZGxv+45BhwaUZXhE0jIz5T8LmMEZ8p+ACG5v///zPCTIYBmDg2m9A1o2vCsBlZM7omDM3ImnBpQtE8CgY9AACJZBzt4B3quAAAAABJRU5ErkJggg=='
  );
  tray = new Tray(img);
  tray.setToolTip('Kimi Usage Widget');
  tray.on('click', () => (win.isVisible() ? win.hide() : win.show()));
  updateTrayMenu();
}

// rebuilt on every settings change so checkbox states never go stale
function updateTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: 'Show / Hide', click: () => (win.isVisible() ? win.hide() : win.show()) },
    { label: 'Refresh now', click: pollOnce },
    { type: 'separator' },
    {
      label: 'Always on top', type: 'checkbox', checked: !!settings.alwaysOnTop,
      click: (i) => { settings.alwaysOnTop = i.checked; saveSettings(); applyWindowSettings(); send('settings', settings); updateTrayMenu(); },
    },
    {
      label: 'Launch at Windows login', type: 'checkbox', checked: !!settings.autostart,
      click: (i) => { settings.autostart = i.checked; saveSettings(); setAutostart(i.checked); send('settings', settings); updateTrayMenu(); },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

// ---------------- IPC ----------------
ipcMain.handle('get-initial', () => ({ settings, quota: buildPayload(lastQuota || { ok: false, message: 'Not fetched yet' }) }));
ipcMain.handle('get-stats', () => buildStatsPayload());
ipcMain.handle('refresh', () => pollOnce());
ipcMain.handle('set-setting', (_e, key, value) => {
  if (!Object.hasOwn(DEFAULT_SETTINGS, key)) return settings;
  if (SETTING_CLAMPS[key]) {
    const [lo, hi] = SETTING_CLAMPS[key];
    const n = Number(value);
    if (!Number.isFinite(n)) return settings; // reject garbage, keep old value
    settings[key] = Math.min(hi, Math.max(lo, key === 'fontSize' || key === 'pollMinutes' ? Math.round(n) : n));
  } else if (typeof DEFAULT_SETTINGS[key] === 'boolean') {
    if (typeof value !== 'boolean') return settings;
    settings[key] = value;
  } else {
    if (value !== 'dark' && value !== 'light') return settings;
    settings[key] = value;
  }
  saveSettings();
  applyWindowSettings();
  if (key === 'scale') applyScale();
  if (key === 'pollMinutes') restartPolling();
  if (key === 'autostart') setAutostart(!!settings.autostart);
  updateTrayMenu();
  return settings;
});
ipcMain.handle('get-settings', () => settings);
// Layout report from the renderer: REAL viewport metrics (innerW/innerH in
// zoomed CSS px), content height, and the scale tag. Main compares needed vs
// real and resizes only what actually mismatches — getSize() can lie on some
// platform paths, the renderer's viewport metrics don't.
ipcMain.on('layout-report', (_e, r) => {
  if (!win || !r) return;
  if (Math.abs((r.scale || 1) - settings.scale) > 0.001) return; // stale zoom, fresh report follows
  const scale = settings.scale || 1;
  const realW = Math.round(r.innerW * scale);   // viewport DIP (inner*scale)
  const realH = Math.round(r.innerH * scale);
  const needH = Math.max(80, Math.round(r.appH * scale)); // content DIP (appH*scale)
  const [cw, ch] = win.getSize();
  let newW = cw, newH = ch, fix = false;
  if (Math.abs(realW - targetW) > 2 && targetW != null) { newW = targetW; fix = true; }
  if (Math.abs(realH - needH) > 2) { newH = needH; targetH = needH; fix = true; }
  if (fix) {
    setSizeVerified(newW, newH);
  }
});
ipcMain.on('window-width', (_e, w) => {
  if (win) {
    const [, h] = win.getSize();
    win.setSize(Math.max(220, Math.round(w)), h);
  }
});
ipcMain.on('window-hide', () => win && win.hide());
ipcMain.on('window-quit', () => app.quit());

app.whenReady().then(() => {
  settingsFile = path.join(app.getPath('userData'), 'settings.json');
  loadSettings();
  // autostart state is owned by the startup-folder shortcut: if the user
  // removed it manually, reflect that instead of resurrecting it
  settings.autostart = autostartEnabled();
  history = new QuotaHistory(path.join(app.getPath('userData'), 'quota-history.json'));
  createWindow();
  createTray();
  restartPolling();
  startReconcileLoop();
});

app.on('window-all-closed', () => { /* keep running in tray */ });
