import { describe, it, expect, vi, beforeEach } from 'vitest';

// шпион на сборку меша клина: кеш `rampMeshes` не зовёт её повторно
vi.mock('../../../src/client/lighting/lightGeometry.js', async importOriginal => {
  const actual = await importOriginal();

  return { ...actual, rampLight: vi.fn(actual.rampLight) };
});

import { rampLight } from '../../../src/client/lighting/lightGeometry.js';
import { createRampLights } from '../../../src/client/lighting/rampLights.js';

const CELL = 10;
// полоса x 20..60, y 0..30, подъём по +x (как в lightGeometry.test.js)
const lane = {
  axis: 0,
  sign: 1,
  from: 0,
  to: 1,
  col0: 2,
  col1: 6,
  row0: 0,
  row1: 3,
};
// та же полоса далеко: x 500..540 — свет её не задевает
const far = { ...lane, col0: 50, col1: 54 };

// текстуры сервиса: `frameOf` берёт размер текстуры и раскладку пятна
const makeTextures = () => ({
  radial: { texture: { width: 68, height: 68 }, contentSize: 64 },
  cone: {
    texture: { width: 136, height: 136 },
    length: 128,
    halfWidth: 64,
    margin: 4,
  },
});
// фонарь в (40, 15) радиусом 30: прямоугольник текстуры ≈ x 8..72,
// y −17..47 — накрывает полосу `lane` целиком
const lamp = () => ({ kind: 'radial', x: 40, y: 15, radius: 30, rotation: 0 });
const item = (extra = {}) => ({ texture: 'tex', color: 0xffcc88, ...extra });

const setup = (levels = new Map()) => {
  const map = { cellW: CELL, cellH: CELL, levels };
  const textures = makeTextures();
  const rampLights = createRampLights({ getMap: () => map, textures });

  return { rampLights, textures };
};

beforeEach(() => {
  rampLight.mockClear();
});

describe('rampLights: свет на клиньях рамп', () => {
  it('без полос — ничего', () => {
    const { rampLights } = setup();
    const target = new Map();

    // полос нет вовсе или список пуст
    for (const lanes of [undefined, []]) {
      expect(rampLights.push(target, 0, lanes, lamp(), item(), 1)).toBe(false);
    }

    expect(target.size).toBe(0);
    expect(rampLight).not.toHaveBeenCalled();
  });

  it('свет задел клин — элемент в карту подножия', () => {
    const { rampLights } = setup();
    const target = new Map();

    expect(rampLights.push(target, 0, [lane], lamp(), item(), 0.5)).toBe(true);
    expect(target.get(0)).toHaveLength(1);

    const [entry] = target.get(0);

    expect(entry).toMatchObject({
      texture: 'tex',
      color: 0xffcc88,
      alpha: 0.5,
    });
    expect(entry.ramp).not.toBeNull();
    expect(rampLight).toHaveBeenCalledTimes(1);
    // прямоугольник текстуры замкнут
    expect(rampLight.mock.calls[0][0]).toMatchObject({
      lane,
      cellW: CELL,
      cellH: CELL,
      closed: true,
    });
  });

  it('кеш: стоящий источник не пересобирает меш, сдвиг — пересобирает', () => {
    const { rampLights } = setup();
    const source = lamp();
    const first = new Map();
    const second = new Map();
    const moved = new Map();

    rampLights.push(first, 0, [lane], source, item(), 1);
    rampLights.push(second, 0, [lane], source, item(), 1);

    expect(rampLight).toHaveBeenCalledTimes(1);
    expect(second.get(0)[0].ramp).toBe(first.get(0)[0].ramp);

    source.x += 5;
    rampLights.push(moved, 0, [lane], source, item(), 1);

    expect(rampLight).toHaveBeenCalledTimes(2);
    expect(moved.get(0)[0].ramp).not.toBe(first.get(0)[0].ramp);
  });

  it('смена текстуры — новый прямоугольник', () => {
    const { rampLights, textures } = setup();
    const source = lamp();

    rampLights.push(new Map(), 0, [lane], source, item(), 1);
    // тот же размер, новый объект текстуры: `textures` живой, сервис
    // освещения мутирует его в `registerTextures`
    textures.radial = {
      ...textures.radial,
      texture: { width: 68, height: 68 },
    };
    rampLights.push(new Map(), 0, [lane], source, item(), 1);

    expect(rampLight).toHaveBeenCalledTimes(2);
  });

  it('мимо клина — false, и промах кешируется', () => {
    const { rampLights } = setup();
    const source = lamp();
    const target = new Map();

    expect(rampLights.push(target, 0, [far], source, item(), 1)).toBe(false);
    expect(rampLights.push(target, 0, [far], source, item(), 1)).toBe(false);
    expect(target.size).toBe(0);
    // второй раз `null` берётся из кеша
    expect(rampLight).toHaveBeenCalledTimes(1);
  });

  it('веер окклюзии фары важнее прямоугольника', () => {
    const { rampLights } = setup();
    const target = new Map();
    const fan = {
      points: new Float32Array([0, 15, 100, -85, 100, -5, 100, 35, 100, 115]),
      closed: false,
      frame: {
        x: 0,
        y: 15,
        rotation: 0,
        sx: 1,
        sy: 1,
        margin: 4,
        width: 136,
        height: 136,
      },
    };
    const cone = { kind: 'cone', x: 0, y: 15, radius: 100, rotation: 0 };

    const occluded = item({ rampFan: fan });

    expect(rampLights.push(target, 0, [lane], cone, occluded, 1)).toBe(true);

    const [args] = rampLight.mock.calls[0];

    expect(args.points).toBe(fan.points);
    expect(args.frame).toBe(fan.frame);
    expect(args.closed).toBe(false);
  });

  it('targets(): уровень вершины -> уровни подножия', () => {
    // `LevelLightMap.rampLevels()` возвращает Set уровней `lane.to`
    const levelMap = (level, tops) => ({
      level,
      rampLevels: () => new Set(tops),
    });
    const { rampLights } = setup(
      new Map([
        [0, levelMap(0, [1, 2])],
        [1, levelMap(1, [2])],
        [2, levelMap(2, [])],
      ]),
    );

    expect(rampLights.targets()).toEqual(
      new Map([
        [1, [0]],
        [2, [0, 1]],
      ]),
    );
  });
});
