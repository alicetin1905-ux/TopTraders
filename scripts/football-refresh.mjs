#!/usr/bin/env node
/**
 * Builds docs/football/data/fixtures.json: upcoming fixtures across the top
 * five European leagues, ranked by a combined "away win + both teams to
 * score" likelihood derived from each team's recent home/away record.
 *
 * Live mode (RAPIDAPI_KEY set): pulls fixtures and recent results from
 * API-Football. Demo mode (no key, or the live fetch fails): generates
 * deterministic sample data so the dashboard always has something to show.
 *
 * Independent of scripts/refresh.mjs (the crypto pipeline) — no shared code
 * or data between the two.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scoreFixture, summarizeTeamForm } from './lib/football-stats.mjs';
import { generateMockSeason } from './lib/football-mock.mjs';
import * as apiFootball from './lib/football-api.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'docs/football/data');

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '';
const NEXT_PER_LEAGUE = Number(process.env.FOOTBALL_NEXT || 8);
const RECENT_MATCHES = Number(process.env.FOOTBALL_RECENT || 10);
const CONCURRENCY = Number(process.env.FOOTBALL_CONCURRENCY || 4);

const log = (...a) => console.log('[football-refresh]', ...a);

async function pool(items, worker, limit) {
  const out = [];
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = await worker(items[idx], idx);
      } catch (err) {
        out[idx] = { __error: String(err.message || err) };
      }
    }
  });
  await Promise.all(runners);
  return out;
}

function scoreAll(fixtures, formById) {
  const scored = [];
  for (const f of fixtures) {
    const homeForm = formById.get(f.home.id);
    const awayForm = formById.get(f.away.id);
    if (!homeForm || !awayForm || homeForm.__error || awayForm.__error) continue;
    const score = scoreFixture(homeForm, awayForm);
    if (!score) continue;
    scored.push({ ...f, stats: { home: homeForm, away: awayForm }, score });
  }
  scored.sort((a, b) => b.score.combined - a.score.combined);
  return scored;
}

async function buildFromApi() {
  const season = apiFootball.currentSeason();
  log(`live mode: season ${season}`);

  const perLeague = await pool(
    apiFootball.LEAGUES,
    (lg) => apiFootball.fetchUpcomingFixtures(RAPIDAPI_KEY, { leagueId: lg.id, season, next: NEXT_PER_LEAGUE }),
    CONCURRENCY,
  );
  const fixtures = perLeague.filter((r) => Array.isArray(r)).flat();
  if (!fixtures.length) throw new Error('no upcoming fixtures returned for any league');

  const teamIds = [...new Set(fixtures.flatMap((f) => [f.home.id, f.away.id]))];
  log(`fetching recent form for ${teamIds.length} teams…`);
  const forms = await pool(
    teamIds,
    async (id) => summarizeTeamForm(await apiFootball.fetchRecentMatches(RAPIDAPI_KEY, id, RECENT_MATCHES)),
    CONCURRENCY,
  );
  const formById = new Map(teamIds.map((id, i) => [id, forms[i]]));

  return scoreAll(fixtures, formById);
}

async function main() {
  await mkdir(OUT, { recursive: true });

  let fixtures;
  let source;
  if (RAPIDAPI_KEY) {
    try {
      fixtures = await buildFromApi();
      source = 'api-football';
    } catch (err) {
      log('live fetch failed, falling back to demo data:', err.message || err);
    }
  }
  if (!fixtures) {
    log(RAPIDAPI_KEY ? 'using demo data (live fetch unavailable)' : 'no RAPIDAPI_KEY set — using demo data');
    const { fixtures: mockFixtures, forms } = generateMockSeason();
    fixtures = scoreAll(mockFixtures, forms);
    source = 'mock';
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    source,
    disclaimer: 'Public/derived football statistics shown for information only — not betting advice.',
    fixtures,
  };
  await writeFile(resolve(OUT, 'fixtures.json'), JSON.stringify(payload, null, 2));
  log(`wrote ${fixtures.length} fixtures (source: ${source})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
