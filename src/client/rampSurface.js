// учитывается ли прогон для уровня `level`: уровень между подножием и
// вершиной (пол террасы под горкой уровнем выше рампой не накрыт)
const coversLevel = (run, level) =>
  level >= Math.min(run.from, run.to) && level <= Math.max(run.from, run.to);

// высота склона прогона на координате `along` вдоль его оси, в уровнях
const runHeight = (run, along) => {
  const span = run.max - run.min;
  const t = span > 0 ? (along - run.min) / span : 0;
  const progress = run.sign > 0 ? t : 1 - t;

  return run.from + (run.to - run.from) * progress;
};

// лежит ли мировая точка в прямоугольнике прогона (границы включительно)
const contains = (run, x, y) => {
  const along = run.axis === 0 ? x : y;
  const cross = run.axis === 0 ? y : x;

  return (
    along >= run.min &&
    along <= run.max &&
    cross >= run.crossMin &&
    cross <= run.crossMax
  );
};

// Высота поверхности рампы в мировой точке, в уровнях.
//
// `runs` — прогоны рамп ядра в МИРОВЫХ единицах (`core.ramp_runs()`, сервис
// `rampRuns`): `{ axis, sign, from, to, min, max, crossMin, crossMax }`.
// Высота — `lerp(from, to, progress)`, прогресс — доля пути вдоль оси от
// подножия. Это та же формула, по которой ядро ведёт z танка
// (`MapLevels::ramp_at` движка) и строятся вершины клина
// (`extrusion.js`, `buildRampMeshes`); близнец освещения на полосах в
// клетках — `lightGeometry.rampHeight`.
//
// Прогон учитывается, только если `level` лежит между его подножием и
// вершиной: пол террасы ПОД горкой уровнем выше рампой не накрыт.
// null — точка не на рампе этого уровня
export function rampSurfaceAt(runs, level, x, y) {
  const run = rampRunAt(runs, level, x, y);

  return run ? runHeight(run, run.axis === 0 ? x : y) : null;
}

// прогон уровня `level` под мировой точкой (границы включительно); null — нет
export function rampRunAt(runs, level, x, y) {
  if (!Array.isArray(runs)) {
    return null;
  }

  return (
    runs.find(run => coversLevel(run, level) && contains(run, x, y)) ?? null
  );
}

// Склон под точкой: `{ height, axis }` — высота в уровнях и ось прогона
// (0 = x, 1 = y; линия равной высоты ей перпендикулярна); null — не рампа
export function rampSlopeAt(runs, level, x, y) {
  const run = rampRunAt(runs, level, x, y);

  return run
    ? { height: runHeight(run, run.axis === 0 ? x : y), axis: run.axis }
    : null;
}

// Грань насыпи, на которой лежит конец луча `(x, y)` с направлением
// `(dx, dy)`: `{ face: { axis: 'x' | 'y', coord, nx, ny }, volume }` — в
// формате `edgeFace` (src/client/wallFace.js) и высота верха грани над
// уровнем в этой точке. Учитываются прогоны с НИЖНИМ уровнем `level`
// (как у насыпи в ядре), конец — на ребре прямоугольника прогона в
// допуске `tolerance`, и чуть дальше по лучу — внутри прогона (луч
// входит в насыпь). null — не грань
export function rampFaceAt(runs, level, x, y, dx, dy, tolerance) {
  if (!Array.isArray(runs)) {
    return null;
  }

  const delta = 2 * tolerance;
  const aheadX = x + dx * delta;
  const aheadY = y + dy * delta;

  for (const run of runs) {
    if (
      Math.min(run.from, run.to) !== level ||
      !contains(run, aheadX, aheadY)
    ) {
      continue;
    }

    const alongX = run.axis === 0;
    const along = alongX ? x : y;
    const cross = alongX ? y : x;
    const dAlong = alongX ? dx : dy;
    const dCross = alongX ? dy : dx;
    // рёбра: вдоль оси — торцы, поперёк — борта
    const edges = [
      { coord: run.min, dist: Math.abs(along - run.min), end: true, d: dAlong },
      { coord: run.max, dist: Math.abs(along - run.max), end: true, d: dAlong },
      {
        coord: run.crossMin,
        dist: Math.abs(cross - run.crossMin),
        end: false,
        d: dCross,
      },
      {
        coord: run.crossMax,
        dist: Math.abs(cross - run.crossMax),
        end: false,
        d: dCross,
      },
    ].filter(edge => edge.dist <= tolerance && Math.abs(edge.d) > 1e-9);

    if (edges.length === 0) {
      continue;
    }

    const edge = edges.reduce((a, b) => (b.dist < a.dist ? b : a));
    // торец прогона по x — линия x = coord (ось грани 'x'), борт — 'y'
    const axis = edge.end === alongX ? 'x' : 'y';
    // нормаль навстречу лучу, как в `edgeFace`
    const normal = edge.d > 0 ? -1 : 1;

    return {
      face: {
        axis,
        coord: edge.coord,
        nx: axis === 'x' ? normal : 0,
        ny: axis === 'y' ? normal : 0,
      },
      volume: runHeight(run, alongX ? aheadX : aheadY) - level,
    };
  }

  return null;
}
