const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const { IDBFactory } = require('fake-indexeddb');
const core = require('./noty-folder-downloader.user.js');
const source = fs.readFileSync(__dirname + '/noty-folder-downloader.user.js', 'utf8');
const origin = 'https://noty.propovednik.com';
const root = '_УЧЕБНИКИ';
const challengePage = "<!doctype html><html><head><title>Just a moment...</title><meta name=\"robots\" content=\"noindex,nofollow\"></head><body><script>window._cf_chl_opt = {};</script></body></html>";
const directoryURL = path => origin + '/?dir=' + encodeURIComponent(path);
const fileURL = path => origin + '/Public/' + path.split('/').map(encodeURIComponent).join('/');

function recoveryClock() {
  const clock = { now: 1000000, ticks: new Map(), urls: [], popupBlocked: false };
  clock.helper = { closed: false, focus() {}, location: { replace(url) { clock.urls.push(url); } } };
  clock.advance = async ms => { clock.now += ms; for (const tick of [...clock.ticks.values()]) tick(); await turn(); };
  clock.ready = (h, changes = {}) => {
    const token = new URL(clock.urls.at(-1)).searchParams.get('noty_helper') || JSON.parse(clock.helper.name.slice(12)).token;
    const event = new h.dom.window.MessageEvent('message', { origin, data: { type: 'noty-directory-ready', token }, ...changes });
    Object.defineProperty(event, 'source', { value: changes.source || clock.helper });
    h.dom.window.dispatchEvent(event);
  };
  return clock;
}

function recoveryBus() {
  const bus = { sent: [], channels: [] };
  bus.Channel = class {
    constructor(name) { this.name = name; bus.channels.push(this); }
    postMessage(data) { bus.sent.push(data); }
    close() {}
  };
  bus.emit = data => bus.channels[0].onmessage({ origin, data });
  return bus;
}

for (const threads of [1, 4]) test(`network outage pauses the queue without losing links and resumes automatically (${threads} workers)`, async () => {
  const clock = recoveryClock(), paths = Array.from({ length: 8 }, (_, i) => root + `/outage-${i}.pdf`);
  let offline = true;
  const responses = new Map(paths.map(path => [fileURL(path), () => {
    if (offline) throw new TypeError('Failed to fetch');
    return new Response('%PDF-1.7\nok');
  }]));
  const h = createHarness(responses, new MemoryDir(), directoryURL(root), { recoveryClock: clock, settings: { auto: false, threads } });
  try {
    await importJSON(h, { root, files: paths.map(path => entry(path)) }); await h.click('download');
    assert.match(h.panel.getElementById('status').textContent, /Сетевой запрос не завершён/);
    assert.ok(h.calls.length <= threads, 'Do not consume the remaining queue during an outage');
    assert.doesNotMatch(h.panel.getElementById('log').textContent, /Cloudflare/);
    await clock.advance(29999); assert.equal(clock.urls.length, 0);
    await clock.advance(1); assert.equal(clock.urls.length, 1);
    offline = false; clock.ready(h);
    await until(() => /Готово: 8\/8. Ошибок: 0./.test(h.panel.getElementById('status').textContent));
    for (const path of paths) {
      assert.ok(h.calls.includes(fileURL(path)));
      assert.equal(h.destination.dirs.get(root).files.get(path.split('/').at(-1)).data.toString(), '%PDF-1.7\nok');
    }
  } finally { h.dom.window.close(); }
});

test('network recovery respects manual pause and retains the blocked file', async () => {
  const clock = recoveryClock(), path = root + '/offline.pdf';
  const responses = new Map([[fileURL(path), () => { throw new TypeError('Failed to fetch'); }]]);
  const h = createHarness(responses, new MemoryDir(), directoryURL(root), { recoveryClock: clock });
  try {
    await importJSON(h, { root, files: [entry(path)] }); await h.click('download');
    assert.match(h.panel.getElementById('status').textContent, /Сетевой запрос не завершён/);
    await h.click('pause'); await clock.advance(600000);
    assert.equal(clock.urls.length, 0); assert.equal(h.calls.length, 1);
    responses.set(fileURL(path), { body: '%PDF-1.7\nok' }); await h.click('download');
    assert.match(h.panel.getElementById('status').textContent, /Готово: 1\/1. Ошибок: 0./);
  } finally { h.dom.window.close(); }
});

test('network retries exhaust locally before recovery and persistent outages have a bounded budget', async () => {
  const clock = recoveryClock(), path = root + '/offline.pdf';
  const h = createHarness(new Map([[fileURL(path), () => { throw new TypeError('Failed to fetch'); }]]), new MemoryDir(), directoryURL(root),
    { recoveryClock: clock, settings: { maxRetries: 1, retryBaseSeconds: 1 } });
  try {
    await importJSON(h, { root, files: [entry(path)] }); await h.click('download');
    assert.equal(h.calls.length, 2); assert.match(h.panel.getElementById('log').textContent, /Автоповтор 1\/1/);
    setSettings(h, { maxRetries: 0 });
    for (let i = 0; i < 8; i++) {
      await clock.advance(300000); clock.ready(h);
      await until(() => h.calls.length === i + 3 && !h.panel.getElementById('export').disabled);
    }
    assert.match(h.panel.getElementById('recoveryInfo').textContent, /исчерпан/);
    await clock.advance(600000); clock.ready(h); await turn();
    assert.equal(h.calls.length, 10); assert.equal(clock.urls.length, 8);
    assert.equal(h.panel.getElementById('retry').disabled, true, 'The file remains queued rather than becoming a final item error');
  } finally { h.dom.window.close(); }
});

test('network failure while scanning can recover without losing pending directories', async () => {
  const clock = recoveryClock(), responses = new Map([[directoryURL(root), () => { throw new TypeError('Failed to fetch'); }]]);
  const h = createHarness(responses, new MemoryDir(), directoryURL(root), { recoveryClock: clock });
  try {
    await h.click('scan');
    const cached = await core.cacheRequest(h.dom.window.indexedDB, root);
    assert.deepEqual(cached.pending, [root]);
    await clock.advance(30000);
    responses.set(directoryURL(root), { body: listing([fileURL(root + '/first.pdf')]) }); clock.ready(h);
    await until(() => /Найдено 1 файлов/.test(h.panel.getElementById('status').textContent));
    assert.equal(h.calls.length, 2);
  } finally { h.dom.window.close(); }
});

test('disabling automatic recovery keeps network failures paused without consuming further files', async () => {
  const clock = recoveryClock(), paths = [root + '/a.pdf', root + '/b.pdf'];
  const responses = new Map(paths.map(path => [fileURL(path), () => { throw new TypeError('Failed to fetch'); }]));
  const h = createHarness(responses, new MemoryDir(), directoryURL(root),
    { recoveryClock: clock, settings: { auto: false, threads: 1, autoRecover: false } });
  try {
    await importJSON(h, { root, files: paths.map(path => entry(path)) }); await h.click('download');
    await clock.advance(600000);
    assert.equal(h.calls.length, 1); assert.equal(clock.urls.length, 0);
    assert.match(h.panel.getElementById('status').textContent, /Сетевой запрос не завершён/);
  } finally { h.dom.window.close(); }
});

test('an open helper with a severed proxy reconnects and refreshes over its authenticated channel', async () => {
  const clock = recoveryClock(), bus = recoveryBus(), path = root + '/first.pdf';
  const responses = new Map([[fileURL(path), { status: 403, body: 'challenge', headers: { 'cf-mitigated': 'challenge' } }]]);
  const h = createHarness(responses, new MemoryDir(), directoryURL(root), { recoveryClock: clock, broadcastChannel: bus.Channel });
  try {
    await importJSON(h, legacyList()); await h.click('enableRecovery');
    const token = JSON.parse(clock.helper.name.slice(12)).token;
    clock.helper.closed = true; // COOP severs the WindowProxy, not the real tab.
    bus.emit({ type: 'noty-directory-ready', token, protocol: 2, revision: 0 });
    assert.match(h.panel.getElementById('enableRecovery').textContent, /подключена/);
    await h.click('download'); await clock.advance(30000);
    const command = bus.sent.find(message => message.type === 'noty-helper-refresh');
    assert(command, 'Existing helper receives a self-navigation command');
    assert.equal(command.target, directoryURL(root)); assert.equal(command.token, token);
    assert.equal(clock.urls.length, 1, 'No popup or direct proxy navigation after pairing');
    bus.emit({ type: 'noty-directory-ready', token, protocol: 2, revision: 0 }); await turn();
    assert.equal(h.calls.length, 1, 'Old-document readiness cannot resume the new navigation');
    responses.set(fileURL(path), { body: '%PDF-1.7\nrecovered' });
    bus.emit({ type: 'noty-directory-ready', token, protocol: 2, revision: command.revision });
    await until(() => /Готово: 1\/1/.test(h.panel.getElementById('status').textContent));
    assert.equal(h.calls.length, 2);
  } finally { h.dom.window.close(); }
});

test('channel liveness distinguishes a severed proxy from an unresponsive helper', async () => {
  const clock = recoveryClock(), bus = recoveryBus();
  const h = createHarness(new Map(), new MemoryDir(), directoryURL(root), { recoveryClock: clock, broadcastChannel: bus.Channel });
  try {
    await h.click('enableRecovery'); const token = JSON.parse(clock.helper.name.slice(12)).token;
    clock.helper.closed = true;
    bus.emit({ type: 'noty-directory-ready', token, protocol: 2, revision: 0 });
    await clock.advance(5001);
    const ping = bus.sent.at(-1); assert.equal(ping.type, 'noty-helper-ping');
    bus.emit({ type: 'noty-helper-alive', token, protocol: 2, revision: 0, nonce: ping.nonce });
    assert.match(h.panel.getElementById('enableRecovery').textContent, /подключена/);
    await clock.advance(5001);
    bus.emit({ type: 'noty-helper-alive', token, protocol: 2, revision: 0, nonce: 'wrong' });
    await clock.advance(10000);
    assert.match(h.panel.getElementById('recoveryInfo').textContent, /закрыта или не отвечает/);
    bus.emit({ type: 'noty-directory-ready', token, protocol: 2, revision: 0 });
    assert.doesNotMatch(h.panel.getElementById('enableRecovery').textContent, /подключена/);
    assert.equal(clock.urls.length, 1);
  } finally { h.dom.window.close(); }
});

test('helper channel rejects foreign, stale and non-archive navigation commands', () => {
  const bus = recoveryBus();
  const dom = new JSDOM(listing([]), { url: directoryURL(root), runScripts: 'outside-only' });
  dom.window.BroadcastChannel = bus.Channel;
  dom.window.sessionStorage.setItem('noty-helper-context-v1', JSON.stringify({ token: 'paired', channel: 'noty-recovery-test', savedAt: Date.now(), revision: 2 }));
  try {
    dom.window.eval(source);
    const before = bus.sent.length;
    for (const data of [
      { token: 'wrong', revision: 3, target: directoryURL(root) },
      { token: 'paired', revision: 2, target: directoryURL(root) },
      { token: 'paired', revision: 3, target: 'https://example.com/' },
      { token: 'paired', revision: 3, target: 'javascript:alert(1)' },
      { token: 'paired', revision: 3, target: fileURL(root + '/download.exe') },
      { token: 'paired', revision: 3, target: origin + '/?dir=../private' }
    ]) bus.emit({ type: 'noty-helper-refresh', ...data });
    assert.equal(bus.sent.length, before);
    assert.equal(dom.window.location.href, directoryURL(root));
    assert.equal(JSON.parse(dom.window.sessionStorage.getItem('noty-helper-context-v1')).revision, 2);
    bus.emit({ type: 'noty-helper-ping', token: 'paired', nonce: 'probe' });
    assert.equal(bus.sent.at(-1).nonce, 'probe');
    assert.equal(bus.sent.at(-1).type, 'noty-helper-alive');
  } finally { dom.window.close(); }
});

test('regression: ordinary HTML with Cloudflare JavaScript Detections downloads and scanning continues', async () => {
  const html = '<!doctype html><html><head><title>Music</title></head><body>Just a moment is a song.' +
    '<script src="/cdn-cgi/challenge-platform/scripts/jsd/api.js"></script></body></html>';
  core.validateHeader(new TextEncoder().encode(html), 'nnn.htm', 'text/html');
  const path = root + '/nnn.htm';
  const responses = new Map([[directoryURL(root), { body: listing([fileURL(path)]) + html }],
    [fileURL(path), { body: html, headers: { 'content-type': 'text/html' } }]]);
  const h = createHarness(responses, new MemoryDir());
  try {
    await h.click('scan'); await h.click('download');
    assert.equal(h.destination.dirs.get(root).files.get('nnn.htm').data.toString(), html);
    assert.match(h.panel.getElementById('status').textContent, /Готово: 1\/1/);
  } finally { h.dom.window.close(); }
});

for (const name of ['nnn.htm', 'index(1).php']) test(`regression: blocked ${name} recovery opens the exact file instead of the accessible catalog`, async () => {
  const path = root + '/' + name, clock = recoveryClock();
  const responses = new Map([[fileURL(path), { status: 403, body: challengePage, headers: { 'cf-mitigated': 'challenge' } }]]);
  const h = createHarness(responses, new MemoryDir(), directoryURL(root), { recoveryClock: clock });
  try {
    await importJSON(h, { root, files: [entry(path)] }); await h.click('download');
    assert.equal(h.panel.getElementById('challengeLink').href, fileURL(path));
    await clock.advance(30000);
    assert.equal(clock.urls.at(-1), fileURL(path));
    assert.equal(JSON.parse(clock.helper.name.slice(12)).target, fileURL(path));
    responses.set(fileURL(path), { body: '<html><body>Music lesson</body></html>' });
    clock.ready(h);
    await until(() => /Готово: 1\/1/.test(h.panel.getElementById('status').textContent));
    assert.equal(h.calls.length, 2);
    assert.equal(h.destination.dirs.get(root).files.get(name).data.toString(), '<html><body>Music lesson</body></html>');
  } finally { h.dom.window.close(); }
});

test('HTML helper waits for its target, full load and real content; ordinary archive pages get no UI', () => {
  const target = fileURL(root + '/nnn.htm');
  for (const [url, content, expected] of [[target, '<html><body>Music lesson</body></html>', 1],
    [target, challengePage, 0], [target, '<html><body></body></html>', 0], [directoryURL(root), listing([]), 0],
    [fileURL(root + '/other.htm'), '<html><body>Other</body></html>', 0]]) {
    const dom = new JSDOM(content, { url, runScripts: 'outside-only' });
    const messages = []; let readyState = 'interactive';
    dom.window.sessionStorage.setItem('noty-helper-context-v1', JSON.stringify({ token: 'test', channel: 'noty-recovery-test', savedAt: Date.now(), target }));
    dom.window.opener = { postMessage: (...args) => messages.push(args) };
    Object.defineProperty(dom.window.document, 'readyState', { get: () => readyState });
    try {
      dom.window.eval(source); assert.equal(messages.length, 0);
      readyState = 'complete'; dom.window.dispatchEvent(new dom.window.Event('load'));
      assert.equal(messages.length, expected);
      assert.equal(dom.window.document.querySelector('#noty-folder-helper'), null);
    } finally { dom.window.close(); }
  }
  const dom = new JSDOM('<html><body>Music lesson</body></html>', { url: target, runScripts: 'outside-only' });
  try { dom.window.eval(source); assert.equal(dom.window.document.querySelector('#noty-helper-status, #noty-folder-helper'), null); }
  finally { dom.window.close(); }
});

test('recovery: repeated readiness cannot create an unbounded blocked-HTML retry loop', async () => {
  const path = root + '/nnn.htm', clock = recoveryClock();
  const responses = new Map([[fileURL(path), { body: challengePage }]]);
  const h = createHarness(responses, new MemoryDir(), directoryURL(root), { recoveryClock: clock });
  try {
    await importJSON(h, { root, files: [entry(path)] }); await h.click('download');
    for (let i = 0; i < 8; i++) {
      await clock.advance(300000);
      assert.equal(clock.urls.at(-1), fileURL(path));
      clock.ready(h);
      await until(() => h.calls.length === i + 2 && /Очередь сохранена/.test(h.panel.getElementById('log').textContent));
      await turn();
    }
    await until(() => /исчерпан/.test(h.panel.getElementById('recoveryInfo').textContent));
    await clock.advance(600000); clock.ready(h); await turn();
    assert.equal(h.calls.length, 9); assert.equal(clock.urls.length, 8);
    assert.equal(h.destination.dirs.get(root).files.has('nnn.htm'), false);
  } finally { h.dom.window.close(); }
});

test('separate challenges after successful downloads each get a fresh recovery budget', async () => {
  const clock = recoveryClock(), attempts = new Map();
  const paths = Array.from({ length: 9 }, (_, i) => root + '/' + i + '.pdf');
  const responses = new Map(paths.map(path => [fileURL(path), () => {
    const count = (attempts.get(path) || 0) + 1; attempts.set(path, count);
    return count === 1 ? new Response('challenge', { status: 403, headers: { 'cf-mitigated': 'challenge' } }) : new Response('%PDF-1.7\nok');
  }]));
  const h = createHarness(responses, new MemoryDir(), directoryURL(root), { recoveryClock: clock, settings: { auto: false, threads: 1 } });
  try {
    await importJSON(h, { root, files: paths.map(path => entry(path)) }); await h.click('download');
    for (let i = 0; i < paths.length; i++) {
      await clock.advance(0);
      assert.match(h.panel.getElementById('status').textContent, /попытка 1\/8/, `Incident ${i + 1} must not inherit past attempts`);
      await clock.advance(29999); assert.equal(clock.urls.length, i);
      await clock.advance(1); assert.equal(clock.urls.length, i + 1);
      clock.ready(h);
      await until(() => h.destination.dirs.get(root)?.files.has(i + '.pdf'));
      if (i + 1 < paths.length) {
        await until(() => h.panel.getElementById('log').textContent.includes(paths[i + 1] + ':'));
        await until(() => !h.panel.getElementById('export').disabled);
      } else await until(() => /Готово: 9\/9/.test(h.panel.getElementById('status').textContent));
    }
    assert.equal(h.calls.length, 18);
    assert.doesNotMatch(h.panel.getElementById('recoveryInfo').textContent, /исчерпан/);
    const completedStatus = h.panel.getElementById('status').textContent;
    await clock.advance(5000);
    assert.equal(h.panel.getElementById('status').textContent, completedStatus, 'An expired recovery timer must preserve completion status');
  } finally { h.dom.window.close(); }
});

test('successful directory recovery resets the budget before a different folder challenge', async () => {
  const clock = recoveryClock(), child = root + '/child', counts = new Map();
  const responses = new Map([root, child].map(path => [directoryURL(path), () => {
    const count = (counts.get(path) || 0) + 1; counts.set(path, count);
    return count === 1 ? new Response(challengePage, { status: 403 }) : new Response(listing(path === root ? [directoryURL(child)] : []));
  }]));
  const h = createHarness(responses, new MemoryDir(), directoryURL(root), { recoveryClock: clock });
  try {
    await h.click('scan'); await clock.advance(30000); clock.ready(h);
    await until(() => h.panel.getElementById('log').textContent.includes(child + ':'));
    await until(() => !h.panel.getElementById('export').disabled);
    await clock.advance(0); assert.match(h.panel.getElementById('status').textContent, /попытка 1\/8/);
    await clock.advance(30000); assert.equal(clock.urls.length, 2); clock.ready(h);
    await until(() => /Найдено 0 файлов в 2 папках/.test(h.panel.getElementById('status').textContent));
    assert.equal(h.calls.length, 4);
  } finally { h.dom.window.close(); }
});

