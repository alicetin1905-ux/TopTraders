# TopTraders

Live dashboard tracking what the biggest traders on major perpetual-futures
exchanges are actually holding right now — open positions, entry price, mark
price, notional value, unrealised PnL, ROE, margin, leverage and liquidation
price.

**Live site:** https://alicetin1905-ux.github.io/TopTraders/

---

## What it shows

| Column | Meaning |
|---|---|
| Side | LONG / SHORT |
| Size | Position size in the base asset |
| Entry | Volume-weighted average entry price |
| Mark | Current mark/oracle price, refreshed live in your browser |
| Value | Notional value of the position |
| Unreal. PnL | Unrealised profit or loss, marked to the live price |
| ROE | Return on the margin backing the position |
| Margin | Margin currently committed |
| Lev. | Leverage (derived as notional ÷ margin) |
| Liq. | Liquidation price, where the venue publishes one |
| Funding | Funding paid or received since the position opened |

Plus a **crowd positioning** view aggregating long vs. short notional per coin
across every tracked trader, and filters by exchange, size, coin and address.

## Exchange coverage

Per-trader positions are only publishable where a venue actually exposes them.
What is covered, and what each venue gives up:

| Exchange | Traders from | Positions | Notes |
|---|---|---|---|
| **Hyperliquid** | Public PnL leaderboard | Full | On-chain perp DEX — every account's book is public. Refreshes live in the browser. |
| **GMX v2** (Arbitrum + Avalanche) | Public squid indexer | Full | On-chain. Entry price, size, collateral and PnL all public. Refreshes live in the browser. |
| **OKX** | Public copy-trading leaderboard | Partial | OKX returns side, leverage, margin, uPnL and PnL ratio, but **masks instrument, entry price and size** for non-copiers. It also sends no CORS headers, so these values come from the server-side snapshot rather than live browser polling. |

Evaluated and **not** included, with the reason:

- **Binance** — retired its public futures leaderboard API (now `404`); copy-trading portfolios require an authenticated session.
- **Bybit** — public copy-trading leaderboard returns `Access Denied` to server-side callers.
- **dYdX v4** — the indexer geo-blocks datacenter and many retail IPs (`403 GEOBLOCKED`).
- **Paradex / Aster** — market data is public, but per-trader positions need an authenticated API key.

There is no way to show a Binance or Bybit trader's live position without that
venue publishing it; the dashboard states this in the footer rather than
quietly showing fewer exchanges than promised.

## How it works

```
GitHub Actions (every 15 min)          Browser (every 15 s)
┌────────────────────────────┐         ┌──────────────────────────────┐
│ scripts/refresh.mjs        │         │ docs/js/app.js               │
│  • HL leaderboard (~37 MB) │ ──────▶ │  • loads snapshot.json       │
│  • GMX position sweep      │ commits │  • polls allMids + tickers   │
│  • OKX lead traders        │  JSON   │  • re-prices every position  │
└────────────────────────────┘         └──────────────────────────────┘
```

Two things can't be done from the browser, which is why there's a pipeline at
all: Hyperliquid's leaderboard is a ~37 MB payload, and OKX sends no CORS
headers. Everything else is fetched client-side.

The clever part is the repricing. PnL on a perp is linear in the mark price:

```
value  = |size| × mark
uPnL   = signedSize × (mark − entry)
```

So a single `allMids` call reprices *every* tracked trader at once, instead of
one request per trader. Expanding a row additionally re-pulls that trader's real
book, so newly opened and closed positions show up — not just new prices.

## Running locally

```bash
npm run refresh   # build docs/data/*.json (~7s, no API keys needed)
npm run serve     # http://localhost:8080
```

No dependencies, no build step, no API keys. Node 20+.

Snapshot size is tunable via env vars: `HL_KEEP`, `GMX_KEEP`, `OKX_KEEP`,
`HL_CANDIDATES`, `CONCURRENCY`.

## Layout

```
docs/                 the published site (GitHub Pages root)
  index.html
  styles.css
  js/app.js           dashboard logic: filter, sort, reprice, render
  js/format.js        number/price/address formatting
  js/venues/          one adapter per exchange, shared by browser and pipeline
  data/               snapshot.json + meta.json, written by CI
scripts/refresh.mjs   the snapshot pipeline
scripts/serve.mjs     local static server
```

The venue adapters are plain ES modules with no imports, so the **same file**
runs in the browser and in the Node pipeline. Adding an exchange means adding
one module exposing `fetchLeaderboard`, `fetchTrader` and `reprice`, then
registering it in `docs/js/venues/index.js`.

## A note on colour

Long/short uses a **blue↔red** diverging pair rather than the conventional
green/red. Green/red measures a CVD separation of ΔE 4.1 for deuteranopia —
red-green colourblind traders cannot tell a long from a short. The blue/red pair
measures ΔE 25.7. PnL keeps green/red but always ships an explicit `+`/`−` sign,
so the sign carries the meaning and colour only reinforces it.

## Caveats

- Leaderboards are self-selected: on OKX a trader must opt into copy-trading, and
  Hyperliquid ranks only addresses it indexes. This is not "the best traders in
  the world", it's "the top of each venue's public leaderboard".
- Large Hyperliquid accounts that are vaults or bridges are filtered out — they
  rank high on account value but hold no perp positions.
- Snapshot data can be up to 15 minutes old for position *composition*; prices
  on screen are live.
- Public exchange data, shown for information only. **Not investment advice.**

## Licence

MIT — see [LICENSE](LICENSE).
