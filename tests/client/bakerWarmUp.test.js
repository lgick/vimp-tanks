import { describe, it, expect, vi, beforeEach } from 'vitest';

// Регресс: каждый baker, применяющий PixiJS Filter перед generateTexture,
// обязан прогреть renderer через warmUpRenderer (см. warmUpRenderer.test.js
// и docs/en/extending.md). Мок ловит именно "забыли добавить вызов в новом
// baker'е" — сценарий, который warmUpRenderer.test.js сам по себе не видит.
vi.mock('../../src/client/bakers/warmUpRenderer.js', () => ({
  default: vi.fn(),
}));

import warmUpRenderer from '../../src/client/bakers/warmUpRenderer.js';
import impactParticleTexture from '../../src/client/bakers/impactParticleTexture.js';
import explosionTexture from '../../src/client/bakers/explosionTexture.js';
import funnelTexture from '../../src/client/bakers/funnelTexture.js';
import smokeTexture from '../../src/client/bakers/smokeTexture.js';

const makeRenderer = order => ({
  generateTexture: vi.fn(() => {
    order.push('generateTexture');
    return {};
  }),
});

describe('bakers с Filter вызывают warmUpRenderer до generateTexture', () => {
  beforeEach(() => {
    warmUpRenderer.mockClear();
  });

  const cases = [
    ['impactParticleTexture', impactParticleTexture, { radius: 4, blur: 2, color: 0xffffff }],
    ['explosionTexture', explosionTexture, { radius: 4, blur: 2, color: 0xffffff }],
    ['funnelTexture', funnelTexture, { baseRadius: 4, irregularity: 1, blur: 2, numPoints: 6 }],
    ['smokeTexture', smokeTexture, { radius: 4, blur: 2, color: 0xffffff }],
  ];

  it.each(cases)('%s', (name, baker, params) => {
    const order = [];
    const renderer = makeRenderer(order);

    warmUpRenderer.mockImplementation(() => order.push('warmUpRenderer'));

    baker(params, renderer);

    expect(warmUpRenderer).toHaveBeenCalledWith(renderer);
    expect(renderer.generateTexture).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['warmUpRenderer', 'generateTexture']);
  });
});
