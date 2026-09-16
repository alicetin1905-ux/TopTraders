/**
 * Liquidation exposure: how much tracked notional gets force-closed as price
 * moves away from spot.
 *
 * Only Hyperliquid and HTX publish a liquidation price. GMX, OKX and Bitget do
 * not, so their positions are counted as uncovered and reported alongside the
 * ladder rather than silently dropped -- the map is a floor on real exposure,
 * not the whole market.
 *
 * Longs liquidate as price falls (liqPx below mark), shorts as it rises. Values
 * are cumulative: the figure at -10% includes everything that already went at
 * -5%, which is what "if BTC drops 10%" actually means.
 */

// Past this the position is effectively unleveraged, and venues return
// placeholder prices (a SOL short quoted 588,405,339% away) that would wreck
// any scale. Beyond the widest band it makes no difference to the ladder.
const MAX_DISTANCE = 1.0;

export const DEFAULT_BANDS = [5, 10, 15, 20, 30, 50];

/** Positions for one coin that carry a usable liquidation price. */
function collect(traders, coin) {
  const usable = [];
  let uncoveredN = 0;
  let uncoveredValue = 0;
  let markSum = 0;
  let markN = 0;

  for (const t of traders) {
    for (const p of t.positions) {
      if (p.coin !== coin || !p.value) continue;
      if (p.markPx > 0) { markSum += p.markPx; markN++; }
      if (!p.liquidationPx || !(p.liquidationPx > 0) || !(p.markPx > 0)) {
        uncoveredN++; uncoveredValue += p.value;
        continue;
      }
      const distance = Math.abs(p.liquidationPx - p.markPx) / p.markPx;
      if (distance > MAX_DISTANCE) { uncoveredN++; uncoveredValue += p.value; continue; }
      // A long liquidates below mark and a short above it; the reverse is an
      // artifact (cross-margin accounting quirks produce a few). Counting one
      // would mark it liquidated at every band in that direction.
      const wrongSide = p.side === 'LONG'
        ? p.liquidationPx >= p.markPx
        : p.liquidationPx <= p.markPx;
      if (wrongSide) { uncoveredN++; uncoveredValue += p.value; continue; }
      usable.push({
        side: p.side, value: p.value, liqPx: p.liquidationPx, markPx: p.markPx,
        trader: t.label || t.address, venue: t.venue, leverage: p.leverage,
      });
    }
  }
  return { usable, uncoveredN, uncoveredValue, mark: markN ? markSum / markN : 0 };
}

/**
 * @returns {object|null} ladder rows plus coverage, or null when the coin has
 *   no position carrying a liquidation price.
 */
export function liquidationLadder(traders, coin, bands = DEFAULT_BANDS) {
  const { usable, uncoveredN, uncoveredValue, mark } = collect(traders, coin);
  if (!usable.length || !mark) return null;

  const rows = [];
  for (const pct of [...bands].sort((a, b) => b - a)) {
    const price = mark * (1 + pct / 100);
    const hit = usable.filter((p) => p.side === 'SHORT' && p.liqPx <= price);
    rows.push({
      pct, dir: 'up', side: 'SHORT', price,
      notional: hit.reduce((a, p) => a + p.value, 0), count: hit.length,
    });
  }
  for (const pct of [...bands].sort((a, b) => a - b)) {
    const price = mark * (1 - pct / 100);
    const hit = usable.filter((p) => p.side === 'LONG' && p.liqPx >= price);
    rows.push({
      pct: -pct, dir: 'down', side: 'LONG', price,
      notional: hit.reduce((a, p) => a + p.value, 0), count: hit.length,
    });
  }

  const nearest = (side, cmp) => usable
    .filter((p) => p.side === side)
    .reduce((best, p) => (best === null || cmp(p.liqPx, best.liqPx) ? p : best), null);

  return {
    coin,
    mark,
    rows,
    max: Math.max(...rows.map((r) => r.notional), 0),
    covered: { count: usable.length, value: usable.reduce((a, p) => a + p.value, 0) },
    uncovered: { count: uncoveredN, value: uncoveredValue },
    // The first level at which anything is forced out, in each direction.
    nearestLong: nearest('LONG', (a, b) => a > b),
    nearestShort: nearest('SHORT', (a, b) => a < b),
  };
}

/** Coins ranked by how much notional the map can actually account for. */
export function coinsWithLiquidations(traders, limit = 12) {
  const totals = new Map();
  for (const t of traders) {
    for (const p of t.positions) {
      if (!p.coin || !p.value || !p.liquidationPx || !(p.markPx > 0)) continue;
      if (Math.abs(p.liquidationPx - p.markPx) / p.markPx > MAX_DISTANCE) continue;
      totals.set(p.coin, (totals.get(p.coin) || 0) + p.value);
    }
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([coin, value]) => ({ coin, value }));
}
