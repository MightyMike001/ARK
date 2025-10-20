import { compute } from './calc.js';
import { startDataFeed } from './data.js';

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
};

const ensureMetricsStructure = () => {
  const metricsEl = document.getElementById('metrics');
  if (!metricsEl) return;
  metricsEl.innerHTML = `Net edge: <strong id="edgeValue">–</strong>% • `
    + `Breakeven spread%: <strong id="breakevenValue">–</strong>% • `
    + `Roundtrip fees: <strong id="roundTripValue">–</strong>% • `
    + `P&L/cyclus: <strong id="pnlValue">–</strong>`;
};

ensureSettingsControls();
ensureMetricsStructure();

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
let params = { ...defaults };

const formatPrice = (value) => {
  if (!isFinite(value)) return '–';
  return `€${value.toFixed(4)}`;
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

const formatDepth = (notional, volume) => {
  if (!isFinite(notional) || !isFinite(volume)) return '–';
  const euroText = notional.toLocaleString('nl-NL', { maximumFractionDigits: 0 });
  const volumeText = volume.toLocaleString('nl-NL', { maximumFractionDigits: 2 });
  return `€${euroText} • ${volumeText} ARK`;
};

const updateBadge = (go) => {
  els.badge.textContent = go ? 'GO' : 'NO-GO';
  els.badge.classList.toggle('go', go);
  els.badge.classList.toggle('nogo', !go);
};

const updateMetrics = () => {
  const result = compute(latestBidAsk.bid, latestBidAsk.ask, params);
  els.buy.textContent = formatPrice(result.buy);
  els.sell.textContent = formatPrice(result.sell);
  els.edge.textContent = formatPercent(result.edge);
  els.breakeven.textContent = formatPercent(result.breakeven);
  if (els.roundTrip) {
    els.roundTrip.textContent = formatPercent(result.roundTripFeePct);
  }
  els.pnl.textContent = formatMoney(result.pnl);
  updateBadge(result.go);
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

  if (els.makerFee) els.makerFee.value = params.makerFeePct;
  if (els.takerFee) els.takerFee.value = params.takerFeePct;
  if (els.route) els.route.value = params.routeProfile;
  if (els.slippage) els.slippage.value = params.slippagePct;
  if (els.minEdge) els.minEdge.value = params.minEdgePct;
  if (els.position) els.position.value = params.positionEur;
  if (els.tick) els.tick.value = params.tick;
  updateMetrics();
};

const persistSettings = () => {
  localStorage.setItem(storageKey, JSON.stringify(params));
};

const readParam = (target, key) => {
  const value = parseFloat(target.value);
  if (isFinite(value)) {
    params[key] = Math.max(0, value);
  }
  updateMetrics();
  persistSettings();
};

const readRoute = (target) => {
  const value = target.value;
  params.routeProfile = ROUTE_VALUES.has(value) ? value : defaults.routeProfile;
  updateMetrics();
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

const formatTime = (timestamp) => {
  if (!timestamp) return 'Laatste tick: –';
  const date = new Date(timestamp);
  return `Laatste tick: ${date.toLocaleTimeString('nl-NL', { hour12: false })}`;
};

const handleTick = ({ bid, ask, timestamp, source, spreadAbs, spreadPct, depth }) => {
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
  if (depth) {
    if (els.bidDepth) {
      els.bidDepth.textContent = formatDepth(depth.bidNotional, depth.bidVolume);
    }
    if (els.askDepth) {
      els.askDepth.textContent = formatDepth(depth.askNotional, depth.askVolume);
    }
  }
  els.tickInfo.textContent = formatTime(lastTick);
  if (source) {
    els.sourceInfo.textContent = source === 'ws' ? 'Bron: Bitvavo WebSocket' : 'Bron: Binance (poll)';
  }
  updateMetrics();
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

const decimalsFromTick = () => {
  const tick = params.tick;
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

const copyToClipboard = (value) => {
  if (!isFinite(value) || !navigator.clipboard) return;
  const decimals = Math.max(0, decimalsFromTick());
  navigator.clipboard.writeText(value.toFixed(decimals));
};

const registerActions = () => {
  els.copyBuy.addEventListener('click', () => {
    const result = compute(latestBidAsk.bid, latestBidAsk.ask, params);
    copyToClipboard(result.buy);
  });
  els.copySell.addEventListener('click', () => {
    const result = compute(latestBidAsk.bid, latestBidAsk.ask, params);
    copyToClipboard(result.sell);
  });
};

const start = () => {
  loadSettings();
  registerSettings();
  registerActions();
  startDataFeed(handleTick, handleSourceChange);
};

start();
