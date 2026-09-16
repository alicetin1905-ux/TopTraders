/**
 * Shared scoring logic for the football dashboard — used by both the mock
 * data generator and the live API-Football pipeline, so "demo" and "live"
 * numbers are always computed the same way.
 *
 * The question the dashboard answers is "how likely is AWAY WIN + BTTS YES",
 * which isn't directly published anywhere, so it's approximated from each
 * team's own recent record:
 *
 *   away-win likelihood  = average(home team's home-loss rate, away team's away-win rate)
 *   BTTS likelihood      = average(home team's home-BTTS rate, away team's away-BTTS rate)
 *   combined             = away-win likelihood × BTTS likelihood
 *
 * Treating the two legs as independent is a simplification (real matches
 * correlate them), but it keeps the score auditable from the two numbers
 * shown alongside it rather than hidden inside a black-box model.
 */

const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

/**
 * @param {{venue: 'home'|'away', gf: number, ga: number}[]} matches
 */
export function summarizeTeamForm(matches) {
  const home = matches.filter((m) => m.venue === 'home');
  const away = matches.filter((m) => m.venue === 'away');
  const rate = (arr, pred) => (arr.length ? arr.filter(pred).length / arr.length : null);

  return {
    homeSample: home.length,
    awaySample: away.length,
    homeWinPct: rate(home, (m) => m.gf > m.ga),
    homeLossPct: rate(home, (m) => m.gf < m.ga),
    homeBttsPct: rate(home, (m) => m.gf > 0 && m.ga > 0),
    awayWinPct: rate(away, (m) => m.gf > m.ga),
    awayLossPct: rate(away, (m) => m.gf < m.ga),
    awayBttsPct: rate(away, (m) => m.gf > 0 && m.ga > 0),
  };
}

const MIN_SAMPLE_FOR_CONFIDENCE = 5;

/**
 * @param {ReturnType<typeof summarizeTeamForm>} homeForm
 * @param {ReturnType<typeof summarizeTeamForm>} awayForm
 */
export function scoreFixture(homeForm, awayForm) {
  const awaySignals = [homeForm.homeLossPct, awayForm.awayWinPct].filter((v) => v != null);
  const bttsSignals = [homeForm.homeBttsPct, awayForm.awayBttsPct].filter((v) => v != null);
  if (!awaySignals.length || !bttsSignals.length) return null;

  const awayWinLikelihood = avg(awaySignals);
  const bttsLikelihood = avg(bttsSignals);
  const minSample = Math.min(homeForm.homeSample, awayForm.awaySample);

  return {
    awayWinLikelihood,
    bttsLikelihood,
    combined: awayWinLikelihood * bttsLikelihood,
    confidence: minSample >= MIN_SAMPLE_FOR_CONFIDENCE ? 'ok' : 'low',
    sampleHome: homeForm.homeSample,
    sampleAway: awayForm.awaySample,
  };
}
