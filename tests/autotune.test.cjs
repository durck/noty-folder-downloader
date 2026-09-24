'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AutoTuner } = require('../noty-folder-downloader.user.js');
const MiB = 1048576;
function driver(settings = {}, initial = 1) {
  const tuner = new AutoTuner({ windowSeconds: 5, ...settings }, 0, initial);
  let now = 0;
  const decisions = [];
  return { tuner, decisions, get now() { return now; },
    step(rate, work = {}, eligible = true, ms = 1000) {
      now += ms;
      const result = tuner.observe(rate * MiB * ms / 1000, ms, eligible, now,
        { active: tuner.limit, ...work });
      if (result) decisions.push({ second: now / 1000, ...result });
      return result;
    },
    run(seconds, rate, work = {}) {
      for (let i = 0; i < seconds; i++) this.step(typeof rate === 'function' ? rate(tuner.limit, i) : rate,
        typeof work === 'function' ? work(tuner.limit, i) : work);
    }
  };
}

test('regression: minimum worker slowdown eventually reconsiders a stale reference', () => {
  const d = driver(); d.run(120, 1);
  const count = d.decisions.length;
  d.run(600, n => n === 1 ? 0.4 : 0.8);
  assert.ok(d.decisions.slice(count).some(x => x.to > 1), 'Must escape the minimum after changed conditions');
  assert.ok(d.tuner.limit >= 2);
});

test('regression: unrelated settings preserve an automatic limit and its measurements', () => {
  const d = driver({}, 4); d.run(3, 1);
  d.tuner.updateSettings({ ...d.tuner.settings, scanThreads: 5, maxRetries: 7 }, d.now);
  assert.equal(d.tuner.limit, 4);
  d.run(9, 1);
  assert.ok(d.decisions.length, 'Unrelated edits must not restart warm-up');
});

test('mode switching restores the manual preference and seeds auto from it within the ceiling', () => {
  const d = driver({ threads: 4, maxThreads: 3 });
  d.tuner.updateSettings({ ...d.tuner.settings, auto: false }, d.now);
  assert.equal(d.tuner.settings.threads, 4);
  d.tuner.updateSettings({ ...d.tuner.settings, auto: true }, d.now);
  assert.equal(d.tuner.limit, 3);
  assert.equal(d.tuner.settings.threads, 4);
});

test('linear scaling converges to the ceiling and a saturated curve retains an efficient level', () => {
  const linear = driver({ maxThreads: 4 }); linear.run(400, n => n);
  assert.equal(linear.tuner.limit, 4);
  assert.ok(linear.decisions.some(d => d.phase === 'confirm'), 'Gains require a fresh baseline');
  const flat = driver({ maxThreads: 4 }); flat.run(400, n => Math.min(n, 2));
  assert.equal(flat.tuner.best.threads, 2);
  assert.ok(flat.decisions.every(d => d.to >= 1 && d.to <= 4));
});

test('upward drift independent of workers fails the return-to-baseline confirmation', () => {
  const d = driver();
  d.run(150, (_, i) => 1 + i * 0.02);
  assert.equal(d.tuner.best.threads, 1);
  assert.ok(d.decisions.some(d => d.reason === 'unconfirmed'));
});

test('bounded exploration can look beyond a local one-worker plateau', () => {
  const d = driver({ maxThreads: 3 });
  d.run(600, n => [0, 1, 1.06, 1.8][n]);
  assert.ok(d.decisions.some(d => d.to === 3));
  assert.equal(d.tuner.best.threads, 3);
});

test('underfilled workers remain measurable and an unnecessary probe finishes', () => {
  const d = driver({}, 4);
  d.run(120, 1, (_, i) => ({ active: i % 10 ? 2 : 0 }));
  assert.ok(d.decisions.length >= 4);
  assert.ok(d.decisions.some(d => d.phase === 'hold'));
});

test('small-file completion gains count even with a flat byte-rate trace', () => {
  const d = driver({ maxThreads: 3 });
  d.run(400, 1, n => ({ files: n * 10, smallFiles: n * 10, completedBytes: n * 10 * 1024 }));
  assert.equal(d.tuner.best.metric, 'files');
  assert.equal(d.tuner.best.threads, 3);
});

test('large or unknown active files prevent a misleading small-file-only score', () => {
  const d = driver({ maxThreads: 2 });
  d.run(180, 1, n => ({ files: n * 10, smallFiles: n * 10, completedBytes: n * 1024 * 10, largeActive: true }));
  assert.equal(d.tuner.best.metric, 'bytes');
  assert.equal(d.tuner.best.threads, 1);
});

test('mixed workloads do not trade away successful completions for extra network bytes', () => {
  const d = driver({ maxThreads: 2 });
  d.run(180, n => n, n => ({ files: n === 1 ? 10 : 5, smallFiles: 0,
    completedBytes: (n === 1 ? 10 : 5) * MiB, largeActive: true }));
  assert.equal(d.tuner.best.threads, 1);
});

