const clampDecimals = (value, decimals) => {
  if (!isFinite(value)) return NaN;
  if (!Number.isFinite(decimals) || decimals < 0) return value;
  return parseFloat(value.toFixed(decimals));
};

const countDecimals = (tick) => {
  if (!isFinite(tick) || tick <= 0) return 0;
  const text = tick.toString();
  if (text.includes('e')) {
    const [base, exp] = text.split('e');
    const baseDecimals = (base.split('.')[1] || '').length;
    const exponent = parseInt(exp, 10);
    return Math.max(0, baseDecimals - exponent);
  }
  return (text.split('.')[1] || '').length;
};

export function roundToTick(value, tick, mode = 'nearest') {
  if (!isFinite(value)) return NaN;
  if (!isFinite(tick) || tick <= 0) return value;
  const decimals = countDecimals(tick);
  const ratio = value / tick;
  const epsilon = Number.EPSILON * Math.max(1, Math.abs(ratio) * 10);
  let steps;

  if (mode === 'down') {
    steps = Math.floor(ratio + epsilon);
  } else if (mode === 'up') {
    steps = Math.ceil(ratio - epsilon);
  } else {
    steps = Math.round(ratio);
  }

  const rounded = steps * tick;
  return clampDecimals(rounded, decimals);
}

export function roundTick(value, tick, mode = 'nearest') {
  return roundToTick(value, tick, mode);
}

export function isOnTick(value, tick) {
  if (!isFinite(value)) return false;
  if (!isFinite(tick) || tick <= 0) return false;
  const rounded = roundToTick(value, tick);
  if (!isFinite(rounded)) return false;
  const tolerance = Math.pow(10, -(countDecimals(tick) + 2));
  return Math.abs(rounded - value) <= tolerance;
}

const sanitizePct = (value) => (isFinite(value) ? Math.max(0, value) : 0);

const resolveRoute = (routeProfile = '') => {
  const normalized = routeProfile.toString().trim().toLowerCase();
  const token = normalized.replace(/\s+/g, '').replace(/-/g, '/');
  switch (token) {
    case 'maker/taker':
      return { buy: 'maker', sell: 'taker' };
    case 'taker/maker':
      return { buy: 'taker', sell: 'maker' };
    case 'taker/taker':
      return { buy: 'taker', sell: 'taker' };
    default:
      return { buy: 'maker', sell: 'maker' };
  }
};

const toTopLevels = (levels) => {
  if (!Array.isArray(levels)) return [];
  const next = [];
  for (const row of levels.slice(0, 3)) {
    if (!Array.isArray(row)) continue;
    const price = parseFloat(row[0]);
    const size = parseFloat(row[1]);
    if (!isFinite(price) || price <= 0 || !isFinite(size) || size <= 0) continue;
    next.push([price, size]);
  }
  return next;
};

const sumNotional = (levels) => levels.reduce((total, [price, size]) => total + price * size, 0);

const depthWeightedPrice = (levels, targetNotional, fallbackPrice) => {
  if (!isFinite(targetNotional) || targetNotional <= 0 || !levels.length) {
    return fallbackPrice;
  }

  let remaining = targetNotional;
  let notional = 0;
  let quantity = 0;

  for (const [price, size] of levels) {
    const levelNotional = price * size;
    if (levelNotional <= 0) continue;

    const takeNotional = Math.min(remaining, levelNotional);
    const takeQuantity = takeNotional / price;
    notional += takeNotional;
    quantity += takeQuantity;
    remaining -= takeNotional;

    if (remaining <= 1e-9) break;
  }

  if (!quantity) return fallbackPrice;
  const average = notional / quantity;
  return isFinite(average) ? average : fallbackPrice;
};

