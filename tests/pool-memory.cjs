'use strict';
// Isolated V8 heap check: one unfinished transfer alongside thousands of short ones.
const { queryObjects } = require('node:v8');
const { runPool } = require('../noty-folder-downloader.user.js');
const turn = () => new Promise(resolve => setImmediate(resolve));
const idle = process.argv.includes('--idle');
let release, completed = 0, ticks = 0;
const samples = [];
runPool({ queue: Array.from({ length: idle ? 1 : 8001 }, (_, i) => i), limit: () => 2,
  paused: () => false, wait: turn,
  worker: id => id === 0 ? new Promise(resolve => { release = resolve; }) : turn(),
  complete: () => { completed++; }, failed: error => { throw error; },
  tick: () => {
    const steps = idle ? ++ticks : completed;
    if ((steps === 1000 || steps === 8000) && !samples.some(s => s.steps === steps)) {
      samples.push({ steps, promises: queryObjects(Promise, { format: 'count' }) });
      if (steps === 8000) release();
    }
  }
}).then(() => process.stdout.write(JSON.stringify(samples)), error => { throw error; });
