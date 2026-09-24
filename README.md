# Noty Folder Downloader

A Tampermonkey userscript for downloading folders from
[noty.propovednik.com](https://noty.propovednik.com/) while preserving their
directory structure. Runs in your browser and saves to a folder you choose.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in desktop Chrome or Edge.
2. [Install the userscript](https://raw.githubusercontent.com/durck/noty-folder-downloader/main/noty-folder-downloader.user.js).
   If the script opens as text, create a new script in Tampermonkey, replace
   its contents with this file, and save. Enable userscript execution if
   Tampermonkey asks you to.
3. Open [the archive](https://noty.propovednik.com/) and navigate to a folder.
   Reload the page if it was already open.

No Node.js installation is needed to use the downloader. Its interface is in
Russian. Desktop Chrome and Edge are the supported browsers because downloads
use the File System Access API.

## Download

1. Click **1. Найти файлы** to scan the current folder and its subfolders.
2. Optionally select folders, filter formats, or edit the collected file list.
3. Click **2. Выбрать папку и скачать**, choose a destination, and allow writing.
4. Keep the main tab open. Enable the helper tab for automatic recovery and
   leave that tab open too. An interactive site check may still need your input.

The selected archive folder is created inside your destination. On Windows,
use a short parent path such as `C:\Archive` for deeply nested collections.
Pause and let active files finish before updating the userscript or reloading.

To resume an existing archive: load the cached list or import its JSON, click
**Проверить папку**, choose the same parent destination, then click
**Докачать отсутствующие / пустые**. Keep the `.noty-download-state.json` journal
with your downloaded archive.

## Features

- Parallel scanning and downloads; manual worker limits or automatic tuning.
- Cached file lists, JSON import/export, size sorting and link removal.
- Folder/format filters, verification, repair and archive update comparison.
- Bounded retries and automatic recovery without discarding queued files.
- Aggregate byte-speed and files-per-second charts, progress and time estimates.
- Catalog on the left and download controls on the right, with a narrow layout.

See the [full guide](docs/GUIDE.md) for settings, limitations and troubleshooting,
and the [changelog](CHANGELOG.md) for version history.

## Development

Use Node.js 24 or newer:

```sh
npm ci
npm run check
npm test
npx playwright install chromium
npm run test:browser
npm run test:ui
```

Browser tests use an isolated profile and offline fixtures; they do not download
the real archive. They use a locally installed Edge/Chrome when available,
otherwise Playwright Chromium. Set `BROWSER_PATH` to override the executable.
Generated screenshots, logs, dependencies and downloaded manifests are ignored.

Report reproducible problems in [Issues](https://github.com/durck/noty-folder-downloader/issues).
Include the script version and a short sanitized error log; omit personal paths
or private file lists.

## License

[MIT](LICENSE). This license covers the downloader code, not material hosted by
the archive. The project is independent of the archive operator.
