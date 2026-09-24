# Downloader improvement plan

Implement and deliver each stage separately, with behavior checks and an updated
README/changelog before moving on. Existing JSON exports and completion journals
must remain compatible. Dates and sizes are evidence of likely changes, not
cryptographic proof of identical contents.

## Combined speed chart — delivered in 3.1.9

- Add aggregate saved-file throughput to the existing byte-speed graph, with
  an orange dashed curve, separate zero-based scale, legend and accessible hint.
  Reuse the completion-card rate and shared bounded sample history.
- Validate no completions versus positive throughput, independent scales and
  matching sample positions. Browser fixtures populate both curves through
  completed downloads and capture desktop/mobile layouts.
- Validation: syntax check and all 170 tests pass; isolated Edge acceptance
  passes, and both chart screenshots were visually inspected.

## Manual concurrency — corrected in 3.1.8

- Reproduced manual 3/4-worker preferences being halved and persisted during
  cooldown, including multiple failures from concurrent requests.
- Keep manual download preferences intact; use the existing temporary recovery
  limit of one until a successful transfer, then restore the chosen concurrency.
  Automatic tuning and scan behavior retain their existing policies.
- Regression scenarios assert persisted/UI preferences, one pending probe and
  actual concurrent requests after recovery for challenges, network errors and
  HTTP 429. Browser acceptance explicitly configures sequential incident tests
  and verifies a three-worker outage/recovery without relying on old reductions.
- Validation: syntax check, all 170 tests and isolated Edge acceptance pass.

## Network outages — corrected in 3.1.7

- Reproduced an outage consuming all eight queued files as final errors, with
  either one or four workers. Tag fetch/body-read exceptions at their boundary
  and promote exhausted per-request retries into bounded queue recovery.
- Preserve queued items, links and partial-write aborts; reuse helper navigation,
  cooldown, single-worker resumption and the consecutive-attempt cap. Do not
  infer a challenge from a generic fetch failure or alter HTTP/disk error rules.
- Validation: 167 tests and syntax check pass. Real-Edge acceptance aborts a
  request with internetdisconnected, confirms untouched items stay queued, then
  verifies helper refresh and automatic completion without a manual restart.
  Network responses and filesystem writes are fixtures; the user's live network
  failure cause remains unknown.

## Helper isolation — corrected in 3.1.6

- Reproduced the disconnect with a real Edge popup served with COOP same-origin:
  the page stayed open while its owner's WindowProxy reported closed. The old
  implementation discarded the valid channel readiness message.
- Pair a persistent BroadcastChannel, send self-navigation commands with
  increasing revisions, and accept matching readiness independently of the
  severed proxy. Validate command source/target and reject stale messages.
  Probe liveness before declaring a previously paired helper unavailable.
- Cover severed-proxy resumption, timeout versus live ping replies, invalid
  commands and the existing real-browser workflow under COOP. Offline HTTP and
  filesystem fixtures do not establish the live site's specific response headers.
- Also reproduced and fixed an expired recovery timer overwriting completed
  download status. Validation: all 161 tests, syntax check and real-Edge
  acceptance pass, including isolated helper refresh/resumption and true closure.

## Recovery attempt lifetime — corrected in 3.1.5

- Reproduced cumulative backoff across unrelated challenges despite successful
  downloads in between. Reset the consecutive-failure budget only on successful
  work after automatic resumption; retain manual-pause, Retry-After and persistent
  failure limits. Helper readiness and local skips are not recovery evidence.
- Two regressions failed before the fix and passed afterward: nine separate file
  incidents in one queue, and distinct directory challenges separated by a valid
  listing. Browser acceptance covers two separate incidents without a manual
  restart, each recovering after the initial delay. Validation: 158 tests,
  syntax check and isolated-browser acceptance pass. Network and disk are mocked.

## Directory name refusal — corrected in 3.1.4

- Reproduce `getDirectoryHandle: Name is not allowed` for a leading-tilde
  archive directory. Escape boundary and Windows short-name-like tilde components
  through the shared local-name mapping; keep original manifest paths and URLs.
