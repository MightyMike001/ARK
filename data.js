const BITVAVO_URL = 'wss://ws.bitvavo.com/v2/';
const MARKET = 'ARKEUR';

const fetchJson = async (url) => {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

const convertUsdtToEur = (value, eurTicker) => {
  if (!eurTicker) return value;
  const eurAsk = parseFloat(eurTicker.askPrice || eurTicker.ask);
  if (!isFinite(eurAsk) || eurAsk <= 0) return value;
  return value / eurAsk;
};

export function startDataFeed(onTick, onSourceChange) {
  let ws;
  let wsTimeout;
  let reconnectTimer;
  let pollTimer;
  let currentSource = '';

  const setSource = (source) => {
    if (source !== currentSource) {
      currentSource = source;
      if (typeof onSourceChange === 'function') onSourceChange(source);
    }
  };

  const handleTick = (tick, source) => {
    setSource(source);
    if (typeof onTick === 'function') onTick({ ...tick, source });
  };

  const clearPoll = () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  const scheduleFallback = () => {
    clearTimeout(wsTimeout);
    wsTimeout = setTimeout(() => {
      startPolling();
    }, 3000);
  };

  const startPolling = () => {
    if (pollTimer) return;
    setSource('poll');
    pollTimer = setInterval(async () => {
      try {
        const [arkTicker, eurTicker] = await Promise.all([
          fetchJson('https://api.binance.com/api/v3/ticker/bookTicker?symbol=ARKUSDT'),
          fetchJson('https://api.binance.com/api/v3/ticker/bookTicker?symbol=EURUSDT'),
        ]);
        const bidUsdt = parseFloat(arkTicker.bidPrice || arkTicker.bid);
        const askUsdt = parseFloat(arkTicker.askPrice || arkTicker.ask);
        if (!isFinite(bidUsdt) || !isFinite(askUsdt)) return;
        const bid = convertUsdtToEur(bidUsdt, eurTicker);
        const ask = convertUsdtToEur(askUsdt, eurTicker);
        if (!isFinite(bid) || !isFinite(ask)) return;
        handleTick({ bid, ask, timestamp: Date.now() }, 'poll');
      } catch (err) {
        console.warn('Binance poll error', err);
      }
    }, 2000);
  };

  const connect = () => {
    clearTimeout(wsTimeout);
    clearInterval(reconnectTimer);
    try {
      ws = new WebSocket(BITVAVO_URL);
    } catch (err) {
      console.warn('Bitvavo WS error', err);
      startPolling();
      reconnectTimer = setTimeout(connect, 5000);
      return;
    }

    ws.onopen = () => {
      setSource('ws');
      clearPoll();
      ws.send(
        JSON.stringify({
          action: 'subscribe',
          markets: [MARKET],
          channels: ['ticker24h'],
        })
      );
      scheduleFallback();
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data && data.market === MARKET) {
          if (data.event === 'subscribed') return;
          const bid = parseFloat(data.bestBid ?? data.bid ?? data.bestBidPrice);
          const ask = parseFloat(data.bestAsk ?? data.ask ?? data.bestAskPrice);
          if (isFinite(bid) && isFinite(ask)) {
            clearPoll();
            handleTick({ bid, ask, timestamp: Date.now() }, 'ws');
            scheduleFallback();
          }
        }
      } catch (err) {
        console.warn('Bitvavo message parse error', err);
      }
    };

    const failover = () => {
      clearTimeout(wsTimeout);
      if (ws) {
        try { ws.close(); } catch (_) {}
      }
      ws = null;
      startPolling();
      reconnectTimer = setTimeout(connect, 6000);
    };

    ws.onerror = failover;
    ws.onclose = failover;
  };

  connect();

  return () => {
    clearTimeout(wsTimeout);
    clearInterval(reconnectTimer);
    clearPoll();
    if (ws) {
      ws.close();
      ws = null;
    }
  };
}
