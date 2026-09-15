/**
 * HTX (formerly Huobi) copy-trading adapter.
 *
 * HTX publishes its futures lead traders and, unlike OKX, does not mask their
 * books: instrument, entry price, size, mark, leverage, margin, liquidation
 * price and funding all come back in full.
 *
 * Two constraints keep this in the pipeline rather than the browser:
 *   - the endpoint sends no CORS headers (preflight answers 403);
 *   - sizes are quoted in contracts, so they need the contract-size table
 *     from the public futures API to convert to base units.
 */

const API = 'https://www.htx.com/futures/api/-/x/hbg/v1/futures/copytrading';
const CONTRACTS = 'https://api.hbdm.com/linear-swap-api/v1/swap_contract_info';

// HTX rejects requests without a browser-ish UA.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

export const meta = {
  id: 'htx',
  name: 'HTX',
  code: 'HTX',
  kind: 'CEX (copy-trading)',
  live: false,
  fields: ['coin', 'entry', 'mark', 'size', 'value', 'pnl', 'roe', 'margin', 'leverage', 'liq', 'funding'],
  note: 'HTX publishes its lead traders’ full books, but sends no CORS headers, so these values come from the server-side snapshot rather than live browser polling.',
};

const num = (v) => (v === undefined || v === null || v === '' ? 0 : parseFloat(v));

async function get(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`htx ${new URL(url).pathname} -> HTTP ${res.status}`);
  return res.json();
}

/** contract_code -> contract_size, e.g. ETH-USDT -> 0.01. */
export async function fetchContracts(opts = {}) {
  const body = await get(CONTRACTS, opts);
  if (body.status !== 'ok') throw new Error(`htx contract info -> ${body.status}`);
  const map = {};
  for (const c of body.data || []) map[c.contract_code] = num(c.contract_size);
  return map;
}

/**
 * Ranked lead traders. rankType 1 exposes the full roster (~360) in pages of
 * 50; rankType 0 is a much shorter curated list.
 */
export async function fetchLeaderboard(limit = 60, opts = {}) {
  const out = [];
  const pageSize = 50;
  for (let page = 1; out.length < limit && page <= 10; page++) {
    const body = await get(
      `${API}/new-rank?rankType=1&pageNo=${page}&pageSize=${pageSize}&timeDimension=1`, opts);
    if (body.code !== 200) throw new Error(`htx new-rank -> code ${body.code}`);
    const items = body.data?.itemList || [];
    if (!items.length) break;
    for (const r of items) {
      out.push({
        userSign: r.userSign,
        uid: r.uid,
        nickName: r.nickName,
        profit: num(r.profit),
        profitRate: num(r.profitRate),
        winRate: num(r.winRate),
        aum: num(r.aum),
        traderAsset: num(r.traderAsset),
        maxDrawdown: num(r.mdd),
        copyUserNum: num(r.copyUserNum),
      });
    }
    if (items.length < pageSize) break;
  }
  return out.slice(0, limit);
}

/** Current open positions for one lead trader. */
export async function fetchTrader(userSign, contracts = {}, opts = {}) {
  const body = await get(`${API}/trader-info/current-positions?userSign=${encodeURIComponent(userSign)}`, opts);
  if (body.code !== 200) throw new Error(`htx current-positions -> code ${body.code}`);

  const raw = body.data?.positions || [];
  const positions = raw.map((p) => {
    // volume is a contract count; contract_size converts it to base units.
    const size = num(p.volume) * (contracts[p.contractCode] ?? 1);
    const mark = num(p.markPrice) || num(p.lastPrice);
    const long = (p.positionSide || p.direction) === 'long' || p.direction === 'buy';
    const value = size * mark;
    const margin = num(p.margin) || num(p.initialMargin);
    return {
      coin: p.symbol || (p.contractCode || '').split('-')[0],
      side: long ? 'LONG' : 'SHORT',
      size,
      signedSize: long ? size : -size,
      entryPx: num(p.openAvgPrice),
      markPx: mark,
      value,
      unrealizedPnl: num(p.profitUnreal),
      roe: num(p.profitRate),
      marginUsed: margin,
      leverage: num(p.leverRate),
      leverageType: p.marginMode || 'cross',
      liquidationPx: num(p.liquidationPrice) || null,
      // Positive funding means the trader paid it, so negate for a PnL reading.
      fundingSinceOpen: -num(p.fundingFee),
      openedAt: p.createdTime || null,
    };
  }).filter((p) => p.size > 0);

  const totalNotional = positions.reduce((a, p) => a + p.value, 0);
  const totalMarginUsed = positions.reduce((a, p) => a + p.marginUsed, 0);
  const uPnl = positions.reduce((a, p) => a + p.unrealizedPnl, 0);
  return {
    venue: meta.id,
    address: userSign,
    accountValue: totalMarginUsed + uPnl,
    totalNotional,
    totalMarginUsed,
    // Some lead traders opt to hide their book; surfaced so an empty list is
    // not mistaken for a trader who is simply flat.
    hidden: body.data?.isHide === 1 && raw.length === 0,
    positions,
    fetchedAt: Date.now(),
  };
}
