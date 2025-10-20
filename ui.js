import { compute, isOnTick } from './calc.js';
import { startDataFeed, fetchMarketSpecifications } from './data.js';

const ROUTE_OPTIONS = [
  { value: 'maker-maker', label: 'Maker/Maker' },
  { value: 'maker-taker', label: 'Maker/Taker' },
  { value: 'taker-taker', label: 'Taker/Taker' },
];

const ROUTE_VALUES = new Set(ROUTE_OPTIONS.map((option) => option.value));

const ensureSettingsControls = () => {
  const form = document.getElementById('settingsForm');
  if (!form) return;

  const makerLabel = document.getElementById('makerFee')?.closest('label');

  if (!document.getElementById('takerFee')) {
    const label = document.createElement('label');
    const span = document.createElement('span');
    span.textContent = 'Taker fee (%)';
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '0.01';
    input.min = '0';
    input.id = 'takerFee';
    label.appendChild(span);
    label.appendChild(input);
    if (makerLabel?.parentElement) {
      makerLabel.parentElement.insertBefore(label, makerLabel.nextSibling);
    } else {
      form.appendChild(label);
    }
  }

  if (!document.getElementById('routeProfile')) {
    const label = document.createElement('label');
    const span = document.createElement('span');
    span.textContent = 'Route';
    const select = document.createElement('select');
    select.id = 'routeProfile';
    ROUTE_OPTIONS.forEach((option) => {
      const opt = document.createElement('option');
      opt.value = option.value;
      opt.textContent = option.label;
      select.appendChild(opt);
    });
    label.appendChild(span);
    label.appendChild(select);
    const takerLabel = document.getElementById('takerFee')?.closest('label');
    if (takerLabel?.parentElement) {
      takerLabel.parentElement.insertBefore(label, takerLabel.nextSibling);
    } else if (makerLabel?.parentElement) {
      makerLabel.parentElement.insertBefore(label, makerLabel.nextSibling);
    } else {
      form.appendChild(label);
    }
  }

  if (!document.getElementById('priceWarning')) {
    const warning = document.createElement('div');
    warning.id = 'priceWarning';
    warning.className = 'hint';
    warning.style.display = 'none';
    warning.setAttribute('role', 'status');
    warning.setAttribute('aria-live', 'polite');
    form.appendChild(warning);
  }

  if (!document.getElementById('tickValidationStyles')) {
    const style = document.createElement('style');
    style.id = 'tickValidationStyles';
    style.textContent = `
      .tick-invalid {
        border-color: #d9534f !important;
        box-shadow: 0 0 0 1px rgba(217, 83, 79, 0.35);
      }

      #priceWarning {
        color: #d9534f;
      }

      .edge-negative {
        color: #d9534f;
      }

      .edge-breakeven {
        color: #f0ad4e;
      }

      .edge-positive {
        color: #3ca66a;
      }
    `;
    document.head?.appendChild(style);
  }
};

const ensureMetricsStructure = () => {
  const metricsEl = document.getElementById('metrics');
  if (!metricsEl) return;
  metricsEl.innerHTML = [
    'Netto edge%: <strong id="edgeValue">–</strong>%',
    'Breakeven spread%: <strong id="breakevenValue">–</strong>%',
    'Roundtrip fees: <strong id="roundTripValue">–</strong>%',
    'P&L/cyclus: <strong id="pnlValue">–</strong>',
    '24h volume: <strong id="volume24hValue">–</strong>',
    'Liquiditeitsscore: <strong id="liquidityScoreValue">–</strong>',
  ].join(' • ');
};

ensureSettingsControls();
ensureMetricsStructure();
ensureSpreadHistoryStructure();

const SPREAD_WINDOW_MS = 15 * 60 * 1000;
const LIQUIDITY_SPREAD_WINDOW_MS = 10 * 60 * 1000;
const MIN_LIQUIDITY_SCORE = 4;
const LIQUIDITY_VOLUME_MIN_EUR = 50000;
const LIQUIDITY_VOLUME_MAX_EUR = 5000000;
const LIQUIDITY_SPREAD_GOOD = 0.002;
const LIQUIDITY_SPREAD_BAD = 0.015;
const spreadHistory = [];
let spreadChartCanvas;
let spreadChartCtx;
let spreadChartPixelRatio = window.devicePixelRatio || 1;
let spreadChartHasResizeListener = false;
let spreadHistoryLatestLabel = null;

function ensureSpreadHistoryStyles() {
  if (document.getElementById('spreadHistoryStyles')) return;
  const style = document.createElement('style');
  style.id = 'spreadHistoryStyles';
  style.textContent = `
    #spreadHistoryCard {
      margin-top: 16px;
      padding: 12px 14px 14px;
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.04);
      background: rgba(15, 20, 29, 0.78);
    }

    #spreadHistoryCard .spread-history-header {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      justify-content: space-between;
      font-size: 12px;
      color: #9aa3ad;
      margin-bottom: 6px;
    }

    #spreadHistoryCard .spread-history-latest {
      color: #e8edf3;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }

    #spreadHistoryCard .spread-history-legend {
      font-size: 11px;
      color: #3ca66a;
      margin-bottom: 6px;
      opacity: 0.8;
    }

    #spreadHistoryCard canvas {
      display: block;
      width: 100%;
      height: 120px;
      border-radius: 8px;
      background: rgba(13, 18, 26, 0.92);
    }
  `;
  document.head?.appendChild(style);
}

