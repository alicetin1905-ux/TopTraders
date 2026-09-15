import * as hyperliquid from './hyperliquid.js';
import * as gmx from './gmx.js';
import * as okx from './okx.js';

export { hyperliquid, gmx, okx };

/** Venue registry, in the order the UI shows them. */
export const VENUES = [hyperliquid.meta, gmx.meta, okx.meta];

export const VENUE_BY_ID = Object.fromEntries(VENUES.map((v) => [v.id, v]));

/**
 * Exchanges that were evaluated but cannot be supported, kept in the UI so the
 * coverage gaps are explicit rather than looking like omissions.
 */
export const UNSUPPORTED = [
  { name: 'Binance', reason: 'Retired its public futures leaderboard API (404); copy-trading portfolios now require an authenticated session.' },
  { name: 'Bybit', reason: 'Public copy-trading leaderboard endpoint returns Access Denied to server-side callers.' },
  { name: 'dYdX v4', reason: 'Indexer geo-blocks datacenter and many retail IPs (HTTP 403 GEOBLOCKED).' },
  { name: 'Paradex / Aster', reason: 'Market data is public, but per-trader positions require an authenticated API key.' },
];
