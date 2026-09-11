import { describe, it, expect } from 'vitest';
import { buildRampLanes } from '../../../src/client/parts/rampLanes.js';

// Полосы рампы для клина. Обхода грида здесь больше нет — прогоны строит
// ядро (`MapLevels::build_runs`) и отдаёт их сервисом `rampRuns` в
// МИРОВЫХ единицах. Проверяется ровно то, что осталось на JS: перевод в
// клетки грида слоя и склейка полос одной горки по номеру БЛОКА.

const STEP = 10;
const SCALE = 2;
// мировая единица = клетка * step * scale, как `tile_size` в ядре
const world = cell => cell * STEP * SCALE;
const toCell = value => Math.round(value / SCALE / STEP);

// прогон ядра в мировых единицах. Границы бортов (`railMin`/`railMax`)
// ядро считает само (`map::ramp_rail_span`): по умолчанию борт начинается
// на клетку дальше подножия, `null` — бортов у прогона нет вовсе
const run = ({
  axis = 0,
  sign = 1,
  from = 0,
  to = 1,
  block = 0,
  min,
  max,
  crossMin,
  crossMax,
  railMin = sign > 0 ? min + 1 : min,
  railMax = sign > 0 ? max : max - 1,
}) => ({
  axis,
  sign,
  from,
  to,
  block,
  min: world(min),
  max: world(max),
  crossMin: world(crossMin),
  crossMax: world(crossMax),
  railMin: railMin === null ? null : world(railMin),
  railMax: railMax === null ? null : world(railMax),
});

describe('buildRampLanes: перевод в клетки', () => {
  it('прогон по оси x ложится в колонки, поперёк — в строки', () => {
    const lanes = buildRampLanes(
      [run({ axis: 0, min: 1, max: 5, crossMin: 1, crossMax: 2 })],
      toCell,
    );

    expect(lanes).toEqual([
      {
        axis: 0,
        sign: 1,
        from: 0,
        to: 1,
        block: 0,
        rail0: 2,
        rail1: 5,
        col0: 1,
        col1: 5,
        row0: 1,
        row1: 2,
      },
    ]);
  });

  it('прогон по оси y ложится в строки, поперёк — в колонки', () => {
    const lanes = buildRampLanes(
      [run({ axis: 1, min: 0, max: 3, crossMin: 2, crossMax: 3 })],
      toCell,
    );

    expect(lanes).toEqual([
      {
        axis: 1,
        sign: 1,
        from: 0,
        to: 1,
        block: 0,
        rail0: 1,
        rail1: 3,
        col0: 2,
        col1: 3,
        row0: 0,
        row1: 3,
      },
    ]);
  });

  it('масштаб карты берётся по оси координаты', () => {
    const axes = [];
    const lanes = buildRampLanes(
      [run({ axis: 0, min: 1, max: 2, crossMin: 3, crossMax: 4 })],
      (value, axis) => {
        axes.push(axis);

        return toCell(value);
      },
    );

    // вдоль оси x — ось 0, поперёк неё — ось 1, борта снова вдоль
    expect(axes).toEqual([0, 0, 1, 1, 0, 0]);
    expect(lanes[0].col0).toBe(1);
    expect(lanes[0].row0).toBe(3);
  });

  it('нисходящая рампа доезжает до полос как есть', () => {
    const lanes = buildRampLanes(
      [
        run({
          axis: 0,
          sign: -1,
          from: 1,
          to: 0,
          min: 0,
          max: 2,
          crossMin: 0,
          crossMax: 1,
        }),
      ],
      toCell,
    );

    expect(lanes[0].from).toBe(1);
    expect(lanes[0].to).toBe(0);
    expect(lanes[0].sign).toBe(-1);
  });

  it('прогон без бортов доезжает до полос с пустыми границами', () => {
    const lanes = buildRampLanes(
      [
        run({
          axis: 0,
          min: 1,
          max: 2,
          crossMin: 1,
          crossMax: 2,
          railMin: null,
          railMax: null,
        }),
      ],
      toCell,
    );

    expect(lanes[0].rail0).toBe(null);
    expect(lanes[0].rail1).toBe(null);
  });

  it('не массив — пустой список', () => {
    expect(buildRampLanes(null, toCell)).toEqual([]);
    expect(buildRampLanes(undefined, toCell)).toEqual([]);
  });
});

describe('buildRampLanes: склейка полос блока', () => {
  it('смежные полосы одного блока становятся одной', () => {
    const lanes = buildRampLanes(
      [
        run({ axis: 0, block: 4, min: 1, max: 4, crossMin: 1, crossMax: 2 }),
        run({ axis: 0, block: 4, min: 1, max: 4, crossMin: 2, crossMax: 3 }),
        run({ axis: 0, block: 4, min: 1, max: 4, crossMin: 3, crossMax: 4 }),
      ],
      toCell,
    );

    expect(lanes).toHaveLength(1);
    expect(lanes[0].row0).toBe(1);
    expect(lanes[0].row1).toBe(4);
    expect(lanes[0].col0).toBe(1);
    expect(lanes[0].col1).toBe(4);
  });

  it('полосы разных блоков не склеиваются', () => {
    const lanes = buildRampLanes(
      [
        run({ axis: 0, block: 0, min: 1, max: 4, crossMin: 1, crossMax: 2 }),
        run({ axis: 0, block: 1, min: 1, max: 3, crossMin: 2, crossMax: 3 }),
      ],
      toCell,
    );

    expect(lanes).toHaveLength(2);
    expect(lanes[0].row1).toBe(2);
    expect(lanes[1].row0).toBe(2);
  });

  it('разрыв поперёк оси внутри блока оставляет две полосы', () => {
    const lanes = buildRampLanes(
      [
        run({ axis: 0, block: 2, min: 0, max: 2, crossMin: 0, crossMax: 1 }),
        run({ axis: 0, block: 2, min: 0, max: 2, crossMin: 2, crossMax: 3 }),
      ],
      toCell,
    );

    expect(lanes).toHaveLength(2);
    expect(lanes[0].row0).toBe(0);
    expect(lanes[1].row0).toBe(2);
  });

  it('склейка по оси y идёт по колонкам', () => {
    const lanes = buildRampLanes(
      [
        run({ axis: 1, block: 1, min: 0, max: 3, crossMin: 0, crossMax: 1 }),
        run({ axis: 1, block: 1, min: 0, max: 3, crossMin: 1, crossMax: 2 }),
      ],
      toCell,
    );

    expect(lanes).toHaveLength(1);
    expect(lanes[0].col0).toBe(0);
    expect(lanes[0].col1).toBe(2);
    expect(lanes[0].row1).toBe(3);
  });
});