function ensureSpreadHistoryStructure() {
  ensureSpreadHistoryStyles();
  const existingCanvas = document.getElementById('spreadHistoryCanvas');
  if (existingCanvas) {
    spreadHistoryLatestLabel = document.getElementById('spreadHistoryLatest') || spreadHistoryLatestLabel;
    return;
  }

  const metricsEl = document.getElementById('metrics');
  const host = metricsEl?.parentElement || document.body;
  if (!host) return;

  const section = document.createElement('section');
  section.id = 'spreadHistoryCard';
  section.className = 'spread-history-card';

  const header = document.createElement('div');
  header.className = 'spread-history-header';

  const title = document.createElement('span');
  title.className = 'spread-history-title';
  title.textContent = 'Spread geschiedenis (15 min)';
  header.appendChild(title);

  const latest = document.createElement('span');
  latest.id = 'spreadHistoryLatest';
  latest.className = 'spread-history-latest';
  latest.textContent = 'Laatste: –';
  header.appendChild(latest);

  section.appendChild(header);

  const legend = document.createElement('div');
  legend.className = 'spread-history-legend';
  legend.textContent = 'Groen = Geschikt';
  section.appendChild(legend);

  const canvas = document.createElement('canvas');
  canvas.id = 'spreadHistoryCanvas';
  canvas.height = 120;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Spread geschiedenis over de laatste 15 minuten');
  section.appendChild(canvas);

  if (metricsEl?.parentElement) {
    metricsEl.parentElement.insertBefore(section, metricsEl.nextSibling);
  } else {
    host.appendChild(section);
  }

  spreadHistoryLatestLabel = latest;
}

function ensureSpreadHistoryChart() {
  ensureSpreadHistoryStructure();
  const canvas = document.getElementById('spreadHistoryCanvas');
  if (!canvas) return false;
  if (!spreadHistoryLatestLabel) {
    spreadHistoryLatestLabel = document.getElementById('spreadHistoryLatest') || spreadHistoryLatestLabel;
  }

  if (!spreadChartCanvas || spreadChartCanvas !== canvas) {
    const context = canvas.getContext('2d');
    if (!context) return false;
    spreadChartCanvas = canvas;
    spreadChartCtx = context;
    spreadChartCanvas.style.width = '100%';
    if (!spreadChartCanvas.style.height) {
      spreadChartCanvas.style.height = '120px';
    }
    resizeSpreadChart({ skipRender: true });
    if (!spreadChartHasResizeListener) {
      window.addEventListener('resize', resizeSpreadChart, { passive: true });
      spreadChartHasResizeListener = true;
    }
  }

  return !!spreadChartCanvas && !!spreadChartCtx;
}

function resizeSpreadChart(options = {}) {
  if (!spreadChartCanvas || !spreadChartCtx) return;
  const ratio = window.devicePixelRatio || 1;
  const rect = spreadChartCanvas.getBoundingClientRect();
  const cssWidth = rect.width || spreadChartCanvas.clientWidth || 320;
  const cssHeight = rect.height || parseFloat(getComputedStyle(spreadChartCanvas).height || '120');
  if (!cssWidth || !cssHeight) return;

  const width = Math.max(1, Math.round(cssWidth * ratio));
  const height = Math.max(1, Math.round(cssHeight * ratio));

  let changed = false;
  if (spreadChartCanvas.width !== width) {
    spreadChartCanvas.width = width;
    changed = true;
  }
  if (spreadChartCanvas.height !== height) {
    spreadChartCanvas.height = height;
    changed = true;
  }

  spreadChartPixelRatio = ratio;

  if (!options.skipRender && (changed || options.force)) {
    renderSpreadChart();
  }
}

function getMinEdgeRatio() {
  const value = parseFloat(params?.minEdgePct);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(0, value) / 100;
}

function updateSpreadHistoryLatestLabel() {
  if (!spreadHistoryLatestLabel) {
    spreadHistoryLatestLabel = document.getElementById('spreadHistoryLatest') || spreadHistoryLatestLabel;
  }
  if (!spreadHistoryLatestLabel) return;

  if (!spreadHistory.length) {
    spreadHistoryLatestLabel.textContent = 'Laatste: –';
    return;
  }

  const last = spreadHistory[spreadHistory.length - 1];
  const spreadLabel = formatSpreadPercent(last.spreadPct);
  const minEdgeRatio = getMinEdgeRatio();
  const meetsEdge = last.showAdvice && isFinite(last.netEdgeRatio) && last.netEdgeRatio >= minEdgeRatio;
  const parts = [`Laatste: ${spreadLabel}`];
  if (last.showAdvice && Number.isFinite(last.netEdgePct)) {
    parts.push(`Edge: ${last.netEdgePct.toFixed(2)}%`);
  }
  if (last.showAdvice) {
    parts.push(meetsEdge ? 'Geschikt' : 'Niet geschikt');
  }
  spreadHistoryLatestLabel.textContent = parts.join(' • ');
}

