const BITVAVO_URL = 'wss://ws.bitvavo.com/v2/';
export const MARKET = 'ARK-EUR';
const BOOK_DEPTH = 25;
const BITVAVO_BOOK_URL = `https://api.bitvavo.com/v2/${MARKET}/book?depth=${BOOK_DEPTH}`;
const BINANCE_DEPTH_URL = `https://api.binance.com/api/v3/depth?symbol=ARKUSDT&limit=${BOOK_DEPTH}`;
const BINANCE_TICKER_URL = 'https://api.binance.com/api/v3/ticker/bookTicker?symbol=EURUSDT';
const BITVAVO_MARKETS_URL = 'https://api.bitvavo.com/v2/markets';
const BITVAVO_TICKER_24H_URL = 'https://api.bitvavo.com/v2/ticker/24h';

const fetchJson = async (url) => {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

const normalizeTickerPayload = (payload, marketId) => {
  if (!payload) return null;
  const market = (payload.market || payload.Market || '').toUpperCase();
  if (market && market !== marketId) return null;

  const volumeBase = parseNumber(
    payload.volume
      ?? payload.amount
      ?? payload.baseVolume
      ?? payload.volumeBase
  );
  const volumeQuote = parseNumber(
    payload.volumeQuote
      ?? payload.quoteVolume
      ?? payload.quote
  );
  const bestBid = parseNumber(payload.bid ?? payload.bestBid);
  const bestAsk = parseNumber(payload.ask ?? payload.bestAsk);
  const last = parseNumber(payload.last ?? payload.price ?? payload.lastPrice);
  const high = parseNumber(payload.high);
  const low = parseNumber(payload.low);
  const timestamp = parseNumber(payload.timestamp ?? payload.time) || Date.now();

  return {
    market: marketId,
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

export async function fetchTicker24hStats(market = MARKET) {
  const marketId = typeof market === 'string' ? market.toUpperCase() : MARKET;
  try {
    const url = `${BITVAVO_TICKER_24H_URL}?market=${encodeURIComponent(marketId)}`;
    const payload = await fetchJson(url);
    const list = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.ticker24h)
        ? payload.ticker24h
        : payload
          ? [payload]
          : [];

    const normalized = list
      .map((item) => normalizeTickerPayload(item, marketId))
      .find(Boolean);
    return normalized || null;
  } catch (err) {
    console.warn('Kon ticker24h niet ophalen', err);
    return null;
  }
}

const parseNumber = (value) => {
  const num = parseFloat(value);
  return Number.isFinite(num) ? num : NaN;
};

export async function fetchMarketSpecifications(market = MARKET) {
  const marketId = typeof market === 'string' ? market.toUpperCase() : MARKET;
  try {
    const url = `${BITVAVO_MARKETS_URL}?market=${encodeURIComponent(marketId)}`;
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

const convertUsdtToEur = (value, eurTicker) => {
  if (!eurTicker) return NaN;
  const eurAsk = parseNumber(eurTicker.askPrice || eurTicker.ask);
  if (!eurAsk || eurAsk <= 0) return NaN;
  return value / eurAsk;
};

const toLevels = (map, side) => {
  const sorter = side === 'bids'
    ? (a, b) => parseNumber(b[0]) - parseNumber(a[0])
    : (a, b) => parseNumber(a[0]) - parseNumber(b[0]);
  const sorted = Array.from(map.entries())
    .sort(sorter)
    .slice(0, BOOK_DEPTH);

  const next = [];
  const nextMap = new Map();
  for (const [priceStr, amount] of sorted) {
    const price = parseNumber(priceStr);
    const size = parseNumber(amount);
    if (!price || price <= 0 || !size || size <= 0) continue;
    next.push([price, size]);
    nextMap.set(priceStr, amount);
  }

  map.clear();
  nextMap.forEach((value, key) => map.set(key, value));
  return next;
};

const sumAmount = (levels) => levels.reduce((total, [, amount]) => total + amount, 0);
const sumNotional = (levels) => levels.reduce((total, [price, amount]) => total + price * amount, 0);

export function startDataFeed(onTick, onSourceChange, onTicker) {
  let ws;
  let reconnectTimer;
  let pollTimer;
  let snapshotRetryTimer;
  let tickerPollTimer;
  let currentSource = '';
  let fetchingSnapshot = false;
  let bookReady = false;
  let lastNonce = 0;
  let pendingUpdates = [];

  const bookState = {
    bids: new Map(),
    asks: new Map(),
    bidLevels: [],
    askLevels: [],
  };

  const emitTicker = (payload, source = 'ws') => {
    if (!payload || typeof onTicker !== 'function') return;
    onTicker({ ...payload, source });
  };

  const setSource = (source) => {
    if (source !== currentSource) {
      currentSource = source;
      if (typeof onSourceChange === 'function') onSourceChange(source);
    }
  };

  const emitTickFromBook = () => {
    if (!bookState.bidLevels.length || !bookState.askLevels.length) return;
    const bestBid = bookState.bidLevels[0][0];
    const bestAsk = bookState.askLevels[0][0];
    if (!bestBid || !bestAsk || bestBid <= 0 || bestAsk <= 0) return;

    const spreadAbs = bestAsk - bestBid;
    const mid = (bestBid + bestAsk) / 2;
    const spreadPct = mid > 0 ? spreadAbs / mid : NaN;

    const depth = {
      bidVolume: sumAmount(bookState.bidLevels),
      askVolume: sumAmount(bookState.askLevels),
      bidNotional: sumNotional(bookState.bidLevels),
      askNotional: sumNotional(bookState.askLevels),
    };

    const payload = {
      bid: bestBid,
      ask: bestAsk,
      spreadAbs,
      spreadPct,
      mid,
      depth,
      bids: bookState.bidLevels,
      asks: bookState.askLevels,
      timestamp: Date.now(),
    };

    setSource('ws');
    if (typeof onTick === 'function') {
      onTick({ ...payload, source: 'ws' });
    }
  };

  const applySideUpdates = (map, updates) => {
    if (!Array.isArray(updates)) return;
    for (const update of updates) {
      if (!Array.isArray(update)) continue;
      const [priceStr, amountStr] = update;
      const price = parseNumber(priceStr);
      const amount = parseNumber(amountStr);
      if (!price || price <= 0) continue;
      if (!amount || amount <= 0) {
        map.delete(priceStr);
      } else {
        map.set(priceStr, amountStr);
      }
    }
  };

  const rebuildLevels = () => {
    bookState.bidLevels = toLevels(bookState.bids, 'bids');
    bookState.askLevels = toLevels(bookState.asks, 'asks');
  };

  const processUpdate = (message) => {
    const nonce = parseNumber(message?.nonce);
    if (!nonce || nonce <= 0) return;
    if (!bookReady) {
      pendingUpdates.push(message);
      return;
    }

    if (nonce <= lastNonce) {
      return;
    }

    if (lastNonce && nonce !== lastNonce + 1) {
      console.warn('Bitvavo nonce gap, resyncing');
      resync();
      return;
    }

    applySideUpdates(bookState.bids, message.bids);
    applySideUpdates(bookState.asks, message.asks);
    rebuildLevels();
    lastNonce = nonce;
    emitTickFromBook();
  };

  const processPendingUpdates = () => {
    if (!pendingUpdates.length) return;
    pendingUpdates
      .sort((a, b) => parseNumber(a?.nonce) - parseNumber(b?.nonce))
      .forEach((update) => processUpdate(update));
    pendingUpdates = [];
  };

  const applySnapshot = (snapshot) => {
    const nonce = parseNumber(snapshot?.nonce);
    if (!nonce || nonce <= 0) throw new Error('Snapshot zonder nonce');
    const bids = snapshot?.bids;
    const asks = snapshot?.asks;
    if (!Array.isArray(bids) || !Array.isArray(asks) || !bids.length || !asks.length) {
      throw new Error('Snapshot zonder bids/asks');
    }

    bookState.bids.clear();
    bookState.asks.clear();
    applySideUpdates(bookState.bids, bids);
    applySideUpdates(bookState.asks, asks);
    rebuildLevels();
    lastNonce = nonce;
    bookReady = true;
    emitTickFromBook();
    processPendingUpdates();
  };

  const clearPoll = () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  const requestSnapshot = async () => {
    if (fetchingSnapshot) return;
    fetchingSnapshot = true;
    clearTimeout(snapshotRetryTimer);
    try {
      const snapshot = await fetchJson(BITVAVO_BOOK_URL);
      applySnapshot(snapshot);
      clearPoll();
      stopTickerPolling();
      setSource('ws');
    } catch (err) {
      console.warn('Kon Bitvavo snapshot niet ophalen', err);
      startPolling();
      snapshotRetryTimer = setTimeout(requestSnapshot, 5000);
    } finally {
      fetchingSnapshot = false;
    }
  };

  const startTickerPolling = (intervalMs = 60000) => {
    if (tickerPollTimer) return;
    const pollTicker = async () => {
      try {
        const stats = await fetchTicker24hStats();
        if (stats) emitTicker(stats, 'poll');
      } catch (err) {
        console.warn('Ticker24h poll error', err);
      }
    };
    pollTicker();
    tickerPollTimer = setInterval(pollTicker, intervalMs);
  };

  const stopTickerPolling = () => {
    if (tickerPollTimer) {
      clearInterval(tickerPollTimer);
      tickerPollTimer = null;
    }
  };

  const startPolling = () => {
    if (pollTimer) return;
    setSource('poll');
    pollTimer = setInterval(async () => {
      try {
        const [depth, eurTicker] = await Promise.all([
          fetchJson(BINANCE_DEPTH_URL),
          fetchJson(BINANCE_TICKER_URL),
        ]);

        const levelsFromBinance = (side) => {
          const rows = Array.isArray(depth?.[side]) ? depth[side] : [];
          const converted = [];
          for (const [priceStr, amountStr] of rows.slice(0, BOOK_DEPTH)) {
            const priceUsdt = parseNumber(priceStr);
            const amount = parseNumber(amountStr);
            if (!priceUsdt || priceUsdt <= 0 || !amount || amount <= 0) continue;
            const priceEur = convertUsdtToEur(priceUsdt, eurTicker);
            if (!priceEur || priceEur <= 0) continue;
            converted.push([priceEur, amount]);
          }
          return converted;
        };

        const bidLevels = levelsFromBinance('bids');
        const askLevels = levelsFromBinance('asks');
        if (!bidLevels.length || !askLevels.length) return;

        const bestBid = bidLevels[0][0];
        const bestAsk = askLevels[0][0];
        if (!bestBid || !bestAsk) return;

        const spreadAbs = bestAsk - bestBid;
        const mid = (bestBid + bestAsk) / 2;
        const spreadPct = mid > 0 ? spreadAbs / mid : NaN;
        const depthTotals = {
          bidVolume: sumAmount(bidLevels),
          askVolume: sumAmount(askLevels),
          bidNotional: sumNotional(bidLevels),
          askNotional: sumNotional(askLevels),
        };

        if (typeof onTick === 'function') {
          onTick({
            bid: bestBid,
            ask: bestAsk,
            spreadAbs,
            spreadPct,
            mid,
            depth: depthTotals,
            bids: bidLevels,
            asks: askLevels,
            timestamp: Date.now(),
            source: 'poll',
          });
        }
      } catch (err) {
        console.warn('Binance poll error', err);
      }
    }, 2000);
    startTickerPolling();
  };

  const resync = () => {
    bookReady = false;
    lastNonce = 0;
    pendingUpdates = [];
    startPolling();
    requestSnapshot();
  };

  const stopWebsocket = () => {
    if (ws) {
      try {
        ws.close();
      } catch (_) {}
      ws = null;
    }
  };

  const handleFailover = () => {
    stopWebsocket();
    startPolling();
    clearTimeout(reconnectTimer);
    clearTimeout(snapshotRetryTimer);
    reconnectTimer = setTimeout(connect, 5000);
  };

  const connect = () => {
    stopWebsocket();
    clearTimeout(reconnectTimer);
    try {
      ws = new WebSocket(BITVAVO_URL);
    } catch (err) {
      console.warn('Bitvavo WS init error', err);
      handleFailover();
      return;
    }

    ws.onopen = () => {
      clearPoll();
      bookReady = false;
      lastNonce = 0;
      pendingUpdates = [];
      stopTickerPolling();
      try {
        ws.send(
          JSON.stringify({
            action: 'subscribe',
            markets: [MARKET],
            channels: ['book', 'ticker24h'],
          })
        );
      } catch (err) {
        console.warn('Kon Bitvavo subscription niet versturen', err);
      }

      if (typeof onTicker === 'function') {
        fetchTicker24hStats().then((stats) => {
          if (stats) emitTicker(stats, 'rest');
        }).catch((err) => console.warn('Kon initiële ticker24h niet laden', err));
      }
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (!data || data.market !== MARKET) return;

        if (data.event === 'subscribed') {
          if (data.channel === 'book') {
            requestSnapshot();
          }
          return;
        }

        if (data.event === 'book') {
          processUpdate(data);
        } else if (data.event === 'ticker24h') {
          const stats = normalizeTickerPayload(data, MARKET);
          if (stats) emitTicker(stats, 'ws');
        } else if (data.event === 'error') {
          console.warn('Bitvavo error event', data);
          handleFailover();
        }
      } catch (err) {
        console.warn('Bitvavo message parse error', err);
      }
    };

    ws.onerror = handleFailover;
    ws.onclose = handleFailover;
  };

  connect();

  return () => {
    clearTimeout(reconnectTimer);
    clearTimeout(snapshotRetryTimer);
    clearPoll();
    stopTickerPolling();
    stopWebsocket();
  };
}
