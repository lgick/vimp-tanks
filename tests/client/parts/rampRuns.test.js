import { describe, it, expect } from 'vitest';
import { buildRampRuns } from '../../../src/client/parts/rampRuns.js';

// Прогоны рампы. Обход обязан совпадать с ядром
// движка (`MapLevels::build_runs`): линия тайлов вдоль оси рампы в одной
// строке или колонке, первая объявленная рампа забирает клетку.
//
// «Верх» у прогонов разных направлений — разная сторона прямоугольника,
// поэтому все четыре направления проверяются поимённо: перепутанный знак
// нарисовал бы клин задом наперёд и никакого исключения не бросил.

const STEP = 10;

// одна горизонтальная линия тайла 7 в строке 1, колонки 1..4
const rowMap = [
  [0, 0, 0, 0, 0],
  [0, 7, 7, 7, 7],
  [0, 0, 0, 0, 0],
];

// одна вертикальная линия тайла 7 в колонке 2, строки 0..2
const colMap = [
  [0, 0, 7],
  [0, 0, 7],
  [0, 0, 7],
];

describe('buildRampRuns: обход грида', () => {
  it('линия по оси x становится одним прогоном', () => {
    const runs = buildRampRuns(rowMap, [
      { tile: 7, dir: 'east', from: 0, to: 1 },
    ]);

    expect(runs).toEqual([
      { axis: 0, sign: 1, rise: 1, col0: 1, col1: 5, row0: 1, row1: 2 },
    ]);
  });

  it('линия по оси y становится одним прогоном', () => {
    const runs = buildRampRuns(colMap, [
      { tile: 7, dir: 'south', from: 0, to: 1 },
    ]);

    expect(runs).toEqual([
      { axis: 1, sign: 1, rise: 1, col0: 2, col1: 3, row0: 0, row1: 3 },
    ]);
  });

  it('разрыв в линии делит её на два прогона', () => {
    const runs = buildRampRuns(
      [[7, 7, 0, 7]],
      [{ tile: 7, dir: 'east', from: 0, to: 1 }],
    );

    expect(runs).toHaveLength(2);
    expect(runs[0].col0).toBe(0);
    expect(runs[0].col1).toBe(2);
    expect(runs[1].col0).toBe(3);
    expect(runs[1].col1).toBe(4);
  });

  it('клетку забирает первая объявленная рампа', () => {
    const runs = buildRampRuns(
      [[7, 7]],
      [
        { tile: 7, dir: 'east', from: 0, to: 1 },
        { tile: 7, dir: 'west', from: 0, to: 1 },
      ],
    );

    expect(runs).toHaveLength(1);
    expect(runs[0].sign).toBe(1);
  });

  it('перепад в несколько уровней доезжает до прогона', () => {
    const runs = buildRampRuns(rowMap, [
      { tile: 7, dir: 'east', from: 0, to: 2 },
    ]);

    expect(runs[0].rise).toBe(2);
  });

  it('спуск (to <= from) прогоном не становится', () => {
    expect(
      buildRampRuns(rowMap, [{ tile: 7, dir: 'east', from: 1, to: 1 }]),
    ).toEqual([]);
  });
});

describe('buildRampRuns: широкая горка', () => {
  // блок 3 × 3 тайла рампы: ядро режет его на три полосы, клин обязан
  // получить ОДИН прогон во всю ширину — иначе на границах полос встанут
  // юбки, то есть перегородки, которых в физике нет
  const wideMap = [
    [0, 0, 0, 0, 0],
    [0, 7, 7, 7, 0],
    [0, 7, 7, 7, 0],
    [0, 7, 7, 7, 0],
  ];

  it('блок одинаковых полос склеивается в один прогон', () => {
    const runs = buildRampRuns(wideMap, [
      { tile: 7, dir: 'east', from: 0, to: 1 },
    ]);

    expect(runs).toEqual([
      { axis: 0, sign: 1, rise: 1, col0: 1, col1: 4, row0: 1, row1: 4 },
    ]);
  });

  it('блок по оси y склеивается поперёк, по колонкам', () => {
    const runs = buildRampRuns(wideMap, [
      { tile: 7, dir: 'south', from: 0, to: 1 },
    ]);

    expect(runs).toEqual([
      { axis: 1, sign: 1, rise: 1, col0: 1, col1: 4, row0: 1, row1: 4 },
    ]);
  });

  it('ступенчатый край оставляет полосы разными прогонами', () => {
    const runs = buildRampRuns(
      [
        [7, 7, 7],
        [7, 7, 0],
        [7, 7, 7],
      ],
      [{ tile: 7, dir: 'east', from: 0, to: 1 }],
    );

    expect(runs).toHaveLength(3);
    // две длинные полосы одинаковы, но не смежны — между ними лежит
    // короткая, поэтому склеивать нечего
    expect(runs.map(run => [run.col0, run.col1, run.row0, run.row1])).toEqual([
      [0, 3, 0, 1],
      [0, 3, 2, 3],
      [0, 2, 1, 2],
    ]);
  });
});
