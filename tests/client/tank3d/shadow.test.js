import { describe, it, expect } from 'vitest';
import { createTankModel } from '../../../src/client/tank3d/model.js';
import { poseModel } from '../../../src/client/tank3d/transform.js';
import {
  convexHull,
  shadowDrift,
  shadowPolygons,
} from '../../../src/client/tank3d/shadow.js';

const model = createTankModel();
const posed = poseModel({ model, size: 10 });

describe('convexHull', () => {
  it('отбрасывает внутренние точки', () => {
    const hull = convexHull([
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
      [1, 1],
    ]);

    expect(hull).toHaveLength(4);
    expect(hull).not.toContainEqual([1, 1]);
  });
});

describe('shadowDrift', () => {
  // свет с северо-запада — тень на юго-восток
  it('от света, в осях контейнера', () => {
    const drift = shadowDrift([-1, -1], 1, 0);

    expect(drift.x).toBeGreaterThan(0);
    expect(drift.y).toBeGreaterThan(0);

    const turned = shadowDrift([-1, 0], 1, Math.PI / 2);

    // курс π/2: экранный +x — это локальный −v
    expect(turned.x).toBeCloseTo(0, 6);
    expect(turned.y).toBeCloseTo(-1, 6);
  });

  it('без света — без сдвига', () => {
    expect(shadowDrift(undefined, 1, 0)).toEqual({ x: 0, y: 0 });
  });
});

describe('shadowPolygons', () => {
  const drift = { x: 0.5, y: 0.5 };
  const extent = polygons => Math.max(...polygons.flat().map(p => p[0]));

  it('по полигону на часть', () => {
    expect(shadowPolygons({ model, points: posed.points, drift })).toHaveLength(
      4,
    );
  });

  it('высокие части падают дальше от света', () => {
    const [track, , turret] = shadowPolygons({
      model,
      points: posed.points,
      drift,
    });
    const centre = polygon =>
      polygon.reduce((sum, p) => sum + p[1], 0) / polygon.length;

    // гусеницы симметричны по v, башня выше — её тень сдвинута к +v сильнее
    expect(centre(turret)).toBeGreaterThan(centre(track));
  });

  it('подъём уводит тень дальше', () => {
    const ground = shadowPolygons({ model, points: posed.points, drift });
    const lifted = shadowPolygons({
      model,
      points: posed.points,
      drift,
      lift: 10,
    });

    expect(extent(lifted)).toBeGreaterThan(extent(ground));
  });
});
