import { describe, it, expect } from 'vitest';
import { createTankModel } from '../../../src/client/tank3d/model.js';
import { poseModel } from '../../../src/client/tank3d/transform.js';
import {
  modelLean,
  projectModel,
  visibleFaces,
  faceShade,
} from '../../../src/client/tank3d/project.js';
import { tankLightUniforms } from '../../../src/client/tankLight.js';
import { tilt, tankLight } from '../../../src/config/render.js';

// Поза, проекция, видимость и свет граней: PixiJS не нужен

const model = createTankModel();
const NO_LEAN = { x: 0, y: 0 };

const view = (pose = {}, lean = NO_LEAN) => {
  const posed = poseModel({ model, size: 10, ...pose });
  const projected = projectModel({ points: posed.points, lean });
  const faces = visibleFaces({ model, points: posed.points, projected });

  return { posed, projected, faces: faces.map(i => model.faces[i]) };
};

const materials = faces => new Set(faces.map(f => f.material));

describe('poseModel + visibleFaces', () => {
  it('ровный танк сверху: видны верхи и скаты, отвесных боков и низа нет', () => {
    const { faces } = view();

    for (const face of faces) {
      expect(face.kind).not.toBe('bottom');
    }

    // отвесные бока гусениц и ствола сверху не видны
    expect(materials(faces).has('trackSide')).toBe(false);
    expect(materials(faces).has('hullTop')).toBe(true);
    expect(materials(faces).has('turretTop')).toBe(true);
    // скаты корпуса (фаски) видны
    expect(materials(faces).has('hullSide')).toBe(true);
  });

  it('проекция палубы совпадает с рисунком в size / 10', () => {
    const posed = poseModel({ model, size: 3 });
    const deck = model.faces.find(f => f.material === 'hullTop');
    const us = deck.indices.map(i => posed.points[i][0]);

    expect(Math.max(...us)).toBeCloseTo(14 * 0.3, 6);
    expect(Math.min(...us)).toBeCloseTo(-16 * 0.3, 6);
  });

  // знаки как в tiltCorners: pitch > 0 поднимает нос, roll > 0 — борт +v.
  // Поднятая сторона поворачивает к наблюдателю СВОЙ торец или бок
  const trackSides = pose => {
    const { posed, faces } = view(pose);

    return faces
      .map(f => model.faces.indexOf(f))
      .filter(i => model.faces[i].material === 'trackSide')
      .map(i => posed.normals[i]);
  };

  it('тангаж > 0 открывает лобовые торцы гусениц', () => {
    const normals = trackSides({ pitch: 0.3 });

    expect(normals.length).toBeGreaterThan(0);

    for (const normal of normals) {
      expect(normal[0]).toBeGreaterThan(0.5);
    }
  });

  it('крен > 0 открывает внешний бок гусеницы +v', () => {
    const normals = trackSides({ roll: 0.3 });

    expect(normals.length).toBeGreaterThan(0);

    for (const normal of normals) {
      expect(normal[1]).toBeGreaterThan(0.5);
    }
  });

  it('поворот башни на π/2 уводит ствол к +v', () => {
    const { posed } = view({ gunRotation: Math.PI / 2 });
    const tip = model.faces.find(f => f.material === 'brake');
    const vs = tip.indices.map(i => posed.points[i][1]);

    expect(Math.min(...vs)).toBeGreaterThan(20);
  });

  it('порядок по частям: корпус → башня → ствол', () => {
    const { faces } = view();
    const hull = faces.findIndex(f => f.material === 'hullTop');
    const turret = faces.findIndex(f => f.material === 'turretTop');
    const barrel = faces.findIndex(f => f.material === 'barrel');

    expect(hull).toBeLessThan(turret);
    expect(turret).toBeLessThan(barrel);
  });

  // на горке корма опущена: у задних скатов башни средняя высота ниже, чем
  // у большой палубы, и сортировка по высоте прятала их под палубу
  it.each([
    [0.35, 0],
    [-0.35, 0],
    [0, 0.35],
    [0, -0.35],
    [0.3, 0.3],
  ])(
    'на наклоне pitch %f, roll %f башня целиком после корпуса',
    (pitch, roll) => {
      const { faces } = view({ pitch, roll });
      const lastHull = faces.map(f => f.part).lastIndexOf('hull');
      const firstTurret = faces.findIndex(f => f.part === 'turret');

      expect(firstTurret).toBeGreaterThan(lastHull);
      expect(faces.filter(f => f.part === 'turret').length).toBeGreaterThan(1);
    },
  );

  it('просадка сжимает модель по высоте, не в плане', () => {
    const still = poseModel({ model, size: 10 });
    const squashed = poseModel({ model, size: 10, squash: 0.2 });
    const top = model.faces.find(f => f.material === 'turretTop').indices[0];

    expect(squashed.points[top][2]).toBeCloseTo(still.points[top][2] * 0.8, 6);
    expect(squashed.points[top][0]).toBeCloseTo(still.points[top][0], 6);
  });

  it('откат двигает только ствол', () => {
    const still = poseModel({ model, size: 10 });
    const kicked = poseModel({ model, size: 10, gunKick: { x: -3, y: 0 } });
    const turretTop = model.faces.find(f => f.material === 'turretTop');
    const brake = model.faces.find(f => f.material === 'brake');

    expect(kicked.points[turretTop.indices[0]]).toEqual(
      still.points[turretTop.indices[0]],
    );
    expect(kicked.points[brake.indices[0]][0]).toBeCloseTo(
      still.points[brake.indices[0]][0] - 3,
      6,
    );
  });
});

