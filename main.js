import { fetchTopSpreadMarkets } from './data.js';

const els = {
  topSpreadsBody: document.querySelector('[data-top-spreads]'),
  topSpreadsUpdated: document.querySelector('[data-top-spreads-updated]'),
  topSpreadsSelect: document.querySelector('[data-top-spreads-select]'),
  topSpreadsChart: document.querySelector('[data-top-spreads-chart]'),
  topSpreadsChartEmpty: document.querySelector('[data-top-spread-chart-empty]'),
  topSpreadsSelected: document.querySelector('[data-top-spread-selected]'),
  topSpreadsCurrent: document.querySelector('[data-top-spread-current]'),
};

const MAX_TOP_SPREAD_HISTORY = 240;
const REFRESH_INTERVAL_MS = 60000;

const topSpreadHistory = new Map();
let selectedTopMarket = null;
let lastTopSpreads = [];
let topSpreadsTimer = null;

function formatPrice(value, digits = 4) {
  if (!Number.isFinite(value)) return '–';
  return `€${value.toFixed(digits)}`;
}

function formatPercent(value, digits = 2) {
  if (!Number.isFinite(value)) return '–';
  return `${value.toFixed(digits)}%`;
}

function formatNumber(value, digits = 0) {
  if (!Number.isFinite(value)) return '–';
  return value.toLocaleString('nl-NL', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function recordTopSpreadsHistory(list = []) {
  if (!Array.isArray(list) || !list.length) return;
  const now = Date.now();
  list.forEach((item) => {
    if (!item || typeof item.market !== 'string') return;
    if (!Number.isFinite(item.spreadPct)) return;
    const timestamp = Number.isFinite(item.timestamp) ? item.timestamp : now;
    const series = topSpreadHistory.get(item.market) || [];
    const lastPoint = series[series.length - 1];
    if (lastPoint && lastPoint.timestamp === timestamp) {
      lastPoint.spreadPct = item.spreadPct;
    } else {
      series.push({ timestamp, spreadPct: item.spreadPct });
    }
    if (series.length > MAX_TOP_SPREAD_HISTORY) {
      series.splice(0, series.length - MAX_TOP_SPREAD_HISTORY);
    }
    topSpreadHistory.set(item.market, series);
  });
}

function drawTopSpreadChart(canvas, data) {
  if (!(canvas instanceof HTMLCanvasElement)) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;

  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  const padding = 16;
  const innerWidth = Math.max(0, width - padding * 2);
  const innerHeight = Math.max(0, height - padding * 2);
  if (!innerWidth || !innerHeight) {
    ctx.restore();
    return;
  }

  const values = data.map((point) => point.spreadPct).filter((value) => Number.isFinite(value));
  const times = data.map((point) => point.timestamp).filter((value) => Number.isFinite(value));
  if (values.length < 2 || times.length < 2) {
    ctx.restore();
    return;
  }

  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const valueRange = maxValue - minValue || 1;
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const timeRange = maxTime - minTime || 1;

  const points = data
    .filter((point) => Number.isFinite(point.spreadPct) && Number.isFinite(point.timestamp))
    .map((point) => ({
      x: padding + ((point.timestamp - minTime) / timeRange) * innerWidth,
      y: padding + (1 - (point.spreadPct - minValue) / valueRange) * innerHeight,
    }));

  if (points.length < 2) {
    ctx.restore();
    return;
  }

  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(60, 166, 106, 0.9)';
  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) {
      ctx.moveTo(point.x, point.y);
    } else {
      ctx.lineTo(point.x, point.y);
    }
  });
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(points[0].x, padding + innerHeight);
  points.forEach((point) => {
    ctx.lineTo(point.x, point.y);
  });
  ctx.lineTo(points[points.length - 1].x, padding + innerHeight);
  ctx.closePath();
  ctx.fillStyle = 'rgba(60, 166, 106, 0.18)';
  ctx.fill();

  ctx.restore();
}

function updateTopSpreadChart() {
  const canvas = els.topSpreadsChart;
  const placeholder = els.topSpreadsChartEmpty;
  if (!canvas) return;

  const history = selectedTopMarket ? topSpreadHistory.get(selectedTopMarket) : null;
  const filtered = Array.isArray(history)
    ? history.filter((point) => Number.isFinite(point.spreadPct) && Number.isFinite(point.timestamp))
    : [];

  if (!filtered.length || filtered.length < 2) {
    if (placeholder) {
      placeholder.hidden = false;
    }
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, width, height);
      ctx.restore();
    }
    return;
  }

  if (placeholder) {
    placeholder.hidden = true;
  }

  const recent = filtered.slice(-60);
  drawTopSpreadChart(canvas, recent);
}

