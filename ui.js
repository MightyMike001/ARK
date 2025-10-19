import { compute } from './calc.js';
import { startDataFeed } from './data.js';

const els = {
  badge: document.getElementById('statusBadge'),
  buy: document.getElementById('buyValue'),
  sell: document.getElementById('sellValue'),
  edge: document.getElementById('edgeValue'),
  breakeven: document.getElementById('breakevenValue'),
  pnl: document.getElementById('pnlValue'),
  bid: document.getElementById('bidValue'),
  ask: document.getElementById('askValue'),
  tickInfo: document.getElementById('tickInfo'),
  sourceInfo: document.getElementById('sourceInfo'),
  copyBuy: document.getElementById('copyBuy'),
  copySell: document.getElementById('copySell'),
  makerFee: document.getElementById('makerFee'),
  slippage: document.getElementById('slippage'),
  minEdge: document.getElementById('minEdge'),
  position: document.getElementById('position'),
  tick: document.getElementById('tick'),
};

const defaults = {
  makerFeePct: 0.15,
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

const formatMoney = (value) => {
  if (!isFinite(value)) return '–';
  return `€${value.toFixed(2)}`;
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

  els.makerFee.value = params.makerFeePct;
  els.slippage.value = params.slippagePct;
  els.minEdge.value = params.minEdgePct;
  els.position.value = params.positionEur;
  els.tick.value = params.tick;
  updateMetrics();
};

const persistSettings = () => {
  localStorage.setItem(storageKey, JSON.stringify(params));
};

const readParam = (target, key) => {
  const value = parseFloat(target.value);
  if (isFinite(value)) {
    params[key] = value;
  }
  updateMetrics();
  persistSettings();
};

const registerSettings = () => {
  els.makerFee.addEventListener('change', (e) => readParam(e.target, 'makerFeePct'));
  els.slippage.addEventListener('change', (e) => readParam(e.target, 'slippagePct'));
  els.minEdge.addEventListener('change', (e) => readParam(e.target, 'minEdgePct'));
  els.position.addEventListener('change', (e) => readParam(e.target, 'positionEur'));
  els.tick.addEventListener('change', (e) => readParam(e.target, 'tick'));
};

const formatTime = (timestamp) => {
  if (!timestamp) return 'Laatste tick: –';
  const date = new Date(timestamp);
  return `Laatste tick: ${date.toLocaleTimeString('nl-NL', { hour12: false })}`;
};

const handleTick = ({ bid, ask, timestamp, source }) => {
  latestBidAsk = { bid, ask };
  lastTick = timestamp;
  els.bid.textContent = formatPrice(bid);
  els.ask.textContent = formatPrice(ask);
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
