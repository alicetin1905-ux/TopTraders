# Away Win + BTTS Tracker

A dashboard of upcoming European football fixtures, ranked by the combined
likelihood of an **away win** and **both teams to score (BTTS)** — the two
outcomes stacked together.

**Live site:** https://alicetin1905-ux.github.io/TopTraders/football/

Built independently of the [TopTraders crypto dashboard](README.md) in this
same repo — separate scripts, separate data, no shared code. It happens to
reuse the same GitHub Pages deploy and the same validated colour palette for
visual consistency, nothing more.

## What it shows

For every upcoming fixture across the top five European leagues (Premier
League, La Liga, Bundesliga, Serie A, Ligue 1):

| Column | Meaning |
|---|---|
| Away win | Likelihood the away team wins, derived from recent form |
| BTTS | Likelihood both teams score |
| Combined | Away win × BTTS — the headline ranking metric |

Fixtures are sorted with the most likely "away win + BTTS yes" match first.
A "low sample" tag marks fixtures where either team has fewer than 5 recent
matches on record, since the underlying rate is noisier with less data.

**This is not a bookmaker probability or betting advice** — it's a simplified
estimate from public/derived match data, shown for information only.

## How the score is computed

Nothing here comes from an odds feed. Each team's recent home and away
matches are split, and from that:

```
away-win likelihood = average(home team's home-loss rate, away team's away-win rate)
BTTS likelihood      = average(home team's home-BTTS rate, away team's away-BTTS rate)
combined             = away-win likelihood × BTTS likelihood
```

Multiplying the two treats them as independent, which is a simplification —
real matches correlate them (a high-scoring away win is not the product of
two unrelated coin flips). The tradeoff is that the score stays auditable
from the two numbers shown beside it in the table, rather than hidden inside
an opaque model. See `scripts/lib/football-stats.mjs` for the exact logic.

## Data source

Two modes, chosen automatically by `scripts/football-refresh.mjs`:

- **Live** — set a `RAPIDAPI_KEY` repo secret (a free key from
  [API-Football on RapidAPI](https://rapidapi.com/api-sports/api/api-football)).
  Pulls upcoming fixtures and each team's last 10 results per league.
  The free tier is ~100 requests/day — five leagues × ~10 teams with fixtures
  in the window is already 40–60 calls per refresh, so this isn't safe to run
  much more than once or twice a day without a paid tier.
  **Not yet exercised against the live API** (built without a key on hand) —
  verify the response shapes in `scripts/lib/football-api.mjs` once a key is
  wired in.
- **Demo** — no key set, or the live fetch fails: generates deterministic
  sample fixtures and history (`scripts/lib/football-mock.mjs`), seeded by
  the calendar date. The site always has something to show. The meta badge
  in the top-left of the page says which mode produced the current data.

## Running locally

```bash
npm run football:refresh   # builds docs/football/data/fixtures.json
npm run football:serve     # http://localhost:8081
```

Set `RAPIDAPI_KEY=...` before `football:refresh` to pull live data instead of
demo data. No other setup, no build step, no dependencies beyond Node 20+.

## Layout

```
docs/football/          the published site (served at /football/ on the same Pages deploy as TopTraders)
  index.html
  styles.css
  js/app.js              filter, sort, render
  js/format.js           date/percentage formatting
  data/fixtures.json     built by scripts/football-refresh.mjs, committed (small, demo-safe)
scripts/football-refresh.mjs   the pipeline: live fetch or demo fallback, then scores + ranks
scripts/football-serve.mjs     local static server
scripts/lib/football-stats.mjs the scoring logic, shared by live and demo paths
scripts/lib/football-api.mjs   API-Football (RapidAPI) client
scripts/lib/football-mock.mjs  deterministic demo data generator
```

## Caveats

- Team-level rates, not a joint model — see "How the score is computed" above.
- Demo mode generates plausible-looking but entirely synthetic results; it is
  clearly labelled "Demo data" in the UI and is not real fixture history.
- Only the top five leagues are covered. Extending to more leagues means
  adding league IDs to `LEAGUES` in `scripts/lib/football-api.mjs` (and to the
  mock generator if you want them in demo mode too) — mind the rate limit.
- Public/derived match data, shown for information only. **Not betting advice.**
