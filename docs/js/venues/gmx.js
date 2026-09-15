/**
 * GMX v2 adapter (Arbitrum + Avalanche).
 *
 * Positions and per-account stats live in GMX's public squid indexer, and the
 * REST API serves market/token metadata plus live oracle prices. Both are
 * CORS-open, so the browser can poll them directly.
 *
 * Fixed-point convention: USD values are 1e30; a token amount uses that token's
 * own decimals; a price is scaled by 10^(30 - tokenDecimals).
 */

export const CHAINS = {
  arbitrum: {
    id: 'arbitrum',
    label: 'Arbitrum',
    graph: 'https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql',
    rest: 'https://arbitrum-api.gmxinfra.io',
  },
  avalanche: {
    id: 'avalanche',
    label: 'Avalanche',
    graph: 'https://gmx.squids.live/gmx-synthetics-avalanche:prod/api/graphql',
    rest: 'https://avalanche-api.gmxinfra.io',
  },
};

export const meta = {
  id: 'gmx',
  name: 'GMX v2',
  kind: 'Perp DEX',
  live: true,
  fields: ['entry', 'mark', 'size', 'value', 'pnl', 'roe', 'margin', 'leverage'],
};

const USD = 1e30;
const big = (v) => (v === undefined || v === null || v === '' ? 0 : Number(v));

/** Scale a BigInt-ish string by 10^dec without losing precision on huge values. */
function scale(raw, dec) {
  if (raw === undefined || raw === null || raw === '') return 0;
  const neg = String(raw).startsWith('-');
  const s = neg ? String(raw).slice(1) : String(raw);
  const pad = s.padStart(dec + 1, '0');
  const int = pad.slice(0, pad.length - dec);
  const frac = pad.slice(pad.length - dec);
  const n = Number(`${int}.${frac || '0'}`);
  return neg ? -n : n;
}

async function gql(chain, query, variables, opts = {}) {
  const res = await fetch(CHAINS[chain].graph, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`gmx ${chain} graph -> HTTP ${res.status}`);
  const body = await res.json();
  if (body.errors) throw new Error(`gmx ${chain} graph -> ${body.errors[0].message}`);
  return body.data;
}

/** market address -> { symbol, decimals } for the index token, plus token decimals table. */
export async function fetchMarkets(chain, opts = {}) {
  const base = CHAINS[chain].rest;
  const [mkRes, tkRes] = await Promise.all([
    fetch(`${base}/markets`, { signal: opts.signal }),
    fetch(`${base}/tokens`, { signal: opts.signal }),
  ]);
  if (!mkRes.ok || !tkRes.ok) throw new Error(`gmx ${chain} metadata -> HTTP ${mkRes.status}/${tkRes.status}`);
  const markets = (await mkRes.json()).markets || [];
  const tokens = (await tkRes.json()).tokens || [];

  const byAddr = {};
  for (const t of tokens) byAddr[t.address.toLowerCase()] = { symbol: t.symbol, decimals: t.decimals };

  const marketMap = {};
  for (const m of markets) {
    const index = byAddr[(m.indexToken || '').toLowerCase()];
    // Swap-only markets have a zero index token and hold no perp positions.
    if (!index) continue;
    marketMap[m.marketToken.toLowerCase()] = {
      symbol: index.symbol,
      decimals: index.decimals,
      name: m.name,
    };
  }
  return { markets: marketMap, tokens: byAddr };
}

/** Live oracle prices keyed by token symbol. */
export async function fetchMarks(chain, tokens, opts = {}) {
  const res = await fetch(`${CHAINS[chain].rest}/prices/tickers`, { signal: opts.signal });
  if (!res.ok) throw new Error(`gmx ${chain} tickers -> HTTP ${res.status}`);
  const rows = await res.json();
  const out = {};
  for (const r of rows) {
    const t = tokens[(r.tokenAddress || '').toLowerCase()];
    const dec = t ? t.decimals : 18;
    const min = scale(r.minPrice, 30 - dec);
    const max = scale(r.maxPrice, 30 - dec);
    if (!min && !max) continue;
    out[r.tokenSymbol] = (min + max) / 2;
  }
  return out;
}

const POSITION_FIELDS = `
  account market isLong sizeInUsd sizeInTokens entryPrice
  collateralAmount collateralToken unrealizedPnl realizedPnl openedAt
`;

