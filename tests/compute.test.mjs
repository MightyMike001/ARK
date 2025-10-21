import assert from 'node:assert/strict';
import { compute } from '../calc.js';

const baseParams = {
  makerFeePct: 0,
  takerFeePct: 0,
  routeProfile: 'maker/maker',
  slippagePct: 0,
  minEdgePct: 0,
  positionEur: 1000,
};

const tolerance = 1e-9;

const scenarios = [
  {
    description: 'spread gelijk aan één tick',
    bid: 100,
    ask: 100.1,
    tick: 0.1,
  },
  {
    description: 'spread kleiner dan twee ticks',
    bid: 1.0,
    ask: 1.075,
    tick: 0.05,
  },
  {
    description: 'nauwe spread met kleine tick',
    bid: 0.5025,
    ask: 0.5075,
    tick: 0.0025,
  },
];

for (const { description, bid, ask, tick } of scenarios) {
  const params = { ...baseParams, tick };
  const result = compute(bid, ask, params);

  assert.ok(result.showAdvice, `verwacht zichtbare adviesstatus voor scenario: ${description}`);
  assert.ok(Number.isFinite(result.buy), `koopprijs moet eindig zijn voor scenario: ${description}`);
  assert.ok(Number.isFinite(result.sell), `verkoopprijs moet eindig zijn voor scenario: ${description}`);
  assert.ok(
    result.buy >= bid - tolerance,
    `koopprijs moet minimaal bod zijn (${description}): ${result.buy} vs ${bid}`,
  );
  assert.ok(
    result.sell <= ask + tolerance,
    `verkoopprijs mag ask niet overschrijden (${description}): ${result.sell} vs ${ask}`,
  );
}

console.log('Alle compute-tests voor smalle spreads geslaagd.');
