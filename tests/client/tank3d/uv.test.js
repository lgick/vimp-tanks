import { describe, it, expect } from 'vitest';
import { createTankModel } from '../../../src/client/tank3d/model.js';
import { faceUVs } from '../../../src/client/tank3d/uv.js';

// атлас-заглушка с раскладкой как у tankModelTexture: развёртка — чистая
// арифметика по областям
const atlas = {
  width: 100,
  height: 50,
  regions: {
    body: { x: 2, y: 2, w: 40, h: 30, originX: 22, originY: 17 },
    gun: { x: 44, y: 2, w: 40, h: 22, originX: 58.5, originY: 13 },
    trackSide: { x: 2, y: 34, w: 40, h: 5 },
    barrelSide: { x: 44, y: 34, w: 22, h: 3 },
    brakeSide: { x: 68, y: 34, w: 8, h: 4 },
    bottom: { x: 78, y: 34, w: 4, h: 4 },
  },
};

const model = createTankModel();
const uvs = faceUVs(model, atlas);

const inside = ([x, y], { x: rx, y: ry, w, h }) =>
  x * atlas.width >= rx - 1e-9 &&
  x * atlas.width <= rx + w + 1e-9 &&
  y * atlas.height >= ry - 1e-9 &&
  y * atlas.height <= ry + h + 1e-9;

// у модели все бока гусениц, ствола и тормоза отвесные — они на полосах;
// остальное планарно по части, низ — в своей области
const STRIPS = {
  trackSide: 'trackSide',
  barrel: 'barrelSide',
  brake: 'brakeSide',
};

const regionOf = face => {
  if (face.kind === 'bottom') {
    return 'bottom';
  }

  if (face.kind === 'side' && STRIPS[face.material]) {
    return STRIPS[face.material];
  }

  return face.part === 'turret' || face.part === 'barrel' ? 'gun' : 'body';
};

describe('faceUVs', () => {
  it('у каждой грани столько UV, сколько вершин', () => {
    model.faces.forEach((face, i) => {
      expect(uvs[i]).toHaveLength(face.indices.length);
    });
  });

  it('палуба ложится на рисунок корпуса по (u, v)', () => {
    const index = model.faces.findIndex(f => f.material === 'hullTop');
    const face = model.faces[index];

    face.indices.forEach((vertex, k) => {
      const [u, v] = model.vertices[vertex];
      const [x, y] = uvs[index][k];

      expect(x * atlas.width).toBeCloseTo(22 + u, 6);
      expect(y * atlas.height).toBeCloseTo(17 + v, 6);
    });
  });

  it('каждая грань — внутри своей области атласа', () => {
    model.faces.forEach((face, i) => {
      const region = atlas.regions[regionOf(face)];

      for (const point of uvs[i]) {
        expect(inside(point, region)).toBe(true);
      }
    });
  });

  it('бок гусеницы: вдоль ребра — его длина, по высоте — вся полоса', () => {
    const index = model.faces.findIndex(
      f => f.material === 'trackSide' && f.kind === 'side',
    );
    const [a, b, c, d] = uvs[index].map(([x, y]) => [
      x * atlas.width,
      y * atlas.height,
    ]);

    expect(b[0] - a[0]).toBeGreaterThan(0);
    expect(a[1]).toBe(39);
    expect(d[1]).toBe(34);
    expect(c[0]).toBe(b[0]);
  });
});