function renderSpreadChart() {
  if (!ensureSpreadHistoryChart()) {
    updateSpreadHistoryLatestLabel();
    return;
  }
  if (!spreadChartCanvas || !spreadChartCtx) return;

  const ratio = spreadChartPixelRatio || window.devicePixelRatio || 1;
  const width = spreadChartCanvas.width / ratio;
  const height = spreadChartCanvas.height / ratio;
  if (!width || !height) {
    updateSpreadHistoryLatestLabel();
    return;
  }

  const ctx = spreadChartCtx;
  ctx.save();
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = 'rgba(13, 18, 26, 0.92)';
  ctx.fillRect(0, 0, width, height);

  const cutoff = Date.now() - SPREAD_WINDOW_MS;
  while (spreadHistory.length && spreadHistory[0].timestamp < cutoff) {
    spreadHistory.shift();
  }

  const now = Date.now();
  const latestTimestamp = spreadHistory.length ? spreadHistory[spreadHistory.length - 1].timestamp : now;
  const windowEnd = Math.max(latestTimestamp, now);
  const windowStart = windowEnd - SPREAD_WINDOW_MS;
  const points = spreadHistory.filter((point) => point.timestamp >= windowStart);

  if (!points.length) {
    ctx.restore();
    updateSpreadHistoryLatestLabel();
    return;
  }

  let minSpread = Infinity;
  let maxSpread = -Infinity;
  points.forEach(({ spreadPct }) => {
    if (isFinite(spreadPct)) {
      if (spreadPct < minSpread) minSpread = spreadPct;
      if (spreadPct > maxSpread) maxSpread = spreadPct;
    }
  });

  if (!isFinite(minSpread) || !isFinite(maxSpread)) {
    minSpread = 0;
    maxSpread = 0.0001;
  }

  if (maxSpread - minSpread < 1e-6) {
    const base = maxSpread || 0.0001;
    minSpread = Math.max(0, base * 0.5);
    maxSpread = base * 1.5;
  } else {
    const padding = (maxSpread - minSpread) * 0.2;
    minSpread = Math.max(0, minSpread - padding);
    maxSpread += padding;
  }

  const span = maxSpread - minSpread || 1;
  const toX = (timestamp) => {
    const clamped = Math.min(Math.max(timestamp, windowStart), windowEnd);
    return ((clamped - windowStart) / SPREAD_WINDOW_MS) * width;
  };
  const toY = (value) => {
    if (!isFinite(value)) return height;
    const normalized = (value - minSpread) / span;
    return height - normalized * height;
  };

  const minEdgeRatio = getMinEdgeRatio();
  ctx.fillStyle = 'rgba(60, 166, 106, 0.18)';
  let segmentStart = null;
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    const meetsEdge = point.showAdvice && isFinite(point.netEdgeRatio) && point.netEdgeRatio >= minEdgeRatio;
    const currentTime = Math.max(point.timestamp, windowStart);
    if (meetsEdge) {
      if (segmentStart === null) {
        segmentStart = currentTime;
      }
    } else if (segmentStart !== null) {
      const x1 = toX(segmentStart);
      const x2 = toX(currentTime);
      if (x2 > x1) {
        ctx.fillRect(x1, 0, x2 - x1, height);
      }
      segmentStart = null;
    }

    if (i === points.length - 1 && segmentStart !== null) {
      const x1 = toX(segmentStart);
      const x2 = toX(windowEnd);
      if (x2 > x1) {
        ctx.fillRect(x1, 0, x2 - x1, height);
      }
      segmentStart = null;
    }
  }

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
  ctx.lineWidth = 1;
  const gridLines = 4;
  for (let i = 1; i < gridLines; i += 1) {
    const y = (height / gridLines) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(200, 167, 106, 0.9)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  points.forEach((point, index) => {
    const x = toX(point.timestamp);
    const y = toY(point.spreadPct);
    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();

  const lastPoint = points[points.length - 1];
  const lastX = toX(lastPoint.timestamp);
  const lastY = toY(lastPoint.spreadPct);
  ctx.fillStyle = 'rgba(200, 167, 106, 0.9)';
  ctx.beginPath();
  ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = 'rgba(154, 163, 173, 0.85)';
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  ctx.textAlign = 'right';
  ctx.fillText(`${(maxSpread * 100).toFixed(2)}%`, width - 4, 12);
  ctx.fillText(`${(minSpread * 100).toFixed(2)}%`, width - 4, height - 4);

  ctx.restore();

  updateSpreadHistoryLatestLabel();
}

function recordSpreadPoint(entry) {
  if (!entry) return;
  const timestamp = Number(entry.timestamp);
  if (!Number.isFinite(timestamp)) return;
  const spreadPctValue = Number(entry.spreadPct);
  const bestBidValue = Number(entry.bestBid);
  const bestAskValue = Number(entry.bestAsk);
  const netEdgeRatioValue = Number(entry.netEdgeRatio);
  const netEdgePctValue = Number(entry.netEdgePct);

  spreadHistory.push({
    timestamp,
    spreadPct: Number.isFinite(spreadPctValue) ? spreadPctValue : NaN,
    bestBid: Number.isFinite(bestBidValue) ? bestBidValue : NaN,
    bestAsk: Number.isFinite(bestAskValue) ? bestAskValue : NaN,
    netEdgeRatio: Number.isFinite(netEdgeRatioValue) ? netEdgeRatioValue : NaN,
    netEdgePct: Number.isFinite(netEdgePctValue) ? netEdgePctValue : NaN,
    showAdvice: Boolean(entry.showAdvice),
  });
  const cutoff = Date.now() - SPREAD_WINDOW_MS;
  while (spreadHistory.length && spreadHistory[0].timestamp < cutoff) {
    spreadHistory.shift();
  }
  renderSpreadChart();
}

const EDGE_STATE_CLASSES = ['edge-negative', 'edge-breakeven', 'edge-positive'];

const els = {
  badge: document.getElementById('statusBadge'),
  buy: document.getElementById('buyValue'),
  sell: document.getElementById('sellValue'),
  edge: document.getElementById('edgeValue'),
  breakeven: document.getElementById('breakevenValue'),
  roundTrip: document.getElementById('roundTripValue'),
  pnl: document.getElementById('pnlValue'),
  bid: document.getElementById('bidValue'),
  ask: document.getElementById('askValue'),
  spreadAbs: document.getElementById('spreadAbsValue'),
  spreadPct: document.getElementById('spreadPctValue'),
  bidDepth: document.getElementById('bidDepthValue'),
  askDepth: document.getElementById('askDepthValue'),
  volume24h: document.getElementById('volume24hValue'),
  liquidityScore: document.getElementById('liquidityScoreValue'),
  tickInfo: document.getElementById('tickInfo'),
  sourceInfo: document.getElementById('sourceInfo'),
  copyBuy: document.getElementById('copyBuy'),
  copySell: document.getElementById('copySell'),
  makerFee: document.getElementById('makerFee'),
  takerFee: document.getElementById('takerFee'),
  route: document.getElementById('routeProfile'),
  slippage: document.getElementById('slippage'),
  minEdge: document.getElementById('minEdge'),
  position: document.getElementById('position'),
  tick: document.getElementById('tick'),
  priceWarning: document.getElementById('priceWarning'),
};

const defaults = {
  makerFeePct: 0.15,
  takerFeePct: 0.25,
  routeProfile: 'maker-maker',
  slippagePct: 0.05,
  minEdgePct: 0.25,
  positionEur: 250,
  tick: 0.0001,
};

const storageKey = 'ark_advice_settings_v1';
let lastTick;
let latestBidAsk = { bid: NaN, ask: NaN };
let latestLevels = { bids: [], asks: [] };
let params = { ...defaults };
let quoteDecimals = 4;
let manualInvalidSides = new Set();
let manualPriceError = '';
let tickerStats = { volumeBase: NaN, volumeQuote: NaN, bid: NaN, ask: NaN, last: NaN, timestamp: 0 };
let liquidityState = { score: NaN, averageSpread: NaN, volumeQuote: NaN, volumeBase: NaN };

const decimalsFromTick = (tickValue = params.tick) => {
  const tick = typeof tickValue === 'string' ? parseFloat(tickValue) : tickValue;
  if (!isFinite(tick) || tick <= 0) return 4;
  const text = tick.toString();
  if (text.includes('e')) {
    const [base, exp] = text.split('e');
    const baseDecimals = (base.split('.')[1] || '').length;
    const exponent = parseInt(exp, 10);
    return Math.max(0, baseDecimals - exponent);
  }
  return Math.max(0, (text.split('.')[1] || '').length);
};

const limitPriceDecimals = (value) => Math.min(Math.max(value, 0), 8);

const getPriceDecimals = () => {
  const tickDecimals = decimalsFromTick();
  if (Number.isFinite(quoteDecimals) && quoteDecimals >= 0) {
    return Math.max(tickDecimals, quoteDecimals);
  }
  return Math.max(tickDecimals, 4);
};

const formatTickSize = (tickValue = params.tick) => {
  const tick = typeof tickValue === 'string' ? parseFloat(tickValue) : tickValue;
  if (!isFinite(tick) || tick <= 0) return '–';
  const decimals = limitPriceDecimals(decimalsFromTick(tick));
  return `€${tick.toFixed(decimals)}`;
};

const formatPrice = (value) => {
  if (!isFinite(value)) return '–';
  return `€${value.toFixed(limitPriceDecimals(getPriceDecimals()))}`;
};

const formatPercent = (value) => {
  if (!isFinite(value)) return '–';
  return value.toFixed(2);
};

const formatSpreadPercent = (value) => {
  if (!isFinite(value)) return '–';
  return `${(value * 100).toFixed(3)}%`;
};

const formatSpreadAbs = (value) => {
  if (!isFinite(value)) return '–';
  return `€${value.toFixed(5)}`;
};

const formatMoney = (value) => {
  if (!isFinite(value)) return '–';
  return `€${value.toFixed(2)}`;
};

const formatVolume24h = (volumeQuote, volumeBase) => {
  const parts = [];
  if (Number.isFinite(volumeQuote) && volumeQuote > 0) {
    const euroText = volumeQuote.toLocaleString('nl-NL', { maximumFractionDigits: 0 });
    parts.push(`€${euroText}`);
  }
  if (Number.isFinite(volumeBase) && volumeBase > 0) {
    const baseText = volumeBase.toLocaleString('nl-NL', { maximumFractionDigits: 0 });
    parts.push(`${baseText} ARK`);
  }
  return parts.length ? parts.join(' • ') : '–';
};

const formatLiquidityScore = (score) => {
  if (!Number.isFinite(score)) return '–';
  return score.toFixed(1);
};

const formatDepth = (notional, volume) => {
  if (!isFinite(notional) || !isFinite(volume)) return '–';
  const euroText = notional.toLocaleString('nl-NL', { maximumFractionDigits: 0 });
  const volumeText = volume.toLocaleString('nl-NL', { maximumFractionDigits: 2 });
  return `€${euroText} • ${volumeText} ARK`;
};

const setPriceWarning = (message) => {
  if (!els.priceWarning) return;
  if (message) {
    els.priceWarning.textContent = message;
    els.priceWarning.style.display = 'block';
  } else {
    els.priceWarning.textContent = '';
    els.priceWarning.style.display = 'none';
  }
};

const applyActionState = (button, enabled, message) => {
  if (!button) return;
  button.disabled = !enabled;
  if (!enabled && message) {
    button.title = message;
    button.setAttribute('aria-disabled', 'true');
  } else {
    button.removeAttribute('title');
    button.removeAttribute('aria-disabled');
  }
};

const validatePriceInputs = () => {
  const inputs = Array.from(document.querySelectorAll('[data-enforce-tick]'));
  const invalidSides = new Set();
  let message = '';
  const tickValue = params.tick;

  if (!inputs.length) {
    return { invalidSides, message };
  }

  if (!isFinite(tickValue) || tickValue <= 0) {
    inputs.forEach((input) => {
      if (!(input instanceof HTMLInputElement)) return;
      input.setCustomValidity('');
      input.classList.remove('tick-invalid');
      input.removeAttribute('title');
    });
    return { invalidSides, message };
  }

  const tickText = formatTickSize(tickValue);
  const baseMessage = tickText === '–'
    ? 'Prijs moet een veelvoud zijn van de tick size.'
    : `Prijs moet een veelvoud zijn van ${tickText}.`;

  inputs.forEach((input) => {
    if (!(input instanceof HTMLInputElement)) return;
    const raw = typeof input.value === 'string' ? input.value.replace(',', '.') : '';
    const numeric = parseFloat(raw);
    if (!isFinite(numeric)) {
      input.setCustomValidity('');
      input.classList.remove('tick-invalid');
      input.removeAttribute('title');
      return;
    }

    if (isOnTick(numeric, tickValue)) {
      input.setCustomValidity('');
      input.classList.remove('tick-invalid');
      input.removeAttribute('title');
      return;
    }

    input.setCustomValidity(baseMessage);
    input.classList.add('tick-invalid');
    input.title = baseMessage;

    const side = (input.dataset.side || '').toLowerCase();
    if (side === 'buy' || side === 'sell') {
      invalidSides.add(side);
    } else {
      invalidSides.add('buy');
      invalidSides.add('sell');
    }

    if (!message) {
      message = baseMessage;
    }
  });

  return { invalidSides, message };
};

const formatTime = (timestamp) => {
  if (!timestamp) return 'Laatste tick: –';
  const date = new Date(timestamp);
  return `Laatste tick: ${date.toLocaleTimeString('nl-NL', { hour12: false })}`;
};

const getMidPrice = () => {
  if (Number.isFinite(latestBidAsk.bid) && Number.isFinite(latestBidAsk.ask)) {
    const mid = (latestBidAsk.bid + latestBidAsk.ask) / 2;
    if (Number.isFinite(mid) && mid > 0) return mid;
  }
  if (Number.isFinite(tickerStats.bid) && Number.isFinite(tickerStats.ask)) {
    const mid = (tickerStats.bid + tickerStats.ask) / 2;
    if (Number.isFinite(mid) && mid > 0) return mid;
  }
  if (Number.isFinite(tickerStats.last) && tickerStats.last > 0) {
    return tickerStats.last;
  }
  return NaN;
};

const computeAverageSpread = (sample, windowMs = LIQUIDITY_SPREAD_WINDOW_MS) => {
  const referenceTime = Number(sample?.timestamp) || Date.now();
  const cutoff = referenceTime - windowMs;
  let sum = 0;
  let count = 0;

  for (const entry of spreadHistory) {
    if (!Number.isFinite(entry?.spreadPct)) continue;
    if (entry.timestamp < cutoff) continue;
    sum += entry.spreadPct;
    count += 1;
  }

  if (sample && Number.isFinite(sample.spreadPct) && sample.timestamp >= cutoff) {
    sum += sample.spreadPct;
    count += 1;
  }

  return count > 0 ? sum / count : NaN;
};

const computeLiquidityScore = (volumeEur, averageSpread) => {
  if (!Number.isFinite(volumeEur) || volumeEur <= 0) return NaN;

  const minVolume = Math.max(1, LIQUIDITY_VOLUME_MIN_EUR);
  const maxVolume = Math.max(minVolume + 1, LIQUIDITY_VOLUME_MAX_EUR);
  const logMin = Math.log10(minVolume);
  const logMax = Math.log10(maxVolume);
  const volumeValue = Math.max(volumeEur, minVolume / 10);
  const volumeRatio = Math.min(
    1,
    Math.max(0, (Math.log10(volumeValue) - logMin) / (logMax - logMin))
  );

  let spreadRatio = 0;
  if (Number.isFinite(averageSpread) && averageSpread > 0) {
    const clamped = Math.min(
      LIQUIDITY_SPREAD_BAD,
      Math.max(averageSpread, LIQUIDITY_SPREAD_GOOD)
    );
    const denom = LIQUIDITY_SPREAD_BAD - LIQUIDITY_SPREAD_GOOD;
    spreadRatio = denom > 0 ? (LIQUIDITY_SPREAD_BAD - clamped) / denom : 0;
  }

  const combined = (volumeRatio * 0.65) + (spreadRatio * 0.35);
  const rawScore = 1 + combined * 9;
  const clampedScore = Math.min(10, Math.max(1, rawScore));
  return Math.round(clampedScore * 10) / 10;
};

const renderLiquidity = () => {
  if (els.volume24h) {
    els.volume24h.textContent = formatVolume24h(liquidityState.volumeQuote, liquidityState.volumeBase);
  }

  if (els.liquidityScore) {
    const scoreText = formatLiquidityScore(liquidityState.score);
    els.liquidityScore.textContent = scoreText;
    if (Number.isFinite(liquidityState.score)) {
      els.liquidityScore.title = Number.isFinite(liquidityState.averageSpread)
        ? `Gemiddelde spread: ${(liquidityState.averageSpread * 100).toFixed(2)}% (rolling ${Math.round(LIQUIDITY_SPREAD_WINDOW_MS / 60000)} min)`
        : '';
    } else {
      els.liquidityScore.removeAttribute('title');
    }
  }
};

const recalculateLiquidity = (spreadSample) => {
  const averageSpread = computeAverageSpread(spreadSample, LIQUIDITY_SPREAD_WINDOW_MS);

  let volumeQuote = Number.isFinite(tickerStats.volumeQuote) && tickerStats.volumeQuote >= 0
    ? tickerStats.volumeQuote
    : NaN;
  const volumeBase = Number.isFinite(tickerStats.volumeBase) && tickerStats.volumeBase >= 0
    ? tickerStats.volumeBase
    : NaN;

  if (!Number.isFinite(volumeQuote) && Number.isFinite(volumeBase) && volumeBase > 0) {
    const mid = getMidPrice();
    if (Number.isFinite(mid) && mid > 0) {
      volumeQuote = volumeBase * mid;
    }
  }

  const score = computeLiquidityScore(volumeQuote, averageSpread);
  liquidityState = {
    score: Number.isFinite(score) ? score : NaN,
    averageSpread,
    volumeQuote: Number.isFinite(volumeQuote) ? volumeQuote : NaN,
    volumeBase,
  };
  renderLiquidity();
  return liquidityState;
};

const updateTickInfo = () => {
  if (!els.tickInfo) return;
  const tickText = formatTickSize(params.tick);
  const tickLabel = tickText === '–' ? 'Tick size: onbekend' : `Tick size: ${tickText}`;
  const timeLabel = formatTime(lastTick);
  els.tickInfo.textContent = `${tickLabel} • ${timeLabel}`;

  if (els.tick && isFinite(params.tick) && params.tick > 0) {
    const decimals = limitPriceDecimals(decimalsFromTick(params.tick));
    els.tick.value = params.tick.toFixed(decimals);
    els.tick.step = params.tick.toString();
    els.tick.min = params.tick.toString();
  }
};

const updateBadge = (go, showAdvice) => {
  if (!els.badge) return;
  if (!showAdvice) {
    els.badge.textContent = '–';
    els.badge.classList.remove('go');
    els.badge.classList.remove('nogo');
    return;
  }

  els.badge.textContent = go ? 'Geschikt?' : 'Niet geschikt';
  els.badge.classList.toggle('go', go);
  els.badge.classList.toggle('nogo', !go);
};

const applyEdgeState = (state, showAdvice) => {
  if (!els.edge) return;
  els.edge.classList.remove(...EDGE_STATE_CLASSES);
  if (!showAdvice) return;
  if (state === 'negative') {
    els.edge.classList.add('edge-negative');
  } else if (state === 'breakeven') {
    els.edge.classList.add('edge-breakeven');
  } else if (state === 'positive') {
    els.edge.classList.add('edge-positive');
  }
};

const updateMetrics = () => {
  const result = compute(latestBidAsk.bid, latestBidAsk.ask, params, latestLevels);
  const baseGo = result.go;
  els.buy.textContent = formatPrice(result.buy);
  els.sell.textContent = formatPrice(result.sell);
  els.edge.textContent = formatPercent(result.showAdvice ? result.edge : NaN);
  els.breakeven.textContent = formatPercent(result.breakeven);
  if (els.roundTrip) {
    els.roundTrip.textContent = formatPercent(result.roundTripFeePct);
  }
  els.pnl.textContent = formatMoney(result.showAdvice ? result.pnl : NaN);

  applyEdgeState(result.edgeState, result.showAdvice);

  const tickValue = params.tick;
  const hasBuy = isFinite(result.buy);
  const hasSell = isFinite(result.sell);
  const buyOnTick = !hasBuy || isOnTick(result.buy, tickValue);
  const sellOnTick = !hasSell || isOnTick(result.sell, tickValue);

  const validation = validatePriceInputs();
  manualInvalidSides = validation.invalidSides;
  manualPriceError = validation.message;

  const tickMessage = ((hasBuy && !buyOnTick) || (hasSell && !sellOnTick))
    && isFinite(tickValue) && tickValue > 0
    ? `Adviesprijs moet een veelvoud zijn van ${formatTickSize(tickValue)}.`
    : '';

  const buyMessage = manualInvalidSides.has('buy')
    ? manualPriceError
    : (hasBuy && !buyOnTick ? tickMessage : '');
  const sellMessage = manualInvalidSides.has('sell')
    ? manualPriceError
    : (hasSell && !sellOnTick ? tickMessage : '');

  const warnings = [];
  if (result.sizeWarning) warnings.push(result.sizeWarning);
  if (buyMessage && !warnings.includes(buyMessage)) warnings.push(buyMessage);
  if (sellMessage && !warnings.includes(sellMessage)) warnings.push(sellMessage);

  const liquidityScore = Number.isFinite(liquidityState.score) ? liquidityState.score : NaN;
  const meetsLiquidity = Number.isFinite(liquidityScore) ? liquidityScore >= MIN_LIQUIDITY_SCORE : true;
  const liquidityMessage = `Liquiditeitsscore te laag (${formatLiquidityScore(liquidityScore)} < ${MIN_LIQUIDITY_SCORE}).`;
  if (!meetsLiquidity && !warnings.includes(liquidityMessage)) {
    warnings.push(liquidityMessage);
  }

  let generalAdviceMessage = '';
  if (!result.showAdvice) {
    generalAdviceMessage = 'Spread te smal voor advies.';
  } else {
    if (!baseGo) {
      generalAdviceMessage = 'Netto edge onder minimumdrempel.';
    }
    if (!meetsLiquidity && !generalAdviceMessage) {
      generalAdviceMessage = liquidityMessage;
    }
  }
  if (!warnings.length && generalAdviceMessage) {
    warnings.push(generalAdviceMessage);
  }

  setPriceWarning(warnings.join(' '));

  const buyEnabled = hasBuy && !buyMessage;
  const sellEnabled = hasSell && !sellMessage;

  const spreadLimitedMessage = generalAdviceMessage;

  applyActionState(
    els.copyBuy,
    buyEnabled,
    buyMessage || (!hasBuy ? spreadLimitedMessage || 'Nog geen koopadvies beschikbaar.' : '')
  );
  applyActionState(
    els.copySell,
    sellEnabled,
    sellMessage || (!hasSell ? spreadLimitedMessage || 'Nog geen verkoopadvies beschikbaar.' : '')
  );

  const finalGo = result.showAdvice && baseGo && meetsLiquidity;
  updateBadge(finalGo, result.showAdvice);
  result.go = finalGo;
  result.liquidityScore = liquidityScore;
  result.meetsLiquidity = meetsLiquidity;
  return result;
};

const refreshMetrics = () => {
  const result = updateMetrics();
  renderSpreadChart();
  return result;
};

const loadSettings = () => {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey));
    if (stored && typeof stored === 'object') {
      params = { ...params, ...stored };
    }
  } catch (_) {}

  const routeValue = ROUTE_VALUES.has(params.routeProfile)
    ? params.routeProfile
    : defaults.routeProfile;
  params.routeProfile = routeValue;

  const parsedTick = parseFloat(params.tick);
  params.tick = isFinite(parsedTick) && parsedTick > 0 ? parsedTick : defaults.tick;

  if (els.makerFee) els.makerFee.value = params.makerFeePct;
  if (els.takerFee) els.takerFee.value = params.takerFeePct;
  if (els.route) els.route.value = params.routeProfile;
  if (els.slippage) els.slippage.value = params.slippagePct;
  if (els.minEdge) els.minEdge.value = params.minEdgePct;
  if (els.position) els.position.value = params.positionEur;
  if (els.tick) {
    const decimals = limitPriceDecimals(decimalsFromTick(params.tick));
    els.tick.value = isFinite(params.tick) ? params.tick.toFixed(decimals) : '';
    if (params.tick > 0) {
      els.tick.step = params.tick;
      els.tick.min = params.tick;
    }
  }
  updateTickInfo();
  refreshMetrics();
};

