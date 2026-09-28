import { Ticker } from 'pixi.js';
import { createHoleFilter, setHoleUniforms } from '../../seeThrough.js';
import { offsetPoint } from '../../parallax.js';
import { parallax as parallaxConfig } from '../../../config/render.js';

// ниже этой силы дыра неотличима от её отсутствия: фильтр снимается совсем,
// чтобы слой не платил за проход, которого не видно
const HOLE_EPSILON = 0.01;

// «Дыра» вокруг игрока: состояние и его применение к одной цели. Слой и его
// перекрыватель считают дыру ОДНИМ кодом, но своими экземплярами состояния —
// у Pixi фильтр несёт свои uniform'ы, одним на две цели не обойтись.
export function createHole() {
  // `tick` — тик, на котором сила дыры уже двигалась: за один тик полотно
  // рисуется несколько раз, а сглаживание по времени обязано шагать один
  // раз (см. `tickRate`)
  return { strength: 0, filter: null, attached: false, tick: null };
}

// Шаг сглаживания дыры за эту отрисовку: доля перехода за время тика,
// но РОВНО раз на тик общего тикера. За тик полотно может рисоваться не
// раз, а `deltaMS` у всех отрисовок тика один: без отсечки дыра гасла бы
// тем быстрее, чем больше отрисовок пришло в тик. Повторные отрисовки
// того же тика получают 0 — сила остаётся, применение идёт каждый раз
export function tickRate(hole, fadeRate) {
  const tick = Ticker.shared.lastTime;

  if (hole.tick === tick) {
    return 0;
  }

  hole.tick = tick;

  return Math.min(1, fadeRate * (Ticker.shared.deltaMS / 1000));
}

// сила дыры тянется к желаемой (0 — игрок не под слоем) с шагом тикера:
// дыра открывается не рывком
export function advance(hole, wanted, rate) {
  hole.strength += ((wanted ? 1 : 0) - hole.strength) * rate;

  return hole.strength;
}

// alpha слоя в центре дыры силы `hole.strength`: `minAlpha` у открытой
// дыры, 1 — без неё. Её получает шейдер дыры (`apply`) и вывески крыши
// (`MapLayer._roofAlpha`) — вывеска гаснет вместе с центром дыры
export function holeCenterAlpha(hole, cfg) {
  return 1 + (cfg.minAlpha - 1) * hole.strength;
}

// внутри слоя нужна не одна alpha, а поле по пикселям, поэтому единственный
// способ — фильтр. Центр приходит в пикселях кадра фильтра, то есть в
// экранных: мировая точка умножается на трансформ сцены (камера — он и есть,
// см. src/client/camera.js)
export function apply(target, hole, cfg, view, stage, camera) {
  if (hole.strength < HOLE_EPSILON || !stage) {
    if (hole.attached) {
      target.filters = [];
      hole.attached = false;
    }

    return;
  }

  if (!hole.filter) {
    hole.filter = createHoleFilter(cfg);
  }

  if (!hole.attached) {
    target.filters = [hole.filter];
    hole.attached = true;
  }

  // игрок под мостом нарисован не в своей мировой точке, а смещённым на
  // собственную высоту (Tank), — и слой над ним смещён тоже. Центр дыры
  // обязан ехать по той же проекции, иначе она уползает от танка тем
  // сильнее, чем дальше он от центра экрана
  const point = offsetPoint(
    view.x,
    view.y,
    camera,
    view.z * parallaxConfig.shear,
  );

  setHoleUniforms(hole.filter, {
    centerX: point.x * stage.scale.x + stage.position.x,
    centerY: point.y * stage.scale.y + stage.position.y,
    radius: cfg.radius * stage.scale.x,
    softness: cfg.softness,
    // дыра открывается не рывком: сила перехода живёт в минимальной alpha
    minAlpha: holeCenterAlpha(hole, cfg),
  });
}

// снять фильтр с цели и отдать программу шейдера: зовётся из destroy
export function dispose(hole, target) {
  if (!hole.filter) {
    hole.attached = false;

    return;
  }

  target.filters = [];
  hole.attached = false;
  hole.filter.destroy();
  hole.filter = null;
}
