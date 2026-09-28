import { describe, it, expect } from 'vitest';
import {
  rampFaceAt,
  rampRunAt,
  rampSlopeAt,
  rampSurfaceAt,
} from '../../src/client/rampSurface.js';

// Высота склона под мировой точкой обязана совпасть с высотой вершин клина
// (`buildRampMeshes`) и z танка в ядре: по ней осколки ложатся на склон.

describe('rampSurfaceAt: высота склона', () => {
  it('подъём по +x: от подножия на min к вершине на max', () => {
    const runs = [
      {
        axis: 0,
        sign: 1,
        from: 0,
        to: 1,
        min: 100,
        max: 140,
        crossMin: 0,
        crossMax: 20,
      },
    ];

    expect(rampSurfaceAt(runs, 0, 100, 10)).toBe(0);
    expect(rampSurfaceAt(runs, 0, 120, 10)).toBeCloseTo(0.5);
    expect(rampSurfaceAt(runs, 0, 140, 10)).toBe(1);
  });

  it('подъём по −y: подножие на max', () => {
    const runs = [
      {
        axis: 1,
        sign: -1,
        from: 0,
        to: 1,
        min: 0,
        max: 40,
        crossMin: 0,
        crossMax: 20,
      },
    ];

    expect(rampSurfaceAt(runs, 0, 10, 40)).toBe(0);
    expect(rampSurfaceAt(runs, 0, 10, 0)).toBe(1);
    expect(rampSurfaceAt(runs, 0, 10, 10)).toBeCloseTo(0.75);
  });

  it('нисходящая рампа: на min — from, на max — to', () => {
    const runs = [
      {
        axis: 0,
        sign: 1,
        from: 1,
        to: 0,
        min: 0,
        max: 40,
        crossMin: 0,
        crossMax: 20,
      },
    ];

    for (const level of [0, 1]) {
      expect(rampSurfaceAt(runs, level, 0, 10)).toBe(1);
      expect(rampSurfaceAt(runs, level, 40, 10)).toBe(0);
    }
  });

  it('точка вне прогона вдоль оси и поперёк — null', () => {
    const runs = [
      {
        axis: 0,
        sign: 1,
        from: 0,
        to: 1,
        min: 100,
        max: 140,
        crossMin: 0,
        crossMax: 20,
      },
    ];

    expect(rampSurfaceAt(runs, 0, 99, 10)).toBeNull();
    expect(rampSurfaceAt(runs, 0, 141, 10)).toBeNull();
    expect(rampSurfaceAt(runs, 0, 120, -1)).toBeNull();
    expect(rampSurfaceAt(runs, 0, 120, 21)).toBeNull();
  });

  it('фильтр уровня: терраса под горкой уровнем выше не накрыта', () => {
    const runs = [
      {
        axis: 0,
        sign: 1,
        from: 1,
        to: 2,
        min: 0,
        max: 40,
        crossMin: 0,
        crossMax: 20,
      },
    ];

    expect(rampSurfaceAt(runs, 0, 20, 10)).toBeNull();
    expect(rampSurfaceAt(runs, 1, 20, 10)).toBeCloseTo(1.5);
    expect(rampSurfaceAt(runs, 2, 20, 10)).toBeCloseTo(1.5);
  });

  it('не массив — null', () => {
    expect(rampSurfaceAt(undefined, 0, 0, 0)).toBeNull();
  });
});

// подъём 0 → 1 вдоль +x на [100, 140], полоса по y 0..20
const eastRun = {
  axis: 0,
  sign: 1,
  from: 0,
  to: 1,
  min: 100,
  max: 140,
  crossMin: 0,
  crossMax: 20,
};

describe('rampRunAt и rampSlopeAt: склон под точкой', () => {
  it('прогон под точкой — тот же объект, вне — null', () => {
    expect(rampRunAt([eastRun], 0, 120, 10)).toBe(eastRun);
    expect(rampRunAt([eastRun], 0, 90, 10)).toBeNull();
    expect(rampRunAt(undefined, 0, 120, 10)).toBeNull();
  });

  it('высота и ось прогона', () => {
    const slope = rampSlopeAt([eastRun], 0, 120, 10);

    expect(slope.height).toBeCloseTo(0.5);
    expect(slope.axis).toBe(0);

    const northRun = {
      ...eastRun,
      axis: 1,
      min: 0,
      max: 40,
      crossMin: 0,
      crossMax: 20,
    };

    expect(rampSlopeAt([northRun], 0, 10, 10)).toEqual({
      height: 0.25,
      axis: 1,
    });
  });

  it('вне прогона — null', () => {
    expect(rampSlopeAt([eastRun], 0, 150, 10)).toBeNull();
    expect(rampSlopeAt([eastRun], 0, 120, 30)).toBeNull();
  });
});

describe('rampFaceAt: грань насыпи под концом луча', () => {
  it('борт: луч с юга на север в y = 0', () => {
    const hit = rampFaceAt([eastRun], 0, 120, 0, 0, 1, 0.15);

    expect(hit.face).toEqual({ axis: 'y', coord: 0, nx: 0, ny: -1 });
    expect(hit.volume).toBeCloseTo(0.5);
  });

  it('торец из-под моста: луч на запад в верхний торец', () => {
    const hit = rampFaceAt([eastRun], 0, 140, 10, -1, 0, 0.15);

    expect(hit.face).toEqual({ axis: 'x', coord: 140, nx: 1, ny: 0 });
    expect(hit.volume).toBeCloseTo(1, 1);
  });

  it('конец внутри прогона — null', () => {
    expect(rampFaceAt([eastRun], 0, 120, 10, 0, 1, 0.15)).toBeNull();
  });

  it('луч, уходящий из прогона наружу, — null', () => {
    expect(rampFaceAt([eastRun], 0, 120, 0, 0, -1, 0.15)).toBeNull();
  });

  it('прогон с нижним уровнем 1 при level 0 — null', () => {
    const upper = { ...eastRun, from: 1, to: 2 };

    expect(rampFaceAt([upper], 0, 120, 0, 0, 1, 0.15)).toBeNull();
    expect(rampFaceAt([upper], 1, 120, 0, 0, 1, 0.15).volume).toBeCloseTo(0.5);
  });
});