const persistSettings = () => {
  localStorage.setItem(storageKey, JSON.stringify(params));
};

const readParam = (target, key) => {
  const value = parseFloat(target.value);
  if (!isFinite(value)) {
    refreshMetrics();
    return;
  }

  if (key === 'tick') {
    if (value > 0) {
      params.tick = value;
    } else if (isFinite(params.tick) && params.tick > 0) {
      target.value = params.tick;
    } else {
      params.tick = defaults.tick;
      target.value = defaults.tick;
    }
    updateTickInfo();
  } else {
    params[key] = Math.max(0, value);
  }
  refreshMetrics();
  persistSettings();
};

const readRoute = (target) => {
  const value = target.value;
  params.routeProfile = ROUTE_VALUES.has(value) ? value : defaults.routeProfile;
  refreshMetrics();
  persistSettings();
};

const registerSettings = () => {
  if (els.makerFee) {
    els.makerFee.addEventListener('change', (e) => readParam(e.target, 'makerFeePct'));
  }
  if (els.takerFee) {
    els.takerFee.addEventListener('change', (e) => readParam(e.target, 'takerFeePct'));
  }
  if (els.route) {
    els.route.addEventListener('change', (e) => readRoute(e.target));
  }
  if (els.slippage) {
    els.slippage.addEventListener('change', (e) => readParam(e.target, 'slippagePct'));
  }
  if (els.minEdge) {
    els.minEdge.addEventListener('change', (e) => readParam(e.target, 'minEdgePct'));
  }
  if (els.position) {
    els.position.addEventListener('change', (e) => readParam(e.target, 'positionEur'));
  }
  if (els.tick) {
    els.tick.addEventListener('change', (e) => readParam(e.target, 'tick'));
  }
};

