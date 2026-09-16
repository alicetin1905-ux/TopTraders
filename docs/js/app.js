/**
 * TopTraders dashboard.
 *
 * Boot: load the snapshot the refresh job committed (traders + their books).
 * Live: poll mid/oracle prices and re-price every position locally, which keeps
 *       PnL, notional and ROE current using ~3 requests instead of one per trader.
 * Deep: when a row is expanded, re-pull that trader's actual book so newly
 *       opened or closed positions appear, not just new prices.
 */

import * as hl from './venues/hyperliquid.js';
import * as gmx from './venues/gmx.js';
import { VENUES, VENUE_BY_ID, UNSUPPORTED } from './venues/index.js';
import { usd, price, qty, pct, shortAddr, ago, cls } from './format.js';
import { liquidationLadder, coinsWithLiquidations } from './liquidation.js';
import { createFillStream } from './venues/hyperliquid-ws.js';

const PRICE_POLL_MS = 15_000;
const SNAPSHOT_POLL_MS = 10 * 60_000;
// GitHub's scheduler is best-effort, so a snapshot can age well past its cron.
const SNAPSHOT_STALE_MS = 45 * 60_000;
// Hyperliquid caps a socket at 15 tracked users; two sockets reach ~85% of its
// notional, which is the bulk of everything tracked.
const TAPE_TRADERS = 30;
const TAPE_CAP = 300;

const state = {
  traders: [],
  generatedAt: 0,
  sources: {},
  marks: { hyperliquid: {}, gmx_arbitrum: {}, gmx_avalanche: {} },
  gmxCtx: {},
  venueFilter: new Set(VENUES.map((v) => v.id)),
  search: '',
  sort: 'notional',
  sortDir: -1,
  minSize: 0,
  expanded: new Set(),
  events: [],
  liqCoin: null,
  feedMode: 'snapshot',
  tape: [],
  stream: null,
  streamStatus: null,
  lastPrice: 0,
  priceError: null,
  error: null,
};

const $ = (s) => document.querySelector(s);
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt !== undefined) n.textContent = txt;
  return n;
};

/* ----------------------------- live repricing ----------------------------- */

/** Apply the newest marks to a trader's book without mutating the snapshot. */
function repriced(trader) {
  const positions = trader.positions.map((p) => {
    if (trader.venue === 'hyperliquid') {
      const m = state.marks.hyperliquid[p.coin];
      return m ? hl.reprice(p, m) : p;
    }
    if (trader.venue === 'gmx') {
      const m = state.marks[`gmx_${trader.chain}`]?.[p.coin];
      return m ? gmx.reprice(p, m) : p;
    }
    return p; // OKX: no browser-reachable price feed, snapshot values stand.
  });

  const totalNotional = positions.reduce((a, p) => a + (p.value || 0), 0);
  const upnl = positions.reduce((a, p) => a + (p.unrealizedPnl || 0), 0);
  const totalMarginUsed = positions.reduce((a, p) => a + (p.marginUsed || 0), 0);
  return { ...trader, positions, totalNotional, totalMarginUsed, upnl };
}

async function pollPrices() {
  const jobs = [];

  jobs.push(hl.fetchMarks().then((m) => { state.marks.hyperliquid = m; }));

  for (const chain of ['arbitrum', 'avalanche']) {
    const ctx = state.gmxCtx[chain];
    if (!ctx) continue;
    jobs.push(gmx.fetchMarks(chain, ctx.tokens).then((m) => { state.marks[`gmx_${chain}`] = m; }));
  }

  const results = await Promise.allSettled(jobs);
  const ok = results.filter((r) => r.status === 'fulfilled').length;

  // Only claim "live" if a feed actually answered; a silent catch here would
  // leave the header saying live while every price on screen was frozen.
  if (ok > 0) {
    state.lastPrice = Date.now();
    state.priceError = ok < results.length ? 'some price feeds unreachable' : null;
  } else {
    state.priceError = 'price feeds unreachable — showing snapshot values';
  }
  render();
}

/** GMX repricing needs token decimals; fetch that metadata once per chain. */
async function loadGmxContext() {
  const chains = [...new Set(state.traders.filter((t) => t.venue === 'gmx').map((t) => t.chain))];
  await Promise.all(chains.map(async (chain) => {
    try { state.gmxCtx[chain] = await gmx.fetchMarkets(chain); } catch { /* prices simply won't refresh */ }
  }));
}

