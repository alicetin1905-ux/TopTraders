#!/usr/bin/env node
/**
 * Builds the trader snapshots the dashboard loads on start.
 *
 * Runs in CI (and locally) rather than the browser because two things can't be
 * done client-side: Hyperliquid's leaderboard is a ~37MB payload, and OKX sends
 * no CORS headers. Everything written here is re-priced live in the browser.
 *
 * Output: docs/data/snapshot.json, docs/data/meta.json
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as hl from '../docs/js/venues/hyperliquid.js';
import * as gmx from '../docs/js/venues/gmx.js';
import * as okx from '../docs/js/venues/okx.js';
import * as htx from '../docs/js/venues/htx.js';
import * as bitget from '../docs/js/venues/bitget.js';
import { diffSnapshots, mergeFeed } from './lib/diff.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'docs/data');

// Tunables: keep the snapshot small enough to load instantly on mobile.
const HL_CANDIDATES = Number(process.env.HL_CANDIDATES || 220);
const HL_KEEP = Number(process.env.HL_KEEP || 60);
const GMX_KEEP = Number(process.env.GMX_KEEP || 40);
const OKX_KEEP = Number(process.env.OKX_KEEP || 20);
const HTX_KEEP = Number(process.env.HTX_KEEP || 25);
const HTX_CANDIDATES = Number(process.env.HTX_CANDIDATES || 80);
const BG_KEEP = Number(process.env.BG_KEEP || 25);
const BG_CANDIDATES = Number(process.env.BG_CANDIDATES || 60);
const CONCURRENCY = Number(process.env.CONCURRENCY || 8);
// Where the last deploy lives. It is the carrier for rolling state now that
// nothing is committed; set to '' to disable and always start fresh.
const SITE_URL = (process.env.SITE_URL ?? 'https://alicetin1905-ux.github.io/TopTraders').replace(/\/$/, '');

const log = (...a) => console.log('[refresh]', ...a);

/** Run tasks with bounded concurrency, tolerating individual failures. */
async function pool(items, worker, limit = CONCURRENCY) {
  const out = [];
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = await worker(items[idx], idx);
      } catch (err) {
        out[idx] = { __error: String(err.message || err) };
      }
    }
  });
  await Promise.all(runners);
  return out;
}

const retry = async (fn, tries = 3, wait = 2000) => {
  let last;
  for (let n = 0; n < tries; n++) {
    try { return await fn(); } catch (e) { last = e; if (n < tries - 1) await new Promise(r => setTimeout(r, wait * (n + 1))); }
  }
  throw last;
};

/* ------------------------------- Hyperliquid ------------------------------ */

async function buildHyperliquid() {
  log('hyperliquid: fetching leaderboard…');
  const rows = await retry(() => hl.fetchLeaderboard());
  log(`hyperliquid: ${rows.length} leaderboard rows`);

  const score = (r) => (r.windows.month?.pnl ?? 0);
  // Accounts far above any real trading book are vaults/bridges; they rank high
  // but hold no perp positions, so cap the account value we consider.
  const candidates = rows
    .filter((r) => r.accountValue > 50_000 && r.accountValue < 500_000_000)
    .sort((a, b) => score(b) - score(a))
    .slice(0, HL_CANDIDATES);

  log(`hyperliquid: probing ${candidates.length} candidates for open positions…`);
  const states = await pool(candidates, (c) => retry(() => hl.fetchTrader(c.address), 2, 1500));

  const traders = [];
  for (let i = 0; i < candidates.length; i++) {
    const st = states[i];
    if (!st || st.__error || !st.positions?.length) continue;
    const c = candidates[i];
    traders.push({
      venue: 'hyperliquid',
      id: c.address,
      address: c.address,
      label: c.displayName || null,
      link: `https://app.hyperliquid.xyz/explorer/address/${c.address}`,
      accountValue: st.accountValue,
      totalNotional: st.totalNotional,
      totalMarginUsed: st.totalMarginUsed,
      pnlDay: c.windows.day?.pnl ?? 0,
      pnlWeek: c.windows.week?.pnl ?? 0,
      pnlMonth: c.windows.month?.pnl ?? 0,
      roiMonth: c.windows.month?.roi ?? 0,
      volumeMonth: c.windows.month?.volume ?? 0,
      positions: st.positions,
    });
    if (traders.length >= HL_KEEP) break;
  }
  log(`hyperliquid: kept ${traders.length} traders with open positions`);
  return traders;
}

/* ----------------------------------- GMX ---------------------------------- */