- Classify explicit archive-directory name refusals as item errors in download
  and repair. Verification reports an unreadable item; generic disk failures
  retain the pause behavior. No remote links or existing files are deleted.
- Four new regression tests failed before the fix and passed afterward; cover
  distinct percent names, successful writes, journal verification/restart and
  continued sibling downloads/repair after other explicit directory refusals.
  Browser acceptance also exercises mapped directory writes and cached restart
  with simulated HTTP and File System Access handles. Validation: 156 tests,
  syntax check and isolated-browser acceptance pass; no live archive was changed.

## File HTTP 403 removal — completed in 3.1.3

- A confirmed ordinary file denial removes the link from the manifest and
  immediately saves the edited cache. Keep excluded-error diagnostics, do not
  retry or repair removed links, and leave local files untouched.
- Confirmed browser challenges retain the file and bounded recovery; directory
  denials cannot mark the crawl complete. Both concurrent response orders are
  covered. This supersedes the blanket file-403 recovery policy in 3.1.2.
- Validate normal/metadata files, one/four workers, empty manifests, edited
  export/cache restoration and retrying other errors without denied files.
  Browser acceptance uses an nginx-style 403 fixture and confirms continuation
  and cached restart with no additional helper navigation or denied request.
  Validation: 152 tests and syntax validation pass, plus isolated browser
  acceptance. HTTP and directory handles remain simulated.

## Concurrent HTTP 403 recovery — corrected in 3.1.2

- Treat bare 403 as a bounded recovery candidate, preserving recovery already
  scheduled by another worker's confirmed challenge. Keep honest HTTP diagnostics.
- Distinguish active downloading from folder preparation; report draining active
  files during pause without starting new work.
- Four reproductions failed before the fix and passed afterward. Validation:
  148 tests including both four-worker response orders, stream draining, queue
  retention, Retry-After, the eight-attempt limit, HTTP 401 and disk-error guards.
  Browser acceptance uses a bare 403 followed by helper recovery, and still covers
  confirmed HTML challenges. HTTP/filesystem fixtures remain simulated.

## Helper connection status — corrected in 3.1.1

- Detect helper closure independently of queue activity, invalidate stale
  readiness and stop the owned monitor. Show loading/reopen states and retain
  queue progress, cooldowns and manual pause semantics.
- Both regression tests failed before the fix and pass afterward. Validation:
  141 tests, syntax check and browser workflow acceptance with real popup
  close/reopen and offline HTTP/filesystem fixtures.

## Collected-list editor — completed in 3.1.0

- Browse all collected entries in a paginated dialog; search paths and sort by
  numeric size or path, keeping unknown sizes last.
- Select/remove links across pages, undo the latest removal, immediately persist
  edits in cache and export the edited list, including an empty manifest.
- Preserve local files and journal records. Invalidate stale queues/reviews and
  block mutations during operations/recovery. Fresh scans may rediscover links.
- Validate persistence, export, failure/retry, paused-queue exclusion, large
  selection, safe filenames and desktop/mobile dialogs using offline fixtures.
  Passed: 139 tests, syntax check, browser workflow and UI acceptance. Real
  IndexedDB/export are exercised in the browser; download filesystem handles
  and server responses remain simulated.

## Workspace redesign — completed in 3.0.0

- Move the original catalog to the left and the download controls to the right.
  Preserve original DOM/links and every existing downloader control.
- Add local catalog search/type filtering, independently scrolling panels,
  fixed primary actions, metric cards and organized import/cache actions.
- Adapt to narrow screens and legacy table widths; keep long filenames and
  settings usable without horizontal page scrolling.
- Validation: 132 offline tests, browser workflow acceptance and dedicated UI
  acceptance at 1440/1100/900/390 pixels. Screenshots inspected. Live site blocked
  by a Cloudflare check during inspection; network and filesystem fixtures are
  simulated and do not establish live-server or installed-Tampermonkey behavior.

## 1. Automatic retries — completed in 1.4.0

