# Changelog

## Unreleased

### 3.2.2

- Remove successfully received empty remote files from the manifest, cache and
  JSON export, using the existing exclusion policy for ordinary file HTTP 403.
  Keep the diagnostic reason but omit excluded links from retry and repair.
- Retain incomplete nonzero-length and empty partial responses for retry;
  preserve existing local files when an empty replacement is rejected.
- Cover empty response variants, cache reload, exports, local preservation and
  retry behavior in regression and browser acceptance tests.

### 3.2.1

- Keep a common tuning metric through each baseline/trial/confirmation so
  completion-count thresholds do not reject genuine small-file scaling.
- Restore the accepted worker count before invalidating a trial on retries,
  failures or resume; preserve the user's manual preference.
- Normalize fractional-rate noise correctly and gather up to six windows for
  sparse small-file completions, using their aggregate rate.
- Continue downward exploration after a confirmed reduction and back off
  unsuccessful probes, with a five-minute maximum hold.
- Add regressions for sparse completions, production error callbacks, downward
  trials, plateau overhead and mixed-size queues. In deterministic 300-file
  latency scenarios, completion time improves from 585.3 to 357.9 seconds and
  from 2233.413 to 1442.408 seconds; these are simulations, not live-site claims.

### 3.2.0

- Replace byte-only hill climbing with bounded, workload-aware probes and a
  return-to-baseline confirmation; use successful small-file completions,
  preserve mixed-workload completion throughput, and rebaseline stale references.
- Keep measurements usable with underfilled workers and background tabs; report
  timer gaps, recovery, draining and queue-tail suspension explicitly.
- Preserve manual preferences across mode switches and recovery. Enter auto
  from the manual limit, capped by the auto maximum, and retain learned state
  when unrelated scan/retry settings change.
- Wake the scheduler at the next permitted launch deadline, avoiding an extra
  200 ms idle delay for short jobs while preserving request pacing.
- Add deterministic algorithm and actual-pool simulations plus integration and
  browser checks for live mode switches, pause, background tabs and recovery.

## 3.1.9

- Move test runners to `tests/` and screenshots to ignored `artifacts/`; remove
  the internal development plan and old local generated results.
- Keep helper query-stripping fixtures inside the mocked browser route instead
  of following an HTTP redirect that could reach the live archive.
- Prepare the public repository with a concise installation guide, MIT license,
  GitHub userscript metadata and automated offline tests.
- Make the denied-link cache regression independent of another worker learning
  its response size after the exclusion checkpoint has already been saved.

- Version 3.1.9: overlay aggregate saved files per second on the speed chart
  using an orange dashed line and an independent labeled zero-based scale.
  Sample the same smoothed completion rate shown by the files/second card;
  retain the blue byte-rate line, shared 180-sample history and thread chart.
- Version 3.1.8: preserve the chosen manual download concurrency during cooldown
  and recovery. The temporary one-worker recovery cap lifts after a successful
  network transfer; errors no longer halve and persist the manual preference.
  Automatic tuning penalties and scan concurrency handling remain unchanged.
- Version 3.1.7: exhausted fetch/body-read retries pause the whole queue and
  retain the current item for bounded automatic recovery through the helper.
  Do not consume untouched files or remove links during a network outage.
  Keep manual pause, disabled recovery, disk-error precedence and the existing
  eight-attempt limit. Report network uncertainty without claiming Cloudflare.
  Scanning uses the same recovery path; partial replacement writes still abort.
- Version 3.1.6: keep recovery helpers connected when COOP severs their
  WindowProxy. Use a persistent authenticated BroadcastChannel for helper
  self-navigation and liveness checks instead of relying on `window.closed`.
  Navigation revisions reject stale readiness; validate command origin, token
  and archive target. Retain direct-window fallback for unpaired helpers.
  Distinguish a missing heartbeat from popup blocking and log refresh failures.
  Keep expired recovery timers from overwriting completed download status.
- Version 3.1.5: reset consecutive recovery attempts after an actual successful
  download or validated directory request following automatic resumption.
  Separate challenges no longer accumulate a session-wide eight-attempt limit
  or five-minute backoff. Helper readiness, local journal skips and jobs finishing
  during a pause do not reset the budget. Repeated failures remain bounded.
  Clarify that a loaded helper page does not confirm access to the file.