test('size population changes invalidate an apparent gain', () => {
  const d = driver({ maxThreads: 2 });
  d.run(120, n => n * 2, n => ({ files: 10, smallFiles: 0, completedBytes: 10 * MiB * (n === 1 ? 1 : 8) }));
  assert.equal(d.tuner.best.threads, 1);
  assert.ok(d.decisions.some(x => x.reason === 'workload'));
});

test('zero progress and pauses do not trigger growth; returning work is reconsidered', () => {
  const d = driver(); d.run(120, 0);
  assert.equal(d.tuner.limit, 1);
  for (let i = 0; i < 100; i++) d.step(10, { reason: 'pause' }, false);
  assert.equal(d.tuner.limit, 1);
  d.run(200, n => n);
  assert.ok(d.tuner.best.threads > 1);
});

test('background-sized timer intervals work, long gaps discard stale comparisons', () => {
  const d = driver({ maxThreads: 2 });
  for (let i = 0; i < 80; i++) d.step(d.tuner.limit, {}, true, 5000);
  assert.equal(d.tuner.best.threads, 2);
  d.step(9000, {}, true, 60000);
  assert.equal(d.tuner.reason, 'timer-gap');
  assert.equal(d.tuner.best.rate, 0);
  d.run(100, 1);
  assert.ok(d.decisions.at(-1).rate < 2 * MiB);
});

test('automatic settings clamp the current level without resetting it to one', () => {
  const d = driver({}, 5);
  d.tuner.updateSettings({ ...d.tuner.settings, maxThreads: 3 }, d.now);
  assert.equal(d.tuner.limit, 3);
  d.tuner.updateSettings({ ...d.tuner.settings, gainPercent: 12 }, d.now);
  assert.equal(d.tuner.limit, 3);
});

test('penalties preserve the user manual preference and invalidate probe history', () => {
  const d = driver({ threads: 5 }, 4);
  d.run(14, n => n); d.tuner.penalize(d.now);
  assert.ok(d.tuner.limit <= 2);
  assert.equal(d.tuner.settings.threads, 5);
  assert.equal(d.tuner.phase, 'baseline');
  assert.equal(d.tuner.best.rate, 0);
});

test('manual mode never tunes and a return to auto drops stale probe evidence', () => {
  const d = driver({ threads: 4 }); d.run(14, 1);
  d.tuner.updateSettings({ ...d.tuner.settings, auto: false }, d.now);
  const count = d.decisions.length;
  d.run(60, 9999);
  assert.equal(d.decisions.length, count);
  d.tuner.updateSettings({ ...d.tuner.settings, threads: 3 }, d.now);
  d.tuner.updateSettings({ ...d.tuner.settings, auto: true }, d.now);
  assert.equal(d.tuner.limit, 3);
  assert.equal(d.tuner.best.rate, 0);
  assert.equal(d.tuner.probe, null);
});

test('a slow drain preserves a pending baseline confirmation', () => {
  const d = driver({ maxThreads: 2 });
  for (let i = 0; i < 100 && d.tuner.phase !== 'confirm'; i++) d.step(d.tuner.limit);
  assert.equal(d.tuner.phase, 'confirm');
  for (let i = 0; i < 20; i++) d.step(9, { reason: 'draining', active: 2 }, false);
  assert.equal(d.tuner.phase, 'confirm');
  assert.ok(d.tuner.probe.candidate);
  d.run(30, n => n);
  assert.equal(d.tuner.best.threads, 2);
});

test('degraded conditions can confirm a lower level without losing the drain probe', () => {
  const d = driver({ maxThreads: 3 }, 3); d.run(15, 3);
  assert.equal(d.tuner.phase, 'hold');
  for (let i = 0; i < 30 && d.tuner.phase !== 'probe'; i++) d.step(1);
  assert.equal(d.tuner.limit, 2);
  for (let i = 0; i < 10; i++) d.step(1, { reason: 'draining', active: 3 }, false);
  assert.equal(d.tuner.limit, 2);
  for (let i = 0; i < 80 && d.tuner.best.threads !== 2; i++) d.step(d.tuner.limit === 2 ? 2 : 1);
  assert.equal(d.tuner.best.threads, 2);
});

test('one contaminated window cannot promote a slower worker level', () => {
  const d = driver({ maxThreads: 2 });
  d.run(13, 1);
  assert.equal(d.tuner.phase, 'probe');
  // Contaminate exactly one completed measurement window of the slower probe.
  d.run(40, n => n === 1 ? 1 : d.tuner.windows.length === 1 ? 20 : 0.5);
  assert.equal(d.tuner.best.threads, 1);
});
