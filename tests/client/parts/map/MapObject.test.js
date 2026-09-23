import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Assets, Container, Texture, Ticker } from 'pixi.js';
import Map from '../../../../src/client/parts/Map.js';
import { createLevelView } from '../../../../src/client/levelView.js';
import { createLighting } from '../../../../src/client/lighting/createLighting.js';
import { seeThrough } from '../../../../src/config/render.js';
import {
  C_Z,
  C_LEVEL,
  C_STATE,
} from '../../../../src/client/snapshotFields.js';

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
      const row = [x, y, 0, 0, 0, 0, 0, 0, 0];

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

  describe('состояния пропа (байт state)', () => {
    const propData = {
      ...dynamicData,
      game: {
        prop: 'crate',
        imgDamaged: 'crate-damaged.png',
        imgDestroyed: 'crate-debris.png',
      },
    };

    const stateRow = state => {
      const row = [0, 0, 0, 0, 0, state, 0, 0, 0];

      row[C_STATE] = state;

      return row;
    };

    // запечённые ассеты парта Map (bakedAssets с component: 'Map')
    const bakedAssets = () => ({
      scorchTexture: { textures: [Texture.WHITE], contentSize: 40 },
      debrisTexture: { textures: [Texture.WHITE], contentSize: 8 },
    });

    // текстуры по URL: каждая картинка состояния — свой объект
    const textures = {
      '/build/img/b1.png': Texture.WHITE,
      '/build/img/crate-damaged.png': new Texture({
        source: Texture.WHITE.source,
      }),
      '/build/img/crate-debris.png': new Texture({
        source: Texture.WHITE.source,
      }),
    };

    const flush = async () => {
      for (let i = 0; i < 5; i += 1) {
        await Promise.resolve();
      }
    };

    let soundManager;

    beforeEach(() => {
      load.mockImplementation(url => Promise.resolve(textures[url]));
      soundManager = { registerSound: vi.fn() };
    });

    const makeProp = async (data = propData, assets = bakedAssets()) => {
      const part = new Map(data, assets, {
        renderer,
        assetsBase: '/build/',
        soundManager,
      });
      const stage = new Container();

      stage.addChild(part);
      await flush();

      return { part, stage, mode: part._mode };
    };

    it('0 → 1 → 0: текстура повреждения и обратно', async () => {
      const { part, mode } = await makeProp();

      part.update(stateRow(0));
      await flush();
      expect(mode.sprite.texture).toBe(textures['/build/img/b1.png']);

      part.update(stateRow(1));
      await flush();
      expect(mode.sprite.texture).toBe(
        textures['/build/img/crate-damaged.png'],
      );
      expect(load).toHaveBeenCalledWith('/build/img/crate-damaged.png');

      part.update(stateRow(0));
      await flush();
      expect(mode.sprite.texture).toBe(textures['/build/img/b1.png']);
    });

    it('→ 2: картинка обломков, zIndex под танками, разлёт и звук', async () => {
      const { part, stage, mode } = await makeProp();

      part.update(stateRow(0));
      await flush();

      const children = stage.children.length;

      part.update(stateRow(2));
      await flush();

      expect(mode.sprite.texture).toBe(textures['/build/img/crate-debris.png']);
      expect(part.zIndex).toBe(1);
      // разлёт щепок — сосед парта на сцене
      expect(stage.children.length).toBe(children + 1);
      expect(soundManager.registerSound).toHaveBeenCalledWith(
        'propBreak',
        expect.objectContaining({ position: expect.any(Object) }),
      );
    });

    it('zIndex обломков на уровне едет за уровнем тела', async () => {
      const { part } = await makeProp();

      part.update(stateRow(0));

      const row = stateRow(2);

      row[C_LEVEL] = 1;
      row[C_Z] = 1;
      part.update(row);

      expect(part.zIndex).toBe(101);
    });

    it('2 → 0 (новый раунд): исходная текстура и zIndex', async () => {
      const { part, mode } = await makeProp();

      part.update(stateRow(0));
      part.update(stateRow(2));
      await flush();
      part.update(stateRow(0));
      await flush();

      expect(mode.sprite.texture).toBe(textures['/build/img/b1.png']);
      expect(mode.sprite.visible).toBe(true);
      expect(part.zIndex).toBe(2);
    });

    it('без imgDestroyed разрушенный рисуется копотью', async () => {
      const barrel = { ...dynamicData, game: { prop: 'barrel' } };
      const { part, mode } = await makeProp(barrel);

      part.update(stateRow(0));
      part.update(stateRow(2));
      await flush();

      expect(mode.sprite.visible).toBe(false);
      expect(mode._scorch.visible).toBe(true);
      expect(part.children).toContain(mode._scorch);

      part.update(stateRow(0));
      await flush();

      expect(mode.sprite.visible).toBe(true);
      expect(mode._scorch.visible).toBe(false);
    });

    it('первый кадр со state = 2 — сразу обломки, без разлёта и звука', async () => {
      const { part, stage, mode } = await makeProp();
      const children = stage.children.length;

      part.update(stateRow(2));
      await flush();

      expect(mode.sprite.texture).toBe(textures['/build/img/crate-debris.png']);
      expect(part.zIndex).toBe(1);
      expect(stage.children.length).toBe(children);
      expect(soundManager.registerSound).not.toHaveBeenCalled();
    });

    it('состояние из кадра до загрузки базовой текстуры применяется после', async () => {
      let resolveBase;

      load.mockImplementation(url =>
        url === '/build/img/b1.png'
          ? new Promise(resolve => {
              resolveBase = resolve;
            })
          : Promise.resolve(textures[url]),
      );

      const part = new Map(propData, bakedAssets(), {
        renderer,
        assetsBase: '/build/',
        soundManager,
      });

      part.update(stateRow(1));
      resolveBase(Texture.WHITE);
      await flush();

      expect(part._mode.sprite.texture).toBe(
        textures['/build/img/crate-damaged.png'],
      );
    });

    it('поздняя загрузка текстуры состояния не трогает уничтоженный парт', async () => {
      let resolveDamaged;
      const { part, mode } = await makeProp();

      load.mockImplementation(
        () =>
          new Promise(resolve => {
            resolveDamaged = resolve;
          }),
      );

      const sprite = mode.sprite;

      part.update(stateRow(1));
      part.destroy();
      resolveDamaged(textures['/build/img/crate-damaged.png']);
      await flush();

      // спрайт снят вместе с партом (Pixi обнулил текстуру) — поздняя
      // загрузка на него ничего не поставила
      expect(sprite.texture).not.toBe(textures['/build/img/crate-damaged.png']);
    });

    it('destroy снимает со сцены незавершённый разлёт', async () => {
      const { part, stage } = await makeProp();

      part.update(stateRow(0));
      part.update(stateRow(2));

      const children = stage.children.length;

      part.destroy();

      // ушёл и сам парт, и его разлёт
      expect(stage.children.length).toBe(children - 2);
    });
  });
});

