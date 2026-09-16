#!/usr/bin/env node
/**
 * Seeds docs/data/changes.json from the snapshot history already in git.
 *
 * Without this the activity feed sits empty until enough refreshes have run to
 * produce a second data point. Every snapshot the refresh job has committed is
 * a real observation, so walking that history back-fills a genuine feed.
 *
 * Usage: node scripts/backfill-changes.mjs [maxCommits]
 */

import { execFileSync } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { diffSnapshots, mergeFeed } from './lib/diff.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'docs/data');
const FILE = 'docs/data/snapshot.json';
const MAX = Number(process.argv[2] || 40);

const git = (...args) => execFileSync('git', args, { cwd: ROOT, maxBuffer: 512 * 1024 * 1024 });

const shas = git('log', '--format=%H', `-${MAX}`, '--', FILE)
  .toString().trim().split('\n').filter(Boolean).reverse(); // oldest first

console.log(`[backfill] ${shas.length} historical snapshots`);
if (shas.length < 2) {
  console.log('[backfill] need at least two snapshots; nothing to do');
  process.exit(0);
}

let feed = [];
let prev = null;
let pairs = 0;

for (const sha of shas) {
  let snap;
  try {
    snap = JSON.parse(git('show', `${sha}:${FILE}`).toString());
  } catch {
    continue; // snapshot absent or unparseable at this commit
  }
  if (prev) {
    // Only compare venues present in both, so adding a venue does not read as
    // a burst of opens, nor removing one as a burst of closes.
    const common = new Set(
      [...new Set((prev.traders || []).map((t) => t.venue))]
        .filter((v) => (snap.traders || []).some((t) => t.venue === v)));
    const scope = (s) => ({ ...s, traders: (s.traders || []).filter((t) => common.has(t.venue)) });
    const events = diffSnapshots(scope(prev), scope(snap), snap.generatedAt);
    if (events.length) {
      // mergeFeed prepends, and we walk oldest -> newest, so the result ends
      // up newest-first exactly as the UI expects.
      feed = mergeFeed(feed, events);
      pairs++;
      console.log(`[backfill] ${new Date(snap.generatedAt).toISOString()} -> +${events.length}`);
    }
  }
  prev = snap;
}

await mkdir(OUT, { recursive: true });
await writeFile(`${OUT}/changes.json`,
  JSON.stringify({ updatedAt: prev?.generatedAt || Date.now(), events: feed }));
console.log(`[backfill] wrote ${feed.length} events from ${pairs} snapshot pairs`);
