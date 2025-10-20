const BITVAVO_BASE_URL = 'https://api.bitvavo.com/v2';
export const DEFAULT_MARKET = 'ARK-EUR';

const parseNumber = (value) => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : NaN;
  }
  if (typeof value === 'string') {
    const normalized = value.replace(',', '.').trim();
    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return NaN;
};

const sanitizeDepth = (value) => {
  const depth = Number.parseInt(value, 10);
  if (!Number.isFinite(depth) || depth <= 0) return 25;
  return Math.min(500, depth);
};

const isValidLevel = (price, amount) => price > 0 && amount > 0 && Number.isFinite(price) && Number.isFinite(amount);

const normalizeLevels = (rows, side) => {
  if (!Array.isArray(rows)) return [];
  const sorter = side === 'bids'
    ? (a, b) => b[0] - a[0]
    : (a, b) => a[0] - b[0];

  return rows
    .map((row) => {
      if (!Array.isArray(row)) return null;
      const price = parseNumber(row[0]);
      const amount = parseNumber(row[1]);
      return isValidLevel(price, amount) ? [price, amount] : null;
    })
    .filter(Boolean)
    .sort(sorter);
};

const fetchJson = async (url) => {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
};

export async function fetchOrderBook(market = DEFAULT_MARKET, depth = 25) {
  const marketId = typeof market === 'string' ? market.toUpperCase() : DEFAULT_MARKET;
  const safeDepth = sanitizeDepth(depth);
  const url = `${BITVAVO_BASE_URL}/${encodeURIComponent(marketId)}/book?depth=${safeDepth}`;
  const payload = await fetchJson(url);
  const bids = normalizeLevels(payload?.bids, 'bids').slice(0, safeDepth);
  const asks = normalizeLevels(payload?.asks, 'asks').slice(0, safeDepth);
  const bestBid = bids.length ? bids[0][0] : NaN;
  const bestAsk = asks.length ? asks[0][0] : NaN;

  return {
    market: marketId,
    bids,
    asks,
    bestBid,
    bestAsk,
    timestamp: Date.now(),
  };
}

const normalizeTickerPayload = (payload, marketId) => {
  if (!payload) return null;
  const rawMarket = (payload.market || payload.Market || '').toUpperCase();
  const resolvedMarket = marketId || rawMarket;
  if (!resolvedMarket) return null;
  if (marketId && rawMarket && rawMarket !== marketId) return null;

  const volumeBase = parseNumber(
    payload.volume
      ?? payload.amount
      ?? payload.baseVolume
      ?? payload.volumeBase,
  );
  const volumeQuote = parseNumber(
    payload.volumeQuote
      ?? payload.quoteVolume
      ?? payload.quote,
  );
  const bestBid = parseNumber(payload.bid ?? payload.bestBid);
  const bestAsk = parseNumber(payload.ask ?? payload.bestAsk);
  const last = parseNumber(payload.last ?? payload.price ?? payload.lastPrice);
  const high = parseNumber(payload.high);
  const low = parseNumber(payload.low);
  const timestamp = parseNumber(payload.timestamp ?? payload.time) || Date.now();

  return {
    market: resolvedMarket,
    volumeBase: Number.isFinite(volumeBase) && volumeBase >= 0 ? volumeBase : NaN,
    volumeQuote: Number.isFinite(volumeQuote) && volumeQuote >= 0 ? volumeQuote : NaN,
    bid: Number.isFinite(bestBid) && bestBid > 0 ? bestBid : NaN,
    ask: Number.isFinite(bestAsk) && bestAsk > 0 ? bestAsk : NaN,
    last: Number.isFinite(last) && last > 0 ? last : NaN,
    high: Number.isFinite(high) && high > 0 ? high : NaN,
    low: Number.isFinite(low) && low > 0 ? low : NaN,
    timestamp,
  };
};

export async function fetchTicker24hStats(market = DEFAULT_MARKET) {
  const marketId = typeof market === 'string' ? market.toUpperCase() : DEFAULT_MARKET;
  const url = `${BITVAVO_BASE_URL}/ticker/24h?market=${encodeURIComponent(marketId)}`;
  try {
    const payload = await fetchJson(url);
    const list = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.ticker24h)
        ? payload.ticker24h
        : payload
          ? [payload]
          : [];
    return list.map((item) => normalizeTickerPayload(item, marketId)).find(Boolean) || null;
  } catch (err) {
    console.warn('Kon ticker24h niet ophalen', err);
    return null;
  }
}