function updateTopSpreadsSelectionUI() {
  if (els.topSpreadsSelect && selectedTopMarket) {
    els.topSpreadsSelect.value = selectedTopMarket;
  }
  if (els.topSpreadsSelect && !selectedTopMarket) {
    els.topSpreadsSelect.value = '';
  }
  if (els.topSpreadsBody) {
    els.topSpreadsBody.querySelectorAll('tr[data-market]').forEach((row) => {
      row.classList.toggle('is-selected', row.dataset.market === selectedTopMarket);
    });
  }

  const selected = lastTopSpreads.find((item) => item.market === selectedTopMarket);
  if (els.topSpreadsSelected) {
    els.topSpreadsSelected.textContent = selected?.market || '–';
  }
  if (els.topSpreadsCurrent) {
    els.topSpreadsCurrent.textContent = selected
      ? `Spread: ${formatPercent(selected.spreadPct, 2)} • ${formatPrice(selected.spreadAbs, 6)}`
      : 'Spread: –';
  }
}

function setSelectedTopSpreadMarket(market) {
  if (typeof market === 'string' && market.trim()) {
    selectedTopMarket = market;
  } else {
    selectedTopMarket = null;
  }
  updateTopSpreadsSelectionUI();
  updateTopSpreadChart();
}

function renderTopSpreads(list = []) {
  if (!els.topSpreadsBody) return;
  lastTopSpreads = Array.isArray(list) ? list : [];

  if (lastTopSpreads.length === 0) {
    els.topSpreadsBody.innerHTML = '<tr><td colspan="7">Geen data beschikbaar</td></tr>';
    if (els.topSpreadsUpdated) {
      els.topSpreadsUpdated.textContent = '–';
    }
    if (els.topSpreadsSelect) {
      els.topSpreadsSelect.innerHTML = '<option value="">Geen markten beschikbaar</option>';
      els.topSpreadsSelect.disabled = true;
    }
    setSelectedTopSpreadMarket(null);
    return;
  }

  const rows = lastTopSpreads
    .map((item, index) => {
      const rank = index + 1;
      const market = item.market || '–';
      const spreadPct = formatPercent(item.spreadPct, 2);
      const spreadAbs = formatPrice(item.spreadAbs, 6);
      const volume = Number.isFinite(item.volumeEur)
        ? `€${formatNumber(item.volumeEur)}`
        : '–';
      const bid = formatPrice(item.bid, 5);
      const ask = formatPrice(item.ask, 5);
      return `
        <tr data-market="${market}">
          <td class="rank">${rank}</td>
          <td>${market}</td>
          <td>${spreadPct}</td>
          <td>${spreadAbs}</td>
          <td>${volume}</td>
          <td>${bid}</td>
          <td>${ask}</td>
        </tr>
      `;
    })
    .join('');

  els.topSpreadsBody.innerHTML = rows;
  if (els.topSpreadsSelect) {
    const options = lastTopSpreads
      .map((item, index) => `<option value="${item.market}">${index + 1}. ${item.market}</option>`)
      .join('');
    els.topSpreadsSelect.innerHTML = options;
    els.topSpreadsSelect.disabled = false;
  }

  if (!selectedTopMarket || !lastTopSpreads.some((item) => item.market === selectedTopMarket)) {
    selectedTopMarket = lastTopSpreads[0]?.market || null;
  }

  updateTopSpreadsSelectionUI();
  updateTopSpreadChart();

  if (els.topSpreadsUpdated) {
    const time = new Date().toLocaleTimeString('nl-NL', { hour12: false });
    els.topSpreadsUpdated.textContent = time;
  }
}

async function refreshTopSpreads() {
  try {
    const list = await fetchTopSpreadMarkets({ limit: 10, minVolumeEur: 100000 });
    recordTopSpreadsHistory(list);
    renderTopSpreads(list);
  } catch (err) {
    console.warn('Kon top spreads niet verversen', err);
    renderTopSpreads([]);
  }
}

function startTopSpreadsUpdates() {
  if (topSpreadsTimer) {
    clearInterval(topSpreadsTimer);
  }
  topSpreadsTimer = setInterval(() => {
    refreshTopSpreads();
  }, REFRESH_INTERVAL_MS);
  refreshTopSpreads();
}

function wireEvents() {
  if (els.topSpreadsSelect) {
    els.topSpreadsSelect.addEventListener('change', (event) => {
      setSelectedTopSpreadMarket(event.target.value);
    });
  }

  if (els.topSpreadsBody) {
    els.topSpreadsBody.addEventListener('click', (event) => {
      const row = event.target.closest('tr[data-market]');
      if (!row) return;
      setSelectedTopSpreadMarket(row.dataset.market);
    });
  }

  window.addEventListener('resize', () => {
    updateTopSpreadChart();
  });
}

function init() {
  wireEvents();
  startTopSpreadsUpdates();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