- Version 3.1.4: escape Chromium-rejected tilde components consistently in
  download, verification and journal paths (for example `~PV_Contents` becomes
  `%7EPV_Contents`). Preserve remote URLs, distinguish literal percent names,
  and keep already-valid long tilde names unchanged. Explicit archive-directory
  name refusals become item errors; unrelated files continue. Generic directory
  failures and journal failures still pause the queue.
- Version 3.1.3: plain file HTTP 403 removes the denied link from the manifest
  and serialized cache, then continues other downloads without global recovery.
  Export the edited list and retain excluded-error diagnostics; omit denied
  links from retry/repair and preserve local files. Restoring even an empty
  cached manifest does not resurrect removed links. Recognized challenges keep
  their links; directory denials keep scanning incomplete. Cover concurrent
  workers, mixed challenge/denial responses, reload and manual retry behavior.
- Version 3.1.2: include bare HTTP 403 in bounded access recovery without claiming
  it proves Cloudflare. Concurrent bare/confirmed 403 responses no longer cancel
  each other's recovery. Honor Retry-After, attempt limits, manual pause and disk
  failures. Keep started transfers running until completion before resuming.
- Show the download phase instead of preparation during active transfers, update
  the pause badge on failure and report the remaining started files while draining.
  Four new regressions failed before the fix; cover both response orders with four
  workers, actual stream draining and retained-queue continuation.
- Version 3.1.1: detect a closed recovery helper even when the main scheduler is
  idle. Monitor the owned popup once per second and recheck on focus/visibility;
  clear stale readiness/token state, stop monitoring and show a reopen action.
  Refresh shows a loading label. Closure does not overwrite queue status or
  bypass cooldown/manual pause. Cover close/reopen in an actual browser.
- Version 3.1.0: add a collected-manifest editor with path search, numeric size
  sorting (unknown sizes last), 100-row pages, cross-page bulk selection and
  link deletion. Preserve local files/journals and invalidate stale queues and
  verification after edits. Block mutations while operations/recovery are active.
- Save edits and single-batch undo immediately to cache; support cache retry and
  export of edited or empty manifests using both existing and editor JSON buttons.
- Cover cache reloads, filtered selections, paused queues, failed persistence,
  safe filename rendering and real-browser dialog/export behavior.
- Version 3.0.0: redesign the page as a responsive catalog/download workspace.
  Preserve original navigation and sorting; add local catalog search and type
  filtering, independent scrolling, fixed primary actions, a run-state badge,
  separate speed/concurrency cards and grouped list/cache controls.
- Retain all download, selection, verification, journal, cache and recovery
  functions. Override legacy table widths/nowrap and heading padding so long
  filenames fit. Add offline browser layout and keyboard checks at four widths.
- Version 2.1.6: distinguish current and averaged transfer rates, display low
  rates in KiB/s, and expose successful file completions/s. Update both active
  counters on every scheduler tick instead of leaving one stale until sampling.
- Estimate sufficiently sampled, similarly sized small-file queues by successful
  completions including writes/journal commits. Keep conditional byte-based ETA
  for mixed/large queues and identify the method. Exclude journal-skipped files
  from completion-rate sampling; retain unknown-size and failed-item semantics.
- Cover rate formatting, mixed-workload boundaries, partial bytes, streamed
  completion-based ETA and the active-counter mismatch.
- Version 2.1.5: handle an explicit `TypeError: Name is not allowed.` from an
  archive item's file-handle lookup/create as a per-item error. Keep downloading
  other items, retain the rejected path in reports, and explain the browser's
  name/type restriction rather than suggesting free disk space. Do not rename
  rejected files or record them as successfully saved.
- Keep generic filesystem errors and journal name failures as global stops.
  Cover lookup/create, download/repair, verification and journal boundaries.
- Version 2.1.4: keep ETA visible for the working queue when other files have
  failed. Exclude failed items from remaining-byte/unknown-size calculations,
  retain them in overall volume and report their count alongside the estimate.
  Retrying failed items includes them again; a drained queue with errors is not
  labeled complete. Refresh ETA immediately on manual pause.
- Streamed regressions cover known/unknown failed sizes, partial progress,
  pause, drained queues and successful retry. Browser acceptance checks the
  completed-queue-with-errors label.
- Version 2.1.3: accept HTML responses for archived `.php` web resources, including
  `index(1).php`, and apply the same target-specific challenge recovery as HTM.
