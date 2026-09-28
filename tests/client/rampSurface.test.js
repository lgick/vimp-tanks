import { describe, it, expect } from 'vitest';
import { rampSurfaceAt } from '../../src/client/rampSurface.js';

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