- Retry transient network/read timeouts, interrupted responses and selected
  temporary HTTP failures during both scanning and downloading.
- Configure maximum retries and initial delay; use bounded exponential backoff
  with jitter. Keep attempts within the existing concurrency limit.
- Pause must interrupt backoff and retain the item for explicit resume.
- Preserve global stops/cooldowns for access checks, HTTP 401/403/429/503, and
  permission, disk and journal errors. Do not retry permanent HTTP 404 errors.
- Validate recovery, exhaustion, disabled retries, pause during backoff and
  correct completion/progress accounting.

## 2. Verify the downloaded directory — completed in 2.0.0

- Add a read-only comparison of the current manifest and a selected local folder.
- Report verified journal matches, missing files, size mismatches and uncertain
  files without journal evidence. Account for rounded directory-listing sizes.
- Export a verification report and queue only missing/incomplete files.
- Before replacing a nonempty mismatching file, show the concrete repair list
  and let the user explicitly choose the replacement action.
- Validate nested folders, unrelated files, interrupted writes and old journals.

## 3. Select folders before downloading — completed in 2.0.0

- Show a searchable tree with checkboxes, file counts and known byte totals.
- Support selecting a parent or individual branches, including partial selection.
- Keep the complete scanned manifest; derive the download queue from selection.
- Update progress and ETA against selected files and preserve original paths.
- Keep the UI responsive for thousands of files; verify Root and subfolder runs.

## 4. File filters — completed in 2.0.0

- Add include/exclude extensions, filename search and maximum file size.
- Define explicit behavior for unknown sizes and combine filters with folder
  selection. Show included/excluded totals before starting.
- Persist preferences and include selection/filter metadata in new exports
  without breaking existing manifests.
- Validate case-insensitive extensions, extensionless files, unknown sizes and
  combinations of filters that select no files.

## 5. Detailed progress — completed in 2.0.0

- Show each active file's path, received/expected bytes, speed and retry state.
- Add bounded-history charts for aggregate throughput and concurrency changes.
- Distinguish waiting, transferring, saving, retrying and completed work.
- Keep updates lightweight; verify pause/resume, stalled connections, changing
  concurrency and long sessions without unbounded history growth.

## 6. Update a local archive — completed in 2.0.0

- Capture listing modification dates where available; compare a fresh manifest
  to the previous snapshot and local verification results.
- Present new, probably changed, unchanged, removed-from-site and uncertain files.
- Queue selected additions/updates. Keep removed local files unless the user
  explicitly chooses a separate cleanup operation.
- Reuse the review/repair flow for replacing existing files. Do not silently
  promote a rounded size/date comparison into a guarantee of identical content.
- Validate additions, renamed/missing files, absent metadata and changed content.

## Delivery log

- Patch 2.1.6: separate recent/average rates with adaptive units, show successful
  saves/s, and synchronize active counters at scheduler ticks. Use file-based ETA
  only with five recent samples and similarly sized small pending files; label
  byte-based ETA as conditional on current pace. Tests cover mixed sizes, stale
  counters, partial bytes and streamed small-file completion. Syntax validation,
  132 offline tests and browser acceptance pass. Live workload prediction accuracy
  is not established by these deterministic checks.
- Patch 2.1.5: scope explicit browser file-name rejection to the affected archive
  item, preserve the failure in reports and continue the queue. Never rename or
  mark the rejected item saved. Keep journal and unrelated filesystem failures
  fatal. Two initial regressions failed before the fix; 129 tests and syntax
  checks pass, including repair/create/lookup and verification boundaries.
  Browser acceptance uses simulated refusal and confirms the next PDF downloads.
  Chromium source independently explains the name check and Windows INI policy;
  no live archive files or browser security settings were changed.
- Patch 2.1.4: estimate the working queue independently of failed items, preserving
  total volume and an explicit error count. Restore failed items to ETA on retry,
  report drained queues honestly and update pause status immediately. Two streamed
  regressions failed before the fix; 124 tests and syntax checks pass. Browser
  acceptance checks the drained queue with one error. Live ETA accuracy remains
  dependent on listing sizes, throughput changes and final disk/journal work.
