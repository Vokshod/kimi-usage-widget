# Kimi Usage Widget

An always-on-top desktop widget for **Kimi Code** quota: the 5-hour session window, the monthly quota, per-model token stats, and daily-equivalent burn estimates. Inspired by [claude-usage-widget](https://github.com/SlavomirDurej/claude-usage-widget), but for Kimi — with one crucial difference: **no login and no cloud scraping**. All data comes from the Kimi Code desktop app's own local server and session logs on this machine.

![screenshot](docs/screenshot.png)

## Features

- **SESSION · 5h** — usage %, reset countdown, and a projection: at your average burn rate since the window started, what % of the window will you consume by reset (≤85% green, ≤100% amber, >100% red).
- **MONTHLY** — usage %, reset date + countdown, and the daily line: `today +0.42% · budget 3.0%/day · 31d left` with over/under-budget coloring. "Today" is measured against the widget's own history samples at local midnight.
- **▾ Model stats** — per-model tokens (today / 7d / total / request counts) from your session wire logs, plus a 7-day per-day chart.
- **⚙ Settings** — size (true zoom), font, opacity, always-on-top, launch at Windows login, compact mode, light theme, warn/danger thresholds, refresh interval. All persisted.
- System tray: show/hide, refresh, always-on-top, launch at login, quit. `−` minimizes to tray.
- Auto-refresh every minute (configurable), self-healing window layout, desktop notifications of state via tray.

## Running it

Requires [Node.js](https://nodejs.org/) 18+ and the Kimi Code desktop app (logged in) as the data source.

```bash
npm install        # see "Electron binary" below if this stalls
npm start
```

or double-click `Kimi Usage Widget.vbs` (launches hidden, no console), or the desktop shortcut if created.

**Launch at Windows login**: enable in the settings panel or tray menu — it creates a shortcut in the Windows startup folder pointing at the VBS launcher (which starts hidden). Disable removes the shortcut.

## How it works

| Layer | What |
|---|---|
| Live quota | `GET {origin}/api/v1/oauth/usage` on the Kimi Code desktop app's local server (`127.0.0.1:23125`), bearer token from `~/.kimi-code/server.token`, origin/port re-read from `~/.kimi-code/server/rc.json` every poll — survives app restarts. |
| Model stats | `usage.record` events in `~/.kimi-code/sessions/**/wire.jsonl` aggregated per model, bucketed by local day. |
| Consumed-today | The widget samples quota ratios every poll into `quota-history.json` (userData) and interpolates the value at local midnight. |

Nothing leaves the machine.

## Project layout

```
main.js               Electron main: window, tray, polling, settings, resize engine, autostart
preload.js            contextBridge IPC surface
renderer/             UI (plain HTML/CSS/JS, no framework)
src/quota.js          local usage API fetcher (pure Node, testable)
src/wirestats.js      wire-log aggregation (pure Node)
src/history.js        quota ratio history + midnight baseline (pure Node)
test-data.js          smoke test for the three src modules
cdp-verify-settings.js  19-check settings verification over DevTools protocol
cdp-shot.js           DOM dump + screenshots over DevTools protocol
fetch-electron.sh     parallel-range Electron binary downloader (mirror fallback)
Kimi Usage Widget.vbs hidden launcher (no console window)
```

## Verifying changes

```bash
node test-data.js                 # data modules against live data
# full UI/settings suite (widget must run with a debug port):
powershell -Command "Start-Process -WindowStyle Hidden -WorkingDirectory . -FilePath 'node_modules\electron\dist\electron.exe' -ArgumentList '.','--remote-debugging-port=9226'"
node cdp-verify-settings.js 9226  # expect: 19 passed, 0 failed
```

## Troubleshooting

- **"Kimi Code desktop app is not running"** — start the Kimi Code app and log in; the widget picks it up within a poll interval.
- **"Usage API rejected the token"** — re-login in Kimi Code (the local token rotates).
- **npm install stalls on the Electron binary** — GitHub's CDN is throttled on some networks. The project pins `electron_mirror` in `.npmrc` (npmmirror); if it still stalls, run `bash fetch-electron.sh` (downloads the binary zip with parallel range requests and unpacks it into `node_modules/electron/dist` exactly where the installer would).

## License

MIT.
