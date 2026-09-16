/**
 * Turns two consecutive snapshots into a feed of position changes.
 *
 * The previous snapshot is whatever is already committed at docs/data, so this
 * costs no extra API calls -- the refresh job simply reads the file before it
 * overwrites it.
 *
 * A position is keyed by trader + coin rather than trader + coin + side, so a
 * reversal reads as one FLIPPED event instead of a CLOSED and an OPENED.
 */

// Ignore churn below this fraction; funding and rounding nudge sizes constantly.
const SIZE_EPS = 0.05;
// Positions smaller than this are noise in a feed meant to surface real moves.
const MIN_NOTIONAL = 1000;

const keyOf = (traderId, coin) => `${traderId}|${coin}`;

function indexPositions(traders) {
  const map = new Map();
  for (const t of traders || []) {
    for (const p of t.positions || []) {
      if (!p.coin) continue;
      map.set(keyOf(t.id, p.coin), { trader: t, pos: p });
    }
  }
  return map;
}

const traderMeta = (t) => ({
  venue: t.venue,
  chain: t.chain || null,
  traderId: t.id,
  trader: t.label || t.address,
  link: t.link || null,
});

/**
 * @returns {Array} events for this tick, biggest notional first.
 */
export function diffSnapshots(prev, next, now = Date.now()) {
  if (!prev?.traders?.length) return [];

  const before = indexPositions(prev.traders);
  const after = indexPositions(next.traders);
  const events = [];

  for (const [key, cur] of after) {
    const old = before.get(key);
    const { pos, trader } = cur;
    const value = pos.value || 0;

    if (!old) {
      if (value < MIN_NOTIONAL) continue;
      events.push({
        ...traderMeta(trader), ts: now, type: 'OPENED', coin: pos.coin, side: pos.side,
        size: pos.size, value, entryPx: pos.entryPx, leverage: pos.leverage,
      });
      continue;
    }

    const prevPos = old.pos;
    if (prevPos.side !== pos.side) {
      events.push({
        ...traderMeta(trader), ts: now, type: 'FLIPPED', coin: pos.coin, side: pos.side,
        fromSide: prevPos.side, size: pos.size, value, entryPx: pos.entryPx, leverage: pos.leverage,
      });
      continue;
    }

    const a = prevPos.size || 0;
    const b = pos.size || 0;
    if (a > 0 && Math.abs(b - a) / a > SIZE_EPS && Math.max(value, prevPos.value || 0) >= MIN_NOTIONAL) {
      events.push({
        ...traderMeta(trader), ts: now, type: b > a ? 'INCREASED' : 'REDUCED', coin: pos.coin,
        side: pos.side, size: b, sizeBefore: a, value, valueBefore: prevPos.value || 0,
        entryPx: pos.entryPx, leverage: pos.leverage,
        deltaPct: (b - a) / a,
      });
    }
  }

  for (const [key, old] of before) {
    if (after.has(key)) continue;
    const { pos, trader } = old;
    const value = pos.value || 0;
    if (value < MIN_NOTIONAL) continue;
    // A trader dropping off the roster is not the same as closing a position.
    if (!next.traders.some((t) => t.id === trader.id)) continue;
    events.push({
      ...traderMeta(trader), ts: now, type: 'CLOSED', coin: pos.coin, side: pos.side,
      size: pos.size, value, entryPx: pos.entryPx, leverage: pos.leverage,
      unrealizedPnlAtClose: pos.unrealizedPnl || 0,
    });
  }

  return events.sort((x, y) => (y.value || 0) - (x.value || 0));
}

/** Prepend this tick's events to the rolling feed and cap its length. */
export function mergeFeed(existing, events, cap = 400) {
  return [...events, ...(existing || [])].slice(0, cap);
}
