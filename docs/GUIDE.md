# Noty folder downloader

A standalone Tampermonkey userscript for `https://noty.propovednik.com/`.
It recursively scans any selected archive directory and streams each file
into a user-selected local folder. No account credentials, remote services,
external scripts, or extension download API are used.

## Install and run

1. Install Tampermonkey from its official site: https://www.tampermonkey.net/.
   Use an up-to-date desktop Chrome or Edge. Follow Tampermonkey's own setup
   instructions if it asks you to enable userscript execution.
2. In Tampermonkey, choose **Create a new script**, replace the template with
   the complete contents of `noty-folder-downloader.user.js`, and save.
3. Open https://noty.propovednik.com/ in that same browser and complete any site
   check. Navigate into the directory you want, or stay on **Root** to include
   every section of the archive.
4. The catalog appears on the left and the download panel on the right.
   Click **1. Найти файлы** in the download panel.
5. After scanning, click **2. Выбрать папку и скачать**, choose a preferably
   empty destination, and grant the browser permission to write there.
   The script creates a subfolder named after the selected remote directory.
   From **Root**, it instead creates `noty.propovednik.com` and preserves all
   top-level section names and nested paths inside it.
6. Keep the tab open and the computer awake until completion. All formats in
  the chosen directory are included, including archives, images and audio.

For example, selecting `D:\Archive` while viewing `_Сборники` saves files under
`D:\Archive\_Сборники\...`. Starting from **Root** saves them under
`D:\Archive\noty.propovednik.com\_Сборники\...`, alongside `_ABC`, `_УЧЕБНИКИ`
and other sections. An individual folder run never follows links to siblings
or parents.

To update an installed copy, replace its entire contents in Tampermonkey with
the new `.user.js` file, save, and reload the site. Version 3.0.0 redesigns the
catalog and download workspace while retaining the existing queue, journal,
cache, filtering and recovery behavior. Version 2.0.0 adds folder/file
selection, filters, local verification and repair, live file details/charts, and
incremental archive comparison. Version 1.4.0 added configurable
automatic retries. Version 1.3.0 added file sizes,
aggregate volume and an estimated time remaining. Version 1.2.0 added parallel
downloads, automatic concurrency tuning, parallel scanning, JSON import, and
a persistent scan cache. Existing textbook journals remain compatible when
you resume from the same remote folder and select the same parent destination.
An archive-wide run uses a separate destination tree and journal; it does not
automatically reuse files from previous individual-folder runs.

