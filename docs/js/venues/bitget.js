/**
 * Bitget copy-trading adapter.
 *
 * Bitget publishes its futures lead traders and their open positions, but the
 * position payload is sparse: symbol, entry price, leverage, margin and side.
 * Size, notional, mark and PnL are not returned, so they are derived:
 *
 *   notional = margin x leverage      (at entry)
 *   size     = notional / entry
 *   value    = size x mark            (mark from the public ticker feed)
 *   uPnL     = signedSize x (mark - entry)
 *
 * Liquidation price is genuinely absent and is reported as unknown rather than
 * guessed, since it depends on maintenance-margin tiers Bitget does not expose.
 *
 * holdSide is numeric here. 1 = LONG, 2 = SHORT, established empirically: under
 * the opposite reading, open positions in the sample sat up to 28x beyond their
 * own liquidation distance, which cannot happen on a live book.
 *
 * Sends no CORS headers, so this runs in the pipeline and the UI reads its
 * snapshot.
 */

const WEB = 'https://www.bitget.com/v1/trigger';
const TICKERS = 'https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

export const meta = {
  id: 'bitget',
  name: 'Bitget',
  code: 'BG',
  kind: 'CEX (copy-trading)',
  live: false,
  fields: ['coin', 'entry', 'mark', 'size', 'value', 'pnl', 'roe', 'margin', 'leverage'],
  masked: ['liq', 'funding'],
  note: 'Bitget returns symbol, entry, leverage, margin and side; size, value and PnL are derived from those plus the public mark price. It does not publish liquidation price or funding, and sends no CORS headers, so values come from the server-side snapshot.',
};

const num = (v) => (v === undefined || v === null || v === '' ? 0 : parseFloat(v));

async function post(path, body, opts = {}) {
  const res = await fetch(`${WEB}/${path}`, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/json',
      Origin: 'https://www.bitget.com',
      Referer: 'https://www.bitget.com/copy-trading/futures',
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`bitget ${path} -> HTTP ${res.status}`);
  return res.json();
}

/** Mark price per contract symbol, e.g. BTCUSDT. */
export async function fetchMarks(opts = {}) {
  const res = await fetch(TICKERS, { headers: { 'User-Agent': UA }, signal: opts.signal });
  if (!res.ok) throw new Error(`bitget tickers -> HTTP ${res.status}`);
  const body = await res.json();
  const out = {};
  for (const t of body.data || []) {
    const px = num(t.markPrice) || num(t.lastPr);
    if (px) out[t.symbol] = px;
  }
  return out;
}

/** Ranked lead traders, paged. */
export async function fetchLeaderboard(limit = 60, opts = {}) {
  const out = [];
  const pageSize = 30;
  for (let page = 1; out.length < limit && page <= 8; page++) {
    const body = await post('public/uta/rankingList',
      { sortRule: 5, sortFlag: 0, pageNo: page, pageSize }, opts);
    const rows = body.data?.rows || [];
    if (!rows.length) break;
    for (const r of rows) {
      if (!r.traderUid) continue;
      out.push({
        traderUid: r.traderUid,
        nickName: r.traderNickName || r.displayName || r.userName,
        followCount: num(r.followCount),
        totalEquity: num(r.totalEquity),
        aum: num(r.aum),
      });
    }
    if (!body.data?.nextFlag) break;
  }
  return out.slice(0, limit);
}

/** Open positions for one lead trader, with the derived fields filled in. */
export async function fetchTrader(traderUid, marks = {}, opts = {}) {
  const body = await post('trace/public/traderPosition',
    { traderUid, pageNo: 1, pageSize: 50 }, opts);

  const positions = (body.data || []).map((d) => {
    const symbol = d.symbolDisplayName || '';
    const entryPx = num(d.openAvgPrice) || num(d.avgPrice);
    const leverage = num(d.openLevel);
    const marginUsed = num(d.openMarginCount);
    const markPx = marks[symbol] || entryPx;
    if (!entryPx || !leverage || !marginUsed) return null;

    const long = Number(d.holdSide) === 1;
    const notionalAtEntry = marginUsed * leverage;
    const size = notionalAtEntry / entryPx;
    const signedSize = long ? size : -size;
    const value = size * markPx;
    const unrealizedPnl = signedSize * (markPx - entryPx);

    return {
      // Trim the settlement suffix so BTCUSDT aggregates with BTC elsewhere.
      coin: symbol.replace(/USDT$|USDC$|PERP$/i, '') || symbol,
      side: long ? 'LONG' : 'SHORT',
      size,
      signedSize,
      entryPx,
      markPx,
      value,
      unrealizedPnl,
      roe: marginUsed > 0 ? unrealizedPnl / marginUsed : 0,
      marginUsed,
      leverage,
      leverageType: Number(d.marginMode) === 1 ? 'isolated' : 'cross',
      // Bitget does not publish this and it is not safely derivable.
      liquidationPx: null,
      openedAt: d.createTime ? Number(d.createTime) : null,
      derived: true,
    };
  }).filter(Boolean);

  const totalNotional = positions.reduce((a, p) => a + p.value, 0);
  const totalMarginUsed = positions.reduce((a, p) => a + p.marginUsed, 0);
  const uPnl = positions.reduce((a, p) => a + p.unrealizedPnl, 0);
  return {
    venue: meta.id,
    address: traderUid,
    accountValue: totalMarginUsed + uPnl,
    totalNotional,
    totalMarginUsed,
    positions,
    fetchedAt: Date.now(),
  };
}