async function buildGmxChain(chain) {
  log(`gmx/${chain}: metadata…`);
  const { markets, tokens } = await retry(() => gmx.fetchMarkets(chain));
  const marks = await retry(() => gmx.fetchMarks(chain, tokens));
  const ctx = { markets, tokens, marks };

  log(`gmx/${chain}: sweeping open positions…`);
  const rows = await retry(() => gmx.fetchTopPositions(chain, ctx, 50_000, 500));

  // Group the sweep by account so each trader carries their whole book.
  const byAccount = new Map();
  for (const { account, pos } of rows) {
    const key = account.toLowerCase();
    if (!byAccount.has(key)) byAccount.set(key, { address: account, positions: [] });
    byAccount.get(key).positions.push(pos);
  }

  // Enrich with lifetime stats where available.
  let stats = [];
  try {
    stats = await retry(() => gmx.fetchLeaderboard(chain, 1000));
  } catch (e) {
    log(`gmx/${chain}: leaderboard stats unavailable (${e.message})`);
  }
  const statByAddr = new Map(stats.map((s) => [s.address.toLowerCase(), s]));

  const traders = [...byAccount.values()]
    .map((t) => {
      const repriced = t.positions.map((p) => gmx.reprice(p, marks[p.coin]));
      const totalNotional = repriced.reduce((a, p) => a + p.value, 0);
      const totalMarginUsed = repriced.reduce((a, p) => a + p.marginUsed, 0);
      const uPnl = repriced.reduce((a, p) => a + p.unrealizedPnl, 0);
      const s = statByAddr.get(t.address.toLowerCase());
      return {
        venue: 'gmx',
        chain,
        id: `${chain}:${t.address}`,
        address: t.address,
        label: null,
        link: `https://app.gmx.io/#/accounts/${t.address}`,
        accountValue: totalMarginUsed + uPnl,
        totalNotional,
        totalMarginUsed,
        pnlDay: 0,
        pnlWeek: 0,
        pnlMonth: s?.realizedPnl ?? 0,
        roiMonth: 0,
        volumeMonth: s?.volume ?? 0,
        winRate: s?.winRate ?? null,
        trades: s?.trades ?? null,
        positions: repriced,
      };
    })
    .sort((a, b) => b.totalNotional - a.totalNotional)
    .slice(0, GMX_KEEP);

  log(`gmx/${chain}: kept ${traders.length} traders`);
  return traders;
}

/* ----------------------------------- OKX ---------------------------------- */

async function buildOkx() {
  log('okx: lead traders…');
  const leaders = await retry(() => okx.fetchLeaderboard(OKX_KEEP));
  const states = await pool(leaders, (l) => retry(() => okx.fetchTrader(l.uniqueCode), 2, 1500), 4);

  const traders = [];
  for (let i = 0; i < leaders.length; i++) {
    const st = states[i];
    const l = leaders[i];
    if (!st || st.__error || !st.positions?.length) continue;
    traders.push({
      venue: 'okx',
      id: l.uniqueCode,
      address: l.uniqueCode,
      label: l.nickName,
      link: `https://www.okx.com/copy-trading/account/${l.uniqueCode}`,
      accountValue: l.aum || st.accountValue,
      totalNotional: st.totalNotional,
      totalMarginUsed: st.totalMarginUsed,
      pnlDay: 0,
      pnlWeek: 0,
      pnlMonth: l.pnl,
      roiMonth: l.pnlRatio,
      volumeMonth: 0,
      aum: l.aum,
      copyTraders: l.copyTraders,
      positions: st.positions,
    });
  }
  log(`okx: kept ${traders.length} traders`);
  return traders;
}

/* ----------------------------------- HTX ---------------------------------- */

async function buildHtx() {
  log('htx: contract table + lead traders\u2026');
  const [contracts, leaders] = await Promise.all([
    retry(() => htx.fetchContracts()),
    retry(() => htx.fetchLeaderboard(HTX_CANDIDATES)),
  ]);
  log(`htx: probing ${leaders.length} lead traders for open positions\u2026`);
  const states = await pool(leaders, (l) => retry(() => htx.fetchTrader(l.userSign, contracts), 2, 1500), 5);

  const traders = [];
  for (let i = 0; i < leaders.length; i++) {
    const st = states[i];
    const l = leaders[i];
    if (!st || st.__error || !st.positions?.length) continue;
    traders.push({
      venue: 'htx',
      id: l.userSign,
      address: l.userSign,
      label: l.nickName,
      link: `https://www.htx.com/en-us/copytrading/futures/trader/${l.userSign}`,
      accountValue: l.traderAsset || l.aum || st.accountValue,
      totalNotional: st.totalNotional,
      totalMarginUsed: st.totalMarginUsed,
      pnlDay: 0,
      pnlWeek: 0,
      pnlMonth: l.profit,
      roiMonth: l.profitRate,
      volumeMonth: 0,
      winRate: l.winRate,
      aum: l.aum,
      copyTraders: l.copyUserNum,
      positions: st.positions,
    });
  }
  traders.sort((a, b) => b.totalNotional - a.totalNotional);
  const kept = traders.slice(0, HTX_KEEP);
  log(`htx: kept ${kept.length} traders with open positions`);
  return kept;
}

