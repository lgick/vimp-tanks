import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Assets, Container, Sprite, Texture, TextureSource } from 'pixi.js';
import Map from '../../../../src/client/parts/Map.js';
import { bakeTileLayer } from '../../../../src/client/parts/bakeTileLayer.js';
import { createLevelView } from '../../../../src/client/levelView.js';
import { levelZ } from '../../../../src/client/levelZ.js';
import { seeThrough, parallax, volume } from '../../../../src/config/render.js';

// Стратегия статического слоя карты: запечённый тайл-лист, его параллакс,
// объём (перекрыватель), клин рампы и прозрачность плиты моста. Парт `Map`
// здесь — диспетчер: он создаёт стратегию и вешает её `render` колбэком
// `onRender`, поэтому тесты идут через парт, а внутренности читаются у
// стратегии (`part._mode`).
//
// Part карты: сборка URL картинок. Тайл-листы и спрайты динамических тел
// везёт сам пакет игры (assets/img/ -> dist/img/), а базу пути движок отдаёт
// сервисом assetsBase — она разная в трёх контурах:
//   лобби/dedicated  '/games/tanks/'  (статик-маунт мастера)
//   standalone dev   '/build/'        (src/standalone.js)
// Промах базы движок не диагностирует: карта осталась бы пустым полотном.

// запекание слоя идёт рендерером — в happy-dom его не поднять, поэтому
// подменяем сам запёк: тесты владения ассетами смотрят на порядок вызовов,
// а не на картинку
vi.mock('../../../../src/client/parts/bakeTileLayer.js', () => ({
  bakeTileLayer: vi.fn(async () => ({ destroy: vi.fn() })),
}));

const renderer = {};

// Assets.load подменён «вечным» промисом: запекание его дожидается, поэтому
// дальше конструктора асинхронная часть не уходит и WebGL в happy-dom не
// требуется
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

describe('MapLayer: база URL картинок', () => {
  it('тайл-лист статического слоя берётся из assetsBase', () => {
    const map = makeMap(staticData, '/games/tanks/');

    expect(load).toHaveBeenCalledWith('/games/tanks/img/tiles.png');
    expect(map._mode._assetUrl).toBe('/games/tanks/img/tiles.png');
  });

  it('другая база даёт другой URL (standalone-контур)', () => {
    makeMap(staticData, '/build/');

    expect(load).toHaveBeenCalledWith('/build/img/tiles.png');
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

    map._mode.mapSprite = {};

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

      const uniforms =
        bridge._mode._hole.filter.resources.holeUniforms.uniforms;

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

      expect(bridge._mode._hole.attached).toBe(false);
      expect(bridge._mode._hole.filter).toBe(null);
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
});

// Смена карты в движке идёт одним синхронным тиком: removeMap() сносит старые
// парты, createMap() тут же создаёт новые на ТЕХ ЖЕ картинках. Ассет игры —
// общий (один тайл-лист на все слои, b1.png на все тела любой карты), поэтому
// парт не имеет права его выгружать, а его собственные асинхронные
// конструкторы обязаны замечать, что парта уже нет.
describe('Map: владение ассетами при смене карты', () => {
  // ассет в кеше — то самое состояние, в котором старый код звал unload и
  // уносил TextureSource из-под всех остальных слоёв и партов
  const cached = () => {
    vi.spyOn(Assets.cache, 'has').mockReturnValue(true);

    return vi.spyOn(Assets, 'unload').mockResolvedValue(undefined);
  };

  it('destroy() не выгружает общий ассет', () => {
    const unload = cached();
    const map = makeMap(staticData, '/build/');

    map.destroy();

    expect(unload).not.toHaveBeenCalled();
  });

  it('поздний бейк не достраивает уничтоженный парт', async () => {
    let resolveLoad;

    load.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveLoad = resolve;
        }),
    );

    const baked = { destroy: vi.fn() };
    let resolveBake;

    bakeTileLayer.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveBake = resolve;
        }),
    );

    const map = makeMap(staticData, '/build/');
    const addChild = vi.spyOn(map, 'addChild');
    // стратегию диспетчер отпускает в destroy — держим ссылку на неё
    const mode = map._mode;

    // ассет доехал, запекание пошло — и тут карта сменилась
    resolveLoad(Texture.EMPTY);
    await Promise.resolve();
    await Promise.resolve();

    map.destroy();
    resolveBake(baked);
    await Promise.resolve();
    await Promise.resolve();

    expect(mode.mapSprite).toBe(null);
    expect(addChild).not.toHaveBeenCalled();
    // текстура сделана generateTexture под этот парт: бросить её нельзя
    expect(baked.destroy).toHaveBeenCalledWith(true);
  });

  // спрайт запечённого слоя выводится из-под `children: true` вручную:
  // иначе его уничтожил бы сам super.destroy, обнулив `_texture`, и наш
  // вызов с `texture: true` упал бы на `null.destroy()`
  it('destroy построенного слоя освобождает запечённую текстуру и не падает', async () => {
    let resolveLoad;

    load.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveLoad = resolve;
        }),
    );

    const destroy = vi
      .spyOn(Texture.EMPTY, 'destroy')
      .mockImplementation(() => {});

    bakeTileLayer.mockImplementation(async () => Texture.EMPTY);

    const map = makeMap(staticData, '/build/');

    resolveLoad(Texture.EMPTY);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(map._mode.mapSprite).not.toBe(null);

    // стратегию диспетчер отпускает в destroy — держим ссылку на неё
    const mode = map._mode;

    map.destroy();

    expect(destroy).toHaveBeenCalledWith(true);
    expect(mode.mapSprite).toBe(null);
  });
});

