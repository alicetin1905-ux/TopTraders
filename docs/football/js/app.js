import { pct, kickoff, relativeAgo } from './format.js';

const state = {
  fixtures: [],
  league: '',
  hideLowSample: false,
  search: '',
};

const els = {
  metaRow: document.getElementById('metaRow'),
  hero: document.getElementById('hero'),
  heroMatch: document.getElementById('heroMatch'),
  heroFigures: document.getElementById('heroFigures'),
  leagueFilter: document.getElementById('leagueFilter'),
  hideLowSample: document.getElementById('hideLowSample'),
  teamSearch: document.getElementById('teamSearch'),
  rows: document.getElementById('rows'),
  emptyState: document.getElementById('emptyState'),
};

function meter(value, cls = '') {
  const w = value == null ? 0 : Math.round(value * 100);
  return `
    <div class="meter">
      <div class="meter-track"><div class="meter-fill ${cls}" style="width:${w}%"></div></div>
      <span class="meter-value">${pct(value)}</span>
    </div>`;
}

function renderMeta(payload) {
  const sourceLabel = payload.source === 'api-football' ? 'Live · API-Football' : 'Demo data';
  els.metaRow.innerHTML = `
    <span class="badge source-${payload.source}">${sourceLabel}</span>
    <span>Refreshed ${relativeAgo(payload.generatedAt)}</span>
  `;
}

function renderHero(fixtures) {
  const top = fixtures[0];
  if (!top) { els.hero.hidden = true; return; }
  els.hero.hidden = false;
  els.heroMatch.innerHTML = `<span class="home">${top.home.name}</span><span class="vs">vs</span>${top.away.name}`;
  els.heroFigures.innerHTML = `
    <div class="figure"><div class="figure-value">${pct(top.score.combined)}</div><div class="figure-label">Away win + BTTS</div></div>
    <div class="figure"><div class="figure-value">${pct(top.score.awayWinLikelihood)}</div><div class="figure-label">Away win likelihood</div></div>
    <div class="figure"><div class="figure-value">${pct(top.score.bttsLikelihood)}</div><div class="figure-label">BTTS likelihood</div></div>
    <div class="figure"><div class="figure-value">${top.league}</div><div class="figure-label">${kickoff(top.date)}</div></div>
  `;
}

function populateLeagues(fixtures) {
  const leagues = [...new Set(fixtures.map((f) => f.league))].sort();
  els.leagueFilter.innerHTML = '<option value="">All leagues</option>' +
    leagues.map((l) => `<option value="${l}">${l}</option>`).join('');
}

function applyFilters() {
  return state.fixtures.filter((f) => {
    if (state.league && f.league !== state.league) return false;
    if (state.hideLowSample && f.score.confidence === 'low') return false;
    if (state.search) {
      const q = state.search.toLowerCase();
      if (!f.home.name.toLowerCase().includes(q) && !f.away.name.toLowerCase().includes(q)) return false;
    }
    return true;
  });
}

function render() {
  const filtered = applyFilters();
  renderHero(filtered);

  els.emptyState.hidden = filtered.length > 0;
  els.rows.innerHTML = filtered.map((f) => `
    <tr>
      <td class="kickoff" data-label="Kickoff">${kickoff(f.date)}</td>
      <td class="league" data-label="League">${f.league}</td>
      <td class="fixture" data-label="Fixture">
        <span class="home">${f.home.name}</span><span class="vs">vs</span>${f.away.name}
        ${f.score.confidence === 'low' ? '<span class="confidence-low" title="Fewer than 5 recent matches on record for one side">low sample</span>' : ''}
      </td>
      <td data-label="Away win">${meter(f.score.awayWinLikelihood)}</td>
      <td data-label="BTTS">${meter(f.score.bttsLikelihood)}</td>
      <td data-label="Combined">${meter(f.score.combined, 'combined')}</td>
    </tr>
  `).join('');
}

async function main() {
  const res = await fetch('./data/fixtures.json', { cache: 'no-store' });
  const payload = await res.json();
  state.fixtures = payload.fixtures;

  renderMeta(payload);
  populateLeagues(state.fixtures);
  render();

  els.leagueFilter.addEventListener('change', (e) => { state.league = e.target.value; render(); });
  els.hideLowSample.addEventListener('change', (e) => { state.hideLowSample = e.target.checked; render(); });
  els.teamSearch.addEventListener('input', (e) => { state.search = e.target.value; render(); });
}

main().catch((err) => {
  console.error(err);
  els.rows.innerHTML = '';
  els.emptyState.hidden = false;
  els.emptyState.textContent = 'Could not load fixture data.';
});
