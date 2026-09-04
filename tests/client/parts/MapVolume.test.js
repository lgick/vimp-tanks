import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Assets, Container, Texture } from 'pixi.js';
import MapVolume from '../../../src/client/parts/MapVolume.js';

// bakeTileLayer печёт слой рендерером — в happy-dom его не поднять, поэтому
// подменяем сам запёк: парт проверяется по геометрии срезов, а не по картинке
vi.mock('../../../src/client/parts/bakeTileLayer.js', () => ({
  bakeTileLayer: vi.fn(async () => ({
    destroy: vi.fn(),
  })),
}));

// камера — трансформ сцены плюс размер полотна (src/client/camera.js)
const renderer = { screen: { width: 800, height: 600 } };

const layerData = (volume, extra = {}) => ({
  type: 'static',
  scale: 1,
  spriteSheet: { img: 'tiles.png', frames: [[0, 0, 32, 32]] },
  map: [
    [1, 1],
    [1, 1],
  ],
  tiles: [1],
  step: 10,
  layer: 1,
  level: 1,
  volume,
  ...extra,
});

const makeVolume = data =>
  new MapVolume(data, {}, { renderer, assetsBase: '/build/' });

// createSlices асинхронна: ждём микрозадачи, иначе сетки ещё нет
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  vi.spyOn(Assets, 'load').mockImplementation(async () => Texture.EMPTY);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MapVolume: слой без высоты', () => {
  // слой без `volume` и динамические тела приходят этому парту ровно так же,
  // как `Map`: он обязан игнорировать их целиком — ни сетки, ни колбэка
  it('слой без volume не строит ничего и не вешает onRender', async () => {
    const part = makeVolume(layerData(0));

    await settle();

    expect(part._onRender).toBe(null);
    expect(part._slices).toHaveLength(0);
    expect(Assets.load).not.toHaveBeenCalled();
  });

  it('динамическое тело парт игнорирует', async () => {
    const part = makeVolume({ type: 'dynamic', scale: 1, volume: 2 });

    await settle();

    expect(part._onRender).toBe(null);
    expect(part._slices).toHaveLength(0);
  });
});

describe('MapVolume: экструзия', () => {
  const built = async () => {
    const part = makeVolume(layerData(2));
    const stage = new Container();

    stage.scale.set(1);
    stage.addChild(part);

    await settle();

    return part;
  };

  it('слой с volume строит срезы и регистрирует onRender', async () => {
    const part = await built();

    expect(typeof part._onRender).toBe('function');
    expect(part._slices.length).toBeGreaterThan(0);
    // объём лежит поверх своего же плоского слоя
    expect(part.zIndex).toBe(101.5);
  });

  it('смещение вершины растёт с расстоянием от центра камеры', async () => {
    const part = await built();

    part.onRender();

    const base = part._basePositions;
    const top = part._slices[part._slices.length - 1].mesh.geometry.positions;

    // центр камеры при пустом трансформе сцены — середина полотна (400, 300):
    // дальний от неё узел (0, 0) обязан уехать сильнее ближнего (20, 20)
    const last = base.length - 2;
    const near = Math.abs(top[last] - base[last]);
    const far = Math.abs(top[0] - base[0]);

    expect(far).toBeGreaterThan(near);
    expect(near).toBeGreaterThan(0);
  });

  it('нижние срезы смещены слабее верхнего', async () => {
    const part = await built();

    part.onRender();

    const base = part._basePositions;
    const shift = slice =>
      Math.abs(slice.mesh.geometry.positions[0] - base[0]);

    expect(shift(part._slices[0])).toBeLessThan(
      shift(part._slices[part._slices.length - 1]),
    );
  });

  it('destroy освобождает свою запечённую текстуру', async () => {
    const part = await built();
    const texture = part._texture;

    part.destroy();

    expect(texture.destroy).toHaveBeenCalledWith(true);
  });
});
