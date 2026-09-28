// Высота поверхности рампы в мировой точке, в уровнях.
//
// `runs` — прогоны рамп ядра в МИРОВЫХ единицах (`core.ramp_runs()`, сервис
// `rampRuns`): `{ axis, sign, from, to, min, max, crossMin, crossMax }`.
// Высота — `lerp(from, to, progress)`, прогресс — доля пути вдоль оси от
// подножия. Это та же формула, по которой ядро ведёт z танка
// (`MapLevels::ramp_at` движка) и строятся вершины клина
// (`extrusion.js`, `buildRampMeshes`); близнец освещения на полосах в
// клетках — `lightMath.rampHeight`.
//
// Прогон учитывается, только если `level` лежит между его подножием и
// вершиной: пол террасы ПОД горкой уровнем выше рампой не накрыт.
// null — точка не на рампе этого уровня
export function rampSurfaceAt(runs, level, x, y) {
  if (!Array.isArray(runs)) {
    return null;
  }

  for (const run of runs) {
    const low = Math.min(run.from, run.to);
    const high = Math.max(run.from, run.to);

    if (level < low || level > high) {
      continue;
    }

    const along = run.axis === 0 ? x : y;
    const cross = run.axis === 0 ? y : x;

    if (
      along < run.min ||
      along > run.max ||
      cross < run.crossMin ||
      cross > run.crossMax
    ) {
      continue;
    }

    const span = run.max - run.min;
    const t = span > 0 ? (along - run.min) / span : 0;
    const progress = run.sign > 0 ? t : 1 - t;

    return run.from + (run.to - run.from) * progress;
  }

  return null;
}