function shapePosition(p, ctx) {
  const market = ctx.markets[(p.market || '').toLowerCase()];
  if (!market) return null;
  const tokenDec = market.decimals;
  const collat = ctx.tokens[(p.collateralToken || '').toLowerCase()] || { decimals: 18, symbol: '?' };

  const value = scale(p.sizeInUsd, 30);
  const size = scale(p.sizeInTokens, tokenDec);
  const entryPx = scale(p.entryPrice, 30 - tokenDec);
  const unrealizedPnl = scale(p.unrealizedPnl, 30);
  const collateralQty = scale(p.collateralAmount, collat.decimals);
  const collatPx = ctx.marks[collat.symbol] || 0;
  // Stablecoin collateral is ~$1 when the oracle has no entry for it.
  const marginUsed = collatPx ? collateralQty * collatPx
    : (/^(USDC|USDT|DAI|USDC\.e)$/i.test(collat.symbol) ? collateralQty : 0);

  const markPx = size !== 0 ? (value / size) : entryPx;

  return {
    coin: market.symbol,
    side: p.isLong ? 'LONG' : 'SHORT',
    size,
    signedSize: p.isLong ? size : -size,
    entryPx,
    markPx,
    value,
    unrealizedPnl,
    roe: marginUsed > 0 ? unrealizedPnl / marginUsed : 0,
    marginUsed,
    // GMX stores a leverage field, but it drifts from the live ratio; derive it.
    leverage: marginUsed > 0 ? value / marginUsed : 0,
    leverageType: 'isolated',
    liquidationPx: null,
    collateralSymbol: collat.symbol,
    openedAt: p.openedAt ? p.openedAt * 1000 : null,
    realizedPnl: scale(p.realizedPnl, 30),
  };
}

/** Open positions for one account on one chain. */
export async function fetchTrader(chain, account, ctx, opts = {}) {
  const data = await gql(
    chain,
    `query Positions($account: String!) {
      positions(where: { account_eq: $account, sizeInUsd_gt: "0", isSnapshot_eq: false }, limit: 100) { ${POSITION_FIELDS} }
    }`,
    { account },
    opts,
  );
  const positions = (data.positions || []).map((p) => shapePosition(p, ctx)).filter(Boolean);
  const totalNotional = positions.reduce((a, p) => a + p.value, 0);
  const totalMarginUsed = positions.reduce((a, p) => a + p.marginUsed, 0);
  const uPnl = positions.reduce((a, p) => a + p.unrealizedPnl, 0);
  return {
    venue: meta.id,
    chain,
    address: account,
    accountValue: totalMarginUsed + uPnl,
    totalNotional,
    totalMarginUsed,
    positions,
    fetchedAt: Date.now(),
  };
}

export function reprice(position, mark) {
  if (!mark || !isFinite(mark)) return position;
  const value = position.size * mark;
  const unrealizedPnl = position.signedSize * (mark - position.entryPx);
  return {
    ...position,
    markPx: mark,
    value,
    unrealizedPnl,
    roe: position.marginUsed > 0 ? unrealizedPnl / position.marginUsed : 0,
    leverage: position.marginUsed > 0 ? value / position.marginUsed : position.leverage,
  };
}

/** Pipeline: rank accounts by realized PnL, then keep those holding open size. */
export async function fetchLeaderboard(chain, limit = 200, opts = {}) {
  const data = await gql(
    chain,
    `query Top($limit: Int!) {
      accountStats(limit: $limit, orderBy: realizedPnl_DESC, where: { period_eq: "total" }) {
        account realizedPnl volume wins losses closedCount
      }
    }`,
    { limit },
    opts,
  );
  return (data.accountStats || []).map((s) => {
    const wins = big(s.wins), losses = big(s.losses);
    return {
      address: s.account,
      realizedPnl: scale(s.realizedPnl, 30),
      volume: scale(s.volume, 30),
      wins,
      losses,
      winRate: wins + losses > 0 ? wins / (wins + losses) : 0,
      trades: big(s.closedCount),
    };
  });
}

/** Pipeline: every open position above a notional floor, in one sweep. */
export async function fetchTopPositions(chain, ctx, minUsd = 100000, limit = 500, opts = {}) {
  const data = await gql(
    chain,
    `query Big($limit: Int!, $min: BigInt!) {
      positions(where: { sizeInUsd_gt: $min, isSnapshot_eq: false }, orderBy: sizeInUsd_DESC, limit: $limit) { ${POSITION_FIELDS} }
    }`,
    { limit, min: String(BigInt(Math.round(minUsd)) * BigInt(1e15) * BigInt(1e15)) },
    opts,
  );
  return (data.positions || [])
    .map((p) => ({ account: p.account, pos: shapePosition(p, ctx) }))
    .filter((x) => x.pos);
}

export { scale, USD };
