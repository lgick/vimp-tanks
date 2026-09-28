import { describe, it, expect } from 'vitest';
import {
  fireIntensity,
  fireEnd,
  smokeRate,
  emissionEnd,
  smokeAlpha,
} from '../../src/client/wreckTimeline.js';

const fire = { duration: 9000, fadeOut: 5000 };
const smoke = { rate: 12, tailRate: 7, tail: 15000 };

describe('fireIntensity', () => {
  it('полная сила всё `duration`', () => {
    expect(fireIntensity(0, fire)).toBe(1);
    expect(fireIntensity(fire.duration, fire)).toBe(1);
  });

  it('линейно стихает за `fadeOut`', () => {
    expect(fireIntensity(fire.duration + fire.fadeOut / 2, fire)).toBeCloseTo(
      0.5,
    );
  });

  it('после конца пожара — 0', () => {
    expect(fireIntensity(fireEnd(fire), fire)).toBe(0);
    expect(fireIntensity(fireEnd(fire) + 1000, fire)).toBe(0);
  });

  it('`fadeOut: 0` — гаснет сразу', () => {
    const instant = { duration: 1000, fadeOut: 0 };

    expect(fireIntensity(1000, instant)).toBe(1);
    expect(fireIntensity(1001, instant)).toBe(0);
  });
});

describe('smokeRate', () => {
  it('в начале — `rate`', () => {
    expect(smokeRate(0, fire, smoke)).toBe(smoke.rate);
  });

  it('в конце пожара — `tailRate`', () => {
    expect(smokeRate(fireEnd(fire), fire, smoke)).toBe(smoke.tailRate);
  });

  it('в середине хвоста — половина `tailRate`', () => {
    expect(smokeRate(fireEnd(fire) + smoke.tail / 2, fire, smoke)).toBeCloseTo(
      smoke.tailRate / 2,
    );
  });

  it('после `emissionEnd` — 0', () => {
    expect(smokeRate(emissionEnd(fire, smoke), fire, smoke)).toBe(0);
    expect(smokeRate(emissionEnd(fire, smoke) + 1000, fire, smoke)).toBe(0);
  });

  it('`tail: 0` — дым обрывается с пожаром', () => {
    const noTail = { ...smoke, tail: 0 };

    expect(smokeRate(fireEnd(fire), fire, noTail)).toBe(0);
  });
});

describe('smokeAlpha', () => {
  it('0 в начале и в конце жизни', () => {
    expect(smokeAlpha(0, 0.4)).toBe(0);
    expect(smokeAlpha(1, 0.4)).toBe(0);
  });

  it('`peak` на плато', () => {
    expect(smokeAlpha(0.12, 0.4)).toBeCloseTo(0.4);
    expect(smokeAlpha(0.3, 0.4)).toBe(0.4);
    expect(smokeAlpha(0.45, 0.4)).toBe(0.4);
  });

  it('проявляется и угасает монотонно', () => {
    expect(smokeAlpha(0.06, 0.4)).toBeCloseTo(0.2);
    expect(smokeAlpha(0.725, 0.4)).toBeCloseTo(0.2);
  });
});
