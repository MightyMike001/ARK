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

export function compute(bid, ask, params) {
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
      minEdge: minEdgePct,
      roundTripFeePct: clampDecimals(roundTripFeePct, 2),
    };
  }

  const rawBuy = Math.max(bid - safeTick, 0);
  const rawSell = ask + safeTick;
  const buy = roundToTick(rawBuy, safeTick, 'down');
  const sell = roundToTick(rawSell, safeTick, 'up');

  const effectiveBuy = buy * (1 + feeBuy + slip);
  const effectiveSell = sell * (1 - feeSell - slip);

  const diff = effectiveSell - effectiveBuy;
  const edge = effectiveBuy > 0 ? (diff / effectiveBuy) * 100 : NaN;
  const pnl = effectiveBuy > 0 ? (positionEur || 0) * (diff / effectiveBuy) : 0;
  const go = isFinite(edge) && edge >= (minEdgePct || 0);

  return {
    buy: clampDecimals(buy, decimals),
    sell: clampDecimals(sell, decimals),
    edge: clampDecimals(edge, 2),
    breakeven: clampDecimals(breakevenSpreadPct, 2),
    pnl: clampDecimals(pnl, 2),
    go,
    minEdge: minEdgePct,
    roundTripFeePct: clampDecimals(roundTripFeePct, 2),
  };
}
