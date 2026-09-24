// Visual and interaction checks against offline legacy-catalog fixtures.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const origin = 'https://noty.propovednik.com';
const source = fs.readFileSync(path.join(__dirname, 'noty-folder-downloader.user.js'), 'utf8');
const folders = ['ENGLISH', 'АККОРДЕОН-БАЯН', 'ВОКАЛ-ХОР', 'ГАРМОНИЯ', 'ГИТАРА', 'ГРАФИКА',
  'ДУХОВНЫЕ ОСНОВЫ МУЗЫКИ ЕХБ', 'ИНСТРУМЕНТОВКА-АРАНЖИРОВКА', 'МУЗ ФОРМА', 'Научно познавательная',
  'ПИАНО', 'ПОЛИФОНИЯ', 'СОЛЬФЕДЖИО', 'ТЕОРИЯ МУЗЫКИ'];
const longName = 'Очень_длинное_название_учебного_материала_по_музыкальной_теории_и_практике_для_проверки_переноса.pdf';
const files = ['Основы музыкальной грамоты.pdf', 'Упражнения по сольфеджио.mp3', longName];
const folderURL = name => '/?dir=' + encodeURIComponent('_УЧЕБНИКИ/' + name);
const fileURL = name => '/Public/' + encodeURIComponent('_УЧЕБНИКИ') + '/' + encodeURIComponent(name);
const row = (url, label, icon, size = '') => `<tr><td width="24"><a href="${url}" aria-label="Открыть"><span aria-hidden="true"></span></a>${icon}</td><td nowrap><a href="${url}">${label}</a></td><td width="100">${size}</td><td width="130">11.06.25</td></tr>`;
const fixture = `<!doctype html><html><head><meta charset="utf-8"><title>Noty · offline preview</title>
<style>body{font:18px Arial;text-align:center;background:white}#source{width:824px;margin:40px auto;border:1px solid #ccc}h2{color:#63a6d1;padding:24px}table{width:100%;border-collapse:collapse}td{text-align:left;padding:4px}tr:nth-child(odd){background:#f5f6f7}</style></head><body>
<div id="source"><h2>Нотный архив христианской музыки</h2><div><a href="/?dir=">Root</a> &rsaquo; _УЧЕБНИКИ</div>
<table><tr><td></td><td><a href="/?dir=_%D0%A3%D0%A7%D0%95%D0%91%D0%9D%D0%98%D0%9A%D0%98&sort=name">File name</a></td><td>Size</td><td>Last updated</td></tr>
${row('/?dir=', '..', '↰')}${folders.map(name => row(folderURL(name), name, '📁')).join('')}
${files.map(name => row(fileURL(name), name, '♪', '5.36 MiB')).join('')}</table></div>
<div style="text-align:center">Mobile view | <a href="https://example.invalid/">Новый сайт</a></div></body></html>`;

