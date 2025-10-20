import { compute } from './calc.js';
import {
  DEFAULT_MARKET,
  fetchMarketSpecifications,
  fetchTicker24hStats,
  fetchTopSpreadMarkets,
  subscribeOrderBook,
} from './data.js';

const ROUTES = [
  { value: 'maker-maker', label: 'Maker/Maker' },
  { value: 'maker-taker', label: 'Maker/Taker' },
  { value: 'taker-taker', label: 'Taker/Taker' },
];

const defaultParams = {
  market: DEFAULT_MARKET,
  depth: 25,
  interval: 5,
  makerFeePct: 0.15,
  takerFeePct: 0.25,
  routeProfile: 'maker-maker',
  slippagePct: 0.05,
  minEdgePct: 0.25,
  positionEur: 250,
  tick: 0.0001,
};

const state = { ...defaultParams };
let stopSubscription = null;
let lastSnapshot = null;
let lastTicker = null;
let topSpreadsTimer = null;
const topSpreadHistory = new Map();
let selectedTopMarket = null;
let lastTopSpreads = [];

const qs = (selector) => document.querySelector(selector);

const els = {
  status: qs('[data-status]'),
  market: qs('#market'),
  depth: qs('#depth'),
  interval: qs('#interval'),
  makerFee: qs('#makerFee'),
  takerFee: qs('#takerFee'),
  route: qs('#route'),
  slippage: qs('#slippage'),
  minEdge: qs('#minEdge'),
  position: qs('#position'),
  tick: qs('#tick'),
  start: qs('#btnStart'),
  stop: qs('#btnStop'),
  bestBid: qs('[data-best-bid]'),
  bestAsk: qs('[data-best-ask]'),
  spreadAbs: qs('[data-spread-abs]'),
  spreadPct: qs('[data-spread-pct]'),
  buy: qs('[data-buy]'),
  sell: qs('[data-sell]'),
  edge: qs('[data-edge]'),
  pnl: qs('[data-pnl]'),
  fees: qs('[data-fees]'),
  breakeven: qs('[data-breakeven]'),
  volume: qs('[data-volume]'),
  updated: qs('[data-updated]'),
  topSpreadsBody: qs('[data-top-spreads]'),
  topSpreadsUpdated: qs('[data-top-spreads-updated]'),
  topSpreadsSelect: qs('[data-top-spreads-select]'),
  topSpreadsChart: qs('[data-top-spreads-chart]'),
  topSpreadsChartEmpty: qs('[data-top-spread-chart-empty]'),
  topSpreadsSelected: qs('[data-top-spread-selected]'),
  topSpreadsCurrent: qs('[data-top-spread-current]'),
};

function setStatus(message, tone = 'neutral') {
  if (!els.status) return;
  els.status.textContent = message;
  els.status.dataset.tone = tone;
}

function formatPrice(value, digits = 4) {
  if (!Number.isFinite(value)) return '–';
  return `€${value.toFixed(digits)}`;
}

function formatPercent(value, digits = 2) {
  if (!Number.isFinite(value)) return '–';
  return `${value.toFixed(digits)}%`;
}

function formatMoney(value) {
  if (!Number.isFinite(value)) return '–';
  return `€${value.toFixed(2)}`;
}