describe('modelLean', () => {
  const lean = overrides =>
    modelLean({
      x: 400,
      y: 300,
      camera: { x: 400, y: 300 },
      heading: 0,
      shear: 0.22,
      levelHeight: 12.8,
      maxLean: 2,
      topHeight: 3,
      ...overrides,
    });

  it('в центре экрана наклона нет', () => {
    const { x, y } = lean();

    expect(x).toBe(0);
    expect(y).toBe(0);
  });

  it('на краю — от камеры и не длиннее maxLean на верхней точке', () => {
    const { x, y } = lean({ x: 5000 });

    expect(x).toBeGreaterThan(0);
    expect(Math.hypot(x, y) * 3).toBeLessThanOrEqual(2);
    expect(Math.hypot(x, y) * 3).toBeCloseTo(2, 3);
  });

  // насыщение плавное: наклон растёт с удалением, а не упирается в срез
  it('наклон растёт монотонно и плавно', () => {
    let previous = 0;

    for (const x of [420, 450, 500, 600, 800]) {
      const top = Math.hypot(lean({ x }).x, lean({ x }).y) * 3;

      expect(top).toBeGreaterThan(previous);
      previous = top;
    }
  });

  it('gain ослабляет наклон', () => {
    const full = lean({ x: 420 }).x;
    const weak = lean({ x: 420, gain: 0.3 }).x;

    expect(weak).toBeLessThan(full);
    expect(weak / full).toBeCloseTo(0.3, 1);
  });

  it('в осях контейнера: курс π/2 поворачивает наклон', () => {
    const { x, y } = lean({ x: 1000, heading: Math.PI / 2 });

    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeLessThan(0);
  });
});

describe('faceShade', () => {
  const light = tankLightUniforms({
    heading: 0,
    rotation: 0,
    pitch: 0,
    roll: 0,
    lightDir: tilt.lightDir,
    lightZ: tankLight.lightZ,
    ambient: tankLight.ambient,
    diffuse: tankLight.diffuse,
  });

  it('плоский верх — 1 при любом курсе', () => {
    for (const heading of [0, 1, Math.PI]) {
      expect(faceShade([0, 0, 1], heading, light)).toBeCloseTo(1, 6);
    }
  });

  it('скат к свету светлее, от света темнее; курс меняет их местами', () => {
    const toLight = [-Math.SQRT1_2, 0, Math.SQRT1_2];

    expect(faceShade(toLight, 0, light)).toBeGreaterThan(1);
    expect(faceShade(toLight, Math.PI, light)).toBeLessThan(1);
  });
});
