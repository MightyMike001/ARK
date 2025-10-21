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
    tableBody.innerHTML = '<tr><td colspan="9">Geen markten gevonden</td></tr>';
  }
  if (updatedAtLabel) {
    updatedAtLabel.textContent = '–';
  }
};

export const renderTopSpreads = (list = [], {
  tableBody,
  updatedAtLabel,
  config,
} = {}) => {
  if (!tableBody) return;
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
      const volumeSurge = formatScore(item.volumeSurge, 2);
      const range15m = formatPercent(item.range15mPct, 2);
      const wick = formatScore(item.wickiness, 2);
      const volume = Number.isFinite(item.volumeEur)
        ? `€${formatNumber(item.volumeEur, 0)}`
        : '–';
      const lastPrice = formatPrice(item.last, 5);
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
          <td class="numeric">${totalScore}${spikeBadge}</td>
          <td class="numeric">${spreadPct}</td>
          <td class="numeric">${volumeSurge}</td>
          <td class="numeric">${range15m}</td>
          <td class="numeric">${wick}</td>
          <td class="numeric">${volume}</td>
          <td class="numeric">${lastPrice}</td>
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