const handleTick = ({ bid, ask, timestamp, source, spreadAbs, spreadPct, depth, bids, asks }) => {
  latestBidAsk = { bid, ask };
  lastTick = timestamp;
  els.bid.textContent = formatPrice(bid);
  els.ask.textContent = formatPrice(ask);
  if (els.spreadAbs) {
    els.spreadAbs.textContent = formatSpreadAbs(spreadAbs);
  }
  if (els.spreadPct) {
    els.spreadPct.textContent = formatSpreadPercent(spreadPct);
  }
  if (Array.isArray(bids)) {
    latestLevels.bids = bids.slice(0, 3);
  }
  if (Array.isArray(asks)) {
    latestLevels.asks = asks.slice(0, 3);
  }

  if (depth) {
    if (els.bidDepth) {
      els.bidDepth.textContent = formatDepth(depth.bidNotional, depth.bidVolume);
    }
    if (els.askDepth) {
      els.askDepth.textContent = formatDepth(depth.askNotional, depth.askVolume);
    }
  }
  updateTickInfo();
  if (source) {
    els.sourceInfo.textContent = source === 'ws' ? 'Bron: Bitvavo WebSocket' : 'Bron: Binance (poll)';
  }
  recalculateLiquidity({ timestamp, spreadPct });
  const result = updateMetrics();
  recordSpreadPoint({
    timestamp,
    spreadPct,
    bestBid: bid,
    bestAsk: ask,
    netEdgeRatio: result?.netEdgeRatio,
    netEdgePct: result?.netEdgePct,
    showAdvice: Boolean(result?.showAdvice),
  });
};