Version 3.1.7 also handles network outages. After the configured per-request
retries fail, the queue pauses, retains the failed item, and uses the existing
helper/cooldown flow for up to eight consecutive recovery attempts. It does not
mark every remaining file as failed or remove its link. Started transfers may
finish; resumption starts with one worker. Manual pause and disabled automatic
recovery are respected. Fetch and response-body exceptions are tagged at the
network boundary, so disk errors and ordinary HTTP item errors keep their own
handling. A `Failed to fetch` message alone does not establish a Cloudflare
challenge: [fetch rejects for several reasons](https://developer.mozilla.org/en-US/docs/Web/API/Window/fetch#exceptions).
The browser test simulates an actual request failure, not a live proxy outage.

For files already counted as errors by an older version, use **Проверить папку**
and **Докачать отсутствующие / пустые** after upgrading, or **Повторить ошибки**
before reloading if staying on the current version. Previously saved files can
be recognized using the completion journal in the same destination.

The same file can also be run as JavaScript in DevTools on that page; the
metadata lines are comments. This is optional and requires no extension.
Do not paste it into the address bar. Review the script before running it.

## Reusing a file list

- **Загрузить JSON** loads a previously exported `noty-files.json`. It validates
  the root, URLs, paths and Windows filename collisions before replacing the
  current list. Loading a list switches the panel's selected root to the root
  stored in that list; the web page itself does not navigate.
- Original 1.0/1.1 exports are supported: load the file, then choose the download
  destination. No directory requests are necessary. Old exports did not record
  whether scanning had finished, so the panel explicitly labels their
  completeness as unknown. The imported list is not a completion journal and
  does not claim that any files are already saved on disk.
- New exports include visited folders, pending folders and scan completion.
  Incomplete lists resume with **Найти файлы**; complete lists can download
  immediately. Export after pausing to transfer an unfinished scan elsewhere.
- During scanning the browser cache is checkpointed at roughly five-second
  intervals and again after completion, pause or failure. In-flight folders
  belong to the checkpoint's pending queue. After reloading the same archive
  directory, click **Из кеша** to restore it explicitly. Cache records are keyed
  by the selected remote root, and importing a JSON also caches that list.
- **Собрать заново** discards the panel's current listing and starts a fresh
  scan of its selected root, retaining the last completed list as a comparison
  baseline. It leaves downloaded files and their on-disk
  completion journal untouched. Cached lists are snapshots, not live updates;
  the panel shows their original date.
- Lists and queues use IndexedDB in this browser profile for this site. File
  contents are not cached. Clearing site data, browser eviction or ending an
  incognito session can remove the cache; keep JSON exports for portable backup.
  Cache failure is displayed and does not stop scanning or downloads. Settings
  are saved separately in localStorage. Avoid concurrent scans of the same
  root in different tabs, because their cache checkpoints can replace each other.

## Folder selection and filters

Expand **Выбор папок и фильтры** after scanning or importing a list. The searchable
tree contains folders inferred from file paths, with expandable branches and
checkboxes. Selecting a parent applies to descendants; individual branches can
override that selection, and parents show a partial state. Each row shows selected
versus total file counts and selected known volume. Large trees render in pages
of 150 rows, with **Показать ещё папки** to expand the result set.

Include/exclude extensions are case-insensitive, separated by spaces, commas or
semicolons. `pdf`, `.pdf`, and `*.pdf` are accepted; `-` selects files without an
extension. A path/name substring and a maximum individual file size in MiB can
be combined with those filters. Zero/blank means no size limit. The unknown-size
checkbox explicitly controls whether files without sizes remain eligible.

The selected count/volume previews the actual download set; an empty set disables
downloading. File-count progress, byte totals and ETA use the current run's queue.
The complete manifest remains intact and is exported alongside view preferences.
Folder/filter preferences persist per remote root in this browser and in new JSON
exports/cache entries. Changing selection while idle resets the pending run and
invalidates its verification/replacement choices. Already saved files remain on
disk and can be recognized through their journal when selected again.

**Все папки** clears folder and individual-file restrictions; it retains filters.
**Сбросить фильтры** clears only filters. Folder checkboxes also clear an individual
file subset. Selection controls are disabled while scanning, verifying or
downloading to keep the active queue stable.

## Verify and repair a local directory

1. Load a list and choose the folders/files to verify.
2. Expand **Проверка папки и докачка** and click **Проверить папку**. Select the same
   *parent* destination used when downloading. For example, choose `D:\Archive`
   for files stored in `D:\Archive\_Сборники`. Verification does not create files,
   directories or journal entries and does not fetch files from the network.
3. Review the report: missing, empty, size mismatch, matching completion journal,
   likely remote update, uncertain without journal evidence, or read error.
   Exact server byte counts can identify a mismatch; rounded listing sizes alone
   do not establish one. A journal match is not a content hash check.
4. **Докачать отсутствующие / пустые** queues only missing and zero-byte files.
   Nonempty mismatches and uncertain files are never included automatically.
5. To replace an existing file, check its row and click **Заменить отмеченные
   файлы (N)**. This explicit action authorizes precisely those replacements.
   Local byte size and modification time are checked against the reviewed file
   both before fetching and before opening the write stream. A detected local
   change requires a new verification. These checks do not replace content hashes.

Successful repairs update the corresponding report rows. Reports are paginated,
can be limited to problems and exported as `noty-verification.json`. Pausing a
verification leaves an exportable partial report; run verification again before
building a repair queue. Files outside the selected manifest are left untouched.

## Detailed progress

**Файлы в работе и графики** shows active file paths, received/expected bytes,
per-file speed and current stage: waiting, receiving, writing, updating the
journal, or retrying. Stalled receiving jobs and retry countdowns are visible.
The last ten finished/failed jobs remain below active work. Two SVG graphs show
aggregate throughput and configured/active concurrency, including tuning changes.
History is capped at 180 approximately one-second samples and resets for a new
queue, while a paused/resumed queue retains its history. Small files may complete
between samples; the completion list still records them.

## Update a local archive

After loading an existing list, click **Проверить обновления на сайте**. The script
keeps that list as a baseline and performs a fresh scan. File sizes and listing
modification dates, where present, classify paths as new, probably changed,
matching metadata, uncertain, or removed from the current completed listing.
Removal is never inferred from an incomplete scan. Matching metadata does not
prove identical content, and absent metadata is explicitly uncertain.

**Выбрать новые и изменённые** creates an individual-file subset within the current
folder/filter rules. Use checkboxes in the comparison to adjust individual files,
or clear folder/filter restrictions if the selected count is unexpectedly small.
Then verify the local parent folder, repair missing additions, and explicitly
select existing files to replace. Updated journal entries retain the source
metadata, so later remote changes no longer silently qualify as old saved files.

**Скачать сравнение** exports `noty-changes.json` with old/new metadata. The baseline
and view preferences also survive cache/JSON round trips; only one previous
snapshot is retained, avoiding recursively growing history. Old journals without
source metadata remain usable, with less evidence about remote changes. Local
files removed from the site are never deleted by the updater.

## Parallelism and automatic tuning

Expand **Потоки и автотюн**. Settings apply while running; lowering a limit lets
already-started work finish before more work starts.

| Setting | Default | Range |
| --- | --- | --- |
| Download mode | Auto | Auto / manual |
| Manual simultaneous files | 3 | 1–12 |
| Auto maximum simultaneous files | 6 | 1–12 |
| Delay between file starts | 150 ms | 0–5000 ms |
| Throughput measurement window | 10 s | 5–60 s |
| Minimum useful gain | 8% | 3–30% |
| Simultaneous folder requests | 3 | 1–6 |
| Delay between folder starts | 200 ms | 0–5000 ms |
| Automatic retries after a transient failure | 3 | 0–8 |
| Initial retry delay | 2 s | 1–60 s |

### Autotuner 3.2.1

A fresh automatic session starts with one worker. It measures two windows after
up to two seconds of warm-up; bursty measurements get a third window and a
median rate. At the defaults, one measurement normally takes 22-32 seconds.
Partially occupied workers no longer discard all accumulated measurements.
For sparse small-file completions (below one file/s), it gathers at least
eight completions or up to six windows, whichever comes first, and uses the
aggregate rate. This avoids treating individual completion events as isolated
speed spikes. Relative-noise protection also applies below one file/s.

For completed small files (at least five completions, all at most 256 KiB, and
no large or unknown-size active files), tuning uses successful saved files/s.
For other workloads it uses received bytes/s, with a completion-rate guard for
mixed queues. Completions count only after file close and journal persistence;
verified local skips do not count as downloads. Neither rates nor ETA are
multiplied into a synthetic speed.

A promising new worker count must also beat a fresh measurement at the old
count: baseline A, trial B, return to A. This reduces accidental attribution of
server/workload changes to concurrency. The metric stays fixed throughout the
comparison and subsequent hold; crossing a completion-count threshold alone
does not change it. A small-file sample becoming mixed/large, or a completed
mean file-size ratio outside 0.5-2, invalidates a comparison. The configured gain
threshold and observed noise determine acceptance. Lower counts may be retained
within a maximum eight-percent tolerance to avoid needless concurrent requests.

Hold periods start at 30 seconds (40 at default settings). Unsuccessful probes
progressively lengthen the hold, capped at five minutes; a confirmed change
resets this backoff. The reference
keeps updating, including at one worker after a persistent slowdown. Bounded
periodic exploration can test two extra workers to look past a local plateau;
all probes obey the configured maximum. Occasional lower-count probes check
whether fewer workers can do the same work, including below the ceiling.
After a confirmed reduction, the next experiment checks the next lower count
until a reduction stops helping or one worker remains. These probes and their
confirmation temporarily change the live worker limit by design.

Tuning also works in hidden tabs while timer observations remain usable. A gap
above 30 seconds starts a fresh measurement; browser suspension cannot be
prevented. Pause, retry waits, access recovery and the end of the queue suspend
tuning with an explicit status. A drain after lowering the limit preserves the
pending comparison until the excess jobs finish. Underfilled probes still
finish, even when launch pacing limits useful concurrency.
Retries and failures immediately roll an unconfirmed trial back to its accepted
worker count before discarding measurements. Access recovery may then reduce
that accepted automatic count further; manual settings remain unchanged.

### Switching modes while running

- **Auto -> manual:** apply the saved manual worker preference, not the last
  automatic probe count. It can exceed the separate automatic maximum.
- **Manual -> auto:** start from the current manual preference, capped by the
  automatic maximum, with fresh measurements. It does not restart at one.
- Lowering a limit lets existing jobs finish; it does not cancel their files.
  No new jobs start while occupancy meets or exceeds the new limit.
- A switch on pause does not resume the queue. During cooldown it does not
  bypass the wait. During access recovery the temporary one-worker cap remains
  until a successful transfer; the selected mode then determines the limit.
- Scan, retry and auto-recovery settings do not discard learned concurrency.
  Changing the automatic ceiling, measurement window, gain threshold or launch
  delay starts fresh measurements at the current (possibly clamped) count.
- The manual preference and mode persist in settings; automatic measurements
  are session-local and do not survive a page reload.

The global launch delay still protects the server from bursts. Scheduler
wake-ups now respect the next start deadline rather than adding a fixed 200 ms
idle wait. More workers cannot eliminate the configured launch delay, slow
journal writes or a saturated network connection.

The display separately reports recent received bytes/s, the weighted average
over up to 30 seconds, successfully saved files/s, active jobs and the chosen
limit. The reference level uses the metric currently being compared; it is not
a claim of a global optimum. Rates adapt their units, and both active-job
counts update from the same scheduler tick.

The algorithm remains a heuristic: heterogeneous files and rapidly varying
server or disk performance can still mislead comparisons. A known good fixed
worker count avoids calibration overhead. Journal writes remain serialized.
The automated simulation suite covers small/large jobs, launch pacing and mode
switches using the actual scheduler; these are offline synthetic workloads,
not performance promises for the live archive.

Folder discovery uses its own fixed, adjustable pool and delay, without speed
autotuning. Newly discovered subfolders enter the queue once. A narrow directory
chain cannot use multiple requests until independent child folders are known.

## File sizes and remaining time

Scanning reads each file's **Size** cell, preferring exact byte-count tooltips
when available. Parsed `sizeBytes` and the original `sizeText` are retained in
JSON exports and the browser cache. Rounded K/KB/MB/GB/TB values are interpreted
in powers of 1024 and displayed as approximate volume. Missing or unrecognized
sizes remain unknown, rather than being counted as zero.

During downloads, a usable uncompressed Content-Length updates the listed size;
successful writes and journal-verified existing files supply their actual sizes.
The volume display includes already-saved files and bytes received for active
files, capped at each file's expected size. Failed attempts lose their partial
progress because retrying starts that file over. The file-count progress bar
continues to count successfully completed or verified files.

**До конца** normally divides remaining known bytes by aggregate received throughput
smoothed over the most recent 30 seconds. The display labels this average separately
from the latest sampling interval; the latest speed and ETA use different windows.
Measurement starts after three seconds;
it resets on resume or long sampling gaps and withholds the estimate after ten
seconds without new data. Time is approximate, rounded up to minutes, and can
change as speed or size information changes. Final disk writes and journal
commits can take additional time. Unknown sizes in the current queue suppress
the estimate rather than implying a complete download time.

Since version 2.1.6, a homogeneous small-file queue can instead use successful
file completions per second, including writing and journal commit. This requires
at least five recent successful downloads, all recent sampled and remaining files
at most 256 KiB, and a remaining mean size within a factor of two of the sampled
mean. Samples span up to 30 seconds (at most 200 completion records). Existing
files skipped through journal verification do not count as downloaded completions.
The ETA label identifies which method was used. Larger, mixed or insufficiently
sampled queues use the byte-based estimate, explicitly conditional on the current
pace. A slow small-file segment does not establish how quickly later large files
will transfer. These are estimates, not a calibrated workload-duration model.

Since version 2.1.4, completed failures no longer hide ETA for the working queue.
Their remaining bytes and unknown sizes are excluded from ETA, while overall
volume and the error list retain them. The label becomes **До конца очереди**
and explicitly gives the number of errors excluded from the estimate. When only
failed items remain it reports that the queue was processed, not that the archive
is complete. **Повторить ошибки** puts them back into the calculation. Manual
pause immediately replaces the time with pause status.

Old JSON exports still work but contain no sizes. Use **Собрать заново** once to
collect sizes from the directory listings, then export the updated list. No HEAD
request is made for every file. The site may omit some sizes, in which case the
panel displays how many remain unknown.

## Pause, resume and failures

- Network request/read failures, timeouts, truncated transfers and HTTP
  408/425/500/502/504 are retried automatically during both scanning and downloads.
  The retry count is additional attempts after the first request. Zero disables
  automatic retries. Default delays are approximately 2, 4 and 8 seconds with
  ±20% random jitter; each delay is capped at 60 seconds.
- A retry retains its worker slot, so waiting attempts do not create extra
  concurrency. Failed file attempts are closed/aborted before retrying from byte
  zero. The log shows attempts/delays; the status shows the number waiting.
  ETA is hidden and automatic tuning is suspended during retry waits. Exhausted file attempts enter
  the normal error list; exhausted folder attempts pause the scan and retain the
  folder in its pending queue/cache.
- Pause interrupts retry backoff within a scheduling tick and retains that item
  for resume. A new explicit resume/manual retry starts a fresh attempt budget.
  HTTP 404, file conflicts and filesystem errors are not retried automatically;
  HTTP 401 requires manual intervention. Recognized challenges, directory HTTP
  403 and HTTP 429/503 enter the bounded recovery flow described below. Plain
  file HTTP 403 removes that link from the manifest and cache and continues the
  queue. It remains in the current error report, marked `excluded`, and is not
  eligible for **Повторить ошибки**. Local files remain untouched.
- **Пауза** stops starting new jobs; all already-started pages/files finish.
  It does not abort a transfer mid-file.
- During scanning, click **Найти файлы** again to resume.
- During downloading, click the download button again to resume.
- **Повторить ошибки** retries individual failed downloads.
- After a refresh, rescan and select the same parent destination. The
  `.noty-download-state.json` journal lets the script skip files it previously
  completed, provided their paths and byte sizes still match. This is not a
  cryptographic integrity check and does not detect server-side replacements.
- A nonempty file without matching journal evidence, or with changed remote
  metadata, requires verification and an explicit replacement selection. Normal
  downloads do not overwrite it. Zero-byte interrupted writes can be retried.
- On an access check, the queue stops starting jobs while existing requests
  finish. A confirmed Cloudflare challenge, directory HTTP 403 or HTTP 429/503
  schedules recovery when enabled. Recovery starts with one worker until a
  successful network transfer. Since 3.1.8, manual download concurrency is
  preserved and automatically restored after that success; auto mode still
  penalizes its tuning limit. If an older version saved a reduced manual value,
  select the desired number once after upgrading. An ordinary non-PDF response
  for a PDF is an individual file error; other files continue.
- Use **Список ссылок** to export the discovered URLs and current errors as JSON.

## Speed and file throughput chart (3.1.9)

The speed chart in **Файлы в работе и графики** shows two aggregate series:
blue solid bytes/second and orange dashed saved files/second. Each uses its own
zero-based range, labeled above the chart; curve heights cannot be compared as
the same unit. Files/second uses the same smoothed rate as the completion card
(up to 30 seconds), including completed network transfers across all workers.
Journal skips are not counted. Both curves share the last 180 samples. Before
the completion-rate warmup finishes, the file curve stays at zero.

## Automatic tab refresh and continuation (2.1.0)

Install the updated userscript in Tampermonkey, then click
**Включить автообновление вкладки** once in the downloader panel. Allow the popup
if prompted and leave both tabs open. The helper uses the same browser session
and the selected archive directory. It does not start another downloader.
Version 2.1.1 also connects **Открыть сайт для проверки** to this same helper
flow. Both controls open a tab labelled **Служебная вкладка Noty**, never a
second empty downloader panel. When readiness arrives, the main button reads
**Служебная вкладка подключена**.

Version 3.1.6 keeps a paired helper connected through a persistent
BroadcastChannel. COOP can sever the direct WindowProxy and make `closed` true
even when the tab remains open; that flag alone no longer disconnects a paired
helper. The helper receives an authenticated refresh command and navigates
itself. Increasing navigation revisions reject readiness from old documents.
Only same-origin archive-directory or archived-HTML targets are accepted.
If a severed proxy has no recent channel response, the owner sends a ping and
waits up to 10 seconds for a reply; navigation has a 30-second grace period.
An unanswered probe reports that the helper is closed or unresponsive.
Manual pause, cooldown, permission checks and retry limits remain in force.
Direct-window navigation remains a fallback before pairing. A first tab still
needs to be opened using the button when popups are blocked.

When upgrading from an older version, pause and let active transfers finish,
close the old helper, reload the main page, restore the manifest from cache,
then open one new helper with **Включить автообновление вкладки**. Select the
same destination through verification/repair to resume completed-journal work.
This loads the new protocol in both tabs. The diagnosis follows the documented
[Window.open COOP behavior](https://developer.mozilla.org/en-US/docs/Web/API/Window/open#return_value).

The helper context is seeded into its own sessionStorage and window name before
the first network navigation. This preserves the role/token across redirects
that remove query parameters, including redirects before userscript execution.
Only the helper stores that context; ordinary tabs are not globally marked as
helpers. Saved fallback contexts expire after 24 hours and are refreshed on
each managed navigation. URL parameters remain compatible with older launches.

The auto-recovery checkbox is enabled by default under **Потоки и автотюн**.
If a helper was not opened in advance, the script tries to open it at recovery
time; popup blocking is reported with instructions to use the button.

Since 3.1.5, the eight-attempt budget counts consecutive unsuccessful recovery
attempts, not all challenges in a long download session. A successfully saved
network download or a successfully validated directory after automatic resumption
resets the budget. A later separate challenge starts at attempt 1/8 with the
initial 30-second delay, unless a longer Retry-After applies. Loading the helper,
skipping a journal-verified local file, or finishing an old transfer while paused
does not establish recovery. A repeatedly challenged resource still reaches the
eight-attempt limit without losing its queued link.

On a recognized Cloudflare challenge, directory HTTP 403 or HTTP 429/503, the main tab retains its
in-memory queue, destination handles and replacement approvals. It lets started
transfers finish and waits at least 30 seconds (or a longer Retry-After), then
navigates the helper to the blocked HTML file (version 2.1.2)
or to the archive directory for other formats. HTML targets retain their exact
URL; their helper context is carried in tab-local storage/window name. The helper
waits for `load`/`complete`, nonempty content at that exact HTML URL or actual
directory headings, and absence of challenge markup before resuming the request.
A redirect to the catalog cannot establish readiness for a blocked HTML file.
The userscript now also runs on archive pages in a registered helper tab;
ordinary archive pages do not receive a downloader panel.
Cross-tab messages carry the current navigation token; BroadcastChannel also
supports helpers without an opener reference. A valid directory does not prove
individual file URLs are unblocked: another challenge returns to waiting. The
log reports a retry, not restored file access, until the download succeeds.

Version 2.1.2 distinguishes normal Cloudflare JavaScript Detections from
interstitial challenge pages. A `challenge-platform` URL or an ordinary phrase
such as "Just a moment" no longer rejects an otherwise valid HTML document.
The `cf-mitigated: challenge` header remains authoritative; fallback detection
uses specific challenge markup in a bounded prefix (up to 8 KiB for downloads).
Logs distinguish header evidence from HTML evidence. A direct diagnostic request
to the reported resource returned HTTP 403 with that header, but this request did
not share the user's browser session and cannot establish that session's response.

Repeated rounds wait 30, 60, 120, 240, then 300 seconds. Longer `Retry-After`
values on download/scan responses are honored. Automatic refreshes/restarts are
limited to eight rounds per explicit run. The first resumed request runs alone;
normal scheduling returns after it succeeds. No repeated network probes run
while waiting for the helper to load. Background browser throttling can delay
the timer; it does not make the retry happen sooner.

**Пауза** or disabling auto-recovery cancels pending automatic continuation,
including while a filesystem permission query is pending. Disk errors and plain
authorization failures also cancel it. If write permission has expired, the
script asks for a click on the download button rather than opening a permission
prompt unattended. After a manual pause or the eight-round limit, resolve the
issue and resume explicitly to start a new budget.

This refreshes the helper, not the main tab: a main-tab reload would lose active
handles and session-only queue state. CAPTCHA/interactive checks still require
the user in the helper tab; normal navigation may complete non-interactive
checks. Do not change browser/profile between the check and the download.
The helper requires the userscript to be installed for new tabs; a one-off
DevTools paste into the main tab alone is insufficient.

Cloudflare documents the `cf-mitigated: challenge` response header in its
[challenge detection guide](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/).
Normal HTML injection is described in its
[JavaScript Detections guide](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/javascript-detections/).

Version 2.1.3 also accepts HTML for `.php` resources found in saved web-page
directories, and uses their exact URLs for challenge recovery. These are saved
HTTP response bytes, not a claim to recover server-side PHP source. Challenge
detection still runs before accepting their contents. HTML remains invalid for
binary documents such as PDF, and a PDF must have its expected signature.

Individual format errors now enter the error list while the remaining download
or repair queue continues automatically. They are not written, counted as saved,
or added to the completion journal. **Повторить ошибки** retries failed items;
**Список ссылок** includes their paths and messages in its `errors` field. Existing
nonempty replacement targets remain intact after rejected responses. Confirmed
challenges, access/rate-limit failures and filesystem failures retain their
existing pause/recovery behavior. A completed queue with errors is not a complete
archive. Updating the installed script requires a reload; afterward restore the
cache/JSON, verify the same parent directory, and start repair once.

## Compatibility and limits

The script uses `showDirectoryPicker` and the File System Access API. This
version targets desktop Chrome/Edge with Tampermonkey. Firefox/Greasemonkey
and the Codex in-app browser are not supported or assumed to expose this API.
No `GM_download` configuration or file-extension whitelist is needed.

Files are fetched through a bounded pool with a configurable start delay.
Transfer speed still depends on the server and network. Files are
streamed instead of buffering the entire archive in memory. A 90-second
inactivity timeout detects stalled transfers.

Unsafe Windows filename characters are escaped. Case-insensitive path
collisions and excessively long individual names stop the scan instead of
silently merging files. Very long full paths may still fail in the browser on
Windows. Chromium creates a sibling temporary file ending in `.crswap` (or a
numbered suffix), so a filename that can be created may still fail when opened
for writing. The relevant limit includes the entire destination prefix.

Version 3.1.4 also escapes Chromium-invalid tilde names: `~PV_Contents` is saved
as `%7EPV_Contents`, including when used as the selected root folder. Boundary
tildes and Windows 8.3-like names are handled; already-valid long names stay
unchanged. Literal `%7E` in the original name is escaped separately, preventing
collisions. Remote URLs and exported source paths remain unchanged. Download,
verification and completion-journal lookup share the same local mapping.
No existing files are moved or renamed. After updating, restore the cached list,
select the same parent directory via verification, and repair missing files.

Version 2.0.1 pauses the download queue on local filesystem failures, retains
unfinished jobs and reports the operation, exception name and relative path.
An expected missing-file lookup remains normal; failure to create a file or
folder is not treated as an ordinary missing file. This change does not remove
browser or operating-system path limits. The browser exposes the selected
directory name, not its absolute local path, so the script cannot automatically
measure the full path length.

For long-path failures, pause and wait until active writes finish. Move the whole
output directory, including `.noty-download-state.json`, to a short parent such
as `C:\N`. For example, the textbook output should be `C:\N\_УЧЕБНИКИ`.
Use **Проверить папку**, select **C:\N** (the parent), then use
**Докачать отсутствующие / пустые**. Import the JSON again only if the tab was
reloaded. Existing completed files remain verifiable through the moved journal.
Do not rename nested files/folders or discard the journal. For a disconnected or
moved destination, reselect it through verification. Generic disk errors can also
mean lost permissions, locks or insufficient free space; inspect the diagnostic.

Use one downloading tab per destination folder. The script does not coordinate
concurrent writers in different tabs. The journal is updated after a file
closes successfully; a crash between file completion and journal persistence
can leave a conflict that needs manual resolution.

Version 2.1.5 distinguishes an explicit `TypeError: Name is not allowed.` from
other filesystem failures when looking up/creating an archive file handle.
It records that item as failed and lets the rest of the queue continue. No
alternative name is generated and no success journal entry is written. During
verification, the same refusal remains a read error, not proof of a missing file.
Journal failures and generic disk/permission/path errors still stop the queue.
The classification follows the browser's explicit refusal, not a hardcoded
extension blacklist. Repeating the operation does not remove the restriction.

Since 3.1.4, the same item-error rule applies to explicit name refusals for
archive subdirectories. Other queued files continue, and failures remain in
the report; these local failures do not remove remote manifest links. A generic
directory `TypeError`, lost permission, `NotFoundError` during creation, or a
journal failure still stops the queue. See Chromium's
[filename validation](https://github.com/chromium/chromium/blob/main/base/i18n/file_util_icu.cc)
for boundary tilde and Windows short-name restrictions.

Chromium checks names and dangerous file types before returning local file
handles; its current Windows policy lists `.ini` as `DANGEROUS`. See the
[path-component check](https://github.com/chromium/chromium/blob/main/content/browser/file_system_access/file_system_access_manager_impl.cc)
and [file-type policy](https://github.com/chromium/chromium/blob/main/components/safe_browsing/content/resources/download_file_types.asciipb).
Tests simulate the reported refusal; they do not disable browser restrictions
or demonstrate successful saving of a blocked file in the user's browser.

## Verification

`npm ci`, then `npm run check` and `npm test` run the offline checks.
The integration fixtures simulate directory pages, streamed HTTP responses,
local file handles, IndexedDB, JSON import, restart/resume, concurrent scheduling
and journal writes. Deterministic simulations check tuning decisions and
rate-limit handling. They do not establish that
Cloudflare will permit a bulk download or replace a test in an installed
Tampermonkey environment.

`npm run test:browser` exercises selection, filtering, read-only verification,
selective repair, reviewed replacement and update comparison in a fresh headless
browser profile. It also checks actual helper-tab navigation, full-load readiness
and automatic continuation, including BroadcastChannel with a missing opener
and helper parameters stripped before userscript execution. The fixture uses
history replacement to simulate the final URL without an HTTP redirect that
could escape Playwright request routing and reach the live archive.
It also keeps the catalog accessible while an HTML file remains challenged,
navigates the helper to that exact file, waits through another challenge, then
verifies that the original HTML bytes are saved after automatic continuation.
It uses installed Edge/Chrome on Windows (or `BROWSER_PATH`);
on other hosts install the Playwright Chromium runtime first. All site requests
are intercepted with offline fixtures and directory handles are simulated.
It saves `preview-selection.png` and `preview-verification.png` for visual review.
Neither this smoke test nor the unit/integration suite downloads the live archive.

Since 3.1.3, an ordinary file HTTP 403 removes only that link and immediately
saves the edited manifest to cache. Reloading **Из кеша** or importing a newly
exported JSON does not retry it. The current error export retains the path and
reason; retry and repair ignore removed links. An empty manifest is also saved.
Cache failure is reported; export the edited JSON if persistence is unavailable.
A fresh scan or importing an older JSON can rediscover removed links.
Confirmed challenges (header or challenge markup) preserve their links and use
bounded recovery. A directory denial keeps the scan incomplete. This replaces
the broad file-403 recovery policy from 3.1.2.

Since 3.1.2, mixed confirmed-challenge and bare-403 responses from concurrent
workers no longer disable recovery. A paused queue reports how many started
files are still finishing; it resumes after they finish, the cooldown expires
and the helper reports readiness. The normal download badge no longer says
preparing throughout an active transfer. Recovery is still limited to eight
attempts and never overrides manual pause, HTTP 401 or filesystem failures.

Since 3.1.1, closing the recovery helper clears its connected label even when
the downloader is idle. The owner checks the popup once per second and when
focus/visibility returns (background browser timers may be delayed). It shows
**Открыть служебную вкладку** after closure and a loading label during navigation.
This does not change download progress or override manual pause/cooldown; queued
readiness messages from the closed helper are ignored.

## Edit the collected list (3.1.0)

After scanning, importing JSON or restoring the cache, open **Список файлов →
Просмотреть и редактировать список**. This editor contains the complete current
manifest, independently of the catalog on the left and the download filters.

- Search by filename or full path; sort by size in either direction or by path.
  Unknown sizes always sort last; approximate sizes retain the `≈` marker.
- The table shows 100 rows per page. **Отметить найденные** selects all search
  matches across pages. Selections survive search changes, and the count reports
  how many selected entries are outside the current search.
- **Удалить ссылки** removes selected entries from the current manifest.
  Deletion never deletes local files or modifies completion journals. It clears
  stale verification results and the prepared queue, so subsequent downloads use
  the edited list. Existing journal matches can still be skipped normally.
- Each deletion or undo immediately saves the edited manifest to IndexedDB.
  **Отменить удаление** restores the last batch within the current session;
  importing/restoring a list or starting a fresh scan clears this undo history.
- **Скачать JSON** and the existing **Список ссылок** both export the edited
  manifest, including an empty list. **Сохранить в кеш** can retry a failed cache
  write; if persistence is unavailable, the editor explicitly asks for JSON export.
- Mutations are blocked during active operations and automatic recovery. Pause
  the operation and let started jobs finish before editing. Fresh scanning or
  update scanning can rediscover deleted links; this is not a permanent exclusion
  list. Existing download-selection filters still apply to the remaining files.

Editor validation covers numeric sorting, bounded rendering, bulk selection,
cache restart/export, empty lists, undo, local-file preservation, paused-queue
editing and cache failure/retry. Browser checks use real dialogs, IndexedDB and
JSON downloads with offline catalog fixtures, plus desktop/mobile screenshots
in `preview-editor-desktop.png` and `preview-editor-mobile.png`.

## Workspace interface (3.0.0)

- At 1100 CSS pixels and wider, the original catalog is on the left and the
  download panel is on the right, with independent scrolling. Main scan,
  download, pause and retry actions stay at the top of the panel.
- The catalog search and entry-type filter only hide/show rows in the current
  directory. They do not change the download selection. Original links, sort
  links, metadata and DOM nodes are retained; no extra catalog requests are made.
- Download folder selection and file filters remain in **Выбор папок и фильтры**.
  JSON import/export, cache restore and fresh scanning are grouped under
  **Список файлов**. Verification/repair, archive updates, tuning and logs keep
  their dedicated sections.
- Current speed, averaged speed, successful file completions and active/allowed
  downloads have separate cards. Volume, ETA and recovery status remain below.
- Smaller screens stack the two panels. Legacy fixed widths and `nowrap` name
  cells are overridden so long filenames fit. Keyboard focus stays visible.
- The helper tab keeps its separate recovery interface. If the expected catalog
  table is absent, the download panel falls back to a floating layout.

`npm run test:ui` checks real-browser layout at 1440, 1100, 900 and 390 pixels,
preserved original DOM/links, catalog filters, keyboard order and settings.
It uses an offline fixture with legacy fixed widths, duplicate icon/name links,
sortable headers and long filenames. Screenshots are saved as
`preview-ui-desktop.png`, `preview-ui-compact.png`, `preview-ui-tablet.png` and
`preview-ui-mobile.png`. The live site presented a Cloudflare check during this
redesign; validation does not claim a live-site or installed-userscript test.

Generated screenshots mentioned in this guide are stored in `artifacts/` at
the project root and are excluded from Git.

References:
- https://www.tampermonkey.net/documentation.php
- https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker
- https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createWritable
- https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB
