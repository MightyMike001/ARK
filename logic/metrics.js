const clamp = (value, min, max) => {
  if (!Number.isFinite(value)) return Number.isFinite(min) ? min : 0;
  let next = value;
  if (Number.isFinite(min) && next < min) {
    next = min;
  }
  if (Number.isFinite(max) && next > max) {
    next = max;
  }
  return next;
};

const median = (values) => {
  if (!Array.isArray(values) || !values.length) return NaN;
  const filtered = values.filter((value) => Number.isFinite(value));
  if (!filtered.length) return NaN;
  const sorted = filtered.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle];
};

const calculateRangePct = (candle) => {
  if (!candle) return NaN;
  const { high, low, close } = candle;
  if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close) || close <= 0) {
    return NaN;
  }
  return ((high - low) / close) * 100;
};

const calculateWickiness = (candle) => {
  if (!candle) return NaN;
  const {
    high, low, open, close,
  } = candle;
  if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(open) || !Number.isFinite(close)) {
    return NaN;
  }
  const upper = Math.max(0, high - Math.max(open, close));
  const lower = Math.max(0, Math.min(open, close) - low);
  const body = Math.abs(close - open);
  if (!Number.isFinite(body) || body === 0) {
    return NaN;
  }
  return (upper + lower) / body;
};

const calculateSpreadPct = (book) => {
  if (!book) return NaN;
  const { ask, bid } = book;
  if (!Number.isFinite(ask) || !Number.isFinite(bid) || ask <= 0 || bid <= 0) {
    return NaN;
  }
  const mid = (ask + bid) / 2;
  if (!Number.isFinite(mid) || mid <= 0) return NaN;
  return ((ask - bid) / mid) * 100;
};

export const computeVolatilityIndicators = ({ candles = {}, book = null } = {}) => {
  const list15m = Array.isArray(candles['15m']) ? candles['15m'] : [];
  const last = list15m[list15m.length - 1];
  const previous = list15m[list15m.length - 2];
  const historyWindow = list15m.length > 1
    ? list15m.slice(Math.max(0, list15m.length - 21), list15m.length - 1)
    : [];

  const range15mPct = calculateRangePct(last);
  const rangeHistory = historyWindow.map((candle) => calculateRangePct(candle)).filter((value) => Number.isFinite(value));
  const rangeMedian = median(rangeHistory);
  const wickiness = calculateWickiness(last);

  const volumeHistory = historyWindow
    .map((candle) => (Number.isFinite(candle?.volume) ? candle.volume : NaN));
  const positiveHistory = volumeHistory.filter((value) => Number.isFinite(value) && value > 0);
  const volumeMedian = median(volumeHistory);
  const positiveMedian = median(positiveHistory);
  const lastVolume = Number.isFinite(last?.volume) ? last.volume : NaN;

  let volumeSurge = NaN;
  if (Number.isFinite(lastVolume)) {
    const referenceMedian = (Number.isFinite(positiveMedian) && positiveMedian > 0)
      ? positiveMedian
      : volumeMedian;

    if (Number.isFinite(referenceMedian) && referenceMedian > 0) {
      volumeSurge = lastVolume / referenceMedian;
    } else if (lastVolume > 0) {
      volumeSurge = lastVolume;
    } else {
      volumeSurge = 0;
    }
  }

  const spreadPct = calculateSpreadPct(book);

  const highSpike = Number.isFinite(last?.high) && Number.isFinite(previous?.high) && previous.high > 0
    ? last.high > previous.high * 1.01
    : false;

  const rangeSpike = Number.isFinite(range15mPct) && Number.isFinite(rangeMedian) && rangeMedian > 0
    ? range15mPct > rangeMedian * 1.5
    : false;

  const spike = Boolean(highSpike && rangeSpike);

  return {
    spreadPct: Number.isFinite(spreadPct) ? spreadPct : NaN,
    range15mPct: Number.isFinite(range15mPct) ? range15mPct : NaN,
    wickiness: Number.isFinite(wickiness) ? wickiness : NaN,
    volumeSurge: Number.isFinite(volumeSurge) ? volumeSurge : NaN,
    spike,
  };
};

export const scoreMarket = (item, candles, book) => {
  const safeCandles = {
    ...candles,
    '15m': Array.isArray(candles?.['15m']) ? candles['15m'] : [],
  };

  const volatility = computeVolatilityIndicators({ candles: safeCandles, book });

  const volumeSurge = Number.isFinite(volatility.volumeSurge) ? volatility.volumeSurge : NaN;
  const wickiness = Number.isFinite(volatility.wickiness) ? volatility.wickiness : NaN;
  const range15mPct = Number.isFinite(volatility.range15mPct) ? volatility.range15mPct : NaN;
  const spreadScore = clamp(Number.isFinite(item.spreadPct) ? item.spreadPct / 1.5 : NaN, 0, 1);
  const volScore = clamp(volumeSurge / 3, 0, 1);
  const wickScore = clamp(wickiness / 6, 0, 1);
  const spikeBonus = volatility.spike ? 0.1 : 0;
  const totalScoreRaw = 0.45 * spreadScore + 0.35 * volScore + 0.2 * wickScore + spikeBonus;
  const totalScore = Number.isFinite(totalScoreRaw) ? totalScoreRaw : 0;

  return {
    ...item,
    volumeSurge,
    wickiness,
    range15mPct,
    spreadScore,
    volScore,
    wickScore,
    spike: Boolean(volatility.spike),
    totalScore,
  };
};

export const buildScoredList = (candidates, candlesByMarket) => {
  const list = Array.isArray(candidates) ? candidates : [];
  return list
    .map((item) => {
      const candles = candlesByMarket.get(item.market) ?? { '15m': [] };
      const book = { ask: item.ask, bid: item.bid };
      return scoreMarket(item, candles, book);
    })
    .filter((item) => Number.isFinite(item.spreadPct) && item.spreadPct > 0)
    .sort((a, b) => {
      if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
      if (b.spreadPct !== a.spreadPct) return b.spreadPct - a.spreadPct;
      if (b.spreadAbs !== a.spreadAbs) return b.spreadAbs - a.spreadAbs;
      return (b.volumeEur || 0) - (a.volumeEur || 0);
    });
};

export const summarizeMetrics = (baseCandidates, finalList) => {
  const spreads = (baseCandidates || [])
    .map((item) => (Number.isFinite(item?.spreadPct) ? item.spreadPct : NaN))
    .filter((value) => Number.isFinite(value) && value > 0);
  const averageSpread = spreads.length
    ? spreads.reduce((sum, value) => sum + value, 0) / spreads.length
    : NaN;

  const topFive = (finalList || [])
    .slice(0, 5)
    .map((item) => ({
      market: item.market,
      totalScore: item.totalScore,
      spreadPct: item.spreadPct,
      volumeEur: item.volumeEur,
      spike: Boolean(item.spike),
    }));

  return {
    scannedCount: Array.isArray(baseCandidates) ? baseCandidates.length : 0,
    averageSpread,
    spikeCount: Array.isArray(finalList)
      ? finalList.filter((item) => item?.spike).length
      : 0,
    topFive,
  };
};

export { clamp };