/* -------------------------------- snapshot -------------------------------- */

async function loadSnapshot() {
  const res = await fetch(`data/snapshot.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`snapshot HTTP ${res.status}`);
  const s = await res.json();
  state.traders = s.traders || [];
  state.generatedAt = s.generatedAt;
  state.sources = s.sources || {};
}

/** The change feed is optional: the dashboard still works without it. */
async function loadChanges() {
  try {
    const res = await fetch(`data/changes.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const c = await res.json();
    state.events = c.events || [];
  } catch { /* feed stays empty */ }
}

/** Re-pull one trader's live book (catches opens/closes, not just price moves). */
async function refreshTrader(trader) {
  try {
    if (trader.venue === 'hyperliquid') {
      const st = await hl.fetchTrader(trader.address);
      Object.assign(trader, {
        positions: st.positions,
        accountValue: st.accountValue,
        totalMarginUsed: st.totalMarginUsed,
      });
    } else if (trader.venue === 'gmx') {
      const ctx = state.gmxCtx[trader.chain];
      if (!ctx) return;
      const st = await gmx.fetchTrader(trader.chain, trader.address, {
        ...ctx, marks: state.marks[`gmx_${trader.chain}`] || {},
      });
      Object.assign(trader, { positions: st.positions, totalMarginUsed: st.totalMarginUsed });
    }
    render();
  } catch { /* keep showing snapshot values */ }
}

/* -------------------------------- derive ---------------------------------- */

function visibleTraders() {
  const q = state.search.trim().toLowerCase();
  let rows = state.traders
    .filter((t) => state.venueFilter.has(t.venue))
    .map(repriced)
    .filter((t) => t.totalNotional >= state.minSize);

  if (q) {
    rows = rows.filter((t) =>
      (t.address || '').toLowerCase().includes(q) ||
      (t.label || '').toLowerCase().includes(q) ||
      t.positions.some((p) => (p.coin || '').toLowerCase().includes(q)));
  }

  const key = {
    notional: (t) => t.totalNotional,
    upnl: (t) => t.upnl,
    account: (t) => t.accountValue,
    pnlMonth: (t) => t.pnlMonth || 0,
    positions: (t) => t.positions.length,
  }[state.sort];

  return rows.sort((a, b) => (key(a) - key(b)) * state.sortDir);
}

