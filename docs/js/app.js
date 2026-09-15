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

const PRICE_POLL_MS = 15_000;
const SNAPSHOT_POLL_MS = 10 * 60_000;

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

function positionsTable(trader) {
  const venue = VENUE_BY_ID[trader.venue];
  const wrap = el('div', 'detail-inner');

  if (venue?.note) wrap.append(el('div', 'venue-note', venue.note));

  const table = el('table');
  const thead = el('thead');
  const hr = el('tr');
  for (const [label, cls] of [
    ['Coin', 'l'], ['Side', 'l'], ['Size', ''], ['Entry', ''], ['Mark', ''],
    ['Value', ''], ['Unreal. PnL', ''], ['ROE', ''], ['Margin', ''], ['Lev.', ''], ['Liq.', ''], ['Funding', ''],
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
    cell(p.leverage ? `${p.leverage.toFixed(1)}×` : '—');
    cell(p.liquidationPx ? price(p.liquidationPx) : '—');
    cell(p.fundingSinceOpen === undefined ? '—' : usd(p.fundingSinceOpen, { compact: true, sign: true }),
      p.fundingSinceOpen === undefined ? '' : cls(p.fundingSinceOpen));

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
  dot.className = `dot${stale || state.priceError ? ' stale' : ''}`;
  if (state.priceError && !state.lastPrice) {
    txt.textContent = state.priceError;
  } else if (state.lastPrice) {
    txt.textContent = `${stale ? 'stale' : 'live'} · prices ${ago(state.lastPrice)} · snapshot ${ago(state.generatedAt)}`
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
  renderCrowd(rows);
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
  $('#refreshBtn').addEventListener('click', async () => {
    $('#refreshBtn').disabled = true;
    try { await loadSnapshot(); await pollPrices(); } catch (e) { state.error = e.message; }
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
  } catch (e) {
    state.error = 'snapshot unavailable';
    render();
    return;
  }
  renderFooter();
  render();
  await loadGmxContext();
  await pollPrices();
  setInterval(pollPrices, PRICE_POLL_MS);
  setInterval(() => loadSnapshot().then(renderFooter).catch(() => {}), SNAPSHOT_POLL_MS);
  setInterval(renderStatus, 5000);
}

boot();
