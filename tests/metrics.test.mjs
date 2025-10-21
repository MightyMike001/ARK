import assert from 'node:assert/strict';
import { computeVolatilityIndicators } from '../logic/metrics.js';

const buildCandle = ({ open = 1, close = 1, high = 1.1, low = 0.9, volume = 0, timestamp }) => ({
  open,
  close,
  high,
  low,
  volume,
  timestamp,
});

const baseTimestamp = Date.UTC(2024, 0, 1);
const step = 15 * 60 * 1000;

const makeSeries = (volumes) => volumes.map((volume, index) => (
  buildCandle({ volume, timestamp: baseTimestamp + index * step })
));

{
  const candles = { '15m': makeSeries([100, 120, 110, 130]) };
  const result = computeVolatilityIndicators({ candles });
  assert.ok(Number.isFinite(result.volumeSurge));
  assert.ok(result.volumeSurge > 0);
}

{
  const candles = { '15m': makeSeries([0, 0, 0, 12]) };
  const result = computeVolatilityIndicators({ candles });
  assert.ok(Number.isFinite(result.volumeSurge));
  assert.ok(result.volumeSurge >= 12);
}

{
  const candles = { '15m': makeSeries([5, 0, 0, 0]) };
  const result = computeVolatilityIndicators({ candles });
  assert.ok(Number.isFinite(result.volumeSurge));
  assert.strictEqual(result.volumeSurge, 0);
}

console.log('Volatility indicator tests passed.');