// Проекция 2.5D слоя: плита уровня N висит НАД землёй, а слой с высотой
// (`volume`) и рампа обзаводятся объёмом. Всё это — дети ОДНОГО контейнера
// парта: прозрачность и фильтр «дыры» иначе гасили бы плиту, оставляя её
// перила глухими.
describe('Map: параллакс и объём слоя', () => {
  // камера восстанавливается по трансформу сцены и размеру полотна
  const viewRenderer = { screen: { width: 800, height: 600 } };

  const parallaxData = {
    ...staticData,
    scale: 0.5,
    level: 1,
    map: [
      [0, 5],
      [0, 0],
    ],
    tiles: [5],
    floor: [5],
    step: 10,
  };

  const makeStage = map => {
    const parent = new Container();

    parent.scale.set(1);
    parent.addChild(map);

    return parent;
  };

  // прогон рампы так, как его отдаёт ядро (`ClientCore::ramp_runs`):
  // МИРОВЫЕ единицы, `tile_size = step * scale` (10 × 0.5 = 5). Ядра в
  // тестах парта нет — сервис отдаёт готовую фикстуру
  const TILE = 10 * 0.5;

  const coreRun = (over = {}) => ({
    axis: 0,
    sign: 1,
    from: 0,
    to: 1,
    block: 0,
    min: 0,
    max: 2 * TILE,
    crossMin: 0,
    crossMax: TILE,
    ...over,
  });

  const make = (data, levelView, runs = []) =>
    new Map(
      data,
      {},
      {
        renderer: viewRenderer,
        assetsBase: '/build/',
        levelView,
        rampRuns: {
          forLevel: level => runs.filter(run => run.from === level),
        },
      },
    );

  // центр камеры при пустом трансформе сцены — середина полотна
  const CAM_X = 400;
  const CAM_Y = 300;

  it('слой уровня 1 получает трансформ параллакса, слой уровня 0 — нет', () => {
    const bridge = make(parallaxData, createLevelView(seeThrough));

    bridge._mode.mapSprite = new Sprite();
    makeStage(bridge);
    bridge.onRender();

    const k = 1 * parallax.shear;

    expect(bridge._mode.mapSprite.scale.x).toBeCloseTo(0.5 * (1 + k), 6);
    expect(bridge._mode.mapSprite.position.x).toBeCloseTo(-CAM_X * k, 6);
    expect(bridge._mode.mapSprite.position.y).toBeCloseTo(-CAM_Y * k, 6);

    // плоский слой земли не платит даже за колбэк
    const ground = make(
      { ...staticData, level: 0 },
      createLevelView(seeThrough),
    );

    expect(ground._onRender).toBe(null);
    expect(ground._mode._parallaxK).toBe(0);
  });

  // игрок под мостом нарисован смещённым на свою высоту, и слой над ним —
  // тоже: центр дыры обязан ехать по той же проекции, иначе он уползает от
  // танка тем сильнее, чем дальше тот от центра экрана
  it('центр «дыры» считается от смещённой позиции игрока', () => {
    const view = createLevelView(seeThrough);

    view.set(0, 15, 5, 2);

    const bridge = make(parallaxData, view);

    bridge._mode.mapSprite = new Sprite();

    const stage = makeStage(bridge);

    for (let i = 0; i < 200; i += 1) {
      bridge.onRender();
    }

    const k = 2 * parallax.shear;
    const uniforms = bridge._mode._hole.filter.resources.holeUniforms.uniforms;

    expect(uniforms.uHoleCenter[0]).toBeCloseTo(
      15 + (15 - CAM_X) * k + stage.position.x,
      3,
    );
    expect(uniforms.uHoleCenter[1]).toBeCloseTo(5 + (5 - CAM_Y) * k, 3);
  });

  describe('экструзия', () => {
    // запекание идёт рендерером, которого в happy-dom нет: подменяем сам
    // запёк текстурой нужного размера — срезы режут её кадрами
    const baked = () =>
      new Texture({ source: new TextureSource({ width: 20, height: 20 }) });

    // горка на восток по строке 0, колонки 0..1 — фикстура всех тестов
    // клина: грид слоя, его тайлы и конфиг рампы
    const rampData = {
      ...parallaxData,
      level: 0,
      map: [
        [7, 7],
        [0, 0],
      ],
      tiles: [7],
      ramps: [{ tile: 7, dir: 'east', from: 0, to: 1 }],
    };

    const ready = async (data, view, runs = []) => {
      load.mockImplementation(async () => Texture.EMPTY);
      bakeTileLayer.mockClear();
      bakeTileLayer.mockImplementation(async () => baked());

      const map = make(data, view || createLevelView(seeThrough), runs);

      for (let i = 0; i < 10; i += 1) {
        await Promise.resolve();
      }

      return map;
    };

    it('слой с объёмом печётся ОДИН раз и даёт ровно slices срезов', async () => {
      const map = await ready({ ...parallaxData, volume: 1 });

      expect(bakeTileLayer).toHaveBeenCalledTimes(1);
      expect(map._mode._slices).toHaveLength(volume.slices);
      // срезы делят текстуру с плоским слоем
      for (const slice of map._mode._slices) {
        expect(slice.target.texture.source).toBe(
          map._mode.mapSprite.texture.source,
        );
      }
    });

    // объём слоя перекрывает динамику СВОЕГО уровня: экструзия уходит от
    // центра камеры, то есть накрывает область за стеной, — и танк, стоящий
    // там, обязан оказаться ЗА ней, а не поверх неё. Внутри парта это
    // недостижимо: у слоя один zIndex на всё
    it('срезы объёма живут в перекрывателе — сиблинге парта на сцене', async () => {
      const map = await ready({ ...parallaxData, volume: 1 });
      const stage = makeStage(map);

      map.onRender();

      expect(map._mode._occluder.parent).toBe(stage);
      expect(map._mode._occluder.zIndex).toBeGreaterThan(
        levelZ(3, map._mode._level),
      );
      // и ниже следующего уровня целиком
      expect(map._mode._occluder.zIndex).toBeLessThan(
        levelZ(1, map._mode._level + 1),
      );

      for (const slice of map._mode._slices) {
        expect(slice.target.parent).toBe(map._mode._occluder);
      }

      expect(map.children).toHaveLength(1);
    });

    // клин рампы, наоборот, остаётся в парте: танк, поднимающийся по горке,
    // рисуется ПОВЕРХ её поверхности
    it('клин рампы остаётся ребёнком парта', async () => {
      const map = await ready(rampData, null, [coreRun()]);

      makeStage(map);
      map.onRender();

      expect(map._mode._occluder).toBe(null);

      for (const slice of map._mode._slices) {
        expect(slice.target.parent).toBe(map);
      }
    });

    // объём обязан оставаться СПЛОШНЫМ: «дыра всегда» превращала стены в
    // полупрозрачные пятна, и объём переставал читаться вовсе
    describe('прозрачность перекрывателя', () => {
      // грид 16 × 12 клеток по 10 при scale 0.5 — мир 80 × 60, то есть
      // камера (400, 300) лежит ВНЕ карты: точка, накрывающая игрока,
      // считается на отрезке от него к центру камеры
      const walls = {
        ...parallaxData,
        level: 0,
        volume: 1,
        map: Array.from({ length: 12 }, () => new Array(16).fill(5)),
        tiles: [5],
        floor: [],
      };

      const run = async (data, view) => {
        const map = await ready(data, view);

        makeStage(map);

        for (let i = 0; i < 200; i += 1) {
          map.onRender();
        }

        return map;
      };

      it('стена своего уровня не гаснет, пока не закрывает танк', async () => {
        const view = createLevelView(seeThrough);

        // игрок в самом центре камеры: экструзия уводит стены ОТ него
        view.set(0, 400, 300, 0);

        const map = await run(walls, view);

        expect(map._mode._occluderHole.attached).toBe(false);
        expect(map._mode._occluderHole.strength).toBeLessThan(0.01);
      });

      it('стена своего уровня гаснет, когда накрывает танк', async () => {
        const view = createLevelView(seeThrough);

        // игрок у начала карты: срез стены между ним и центром камеры
        // ложится ровно на него
        view.set(0, 0, 0, 0);

        const map = await run(walls, view);

        expect(map._mode._occluderHole.attached).toBe(true);
        expect(map._mode._occluderHole.strength).toBeGreaterThan(0.9);
      });

      // перила моста обязаны исчезать вместе с плитой, под которой стоит
      // игрок, — иначе они остаются глухим блоком над дырой в ней
      it('объём НАД игроком гаснет вместе со своим слоем', async () => {
        const view = createLevelView(seeThrough);

        view.set(0, 400, 300, 0);

        const map = await run({ ...parallaxData, volume: 1 }, view);

        expect(map._mode._level).toBe(1);
        expect(map._mode._occluderHole.attached).toBe(true);
      });
    });

    // дальняя кромка прогона — уже следующая клетка, тайла рампы в ней нет:
    // юбка, растянувшая её пиксели, оказывалась прозрачной, и насыпь
    // читалась пустой с одной стороны
    it('юбка текстурируется изнутри прогона, а не с его кромки', async () => {
      const map = await ready(rampData, null, [coreRun()]);

      const uvs = map._mode._slices[0].target.geometry.uvs;
      const width = map._mode._rampTexture.width;
      const height = map._mode._rampTexture.height;

      // прогон занимает строку 0, колонки 0..1 при step 10: выборка обязана
      // лежать СТРОГО внутри этого прямоугольника
      for (let i = 0; i < uvs.length; i += 2) {
        expect(uvs[i] * width).toBeGreaterThan(0);
        expect(uvs[i] * width).toBeLessThan(20);
        expect(uvs[i + 1] * height).toBeGreaterThan(0);
        expect(uvs[i + 1] * height).toBeLessThan(10);
      }
    });

    it('destroy снимает перекрыватель со сцены и не трогает общую текстуру', async () => {
      const map = await ready({ ...parallaxData, volume: 1 });
      const stage = makeStage(map);

      map.onRender();

      const occluder = map._mode._occluder;
      const source = map._mode._slices[0].target.texture.source;
      const destroy = vi.spyOn(source, 'destroy');

      map.destroy();

      expect(stage.children).toHaveLength(0);
      expect(occluder.destroyed).toBe(true);
      // запечённую текстуру перекрыватель делит со слоем: отдаёт её один
      // владелец — спрайт слоя, и ровно один раз
      expect(destroy).toHaveBeenCalledTimes(1);
    });

    it('срезы стоят по возрастанию высоты и сдвинуты сильнее слоя', async () => {
      const map = await ready({ ...parallaxData, volume: 1 });

      makeStage(map);
      map.onRender();

      const heights = map._mode._slices.map(slice => slice.k);

      expect(heights).toEqual([...heights].sort((a, b) => a - b));
      expect(heights[0]).toBeGreaterThan(map._mode._parallaxK);

      const top = map._mode._slices[map._mode._slices.length - 1].target;

      expect(Math.abs(top.position.x)).toBeGreaterThan(
        Math.abs(map._mode.mapSprite.position.x),
      );
    });

    // клин рампы: горка — наклонная плоскость, для этого печётся отдельная
    // текстура только из клеток рампы, а прогон превращается в один меш
    it('рампа даёт свою текстуру, поверхность прогона и юбку', async () => {
      const map = await ready(rampData, null, [coreRun()]);

      expect(bakeTileLayer).toHaveBeenCalledTimes(2);
      expect(map._mode._rampTexture).not.toBe(null);
      // прогон — наклонная плоскость плюс юбка насыпи, а не лестница из
      // срезов: два меша, и юбка нарисована первой
      expect(map._mode._slices).toHaveLength(2);
      expect(map._mode._slices[0].base).toBeInstanceOf(Float32Array);
      expect(map._mode._slices[1].base).toBeInstanceOf(Float32Array);
      // юбка стоит на базовой плоскости прогона
      expect(map._mode._slices[0].k).toBeCloseTo(0, 6);
      // порядок отрисовки задаётся вершиной клина: полный перепад рампы
      expect(map._mode._slices[1].k).toBeCloseTo(parallax.shear, 6);
    });

    // горка обязана читаться как насыпь: под её поверхностью — грани до
    // базовой плоскости прогона, а не пустота, в которую «можно проехать»
    it('юбка тянет поверхность прогона вниз, до базовой плоскости', async () => {
      const map = await ready(rampData, null, [coreRun()]);

      const skirt = map._mode._slices[0];
      const surface = map._mode._slices[1];
      const points = 2 * volume.rampSegments + 1;

      // два борта вдоль оси плюс торцевая пара, по верхней и нижней кромке
      expect(skirt.heights).toHaveLength((points * 2 + 2) * 2);

      let previousTop = -1;

      for (let i = 0; i < points; i += 1) {
        const top = skirt.heights[i * 2];
        const bottom = skirt.heights[i * 2 + 1];

        // верхняя кромка идёт по поверхности, нижняя — по базовой плоскости
        expect(top).toBeCloseTo(surface.heights[i * 2], 6);
        expect(bottom).toBeCloseTo(0, 6);
        expect(top).toBeGreaterThan(previousTop);

        previousTop = top;
      }

      // грань вертикальна: обе кромки стоят в одной мировой точке
      expect(skirt.base[2]).toBeCloseTo(skirt.base[0], 6);
      expect(skirt.base[3]).toBeCloseTo(skirt.base[1], 6);

      // боковая грань темнее поверхности
      expect(skirt.target.tint).toBe(volume.sideTint);
    });

    // ради этого клин и стал мешем: высота растёт вдоль прогона непрерывно,
    // а не четырьмя ступенями
    it('высота клина растёт вдоль прогона монотонно и без ступеней', async () => {
      const map = await ready(rampData, null, [coreRun()]);

      const { heights } = map._mode._slices[1];
      // по вершине на каждый угол сегмента: 2 клетки × rampSegments + 1
      const points = 2 * volume.rampSegments + 1;

      expect(heights).toHaveLength(points * 2);

      // подъём на восток: у западного торца высоты нет, у восточного — вся
      expect(heights[0]).toBeCloseTo(0, 6);
      expect(heights[1]).toBeCloseTo(0, 6);
      expect(heights[heights.length - 1]).toBeCloseTo(parallax.shear, 6);

      // шаг между соседними точками один и тот же — это и есть «плоскость»
      const step = heights[2] - heights[0];

      expect(step).toBeGreaterThan(0);

      for (let i = 2; i < heights.length; i += 2) {
        expect(heights[i] - heights[i - 2]).toBeCloseTo(step, 6);
      }
    });

    // вершины меша сдвигает не трансформ контейнера, а сама проекция: у
    // каждой своя высота, поэтому applyParallax тут не применим
    it('камера двигает вершины клина тем сильнее, чем они выше', async () => {
      const map = await ready(rampData, null, [coreRun()]);

      makeStage(map);
      map.onRender();

      const { target, base, heights } = map._mode._slices[1];
      const shift = i =>
        Math.abs(target.vertices[i * 2] - base[i * 2]) +
        Math.abs(target.vertices[i * 2 + 1] - base[i * 2 + 1]);

      // низ клина стоит в мировой точке, вершина уехала от центра камеры
      expect(heights[0]).toBe(0);
      expect(shift(0)).toBeCloseTo(0, 6);
      expect(shift(heights.length - 1)).toBeGreaterThan(0);
    });

    // нисходящая рампа (`from > to`) — законная карта: её тайл лежит в
    // гриде ВЕРХНЕГО уровня, и клин обязан спускаться от него к нижнему.
    // До этапа 3 плана review-multilevel-3 такая горка не рисовалась вовсе
    it('нисходящая рампа даёт клин от верхнего уровня к нижнему', async () => {
      const map = await ready(
        {
          ...rampData,
          level: 1,
          ramps: [{ tile: 7, dir: 'east', from: 1, to: 0 }],
        },
        null,
        [coreRun({ from: 1, to: 0 })],
      );

      expect(map._mode._slices).toHaveLength(2);

      const skirt = map._mode._slices[0];
      const surface = map._mode._slices[1];
      const { heights } = surface;

      // насыпь стоит на НИЖНЕМ уровне прогона, а не на уровне слоя
      expect(skirt.k).toBeCloseTo(0, 6);
      // порядок отрисовки — по верхнему уровню прогона
      expect(surface.k).toBeCloseTo(parallax.shear, 6);

      // высота идёт от уровня слоя (1) вниз до 0 — то же
      // `lerp(from, to, progress)`, что у z танка в ядре
      expect(heights[0]).toBeCloseTo(parallax.shear, 6);
      expect(heights[heights.length - 1]).toBeCloseTo(0, 6);

      for (let i = 2; i < heights.length; i += 2) {
        expect(heights[i]).toBeLessThan(heights[i - 2]);
      }
    });

    // прогоны приходят из ядра по уровню `from`: чужой уровень слой не берёт
    it('прогон чужого уровня в клин не попадает', async () => {
      const map = await ready(rampData, null, [coreRun({ from: 1, to: 2 })]);

      expect(map._mode._slices).toHaveLength(0);
    });

    it('рампу чужого рендер-слоя парт не рисует', async () => {
      const map = await ready({ ...rampData, tiles: [5] }, null, [coreRun()]);

      expect(bakeTileLayer).toHaveBeenCalledTimes(1);
      expect(map._mode._slices).toHaveLength(0);
    });

    it('destroy освобождает текстуру клина', async () => {
      const map = await ready(rampData, null, [coreRun()]);

      const rampTexture = map._mode._rampTexture;
      const destroy = vi.spyOn(rampTexture, 'destroy');
      const meshes = map._mode._slices.map(slice => slice.target);

      map.destroy();

      // источник текстуры клина отдаётся один раз, оба меша уходят вместе
      // с детьми контейнера
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(destroy).toHaveBeenCalledWith(true);

      for (const mesh of meshes) {
        expect(mesh.destroyed).toBe(true);
      }
    });
  });
});
