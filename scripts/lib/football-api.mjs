/**
 * Client for API-Football via RapidAPI (https://rapidapi.com/api-sports/api/api-football).
 * Only exercised when RAPIDAPI_KEY is set — untested against the live API
 * since this was built without a key on hand; verify response shapes once a
 * key is wired in, particularly the `errors` field, which API-Football
 * returns as `{}` (no errors) or a populated object/array depending on
 * endpoint and API version.
 *
 * Free tier is ~100 requests/day, so keep FOOTBALL_NEXT and FOOTBALL_RECENT
 * modest — five leagues × ~10 teams with fixtures in the window is already
 * 40-60 calls per refresh.
 */

const BASE = 'https://api-football-v1.p.rapidapi.com/v3';
const HOST = 'api-football-v1.p.rapidapi.com';

export const LEAGUES = [
  { id: 39, name: 'Premier League', country: 'England' },
  { id: 140, name: 'La Liga', country: 'Spain' },
  { id: 78, name: 'Bundesliga', country: 'Germany' },
  { id: 135, name: 'Serie A', country: 'Italy' },
  { id: 61, name: 'Ligue 1', country: 'France' },
];

/** European season labels run by start year (e.g. "2025" for 2025/26). */
export function currentSeason(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  return month >= 7 ? year : year - 1;
}

async function apiGet(key, path, params) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': HOST },
  });
  if (!res.ok) throw new Error(`API-Football ${path} -> HTTP ${res.status}`);
  const body = await res.json();
  const errCount = Array.isArray(body.errors) ? body.errors.length : Object.keys(body.errors || {}).length;
  if (errCount) throw new Error(`API-Football ${path} -> ${JSON.stringify(body.errors)}`);
  return body.response;
}

export async function fetchUpcomingFixtures(key, { leagueId, season, next = 10 }) {
  const rows = await apiGet(key, '/fixtures', { league: leagueId, season, next });
  return rows.map((r) => ({
    id: r.fixture.id,
    date: r.fixture.date,
    league: r.league.name,
    leagueCountry: r.league.country,
    home: { id: r.teams.home.id, name: r.teams.home.name },
    away: { id: r.teams.away.id, name: r.teams.away.name },
  }));
}

/** Recent finished matches for one team, normalised to {venue, gf, ga}. */
export async function fetchRecentMatches(key, teamId, last = 10) {
  const rows = await apiGet(key, '/fixtures', { team: teamId, last });
  return rows
    .filter((r) => r.fixture.status?.short === 'FT')
    .map((r) => {
      const isHome = r.teams.home.id === teamId;
      const gf = isHome ? r.goals.home : r.goals.away;
      const ga = isHome ? r.goals.away : r.goals.home;
      return { venue: isHome ? 'home' : 'away', gf, ga };
    })
    .filter((m) => m.gf != null && m.ga != null);
}
