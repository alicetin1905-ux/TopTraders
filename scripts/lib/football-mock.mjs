/**
 * Deterministic demo data for the football dashboard: five European leagues,
 * a synthetic recent-form history per team, and one upcoming matchday per
 * league. Used whenever RAPIDAPI_KEY isn't set (or the live fetch fails), so
 * the dashboard always has something to render.
 *
 * Seeded by the calendar date (UTC), so it's stable within a day and changes
 * on the next — reproducible for testing, but not frozen forever.
 */

import { summarizeTeamForm } from './football-stats.mjs';

const LEAGUES = [
  {
    name: 'Premier League',
    country: 'England',
    teams: ['Arsenal', 'Man City', 'Liverpool', 'Chelsea', 'Man United', 'Tottenham', 'Newcastle', 'Aston Villa', 'Brighton', 'West Ham'],
  },
  {
    name: 'La Liga',
    country: 'Spain',
    teams: ['Real Madrid', 'Barcelona', 'Atletico Madrid', 'Real Sociedad', 'Real Betis', 'Villarreal', 'Athletic Bilbao', 'Sevilla', 'Valencia', 'Girona'],
  },
  {
    name: 'Bundesliga',
    country: 'Germany',
    teams: ['Bayern Munich', 'Bayer Leverkusen', 'RB Leipzig', 'Borussia Dortmund', 'Eintracht Frankfurt', 'VfB Stuttgart', 'Freiburg', 'Union Berlin', 'Wolfsburg', 'Werder Bremen'],
  },
  {
    name: 'Serie A',
    country: 'Italy',
    teams: ['Inter Milan', 'AC Milan', 'Juventus', 'Napoli', 'Roma', 'Lazio', 'Atalanta', 'Fiorentina', 'Bologna', 'Torino'],
  },
  {
    name: 'Ligue 1',
    country: 'France',
    teams: ['Paris Saint-Germain', 'Monaco', 'Marseille', 'Lyon', 'Lille', 'Nice', 'Lens', 'Rennes', 'Strasbourg', 'Toulouse'],
  },
];

function mulberry32(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return h;
}

/** Cheap Poisson-ish draw — good enough for plausible-looking goal counts. */
function poissonish(rng, lambda) {
  const l = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > l);
  return k - 1;
}

function shuffled(arr, rng) {
  return [...arr]
    .map((v) => [rng(), v])
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v);
}

const KICKOFF_HOURS_UTC = [12, 15, 17, 19];

export function generateMockSeason(dateKey = new Date().toISOString().slice(0, 10)) {
  const rng = mulberry32(hashSeed(dateKey));

  let nextId = 1;
  const teams = [];
  for (const league of LEAGUES) {
    for (const name of league.teams) {
      teams.push({
        id: nextId++,
        name,
        league: league.name,
        leagueCountry: league.country,
        attack: 0.9 + rng() * 1.1,
        defense: 0.7 + rng() * 0.8,
      });
    }
  }

  const byLeague = new Map();
  for (const t of teams) {
    if (!byLeague.has(t.league)) byLeague.set(t.league, []);
    byLeague.get(t.league).push(t);
  }

  const matchesByTeam = new Map(teams.map((t) => [t.id, []]));
  function playMatch(home, away) {
    const gf = poissonish(rng, home.attack / away.defense);
    const ga = poissonish(rng, away.attack / home.defense);
    matchesByTeam.get(home.id).push({ venue: 'home', gf, ga });
    matchesByTeam.get(away.id).push({ venue: 'away', gf: ga, ga: gf });
  }

  // Recent-form history: enough home/away rounds per league that most teams
  // clear the "low sample" threshold (5+), like a real few-months-in season.
  for (const group of byLeague.values()) {
    for (let round = 0; round < 12; round++) {
      const order = shuffled(group, rng);
      for (let i = 0; i + 1 < order.length; i += 2) playMatch(order[i], order[i + 1]);
    }
  }

  const forms = new Map();
  for (const t of teams) forms.set(t.id, summarizeTeamForm(matchesByTeam.get(t.id)));

  // Upcoming: one matchday per league, spread over the next week.
  const fixtures = [];
  const now = new Date();
  for (const [leagueName, group] of byLeague) {
    const order = shuffled(group, rng);
    const dayOffset = 1 + Math.floor(rng() * 6);
    const kickoff = new Date(now.getTime() + dayOffset * 86_400_000);
    kickoff.setUTCHours(KICKOFF_HOURS_UTC[Math.floor(rng() * KICKOFF_HOURS_UTC.length)], 0, 0, 0);

    for (let i = 0; i + 1 < order.length; i += 2) {
      const home = order[i];
      const away = order[i + 1];
      fixtures.push({
        id: `mock-${home.id}-${away.id}`,
        date: kickoff.toISOString(),
        league: leagueName,
        leagueCountry: home.leagueCountry,
        home: { id: home.id, name: home.name },
        away: { id: away.id, name: away.name },
      });
    }
  }

  return { fixtures, forms };
}
