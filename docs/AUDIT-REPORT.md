# Audit report — 2026-10-30

Full-codebase audit performed by a subagent after the initial build + settings-verification rounds. Eight issues found and fixed; all fixes verified with `node --check`, `node test-data.js`, and the 19-check CDP settings suite (19 passed, 0 failed), plus focused live-renderer assertions (`{"xssSafe":true,"zeroBudget":true}`).

## Fixes (by severity)

1. **Refresh race / unhandled rejection** — `main.js` (`pollOnce`). Concurrent manual + timer refreshes could interleave: an older, slower response could overwrite newer quota/history, and an async throw could escape as an unhandled rejection. Polling is now serialized through a single in-flight promise with a try/catch/finally guard.
2. **Unsafe persisted settings and IPC values** — `main.js` (`loadSettings`, `set-setting`). A corrupt/legacy `settings.json` could produce an invalid zoom factor or a near-zero poll interval at startup; the IPC handler accepted inherited object keys and wrong value types. Added startup normalization, `Object.hasOwn` key checks, and boolean/theme value validation.
3. **HTML injection from model names** — `renderer/app.js` (model stats list). Model strings from wire logs were interpolated into `innerHTML` (XSS vector via crafted log content). Replaced with DOM node construction, `textContent`, and safe attribute assignment.
4. **Malformed token aggregation** — `src/wirestats.js`. String or negative token fields could concatenate into totals or poison sums; a model literally named `__proto__` mutated the result object. Only finite positive numbers are summed now, and the result object is null-prototype.
5. **DST day-bucket drift** — `src/wirestats.js` (`localDayStartMs`, week bucketing). Subtracting fixed 24-hour periods produced non-midnight bucket keys around DST transitions, silently dropping events from daily totals. Switched to local-calendar date arithmetic.
6. **Malformed quota fields** — `src/quota.js`, `renderer/app.js`. Invalid `usedRatio`/missing `resetAt` values produced `NaN` percentages and `Invalid Date` countdowns in the UI. Usage fields are normalized at fetch time; reset rendering is guarded with `Number.isFinite`.
7. **Exhausted monthly budget** — `main.js`, `renderer/app.js`. At ≥100% monthly usage the sustainable-per-day calc went negative and the over/under-budget ratio became `Infinity×`. Budget clamps to zero; exhaustion renders as "over budget" instead of a nonsense number.
8. **Exact-midnight history sample** — `src/history.js` (`valueAt`). A sample timestamped exactly at the midnight boundary was treated as "no sample before midnight" and returned unknown. It now returns that sample directly.

## Areas checked and found clean

- Preload/main/renderer IPC channel contracts (renames would break silently — verified one-to-one).
- Missing Kimi Code installation: no token / no rc.json / server unreachable all surface user-readable error states.
- Malformed `wire.jsonl` lines: skipped per-line without aborting the scan.
- CSP present in `index.html`; no external resources; no `nodeIntegration`.
- Timer/listener lifecycle: poll timer restarted cleanly on interval change; no accumulating listeners.
- The seven protected platform behaviors (see `docs/PROJECT-NOTES.md`) were left intact.

## Verification evidence

- `node --check` passed on all five changed files.
- `node test-data.js`: live quota parsed; 23 wire files scanned in ~230ms; history round-trip + interpolation passed.
- CDP settings suite: **19 passed, 0 failed**.
- Widget relaunched clean via `Kimi Usage Widget.vbs` after testing.

---

# Audit round 2 — 2026-11-02

Second full-codebase audit (subagent) after the autostart / slim-vertical / cloud-source feature rounds. Twelve findings: nine fixed, two bounded/accepted, one test-only fix.

## Fixed

1. **Unbounded wire-log read** — `src/wirestats.js`. A multi-GB `wire.jsonl` was read whole on every stats refresh. Reads are now capped to a 16 MB tail per file (logs are append-only; recent `usage.record` events live at the end).
2. **apiToken switch race** — `main.js`. A slow cloud response could land after the token was cleared/changed and overwrite fresh local quota. Responses carry a source generation counter; stale generations are discarded, and a token change resets the last-known quota and re-polls.
3. **Cloud reset_time / NaN ratios** — `src/quota.js`. Missing or non-numeric cloud `reset_time`/usage fields produced `NaN` ratios and `Invalid Date` resets. Normalized through shared `toRatio`/`validResetAt` helpers with finite guards in `buildFromQuota`.
4. **Non-atomic writes** — `main.js`, `src/history.js`. A crash mid-write could leave a truncated `settings.json` / `quota-history.json`. Both now write temp-then-rename.
5. **Unvalidated history load** — `src/history.js`. Corrupt or wrongly-typed persisted samples could break interpolation. Samples are finite-checked, ratios coerced via `toFiniteOrNull`, and sorted by timestamp on load.
6. **Tray crash when window is null** — `main.js`. Tray click / Show-Hide menu assumed a live window and could throw after the window was closed. Centralized `toggleWindow()` guard; window is recreated on demand.
7. **Stale renderer sections** — `renderer/app.js`. Switching quota sources could leave the previous source's session/monthly rows on screen. Missing sections are now explicitly cleared.
8. **Corrupt instance file aborts port scan** — `main.js`. One malformed Kimi Code desktop-instance JSON stopped discovery of the real instance. Per-file try/continue with host/port validation.
9. **Sub-row clipping at max font** — `renderer/styles.css`. `white-space: nowrap` on `.sub` cropped the wrap-allowed daily line at fontSize 18. Nowrap removed; frameless window height self-heals.

## Test-only fix

10. **`test-data.js` had no assertions** — rewrote as a real check suite: hard assertions for wire stats (7 sorted local-midnight buckets, no `__proto__` pollution) and history (2-sample round-trip, midnight-baseline interpolation to 1e-9); live API checks stay warn-only (machine may legitimately fail them) but assert ratio finiteness when the fetch succeeds. CDP suite gained 3 assertions (sub-row no-clip at font 18, threshold pair-clamp both directions) → **35 assertions**.

## Bounded / accepted (no code change)

11. **wirestats reads whole lines even when capped** — a single >16 MB line would still be one buffer; accepted, tail cap covers realistic logs.
12. **No single-instance lock** — launching the widget twice runs two instances; accepted (startup-folder + manual launch double-run is rare, and a lock complicates the CDP debug workflow).

## Verification evidence

- `node --check` clean on all eight JS files.
- `node test-data.js`: **9 passed, 0 failed** (local quota 5h 65.4% / month 20.0%; 38 wire files in ~350 ms; history interpolation exact).
- CDP settings suite: **35 passed, 0 failed** (one initial failure was a test-restore-order artifact of the new pair clamp, not a product bug — the suite now restores danger-before-warn).
- User settings restored (scale 1.1, font 15, opacity 1, vertical on, thresholds 0.75/0.9); widget relaunched clean via `Kimi Usage Widget.vbs` — exactly one main process.
