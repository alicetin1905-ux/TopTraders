/**
 * OKX copy-trading adapter.
 *
 * OKX publishes its lead traders and their open positions without auth, but it
 * deliberately masks the parts that would let you mirror a trade for free:
 * instId, openAvgPx, markPx and subPos come back as empty strings for anyone
 * who isn't copying the trader. What survives is real and still useful --
 * side, leverage, margin, unrealized PnL and PnL ratio.
 *
 * OKX also sends no CORS headers, so the browser cannot call it directly. This
 * adapter runs in the refresh pipeline only; the UI reads its snapshot.
 */

const BASE = 'https://www.okx.com/api/v5/copytrading';

export const meta = {
  id: 'okx',
  name: 'OKX',
  code: 'OKX',
  kind: 'CEX (copy-trading)',
  live: false,
  fields: ['side', 'pnl', 'roe', 'margin', 'leverage'],
  // Surfaced in the UI so the gaps read as an OKX policy, not a bug.
  masked: ['coin', 'entry', 'mark', 'size', 'value'],
  note: 'OKX hides instrument, entry price and size for non-copiers, and blocks browser requests (no CORS). Values come from the server-side snapshot.',
};

const num = (v) => (v === undefined || v === null || v === '' ? 0 : parseFloat(v));

/** "ETH-USDT-SWAP" -> "ETH"; empty/masked instruments stay null. */
function baseCoin(instId) {
  if (!instId) return null;
  return instId.split('-')[0].toUpperCase() || null;
}

async function call(path, params, opts = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}/${path}?${qs}`, {
    headers: { Accept: 'application/json' },
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`okx ${path} -> HTTP ${res.status}`);
  const body = await res.json();
  if (body.code !== '0') throw new Error(`okx ${path} -> ${body.code} ${body.msg || ''}`);
  return body.data || [];
}

/** Ranked public lead traders. */
export async function fetchLeaderboard(limit = 40, opts = {}) {
  const data = await call('public-lead-traders', {
    instType: 'SWAP',
    sortType: 'pnl',
    limit: String(Math.min(limit, 20)), // OKX rejects limit > 20 (code 51000)
  }, opts);
  const ranks = data[0]?.ranks || [];
  return ranks.map((r) => ({
    uniqueCode: r.uniqueCode,
    nickName: r.nickName,
    portLink: r.portLink || null,
    pnl: num(r.pnl),
    pnlRatio: num(r.pnlRatio),
    aum: num(r.aum),
    copyTraders: num(r.copyTraderNum),
    leadDays: num(r.leadDays),
    winRatio: num(r.winRatio),
  }));
}

/** Current open positions for one lead trader (partially masked by OKX). */
export async function fetchTrader(uniqueCode, opts = {}) {
  const data = await call('public-current-subpositions', {
    uniqueCode,
    instType: 'SWAP',
    limit: '50',
  }, opts);

  const positions = data.map((p) => {
    const margin = num(p.margin);
    const upl = num(p.upl);
    return {
      // instId is blank for non-copiers; keep it null rather than inventing a
      // symbol. When it is present ("ETH-USDT-SWAP"), reduce it to the base coin
      // so the exposure aggregates with the same coin on other venues.
      coin: baseCoin(p.instId),
      side: (p.posSide || '').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG',
      size: num(p.subPos) || null,
      signedSize: null,
      entryPx: num(p.openAvgPx) || null,
      markPx: num(p.markPx) || null,
      // No size or price, so notional is only knowable via margin x leverage.
      value: margin > 0 && num(p.lever) > 0 ? margin * num(p.lever) : null,
      unrealizedPnl: upl,
      roe: num(p.uplRatio),
      marginUsed: margin,
      leverage: num(p.lever),
      leverageType: p.mgnMode || 'cross',
      liquidationPx: null,
      currency: p.ccy || 'USDT',
      openedAt: p.openTime ? num(p.openTime) : null,
      partial: true,
    };
  });

  const totalMarginUsed = positions.reduce((a, p) => a + p.marginUsed, 0);
  const uPnl = positions.reduce((a, p) => a + p.unrealizedPnl, 0);
  return {
    venue: meta.id,
    address: uniqueCode,
    accountValue: totalMarginUsed + uPnl,
    totalNotional: positions.reduce((a, p) => a + (p.value || 0), 0),
    totalMarginUsed,
    positions,
    fetchedAt: Date.now(),
  };
}
