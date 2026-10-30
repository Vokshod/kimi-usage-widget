# Project notes — Kimi Usage Widget

Dev-facing knowledge that took real debugging to acquire. **Do not "simplify" any of the items in the Platform quirks section** — each one exists because a naive implementation demonstrably broke.

## The Kimi Code local usage API

- Endpoint: `GET {origin}/api/v1/oauth/usage` where `{origin}` comes from `~/.kimi-code/server/rc.json` (`local_origin`, e.g. `http://127.0.0.1:23125`). Re-read **every** poll — the desktop app restart changes port/nonce.
- Auth: `Authorization: Bearer <~/.kimi-code/server.token>` (43-byte token, re-read every poll).
- Response shape (verified 2026-10-30):

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "kind": "ok",
    "quota": {
      "usages": {
        "limit5h":    { "usedRatio": 0.173,  "resetAt": "2026-10-30T20:37:22Z" },
        "monthTotal": { "usedRatio": 0.0667, "resetAt": "2026-11-30T00:00:00Z" },
        "monthCode":  { "usedRatio": 0.065,  "resetAt": "2026-11-30T00:00:00Z" },
        "weekly":     { ... }              // legacy plans only
      },
      "extraUsage": null                    // object when Extra Usage enabled
    }
  }
}
```

- Non-`code:0` / malformed shapes must be treated as errors, never trusted field-by-field (the audit hardened this — see `docs/AUDIT-REPORT.md`).
- The route is NOT under `/api/usage` etc. — it is `/api/v1/oauth/usage` (discovered by grepping the desktop app's JS bundle for `"/oauth/usage"` after guessing ~8 wrong paths).

### The 5h window is FIXED, not rolling

Official docs ([membership](https://www.kimi.com/code/docs/en/kimi-code/membership.html), [plan rules](https://www.kimi.com/en/help/membership/membership-update-rules)) say "rolling 5-hour rate window" — but the live API behavior proves a **fixed window** (chained: a new window starts when the previous one ends):

- Over 100s with zero metered requests, `resetAt` crept **1 second** (a sliding window would advance ~100s).
- `resetAt` stays pinned as a future instant; the desktop UI shows "resets in 57m" — a fixed countdown.
- Consequence: nothing refills inside a window. The widget's session line therefore **projects** `usedRatio / elapsedFraction` ("on track to use N% of window"), it does not assume continuous refill.

Empirical method that settled it: two `curl` polls 100s apart while idle, diff `resetAt`. (Note: `/oauth/usage` curls themselves are not metered; agent model calls are.)

## Platform quirks (Windows 10/11 + Electron 33, verified empirically)

1. **Never call `win.setResizable()` at runtime.** Going `resizable=false` makes Chromium pin min=max to the current size (`HWNDMessageHandler::SetMinMaxSizeToCurrent`) — the window is frozen forever after. The resize ladder must not include it.
2. **`win.getSize()` can echo fiction** — it may return the just-requested size even when Windows silently didn't apply the resize. All layout truth must come from renderer-reported `window.innerWidth/innerHeight` (the `layout-report` IPC). Read-back verification with `getSize()` alone false-positives.
3. **Zoom accounting**: the widget uses `webContents.setZoomFactor(scale)`. Then: `viewport_DIP = innerWidth × scale` and `content_DIP = appH_getBoundingClientRect × scale` (both multiply — getBoundingClientRect and innerHeight are in the same zoomed CSS units; a ÷ anywhere is a bug that only shows at scale ≠ 1).
4. **Silent resize refusals**: shrinking resizes are sometimes ignored by the platform. `setSizeVerified()` escalates `setBounds → setSize → setContentSize → hide/setSize/show`. `setBounds` is first because plain `setSize` is the most likely to be ignored.
5. **The renderer heartbeat is load-bearing**: a `setInterval(reportHeight, 2000)` must keep firing layout reports — the ResizeObserver stays silent when layout is static, and without the heartbeat a platform-ignored resize never heals (this exact bug left the window cropped forever after a drag storm).
6. **Stale-zoom protection**: every layout report carries the scale it was measured at; main drops reports whose tag ≠ its current `settings.scale` (a measurement at the old zoom divided by the new scale computed a wrong height and cropped the window).
7. **Multiple rapid scale drags** create transient over-tall/short states; they converge within ~1–2s once the heartbeat exists. Don't chase sub-second convergence.
8. Windows background launches must be hidden (`Start-Process -WindowStyle Hidden` or the VBS wrapper) — never a visible console (user rule, config-wide).

## Windows autostart

- Implemented as a startup-folder shortcut (`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Kimi Usage Widget.lnk`) → `wscript.exe "…\Kimi Usage Widget.vbs"` → launches electron hidden. Created/removed via PowerShell `WScript.Shell` COM from the Electron main process.
- Boot reconcile: `settings.autostart` is overwritten from shortcut existence at startup — if the user deletes the shortcut manually, the option shows off instead of resurrecting itself.

## Network/install traps on this machine

- GitHub/npm CDNs for the Electron binary are throttled (~110 KB/s per connection, and Node `fetch` intermittently hits the broken-IPv6 trap). `.npmrc` pins `electron_mirror=https://npmmirror.com/mirrors/electron/`; `fetch-electron.sh` is the manual fallback (8 parallel `curl -4` range requests, then unzip into `node_modules/electron/dist` + write `path.txt` containing `electron.exe`).
- `npm install` with `ELECTRON_SKIP_BINARY_DOWNLOAD=1` lays down everything except the binary in ~40s.
- If an `npm install` is killed mid-run, orphaned `node install.js` / npm processes keep file locks on `node_modules` — find them via `Get-CimInstance Win32_Process | Where CommandLine -match 'install'` and kill before cleaning.

## Verification toolkit

- `node test-data.js` — exercises `src/quota.js` (live API), `src/wirestats.js` (real logs), `src/history.js` (round-trip + interpolation) without Electron.
- `node cdp-verify-settings.js <port>` — 19 assertions simulating real slider drags/checkbox clicks over the Chrome DevTools protocol; launches the widget with `--remote-debugging-port`.
- `node cdp-shot.js <port>` — dumps widget DOM state + captures collapsed/expanded/settings screenshots.
- Run instances hidden; kill via `Get-Process electron | Where-Object { $_.Path -like '*KimiUsageWidget*' } | Stop-Process -Force`.

## Runtime data locations

- Settings + quota history: `%APPDATA%\kimi-usage-widget\` (`settings.json`, `quota-history.json`). Never commit these (they contain device-specific state).
- Data sources (read-only): `~/.kimi-code/server/rc.json`, `~/.kimi-code/server.token`, `~/.kimi-code/sessions/**/wire.jsonl`.
