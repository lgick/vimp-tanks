import { describe, it, expect } from 'vitest';
import {
  createHole,
  advance,
  apply,
  dispose,
} from '../../../../src/client/parts/map/holeOverlay.js';
import { seeThrough, parallax } from '../../../../src/config/render.js';

// «Дыра» вокруг игрока: состояние и его применение к одной цели. Слой и его
// перекрыватель считают дыру этим кодом, но своими экземплярами состояния —
// у Pixi фильтр несёт свои uniform'ы. Как этим пользуется слой — в
// MapLayer.test.js, здесь — сам механизм.

const target = () => ({ filters: [] });

// сцена: камера — это её трансформ, по нему считается экранный центр дыры
const stage = (x = 0, y = 0) => ({
  scale: { x: 1, y: 1 },
  position: { x, y },
});

const open = (
  hole,
  view,
  target_,
  camera = { x: 0, y: 0 },
  scene = stage(),
) => {
  for (let i = 0; i < 200; i += 1) {
    advance(hole, true, 0.2);
    apply(target_, hole, seeThrough, view, scene, camera);
  }
};

describe('holeOverlay', () => {
  it('сила тянется к желаемой и не выходит за единицу', () => {
    const hole = createHole();

    for (let i = 0; i < 200; i += 1) {
      advance(hole, true, 0.2);
    }

    expect(hole.strength).toBeGreaterThan(0.99);
    expect(hole.strength).toBeLessThanOrEqual(1);

    for (let i = 0; i < 200; i += 1) {
      advance(hole, false, 0.2);
    }

    expect(hole.strength).toBeLessThan(0.01);
  });

  // фильтр создаётся лениво: слоёв уровня >= 1 на карте может не быть вовсе,
  // а программу шейдера тогда компилировать не за что
  it('слабая дыра фильтра не создаёт вовсе', () => {
    const hole = createHole();
    const object = target();

    apply(object, hole, seeThrough, { x: 0, y: 0, z: 0 }, stage(), {
      x: 0,
      y: 0,
    });

    expect(hole.filter).toBe(null);
    expect(hole.attached).toBe(false);
    expect(object.filters).toHaveLength(0);
  });

  // центр дыры — экранный: мировая точка через трансформ сцены, и по той же
  // проекции, по которой нарисован сам игрок
  it('центр дыры считается от смещённой позиции игрока', () => {
    const hole = createHole();
    const object = target();
    const camera = { x: 400, y: 300 };

    open(hole, { x: 15, y: 5, z: 2 }, object, camera, stage(100, 50));

    expect(object.filters).toHaveLength(1);
    expect(hole.attached).toBe(true);

    const k = 2 * parallax.shear;
    const uniforms = hole.filter.resources.holeUniforms.uniforms;

    expect(uniforms.uHoleCenter[0]).toBeCloseTo(
      15 + (15 - camera.x) * k + 100,
      3,
    );
    expect(uniforms.uHoleCenter[1]).toBeCloseTo(5 + (5 - camera.y) * k + 50, 3);
    expect(uniforms.uHoleParams[2]).toBeCloseTo(seeThrough.minAlpha, 2);
  });

  // ниже HOLE_EPSILON дыра неотличима от её отсутствия: слой не платит за
  // проход, которого не видно
  it('затухшая дыра снимает фильтр с цели', () => {
    const hole = createHole();
    const object = target();
    const view = { x: 0, y: 0, z: 0 };

    open(hole, view, object);

    for (let i = 0; i < 200; i += 1) {
      advance(hole, false, 0.2);
      apply(object, hole, seeThrough, view, stage(), { x: 0, y: 0 });
    }

    expect(object.filters).toHaveLength(0);
    expect(hole.attached).toBe(false);
    // программа шейдера остаётся: дыра открывается и закрывается каждый бой
    expect(hole.filter).not.toBe(null);
  });

  it('dispose снимает фильтр и отдаёт его программу', () => {
    const hole = createHole();
    const object = target();

    open(hole, { x: 0, y: 0, z: 0 }, object);
    dispose(hole, object);

    expect(object.filters).toHaveLength(0);
    expect(hole.attached).toBe(false);
    expect(hole.filter).toBe(null);
  });
});
