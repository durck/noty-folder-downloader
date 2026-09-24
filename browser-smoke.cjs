// Offline acceptance checks in an isolated browser profile; no live-site requests.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = '_УЧЕБНИКИ';
const origin = 'https://noty.propovednik.com';
const urlFor = name => origin + '/Public/' + encodeURIComponent(root) + '/' + name;
const source = fs.readFileSync(path.join(__dirname, 'noty-folder-downloader.user.js'), 'utf8');

(async () => {
  const candidates = [process.env.BROWSER_PATH, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean);
  const executablePath = candidates.find(p => fs.existsSync(p));
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    let revision = 1;
    let challengeNext = false, helperBlocked = false, helperNavigations = 0, networkOutage = false;
    const incidentAttempts = new Map();
    let htmlAccess = false, htmlNavigations = 0;
    const htmlLesson = '<!doctype html><html><head><meta charset="utf-8"><title>Music</title></head><body><h1>Music lesson</h1>' +
      '<script>/* /cdn-cgi/challenge-platform/scripts/jsd/api.js */</script></body></html>';
    const fetched = [];
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname === '/') {
        if (url.searchParams.has('noty_helper')) {
          return route.fulfill({ status: 302, headers: { location: origin + '/?dir=' + encodeURIComponent(root) } });
        }
        if (route.request().frame().page() !== page) {
          helperNavigations++;
          const helperNow = await page.evaluate(() => Date.now());
          return route.fulfill({ headers: { 'Cross-Origin-Opener-Policy': 'same-origin' }, contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><head><meta charset="utf-8"></head><body>' +
            (helperBlocked ? '<h1>Cloudflare: Just a moment</h1>' : '<table><tr><th>File name</th><th>Size</th></tr></table>') +
            `<script>Date.now = () => ${helperNow}; window.opener = null;</script><script>` + source.replaceAll('</script', '<\\/script') + '</script></body></html>' });
        }
        const names = ['first.pdf', 'second.pdf', 'third.pdf', 'audio.mp3', ...(revision === 2 ? ['new.pdf'] : [])];
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><head><meta charset="utf-8"><title>Offline downloader acceptance fixture</title></head>' +
          '<body style="font:18px system-ui;background:#edf3f7;padding:28px"><h1>Проверка загрузчика · офлайн</h1><p>Тестовый каталог, без запросов к сайту.</p>' +
          '<table><tr><th>File name</th><th>Size</th><th>Last updated</th></tr>' + names.map(name =>
            `<tr><td><a href="${urlFor(name)}">${name}</a></td><td>14 B</td><td>${revision === 2 && name === 'first.pdf' ? '24.09.26' : '23.09.26'}</td></tr>`).join('') + '</table></body></html>' });
      }
      if (url.pathname.startsWith('/Public/')) {
        const chartFile = /\/chart-(\d+)\.pdf$/.exec(url.pathname);
        if (chartFile) {
          const index = Number(chartFile[1]);
          await page.evaluate(ms => { window.chartTestNow += ms; }, [1000, 2000, 1000, 3000][index % 4]);
          return route.fulfill({ contentType: 'application/pdf', body: '%PDF-1.7\n' + 'x'.repeat([8192, 2048, 24000, 16000][index % 4]) });
        }
        if (url.pathname.endsWith('/index(1).php') || url.pathname.endsWith('/bad-content.pdf')) {
          fetched.push(decodeURIComponent(url.pathname).split('/').at(-1));
          return route.fulfill({ contentType: 'text/html', body: htmlLesson });
        }
        if (url.pathname.endsWith('/nnn.htm')) {
          if (route.request().isNavigationRequest()) {
            htmlNavigations++;
            const helperNow = await page.evaluate(() => Date.now());
            const blocked = htmlNavigations === 1;
            if (!blocked) htmlAccess = true;
            const body = blocked ? '<html><head><title>Just a moment...</title><meta name="robots" content="noindex,nofollow"></head><body><h1>Challenge pending</h1></body></html>' : htmlLesson;
            return route.fulfill({ contentType: 'text/html; charset=utf-8', body: body.replace('</body>',
              `<script>Date.now = () => ${helperNow}; window.opener = null;</script><script>` + source.replaceAll('</script', '<\\/script') + '</script></body>') });
          }
          fetched.push('nnn.htm');
          return route.fulfill(htmlAccess ? { contentType: 'text/html', body: htmlLesson } :
            { status: 403, headers: { 'cf-mitigated': 'challenge' }, body: 'challenge' });
        }
        fetched.push(decodeURIComponent(url.pathname).split('/').at(-1));
        if (networkOutage) return route.abort('internetdisconnected');
        if (/\/incident-[ab]\.pdf$/.test(url.pathname)) {
          const attempts = (incidentAttempts.get(url.pathname) || 0) + 1;
          incidentAttempts.set(url.pathname, attempts);
          if (attempts === 1) return route.fulfill({ status: 403, headers: { 'cf-mitigated': 'challenge' }, body: 'challenge' });
        }
        if (challengeNext) {
          challengeNext = false;
          return route.fulfill({ status: 403, headers: { 'cf-mitigated': 'challenge' }, body: 'challenge' });
        }
        if (/\/(?:\._\.DS_Store|denied-score\.pdf)$/.test(url.pathname)) {
          return route.fulfill({ status: 403, contentType: 'text/html', body: '<html><h1>403 Forbidden</h1><hr>nginx/1.18.0</html>' });
        }
        return route.fulfill({ contentType: 'application/pdf', body: '%PDF-1.7\nfirst' });
      }
      return route.abort();
    });
    await page.addInitScript(({ root }) => {
      const encode = text => new TextEncoder().encode(text);
      const files = new Map([[root + '/first.pdf', { bytes: encode('user original'), modified: 1 }]]);
      const directories = new Set(['', root]);
      const missing = () => new DOMException('Not found', 'NotFoundError');
      function directory(base) {
        return { name: base.split('/').at(-1) || 'destination', requestPermission: async () => 'granted', queryPermission: async () => 'granted',
          getDirectoryHandle: async (name, options = {}) => {
            if (name.startsWith('~')) throw new TypeError("Failed to execute 'getDirectoryHandle' on 'FileSystemDirectoryHandle': Name is not allowed.");
            const key = base ? base + '/' + name : name;
            if (!directories.has(key)) { if (!options.create) throw missing(); directories.add(key); }
            return directory(key);
          },
          getFileHandle: async (name, options = {}) => {
            if (name === 'rimm_1.ini') throw new TypeError("Failed to execute 'getFileHandle' on 'FileSystemDirectoryHandle': Name is not allowed.");
            const key = base ? base + '/' + name : name;
            if (!files.has(key)) { if (!options.create) throw missing(); files.set(key, { bytes: new Uint8Array(), modified: 1 }); }
            return { getFile: async () => {
              const value = files.get(key); return { size: value.bytes.length, lastModified: value.modified,
                text: async () => new TextDecoder().decode(value.bytes) };
            }, createWritable: async () => {
              let pieces = [];
              return { write: async chunk => pieces.push(typeof chunk === 'string' ? encode(chunk) : chunk.slice()),
                abort: async () => { pieces = []; }, close: async () => {
                  const bytes = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0)); let offset = 0;
                  for (const piece of pieces) { bytes.set(piece, offset); offset += piece.length; }
                  files.set(key, { bytes, modified: files.get(key).modified + 1 });
                } };
            } };
          }
        };
      }
      window.showDirectoryPicker = async () => directory('');
      window.testReadFile = key => files.has(key) ? new TextDecoder().decode(files.get(key).bytes) : null;
      localStorage.setItem('noty-folder-settings-v1', JSON.stringify({ auto: false, threads: 2, delayMs: 0, scanDelayMs: 0, maxRetries: 0 }));
    }, { root });
    await page.goto(origin + '/?dir=' + encodeURIComponent(root)); await page.addScriptTag({ content: source });
    await page.locator('#scan').click(); await page.getByText('Найдено 4 файлов в 1 папках.', { exact: false }).waitFor();
    await page.locator('#selectionDetails > summary').click();
    await page.locator('#includeExt').fill('pdf'); await page.locator('#includeExt').dispatchEvent('change');
    assert.match(await page.locator('#selectionInfo').innerText(), /Выбрано 3 из 4/);
    await page.screenshot({ path: path.join(__dirname, 'preview-selection.png') });
    await page.locator('#selectionDetails > summary').click(); await page.locator('#verifyDetails > summary').click();
    await page.locator('#verify').click(); await page.getByText('Проверка завершена.', { exact: false }).waitFor();
    assert.equal(fetched.length, 0);
    assert.match(await page.locator('#verifyInfo').innerText(), /Нет файла: 2/);
    await page.locator('#repair').click(); await page.getByText('Готово: 2/2. Ошибок: 0.', { exact: true }).waitFor();
    assert.deepEqual([...fetched].sort(), ['second.pdf', 'third.pdf']);
    assert.equal(await page.evaluate(root => window.testReadFile(root + '/first.pdf'), root), 'user original');
    await page.locator('#reportRows input[type=checkbox]').check(); await page.locator('#replaceSelected').click();
    await page.getByText('Готово: 1/1. Ошибок: 0.', { exact: true }).waitFor();
    assert.equal(await page.evaluate(root => window.testReadFile(root + '/first.pdf'), root), '%PDF-1.7\nfirst');
    await page.screenshot({ path: path.join(__dirname, 'preview-verification.png') });
    revision = 2;
    await page.locator('#verifyDetails > summary').click(); await page.locator('#updateDetails > summary').click();
    await page.locator('#updateScan').click(); await page.getByText('Найдено 5 файлов в 1 папках.', { exact: false }).waitFor();
    assert.match(await page.locator('#updateInfo').innerText(), /Новый: 1/);
    assert.match(await page.locator('#updateInfo').innerText(), /Предположительно изменён: 1/);
    await page.locator('#selectUpdates').click();
    assert.match(await page.locator('#selectionInfo').innerText(), /Выбрано 2 из 5/);
    assert.deepEqual(errors, []);
    // Exercise real popup navigation and cross-tab messages with offline HTTP
    // fixtures. Only the clock and local destination handles are simulated.
    await page.evaluate(() => { const original = window.open; window.open = (...args) => { window.testHelperProxy = original.apply(window, args); return window.testHelperProxy; }; });
    const popup = context.waitForEvent('page'); await page.locator('#enableRecovery').click();
    const helper = await popup; helper.on('pageerror', e => errors.push(e.message));
    try {
      await helper.waitForFunction(() => document.title === 'Noty: страница загрузилась', null, { timeout: 15000 });
    } catch (error) {
      console.error('Helper fixture failed to initialize:', await helper.evaluate(() => ({
        url: location.href, title: document.title, readyState: document.readyState,
        hasStoredContext: !!sessionStorage.getItem('noty-helper-context-v1'),
        hasWindowContext: window.name.startsWith('noty-helper:'),
        helperStatus: document.querySelector('#noty-helper-status')?.textContent
      })), errors);
      throw error;
    }
    assert.equal(new URL(helper.url()).searchParams.has('noty_helper'), false);
    assert.equal(await helper.locator('#noty-folder-helper').count(), 0);
    await helper.locator('#noty-helper-status').waitFor();
    assert.equal(await page.evaluate(() => window.testHelperProxy.closed), true, 'COOP severs the proxy of an actually open helper');
    assert.equal(helper.isClosed(), false);
    await page.locator('#enableRecovery').filter({ hasText: 'Служебная вкладка подключена' }).waitFor({ timeout: 4000 });
    assert.equal(helperNavigations, 1);
    await page.locator('#importFile').setInputFiles({ name: 'recovery.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ root, files: [{ path: root + '/new.pdf', url: urlFor('new.pdf') }] })) });
    await page.getByText('JSON загружен:', { exact: false }).waitFor();
    await page.evaluate(() => {
      window.recoveryTestNow = Date.now(); Date.now = () => window.recoveryTestNow;
      const ticks = new Map(); let id = 100000;
      const clearNativeInterval = window.clearInterval.bind(window);
      window.setInterval = fn => { ticks.set(id, fn); return id++; };
      window.clearInterval = key => { if (!ticks.delete(key)) clearNativeInterval(key); };
      window.advanceRecoveryTest = ms => { window.recoveryTestNow += ms; for (const tick of [...ticks.values()]) tick(); };
    });
    challengeNext = true; helperBlocked = true;
    await page.locator('#download').click(); await page.locator('#status').filter({ hasText: 'Cloudflare: сайт запросил' }).waitFor();
    const beforeRecovery = fetched.length;
    await page.evaluate(() => window.advanceRecoveryTest(30000));
    await helper.getByText('Cloudflare: Just a moment', { exact: true }).waitFor();
    assert.equal(helperNavigations, 2); assert.equal(fetched.length, beforeRecovery);
    assert.equal(await helper.locator('#noty-folder-helper').count(), 0);
    helperBlocked = false;
    await page.evaluate(() => window.advanceRecoveryTest(60000));
    await page.getByText('Готово: 1/1. Ошибок: 0.', { exact: true }).waitFor();
    assert.equal(helperNavigations, 3); assert.equal(fetched.length, beforeRecovery + 1);
    await helper.screenshot({ path: path.join(__dirname, 'preview-helper.png') });
    assert.equal(await page.evaluate(root => window.testReadFile(root + '/new.pdf'), root), '%PDF-1.7\nfirst');
    // Catalog access is already available, but the HTML resource remains blocked.
    // The helper must visit that exact resource and wait through its challenge.
    await page.locator('#importFile').setInputFiles({ name: 'html-recovery.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ root, files: [{ path: root + '/nnn.htm', url: urlFor('nnn.htm') }] })) });
    await page.getByText('JSON загружен:', { exact: false }).waitFor();
    if (!await page.locator('#selectionDetails').evaluate(el => el.open)) await page.locator('#selectionDetails > summary').click();
    await page.locator('#selectAll').click(); await page.locator('#clearFilters').click();
    await page.locator('#download').click(); await page.locator('#status').filter({ hasText: 'Cloudflare: сайт запросил' }).waitFor();
    const beforeHTML = fetched.length;
    await page.evaluate(() => window.advanceRecoveryTest(30000));
    await helper.getByText('Challenge pending', { exact: true }).waitFor();
    assert.equal(helper.url(), urlFor('nnn.htm'));
    assert.equal(fetched.length, beforeHTML);
    helperBlocked = false;
    await page.evaluate(() => window.advanceRecoveryTest(60000));
    await page.getByText('Готово: 1/1. Ошибок: 0.', { exact: true }).waitFor();
    assert.equal(htmlNavigations, 2); assert.equal(fetched.length, beforeHTML + 1);
    assert.equal(await page.evaluate(root => window.testReadFile(root + '/nnn.htm'), root), htmlLesson);
    assert.equal(await helper.locator('#noty-folder-helper').count(), 0);
    await helper.screenshot({ path: path.join(__dirname, 'preview-html-recovery.png') });
    const repairFiles = ['index(1).php', 'bad-content.pdf', 'last-good.pdf'];
    await page.locator('#importFile').setInputFiles({ name: 'php-repair.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ root, files: repairFiles.map(name => ({ path: root + '/' + name, url: urlFor(name) })) })) });
    await page.getByText('JSON загружен:', { exact: false }).waitFor();
    if (!await page.locator('#verifyDetails').evaluate(el => el.open)) await page.locator('#verifyDetails > summary').click();
    await page.locator('#verify').click(); await page.getByText('Проверка завершена.', { exact: false }).waitFor();
    const beforeRepair = fetched.length;
    await page.locator('#repair').click();
    await page.getByText('Готово: 2/3. Ошибок: 1.', { exact: true }).waitFor();
    assert.match(await page.locator('#eta').innerText(), /очередь обработана.*ошибки: 1/);
    assert.deepEqual(fetched.slice(beforeRepair).sort(), [...repairFiles].sort());
    assert.equal(await page.evaluate(root => window.testReadFile(root + '/index(1).php'), root), htmlLesson);
    assert.equal(await page.evaluate(root => window.testReadFile(root + '/bad-content.pdf'), root), null);
    assert.equal(await page.evaluate(root => window.testReadFile(root + '/last-good.pdf'), root), '%PDF-1.7\nfirst');
    assert.equal(helperNavigations, 3); assert.equal(htmlNavigations, 2);
    const blockedFiles = ['rimm_1.ini', 'z-after-ini.pdf'];
    await page.locator('#importFile').setInputFiles({ name: 'blocked-name.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ root, files: blockedFiles.map(name => ({ path: root + '/' + name, url: urlFor(name) })) })) });
    await page.getByText('JSON загружен:', { exact: false }).waitFor();
    const beforeBlocked = fetched.length;
    await page.locator('#download').click(); await page.getByText('Готово: 1/2. Ошибок: 1.', { exact: true }).waitFor();
    assert.deepEqual(fetched.slice(beforeBlocked), ['z-after-ini.pdf']);
    assert.equal(await page.evaluate(root => window.testReadFile(root + '/rimm_1.ini'), root), null);
    assert.equal(await page.evaluate(root => window.testReadFile(root + '/z-after-ini.pdf'), root), '%PDF-1.7\nfirst');
    const deniedFiles = ['._.DS_Store', 'denied-score.pdf', 'z-after-denied.pdf'];
    await page.locator('#importFile').setInputFiles({ name: 'denied.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ root, files: deniedFiles.map(name => ({ path: root + '/' + name, url: urlFor(name) })) })) });
    await page.getByText('JSON загружен:', { exact: false }).waitFor();
    const beforeDenied = fetched.length;
    await page.locator('#download').click(); await page.getByText('Готово: 1/3. Ошибок: 2.', { exact: true }).waitFor();
    assert.deepEqual(fetched.slice(beforeDenied).sort(), [...deniedFiles].sort());
    assert.equal(helperNavigations, 3); assert.equal(htmlNavigations, 2);
    assert.equal(await page.evaluate(root => window.testReadFile(root + '/denied-score.pdf'), root), null);
    assert.equal(await page.evaluate(root => window.testReadFile(root + '/z-after-denied.pdf'), root), '%PDF-1.7\nfirst');
    assert.equal(await page.locator('#retry').isDisabled(), true);
    await page.locator('#cache').click();
    await page.locator('#selectionInfo').filter({ hasText: 'Выбрано 1 из 1' }).waitFor();
    await page.locator('#download').click(); await page.getByText('Готово: 1/1. Ошибок: 0.', { exact: true }).waitFor();
    assert.equal(fetched.length, beforeDenied + 3, 'Cached list never requests denied files again');
    await page.locator('#importFile').setInputFiles({ name: 'tilde-directory.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ root, files: [{ path: root + '/~PV_Contents/0000.pdf', url: urlFor('~PV_Contents/0000.pdf') }] })) });
    await page.getByText('JSON загружен:', { exact: false }).waitFor();
    const beforeTilde = fetched.length;
    await page.locator('#download').click(); await page.getByText('Готово: 1/1. Ошибок: 0.', { exact: true }).waitFor();
    assert.equal(await page.evaluate(root => window.testReadFile(root + '/%7EPV_Contents/0000.pdf'), root), '%PDF-1.7\nfirst');
    assert.equal(await page.evaluate(root => window.testReadFile(root + '/~PV_Contents/0000.pdf'), root), null);
    await page.locator('#verify').click(); await page.getByText('Проверка завершена.', { exact: false }).waitFor();
    assert.match(await page.locator('#verifyInfo').textContent(), /Совпадает с журналом: 1/);
    await page.locator('#cache').click(); await page.getByText('Кеш загружен:', { exact: false }).waitFor();
    await page.locator('#download').click(); await page.getByText('Готово: 1/1. Ошибок: 0.', { exact: true }).waitFor();
    assert.equal(fetched.length, beforeTilde + 1, 'Encoded directory paths resume from the journal');
    const incidentFiles = ['incident-a.pdf', 'incident-b.pdf'];
    assert.equal(await page.locator('#threads').inputValue(), '2', 'Earlier recoveries preserve the manual preference');
    await page.locator('#threads').evaluate(el => { el.closest('details').open = true; });
    await page.locator('#threads').fill('1'); await page.locator('#threads').dispatchEvent('change');
    await page.locator('#importFile').setInputFiles({ name: 'separate-incidents.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ root, files: incidentFiles.map(name => ({ path: root + '/' + name, url: urlFor(name) })) })) });
    await page.getByText('JSON загружен:', { exact: false }).waitFor();
    const beforeIncidents = helperNavigations;
    await page.locator('#download').click();
    for (let i = 0; i < 2; i++) {
      await page.locator('#log').filter({ hasText: incidentFiles[i] + ': Cloudflare' }).waitFor({ state: 'attached' });
      await page.waitForFunction(() => !document.querySelector('#noty-folder-helper').shadowRoot.getElementById('export').disabled);
      await page.evaluate(() => window.advanceRecoveryTest(0));
      await page.locator('#status').filter({ hasText: 'попытка 1/8' }).waitFor();
      await page.evaluate(() => window.advanceRecoveryTest(30000));
      await page.locator('#log').filter({ hasText: 'Сохранён: ' + incidentFiles[i] }).waitFor({ state: 'attached' });
    }
    await page.getByText('Готово: 2/2. Ошибок: 0.', { exact: true }).waitFor();
    assert.equal(helperNavigations, beforeIncidents + 2);
    assert.deepEqual([...incidentAttempts.values()], [2, 2]);
    // A real fetch rejection must preserve the queue and use the same isolated
    // helper, without turning every untouched file into a final error.
    const outageFiles = ['outage-a.pdf', 'outage-b.pdf', 'outage-c.pdf', 'outage-d.pdf', 'outage-e.pdf'];
    await page.locator('#threads').fill('3'); await page.locator('#threads').dispatchEvent('change');
    await page.locator('#importFile').setInputFiles({ name: 'outage.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ root, files: outageFiles.map(name => ({ path: root + '/' + name, url: urlFor(name) })) })) });
    await page.getByText('JSON загружен:', { exact: false }).waitFor();
    const beforeOutage = fetched.length, helperBeforeOutage = helperNavigations;
    networkOutage = true;
    await page.locator('#download').click();
    await page.locator('#status').filter({ hasText: 'Сетевой запрос не завершён' }).waitFor();
    await page.locator('#export').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('#noty-folder-helper').shadowRoot.getElementById('export').disabled);
    assert.equal(fetched.length, beforeOutage + 3);
    assert.equal(await page.locator('#threads').inputValue(), '3');
    networkOutage = false;
    await page.evaluate(() => window.advanceRecoveryTest(30000));
    await page.getByText('Готово: 5/5. Ошибок: 0.', { exact: true }).waitFor();
    assert.equal(await page.locator('#metricActive').textContent(), '0 / 3');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('noty-folder-settings-v1')).threads), 3);
    assert.equal(helperNavigations, helperBeforeOutage + 1);
    assert.equal(helper.isClosed(), false);
    for (const name of outageFiles) assert.equal(await page.evaluate(key => window.testReadFile(key), root + '/' + name), '%PDF-1.7\nfirst');
    // A real popup close must be visible while the main download scheduler is idle.
    const idleStatus = await page.locator('#status').textContent(), idleRequests = fetched.length;
    await helper.close();
    await page.evaluate(() => window.advanceRecoveryTest(5001));
    await page.evaluate(() => window.advanceRecoveryTest(10000));
    await page.locator('#recoveryInfo').filter({ hasText: 'Служебная вкладка закрыта' }).waitFor({ timeout: 5000 });
    assert.equal(await page.locator('#enableRecovery').textContent(), 'Открыть служебную вкладку');
    assert.equal(await page.locator('#status').textContent(), idleStatus);
    assert.equal(fetched.length, idleRequests);
    const reopen = context.waitForEvent('page'); await page.locator('#enableRecovery').click();
    const newHelper = await reopen; newHelper.on('pageerror', e => errors.push(e.message));
    await page.locator('#enableRecovery').filter({ hasText: 'Служебная вкладка подключена' }).waitFor();
    await newHelper.close(); await page.evaluate(() => window.advanceRecoveryTest(5001));
    await page.evaluate(() => window.advanceRecoveryTest(10000));
    assert.equal(await page.locator('#enableRecovery').textContent(), 'Открыть служебную вкладку');
    assert.deepEqual(errors, []);
    // Populate both chart series through real completed downloads with a
    // deterministic clock, then inspect desktop and narrow layouts.
    await page.evaluate(() => { window.chartTestNow = performance.now(); performance.now = () => window.chartTestNow; });
    await page.locator('#threads').fill('1'); await page.locator('#threads').dispatchEvent('change');
    const chartFiles = Array.from({ length: 16 }, (_, i) => `chart-${i}.pdf`);
    await page.locator('#importFile').setInputFiles({ name: 'chart.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ root, files: chartFiles.map(name => ({ path: root + '/' + name, url: urlFor(name) })) })) });
    await page.getByText('JSON загружен:', { exact: false }).waitFor();
    await page.locator('#download').click(); await page.getByText('Готово: 16/16. Ошибок: 0.', { exact: true }).waitFor();
    await page.locator('#detailProgress > summary').click();
    assert.equal(await page.locator('#rateChart polyline').count(), 2);
    assert.equal(await page.locator('#rateChart polyline').nth(1).getAttribute('stroke-dasharray'), '5 3');
    assert.match(await page.locator('#fileScale').textContent(), /файлов\/с/);
    for (const [width, label] of [[1440, 'desktop'], [390, 'mobile']]) {
      await page.setViewportSize({ width, height: 1040 });
      await page.locator('#rateChartBlock').scrollIntoViewIfNeeded();
      assert(await page.locator('#rateChartBlock').evaluate(el => el.scrollWidth <= el.clientWidth), 'Chart legend fits ' + label);
      await page.locator('#rateChartBlock').screenshot({ path: path.join(__dirname, `preview-rates-${label}.png`) });
    }
    assert.deepEqual(errors, []);
    console.log('Browser acceptance passed: selection/filtering, verification/repair/replacement, updates, recovery, helper close/reopen, PHP HTML, format/name errors, plain-403 removal, tilde directory mapping and cached restart; zero page errors.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
