/**
 * Hyperliquid adapter.
 *
 * Hyperliquid is a fully on-chain perp DEX, so every account's positions are
 * public. Two endpoints matter here:
 *   - stats-data.../leaderboard : ranked PnL/ROI/volume per window (~37MB, pipeline only)
 *   - api.../info               : clearinghouseState, allMids (CORS-open, browser safe)
 */

export const INFO_URL = 'https://api.hyperliquid.xyz/info';
export const LEADERBOARD_URL = 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard';

export const meta = {
  id: 'hyperliquid',
  name: 'Hyperliquid',
  code: 'HL',
  kind: 'Perp DEX',
  // Positions can be polled straight from the browser.
  live: true,
  fields: ['entry', 'mark', 'size', 'value', 'pnl', 'roe', 'margin', 'leverage', 'liq', 'funding'],
};

async function info(body, { signal } = {}) {
  const res = await fetch(INFO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`hyperliquid ${body.type} -> HTTP ${res.status}`);
  return res.json();
}

const num = (v) => (v === undefined || v === null || v === '' ? 0 : parseFloat(v));

/** Live mid price for every listed asset: one cheap call that reprices every trader. */
export async function fetchMarks(opts) {
  const mids = await info({ type: 'allMids' }, opts);
  const out = {};
  for (const [coin, px] of Object.entries(mids)) {
    // Skip internal index ids like "#12090" that aren't tradeable coins.
    if (coin.startsWith('#')) continue;
    out[coin] = parseFloat(px);
  }
  return out;
}

/** Open positions + margin summary for one address. */
export async function fetchTrader(address, opts) {
  const st = await info({ type: 'clearinghouseState', user: address }, opts);
  const summary = st.marginSummary || {};
  const positions = (st.assetPositions || [])
    .map((ap) => ap.position)
    .filter((p) => p && num(p.szi) !== 0)
    .map((p) => {
      const szi = num(p.szi);
      const entry = num(p.entryPx);
      const value = num(p.positionValue);
      // mark is implied by value/size; the UI re-derives it live from allMids.
      const mark = szi !== 0 ? value / Math.abs(szi) : entry;
      return {
        coin: p.coin,
        side: szi > 0 ? 'LONG' : 'SHORT',
        size: Math.abs(szi),
        signedSize: szi,
        entryPx: entry,
        markPx: mark,
        value,
        unrealizedPnl: num(p.unrealizedPnl),
        roe: num(p.returnOnEquity),
        marginUsed: num(p.marginUsed),
        leverage: p.leverage ? num(p.leverage.value) : 0,
        leverageType: p.leverage ? p.leverage.type : 'cross',
        liquidationPx: p.liquidationPx === null ? null : num(p.liquidationPx),
        fundingSinceOpen: p.cumFunding ? -num(p.cumFunding.sinceOpen) : 0,
      };
    });

  return {
    venue: meta.id,
    address,
    accountValue: num(summary.accountValue),
    totalNotional: num(summary.totalNtlPos),
    totalMarginUsed: num(summary.totalMarginUsed),
    withdrawable: num(st.withdrawable),
    positions,
    fetchedAt: Date.now(),
  };
}

/**
 * Reprice a position against a fresh mark. Hyperliquid PnL is linear:
 *   value = |size| * mark,  uPnL = signedSize * (mark - entry)
 * so one allMids call refreshes every trader without re-polling accounts.
 */
export function reprice(position, mark) {
  if (!mark || !isFinite(mark)) return position;
  const value = Math.abs(position.signedSize) * mark;
  const unrealizedPnl = position.signedSize * (mark - position.entryPx);
  const cost = Math.abs(position.signedSize) * position.entryPx;
  return {
    ...position,
    markPx: mark,
    value,
    unrealizedPnl,
    roe: position.marginUsed > 0 ? unrealizedPnl / position.marginUsed : (cost > 0 ? unrealizedPnl / cost : 0),
  };
}

/**
 * Pipeline-only: the ranked leaderboard. Large payload, so this is called from
 * the GitHub Actions refresh job rather than the browser.
 */
export async function fetchLeaderboard(opts) {
  const res = await fetch(LEADERBOARD_URL, opts);
  if (!res.ok) throw new Error(`hyperliquid leaderboard -> HTTP ${res.status}`);
  const body = await res.json();
  const rows = body.leaderboardRows || [];
  return rows.map((r) => {
    const win = {};
    for (const [name, perf] of r.windowPerformances || []) {
      win[name] = { pnl: num(perf.pnl), roi: num(perf.roi), volume: num(perf.vlm) };
    }
    return {
      address: r.ethAddress,
      displayName: r.displayName || null,
      accountValue: num(r.accountValue),
      windows: win,
    };
  });
}