test('helper closure updates idle UI, rejects late readiness and supports reopening', async () => {
  const clock = recoveryClock(), h = createHarness(new Map(), new MemoryDir(), directoryURL(root), { recoveryClock: clock });
  try {
    await importJSON(h, legacyList());
    const status = h.panel.getElementById('status').textContent;
    await h.click('enableRecovery'); clock.ready(h);
    assert.match(h.panel.getElementById('enableRecovery').textContent, /подключена/);
    clock.helper.closed = true; await clock.advance(1000);
    assert.match(h.panel.getElementById('recoveryInfo').textContent, /закрыта/);
    assert.doesNotMatch(h.panel.getElementById('enableRecovery').textContent, /подключена/);
    assert.equal(h.panel.getElementById('status').textContent, status, 'Do not overwrite queue status');
    assert.equal(clock.ticks.size, 0, 'Stop the helper monitor after closure');
    clock.ready(h); // An already queued message from the old helper must be ignored.
    assert.doesNotMatch(h.panel.getElementById('enableRecovery').textContent, /подключена/);
    clock.helper.closed = false; await h.click('enableRecovery');
    assert.match(h.panel.getElementById('enableRecovery').textContent, /загружается/);
    clock.ready(h); assert.match(h.panel.getElementById('enableRecovery').textContent, /подключена/);
    assert.equal(clock.ticks.size, 1, 'Exactly one closure monitor after reopening');
    await h.click('enableRecovery'); assert.equal(clock.ticks.size, 1, 'Refresh must not add monitors');
  } finally { h.dom.window.close(); }
});

test('helper closure is detected on focus without a timer tick and does not resume a blocked queue', async () => {
  const clock = recoveryClock(), responses = fixtures();
  responses.set(fileURL(root + '/first.pdf'), { status: 403, body: challengePage });
  const h = createHarness(responses, new MemoryDir(), directoryURL(root), { recoveryClock: clock });
  try {
    await importJSON(h, legacyList()); await h.click('download'); await clock.advance(30000);
    const requests = h.calls.length;
    clock.helper.closed = true;
    h.dom.window.dispatchEvent(new h.dom.window.Event('focus'));
    assert.match(h.panel.getElementById('recoveryInfo').textContent, /закрыта/);
    clock.ready(h); await turn();
    assert.equal(h.calls.length, requests, 'A stale readiness message cannot resume work');
    assert.equal(clock.urls.length, 1, 'Closure must not trigger immediate popup/reload loops');
    await h.click('pause'); clock.helper.closed = false; await h.click('enableRecovery'); clock.ready(h); await turn();
    assert.equal(h.calls.length, requests, 'Reconnection must respect manual pause');
  } finally { h.dom.window.close(); }
});

test('recovery delay is bounded and honors a longer Retry-After', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 8].map(n => core.recoveryDelay(n)), [30000, 60000, 120000, 240000, 300000, 300000]);
  assert.equal(core.recoveryDelay(1, 900000), 900000);
});

for (const response of [
  { status: 403, body: 'challenge', headers: { 'cf-mitigated': 'challenge' } },
  { status: 200, body: 'challenge', headers: { 'cf-mitigated': 'challenge' } },
  { status: 200, body: challengePage },
  { status: 403, body: challengePage },
  { status: 429, body: 'slow down' },
  { status: 503, body: 'busy' }
]) {
  test(`recovery: ${response.status}/${response.body} waits for the helper and resumes the original queue`, async () => {
    const clock = recoveryClock(), responses = fixtures();
    responses.set(fileURL(root + '/first.pdf'), response);
    const h = createHarness(responses, new MemoryDir(), directoryURL(root), { recoveryClock: clock });
    try {
      await importJSON(h, legacyList()); await h.click('download');
      assert.equal(h.calls.length, 1);
      assert.equal(h.destination.dirs.get(root).files.has('first.pdf'), false);
      assert.equal(h.panel.getElementById('pause').disabled, false);
      await clock.advance(29999); assert.equal(clock.urls.length, 0);
      await clock.advance(1); assert.equal(clock.urls.length, 1);
      assert.equal(h.calls.length, 1);
      clock.ready(h, { origin: 'https://example.com' }); await turn(); assert.equal(h.calls.length, 1);
      clock.ready(h, { source: {} }); await turn(); assert.equal(h.calls.length, 1);
      clock.ready(h, { data: { type: 'noty-directory-ready', token: 'stale' } }); await turn(); assert.equal(h.calls.length, 1);
      responses.set(fileURL(root + '/first.pdf'), { body: '%PDF-1.7\nrecovered' });
      clock.ready(h);
      await until(() => /Готово: 1\/1/.test(h.panel.getElementById('status').textContent));
      assert.equal(h.calls.length, 2);
      assert.equal(h.destination.dirs.get(root).files.get('first.pdf').data.toString(), '%PDF-1.7\nrecovered');
    } finally { h.dom.window.close(); }
  });
}

for (const plainFirst of [false, true]) test(`four-stream mixed 403 responses recover challenges and skip denied files (plain first: ${plainFirst})`, async () => {
  const clock = recoveryClock(), paths = ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf', 'e.pdf', 'f.pdf'].map(name => root + '/' + name);
  const releases = new Map(), responses = new Map(paths.map(path => [fileURL(path), { body: '%PDF-1.7\nrecovered' }]));
  for (const path of paths.slice(0, 4)) responses.set(fileURL(path), () => new Promise(resolve => releases.set(path, resolve)));
  const h = createHarness(responses, new MemoryDir(), directoryURL(root), { recoveryClock: clock, settings: { auto: false, threads: 4 } });
  let running, stream;
  try {
    await importJSON(h, { root, files: paths.map(path => entry(path)) });
    await h.click('enableRecovery'); clock.ready(h);
    running = h.click('download'); await until(() => releases.size === 4);
    const blocked = index => new Response('Access denied', { status: 403,
      headers: ((index === 0) === plainFirst) ? {} : { 'cf-mitigated': 'challenge' } });
    releases.get(paths[0])(blocked(0));
    await until(() => h.panel.getElementById('log').textContent.includes(paths[0] + ':'));
    releases.get(paths[1])(blocked(1));
    await until(() => h.panel.getElementById('log').textContent.includes(paths[1] + ':'));
    releases.get(paths[2])(new Response('%PDF-1.7\ncomplete'));
    releases.get(paths[3])(new Response(new ReadableStream({ start(controller) {
      stream = controller; controller.enqueue(new TextEncoder().encode('%PDF-1.7\n' + 'x'.repeat(9000)));
    } })));
    await until(() => h.panel.getElementById('metricActive').textContent.startsWith('1 /'));
    assert.doesNotMatch(h.panel.getElementById('recoveryInfo').textContent, /продолжение выключено/);
    assert.equal(h.panel.getElementById('runState').textContent, 'На паузе');
    assert.match(h.panel.getElementById('status').textContent, /начатые файлы.*1/);
    const requestsWhilePaused = h.calls.length;
    await clock.advance(30000);
    assert.equal(h.calls.length, requestsWhilePaused, 'No queued file starts while draining');
    assert.equal(clock.urls.length, 1, 'Do not resume while an existing stream is active');
    stream.close(); stream = null; await running;
    for (const path of paths.slice(0, 4)) responses.set(fileURL(path), { body: '%PDF-1.7\nrecovered' });
    await clock.advance(0); assert.equal(clock.urls.length, 2);
    assert.match(h.panel.getElementById('status').textContent, /попытка 1\/8/, 'Draining old transfers does not reset the incident');
    clock.ready(h);
    await until(() => /Готово: 5\/6. Ошибок: 1/.test(h.panel.getElementById('status').textContent));
    assert.equal(h.calls.length, 7, 'Only the challenge and two queued files are fetched after recovery');
    const denied = plainFirst ? paths[0] : paths[1];
    assert.equal(h.calls.filter(url => url === fileURL(denied)).length, 1, 'Plain denied files are not retried automatically');
    assert.equal(h.calls.filter(url => url === fileURL(paths[3])).length, 1);
  } finally {
    for (const release of releases.values()) release(new Response('%PDF-1.7\ncleanup'));
    if (stream) stream.close(); if (running) await running;
    h.dom.window.close();
  }
});

for (const threads of [1, 4]) test(`bare 403 on macOS metadata is an item error and other files continue (${threads} workers)`, async () => {
  const clock = recoveryClock();
  const paths = ['._.DS_Store', '._1-Доверие Богу.enc', '.DS_Store', '1-Доверие Богу.enc', 'z-last.pdf'].map(name => root + '/' + name);
  const responses = new Map(paths.map((path, i) => [fileURL(path), i < 3 ? { status: 403, body: 'Access denied' } : { body: '%PDF-1.7\ncontent' }]));
  const h = createHarness(responses, new MemoryDir(), directoryURL(root), { recoveryClock: clock, settings: { auto: false, threads } });
  try {
    await importJSON(h, { root, files: paths.map(path => entry(path)) }); await h.click('download');
    assert.match(h.panel.getElementById('status').textContent, /Готово: 2\/5. Ошибок: 3/);
    await clock.advance(600000); assert.equal(clock.urls.length, 0);
    assert.equal(h.calls.length, 5);
    const data = await exportedJSON(h, 'export');
    assert.deepEqual(data.errors.map(e => e.item.path).sort(), paths.slice(0, 3).sort());
    assert(data.errors.every(e => /HTTP 403.*служебн/.test(e.error)));
    const out = h.destination.dirs.get(root);
    assert.equal(out.files.has('._1-Доверие Богу.enc'), false);
    const journal = JSON.parse(out.files.get('.noty-download-state.json').data);
    assert.equal(Object.keys(journal.completed).length, 2);
    assert.deepEqual(data.files.map(f => f.path).sort(), paths.slice(3).sort());
    assert.deepEqual((await core.cacheRequest(h.dom.window.indexedDB, root)).files.map(f => f.path).sort(), paths.slice(3).sort());
    assert.equal(h.panel.getElementById('retry').disabled, true);
    assert.match(h.panel.getElementById('eta').textContent, /удалено ссылок с HTTP 403: 3/);
    assert.doesNotMatch(h.panel.getElementById('eta').textContent, /требуют повтора/);
    await h.click('retry'); assert.equal(h.calls.length, 5);
    assert.equal(clock.urls.length, 0, 'Removed files never enter the retry queue');
  } finally { h.dom.window.close(); }
});

test('confirmed challenge on metadata still requires recovery and successful metadata is saved', async () => {
  const clock = recoveryClock(), path = root + '/._score.enc';
  const responses = new Map([[fileURL(path), { status: 403, body: 'challenge', headers: { 'cf-mitigated': 'challenge' } }]]);
  const h = createHarness(responses, new MemoryDir(), directoryURL(root), { recoveryClock: clock });
  try {
    await importJSON(h, { root, files: [entry(path)] }); await h.click('download');
    assert.equal((await exportedJSON(h, 'export')).files[0].path, path, 'Challenges must not remove links');
    await clock.advance(30000); assert.equal(clock.urls.length, 1);
    responses.set(fileURL(path), { body: 'AppleDouble fixture bytes' }); clock.ready(h);
    await until(() => /Готово: 1\/1. Ошибок: 0/.test(h.panel.getElementById('status').textContent));
    assert.equal(h.destination.dirs.get(root).files.get('._score.enc').data.toString(), 'AppleDouble fixture bytes');
  } finally { h.dom.window.close(); }
});

test('all-denied manifest stays empty in cache and export, including after reload', async () => {
  const db = new IDBFactory(), path = root + '/denied.pdf';
  let h = createHarness(new Map([[fileURL(path), { status: 403, body: 'Forbidden' }]]), new MemoryDir(), directoryURL(root), { indexedDB: db });
  try {
    await importJSON(h, { root, files: [entry(path)] }); await h.click('download');
    assert.deepEqual((await exportedJSON(h, 'export')).files, []);
    assert.deepEqual(core.validateManifest(await core.cacheRequest(db, root)).files, []);
    assert.equal(h.panel.getElementById('download').disabled, true);
    h.dom.window.close(); h = createHarness(new Map(), new MemoryDir(), directoryURL(root), { indexedDB: db });
    await until(() => !h.panel.getElementById('cache').disabled); await h.click('cache');
    assert.deepEqual((await exportedJSON(h, 'export')).files, []);
    await h.click('download'); assert.equal(h.calls.length, 0);
  } finally { h.dom.window.close(); }
});

test('manual retry retries other errors while retaining excluded 403 diagnostics', async () => {
  const denied = root + '/denied.pdf', missing = root + '/missing.pdf';
  const responses = new Map([[fileURL(denied), { status: 403, body: 'Forbidden' }], [fileURL(missing), { status: 404, body: 'Not found' }]]);
  const h = createHarness(responses);
  try {
    await importJSON(h, { root, files: [entry(denied), entry(missing)] }); await h.click('download');
    assert.equal(h.panel.getElementById('retry').disabled, false);
    responses.set(fileURL(missing), { body: '%PDF-1.7\nrecovered' }); await h.click('retry');
    assert.equal(h.calls.filter(url => url === fileURL(denied)).length, 1);
    assert.equal(h.calls.filter(url => url === fileURL(missing)).length, 2);
    const data = await exportedJSON(h, 'export');
    assert.deepEqual(data.files.map(f => f.path), [missing]);
    assert.equal(data.errors.length, 1); assert.equal(data.errors[0].excluded, true);
    assert.equal(h.panel.getElementById('retry').disabled, true);
  } finally { h.dom.window.close(); }
});

test('directory 403 recovery honors Retry-After and stops after eight unsuccessful recoveries', async () => {
  const clock = recoveryClock();
  const responses = new Map([[directoryURL(root), { status: 403, body: 'Access denied', headers: { 'retry-after': '120' } }]]);
  const h = createHarness(responses, new MemoryDir(), directoryURL(root), { recoveryClock: clock });
  try {
    await h.click('scan');
    await clock.advance(119999); assert.equal(clock.urls.length, 0);
    await clock.advance(1); assert.equal(new URL(clock.urls.at(-1)).searchParams.get('dir'), root);
    for (let i = 0; i < 8; i++) {
      if (i > 0) await clock.advance(300000);
      clock.ready(h);
      await until(() => h.calls.length === i + 2);
      await until(() => h.panel.getElementById('log').textContent.split('HTTP 403').length === i + 3);
      await until(() => !h.panel.getElementById('export').disabled);
    }
    assert.match(h.panel.getElementById('recoveryInfo').textContent, /исчерпан/);
    await clock.advance(600000); clock.ready(h); await turn();
    assert.equal(h.calls.length, 9); assert.equal(clock.urls.length, 8);
    assert.equal(h.destination.dirs.size, 0);
  } finally { h.dom.window.close(); }
});

test('HTTP 401 still requires manual intervention', async () => {
  const clock = recoveryClock(), path = root + '/first.pdf';
  const h = createHarness(new Map([[fileURL(path), { status: 401, body: 'Unauthorized' }]]), new MemoryDir(), directoryURL(root), { recoveryClock: clock });
  try {
    await importJSON(h, legacyList()); await h.click('download'); await clock.advance(600000);
    assert.equal(clock.urls.length, 0); assert.equal(h.calls.length, 1);
    assert.match(h.panel.getElementById('status').textContent, /HTTP 401/);
  } finally { h.dom.window.close(); }
});

test('download badge reports loading after folder preparation completes', async () => {
  let release;
  const h = createHarness(new Map([[fileURL(root + '/first.pdf'), () => new Promise(resolve => { release = resolve; })]]));
  let running;
  try {
    await importJSON(h, legacyList()); running = h.click('download'); await until(() => !!release);
    assert.equal(h.panel.getElementById('runState').textContent, 'Загрузка');
  } finally { if (release) release(new Response('%PDF-1.7\ncontent')); if (running) await running; h.dom.window.close(); }
});

test('recovery: Retry-After delays navigation and repeated page refreshes stop at eight attempts', async () => {
  const clock = recoveryClock(), responses = fixtures();
  responses.set(fileURL(root + '/first.pdf'), { body: 'challenge', status: 403, headers: { 'cf-mitigated': 'challenge', 'retry-after': '120' } });
  const h = createHarness(responses, new MemoryDir(), directoryURL(root), { recoveryClock: clock });
  try {
    await importJSON(h, legacyList()); await h.click('download');
    await clock.advance(119999); assert.equal(clock.urls.length, 0);
    await clock.advance(1); assert.equal(clock.urls.length, 1);
    for (let i = 0; i < 8; i++) await clock.advance(300000);
    assert.equal(clock.urls.length, 8); assert.equal(h.calls.length, 1);
    assert.match(h.panel.getElementById('recoveryInfo').textContent, /исчерпан/);
    clock.ready(h); await turn(); assert.equal(h.calls.length, 1);
  } finally { h.dom.window.close(); }
});

for (const mode of ['pause', 'disabled', 'permission', 'popup']) {
  test(`recovery: ${mode} prevents unattended resumption`, async () => {
    const clock = recoveryClock(), responses = fixtures();
    responses.set(fileURL(root + '/first.pdf'), { body: challengePage });
    const h = createHarness(responses, new MemoryDir(), directoryURL(root), { recoveryClock: clock });
    try {
      await importJSON(h, legacyList()); await h.click('download');
      if (mode === 'pause') await h.click('pause');
      if (mode === 'disabled') { const input = h.panel.getElementById('autoRecover'); input.checked = false; input.onchange(); }
      if (mode === 'permission') h.destination.dirs.get(root).queryPermission = async () => 'prompt';
      if (mode === 'popup') clock.popupBlocked = true;
      await clock.advance(30000);
      if (mode === 'permission') {
        clock.ready(h); await until(() => /нужен доступ/.test(h.panel.getElementById('status').textContent));
      } else if (mode === 'popup') assert.match(h.panel.getElementById('recoveryInfo').textContent, /всплывающие/);
      else assert.equal(clock.urls.length, 0);
      assert.equal(h.calls.length, 1);
    } finally { h.dom.window.close(); }
  });
}

test('recovery: folder enumeration resumes after helper navigation without a directory picker', async () => {
  const clock = recoveryClock(), responses = new Map([[directoryURL(root), { body: challengePage }]]);
  const h = createHarness(responses, new MemoryDir(), directoryURL(root), { recoveryClock: clock });
  try {
    await h.click('scan'); await clock.advance(30000);
    responses.set(directoryURL(root), { body: listing([fileURL(root + '/first.pdf')]) });
    clock.ready(h);
    await until(() => /Найдено 1 файлов/.test(h.panel.getElementById('status').textContent));
    assert.equal(h.calls.length, 2); assert.equal(h.destination.dirs.size, 0);
  } finally { h.dom.window.close(); }
});

test('helper announces only a fully loaded directory and never starts a second downloader', () => {
  for (const content of [listing([]), challengePage]) {
    const dom = new JSDOM(content, { url: origin + '/?noty_helper=token', runScripts: 'outside-only' });
    let readyState = 'interactive'; const messages = [];
    Object.defineProperty(dom.window.document, 'readyState', { get: () => readyState });
    dom.window.opener = { postMessage: (...args) => messages.push(args) };
    try {
      dom.window.eval(source); assert.equal(messages.length, 0);
      assert.equal(dom.window.document.querySelector('#noty-folder-helper'), null);
      readyState = 'complete'; dom.window.dispatchEvent(new dom.window.Event('load'));
      assert.equal(messages.length, content.includes('File name') ? 1 : 0);
      if (messages.length) { assert.equal(messages[0][0].token, 'token'); assert.equal(messages[0][1], origin); }
    } finally { dom.window.close(); }
  }
});

