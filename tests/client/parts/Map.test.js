import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Assets } from 'pixi.js';
import Map from '../../../src/client/parts/Map.js';

// Part карты: сборка URL картинок. Тайл-листы и спрайты динамических тел
// везёт сам пакет игры (assets/img/ -> dist/img/), а базу пути движок отдаёт
// сервисом assetsBase — она разная в трёх контурах:
//   лобби/dedicated  '/games/tanks/'  (статик-маунт мастера)
//   standalone dev   '/build/'        (src/standalone.js)
// Промах базы движок не диагностирует: карта осталась бы пустым полотном.

const renderer = {};

// Assets.load подменён «вечным» промисом: createStatic/createDynamic его
// дожидаются, поэтому дальше конструктора асинхронная часть не уходит и
// WebGL в happy-dom не требуется
let load;

const staticData = {
  type: 'static',
  scale: 1,
  spriteSheet: { img: 'tiles.png', frames: [[0, 0, 32, 32]] },
  map: [[1]],
  tiles: [1],
  step: 32,
  layer: 1,
};

const dynamicData = {
  type: 'dynamic',
  scale: 1,
  img: 'b1.png',
  layer: 2,
  angle: 0,
  width: 64,
  height: 64,
  position: [640, 480],
};

const makeMap = (data, assetsBase) =>
  new Map(data, {}, { renderer, assetsBase });

beforeEach(() => {
  load = vi.spyOn(Assets, 'load').mockImplementation(() => new Promise(() => {}));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Map: база URL картинок', () => {
  it('тайл-лист статического слоя берётся из assetsBase', () => {
    const map = makeMap(staticData, '/games/tanks/');

    expect(load).toHaveBeenCalledWith('/games/tanks/img/tiles.png');
    expect(map._assetUrl).toBe('/games/tanks/img/tiles.png');
  });

  it('спрайт динамического тела берётся из assetsBase', () => {
    const map = makeMap(dynamicData, '/games/tanks/');

    expect(load).toHaveBeenCalledWith('/games/tanks/img/b1.png');
    expect(map._assetUrl).toBe('/games/tanks/img/b1.png');
  });

  it('другая база даёт другой URL (standalone-контур)', () => {
    makeMap(staticData, '/build/');

    expect(load).toHaveBeenCalledWith('/build/img/tiles.png');
  });

  // конструктор зовётся из рендер-тика движка, где перехватчика нет:
  // исключение оборвало бы создание остальных сущностей кадра, поэтому
  // промах базы только логируется, а карта остаётся пустой
  it('без сервиса assetsBase логирует ошибку, а не грузит "undefined"', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const map = makeMap(staticData, undefined);

    expect(error).toHaveBeenCalledWith(expect.stringContaining('assetsBase'));
    expect(load).not.toHaveBeenCalled();
    expect(map._assetUrl).toBe(null);
    expect(map.mapSprite).toBe(null);
  });
});