function formatNumber(value, digits = 2) {
  if (!Number.isFinite(value)) return '–';
  return value.toLocaleString('nl-NL', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatVolume(ticker) {
  if (!ticker) return '–';
  const parts = [];
  if (Number.isFinite(ticker.volumeQuote) && ticker.volumeQuote > 0) {
    parts.push(`€${ticker.volumeQuote.toLocaleString('nl-NL', { maximumFractionDigits: 0 })}`);
  }
  if (Number.isFinite(ticker.volumeBase) && ticker.volumeBase > 0) {
    parts.push(`${ticker.volumeBase.toLocaleString('nl-NL', { maximumFractionDigits: 0 })} ARK`);
  }
  return parts.length ? parts.join(' • ') : '–';
}

const MAX_TOP_SPREAD_HISTORY = 240;

function recordTopSpreadsHistory(list = []) {
  if (!Array.isArray(list) || !list.length) return;
  const now = Date.now();
  list.forEach((item) => {
    if (!item || typeof item.market !== 'string') return;
    if (!Number.isFinite(item.spreadPct)) return;
    const timestamp = Number.isFinite(item.timestamp) ? item.timestamp : now;
    const series = topSpreadHistory.get(item.market) || [];
    const lastPoint = series[series.length - 1];
    if (lastPoint && lastPoint.timestamp === timestamp) {
      lastPoint.spreadPct = item.spreadPct;
    } else {
      series.push({ timestamp, spreadPct: item.spreadPct });
    }
    if (series.length > MAX_TOP_SPREAD_HISTORY) {
      series.splice(0, series.length - MAX_TOP_SPREAD_HISTORY);
    }
    topSpreadHistory.set(item.market, series);
  });
}

function updateTopSpreadsSelectionUI() {
  if (els.topSpreadsSelect && selectedTopMarket) {
    els.topSpreadsSelect.value = selectedTopMarket;
  }
  if (els.topSpreadsSelect && !selectedTopMarket) {
    els.topSpreadsSelect.value = '';
  }
  if (els.topSpreadsBody) {
    els.topSpreadsBody.querySelectorAll('tr[data-market]').forEach((row) => {
      row.classList.toggle('is-selected', row.dataset.market === selectedTopMarket);
    });
  }

  const selected = lastTopSpreads.find((item) => item.market === selectedTopMarket);
  if (els.topSpreadsSelected) {
    els.topSpreadsSelected.textContent = selected?.market || '–';
  }
  if (els.topSpreadsCurrent) {
    els.topSpreadsCurrent.textContent = selected
      ? `Spread: ${formatPercent(selected.spreadPct, 2)} • ${formatPrice(selected.spreadAbs, 6)}`
      : 'Spread: –';
  }
}

function drawTopSpreadChart(canvas, data) {
  if (!(canvas instanceof HTMLCanvasElement)) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;

  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  const padding = 16;
  const innerWidth = Math.max(0, width - padding * 2);
  const innerHeight = Math.max(0, height - padding * 2);
  if (!innerWidth || !innerHeight) {
    ctx.restore();
    return;
  }

  const values = data.map((point) => point.spreadPct).filter((value) => Number.isFinite(value));
  const times = data.map((point) => point.timestamp).filter((value) => Number.isFinite(value));
  if (values.length < 2 || times.length < 2) {
    ctx.restore();
    return;
  }

  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const valueRange = maxValue - minValue || 1;
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const timeRange = maxTime - minTime || 1;

  const points = data
    .filter((point) => Number.isFinite(point.spreadPct) && Number.isFinite(point.timestamp))
    .map((point) => ({
      x: padding + ((point.timestamp - minTime) / timeRange) * innerWidth,
      y: padding + (1 - (point.spreadPct - minValue) / valueRange) * innerHeight,
    }));

  if (points.length < 2) {
    ctx.restore();
    return;
  }

  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(60, 166, 106, 0.9)';
  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) {
      ctx.moveTo(point.x, point.y);
    } else {
      ctx.lineTo(point.x, point.y);
    }
  });
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(points[0].x, padding + innerHeight);
  points.forEach((point) => {
    ctx.lineTo(point.x, point.y);
  });
  ctx.lineTo(points[points.length - 1].x, padding + innerHeight);
  ctx.closePath();
  ctx.fillStyle = 'rgba(60, 166, 106, 0.18)';
  ctx.fill();

  ctx.restore();
}

