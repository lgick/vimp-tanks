import { describe, it, expect, vi, beforeEach } from 'vitest';

// шпион на обход лучей: короткий путь его не зовёт
vi.mock(
  '../../../src/client/lighting/lightGeometry.js',
  async importOriginal => {
    const actual = await importOriginal();

    return { ...actual, coneFan: vi.fn(actual.coneFan) };
  },
);

import { coneFan } from '../../../src/client/lighting/lightGeometry.js';
import { createOcclusion } from '../../../src/client/lighting/occlusion.js';

const STEP = 32;
const cfg = {
  headlights: {
    occlusion: { enabled: true, rays: 16 },
    wash: { height: 0.6, intensity: 1 },
  },
};
// раскладка текстуры конуса для `frameOf`: длина 100, полуширина 25, отступ 20
const asset = {
  texture: { width: 140, height: 60 },
  length: 100,
  halfWidth: 25,
  margin: 20,
};
const light = () => ({
  kind: 'cone',
  level: 0,
  x: 40,
  y: 48,
  z: 0,
  radius: 90,
  spread: 0.5,
  rotation: 0,
});
// столбец клеток `col` — стена уровня 0
const column = col => Array.from({ length: 20 }, (_, row) => [col, row]);

const setup = ({ walls = [], lanes = [] } = {}) => {
  const map = {
    step: STEP,
    scale: { x: 1, y: 1 },
    cellW: STEP,
    cellH: STEP,
    cols: 20,
    rows: 20,
    blockers: new Map(),
    rampCells: new Map(),
  };
  const occlusion = createOcclusion({ getMap: () => map, cfg });

  // вклады объёмов — в формате `volumes.levels()`
  occlusion.sync(
    new Map([[0, [{ cells: walls, volume: 1 }]]]),
    new Map(lanes.length ? [[0, new Map([['ramps', lanes]])]] : []),
  );

  return occlusion;
};

beforeEach(() => {
  coneFan.mockClear();
});

describe('occlusion: короткий путь без препятствий рядом', () => {
  it('стена далеко — лучи не пускаются', () => {
    // стена в x 480..512, AABB прямоугольника конуса с запасом — колонки −1..5
    const occlusion = setup({ walls: column(15) });
    const result = occlusion.occlusionOf(light(), asset);

    expect(coneFan).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      shape: null,
      hit: null,
      wash: null,
      fan: null,
    });
  });

  it('стена рядом — лучи пускаются, ось упирается в стену', () => {
    // стена в x 96..128
    const occlusion = setup({ walls: column(3) });
    const result = occlusion.occlusionOf(light(), asset);

    expect(coneFan).toHaveBeenCalledTimes(1);
    expect(result.fan).not.toBeNull();
    expect(result.fan).toHaveProperty('points');
    expect(result.fan).toHaveProperty('closed');
    expect(result.fan).toHaveProperty('frame');
    expect(result.hit.x).toBeCloseTo(96);
    expect(result.hit.y).toBeCloseTo(48);
  });

  it('рампа рядом без стен — лучи пускаются', () => {
    const occlusion = setup({
      lanes: [
        {
          axis: 0,
          sign: 1,
          from: 0,
          to: 1,
          col0: 3,
          col1: 6,
          row0: 1,
          row1: 2,
        },
      ],
    });

    occlusion.occlusionOf(light(), asset);

    expect(coneFan).toHaveBeenCalled();
  });

  it('кеш: тот же источник не пускает лучи повторно, сдвиг — пускает', () => {
    const occlusion = setup({ walls: column(3) });
    const source = light();
    const first = occlusion.occlusionOf(source, asset);
    const second = occlusion.occlusionOf(source, asset);

    expect(coneFan).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);

    source.x += 1;
    occlusion.occlusionOf(source, asset);

    expect(coneFan).toHaveBeenCalledTimes(2);
  });

  it('кеш короткого пути: тот же результат без лучей', () => {
    const occlusion = setup({ walls: column(15) });
    const source = light();
    const first = occlusion.occlusionOf(source, asset);
    const second = occlusion.occlusionOf(source, asset);

    expect(second).toBe(first);
    expect(coneFan).not.toHaveBeenCalled();
  });
});
