'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runPool } = require('../noty-folder-downloader.user.js');

// Use virtual request completion times with the production scheduler.
async function scanTree({ chain = false, count = 21, latency = 1000, delay = 200, limit = 5 } = {}) {
  const queue = [0], starts = [], timers = [], visited = new Set();
  let now = 0, ended = false, peak = 0, requests = 0;
  const wait = ms => new Promise(resolve => timers.push({ at: now + ms, resolve }));
  const run = runPool({ queue, limit: () => limit, paused: () => false, delayMs: () => delay, now: () => now, wait,
    worker: async id => {
      starts.push({ id, at: now });
      requests++; peak = Math.max(peak, requests);
      await wait(latency); requests--;
      if (chain && id + 1 < count) queue.push(id + 1);
      if (!chain && id === 0) queue.push(...Array.from({ length: count - 1 }, (_, i) => i + 1));
    },
    complete: id => visited.add(id), failed: error => { throw error; }
  }).finally(() => { ended = true; });
  while (!ended) {
    await new Promise(resolve => setImmediate(resolve));
    if (ended) break;
    assert.ok(timers.length);
    timers.sort((a, b) => a.at - b.at); now = timers[0].at;
    assert.ok(now < 1000000);
    while (timers.length && timers[0].at <= now) timers.shift().resolve();
  }
  await run;
  assert.equal(visited.size, count); assert.equal(starts.length, count);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i].at - starts[i - 1].at >= delay);
  return { ms: now, peak };
}

test('wide folder tree fills all five slots when requests are slower than launch pacing', async () => {
  const result = await scanTree();
  assert.equal(result.peak, 5); assert.equal(result.ms, 5800);
});

test('fast listings are launch-rate limited, not starved by the worker pool', async () => {
  const paced = await scanTree({ latency: 100 });
  const unpaced = await scanTree({ latency: 100, delay: 0 });
  assert.equal(paced.peak, 1); assert.equal(paced.ms, 4100);
  assert.equal(unpaced.peak, 5); assert.equal(unpaced.ms, 500);
  console.log(JSON.stringify({ scenario: '21 fast folder listings, five slots', paced, unpaced }));
});

test('a nested directory chain has one available request regardless of the configured limit', async () => {
  const one = await scanTree({ chain: true, limit: 1 });
  const five = await scanTree({ chain: true });
  assert.equal(five.peak, 1); assert.equal(five.ms, one.ms); assert.equal(five.ms, 21000);
});
