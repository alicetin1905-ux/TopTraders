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

Plus a **recent activity feed** showing which traders opened, closed, added to
or cut a position between snapshots, a **crowd positioning** view aggregating
long vs. short notional per coin, and filters by exchange, size, coin and
address.

## Exchange coverage

Per-trader positions are only publishable where a venue actually exposes them.
What is covered, and what each venue gives up:

| Exchange | Traders from | Positions | Notes |
|---|---|---|---|
| **Hyperliquid** | Public PnL leaderboard | Full | On-chain perp DEX — every account's book is public. Refreshes live in the browser. |
| **GMX v2** (Arbitrum + Avalanche) | Public squid indexer | Full | On-chain. Entry price, size, collateral and PnL all public. Refreshes live in the browser. |
| **HTX** (formerly Huobi) | Public copy-trading leaderboard (~367 lead traders) | Full | Publishes lead traders' complete books — instrument, entry, mark, size, leverage, margin, liquidation price and funding. Sends no CORS headers, so values come from the snapshot. Sizes are quoted in contracts and converted via the public contract-size table. |
| **Bitget** | Public copy-trading leaderboard | Derived | Returns symbol, entry, leverage, margin and side only. Size, notional and PnL are **derived** (`notional = margin × leverage`, `size = notional ÷ entry`, marked against the public ticker feed). Publishes no liquidation price or funding, and sends no CORS headers. |
| **OKX** | Public copy-trading leaderboard | Partial | OKX returns side, leverage, margin, uPnL and PnL ratio, but **masks instrument, entry price and size** for non-copiers. Also sends no CORS headers, so these values come from the snapshot. |

Evaluated and **not** included, with the reason:

- **Coinbase** — runs no copy-trading or social-trading product and publishes no trader leaderboard. Advanced Trade and Coinbase International expose market data only (products, candles, order book); positions are returned solely to the authenticated owner of an account. There is no public endpoint to build this from.
- **Binance** — retired its public futures leaderboard API (now `404`); copy-trading portfolios require an authenticated session.
- **Bybit** — public copy-trading leaderboard returns `Access Denied` to server-side callers.
- **dYdX v4** — the indexer geo-blocks datacenter and many retail IPs (`403 GEOBLOCKED`).
- **Paradex / Aster** — market data is public, but per-trader positions need an authenticated API key.

There is no way to show a Coinbase or Binance trader's live position without
that venue publishing it; the dashboard states this in the footer rather than
quietly showing fewer exchanges than promised.

## The activity feed

Every refresh diffs the new snapshot against the one already committed, which
costs no extra API calls — the previous tick is simply the file on disk. That
produces `OPENED` / `CLOSED` / `INCREASED` / `REDUCED` / `FLIPPED` events with
the trader, coin, side, notional and size delta.

Two details keep the feed honest rather than noisy:

- A position is keyed by **trader + coin**, not trader + coin + side, so a
  reversal reads as one `FLIPPED` event instead of a `CLOSED` plus an `OPENED`.
- Only venues that answered successfully this tick are compared. Without that,
  a source having a bad minute would read as every one of its traders closing
  every position at once.

Size changes below 5% and positions under $1,000 are ignored, since funding and
rounding nudge sizes constantly.

`scripts/backfill-changes.mjs` seeds the feed from the snapshot history already
in git, so it is populated on first deploy instead of empty for hours.

## How it works

```
GitHub Actions (scheduled)                      Browser (every 15 s)
┌──────────────────────────────────┐            ┌──────────────────────────────┐
│ scripts/refresh.mjs              │            │ docs/js/app.js               │
│  • HL leaderboard (~37 MB)       │            │  • loads snapshot.json       │
│  • GMX position sweep            │  deploys   │  • polls allMids + tickers   │
│  • CEX lead traders              │ ─────────▶ │  • re-prices every position  │
│  • diffs vs. previous tick       │  to Pages  │  • renders the activity feed │
└──────────────────────────────────┘            └──────────────────────────────┘
          ▲                                                   │
          └───── reads last snapshot + feed from the site ◀────┘
```

**Nothing is committed.** The snapshots are built in CI and handed straight to
Pages. Committing them cost roughly 72 KB of packed history per refresh — about
315 MB a year at the observed cadence, and ~2.5 GB if the 15-minute schedule
were ever honoured — for data that is worthless the moment it is superseded.

The rolling state that *does* need to survive between runs (the previous tick,
for diffing, and the activity feed) is read back from the deployed site, which
is simply the last successful run of this same job. If the site is unreachable
or this is a first deploy, the run still succeeds and simply starts the feed
fresh.

A single workflow refreshes and deploys, which also sidesteps a trap: a push
made with the default `GITHUB_TOKEN` does not trigger other workflows, so a
commit-then-deploy split silently never redeploys.

Two things can't be done from the browser, which is why there's a pipeline at
all: Hyperliquid's leaderboard is a ~37 MB payload, and the CEXes (OKX, HTX,
Bitget) send no CORS headers. Everything else is fetched client-side.

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
npm run refresh   # build docs/data/*.json (~55s, no API keys needed)
npm run serve     # http://localhost:8080
```

`npm run refresh` is required before the first `npm run serve`: the data files
are git-ignored, so a fresh clone has none. By default the refresh pulls the
previous tick from the live site to diff against; set `SITE_URL=''` to skip
that and start the activity feed empty.

No dependencies, no build step, no API keys. Node 20+.

Snapshot size is tunable via env vars: `HL_KEEP`, `GMX_KEEP`, `OKX_KEEP`,
`HTX_KEEP`, `BG_KEEP`, `HL_CANDIDATES`, `HTX_CANDIDATES`, `BG_CANDIDATES`,
`CONCURRENCY`.

## Layout

```
docs/                 the published site (GitHub Pages root)
  index.html
  styles.css
  js/app.js           dashboard logic: filter, sort, reprice, render
  js/format.js        number/price/address formatting
  js/venues/          one adapter per exchange, shared by browser and pipeline
  data/               snapshot.json, changes.json, meta.json — built by CI,
                      git-ignored (see "Nothing is committed" above)
scripts/refresh.mjs   the snapshot pipeline
scripts/lib/diff.mjs  snapshot-to-snapshot change detection
scripts/backfill-changes.mjs  recovery: rebuild a feed from frozen git history
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

Venue is deliberately **not** colour-coded. With five exchanges, no categorical
palette clears the colourblind-separation floors under all-pairs comparison —
every candidate quartet failed — so venue is shown as a short text code
(`HL`, `GMX`, `OKX`, `HTX`, `BG`) in a neutral chip. That keeps the page's colour
budget on the two things it genuinely encodes: direction and PnL.

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