- Treat invalid individual file content as a recorded item error instead of
  pausing and requeuing it forever. Continue other downloads/repairs automatically;
  retain challenge/access, rate-limit and filesystem stops. Failed responses are
  not written or journaled, and reviewed replacements preserve the original.
- Regressions cover both download and repair, selective retry of failed items,
  PHP challenge recovery and browser repair continuing without another click.
- Version 2.1.2: recover a challenged HTML download at its exact URL rather than
  repeatedly loading an already accessible catalog. Require the expected page
  and full load before signaling readiness; preserve helper context without
  adding query parameters to archived HTML URLs.
- Stop classifying normal JavaScript Detections or article phrases as challenge
  pages. Keep response-header detection and specific interstitial markup checks,
  inspect up to 8 KiB before writing, and log the evidence used for recovery.
- Replace premature restored-access messages with explicit retry status. Cover
  false positives, target-specific readiness and the browser recovery flow.
- Version 2.1.1: connect the challenge link to the recovery helper instead of
  opening an unrelated ordinary tab. Seed per-tab context before navigation so
  redirects removing URL parameters do not turn the helper into a new downloader.
- Add visible helper/connection status and regressions for first-navigation
  redirects, stale contexts, and both recovery entry points. Browser acceptance
  now follows actual HTTP redirects before executing the helper userscript.
- Version 2.1.0: refresh a same-session helper tab after a recognized Cloudflare
  challenge or HTTP 429/503, then resume the preserved queue only after a fully
  loaded directory is confirmed. Detect `cf-mitigated` and challenge HTML.
- Add bounded 30–300 second backoff, Retry-After handling, eight-round budgets,
  popup guidance, a recovery setting and cancellation on manual pause/disk errors.
  Resume with one request; require a user gesture when write permission is lost.
- Cover recovery, spoofed/stale readiness, cancellation races and concurrent
  failures with offline tests, plus real cross-tab navigation in browser fixtures.
- Version 2.0.1: pause and preserve the queue on local filesystem failures during
  repair/download instead of accumulating an error for every remaining file.
  Report the operation, exception name and relative local path, with Windows
  long-path recovery guidance. Keep network retries separate from disk failures.
- Report a file handle lost during verification as a read error, not a missing
  file eligible for automatic repair. Add regressions for directory/file creation,
  writable streams, writes, closes, concurrent failures and queue recovery.
- Version 2.0.0: complete the remaining roadmap with read-only local verification,
  exportable reports, missing/empty-only repair and explicitly reviewed replacements
  guarded by local size/modification-time checks.
- Add searchable paginated folder selection, combined extension/name/size filters,
  unknown-size policy and persistent view preferences in cache and JSON exports.
- Add active file stages/speeds and bounded throughput/concurrency charts.
- Preserve listing dates and one prior snapshot, compare additions/changes/removals,
  select incremental updates, and retain source metadata in completion journals.
  Removed local files are never deleted; metadata matches are not hash verification.
- Add real-browser offline acceptance checks and screenshots alongside regression
  coverage for old manifests/journals and the new combined workflows.
- Version 1.4.0: add configurable automatic retries for transient scan/download
  failures, exponential backoff with jitter, interruptible retry waiting, and
  retry-aware progress/ETA/tuning. Preserve global stops for access/rate limits.
- Track all six agreed improvements and stage status in PLAN.md.
- Version 1.3.0: collect file sizes from directory rows and retain them in cache
  and JSON; show aggregate byte progress and time remaining from smoothed
  throughput, with explicit unknown sizes, pause, retry and completion states.
- Version 1.2.0: add adjustable parallel downloads, throughput-based automatic
  concurrency tuning, live aggregate speed, and independent parallel scanning.
- Serialize completion-journal writes; drain active work on pause and reduce
  concurrency with a Retry-After-aware cooldown on HTTP 429/503.
- Import existing JSON lists, export resumable scan queues, persist per-root
  scan checkpoints in IndexedDB, and offer explicit cache restore and rescan.
- Version 1.1.0: support any archive directory and the complete Root listing,
  preserving top-level folders under `noty.propovednik.com` for archive-wide runs.
- Add a recursive textbook downloader with folder preservation, streamed writes,
  pause/resume, a completion journal, bounded site traversal and response checks.
