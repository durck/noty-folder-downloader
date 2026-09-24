// ==UserScript==
// @name         Noty: скачать папку целиком
// @namespace    local.noty-folder-downloader
// @version      3.2.0
// @license      MIT
// @homepageURL  https://github.com/durck/noty-folder-downloader
// @supportURL   https://github.com/durck/noty-folder-downloader/issues
// @downloadURL  https://raw.githubusercontent.com/durck/noty-folder-downloader/main/noty-folder-downloader.user.js
// @updateURL    https://raw.githubusercontent.com/durck/noty-folder-downloader/main/noty-folder-downloader.user.js
// @description  Рекурсивное скачивание любой папки нотного архива с сохранением структуры и продолжением загрузки.
// @match        https://noty.propovednik.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';
  const ORIGIN = 'https://noty.propovednik.com';
  const JOURNAL = '.noty-download-state.json';
  const SETTINGS_KEY = 'noty-folder-settings-v1';
  function normalizeSettings(input = {}) {
    const number = (key, fallback, min, max) => {
      const n = input[key] === '' ? NaN : Number(input[key]);
      return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
    };
    return { auto: input.auto !== false, autoRecover: input.autoRecover !== false, threads: number('threads', 3, 1, 12),
      maxThreads: number('maxThreads', 6, 1, 12), delayMs: number('delayMs', 150, 0, 5000),
      windowSeconds: number('windowSeconds', 10, 5, 60), gainPercent: number('gainPercent', 8, 3, 30),
      scanThreads: number('scanThreads', 3, 1, 6), scanDelayMs: number('scanDelayMs', 200, 0, 5000),
      maxRetries: number('maxRetries', 3, 0, 8), retryBaseSeconds: number('retryBaseSeconds', 2, 1, 60) };
  }
  function transient(error) { error.retryable = true; return error; }
  function isChallenge(text) {
    // JavaScript Detections are also injected into normal HTML. A reference to
    // challenge-platform (or a phrase in article text) is not an interstitial.
    const title = /<title\b[^>]*>\s*(?:Just a moment[.!…]*|Выполнение проверки безопасности[^<]*)\s*<\/title>/i.test(text);
    return /(?:window\.)?_cf_chl_opt\s*=/.test(text) ||
      (title && /noindex|\bid\s*=\s*["'](?:challenge-form|challenge-error-text)|\/challenge-platform\/[^"']*\/orchestrate\//i.test(text));
  }
  function htmlDocumentPath(path) { return /\.(?:html?|php)$/i.test(path); }
  function macMetadataPath(path) {
    const name = path.split('/').at(-1);
    return name === '.DS_Store' || (name.startsWith('._') && name.length > 2);
  }
  function htmlRecoveryTarget(url) {
    try {
      const parsed = new URL(url);
      return parsed.origin === ORIGIN && parsed.pathname.startsWith('/Public/') && htmlDocumentPath(parsed.pathname) ? parsed.href : null;
    } catch { return null; }
  }
  function challengeError(delay = 30000, url = '', evidence = 'признаки страницы проверки в HTML') {
    return Object.assign(new Error('Cloudflare: сайт запросил проверку браузера. Если ожидание не помогает, открой ссылку «Открыть сайт для проверки» и пройди проверку в том же браузере.'),
      { stop: true, challenge: true, retryMs: delay, url, evidence });
  }
  function recoveryDelay(attempt, retryMs = 0) {
    return Math.max(retryMs, Math.min(300000, 30000 * 2 ** Math.max(0, attempt - 1)));
  }
  function directoryReady(doc) {
    const headings = [...doc.querySelectorAll('table th, table td')].map(cell => cell.textContent.trim());
    return headings.some(t => /^File name/i.test(t)) && headings.some(t => /^Size/.test(t));
  }
  async function networkOperation(operation) {
    try { return await operation(); }
    catch (e) { e.networkFailure = true; throw transient(e); }
  }
  async function diskOperation(action, path, operation, missingIsNormal = false, itemName = false) {
    try { return await operation(); }
    catch (cause) {
      if (missingIsNormal && cause.name === 'NotFoundError') return null;
      // Only an explicit archive file/directory name rejection is item-local.
      // Keep unknown disk errors and every journal failure as global stops.
      const rejectedName = itemName && cause.name === 'TypeError' &&
        /(?:^|:\s*)Name is not allowed\.$/.test(cause.message || '');
      let hint = 'Проверь доступ к папке и свободное место; закрой другие загрузки в неё.';
      if (rejectedName) {
        hint = (itemName === 'directory' ? 'Браузер запретил имя папки.' : 'Браузер запретил имя или тип этого файла.') +
          ' Файл не сохранён; отказ останется в отчёте, остальные файлы могут скачиваться.';
      } else if (['NotFoundError', 'InvalidStateError'].includes(cause.name)) {
        hint = 'Папка могла стать недоступна, либо путь слишком длинный. В Windows выбери короткую родительскую папку (например, C:\\N): браузеру нужен запас для временного файла .crswap. После переноса архива вместе с журналом снова нажми «Проверить папку» и выбери нового родителя.';
      }
      const error = new Error(`Локальная файловая система: ${action}. ${cause.name || 'Error'}: ${cause.message}\nПуть внутри выбранной папки: ${path}\n${hint}`, { cause });
      error.stop = !rejectedName;
      throw error;
    }
  }
  function backoffMs(attempt, baseSeconds, random = Math.random) {
    return Math.round(Math.min(60000, baseSeconds * 1000 * 2 ** (attempt - 1) * (0.8 + random() * 0.4)));
  }
  async function withRetries(operation, { settings, paused, onRetry = () => {}, onWaitEnd = () => {},
    now = () => performance.now(), wait = ms => new Promise(resolve => setTimeout(resolve, ms)), random = Math.random }) {
    let retried = 0;
    for (;;) {
      try { return await operation(); }
      catch (error) {
        if (error.stop || !error.retryable || retried >= settings().maxRetries) throw error;
        const pauseError = () => Object.assign(new Error('Повтор на паузе'), { pausedRetry: true });
        if (paused()) throw pauseError();
        const delay = backoffMs(++retried, settings().retryBaseSeconds, random);
        const deadline = now() + delay;
        onRetry(error, retried, delay);
        try {
          while (now() < deadline) {
            if (paused()) throw pauseError();
            await wait(Math.min(200, deadline - now()));
          }
          if (paused()) throw pauseError();
          // A settings change can disable or reduce retries during the wait.
          if (retried > settings().maxRetries) throw error;
        } finally { onWaitEnd(); }
      }
    }
  }
  function retryDelay(value, now = Date.now()) {
    if (!value) return 30000;
    const seconds = Number(value);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
    return Number.isFinite(delay) ? Math.max(30000, delay) : 30000;
  }
  function parseSizeBytes(value) {
    if (typeof value !== 'string') return null;
    const text = value.trim().replace(/[\u00a0\u202f]/g, ' ');
    const match = text.match(/^([\d., ]+)\s*(bytes?|байт(?:а|ов)?|[kmgtкмгт](?:[iи]?[bб])?|b|б)?$/i);
    if (!match) return null;
    let number = match[1].trim();
    const unit = (match[2] || 'b').toLowerCase();
    const power = { k: 1, к: 1, m: 2, м: 2, g: 3, г: 3, t: 4, т: 4 }[unit[0]] || 0;
    // Byte counts use grouping; larger units also accept a decimal comma.
    if (/^\d{1,3}(?:[ ,.]\d{3})+$/.test(number) && power === 0) number = number.replace(/[ ,.]/g, '');
    else {
      if (number.includes(' ') && !/^\d{1,3}(?: \d{3})+(?:[.,]\d+)?$/.test(number)) return null;
      number = number.replace(/ /g, '').replace(',', '.');
      if (!/^\d+(?:\.\d+)?$/.test(number)) return null;
    }
    const bytes = Math.round(Number(number) * 1024 ** power);
    return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
  }
  function listingSize(link) {
    const table = link.closest('table'), row = link.closest('tr');
    if (!table || !row) return { sizeBytes: null };
    let column = -1;
    for (const headerRow of table.rows) {
      let index = 0;
      for (const cell of headerRow.cells) {
        if (/^Size$/i.test(cell.textContent.trim())) { column = index; break; }
        index += cell.colSpan || 1;
      }
      if (column >= 0) break;
    }
    let index = 0;
    for (const cell of row.cells) {
      const end = index + (cell.colSpan || 1);
      if (column >= index && column < end) {
        // Prefer an exact byte count exposed in a tooltip over rounded display text.
        const title = cell.getAttribute('title') || cell.querySelector('[title]')?.getAttribute('title') || '';
        const exact = /(?:bytes?|байт(?:а|ов)?)\s*$/i.test(title) ? parseSizeBytes(title) : null;
        const sizeText = cell.textContent.trim();
        return { sizeBytes: exact ?? parseSizeBytes(sizeText), sizeText };
      }
      index = end;
    }
    return { sizeBytes: null };
  }
  function validSize(value) { return Number.isSafeInteger(value) && value >= 0; }
  function transferTotals(files, completed = new Set(), loaded = new Map()) {
    let total = 0, processed = 0, remaining = 0, unknown = 0, pending = 0;
    for (const file of files) {
      const done = completed.has(file.path);
      if (!done) pending++;
      if (!validSize(file.sizeBytes)) { if (!done) unknown++; continue; }
      total += file.sizeBytes;
      const bytes = done ? file.sizeBytes : Math.max(0, Math.min(file.sizeBytes, loaded.get(file.path) || 0));
      processed += bytes; remaining += file.sizeBytes - bytes;
    }
    return { total, processed, remaining, unknown, pending };
  }
  function formatBytes(bytes) {
    const units = ['Б', 'КиБ', 'МиБ', 'ГиБ', 'ТиБ'];
    let index = 0;
    while (bytes >= 1024 && index < units.length - 1) { bytes /= 1024; index++; }
    return `${bytes.toLocaleString('ru-RU', { maximumFractionDigits: index ? 2 : 0 })} ${units[index]}`;
  }
  function formatRate(bytes) { return formatBytes(Math.max(0, bytes)) + '/с'; }
  function queueEstimate(files, completed, loaded, byteRate, fileRate, recentSizes = []) {
    const pending = files.filter(file => !completed.has(file.path));
    const totals = transferTotals(pending, new Set(), loaded);
    if (!pending.length || totals.unknown) return null;
    const small = size => validSize(size) && size <= 256 * 1024;
    // Completion rate includes writing and journal commit. Extrapolate it only
    // to a similar small-file workload; never apply tiny-file rates to large PDFs.
    if (fileRate > 0 && recentSizes.length >= 5 && recentSizes.every(small) && pending.every(file => small(file.sizeBytes))) {
      const recentMean = recentSizes.reduce((sum, size) => sum + size, 0) / recentSizes.length;
      const pendingMean = pending.reduce((sum, file) => sum + file.sizeBytes, 0) / pending.length;
      if (recentMean > 0 && pendingMean >= recentMean / 2 && pendingMean <= recentMean * 2)
        return { seconds: pending.length / fileRate, method: 'files' };
    }
    return byteRate > 0 && totals.remaining > 0 ? { seconds: totals.remaining / byteRate, method: 'bytes' } : null;
  }
  function formatDuration(seconds) {
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    if (minutes < 60) return `${minutes} мин`;
    const hours = Math.floor(minutes / 60), rest = minutes % 60;
    if (hours < 24) return `${hours} ч${rest ? ' ' + rest + ' мин' : ''}`;
    return `${Math.floor(hours / 24)} д ${hours % 24} ч`;
  }
  class SpeedMeter {
    constructor() { this.samples = []; this.elapsed = 0; this.idle = 0; }
    observe(bytes, ms) {
      if (ms <= 0 || ms > 5000 || bytes < 0) { this.samples = []; this.elapsed = 0; this.idle = 0; return 0; }
      this.samples.push({ bytes, ms }); this.elapsed += ms;
      this.idle = bytes > 0 ? 0 : this.idle + ms;
      while (this.samples.length > 1 && this.elapsed - this.samples[0].ms >= 30000) this.elapsed -= this.samples.shift().ms;
      if (this.elapsed < 3000 || this.idle >= 10000) return 0;
      return this.samples.reduce((sum, sample) => sum + sample.bytes, 0) * 1000 / this.elapsed;
    }
  }
  function serialWriter() {
    let tail = Promise.resolve();
    return job => {
      const result = tail.then(job);
      tail = result.catch(() => {});
      return result;
    };
  }
  class AutoTuner {
    constructor(settings, now = 0, initial = 1) {
      this.settings = normalizeSettings(settings);
      this.limit = Math.min(this.settings.maxThreads, Math.max(1, initial));
      this.explorations = 0;
      this.resetWindow(now);
    }
    clearWindow(now) {
      this.frames = []; this.windows = [];
      this.warmUntil = now + Math.min(2000, this.settings.windowSeconds * 500);
    }
    resetWindow(now) {
      // A pause, error or new run invalidates comparisons, not the chosen limit.
      this.phase = 'baseline'; this.probe = null; this.reference = null;
      this.best = { threads: this.limit, rate: 0, fileRate: 0, metric: 'bytes' };
      this.reason = 'measuring'; this.holdUntil = now;
      this.clearWindow(now);
    }
    updateSettings(input, now) {
      const before = this.settings, next = normalizeSettings(input);
      this.settings = next;
      if (before.auto !== next.auto) {
        // Manual preference belongs to the user. Never replace it with a probe.
        this.limit = Math.min(next.maxThreads, next.auto ? next.threads : this.best.threads || this.limit);
        this.resetWindow(now); this.reason = next.auto ? 'measuring' : 'manual';
      } else if (['maxThreads', 'windowSeconds', 'gainPercent', 'delayMs'].some(key => before[key] !== next[key])) {
        this.limit = Math.min(this.limit, next.maxThreads); this.resetWindow(now);
      }
    }
    penalize(now) {
      this.limit = Math.max(1, Math.floor(this.limit / 2));
      this.resetWindow(now); this.reason = 'recovery';
    }
    suspend(reason, now) {
      if (this.reason !== reason) {
        if (reason === 'draining') {
          // A lower probe and A/B/A confirmation must survive their own drain.
          this.clearWindow(now); this.reason = reason; return;
        }
        // Do not keep an unconfirmed increase across a contaminated interval.
        if (this.probe) this.limit = this.probe.base.threads;
        this.resetWindow(now); this.reason = reason;
      }
    }
    move(limit, phase, now) {
      this.limit = Math.max(1, Math.min(this.settings.maxThreads, limit));
      this.phase = phase; this.reason = 'measuring'; this.clearWindow(now);
    }
    hold(sample, now, reason = 'stable') {
      this.best = sample; this.probe = null; this.reference = sample;
      this.holdUntil = now + Math.max(30000, this.settings.windowSeconds * 4000);
      this.move(sample.threads, 'hold', now); this.reason = reason;
    }
    startProbe(sample, next, now) {
      this.best = sample; this.probe = { base: sample, candidate: null, next };
      this.move(next, 'probe', now);
    }
    comparable(a, b) {
      if (a.metric !== b.metric) return false;
      // Avoid attributing a new population of files to the worker change.
      if (a.meanSize > 0 && b.meanSize > 0) {
        const ratio = a.meanSize / b.meanSize;
        if (ratio < 0.5 || ratio > 2) return false;
      }
      return true;
    }
    score(sample) { return sample.metric === 'files' ? sample.fileRate : sample.rate; }
    acceptable(candidate, base) {
      if (!this.comparable(candidate, base) || this.score(base) <= 0) return false;
      const gain = Math.max(this.settings.gainPercent / 100, candidate.noise, base.noise);
      const ratio = this.score(candidate) / this.score(base);
      // Mixed queues must not buy network throughput by starving completions.
      if (candidate.metric === 'bytes' && candidate.files >= 5 && base.files >= 5 && candidate.fileRate < base.fileRate * 0.75) return false;
      return candidate.threads < base.threads ? ratio >= 1 - Math.min(gain, 0.08) : ratio > 1 + gain;
    }
    summarize(frames) {
      const total = frames.reduce((a, f) => {
        for (const key of ['ms', 'bytes', 'files', 'completedBytes', 'smallFiles', 'activeMs']) a[key] += f[key];
        a.largeActive ||= f.largeActive; return a;
      }, { ms: 0, bytes: 0, files: 0, completedBytes: 0, smallFiles: 0, activeMs: 0, largeActive: false });
      return { ...total, threads: this.limit, rate: total.bytes * 1000 / total.ms,
        fileRate: total.files * 1000 / total.ms, meanSize: total.files ? total.completedBytes / total.files : 0,
        metric: total.files >= 5 && total.smallFiles === total.files && !total.largeActive ? 'files' : 'bytes',
        utilization: total.activeMs / total.ms / this.limit };
    }
    observe(bytes, elapsedMs, eligible, now, work = {}) {
      if (!this.settings.auto) { this.suspend('manual', now); return null; }
      if (!eligible) { this.suspend(work.reason || 'waiting', now); return null; }
      if (!Number.isFinite(elapsedMs) || elapsedMs <= 0 || elapsedMs > 30000) {
        this.suspend('timer-gap', now); return null;
      }
      if (this.reason === 'draining') {
        this.clearWindow(now); this.reason = 'measuring'; return null;
      }
      if (['manual', 'waiting', 'pause', 'retry', 'recovery', 'tail', 'timer-gap'].includes(this.reason)) {
        this.resetWindow(now); return null;
      }
      // Do not mix bytes that straddle a setting/worker change with its new window.
      if (now - elapsedMs < this.warmUntil) return null;
      const positive = value => Number.isFinite(value) ? Math.max(0, value) : 0;
      this.frames.push({ ms: elapsedMs, bytes: positive(bytes), files: positive(work.files),
        completedBytes: positive(work.completedBytes), smallFiles: positive(work.smallFiles),
        activeMs: Math.min(this.limit, positive(work.active ?? this.limit)) * elapsedMs,
        largeActive: !!work.largeActive });
      const window = this.summarize(this.frames);
      if (window.ms < this.settings.windowSeconds * 1000) return null;
      this.windows.push(window); this.frames = [];
      if (this.windows.length < 2) return null;
      const sample = this.summarize(this.windows);
      const value = w => sample.metric === 'files' ? w.fileRate : w.rate;
      const scores = this.windows.map(value);
      const spread = (Math.max(...scores) - Math.min(...scores)) / Math.max(1, ...scores);
      // A third window handles bursty reads; a probe never waits forever for quiet.
      if (spread > 0.25 && this.windows.length < 3) return null;
      if (this.windows.length === 3) {
        const median = [...this.windows].sort((a, b) => value(a) - value(b))[1];
        sample.rate = median.rate; sample.fileRate = median.fileRate;
      }
      sample.noise = Math.min(0.3, spread / 2); this.windows = [];
      const old = this.limit;
      if (this.phase === 'baseline') {
        this.best = sample;
        if (this.score(sample) > 0 && this.limit < this.settings.maxThreads) this.startProbe(sample, this.limit + 1, now);
        else this.hold(sample, now, this.score(sample) > 0 ? 'ceiling' : 'no-progress');
      } else if (this.phase === 'probe') {
        const base = this.probe.base;
        if (!this.comparable(sample, base)) {
          this.move(base.threads, 'baseline', now); this.probe = null; this.reason = 'workload';
        } else if (this.acceptable(sample, base)) {
          this.probe.candidate = sample;
          // A/B/A: confirm against a fresh baseline, not an obsolete peak.
          this.move(base.threads, 'confirm', now);
        } else this.hold(base, now, sample.utilization < 0.65 ? 'pacing' : 'plateau');
      } else if (this.phase === 'confirm') {
        const candidate = this.probe.candidate;
        if (this.acceptable(candidate, sample)) {
          this.best = candidate; this.probe = null;
          this.move(candidate.threads, 'baseline', now);
        } else this.hold(sample, now, 'unconfirmed');
      } else {
        const changed = !this.comparable(sample, this.best);
        const degraded = this.score(sample) < this.score(this.best) * 0.8;
        // Always refresh, including at one worker and when progress is zero.
        this.best = sample;
        if (changed) { this.move(this.limit, 'baseline', now); this.reason = 'workload'; }
        else if (degraded && this.limit > 1 && this.score(sample) > 0) this.startProbe(sample, this.limit - 1, now);
        else if (now >= this.holdUntil && this.score(sample) > 0) {
          // Occasionally look beyond a local one-step plateau, within the same cap.
          const step = ++this.explorations % 2 === 0 ? 2 : 1;
          const next = this.limit < this.settings.maxThreads ? Math.min(this.settings.maxThreads, this.limit + step) : Math.max(1, this.limit - 1);
          if (next !== this.limit) this.startProbe(sample, next, now);
          else this.hold(sample, now, 'ceiling');
        }
      }
      return { from: old, to: this.limit, rate: sample.rate, fileRate: sample.fileRate,
        metric: sample.metric, phase: this.phase, reason: this.reason };
    }
  }
  async function runPool({ queue, limit, paused, worker, complete, failed, tick = () => {},
    delayMs = () => 0, now = () => performance.now(), wait = ms => new Promise(r => setTimeout(r, ms)) }) {
    const active = new Set(); let nextStart = 0;
    try {
      while (queue.length || active.size) {
        while (!paused() && queue.length && active.size < Math.max(1, Math.min(12, limit())) && now() >= nextStart) {
          const item = queue.shift();
          // Queue ownership is transferred synchronously before any asynchronous work.
          const job = Promise.resolve().then(() => worker(item)).then(() => complete(item), e => failed(e, item))
            .finally(() => active.delete(job));
          active.add(job); nextStart = now() + delayMs();
          if (delayMs() > 0) break;
        }
        tick(active.size, queue.length);
        if (!active.size && (paused() || !queue.length)) break;
        const canStart = !paused() && queue.length && active.size < Math.max(1, Math.min(12, limit()));
        const untilStart = canStart ? Math.max(1, nextStart - now()) : 200;
        await Promise.race([...active, wait(Math.min(200, untilStart))]);
      }
    } finally { await Promise.allSettled(active); }
  }

  function validPath(value) {
    const parts = value.replace(/\/+$/, '').split('/');
    if (parts.some(p => !p || p === '.' || p === '..' || /[\\\x00-\x1f]/.test(p))) {
      throw new Error('Некорректный путь каталога');
    }
    return parts.join('/');
  }
  // The empty string denotes the archive root, not a filesystem path segment.
  function inside(path, root) { return root === '' || path === root || path.startsWith(root + '/'); }
  function descendant(path, root) { return path !== root && inside(path, root); }
  function currentRoot(url) {
    const page = new URL(url);
    if (page.origin !== ORIGIN || page.pathname !== '/') throw new Error('Открой каталог нотного архива.');
    const value = page.searchParams.get('dir');
    return value === null || value === '' ? '' : validPath(value);
  }
  function relativePath(path, root) {
    validPath(path);
    if (!descendant(path, root)) throw new Error('Файл вне выбранной папки');
    return root === '' ? path : path.slice(root.length + 1);
  }
  function folderURL(path) { return ORIGIN + '/?dir=' + encodeURIComponent(path); }
  function classifyLink(href, base, root, parent) {
    try {
      const u = new URL(href, base);
      if (u.origin !== ORIGIN || u.username || u.password || u.hash) return null;
      if (u.pathname === '/' && u.searchParams.has('dir')) {
        if ([...u.searchParams.keys()].some(k => k !== 'dir')) return null;
        const value = u.searchParams.get('dir');
        const path = value === '' ? '' : validPath(value);
        if (!inside(path, root) || !descendant(path, parent)) return null;
        return { type: 'folder', path, url: folderURL(path) };
      }
      if (!u.pathname.startsWith('/Public/') || u.search) return null;
      // Decode each segment separately, so encoded separators cannot create paths.
      const parts = u.pathname.slice('/Public/'.length).split('/').map(decodeURIComponent);
      if (parts.some(p => p.includes('/') || p.includes('\\'))) return null;
      const path = validPath(parts.join('/'));
      if (!inside(path, root) || !descendant(path, parent)) return null;
      return { type: 'file', path, url: u.href };
    } catch { return null; }
  }
  function safeName(name) {
    // Escape '%' too, making the encoding unambiguous and preserving most names.
    let out = name.replace(/[%<>:"/\\|?*\x00-\x1f]/g,
      c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
    out = out.replace(/[ .]+$/g, tail => [...tail].map(c => c === '.' ? '%2E' : '%20').join(''));
    // Chromium checks after stripping one leading dot and also rejects Windows
    // 8.3-like names containing '~'. Preserve already-valid long names.
    const checked = out.startsWith('.') ? out.slice(1) : out;
    const shortTilde = checked.includes('~') && /^[^.]{1,8}(?:\.[^.]{0,3})?$/.test(checked) &&
      !/[\s"\/\[\]:+|<>=;?,*]/u.test(checked);
    if (/^~|~$/.test(checked) || shortTilde) out = out.replace(/~/g, '%7E');
    if (/^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(out)) {
      out = '%' + out.charCodeAt(0).toString(16).toUpperCase() + out.slice(1);
    }
    if (out.length > 220) throw new Error('Слишком длинное имя: ' + name);
    return out;
  }
  function localParts(path, root) {
    return relativePath(path, root).split('/').map(safeName);
  }
  function checkCollisions(files, root) {
    const seen = new Map();
    for (const file of files) {
      const raw = relativePath(file.path, root).split('/');
      const local = localParts(file.path, root);
      if (local[0].toLowerCase() === JOURNAL) throw new Error('Имя файла совпадает с именем журнала загрузки.');
      for (let i = 1; i <= local.length; i++) {
        const key = local.slice(0, i).join('/').normalize('NFC').toLowerCase();
        const source = raw.slice(0, i).join('/') + (i === local.length ? ':file' : ':dir');
        if (seen.has(key) && seen.get(key) !== source) {
          throw new Error('Совпадение имён в Windows: ' + key + '. Выбери более узкую папку.');
        }
        seen.set(key, source);
      }
    }
  }
  function validateHeader(bytes, path, contentType) {
    const text = new TextDecoder().decode(bytes).replace(/^\uFEFF/, '').trimStart();
    const isHTMLFile = htmlDocumentPath(path);
    if (isChallenge(text)) throw challengeError();
    if (!isHTMLFile && (/text\/html/i.test(contentType) || /^<(?:!doctype|html|head|body)/i.test(text))) {
      throw new Error('Вместо файла сервер вернул HTML-страницу.');
    }
    if (/\.pdf$/i.test(path) && !text.startsWith('%PDF-')) throw new Error('Ответ не является PDF.');
  }

  function listingCell(link, heading) {
    const table = link.closest('table'), row = link.closest('tr');
    if (!table || !row) return null;
    let column = -1;
    for (const tr of table.rows) {
      let index = 0;
      for (const cell of tr.cells) {
        if (heading.test(cell.textContent.trim())) { column = index; break; }
        index += cell.colSpan || 1;
      }
      if (column >= 0) break;
    }
    let index = 0;
    for (const cell of row.cells) {
      if (column >= index && column < index + (cell.colSpan || 1)) return cell;
      index += cell.colSpan || 1;
    }
    return null;
  }
  function remoteMetadata(input = {}) {
    const data = input.remote || input;
    return { sizeBytes: validSize(data.sizeBytes) ? data.sizeBytes : null,
      sizeExact: data.sizeExact === true,
      sizeText: typeof data.sizeText === 'string' ? data.sizeText.slice(0, 100) : '',
      modified: typeof data.modified === 'string' && !/^[\s?—-]*$/.test(data.modified) ? data.modified.trim().slice(0, 100) : '' };
  }
  function listingMetadata(link) {
    const size = listingSize(link), cell = listingCell(link, /^Size$/i);
    const title = cell?.getAttribute('title') || cell?.querySelector('[title]')?.getAttribute('title') || '';
    const sizeExact = validSize(size.sizeBytes) &&
      ((/(?:bytes?|байт(?:а|ов)?)\s*$/i.test(title) && parseSizeBytes(title) !== null) || /^[\d.,\s\u00a0\u202f]+(?:bytes?|байт(?:а|ов)?|b|б)?$/i.test(size.sizeText || ''));
    const modified = listingCell(link, /^(Last (?:updated|modified)|Modified|Date)$/i)?.textContent.trim() || '';
    return { ...size, remote: remoteMetadata({ ...size, sizeExact, modified }) };
  }
  function compareRemote(before, after) {
    const a = remoteMetadata(before), b = remoteMetadata(after);
    if (a.modified && b.modified && a.modified !== b.modified) return 'changed';
    if (validSize(a.sizeBytes) && validSize(b.sizeBytes) && a.sizeBytes !== b.sizeBytes) return 'changed';
    if (validSize(a.sizeBytes) && validSize(b.sizeBytes) && a.sizeBytes === b.sizeBytes && a.modified && b.modified) return 'unchanged';
    return 'uncertain';
  }
  function compareManifests(previous, files, complete = true) {
    if (!previous) return [];
    const old = new Map(previous.files.map(f => [f.path, f]));
    const changes = files.map(file => {
      const before = old.get(file.path); old.delete(file.path);
      return { path: file.path, status: before ? compareRemote(before, file) : 'added',
        before: before ? remoteMetadata(before) : null, after: remoteMetadata(file) };
    });
    if (complete) for (const file of old.values()) changes.push({ path: file.path, status: 'removed', before: remoteMetadata(file), after: null });
    return changes;
  }
  function normalizeFilters(input = {}) {
    const text = key => typeof input[key] === 'string' ? input[key].slice(0, 1000) : '';
    const n = Number(input.maxMiB);
    return { include: text('include'), exclude: text('exclude'), query: text('query'),
      maxMiB: Number.isFinite(n) && n > 0 ? Math.min(n, 1048576) : 0, unknown: input.unknown !== false };
  }
  function extensionSet(text) { return new Set(text.toLowerCase().split(/[\s,;]+/).filter(Boolean).map(x => x.replace(/^\*?\./, ''))); }
  function matchesFilter(file, filters) {
    const name = file.path.split('/').at(-1).toLowerCase();
    const extension = name.includes('.') && !name.endsWith('.') ? name.split('.').at(-1) : '-';
    const include = extensionSet(filters.include), exclude = extensionSet(filters.exclude);
    if (include.size && !include.has(extension)) return false;
    if (exclude.has(extension) || !file.path.toLowerCase().includes(filters.query.toLowerCase())) return false;
    if (!validSize(file.sizeBytes)) return filters.unknown;
    return !filters.maxMiB || file.sizeBytes <= filters.maxMiB * 1048576;
  }
  function normalizeView(input = {}, root) {
    const selection = [];
    if (Array.isArray(input.folders)) for (const entry of input.folders.slice(0, 100000)) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string' || typeof entry[1] !== 'boolean') continue;
      try { if ((entry[0] === '' || validPath(entry[0]) === entry[0]) && inside(entry[0], root)) selection.push(entry); } catch { /* Ignore invalid preferences. */ }
    }
    const files = Array.isArray(input.files) ? [...new Set(input.files.slice(0, 250000).filter(path => {
      try { return typeof path === 'string' && validPath(path) === path && descendant(path, root); } catch { return false; }
    }))] : null;
    return { folders: [...new Map(selection)], files, filters: normalizeFilters(input.filters || {}) };
  }
  function folderSelected(path, view) {
    let enabled = true, length = -1;
    for (const [folder, value] of view.folders) if (inside(path, folder) && folder.length > length) { enabled = value; length = folder.length; }
    return enabled;
  }
  function selectFiles(files, view) {
    const subset = view.files === null ? null : new Set(view.files);
    return files.filter(file => folderSelected(file.path, view) && (!subset || subset.has(file.path)) && matchesFilter(file, view.filters));
  }
  function folderTree(files, root, view) {
    const nodes = new Map([[root, { path: root, count: 0, checked: 0, selected: 0, bytes: 0, unknown: 0 }]]);
    const chosen = new Set(selectFiles(files, view).map(f => f.path));
    for (const file of files) {
      const parts = relativePath(file.path, root).split('/');
      const parents = [root]; let path = root;
      for (const part of parts.slice(0, -1)) { path = path ? path + '/' + part : part; parents.push(path); }
      for (const parent of parents) {
        if (!nodes.has(parent)) nodes.set(parent, { path: parent, count: 0, checked: 0, selected: 0, bytes: 0, unknown: 0 });
        const node = nodes.get(parent); node.count++;
        if (folderSelected(file.path, view)) node.checked++;
        if (chosen.has(file.path)) { node.selected++; if (validSize(file.sizeBytes)) node.bytes += file.sizeBytes; else node.unknown++; }
      }
    }
    return [...nodes.values()].sort((a, b) => a.path.localeCompare(b.path));
  }
  function verifyFile(file, root, local, record) {
    if (!local) return 'missing';
    if (local.size === 0) return 'incomplete';
    const relative = localParts(file.path, root).join('/');
    if (record && record.path === relative && validSize(record.size)) {
      if (record.size !== local.size) return 'mismatch';
      if (record.remote && compareRemote({ remote: record.remote }, file) === 'changed') return 'changed';
      const remote = remoteMetadata(file);
      if (remote.sizeExact && validSize(remote.sizeBytes) && remote.sizeBytes !== local.size) return 'changed';
      return 'verified';
    }
    const remote = remoteMetadata(file);
    if (remote.sizeExact && validSize(remote.sizeBytes) && remote.sizeBytes !== local.size) return 'mismatch';
    return 'uncertain';
  }
  function sameLocal(file, stamp) {
    return file.size === stamp.size && (file.lastModified ?? null) === stamp.lastModified;
  }
  class History {
    constructor(limit = 180) { this.limit = limit; this.points = []; }
    add(point) { this.points.push(point); if (this.points.length > this.limit) this.points.splice(0, this.points.length - this.limit); }
  }

  function listManifestFiles(files, query = '', sort = 'size-desc') {
    const needle = query.trim().toLocaleLowerCase();
    return [...files].filter(item => !needle || item.path.toLocaleLowerCase().includes(needle)).sort((a, b) => {
      const byPath = () => a.path.localeCompare(b.path, 'ru', { numeric: true });
      if (sort === 'path') return byPath();
      const aKnown = validSize(a.sizeBytes), bKnown = validSize(b.sizeBytes);
      if (aKnown !== bKnown) return aKnown ? -1 : 1;
      return (aKnown ? (a.sizeBytes - b.sizeBytes) * (sort === 'size-asc' ? 1 : -1) : 0) || byPath();
    });
  }
  function validateManifest(data) {
    if (!data || typeof data.root !== 'string' || !Array.isArray(data.files) || data.files.length > 250000) {
      throw new Error('Нужен список noty-files.json с полями root и files.');
    }
    if (data.version !== undefined && data.version !== 2) throw new Error('Версия списка не поддерживается.');
    const scope = data.root === '' ? '' : validPath(data.root);
    const files = new Map();
    for (const entry of data.files) {
      if (!entry || typeof entry.url !== 'string' || typeof entry.path !== 'string') throw new Error('Некорректная запись файла.');
      const item = classifyLink(entry.url, folderURL(scope), scope, scope);
      if (!item || item.type !== 'file' || item.path !== entry.path) throw new Error('Недопустимая ссылка или путь: ' + entry.path);
      item.sizeBytes = validSize(entry.sizeBytes) ? entry.sizeBytes : null;
      if (typeof entry.sizeText === 'string') item.sizeText = entry.sizeText.slice(0, 100);
      item.remote = remoteMetadata(entry);
      if (!files.has(item.path)) files.set(item.path, item);
    }
    checkCollisions([...files.values()], scope);
    const folders = values => {
      if (!Array.isArray(values) || values.length > 100000) throw new Error('Некорректная очередь папок.');
      return [...new Set(values.map(value => {
        if (typeof value !== 'string') throw new Error('Некорректная папка.');
        const path = value === '' ? '' : validPath(value);
        if (path !== value || !inside(path, scope)) throw new Error('Папка вне выбранного раздела.');
        return path;
      }))];
    };
    const legacy = data.version === undefined;
    const visited = legacy ? [] : folders(data.visited);
    const seen = new Set(visited);
    const pending = legacy ? [] : folders(data.pending).filter(p => !seen.has(p));
    if (!legacy && (typeof data.scanned !== 'boolean' || (data.scanned && pending.length))) {
      throw new Error('Несогласованное состояние обхода.');
    }
    if (!legacy && !data.scanned && !pending.length) pending.push(scope);
    let previous = null;
    if (data.previous && data.previous.root === scope) {
      const clean = validateManifest({ root: scope, files: data.previous.files, generatedAt: data.previous.generatedAt });
      previous = { root: scope, files: clean.files, generatedAt: clean.generatedAt };
    }
    return { version: 2, root: scope, files: [...files.values()], visited, pending, previous,
      view: data.view ? normalizeView(data.view, scope) : null,
      scanned: legacy || data.scanned, legacy: legacy || data.legacy === true,
      generatedAt: typeof data.generatedAt === 'string' ? data.generatedAt : '' };
  }

  // Resolve writes only after the transaction commits. A failed cache never blocks downloads.
  function cacheRequest(factory, key, value) {
    return new Promise((resolve, reject) => {
      let db, tx, finished = false;
      const finish = (error, result) => {
        if (finished) return;
        finished = true; clearTimeout(timer); db?.close();
        if (error) reject(error); else resolve(result);
      };
      const timer = setTimeout(() => {
        try { tx?.abort(); } catch { /* The transaction may already have ended. */ }
        finish(new Error('Кеш: превышено время ожидания.'));
      }, 8000);
      try {
        if (!factory) throw new Error('Кеш браузера недоступен. Можно сохранить и загрузить JSON.');
        const open = factory.open('noty-folder-cache', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('lists');
        open.onerror = () => finish(open.error);
        open.onblocked = () => finish(new Error('Кеш занят другой вкладкой.'));
        open.onsuccess = () => {
          db = open.result;
          if (finished) { db.close(); return; }
          db.onversionchange = () => db.close();
          try {
            tx = db.transaction('lists', value === undefined ? 'readonly' : 'readwrite');
            const store = tx.objectStore('lists');
            const request = value === undefined ? store.get(key) : store.put(value, key);
            tx.oncomplete = () => finish(null, request.result);
            tx.onabort = () => finish(tx.error || new Error('Запись кеша отменена.'));
            tx.onerror = () => finish(tx.error || new Error('Ошибка кеша.'));
          } catch (e) { finish(e); }
        };
      } catch (e) { finish(e); }
    });
  }

  // Export the pure boundary and validation logic for offline regression tests.
  if (typeof module === 'object' && module.exports) {
    module.exports = { validPath, inside, currentRoot, classifyLink, safeName, localParts, checkCollisions, validateHeader,
      normalizeSettings, retryDelay, recoveryDelay, directoryReady, serialWriter, AutoTuner, runPool, validateManifest, cacheRequest, listManifestFiles,
      parseSizeBytes, listingSize, transferTotals, formatBytes, formatDuration, formatRate, queueEstimate, SpeedMeter,
      backoffMs, withRetries, remoteMetadata, listingMetadata, compareRemote, compareManifests, macMetadataPath,
      normalizeFilters, normalizeView, matchesFilter, folderSelected, selectFiles, folderTree, verifyFile, sameLocal, History };
    return;
  }
  if (location.origin !== ORIGIN || document.querySelector('#noty-folder-helper, #noty-helper-status')) return;
  const helperStorageKey = 'noty-helper-context-v1';
  const helperParams = new URL(location.href).searchParams;
  let helperContext = helperParams.get('noty_helper') ? {
    token: helperParams.get('noty_helper'), channel: helperParams.get('noty_channel'),
    revision: Number(helperParams.get('noty_revision') || 0), savedAt: Date.now()
  } : null;
  if (!helperContext) {
    const candidates = [];
    try { candidates.push(JSON.parse(sessionStorage.getItem(helperStorageKey))); } catch { /* Storage may be disabled. */ }
    try { if (window.name.startsWith('noty-helper:')) candidates.push(JSON.parse(window.name.slice(12))); } catch { /* Ignore unrelated window names. */ }
    helperContext = candidates.filter(value => value && typeof value.token === 'string' && value.token.length > 0 && value.token.length < 200 &&
      typeof value.channel === 'string' && value.channel.startsWith('noty-recovery-') &&
      Number.isFinite(value.savedAt) && value.savedAt > Date.now() - 86400000 && value.savedAt <= Date.now() + 60000)
      .sort((a, b) => b.savedAt - a.savedAt)[0];
  }
  if (helperContext) {
    helperContext.revision = Number.isSafeInteger(helperContext.revision) ? helperContext.revision : 0;
    try { sessionStorage.setItem(helperStorageKey, JSON.stringify(helperContext)); } catch { /* Window name remains a fallback. */ }
    const helperChannel = helperContext.channel?.startsWith('noty-recovery-') && typeof BroadcastChannel === 'function'
      ? new BroadcastChannel(helperContext.channel) : null;
    const announce = (type, extra = {}) => {
      const message = { type, token: helperContext.token, protocol: 2, revision: helperContext.revision, ...extra };
      helperChannel?.postMessage(message);
      if (type === 'noty-directory-ready') {
        try { window.opener?.postMessage(message, ORIGIN); } catch { /* COOP can sever the opener. */ }
      }
    };
    if (helperChannel) {
      helperChannel.onmessage = event => {
        const data = event.data;
        if (event.origin !== ORIGIN || data?.token !== helperContext.token) return;
        if (data.type === 'noty-helper-ping') { announce('noty-helper-alive', { nonce: data.nonce }); return; }
        if (data.type !== 'noty-helper-refresh' || !Number.isSafeInteger(data.revision) || data.revision <= helperContext.revision) return;
        try {
          const target = new URL(data.target);
          if (target.origin !== ORIGIN || target.username || target.password || target.hash) return;
          if (target.pathname === '/') {
            currentRoot(target.href);
            if ([...target.searchParams.keys()].some(key => key !== 'dir')) return;
          } else if (!htmlRecoveryTarget(target.href) || !classifyLink(target.href, folderURL(''), '', '')) return;
          helperContext = { ...helperContext, revision: data.revision, target: target.href, savedAt: Date.now() };
          const context = JSON.stringify(helperContext);
          try { sessionStorage.setItem(helperStorageKey, context); } catch { /* Window name remains a fallback. */ }
          window.name = 'noty-helper:' + context;
          if (target.pathname === '/') {
            target.searchParams.set('noty_helper', helperContext.token);
            target.searchParams.set('noty_channel', helperContext.channel);
            target.searchParams.set('noty_revision', String(helperContext.revision));
          }
          announce('noty-helper-alive', { navigating: true });
          location.replace(target.href);
        } catch { /* Reject invalid navigation messages without changing the queue. */ }
      };
      announce('noty-helper-alive');
      window.addEventListener('pagehide', () => helperChannel.close(), { once: true });
    }
    const hasContent = !!document.body?.textContent.trim() || !!document.body?.querySelector('img, audio, video, object');
    const badge = document.createElement('div'); badge.id = 'noty-helper-status'; badge.setAttribute('role', 'status');
    badge.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;max-width:360px;padding:16px;background:white;border:1px solid #bacbd8;border-radius:12px;font:15px/1.5 system-ui;color:#172634';
    badge.textContent = 'Служебная вкладка Noty. Ожидаю полной загрузки страницы проверки. Оставь эту вкладку открытой.';
    document.body.append(badge);
    let notified = false;
    const notifyReady = () => {
      const target = htmlRecoveryTarget(helperContext.target);
      const contentReady = target ? location.href === target && hasContent : location.pathname === '/' && directoryReady(document);
      if (!notified && document.readyState === 'complete' && contentReady && !isChallenge(document.documentElement.outerHTML)) {
        notified = true;
        announce('noty-directory-ready');
        document.title = 'Noty: страница загрузилась';
        badge.textContent = 'Служебная вкладка Noty. Страница загрузилась. Доступ к файлу ещё не подтверждён; статус и время следующей попытки — в основной вкладке. Оставь обе вкладки открытыми.';
      }
    };
    window.addEventListener('load', notifyReady, { once: true }); notifyReady();
    return;
  }

  // Archive HTML is only a recovery surface when this tab has a helper context.
  if (location.pathname !== '/') return;
  function mountCatalogWorkspace(panelHost) {
    const table = [...document.querySelectorAll('table')].find(candidate => {
      const headings = [...candidate.rows].flatMap(row => [...row.cells].map(cell => cell.textContent.trim()));
      return headings.some(text => /^File name/i.test(text)) && headings.some(text => /^Size$/.test(text));
    });
    if (!table) {
      panelHost.style.cssText += ';position:fixed;top:16px;right:16px;width:min(500px,calc(100vw - 32px));height:calc(100vh - 32px);z-index:2147483646';
      return;
    }
    const original = [...document.body.childNodes].filter(node => node !== panelHost &&
      !(node.nodeType === 1 && ['SCRIPT', 'STYLE', 'LINK'].includes(node.tagName)));
    const shell = document.createElement('div'); shell.id = 'noty-workspace';
    shell.innerHTML = `<header class="noty-app-head"><div class="noty-brand"><span class="noty-brand-mark" aria-hidden="true">♫</span><div><span class="noty-kicker">МУЗЫКАЛЬНАЯ БИБЛИОТЕКА</span><h1>Нотный архив</h1></div></div><span class="noty-app-caption">Каталог и загрузки <span>3.2</span></span></header>
      <main class="noty-columns"><section class="noty-catalog" aria-labelledby="noty-catalog-title"><div class="noty-catalog-head"><div class="noty-catalog-heading"><div><span class="noty-kicker">ОБЗОР АРХИВА</span><h2 id="noty-catalog-title">Каталог файлов</h2></div><span id="noty-catalog-count" role="status"></span></div>
      <div class="noty-catalog-tools"><label class="noty-search"><span aria-hidden="true">⌕</span><input id="noty-catalog-search" type="search" placeholder="Найти в этой папке" aria-label="Найти в открытой папке"></label><select id="noty-catalog-kind" aria-label="Тип записей каталога"><option value="all">Все записи</option><option value="folder">Папки</option><option value="file">Файлы</option></select></div></div>
      <div id="noty-catalog-content"></div><p id="noty-catalog-empty" hidden>Ничего не найдено. Измени запрос или тип записей.</p><footer class="noty-catalog-foot">Открой папку, чтобы перейти к её содержимому. Выбор для скачивания — в панели справа.</footer></section><aside id="noty-download-column" aria-label="Управление загрузками"></aside></main>`;
    const content = shell.querySelector('#noty-catalog-content');
    for (let parent = table.parentElement; parent && parent !== document.body; parent = parent.parentElement) parent.classList.add('noty-catalog-ancestor');
    content.append(...original);
    for (const heading of content.querySelectorAll('h1,h2,h3')) {
      if (/Нотный архив христианской музыки/i.test(heading.textContent)) heading.classList.add('noty-source-title');
    }
    table.classList.add('noty-file-table');
    const entries = [];
    for (const row of table.rows) {
      const nameHeader = [...row.cells].find(cell => /^File name/i.test(cell.textContent.trim()));
      if (nameHeader) { row.classList.add('noty-table-head'); nameHeader.classList.add('noty-name-cell'); continue; }
      const link = [...row.querySelectorAll('a[href]')].find(a => {
        if (!a.textContent.trim()) return false;
        try { const url = new URL(a.href); return url.origin === ORIGIN &&
          (url.pathname.startsWith('/Public/') || (url.pathname === '/' && !url.searchParams.has('sort_by'))); }
        catch { return false; }
      });
      if (!link) continue;
      const url = new URL(link.href), parent = /^\s*(?:\.\.|Root|Parent Directory)\s*$/i.test(link.textContent);
      const kind = url.pathname.startsWith('/Public/') ? 'file' : 'folder';
      row.classList.add('noty-entry', parent ? 'noty-parent-entry' : 'noty-' + kind);
      link.classList.add('noty-entry-link');
      link.closest('td')?.classList.add('noty-name-cell');
      entries.push({ row, kind, parent, text: row.textContent.toLocaleLowerCase() });
    }
    for (const cell of table.querySelectorAll('th,td')) {
      const labels = { 'File name': 'Название', 'Size': 'Размер', 'Last updated': 'Изменён' };
      const label = labels[cell.textContent.trim()];
      if (label) {
        const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
        let node; while ((node = walker.nextNode())) if (node.textContent.trim()) { node.textContent = label; break; }
      }
    }
    const search = shell.querySelector('#noty-catalog-search'), kind = shell.querySelector('#noty-catalog-kind');
    const filter = () => {
      const query = search.value.trim().toLocaleLowerCase(); let visible = 0;
      const count = entries.filter(entry => !entry.parent).length;
      for (const entry of entries) {
        const show = entry.parent || ((!query || entry.text.includes(query)) && (kind.value === 'all' || kind.value === entry.kind));
        entry.row.hidden = !show; if (show && !entry.parent) visible++;
      }
      shell.querySelector('#noty-catalog-count').textContent = `${visible} / ${count} записей`;
      shell.querySelector('#noty-catalog-empty').hidden = visible > 0;
    };
    search.addEventListener('input', filter); kind.addEventListener('change', filter); filter();
    const style = document.createElement('style'); style.id = 'noty-workspace-style';
    style.textContent = `
      body.noty-app{margin:0!important;padding:0!important;background:#f2f5f4!important;color:#20343d!important;font:14px/1.5 'Segoe UI',system-ui,sans-serif!important;text-align:left!important;overflow:hidden}
      #noty-workspace{box-sizing:border-box;width:100%;max-width:2160px;margin:0 auto;padding:0 28px 24px;color:#20343d}#noty-workspace *{box-sizing:border-box}.noty-app-head{height:104px;display:flex;align-items:center;justify-content:space-between;gap:20px}.noty-brand{display:flex;align-items:center;gap:14px}.noty-brand-mark{display:grid;place-items:center;width:48px;height:48px;border-radius:15px;background:#176b60;color:#fff;font:30px Georgia,serif}.noty-kicker{display:block;font:700 10px/1.5 'Segoe UI',system-ui,sans-serif;letter-spacing:1.7px;color:#7b9095;margin-bottom:5px}.noty-brand h1{font:700 25px/1.2 'Segoe UI',system-ui,sans-serif;letter-spacing:-.8px;margin:0;color:#20343d}.noty-app-caption{font:12px 'Segoe UI',system-ui,sans-serif;color:#6d8389}.noty-app-caption span{border:1px solid #d5e1df;border-radius:6px;font-size:10px;padding:3px 6px;margin-left:10px}
      .noty-columns{display:grid;grid-template-columns:minmax(0,1fr) minmax(440px,500px);gap:24px;height:calc(100dvh - 128px);min-height:0}.noty-catalog{min-width:0;display:flex;flex-direction:column;overflow:hidden;border:1px solid #dce5e6;border-radius:20px;background:white;box-shadow:0 8px 28px #18383b06}.noty-catalog-head{padding:25px 26px 20px;border-bottom:1px solid #e8eeee}.noty-catalog-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px}.noty-catalog-heading h2{font:650 23px/1.2 'Segoe UI',system-ui,sans-serif;letter-spacing:-.6px;margin:0;color:#20343d}#noty-catalog-count{font-size:11px;color:#6c8389;background:#f1f6f5;border-radius:99px;padding:6px 10px;white-space:nowrap}.noty-catalog-tools{display:flex;gap:10px}.noty-search{display:flex;gap:9px;align-items:center;min-width:0;flex:1;background:#f6f8f8;border:1px solid #dce6e5;border-radius:10px;padding:0 12px;color:#78908f}.noty-search span{font-size:24px}#noty-catalog-search{border:0;background:transparent;outline:none;min-width:0;width:100%;padding:10px 0;font:13px 'Segoe UI',system-ui,sans-serif;color:#20343d}#noty-catalog-kind{border:1px solid #dce6e5;border-radius:10px;padding:10px;background:white;color:#49616b;font:12px 'Segoe UI',system-ui,sans-serif;max-width:140px}.noty-search:focus-within{outline:3px solid #91c8bd;outline-offset:2px}
      #noty-catalog-content{flex:1;min-height:0;overflow:auto;padding:18px 26px 26px;overscroll-behavior:contain;scrollbar-width:thin;font:13px/1.6 'Segoe UI',system-ui,sans-serif;text-align:left;color:#49616b}#noty-catalog-content .noty-catalog-ancestor{width:100%!important;max-width:100%!important;min-width:0!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important;text-align:left!important}#noty-catalog-content .noty-source-title{display:none!important}
      #noty-catalog-content .noty-file-table{border:0!important;border-collapse:collapse!important;border-spacing:0!important;width:100%!important;table-layout:auto!important;margin:15px 0!important;font:13px/1.55 'Segoe UI',system-ui,sans-serif!important;text-align:left!important}#noty-catalog-content .noty-file-table :is(th,td){padding:12px 10px!important;border:0!important;border-bottom:1px solid #edf1f1!important;vertical-align:middle!important;background:transparent!important;color:#49616b!important;text-align:left!important}#noty-catalog-content .noty-file-table th{font-size:10px!important;font-weight:600!important;color:#809196!important;text-transform:uppercase;letter-spacing:.65px}#noty-catalog-content .noty-file-table tr{background:#fff!important}#noty-catalog-content .noty-file-table .noty-entry:hover{background:#f2f8f6!important}#noty-catalog-content .noty-file-table a{color:#24444a!important;text-decoration:none!important;overflow-wrap:anywhere}#noty-catalog-content .noty-entry-link{display:block;max-width:100%;min-width:0;font-weight:500}#noty-catalog-content .noty-folder .noty-entry-link{color:#176b60!important;font-weight:600}#noty-catalog-content .noty-parent-entry a{color:#7b9398!important}#noty-catalog-content .noty-file-table img{max-width:20px;max-height:20px;vertical-align:middle}#noty-catalog-content .noty-file-table td:not(:has(a)){font-size:11px!important;color:#819297!important;white-space:nowrap}#noty-catalog-content a{color:#176b60}#noty-workspace [hidden]{display:none!important}#noty-catalog-empty{padding:20px 26px;color:#78908f;font-size:13px}.noty-catalog-foot{padding:14px 26px;background:#fbfcfc;border-top:1px solid #edf1f1;font:11px/1.5 'Segoe UI',system-ui,sans-serif;color:#819397}#noty-download-column{min-width:0;min-height:0}#noty-workspace :is(a,select):focus-visible{outline:3px solid #79beb3;outline-offset:3px}
      .noty-catalog-heading h2{padding:0}.noty-brand h1{padding:0}#noty-catalog-content .noty-file-table :is(th,td):not(.noty-name-cell){width:1%!important}#noty-catalog-content .noty-file-table .noty-name-cell{white-space:normal!important;overflow-wrap:anywhere;width:auto!important}#noty-catalog-content .noty-table-head :is(a,td,th){font-size:11px!important;color:#60777d!important;font-weight:600}#noty-catalog-content .noty-file-table td:has(img){width:30px!important}
      @media(max-width:1099px){body.noty-app{overflow:auto}#noty-workspace{padding:0 16px 24px}.noty-app-head{height:88px}.noty-columns{grid-template-columns:1fr;height:auto;gap:20px}.noty-catalog{max-height:70vh;min-height:280px}#noty-download-column{height:auto}.noty-catalog-head{padding:20px}.noty-catalog-heading{margin-bottom:16px}#noty-catalog-content{padding:10px 16px 18px}}@media(max-width:500px){.noty-app-caption{display:none}.noty-brand h1{font-size:22px}.noty-brand-mark{width:42px;height:42px}.noty-catalog-heading h2{font-size:20px}.noty-kicker{font-size:9px}.noty-catalog-tools{gap:7px}#noty-catalog-kind{max-width:112px;font-size:11px}#noty-catalog-content .noty-file-table :is(th,td){padding:10px 6px!important;font-size:12px!important}.noty-catalog-foot{padding:12px 18px}}
    `;
    document.head.append(style); document.body.classList.add('noty-app');
    shell.querySelector('#noty-download-column').append(panelHost); document.body.append(shell);
  }
  const host = document.createElement('div');
  host.id = 'noty-folder-helper';
  host.style.cssText = 'display:block;min-width:0;height:100%';
  const ui = host.attachShadow({ mode: 'open' });
  ui.innerHTML = `<style>
    :host{display:block;font:14px/1.5 'Segoe UI',system-ui,sans-serif;color:#20343d;color-scheme:light}
    *{box-sizing:border-box}section{height:100%;min-height:0;display:flex;flex-direction:column;background:#fff;border:1px solid #dce5e6;border-radius:20px;overflow:hidden;box-shadow:0 8px 28px #18383b08;text-align:left}
    h2{font:700 22px/1.2 'Segoe UI',system-ui,sans-serif;letter-spacing:-.6px;margin:0}p{margin:0}small{display:block;color:#60757e;font:12px/1.55 'Segoe UI',system-ui,sans-serif}
    button,input,select{font:inherit}button{border:1px solid #dce5e6;border-radius:9px;padding:9px 12px;margin:4px 4px 4px 0;background:#fff;color:#28444e;cursor:pointer;font-size:13px;font-weight:600;line-height:1.35;white-space:normal;transition:background .15s}
    button:hover:not(:disabled){background:#edf6f5;border-color:#91bcb6}button.primary{background:#176b60;color:#fff;border-color:#176b60}button.primary:hover:not(:disabled){background:#105549}button:disabled{color:#85979d;background:#f1f4f5;border-color:#e7edef;cursor:not-allowed}
    :is(button,input,select,summary,a):focus-visible{outline:3px solid #79beb3;outline-offset:3px}a{color:#176b60;text-underline-offset:3px} [hidden]{display:none!important}
    .panel-head{padding:22px 22px 16px;border-bottom:1px solid #e7edef;background:#fff;flex-shrink:0}.heading-line{display:flex;align-items:center;justify-content:space-between;gap:12px}.eyebrow{text-transform:uppercase;font-size:10px;font-weight:700;letter-spacing:1.7px;color:#7d9298;margin-bottom:8px}
    #runState{font-size:11px;font-weight:600;border-radius:99px;padding:5px 9px;background:#edf5f3;color:#176b60;white-space:nowrap}#runState[data-state=paused]{background:#fff3dc;color:#875907}#root{margin-top:10px;overflow-wrap:anywhere;font-size:12px;max-height:54px;overflow:auto}
    .action-grid{display:grid;grid-template-columns:1fr 1.4fr;gap:8px;margin-top:18px}.action-grid button{margin:0;min-height:43px}.action-grid #scan{background:#f1f7f5;color:#176b60;border-color:#d3e5df}.secondary-actions{display:flex;gap:7px;margin-top:8px}.secondary-actions button{flex:1;margin:0;font-size:12px;min-height:34px}
    .panel-scroll{min-height:0;overflow:auto;overscroll-behavior:contain;padding:18px 22px 24px;scrollbar-width:thin;scrollbar-color:#c5d8d6 transparent}.status-card{margin-bottom:18px}#status{font-size:13px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;max-height:130px;overflow:auto}
    progress{appearance:none;display:block;width:100%;height:7px;margin:14px 0 16px;border:0;border-radius:20px;overflow:hidden;background:#e9efee}progress::-webkit-progress-bar{background:#e9efee}progress::-webkit-progress-value{background:#219780;border-radius:20px}progress::-moz-progress-bar{background:#219780}
    .metric-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:10px 0}.metric{padding:11px 12px;background:#f4f7f7;border-radius:10px;min-width:0}.metric span{display:block;font-size:10px;color:#637a81;margin-bottom:3px}.metric strong{display:block;font-size:17px;letter-spacing:-.4px;font-weight:650;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
    #tuningSummary{font-size:11px;margin:8px 0 13px}#volume{border-top:1px solid #e8eeee;padding-top:12px;font-variant-numeric:tabular-nums}#eta{margin-top:6px;color:#176b60;font-weight:600}#recoveryInfo:empty{display:none}#recoveryInfo{margin-top:10px}#challengeLink{display:block;margin:8px 0}#enableRecovery{font-size:11px;width:100%;margin:10px 0 0;background:#f6f8f8}
    details{border-top:1px solid #e3ebeb;padding:0;margin:0}summary{position:relative;list-style:none;padding:16px 22px 16px 0;font-size:13px;font-weight:650;cursor:pointer}summary::-webkit-details-marker{display:none}summary:after{content:'+';position:absolute;right:2px;font-size:17px;line-height:20px;font-weight:400;color:#7b9398}details[open]>summary:after{content:'−'}details[open]{padding-bottom:17px}details>small{margin:8px 0}
    .settings{display:grid;grid-template-columns:minmax(0,1fr) 115px;align-items:center;gap:10px 12px;margin:14px 0}.settings label{font-size:12px;color:#49616b}input,select{border:1px solid #ccdada;border-radius:8px;background:#fff;color:#20343d;width:100%;min-height:36px;padding:7px 9px;font-size:13px}input[type=checkbox]{width:16px;min-height:16px;height:16px;margin:3px 7px 0 0;accent-color:#176b60;flex-shrink:0;vertical-align:top}label{font-size:13px}fieldset{border:0;padding:0;margin:0;min-width:0}fieldset:disabled{opacity:.55}
    .scroll{max-height:260px;overflow:auto;scrollbar-width:thin;overscroll-behavior:contain;margin:8px 0}.row{display:flex;gap:6px;align-items:flex-start;padding:9px 0;border-bottom:1px solid #edf1f1;font-size:12px}.row label{flex:1;min-width:0;overflow-wrap:anywhere;font-size:12px}.row button{padding:0 6px;margin:0;min-height:23px}#jobs,#log{white-space:pre-wrap;font-size:11px;line-height:1.7;overflow-wrap:anywhere;max-height:260px;overflow:auto;background:#f5f8f7;border-radius:9px;padding:12px}#log:empty:before{content:'Здесь появятся события загрузки.';color:#70858d}
    svg{width:100%;height:70px;background:#f4f8f7;border-radius:8px;display:block;margin:7px 0 12px}.note{margin:6px 0}.panel-foot{font-size:11px;border-top:1px solid #e3ebeb;padding-top:14px;margin-top:6px;color:#7c9096}.list-actions{display:flex;flex-wrap:wrap;gap:4px}.list-actions button{flex:1 1 40%;margin:0}#export{flex-basis:100%}#repair,#verify,#replaceSelected,#updateScan,#selectUpdates{width:100%;margin:4px 0}#repair{background:#edf6f3;color:#176b60;border-color:#cfe3dd}#replaceSelected{color:#975a2c}
    #editList{width:100%;margin:10px 0 0;background:#edf6f3;color:#176b60}.manifest-dialog{color:#20343d;background:#fff;border:1px solid #dce5e6;border-radius:18px;padding:0;width:min(1120px,calc(100vw - 32px));height:min(800px,calc(100dvh - 40px));max-width:none;max-height:none;box-shadow:0 20px 80px #102f3c30;text-align:left}.manifest-dialog[open]{display:flex;flex-direction:column}.manifest-dialog::backdrop{background:#102b365c;backdrop-filter:blur(3px)}.editor-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:22px 24px 16px}.editor-head h2{font-size:21px}.editor-head small{margin-top:6px}.editor-head button{flex-shrink:0}.editor-tools{display:grid;grid-template-columns:minmax(0,1fr) 245px;gap:12px;padding:0 24px 12px}.editor-tools label{display:block;font-size:11px;color:#60757e;margin-bottom:4px}.editor-actions{padding:0 24px 12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}.editor-actions button{margin:0;font-size:12px}.editor-actions small{flex-basis:100%}.editor-table-wrap{flex:1;min-height:0;overflow:auto;border-top:1px solid #e3ebeb;border-bottom:1px solid #e3ebeb;padding:0 24px}.editor-table{border-collapse:collapse;width:100%;table-layout:fixed;font-size:12px}.editor-table th{text-align:left;font-weight:600;color:#60757e;background:#f7faf9;position:sticky;top:0;z-index:1;padding:12px 8px}.editor-table :is(td,th):first-child{width:38px}.editor-table :is(td,th):last-child{width:130px;text-align:right}.editor-table td{padding:12px 8px;border-bottom:1px solid #e7edef;vertical-align:top}.editor-table tr:has(input:checked){background:#edf7f3}.editor-table a{font-weight:600;text-decoration:none;overflow-wrap:anywhere}.editor-table small{font-size:11px;overflow-wrap:anywhere;margin-top:3px}.editor-table input{cursor:pointer}.editor-bottom{padding:12px 24px 18px}.editor-pages{display:flex;align-items:center;gap:12px;justify-content:space-between;margin-bottom:8px}.editor-pages small{text-align:center}.editor-bottom .editor-actions{padding:0}.editor-bottom small{margin-top:6px}#editorDelete{background:#fff4f0;border-color:#ecd6cb;color:#973f23}#editorDelete:disabled{color:#85979d;background:#f1f4f5;border-color:#e7edef}#editorEmpty{padding:24px 0;text-align:center;color:#60757e}
    @media(max-width:1099px){section{height:auto;max-height:none}.panel-scroll{overflow:visible}.panel-head{position:sticky;top:0;z-index:2}.settings{grid-template-columns:minmax(0,1fr) 105px}}@media(max-width:600px){.manifest-dialog{width:calc(100vw - 16px);height:calc(100dvh - 20px);border-radius:12px}.editor-head{padding:16px 12px 12px}.editor-head h2{font-size:18px}.editor-tools{padding:0 12px 10px;grid-template-columns:1fr;gap:7px}.editor-actions{padding:0 12px 10px}.editor-table-wrap{padding:0 6px}.editor-table :is(td,th):last-child{width:85px}.editor-table :is(td,th):first-child{width:30px}.editor-bottom{padding:8px 12px 12px}.editor-bottom button{padding:8px;font-size:11px}.editor-head small{font-size:11px}}@media(max-width:420px){.panel-head{padding:18px 16px 14px}.panel-scroll{padding:16px}.action-grid{grid-template-columns:1fr}.metric strong{font-size:16px}}
    .chart-scales{display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px 12px;margin-top:8px;font-size:11px;line-height:1.5}.chart-scales span:before{content:'';display:inline-block;width:18px;border-top:2px solid currentColor;margin-right:6px;vertical-align:middle}#byteScale{color:#185d80}#fileScale{color:#a85c13}#fileScale:before{border-top-style:dashed}#rateChartHint{margin-bottom:12px}
  </style><section><h2>Скачать папку целиком</h2><small id="root"></small>
    <p id="status" role="status" aria-live="polite">Сначала собери список файлов.</p><progress id="progress" value="0" max="1"></progress>
    <small id="speed">Скорость: —</small>
    <small id="volume">Объём: —</small><small id="eta">До конца: —</small>
    <small id="recoveryInfo" role="status"></small>
    <a id="challengeLink" target="_blank" rel="noopener noreferrer" hidden>Открыть сайт для проверки</a>
    <button id="enableRecovery">Включить автообновление вкладки</button>
    <details id="selectionDetails"><summary>Выбор папок и фильтры</summary><fieldset id="selectionFields">
      <label for="folderSearch">Поиск папки</label><input id="folderSearch" type="search">
      <button id="selectAll">Все папки</button><button id="selectNone">Снять выбор</button>
      <div id="tree" class="scroll"></div><button id="treeMore" hidden>Показать ещё папки</button>
      <div class="settings"><label for="includeExt">Только расширения</label><input id="includeExt" placeholder="pdf, djvu">
      <label for="excludeExt">Исключить расширения</label><input id="excludeExt" placeholder="mp3, zip">
      <label for="fileQuery">Имя или путь содержит</label><input id="fileQuery" type="search">
      <label for="maxMiB">Максимум на файл, МиБ</label><input id="maxMiB" type="number" min="0" step="any" placeholder="Без лимита"></div>
      <label><input id="unknownSize" type="checkbox" checked> Включать файлы неизвестного размера</label>
      <small>Расширения через запятую; «-» — без расширения. Ноль или пустой лимит — без ограничения.</small>
      <button id="clearFilters">Сбросить фильтры</button></fieldset><small id="selectionInfo"></small></details>
    <details id="detailProgress"><summary>Файлы в работе и графики</summary><div id="jobs">Загрузок пока нет.</div>
      <div id="rateChartBlock"><small id="rateChartLabel">Скорость и сохранение за последние 180 замеров</small>
      <div class="chart-scales"><span id="byteScale">Скорость · Б/с</span><span id="fileScale">Сохранение · файлов/с</span></div>
      <svg id="rateChart" viewBox="0 0 380 70" role="img" aria-label="Суммарная скорость и темп сохранения файлов; независимые шкалы" aria-describedby="rateChartLabel byteScale fileScale rateChartHint"></svg>
      <small id="rateChartHint">Шкалы независимы, от нуля. Файлов/с — средний темп сохранения по всем потокам, как в карточке выше.</small></div>
      <small>Лимит потоков (синий) и активные задания (зелёный)</small><svg id="threadChart" viewBox="0 0 380 70" role="img" aria-label="График количества потоков"></svg></details>
    <details><summary>Потоки и автотюн</summary><div class="settings">
      <label for="auto">Режим</label><select id="auto"><option value="auto">Авто</option><option value="manual">Ручной</option></select>
      <label for="threads">Потоков вручную</label><input id="threads" type="number" min="1" max="12">
      <label for="maxThreads">Предел автотюна</label><input id="maxThreads" type="number" min="1" max="12">
      <label for="delayMs">Между стартами, мс</label><input id="delayMs" type="number" min="0" max="5000" step="50">
      <label for="windowSeconds">Окно измерения, с</label><input id="windowSeconds" type="number" min="5" max="60">
      <label for="gainPercent">Минимальный прирост, %</label><input id="gainPercent" type="number" min="3" max="30">
      <label for="scanThreads">Потоков сбора папок</label><input id="scanThreads" type="number" min="1" max="6">
      <label for="scanDelayMs">Между запросами папок, мс</label><input id="scanDelayMs" type="number" min="0" max="5000" step="50">
      <label for="maxRetries">Автоповторов при сбое</label><input id="maxRetries" type="number" min="0" max="8">
      <label for="retryBaseSeconds">Начальная задержка повтора, с</label><input id="retryBaseSeconds" type="number" min="1" max="60">
    </div><label><input id="autoRecover" type="checkbox" checked> Автоматически продолжать после Cloudflare / HTTP 403 / 429 / 503</label>
    <small>До 8 попыток за запуск с ожиданием 30–300 с; более долгий Retry-After соблюдается. «Пауза» отменяет автоматическое продолжение. Проверку с кликом нужно пройти самостоятельно.</small>
    <small>Автотюн учитывает байты и сохранённые файлы, проверяет результат возвратом к прежнему лимиту. Работает и в фоновой вкладке. При смене режима начатые файлы докачаются.</small></details>
    <button id="scan" class="primary">1. Найти файлы</button><button id="download" class="primary" disabled>2. Выбрать папку и скачать</button>
    <button id="pause" disabled>Пауза</button><button id="retry" disabled>Повторить ошибки</button><button id="export" disabled>Список ссылок</button>
    <button id="import">Загрузить JSON</button><input id="importFile" type="file" accept=".json,application/json" hidden>
    <button id="cache" disabled>Из кеша</button><button id="rescan">Собрать заново</button><small id="cacheInfo">Проверяю кеш…</small>
    <details id="verifyDetails"><summary>Проверка папки и докачка</summary>
      <button id="verify" disabled>Проверить папку</button><button id="repair" disabled>Докачать отсутствующие / пустые</button>
      <small>Выбери ту же родительскую папку, что при скачивании. Проверка читает выбранные файлы и ничего не изменяет.</small>
      <small>Для глубоких папок в Windows используй короткий путь назначения, например C:\\N. Длинный путь может помешать созданию файла или его временной копии.</small>
      <small id="verifyInfo">Проверка ещё не выполнена.</small>
      <label for="reportFilter">Показать</label><select id="reportFilter"><option value="all">Все результаты</option><option value="problems">Только проблемы</option></select>
      <div id="reportRows" class="scroll"></div><button id="reportMore" hidden>Ещё результаты</button>
      <button id="replaceSelected" disabled>Заменить отмеченные файлы</button><button id="exportReport" disabled>Скачать отчёт</button>
      <small>Замена перезапишет только отмеченные здесь файлы. Перед записью проверяется, что локальный файл не изменился после проверки.</small></details>
    <details id="updateDetails"><summary>Обновление архива</summary><button id="updateScan" disabled>Проверить обновления на сайте</button>
      <small id="updateInfo">Для сравнения нужен предыдущий список.</small><button id="selectUpdates" disabled>Выбрать новые и изменённые</button>
      <div id="changeRows" class="scroll"></div><button id="changeMore" hidden>Ещё изменения</button><button id="exportChanges" disabled>Скачать сравнение</button>
      <small>Размеры и даты показывают предполагаемые изменения. Исчезнувшие с сайта локальные файлы не удаляются.</small></details>
    <small>Структура папок сохраняется. Держи вкладку открытой. Пауза — после уже начатых файлов или страниц.</small>
    <details><summary>Ход работы</summary><div id="log"></div></details></section>`;
  // Reuse every existing control and its ID; only regroup the interface.
  const panel = ui.querySelector('section');
  const panelDetails = [...panel.querySelectorAll('details')];
  const take = (parent, ids) => { for (const id of ids) parent.append(ui.getElementById(id)); };
  const panelHead = document.createElement('header'); panelHead.className = 'panel-head';
  panelHead.innerHTML = '<div class="eyebrow">ВАША БИБЛИОТЕКА</div><div class="heading-line"><h2>Загрузки</h2><span id="runState">Готов к работе</span></div>';
  take(panelHead, ['root']);
  const actions = document.createElement('div'); actions.className = 'action-grid'; take(actions, ['scan', 'download']); panelHead.append(actions);
  const secondary = document.createElement('div'); secondary.className = 'secondary-actions'; take(secondary, ['pause', 'retry']); panelHead.append(secondary);
  const panelScroll = document.createElement('div'); panelScroll.className = 'panel-scroll';
  const statusCard = document.createElement('div'); statusCard.className = 'status-card';
  take(statusCard, ['status', 'progress', 'speed']); statusCard.querySelector('#speed').hidden = true;
  const metrics = document.createElement('div'); metrics.className = 'metric-grid';
  metrics.innerHTML = '<div class="metric"><span>Сейчас</span><strong id="metricCurrent">—</strong></div><div class="metric"><span>Средняя · до 30 с</span><strong id="metricAverage">—</strong></div><div class="metric"><span>Сохранение · файлов/с</span><strong id="metricFiles">—</strong></div><div class="metric"><span>Активно / лимит</span><strong id="metricActive">0 / 1</strong></div>';
  statusCard.append(metrics);
  const tuning = document.createElement('small'); tuning.id = 'tuningSummary'; tuning.textContent = 'Показатели появятся после начала загрузки.'; statusCard.append(tuning);
  take(statusCard, ['volume', 'eta', 'recoveryInfo', 'challengeLink', 'enableRecovery']);
  const listDetails = document.createElement('details'); listDetails.id = 'listDetails'; listDetails.open = true;
  listDetails.innerHTML = '<summary>Список файлов</summary><div class="list-actions"></div><button id="editList" disabled>Просмотреть и редактировать список</button>';
  take(listDetails.querySelector('div'), ['import', 'cache', 'rescan', 'export']); take(listDetails, ['importFile', 'cacheInfo']);
  panelScroll.append(statusCard, listDetails, ...panelDetails);
  const foot = document.createElement('div'); foot.className = 'panel-foot'; foot.textContent = 'Структура папок сохраняется. Оставь вкладку открытой до завершения. Пауза — после начатых файлов.';
  panelScroll.append(foot); panel.replaceChildren(panelHead, panelScroll);
  const editor = document.createElement('dialog'); editor.id = 'manifestEditor'; editor.className = 'manifest-dialog';
  editor.setAttribute('aria-labelledby', 'editorTitle');
  editor.innerHTML = `<div class="editor-head"><div><h2 id="editorTitle">Собранный список</h2><small id="editorSummary"></small></div><button id="editorClose" autofocus>Закрыть</button></div>
    <div class="editor-tools"><div><label for="editorQuery">Имя файла или путь</label><input id="editorQuery" type="search" placeholder="Например, сольфеджио или .mp3"></div><div><label for="editorSort">Сортировка</label><select id="editorSort"><option value="size-desc">Размер: большие сначала</option><option value="size-asc">Размер: маленькие сначала</option><option value="path">Путь: А → Я</option></select></div></div>
    <div class="editor-actions"><button id="editorSelectAll">Отметить найденные</button><button id="editorClear">Снять отметки</button><small id="editorSelectionInfo"></small></div>
    <div class="editor-table-wrap"><table class="editor-table"><thead><tr><th><span aria-label="Выбор">✓</span></th><th>Файл / папка</th><th>Размер</th></tr></thead><tbody id="editorRows"></tbody></table><p id="editorEmpty" hidden>В списке нет подходящих файлов.</p></div>
    <div class="editor-bottom"><div class="editor-pages"><button id="editorPrev">← Назад</button><small id="editorPageInfo"></small><button id="editorNext">Далее →</button></div>
    <div class="editor-actions"><button id="editorDelete">Удалить ссылки (0)</button><button id="editorUndo">Отменить удаление</button><button id="editorSave">Сохранить в кеш</button><button id="editorExport">Скачать JSON</button></div>
    <small id="editorNotice" role="status" aria-live="polite">Удаляются только ссылки из списка. Локальные файлы сохраняются. Новый сбор с сайта может вернуть удалённые ссылки.</small></div>`;
  ui.append(editor);
  document.body.append(host);
  mountCatalogWorkspace(host);
  const $ = id => ui.getElementById(id);
  let root;
  try {
    root = currentRoot(location.href);
    $('root').textContent = root || 'Весь архив (Root)';
    if (root === '') $('status').textContent = 'Будут найдены файлы во всех разделах архива. Сначала собери список файлов.';
  }
  catch (e) { $('status').textContent = e.message; $('scan').disabled = true; return; }
  const state = { busy: false, pause: false, phase: '', folders: [root], visited: new Set(), files: new Map(),
    scanned: false, output: null, journal: null, queue: [], errors: [], done: 0, total: 0, logs: [],
    received: 0, active: 0, rate: 0, transferredFiles: 0, transferredBytes: 0, transferredSmall: 0, fileRate: 0, completionSamples: [], cooldownUntil: 0, stopReason: '', preparing: false, ticker: null,
    inFlightFolders: new Set(), knownFolders: new Set([root]), legacy: false, cacheAvailable: false,
    listGeneratedAt: new Date().toISOString(), completedPaths: new Set(), loadedBytes: new Map(), etaRate: 0,
    retrying: new Map(), retryEpoch: 0, autoPending: false, autoAttempts: 0, userPaused: false, recoveryBlocked: false, recoveryEpoch: 0, recovering: false,
    helper: null, helperToken: '', helperReady: false, helperWaitingUntil: 0,
    helperProtocol: false, helperRevision: 0, helperLastSeen: 0, helperConnectUntil: 0, helperPingDeadline: 0, helperPingNonce: '',
    view: normalizeView({}, root), selected: [], runFiles: null, sessionReady: false,
    previous: null, changes: [], changeByPath: new Map(), review: null, reviewRenderedAt: 0, reviewSelected: new Set(), replacements: new Map(),
    expanded: new Set([root]), treeLimit: 150, reportLimit: 100, changeLimit: 100,
    jobs: new Map(), recentJobs: [], history: new History(),
    editorSelected: new Set(), editorPage: 0, editorUndo: null, manifestLoaded: false };
  try { state.view = normalizeView(JSON.parse(localStorage.getItem('noty-view:' + root) || '{}'), root); } catch { /* Optional preferences. */ }
  let settings;
  try { settings = normalizeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); }
  catch { settings = normalizeSettings(); }
  let tuner = new AutoTuner(settings, performance.now());
  const serializeJournal = serialWriter();
  const serializeCache = serialWriter();
  const settingKeys = ['threads', 'maxThreads', 'delayMs', 'windowSeconds', 'gainPercent', 'scanThreads', 'scanDelayMs', 'maxRetries', 'retryBaseSeconds'];
  function fillSettings() {
    $('auto').value = settings.auto ? 'auto' : 'manual';
    $('autoRecover').checked = settings.autoRecover;
    for (const key of settingKeys) $(key).value = settings[key];
    $('threads').disabled = settings.auto;
    for (const key of ['maxThreads', 'windowSeconds', 'gainPercent']) $(key).disabled = !settings.auto;
  }
  fillSettings();
  function targetThreads() { return state.recovering ? 1 : settings.auto ? tuner.limit : settings.threads; }
  function showSpeed(refreshVolume = true) {
    const best = tuner.best.rate > 0 || tuner.best.fileRate > 0 ? `${tuner.best.threads} поток(а), ` +
      (tuner.best.metric === 'files' ? `${tuner.best.fileRate.toFixed(2)} файлов/с` : formatRate(tuner.best.rate)) : 'ещё измеряется';
    const phases = { baseline: 'замер', probe: 'проба лимита', confirm: 'контрольный замер', hold: 'удержание' };
    const reasons = { waiting: 'ожидание', pause: 'пауза', retry: 'ожидание повтора', recovery: 'проверка доступа одним потоком',
      draining: 'завершаю лишние задания', tail: 'остаток очереди', 'timer-gap': 'перерыв таймера; замер начнётся заново',
      workload: 'состав файлов изменился', pacing: 'ограничение темпа запуска', plateau: 'прироста нет',
      unconfirmed: 'прирост не подтвердился', ceiling: 'достигнут лимит', 'no-progress': 'нет данных о прогрессе' };
    const tuneStatus = state.pause ? reasons.pause : state.recovering ? reasons.recovery : reasons[tuner.reason] || phases[tuner.phase];
    $('speed').textContent = `Сейчас: ${formatRate(state.rate)} · Средняя (до 30 с): ${state.etaRate > 0 ? formatRate(state.etaRate) : '—'}\n` +
      `Сохранение: ${state.fileRate > 0 ? state.fileRate.toLocaleString('ru-RU', { maximumFractionDigits: 2 }) : '—'} файлов/с · Активно: ${state.active} · Лимит: ${targetThreads()}\n` +
      (settings.auto ? `Автотюн: ${tuneStatus} · Опорный уровень: ${best}` :
        `Ручной режим: ${settings.threads} поток(а)` + (state.recovering ? ' · временно один поток для проверки доступа' : ''));
    $('metricCurrent').textContent = formatRate(state.rate);
    $('metricAverage').textContent = state.etaRate > 0 ? formatRate(state.etaRate) : '—';
    $('metricFiles').textContent = state.fileRate > 0 ? state.fileRate.toLocaleString('ru-RU', { maximumFractionDigits: 2 }) : '—';
    $('metricActive').textContent = `${state.active} / ${targetThreads()}`;
    $('tuningSummary').textContent = $('speed').textContent.split('\n').at(-1);
    if (refreshVolume) showVolume();
  }
  function showVolume() {
    const files = [...(state.runFiles || (state.scanned ? state.selected : state.files.values()))];
    const totals = transferTotals(files, state.completedPaths, state.loadedBytes);
    // Failed items stay in the overall volume/error report, but no longer belong
    // to the running queue. Only retryable errors can re-enter it.
    const failedPaths = new Set(state.errors.map(error => error.item.path));
    const queueFiles = failedPaths.size ? files.filter(file => !failedPaths.has(file.path)) : files;
    const queueTotals = failedPaths.size ? transferTotals(queueFiles, state.completedPaths, state.loadedBytes) : totals;
    $('volume').textContent = state.output ? `По объёму: ≈ ${formatBytes(totals.processed)} / ${formatBytes(totals.total)}` : `Объём списка: ≈ ${formatBytes(totals.total)}`;
    if (totals.unknown) $('volume').textContent += ` + неизвестный размер у ${totals.unknown} файлов`;
    let eta = '—';
    if (state.output && totals.pending === 0) eta = 'завершено';
    else if (state.pause) eta = 'пауза';
    else if (state.output && queueTotals.pending === 0 && failedPaths.size) eta = 'очередь обработана';
    else if (state.retrying.size) eta = 'ожидаю повторов после сбоя';
    else if (queueTotals.unknown) eta = 'нужны размеры всех оставшихся файлов';
    else if (state.busy && state.phase === 'download') {
      const estimate = queueEstimate(queueFiles, state.completedPaths, state.loadedBytes, state.etaRate, state.fileRate,
        state.completionSamples.filter(sample => performance.now() - sample.at <= 30000).map(sample => sample.size));
      if (estimate) eta = '≈ ' + formatDuration(estimate.seconds) + (estimate.method === 'files' ? ' (по темпу сохранения файлов)' : ' (по средней скорости, при текущем темпе)');
      else eta = queueTotals.remaining === 0 ? 'завершаю файлы…' : 'измеряю скорость…';
    }
    const excluded = state.errors.filter(error => error.excluded).length;
    const retryable = state.errors.length - excluded;
    $('eta').textContent = (failedPaths.size ? 'До конца очереди: ' : 'До конца: ') + eta +
      (retryable ? `; ошибки: ${retryable} — не включены в оценку, требуют повтора` : '') +
      (excluded ? `; удалено ссылок с HTTP 403: ${excluded}` : '');
  }
  for (const key of ['auto', 'autoRecover', ...settingKeys]) {
    $(key).onchange = () => {
      const input = { auto: $('auto').value === 'auto', autoRecover: $('autoRecover').checked };
      for (const name of settingKeys) input[name] = $(name).value;
      settings = normalizeSettings(input); tuner.updateSettings(settings, performance.now());
      if (!settings.autoRecover) cancelRecovery();
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* Optional persistence. */ }
      fillSettings(); showSpeed(); log('Настройки применены. Начатые файлы докачаются.');
    };
  }
  function say(message) { $('status').textContent = message; }
  function log(message) { state.logs.push(message); state.logs = state.logs.slice(-50); $('log').textContent = state.logs.join('\n'); }
  function controls() {
    const locked = state.busy || state.preparing || state.autoPending;
    const paused = state.autoPending || (state.pause && state.queue.length > 0);
    $('runState').dataset.state = paused ? 'paused' : state.busy ? 'busy' : 'idle';
    $('runState').textContent = paused ? 'На паузе' : state.busy
      ? ({ scan: 'Сбор списка', verify: 'Проверка', download: 'Загрузка' }[state.phase] || 'В работе')
      : state.preparing ? 'Подготовка' : state.errors.length ? 'Есть ошибки' : state.total && state.done === state.total ? 'Завершено' : 'Готов к работе';
    $('scan').disabled = locked || state.scanned || Date.now() < state.cooldownUntil;
    $('download').disabled = locked || !state.scanned || state.selected.length === 0 || Date.now() < state.cooldownUntil;
    $('pause').disabled = !state.autoPending && (!state.busy || state.pause);
    $('retry').disabled = locked || !state.errors.some(e => !e.excluded) || Date.now() < state.cooldownUntil;
    $('export').disabled = state.busy || state.preparing || !state.manifestLoaded;
    $('editList').disabled = !state.manifestLoaded;
    editorControls();
    $('import').disabled = locked;
    $('cache').disabled = locked || !state.cacheAvailable;
    $('rescan').disabled = locked || Date.now() < state.cooldownUntil;
    $('selectionFields').disabled = locked;
    $('verify').disabled = locked || !state.scanned || !state.selected.length;
    $('repair').disabled = locked || !state.review?.complete || !state.review.rows.some(r => ['missing', 'incomplete'].includes(r.status)) || Date.now() < state.cooldownUntil;
    $('replaceSelected').disabled = locked || !state.review?.complete || !state.reviewSelected.size || Date.now() < state.cooldownUntil;
    $('replaceSelected').textContent = `Заменить отмеченные файлы (${state.reviewSelected.size})`;
    $('exportReport').disabled = locked || !state.review;
    $('updateScan').disabled = locked || !state.scanned || Date.now() < state.cooldownUntil;
    $('selectUpdates').disabled = locked || !state.changes.some(r => ['added', 'changed'].includes(r.status));
    $('exportChanges').disabled = locked || !state.previous;
    for (const box of $('reportRows').querySelectorAll('input')) box.disabled = locked;
    for (const box of $('changeRows').querySelectorAll('input')) box.disabled = locked;
  }
  function progress() { $('progress').max = Math.max(state.total, 1); $('progress').value = state.done; showVolume(); }
  function invalidateReview() {
    state.review = null; state.reviewSelected.clear(); state.replacements.clear();
    $('reportRows').replaceChildren(); $('verifyInfo').textContent = 'Проверь папку для текущего выбора файлов.';
  }
  function resetSession() {
    state.sessionReady = false; state.runFiles = null; state.queue = []; state.errors = [];
    state.completedPaths.clear(); state.loadedBytes.clear(); state.done = 0; state.total = 0;
    state.jobs.clear(); state.recentJobs = []; state.history = new History();
    $('progress').value = 0; $('progress').max = 1; renderJobs();
  }
  function refreshSelection(changed = false) {
    state.selected = selectFiles([...state.files.values()], state.view);
    const totals = transferTotals(state.selected);
    $('selectionInfo').textContent = `Выбрано ${state.selected.length} из ${state.files.size}; ≈ ${formatBytes(totals.total)}` +
      (totals.unknown ? ` + ${totals.unknown} неизвестных размеров` : '') + (state.view.files !== null ? '. Действует выбор отдельных файлов.' : '');
    if (changed) {
      resetSession(); invalidateReview();
      try { localStorage.setItem('noty-view:' + root, JSON.stringify(state.view)); } catch { /* Optional preferences. */ }
      if (state.scanned) scheduleCache();
    }
    renderTree(); renderChanges(); showVolume(); controls();
    if (editor.open) renderEditor();
  }
  const editorPageSize = 100;
  function editorItems() { return listManifestFiles(state.files.values(), $('editorQuery').value, $('editorSort').value); }
  function editorControls() {
    const locked = state.busy || state.preparing || state.autoPending;
    $('editorDelete').disabled = locked || !state.editorSelected.size;
    $('editorDelete').textContent = `Удалить ссылки (${state.editorSelected.size})`;
    $('editorUndo').disabled = locked || !state.editorUndo;
    $('editorSave').disabled = locked || !state.manifestLoaded;
    $('editorExport').disabled = state.busy || state.preparing || !state.manifestLoaded;
  }
  function renderEditor() {
    const focusedPath = ui.activeElement?.dataset.path;
    const items = editorItems(), totals = transferTotals([...state.files.values()]);
    const pages = Math.max(1, Math.ceil(items.length / editorPageSize));
    state.editorPage = Math.min(state.editorPage, pages - 1);
    $('editorSummary').textContent = `Всего: ${state.files.size} файлов · ≈ ${formatBytes(totals.total)}` + (totals.unknown ? ` · без размера: ${totals.unknown}` : '');
    $('editorPageInfo').textContent = `Страница ${state.editorPage + 1} / ${pages} · найдено ${items.length}`;
    const foundSelected = items.filter(item => state.editorSelected.has(item.path)).length;
    $('editorSelectionInfo').textContent = `Отмечено: ${state.editorSelected.size}` + (state.editorSelected.size > foundSelected ? ` (вне поиска: ${state.editorSelected.size - foundSelected})` : '') +
      (state.busy || state.preparing || state.autoPending ? '. Для редактирования дождись завершения операции или поставь её на паузу.' : '. Размеры без точных данных помечены ≈; неизвестные — в конце.');
    $('editorPrev').disabled = state.editorPage === 0; $('editorNext').disabled = state.editorPage + 1 >= pages;
    $('editorSelectAll').disabled = !items.length; $('editorClear').disabled = !state.editorSelected.size;
    const rows = document.createDocumentFragment();
    for (const item of items.slice(state.editorPage * editorPageSize, (state.editorPage + 1) * editorPageSize)) {
      const row = document.createElement('tr'), checkCell = document.createElement('td'), nameCell = document.createElement('td'), sizeCell = document.createElement('td');
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = state.editorSelected.has(item.path);
      checkbox.setAttribute('aria-label', 'Отметить ' + item.path); checkbox.dataset.path = item.path;
      checkbox.onchange = () => { if (checkbox.checked) state.editorSelected.add(item.path); else state.editorSelected.delete(item.path); renderEditor(); };
      checkCell.append(checkbox);
      const link = document.createElement('a'); link.href = item.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = item.path.split('/').at(-1);
      const folder = document.createElement('small'), separator = item.path.lastIndexOf('/');
      folder.textContent = separator < 0 ? 'Root' : item.path.slice(0, separator);
      nameCell.append(link, folder); sizeCell.textContent = validSize(item.sizeBytes) ? (item.remote?.sizeExact ? '' : '≈ ') + formatBytes(item.sizeBytes) : 'Неизвестен';
      row.append(checkCell, nameCell, sizeCell); rows.append(row);
    }
    $('editorRows').replaceChildren(rows); $('editorEmpty').hidden = items.length > 0; editorControls();
    if (focusedPath) [...$('editorRows').querySelectorAll('input')].find(input => input.dataset.path === focusedPath)?.focus({ preventScroll: true });
  }
  async function editManifest(undo = false) {
    if (state.busy || state.preparing || state.autoPending) return;
    const removed = undo ? state.editorUndo : [...state.editorSelected].map(path => state.files.get(path)).filter(Boolean);
    if (!removed?.length) return;
    state.preparing = true; controls(); manualRun();
    if (undo) { for (const item of removed) state.files.set(item.path, item); state.editorUndo = null; }
    else { for (const item of removed) state.files.delete(item.path); state.editorUndo = removed; }
    state.editorSelected.clear(); state.listGeneratedAt = new Date().toISOString(); state.pause = false; state.stopReason = '';
    updateChanges(); refreshSelection(true);
    $('editorNotice').textContent = 'Сохраняю изменения в кеш…';
    try {
      const saved = await saveCache();
      $('editorNotice').textContent = `${undo ? 'Восстановлено' : 'Удалено ссылок'}: ${removed.length}. ` +
        (saved ? 'Изменения сохранены в кеше.' : 'Кеш недоступен. Скачай JSON, чтобы не потерять изменения.');
      say(`Список изменён: ${state.files.size} файлов. Локальные файлы не изменены.`);
    } finally { state.preparing = false; controls(); renderEditor(); }
  }
  function fillFilters() {
    const f = state.view.filters;
    $('includeExt').value = f.include; $('excludeExt').value = f.exclude;
    $('fileQuery').value = f.query; $('maxMiB').value = f.maxMiB || ''; $('unknownSize').checked = f.unknown;
  }
  function renderTree() {
    const nodes = folderTree([...state.files.values()], root, state.view);
    const query = $('folderSearch').value.trim().toLowerCase();
    const visible = nodes.filter(node => {
      if (query) return (node.path || 'Root').toLowerCase().includes(query);
      if (node.path === root) return true;
      let parent = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '';
      for (;;) {
        if (!state.expanded.has(parent)) return false;
        if (parent === root || !parent) return true;
        parent = parent.includes('/') ? parent.slice(0, parent.lastIndexOf('/')) : '';
      }
    });
    const fragment = document.createDocumentFragment();
    for (const node of visible.slice(0, state.treeLimit)) {
      const row = document.createElement('div'); row.className = 'row';
      const depth = node.path === root ? 0 : relativePath(node.path, root).split('/').length;
      row.style.paddingLeft = Math.min(depth * 10, 60) + 'px';
      const expand = document.createElement('button'); expand.textContent = state.expanded.has(node.path) ? '−' : '+';
      expand.setAttribute('aria-label', 'Раскрыть или свернуть ' + (node.path || 'Root'));
      expand.onclick = () => { if (state.expanded.has(node.path)) state.expanded.delete(node.path); else state.expanded.add(node.path); renderTree(); };
      const label = document.createElement('label'), box = document.createElement('input'); box.type = 'checkbox';
      box.dataset.path = node.path; box.checked = node.count > 0 && node.checked === node.count;
      box.indeterminate = node.checked > 0 && node.checked < node.count;
      box.onchange = () => {
        state.view.folders = state.view.folders.filter(([p]) => !inside(p, node.path));
        state.view.folders.push([node.path, box.checked]); state.view.files = null; refreshSelection(true);
      };
      label.append(box, document.createTextNode(` ${node.path || 'Root'} · ${node.selected}/${node.count} · ${formatBytes(node.bytes)}${node.unknown ? ' + ?' : ''}`));
      row.append(expand, label); fragment.append(row);
    }
    $('tree').replaceChildren(fragment); $('treeMore').hidden = visible.length <= state.treeLimit;
  }
  const changeLabels = { added: 'Новый', changed: 'Предположительно изменён', unchanged: 'Метаданные совпадают', removed: 'Исчез с сайта', uncertain: 'Недостаточно данных' };
  const verifyLabels = { missing: 'Нет файла', incomplete: 'Пустой файл', mismatch: 'Размер не совпадает', verified: 'Совпадает с журналом', changed: 'Есть обновление', uncertain: 'Нет подтверждения в журнале', error: 'Ошибка чтения' };
  function renderChanges() {
    const fragment = document.createDocumentFragment(), selected = new Set(state.selected.map(f => f.path));
    for (const row of state.changes.slice(0, state.changeLimit)) {
      const line = document.createElement('div'); line.className = 'row';
      const label = document.createElement('label');
      if (row.status !== 'removed') {
        const box = document.createElement('input'); box.type = 'checkbox'; box.checked = selected.has(row.path);
        box.dataset.path = row.path; box.disabled = state.busy || state.preparing;
        box.onchange = () => {
          const paths = new Set(state.selected.map(f => f.path)); if (box.checked) paths.add(row.path); else paths.delete(row.path);
          state.view.files = [...paths]; refreshSelection(true);
        };
        label.append(box);
      }
      let detail = '';
      if (row.status === 'changed') {
        if (validSize(row.before?.sizeBytes) && validSize(row.after?.sizeBytes) && row.before.sizeBytes !== row.after.sizeBytes) detail += ` · ${formatBytes(row.before.sizeBytes)} → ${formatBytes(row.after.sizeBytes)}`;
        if (row.before?.modified && row.after?.modified && row.before.modified !== row.after.modified) detail += ` · ${row.before.modified} → ${row.after.modified}`;
      }
      label.append(document.createTextNode(` ${changeLabels[row.status]}: ${row.path}${detail}`)); line.append(label); fragment.append(line);
    }
    $('changeRows').replaceChildren(fragment); $('changeMore').hidden = state.changes.length <= state.changeLimit;
    const counts = {};
    for (const row of state.changes) counts[row.status] = (counts[row.status] || 0) + 1;
    $('updateInfo').textContent = state.previous ?
      `Сравнение с ${state.previous.generatedAt || 'предыдущим списком'}. ` + Object.entries(counts).map(([key, value]) => `${changeLabels[key]}: ${value}`).join('; ') : 'Для сравнения нажми «Проверить обновления на сайте» после первого сбора или импорта.';
  }
  function updateChanges() {
    state.changes = compareManifests(state.previous, [...state.files.values()], state.scanned && !state.legacy);
    state.changeByPath = new Map(state.changes.map(row => [row.path, row.status]));
    renderChanges();
  }
  function renderReview() {
    const review = state.review;
    if (!review) return;
    state.reviewRenderedAt = performance.now();
    const counts = {};
    for (const row of review.rows) counts[row.status] = (counts[row.status] || 0) + 1;
    $('verifyInfo').textContent = `${review.complete ? 'Проверено' : 'Частичная проверка'} ${review.rows.length}/${review.total}. ` +
      Object.entries(counts).map(([key, count]) => `${verifyLabels[key]}: ${count}`).join('; ');
    const rows = review.rows.filter(row => $('reportFilter').value !== 'problems' || row.status !== 'verified');
    const fragment = document.createDocumentFragment();
    for (const row of rows.slice(0, state.reportLimit)) {
      const line = document.createElement('div'); line.className = 'row'; const label = document.createElement('label');
      if (['mismatch', 'changed', 'uncertain'].includes(row.status)) {
        const box = document.createElement('input'); box.type = 'checkbox'; box.dataset.path = row.path;
        box.checked = state.reviewSelected.has(row.path); box.disabled = state.busy || state.preparing;
        box.onchange = () => { if (box.checked) state.reviewSelected.add(row.path); else state.reviewSelected.delete(row.path); controls(); };
        label.append(box);
      }
      label.append(document.createTextNode(` ${verifyLabels[row.status]}: ${row.path}` +
        (row.localSize !== null ? ` · на диске ${formatBytes(row.localSize)}` : '') +
        (validSize(row.expected?.sizeBytes) ? ` · на сайте ${row.expected.sizeExact ? '' : '≈ '}${formatBytes(row.expected.sizeBytes)}` : '') +
        (row.status === 'mismatch' && validSize(row.journalSize) ? ` · по журналу ${formatBytes(row.journalSize)}` : '') + (row.error ? ' · ' + row.error : '')));
      line.append(label); fragment.append(line);
    }
    $('reportRows').replaceChildren(fragment); $('reportMore').hidden = rows.length <= state.reportLimit;
  }
  async function localFile(dir, file) {
    if (!dir) return null;
    const parts = localParts(file.path, root), walked = [outputName()]; let current = dir;
    for (const part of parts.slice(0, -1)) {
      walked.push(part);
      current = await diskOperation('чтение папки', walked.join('/'), () => current.getDirectoryHandle(part), true, 'directory');
      if (!current) return null;
    }
    walked.push(parts.at(-1));
    const path = walked.join('/');
    const handle = await diskOperation('поиск файла', path, () => current.getFileHandle(parts.at(-1)), true, true);
    return handle ? diskOperation('чтение файла', path, () => handle.getFile()) : null;
  }
  function outputName() { return root === '' ? 'noty.propovednik.com' : safeName(root.split('/').at(-1)); }
  async function verifyDirectory() {
    if (state.busy || state.preparing || !state.scanned || !state.selected.length) return;
    state.preparing = true; controls();
    try {
      if (!window.showDirectoryPicker) throw new Error('Нужен Chrome или Edge с выбором папки.');
      const parent = await window.showDirectoryPicker({ mode: 'read', id: 'noty-textbooks', startIn: 'downloads' });
      let dir = null;
      try { dir = await parent.getDirectoryHandle(outputName()); } catch (e) { if (e.name !== 'NotFoundError') throw e; }
      const journal = dir ? await readJournal(dir) : { version: 1, root, completed: {} };
      resetSession(); invalidateReview();
      state.destination = parent; state.output = dir; state.journal = journal;
      state.busy = true; state.phase = 'verify'; state.pause = false;
      const files = [...state.selected];
      state.review = { root, generatedAt: new Date().toISOString(), total: files.length, complete: false, rows: [] };
      controls();
      for (const file of files) {
        if (state.pause) break;
        let row;
        try {
          const local = await localFile(dir, file), record = journal.completed[file.url];
          let status = verifyFile(file, root, local, record);
          if (status === 'verified' && !record?.remote && state.changeByPath.get(file.path) === 'changed') status = 'changed';
          row = { path: file.path, status, localSize: local?.size ?? null, lastModified: local?.lastModified ?? null,
            expected: remoteMetadata(file), journalSize: validSize(record?.size) ? record.size : null, change: state.changeByPath.get(file.path) || null };
        } catch (e) { row = { path: file.path, status: 'error', localSize: null, error: e.message }; }
        state.review.rows.push(row);
        if (state.review.rows.length % 25 === 0) {
          say(`Проверка: ${state.review.rows.length}/${files.length}`); renderReview();
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
      state.review.complete = state.review.rows.length === files.length;
      renderReview(); $('verifyDetails').open = true;
      say(state.review.complete ? 'Проверка завершена. Отчёт ниже; выбери докачку или конкретные замены.' : 'Проверка на паузе. Повтори проверку, чтобы подготовить полную очередь.');
    } catch (e) { if (e.name !== 'AbortError') say(e.message); }
    finally { state.busy = false; state.preparing = false; controls(); }
  }
  function prepareQueue(files) {
    resetSession(); state.runFiles = [...files]; state.queue = [...files].sort((a, b) => a.path.localeCompare(b.path));
    state.total = files.length; state.sessionReady = true; progress();
  }
  function exportJSON(data, name) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  function drawChart(id, points, keys, maximum, colors, dashed = []) {
    const svg = $(id); svg.replaceChildren();
    keys.forEach((key, index) => {
      const scale = Array.isArray(maximum) ? maximum[index] : maximum;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      line.setAttribute('points', points.map((p, i) => `${4 + i * 372 / Math.max(1, points.length - 1)},${66 - Math.min(scale, Math.max(0, p[key] || 0)) * 62 / scale}`).join(' '));
      if (dashed[index]) line.setAttribute('stroke-dasharray', '5 3');
      line.setAttribute('fill', 'none'); line.setAttribute('stroke', colors[index]); line.setAttribute('stroke-width', '2'); svg.append(line);
    });
  }
  function renderJobs(sample = false) {
    const now = performance.now();
    const labels = { waiting: 'ожидание ответа', download: 'получение', saving: 'запись', journal: 'журнал', retry: 'повтор', done: 'готово', error: 'ошибка', paused: 'пауза' };
    if (sample) {
      for (const [path, job] of state.jobs) {
        const bytes = state.loadedBytes.get(path) || 0, elapsed = now - job.sampleAt;
        if (elapsed > 0) job.rate = Math.max(0, bytes - job.sampleBytes) * 1000 / elapsed;
        if (bytes !== job.sampleBytes) job.dataAt = now;
        job.sampleAt = now; job.sampleBytes = bytes;
      }
      state.history.add({ time: Date.now(), rate: state.rate, fileRate: state.fileRate, limit: targetThreads(), active: state.active });
    }
    const lines = [...state.jobs].map(([path, job]) => {
      const item = state.files.get(path), received = state.loadedBytes.get(path) || 0;
      return `${labels[job.stage]}${job.stage === 'download' && now - job.dataAt >= 10000 ? ' (нет новых данных)' : ''}: ${path}\n${formatBytes(received)} / ${validSize(item?.sizeBytes) ? formatBytes(item.sizeBytes) : '?'} · ${formatBytes(job.rate)}/с` +
        (state.retrying.has(path) ? ` · повтор через ${Math.max(0, Math.ceil((state.retrying.get(path) - now) / 1000))} с` : '');
    });
    for (const job of state.recentJobs) lines.push(`${labels[job.stage]}: ${job.path}`);
    $('jobs').textContent = lines.join('\n\n') || 'Загрузок пока нет.';
    const points = state.history.points, peak = Math.max(0, ...points.map(p => p.rate));
    const filePeak = Math.max(0, ...points.map(p => p.fileRate || 0)), fileScale = Math.max(1, Math.ceil(filePeak));
    $('rateChartLabel').textContent = `Последние ${points.length} замеров · максимум ${formatBytes(peak)}/с · ${filePeak.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} файлов/с`;
    $('byteScale').textContent = `Скорость: 0–${formatBytes(Math.max(1, peak))}/с`;
    $('fileScale').textContent = `Сохранение: 0–${fileScale.toLocaleString('ru-RU')} файлов/с`;
    drawChart('rateChart', points, ['rate', 'fileRate'], [Math.max(1, peak), fileScale], ['#185d80', '#a85c13'], [false, true]);
    drawChart('threadChart', points, ['limit', 'active'], 12, ['#185d80', '#198754']);
  }
  function finishJob(path, stage) {
    state.jobs.delete(path); state.recentJobs.unshift({ path, stage }); state.recentJobs = state.recentJobs.slice(0, 10); renderJobs();
  }
  function fatal(message) { const e = new Error(message); e.stop = true; return e; }
  function cancelRecovery() {
    state.autoPending = false; state.recoveryEpoch++;
    $('recoveryInfo').textContent = 'Автоматическое продолжение выключено для текущей паузы.';
  }
  function finishRecovery() {
    // Only successful work after resumption proves progress. Jobs finishing
    // during the pause and local journal skips cannot reset the retry budget.
    if (!state.recovering || state.pause || state.autoPending) return;
    state.recovering = false; state.autoAttempts = 0; state.helperWaitingUntil = 0;
    $('recoveryInfo').textContent = 'После восстановления запрос выполнен успешно. Счётчик безуспешных попыток сброшен.';
    log('После восстановления запрос выполнен успешно. Следующая отдельная остановка начнётся с попытки 1/8.');
  }
  function manualRun() {
    cancelRecovery(); state.userPaused = false; state.recoveryBlocked = false; state.autoAttempts = 0;
    state.recoveryTarget = null;
    state.recovering = false; $('recoveryInfo').textContent = '';
  }
  const recoveryChannelName = 'noty-recovery-' + Math.random().toString(36).slice(2);
  const recoveryChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(recoveryChannelName) : null;
  let helperMonitor = null;
  function checkHelperConnection() {
    if (!state.helper) return false;
    if (!state.helper.closed) return true;
    // COOP may report closed for a live tab. Prefer an authenticated channel
    // response, and allow a bounded interval for a newly loaded document.
    if (recoveryChannel && state.helperToken) {
      if (Date.now() < state.helperConnectUntil || (state.helperProtocol && Date.now() - state.helperLastSeen < 5000)) return true;
      if (state.helperProtocol && !state.helperPingDeadline) {
        state.helperPingNonce = Math.random().toString(36).slice(2);
        state.helperPingDeadline = Date.now() + 10000;
        recoveryChannel.postMessage({ type: 'noty-helper-ping', token: state.helperToken, nonce: state.helperPingNonce });
        return true;
      }
      if (state.helperProtocol && Date.now() < state.helperPingDeadline) return true;
    }
    state.helper = null; state.helperReady = false; state.helperToken = '';
    const viaChannel = state.helperProtocol;
    state.helperProtocol = false; state.helperPingDeadline = 0; state.helperConnectUntil = 0;
    if (helperMonitor !== null) { clearInterval(helperMonitor); helperMonitor = null; }
    $('enableRecovery').textContent = 'Открыть служебную вкладку';
    $('recoveryInfo').textContent = viaChannel ? 'Служебная вкладка закрыта или не отвечает. Открой её снова кнопкой ниже.' :
      'Служебная вкладка закрыта. При необходимости открой её снова кнопкой ниже.';
    log(viaChannel ? 'Нет ответа служебной вкладки на проверку связи в течение 10 с.' : 'Прямая связь со служебной вкладкой потеряна.');
    return false;
  }
  // Check even when the download/recovery scheduler is idle. Focus catches
  // closure promptly after background-tab timer throttling.
  window.addEventListener('focus', checkHelperConnection);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkHelperConnection(); });
  function openHelper(refresh = false) {
    try {
      const connected = checkHelperConnection();
      if (connected && !refresh) { try { state.helper.focus(); } catch { /* Isolated helper. */ } return true; }
      const target = state.recoveryTarget || folderURL(root);
      if (connected && state.helperProtocol && recoveryChannel) {
        state.helperReady = false; state.helperRevision++; state.helperConnectUntil = Date.now() + 30000;
        state.helperPingDeadline = 0;
        recoveryChannel.postMessage({ type: 'noty-helper-refresh', token: state.helperToken, revision: state.helperRevision, target });
        $('enableRecovery').textContent = 'Служебная вкладка загружается…';
        $('recoveryInfo').textContent = 'Команда обновления отправлена служебной вкладке. Ожидаю загрузки страницы.';
        log('Служебной вкладке отправлена команда обновления по каналу связи.');
        return true;
      }
      state.helperReady = false;
      state.helperProtocol = false; state.helperRevision = 0; state.helperPingDeadline = 0;
      state.helperConnectUntil = recoveryChannel ? Date.now() + 30000 : 0;
      state.helperToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const url = new URL(target);
      if (!htmlRecoveryTarget(target)) {
        url.searchParams.set('noty_helper', state.helperToken);
        url.searchParams.set('noty_channel', recoveryChannelName);
      }
      // Seed tab-local state before the first network navigation: a redirect
      // can strip the URL parameters before this userscript ever executes.
      if (!state.helper || state.helper.closed) state.helper = window.open('', '_blank');
      if (!state.helper) throw new Error('popup blocked');
      const context = JSON.stringify({ token: state.helperToken, channel: recoveryChannelName, revision: 0, savedAt: Date.now(), target });
      try { state.helper.name = 'noty-helper:' + context; } catch { /* URL and storage remain fallbacks. */ }
      try { state.helper.sessionStorage.setItem(helperStorageKey, context); } catch { /* Window name and URL remain fallbacks. */ }
      state.helper.location.replace(url.href);
      if (helperMonitor === null) helperMonitor = setInterval(checkHelperConnection, 1000);
      $('enableRecovery').textContent = 'Служебная вкладка загружается…';
      $('recoveryInfo').textContent = 'Служебная вкладка открыта. Оставь её открытой; очередь работает в основной вкладке.';
      return true;
    } catch (error) {
      $('enableRecovery').textContent = 'Открыть служебную вкладку';
      $('recoveryInfo').textContent = error.message === 'popup blocked' ?
        'Разреши всплывающие окна для сайта и нажми «Открыть служебную вкладку».' :
        'Не удалось обновить служебную вкладку. Подробности — в ходе работы.';
      log(`Обновление служебной вкладки: ${error.name}: ${error.message}`);
      return false;
    }
  }
  $('enableRecovery').onclick = () => {
    settings.autoRecover = true; fillSettings();
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* Optional persistence. */ }
    openHelper(true);
  };
  $('challengeLink').onclick = event => { event.preventDefault(); $('enableRecovery').onclick(); };
  function helperReady(data, viaChannel = false) {
    if (data?.type !== 'noty-directory-ready' || !state.helperToken || data.token !== state.helperToken ||
      (data.revision || 0) !== state.helperRevision || (!viaChannel && !checkHelperConnection())) return;
    state.helperReady = true;
    $('enableRecovery').textContent = 'Служебная вкладка подключена';
    $('recoveryInfo').textContent = 'Служебная вкладка сообщила: страница загрузилась. Доступ к файлу проверит повторный запрос.';
    if (state.autoPending) serviceRecovery();
  }
  if (recoveryChannel) recoveryChannel.onmessage = event => {
    const data = event.data;
    if (event.origin !== ORIGIN || !state.helperToken || data?.token !== state.helperToken || data.protocol !== 2 ||
      data.revision !== state.helperRevision || !['noty-helper-alive', 'noty-directory-ready'].includes(data.type)) return;
    if (data.nonce && data.nonce !== state.helperPingNonce) return;
    state.helperProtocol = true; state.helperLastSeen = Date.now(); state.helperPingDeadline = 0;
    if (!data.navigating) state.helperConnectUntil = 0;
    helperReady(data, true);
  };
  window.addEventListener('message', event => {
    if (event.origin === ORIGIN && event.source === state.helper) helperReady(event.data);
  });
  function queueRecovery(error) {
    // File-level plain denials never reach global recovery. Directory access
    // failures and recognized challenges retain the bounded recovery flow.
    if (error.networkFailure || error.challenge || [403, 429, 503].includes(error.status)) {
      state.recoveryTarget = htmlRecoveryTarget(error.url) || folderURL(root);
    }
    if (error.networkFailure || error.challenge || error.status === 403) {
      $('challengeLink').hidden = false; $('challengeLink').href = state.recoveryTarget;
      log(`Проверка доступа: ${error.evidence || 'ответ сервера'}. Страница проверки: ${state.recoveryTarget}`);
    }
    if (!error.networkFailure && !error.challenge && ![403, 429, 503].includes(error.status)) {
      state.stopReason = error.message; state.recoveryBlocked = true; cancelRecovery(); return;
    }
    if (settings.autoRecover && !state.userPaused && !state.recoveryBlocked && state.autoAttempts < 8) {
      if (!state.autoPending) {
        state.autoAttempts++; state.helperReady = false; state.helperWaitingUntil = 0;
      }
      state.autoPending = true;
      beginCooldown({ ...error, retryMs: recoveryDelay(state.autoAttempts, error.retryMs) });
      $('recoveryInfo').textContent = 'Автопродолжение включено. Ожидаю завершения начатых файлов и задержки перед проверкой доступа.';
    } else {
      if (error.retryMs) beginCooldown(error);
      if (state.autoAttempts >= 8) $('recoveryInfo').textContent = 'Лимит 8 автоматических попыток исчерпан. Проверь доступ к сайту, сеть и прокси, затем продолжи вручную.';
    }
  }
  function serviceRecovery() {
    checkHelperConnection();
    if (!state.autoPending || state.busy || state.preparing || Date.now() < state.cooldownUntil) return;
    if (state.helperReady) { void resumeAutomatically(); return; }
    if (Date.now() < state.helperWaitingUntil) return;
    if (state.helperWaitingUntil) {
      if (state.autoAttempts >= 8) {
        cancelRecovery(); $('recoveryInfo').textContent = 'Лимит 8 автоматических попыток исчерпан. Проверь доступ к сайту, сеть и прокси, затем продолжи вручную.';
        controls(); return;
      }
      state.autoAttempts++;
    }
    state.helperWaitingUntil = Date.now() + recoveryDelay(state.autoAttempts);
    openHelper(true);
  }
  async function resumeAutomatically() {
    const epoch = state.recoveryEpoch, phase = state.phase;
    state.preparing = true; controls();
    try {
      if (phase === 'download' && await state.output?.queryPermission({ mode: 'readwrite' }) !== 'granted') {
        cancelRecovery(); say('Для продолжения нужен доступ к папке. Нажми кнопку скачивания.'); return;
      }
      if (epoch !== state.recoveryEpoch || !state.autoPending || state.userPaused || !settings.autoRecover) return;
      state.autoPending = false; state.recovering = true;
      $('challengeLink').hidden = true;
      $('recoveryInfo').textContent = `Страница проверки загрузилась. Автопродолжение ${state.autoAttempts}/8, один поток до первого успешного запроса.`;
      log('Страница проверки загрузилась. Повторяю запрос; доступ к файлу ещё не подтверждён.');
      if (phase === 'scan') { state.preparing = false; await scan(true); }
      else await runQueue();
    } catch (e) { cancelRecovery(); say('Автопродолжение остановлено: ' + e.message); }
    finally { state.preparing = false; controls(); }
  }
  async function retryOperation(path, operation) {
    try { return await withRetries(operation, { settings: () => settings, paused: () => state.pause,
      onRetry: (error, attempt, delay) => {
        state.loadedBytes.delete(path); state.etaRate = 0; state.retryEpoch++;
        tuner.resetWindow(performance.now());
        state.retrying.set(path, performance.now() + delay);
        if (state.jobs.has(path)) state.jobs.get(path).stage = 'retry';
        log(`${path || 'Root'}: ${error.message}. Автоповтор ${attempt}/${settings.maxRetries} через ${(delay / 1000).toFixed(1)} с.`);
        showVolume();
      },
      onWaitEnd: () => { state.retrying.delete(path); }
    }); } catch (cause) {
      // Only failures tagged at the fetch/read boundary enter network recovery.
      // HTTP item errors, manual pauses and filesystem errors keep their policies.
      if (!cause.networkFailure || cause.pausedRetry) throw cause;
      throw Object.assign(new Error(`Сетевой запрос не завершён: ${cause.message}. Очередь приостановлена; текущая запись остаётся в очереди для повтора.`, { cause }),
        { stop: true, networkFailure: true, retryMs: 30000, evidence: `${cause.name || 'Error'}: ${cause.message}; причина сетевого сбоя не определена` });
    }
  }
  async function fetchChecked(url, signal) {
    const res = await networkOperation(() => fetch(url, { credentials: 'same-origin', redirect: 'error', signal }));
    if (res.headers.get('cf-mitigated') === 'challenge') {
      await res.body?.cancel(); throw challengeError(retryDelay(res.headers.get('retry-after')), url, `HTTP ${res.status}; cf-mitigated: challenge`);
    }
    if ([401, 403, 429, 503].includes(res.status)) {
      if ([403, 503].includes(res.status) && res.body) {
        const reader = res.body.getReader(); const decoder = new TextDecoder(); let prefix = '';
        try {
          while (prefix.length < 4096) {
            const part = await networkOperation(() => reader.read()); if (part.done) break;
            prefix += decoder.decode(part.value.subarray(0, 4096 - prefix.length));
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        if (isChallenge(prefix)) throw challengeError(retryDelay(res.headers.get('retry-after')), url, `HTTP ${res.status}; признаки страницы проверки в HTML`);
      }
      await res.body?.cancel();
      const item = classifyLink(url, folderURL(root), root, root);
      // Recognized challenges were handled above. A plain file denial is an
      // item failure; directory denials still require the scan to pause.
      if (res.status === 403 && item?.type === 'file') {
        const name = macMetadataPath(item.path) ? 'служебному файлу macOS' : 'файлу';
        const error = new Error(`HTTP 403. Сервер запретил доступ к ${name}; удаляю ссылку из списка и кеша, продолжаю остальные.`);
        error.status = res.status; error.url = url; error.excludeFromManifest = true;
        throw error;
      }
      const e = fatal(res.status === 403 ? 'HTTP 403. Сервер отказал в доступе; очередь приостановлена.' :
        `HTTP ${res.status}. Загрузка остановлена. Открой сайт в другой вкладке и пройди проверку, если она появилась.`);
      e.status = res.status; e.url = url;
      if ([403, 429, 503].includes(res.status)) e.retryMs = retryDelay(res.headers.get('retry-after'));
      throw e;
    }
    if (!res.ok) {
      await res.body?.cancel();
      const error = new Error('HTTP ' + res.status);
      if ([408, 425, 500, 502, 504].includes(res.status)) transient(error);
      throw error;
    }
    return res;
  }
  async function scan(automatic = false) {
    if (state.busy || state.preparing || state.scanned || Date.now() < state.cooldownUntil) return;
    if (!automatic) manualRun();
    state.manifestLoaded = true;
    state.busy = true; state.pause = false; state.phase = 'scan'; state.stopReason = ''; controls();
    try {
      await runPool({ queue: state.folders, limit: () => state.recovering ? 1 : settings.scanThreads, paused: () => state.pause,
        delayMs: () => settings.scanDelayMs,
        worker: path => retryOperation(path, async () => {
          state.inFlightFolders.add(path);
          const res = await fetchChecked(folderURL(path), AbortSignal.timeout(60000));
          const html = await networkOperation(() => res.text());
          if (isChallenge(html)) throw challengeError();
          const doc = new DOMParser().parseFromString(html, 'text/html');
          if (!directoryReady(doc)) {
            throw fatal('Не получен каталог. Открой сайт в другой вкладке, пройди проверку и нажми «Найти файлы» снова.');
          }
          for (const a of doc.querySelectorAll('table a[href]')) {
            const item = classifyLink(a.getAttribute('href'), folderURL(path), root, path);
            if (!item) continue;
            if (item.type === 'folder') {
              if (!state.knownFolders.has(item.path)) {
                state.knownFolders.add(item.path); state.folders.push(item.path);
              }
            } else if (!state.files.has(item.path)) state.files.set(item.path, { ...item, ...listingMetadata(a) });
          }
          state.visited.add(path);
        }),
        complete: path => { finishRecovery(); state.inFlightFolders.delete(path); state.listGeneratedAt = new Date().toISOString(); showVolume(); scheduleCache(); },
        failed: (e, path) => {
          state.inFlightFolders.delete(path); state.folders.unshift(path); state.pause = true;
          if (!e.pausedRetry) { state.stopReason ||= e.message; log(path + ': ' + e.message); }
          if (!e.pausedRetry) queueRecovery(e);
        },
        tick: (active, queued) => say(state.stopReason || `${state.pause ? 'Пауза: завершаю запросы' : 'Собираю папки'}…\nПапок: ${state.visited.size}; файлов: ${state.files.size}; запросов: ${active}; в очереди: ${queued}; ждут повтора: ${state.retrying.size}.`)
      });
      if (!state.folders.length) {
        checkCollisions([...state.files.values()], root);
        state.scanned = true;
        updateChanges(); refreshSelection();
        say(`Найдено ${state.files.size} файлов в ${state.visited.size} папках.\nВыбери папку на компьютере для скачивания.`);
      } else say((state.stopReason ? state.stopReason + '\n' : '') + `Поиск на паузе. Найдено ${state.files.size} файлов. Нажми «Найти файлы», чтобы продолжить.`);
    } catch (e) { say(e.message); log(e.message); }
    finally { await saveCache(); state.busy = false; refreshSelection(); }
  }

  function beginCooldown(error) {
    state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + error.retryMs);
    if (state.phase === 'scan') settings.scanThreads = Math.max(1, Math.floor(settings.scanThreads / 2));
    // Recovery temporarily caps downloads through targetThreads(). Preserve
    // the user's manual preference so successful recovery restores it.
    else if (settings.auto) tuner.penalize(performance.now());
    fillSettings();
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* Optional persistence. */ }
    if (!state.ticker) state.ticker = setInterval(() => {
      controls();
      if (!state.busy && !state.preparing && (state.autoPending || state.pause)) say(`${state.stopReason}\n` + (state.autoPending
        ? `Ожидание доступа: попытка ${state.autoAttempts}/8. Следующее действие через ${Math.max(0, Math.ceil((Math.max(state.cooldownUntil, state.helperReady ? 0 : state.helperWaitingUntil) - Date.now()) / 1000))} с. «Пауза» отменяет автопродолжение.`
        : `Повтор доступен через ${Math.max(0, Math.ceil((state.cooldownUntil - Date.now()) / 1000))} с. Затем нажми «${state.phase === 'scan' ? 'Найти файлы' : 'Выбрать папку и скачать'}».`));
      serviceRecovery();
      if (Date.now() >= state.cooldownUntil && !state.autoPending) { clearInterval(state.ticker); state.ticker = null; }
    }, 1000);
  }

  let cacheTimer = null, cacheFailed = false;
  function snapshot() {
    return { version: 2, root, generatedAt: state.listGeneratedAt, savedAt: new Date().toISOString(), files: [...state.files.values()],
      visited: [...state.visited], pending: [...new Set([...state.folders, ...state.inFlightFolders])].filter(p => !state.visited.has(p)),
      scanned: state.scanned, legacy: state.legacy, view: state.view, previous: state.previous };
  }
  function scheduleCache() {
    if (cacheTimer === null && !cacheFailed) cacheTimer = setTimeout(() => { cacheTimer = null; void saveCache(); }, 5000);
  }
  async function saveCache() {
    clearTimeout(cacheTimer); cacheTimer = null;
    if (cacheFailed) return false;
    const data = snapshot();
    try {
      await serializeCache(() => cacheRequest(window.indexedDB, data.root, data));
      state.cacheAvailable = true;
      $('cacheInfo').textContent = `Кеш: ${data.files.length} файлов, ${data.scanned ? 'список готов' : 'обход не завершён'} · ${new Date(data.generatedAt).toLocaleString()}`;
      return true;
    } catch (e) { cacheFailed = true; $('cacheInfo').textContent = e.message + ' Сохрани JSON.'; log(e.message); return false; }
  }
  function applyManifest(data, sourceName) {
    manualRun();
    root = data.root; state.files = new Map(data.files.map(f => [f.path, f])); state.manifestLoaded = true;
    state.editorSelected.clear(); state.editorUndo = null; state.editorPage = 0;
    $('editorQuery').value = ''; $('editorNotice').textContent = 'Удаляются только ссылки из списка. Локальные файлы сохраняются. Новый сбор с сайта может вернуть удалённые ссылки.';
    state.visited = new Set(data.visited); state.folders = [...data.pending]; state.inFlightFolders.clear();
    state.knownFolders = new Set([...data.visited, ...data.pending]);
    state.scanned = data.scanned; state.legacy = data.legacy; state.output = null; state.journal = null;
    state.destination = null; state.previous = data.previous || null;
    let view = {};
    try { view = JSON.parse(localStorage.getItem('noty-view:' + root) || '{}'); } catch { /* Optional preferences. */ }
    state.view = normalizeView(data.view || view, root); state.expanded = new Set([root]); state.treeLimit = 150;
    state.listGeneratedAt = data.generatedAt || '';
    resetSession(); invalidateReview(); state.pause = false; state.etaRate = 0;
    fillFilters(); updateChanges(); refreshSelection(); renderJobs();
    $('root').textContent = root || 'Весь архив (Root)'; progress();
    say(`${sourceName}: ${data.files.length} файлов. ${data.generatedAt ? 'Дата списка: ' + data.generatedAt + '. ' : ''}\n` +
      (data.legacy ? 'Старый формат: полнота обхода неизвестна. Можно скачать список или собрать заново.' :
        data.scanned ? 'Можно выбрать папку и скачать. Для обновления списка — «Собрать заново».' : 'Обход не завершён. Нажми «Найти файлы», чтобы продолжить.'));
  }
  async function checkCache() {
    const scope = root;
    try {
      const data = await cacheRequest(window.indexedDB, scope);
      if (scope !== root) return;
      state.cacheAvailable = !!data;
      $('cacheInfo').textContent = data ? `Есть кеш этого раздела от ${data.generatedAt}. Нажми «Из кеша».` : 'Кеша этого раздела пока нет. Он сохранится при сборе.';
    } catch (e) { if (scope === root) $('cacheInfo').textContent = e.message; }
    controls();
  }
  async function readJournal(dir) {
    try {
      const handle = await dir.getFileHandle(JOURNAL);
      const data = JSON.parse(await (await handle.getFile()).text());
      if (data.version !== 1 || data.root !== root || !data.completed || typeof data.completed !== 'object') {
        throw new Error('Журнал принадлежит другому каталогу. Выбери пустую папку.');
      }
      return data;
    } catch (e) {
      if (e.name === 'NotFoundError') return { version: 1, root, completed: {} };
      throw e;
    }
  }
  async function saveJournal() {
    return serializeJournal(async () => {
      let stream;
      try {
        const path = outputName() + '/' + JOURNAL;
        const handle = await diskOperation('создание журнала', path, () => state.output.getFileHandle(JOURNAL, { create: true }));
        stream = await diskOperation('открытие журнала для записи', path, () => handle.createWritable());
        await diskOperation('запись журнала', path, () => stream.write(JSON.stringify(state.journal, null, 2)));
        await diskOperation('завершение журнала', path, () => stream.close());
      } catch (e) { if (stream) await stream.abort().catch(() => {}); throw e; }
    });
  }
  async function locate(parts) {
    let dir = state.output; const walked = [outputName()];
    for (const part of parts.slice(0, -1)) {
      walked.push(part);
      dir = await diskOperation('создание папки', walked.join('/'), () => dir.getDirectoryHandle(part, { create: true }), false, 'directory');
    }
    return dir;
  }
  async function downloadFile(item) {
    const started = performance.now();
    state.jobs.set(item.path, { stage: 'waiting', sampleAt: started, sampleBytes: 0, dataAt: started, rate: 0, sizeBytes: item.sizeBytes });
    const job = state.jobs.get(item.path), remote = remoteMetadata(item);
    state.loadedBytes.set(item.path, 0);
    const parts = localParts(item.path, root);
    const relative = parts.join('/');
    const localPath = outputName() + '/' + relative;
    const dir = await locate(parts);
    const existing = await diskOperation('поиск файла', localPath, () => dir.getFileHandle(parts.at(-1)), true, true);
    const record = state.journal.completed[item.url];
    const replacement = state.replacements.get(item.path);
    if (!existing && replacement) throw new Error('Файл изменился после проверки. Проверь папку снова: ' + relative);
    if (existing) {
      const file = await diskOperation('чтение файла', localPath, () => existing.getFile());
      if (replacement && !sameLocal(file, replacement)) throw new Error('Файл изменился после проверки. Проверь папку снова: ' + relative);
      const oldSourceChanged = !record?.remote && state.changeByPath.get(item.path) === 'changed';
      if (!replacement && !oldSourceChanged && verifyFile(item, root, file, record) === 'verified') {
        item.sizeBytes = file.size;
        await saveJournal(); log('Уже сохранён: ' + relative); return;
      }
      // Never overwrite a nonempty file without matching journal evidence.
      if (!replacement && file.size !== 0) throw new Error('Нужна проверка и выбор замены существующего файла: ' + relative);
    }
    let stream = null;
    let reader = null;
    const controller = new AbortController();
    let timer;
    const resetTimeout = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), 90000); };
    resetTimeout();
    try {
      const res = await fetchChecked(item.url, controller.signal);
      if (!res.body) throw new Error('Пустой ответ сервера');
      const lengthHeader = res.headers.get('content-length');
      if (lengthHeader !== null && /^\d+$/.test(lengthHeader) && !res.headers.get('content-encoding') && validSize(Number(lengthHeader))) {
        item.sizeBytes = Number(lengthHeader);
      }
      job.sizeBytes = item.sizeBytes;
      reader = res.body.getReader();
      job.stage = 'download';
      const chunks = []; let initialSize = 0; let ended = false;
      while (initialSize < 8192) {
        resetTimeout(); const part = await networkOperation(() => reader.read());
        if (part.done) { ended = true; break; }
        state.received += part.value.byteLength;
        state.loadedBytes.set(item.path, (state.loadedBytes.get(item.path) || 0) + part.value.byteLength);
        chunks.push(part.value); initialSize += part.value.byteLength;
      }
      if (!initialSize) throw new Error('Пустой файл');
      const header = new Uint8Array(Math.min(initialSize, 8192));
      let offset = 0;
      for (const chunk of chunks) { const n = Math.min(chunk.length, header.length - offset); header.set(chunk.subarray(0, n), offset); offset += n; }
      try { validateHeader(header, item.path, res.headers.get('content-type') || ''); }
      // A malformed file is a per-item failure. Only confirmed challenges carry
      // their own global stop; otherwise leave the rest of the queue running.
      catch (e) { e.url = item.url; throw e; }
      const handle = existing || await diskOperation('создание файла', localPath, () => dir.getFileHandle(parts.at(-1), { create: true }), false, true);
      if (replacement && !sameLocal(await diskOperation('повторное чтение файла', localPath, () => handle.getFile()), replacement)) throw new Error('Файл изменился после проверки. Проверь папку снова: ' + relative);
      job.stage = 'saving';
      stream = await diskOperation('открытие файла для записи', localPath, () => handle.createWritable());
      let size = 0;
      for (const chunk of chunks) { await diskOperation('запись файла', localPath, () => stream.write(chunk)); size += chunk.length; }
      while (!ended) {
        job.stage = 'download';
        resetTimeout(); const part = await networkOperation(() => reader.read());
        if (part.done) break;
        state.received += part.value.byteLength;
        state.loadedBytes.set(item.path, (state.loadedBytes.get(item.path) || 0) + part.value.byteLength);
        job.stage = 'saving'; await diskOperation('запись файла', localPath, () => stream.write(part.value)); size += part.value.length;
      }
      const length = res.headers.get('content-length');
      if (length && !res.headers.get('content-encoding') && Number(length) !== size) throw transient(new Error('Файл загрузился не полностью'));
      job.stage = 'saving'; await diskOperation('завершение файла', localPath, () => stream.close()); stream = null;
      state.replacements.delete(item.path);
      item.sizeBytes = size;
      state.journal.completed[item.url] = { path: relative, size, remote, savedAt: new Date().toISOString() };
      job.stage = 'journal';
      await saveJournal(); job.downloaded = true; log('Сохранён: ' + relative);
    } finally {
      clearTimeout(timer); controller.abort();
      if (reader) await reader.cancel().catch(() => {});
      if (stream) await stream.abort().catch(() => {});
    }
  }
  async function runQueue() {
    if (state.busy || Date.now() < state.cooldownUntil) return;
    state.busy = true; state.pause = false; state.phase = 'download'; controls();
    state.stopReason = ''; state.rate = 0; state.etaRate = 0; state.fileRate = 0; state.completionSamples = [];
    let speedMeter = new SpeedMeter(), fileMeter = new SpeedMeter(), retryEpoch = state.retryEpoch;
    tuner.resetWindow(performance.now());
    let lastTime = performance.now(), lastBytes = state.received, lastFiles = state.transferredFiles;
    let lastSavedBytes = state.transferredBytes, lastSmall = state.transferredSmall;
    try {
      await runPool({ queue: state.queue, limit: targetThreads, paused: () => state.pause,
        delayMs: () => settings.delayMs, worker: item => retryOperation(item.path, () => downloadFile(item)),
        complete: item => {
          if (state.jobs.get(item.path)?.downloaded) {
            finishRecovery();
            state.transferredFiles++;
            state.transferredBytes += item.sizeBytes;
            if (item.sizeBytes <= 262144) state.transferredSmall++;
            state.completionSamples.push({ at: performance.now(), size: item.sizeBytes });
            if (state.completionSamples.length > 200) state.completionSamples.shift();
          }
          state.completedPaths.add(item.path); state.loadedBytes.delete(item.path); state.done++;
          const row = state.review?.rows.find(r => r.path === item.path);
          if (row) {
            row.status = 'verified'; row.localSize = item.sizeBytes; row.journalSize = item.sizeBytes;
            state.review.updatedAt = new Date().toISOString(); state.reviewSelected.delete(item.path);
            if (performance.now() - state.reviewRenderedAt >= 500) renderReview();
          }
          progress(); finishJob(item.path, 'done');
        },
        failed: async (e, item) => {
          state.loadedBytes.delete(item.path);
          finishJob(item.path, e.pausedRetry ? 'paused' : 'error');
          if (e.pausedRetry) { state.queue.unshift(item); return; }
          log(item.path + ': ' + e.message);
          tuner.resetWindow(performance.now());
          if (e.stop || ['NotAllowedError', 'QuotaExceededError', 'NotReadableError'].includes(e.name)) {
            state.pause = true; state.queue.unshift(item);
            if (!state.stopReason) state.stopReason = e.message;
            queueRecovery(e);
            controls();
          } else {
            state.errors.push({ item, error: e.message, ...(e.excludeFromManifest ? { excluded: true } : {}) });
            if (e.excludeFromManifest) {
              state.files.delete(item.path);
              state.editorSelected.delete(item.path);
              if (state.editorUndo) state.editorUndo = state.editorUndo.filter(f => f.path !== item.path);
              if (state.view.files) state.view.files = state.view.files.filter(path => path !== item.path);
              if (state.review) state.review.rows = state.review.rows.filter(row => row.path !== item.path);
              state.reviewSelected.delete(item.path); state.replacements.delete(item.path);
              refreshSelection();
              // Await the serialized cache transaction before this worker finishes.
              await saveCache();
            }
          }
        },
        tick: (active, queued) => {
          state.active = active;
          const now = performance.now(), elapsed = now - lastTime;
          if (elapsed >= 1000) {
            const delta = state.received - lastBytes;
            const reason = state.pause ? 'pause' : state.recovering ? 'recovery' : state.retrying.size ? 'retry' :
              active > targetThreads() ? 'draining' : queued === 0 ? 'tail' : '';
            const work = { files: state.transferredFiles - lastFiles, completedBytes: state.transferredBytes - lastSavedBytes,
              smallFiles: state.transferredSmall - lastSmall, active, reason,
              largeActive: [...state.jobs.values()].some(job => !validSize(job.sizeBytes) || job.sizeBytes > 262144) };
            if (retryEpoch !== state.retryEpoch) {
              speedMeter = new SpeedMeter(); fileMeter = new SpeedMeter(); state.completionSamples = [];
              lastFiles = state.transferredFiles; retryEpoch = state.retryEpoch;
            }
            state.rate = delta * 1000 / elapsed;
            state.etaRate = speedMeter.observe(delta, elapsed);
            state.fileRate = fileMeter.observe(state.transferredFiles - lastFiles, elapsed);
            lastFiles = state.transferredFiles;
            if (settings.auto) {
              const decision = tuner.observe(delta, elapsed, !reason, now, work);
              if (decision && decision.from !== decision.to) log(`Автотюн: ${decision.from} → ${decision.to}; ` +
                (decision.metric === 'files' ? `${decision.fileRate.toFixed(2)} файлов/с` : formatRate(decision.rate)) +
                (decision.phase === 'confirm' ? '; контрольный замер прежнего лимита.' : '.'));
            }
            lastSavedBytes = state.transferredBytes; lastSmall = state.transferredSmall;
            lastTime = now; lastBytes = state.received;
            renderJobs(true);
          }
          showSpeed(elapsed >= 1000);
          say(state.stopReason ? state.stopReason + (state.pause && active ? `\nПауза: завершаю начатые файлы (${active}). Новые не запускаются.` : '') :
            (state.pause ? 'Пауза: докачиваю уже начатые файлы…' : `Файлов: ${state.done}/${state.total}. Ошибок: ${state.errors.length}.\nВ работе: ${active}; в очереди: ${queued}; ждут повтора: ${state.retrying.size}.`));
        }
      });
      if (!state.queue.length) say(`Готово: ${state.done}/${state.total}. Ошибок: ${state.errors.length}.`);
      else if (state.queue.length) {
        say((state.stopReason || '') + (state.autoPending ? '\nНа паузе. Автообновление включено; ожидаю доступ к каталогу.' : '\nНа паузе. Нажми кнопку скачивания для продолжения.'));
        log('Очередь сохранена в этой вкладке.');
      }
    } finally { state.busy = false; state.active = 0; state.rate = 0; state.etaRate = 0; state.fileRate = 0; showSpeed(); renderJobs(); renderReview(); controls(); }
  }
  $('scan').onclick = () => scan();
  $('pause').onclick = () => { state.userPaused = true; cancelRecovery(); state.pause = true; say('На паузе. Автопродолжение отменено; уже начатые файлы или страницы завершаются.'); showVolume(); controls(); };
  async function startDownload() {
    if (state.busy || state.preparing || !state.scanned || !state.selected.length || Date.now() < state.cooldownUntil) return;
    manualRun();
    state.preparing = true; controls();
    try {
      if (!state.output) {
        if (!window.showDirectoryPicker) throw new Error('Нужен Chrome или Edge с выбором папки. Открой сайт в обычном браузере.');
        // Invoke synchronously from the click handler to preserve user activation.
        const selected = state.destination || await window.showDirectoryPicker({ mode: 'readwrite', id: 'noty-textbooks', startIn: 'downloads' });
        if (await selected.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('Нет разрешения на запись в папку.');
        const output = await selected.getDirectoryHandle(outputName(), { create: true });
        const journal = await readJournal(output);
        state.output = output; state.journal = journal;
        state.destination = selected;
      }
      if (!state.sessionReady) prepareQueue(state.selected);
      if (await state.output.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('Нет разрешения на запись в папку.');
      await runQueue();
    } catch (e) { if (e.name !== 'AbortError') say(e.message); }
    finally { state.preparing = false; controls(); }
  }
  $('download').onclick = startDownload;
  $('retry').onclick = async () => {
    if (state.busy || state.preparing || Date.now() < state.cooldownUntil) return;
    const retryable = state.errors.filter(e => !e.excluded);
    if (!retryable.length) return;
    manualRun();
    state.queue.push(...retryable.map(e => e.item)); state.errors = state.errors.filter(e => e.excluded);
    await runQueue();
  };
  $('export').onclick = () => {
    const data = { ...snapshot(), errors: state.errors };
    exportJSON(data, 'noty-files.json');
  };
  $('editList').onclick = () => {
    renderEditor();
    if (!editor.open) { if (editor.showModal) editor.showModal(); else editor.setAttribute('open', ''); }
  };
  $('editorClose').onclick = () => { if (editor.close) editor.close(); else editor.removeAttribute('open'); };
  $('editorQuery').oninput = $('editorSort').onchange = () => { state.editorPage = 0; renderEditor(); };
  $('editorPrev').onclick = () => { state.editorPage = Math.max(0, state.editorPage - 1); renderEditor(); $('editorRows').parentElement.parentElement.scrollTop = 0; };
  $('editorNext').onclick = () => { state.editorPage++; renderEditor(); $('editorRows').parentElement.parentElement.scrollTop = 0; };
  $('editorSelectAll').onclick = () => { for (const item of editorItems()) state.editorSelected.add(item.path); renderEditor(); };
  $('editorClear').onclick = () => { state.editorSelected.clear(); renderEditor(); };
  $('editorDelete').onclick = () => editManifest();
  $('editorUndo').onclick = () => editManifest(true);
  $('editorExport').onclick = () => { if (!state.busy && !state.preparing) $('export').onclick(); };
  $('editorSave').onclick = async () => {
    if (state.busy || state.preparing || state.autoPending) return;
    state.preparing = true; controls(); cacheFailed = false;
    $('editorNotice').textContent = 'Сохраняю список в кеш…';
    try { $('editorNotice').textContent = await saveCache() ? 'Список сохранён в кеше.' : 'Кеш недоступен. Скачай JSON, чтобы не потерять изменения.'; }
    finally { state.preparing = false; controls(); }
  };
  $('import').onclick = () => $('importFile').click();
  $('importFile').onchange = async () => {
    const file = $('importFile').files[0];
    if (!file || state.busy || state.preparing) return;
    state.preparing = true; controls();
    try {
      if (file.size > 100 * 1024 * 1024) throw new Error('JSON больше 100 МиБ. Выбери список меньшего раздела.');
      const data = validateManifest(JSON.parse(await file.text()));
      applyManifest(data, 'JSON загружен'); await saveCache();
    } catch (e) { say('Не удалось загрузить список: ' + e.message); }
    finally { state.preparing = false; $('importFile').value = ''; controls(); }
  };
  $('cache').onclick = async () => {
    if (state.busy || state.preparing) return;
    state.preparing = true; controls();
    try { applyManifest(validateManifest(await cacheRequest(window.indexedDB, root)), 'Кеш загружен'); }
    catch (e) { say('Не удалось прочитать кеш: ' + e.message); }
    finally { state.preparing = false; controls(); }
  };
  $('rescan').onclick = async () => {
    if (state.busy || state.preparing || Date.now() < state.cooldownUntil) return;
    const previous = state.scanned ? { root, files: [...state.files.values()].map(f => ({ ...f })), generatedAt: state.listGeneratedAt } : state.previous;
    const view = state.view;
    applyManifest({ root, files: [], visited: [], pending: [root], scanned: false, legacy: false, previous, view }, 'Новый обход');
    await scan();
  };
  $('updateScan').onclick = async () => { await $('rescan').onclick(); $('updateDetails').open = true; };
  $('selectAll').onclick = () => { state.view.folders = []; state.view.files = null; refreshSelection(true); };
  $('selectNone').onclick = () => { state.view.folders = [[root, false]]; state.view.files = null; refreshSelection(true); };
  $('selectUpdates').onclick = () => {
    state.view.files = state.changes.filter(r => ['added', 'changed'].includes(r.status)).map(r => r.path); refreshSelection(true);
    $('selectionDetails').open = true;
  };
  for (const id of ['includeExt', 'excludeExt', 'fileQuery', 'maxMiB', 'unknownSize']) $(id).onchange = () => {
    state.view.filters = normalizeFilters({ include: $('includeExt').value, exclude: $('excludeExt').value,
      query: $('fileQuery').value, maxMiB: $('maxMiB').value, unknown: $('unknownSize').checked });
    fillFilters(); refreshSelection(true);
  };
  $('clearFilters').onclick = () => { state.view.filters = normalizeFilters(); fillFilters(); refreshSelection(true); };
  $('folderSearch').oninput = () => { state.treeLimit = 150; renderTree(); };
  $('treeMore').onclick = () => { state.treeLimit += 150; renderTree(); };
  $('changeMore').onclick = () => { state.changeLimit += 100; renderChanges(); };
  $('reportMore').onclick = () => { state.reportLimit += 100; renderReview(); };
  $('reportFilter').onchange = () => { state.reportLimit = 100; renderReview(); controls(); };
  $('verify').onclick = verifyDirectory;
  $('repair').onclick = async () => {
    if (state.busy || state.preparing || !state.review?.complete || Date.now() < state.cooldownUntil) return;
    const paths = new Set(state.review.rows.filter(r => ['missing', 'incomplete'].includes(r.status)).map(r => r.path));
    const files = state.selected.filter(f => paths.has(f.path));
    if (!files.length) return;
    state.replacements.clear(); prepareQueue(files); await startDownload();
  };
  $('replaceSelected').onclick = async () => {
    if (state.busy || state.preparing || !state.review?.complete || Date.now() < state.cooldownUntil) return;
    const rows = state.review.rows.filter(r => state.reviewSelected.has(r.path) && ['mismatch', 'changed', 'uncertain'].includes(r.status));
    if (!rows.length) return;
    state.replacements = new Map(rows.map(r => [r.path, { size: r.localSize, lastModified: r.lastModified }]));
    prepareQueue(rows.map(r => state.files.get(r.path))); await startDownload();
  };
  $('exportReport').onclick = () => { if (state.review) exportJSON(state.review, 'noty-verification.json'); };
  $('exportChanges').onclick = () => exportJSON({ root, generatedAt: new Date().toISOString(), previousDate: state.previous?.generatedAt, changes: state.changes }, 'noty-changes.json');
  fillFilters(); refreshSelection();
  void checkCache();
  window.addEventListener('beforeunload', e => { if (state.busy || state.autoPending) { e.preventDefault(); e.returnValue = ''; } });
})();
