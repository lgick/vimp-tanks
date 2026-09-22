import { describe, it, expect } from 'vitest';
import blurMargin, {
  blurPadding,
} from '../../../src/client/bakers/blurMargin.js';

// сигма размытия Pixi (ядро 5, несколько проходов)
const SIGMA_PER_STRENGTH = 1.29;

describe('blurMargin', () => {
  it('возвращает целое число пикселей', () => {
    expect(Number.isInteger(blurMargin(2.5))).toBe(true);
  });

  it('без размытия запас не нужен', () => {
    expect(blurMargin(0)).toBe(0);
  });

  it('покрывает не менее трёх сигм размытия', () => {
    for (const strength of [1, 2, 10, 40]) {
      expect(blurMargin(strength)).toBeGreaterThanOrEqual(
        3 * SIGMA_PER_STRENGTH * strength,
      );
    }
  });

  it('растёт линейно по силе размытия', () => {
    expect(blurMargin(20)).toBe(blurMargin(10) * 2);
  });

  it('padding вдвое шире запаса: край области фильтра за рамкой на носитель ядра', () => {
    for (const strength of [0, 1, 2.5, 4]) {
      expect(blurPadding(strength)).toBe(blurMargin(strength) * 2);
    }
  });
});
