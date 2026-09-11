// Полосы рамп для КАРТИНКИ клина: прогоны ядра, переведённые в клетки
// грида слоя и склеенные поперёк.
//
// Сами прогоны здесь НЕ строятся. Их строит ядро (`MapLevels::build_runs`,
// packages/engine/core/src/map.rs) — та же геометрия, по которой физика
// ставит стражей прогона, — и отдаёт клиенту сервисом `rampRuns`
// (src/client/index.js). Второй обход грида на JS жил здесь до этапа 3
// плана review-multilevel-3 и расходился бы с ядром молча: горка, которую
// видно и нельзя проехать (или наоборот).
//
// Остаётся одно намеренное расхождение с ядром — ШИРИНА. Полосы одной
// широкой горки здесь склеиваются в одну. Ядру полосы нужны раздельными
// (вердикт гейта судится на полосу, `core/src/level.rs`), а клину — нет:
// между полосами нет ни стенки, ни ступеньки, и юбки на их границах
// нарисовали бы перегородки, которых в физике не существует.

// Прогоны ядра → полосы в КЛЕТКАХ: `col0..col1` и `row0..row1` —
// полуинтервалы, `sign` — направление подъёма вдоль оси, `from`/`to` —
// уровни подножия и вершины (у нисходящей рампы `from > to`).
//
// `toCell(world, axis)` переводит мировую координату в клетку грида по
// своей оси (0 = x, 1 = y): масштаб карты живёт у парта, ядро считает
// в мировых единицах.
export function buildRampLanes(runs, toCell) {
  const lanes = [];

  if (!Array.isArray(runs)) {
    return lanes;
  }

  for (const run of runs) {
    const alongAxis = run.axis === 0 ? 0 : 1;
    const crossAxis = alongAxis === 0 ? 1 : 0;
    const along0 = toCell(run.min, alongAxis);
    const along1 = toCell(run.max, alongAxis);
    const cross0 = toCell(run.crossMin, crossAxis);
    const cross1 = toCell(run.crossMax, crossAxis);
    // границы БОРТОВ вдоль оси приходят из ядра
    // (`map::ramp_rail_span`): юбка клина обязана рисовать борта ровно
    // там, где физика ставит стражей. `null` — бортов нет вовсе (прогон
    // длиной в одну клетку)
    const hasRails =
      typeof run.railMin === 'number' && typeof run.railMax === 'number';

    lanes.push({
      axis: run.axis,
      sign: run.sign,
      from: run.from,
      to: run.to,
      block: run.block,
      rail0: hasRails ? toCell(run.railMin, alongAxis) : null,
      rail1: hasRails ? toCell(run.railMax, alongAxis) : null,
      col0: alongAxis === 0 ? along0 : cross0,
      col1: alongAxis === 0 ? along1 : cross1,
      row0: alongAxis === 0 ? cross0 : along0,
      row1: alongAxis === 0 ? cross1 : along1,
    });
  }

  return mergeLanes(lanes);
}

// Склейка полос одной широкой горки: полосы с одним номером БЛОКА,
// лежащие вплотную поперёк оси, становятся одной полосой во всю ширину
// блока. Номер блока даёт ядро (`push_run`, E map.rs): он уже означает
// «та же ось, знак, уровни и границы ВДОЛЬ оси», поэтому полосы разной
// длины (ступенчатый край блока) несут разные номера и остаются разными
// полосами — ровно тот же признак «одна горка», что у физики.
function mergeLanes(lanes) {
  const groups = new Map();

  for (const lane of lanes) {
    const group = groups.get(lane.block);

    if (group) {
      group.push(lane);
    } else {
      groups.set(lane.block, [lane]);
    }
  }

  const merged = [];

  for (const group of groups.values()) {
    // поперечная координата: колонка при оси y, строка при оси x
    const cross0 = lane => (lane.axis === 1 ? lane.col0 : lane.row0);
    const cross1 = lane => (lane.axis === 1 ? lane.col1 : lane.row1);

    group.sort((a, b) => cross0(a) - cross0(b));

    let current = null;

    for (const lane of group) {
      if (current && cross0(lane) === cross1(current)) {
        if (current.axis === 1) {
          current.col1 = lane.col1;
        } else {
          current.row1 = lane.row1;
        }

        continue;
      }

      current = { ...lane };
      merged.push(current);
    }
  }

  return merged;
}