function updateTopSpreadChart() {
  const canvas = els.topSpreadsChart;
  const placeholder = els.topSpreadsChartEmpty;
  if (!canvas) return;

  const history = selectedTopMarket ? topSpreadHistory.get(selectedTopMarket) : null;
  const filtered = Array.isArray(history)
    ? history.filter((point) => Number.isFinite(point.spreadPct) && Number.isFinite(point.timestamp))
    : [];

  if (!filtered.length || filtered.length < 2) {
    if (placeholder) {
      placeholder.hidden = false;
    }
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, width, height);
      ctx.restore();
    }
    return;
  }

  if (placeholder) {
    placeholder.hidden = true;
  }

  const recent = filtered.slice(-60);
  drawTopSpreadChart(canvas, recent);
}

function setSelectedTopSpreadMarket(market) {
  if (typeof market === 'string' && market.trim()) {
    selectedTopMarket = market;
  } else {
    selectedTopMarket = null;
  }
  updateTopSpreadsSelectionUI();
  updateTopSpreadChart();
}

function renderTopSpreads(list = []) {
  if (!els.topSpreadsBody) return;
  lastTopSpreads = Array.isArray(list) ? list : [];

  if (lastTopSpreads.length === 0) {
    els.topSpreadsBody.innerHTML = '<tr><td colspan="7">Geen data beschikbaar</td></tr>';
    if (els.topSpreadsUpdated) {
      els.topSpreadsUpdated.textContent = '–';
    }
    if (els.topSpreadsSelect) {
      els.topSpreadsSelect.innerHTML = '<option value="">Geen markten beschikbaar</option>';
      els.topSpreadsSelect.disabled = true;
    }
    setSelectedTopSpreadMarket(null);
    return;
  }

  const rows = lastTopSpreads
    .map((item, index) => {
      const rank = index + 1;
      const market = item.market || '–';
      const spreadPct = formatPercent(item.spreadPct, 2);
      const spreadAbs = formatPrice(item.spreadAbs, 6);
      const volume = Number.isFinite(item.volumeEur)
        ? `€${formatNumber(item.volumeEur, 0)}`
        : '–';
      const bid = formatPrice(item.bid, 5);
      const ask = formatPrice(item.ask, 5);
      return `
        <tr data-market="${market}">
          <td class="rank">${rank}</td>
          <td>${market}</td>
          <td>${spreadPct}</td>
          <td>${spreadAbs}</td>
          <td>${volume}</td>
          <td>${bid}</td>
          <td>${ask}</td>
        </tr>
      `;
    })
    .join('');

  els.topSpreadsBody.innerHTML = rows;
  if (els.topSpreadsSelect) {
    const options = lastTopSpreads
      .map((item, index) => `<option value="${item.market}">${index + 1}. ${item.market}</option>`)
      .join('');
    els.topSpreadsSelect.innerHTML = options;
    els.topSpreadsSelect.disabled = false;
  }

  if (!selectedTopMarket || !lastTopSpreads.some((item) => item.market === selectedTopMarket)) {
    selectedTopMarket = lastTopSpreads[0]?.market || null;
  }

  updateTopSpreadsSelectionUI();
  updateTopSpreadChart();

  if (els.topSpreadsUpdated) {
    const time = new Date().toLocaleTimeString('nl-NL', { hour12: false });
    els.topSpreadsUpdated.textContent = time;
  }
}

async function refreshTopSpreads() {
  try {
    const list = await fetchTopSpreadMarkets({ limit: 10, minVolumeEur: 100000 });
    recordTopSpreadsHistory(list);
    renderTopSpreads(list);
  } catch (err) {
    console.warn('Kon top spreads niet verversen', err);
    renderTopSpreads([]);
  }
}

function startTopSpreadsUpdates(intervalMs = 60000) {
  if (topSpreadsTimer) {
    clearInterval(topSpreadsTimer);
  }
  const refreshInterval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 60000;
  topSpreadsTimer = setInterval(() => {
    refreshTopSpreads();
  }, refreshInterval);
  refreshTopSpreads();
}

