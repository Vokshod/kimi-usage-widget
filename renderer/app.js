'use strict';

const $ = (id) => document.getElementById(id);
const app = $('app');

let settings = null;
let expanded = false;
let settingsOpen = false;
let statsCache = null;
let lastQuota = null; // cached so threshold changes can repaint bars immediately

// ---------- formatting ----------
function fmtPct(r) { return r == null ? '–' : `${(r * 100).toFixed(r < 0.1 ? 1 : 0)}%`; }

function fmtCountdown(ms) {
  if (ms == null || isNaN(ms)) return '';
  let m = Math.max(0, Math.round(ms / 60000));
  const d = Math.floor(m / 1440);
  m -= d * 1440;
  const h = Math.floor(m / 60);
  m -= h * 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtTokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function fmtResetDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

function shortModel(name) {
  return (name || 'unknown').split('/').pop();
}

// ---------- rendering ----------
function isWide() {
  return !settings.vertical || expanded || settingsOpen;
}

function setFill(el, ratio) {
  const pct = `${Math.min(100, ratio * 100)}%`;
  if (settings.vertical) {
    el.style.width = '100%';
    el.style.height = pct; // vertical bar fills bottom-up
  } else {
    el.style.height = '100%';
    el.style.width = pct;
  }
}
function barClass(ratio) {
  if (ratio == null) return 'fill';
  if (ratio >= settings.dangerAt) return 'fill danger';
  if (ratio >= settings.warnAt) return 'fill warn';
  return 'fill';
}

function renderQuota(p) {
  lastQuota = p;
  const err = $('error');
  // p.stale: refresh failed transiently (upstream blip) but last-good quota is
  // served — deliberately silent, it self-heals next poll and isn't worth a banner
  if (!p.ok && !p.stale) {
    err.textContent = p.error || 'Unknown error';
    err.className = 'error';
    err.classList.remove('hidden');
    return;
  }
  err.classList.add('hidden');
  $('src-badge').classList.toggle('hidden', p.source !== 'api');

  const now = Date.now();

  // session (5h window)
  if (p.limit5h) {
    const r = p.limit5h.usedRatio;
    const fill = $('sess-fill');
    setFill(fill, r);
    fill.className = barClass(r);
    $('sess-pct').textContent = fmtPct(r);
    const resetMs = p.limit5h.resetAt ? new Date(p.limit5h.resetAt).getTime() - now : NaN;
    $('sess-reset').textContent = Number.isFinite(resetMs) ? 'resets in ' + fmtCountdown(resetMs) : '';
    const paceEl = $('sess-pace');
    if (!Number.isFinite(resetMs)) {
      paceEl.textContent = '';
    } else {
      // projection: the 5h window is FIXED (verified against the live API —
      // resetAt stays pinned between requests, usage only resets at the boundary),
      // so at the current average burn rate, what % of the window is consumed by reset?
      const WINDOW_MS = 5 * 3600000;
      const elapsed = Math.min(1, Math.max(0.02, 1 - resetMs / WINDOW_MS));
      const projected = r / elapsed; // 1.0 = exactly 100% consumed at reset
      const projPct = Math.round(projected * 100);
      if (projected <= 0.85) {
        paceEl.innerHTML = `<span class="ok">pace ok</span> · on track to use ${projPct}% of window`;
      } else if (projected <= 1.0) {
        paceEl.innerHTML = `<span class="hot">tight</span> · ~${projPct}% of window by reset`;
      } else {
        paceEl.innerHTML = `<span class="hot">over pace</span> · would hit ${projPct}% before reset`;
      }
    }
  }

  // monthly
  if (p.monthCode) {
    const r = p.monthCode.usedRatio;
    const fill = $('month-fill');
    setFill(fill, r);
    fill.className = barClass(r);
    $('month-pct').textContent = fmtPct(r);
    const resetMs = p.monthCode.resetAt ? new Date(p.monthCode.resetAt).getTime() - now : NaN;
    $('month-reset').textContent = Number.isFinite(resetMs)
      ? `${fmtResetDate(p.monthCode.resetAt)} · in ${fmtCountdown(resetMs)}` : '';

    const parts = [];
    if (p.monthConsumedToday != null) {
      parts.push(`today +${(p.monthConsumedToday * 100).toFixed(2)}%`);
    } else {
      parts.push('today n/a (collecting)');
    }
    if (p.monthSustainablePerDay != null) {
      parts.push(`budget ${(p.monthSustainablePerDay * 100).toFixed(1)}%/day`);
      if (p.monthConsumedToday > 0 && p.monthSustainablePerDay <= 0) {
        parts.push('<span class="hot">over budget</span>');
      } else if (p.monthConsumedToday != null && p.monthSustainablePerDay > 0) {
        const ratio = p.monthConsumedToday / p.monthSustainablePerDay;
        if (ratio > 1.25) parts.push(`<span class="hot">${ratio.toFixed(1)}× over budget</span>`);
        else if (ratio < 0.75) parts.push(`<span class="ok">under budget</span>`);
      }
    }
    if (p.monthDaysLeft != null) parts.push(`${p.monthDaysLeft}d left`);
    $('month-daily').innerHTML = parts.join(' · ');
  }

  // extra usage
  const eu = $('extra-usage');
  if (p.extraUsage && typeof p.extraUsage === 'object') {
    const txt = Object.entries(p.extraUsage)
      .map(([k, v]) => `${k}: ${typeof v === 'number' ? v : JSON.stringify(v)}`)
      .join(' · ');
    eu.textContent = `Extra usage — ${txt}`;
    eu.classList.remove('hidden');
  } else {
    eu.classList.add('hidden');
  }
}

function renderStats(s) {
  statsCache = s;
  const list = $('model-list');
  list.innerHTML = '';
  const entries = Object.entries(s.models || {});
  if (entries.length === 0) {
    list.innerHTML = '<div class="mrow"><span class="mname">no usage recorded (yet)</span></div>';
  }
  for (const [model, m] of entries) {
    const row = document.createElement('div');
    row.className = 'mrow';
    const name = document.createElement('span');
    name.className = 'mname';
    name.title = model;
    name.textContent = shortModel(model);
    const nums = document.createElement('span');
    nums.className = 'mnums';
    const today = document.createElement('b');
    today.textContent = fmtTokens(m.today);
    nums.append(today, ` today · ${fmtTokens(m.last7d)} 7d · ${m.requests} req`);
    row.append(name, nums);
    list.appendChild(row);
  }

  // 7-day per-day token chart
  const chart = $('week-chart');
  chart.innerHTML = '';
  const days = s.daily || [];
  const max = Math.max(1, ...days.map((d) => d.totalTokens));
  const todayStart = s.todayStart;
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (const d of days) {
    const col = document.createElement('div');
    col.className = 'wcol';
    const h = Math.max(3, (d.totalTokens / max) * 40);
    const label = DAY_NAMES[new Date(d.dayStartMs).getDay()];
    col.innerHTML = `<div class="wbar${d.dayStartMs === todayStart ? ' today' : ''}" style="height:${h}px" title="${fmtTokens(d.totalTokens)} tokens"></div>
      <div class="wday">${label}</div>`;
    chart.appendChild(col);
  }
}

// ---------- layout: report content height so main can resize window ----------
// rAF-throttled and change-only: during zoom transitions the ResizeObserver
// fires continuously, and each report triggers a main-process resize.
let heightPending = false;
let lastReportedHeight = 0;
let lastReportAt = 0;
function reportHeight() {
  if (heightPending) return;
  heightPending = true;
  requestAnimationFrame(() => {
    heightPending = false;
    const h = Math.ceil(app.getBoundingClientRect().height);
    const now = Date.now();
    // change-only, but always heartbeat every 2s so main can heal
    // platform-ignored resizes even when layout doesn't change
    if (Math.abs(h - lastReportedHeight) < 2 && now - lastReportAt < 2000) return;
    lastReportedHeight = h;
    lastReportAt = now;
    app.classList.toggle('wide', isWide()); // slim-mode header depends on it
    window.widget.setHeight(h, settings.scale || 1, isWide());
  });
}

// ---------- settings ----------
function applySettingsToUI() {
  document.documentElement.style.setProperty('--font-size', settings.fontSize + 'px');
  app.classList.toggle('compact', !!settings.compact);
  app.classList.toggle('vertical', !!settings.vertical);
  app.classList.toggle('theme-light', settings.theme === 'light');
  app.classList.toggle('theme-dark', settings.theme !== 'light');
  $('set-scale').value = settings.scale;
  $('set-scale-v').textContent = Math.round(settings.scale * 100) + '%';
  $('set-font').value = settings.fontSize;
  $('set-font-v').textContent = settings.fontSize + 'px';
  $('set-opacity').value = settings.opacity;
  $('set-opacity-v').textContent = Math.round(settings.opacity * 100) + '%';
  $('set-aot').checked = !!settings.alwaysOnTop;
  $('set-autostart').checked = !!settings.autostart;
  $('set-compact').checked = !!settings.compact;
  $('set-vertical').checked = !!settings.vertical;
  $('set-theme').checked = settings.theme === 'light';
  $('set-warn').value = settings.warnAt;
  $('set-danger').value = settings.dangerAt;
  $('set-poll').value = settings.pollMinutes;
  // only write back when different — re-assigning .value on every keystroke
  // would move the caret in the token field
  if ($('set-apitoken').value !== (settings.apiToken || '')) {
    $('set-apitoken').value = settings.apiToken || '';
  }
}

async function bindSetting(id, key, parse) {
  const el = $(id);
  el.addEventListener('input', async () => {
    const raw = el.type === 'checkbox' ? el.checked : el.value;
    const val = parse ? parse(raw) : raw;
    settings = await window.widget.setSetting(key, val);
    applySettingsToUI();
    if (lastQuota) renderQuota(lastQuota); // thresholds/theme changes repaint bars now
    reportHeight();
  });
}

// ---------- events ----------
$('btn-refresh').addEventListener('click', () => window.widget.refresh());
$('btn-hide').addEventListener('click', () => window.widget.hide());
$('btn-expand').addEventListener('click', async () => {
  expanded = !expanded;
  $('details').classList.toggle('hidden', !expanded);
  $('btn-expand').innerHTML = expanded ? '&#9652;' : '&#9662;';
  if (expanded && !statsCache) {
    renderStats(await window.widget.getStats());
  } else if (expanded) {
    renderStats(statsCache);
  }
  reportHeight();
});
$('btn-settings').addEventListener('click', () => {
  settingsOpen = !settingsOpen;
  $('settings-panel').classList.toggle('hidden', !settingsOpen);
  reportHeight();
});

bindSetting('set-scale', 'scale', Number);
bindSetting('set-font', 'fontSize', Number);
bindSetting('set-opacity', 'opacity', Number);
bindSetting('set-aot', 'alwaysOnTop');
bindSetting('set-autostart', 'autostart');
bindSetting('set-compact', 'compact');
bindSetting('set-vertical', 'vertical');
bindSetting('set-theme', 'theme', (checked) => (checked ? 'light' : 'dark'));
bindSetting('set-warn', 'warnAt', Number);
bindSetting('set-danger', 'dangerAt', Number);
bindSetting('set-poll', 'pollMinutes', Number);
bindSetting('set-apitoken', 'apiToken');

// ---------- boot ----------
(async () => {
  const initial = await window.widget.getInitial();
  settings = initial.settings;
  expanded = false;
  applySettingsToUI();
  renderQuota(initial.quota);
  window.widget.onQuota((p) => { renderQuota(p); });
  window.widget.onSettings((s) => { settings = s; applySettingsToUI(); });
  // auto-refresh model stats while expanded, every 60s
  setInterval(() => { if (expanded) window.widget.getStats().then(renderStats); }, 60000);
  requestAnimationFrame(reportHeight);
  new ResizeObserver(reportHeight).observe(app);
  // true heartbeat: RO stays silent when layout is static, but the window may
  // still mismatch the content (platform-ignored resize) — keep reporting
  setInterval(reportHeight, 2000);
})();
