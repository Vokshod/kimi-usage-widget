# Project notes — Kimi Usage Widget

Dev-facing knowledge that took real debugging to acquire. **Do not "simplify" any of the items in the Platform quirks section** — each one exists because a naive implementation demonstrably broke.

## The Kimi Code local usage API

- Endpoint: `GET {origin}/api/v1/oauth/usage` where `{origin}` comes from the desktop app's server registry — **app >= 2.4.0 (2026-11-01): `~/.kimi-code/server/instances/<server_id>.json` files** shaped `{"host","port","pid","heartbeat_at","host_version"}`; pick the freshest `heartbeat_at` (stale files linger after restarts). Older apps: `~/.kimi-code/server/rc.json` `local_origin`. Re-read **every** poll — restarts change port/server_id.
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
- **Transient upstream failures hide inside HTTP 200** (verified 2026-10-31): when the local server's OWN upstream fetch fails (frequent on this network — up to ~50% of polls in bursts), it still answers `code:0` but with `data: {"kind":"error","message":"Failed to fetch usage: fetch failed"}` and no `quota`. The widget treats this as reason `upstream` and serves the last good quota for up to 10 min (`STALE_MS`, stale-while-revalidate) **silently** — no banner, it self-heals. Red error only for real failures: unreachable, auth, or nothing fresh for 10+ min. Do NOT add a visible warning for the transient case; it just flickers.
- The route is NOT under `/api/usage` etc. — it is `/api/v1/oauth/usage` (discovered by grepping the desktop app's JS bundle for `"/oauth/usage"` after guessing ~8 wrong paths).

### Cloud source — API key (alternative to the local server)

Set an API token in the widget settings (from the [Kimi Code Console](https://www.kimi.com/code/docs/en/) → API Keys, up to 5 per account) and usage is read **directly from Kimi's cloud** — works even when the desktop app is closed. Endpoint recovered from the desktop app's own bundle (the CLI `/usage` calls the same URL; not documented publicly):

- `GET https://api.kimi.com/coding/v1/usages` (fallback on network/404: `https://api.kimi.ai/coding/v1/usages`), headers `Authorization: Bearer <key>`, `Accept: application/json`, 8s timeout.
- Response shape (snake_case, normalized by `fetchQuotaCloud` in `src/quota.js`): `{ usages: { limit_5h, limit_7d, limit_month_total, limit_month_code: { used_ratio, reset_time } }, boosterWallet: { balanceCents, totalCents, monthlyChargeLimitEnabled, monthlyChargeLimitCents, monthlyUsedCents, currency } }`. `used_ratio` may be a number OR numeric string; `reset_time` may be absent.
- Errors: 401/403 → key rejected (response body `error.message` is shown); 404 → that region's host lacks the endpoint, try the other.
- Both hosts answer from a Russian IP (verified 2026-11-02) — no VPN needed. The OAuth `server.token` does NOT work as an API key (401).
- **Cloud `limit_5h.resetAt` can be a PAST instant** when the current window has expired but no new request has started the next one (observed 2026-11-02: ~11h in the past). The widget handles it: `elapsed` clamps to 1, so projected == usedRatio ("on track to use N%"). The local source always reported a future `resetAt` — a cloud-source quirk, not a bug.
- Token is stored in `%APPDATA%\kimi-usage-widget\settings.json` (local only, never committed); empty string = back to the local desktop-app source. An "API" badge in the widget header shows which source is active.

### The 5h window is FIXED, not rolling

Official docs ([membership](https://www.kimi.com/code/docs/en/kimi-code/membership.html), [plan rules](https://www.kimi.com/en/help/membership/membership-update-rules)) say "rolling 5-hour rate window" — but the live API behavior proves a **fixed window** (chained: a new window starts when the previous one ends):

- Over 100s with zero metered requests, `resetAt` crept **1 second** (a sliding window would advance ~100s).
- `resetAt` stays pinned as a future instant; the desktop UI shows "resets in 57m" — a fixed countdown.
- Consequence: nothing refills inside a window. The widget's session line therefore **projects** `usedRatio / elapsedFraction` ("on track to use N% of window"), it does not assume continuous refill.

Empirical method that settled it: two `curl` polls 100s apart while idle, diff `resetAt`. (Note: `/oauth/usage` curls themselves are not metered; agent model calls are.)

## Monthly budget & pacing math (verified correct 2026-10-31)

Formulas in `main.js buildFromQuota` / `app.js renderQuota`, cross-checked against live API + real history samples:

- **Budget/day** = `(1 − monthCode.usedRatio) / ceil((resetAt − now)/24h)`. The `ceil` is deliberate: a partial final day counts as a full day, so the budget spreads over remaining local calendar dates including today — apples-to-apples with per-calendar-day consumption. Conservative by up to ~1 day (up to 2× in the last hours); do not "fix" to fractional days.
- **Consumed today** = current `usedRatio` − ratio linearly interpolated at local midnight from 1-min history samples. Verified live: midnight baseline 8.78%, current 10.99% → +2.21%.
- **Pace verdict** = today ÷ budget/day; `under budget` < 0.75×, `X× over budget` > 1.25×.
- **Known edge**: on monthly-reset day, `today` clamps to +0.00% (`Math.max(0, …)` — pre-reset baseline exceeds the fresh ratio). Harmless by design.
- Budgeting uses `monthCode` only, ignoring `monthTotal`/`extraUsage`; once `monthCode` is exhausted the line shows "over budget" even if Extra Usage covers spend (no extraUsage data seen in the wild yet — `null` as of 2026-10-31).

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
- `node cdp-verify-settings.js <port>` — 35 assertions simulating real slider drags/checkbox clicks over the Chrome DevTools protocol; launches the widget with `--remote-debugging-port`.
- **CDP verification dirties the REAL settings**: the debug instance uses the same `%APPDATA%\kimi-usage-widget\settings.json` as the user's widget, and the suite leaves it at last-dragged extremes (seen: scale 1.6 / font 18 / opacity 0.2). After every verification run, restore the user's preferred defaults (scale 1.1, fontSize 15, opacity 1.0) in settings.json BEFORE relaunching clean.
- `node cdp-shot.js <port>` — dumps widget DOM state + captures collapsed/expanded/settings screenshots.
- Run instances hidden; kill via `Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(electron|Kimi)' -and $_.CommandLine -match 'KimiUsageWidget' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }` — matching on `Get-Process Path` silently kills NOTHING (the Path is the Electron binary, not the project dir), leaving duplicate instances that share settings.json and cause "impossible" test failures.

## Runtime data locations

- Settings + quota history: `%APPDATA%\kimi-usage-widget\` (`settings.json`, `quota-history.json`). Never commit these (they contain device-specific state).
- Data sources (read-only): `~/.kimi-code/server/rc.json`, `~/.kimi-code/server.token`, `~/.kimi-code/sessions/**/wire.jsonl`.
