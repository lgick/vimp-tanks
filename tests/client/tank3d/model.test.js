import { describe, it, expect } from 'vitest';
import {
  createTankModel,
  polygonNormal,
} from '../../../src/client/tank3d/model.js';

// Модель — чистые данные: вершины в пикселях рисунка корпуса и грани с
// обходом наружу

const model = createTankModel();
const facePoints = face => face.indices.map(i => model.vertices[i]);

describe('createTankModel', () => {
  it('каждая часть замкнута: у каждого ребра есть обратное', () => {
    for (const part of ['track', 'hull', 'turret', 'barrel']) {
      const edges = new Map();

      for (const face of model.faces.filter(f => f.part === part)) {
        face.indices.forEach((a, i) => {
          const b = face.indices[(i + 1) % face.indices.length];
          const key = `${a}>${b}`;

          edges.set(key, (edges.get(key) || 0) + 1);
        });
      }

      for (const key of edges.keys()) {
        const [a, b] = key.split('>');

        expect(edges.has(`${b}>${a}`)).toBe(true);
      }
    }
  });

  it('нормали смотрят наружу: верх вверх, низ вниз, бока от центра части', () => {
    for (const face of model.faces) {
      const normal = polygonNormal(facePoints(face));

      if (face.kind === 'top') {
        expect(normal[2]).toBeCloseTo(1, 6);
      } else if (face.kind === 'bottom') {
        expect(normal[2]).toBeCloseTo(-1, 6);
      }
    }

    // бока корпуса: нормаль по направлению от центра корпуса (0, 0)
    for (const face of model.faces.filter(
      f => f.part === 'hull' && f.kind === 'side',
    )) {
      const points = facePoints(face);
      const cu = points.reduce((sum, p) => sum + p[0], 0) / points.length;
      const cv = points.reduce((sum, p) => sum + p[1], 0) / points.length;
      const normal = polygonNormal(points);

      expect(normal[0] * cu + normal[1] * cv).toBeGreaterThan(0);
    }
  });

  it('палуба и башня — по рисунку корпуса', () => {
    const deck = model.faces.find(f => f.material === 'hullTop');
    const us = facePoints(deck).map(p => p[0]);
    const vs = facePoints(deck).map(p => p[1]);

    expect(Math.min(...us)).toBe(-16);
    expect(Math.max(...us)).toBe(14);
    expect(Math.min(...vs)).toBe(-7);
    expect(Math.max(...vs)).toBe(7);

    const turretTop = model.faces.find(f => f.material === 'turretTop');

    expect(facePoints(turretTop)).toHaveLength(8);
  });
});
