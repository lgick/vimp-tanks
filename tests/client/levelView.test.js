import { describe, it, expect } from 'vitest';
import { createLevelView } from '../../src/client/levelView.js';
import { seeThroughAlpha } from '../../src/client/seeThrough.js';
import { seeThrough, parallax } from '../../src/config/render.js';

// Сервис levelView: дыра в плите и alpha точечных сущностей обязаны
// считаться в ОДНОЙ системе координат — в нарисованной. Плита центрирует
// дыру по смещённой точке игрока (Map._applyHole), поэтому и расстояние до
// ящика на ней берётся между смещёнными точками, иначе круг прозрачности
// расходится с нарисованной дырой тем сильнее, чем дальше игрок от центра
// экрана и чем выше сущность.
describe('levelView: проекция 2.5D в формуле прозрачности', () => {
  // центр камеры в начале координат: смещение точки становится просто
  // умножением на (1 + k)
  const camera = { x: 0, y: 0, scaleX: 1, scaleY: 1 };
  const shear = parallax.shear;

  // та же формула, что у offsetPoint и у вершин клина
  const drawn = (x, y, k) => ({
    x: x + (x - camera.x) * k,
    y: y + (y - camera.y) * k,
  });

  // игрок под мостом, в стороне от центра камеры
  const playerX = 1000;
  const makeView = () => {
    const view = createLevelView(seeThrough);

    view.set(0, playerX, 0, 0);

    return view;
  };

  it('край дыры считается по нарисованным точкам, а не по мировым', () => {
    const view = makeView();

    view.setCamera(camera);

    // ящик стоит на плите уровня 1: нарисован он смещённым, и ровно на
    // границе дыры — прозрачности быть не должно
    const boxX = (playerX + seeThrough.radius) / (1 + shear);

    expect(view.alphaFor(1, boxX, 0)).toBeCloseTo(1, 5);

    // по сырым мировым точкам тот же ящик оказался бы почти в центре дыры
    const rawDistance = boxX - playerX;

    expect(rawDistance).toBeLessThan(
      seeThrough.radius * (1 - seeThrough.softness),
    );
  });

  it('alpha сущности совпадает с формулой фильтра плиты в той же точке', () => {
    const view = makeView();

    view.setCamera(camera);

    const entityX = 900;
    const entityY = 120;
    const point = drawn(entityX, entityY, shear);
    const player = drawn(playerX, 0, 0);

    expect(view.alphaFor(1, entityX, entityY)).toBeCloseTo(
      seeThroughAlpha({
        viewLevel: 0,
        viewX: player.x,
        viewY: player.y,
        level: 1,
        x: point.x,
        y: point.y,
        cfg: seeThrough,
      }),
      5,
    );
  });

  it('высота игрока тоже проецируется: на рампе дыра едет вместе с ним', () => {
    const view = createLevelView(seeThrough);

    // игрок уровня 0 поднялся по рампе на половину уровня
    view.set(0, playerX, 0, 0.5);
    view.setCamera(camera);

    const player = drawn(playerX, 0, 0.5 * shear);
    const entityX = 900;
    const point = drawn(entityX, 0, shear);

    expect(view.alphaFor(1, entityX, 0)).toBeCloseTo(
      seeThroughAlpha({
        viewLevel: 0,
        viewX: player.x,
        viewY: player.y,
        level: 1,
        x: point.x,
        y: point.y,
        cfg: seeThrough,
      }),
      5,
    );
  });

  it('своя высота сущности важнее её уровня', () => {
    const view = makeView();

    view.setCamera(camera);

    // дым над плитой уровня 1 нарисован выше самой плиты
    expect(view.alphaFor(1, 900, 0, 1.5)).not.toBeCloseTo(
      view.alphaFor(1, 900, 0),
      5,
    );
  });

  it('без камеры (до первого кадра) точки остаются мировыми', () => {
    const view = makeView();

    expect(view.alphaFor(1, 900, 0)).toBeCloseTo(
      seeThroughAlpha({
        viewLevel: 0,
        viewX: playerX,
        viewY: 0,
        level: 1,
        x: 900,
        y: 0,
        cfg: seeThrough,
      }),
      5,
    );
  });
});
