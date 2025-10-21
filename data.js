const BITVAVO_BASE_URL = 'https://api.bitvavo.com/v2';
export const DEFAULT_MARKET = 'ARK-EUR';

const MARKET_ID_PATTERN = /^[A-Z0-9-]+$/;
const MAX_CONCURRENT_REQUESTS = 4;
const STABLE_ASSETS = new Set(['USDT', 'USDC', 'EURS']);
const REQUEST_SPACING_MS = 200;
const POLL_INTERVAL_TICKER_MS = 30000;
const POLL_INTERVAL_CANDLES_MS = 60000;
const CANDLE_CACHE_TTL_MS = 60000;

const requestQueue = [];
let requestQueueActive = false;

const processRequestQueue = () => {
  if (!requestQueue.length) {
    requestQueueActive = false;
    return;
  }
  const job = requestQueue.shift();
  if (!job) {
    requestQueueActive = false;
    return;
  }
  const { task, resolve, reject } = job;
  setTimeout(() => {
    scheduleRequest(task)
      .then(resolve, reject)
      .finally(processRequestQueue);
  }, REQUEST_SPACING_MS);
};

const enqueueNetworkTask = (task) => new Promise((resolve, reject) => {
  requestQueue.push({ task, resolve, reject });
  if (!requestQueueActive) {
    requestQueueActive = true;
    processRequestQueue();
  }
});

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

const createLimiter = (limit = MAX_CONCURRENT_REQUESTS) => {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : MAX_CONCURRENT_REQUESTS;
  let active = 0;
  const queue = [];

  const dequeue = () => {
    if (active >= safeLimit) return;
    const job = queue.shift();
    if (!job) return;
    active += 1;
    const { task, resolve, reject } = job;
    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        dequeue();
      });
  };

  return (task) => new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    dequeue();
  });
};

const scheduleRequest = createLimiter(MAX_CONCURRENT_REQUESTS);

export const normalizeMarketId = (market = DEFAULT_MARKET) => {
  if (market == null) return DEFAULT_MARKET;

  const text = String(market).trim().toUpperCase();
  if (!text) return DEFAULT_MARKET;
  if (!text.includes('-')) return DEFAULT_MARKET;
  if (!MARKET_ID_PATTERN.test(text)) return DEFAULT_MARKET;

  return text;
};

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

const splitMarketId = (marketId = '') => {
  if (typeof marketId !== 'string') return { base: '', quote: '' };
  const [baseRaw = '', quoteRaw = ''] = marketId.split('-');
  return { base: baseRaw.toUpperCase(), quote: quoteRaw.toUpperCase() };
};

const isEurMarket = (marketId) => {
  const { quote } = splitMarketId(marketId);
  return quote === 'EUR';
};

const isStableMarket = (marketId) => {
  const { base } = splitMarketId(marketId);
  return STABLE_ASSETS.has(base);
};

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

const mapWithConcurrency = async (items, limit = MAX_CONCURRENT_REQUESTS, iteratee) => {
  if (!Array.isArray(items) || !items.length) return [];
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), items.length) : 1;
  const results = new Array(items.length);
  let index = 0;

  const worker = async () => {
    while (true) {
      if (index >= items.length) break;
      const current = index;
      index += 1;
      try {
        results[current] = await iteratee(items[current], current);
      } catch (err) {
        console.warn('Fout bij verwerken taak', err);
        results[current] = null;
      }
    }
  };

  const workers = Array.from({ length: Math.max(1, safeLimit) }, worker);
  await Promise.all(workers);
  return results;
};

const rawFetchJson = async (url) => {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
};

const fetchJson = (url) => enqueueNetworkTask(() => rawFetchJson(url));

