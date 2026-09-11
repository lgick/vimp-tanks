import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Assets } from 'pixi.js';
import Map from '../../../src/client/parts/Map.js';
import MapLayer from '../../../src/client/parts/map/MapLayer.js';
import MapObject from '../../../src/client/parts/map/MapObject.js';

// Парт карты — диспетчер двух стратегий: движок отдаёт статические слои и
// динамические тела в ОДИН и тот же список имён (`gameSets`), поэтому имя
// парта одно, а вид данных разбирается внутри. Сами стратегии проверяются
// в tests/client/parts/map/*.

vi.mock('../../../src/client/parts/bakeTileLayer.js', () => ({
  bakeTileLayer: vi.fn(async () => ({ destroy: vi.fn() })),
}));

const renderer = {};

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
  load = vi
    .spyOn(Assets, 'load')
    .mockImplementation(() => new Promise(() => {}));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Map: диспетчер стратегий', () => {
  it('статические данные ведут в стратегию слоя', () => {
    expect(makeMap(staticData, '/build/')._mode).toBeInstanceOf(MapLayer);
  });

  it('динамические данные ведут в стратегию тела', () => {
    expect(makeMap(dynamicData, '/build/')._mode).toBeInstanceOf(MapObject);
  });

  // конструктор зовётся из рендер-тика движка, где перехватчика нет:
  // исключение оборвало бы создание остальных сущностей кадра, поэтому
  // промах базы только логируется, а карта остаётся пустой
  it('без сервиса assetsBase логирует ошибку, а не грузит "undefined"', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const map = makeMap(staticData, undefined);

    expect(error).toHaveBeenCalledWith(expect.stringContaining('assetsBase'));
    expect(load).not.toHaveBeenCalled();
    expect(map._mode).toBe(null);
  });

  // парт без стратегии обязан пережить и кадр, и смену карты: движок зовёт
  // update/destroy у всех партов подряд
  it('парт без стратегии не падает на update и destroy', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const map = makeMap(staticData, undefined);

    expect(() => map.update([0, 0, 0, 0, 0, 0, 0, 0])).not.toThrow();
    expect(() => map.destroy()).not.toThrow();
  });
});
