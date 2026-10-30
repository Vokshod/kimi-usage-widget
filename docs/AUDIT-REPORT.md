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
