import { describe, it, expect } from 'vitest';
import { Container } from 'pixi.js';
import { offsetPoint, applyParallax } from '../../src/client/parallax.js';

// Проекция 2.5D живёт в одном модуле именно потому, что её потребители
// разные: слой карты и его объём двигаются трансформом контейнера, а танк,
// центр «дыры» и тень — точкой. Обе формы обязаны давать одну и ту же
// мировую точку, иначе танк съедет с плиты, на которой стоит.

const camera = { x: 400, y: 300 };

// мировая точка содержимого контейнера после его трансформа
const worldOf = (target, localX, localY) => ({
  x: localX * target.scale.x + target.position.x,
  y: localY * target.scale.y + target.position.y,
});

describe('parallax: точка и контейнер дают одну проекцию', () => {
  it('трансформ контейнера повторяет точечную формулу', () => {
    const target = new Container();
    const baseScale = 0.4;
    const k = 2 * 0.22;

    applyParallax(target, camera, k, baseScale);

    // содержимое слоя авторится в НЕмасштабированных единицах карты
    for (const [localX, localY] of [
      [0, 0],
      [100, 40],
      [-250, 900],
    ]) {
      const point = offsetPoint(
        localX * baseScale,
        localY * baseScale,
        camera,
        k,
      );
      const world = worldOf(target, localX, localY);

      expect(world.x).toBeCloseTo(point.x, 6);
      expect(world.y).toBeCloseTo(point.y, 6);
    }
  });

  it('сущность в мировых координатах (baseScale = 1) — тот же результат', () => {
    const target = new Container();
    const k = 0.5 * 0.22;

    applyParallax(target, camera, k);

    const point = offsetPoint(120, 700, camera, k);
    const world = worldOf(target, 120, 700);

    expect(world.x).toBeCloseTo(point.x, 6);
    expect(world.y).toBeCloseTo(point.y, 6);
  });

  it('сдвиг растёт с высотой и с расстоянием до центра камеры', () => {
    const near = offsetPoint(410, 300, camera, 0.22);
    const far = offsetPoint(100, 300, camera, 0.22);
    const higher = offsetPoint(100, 300, camera, 0.44);

    expect(Math.abs(near.x - 410)).toBeLessThan(Math.abs(far.x - 100));
    expect(Math.abs(higher.x - 100)).toBeGreaterThan(Math.abs(far.x - 100));
  });
});

describe('parallax: нулевая высота ничего не меняет', () => {
  it('k = 0 оставляет точку на месте', () => {
    expect(offsetPoint(120, 700, camera, 0)).toEqual({ x: 120, y: 700 });
  });

  it('точка без камеры (парт ещё не на сцене) не смещается', () => {
    expect(offsetPoint(120, 700, null, 0.44)).toEqual({ x: 120, y: 700 });
  });

  it('k = 0 оставляет контейнеру базовый масштаб и нулевую позицию', () => {
    const target = new Container();

    applyParallax(target, camera, 0, 0.4);

    expect(target.scale.x).toBeCloseTo(0.4, 6);
    expect(target.scale.y).toBeCloseTo(0.4, 6);
    expect(target.position.x).toBe(0);
    expect(target.position.y).toBe(0);
  });

  it('контейнер без камеры остаётся в базовом масштабе', () => {
    const target = new Container();

    applyParallax(target, null, 0.44, { x: 0.4, y: 0.4 });

    expect(target.scale.x).toBeCloseTo(0.4, 6);
    expect(target.position.x).toBe(0);
  });
});