const handleTicker = (ticker) => {
  if (!ticker || typeof ticker !== 'object') return;
  const volumeBase = Number(ticker.volumeBase);
  const volumeQuote = Number(ticker.volumeQuote);
  const bid = Number(ticker.bid);
  const ask = Number(ticker.ask);
  const last = Number(ticker.last);
  const timestamp = Number(ticker.timestamp) || Date.now();

  tickerStats = {
    volumeBase: Number.isFinite(volumeBase) && volumeBase >= 0 ? volumeBase : NaN,
    volumeQuote: Number.isFinite(volumeQuote) && volumeQuote >= 0 ? volumeQuote : NaN,
    bid: Number.isFinite(bid) && bid > 0 ? bid : tickerStats.bid,
    ask: Number.isFinite(ask) && ask > 0 ? ask : tickerStats.ask,
    last: Number.isFinite(last) && last > 0 ? last : tickerStats.last,
    timestamp,
  };

  recalculateLiquidity();
  refreshMetrics();
};

const handleSourceChange = (source) => {
  if (!source) {
    els.sourceInfo.textContent = '';
  } else if (source === 'ws') {
    els.sourceInfo.textContent = 'Bron: Bitvavo WebSocket';
  } else {
    els.sourceInfo.textContent = 'Bron: Binance (poll)';
  }
};