export async function fetchTopSpreadMarkets({ limit = 10, minVolumeEur = 100000 } = {}) {
  const url = `${BITVAVO_BASE_URL}/ticker/24h`;
  try {
    const payload = await fetchJson(url);
    const list = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.ticker24h)
        ? payload.ticker24h
        : [];

    const normalized = list
      .map((item) => normalizeTickerPayload(item))
      .filter((item) => item && typeof item.market === 'string' && item.market.endsWith('-EUR'))
      .map((item) => {
        const spreadAbs = Number.isFinite(item.ask) && Number.isFinite(item.bid)
          ? item.ask - item.bid
          : NaN;
        const mid = Number.isFinite(item.ask) && Number.isFinite(item.bid)
          ? (item.ask + item.bid) / 2
          : NaN;
        const spreadPct = Number.isFinite(spreadAbs) && Number.isFinite(mid) && mid > 0
          ? (spreadAbs / mid) * 100
          : NaN;
        const volumeEur = Number.isFinite(item.volumeQuote) ? item.volumeQuote : NaN;
        return {
          ...item,
          spreadAbs: Number.isFinite(spreadAbs) ? spreadAbs : NaN,
          spreadPct: Number.isFinite(spreadPct) ? spreadPct : NaN,
          volumeEur,
        };
      })
      .filter((item) => item.spreadPct > 0 && item.volumeEur >= minVolumeEur);

    const sorted = normalized.sort((a, b) => {
      if (b.spreadPct !== a.spreadPct) return b.spreadPct - a.spreadPct;
      if (b.spreadAbs !== a.spreadAbs) return b.spreadAbs - a.spreadAbs;
      return (b.volumeEur || 0) - (a.volumeEur || 0);
    });
    return sorted.slice(0, limit);
  } catch (err) {
    console.warn('Kon top spreads niet ophalen', err);
    return [];
  }
}

export async function fetchMarketSpecifications(market = DEFAULT_MARKET) {
  const marketId = typeof market === 'string' ? market.toUpperCase() : DEFAULT_MARKET;
  const url = `${BITVAVO_BASE_URL}/markets?market=${encodeURIComponent(marketId)}`;
  try {
    const payload = await fetchJson(url);
    const list = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.markets)
        ? payload.markets
        : [];

    const spec = list.find((item) => (item?.market || '').toUpperCase() === marketId);
    if (!spec) return null;

    const tickSize = parseNumber(spec.tickSize ?? spec.priceTickSize ?? spec.stepSize);
    const quoteDecimalsRaw = spec.amountQuoteDecimals
      ?? spec.amountDecimalsQuote
      ?? spec.quotePrecision;
    const amountQuoteDecimals = Number.isFinite(quoteDecimalsRaw)
      ? quoteDecimalsRaw
      : parseInt(quoteDecimalsRaw, 10);

    return {
      market: spec.market || marketId,
      tickSize: Number.isFinite(tickSize) && tickSize > 0 ? tickSize : NaN,
      amountQuoteDecimals: Number.isFinite(amountQuoteDecimals) && amountQuoteDecimals >= 0
        ? amountQuoteDecimals
        : NaN,
    };
  } catch (err) {
    console.warn('Kon marktspecificaties niet ophalen', err);
    return null;
  }
}

export function subscribeOrderBook({
  market = DEFAULT_MARKET,
  depth = 25,
  intervalMs = 5000,
  onData,
  onError,
} = {}) {
  const marketId = typeof market === 'string' ? market.toUpperCase() : DEFAULT_MARKET;
  const safeDepth = sanitizeDepth(depth);
  const refresh = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 5000;

  let active = true;
  let timer = null;

  const loop = async () => {
    try {
      const snapshot = await fetchOrderBook(marketId, safeDepth);
      if (!active) return;
      onData?.(snapshot);
    } catch (err) {
      if (!active) return;
      console.warn('Fout bij ophalen orderboek', err);
      onError?.(err);
    } finally {
      if (!active) return;
      timer = setTimeout(loop, refresh);
    }
  };

  loop();

  return () => {
    active = false;
    if (timer) clearTimeout(timer);
  };
}
