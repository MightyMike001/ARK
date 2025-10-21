import { roundToTick } from '../calc.js';

const COLUMN_COUNT = 12;
const DEFAULT_LIMIT_NOTIONAL_EUR = 1000;
const FALLBACK_TICK_SIZE = 0.0001;

const formatNumber = (value, digits = 0) => {
  if (!Number.isFinite(value)) return '–';
  return value.toLocaleString('nl-NL', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
};

const formatPercent = (value, digits = 2) => {
  if (!Number.isFinite(value)) return '–';
  return `${value.toFixed(digits)}%`;
};

const formatScore = (value, digits = 2) => {
  if (!Number.isFinite(value)) return '–';
  return value.toFixed(digits);
};

const formatPrice = (value, digits = 4) => {
  if (!Number.isFinite(value)) return '–';
  return `€${value.toFixed(digits)}`;
};

const countTickDecimals = (tick) => {
  if (!Number.isFinite(tick) || tick <= 0) return 4;
  const text = tick.toString();
  if (text.includes('e')) {
    const [base, exp] = text.split('e');
    const baseDecimals = (base.split('.')[1] || '').length;
    const exponent = Number.parseInt(exp, 10);
    const decimals = Math.max(0, baseDecimals - exponent);
    return Math.min(8, Math.max(decimals, 2));
  }
  const decimals = (text.split('.')[1] || '').length;
  return Math.min(8, Math.max(decimals, 2));
};

const formatAmount = (value) => {
  if (!Number.isFinite(value) || value <= 0) return '–';
  const abs = Math.abs(value);
  let digits = 6;
  if (abs >= 100) {
    digits = 2;
  } else if (abs >= 10) {
    digits = 3;
  } else if (abs >= 1) {
    digits = 4;
  } else if (abs >= 0.1) {
    digits = 5;
  }
  return value.toLocaleString('nl-NL', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
};

const resolveLimitAdvice = (item = {}) => {
  const advice = item?.limitAdvice ?? {};
  const hasCompleteAdvice = ['buyPrice', 'sellPrice', 'buyAmount', 'sellAmount']
    .every((key) => Number.isFinite(advice[key]) && advice[key] > 0);
  if (hasCompleteAdvice) {
    return advice;
  }

  const bid = Number.isFinite(item?.bid) && item.bid > 0 ? item.bid : NaN;
  const ask = Number.isFinite(item?.ask) && item.ask > 0 ? item.ask : NaN;
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid >= ask) {
    return advice;
  }

  const tick = Number.isFinite(item?.tickSize) && item.tickSize > 0
    ? item.tickSize
    : FALLBACK_TICK_SIZE;
  const notional = Number.isFinite(item?.notionalEur) && item.notionalEur > 0
    ? item.notionalEur
    : DEFAULT_LIMIT_NOTIONAL_EUR;

  let candidateBuy = Math.min(bid + tick, ask - tick);
  if (!Number.isFinite(candidateBuy) || candidateBuy <= 0) {
    candidateBuy = bid;
  }
  if (candidateBuy < bid) {
    candidateBuy = bid;
  }

  let candidateSell = Math.max(ask - tick, bid + tick);
  if (!Number.isFinite(candidateSell) || candidateSell <= 0) {
    candidateSell = ask;
  }
  if (candidateSell > ask) {
    candidateSell = ask;
  }

  const buyPrice = roundToTick(Math.max(candidateBuy, tick), tick, 'down');
  const sellPrice = roundToTick(Math.max(candidateSell, tick), tick, 'up');
  const safeBuyPrice = Number.isFinite(buyPrice) && buyPrice > 0 ? buyPrice : bid;
  const safeSellPrice = Number.isFinite(sellPrice) && sellPrice > 0 ? sellPrice : ask;
  const buyAmount = Number.isFinite(safeBuyPrice) && safeBuyPrice > 0 ? notional / safeBuyPrice : NaN;
  const sellAmount = Number.isFinite(safeSellPrice) && safeSellPrice > 0 ? notional / safeSellPrice : NaN;

  return {
    buyPrice: Number.isFinite(advice.buyPrice) && advice.buyPrice > 0 ? advice.buyPrice : safeBuyPrice,
    sellPrice: Number.isFinite(advice.sellPrice) && advice.sellPrice > 0 ? advice.sellPrice : safeSellPrice,
    buyAmount: Number.isFinite(advice.buyAmount) && advice.buyAmount > 0 ? advice.buyAmount : buyAmount,
    sellAmount: Number.isFinite(advice.sellAmount) && advice.sellAmount > 0 ? advice.sellAmount : sellAmount,
  };
};

const applyFilters = (list, config) => {
  if (!Array.isArray(list)) return [];
  const thresholds = config?.thresholds ?? {};
  const enabled = config?.enabled ?? {};

  return list.filter((item) => {
    if (!item) return false;
    const passesSpread = !enabled.minSpread
      || !Number.isFinite(thresholds.minSpread)
      || item.spreadPct >= thresholds.minSpread;
    const passesVolumeSurge = !enabled.minVolSurge
      || !Number.isFinite(thresholds.minVolSurge)
      || item.volumeSurge >= thresholds.minVolSurge;
    const passesVolume = !enabled.min24hVolEur
      || !Number.isFinite(thresholds.min24hVolEur)
      || item.volumeEur >= thresholds.min24hVolEur;
    return passesSpread && passesVolumeSurge && passesVolume;
  });
};

const renderEmptyState = (tableBody, updatedAtLabel) => {
  if (tableBody) {
    tableBody.innerHTML = `<tr><td colspan="${COLUMN_COUNT}">Geen markten gevonden</td></tr>`;
  }
  if (updatedAtLabel) {
    updatedAtLabel.textContent = '–';
  }
};

const renderErrorState = (tableBody, updatedAtLabel, message) => {
  const text = typeof message === 'string' && message.trim()
    ? message.trim()
    : 'data unavailable';
  if (tableBody) {
    tableBody.innerHTML = `<tr><td colspan="${COLUMN_COUNT}">${text}</td></tr>`;
  }
  if (updatedAtLabel) {
    updatedAtLabel.textContent = '–';
  }
};

export const renderTopSpreads = (list = [], {
  tableBody,
  updatedAtLabel,
  config,
  errorMessage,
} = {}) => {
  if (!tableBody) return;
  if (errorMessage) {
    renderErrorState(tableBody, updatedAtLabel, errorMessage);
    return;
  }
  const filtered = applyFilters(list, config);

  if (!filtered.length) {
    renderEmptyState(tableBody, updatedAtLabel);
    return;
  }

  const rows = filtered
    .map((item, index) => {
      const rank = index + 1;
      const market = item.market || '–';
      const totalScore = formatScore(item.totalScore, 2);
      const spreadPct = formatPercent(item.spreadPct, 2);
      const priceDigits = countTickDecimals(item.tickSize);
      const spreadAbs = formatPrice(item.spreadAbs, priceDigits);
      const volumeSurge = formatScore(item.volumeSurge, 2);
      const range15m = formatPercent(item.range15mPct, 2);
      const wick = formatScore(item.wickiness, 2);
      const volume = Number.isFinite(item.volumeEur)
        ? `€${formatNumber(item.volumeEur, 0)}`
        : '–';
      const lastPrice = formatPrice(item.last, priceDigits);
      const baseAsset = (market.split('-')[0] || '').toUpperCase();
      const limitAdvice = resolveLimitAdvice(item);
      const buyPrice = formatPrice(limitAdvice.buyPrice, priceDigits);
      const buyAmount = formatAmount(limitAdvice.buyAmount);
      const sellPrice = formatPrice(limitAdvice.sellPrice, priceDigits);
      const sellAmount = formatAmount(limitAdvice.sellAmount);
      const highlightClasses = [];
      if (item.spike) {
        highlightClasses.push('row-spike');
      }
      if (Number.isFinite(item.spreadPct) && Number.isFinite(item.volumeSurge)) {
        if (item.spreadPct > 3 && item.volumeSurge > 2) {
          highlightClasses.push('row-opportunity');
        }
      }
      const className = highlightClasses.join(' ');
      const spikeBadge = item.spike ? '<span class="spike-indicator">⚡ Spike</span>' : '';
      return `
        <tr data-market="${market}" class="${className}">
          <td class="numeric">${rank}</td>
          <td>${market}</td>
          <td class="numeric" title="Score = 45% spread + 35% volume + 20% wick + spike bonus">${totalScore}${spikeBadge}</td>
          <td class="numeric" title="Spread% = (ask - bid) / gemiddelde prijs × 100">${spreadPct}</td>
          <td class="numeric" title="Spread € = ask - bid">${spreadAbs}</td>
          <td class="numeric" title="VolSurge = laatste 15m volume / mediane 15m volume">${volumeSurge}</td>
          <td class="numeric" title="15m Range% = (high - low) / close × 100 van laatste 15m candle">${range15m}</td>
          <td class="numeric" title="Wick = (bovenste + onderste wick) / candle body">${wick}</td>
          <td class="numeric">${volume}</td>
          <td class="numeric">${lastPrice}</td>
          <td class="numeric" title="Aanbevolen limit kooporder voor €1000">
            <div class="limit-advice">
              <span class="price">${buyPrice}</span>
              <span class="amount">${buyAmount} ${baseAsset}</span>
            </div>
          </td>
          <td class="numeric" title="Aanbevolen limit verkooporder voor €1000">
            <div class="limit-advice">
              <span class="price">${sellPrice}</span>
              <span class="amount">${sellAmount} ${baseAsset}</span>
            </div>
          </td>
        </tr>
      `;
    })
    .join('');

  tableBody.innerHTML = rows;
  if (updatedAtLabel) {
    const time = new Date().toLocaleTimeString('nl-NL', { hour12: false });
    updatedAtLabel.textContent = time;
  }
};

export { applyFilters };