/** Net long/short notional per coin across everything currently visible. */
function crowdExposure(rows) {
  const by = new Map();
  for (const t of rows) {
    for (const p of t.positions) {
      if (!p.coin || !p.value) continue;
      const e = by.get(p.coin) || { coin: p.coin, long: 0, short: 0, traders: 0 };
      if (p.side === 'LONG') e.long += p.value; else e.short += p.value;
      e.traders++;
      by.set(p.coin, e);
    }
  }
  return [...by.values()]
    .map((e) => ({ ...e, total: e.long + e.short, net: e.long - e.short }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);
}

/* --------------------------------- render --------------------------------- */

function renderTiles(rows) {
  const positions = rows.reduce((a, t) => a + t.positions.length, 0);
  const notional = rows.reduce((a, t) => a + t.totalNotional, 0);
  const upnl = rows.reduce((a, t) => a + t.upnl, 0);
  let long = 0, short = 0;
  for (const t of rows) for (const p of t.positions) {
    if (!p.value) continue;
    if (p.side === 'LONG') long += p.value; else short += p.value;
  }
  const skew = long + short > 0 ? long / (long + short) : 0;

  const tiles = [
    { k: 'Traders tracked', v: String(rows.length), note: (() => {
      const n = VENUES.filter((v) => state.venueFilter.has(v.id)).length;
      return `${n} exchange${n === 1 ? '' : 's'} selected`;
    })() },
    { k: 'Open positions', v: String(positions), note: 'across all tracked books' },
    { k: 'Total notional', v: usd(notional, { compact: true }), note: 'sum of position value' },
    { k: 'Unrealised PnL', v: usd(upnl, { compact: true, sign: true }), note: 'live, marked to market', cls: cls(upnl) },
    { k: 'Long / short skew', v: `${(skew * 100).toFixed(0)} / ${(100 - skew * 100).toFixed(0)}`, note: 'share of notional that is long' },
  ];

  const box = $('#tiles');
  box.textContent = '';
  for (const t of tiles) {
    const d = el('div', 'tile');
    d.append(el('div', 'k', t.k));
    d.append(el('div', `v ${t.cls || ''}`, t.v));
    d.append(el('div', 'note', t.note));
    box.append(d);
  }
}

const ACTIONS = {
  OPENED:    { glyph: '+', label: 'OPENED',  cls: 'up' },
  INCREASED: { glyph: '+', label: 'ADDED',   cls: 'up' },
  REDUCED:   { glyph: '\u2212', label: 'CUT', cls: 'down' },
  CLOSED:    { glyph: '\u2212', label: 'CLOSED', cls: 'down' },
  FLIPPED:   { glyph: '\u21c4', label: 'FLIPPED', cls: 'flip' },
};

function renderFeed() {
  const box = $('#feed');
  box.textContent = '';

  const q = state.search.trim().toLowerCase();
  const rows = state.events.filter((e) => state.venueFilter.has(e.venue) && (!q
    || (e.trader || '').toLowerCase().includes(q)
    || (e.coin || '').toLowerCase().includes(q))).slice(0, 60);

  $('#activityCount').textContent = state.events.length
    ? `${rows.length} shown of ${state.events.length}`
    : '';

  if (!rows.length) {
    box.append(el('div', 'empty',
      state.events.length
        ? 'No activity matches these filters.'
        : 'No activity recorded yet — the feed fills in as snapshots are compared.'));
    return;
  }

  for (const e of rows) {
    const a = ACTIONS[e.type] || { glyph: '\u00b7', label: e.type, cls: 'down' };
    const row = el('div', 'fevt');

    row.append(el('div', 'when', ago(e.ts)));
    row.append(el('div', `act ${a.cls}`, `${a.glyph} ${a.label}`));

    const who = el('div', 'who2');
    const name = e.trader ? shortAddr(e.trader) : '—';
    if (e.link) {
      const link = el('a', null, name);
      link.href = e.link; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.title = e.trader;
      who.append(link);
    } else {
      const sp = el('span', 'nolink', name);
      sp.title = e.trader || '';
      who.append(sp);
    }
    const venue = VENUE_BY_ID[e.venue];
    const b = el('span', 'vbadge', venue ? venue.code : e.venue);
    b.title = venue ? `${venue.name} — ${venue.kind}` : e.venue;
    who.append(b);
    row.append(who);

    row.append(el('div', 'coin2', e.coin || '—'));

    const sideCell = el('div');
    sideCell.append(el('span', `side ${e.side}`, e.side));
    if (e.type === 'FLIPPED' && e.fromSide) sideCell.title = `was ${e.fromSide}`;
    row.append(sideCell);

    const val = el('div', 'val2', usd(e.value, { compact: true }));
    val.title = e.entryPx ? `entry ${price(e.entryPx)}${e.leverage ? ` · ${e.leverage.toFixed(1)}×` : ''}` : '';
    row.append(val);

    row.append(el('div', 'delta',
      e.deltaPct === undefined ? '' : `${e.deltaPct > 0 ? '+' : ''}${(e.deltaPct * 100).toFixed(0)}%`));

    box.append(row);
  }
}

function renderLiquidation(rows) {
  const coins = coinsWithLiquidations(rows);
  const sel = $('#liqCoin');
  const panel = $('#liqPanel');

  if (!coins.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  // Keep the chosen coin if it still has data, else fall back to the largest.
  if (!state.liqCoin || !coins.some((c) => c.coin === state.liqCoin)) {
    state.liqCoin = coins[0].coin;
  }
  const wanted = coins.map((c) => c.coin).join(',');
  if (sel.dataset.coins !== wanted) {
    sel.dataset.coins = wanted;
    sel.textContent = '';
    for (const c of coins) {
      const o = el('option', null, `${c.coin} — ${usd(c.value, { compact: true })}`);
      o.value = c.coin;
      sel.append(o);
    }
  }
  sel.value = state.liqCoin;

  const L = liquidationLadder(rows, state.liqCoin);
  const ladder = $('#ladder');
  ladder.textContent = '';
  if (!L) return;

  const dist = (p) => (p ? `${(((p.liqPx - L.mark) / L.mark) * 100).toFixed(1)}%` : '—');
  const sum = $('#liqSummary');
  sum.textContent = '';
  for (const [k, v, c] of [
    ['Mark price', price(L.mark), ''],
    ['Nearest long liq.', L.nearestLong ? `${price(L.nearestLong.liqPx)} (${dist(L.nearestLong)})` : '—', 'pos-long'],
    ['Nearest short liq.', L.nearestShort ? `${price(L.nearestShort.liqPx)} (+${dist(L.nearestShort)})` : '—', 'pos-short'],
    ['Mapped notional', usd(L.covered.value, { compact: true }), ''],
  ]) {
    const d = el('div');
    d.append(el('div', 'k2', k));
    const val = el('div', 'v2', v);
    if (c === 'pos-long') val.style.color = 'var(--long)';
    if (c === 'pos-short') val.style.color = 'var(--short)';
    d.append(val);
    sum.append(d);
  }

  const up = L.rows.filter((r) => r.dir === 'up');
  const down = L.rows.filter((r) => r.dir === 'down');

  const addRow = (r) => {
    const row = el('div', 'lrow');
    row.append(el('div', 'band', `${r.pct > 0 ? '+' : ''}${r.pct}%`));
    row.append(el('div', 'lpx', price(r.price)));

    const track = el('div', 'ltrack');
    // No bar at all when nothing liquidates: min-width would otherwise paint a
    // sliver that reads as a small non-zero amount.
    if (r.notional > 0 && L.max > 0) {
      const fill = el('div', `lfill ${r.dir === 'up' ? 's' : 'l'}`);
      fill.style.width = `${Math.max((r.notional / L.max) * 100, 1.5)}%`;
      track.append(fill);
    }
    track.title = `${r.count} ${r.side.toLowerCase()} position(s) liquidated by ${price(r.price)} — ${usd(r.notional)}`;
    row.append(track);

    row.append(el('div', `lval${r.notional > 0 ? '' : ' zero'}`, usd(r.notional, { compact: true })));
    ladder.append(row);
  };

  up.forEach(addRow);

  const markRow = el('div', 'lmark');
  markRow.append(el('div', 'band', 'now'));
  markRow.append(el('div', 'now', price(L.mark)));
  markRow.append(el('div', 'rule'));
  markRow.append(el('div'));
  ladder.append(markRow);

  down.forEach(addRow);

  const total = L.covered.value + L.uncovered.value;
  $('#liqCoverage').textContent =
    `Mapped ${L.covered.count} of ${L.covered.count + L.uncovered.count} tracked ${state.liqCoin} positions `
    + `(${usd(L.covered.value, { compact: true })} of ${usd(total, { compact: true })}). `
    + 'Only Hyperliquid and HTX publish a liquidation price — GMX, OKX and Bitget do not, '
    + 'so this is a floor on real exposure, not the whole market.';
}

/* ------------------------------- trade tape ------------------------------- */

/** Open the live fill stream over the largest Hyperliquid books. */
function startTape() {
  if (state.stream) return;
  const addresses = state.traders
    .filter((t) => t.venue === 'hyperliquid')
    .sort((a, b) => b.totalNotional - a.totalNotional)
    .slice(0, TAPE_TRADERS)
    .map((t) => t.address);
  if (!addresses.length) return;

  // Address -> display name, so the tape can show what the table shows.
  const label = new Map(state.traders.map((t) => [t.address, t.label || t.address]));

  state.stream = createFillStream({
    addresses,
    onFills: (fills) => {
      for (const f of fills) f.trader = label.get(f.address) || f.address;
      state.tape = [...fills, ...state.tape]
        .sort((a, b) => b.ts - a.ts)
        .slice(0, TAPE_CAP);
      if (state.feedMode === 'live') renderTape();
    },
    onStatus: (st) => { state.streamStatus = st; if (state.feedMode === 'live') renderTape(); },
  });
}

/** "Open Long" -> a glyph, a word and the side the fill is on. */
function describeFill(dir) {
  const d = dir || '';
  const side = /long/i.test(d) ? 'LONG' : /short/i.test(d) ? 'SHORT' : null;
  const closing = /close|liquidat/i.test(d);
  return {
    side,
    glyph: closing ? '\u2212' : '+',
    label: d.replace(/^(Open|Close)\s+/i, (m) => m.trim().toUpperCase() + ' '),
    liquidated: /liquidat/i.test(d),
  };
}

function renderTape() {
  const box = $('#tape');
  box.textContent = '';

  const q = state.search.trim().toLowerCase();
  const rows = state.tape.filter((f) => !q
    || (f.trader || '').toLowerCase().includes(q)
    || (f.coin || '').toLowerCase().includes(q)).slice(0, 80);

  const st = state.streamStatus;
  $('#activityCount').textContent = st
    ? `${rows.length} of ${state.tape.length} fills · ${st.connected}/${st.sockets} sockets`
    : 'connecting\u2026';

  if (!rows.length) {
    box.append(el('div', 'empty', st && st.connected
      ? 'Connected \u2014 waiting for the next fill.'
      : 'Connecting to Hyperliquid\u2026'));
    return;
  }

  const now = Date.now();
  for (const f of rows) {
    const d = describeFill(f.dir);
    const row = el('div', 'tapeevt');
    // Only pulse genuinely new fills, not the backfill batch on connect.
    if (!f.isSnapshot && now - f.ts < 30_000) row.classList.add('fresh');

    row.append(el('div', 'when', ago(f.ts)));
    row.append(el('div', 'act', `${d.glyph} ${d.label}`));

    const who = el('div', 'who2');
    const name = el('span', 'nolink', shortAddr(f.trader));
    name.title = f.address;
    who.append(name);
    const b = el('span', 'vbadge', 'HL');
    b.title = 'Hyperliquid — live fill';
    who.append(b);
    row.append(who);

    row.append(el('div', 'coin2', f.coin));

    const sideCell = el('div');
    if (d.side) sideCell.append(el('span', `side ${d.side}`, d.side));
    else sideCell.append(el('span', 'masked', f.dir || '—'));
    row.append(sideCell);

    const szpx = el('div', 'szpx', `${qty(f.size)} @ ${price(f.price)}`);
    szpx.title = `notional ${usd(f.value)}`;
    row.append(szpx);

    // Realized PnL is only meaningful on a close.
    row.append(el('div', `rpnl ${f.closedPnl ? cls(f.closedPnl) : 'flat'}`,
      f.closedPnl ? usd(f.closedPnl, { compact: true, sign: true }) : ''));

    box.append(row);
  }
}

function setFeedMode(mode) {
  state.feedMode = mode;
  const live = mode === 'live';
  $('#modeLive').setAttribute('aria-pressed', live ? 'true' : 'false');
  $('#modeSnapshot').setAttribute('aria-pressed', live ? 'false' : 'true');
  $('#feed').hidden = live;
  $('#tape').hidden = !live;
  $('#tapeNote').hidden = !live;
  $('#activityDesc').textContent = live
    ? '\u2014 actual executions from Hyperliquid, streamed as they happen'
    : '\u2014 positions opened, closed, added to or cut since the last snapshots';
  $('#tapeNote').textContent =
    `Live executions for the ${TAPE_TRADERS} largest Hyperliquid books (~85% of its notional). `
    + 'Hyperliquid caps a socket at 15 tracked users, and only it streams fills publicly, '
    + 'so the other venues appear under snapshot changes. The tape runs only while this page is open.';
  try { localStorage.setItem('tt-feed-mode', mode); } catch { /* private mode */ }
  if (live) { startTape(); renderTape(); } else { render(); }
}

function renderCrowd(rows) {
  const data = crowdExposure(rows);
  const box = $('#bars');
  box.textContent = '';

  if (!data.length) {
    box.append(el('div', 'empty', 'No positions match the current filters.'));
    return;
  }

  const max = Math.max(...data.map((d) => Math.max(d.long, d.short)));
  for (const d of data) {
    const row = el('div', 'bar-row');
    row.append(el('div', 'coin', d.coin));

    const track = el('div', 'bar-track');
    // Two fills meeting at the midpoint, with a 2px surface gap between them.
    const lw = max > 0 ? (d.long / max) * 50 : 0;
    const sw = max > 0 ? (d.short / max) * 50 : 0;
    const l = el('div', 'fill l');
    l.style.right = 'calc(50% + 1px)';
    l.style.width = `calc(${lw}% - 1px)`;
    const s = el('div', 'fill s');
    s.style.left = 'calc(50% + 1px)';
    s.style.width = `calc(${sw}% - 1px)`;
    const mid = el('div', 'axis-mid');
    mid.style.left = '50%';
    track.append(l, s, mid);
    track.title = `${d.coin} — long ${usd(d.long, { compact: true })} · short ${usd(d.short, { compact: true })} · ${d.traders} position(s)`;
    row.append(track);

    const net = el('div', `net ${cls(d.net)}`, usd(d.net, { compact: true, sign: true }));
    net.title = 'Net exposure (long minus short)';
    row.append(net);
    box.append(row);
  }
}

/** Stats the venues report about the trader themselves, where available. */
function traderStats(t) {
  const out = [];
  const add = (k, v, c) => out.push({ k, v, c });
  if (t.pnlDay) add('24h PnL', usd(t.pnlDay, { compact: true, sign: true }), cls(t.pnlDay));
  if (t.pnlWeek) add('7d PnL', usd(t.pnlWeek, { compact: true, sign: true }), cls(t.pnlWeek));
  if (t.pnlMonth) add('30d PnL', usd(t.pnlMonth, { compact: true, sign: true }), cls(t.pnlMonth));
  if (t.roiMonth) add('30d ROI', pct(t.roiMonth, { sign: true }), cls(t.roiMonth));
  if (t.winRate !== undefined && t.winRate !== null) add('Win rate', pct(t.winRate));
  if (t.trades) add('Trades', String(t.trades));
  if (t.volumeMonth) add('30d volume', usd(t.volumeMonth, { compact: true }));
  if (t.aum) add('AUM', usd(t.aum, { compact: true }));
  if (t.copyTraders) add('Copiers', String(t.copyTraders));
  return out;
}

function positionsTable(trader) {
  const venue = VENUE_BY_ID[trader.venue];
  const wrap = el('div', 'detail-inner');

  const stats = traderStats(trader);
  if (stats.length) {
    const strip = el('div', 'tstats');
    for (const st of stats) {
      const d = el('div');
      d.append(el('div', 'k2', st.k));
      d.append(el('div', `v3 ${st.c || ''}`, st.v));
      strip.append(d);
    }
    if (trader.link) {
      const a = el('a', 'tlink', 'Open on venue \u2197');
      a.href = trader.link; a.target = '_blank'; a.rel = 'noopener noreferrer';
      strip.append(a);
    }
    wrap.append(strip);
  }

  if (venue?.note) wrap.append(el('div', 'venue-note', venue.note));

  const table = el('table');
  const thead = el('thead');
  const hr = el('tr');
  for (const [label, cls] of [
    ['Coin', 'l'], ['Side', 'l'], ['Size', ''], ['Entry', ''], ['Mark', ''],
    ['Value', ''], ['Unreal. PnL', ''], ['ROE', ''], ['Margin', ''], ['Lev.', ''], ['Liq.', ''],
    ['Funding', ''], ['Age', ''],
  ]) {
    const th = el('th', cls, label);
    hr.append(th);
  }
  thead.append(hr);
  table.append(thead);

  const tb = el('tbody');
  const sorted = [...trader.positions].sort((a, b) => (b.value || 0) - (a.value || 0));
  for (const p of sorted) {
    const tr = el('tr');
    const cell = (txt, c) => { const td = el('td', c, txt); tr.append(td); return td; };

    if (p.coin) cell(p.coin, 'l');
    else { const td = cell('hidden', 'l'); td.classList.add('masked'); td.title = 'OKX masks the instrument for non-copiers'; }

    const sideTd = el('td', 'l');
    sideTd.append(el('span', `side ${p.side}`, p.side));
    tr.append(sideTd);

    cell(p.size === null || p.size === undefined ? '—' : qty(p.size));
    cell(price(p.entryPx));
    cell(price(p.markPx));
    cell(p.value === null ? '—' : usd(p.value, { compact: true }));
    cell(usd(p.unrealizedPnl, { compact: true, sign: true }), cls(p.unrealizedPnl));
    cell(pct(p.roe, { sign: true }), cls(p.roe));
    cell(usd(p.marginUsed, { compact: true }));
    const levCell = cell(p.leverage ? `${p.leverage.toFixed(1)}×` : '—');
    // Cross vs isolated changes what a loss can actually reach.
    if (p.leverageType) levCell.title = `${p.leverageType} margin`;
    if (p.leverageType === 'isolated') levCell.textContent += ' iso';
    cell(p.liquidationPx ? price(p.liquidationPx) : '—');
    cell(p.fundingSinceOpen === undefined ? '—' : usd(p.fundingSinceOpen, { compact: true, sign: true }),
      p.fundingSinceOpen === undefined ? '' : cls(p.fundingSinceOpen));
    const ageCell = cell(p.openedAt ? ago(p.openedAt).replace(' ago', '') : '—');
    if (p.openedAt) ageCell.title = `opened ${new Date(p.openedAt).toUTCString()}`;

    tb.append(tr);
  }
  table.append(tb);
  wrap.append(table);
  return wrap;
}

function renderTable(rows) {
  const tb = $('#tbody');
  tb.textContent = '';
  $('#traderCount').textContent = `— ${rows.length} shown`;

  if (!rows.length) {
    const tr = el('tr');
    const td = el('td', 'empty', 'No traders match these filters. Try lowering the minimum size.');
    td.colSpan = 9;
    tr.append(td);
    tb.append(tr);
    return;
  }

  rows.forEach((t, i) => {
    const venue = VENUE_BY_ID[t.venue];
    const open = state.expanded.has(t.id);

    const tr = el('tr', 'trader');
    tr.tabIndex = 0;
    tr.setAttribute('aria-expanded', open ? 'true' : 'false');

    const c0 = el('td', 'rank');
    c0.append(el('span', 'caret', '›'));
    tr.append(c0);

    const who = el('td', 'l');
    const box = el('div', 'who');
    box.append(el('span', 'rank', String(i + 1)));
    const label = el('span', t.label ? 'name' : 'addr', t.label || shortAddr(t.address));
    label.title = t.address;
    box.append(label);
    const b = el('span', 'vbadge', venue ? venue.code : t.venue);
    if (t.chain) b.append(document.createTextNode(` · ${t.chain === 'arbitrum' ? 'ARB' : 'AVAX'}`));
    b.title = venue ? `${venue.name} — ${venue.kind}` : t.venue;
    box.append(b);
    who.append(box);
    tr.append(who);

    const cell = (txt, c) => { tr.append(el('td', c, txt)); };
    cell(usd(t.accountValue, { compact: true }), 'hide-xs');
    cell(usd(t.totalNotional, { compact: true }));
    cell(usd(t.totalMarginUsed, { compact: true }), 'hide-sm');
    const lev = t.totalMarginUsed > 0 ? t.totalNotional / t.totalMarginUsed : 0;
    cell(lev ? `${lev.toFixed(1)}×` : '—', 'hide-sm');
    cell(usd(t.upnl, { compact: true, sign: true }), cls(t.upnl));
    cell(t.pnlMonth ? usd(t.pnlMonth, { compact: true, sign: true }) : '—', `hide-sm ${cls(t.pnlMonth)}`);
    cell(String(t.positions.length));

    const toggle = () => {
      if (state.expanded.has(t.id)) state.expanded.delete(t.id);
      else { state.expanded.add(t.id); refreshTrader(state.traders.find((x) => x.id === t.id) || t); }
      render();
    };
    tr.addEventListener('click', (e) => { if (!e.target.closest('a')) toggle(); });
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    tb.append(tr);

    if (open) {
      const dtr = el('tr', 'detail');
      const dtd = el('td');
      dtd.colSpan = 9;
      dtd.append(positionsTable(t));
      dtr.append(dtd);
      tb.append(dtr);
    }
  });
}

function renderStatus() {
  const dot = $('#statusDot');
  const txt = $('#statusText');
  if (state.error) {
    dot.className = 'dot err';
    txt.textContent = state.error;
    return;
  }
  const stale = !state.lastPrice || Date.now() - state.lastPrice > PRICE_POLL_MS * 3;
  const snapStale = state.generatedAt && Date.now() - state.generatedAt > SNAPSHOT_STALE_MS;
  dot.className = `dot${stale || snapStale || state.priceError ? ' stale' : ''}`;
  if (state.priceError && !state.lastPrice) {
    txt.textContent = state.priceError;
  } else if (state.lastPrice) {
    txt.textContent = `${stale ? 'stale' : 'live'} · prices ${ago(state.lastPrice)} · snapshot ${ago(state.generatedAt)}`
      + (snapStale ? ' (positions may have changed)' : '')
      + (state.priceError ? ` · ${state.priceError}` : '');
  } else {
    txt.textContent = `snapshot ${ago(state.generatedAt)}`;
  }
}

function renderFooter() {
  const cov = $('#coverage');
  cov.textContent = '';
  for (const v of VENUES) {
    const src = Object.entries(state.sources).filter(([k]) => k.startsWith(v.id));
    const ok = src.length ? src.every(([, s]) => s.ok) : null;
    const n = src.reduce((a, [, s]) => a + (s.traders || 0), 0);
    const li = el('li');
    li.append(document.createTextNode(`${v.name} (${v.kind}) — `));
    li.append(document.createTextNode(
      ok === null ? 'not in snapshot'
        : ok ? `${n} traders, ${v.live ? 'live in-browser' : 'snapshot only'}`
          : 'source failed on last refresh'));
    cov.append(li);
  }

  const un = $('#unsupported');
  un.textContent = '';
  for (const u of UNSUPPORTED) {
    const li = el('li');
    li.append(el('strong', null, u.name));
    li.append(document.createTextNode(` — ${u.reason}`));
    un.append(li);
  }

  $('#metaLine').textContent = state.generatedAt
    ? `Snapshot built ${new Date(state.generatedAt).toUTCString()}.`
    : '';
}

function render() {
  const rows = visibleTraders();
  renderTiles(rows);
  if (state.feedMode === 'live') renderTape(); else renderFeed();
  renderCrowd(rows);
  renderLiquidation(rows);
  renderTable(rows);
  renderStatus();
}

/* --------------------------------- wiring --------------------------------- */

function buildChips() {
  const box = $('#venueChips');
  box.textContent = '';
  for (const v of VENUES) {
    const b = el('button', 'chip');
    b.type = 'button';
    b.setAttribute('aria-pressed', state.venueFilter.has(v.id) ? 'true' : 'false');
    if (v.code && v.code !== v.name) b.append(el('span', 'vcode', v.code));
    b.append(document.createTextNode(v.name));
    b.title = v.live ? `${v.kind} — positions refresh live in your browser` : `${v.kind} — ${v.note || 'snapshot only'}`;
    b.addEventListener('click', () => {
      if (state.venueFilter.has(v.id)) state.venueFilter.delete(v.id);
      else state.venueFilter.add(v.id);
      b.setAttribute('aria-pressed', state.venueFilter.has(v.id) ? 'true' : 'false');
      render();
    });
    box.append(b);
  }
}

function wire() {
  $('#search').addEventListener('input', (e) => { state.search = e.target.value; render(); });
  $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; render(); });
  $('#minSize').addEventListener('change', (e) => { state.minSize = Number(e.target.value); render(); });
  $('#liqCoin').addEventListener('change', (e) => { state.liqCoin = e.target.value; render(); });
  $('#modeSnapshot').addEventListener('click', () => setFeedMode('snapshot'));
  $('#modeLive').addEventListener('click', () => setFeedMode('live'));
  $('#refreshBtn').addEventListener('click', async () => {
    $('#refreshBtn').disabled = true;
    try { await loadSnapshot(); await loadChanges(); await pollPrices(); } catch (e) { state.error = e.message; }
    $('#refreshBtn').disabled = false;
    render();
  });

  document.querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const k = th.dataset.sort;
      if (state.sort === k) state.sortDir *= -1;
      else { state.sort = k; state.sortDir = -1; }
      $('#sort').value = k;
      render();
    });
  });

  const themeBtn = $('#themeBtn');
  const saved = (() => { try { return localStorage.getItem('tt-theme'); } catch { return null; } })();
  if (saved) document.documentElement.dataset.theme = saved;
  const syncLabel = () => { themeBtn.textContent = document.documentElement.dataset.theme === 'light' ? 'Dark' : 'Light'; };
  syncLabel();
  themeBtn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('tt-theme', next); } catch { /* private mode */ }
    syncLabel();
  });
}

async function boot() {
  buildChips();
  wire();
  try {
    await loadSnapshot();
    await loadChanges();
  } catch (e) {
    state.error = 'snapshot unavailable';
    render();
    return;
  }
  renderFooter();
  render();
  let savedMode = null;
  try { savedMode = localStorage.getItem('tt-feed-mode'); } catch { /* private mode */ }
  setFeedMode(savedMode === 'live' ? 'live' : 'snapshot');
  await loadGmxContext();
  await pollPrices();
  setInterval(pollPrices, PRICE_POLL_MS);
  setInterval(() => loadSnapshot().then(loadChanges).then(() => { renderFooter(); render(); }).catch(() => {}), SNAPSHOT_POLL_MS);
  setInterval(renderStatus, 5000);
}

boot();