function updateMetrics(snapshot, result) {
  if (!snapshot) return;
  const { bestBid, bestAsk } = snapshot;
  const spreadAbs = Number.isFinite(bestAsk) && Number.isFinite(bestBid)
    ? bestAsk - bestBid
    : NaN;
  const mid = Number.isFinite(bestAsk) && Number.isFinite(bestBid)
    ? (bestAsk + bestBid) / 2
    : NaN;
  const spreadPct = Number.isFinite(spreadAbs) && Number.isFinite(mid) && mid > 0
    ? (spreadAbs / mid) * 100
    : NaN;

  if (els.bestBid) els.bestBid.textContent = formatPrice(bestBid);
  if (els.bestAsk) els.bestAsk.textContent = formatPrice(bestAsk);
  if (els.spreadAbs) els.spreadAbs.textContent = formatPrice(spreadAbs, 6);
  if (els.spreadPct) els.spreadPct.textContent = formatPercent(spreadPct, 3);

  if (result) {
    if (els.buy) els.buy.textContent = formatPrice(result.buy);
    if (els.sell) els.sell.textContent = formatPrice(result.sell);
    if (els.edge) els.edge.textContent = formatPercent(result.netEdgePct, 2);
    if (els.pnl) els.pnl.textContent = formatMoney(result.pnl);
    if (els.fees) els.fees.textContent = formatPercent(result.roundTripFeePct, 2);
    if (els.breakeven) els.breakeven.textContent = formatPercent(result.breakeven, 2);
  }

  if (els.updated) {
    const time = new Date(snapshot.timestamp).toLocaleTimeString('nl-NL', { hour12: false });
    els.updated.textContent = `Laatste update: ${time}`;
  }

  if (els.volume) {
    els.volume.textContent = formatVolume(lastTicker);
  }
}

function readFloat(input, fallback) {
  if (!(input instanceof HTMLInputElement)) return fallback;
  const value = parseFloat(input.value.replace(',', '.'));
  return Number.isFinite(value) ? value : fallback;
}

function readInt(input, fallback) {
  if (!(input instanceof HTMLInputElement)) return fallback;
  const value = parseInt(input.value, 10);
  return Number.isFinite(value) ? value : fallback;
}

function applyParamsFromInputs() {
  state.market = (els.market?.value || defaultParams.market).toUpperCase();
  state.depth = readInt(els.depth, defaultParams.depth);
  state.interval = Math.max(1, readInt(els.interval, defaultParams.interval));
  state.makerFeePct = Math.max(0, readFloat(els.makerFee, defaultParams.makerFeePct));
  state.takerFeePct = Math.max(0, readFloat(els.takerFee, defaultParams.takerFeePct));
  state.routeProfile = ROUTES.some((route) => route.value === els.route?.value)
    ? els.route.value
    : defaultParams.routeProfile;
  state.slippagePct = Math.max(0, readFloat(els.slippage, defaultParams.slippagePct));
  state.minEdgePct = Math.max(0, readFloat(els.minEdge, defaultParams.minEdgePct));
  state.positionEur = Math.max(0, readFloat(els.position, defaultParams.positionEur));
  state.tick = Math.max(0, readFloat(els.tick, defaultParams.tick));
}

function populateDefaults() {
  if (els.market) els.market.value = defaultParams.market;
  if (els.depth) els.depth.value = String(defaultParams.depth);
  if (els.interval) els.interval.value = String(defaultParams.interval);
  if (els.makerFee) els.makerFee.value = String(defaultParams.makerFeePct);
  if (els.takerFee) els.takerFee.value = String(defaultParams.takerFeePct);
  if (els.route) {
    ROUTES.forEach((option) => {
      const opt = document.createElement('option');
      opt.value = option.value;
      opt.textContent = option.label;
      if (option.value === defaultParams.routeProfile) opt.selected = true;
      els.route.appendChild(opt);
    });
  }
  if (els.slippage) els.slippage.value = String(defaultParams.slippagePct);
  if (els.minEdge) els.minEdge.value = String(defaultParams.minEdgePct);
  if (els.position) els.position.value = String(defaultParams.positionEur);
  if (els.tick) els.tick.value = String(defaultParams.tick);
}

