import { describe, it, expect } from 'vitest';
import TracerEffect, {
  tracerSpan,
} from '../../../../src/client/parts/effects/shot/TracerEffect.js';
import { tracer } from '../../../../src/config/render.js';

describe('tracerSpan', () => {
  const span = progress =>
    tracerSpan({ progress, totalDist: 500, trailLength: 55 });

  // линия выходит прямо из ствола: отступа от дула нет
  it('с первого кадра хвост у дула', () => {
    const { tail, head } = span(0.05);

    expect(tail).toBe(0);
    expect(head).toBeCloseTo(25, 6);
  });

  it('хвост не длиннее trailLength', () => {
    for (const progress of [0.2, 0.4, 0.6]) {
      const { tail, head } = span(progress);

      expect(head - tail).toBeLessThanOrEqual(55 + 1e-6);
    }
  });

  it('к концу пути хвост стягивается к цели', () => {
    const { tail, head } = span(1);

    expect(head).toBe(500);
    expect(tail).toBe(500);
  });
});

// дальний выстрел: пролёт упирается в maxDuration, голова проходит сотни
// единиц за кадр — хвост обязан держать линию от ствола в первом кадре
describe('tracerSpan: дальний выстрел', () => {
  it('в первом кадре линия идёт от дула', () => {
    const totalDist = 1500;
    const progress = 1000 / 60 / tracer.maxDuration;
    const { tail, head } = tracerSpan({
      progress,
      totalDist,
      trailLength: tracer.trailLength,
      trailShare: tracer.trailShare,
    });

    expect(head).toBeGreaterThan(200);
    expect(tail).toBe(0);
  });

  it('у ближнего выстрела хвост — trailLength', () => {
    const { tail, head } = tracerSpan({
      progress: 0.5,
      totalDist: 100,
      trailLength: 55,
      trailShare: 0.4,
    });

    expect(head - tail).toBeCloseTo(27.5, 6);
  });
});

describe('TracerEffect', () => {
  it('длительность в границах конфига', () => {
    const near = new TracerEffect(0, 0, 1, 0, () => {});
    const far = new TracerEffect(0, 0, 100000, 0, () => {});

    expect(near.animationDuration).toBe(tracer.minDuration);
    expect(far.animationDuration).toBe(tracer.maxDuration);
  });

  it('завершается по длительности', () => {
    let done = false;
    const effect = new TracerEffect(0, 0, 500, 0, () => {
      done = true;
    });

    effect._update(effect.animationDuration / 2);
    expect(done).toBe(false);

    effect._update(effect.animationDuration);
    expect(done).toBe(true);
  });

  it('выстрел в ту же точку не даёт NaN и завершается', () => {
    let done = false;
    const effect = new TracerEffect(5, 5, 5, 5, () => {
      done = true;
    });

    effect._update(tracer.maxDuration);

    expect(done).toBe(true);
  });
});

// дуло едущего танка сдвигается: луч переносится целиком — направление и
// длина прежние, прогресс пролёта сохраняется
describe('TracerEffect.shiftTo', () => {
  it('переносит начало и конец на один сдвиг', () => {
    const effect = new TracerEffect(0, 0, 100, 0, () => {});

    effect._update(effect.animationDuration / 2);
    effect.shiftTo(5, 10);

    expect(effect.startPositionX).toBe(5);
    expect(effect.startPositionY).toBe(10);
    expect(effect.endPositionX).toBe(105);
    expect(effect.endPositionY).toBe(10);
    expect(effect.totalDist).toBeCloseTo(100, 6);
    expect(effect.progress).toBeCloseTo(0.5, 6);
  });

  // танк вплотную к стене: дуло уже в стене, луч нулевой. При езде вдоль
  // стены он обязан остаться нулевым, а не растянуться назад
  it('нулевой луч остаётся нулевым', () => {
    const effect = new TracerEffect(10, 10, 10, 10, () => {});

    effect._update(1);
    effect.shiftTo(30, 10);

    expect(effect.totalDist).toBe(0);
    expect(effect.endPositionX).toBe(30);
  });
});
