import { describe, it, expect } from 'vitest';
import {
  crossingDistance,
  edgeFace,
  faceIsFront,
  raisedPoint,
} from '../../src/client/wallFace.js';
import { offsetPoint } from '../../src/client/parallax.js';

// Геометрия видимой грани стены: чистые функции, без PixiJS.

describe('wallFace: edgeFace', () => {
  const CELL = 32;

  it('конец на кромке x — грань по x, нормаль навстречу лучу', () => {
    expect(edgeFace(64.05, 40, 1, 0, CELL, CELL, 0.15)).toEqual({
      axis: 'x',
      coord: 64,
      nx: -1,
      ny: 0,
    });
    expect(edgeFace(63.9, 40, -1, 0, CELL, CELL, 0.15)).toEqual({
      axis: 'x',
      coord: 64,
      nx: 1,
      ny: 0,
    });
  });

  it('конец на кромке y — грань по y', () => {
    expect(edgeFace(40, 96, 0.2, 0.98, CELL, CELL, 0.15)).toEqual({
      axis: 'y',
      coord: 96,
      nx: 0,
      ny: -1,
    });
  });

  it('конец не на кромке — null', () => {
    expect(edgeFace(40, 50, 1, 0, CELL, CELL, 0.15)).toBeNull();
    // на кромке, но луч идёт вдоль неё — это не упор
    expect(edgeFace(64, 50, 0, 1, CELL, CELL, 0.15)).toBeNull();
  });

  it('угол — ось большей составляющей направления', () => {
    expect(edgeFace(64, 96, 0.8, 0.6, CELL, CELL, 0.15).axis).toBe('x');
    expect(edgeFace(64, 96, 0.6, -0.8, CELL, CELL, 0.15)).toEqual({
      axis: 'y',
      coord: 96,
      nx: 0,
      ny: 1,
    });
  });
});

describe('wallFace: faceIsFront', () => {
  const face = { axis: 'x', coord: 64, nx: -1, ny: 0 };

  it('грань смотрит на камеру — видна, камера за стеной — нет', () => {
    expect(faceIsFront(face, 64, 40, { x: 0, y: 0 })).toBe(true);
    expect(faceIsFront(face, 64, 40, { x: 200, y: 0 })).toBe(false);
  });
});

describe('wallFace: raisedPoint', () => {
  const camera = { x: 10, y: -20 };

  it('рисунок q в kBase совпадает с рисунком p в kRaised', () => {
    const kBase = 0.22;
    const kRaised = 0.22 + 0.19 * 0.22;
    const q = raisedPoint(120, 80, camera, kBase, kRaised);
    const drawn = offsetPoint(q.x, q.y, camera, kBase);
    const target = offsetPoint(120, 80, camera, kRaised);

    expect(drawn.x).toBeCloseTo(target.x, 6);
    expect(drawn.y).toBeCloseTo(target.y, 6);
  });

  it('без камеры — исходная точка', () => {
    expect(raisedPoint(5, 6, null, 0, 0.1)).toEqual({ x: 5, y: 6 });
  });
});

describe('wallFace: crossingDistance', () => {
  const camera = { x: 200, y: 30 };

  it('рисунок точки на t лежит на линии грани', () => {
    const face = { axis: 'x', coord: 96, nx: -1, ny: 0 };
    const kBase = 0;
    const kLine = 1 * 0.22;
    const dx = Math.cos(0.2);
    const dy = Math.sin(0.2);
    const t = crossingDistance({
      x0: 10,
      y0: 20,
      dx,
      dy,
      face,
      camera,
      kBase,
      kLine,
    });
    const drawn = offsetPoint(10 + dx * t, 20 + dy * t, camera, kBase);

    expect(drawn.x).toBeCloseTo(96 + (96 - camera.x) * kLine, 6);
    // камера за стеной: силуэт верха ближе подножия
    expect(10 + dx * t).toBeLessThan(96);
  });

  it('то же для грани по y и ненулевой проекции пола', () => {
    const face = { axis: 'y', coord: 64, nx: 0, ny: -1 };
    const kBase = 0.22;
    const kLine = 1.35 * 0.22;
    const t = crossingDistance({
      x0: 0,
      y0: 0,
      dx: 0,
      dy: 1,
      face,
      camera: { x: 0, y: 150 },
      kBase,
      kLine,
    });
    const drawn = offsetPoint(0, t, { x: 0, y: 150 }, kBase);

    expect(drawn.y).toBeCloseTo(64 + (64 - 150) * kLine, 6);
  });

  it('луч параллелен грани — null', () => {
    expect(
      crossingDistance({
        x0: 0,
        y0: 0,
        dx: 0,
        dy: 1,
        face: { axis: 'x', coord: 96, nx: -1, ny: 0 },
        camera,
        kBase: 0,
        kLine: 0.22,
      }),
    ).toBeNull();
  });
});
