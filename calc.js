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
  const minEdgePctValue = sanitizePct(minEdgePct);
  const minEdgeRatio = minEdgePctValue / 100;
  const roundTripFeeRatio = feeBuy + feeSell;
  const roundTripFeePct = roundTripFeeRatio * 100;
  const breakevenSpreadRatio = roundTripFeeRatio + 2 * slip;
  const breakevenSpreadPct = breakevenSpreadRatio * 100;

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
      spreadThreshold: clampDecimals(breakevenSpreadPct + minEdgePctValue, 2),
      minEdge: minEdgePctValue,
      roundTripFeePct: clampDecimals(roundTripFeePct, 2),
      netEdgeRatio: NaN,
      netEdgePct: NaN,
    };
  }

  const spreadAbs = ask - bid;
  const mid = (bid + ask) / 2;
  const spreadRatio = mid > 0 ? spreadAbs / mid : NaN;

  const spreadPct = isFinite(spreadRatio) ? spreadRatio * 100 : NaN;

  const spreadThreshold = breakevenSpreadPct + minEdgePctValue;

  const hasMeaningfulSpread = Number.isFinite(spreadAbs) && spreadAbs > safeTick;

  let candidateBuy = hasMeaningfulSpread
    ? Math.min(bid + safeTick, ask - safeTick)
    : bid;
  if (!Number.isFinite(candidateBuy) || candidateBuy <= 0) {
    candidateBuy = bid;
  }
  if (candidateBuy < bid) {
    candidateBuy = bid;
  }

  let candidateSell = hasMeaningfulSpread
    ? Math.max(ask - safeTick, bid + safeTick)
    : ask;
  if (!Number.isFinite(candidateSell) || candidateSell <= 0) {
    candidateSell = ask;
  }
  if (candidateSell > ask) {
    candidateSell = ask;
  }

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

  const netEdgeRatio = isFinite(spreadRatio)
    ? spreadRatio - roundTripFeeRatio - 2 * slip
    : NaN;
  const edge = isFinite(netEdgeRatio) ? netEdgeRatio * 100 : NaN;
  const pnlRaw = isFinite(netEdgeRatio) ? orderValue * netEdgeRatio : NaN;
  const pnl = isFinite(pnlRaw) ? pnlRaw : NaN;
  const showAdvice = isFinite(netEdgeRatio);
  const meetsEdge = showAdvice && netEdgeRatio >= minEdgeRatio;

  let edgeState = 'neutral';
  if (isFinite(netEdgeRatio)) {
    if (netEdgeRatio < 0) {
      edgeState = 'negative';
    } else if (netEdgeRatio >= minEdgeRatio) {
      edgeState = 'positive';
    } else {
      edgeState = 'breakeven';
    }
  }

  const go = meetsEdge;

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
    minEdge: minEdgePctValue,
    roundTripFeePct: clampDecimals(roundTripFeePct, 2),
    sizeWarning: depthWarning ? 'Size te groot t.o.v. depth' : '',
    netEdgeRatio,
    netEdgePct: isFinite(edge) ? edge : NaN,
  };
}
