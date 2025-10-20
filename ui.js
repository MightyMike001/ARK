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
  metricsEl.innerHTML = `Net edge: <strong id="edgeValue">–</strong>% • `
    + `Breakeven spread%: <strong id="breakevenValue">–</strong>% • `
    + `Roundtrip fees: <strong id="roundTripValue">–</strong>% • `
    + `P&L/cyclus: <strong id="pnlValue">–</strong>`;
};

ensureSettingsControls();
ensureMetricsStructure();

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

const updateBadge = (go) => {
  els.badge.textContent = go ? 'GO' : 'NO-GO';
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

  const generalAdviceMessage = result.showAdvice ? '' : 'Spread te smal voor advies.';
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
  updateMetrics();
};

const persistSettings = () => {
  localStorage.setItem(storageKey, JSON.stringify(params));
};

const readParam = (target, key) => {
  const value = parseFloat(target.value);
  if (!isFinite(value)) {
    updateMetrics();
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
    updateMetrics();
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
  updateMetrics();
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
  loadSettings();
  registerSettings();
  registerManualValidation();
  registerActions();
  startDataFeed(handleTick, handleSourceChange);
  loadMarketSpecifications();
};

start();