export async function fetchOrderBook(market = DEFAULT_MARKET, depth = 25) {
  const marketId = normalizeMarketId(market);
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

const normalizeMarketEntry = (item) => {
  if (!item) return null;
  const market = String(item.market || item.Market || '').toUpperCase();
  if (!market || !market.includes('-')) return null;
  const { base, quote } = splitMarketId(market);
  const status = (item.status || item.state || '').toString().toLowerCase();
  const trading = item.trading != null ? Boolean(item.trading) : status !== 'halted';
  const tickSize = parseNumber(item.priceTickSize ?? item.tickSize ?? item.stepSize);
  const minOrderInQuote = parseNumber(item.minQuoteAmount ?? item.minOrderInQuote);
  const amountDecimals = parseNumber(item.amountDecimals ?? item.decimals ?? item.amountPrecision);
  const priceDecimals = parseNumber(item.priceDecimals ?? item.decimalsPrice ?? item.pricePrecision);

  return {
    market,
    base,
    quote,
    status: status || 'unknown',
    trading,
    tickSize: Number.isFinite(tickSize) && tickSize > 0 ? tickSize : NaN,
    minOrderInQuote: Number.isFinite(minOrderInQuote) && minOrderInQuote >= 0 ? minOrderInQuote : NaN,
    amountDecimals: Number.isFinite(amountDecimals) && amountDecimals >= 0 ? amountDecimals : NaN,
    priceDecimals: Number.isFinite(priceDecimals) && priceDecimals >= 0 ? priceDecimals : NaN,
  };
};

export async function fetchBitvavoMarkets({ includeStable = false } = {}) {
  try {
    const payload = await fetchJson(`${BITVAVO_BASE_URL}/markets`);
    const list = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.markets)
        ? payload.markets
        : [];
    return list
      .map((item) => normalizeMarketEntry(item))
      .filter((item) => item && isEurMarket(item.market))
      .filter((item) => includeStable || !isStableMarket(item.market));
  } catch (err) {
    console.warn('Kon markets niet ophalen', err);
    return [];
  }
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

const normalizeTickerBookSnapshot = (payload, marketId) => {
  if (!payload) return null;
  const rawMarket = (payload.market || payload.Market || '').toUpperCase();
  const resolvedMarket = marketId || rawMarket;
  if (!resolvedMarket) return null;
  if (marketId && rawMarket && rawMarket !== marketId) return null;

  const bid = parseNumber(payload.bid ?? payload.bestBid);
  const ask = parseNumber(payload.ask ?? payload.bestAsk);
  const bidSize = parseNumber(payload.bidSize ?? payload.sizeBid);
  const askSize = parseNumber(payload.askSize ?? payload.sizeAsk);
  const timestamp = parseNumber(payload.timestamp ?? payload.time) || Date.now();
  const spreadAbs = Number.isFinite(ask) && Number.isFinite(bid) ? ask - bid : NaN;
  const mid = Number.isFinite(ask) && Number.isFinite(bid) ? (ask + bid) / 2 : NaN;
  const spreadPct = Number.isFinite(spreadAbs) && Number.isFinite(mid) && mid > 0
    ? (spreadAbs / mid) * 100
    : NaN;

  return {
    market: resolvedMarket,
    bid: Number.isFinite(bid) && bid > 0 ? bid : NaN,
    ask: Number.isFinite(ask) && ask > 0 ? ask : NaN,
    bidSize: Number.isFinite(bidSize) && bidSize >= 0 ? bidSize : NaN,
    askSize: Number.isFinite(askSize) && askSize >= 0 ? askSize : NaN,
    spreadAbs: Number.isFinite(spreadAbs) ? spreadAbs : NaN,
    spreadPct: Number.isFinite(spreadPct) ? spreadPct : NaN,
    mid: Number.isFinite(mid) ? mid : NaN,
    timestamp,
  };
};

export async function fetchBitvavoTickerBook(market = DEFAULT_MARKET) {
  const marketId = normalizeMarketId(market);
  const url = `${BITVAVO_BASE_URL}/ticker/book?market=${encodeURIComponent(marketId)}`;
  try {
    const payload = await fetchJson(url);
    const bid = parseNumber(payload?.bid);
    const ask = parseNumber(payload?.ask);
    const bidSize = parseNumber(payload?.bidSize ?? payload?.sizeBid);
    const askSize = parseNumber(payload?.askSize ?? payload?.sizeAsk);
    const timestamp = parseNumber(payload?.timestamp) || Date.now();
    const spreadAbs = Number.isFinite(ask) && Number.isFinite(bid) ? ask - bid : NaN;
    const mid = Number.isFinite(ask) && Number.isFinite(bid) ? (ask + bid) / 2 : NaN;
    const spreadPct = Number.isFinite(spreadAbs) && Number.isFinite(mid) && mid > 0
      ? (spreadAbs / mid) * 100
      : NaN;

    return {
      market: marketId,
      bid: Number.isFinite(bid) && bid > 0 ? bid : NaN,
      ask: Number.isFinite(ask) && ask > 0 ? ask : NaN,
      bidSize: Number.isFinite(bidSize) && bidSize >= 0 ? bidSize : NaN,
      askSize: Number.isFinite(askSize) && askSize >= 0 ? askSize : NaN,
      spreadAbs: Number.isFinite(spreadAbs) ? spreadAbs : NaN,
      spreadPct: Number.isFinite(spreadPct) ? spreadPct : NaN,
      mid: Number.isFinite(mid) ? mid : NaN,
      timestamp,
    };
  } catch (err) {
    console.warn('Kon ticker book niet ophalen', err);
    return null;
  }
}

export async function fetchBitvavoTicker24h(market = DEFAULT_MARKET) {
  const marketId = normalizeMarketId(market);
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

export async function fetchTicker24hStats(market = DEFAULT_MARKET) {
  return fetchBitvavoTicker24h(market);
}

const fetchAllTickerBook = async () => {
  const url = `${BITVAVO_BASE_URL}/ticker/book`;
  try {
    const payload = await fetchJson(url);
    const list = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.tickerBook)
        ? payload.tickerBook
        : [];
    return list.map((item) => normalizeTickerBookSnapshot(item)).filter(Boolean);
  } catch (err) {
    console.warn('Kon ticker book snapshot niet ophalen', err);
    return [];
  }
};

const fetchAllTicker24h = async () => {
  const url = `${BITVAVO_BASE_URL}/ticker/24h`;
  try {
    const payload = await fetchJson(url);
    const list = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.ticker24h)
        ? payload.ticker24h
        : [];
    return list.map((item) => normalizeTickerPayload(item)).filter(Boolean);
  } catch (err) {
    console.warn('Kon ticker24h snapshot niet ophalen', err);
    return [];
  }
};

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
      .filter((item) => item && typeof item.market === 'string' && isEurMarket(item.market))
      .filter((item) => item && (item.market ? !isStableMarket(item.market) : true))
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

    if (!normalized.length) {
      return [];
    }

    const enriched = await mapWithConcurrency(normalized, MAX_CONCURRENT_REQUESTS, async (item) => {
      let candles = {};
      try {
        const candlePayload = await fetchBitvavoCandles(item.market, {
          intervals: ['15m'],
          limit: 64,
        });
        candles = candlePayload?.candles ?? {};
      } catch (err) {
        console.warn(`Kon candles niet ophalen voor ${item.market}`, err);
      }

      const safeCandles = {
        ...candles,
        '15m': Array.isArray(candles?.['15m']) ? candles['15m'] : [],
      };
      const volatility = computeVolatilityIndicators({
        candles: safeCandles,
        book: { ask: item.ask, bid: item.bid },
      });

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
    });

    const sorted = enriched.sort((a, b) => {
      if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
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

const normalizeCandleRow = (row) => {
  if (!Array.isArray(row) || row.length < 6) return null;
  const [timestampRaw, openRaw, highRaw, lowRaw, closeRaw, volumeRaw] = row;
  const timestamp = Number.parseInt(timestampRaw, 10);
  const open = parseNumber(openRaw);
  const high = parseNumber(highRaw);
  const low = parseNumber(lowRaw);
  const close = parseNumber(closeRaw);
  const volume = parseNumber(volumeRaw);
  if (!Number.isFinite(timestamp)) return null;
  return {
    timestamp,
    open: Number.isFinite(open) ? open : NaN,
    high: Number.isFinite(high) ? high : NaN,
    low: Number.isFinite(low) ? low : NaN,
    close: Number.isFinite(close) ? close : NaN,
    volume: Number.isFinite(volume) ? volume : NaN,
  };
};

const sanitizeCandleLimit = (value) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 120;
  return Math.min(1000, parsed);
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

const computeVolatilityIndicators = ({ candles = {}, book = null } = {}) => {
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

  const volumeHistory = historyWindow.map((candle) => (Number.isFinite(candle?.volume) ? candle.volume : NaN));
  const volumeMedian = median(volumeHistory);
  const volumeSurge = Number.isFinite(last?.volume) && Number.isFinite(volumeMedian) && volumeMedian > 0
    ? last.volume / volumeMedian
    : NaN;

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

export async function fetchBitvavoCandles(
  market = DEFAULT_MARKET,
  { intervals = ['1m', '15m'], limit = 120 } = {},
) {
  const marketId = normalizeMarketId(market);
  const uniqueIntervals = Array.from(new Set((intervals || []).map((interval) => interval?.toString().trim()).filter(Boolean)));
  const candles = {};

  await Promise.all(uniqueIntervals.map(async (interval) => {
    const safeInterval = interval;
    const safeLimit = sanitizeCandleLimit(limit);
    const url = `${BITVAVO_BASE_URL}/${encodeURIComponent(marketId)}/candles?interval=${encodeURIComponent(safeInterval)}&limit=${safeLimit}`;
    try {
      const payload = await fetchJson(url);
      const rows = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.candles)
          ? payload.candles
          : [];
      candles[safeInterval] = rows.map((row) => normalizeCandleRow(row)).filter(Boolean);
    } catch (err) {
      console.warn(`Kon candles (${safeInterval}) niet ophalen`, err);
      candles[safeInterval] = [];
    }
  }));

  return { market: marketId, candles };
}

export async function fetchBitvavoMarketSnapshots({ includeCandles = true, candleLimit = 120 } = {}) {
  const markets = await fetchBitvavoMarkets();
  if (!markets.length) return [];

  const results = await mapWithConcurrency(markets, MAX_CONCURRENT_REQUESTS, async (market) => {
    if (!market?.market) return null;
    try {
      const [book, stats] = await Promise.all([
        fetchBitvavoTickerBook(market.market),
        fetchBitvavoTicker24h(market.market),
      ]);

      let candles = null;
      if (includeCandles) {
        const candlePayload = await fetchBitvavoCandles(market.market, {
          intervals: ['1m', '15m'],
          limit: candleLimit,
        });
        candles = candlePayload?.candles ?? {};
      }

      return {
        ...market,
        book,
        stats,
        candles,
        volatility: computeVolatilityIndicators({ candles, book }),
      };
    } catch (err) {
      console.warn(`Kon marktdata niet ophalen voor ${market.market}`, err);
      return {
        ...market,
        book: null,
        stats: null,
        candles: includeCandles ? {} : null,
      };
    }
  });

  return results.filter(Boolean);
}

export async function fetchMarketSpecifications(market = DEFAULT_MARKET) {
  const marketId = normalizeMarketId(market);
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

export function createTopSpreadPoller({ limit = 50, minVolumeEur = 0 } = {}) {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50;
  const safeMinVolume = Number.isFinite(minVolumeEur) && minVolumeEur > 0 ? minVolumeEur : 0;

  const listeners = new Set();
  const state = {
    book: new Map(),
    stats: new Map(),
    candles: new Map(),
    lastResult: [],
    topMarkets: [],
  };

  const options = {
    limit: safeLimit,
    minVolumeEur: safeMinVolume,
  };

  let active = true;
  let tickerTimer = null;
  let candleTimer = null;
  let recomputeInFlight = false;
  let recomputeQueued = false;
  let recomputeQueuedForce = false;

  const emit = () => {
    const snapshot = state.lastResult.map((item) => ({ ...item }));
    listeners.forEach((listener) => {
      try {
        listener(snapshot);
      } catch (err) {
        console.warn('Listener-fout in top spread poller', err);
      }
    });
  };

  const computeBaseCandidates = (minVolumeFilter = 0) => {
    const minVolume = Number.isFinite(minVolumeFilter) && minVolumeFilter > 0 ? minVolumeFilter : 0;
    const candidates = [];

    state.stats.forEach((stats, market) => {
      if (!stats) return;
      if (!isEurMarket(market)) return;
      if (isStableMarket(market)) return;

      const book = state.book.get(market);
      const bid = Number.isFinite(book?.bid) && book.bid > 0 ? book.bid : stats.bid;
      const ask = Number.isFinite(book?.ask) && book.ask > 0 ? book.ask : stats.ask;
      if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) {
        return;
      }

      const spreadAbs = ask - bid;
      const mid = (ask + bid) / 2;
      const spreadPct = Number.isFinite(spreadAbs) && Number.isFinite(mid) && mid > 0
        ? (spreadAbs / mid) * 100
        : NaN;
      if (!Number.isFinite(spreadPct) || spreadPct <= 0) {
        return;
      }

      const volumeEur = Number.isFinite(stats.volumeQuote) ? stats.volumeQuote : NaN;
      if (minVolume > 0 && (!Number.isFinite(volumeEur) || volumeEur < minVolume)) {
        return;
      }

      candidates.push({
        market,
        bid,
        ask,
        bidSize: Number.isFinite(book?.bidSize) ? book.bidSize : NaN,
        askSize: Number.isFinite(book?.askSize) ? book.askSize : NaN,
        spreadAbs: Number.isFinite(spreadAbs) ? spreadAbs : NaN,
        spreadPct: Number.isFinite(spreadPct) ? spreadPct : NaN,
        mid: Number.isFinite(mid) ? mid : NaN,
        last: stats.last,
        volumeBase: stats.volumeBase,
        volumeQuote: stats.volumeQuote,
        volumeEur,
        high: stats.high,
        low: stats.low,
        timestamp: stats.timestamp ?? Date.now(),
      });
    });

    return candidates.sort((a, b) => b.spreadPct - a.spreadPct);
  };

  const ensureCandles = (market, force = false) => {
    if (!market) return Promise.resolve({ '15m': [] });
    const now = Date.now();
    const current = state.candles.get(market) || null;
    if (!force && current && !current.promise && now - current.timestamp < CANDLE_CACHE_TTL_MS) {
      return Promise.resolve(current.data);
    }
    if (!force && current?.promise) {
      return current.promise;
    }
    if (current?.promise) {
      return current.promise;
    }

    const fetchPromise = fetchBitvavoCandles(market, { intervals: ['15m'], limit: 64 })
      .then((payload) => {
        const candles = payload?.candles ?? {};
        const safeCandles = {
          ...candles,
          '15m': Array.isArray(candles?.['15m']) ? candles['15m'] : [],
        };
        state.candles.set(market, {
          data: safeCandles,
          timestamp: Date.now(),
        });
        return safeCandles;
      })
      .catch((err) => {
        console.warn(`Kon candles niet ophalen voor ${market}`, err);
        if (current?.data) {
          state.candles.set(market, {
            data: current.data,
            timestamp: current.timestamp ?? 0,
          });
          return current.data;
        }
        const fallback = { '15m': [] };
        state.candles.set(market, { data: fallback, timestamp: 0 });
        return fallback;
      });

    state.candles.set(market, {
      data: current?.data ?? { '15m': [] },
      timestamp: current?.timestamp ?? 0,
      promise: fetchPromise,
    });

    fetchPromise.finally(() => {
      const entry = state.candles.get(market);
      if (entry?.promise === fetchPromise) {
        state.candles.set(market, {
          data: entry.data ?? { '15m': [] },
          timestamp: entry.timestamp ?? Date.now(),
        });
      }
    });

    return fetchPromise;
  };

  const refreshCandlesForMarkets = async (markets, force = false) => {
    const unique = Array.from(new Set((markets || []).filter(Boolean)));
    if (!unique.length) return;
    await Promise.all(unique.map((market) => ensureCandles(market, force)));
  };

  const buildFinalList = (candidates) => {
    const enriched = candidates.map((item) => {
      const cache = state.candles.get(item.market);
      const candles = cache?.data ?? { '15m': [] };
      const safeCandles = {
        ...candles,
        '15m': Array.isArray(candles?.['15m']) ? candles['15m'] : [],
      };
      const volatility = computeVolatilityIndicators({ candles: safeCandles, book: { ask: item.ask, bid: item.bid } });

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
    });

    return enriched
      .filter((item) => Number.isFinite(item.spreadPct) && item.spreadPct > 0)
      .sort((a, b) => {
        if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
        if (b.spreadPct !== a.spreadPct) return b.spreadPct - a.spreadPct;
        if (b.spreadAbs !== a.spreadAbs) return b.spreadAbs - a.spreadAbs;
        return (b.volumeEur || 0) - (a.volumeEur || 0);
      });
  };

  const recompute = async (forceCandles = false) => {
    if (!active) return;
    if (recomputeInFlight) {
      recomputeQueued = true;
      recomputeQueuedForce = recomputeQueuedForce || forceCandles;
      return;
    }

    recomputeInFlight = true;
    try {
      const baseCandidates = computeBaseCandidates(options.minVolumeEur);
      if (!baseCandidates.length) {
        state.lastResult = [];
        state.topMarkets = [];
        emit();
        return;
      }

      const candidateCount = Math.max(options.limit * 2, options.limit || 1);
      const scopedCandidates = baseCandidates.slice(0, candidateCount);
      await refreshCandlesForMarkets(scopedCandidates.map((item) => item.market), forceCandles);
      const finalList = buildFinalList(scopedCandidates).slice(0, options.limit);

      state.lastResult = finalList;
      state.topMarkets = finalList.map((item) => item.market);
      emit();
    } catch (err) {
      console.warn('Fout bij herberekenen top spreads', err);
    } finally {
      recomputeInFlight = false;
      if (recomputeQueued) {
        const nextForce = recomputeQueuedForce;
        recomputeQueued = false;
        recomputeQueuedForce = false;
        recompute(nextForce);
      }
    }
  };

  const refreshTickerData = async (forceCandles = false) => {
    if (!active) return;
    try {
      const [bookList, statsList] = await Promise.all([
        fetchAllTickerBook(),
        fetchAllTicker24h(),
      ]);

      if (bookList.length) {
        state.book = new Map(bookList.map((item) => [item.market, item]));
      }
      if (statsList.length) {
        state.stats = new Map(statsList.map((item) => [item.market, item]));
      }
    } catch (err) {
      console.warn('Kon tickerdata niet verversen', err);
    }

    await recompute(forceCandles);
  };

  const subscribe = (listener) => {
    if (typeof listener !== 'function') {
      return () => {};
    }
    listeners.add(listener);
    if (state.lastResult.length) {
      const snapshot = state.lastResult.map((item) => ({ ...item }));
      try {
        listener(snapshot);
      } catch (err) {
        console.warn('Listener-fout in initiële callback', err);
      }
    }
    return () => {
      listeners.delete(listener);
    };
  };

  const updateOptions = ({ limit: nextLimit, minVolumeEur: nextMinVolume } = {}) => {
    if (!active) return;
    let changed = false;

    if (Number.isFinite(nextLimit) && nextLimit > 0) {
      const normalized = Math.floor(nextLimit);
      if (normalized !== options.limit) {
        options.limit = normalized;
        changed = true;
      }
    }

    if (nextMinVolume != null) {
      const parsed = Number.parseFloat(nextMinVolume);
      const normalized = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
      if (normalized !== options.minVolumeEur) {
        options.minVolumeEur = normalized;
        changed = true;
      }
    }

    if (changed) {
      recompute(true);
    }
  };

  const stop = () => {
    if (!active) return;
    active = false;
    if (tickerTimer) clearInterval(tickerTimer);
    if (candleTimer) clearInterval(candleTimer);
    listeners.clear();
  };

  const start = () => {
    refreshTickerData(true).catch((err) => {
      console.warn('Kon initiële tickerdata niet laden', err);
    });
    tickerTimer = setInterval(() => {
      refreshTickerData(false).catch((err) => {
        console.warn('Kon periodieke tickerdata niet laden', err);
      });
    }, POLL_INTERVAL_TICKER_MS);
    candleTimer = setInterval(() => {
      recompute(true).catch((err) => {
        console.warn('Kon periodieke candle-update niet uitvoeren', err);
      });
    }, POLL_INTERVAL_CANDLES_MS);
  };

  start();

  return {
    subscribe,
    updateOptions,
    stop,
  };
}

export function subscribeOrderBook({
  market = DEFAULT_MARKET,
  depth = 25,
  intervalMs = 5000,
  onData,
  onError,
} = {}) {
  const marketId = normalizeMarketId(market);
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
