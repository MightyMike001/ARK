import { roundToTick } from '../calc.js';

const COLUMN_COUNT = 7;
const DEFAULT_LIMIT_NOTIONAL_EUR = 1000;
const FALLBACK_TICK_SIZE = 0.0001;

const escapeHtml = (value = '') => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

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

  const spread = ask - bid;
  const hasMeaningfulSpread = Number.isFinite(spread) && spread > tick;

  let candidateBuy = hasMeaningfulSpread
    ? Math.min(bid + tick, ask - tick)
    : bid;
  if (!Number.isFinite(candidateBuy) || candidateBuy <= 0) {
    candidateBuy = bid;
  }
  if (candidateBuy < bid) {
    candidateBuy = bid;
  }

  let candidateSell = hasMeaningfulSpread
    ? Math.max(ask - tick, bid + tick)
    : ask;
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

const renderEmptyState = (tableBody, updatedAtLabel, cardContainer) => {
  if (tableBody) {
    tableBody.innerHTML = `<tr><td colspan="${COLUMN_COUNT}">Geen markten gevonden</td></tr>`;
  }
  if (cardContainer) {
    cardContainer.innerHTML = '<div class="mobile-placeholder">Geen markten gevonden</div>';
  }
  if (updatedAtLabel) {
    updatedAtLabel.textContent = '–';
  }
};

const renderErrorState = (tableBody, updatedAtLabel, message, cardContainer) => {
  const text = typeof message === 'string' && message.trim()
    ? message.trim()
    : 'data unavailable';
  if (tableBody) {
    tableBody.innerHTML = `<tr><td colspan="${COLUMN_COUNT}">${text}</td></tr>`;
  }
  if (cardContainer) {
    const safeText = escapeHtml(text);
    cardContainer.innerHTML = `<div class="mobile-placeholder">${safeText}</div>`;
  }
  if (updatedAtLabel) {
    updatedAtLabel.textContent = '–';
  }
};

export const renderTopSpreads = (list = [], {
  tableBody,
  updatedAtLabel,
  cardContainer,
  config,
  errorMessage,
} = {}) => {
  if (!tableBody && !cardContainer) return;
  if (errorMessage) {
    renderErrorState(tableBody, updatedAtLabel, errorMessage, cardContainer);
    return;
  }
  const filtered = applyFilters(list, config);

  if (!filtered.length) {
    renderEmptyState(tableBody, updatedAtLabel, cardContainer);
    return;
  }

  const normalized = filtered.map((item, index) => {
    const rank = index + 1;
    const market = item.market || '–';
    const totalScore = formatScore(item.totalScore, 2);
    const spreadPct = formatPercent(item.spreadPct, 2);
    const priceDigits = countTickDecimals(item.tickSize);
    const volume = Number.isFinite(item.volumeEur)
      ? `€${formatNumber(item.volumeEur, 0)}`
      : '–';
    const baseAsset = (market.split('-')[0] || '').toUpperCase();
    const limitAdvice = resolveLimitAdvice(item);
    const buyPrice = formatPrice(limitAdvice.buyPrice, priceDigits);
    const buyAmount = formatAmount(limitAdvice.buyAmount);
    const sellPrice = formatPrice(limitAdvice.sellPrice, priceDigits);
    const sellAmount = formatAmount(limitAdvice.sellAmount);
    const isSpike = Boolean(item.spike);
    const isOpportunity = Number.isFinite(item.spreadPct)
      && Number.isFinite(item.volumeSurge)
      && item.spreadPct > 3
      && item.volumeSurge > 2;
    const tableClasses = [];
    if (isSpike) {
      tableClasses.push('row-spike');
    }
    if (isOpportunity) {
      tableClasses.push('row-opportunity');
    }

    return {
      rank,
      market,
      totalScore,
      spreadPct,
      volume,
      baseAsset,
      buyPrice,
      buyAmount,
      sellPrice,
      sellAmount,
      tableClassName: tableClasses.join(' '),
      cardClassName: ['mobile-market-card', isSpike ? 'is-spike' : '', isOpportunity ? 'is-opportunity' : '']
        .filter(Boolean)
        .join(' '),
      isSpike,
    };
  });

  const rows = normalized
    .map((entry) => {
      const spikeBadge = entry.isSpike ? '<span class="spike-indicator">⚡ Spike</span>' : '';
      return `
        <tr data-market="${entry.market}" class="${entry.tableClassName}">
          <td class="numeric">${entry.rank}</td>
          <td>${entry.market}</td>
          <td class="numeric" title="Score = 45% spread + 35% volume + 20% wick + spike bonus">${entry.totalScore}${spikeBadge}</td>
          <td class="numeric" title="Spread% = (ask - bid) / gemiddelde prijs × 100">${entry.spreadPct}</td>
          <td class="numeric">${entry.volume}</td>
          <td class="numeric" title="Aanbevolen limit kooporder voor €1000">
            <div class="limit-advice buy">
              <span class="label"><span class="flag">Let op</span> Koop nu</span>
              <span class="price">${entry.buyPrice}</span>
              <span class="amount">${entry.buyAmount} ${entry.baseAsset}</span>
            </div>
          </td>
          <td class="numeric" title="Aanbevolen limit verkooporder voor €1000">
            <div class="limit-advice sell">
              <span class="label"><span class="flag">Let op</span> Verkoop direct</span>
              <span class="price">${entry.sellPrice}</span>
              <span class="amount">${entry.sellAmount} ${entry.baseAsset}</span>
            </div>
          </td>
        </tr>
      `;
    })
    .join('');

  if (tableBody) {
    tableBody.innerHTML = rows;
  }
  if (cardContainer) {
    const cards = normalized
      .map((entry) => `
        <article class="${entry.cardClassName}" data-market="${entry.market}">
          <header class="mobile-market-card__header">
            <div class="mobile-market-card__title">
              <span class="mobile-market-card__rank">#${entry.rank}</span>
              <span class="mobile-market-card__pair">${entry.market}</span>
            </div>
            <div class="mobile-market-card__score" title="Score = 45% spread + 35% volume + 20% wick + spike bonus">
              ${entry.totalScore}
              ${entry.isSpike ? '<span class="mobile-market-card__badge">⚡ Spike</span>' : ''}
            </div>
          </header>
          <dl class="mobile-market-card__metrics">
            <div>
              <dt title="Spread% = (ask - bid) / gemiddelde prijs × 100">Spread%</dt>
              <dd>${entry.spreadPct}</dd>
            </div>
            <div>
              <dt>24h Vol</dt>
              <dd>${entry.volume}</dd>
            </div>
          </dl>
          <div class="mobile-market-card__actions">
            <div class="limit-advice buy" title="Aanbevolen limit kooporder voor €1000">
              <span class="label"><span class="flag">Let op</span> Koop nu</span>
              <span class="price">${entry.buyPrice}</span>
              <span class="amount">${entry.buyAmount} ${entry.baseAsset}</span>
            </div>
            <div class="limit-advice sell" title="Aanbevolen limit verkooporder voor €1000">
              <span class="label"><span class="flag">Let op</span> Verkoop direct</span>
              <span class="price">${entry.sellPrice}</span>
              <span class="amount">${entry.sellAmount} ${entry.baseAsset}</span>
            </div>
          </div>
        </article>
      `)
      .join('');
    cardContainer.innerHTML = cards;
  }
  if (updatedAtLabel) {
    const time = new Date().toLocaleTimeString('nl-NL', { hour12: false });
    updatedAtLabel.textContent = time;
  }
};

export { applyFilters };
