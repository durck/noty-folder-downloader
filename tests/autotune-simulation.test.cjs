'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AutoTuner, normalizeSettings, runPool } = require('../noty-folder-downloader.user.js');

async function simulate({ duration = 800, size = 1024, count = 1500, settings: input = {}, changes = [] } = {}) {
  let settings = normalizeSettings({ windowSeconds: 5, ...input });
  const tuner = new AutoTuner(settings);
  let now = 0, ended = false, bytes = 0, saved = 0, small = 0, savedBytes = 0;
  let lastTime = 0, lastBytes = 0, lastSaved = 0, lastSmall = 0, lastSavedBytes = 0;
  const jobs = Array.from({ length: count }, (_, id) => ({
    size: typeof size === 'function' ? size(id) : size,
    duration: typeof duration === 'function' ? duration(id) : duration
  }));
  const activeSizes = new Map();
  const started = [], completed = [], decisions = [], timeline = [], timers = [];
  const limit = () => settings.auto ? tuner.limit : settings.threads;
  const wait = ms => new Promise(resolve => timers.push({ at: now + ms, resolve }));
  for (const change of changes) timers.push({ at: change.at, resolve() {
    settings = normalizeSettings({ ...settings, ...change.settings }); tuner.updateSettings(settings, now);
    timeline.push({ at: now, auto: settings.auto, limit: limit(), preference: settings.threads });
  } });
  const pool = runPool({ queue: Array.from({ length: count }, (_, i) => i),
    limit, paused: () => false, delayMs: () => settings.delayMs, now: () => now, wait,
    worker: async id => {
      started.push({ id, at: now, limit: limit() }); activeSizes.set(id, jobs[id].size);
      await wait(jobs[id].duration); bytes += jobs[id].size;
    },
    complete: id => {
      completed.push(id); saved++; activeSizes.delete(id); savedBytes += jobs[id].size;
      if (jobs[id].size <= 262144) small++;
    },
    failed: error => { throw error; },
    tick(active, queued) {
      const elapsed = now - lastTime;
      if (elapsed < 1000) return;
      const reason = active > limit() ? 'draining' : queued === 0 ? 'tail' : '';
      if (settings.auto) {
        const decision = tuner.observe(bytes - lastBytes, elapsed, !reason, now,
          { files: saved - lastSaved, smallFiles: small - lastSmall, completedBytes: savedBytes - lastSavedBytes,
            active, largeActive: [...activeSizes.values()].some(value => value > 262144), reason });
        if (decision) decisions.push({ at: now, ...decision });
      }
      lastTime = now; lastBytes = bytes; lastSaved = saved; lastSmall = small; lastSavedBytes = savedBytes;
    }
  }).finally(() => { ended = true; });
  while (!ended) {
    await new Promise(resolve => setImmediate(resolve));
    if (ended) break;
    assert.ok(timers.length, 'Scheduler has work but no wake-up');
    timers.sort((a, b) => a.at - b.at); now = timers[0].at;
    assert.ok(now < 10000000, 'Simulation must finish within its deadline');
    while (timers.length && timers[0].at <= now) timers.shift().resolve();
  }
  await pool;
  assert.equal(completed.length, count);
  assert.equal(new Set(started.map(x => x.id)).size, count);
  assert.equal(new Set(completed).size, count);
  return { seconds: now / 1000, started, decisions, timeline, tuner, settings };
}

test('simulation: tiny files obey launch pacing without an extra 200ms idle penalty', async () => {
  const result = await simulate({ duration: 120, count: 1200 });
  assert.ok(result.seconds < 190, `Unexpected pacing overhead: ${result.seconds}s`);
  assert.ok(result.decisions.length > 5, 'Underfill must not disable measurements');
  const starts = result.started.map(x => x.at);
  assert.ok(starts.slice(1).every((time, i) => time - starts[i] >= 150), 'Keep the server-friendly launch delay');
});

test('simulation: latency-bound small files outperform one worker and approach fixed concurrency', async () => {
  const auto = await simulate();
  const single = await simulate({ settings: { auto: false, threads: 1 } });
  const fixed = await simulate({ settings: { auto: false, threads: 6 } });
  assert.ok(auto.seconds < single.seconds * 0.5);
  assert.ok(auto.seconds < fixed.seconds * 1.5, 'Discovery overhead must remain bounded');
  assert.ok(auto.decisions.some(d => d.metric === 'files' && d.to >= 4));
  console.log(JSON.stringify({ scenario: 'latency-bound small files', autoSeconds: auto.seconds,
    oneWorkerSeconds: single.seconds, sixWorkersSeconds: fixed.seconds }));
});

test('simulation: switching modes twice preserves files and manual limits', async () => {
  const result = await simulate({ duration: 2000, count: 600, settings: { threads: 4, maxThreads: 3 }, changes: [
    { at: 10000, settings: { auto: false } },
    { at: 45000, settings: { auto: true } },
    { at: 70000, settings: { scanThreads: 5 } },
    { at: 100000, settings: { auto: false, threads: 2 } },
    { at: 130000, settings: { auto: true } }
  ] });
  assert.deepEqual(result.timeline.map(x => x.limit).slice(0, 2), [4, 3]);
  assert.deepEqual(result.timeline.slice(-2).map(x => x.limit), [2, 2]);
  assert.ok(result.started.filter(x => x.at >= 10000 && x.at < 45000).every(x => x.limit === 4));
  assert.ok(result.started.filter(x => x.at >= 100000 && x.at < 130000).every(x => x.limit === 2));
  assert.equal(result.settings.threads, 2);
});

test('simulation: large-file byte throughput adapts without requiring file-rate samples', async () => {
  const result = await simulate({ duration: 4000, size: 8 * 1048576, count: 300 });
  assert.ok(result.decisions.some(d => d.metric === 'bytes' && d.to >= 4));
  assert.ok(result.seconds < 1200 * 0.65);
});

for (const [duration, windowSeconds] of [[3000, 5], [12000, 10]]) {
  test(`regression: ${duration}ms small files scale across the five-completion threshold`, async () => {
    const config = { duration, count: 300, settings: { windowSeconds, maxThreads: 3 } };
    const auto = await simulate(config);
    const fixed = await simulate({ ...config, settings: { ...config.settings, auto: false, threads: 3 } });
    assert.equal(auto.tuner.best.threads, 3);
    assert.ok(auto.seconds < fixed.seconds * 1.3, `${auto.seconds}s vs fixed ${fixed.seconds}s`);
    assert.equal(auto.decisions.filter(d => d.reason === 'workload').length, 0);
    console.log(JSON.stringify({ scenario: `${duration}ms small files`, autoSeconds: auto.seconds, fixedSeconds: fixed.seconds }));
  });
}

test('simulation: mixed sizes and a workload transition preserve the queue and adapt', async () => {
  const config = { count: 900, settings: { maxThreads: 4 },
    size: id => id < 300 ? 1024 : id % 3 ? 4 * 1048576 : 65536,
    duration: id => id < 300 ? 500 : id % 3 ? 5000 : 1500 };
  const auto = await simulate(config);
  const single = await simulate({ ...config, settings: { auto: false, threads: 1 } });
  assert.ok(auto.decisions.some(d => d.metric === 'files'));
  assert.ok(auto.decisions.some(d => d.metric === 'bytes' && d.to >= 3));
  assert.ok(auto.seconds < single.seconds * 0.6);
  assert.ok(auto.started.every(job => job.limit >= 1 && job.limit <= 4));
});