for (const carrier of ['sessionStorage', 'name']) {
  test(`regression: helper survives stripped URL parameters using ${carrier}`, () => {
    const dom = new JSDOM(listing([]), { url: directoryURL(root), runScripts: 'outside-only' });
    const messages = [], context = { token: 'redirect-token', channel: 'noty-recovery-test', savedAt: Date.now() };
    Object.defineProperty(dom.window.document, 'readyState', { value: 'complete' });
    dom.window.opener = { postMessage: (...args) => messages.push(args) };
    if (carrier === 'sessionStorage') dom.window.sessionStorage.setItem('noty-helper-context-v1', JSON.stringify(context));
    else dom.window.name = 'noty-helper:' + JSON.stringify(context);
    try {
      dom.window.eval(source);
      assert.equal(dom.window.document.querySelector('#noty-folder-helper'), null);
      assert.equal(messages[0][0].token, 'redirect-token');
      assert.match(dom.window.document.getElementById('noty-helper-status').textContent, /Служебная вкладка/);
    } finally { dom.window.close(); }
  });
}

test('regression: challenge link opens the connected helper instead of an unrelated ordinary tab', async () => {
  const clock = recoveryClock(), responses = fixtures();
  responses.set(fileURL(root + '/first.pdf'), { body: challengePage });
  const h = createHarness(responses, new MemoryDir(), directoryURL(root), { recoveryClock: clock });
  try {
    await importJSON(h, legacyList()); await h.click('download');
    const link = h.panel.getElementById('challengeLink');
    assert.equal(typeof link.onclick, 'function');
    let prevented = false; link.onclick({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.ok(new URL(clock.urls.at(-1)).searchParams.get('noty_helper'));
  } finally { h.dom.window.close(); }
});

test('regression: helper context is installed before navigation and never stored in the owner tab', async () => {
  const clock = recoveryClock(), stored = new Map();
  clock.helper.sessionStorage = { setItem: (key, value) => stored.set(key, value) };
  const h = createHarness(fixtures(), new MemoryDir(), directoryURL(root), { recoveryClock: clock });
  let navigations = 0;
  clock.helper.location.replace = url => {
    navigations++;
    const token = new URL(url).searchParams.get('noty_helper');
    assert.equal(JSON.parse(stored.get('noty-helper-context-v1')).token, token);
    assert.equal(JSON.parse(clock.helper.name.slice(12)).token, token);
    assert.equal(h.dom.window.sessionStorage.getItem('noty-helper-context-v1'), null);
  };
  try { await h.click('enableRecovery'); await h.click('enableRecovery'); assert.equal(navigations, 2); }
  finally { h.dom.window.close(); }
});

test('expired or malformed helper context does not turn a normal tab into a helper', () => {
  for (const context of ['invalid JSON', JSON.stringify({ token: 'x', channel: 'noty-recovery-test', savedAt: Date.now() - 86400001 }),
    JSON.stringify({ token: '', channel: 'noty-recovery-test', savedAt: Date.now() })]) {
    const dom = new JSDOM(listing([]), { url: directoryURL(root), runScripts: 'outside-only' });
    dom.window.sessionStorage.setItem('noty-helper-context-v1', context);
    try { dom.window.eval(source); assert.ok(dom.window.document.getElementById('noty-folder-helper')); }
    finally { dom.window.close(); }
  }
});

for (const confirmedChallenge of [true, false]) test(`recovery: a concurrent disk failure prevents 403 auto-resumption (confirmed: ${confirmedChallenge})`, async () => {
  const clock = recoveryClock(), destination = new MemoryDir(), out = await destination.getDirectoryHandle(root, { create: true });
  let release, requests = 0; const barrier = new Promise(resolve => { release = resolve; });
  const paths = ['a.pdf', 'b.pdf'].map(p => root + '/' + p);
  const responses = new Map(paths.map((p, index) => [fileURL(p), async () => {
    if (++requests === 2) release(); await barrier;
    return index === 0 ? new Response('blocked', { status: 403, headers: confirmedChallenge ? { 'cf-mitigated': 'challenge' } : {} }) : new Response('%PDF-1.7\nfile');
  }]));
  const file = new MemoryFile(); file.createWritable = async () => { throw new DOMException('Local destination gone', 'NotFoundError'); };
  out.files.set('b.pdf', file);
  const h = createHarness(responses, destination, directoryURL(root), { recoveryClock: clock, settings: { auto: false, threads: 2 } });
  try {
    await importJSON(h, { root, files: paths.map(p => entry(p)) }); await h.click('download');
    await clock.advance(60000);
    assert.equal(clock.urls.length, 0); assert.equal(requests, 2);
    assert.match(h.panel.getElementById('status').textContent, /Локальная файловая система/);
  } finally { release(); h.dom.window.close(); }
});

test('recovery: manual pause wins a race with a pending permission query', async () => {
  const clock = recoveryClock(), responses = fixtures();
  responses.set(fileURL(root + '/first.pdf'), { body: challengePage });
  const h = createHarness(responses, new MemoryDir(), directoryURL(root), { recoveryClock: clock });
  let release;
  try {
    await importJSON(h, legacyList()); await h.click('download');
    h.destination.dirs.get(root).queryPermission = () => new Promise(resolve => { release = resolve; });
    await clock.advance(30000); clock.ready(h); await until(() => !!release);
    await h.click('pause'); release('granted'); await turn();
    await clock.advance(60000);
    assert.equal(h.calls.length, 1); assert.equal(clock.urls.length, 1);
    assert.match(h.panel.getElementById('recoveryInfo').textContent, /выключено/);
  } finally { release?.('granted'); h.dom.window.close(); }
});

test('folder scope distinguishes siblings and rejects traversal', () => {
  assert.equal(core.currentRoot(directoryURL(root + '/ТЕОРИЯ/')), root + '/ТЕОРИЯ');
  assert.equal(core.currentRoot(directoryURL('_Сборники/Хоровые')), '_Сборники/Хоровые');
  assert.equal(core.inside('_Сборники-other', '_Сборники'), false);
  for (const path of ['a/../b', 'a/./b', 'a//b', '/a', 'a\\b', 'a/\0b']) assert.throws(() => core.validPath(path));
});
test('archive root accepts both home URLs and rejects malformed folder paths', () => {
  assert.equal(core.currentRoot(origin + '/'), '');
  assert.equal(core.currentRoot(directoryURL('')), '');
  assert.equal(core.currentRoot(origin + '/?sort_by=name&dir='), '');
  for (const path of ['/', '../_ABC', '_ABC/../_PV', '_ABC\\escape']) {
    assert.throws(() => core.currentRoot(directoryURL(path)));
  }
  assert.throws(() => core.currentRoot('https://example.com/'));
});
test('archive-root relative paths preserve their first segment and still reject traversal', () => {
  assert.deepEqual(core.localParts('_ABC/Folder/song.pdf', ''), ['_ABC', 'Folder', 'song.pdf']);
  assert.deepEqual(core.localParts('song.pdf', ''), ['song.pdf']);
  assert.throws(() => core.localParts('../song.pdf', ''));
  assert.throws(() => core.localParts('', ''));
  assert.throws(() => core.checkCollisions([{ path: '_ABC/x.pdf' }, { path: '_abc/x.pdf' }], ''));
  assert.throws(() => core.checkCollisions([{ path: '.noty-download-state.json' }], ''));
});
test('only child listing links without sorting or mobile parameters are followed', () => {
  const base = directoryURL(root);
  assert.equal(core.classifyLink('?dir=' + encodeURIComponent(root + '/ПИАНО'), base, root, root).type, 'folder');
  for (const href of [base, '?dir=', '?dir=' + encodeURIComponent(root + '/ПИАНО') + '&sort_by=name',
    '?m&dir=' + encodeURIComponent(root + '/ПИАНО'), 'https://example.com/?dir=' + encodeURIComponent(root + '/ПИАНО')]) {
    assert.equal(core.classifyLink(href, base, root, root), null);
  }
});
test('literal plus, percent, spaces, Unicode and hashes survive file URL decoding', () => {
  const path = root + '/ТЕОРИЯ/Ноты + 100% #1.pdf';
  assert.equal(core.classifyLink(fileURL(path), directoryURL(root), root, root).path, path);
});
test('encoded slashes, external links, credentials and files outside the root are rejected', () => {
  for (const url of [origin + '/Public/' + encodeURIComponent(root) + '/a%2fb.pdf',
    fileURL(root + '/a\\b.pdf'), fileURL('_ДРУГОЕ/a.pdf'), fileURL(root + '-other/a.pdf'),
    'https://user:pass@noty.propovednik.com/Public/' + encodeURIComponent(root) + '/a.pdf']) {
    assert.equal(core.classifyLink(url, directoryURL(root), root, root), null);
  }
});
test('Windows escaping is stable and does not collapse distinct unsafe names', () => {
  assert.equal(core.safeName('Ноты.pdf'), 'Ноты.pdf');
  assert.notEqual(core.safeName('a:b.pdf'), core.safeName('a%3Ab.pdf'));
  assert.equal(core.safeName('CON.txt'), '%43ON.txt');
  assert.equal(core.safeName('a. '), 'a%2E%20');
  assert.throws(() => core.safeName('a'.repeat(221)));
});

test('Chromium-invalid tilde names are escaped without changing valid long names', () => {
  for (const name of ['~PV_Contents', 'backup~', '.~hidden', 'ABC~1', 'abc~1.pdf']) {
    assert.equal(core.safeName(name), name.replaceAll('~', '%7E'));
    assert.notEqual(core.safeName(name), core.safeName(name.replaceAll('~', '%7E')));
  }
  assert.equal(core.safeName('long~folder-name'), 'long~folder-name');
  assert.equal(core.safeName('.noty-download-state.json'), '.noty-download-state.json');
});

test('tilde directory downloads, verifies and resumes at the same encoded path', async () => {
  const destination = new MemoryDir(), out = await destination.getDirectoryHandle(root, { create: true });
  const original = out.getDirectoryHandle.bind(out);
  out.getDirectoryHandle = async (name, options) => {
    if (name.startsWith('~')) throw new TypeError("Failed to execute 'getDirectoryHandle' on 'FileSystemDirectoryHandle': Name is not allowed.");
    return original(name, options);
  };
  const paths = ['~PV_Contents/0000.htm', '%7EPV_Contents/0000.htm', 'last.pdf'].map(p => root + '/' + p);
  const responses = new Map(paths.map(p => [fileURL(p), { body: p.endsWith('.htm') ? '<html>Music lesson</html>' : '%PDF-1.7\nok' }]));
  const db = new IDBFactory(); let h = createHarness(responses, destination, directoryURL(root), { indexedDB: db });
  try {
    await importJSON(h, { root, files: paths.map(p => entry(p)) }); await h.click('download');
    assert.match(h.panel.getElementById('status').textContent, /Готово: 3\/3. Ошибок: 0/);
    assert.equal(out.dirs.get('%7EPV_Contents').files.get('0000.htm').data.toString(), '<html>Music lesson</html>');
    assert.equal(out.dirs.get('%257EPV_Contents').files.get('0000.htm').data.toString(), '<html>Music lesson</html>');
    await h.click('verify'); assert.match(h.panel.getElementById('verifyInfo').textContent, /Совпадает с журналом: 3/);
    assert.deepEqual((await exportedJSON(h, 'export')).files.map(f => f.path), paths);
    h.dom.window.close(); h = createHarness(responses, destination, directoryURL(root), { indexedDB: db });
    await until(() => !h.panel.getElementById('cache').disabled); await h.click('cache'); await h.click('download');
    assert.equal(h.calls.length, 0);
    assert.match(h.panel.getElementById('status').textContent, /Готово: 3\/3. Ошибок: 0/);
  } finally { h.dom.window.close(); }
});

for (const start of ['download', 'repair']) test(`explicit directory name rejection does not stop sibling ${start}`, async () => {
  const destination = new MemoryDir(), out = await destination.getDirectoryHandle(root, { create: true });
  const original = out.getDirectoryHandle.bind(out); let reject = start === 'download';
  out.getDirectoryHandle = async (name, options) => {
    if (reject && name === 'blocked') throw new TypeError("Failed to execute 'getDirectoryHandle' on 'FileSystemDirectoryHandle': Name is not allowed.");
    return original(name, options);
  };
  const paths = ['blocked/a.pdf', 'blocked/b.pdf', 'last.pdf'].map(p => root + '/' + p);
  const h = createHarness(new Map(paths.map(p => [fileURL(p), { body: '%PDF-1.7\nok' }])), destination);
  try {
    await importJSON(h, { root, files: paths.map(p => entry(p)) });
    if (start === 'repair') { await h.click('verify'); reject = true; }
    await h.click(start);
    assert.match(h.panel.getElementById('status').textContent, /Готово: 1\/3. Ошибок: 2/);
    assert.equal(out.files.get('last.pdf').data.toString(), '%PDF-1.7\nok');
    assert.equal(h.calls.length, 1);
    const data = await exportedJSON(h, 'export');
    assert.equal(data.files.length, 3, 'Local name failure does not delete remote links');
    assert(data.errors.every(e => /имя папки/.test(e.error) && !/свободное место/.test(e.error)));
    await h.click('verify'); assert.match(h.panel.getElementById('verifyInfo').textContent, /Ошибка чтения: 2/);
  } finally { h.dom.window.close(); }
});
test('case, file/directory and journal collisions cannot overwrite files', () => {
  assert.throws(() => core.checkCollisions([{ path: root + '/A.pdf' }, { path: root + '/a.pdf' }], root));
  assert.throws(() => core.checkCollisions([{ path: root + '/A' }, { path: root + '/A/b.pdf' }], root));
  assert.throws(() => core.checkCollisions([{ path: root + '/.noty-download-state.json' }], root));
  core.checkCollisions([{ path: root + '/A/1.pdf' }, { path: root + '/A/2.pdf' }], root);
});
test('PDFs and legitimate HTML are distinguished from error and challenge pages', () => {
  const bytes = text => new TextEncoder().encode(text);
  core.validateHeader(bytes('%PDF-1.7\ndata'), 'a.pdf', 'application/pdf');
  core.validateHeader(bytes('<!doctype html><html>Book</html>'), 'a.htm', 'text/html');
  assert.throws(() => core.validateHeader(bytes('<html>Error</html>'), 'a.pdf', 'application/octet-stream'));
  assert.throws(() => core.validateHeader(bytes('error'), 'a.pdf', 'application/pdf'));
  assert.throws(() => core.validateHeader(bytes(challengePage), 'a.htm', 'text/html'));
});

for (const start of ['download', 'repair']) {
  test(`regression: ${start} accepts an archived PHP page and continues after invalid file content`, async () => {
    const php = root + '/Wikipedia.files/index(1).php';
    const bad = root + '/bad.pdf', invalid = root + '/invalid.pdf', good = root + '/last.pdf';
    const html = '<!doctype html><html><head><title>Archive page</title></head><body>Archived resource</body></html>';
    const responses = new Map([[fileURL(php), { body: html, headers: { 'content-type': 'text/html' } }],
      [fileURL(bad), { body: '<html>Server error</html>', headers: { 'content-type': 'text/html' } }],
      [fileURL(invalid), { body: 'not a PDF', headers: { 'content-type': 'application/pdf' } }],
      [fileURL(good), { body: '%PDF-1.7\ngood' }]]);
    const h = createHarness(responses, new MemoryDir(), directoryURL(root), { settings: { auto: false, threads: 1 } });
    try {
      await importJSON(h, { root, files: [php, bad, invalid, good].map(path => entry(path)) });
      if (start === 'repair') await h.click('verify');
      await h.click(start);
      const out = h.destination.dirs.get(root);
      assert.equal(out.dirs.get('Wikipedia.files')?.files.get('index(1).php')?.data.toString(), html);
      assert.equal(out.files.get('last.pdf')?.data.toString(), '%PDF-1.7\ngood');
      assert.equal(out.files.has('bad.pdf'), false); assert.equal(out.files.has('invalid.pdf'), false);
      assert.match(h.panel.getElementById('status').textContent, /Готово: 2\/4. Ошибок: 2/);
      const exported = await exportedJSON(h, 'export');
      assert.deepEqual(exported.errors.map(e => e.item.path).sort(), [bad, invalid]);
      assert.equal(h.calls.length, 4);
      // Only the two failed files are retried; successfully saved files stay put.
      responses.set(fileURL(bad), { body: '%PDF-1.7\nrepaired' });
      responses.set(fileURL(invalid), { body: '%PDF-1.7\nrepaired' });
      await h.click('retry');
      assert.equal(h.calls.length, 6);
      assert.match(h.panel.getElementById('status').textContent, /Готово: 4\/4. Ошибок: 0/);
    } finally { h.dom.window.close(); }
  });
}

class MemoryFile {
  constructor(data = '') { this.data = Buffer.from(data); this.lastModified = 1; }
  async getFile() { const data = this.data; return { size: data.length, lastModified: this.lastModified, text: async () => data.toString() }; }
  async createWritable() {
    let pieces = [];
    return { write: async chunk => pieces.push(Buffer.from(chunk)), close: async () => { this.data = Buffer.concat(pieces); this.lastModified++; },
      abort: async () => { pieces = []; } };
  }
}
class MemoryDir {
  constructor(name = 'destination') { this.name = name; this.dirs = new Map(); this.files = new Map(); }
  async requestPermission() { return 'granted'; }
  async queryPermission() { return 'granted'; }
  async getDirectoryHandle(name, options = {}) {
    if (!this.dirs.has(name)) {
      if (!options.create) throw new DOMException('Not found', 'NotFoundError');
      this.dirs.set(name, new MemoryDir(name));
    }
    return this.dirs.get(name);
  }
  async getFileHandle(name, options = {}) {
    if (!this.files.has(name)) {
      if (!options.create) throw new DOMException('Not found', 'NotFoundError');
      this.files.set(name, new MemoryFile());
    }
    return this.files.get(name);
  }
}
function listing(links) {
  return '<html><table><tr><th><a>File name</a></th><th><a>Size</a></th></tr>' +
    links.map(link => `<tr><td><a href="${link.replaceAll('&', '&amp;')}">File</a></td></tr>`).join('') + '</table></html>';
}
function createHarness(responses, destination = new MemoryDir(), pageURL = directoryURL(root), options = {}) {
  const dom = new JSDOM('<html><body></body></html>', { url: pageURL, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  if (options.broadcastChannel) w.BroadcastChannel = options.broadcastChannel;
  if (options.clock) w.performance.now = () => options.clock.now;
  if (options.recoveryClock) {
    const clock = options.recoveryClock; let next = 1;
    w.Date.now = () => clock.now;
    w.setInterval = fn => { const id = next++; clock.ticks.set(id, fn); return id; };
    w.clearInterval = id => clock.ticks.delete(id);
    w.open = url => { if (url) clock.urls.push(url); return clock.popupBlocked ? null : clock.helper; };
  }
  w.indexedDB = options.indexedDB === null ? undefined : options.indexedDB || new IDBFactory();
  w.localStorage.setItem('noty-folder-settings-v1', JSON.stringify({ delayMs: 0, scanDelayMs: 0, maxRetries: 0, ...options.settings }));
  w.TextDecoder = TextDecoder; w.AbortController = AbortController; w.AbortSignal = AbortSignal;
  const nativeTimer = w.setTimeout.bind(w);
  w.setTimeout = (fn, delay, ...args) => {
    if (delay === 5000 && options.checkpoint) options.checkpoint.run = fn;
    return nativeTimer(fn, delay <= 500 ? 0 : delay, ...args);
  };
  const calls = [];
  w.fetch = async url => {
    calls.push(url);
    const value = responses.get(url);
    if (!value) throw new Error('Unexpected URL: ' + url);
    return typeof value === 'function' ? value() : new Response(value.body, { status: value.status || 200, headers: value.headers });
  };
  w.showDirectoryPicker = async () => destination;
  w.eval(source);
  const panel = w.document.querySelector('#noty-folder-helper').shadowRoot;
  return { dom, panel, calls, destination, click: async id => panel.getElementById(id).onclick() };
}
function setSettings(h, changes) {
  for (const [key, value] of Object.entries(changes)) h.panel.getElementById(key).value = String(value);
  h.panel.getElementById(Object.keys(changes)[0]).onchange();
}
async function importJSON(h, data) {
  const input = h.panel.getElementById('importFile');
  const text = JSON.stringify(data);
  Object.defineProperty(input, 'files', { configurable: true, value: [{ size: Buffer.byteLength(text), text: async () => text }] });
  await input.onchange();
}
const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 1000; i++) { if (predicate()) return; await turn(); }
  assert.fail('Timed out waiting for condition');
}
function fixtures() {
  return new Map([
    [directoryURL(root), { body: listing([directoryURL(root + '/Теория'), directoryURL(root + '/Теория'),
      directoryURL(root), '?sort_by=name&dir=' + encodeURIComponent(root), fileURL(root + '/first.pdf')]) }],
    [directoryURL(root + '/Теория'), { body: listing([directoryURL(root), fileURL(root + '/Теория/Ноты +.pdf')]) }],
    [fileURL(root + '/first.pdf'), { body: '%PDF-1.7\nfirst', headers: { 'content-type': 'application/pdf' } }],
    [fileURL(root + '/Теория/Ноты +.pdf'), () => new Response(new ReadableStream({ start(c) {
      // The PDF signature deliberately straddles transport chunks.
      for (const part of ['%P', 'DF-1.7\n', 'nested']) c.enqueue(new TextEncoder().encode(part)); c.close();
    } }), { headers: { 'content-type': 'application/pdf' } })]
  ]);
}
test('integration: crawl deduplicates links, preserves directories, streams bytes and resumes after reload', async () => {
  const destination = new MemoryDir();
  let h = createHarness(fixtures(), destination);
  await h.click('scan'); await h.click('download');
  assert.match(h.panel.getElementById('status').textContent, /Готово: 2\/2. Ошибок: 0/);
  const out = destination.dirs.get(root);
  assert.equal(out.files.get('first.pdf').data.toString(), '%PDF-1.7\nfirst');
  assert.equal(out.dirs.get('Теория').files.get('Ноты +.pdf').data.toString(), '%PDF-1.7\nnested');
  assert.equal(h.calls.filter(u => u === directoryURL(root + '/Теория')).length, 1);
  assert.equal(Object.keys(JSON.parse(out.files.get('.noty-download-state.json').data).completed).length, 2);
  h.dom.window.close();
  h = createHarness(fixtures(), destination);
  await h.click('scan'); await h.click('download');
  assert.equal(h.calls.filter(u => u.includes('/Public/')).length, 0);
  assert.match(h.panel.getElementById('status').textContent, /Готово: 2\/2/);
  h.dom.window.close();
});
test('plain file 403 is removed from manifest/cache/export and never retried after reload', async () => {
  const responses = fixtures(), clock = recoveryClock(), db = new IDBFactory(), destination = new MemoryDir();
  responses.set(fileURL(root + '/first.pdf'), { body: '<html><h1>403 Forbidden</h1><hr>nginx/1.18.0</html>', status: 403 });
  let h = createHarness(responses, destination, directoryURL(root), { recoveryClock: clock, indexedDB: db });
  try {
    await h.click('scan'); await h.click('download');
    assert.match(h.panel.getElementById('status').textContent, /Готово: 1\/2. Ошибок: 1/);
    assert.equal(destination.dirs.get(root).files.has('first.pdf'), false);
    const exported = await exportedJSON(h, 'export');
    assert.deepEqual(exported.files.map(f => f.path), [root + '/Теория/Ноты +.pdf']);
    assert.equal(exported.errors[0].item.path, root + '/first.pdf');
    assert.match(h.panel.getElementById('log').textContent, /403/);
    const cached = core.validateManifest(await core.cacheRequest(db, root));
    // The 403 checkpoint can precede another worker learning its file size.
    // This regression requires durable link removal, not identical timing of
    // response-derived metadata in the earlier checkpoint and later export.
    assert.deepEqual(cached.files.map(({ path, url }) => ({ path, url })),
      [{ path: root + '/Теория/Ноты +.pdf', url: fileURL(root + '/Теория/Ноты +.pdf') }]);
    await clock.advance(600000); assert.equal(clock.urls.length, 0);
    await h.click('retry');
    assert.equal(h.calls.filter(u => u === fileURL(root + '/first.pdf')).length, 1);
    h.dom.window.close();
    h = createHarness(responses, destination, directoryURL(root), { indexedDB: db });
    await until(() => !h.panel.getElementById('cache').disabled); await h.click('cache');
    await h.click('download');
    assert.equal(h.calls.length, 0, 'Denied file is absent; previously saved file is kept');
    assert.match(h.panel.getElementById('status').textContent, /Готово: 1\/1. Ошибок: 0/);
  } finally { h.dom.window.close(); }
});
test('integration: HTML with status 200 is not saved as a PDF', async () => {
  const responses = fixtures();
  responses.set(fileURL(root + '/first.pdf'), { body: '<html>Access denied</html>', headers: { 'content-type': 'text/html' } });
  const h = createHarness(responses);
  await h.click('scan'); await h.click('download');
  assert.match(h.panel.getElementById('log').textContent, /HTML/);
  assert.match(h.panel.getElementById('status').textContent, /Готово: 1\/2. Ошибок: 1/);
  assert.equal(h.destination.dirs.get(root).files.has('first.pdf'), false);
  h.dom.window.close();
});
test('integration: existing files without journal evidence are preserved', async () => {
  const destination = new MemoryDir();
  const out = await destination.getDirectoryHandle(root, { create: true });
  out.files.set('first.pdf', new MemoryFile('user-owned content'));
  const h = createHarness(fixtures(), destination);
  await h.click('scan'); await h.click('download');
  assert.equal(out.files.get('first.pdf').data.toString(), 'user-owned content');
  assert.match(h.panel.getElementById('status').textContent, /Ошибок: 1/);
  assert.equal(h.calls.includes(fileURL(root + '/first.pdf')), false);
  h.dom.window.close();
});
test('integration: truncated transfer aborts and does not mark a file complete', async () => {
  const responses = fixtures();
  responses.set(fileURL(root + '/first.pdf'), { body: '%PDF-1.7\nshort', headers: { 'content-length': '100' } });
  const h = createHarness(responses);
  await h.click('scan'); await h.click('download');
  const out = h.destination.dirs.get(root);
  assert.equal(out.files.get('first.pdf').data.length, 0);
  assert.equal(JSON.parse(out.files.get('.noty-download-state.json').data).completed[fileURL(root + '/first.pdf')], undefined);
  assert.match(h.panel.getElementById('status').textContent, /Ошибок: 1/);
  h.dom.window.close();
});
test('integration: a challenge response cannot be mistaken for an empty directory', async () => {
  const responses = new Map([[directoryURL(root), { body: challengePage }]]);
  const h = createHarness(responses);
  await h.click('scan');
  assert.match(h.panel.getElementById('status').textContent, /Cloudflare/);
  assert.equal(h.panel.getElementById('download').disabled, true);
  h.dom.window.close();
});
test('integration: pause completes the current file, then resumes the remaining queue', async () => {
  const responses = fixtures();
  let h;
  let requestedPause = false;
  for (const [url, original] of responses) {
    if (!url.includes('/Public/')) continue;
    responses.set(url, () => {
      if (!requestedPause) { h.panel.getElementById('pause').onclick(); requestedPause = true; }
      return typeof original === 'function' ? original() : new Response(original.body, { headers: original.headers });
    });
  }
  h = createHarness(responses);
  await h.click('scan'); await h.click('download');
  assert.equal(h.calls.filter(u => u.includes('/Public/')).length, 1);
  assert.match(h.panel.getElementById('status').textContent, /На паузе/);
  const journal = JSON.parse(h.destination.dirs.get(root).files.get('.noty-download-state.json').data);
  assert.equal(Object.keys(journal.completed).length, 1);
  await h.click('download');
  assert.match(h.panel.getElementById('status').textContent, /Готово: 2\/2/);
  h.dom.window.close();
});
test('integration: retry downloads only failed files after the server recovers', async () => {
  const responses = fixtures();
  responses.set(fileURL(root + '/first.pdf'), { body: 'missing', status: 404 });
  const h = createHarness(responses);
  await h.click('scan'); await h.click('download');
  assert.match(h.panel.getElementById('status').textContent, /Готово: 1\/2. Ошибок: 1/);
  responses.set(fileURL(root + '/first.pdf'), { body: '%PDF-1.7\nrecovered' });
  await h.click('retry');
  assert.match(h.panel.getElementById('status').textContent, /Готово: 2\/2. Ошибок: 0/);
  assert.equal(h.calls.filter(u => u === fileURL(root + '/Теория/Ноты +.pdf')).length, 1);
  h.dom.window.close();
});
test('integration: Root downloads all sections and direct files, then resumes from ?dir=', async () => {
  const responses = new Map([
    [directoryURL(''), { body: listing([directoryURL(''), directoryURL('_ABC'), directoryURL('_Сборники'),
      directoryURL('_ABC'), '?sort_by=name&dir=', fileURL('index.pdf'), 'https://example.com/']) }],
    [directoryURL('_ABC'), { body: listing([directoryURL(''), fileURL('_ABC/song.pdf')]) }],
    [directoryURL('_Сборники'), { body: listing([directoryURL(''), directoryURL('_Сборники/Хор')]) }],
    [directoryURL('_Сборники/Хор'), { body: listing([directoryURL('_Сборники'), fileURL('_Сборники/Хор/song.pdf')]) }],
    [fileURL('index.pdf'), { body: '%PDF-1.7\nindex' }],
    [fileURL('_ABC/song.pdf'), { body: '%PDF-1.7\nABC' }],
    [fileURL('_Сборники/Хор/song.pdf'), { body: '%PDF-1.7\nchoir' }]
  ]);
  const destination = new MemoryDir();
  let h = createHarness(responses, destination, origin + '/');
  assert.match(h.panel.getElementById('root').textContent, /Весь архив/);
  await h.click('scan'); await h.click('download');
  assert.match(h.panel.getElementById('status').textContent, /Готово: 3\/3. Ошибок: 0/);
  const out = destination.dirs.get('noty.propovednik.com');
  assert.equal(out.files.get('index.pdf').data.toString(), '%PDF-1.7\nindex');
  assert.equal(out.dirs.get('_ABC').files.get('song.pdf').data.toString(), '%PDF-1.7\nABC');
  assert.equal(out.dirs.get('_Сборники').dirs.get('Хор').files.get('song.pdf').data.toString(), '%PDF-1.7\nchoir');
  assert.equal(h.calls.filter(u => u === directoryURL('')).length, 1);
  assert.equal(h.calls.filter(u => u === directoryURL('_ABC')).length, 1);
  assert.equal(JSON.parse(out.files.get('.noty-download-state.json').data).root, '');
  h.dom.window.close();
  h = createHarness(responses, destination, directoryURL(''));
  await h.click('scan'); await h.click('download');
  assert.match(h.panel.getElementById('status').textContent, /Готово: 3\/3. Ошибок: 0/);
  assert.equal(h.calls.filter(u => u.includes('/Public/')).length, 0);
  h.dom.window.close();
});
test('integration: a non-textbook subfolder excludes parents and siblings', async () => {
  const selected = '_PV/Хор';
  const responses = new Map([
    [directoryURL(selected), { body: listing([directoryURL(''), directoryURL('_PV'),
      directoryURL('_PV/Хор-other'), fileURL('_PV/Хор-other/song.pdf'), fileURL(selected + '/song.pdf')]) }],
    [fileURL(selected + '/song.pdf'), { body: '%PDF-1.7\nchoir' }]
  ]);
  const h = createHarness(responses, new MemoryDir(), directoryURL(selected));
  await h.click('scan'); await h.click('download');
  assert.match(h.panel.getElementById('status').textContent, /Готово: 1\/1. Ошибок: 0/);
  assert.equal(h.destination.dirs.get('Хор').files.get('song.pdf').data.toString(), '%PDF-1.7\nchoir');
  assert.deepEqual(h.calls, [directoryURL(selected), fileURL(selected + '/song.pdf')]);
  h.dom.window.close();
});

test('settings clamp unsafe limits and preserve independent scan settings', () => {
  const s = core.normalizeSettings({ threads: 100, maxThreads: 0, scanThreads: 99, delayMs: -5,
    windowSeconds: '', gainPercent: 'bad', scanDelayMs: 500, auto: false });
  assert.equal(s.threads, 12); assert.equal(s.maxThreads, 1); assert.equal(s.scanThreads, 6);
  assert.equal(s.delayMs, 0); assert.equal(s.windowSeconds, 10); assert.equal(s.gainPercent, 8);
  assert.equal(s.scanDelayMs, 500); assert.equal(s.auto, false);
});

function tuneDriver(settings = {}) {
  const tuner = new core.AutoTuner({ windowSeconds: 5, ...settings });
  let now = 0;
  return { tuner,
    step(rate, eligible = true, elapsed = 1000) { now += elapsed; return tuner.observe(rate * elapsed / 1000, elapsed, eligible, now); },
    decision(rate) {
      for (let i = 0; i < 100; i++) { const result = this.step(rate); if (result) return result; }
      assert.fail('No tuner decision');
    }
  };
}
test('autotuner climbs with gains, rejects a slowdown and holds the best level', () => {
  const d = tuneDriver();
  assert.equal(d.decision(1000).to, 2);
  assert.equal(d.decision(1700).to, 3);
  assert.equal(d.decision(1400).to, 2);
  assert.equal(d.tuner.phase, 'hold');
  assert.equal(d.tuner.best.threads, 2);
  assert.equal(d.decision(1700).to, 2);
});
test('autotuner rejects a plateau, honors ceiling and re-probes after a stable hold', () => {
  const d = tuneDriver({ maxThreads: 2 });
  assert.equal(d.decision(1000).to, 2);
  assert.equal(d.decision(1070).to, 1);
  for (let i = 0; i < 7; i++) assert.equal(d.decision(1000).to, 1);
  assert.equal(d.decision(1000).to, 2);
  assert.equal(d.decision(1700).to, 2);
  assert.equal(d.tuner.phase, 'hold');
});
test('autotuner uses median windows and ignores underfilled or suspended sampling', () => {
  const d = tuneDriver();
  for (let i = 0; i < 100; i++) assert.equal(d.step(999999, false), null);
  assert.equal(d.tuner.limit, 1);
  assert.equal(d.step(999999, true, 6000), null);
  // Warm up, then contaminate exactly one of three five-second windows.
  for (let i = 0; i < 4; i++) d.step(1000);
  for (let i = 0; i < 5; i++) d.step(1000);
  for (let i = 0; i < 5; i++) d.step(1000000);
  let result;
  for (let i = 0; i < 5; i++) result = d.step(1000) || result;
  assert.equal(result.rate, 1000);
  assert.equal(result.to, 2);
});
test('autotuner tests a lower level after sustained degradation, and can reject it', () => {
  const d = tuneDriver({ maxThreads: 3 });
  d.decision(1000); d.decision(1800); d.decision(2400);
  assert.equal(d.decision(1200).to, 3);
  assert.equal(d.decision(1200).to, 2);
  assert.equal(d.decision(800).to, 3);
  assert.equal(d.tuner.phase, 'hold');
  d.tuner.penalize(999999);
  assert.equal(d.tuner.limit, 1); assert.equal(d.tuner.phase, 'baseline');
});
test('autotuner keeps a lower level if it restores aggregate throughput', () => {
  const d = tuneDriver({ maxThreads: 3 });
  d.decision(1000); d.decision(1800); d.decision(2400);
  d.decision(1200); d.decision(1200);
  assert.equal(d.decision(1600).to, 2);
  assert.equal(d.tuner.best.threads, 2);
});

test('pool changes limits live, drains excess workers and never loses or duplicates jobs', async () => {
  let limit = 3, active = 0, peak = 0;
  const releases = new Map(), started = [], completed = [];
  const queue = [1, 2, 3, 4, 5, 6];
  const work = core.runPool({ queue, limit: () => limit, paused: () => false,
    worker: id => new Promise(resolve => { active++; peak = Math.max(peak, active); started.push(id); releases.set(id, resolve); }),
    complete: id => { active--; completed.push(id); }, failed: e => { throw e; } });
  await until(() => started.length === 3);
  limit = 1; releases.get(1)(); releases.get(2)();
  await until(() => completed.length === 2); await turn();
  assert.deepEqual(started, [1, 2, 3]);
  releases.get(3)(); await until(() => started.length === 4);
  assert.equal(active, 1);
  limit = 2; releases.get(4)(); await until(() => started.length === 6);
  releases.get(5)(); releases.get(6)(); await work;
  assert.equal(peak, 3); assert.equal(queue.length, 0);
  assert.deepEqual([...completed].sort(), [1, 2, 3, 4, 5, 6]);
});
test('pool respects a global start delay even when all workers are idle', async () => {
  let now = 0; const starts = [];
  await core.runPool({ queue: [1, 2, 3], limit: () => 3, paused: () => false,
    delayMs: () => 250, now: () => now, wait: async ms => { now += ms; await turn(); },
    worker: async () => { starts.push(now); }, complete: () => {}, failed: e => { throw e; } });
  assert.equal(starts.length, 3);
  assert.ok(starts[1] - starts[0] >= 250); assert.ok(starts[2] - starts[1] >= 250);
});
test('pool stops scheduling on failure but drains in-flight work and retains pending jobs', async () => {
  let paused = false;
  const queue = [1, 2, 3, 4, 5], completed = [], started = [], releases = new Map();
  const run = core.runPool({ queue, limit: () => 3, paused: () => paused,
    worker: id => new Promise((resolve, reject) => { started.push(id); releases.set(id, id === 1 ? reject : resolve); }),
    complete: id => completed.push(id), failed: (e, id) => { paused = true; queue.unshift(id); } });
  await until(() => started.length === 3);
  releases.get(1)(new Error('HTTP 429')); await until(() => paused);
  releases.get(2)(); releases.get(3)(); await run;
  assert.deepEqual(started, [1, 2, 3]); assert.deepEqual(completed.sort(), [2, 3]);
  assert.deepEqual(queue, [1, 4, 5]);
});
test('serialized writes do not overlap and a failed write does not poison the next one', async () => {
  const write = core.serialWriter(); let active = 0, peak = 0;
  const events = [];
  const jobs = [1, 2, 3].map(id => write(async () => {
    active++; peak = Math.max(peak, active); await turn(); active--; events.push(id);
    if (id === 2) throw new Error('disk');
  }));
  const results = await Promise.allSettled(jobs);
  assert.equal(peak, 1); assert.deepEqual(events, [1, 2, 3]);
  assert.deepEqual(results.map(r => r.status), ['fulfilled', 'rejected', 'fulfilled']);
});
test('Retry-After parses seconds and dates with a minimum cooldown', () => {
  assert.equal(core.retryDelay('120'), 120000);
  assert.equal(core.retryDelay('0'), 30000);
  assert.equal(core.retryDelay('bad'), 30000);
  assert.equal(core.retryDelay('Wed, 23 Sep 2026 10:02:00 GMT', Date.parse('2026-09-23T10:00:00Z')), 120000);
});

const legacyList = (scope = root) => ({ root: scope, generatedAt: '2026-09-23T10:00:00Z',
  files: [{ type: 'file', path: scope + '/first.pdf', url: fileURL(scope + '/first.pdf') }] });
test('manifest importer accepts legacy exports and deduplicates URL aliases by path', () => {
  const data = legacyList();
  data.files.push({ ...data.files[0], url: data.files[0].url.replace('first', '%66irst') });
  const result = core.validateManifest(data);
  assert.equal(result.files.length, 1); assert.equal(result.legacy, true); assert.equal(result.scanned, true);
});
test('manifest importer rejects external URLs, mismatched paths, traversal and collisions', () => {
  const bad = ['https://example.com/book.pdf', fileURL('_OTHER/book.pdf'), fileURL(root + '/a%2fb.pdf')];
  for (const url of bad) {
    const data = legacyList(); data.files[0].url = url; assert.throws(() => core.validateManifest(data));
  }
  const data = legacyList(); data.files[0].path = root + '/else.pdf'; assert.throws(() => core.validateManifest(data));
  for (const scope of ['../escape', 'a/../b', '/a']) assert.throws(() => core.validateManifest(legacyList(scope)));
  const clash = legacyList();
  clash.files.push({ path: root + '/FIRST.pdf', url: fileURL(root + '/FIRST.pdf') });
  assert.throws(() => core.validateManifest(clash));
});
test('manifest importer validates resumable scan queues and unknown versions', () => {
  const data = { ...legacyList(), version: 2, visited: [root], pending: [root + '/A'], scanned: false };
  assert.deepEqual(core.validateManifest(data).pending, [root + '/A']);
  assert.throws(() => core.validateManifest({ ...data, pending: ['elsewhere'] }));
  assert.throws(() => core.validateManifest({ ...data, pending: [root + '/../escape'] }));
  assert.throws(() => core.validateManifest({ ...data, scanned: true }));
  assert.throws(() => core.validateManifest({ ...data, version: 3 }));
});
test('IndexedDB persists independently keyed lists across connections', async () => {
  const db = new IDBFactory();
  await core.cacheRequest(db, root, legacyList());
  await core.cacheRequest(db, '_ABC', legacyList('_ABC'));
  assert.deepEqual(await core.cacheRequest(db, root), legacyList());
  assert.deepEqual(await core.cacheRequest(db, '_ABC'), legacyList('_ABC'));
  assert.equal(await core.cacheRequest(db, '_PV'), undefined);
  await assert.rejects(core.cacheRequest(undefined, root), /недоступен/);
});

test('integration: importing an old JSON downloads without fetching any directory pages', async () => {
  const h = createHarness(fixtures(), new MemoryDir(), origin + '/');
  await importJSON(h, legacyList());
  assert.match(h.panel.getElementById('status').textContent, /Старый формат/);
  assert.equal(h.panel.getElementById('root').textContent, root);
  await h.click('download');
  assert.deepEqual(h.calls, [fileURL(root + '/first.pdf')]);
  assert.equal(h.destination.dirs.get(root).files.get('first.pdf').data.toString(), '%PDF-1.7\nfirst');
  h.dom.window.close();
});
test('integration: invalid import leaves the previous valid list intact', async () => {
  const h = createHarness(fixtures());
  await h.click('scan');
  const invalid = legacyList(); invalid.files[0].url = 'https://example.com/stolen.pdf';
  await importJSON(h, invalid);
  assert.match(h.panel.getElementById('status').textContent, /Не удалось/);
  await h.click('download');
  assert.match(h.panel.getElementById('status').textContent, /Готово: 2\/2/);
  h.dom.window.close();
});
test('integration: a finished cache reloads without rescanning and can be refreshed explicitly', async () => {
  const db = new IDBFactory();
  let h = createHarness(fixtures(), new MemoryDir(), directoryURL(root), { indexedDB: db });
  await h.click('scan'); h.dom.window.close();
  h = createHarness(fixtures(), new MemoryDir(), directoryURL(root), { indexedDB: db });
  await until(() => !h.panel.getElementById('cache').disabled);
  await h.click('cache');
  assert.match(h.panel.getElementById('status').textContent, /Кеш загружен: 2 файлов/);
  assert.equal(h.calls.length, 0);
  await h.click('rescan');
  assert.equal(h.calls.filter(u => !u.includes('/Public/')).length, 2);
  await h.click('download');
  assert.match(h.panel.getElementById('status').textContent, /Готово: 2\/2/);
  h.dom.window.close();
});
test('integration: unavailable cache does not prevent scan or download', async () => {
  const h = createHarness(fixtures(), new MemoryDir(), directoryURL(root), { indexedDB: null });
  await h.click('scan');
  assert.match(h.panel.getElementById('cacheInfo').textContent, /недоступен/);
  await h.click('download');
  assert.match(h.panel.getElementById('status').textContent, /Готово: 2\/2/);
  h.dom.window.close();
});
test('integration: folder pool visits dynamically discovered folders once and in parallel', async () => {
  const responses = new Map(), releases = new Map();
  const paths = ['A', 'B', 'C', 'D'].map(p => root + '/' + p);
  responses.set(directoryURL(root), { body: listing(paths.map(directoryURL)) });
  for (const path of paths) responses.set(directoryURL(path), () => new Promise(resolve => releases.set(path, () =>
    resolve(new Response(listing([directoryURL(root + '/A/Nested'), fileURL(path + '/song.pdf')]))))));
  responses.set(directoryURL(root + '/A/Nested'), { body: listing([fileURL(root + '/A/Nested/song.pdf')]) });
  const h = createHarness(responses);
  const run = h.click('scan');
  await until(() => releases.size === 3);
  assert.equal(h.calls.length, 4);
  releases.get(paths[0])(); await until(() => releases.has(paths[3]));
  releases.get(paths[1])(); releases.get(paths[2])(); releases.get(paths[3])();
  await run;
  assert.match(h.panel.getElementById('status').textContent, /5 файлов в 6 папках/);
  assert.equal(h.calls.filter(u => u === directoryURL(root + '/A/Nested')).length, 1);
  h.dom.window.close();
});
test('integration: interrupted folder pool caches pending work and resumes after reload', async () => {
  const db = new IDBFactory(), responses = new Map(), releases = new Map();
  const paths = ['A', 'B', 'C', 'D'].map(p => root + '/' + p);
  responses.set(directoryURL(root), { body: listing(paths.map(directoryURL)) });
  for (const path of paths) responses.set(directoryURL(path), () => new Promise(resolve => releases.set(path, () =>
    resolve(new Response(listing([fileURL(path + '/song.pdf')]))))));
  let h = createHarness(responses, new MemoryDir(), directoryURL(root), { indexedDB: db });
  const run = h.click('scan'); await until(() => releases.size === 3);
  await h.click('pause'); for (const release of releases.values()) release(); await run;
  const saved = await core.cacheRequest(db, root);
  assert.equal(saved.scanned, false); assert.deepEqual(saved.pending, [paths[3]]); assert.equal(saved.visited.length, 4);
  h.dom.window.close();
  responses.set(directoryURL(paths[3]), { body: listing([fileURL(paths[3] + '/song.pdf')]) });
  h = createHarness(responses, new MemoryDir(), directoryURL(root), { indexedDB: db });
  await until(() => !h.panel.getElementById('cache').disabled); await h.click('cache'); await h.click('scan');
  assert.deepEqual(h.calls, [directoryURL(paths[3])]);
  assert.match(h.panel.getElementById('status').textContent, /4 файлов в 5 папках/);
  h.dom.window.close();
});
test('integration: parallel downloads serialize journal commits and preserve all completion records', async () => {
  const destination = new MemoryDir(), out = await destination.getDirectoryHandle(root, { create: true });
  const journal = new MemoryFile(JSON.stringify({ version: 1, root, completed: {} }));
  let writers = 0, peak = 0, requests = 0;
  const original = journal.createWritable.bind(journal);
  journal.createWritable = async () => {
    writers++; peak = Math.max(peak, writers); const stream = await original();
    const close = stream.close; stream.close = async () => { await turn(); await close(); writers--; };
    return stream;
  };
  out.files.set('.noty-download-state.json', journal);
  const releases = [], responses = new Map();
  const paths = Array.from({ length: 6 }, (_, i) => root + '/' + i + '.pdf');
  responses.set(directoryURL(root), { body: listing(paths.map(fileURL)) });
  for (const path of paths) responses.set(fileURL(path), () => new Promise(resolve => {
    requests++; releases.push(() => resolve(new Response('%PDF-1.7\n' + path)));
  }));
  const h = createHarness(responses, destination, directoryURL(root), { settings: { auto: false, threads: 3 } });
  await h.click('scan'); const run = h.click('download');
  await until(() => requests === 3); releases.splice(0).forEach(release => release());
  await until(() => requests === 6); releases.splice(0).forEach(release => release()); await run;
  assert.equal(peak, 1); assert.equal(Object.keys(JSON.parse(journal.data).completed).length, 6);
  assert.match(h.panel.getElementById('status').textContent, /Готово: 6\/6. Ошибок: 0/);
  h.dom.window.close();
});
test('integration: rate limiting preserves manual concurrency and blocks immediate retry', async () => {
  const responses = fixtures();
  responses.set(fileURL(root + '/first.pdf'), { body: 'slow down', status: 429, headers: { 'retry-after': '60' } });
  const h = createHarness(responses, new MemoryDir(), directoryURL(root), { settings: { auto: false, threads: 4 } });
  await h.click('scan'); await h.click('download');
  assert.equal(h.panel.getElementById('threads').value, '4');
  assert.equal(h.panel.getElementById('download').disabled, true);
  const count = h.calls.length; await h.click('download'); assert.equal(h.calls.length, count);
  assert.match(h.panel.getElementById('status').textContent, /HTTP 429/);
  h.dom.window.close();
});

for (const [threads, failure] of [[3, 'challenge'], [4, 'network'], [4, '429']]) {
  test(`manual ${threads} workers survive ${failure} recovery and return after one successful transfer`, async () => {
    const clock = recoveryClock(), releases = [], paths = Array.from({ length: 9 }, (_, i) => root + `/manual-${i}.pdf`);
    let blocked = true;
    const responses = new Map(paths.map(path => [fileURL(path), () => {
      if (blocked) {
        if (failure === 'network') throw new TypeError('Failed to fetch');
        return new Response('blocked', { status: failure === '429' ? 429 : 403,
          headers: failure === 'challenge' ? { 'cf-mitigated': 'challenge' } : {} });
      }
      return new Promise(resolve => releases.push(() => resolve(new Response('%PDF-1.7\nok'))));
    }]));
    const h = createHarness(responses, new MemoryDir(), directoryURL(root),
      { recoveryClock: clock, settings: { auto: false, threads } });
    try {
      await importJSON(h, { root, files: paths.map(path => entry(path)) }); await h.click('download');
      assert.equal(h.panel.getElementById('threads').value, String(threads));
      assert.equal(JSON.parse(h.dom.window.localStorage.getItem('noty-folder-settings-v1')).threads, threads);
      blocked = false; await clock.advance(30000); clock.ready(h);
      await until(() => releases.length === 1);
      assert.match(h.panel.getElementById('metricActive').textContent, /\/ 1$/);
      await turn(); assert.equal(releases.length, 1, 'Only one probe may start before a successful transfer');
      releases.shift()();
      await until(() => releases.length === threads);
      assert.equal(h.panel.getElementById('metricActive').textContent, `${threads} / ${threads}`);
      assert.equal(h.panel.getElementById('threads').value, String(threads));
      for (let i = 0; i < 100; i++) {
        releases.splice(0).forEach(release => release()); await turn();
        if (/Готово: 9\/9/.test(h.panel.getElementById('status').textContent)) break;
      }
      await until(() => /Готово: 9\/9. Ошибок: 0./.test(h.panel.getElementById('status').textContent));
      assert.equal(JSON.parse(h.dom.window.localStorage.getItem('noty-folder-settings-v1')).threads, threads);
    } finally { releases.splice(0).forEach(release => release()); h.dom.window.close(); }
  });
}
test('integration: scan rate limiting lowers its own cap and checkpoints the failed folder', async () => {
  const responses = new Map([[directoryURL(root), { body: 'slow down', status: 429 }]]);
  const h = createHarness(responses, new MemoryDir(), directoryURL(root), { settings: { scanThreads: 6 } });
  await h.click('scan');
  assert.equal(h.panel.getElementById('scanThreads').value, '3');
  assert.equal(h.panel.getElementById('scan').disabled, true);
  const data = await core.cacheRequest(h.dom.window.indexedDB, root);
  assert.deepEqual(data.pending, [root]); assert.equal(data.scanned, false);
  assert.equal(data.files.length, 0);
  h.dom.window.close();
});
test('integration: changing settings updates the live UI and persists valid limits', async () => {
  const h = createHarness(fixtures());
  setSettings(h, { auto: 'manual', threads: '99', scanThreads: '5' });
  assert.equal(h.panel.getElementById('threads').value, '12');
  assert.equal(h.panel.getElementById('threads').disabled, false);
  assert.equal(h.panel.getElementById('maxThreads').disabled, true);
  assert.equal(JSON.parse(h.dom.window.localStorage.getItem('noty-folder-settings-v1')).scanThreads, 5);
  await h.click('scan'); h.dom.window.close();
});

test('integration: a mid-scan checkpoint includes active folders, and new JSON resumes them', async () => {
  const db = new IDBFactory(), checkpoint = {}, responses = new Map(), releases = [];
  const paths = ['A', 'B', 'C', 'D'].map(p => root + '/' + p);
  responses.set(directoryURL(root), { body: listing([...paths.map(directoryURL), fileURL(root + '/first.pdf')]) });
  for (const path of paths) responses.set(directoryURL(path), () => new Promise(resolve => releases.push(() =>
    resolve(new Response(listing([fileURL(path + '/song.pdf')]))))));
  const h = createHarness(responses, new MemoryDir(), directoryURL(root), { indexedDB: db, checkpoint });
  const run = h.click('scan'); await until(() => releases.length === 3);
  checkpoint.run();
  let saved;
  for (let i = 0; i < 100; i++) {
    saved = await core.cacheRequest(db, root); if (saved) break; await turn();
  }
  assert.deepEqual(saved.pending.sort(), paths); assert.deepEqual(saved.visited, [root]);
  await h.click('pause'); releases.forEach(release => release()); await run;
  let exported;
  h.dom.window.Blob = Blob;
  h.dom.window.URL.createObjectURL = blob => { exported = blob; return 'blob:test'; };
  h.dom.window.URL.revokeObjectURL = () => {};
  h.dom.window.HTMLAnchorElement.prototype.click = () => {};
  await h.click('export');
  const data = JSON.parse(await exported.text());
  assert.equal(data.version, 2); assert.equal(data.scanned, false); assert.deepEqual(data.pending, [paths[3]]);
  h.dom.window.close();
  responses.set(directoryURL(paths[3]), { body: listing([fileURL(paths[3] + '/song.pdf')]) });
  const restored = createHarness(responses);
  await importJSON(restored, data); await restored.click('scan');
  assert.deepEqual(restored.calls, [directoryURL(paths[3])]);
  assert.match(restored.panel.getElementById('status').textContent, /5 файлов в 5 папках/);
  restored.dom.window.close();
});
test('integration: importing and recaching an old list preserves its original date', async () => {
  const h = createHarness(fixtures());
  const data = legacyList(); await importJSON(h, data);
  const saved = await core.cacheRequest(h.dom.window.indexedDB, root);
  assert.equal(saved.generatedAt, data.generatedAt);
  assert.equal(saved.legacy, true);
  h.dom.window.close();
});
test('integration: pausing during the final file still reports completion', async () => {
  const responses = fixtures(); let h;
  responses.set(fileURL(root + '/first.pdf'), () => {
    h.panel.getElementById('pause').onclick(); return new Response('%PDF-1.7\nlast');
  });
  h = createHarness(responses); await importJSON(h, legacyList()); await h.click('download');
  assert.match(h.panel.getElementById('status').textContent, /Готово: 1\/1/);
  h.dom.window.close();
});

test('size parser handles byte grouping, decimal units and unknown sizes', () => {
  const cases = [['1234', 1234], ['1,234 bytes', 1234], ['1 234 байта', 1234], ['1\u00a0234 Б', 1234],
    ['1.5 MB', 1572864], ['1,5 МиБ', 1572864], ['1,5 МБ', 1572864], ['2 KiB', 2048],
    ['15.2K', 15565], ['0 B', 0], ['2 ГБ', 2147483648], ['1 TB', 1099511627776]];
  for (const [text, expected] of cases) assert.equal(core.parseSizeBytes(text), expected, text);
  for (const text of ['', '-', 'Unknown', '12 34 B', '-3 KB', 'Infinity', '1e6', '1.2.3 KB', '99999999999 TB']) {
    assert.equal(core.parseSizeBytes(text), null, text);
  }
});
test('listing sizes follow the Size column including colspans and exact tooltips', () => {
  const dom = new JSDOM('<table><tr><th colspan="2">File name</th><th>Size</th><th>Date</th></tr>' +
    '<tr><td>icon</td><td><a href="book.pdf">Book</a></td><td><span title="1,234 bytes">1.2 KB</span></td><td>23.09.26</td></tr></table>');
  assert.deepEqual(core.listingSize(dom.window.document.querySelector('a')), { sizeBytes: 1234, sizeText: '1.2 KB' });
  dom.window.close();
  const missing = new JSDOM('<table><tr><th>File name</th><th>Date</th></tr><tr><td><a href="x">File</a></td><td>2026</td></tr></table>');
  assert.deepEqual(core.listingSize(missing.window.document.querySelector('a')), { sizeBytes: null });
  missing.window.close();
});
test('volume totals distinguish saved files, partial transfers, unknown sizes and retry resets', () => {
  const files = [{ path: 'a', sizeBytes: 100 }, { path: 'b', sizeBytes: 200 }, { path: 'c', sizeBytes: null }];
  assert.deepEqual(core.transferTotals(files, new Set(['a']), new Map([['b', 50]])),
    { total: 300, processed: 150, remaining: 150, unknown: 1, pending: 2 });
  assert.equal(core.transferTotals(files, new Set(['a']), new Map([['b', 500]])).remaining, 0);
  assert.equal(core.transferTotals(files, new Set(['a']), new Map()).remaining, 200);
  files[2].sizeBytes = 300;
  const totals = core.transferTotals(files, new Set(['a', 'b', 'c']));
  assert.equal(totals.processed, 600); assert.equal(totals.remaining, 0); assert.equal(totals.pending, 0);
});
test('ETA speed smooths spikes, requires warmup, expires old samples and detects stalls', () => {
  const meter = new core.SpeedMeter();
  assert.equal(meter.observe(1000, 1000), 0); assert.equal(meter.observe(1000, 1000), 0);
  assert.equal(meter.observe(1000, 1000), 1000);
  assert.equal(meter.observe(9000, 1000), 3000);
  for (let i = 0; i < 30; i++) meter.observe(2000, 1000);
  assert.equal(meter.observe(2000, 1000), 2000);
  for (let i = 0; i < 9; i++) assert.ok(meter.observe(0, 1000) > 0);
  assert.equal(meter.observe(0, 1000), 0);
  assert.equal(meter.observe(50000, 10000), 0);
  assert.equal(meter.observe(2000, 1000), 0);
  assert.equal(core.formatDuration(5), '1 мин');
  assert.equal(core.formatDuration(3900), '1 ч 5 мин');
  assert.equal(core.formatDuration(90000), '1 д 1 ч');
  assert.equal(core.formatBytes(1048576), '1 МиБ');
});

test('queue ETA uses file throughput only for a measured, similarly sized small-file queue', () => {
  const files = Array.from({ length: 20 }, (_, i) => ({ path: String(i), sizeBytes: 1024 }));
  const estimate = (list, sizes = Array(5).fill(1024), rate = 2) => core.queueEstimate(list, new Set(), new Map(), 1024, rate, sizes);
  assert.deepEqual(estimate(files), { seconds: 10, method: 'files' });
  assert.deepEqual(estimate(files, [1024]), { seconds: 20, method: 'bytes' });
  assert.deepEqual(estimate(files, Array(5).fill(1024), 0), { seconds: 20, method: 'bytes' });
  assert.equal(estimate([...files, { path: 'big', sizeBytes: 10485760 }]).method, 'bytes');
  assert.equal(estimate(files, Array(5).fill(65536)).method, 'bytes');
  assert.equal(estimate([{ path: 'unknown', sizeBytes: null }]), null);
  assert.equal(core.queueEstimate(files, new Set(), new Map(), 0, 0, []), null);
  // Failed/excluded items are removed by the caller; completed and partially
  // received bytes must not be extrapolated a second time.
  assert.deepEqual(core.queueEstimate(files, new Set(['0']), new Map([['1', 512]]), 1024, 0, []), { seconds: 18.5, method: 'bytes' });
  assert.equal(core.formatRate(10485.76), '10,24 КиБ/с');
});

test('regression: active counters agree between speed and status before the next rate sample', async () => {
  const clock = { now: 0 }, controllers = [];
  const paths = ['a.pdf', 'b.pdf'].map(p => root + '/' + p);
  const responses = new Map(paths.map((p, i) => [fileURL(p), () => new Response(new ReadableStream({ start(c) { controllers[i] = c; } }),
    { headers: { 'content-length': '10000' } })]));
  const h = createHarness(responses, new MemoryDir(), directoryURL(root), { clock, settings: { auto: false, threads: 2, delayMs: 0 } });
  let run;
  try {
    await importJSON(h, { root, files: paths.map(p => entry(p, 10000)) });
    run = h.click('download'); await until(() => controllers.filter(Boolean).length === 2);
    for (const c of controllers) { const bytes = new Uint8Array(8192); bytes.set(new TextEncoder().encode('%PDF-1.7\n')); c.enqueue(bytes); }
    clock.now = 1000; await new Promise(resolve => setTimeout(resolve, 15));
    controllers[0].enqueue(new Uint8Array(1808)); controllers[0].close();
    await until(() => /В работе: 1;/.test(h.panel.getElementById('status').textContent));
    assert.match(h.panel.getElementById('speed').textContent, /Активно: 1/);
    assert.match(h.panel.getElementById('speed').textContent, /Средняя.*30 с/);
    controllers[1].enqueue(new Uint8Array(1808)); controllers[1].close(); await run;
  } finally {
    for (const c of controllers) { try { c.error(new Error('cleanup')); } catch { /* Closed. */ } }
    if (run) await run; h.dom.window.close();
  }
});

test('integration: completed small files supply a file-based ETA for similar queued files', async () => {
  const clock = { now: 0 }; let controller;
  const paths = Array.from({ length: 10 }, (_, i) => root + '/' + i + '.pdf');
  const bytes = new Uint8Array(1024); bytes.set(new TextEncoder().encode('%PDF-1.7\n'));
  const responses = new Map(paths.map((p, i) => [fileURL(p), () => {
    if (i < 5) { clock.now += 1000; return new Response(bytes, { headers: { 'content-length': '1024' } }); }
    return new Response(new ReadableStream({ start(c) { controller = c; } }), { headers: { 'content-length': '1024' } });
  }]));
  const h = createHarness(responses, new MemoryDir(), directoryURL(root), { clock, settings: { auto: false, threads: 1, delayMs: 0 } });
  let run;
  try {
    await importJSON(h, { root, files: paths.map(p => entry(p, 1024)) });
    run = h.click('download'); await until(() => controller);
    await until(() => /по темпу сохранения файлов/.test(h.panel.getElementById('eta').textContent));
    assert.match(h.panel.getElementById('speed').textContent, /КиБ\/с/);
    assert.doesNotMatch(h.panel.getElementById('speed').textContent, /Сохранение: —/);
    const curves = h.panel.getElementById('rateChart').querySelectorAll('polyline');
    assert.equal(curves.length, 2);
    assert.notEqual(curves[0].getAttribute('stroke'), curves[1].getAttribute('stroke'));
    assert.equal(curves[1].getAttribute('stroke-dasharray'), '5 3');
    const ys = [...curves].map(line => line.getAttribute('points').split(' ').map(p => Number(p.split(',')[1])));
    assert.equal(ys[0].length, ys[1].length, 'Both series share the sample timeline');
    assert.ok(ys.flat().every(y => Number.isFinite(y) && y >= 4 && y <= 66));
    assert.ok(Math.min(...ys[1]) < 20, 'File throughput needs its own scale instead of the byte-rate scale');
    assert.match(h.panel.getElementById('fileScale').textContent, /файлов\/с/);
    await h.click('pause'); controller.enqueue(bytes); controller.close(); await run;
    assert.equal(h.calls.length, 6);
    assert.match(h.panel.getElementById('eta').textContent, /пауза/);
  } finally { try { controller?.error(new Error('cleanup')); } catch { /* Closed. */ } if (run) await run; h.dom.window.close(); }
});
test('manifest sizes survive validation and invalid metadata becomes unknown', () => {
  for (const size of [0, 1234, 9876543210]) {
    const data = legacyList(); data.files[0].sizeBytes = size;
    assert.equal(core.validateManifest(data).files[0].sizeBytes, size);
  }
  for (const size of [-1, '1234', null, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const data = legacyList(); data.files[0].sizeBytes = size;
    assert.equal(core.validateManifest(data).files[0].sizeBytes, null);
  }
});
function sizedListing(rows) {
  return '<table><tr><th>File name</th><th>Size</th></tr>' + rows.map(([url, size]) =>
    `<tr><td><a href="${url}">File</a></td><td>${size}</td></tr>`).join('') + '</table>';
}
test('integration: scan records sizes in the cache and exported/imported JSON', async () => {
  const responses = new Map([[directoryURL(root), { body: sizedListing([
    [fileURL(root + '/a.pdf'), '1.5 MB'], [fileURL(root + '/b.pdf'), '2 KB']]) }]]);
  const h = createHarness(responses); await h.click('scan');
  const saved = await core.cacheRequest(h.dom.window.indexedDB, root);
  assert.deepEqual(saved.files.map(f => f.sizeBytes), [1572864, 2048]);
  assert.match(h.panel.getElementById('volume').textContent, /1,5 МиБ/);
  let exported;
  h.dom.window.Blob = Blob; h.dom.window.URL.createObjectURL = blob => { exported = blob; return 'blob:test'; };
  h.dom.window.URL.revokeObjectURL = () => {}; h.dom.window.HTMLAnchorElement.prototype.click = () => {};
  await h.click('export');
  const data = JSON.parse(await exported.text()); h.dom.window.close();
  const restored = createHarness(responses); await importJSON(restored, data);
  assert.match(restored.panel.getElementById('volume').textContent, /1,5 МиБ/);
  assert.equal(restored.calls.length, 0); restored.dom.window.close();
});
test('integration: old lists show unknown volume until a response or saved file supplies it', async () => {
  const h = createHarness(fixtures()); await importJSON(h, legacyList());
  assert.match(h.panel.getElementById('volume').textContent, /неизвестный размер у 1/);
  assert.match(h.panel.getElementById('eta').textContent, /нужны размеры/);
  await h.click('download');
  assert.match(h.panel.getElementById('volume').textContent, /14 Б \/ 14 Б/);
  assert.match(h.panel.getElementById('eta').textContent, /завершено/);
  const destination = h.destination; h.dom.window.close();
  const resumed = createHarness(fixtures(), destination); await importJSON(resumed, legacyList()); await resumed.click('download');
  assert.equal(resumed.calls.length, 0);
  assert.match(resumed.panel.getElementById('volume').textContent, /14 Б \/ 14 Б/); resumed.dom.window.close();
});
test('integration: ETA updates from streamed bytes and resets partial volume after a failed transfer', async () => {
  const clock = { now: 0 }; let controller;
  const responses = new Map([[fileURL(root + '/first.pdf'), () => new Response(new ReadableStream({ start(c) { controller = c; } }),
    { headers: { 'content-length': '10000', 'content-type': 'application/pdf' } })]]);
  const h = createHarness(responses, new MemoryDir(), directoryURL(root), { clock });
  const data = legacyList(); data.files[0].sizeBytes = 9000; await importJSON(h, data);
  const run = h.click('download'); await until(() => controller);
  for (let i = 1; i <= 4; i++) {
    const bytes = new Uint8Array(1024); if (i === 1) bytes.set(new TextEncoder().encode('%PDF-1.7\n'));
    controller.enqueue(bytes); clock.now = i * 1000;
    await new Promise(resolve => setTimeout(resolve, 8));
  }
  assert.match(h.panel.getElementById('eta').textContent, /≈ 1 мин/);
  assert.match(h.panel.getElementById('volume').textContent, /4 КиБ \/ 9,77 КиБ/);
  controller.error(new Error('connection lost')); await run;
  assert.match(h.panel.getElementById('volume').textContent, /0 Б \/ 9,77 КиБ/);
  assert.match(h.panel.getElementById('eta').textContent, /пауза/);
  assert.match(h.panel.getElementById('status').textContent, /Сетевой запрос не завершён/);
  h.dom.window.close();
});

for (const failedSize of [10 * 1024 * 1024, null]) {
  test(`regression: ETA continues for the working queue after an error of size ${failedSize}`, async () => {
    const clock = { now: 0 }; let controller;
    const bad = root + '/a.pdf', good = root + '/b.pdf';
    const responses = new Map([[fileURL(bad), { body: '<html>Invalid PDF</html>', headers: { 'content-type': 'text/html' } }],
      [fileURL(good), () => new Response(new ReadableStream({ start(c) { controller = c; } }),
        { headers: { 'content-length': '10000', 'content-type': 'application/pdf' } })]]);
    const h = createHarness(responses, new MemoryDir(), directoryURL(root), { clock, settings: { auto: false, threads: 1 } });
    let run;
    try {
      await importJSON(h, { root, files: [entry(bad, failedSize), entry(good, 10000)] });
      run = h.click('download'); await until(() => controller);
      for (let i = 1; i <= 4; i++) {
        const bytes = new Uint8Array(1024); if (i === 1) bytes.set(new TextEncoder().encode('%PDF-1.7\n'));
        controller.enqueue(bytes); clock.now = i * 1000;
        await new Promise(resolve => setTimeout(resolve, 8));
      }
      assert.match(h.panel.getElementById('eta').textContent, /До конца очереди: ≈ 1 мин/);
      assert.match(h.panel.getElementById('eta').textContent, /ошибки: 1.*не включены/);
      if (failedSize) assert.match(h.panel.getElementById('volume').textContent, /МиБ/);
      await h.click('pause'); assert.match(h.panel.getElementById('eta').textContent, /пауза/);
      controller.enqueue(new Uint8Array(5904)); controller.close(); await run;
      // Resuming an already drained queue must not call the archive complete.
      await h.click('download');
      assert.match(h.panel.getElementById('eta').textContent, /очередь обработана.*ошибки: 1/);
      assert.doesNotMatch(h.panel.getElementById('eta').textContent, /завершено/);
      // Failed items rejoin the estimate when explicitly retried.
      controller = null;
      responses.set(fileURL(bad), () => new Response(new ReadableStream({ start(c) { controller = c; } }),
        { headers: { 'content-length': '10000', 'content-type': 'application/pdf' } }));
      run = h.click('retry'); await until(() => controller);
      for (let i = 1; i <= 4; i++) {
        const bytes = new Uint8Array(1024); if (i === 1) bytes.set(new TextEncoder().encode('%PDF-1.7\n'));
        controller.enqueue(bytes); clock.now = 4000 + i * 1000;
        await new Promise(resolve => setTimeout(resolve, 8));
      }
      assert.match(h.panel.getElementById('eta').textContent, /^До конца: ≈ 1 мин \(по средней скорости/);
      controller.enqueue(new Uint8Array(5904)); controller.close(); await run;
      assert.match(h.panel.getElementById('eta').textContent, /завершено/);
    } finally {
      try { controller?.error(new Error('test cleanup')); } catch { /* Already closed. */ }
      if (run) await run;
      h.dom.window.close();
    }
  });
}

test('retry backoff grows with bounded jitter and settings have safe defaults', () => {
  assert.equal(core.normalizeSettings().maxRetries, 3);
  assert.equal(core.normalizeSettings().retryBaseSeconds, 2);
  assert.equal(core.normalizeSettings({ maxRetries: -1 }).maxRetries, 0);
  assert.equal(core.normalizeSettings({ maxRetries: 99, retryBaseSeconds: 0 }).maxRetries, 8);
  assert.equal(core.normalizeSettings({ retryBaseSeconds: 0 }).retryBaseSeconds, 1);
  assert.deepEqual([1, 2, 3].map(n => core.backoffMs(n, 2, () => 0.5)), [2000, 4000, 8000]);
  assert.equal(core.backoffMs(1, 2, () => 0), 1600);
  assert.equal(core.backoffMs(1, 2, () => 1), 2400);
  assert.equal(core.backoffMs(8, 60, () => 1), 60000);
});
function retryHarness(overrides = {}) {
  let now = 0;
  const config = { maxRetries: 3, retryBaseSeconds: 2 };
  const delays = [];
  return { config, delays, options: { settings: () => config, paused: () => false,
    now: () => now, random: () => 0.5, wait: async ms => { now += ms; },
    onRetry: (e, attempt, delay) => delays.push(delay), ...overrides } };
}
test('transient retries recover with one final result and a bounded attempt count', async () => {
  const h = retryHarness(); let attempts = 0;
  const result = await core.withRetries(async () => {
    if (++attempts < 3) throw Object.assign(new Error('network'), { retryable: true });
    return 'saved';
  }, h.options);
  assert.equal(result, 'saved'); assert.equal(attempts, 3); assert.deepEqual(h.delays, [2000, 4000]);
  attempts = 0; h.config.maxRetries = 2;
  await assert.rejects(core.withRetries(async () => {
    attempts++; throw Object.assign(new Error('network'), { retryable: true });
  }, h.options), /network/);
  assert.equal(attempts, 3);
});
test('permanent, fatal and disabled retry cases fail without a second attempt', async () => {
  for (const error of [new Error('404'), Object.assign(new Error('403'), { stop: true, retryable: true })]) {
    let count = 0; const h = retryHarness();
    await assert.rejects(core.withRetries(async () => { count++; throw error; }, h.options));
    assert.equal(count, 1); assert.equal(h.delays.length, 0);
  }
  const h = retryHarness(); h.config.maxRetries = 0;
  await assert.rejects(core.withRetries(async () => { throw Object.assign(new Error('network'), { retryable: true }); }, h.options));
  assert.equal(h.delays.length, 0);
});
test('pause interrupts retry waiting and lowering the retry setting cancels another attempt', async () => {
  let paused = false, finished = 0, attempts = 0;
  const h = retryHarness({ paused: () => paused, onRetry: () => { paused = true; }, onWaitEnd: () => finished++ });
  await assert.rejects(core.withRetries(async () => {
    attempts++; throw Object.assign(new Error('network'), { retryable: true });
  }, h.options), e => e.pausedRetry === true);
  assert.equal(attempts, 1); assert.equal(finished, 1);
  const next = retryHarness(); attempts = 0;
  next.options.onRetry = () => { next.config.maxRetries = 0; };
  await assert.rejects(core.withRetries(async () => {
    attempts++; throw Object.assign(new Error('network'), { retryable: true });
  }, next.options), /network/);
  assert.equal(attempts, 1);
});
test('integration: temporary HTTP failure retries one file and records completion once', async () => {
  const responses = fixtures(); let attempts = 0;
  responses.set(fileURL(root + '/first.pdf'), () => ++attempts === 1 ? new Response('temporary', { status: 502 }) : new Response('%PDF-1.7\nrecovered'));
  const h = createHarness(responses, new MemoryDir(), directoryURL(root), { settings: { maxRetries: 1, retryBaseSeconds: 1 } });
  await importJSON(h, legacyList()); await h.click('download');
  assert.equal(attempts, 2); assert.match(h.panel.getElementById('status').textContent, /Готово: 1\/1. Ошибок: 0/);
  assert.match(h.panel.getElementById('log').textContent, /Автоповтор 1\/1/);
  const journal = JSON.parse(h.destination.dirs.get(root).files.get('.noty-download-state.json').data);
  assert.equal(Object.keys(journal.completed).length, 1); h.dom.window.close();
});
test('integration: a read failure is retried after aborting the partial write', async () => {
  const responses = fixtures(); let attempts = 0;
  responses.set(fileURL(root + '/first.pdf'), () => {
    if (++attempts > 1) return new Response('%PDF-1.7\nrecovered');
    let reads = 0;
    return new Response(new ReadableStream({ pull(c) {
      if (reads++ === 0) { const bytes = new Uint8Array(2048); bytes.set(new TextEncoder().encode('%PDF-1.7\n')); c.enqueue(bytes); }
      else c.error(new TypeError('connection lost'));
    } }));
  });
  const h = createHarness(responses, new MemoryDir(), directoryURL(root), { settings: { maxRetries: 1, retryBaseSeconds: 1 } });
  await importJSON(h, legacyList()); await h.click('download');
  assert.equal(attempts, 2);
  assert.equal(h.destination.dirs.get(root).files.get('first.pdf').data.toString(), '%PDF-1.7\nrecovered');
  assert.match(h.panel.getElementById('status').textContent, /Ошибок: 0/); h.dom.window.close();
});
test('integration: folder requests recover after transient network errors', async () => {
  let attempts = 0;
  const responses = new Map([[directoryURL(root), () => {
    if (++attempts === 1) throw new TypeError('Failed to fetch');
    return new Response(listing([fileURL(root + '/first.pdf')]));
  }]]);
  const h = createHarness(responses, new MemoryDir(), directoryURL(root), { settings: { maxRetries: 1, retryBaseSeconds: 1 } });
  await h.click('scan');
  assert.equal(attempts, 2); assert.match(h.panel.getElementById('status').textContent, /1 файлов в 1 папках/);
  const cached = await core.cacheRequest(h.dom.window.indexedDB, root);
  assert.equal(cached.scanned, true); assert.equal(cached.files.length, 1); h.dom.window.close();
});
test('integration: pause during download backoff preserves the queue without a final error', async () => {
  let attempts = 0;
  const responses = fixtures();
  responses.set(fileURL(root + '/first.pdf'), () => {
    if (++attempts === 1) throw new TypeError('network');
    return new Response('%PDF-1.7\nrecovered');
  });
  const h = createHarness(responses, new MemoryDir(), directoryURL(root), { settings: { maxRetries: 3 } });
  await importJSON(h, legacyList()); const run = h.click('download');
  await until(() => h.panel.getElementById('log').textContent.includes('Автоповтор'));
  await h.click('pause'); await run;
  assert.equal(attempts, 1); assert.equal(h.panel.getElementById('retry').disabled, true);
  assert.match(h.panel.getElementById('status').textContent, /На паузе/);
  await h.click('download'); assert.equal(attempts, 2);
  assert.match(h.panel.getElementById('status').textContent, /Готово: 1\/1/); h.dom.window.close();
});
test('integration: retry exhaustion reports one error and permanent HTTP errors never retry', async () => {
  for (const status of [500, 404, 403, 429, 503]) {
    let attempts = 0; const responses = fixtures();
    responses.set(fileURL(root + '/first.pdf'), () => { attempts++; return new Response('error', { status }); });
    const h = createHarness(responses, new MemoryDir(), directoryURL(root), { settings: { maxRetries: 1, retryBaseSeconds: 1 } });
    await importJSON(h, legacyList()); await h.click('download');
    assert.equal(attempts, status === 500 ? 2 : 1);
    if ([500, 404, 403].includes(status)) assert.match(h.panel.getElementById('status').textContent, /Ошибок: 1/);
    else assert.match(h.panel.getElementById('status').textContent, /На паузе/);
    h.dom.window.close();
  }
});
test('integration: a filesystem TypeError is not classified as a network failure', async () => {
  const destination = new MemoryDir(), dir = await destination.getDirectoryHandle(root, { create: true });
  const file = new MemoryFile(); let writes = 0;
  file.createWritable = async () => { writes++; throw new TypeError('disk error'); };
  dir.files.set('first.pdf', file);
  const h = createHarness(fixtures(), destination, directoryURL(root), { settings: { maxRetries: 3 } });
  await importJSON(h, legacyList()); await h.click('download');
  assert.equal(writes, 1); assert.match(h.panel.getElementById('status').textContent, /На паузе/);
  assert.doesNotMatch(h.panel.getElementById('log').textContent, /Автоповтор/); h.dom.window.close();
});

function entry(path, sizeBytes = null, modified = '', sizeExact = false) {
  return { path, url: fileURL(path), sizeBytes, remote: { sizeBytes, modified, sizeExact } };
}

for (const phase of ['lookup', 'create']) for (const start of ['download', 'repair']) {
  test(`regression: rejected file name during ${phase} does not stop ${start}`, async () => {
    const destination = new MemoryDir(), out = await destination.getDirectoryHandle(root, { create: true });
    const getFile = out.getFileHandle.bind(out); let reject = start === 'download';
    out.getFileHandle = async (name, options = {}) => {
      if (reject && name === 'rimm_1.ini' && (phase === 'lookup' || options.create))
        throw new TypeError("Failed to execute 'getFileHandle' on 'FileSystemDirectoryHandle': Name is not allowed.");
      return getFile(name, options);
    };
    const paths = ['rimm_1.ini', 'z.pdf'].map(p => root + '/' + p);
    const responses = new Map(paths.map(p => [fileURL(p), { body: p.endsWith('.pdf') ? '%PDF-1.7\nok' : '[settings]' }]));
    const h = createHarness(responses, destination, directoryURL(root), { settings: { auto: false, threads: 1 } });
    try {
      await importJSON(h, { root, files: paths.map(p => entry(p)) });
      if (start === 'repair') { await h.click('verify'); reject = true; }
      await h.click(start);
      assert.equal(out.files.get('z.pdf')?.data.toString(), '%PDF-1.7\nok');
      assert.equal(out.files.has('rimm_1.ini'), false);
      assert.match(h.panel.getElementById('status').textContent, /Готово: 1\/2. Ошибок: 1/);
      const exported = await exportedJSON(h, 'export');
      assert.equal(exported.errors.length, 1);
      assert.match(exported.errors[0].error, /Браузер запретил имя/);
      assert.doesNotMatch(exported.errors[0].error, /свободное место/);
      const journal = JSON.parse(out.files.get('.noty-download-state.json').data);
      assert.equal(journal.completed[fileURL(paths[0])], undefined);
      assert.equal(h.calls.length, phase === 'lookup' ? 1 : 2);
      await h.click('verify');
      if (phase === 'lookup') assert.match(h.panel.getElementById('verifyInfo').textContent, /Ошибка чтения: 1/);
    } finally { h.dom.window.close(); }
  });
}

test('regression: rejected journal name still stops the queue', async () => {
  const destination = new MemoryDir(), out = await destination.getDirectoryHandle(root, { create: true });
  const getFile = out.getFileHandle.bind(out);
  out.getFileHandle = async (name, options = {}) => {
    if (name === '.noty-download-state.json' && options.create) throw new TypeError('Name is not allowed.');
    return getFile(name, options);
  };
  const h = createHarness(fixtures(), destination);
  try {
    await importJSON(h, legacyList()); await h.click('download');
    assert.match(h.panel.getElementById('status').textContent, /На паузе/);
    assert.match(h.panel.getElementById('status').textContent, /создание журнала/);
  } finally { h.dom.window.close(); }
});

for (const phase of ['directory', 'file', 'writable', 'write', 'close']) {
  test(`regression: repair pauses on a local ${phase} failure and retains the entire queue`, async () => {
    const destination = new MemoryDir(), out = await destination.getDirectoryHandle(root, { create: true });
    const nested = await out.getDirectoryHandle('Long folder', { create: true });
    const paths = ['Long folder/first.pdf', 'Long folder/second.pdf'].map(p => root + '/' + p);
    const responses = new Map(paths.map(p => [fileURL(p), { body: '%PDF-1.7\nrepair' }]));
    const h = createHarness(responses, destination, directoryURL(root), { settings: { maxRetries: 3 } });
    let failedCalls = 0;
    try {
      await importJSON(h, { root, files: paths.map(p => entry(p)) });
      await h.click('verify');
      const originalDir = out.getDirectoryHandle.bind(out), originalFile = nested.getFileHandle.bind(nested);
      const fail = () => { failedCalls++; throw new DOMException('Local path unavailable', phase === 'directory' || phase === 'file' ? 'NotFoundError' : 'InvalidStateError'); };
      if (phase === 'directory') out.getDirectoryHandle = fail;
      else if (phase === 'file') nested.getFileHandle = async (name, options = {}) => options.create ? fail() : originalFile(name, options);
      else {
        const empty = new MemoryFile();
        nested.files.set('first.pdf', empty);
        empty.createWritable = async () => {
          if (phase === 'writable') return fail();
          return { write: async () => { if (phase === 'write') fail(); }, close: async () => { if (phase === 'close') fail(); }, abort: async () => {} };
        };
      }
      await h.click('repair');
      assert.match(h.panel.getElementById('status').textContent, /На паузе/);
      assert.match(h.panel.getElementById('status').textContent, /Локальная файловая система/);
      assert.match(h.panel.getElementById('status').textContent, /NotFoundError|InvalidStateError/);
      assert.match(h.panel.getElementById('status').textContent, /коротк/);
      assert.equal(failedCalls, 1);
      assert.equal(h.calls.includes(fileURL(paths[1])), false);
      assert.equal(h.panel.getElementById('retry').disabled, true);
      assert.doesNotMatch(h.panel.getElementById('log').textContent, /Автоповтор/);
      out.getDirectoryHandle = originalDir; nested.getFileHandle = originalFile;
      nested.files.delete('first.pdf');
      await h.click('download');
      assert.match(h.panel.getElementById('status').textContent, /Готово: 2\/2. Ошибок: 0/);
      assert.equal(nested.files.get('second.pdf').data.toString(), '%PDF-1.7\nrepair');
    } finally { h.dom.window.close(); }
  });
}

test('regression: concurrent local failures drain started jobs and preserve every pending download', async () => {
  const destination = new MemoryDir(), out = await destination.getDirectoryHandle(root, { create: true });
  const files = ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf'].map(p => entry(root + '/' + p));
  const responses = new Map(files.map(f => [f.url, { body: '%PDF-1.7\ncontent' }]));
  const h = createHarness(responses, destination, directoryURL(root), { settings: { auto: false, threads: 2 } });
  let entered = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  try {
    await importJSON(h, { root, files }); await h.click('verify');
    for (const name of ['a.pdf', 'b.pdf']) {
      const file = new MemoryFile(); out.files.set(name, file);
      file.createWritable = async () => {
        if (++entered === 2) release();
        await barrier;
        throw new DOMException('Swap file path too long', 'InvalidStateError');
      };
    }
    await h.click('repair');
    assert.equal(entered, 2); assert.equal(h.calls.length, 2);
    assert.match(h.panel.getElementById('status').textContent, /На паузе/);
    for (const name of ['a.pdf', 'b.pdf']) out.files.set(name, new MemoryFile());
    await h.click('download');
    assert.match(h.panel.getElementById('status').textContent, /Готово: 4\/4. Ошибок: 0/);
    assert.equal(Object.keys(JSON.parse(out.files.get('.noty-download-state.json').data).completed).length, 4);
  } finally { release(); h.dom.window.close(); }
});

test('regression: losing an already located file during verification reports a read error', async () => {
  const destination = new MemoryDir(), out = await destination.getDirectoryHandle(root, { create: true });
  const file = new MemoryFile('existing');
  file.getFile = async () => { throw new DOMException('Handle became stale', 'NotFoundError'); };
  out.files.set('first.pdf', file);
  const h = createHarness(fixtures(), destination);
  try {
    await importJSON(h, legacyList()); await h.click('verify');
    const report = await exportedJSON(h, 'exportReport');
    assert.equal(report.rows[0].status, 'error');
    assert.match(report.rows[0].error, /чтение файла.*NotFoundError/s);
    assert.equal(h.panel.getElementById('repair').disabled, true);
    assert.equal(h.calls.length, 0);
  } finally { h.dom.window.close(); }
});
async function exportedJSON(h, button) {
  let blob;
  h.dom.window.Blob = Blob;
  h.dom.window.URL.createObjectURL = value => { blob = value; return 'blob:test'; };
  h.dom.window.URL.revokeObjectURL = () => {};
  h.dom.window.HTMLAnchorElement.prototype.click = () => {};
  await h.click(button); return JSON.parse(await blob.text());
}
function checkbox(h, container, path) {
  const result = [...h.panel.getElementById(container).querySelectorAll('input[type=checkbox]')].find(el => el.dataset.path === path);
  assert.ok(result, `Missing checkbox for ${path}`); return result;
}
function toggle(h, container, path, checked) {
  const box = checkbox(h, container, path); box.checked = checked; box.onchange();
}
test('filters combine extensions, names, size limits and unknown-size policy', () => {
  const files = [entry(root + '/A/BOOK.PDF', 1024), entry(root + '/A/readme', 1),
    entry(root + '/B/song.mp3', 1048577), entry(root + '/B/book.djvu', null), entry(root + '/A/empty.pdf', 0)];
  const view = core.normalizeView({ filters: { include: '*.pdf, djvu', exclude: '.djvu', maxMiB: 1 } }, root);
  assert.deepEqual(core.selectFiles(files, view).map(f => f.path), [files[0].path, files[4].path]);
  view.filters = core.normalizeFilters({ include: '-', query: 'README' });
  assert.deepEqual(core.selectFiles(files, view), [files[1]]);
  view.filters = core.normalizeFilters({ unknown: false, maxMiB: 1 });
  assert.equal(core.selectFiles(files, view).length, 3);
  view.filters = core.normalizeFilters({ include: 'djvu', unknown: false });
  assert.equal(core.selectFiles(files, view).length, 0);
});
test('folder selection supports nested overrides, siblings, partial parents and file subsets', () => {
  const files = ['A/a.pdf', 'A/B/b.pdf', 'A-other/c.pdf'].map(p => entry(root + '/' + p, 100));
  const view = core.normalizeView({ folders: [[root, false], [root + '/A', true], [root + '/A/B', false]] }, root);
  assert.deepEqual(core.selectFiles(files, view), [files[0]]);
  const tree = core.folderTree(files, root, view);
  assert.deepEqual(tree.find(n => n.path === root), { path: root, count: 3, checked: 1, selected: 1, bytes: 100, unknown: 0 });
  view.files = [files[1].path]; assert.equal(core.selectFiles(files, view).length, 0);
  view.folders = []; assert.deepEqual(core.selectFiles(files, view), [files[1]]);
  const invalid = core.normalizeView({ folders: [['../bad', true], ['elsewhere', false], [root, false]], files: ['../bad', 'elsewhere/file'] }, root);
  assert.deepEqual(invalid.folders, [[root, false]]); assert.deepEqual(invalid.files, []);
});
test('listing metadata distinguishes exact byte counts, rounded units and absent dates', () => {
  for (const [size, exact] of [['1234 bytes', true], ['1.2 KB', false], ['1234', true], ['1234 байт', true]]) {
    const dom = new JSDOM(`<table><tr><th>File name</th><th>Size</th><th>Last updated</th></tr><tr><td><a href="x">x</a></td><td>${size}</td><td>23.09.26</td></tr></table>`);
    const meta = core.listingMetadata(dom.window.document.querySelector('a')).remote;
    assert.equal(meta.sizeExact, exact, size); assert.equal(meta.modified, '23.09.26'); dom.window.close();
  }
  assert.equal(core.remoteMetadata({ modified: '-' }).modified, '');
});
test('manifest comparison reports additions, changes, uncertainty and confirmed removals', () => {
  const previous = { files: [entry('same.pdf', 100, '01.01.26'), entry('changed.pdf', 100, '01.01.26'),
    entry('unknown.pdf'), entry('removed.pdf', 5)] };
  const current = [entry('same.pdf', 100, '01.01.26'), entry('changed.pdf', 100, '02.01.26'), entry('unknown.pdf'), entry('new.pdf')];
  assert.deepEqual(core.compareManifests(previous, current).map(r => r.status), ['unchanged', 'changed', 'uncertain', 'added', 'removed']);
  assert.equal(core.compareManifests(previous, current, false).some(r => r.status === 'removed'), false);
  assert.equal(core.compareRemote(entry('x', 1), entry('x', 2)), 'changed');
  assert.equal(core.compareRemote(entry('x', 1), entry('x', 1)), 'uncertain');
});
test('verification does not confuse rounded sizes or missing journal entries with trusted matches', () => {
  const file = entry(root + '/book.pdf', 1024, '', false), record = { path: 'book.pdf', size: 1100 };
  assert.equal(core.verifyFile(file, root, null, record), 'missing');
  assert.equal(core.verifyFile(file, root, { size: 0 }, record), 'incomplete');
  assert.equal(core.verifyFile(file, root, { size: 1100 }, record), 'verified');
  assert.equal(core.verifyFile(file, root, { size: 1101 }, record), 'mismatch');
  assert.equal(core.verifyFile(file, root, { size: 1100 }, null), 'uncertain');
  file.remote.sizeExact = true;
  assert.equal(core.verifyFile(file, root, { size: 1100 }, null), 'mismatch');
  assert.equal(core.verifyFile(file, root, { size: 1024 }, null), 'uncertain');
  assert.equal(core.verifyFile(file, root, { size: 1100 }, record), 'changed');
  assert.equal(core.sameLocal({ size: 10, lastModified: 2 }, { size: 10, lastModified: 1 }), false);
});
test('JSON carries view, dates and one previous snapshot without trusting nested snapshots', () => {
  const data = { ...legacyList(), view: { folders: [[root, false]], filters: { include: 'pdf' } },
    previous: { root, files: [entry(root + '/old.pdf', 10, 'yesterday')], previous: { malicious: true } } };
  data.files[0].remote = { sizeBytes: 100, sizeExact: true, modified: 'today' };
  const result = core.validateManifest(data);
  assert.equal(result.files[0].remote.modified, 'today'); assert.equal(result.previous.files.length, 1);
  assert.equal(result.previous.previous, undefined); assert.equal(result.view.filters.include, 'pdf');
  assert.deepEqual(result.view.folders, [[root, false]]);
  assert.throws(() => core.validateManifest({ ...data, previous: { root, files: [entry('outside/file.pdf')] } }));
});
test('graph history stays bounded during long runs', () => {
  const history = new core.History();
  for (let i = 0; i < 10000; i++) history.add({ rate: i, limit: 6, active: 5 });
  assert.equal(history.points.length, 180); assert.equal(history.points[0].rate, 9820);
});
test('integration: folder and format selection restricts downloads while preserving full exports', async () => {
  const files = [entry(root + '/A/a.pdf', 10), entry(root + '/A/audio.mp3', 20), entry(root + '/B/b.pdf', 30)];
  const responses = new Map(files.map(f => [f.url, { body: f.path.endsWith('.pdf') ? '%PDF-1.7\ncontent' : 'audio' }]));
  const h = createHarness(responses); await importJSON(h, { root, files });
  await h.click('selectNone'); toggle(h, 'tree', root + '/A', true);
  assert.equal(checkbox(h, 'tree', root).indeterminate, true);
  h.panel.getElementById('includeExt').value = 'PDF'; h.panel.getElementById('includeExt').onchange();
  assert.match(h.panel.getElementById('selectionInfo').textContent, /Выбрано 1 из 3/);
  const exported = await exportedJSON(h, 'export'); assert.equal(exported.files.length, 3); assert.equal(exported.view.filters.include, 'PDF');
  await h.click('download'); assert.deepEqual(h.calls, [files[0].url]);
  assert.match(h.panel.getElementById('status').textContent, /Готово: 1\/1/);
  assert.equal(h.destination.dirs.get(root).dirs.has('B'), false); h.dom.window.close();
  const restored = createHarness(responses); await importJSON(restored, exported);
  assert.match(restored.panel.getElementById('selectionInfo').textContent, /Выбрано 1 из 3/); restored.dom.window.close();
});
test('integration: no matching files disables downloading and preferences survive reload', async () => {
  const h = createHarness(fixtures()); await importJSON(h, legacyList());
  h.panel.getElementById('excludeExt').value = 'pdf'; h.panel.getElementById('excludeExt').onchange();
  assert.equal(h.panel.getElementById('download').disabled, true);
  await h.click('download'); assert.equal(h.calls.length, 0);
  assert.equal(JSON.parse(h.dom.window.localStorage.getItem('noty-view:' + root)).filters.exclude, 'pdf');
  await h.click('clearFilters'); assert.equal(h.panel.getElementById('download').disabled, false); h.dom.window.close();
});
test('integration: verification is read-only, repair fetches only missing files, replacements require selection', async () => {
  const destination = new MemoryDir(), out = await destination.getDirectoryHandle(root, { create: true });
  out.files.set('first.pdf', new MemoryFile('unrelated original'));
  out.files.set('unrelated.txt', new MemoryFile('leave me'));
  const h = createHarness(fixtures(), destination); await h.click('scan'); await h.click('verify');
  assert.equal(h.calls.filter(url => url.includes('/Public/')).length, 0);
  assert.equal(out.files.has('.noty-download-state.json'), false); assert.equal(out.dirs.size, 0);
  const report = await exportedJSON(h, 'exportReport');
  assert.deepEqual(report.rows.map(r => r.status).sort(), ['missing', 'uncertain']);
  assert.equal(h.panel.getElementById('replaceSelected').disabled, true);
  await h.click('repair');
  assert.deepEqual(h.calls.filter(url => url.includes('/Public/')), [fileURL(root + '/Теория/Ноты +.pdf')]);
  assert.equal(out.files.get('first.pdf').data.toString(), 'unrelated original');
  toggle(h, 'reportRows', root + '/first.pdf', true); await h.click('replaceSelected');
  assert.equal(out.files.get('first.pdf').data.toString(), '%PDF-1.7\nfirst');
  assert.equal(out.files.get('unrelated.txt').data.toString(), 'leave me');
  assert.equal(Object.keys(JSON.parse(out.files.get('.noty-download-state.json').data).completed).length, 2);
  h.dom.window.close();
});
test('integration: verification of an absent output folder creates nothing until repair is requested', async () => {
  const h = createHarness(fixtures()); await importJSON(h, legacyList()); await h.click('verify');
  assert.equal(h.destination.dirs.size, 0);
  assert.equal((await exportedJSON(h, 'exportReport')).rows[0].status, 'missing');
  let granted = false; h.destination.requestPermission = async () => { granted = true; return 'granted'; };
  const original = h.destination.getDirectoryHandle.bind(h.destination);
  h.destination.getDirectoryHandle = async (name, options) => { if (options?.create) assert.equal(granted, true); return original(name, options); };
  await h.click('repair');
  assert.equal(h.destination.dirs.get(root).files.get('first.pdf').data.toString(), '%PDF-1.7\nfirst'); h.dom.window.close();
});
test('integration: a local edit before replacement or during its network request prevents overwrite', async () => {
  for (const timing of ['before', 'during']) {
    const destination = new MemoryDir(), out = await destination.getDirectoryHandle(root, { create: true });
    const file = new MemoryFile('original'); out.files.set('first.pdf', file);
    const responses = fixtures();
    if (timing === 'during') responses.set(fileURL(root + '/first.pdf'), () => { file.lastModified++; return new Response('%PDF-1.7\nnew'); });
    const h = createHarness(responses, destination); await importJSON(h, legacyList()); await h.click('verify');
    toggle(h, 'reportRows', root + '/first.pdf', true);
    if (timing === 'before') file.lastModified++;
    await h.click('replaceSelected');
    assert.equal(file.data.toString(), 'original');
    assert.match(h.panel.getElementById('log').textContent, /изменился после проверки/);
    h.dom.window.close();
  }
});
test('integration: a bad replacement response leaves the previous file intact', async () => {
  const destination = new MemoryDir(), out = await destination.getDirectoryHandle(root, { create: true });
  out.files.set('first.pdf', new MemoryFile('original'));
  const responses = fixtures(); responses.set(fileURL(root + '/first.pdf'), { body: '<html>blocked</html>', headers: { 'content-type': 'text/html' } });
  const h = createHarness(responses, destination); await importJSON(h, legacyList()); await h.click('verify');
  toggle(h, 'reportRows', root + '/first.pdf', true); await h.click('replaceSelected');
  assert.equal(out.files.get('first.pdf').data.toString(), 'original');
  assert.equal(out.files.has('.noty-download-state.json'), false); h.dom.window.close();
});
test('integration: journal mismatches are reported and changing filters invalidates replacement approval', async () => {
  const destination = new MemoryDir(), out = await destination.getDirectoryHandle(root, { create: true });
  out.files.set('first.pdf', new MemoryFile('short'));
  out.files.set('.noty-download-state.json', new MemoryFile(JSON.stringify({ version: 1, root,
    completed: { [fileURL(root + '/first.pdf')]: { path: 'first.pdf', size: 500 } } })));
  const h = createHarness(fixtures(), destination); await importJSON(h, legacyList()); await h.click('verify');
  assert.equal((await exportedJSON(h, 'exportReport')).rows[0].status, 'mismatch');
  toggle(h, 'reportRows', root + '/first.pdf', true);
  await h.click('selectNone'); assert.equal(h.panel.getElementById('replaceSelected').disabled, true);
  await h.click('replaceSelected'); assert.equal(h.calls.length, 0); h.dom.window.close();
});
test('integration: cancelled verification cannot offer a partial repair queue', async () => {
  const files = Array.from({ length: 30 }, (_, i) => entry(root + '/' + i + '.pdf'));
  const h = createHarness(new Map()); await importJSON(h, { root, files });
  h.dom.window.showDirectoryPicker = async () => { h.panel.getElementById('pause').onclick(); return h.destination; };
  // Pause after verification has started, during its first yielded batch.
  const run = h.click('verify');
  await until(() => h.panel.getElementById('status').textContent.includes('Проверка: 25/'));
  await h.click('pause'); await run;
  const report = await exportedJSON(h, 'exportReport'); assert.equal(report.complete, false);
  assert.equal(h.panel.getElementById('repair').disabled, true); h.dom.window.close();
});
test('integration: incremental update compares snapshots and downloads only selected additions', async () => {
  const old = [entry(root + '/same.pdf', 10, '01.01.26'), entry(root + '/changed.pdf', 10, '01.01.26'), entry(root + '/gone.pdf', 10, '01.01.26')];
  const responses = new Map([[directoryURL(root), { body: '<table><tr><th>File name</th><th>Size</th><th>Last updated</th></tr>' +
    [['same', '01.01.26'], ['changed', '02.01.26'], ['new', '02.01.26']].map(([name, date]) =>
      `<tr><td><a href="${fileURL(root + '/' + name + '.pdf')}">${name}</a></td><td>10 B</td><td>${date}</td></tr>`).join('') + '</table>' }],
    [fileURL(root + '/new.pdf'), { body: '%PDF-1.7\nnew' }]]);
  const h = createHarness(responses); await importJSON(h, { root, files: old }); await h.click('updateScan');
  const diff = await exportedJSON(h, 'exportChanges');
  assert.deepEqual(Object.fromEntries(diff.changes.map(r => [r.path.split('/').at(-1), r.status])),
    { 'same.pdf': 'unchanged', 'changed.pdf': 'changed', 'new.pdf': 'added', 'gone.pdf': 'removed' });
  await h.click('selectUpdates'); toggle(h, 'changeRows', root + '/changed.pdf', false);
  await h.click('download');
  assert.deepEqual(h.calls.filter(url => url.includes('/Public/')), [fileURL(root + '/new.pdf')]);
  const cache = await core.cacheRequest(h.dom.window.indexedDB, root);
  assert.equal(cache.previous.files.length, 3); h.dom.window.close();
});
test('integration: changed remote metadata prevents silent journal skips and supports reviewed updates', async () => {
  const file = entry(root + '/first.pdf', 14, '02.01.26', true), destination = new MemoryDir();
  const out = await destination.getDirectoryHandle(root, { create: true });
  out.files.set('first.pdf', new MemoryFile('%PDF-1.7\nprior'));
  const size = out.files.get('first.pdf').data.length;
  out.files.set('.noty-download-state.json', new MemoryFile(JSON.stringify({ version: 1, root,
    completed: { [file.url]: { path: 'first.pdf', size, remote: { sizeBytes: size, sizeExact: true, modified: '01.01.26' } } } })));
  out.files.set('removed.pdf', new MemoryFile('preserve removed file'));
  const h = createHarness(fixtures(), destination); await importJSON(h, { root, files: [file] });
  await h.click('download'); assert.equal(h.calls.length, 0);
  assert.match(h.panel.getElementById('status').textContent, /Ошибок: 1/);
  await h.click('verify'); assert.equal((await exportedJSON(h, 'exportReport')).rows[0].status, 'changed');
  toggle(h, 'reportRows', file.path, true); await h.click('replaceSelected');
  assert.equal(out.files.get('first.pdf').data.toString(), '%PDF-1.7\nfirst');
  assert.equal(JSON.parse(out.files.get('.noty-download-state.json').data).completed[file.url].remote.modified, '02.01.26');
  await h.click('verify'); assert.equal((await exportedJSON(h, 'exportReport')).rows[0].status, 'verified');
  assert.equal(out.files.get('removed.pdf').data.toString(), 'preserve removed file'); h.dom.window.close();
});
test('integration: detailed progress shows active bytes and draws speed/concurrency history', async () => {
  const clock = { now: 0 }; let controller;
  const responses = new Map([[fileURL(root + '/first.pdf'), () => new Response(new ReadableStream({ start(c) { controller = c; } }))]]);
  const h = createHarness(responses, new MemoryDir(), directoryURL(root), { clock });
  await importJSON(h, legacyList()); const run = h.click('download'); await until(() => controller);
  for (let i = 1; i <= 4; i++) {
    const bytes = new Uint8Array(1024); if (i === 1) bytes.set(new TextEncoder().encode('%PDF-1.7\n'));
    controller.enqueue(bytes); clock.now = i * 1000; await new Promise(resolve => setTimeout(resolve, 8));
  }
  assert.match(h.panel.getElementById('jobs').textContent, /first.pdf/);
  assert.match(h.panel.getElementById('jobs').textContent, /4 КиБ/);
  assert.ok(h.panel.getElementById('rateChart').querySelector('polyline').getAttribute('points').length > 0);
  const fileCurve = h.panel.getElementById('rateChart').querySelectorAll('polyline')[1];
  assert.ok(fileCurve.getAttribute('points').split(' ').every(p => Number(p.split(',')[1]) === 66), 'No completed files means a zero file rate even while bytes arrive');
  assert.equal(h.panel.getElementById('threadChart').querySelectorAll('polyline').length, 2);
  controller.close(); await run;
  assert.match(h.panel.getElementById('jobs').textContent, /готово:.*first.pdf/); h.dom.window.close();
});
test('integration: large folder trees render in bounded pages with working search', async () => {
  const files = Array.from({ length: 500 }, (_, i) => entry(root + '/Folder' + String(i).padStart(3, '0') + '/book.pdf', 100));
  const h = createHarness(new Map()); await importJSON(h, { root, files });
  assert.equal(h.panel.getElementById('tree').querySelectorAll('.row').length, 150);
  assert.equal(h.panel.getElementById('treeMore').hidden, false); await h.click('treeMore');
  assert.equal(h.panel.getElementById('tree').querySelectorAll('.row').length, 300);
  h.panel.getElementById('folderSearch').value = 'Folder499'; h.panel.getElementById('folderSearch').oninput();
  assert.equal(h.panel.getElementById('tree').querySelectorAll('.row').length, 1);
  toggle(h, 'tree', root + '/Folder499', false);
  assert.match(h.panel.getElementById('selectionInfo').textContent, /Выбрано 499 из 500/); h.dom.window.close();
});

test('integration: interrupted replacement aborts new bytes while retaining the old file', async () => {
  const destination = new MemoryDir(), out = await destination.getDirectoryHandle(root, { create: true });
  out.files.set('first.pdf', new MemoryFile('original data'));
  let reads = 0;
  const responses = new Map([[fileURL(root + '/first.pdf'), () => new Response(new ReadableStream({ pull(c) {
    if (reads++ === 0) { const bytes = new Uint8Array(2048); bytes.set(new TextEncoder().encode('%PDF-1.7\n')); c.enqueue(bytes); }
    else c.error(new TypeError('interrupted'));
  } }))]]);
  const h = createHarness(responses, destination); await importJSON(h, legacyList()); await h.click('verify');
  toggle(h, 'reportRows', root + '/first.pdf', true); await h.click('replaceSelected');
  assert.equal(out.files.get('first.pdf').data.toString(), 'original data');
  assert.equal(out.files.has('.noty-download-state.json'), false);
  assert.match(h.panel.getElementById('status').textContent, /Сетевой запрос не завершён/); h.dom.window.close();
});
test('integration: Root verification and repair use the archive output directory and update report rows', async () => {
  const file = entry('_ABC/book.pdf', 14);
  const h = createHarness(new Map([[file.url, { body: '%PDF-1.7\nfirst' }]]), new MemoryDir(), origin + '/');
  await importJSON(h, { root: '', files: [file] }); await h.click('verify'); await h.click('repair');
  assert.equal(h.destination.dirs.get('noty.propovednik.com').dirs.get('_ABC').files.get('book.pdf').data.toString(), '%PDF-1.7\nfirst');
  const report = await exportedJSON(h, 'exportReport'); assert.equal(report.rows[0].status, 'verified');
  assert.equal(h.panel.getElementById('repair').disabled, true); h.dom.window.close();
});
test('manifest editor sorts numeric sizes with unknowns last and searches paths without mutating the source', () => {
  const files = [entry(root + '/unknown.pdf'), entry(root + '/B/Теория10.pdf', 10), entry(root + '/B/Теория2.pdf', 10),
    entry(root + '/large.pdf', 10240), entry(root + '/zero.pdf', 0)];
  const original = files.map(f => f.path);
  assert.deepEqual(core.listManifestFiles(files).map(f => f.sizeBytes), [10240, 10, 10, 0, null]);
  assert.deepEqual(core.listManifestFiles(files, '', 'size-asc').map(f => f.sizeBytes), [0, 10, 10, 10240, null]);
  assert.deepEqual(core.listManifestFiles(files, ' теория ', 'path').map(f => f.path), [root + '/B/Теория2.pdf', root + '/B/Теория10.pdf']);
  assert.equal(core.listManifestFiles(files, '/B/').length, 2);
  assert.deepEqual(files.map(f => f.path), original);
});

test('editor deletion persists in cache/export, invalidates verification and leaves local files untouched', async () => {
  const db = new IDBFactory(), destination = new MemoryDir(), out = await destination.getDirectoryHandle(root, { create: true });
  out.files.set('remove.pdf', new MemoryFile('keep local original'));
  const files = [entry(root + '/remove.pdf', 10), entry(root + '/keep.pdf', 20)];
  let h = createHarness(new Map(), destination, directoryURL(root), { indexedDB: db });
  try {
    await importJSON(h, { root, files }); await h.click('verify'); await h.click('editList');
    toggle(h, 'editorRows', files[0].path, true); await h.click('editorDelete');
    assert.match(h.panel.getElementById('editorNotice').textContent, /сохранены в кеше/);
    assert.deepEqual((await exportedJSON(h, 'editorExport')).files.map(f => f.path), [files[1].path]);
    assert.deepEqual((await exportedJSON(h, 'export')).files.map(f => f.path), [files[1].path]);
    assert.equal(out.files.get('remove.pdf').data.toString(), 'keep local original');
    assert.equal(h.panel.getElementById('repair').disabled, true);
    assert.equal(h.panel.getElementById('exportReport').disabled, true);
    const cached = core.validateManifest(await core.cacheRequest(db, root));
    assert.deepEqual(cached.files.map(f => f.path), [files[1].path]);
    h.dom.window.close();
    h = createHarness(new Map(), destination, directoryURL(root), { indexedDB: db });
    await until(() => !h.panel.getElementById('cache').disabled); await h.click('cache');
    assert.deepEqual((await exportedJSON(h, 'export')).files.map(f => f.path), [files[1].path]);
    assert.equal(h.calls.length, 0);
  } finally { h.dom.window.close(); }
});

test('editor handles all filtered pages, hidden selections, empty exports and undo', async () => {
  const h = createHarness(new Map());
  try {
    const files = Array.from({ length: 205 }, (_, i) => entry(root + '/book' + i + '.pdf', i));
    files.push(entry(root + '/song.mp3', 1000));
    await importJSON(h, { root, files }); await h.click('editList');
    assert.equal(h.panel.getElementById('editorRows').children.length, 100);
    await h.click('editorNext'); assert.match(h.panel.getElementById('editorPageInfo').textContent, /2 \/ 3/);
    const query = h.panel.getElementById('editorQuery'); query.value = '.pdf'; query.oninput();
    await h.click('editorSelectAll'); assert.match(h.panel.getElementById('editorDelete').textContent, /205/);
    query.value = '.mp3'; query.oninput();
    assert.match(h.panel.getElementById('editorSelectionInfo').textContent, /вне поиска: 205/);
    await h.click('editorDelete');
    assert.deepEqual((await exportedJSON(h, 'export')).files.map(f => f.path), [root + '/song.mp3']);
    await h.click('editorUndo'); assert.equal((await exportedJSON(h, 'export')).files.length, 206);
    assert.equal(h.panel.getElementById('editorUndo').disabled, true);
    query.value = ''; query.oninput(); await h.click('editorSelectAll'); await h.click('editorDelete');
    assert.equal(h.panel.getElementById('export').disabled, false);
    assert.equal(h.panel.getElementById('editorExport').disabled, false);
    assert.equal(h.panel.getElementById('download').disabled, true);
    const empty = await exportedJSON(h, 'export'); assert.equal(empty.files.length, 0);
    assert.equal(core.validateManifest(empty).files.length, 0);
    await h.click('cache'); assert.equal((await exportedJSON(h, 'export')).files.length, 0);
    assert.equal(h.panel.getElementById('editorUndo').disabled, true, 'Loading a manifest resets undo');
  } finally { h.dom.window.close(); }
});

test('editor cache failure remains exportable and explicit save can retry persistence', async () => {
  const h = createHarness(new Map(), new MemoryDir(), directoryURL(root), { indexedDB: null });
  try {
    await importJSON(h, { root, files: [entry(root + '/a.pdf'), entry(root + '/b.pdf')] }); await h.click('editList');
    toggle(h, 'editorRows', root + '/a.pdf', true); await h.click('editorDelete');
    assert.match(h.panel.getElementById('editorNotice').textContent, /Кеш недоступен.*JSON/);
    assert.deepEqual((await exportedJSON(h, 'editorExport')).files.map(f => f.path), [root + '/b.pdf']);
    const db = new IDBFactory(); h.dom.window.indexedDB = db; await h.click('editorSave');
    assert.match(h.panel.getElementById('editorNotice').textContent, /сохранён в кеше/);
    assert.deepEqual((await core.cacheRequest(db, root)).files.map(f => f.path), [root + '/b.pdf']);
  } finally { h.dom.window.close(); }
});

test('editor cannot mutate an active queue but excludes removed items after pause', async () => {
  let release;
  const files = ['a.pdf', 'b.pdf', 'c.pdf'].map(name => entry(root + '/' + name));
  const responses = new Map(files.map(f => [f.url, { body: '%PDF-1.7\ncontent' }]));
  responses.set(files[0].url, () => new Promise(resolve => { release = () => resolve(new Response('%PDF-1.7\ncontent')); }));
  const h = createHarness(responses, new MemoryDir(), directoryURL(root), { settings: { auto: false, threads: 1 } });
  try {
    await importJSON(h, { root, files }); await h.click('editList');
    toggle(h, 'editorRows', files[1].path, true);
    const running = h.click('download'); await until(() => !!release);
    assert.equal(h.panel.getElementById('editorDelete').disabled, true);
    await h.click('editorDelete');
    await h.click('pause'); release(); await running;
    assert.equal(h.panel.getElementById('editorDelete').disabled, false);
    await h.click('editorDelete'); await h.click('download');
    assert.equal(h.calls.includes(files[1].url), false);
    assert.equal(h.calls.includes(files[2].url), true);
    assert.deepEqual((await exportedJSON(h, 'export')).files.map(f => f.path), [files[0].path, files[2].path]);
  } finally { if (release) release(); h.dom.window.close(); }
});

test('editor shows Root for files directly in the archive root', async () => {
  const h = createHarness(new Map(), new MemoryDir(), directoryURL(''));
  try {
    await importJSON(h, { root: '', files: [entry('song.pdf', 42)] }); await h.click('editList');
    assert.equal(h.panel.getElementById('editorRows').querySelector('small').textContent, 'Root');
  } finally { h.dom.window.close(); }
});

test('editor safely renders imported filenames and retains focus when checking rows', async () => {
  const h = createHarness(new Map());
  try {
    const path = root + '/<img src=x onerror=alert(1)>.pdf';
    await importJSON(h, { root, files: [entry(path)] }); await h.click('editList');
    assert.equal(h.panel.getElementById('editorRows').querySelector('img'), null);
    assert.equal(h.panel.getElementById('editorRows').querySelector('a').textContent, path.split('/').at(-1));
    checkbox(h, 'editorRows', path).focus(); toggle(h, 'editorRows', path, true);
    assert.equal(h.panel.activeElement.dataset.path, path);
  } finally { h.dom.window.close(); }
});

test('integration: cached update comparisons and selection survive a browser restart', async () => {
  const db = new IDBFactory();
  const data = { root, files: [entry(root + '/same.pdf', 5, 'date'), entry(root + '/new.pdf', 5, 'date')],
    previous: { root, files: [entry(root + '/same.pdf', 5, 'date')] }, view: { files: [root + '/new.pdf'] } };
  let h = createHarness(new Map(), new MemoryDir(), directoryURL(root), { indexedDB: db });
  await importJSON(h, data); h.dom.window.close();
  h = createHarness(new Map(), new MemoryDir(), directoryURL(root), { indexedDB: db });
  await until(() => !h.panel.getElementById('cache').disabled); await h.click('cache');
  assert.match(h.panel.getElementById('selectionInfo').textContent, /Выбрано 1 из 2/);
  assert.match(h.panel.getElementById('updateInfo').textContent, /Новый: 1/); h.dom.window.close();
});