/* --------------------------------- Bitget --------------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function buildBitget() {
  log('bitget: marks + lead traders\u2026');
  const [marks, leaders] = await Promise.all([
    retry(() => bitget.fetchMarks()),
    retry(() => bitget.fetchLeaderboard(BG_CANDIDATES)),
  ]);
  log(`bitget: probing ${leaders.length} lead traders (throttled)\u2026`);

  // Bitget answers bursts with HTTP 429, so walk the roster serially.
  const traders = [];
  for (const l of leaders) {
    await sleep(700);
    let st;
    try {
      st = await retry(() => bitget.fetchTrader(l.traderUid, marks), 2, 3000);
    } catch { continue; }
    if (!st.positions.length) continue;
    traders.push({
      venue: 'bitget',
      id: l.traderUid,
      address: l.traderUid,
      label: l.nickName,
      link: `https://www.bitget.com/copy-trading/futures-trader-v1/${l.traderUid}`,
      accountValue: l.totalEquity || l.aum || st.accountValue,
      totalNotional: st.totalNotional,
      totalMarginUsed: st.totalMarginUsed,
      pnlDay: 0,
      pnlWeek: 0,
      pnlMonth: 0,
      roiMonth: 0,
      volumeMonth: 0,
      copyTraders: l.followCount,
      positions: st.positions,
    });
  }
  traders.sort((a, b) => b.totalNotional - a.totalNotional);
  const kept = traders.slice(0, BG_KEEP);
  log(`bitget: kept ${kept.length} traders with open positions`);
  return kept;
}

/* ---------------------------------- main ---------------------------------- */

async function main() {
  const started = Date.now();
  const sources = {};

  const tasks = [
    ['hyperliquid', buildHyperliquid()],
    ['gmx:arbitrum', buildGmxChain('arbitrum')],
    ['gmx:avalanche', buildGmxChain('avalanche')],
    ['okx', buildOkx()],
    ['htx', buildHtx()],
    ['bitget', buildBitget()],
  ];

  const results = await Promise.allSettled(tasks.map(([, p]) => p));
  let traders = [];
  results.forEach((r, idx) => {
    const name = tasks[idx][0];
    if (r.status === 'fulfilled') {
      sources[name] = { ok: true, traders: r.value.length };
      traders = traders.concat(r.value);
    } else {
      sources[name] = { ok: false, error: String(r.reason?.message || r.reason) };
      console.error(`[refresh] ${name} FAILED:`, r.reason?.message || r.reason);
    }
  });

  if (!traders.length) throw new Error('every source failed; refusing to write an empty snapshot');

  const positions = traders.reduce((a, t) => a + t.positions.length, 0);
  const snapshot = { generatedAt: Date.now(), sources, traders };

  // The previous tick used to come from a committed file, which grew the repo by
  // ~72KB per refresh forever. The published site is the same data and costs
  // nothing to keep, so read state from there and commit nothing.
  const readJson = async (f, fallback) => {
    try {
      return JSON.parse(await readFile(`${OUT}/${f}`, 'utf8'));
    } catch { /* not on disk (CI checkout, or first local run) -- try the site */ }
    if (!SITE_URL) return fallback;
    try {
      const res = await fetch(`${SITE_URL}/data/${f}?t=${Date.now()}`, {
        headers: { 'Cache-Control': 'no-cache' },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      log(`previous ${f}: loaded from ${SITE_URL}`);
      return body;
    } catch (err) {
      log(`previous ${f}: unavailable (${err.message}) -- starting fresh`);
      return fallback;
    }
  };
  const prev = await readJson('snapshot.json', null);
  let events = [];
  try {
    // Only diff venues that came back healthy: a source that failed this tick
    // would otherwise read as every one of its traders closing at once.
    const healthy = new Set(Object.entries(sources)
      .filter(([, v]) => v.ok).map(([k]) => k.split(':')[0]));
    const scope = (snap) => (snap
      ? { ...snap, traders: (snap.traders || []).filter((t) => healthy.has(t.venue)) }
      : snap);
    events = diffSnapshots(scope(prev), scope(snapshot), snapshot.generatedAt);
  } catch (err) {
    console.error('[refresh] diff failed (continuing):', err.message);
  }
  const feed = mergeFeed((await readJson('changes.json', { events: [] })).events, events);
  await mkdir(OUT, { recursive: true });
  await writeFile(`${OUT}/changes.json`, JSON.stringify({ updatedAt: snapshot.generatedAt, events: feed }));
  log(`changes: +${events.length} this tick, ${feed.length} in feed`);
  const meta = {
    generatedAt: snapshot.generatedAt,
    durationMs: Date.now() - started,
    sources,
    totals: {
      traders: traders.length,
      positions,
      changesThisTick: events.length,
      notional: traders.reduce((a, t) => a + (t.totalNotional || 0), 0),
    },
  };

  await mkdir(OUT, { recursive: true });
  await writeFile(`${OUT}/snapshot.json`, JSON.stringify(snapshot));
  await writeFile(`${OUT}/meta.json`, JSON.stringify(meta, null, 2));

  log(`wrote ${traders.length} traders / ${positions} positions in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  log('sources:', JSON.stringify(sources));
}

main().catch((err) => {
  console.error('[refresh] fatal:', err);
  process.exit(1);
});