export function compute(bid, ask, params, book = {}) {
  const {
    makerFeePct,
    takerFeePct,
    routeProfile,
    slippagePct,
    minEdgePct,
    positionEur,
    tick,
  } = params;

  const safeTick = tick > 0 ? tick : 0.0001;
  const decimals = countDecimals(safeTick);
  const makerFee = sanitizePct(makerFeePct);
  const takerFee = sanitizePct(takerFeePct);
  const slippage = sanitizePct(slippagePct);
  const route = resolveRoute(routeProfile);
  const buyFeePct = route.buy === 'taker' ? takerFee : makerFee;
  const sellFeePct = route.sell === 'taker' ? takerFee : makerFee;
  const feeBuy = buyFeePct / 100;
  const feeSell = sellFeePct / 100;
  const slip = slippage / 100;
  const roundTripFeePct = buyFeePct + sellFeePct;
  const breakevenSpreadPct = roundTripFeePct + 2 * slippage;

  if (!isFinite(bid) || !isFinite(ask) || bid <= 0 || ask <= 0) {
    return {
      buy: NaN,
      sell: NaN,
      edge: NaN,
      breakeven: clampDecimals(breakevenSpreadPct, 2),
      pnl: NaN,
      go: false,
      showAdvice: false,
      edgeState: 'neutral',
      spreadPct: NaN,
      spreadThreshold: clampDecimals(breakevenSpreadPct + (minEdgePct || 0), 2),
      minEdge: minEdgePct,
      roundTripFeePct: clampDecimals(roundTripFeePct, 2),
    };
  }

  const spreadAbs = ask - bid;
  const mid = (bid + ask) / 2;
  const spreadPct = mid > 0 ? (spreadAbs / mid) * 100 : NaN;

  const spreadThreshold = breakevenSpreadPct + (minEdgePct || 0);

  const candidateBuy = Math.min(bid + safeTick, ask - safeTick);
  const candidateSell = Math.max(ask - safeTick, bid + safeTick);

  const boundedBuy = Math.max(0, candidateBuy);
  const boundedSell = Math.max(0, candidateSell);

  const rawBuy = roundToTick(boundedBuy, safeTick, 'down');
  const rawSell = roundToTick(boundedSell, safeTick, 'up');

  const buy = clampDecimals(rawBuy, decimals);
  const sell = clampDecimals(rawSell, decimals);

  const orderValue = Math.max(0, Number(positionEur) || 0);
  const askLevels = toTopLevels(book.asks);
  const bidLevels = toTopLevels(book.bids);
  const buyDepthNotional = sumNotional(askLevels);
  const sellDepthNotional = sumNotional(bidLevels);

  const depthWarning = orderValue > 0
    && ((buyDepthNotional > 0 && orderValue > buyDepthNotional * 0.25)
      || (sellDepthNotional > 0 && orderValue > sellDepthNotional * 0.25));

  const depthAdjustedBuy = depthWeightedPrice(askLevels, orderValue, buy);
  const depthAdjustedSell = depthWeightedPrice(bidLevels, orderValue, sell);

  const effectiveBuy = depthAdjustedBuy * (1 + feeBuy + slip);
  const effectiveSell = depthAdjustedSell * (1 - feeSell - slip);

  const diff = effectiveSell - effectiveBuy;
  const edge = effectiveBuy > 0 ? (diff / effectiveBuy) * 100 : NaN;
  const pnl = effectiveBuy > 0 ? (positionEur || 0) * (diff / effectiveBuy) : 0;
  const showAdvice = isFinite(spreadPct) && spreadPct >= spreadThreshold;

  let edgeState = 'neutral';
  if (isFinite(edge)) {
    if (edge < 0) {
      edgeState = 'negative';
    } else if (edge >= (minEdgePct || 0)) {
      edgeState = 'positive';
    } else {
      edgeState = 'breakeven';
    }
  }

  const go = showAdvice && edgeState === 'positive';

  return {
    buy: showAdvice ? buy : NaN,
    sell: showAdvice ? sell : NaN,
    edge: clampDecimals(edge, 2),
    breakeven: clampDecimals(breakevenSpreadPct, 2),
    pnl: clampDecimals(pnl, 2),
    go,
    showAdvice,
    edgeState,
    spreadPct: clampDecimals(spreadPct, 3),
    spreadThreshold: clampDecimals(spreadThreshold, 2),
    minEdge: minEdgePct,
    roundTripFeePct: clampDecimals(roundTripFeePct, 2),
    sizeWarning: depthWarning ? 'Size te groot t.o.v. depth' : '',
  };
}