function computeAdvice(snapshot) {
  if (!snapshot) return null;
  const params = {
    makerFeePct: state.makerFeePct,
    takerFeePct: state.takerFeePct,
    routeProfile: state.routeProfile,
    slippagePct: state.slippagePct,
    minEdgePct: state.minEdgePct,
    positionEur: state.positionEur,
    tick: state.tick,
  };
  return compute(snapshot.bestBid, snapshot.bestAsk, params, {
    bids: snapshot.bids,
    asks: snapshot.asks,
  });
}

function restartSubscription() {
  if (stopSubscription) {
    stopSubscription();
    stopSubscription = null;
  }

  applyParamsFromInputs();
  setStatus(`Ophalen orderboek voor ${state.market}…`, 'neutral');

  stopSubscription = subscribeOrderBook({
    market: state.market,
    depth: state.depth,
    intervalMs: state.interval * 1000,
    onData: (snapshot) => {
      lastSnapshot = snapshot;
      const result = computeAdvice(snapshot);
      updateMetrics(snapshot, result);
      setStatus(`Live data: ${state.market}`, 'ok');
    },
    onError: (err) => {
      const message = err && typeof err.message === 'string' && err.message.trim()
        ? err.message.trim()
        : 'Onbekende fout';
      setStatus(`Fout bij ophalen: ${message}`, 'warn');
    },
  });
}

function stop() {
  if (stopSubscription) {
    stopSubscription();
    stopSubscription = null;
  }
  setStatus('Gestopt', 'warn');
}

async function refreshMarketMeta() {
  try {
    const spec = await fetchMarketSpecifications(state.market);
    if (spec && Number.isFinite(spec.tickSize) && spec.tickSize > 0) {
      state.tick = spec.tickSize;
      if (els.tick) els.tick.value = String(spec.tickSize);
    }
  } catch (err) {
    console.warn('Kon tick size niet ophalen', err);
  }

  try {
    lastTicker = await fetchTicker24hStats(state.market);
    if (lastSnapshot) {
      const result = computeAdvice(lastSnapshot);
      updateMetrics(lastSnapshot, result);
    }
  } catch (err) {
    console.warn('Kon ticker24h niet verversen', err);
  }
}

function wireEvents() {
  const form = document.getElementById('settingsForm');
  if (form) {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      restartSubscription();
      refreshMarketMeta();
    });
  }

  const inputs = [
    els.market,
    els.depth,
    els.interval,
    els.makerFee,
    els.takerFee,
    els.route,
    els.slippage,
    els.minEdge,
    els.position,
    els.tick,
  ];
  inputs.forEach((input) => {
    if (!input) return;
    input.addEventListener('change', () => {
      applyParamsFromInputs();
      if (lastSnapshot) {
        const result = computeAdvice(lastSnapshot);
        updateMetrics(lastSnapshot, result);
      }
      if (input === els.market) {
        refreshMarketMeta();
      }
    });
  });

  if (els.stop) {
    els.stop.addEventListener('click', (event) => {
      event.preventDefault();
      stop();
    });
  }

  if (els.topSpreadsSelect) {
    els.topSpreadsSelect.addEventListener('change', (event) => {
      setSelectedTopSpreadMarket(event.target.value);
    });
  }

  if (els.topSpreadsBody) {
    els.topSpreadsBody.addEventListener('click', (event) => {
      const row = event.target.closest('tr[data-market]');
      if (!row) return;
      setSelectedTopSpreadMarket(row.dataset.market);
    });
  }

  window.addEventListener('resize', () => {
    updateTopSpreadChart();
  });
}

function init() {
  populateDefaults();
  applyParamsFromInputs();
  wireEvents();
  restartSubscription();
  refreshMarketMeta();
  startTopSpreadsUpdates();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