describe('MapObject: засвет и тень в лучах (ночь)', () => {
  const screenRenderer = { screen: { width: 800, height: 600 } };

  const flush = async () => {
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }
  };

  const propRow = (x, y, state = 0) => {
    const row = [x, y, 0, 0, 0, 0, 0, 0, 0];

    row[C_Z] = 0;
    row[C_LEVEL] = 0;
    row[C_STATE] = state;

    return row;
  };

  // фонарь в клетке [21, 15] (центр 688, 496): ящик 640..704 × 480..544
  const makeLitProp = async ({ night = true } = {}) => {
    load.mockImplementation(() => Promise.resolve(Texture.WHITE));

    const service = createLighting();
    const levelView = createLevelView(seeThrough);
    const stage = new Container();

    stage.position.set(400 - 672, 300 - 512);
    service.registerTextures({
      glint: { texture: Texture.WHITE, contentSize: 64 },
    });
    service.acquireMap(
      'k',
      { night, lamps: [{ cell: [21, 15], radius: 120, color: 0xffc070 }] },
      32,
      1,
    );

    const part = new Map(
      dynamicData,
      {},
      {
        renderer: screenRenderer,
        assetsBase: '/build/',
        levelView,
        lighting: service,
      },
    );

    stage.addChild(part);
    service.attachStage(stage, screenRenderer);
    await flush();
    part.update(propRow(640, 480));

    return { part, mode: part._mode, service };
  };

  const step = part => {
    Ticker.shared.lastTime += 16;
    part._onRender();
  };

  it('проп под фонарём получает блик по своему силуэту', async () => {
    const { part, mode } = await makeLitProp();

    step(part);

    const { sprite, mask } = mode._glint;

    expect(sprite.visible).toBe(true);
    expect(sprite.blendMode).toBe('add');
    expect(sprite.mask).toBe(mask);
    expect(mask.texture).toBe(mode.sprite.texture);
    expect(mask.rotation).toBe(mode.sprite.rotation);
    expect(sprite.tint).toBe(0xffc070);
    // центр тела (672, 512), фонарь (688, 496): вправо-вверх
    expect(sprite.rotation).toBeCloseTo(-Math.PI / 4);
  });

  it('днём блика нет', async () => {
    const { part, mode } = await makeLitProp({ night: false });

    step(part);

    expect(mode._glint).toBeNull();
  });

  it('целый проп — тень в лучах, копоть — нет, destroy снимает', async () => {
    const { part, mode, service } = await makeLitProp();
    const setCaster = vi.spyOn(service, 'setCaster');

    step(part);

    expect(setCaster).toHaveBeenLastCalledWith(mode, {
      x: 672,
      y: 512,
      z: 0,
      level: 0,
      radius: Math.hypot(64, 64) / 2,
    });

    part.update(propRow(640, 480, 2));
    step(part);

    expect(setCaster).toHaveBeenLastCalledWith(mode, null);
    expect(mode._glint.sprite.visible).toBe(false);

    part.destroy();

    expect(setCaster).toHaveBeenLastCalledWith(mode, null);
  });
});
