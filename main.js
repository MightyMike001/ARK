import { fetchTopSpreadMarkets } from './data.js';

const REFRESH_INTERVAL_MS = 60000;
const FILTER_STORAGE_KEY = 'topSpreadFilters';
const DEFAULT_FILTERS = {
  minSpread: 0,
  minVolSurge: 0,
  minVolEur: 100000,
};

const els = {
  topSpreadsBody: document.querySelector('[data-top-spreads]'),
  topSpreadsUpdated: document.querySelector('[data-top-spreads-updated]'),
  filters: {
    minSpread: document.querySelector('[data-filter="minSpread"]'),
    minVolSurge: document.querySelector('[data-filter="minVolSurge"]'),
    minVolEur: document.querySelector('[data-filter="minVolEur"]'),
  },
};

let refreshTimer = null;
let lastFetched = [];
let activeFilters = loadFilters();

function loadFilters() {
  try {
    const stored = localStorage.getItem(FILTER_STORAGE_KEY);
    if (!stored) return { ...DEFAULT_FILTERS };
    const parsed = JSON.parse(stored);
    return {
      minSpread: toSafeNumber(parsed?.minSpread, DEFAULT_FILTERS.minSpread),
      minVolSurge: toSafeNumber(parsed?.minVolSurge, DEFAULT_FILTERS.minVolSurge),
      minVolEur: toSafeNumber(parsed?.minVolEur, DEFAULT_FILTERS.minVolEur),
    };
  } catch (err) {
    console.warn('Kon filters niet laden', err);
    return { ...DEFAULT_FILTERS };
  }
}

function saveFilters() {
  try {
    localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(activeFilters));
  } catch (err) {
    console.warn('Kon filters niet opslaan', err);
  }
}

function toSafeNumber(value, fallback = 0) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function applyFiltersToInputs() {
  Object.entries(activeFilters).forEach(([key, value]) => {
    const input = els.filters[key];
    if (!input) return;
    if (typeof value === 'number') {
      input.value = Number.isFinite(value) ? value : '';
    }
  });
}

function formatNumber(value, digits = 0) {
  if (!Number.isFinite(value)) return '–';
  return value.toLocaleString('nl-NL', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatPercent(value, digits = 2) {
  if (!Number.isFinite(value)) return '–';
  return `${value.toFixed(digits)}%`;
}

function formatScore(value, digits = 2) {
  if (!Number.isFinite(value)) return '–';
  return value.toFixed(digits);
}

function formatPrice(value, digits = 4) {
  if (!Number.isFinite(value)) return '–';
  return `€${value.toFixed(digits)}`;
}

function filterMarkets(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((item) => {
    if (!item) return false;
    const passesSpread = !Number.isFinite(activeFilters.minSpread)
      || item.spreadPct >= activeFilters.minSpread;
    const passesVolumeSurge = !Number.isFinite(activeFilters.minVolSurge)
      || item.volumeSurge >= activeFilters.minVolSurge;
    const passesVolume = !Number.isFinite(activeFilters.minVolEur)
      || item.volumeEur >= activeFilters.minVolEur;
    return passesSpread && passesVolumeSurge && passesVolume;
  });
}

function renderTopSpreads(rawList = []) {
  if (!els.topSpreadsBody) return;
  const list = filterMarkets(rawList);

  if (!list.length) {
    els.topSpreadsBody.innerHTML = '<tr><td colspan="9">Geen markten gevonden</td></tr>';
    if (els.topSpreadsUpdated) {
      els.topSpreadsUpdated.textContent = '–';
    }
    return;
  }

  const rows = list
    .map((item, index) => {
      const rank = index + 1;
      const market = item.market || '–';
      const totalScore = formatScore(item.totalScore, 2);
      const spreadPct = formatPercent(item.spreadPct, 2);
      const volumeSurge = formatScore(item.volumeSurge, 2);
      const range15m = formatPercent(item.range15mPct, 2);
      const wick = formatScore(item.wickiness, 2);
      const volume = Number.isFinite(item.volumeEur)
        ? `€${formatNumber(item.volumeEur, 0)}`
        : '–';
      const lastPrice = formatPrice(item.last, 5);
      const spikeBadge = item.spike ? ' ⚡' : '';
      return `
        <tr data-market="${market}" class="${item.spike ? 'has-spike' : ''}">
          <td class="numeric">${rank}</td>
          <td>${market}</td>
          <td class="numeric">${totalScore}${spikeBadge}</td>
          <td class="numeric">${spreadPct}</td>
          <td class="numeric">${volumeSurge}</td>
          <td class="numeric">${range15m}</td>
          <td class="numeric">${wick}</td>
          <td class="numeric">${volume}</td>
          <td class="numeric">${lastPrice}</td>
        </tr>
      `;
    })
    .join('');

  els.topSpreadsBody.innerHTML = rows;
  if (els.topSpreadsUpdated) {
    const time = new Date().toLocaleTimeString('nl-NL', { hour12: false });
    els.topSpreadsUpdated.textContent = time;
  }
}

async function refreshTopSpreads() {
  try {
    const list = await fetchTopSpreadMarkets({
      limit: 50,
      minVolumeEur: activeFilters.minVolEur,
    });
    lastFetched = Array.isArray(list) ? list : [];
    renderTopSpreads(lastFetched);
  } catch (err) {
    console.warn('Kon top spreads niet verversen', err);
    lastFetched = [];
    renderTopSpreads([]);
  }
}

function handleFilterChange(key, value) {
  if (!(key in activeFilters)) return;
  const safeValue = toSafeNumber(value, DEFAULT_FILTERS[key]);
  activeFilters = { ...activeFilters, [key]: safeValue };
  saveFilters();
  renderTopSpreads(lastFetched);
  refreshTopSpreads();
}

function wireEvents() {
  Object.entries(els.filters).forEach(([key, input]) => {
    if (!input) return;
    input.addEventListener('change', (event) => {
      handleFilterChange(key, event.target.value);
    });
  });
}

function startPolling() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
  refreshTimer = setInterval(() => {
    refreshTopSpreads();
  }, REFRESH_INTERVAL_MS);
  refreshTopSpreads();
}

function init() {
  applyFiltersToInputs();
  wireEvents();
  startPolling();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
