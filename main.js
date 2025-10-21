import { createTopSpreadPoller } from './data.js';

const UI_UPDATE_DEBOUNCE_MS = 300;
const STORAGE_KEY = 'arkScannerCfg';
const LEGACY_STORAGE_KEY = 'topSpreadFilters';
const DEFAULT_THRESHOLDS = {
  minSpread: 0.8,
  minVolSurge: 1.5,
  min24hVolEur: 15000,
};
const DEFAULT_ENABLED = {
  minSpread: true,
  minVolSurge: true,
  min24hVolEur: true,
};

const els = {
  topSpreadsBody: document.querySelector('[data-top-spreads]'),
  topSpreadsUpdated: document.querySelector('[data-top-spreads-updated]'),
  filters: {
    minSpread: document.querySelector('[data-filter="minSpread"]'),
    minVolSurge: document.querySelector('[data-filter="minVolSurge"]'),
    min24hVolEur: document.querySelector('[data-filter="min24hVolEur"]'),
  },
  toggles: {
    minSpread: document.querySelector('[data-toggle="minSpread"]'),
    minVolSurge: document.querySelector('[data-toggle="minVolSurge"]'),
    min24hVolEur: document.querySelector('[data-toggle="min24hVolEur"]'),
  },
};

let renderTimer = null;
let lastFetched = [];
let activeConfig = loadConfig();
let dataFeed = null;
let unsubscribeFeed = null;

const cloneDefaults = () => ({
  thresholds: { ...DEFAULT_THRESHOLDS },
  enabled: { ...DEFAULT_ENABLED },
});

function toSafeNumber(value, fallback = 0) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function parseStoredConfig(raw) {
  if (!raw || typeof raw !== 'object') {
    return cloneDefaults();
  }

  const defaults = cloneDefaults();
  const thresholds = { ...defaults.thresholds };
  const enabled = { ...defaults.enabled };

  Object.keys(thresholds).forEach((key) => {
    const candidate = raw?.thresholds?.[key]
      ?? raw?.filters?.[key]
      ?? raw?.[key];
    thresholds[key] = toSafeNumber(candidate, defaults.thresholds[key]);
  });

  Object.keys(enabled).forEach((key) => {
    const flag = raw?.enabled?.[key];
    enabled[key] = typeof flag === 'boolean' ? flag : defaults.enabled[key];
  });

  return { thresholds, enabled };
}

function loadConfig() {
  const defaults = cloneDefaults();

  if (typeof localStorage === 'undefined') {
    return defaults;
  }

  const readConfig = (key) => {
    try {
      const stored = localStorage.getItem(key);
      if (!stored) return null;
      const parsed = JSON.parse(stored);
      return parseStoredConfig(parsed);
    } catch (err) {
      console.warn(`Kon configuratie niet laden (${key})`, err);
      return null;
    }
  };

  return readConfig(STORAGE_KEY)
    ?? readConfig(LEGACY_STORAGE_KEY)
    ?? defaults;
}

function saveConfig() {
  if (typeof localStorage === 'undefined') {
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(activeConfig));
  } catch (err) {
    console.warn('Kon configuratie niet opslaan', err);
  }
}

function applyConfigToInputs() {
  const { thresholds, enabled } = activeConfig;

  Object.entries(els.filters).forEach(([key, input]) => {
    if (!input) return;
    const value = thresholds[key];
    if (typeof value === 'number') {
      input.value = Number.isFinite(value) ? value : '';
    }
    input.disabled = !enabled[key];
  });

  Object.entries(els.toggles).forEach(([key, toggle]) => {
    if (!toggle) return;
    toggle.checked = Boolean(enabled[key]);
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
  const { thresholds, enabled } = activeConfig;
  return list.filter((item) => {
    if (!item) return false;
    const passesSpread = !enabled.minSpread
      || !Number.isFinite(thresholds.minSpread)
      || item.spreadPct >= thresholds.minSpread;
    const passesVolumeSurge = !enabled.minVolSurge
      || !Number.isFinite(thresholds.minVolSurge)
      || item.volumeSurge >= thresholds.minVolSurge;
    const passesVolume = !enabled.min24hVolEur
      || !Number.isFinite(thresholds.min24hVolEur)
      || item.volumeEur >= thresholds.min24hVolEur;
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

function scheduleRender() {
  if (renderTimer) {
    clearTimeout(renderTimer);
  }
  renderTimer = setTimeout(() => {
    renderTimer = null;
    renderTopSpreads(lastFetched);
  }, UI_UPDATE_DEBOUNCE_MS);
}

function handleDataUpdate(list) {
  lastFetched = Array.isArray(list) ? list : [];
  scheduleRender();
}

function getActiveMinVolumeThreshold() {
  const { thresholds, enabled } = activeConfig;
  if (!enabled.min24hVolEur) return 0;
  const value = thresholds.min24hVolEur;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function ensureDataFeed() {
  const minVolume = getActiveMinVolumeThreshold();
  if (!dataFeed) {
    dataFeed = createTopSpreadPoller({
      limit: 50,
      minVolumeEur: minVolume,
    });
    unsubscribeFeed = dataFeed.subscribe(handleDataUpdate);
    return;
  }
  dataFeed.updateOptions({
    limit: 50,
    minVolumeEur: minVolume,
  });
}

function stopDataFeed() {
  if (typeof unsubscribeFeed === 'function') {
    unsubscribeFeed();
    unsubscribeFeed = null;
  }
  if (dataFeed) {
    dataFeed.stop?.();
    dataFeed = null;
  }
}

function handleThresholdChange(key, value) {
  if (!(key in activeConfig.thresholds)) return;
  const safeValue = toSafeNumber(value, DEFAULT_THRESHOLDS[key]);
  activeConfig = {
    thresholds: { ...activeConfig.thresholds, [key]: safeValue },
    enabled: { ...activeConfig.enabled },
  };
  saveConfig();
  applyConfigToInputs();
  ensureDataFeed();
  scheduleRender();
}

function handleToggleChange(key, nextState) {
  if (!(key in activeConfig.enabled)) return;
  activeConfig = {
    thresholds: { ...activeConfig.thresholds },
    enabled: { ...activeConfig.enabled, [key]: Boolean(nextState) },
  };
  saveConfig();
  applyConfigToInputs();
  ensureDataFeed();
  scheduleRender();
}

function wireEvents() {
  Object.entries(els.filters).forEach(([key, input]) => {
    if (!input) return;
    input.addEventListener('change', (event) => {
      handleThresholdChange(key, event.target.value);
    });
  });

  Object.entries(els.toggles).forEach(([key, toggle]) => {
    if (!toggle) return;
    toggle.addEventListener('change', (event) => {
      handleToggleChange(key, event.target.checked);
    });
  });
}

function init() {
  applyConfigToInputs();
  wireEvents();
  ensureDataFeed();
  scheduleRender();
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    stopDataFeed();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
