import { describe, it, expect } from 'vitest';
import {
  createAnimationClock,
  quantizeTime,
} from '../../src/client/animationClock.js';

// Общие часы анимаций карты: за тик движок рисует полотно несколько раз, а
// время обязано шагнуть ровно один раз.
describe('animationClock', () => {
  it('одно приращение на тик при многократной отрисовке', () => {
    const ticker = { lastTime: 1000 };
    const clock = createAnimationClock(ticker);

    expect(clock.now()).toBe(0);

    ticker.lastTime += 16;

    for (let i = 0; i < 5; i += 1) {
      expect(clock.now()).toBeCloseTo(0.016, 9);
    }

    ticker.lastTime += 16;

    expect(clock.now()).toBeCloseTo(0.032, 9);
  });

  it('пропущенные тики догоняются разницей времени, назад время не идёт', () => {
    const ticker = { lastTime: 0 };
    const clock = createAnimationClock(ticker);

    clock.now();
    ticker.lastTime = 500;

    expect(clock.now()).toBeCloseTo(0.5, 9);

    ticker.lastTime = 400;

    expect(clock.now()).toBeCloseTo(0.5, 9);
  });

  it('квантование по maxFps: кадр меняется не чаще maxFps', () => {
    expect(quantizeTime(0.049, 30)).toBeCloseTo(1 / 30, 9);
    expect(quantizeTime(0.07, 30)).toBeCloseTo(2 / 30, 9);
    expect(quantizeTime(0.07, 0)).toBe(0.07);
  });
});
