import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Assets, Container } from 'pixi.js';
import Map from '../../../src/client/parts/Map.js';
import { createLevelView } from '../../../src/client/levelView.js';
import { seeThrough } from '../../../src/config/render.js';
import { C_LEVEL } from '../../../src/client/snapshotFields.js';

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
  load = vi
    .spyOn(Assets, 'load')
    .mockImplementation(() => new Promise(() => {}));
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

// 2.5D: слой уровня 1 (плита моста) обязан лежать выше любого наземного
// слоя, а под локальным игроком — становиться полупрозрачным.
describe('Map: слои 2.5D', () => {
  const bridgeData = {
    ...staticData,
    layer: 1,
    level: 1,
    map: [
      [0, 5],
      [0, 0],
    ],
    tiles: [5],
    floor: [5],
    step: 10,
  };

  // сервис игры levelView настоящий (src/client/levelView.js): формула
  // прозрачности одна на все парты, и подменять её фейком значило бы
  // проверять не ту арифметику, что работает в игре
  const levelView = (mode, level, x, y) => {
    const view = createLevelView({ ...seeThrough, mode });

    view.set(level, x, y, 0);

    return view;
  };

  // onRender выходит раньше, если карта ещё не запечена: спрайт подставляется
  // вручную — WebGL в happy-dom не поднять
  const readyBridge = (view, data = bridgeData) => {
    const map = new Map(
      data,
      {},
      { renderer, assetsBase: '/build/', levelView: view },
    );

    map.mapSprite = {};

    return map;
  };

  // сцена: камера — это её трансформ, по нему плита считает центр дыры
  const stage = map => {
    const parent = new Container();

    parent.scale.set(1);
    parent.addChild(map);

    return parent;
  };

  it('статический слой уровня 1 получает шаг zIndex', () => {
    const ground = makeMap(staticData, '/build/');
    const bridge = makeMap(bridgeData, '/build/');

    expect(ground.zIndex).toBe(1);
    expect(bridge.zIndex).toBe(101);
  });

  // проверяем ПРОВОДКУ, а не тело: `onRender` у Container — аксессор, и
  // одноимённый метод на прототипе парта затенил бы его сеттер, оставив
  // `_onRender` null. Тест, зовущий колбэк руками, такого не ловит
  it('плита регистрирует колбэк onRender в PixiJS', () => {
    const bridge = readyBridge(levelView('layer', 0, 15, 5));
    const ground = makeMap(staticData, '/build/');

    expect(typeof bridge._onRender).toBe('function');
    expect(ground._onRender).toBe(null);
  });

  it('слоёная карта отмечается в levelView (бейдж уровня у своего танка)', () => {
    const view = createLevelView(seeThrough);

    expect(view.layered).toBe(false);

    new Map(bridgeData, {}, { renderer, assetsBase: '/build/', levelView: view });

    expect(view.layered).toBe(true);
  });

  describe("режим 'layer'", () => {
    it('плита гаснет, когда локальный игрок под ней', () => {
      // игрок на уровне 0 в тайле (col 1, row 0) — это тайл пола моста
      const bridge = readyBridge(levelView('layer', 0, 15, 5));

      for (let i = 0; i < 200; i += 1) {
        bridge.onRender();
      }

      expect(bridge.alpha).toBeLessThan(0.5);
    });

    it('плита остаётся непрозрачной, когда игрок рядом с мостом', () => {
      // тот же уровень 0, но тайл (col 0, row 0) — не пол моста
      const bridge = readyBridge(levelView('layer', 0, 5, 5));

      for (let i = 0; i < 200; i += 1) {
        bridge.onRender();
      }

      expect(bridge.alpha).toBe(1);
    });

    it('игрок на самом мосту плиту не гасит', () => {
      const bridge = readyBridge(levelView('layer', 1, 15, 5));

      for (let i = 0; i < 200; i += 1) {
        bridge.onRender();
      }

      expect(bridge.alpha).toBe(1);
    });
  });

  describe("режим 'hole'", () => {
    it('под плитой появляется фильтр дыры с центром в игроке', () => {
      const bridge = readyBridge(levelView('hole', 0, 15, 5));
      const parent = stage(bridge);

      parent.position.set(100, 50);

      for (let i = 0; i < 200; i += 1) {
        bridge.onRender();
      }

      expect(bridge.filters.length).toBe(1);

      const uniforms = bridge._holeFilter.resources.holeUniforms.uniforms;

      // центр — экранный: мировая точка через трансформ сцены (камеру)
      expect(uniforms.uHoleCenter[0]).toBeCloseTo(115);
      expect(uniforms.uHoleCenter[1]).toBeCloseTo(55);
      expect(uniforms.uHoleParams[2]).toBeCloseTo(seeThrough.minAlpha, 2);
    });

    it('над плитой фильтр снимается совсем', () => {
      const bridge = readyBridge(levelView('hole', 1, 15, 5));

      stage(bridge);

      for (let i = 0; i < 200; i += 1) {
        bridge.onRender();
      }

      expect(bridge._holeAttached).toBe(false);
      expect(bridge._holeFilter).toBe(null);
    });

    // в режиме 'hole' пол не при чём: дыра ездит за игроком, и её край сам
    // показывает, где кончается плита
    it('игрок рядом с мостом дыру всё равно открывает', () => {
      const bridge = readyBridge(levelView('hole', 0, 5, 5));

      stage(bridge);

      for (let i = 0; i < 200; i += 1) {
        bridge.onRender();
      }

      expect(bridge.filters.length).toBe(1);
    });
  });

  describe('динамическое тело (ящик)', () => {
    const boxRow = (x, y, level) => {
      const row = [x, y, 0, 0, 0, 0, 0, 0];

      row[C_LEVEL] = level;

      return row;
    };

    const makeBox = view =>
      new Map(
        dynamicData,
        {},
        { renderer, assetsBase: '/build/', levelView: view },
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

    it('ящик на мосту гаснет рядом с игроком и темнеет под ним', () => {
      const view = createLevelView(seeThrough);
      const box = makeBox(view);

      box.sprite = {};
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
});
