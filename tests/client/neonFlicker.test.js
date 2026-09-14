import { describe, it, expect } from 'vitest';
import {
  brightness,
  cellSeed,
  inDropout,
  DROPOUT_WINDOW,
} from '../../src/client/neonFlicker.js';

// Мерцание неона — чистая функция: одинаковая картина у всех клиентов.
describe('neonFlicker', () => {
  const cfg = { pulse: 0.15, dropouts: 0.2 };

  it('детерминирована: одинаковые входы — одинаковый результат', () => {
    const seed = cellSeed(40, 20, 1);

    for (let t = 0; t < 30; t += 0.37) {
      expect(brightness(t, seed, cfg)).toEqual(brightness(t, seed, cfg));
    }

    expect(cellSeed(40, 20, 1)).toBe(seed);
    expect(cellSeed(41, 20, 1)).not.toBe(seed);
  });

  it('яркость ядра и ореола в [0, 1]; сбой гасит ядро сильнее ореола', () => {
    const seed = cellSeed(3, 7);
    let dropped = 0;

    for (let t = 0; t < 120; t += 0.01) {
      const light = brightness(t, seed, { pulse: 1, dropouts: 0.5 });

      expect(light.core).toBeGreaterThanOrEqual(0);
      expect(light.core).toBeLessThanOrEqual(1);
      expect(light.glow).toBeGreaterThanOrEqual(0);
      expect(light.glow).toBeLessThanOrEqual(1);
      expect(light.core).toBeLessThanOrEqual(light.glow);

      if (light.core < light.glow) {
        dropped += 1;
      }
    }

    expect(dropped).toBeGreaterThan(0);
  });

  it('без flicker — ровный свет', () => {
    expect(brightness(12.3, 5, undefined)).toEqual({ core: 1, glow: 1 });
  });

  it('пульс не опускает яркость ниже 1 − pulse', () => {
    for (let t = 0; t < 10; t += 0.05) {
      const light = brightness(t, 9, { pulse: 0.15 });

      expect(light.core).toBeGreaterThanOrEqual(0.85 - 1e-9);
    }
  });

  it('сбои приходятся на ожидаемую долю окон', () => {
    const windows = 20000;
    let hits = 0;

    for (let window = 0; window < windows; window += 1) {
      const from = window * DROPOUT_WINDOW;

      for (let step = 0; step < 60; step += 1) {
        if (inDropout(from + (step / 60) * DROPOUT_WINDOW, cellSeed(1, 2), 0.2)) {
          hits += 1;
          break;
        }
      }
    }

    expect(hits / windows).toBeGreaterThan(0.17);
    expect(hits / windows).toBeLessThan(0.23);
  });
});