- Patch 2.1.3: support HTML responses for archived PHP resources and stop turning
  every content validation error into a global queue pause. Both initial download
  and verified repair continue automatically past per-item errors, preserve their
  error records, and selectively retry them later. PHP challenges retain global
  recovery. Three new regression cases failed before the fix; 122 tests and
  syntax checks pass. Browser acceptance covers repair of PHP HTML, a rejected
  HTML-as-PDF response and a following valid PDF without another resume click.
  These responses and filesystem handles are simulated, not the user's live run.
- Patch 2.1.2: fix normal JavaScript Detections being classified as interstitials
  and direct blocked-HTML recovery to the exact resource instead of the catalog.
  Report response/header evidence and retry status without claiming file access.
  Three new regression scenarios failed before the fix; 119 offline tests and
  syntax validation pass. Browser acceptance checks a catalog that stays open
  while the HTML target requires two helper navigations, then verifies the saved
  HTML bytes and zero page errors. Also cover exhaustion when readiness repeatedly
  precedes a still-blocked request. The live direct HTTP diagnostic returned a
  confirmed challenge; it did not share the user's browser session. Live browser
  recovery remains unverified. Existing list/cache/journal formats are unchanged.
- Patch 2.1.1: fix the ordinary-tab challenge link and helper role loss when URL
  parameters disappear. Preserve context in the helper before its first navigation
  and display its role. Three focused regressions and the redirected browser flow
  failed before the fix. Validation: 115 offline tests, syntax validation and
  browser acceptance with HTTP 302 stripping helper parameters and no opener.
  Live-site redirect behavior was not confirmed; the direct web tool could not
  access the diagnostic URL. Both identified code defects are covered offline.
- Version 2.1.0: helper-tab refresh and automatic continuation after confirmed
  directory load. The main tab keeps its queue and destination handles. Recovery
  respects cooldowns and manual pause, stops after eight rounds, and never
  automatically resumes past a filesystem failure or expired write permission.
  Validation: 110 offline tests, syntax check and real-browser acceptance with
  intercepted HTTP responses, helper navigation and BroadcastChannel. Filesystem
  handles remain simulated; no live Cloudflare challenge was solved in testing.
- Patch 2.0.1: local filesystem failures now pause and preserve pending downloads
  with operation/path diagnostics and long-path recovery instructions. Verification
  distinguishes a failed read through an acquired handle from an absent file.
  Five new repair regressions failed before the fix and passed afterward; 94
  offline tests, syntax validation and isolated-browser acceptance pass.
  The browser acceptance still mocks directory handles. Read-only inspection of
  the affected archive found empty files clustered at full-path lengths 253–259;
  Chromium's sibling `.crswap` suffix explains why creation can succeed before
  writing fails. A separate Win32 probe in PowerShell accepted a 260-character
  path, so that probe does not establish Chromium's behavior. The recovery path
  was calculated against the manifest; a live browser download after relocation
  remains to be checked by the user.
- Baseline: version 1.3.0, 55 offline tests; recursive scan, cache/JSON import,
  bounded downloads, automatic tuning, byte totals and estimated time remaining.
- Stage 1: version 1.4.0, 65 offline tests passing, plus syntax validation.
  Automatic retries cover both directory and file requests, bounded backoff,
  pause/resume, exhausted attempts, partial reads and separation of disk errors
  from network errors. No live-site bulk benchmark was performed.
- Stages 2–6: version 2.0.0. Delivered read-only verification/repair, explicit
  replacement choices with local-change checks, folder/file selection, filters,
  bounded detailed progress/charts and metadata-based incremental updates.
- Validation: 87 offline tests, syntax validation and isolated-browser acceptance
  covering the combined selection → verify → repair → replace → update workflow.
  Screenshots were inspected. The existing 4,757-file JSON passed validation and
  folder-tree preparation. Actual server throughput and a full live archive
  download were not benchmarked; real File System Access permission prompts
  still depend on the installed browser and Tampermonkey environment.
