import { describe, it, expect, vi, beforeEach } from 'vitest';

// Регресс: bakers/index.js оборачивает каждый baker вызовом
// warmUpRenderer до его тела (см. warmUpRenderer.test.js и
// docs/en/extending.md). Мок здесь ловит именно "обёртка сломалась/забыта
// для нового baker'а" — сценарий, который warmUpRenderer.test.js сам по
// себе не видит, потому что тестирует только мемоизацию WeakSet.
vi.mock('../../src/client/bakers/warmUpRenderer.js', () => ({
  default: vi.fn(),
}));

import warmUpRenderer from '../../src/client/bakers/warmUpRenderer.js';
import bakers from '../../src/client/bakers/index.js';

const makeRenderer = order => ({
  generateTexture: vi.fn(() => {
    order.push('generateTexture');
    return {};
  }),
});

describe('bakers/index.js оборачивает каждый baker прогревом рендерера', () => {
  beforeEach(() => {
    warmUpRenderer.mockClear();
  });

  const cases = [
    ['impactParticleTexture', { radius: 4, blur: 2, color: 0xffffff }],
    ['explosionTexture', { radius: 4, blur: 2, color: 0xffffff }],
    ['funnelTexture', { baseRadius: 4, irregularity: 1, blur: 2, numPoints: 6 }],
    ['smokeTexture', { radius: 4, blur: 2, color: 0xffffff }],
    [
      'tankRadarTexture',
      {
        radius: 8,
        borderWidth: 1,
        crossSize: 6,
        crossThickness: 1,
        colors: { teamId1: 0xff0000, teamId2: 0x0000ff },
      },
    ],
    ['trackMarkTexture', { width: 4, length: 8, color: 0xffffff }],
    ['bombTexture', { colorOuter: 0x000000, colorInner: 0xffffff }],
  ];

  it.each(cases)('%s', (name, params) => {
    const order = [];
    const renderer = makeRenderer(order);

    warmUpRenderer.mockImplementation(() => order.push('warmUpRenderer'));

    bakers[name](params, renderer);

    expect(warmUpRenderer).toHaveBeenCalledWith(renderer);
    expect(renderer.generateTexture).toHaveBeenCalled();
    expect(order[0]).toBe('warmUpRenderer');
  });
});