(async () => {
  const executablePath = [process.env.BROWSER_PATH, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean).find(p => fs.existsSync(p));
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1040 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture }));
    await page.goto(origin + '/?dir=' + encodeURIComponent('_УЧЕБНИКИ'));
    await page.evaluate(() => { window.originalCatalog = document.querySelector('table'); });
    await page.addScriptTag({ content: source });
    assert.equal(await page.locator('#noty-workspace').count(), 1);
    assert(await page.evaluate(() => window.originalCatalog === document.querySelector('.noty-file-table')), 'Keep original DOM and event handlers');
    assert.equal(await page.locator('#noty-catalog-count').textContent(), '17 / 17 записей');
    assert.equal(await page.locator('.noty-file-table a').filter({ hasText: 'ENGLISH' }).getAttribute('href'), folderURL('ENGLISH'));
    assert.equal(await page.locator('.noty-entry-link').filter({ hasText: longName }).getAttribute('href'), fileURL(longName));
    assert.equal(await page.getByRole('link', { name: 'Название', exact: true }).count(), 1, 'Sort link preserved and localized');

    await page.locator('#noty-catalog-search').fill('сольфеджио');
    assert.equal(await page.locator('#noty-catalog-count').textContent(), '2 / 17 записей');
    await page.locator('#noty-catalog-kind').selectOption('file');
    assert.equal(await page.locator('#noty-catalog-count').textContent(), '1 / 17 записей');
    assert(await page.locator('.noty-parent-entry').isVisible(), 'Parent navigation survives filtering');
    await page.locator('#noty-catalog-search').fill('нет такого файла');
    assert(await page.locator('#noty-catalog-empty').isVisible());
    await page.locator('#noty-catalog-search').fill('');
    await page.locator('#noty-catalog-kind').selectOption('all');
    assert.equal(await page.locator('#status').textContent(), 'Сначала собери список файлов.', 'Catalog filter does not start a scan');

    // The main actions remain visible while lower settings scroll independently.
    await page.locator('summary').filter({ hasText: 'Потоки и автотюн' }).click();
    await page.locator('#threads').scrollIntoViewIfNeeded();
    await page.locator('#auto').selectOption('manual');
    await page.locator('#threads').fill('4'); await page.locator('#threads').dispatchEvent('change');
    assert.equal(await page.locator('#threads').inputValue(), '4');
    const scanBox = await page.locator('#scan').boundingBox();
    assert(scanBox.y >= 0 && scanBox.y + scanBox.height <= 1040, 'Main action remains in view');
    await page.locator('summary').filter({ hasText: 'Потоки и автотюн' }).click();
    await page.locator('.panel-scroll').evaluate(el => { el.scrollTop = 0; });

    for (const [width, height, name] of [[1440, 1040, 'desktop'], [1100, 800, 'compact'], [900, 1100, 'tablet'], [390, 844, 'mobile']]) {
      await page.setViewportSize({ width, height });
      const geometry = await page.evaluate(() => {
        const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }; };
        return { catalog: rect('.noty-catalog'), downloads: rect('#noty-download-column'), scroll: document.documentElement.scrollWidth, width: innerWidth };
      });
      assert(geometry.scroll <= geometry.width, name + ': no horizontal page overflow');
      if (width >= 1100) assert(geometry.catalog.right < geometry.downloads.x, name + ': catalog left and controls right');
      else assert(geometry.catalog.bottom < geometry.downloads.y, name + ': panels stack without overlap');
      // Long names wrap inside the catalog rather than requiring horizontal panning.
      const tableFits = await page.locator('#noty-catalog-content').evaluate(el => el.scrollWidth <= el.clientWidth + 1);
      assert(tableFits, name + ': catalog should fit the panel');
      await page.screenshot({ path: path.join(__dirname, `preview-ui-${name}.png`), fullPage: width < 1100 });
    }
    // File listing filters stay usable at phone width, including long filenames.
    await page.locator('#noty-catalog-kind').selectOption('file');
    await page.locator('#noty-catalog-search').fill('Очень_длинное');
    assert.equal(await page.locator('#noty-catalog-count').textContent(), '1 / 17 записей');
    await page.locator('#noty-catalog-search').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'noty-catalog-kind');
    await page.locator('summary').filter({ hasText: 'Потоки и автотюн' }).click();
    await page.locator('#threads').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('#threads').inputValue(), '4', 'Settings survive layout changes');
    // Exercise the manifest editor with actual JSON import, IndexedDB and download.
    const manifest = { root: '_УЧЕБНИКИ', files: Array.from({ length: 205 }, (_, i) => ({
      path: '_УЧЕБНИКИ/ГАРМОНИЯ/Упражнение ' + i + '.pdf',
      url: origin + fileURL('ГАРМОНИЯ/Упражнение ' + i + '.pdf').replaceAll('%2F', '/'), sizeBytes: (i + 1) * 1024
    })) };
    await page.locator('#importFile').setInputFiles({ name: 'noty-files.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(manifest)) });
    await page.waitForFunction(() => document.querySelector('#noty-folder-helper').shadowRoot.getElementById('editList').disabled === false);
    await page.locator('#editList').click();
    assert(await page.locator('#manifestEditor').evaluate(el => el.matches(':modal')));
    assert.equal(await page.locator('#editorRows tr').count(), 100);
    assert.match(await page.locator('#editorRows tr').first().textContent(), /Упражнение 204/);
    await page.locator('#editorSort').selectOption('size-asc');
    assert.match(await page.locator('#editorRows tr').first().textContent(), /Упражнение 0/);
    await page.locator('#editorRows input').first().check();
    await page.locator('#editorDelete').click();
    await page.waitForFunction(() => document.querySelector('#noty-folder-helper').shadowRoot.getElementById('editorNotice').textContent.includes('сохранены в кеше'));
    const downloadPromise = page.waitForEvent('download'); await page.locator('#editorExport').click();
    const download = await downloadPromise;
    const edited = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    assert.equal(edited.files.length, 204); assert(!edited.files.some(f => f.path.endsWith('/Упражнение 0.pdf')));
    await page.locator('#editorUndo').click();
    await page.waitForFunction(() => document.querySelector('#noty-folder-helper').shadowRoot.getElementById('editorNotice').textContent.includes('Восстановлено'));
    await page.locator('#editorSort').selectOption('size-desc');
    for (const [width, height, label] of [[1440, 1040, 'desktop'], [390, 844, 'mobile']]) {
      await page.setViewportSize({ width, height });
      const bounds = await page.locator('#manifestEditor').boundingBox();
      assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= height, label + ': editor fits the viewport');
      assert(await page.locator('#manifestEditor').evaluate(el => el.scrollWidth <= el.clientWidth), label + ': no horizontal editor overflow');
      assert(await page.locator('.editor-table-wrap').evaluate(el => el.clientHeight > 80), label + ': table has usable scroll space');
      await page.screenshot({ path: path.join(__dirname, `preview-editor-${label}.png`) });
    }
    await page.keyboard.press('Escape'); assert(!await page.locator('#manifestEditor').isVisible());
    assert.deepEqual(errors, []);
    console.log('UI acceptance passed: catalog, responsive layout, keyboard, manifest import/sort/delete/cache/export/undo and responsive modal; no page errors.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