const copyToClipboard = (value) => {
  if (!isFinite(value) || !navigator.clipboard) return;
  if (!isOnTick(value, params.tick)) return;
  const decimals = limitPriceDecimals(getPriceDecimals());
  navigator.clipboard.writeText(value.toFixed(decimals));
};

const registerManualValidation = () => {
  const handler = (event) => {
    const target = event.target;
    if (!target || !(target instanceof HTMLInputElement)) return;
    if (!('enforceTick' in target.dataset)) return;
    refreshMetrics();
  };

  document.addEventListener('input', handler);
  document.addEventListener('change', handler);
};

const applyMarketSpecifications = (spec) => {
  if (!spec || typeof spec !== 'object') return;

  const { tickSize, amountQuoteDecimals } = spec;
  let tickChanged = false;

  if (isFinite(tickSize) && tickSize > 0) {
    const previousTick = params.tick;
    const tolerance = Math.max(Number.EPSILON, tickSize * 1e-8);
    if (!isFinite(previousTick) || Math.abs(previousTick - tickSize) > tolerance) {
      tickChanged = true;
    }
    params.tick = tickSize;
  }

  const decimalsValue = Number(amountQuoteDecimals);
  if (Number.isFinite(decimalsValue) && decimalsValue >= 0) {
    quoteDecimals = decimalsValue;
  }

  updateTickInfo();
  if (tickChanged) {
    persistSettings();
  }
  refreshMetrics();
};

const loadMarketSpecifications = async () => {
  try {
    const spec = await fetchMarketSpecifications();
    if (spec) {
      applyMarketSpecifications(spec);
    }
  } catch (err) {
    console.warn('Kon marktspecificaties niet laden', err);
  }
};

const registerActions = () => {
  if (els.copyBuy) {
    els.copyBuy.addEventListener('click', () => {
      const result = compute(latestBidAsk.bid, latestBidAsk.ask, params, latestLevels);
      copyToClipboard(result.buy);
    });
  }
  if (els.copySell) {
    els.copySell.addEventListener('click', () => {
      const result = compute(latestBidAsk.bid, latestBidAsk.ask, params, latestLevels);
      copyToClipboard(result.sell);
    });
  }
};

const start = () => {
  ensureSpreadHistoryStructure();
  loadSettings();
  registerSettings();
  registerManualValidation();
  registerActions();
  renderLiquidity();
  startDataFeed(handleTick, handleSourceChange, handleTicker);
  loadMarketSpecifications();
};

start();
