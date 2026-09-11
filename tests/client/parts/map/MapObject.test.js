import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Assets, Container, Texture } from 'pixi.js';
import Map from '../../../../src/client/parts/Map.js';
import { createLevelView } from '../../../../src/client/levelView.js';
import { seeThrough } from '../../../../src/config/render.js';
import { C_Z, C_LEVEL } from '../../../../src/client/snapshotFields.js';

// Стратегия динамического тела карты (ящик): своя строка кадра, свой
// уровень и своя прозрачность. Парт `Map` здесь — диспетчер: он создаёт
// стратегию и вешает её `render` колбэком `onRender`, поэтому тесты идут
// через парт, а внутренности читаются у стратегии (`part._mode`).

const renderer = {};

// Assets.load подменён «вечным» промисом: создание спрайта его дожидается,
// поэтому дальше конструктора асинхронная часть не уходит и WebGL в
// happy-dom не требуется
let load;

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

// ассет в кеше — то самое состояние, в котором старый код звал unload и
// уносил TextureSource из-под всех остальных слоёв и партов
const cached = () => {
  vi.spyOn(Assets.cache, 'has').mockReturnValue(true);

  return vi.spyOn(Assets, 'unload').mockResolvedValue(undefined);
};

beforeEach(() => {
  load = vi
    .spyOn(Assets, 'load')
    .mockImplementation(() => new Promise(() => {}));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MapObject: динамическое тело карты', () => {
  it('спрайт динамического тела берётся из assetsBase', () => {
    const map = makeMap(dynamicData, '/games/tanks/');

    expect(load).toHaveBeenCalledWith('/games/tanks/img/b1.png');
    expect(map._mode._assetUrl).toBe('/games/tanks/img/b1.png');
  });

  describe('динамическое тело (ящик)', () => {
    // высота по умолчанию равна уровню — так хост и держит стоящее тело
    // (`map::step_body_level`); дробная `z` бывает только в падении
    const boxRow = (x, y, level, z = level) => {
      const row = [x, y, 0, 0, 0, 0, 0, 0];

      row[C_Z] = z;
      row[C_LEVEL] = level;

      return row;
    };

    const makeBox = (view, box = renderer) =>
      new Map(
        dynamicData,
        {},
        { renderer: box, assetsBase: '/build/', levelView: view },
      );

    // ящик на мосту гаснуть не начинал вовсе: у динамической ветки не было
    // ни onRender, ни alpha
    it('ящик регистрирует колбэк onRender в PixiJS', () => {
      expect(typeof makeBox(createLevelView(seeThrough))._onRender).toBe(
        'function',
      );
    });

    it('zIndex ящика едет за уровнем из строки кадра', () => {
      const box = makeBox(createLevelView(seeThrough));

      expect(box.zIndex).toBe(2);

      box.update(boxRow(0, 0, 1));

      expect(box.zIndex).toBe(102);

      // падение с моста: уровень возвращается к земле
      box.update(boxRow(0, 0, 0));

      expect(box.zIndex).toBe(2);
    });

    // порядок отрисовки обязан переехать вместе с zIndex в том же кадре:
    // ящик, упавший с моста, иначе рисовался бы поверх плиты до следующего
    // спавна. Сеттер `zIndex` в PixiJS 8 помечает родителя сам
    // (sortMixin.depthOfChildModified), контейнер пересортируется на
    // collectRenderables — проверяем именно эту связку
    it('смена уровня помечает родителя к пересортировке', () => {
      const box = makeBox(createLevelView(seeThrough));
      const parent = new Container();

      parent.addChild(box);
      parent.sortChildren();

      expect(parent.sortDirty).toBe(false);

      box.update(boxRow(0, 0, 1));

      expect(parent.sortableChildren).toBe(true);
      expect(parent.sortDirty).toBe(true);
    });

    // падающий ящик рисуется ВЫСОТОЙ, а не уровнем: хост держит `level`
    // тем уровнем, с которого тело сорвалось, до самого касания
    it('падающий ящик переходит на нижний слой по высоте', () => {
      const box = makeBox(createLevelView(seeThrough));

      box.update(boxRow(0, 0, 1));

      expect(box.zIndex).toBe(102);

      // сорвался с моста: `level` ещё 1, но высота уже ниже половины
      box.update(boxRow(0, 0, 1, 0.4));

      expect(box.zIndex).toBe(2);
    });

    // падающий ящик обязан ОПУСКАТЬСЯ видимо, а не телепортироваться на
    // нижний слой в момент касания: параллакс ведёт высота строки
    it('параллакс падающего ящика едет за высотой', () => {
      const view = createLevelView(seeThrough);
      // камера берётся у сцены: без родителя и полотна её нет, и параллакс
      // не двигает ничего
      const stage = new Container();

      stage.position.set(0, 0);
      stage.scale.set(1, 1);

      const box = makeBox(view, { screen: { width: 800, height: 600 } });

      stage.addChild(box);
      box._mode.sprite = {};
      view.set(0, 0, 0, 0);

      box.update(boxRow(100, 100, 1));
      box.onRender();

      const high = box.scale.x;

      box.update(boxRow(100, 100, 1, 0.5));
      box.onRender();

      expect(box.scale.x).not.toBe(high);
      expect(box.scale.x).toBeLessThan(high);
    });

    it('alphaFor получает высоту строки', () => {
      const view = createLevelView(seeThrough);
      const alphaFor = vi.spyOn(view, 'alphaFor');
      const box = makeBox(view);

      box._mode.sprite = {};
      box.update(boxRow(100, 100, 1, 0.4));
      box.onRender();

      expect(alphaFor).toHaveBeenCalledWith(0, 100, 100, 0.4);
    });

    it('ящик на мосту гаснет рядом с игроком и темнеет под ним', () => {
      const view = createLevelView(seeThrough);
      const box = makeBox(view);

      box._mode.sprite = {};
      box.update(boxRow(100, 100, 1));

      // игрок на земле рядом с ящиком: ящик над ним — гаснет
      view.set(0, 100, 100, 0);
      box.onRender();

      expect(box.alpha).toBeCloseTo(seeThrough.minAlpha, 5);
      expect(box.tint).toBe(0xffffff);

      // игрок сам поднялся на мост: ящик виден целиком
      view.set(1, 100, 100, 0);
      box.onRender();

      expect(box.alpha).toBe(1);

      // ящик упал вниз: он ниже игрока — затемняется
      box.update(boxRow(100, 100, 0));
      box.onRender();

      expect(box.alpha).toBe(1);
      expect(box.tint).toBe(seeThrough.lowerTint);
    });
  });

  it('destroy() динамического тела тоже не трогает Assets', () => {
    const unload = cached();
    const box = makeMap(dynamicData, '/build/');

    box.destroy();

    expect(unload).not.toHaveBeenCalled();
  });

  it('поздняя загрузка не достраивает уничтоженное динамическое тело', async () => {
    let resolveLoad;

    load.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveLoad = resolve;
        }),
    );

    const box = makeMap(dynamicData, '/build/');
    const addChild = vi.spyOn(box, 'addChild');
    // стратегию диспетчер отпускает в destroy — держим ссылку на неё
    const mode = box._mode;

    box.destroy();
    resolveLoad(Texture.EMPTY);
    await Promise.resolve();
    await Promise.resolve();

    expect(mode.sprite).toBe(null);
    expect(addChild).not.toHaveBeenCalled();
  });
});
