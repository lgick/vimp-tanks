import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  AlphaFilter,
  Container,
  Sprite,
  Texture,
  TextureSource,
  Ticker,
} from 'pixi.js';
import {
  createLighting,
  lightArea,
} from '../../../src/client/lighting/createLighting.js';
import LevelLightMap from '../../../src/client/lighting/LevelLightMap.js';
import { createLevelView } from '../../../src/client/levelView.js';
import { levelZ } from '../../../src/client/levelZ.js';
import {
  LIGHT_OVERLAY_BASE_Z,
  EMISSIVE_BASE_Z,
  LAMP_HEAD_BASE_Z,
} from '../../../src/client/lighting/lightMath.js';
import { lighting, parallax } from '../../../src/config/render.js';

// Сервис освещения поверх настоящих контейнеров Pixi и мок-рендерера:
// проверяется, ЧТО лежит на сцене и что уходит в раскладку источников, а не
// картинка. Смена карты гоняется в реальном порядке движка: сначала
// уничтожаются ВСЕ части старой карты, затем создаются новые.

const screen = { width: 800, height: 600 };
const renderer = { screen };

const sized = (width, height) =>
  new Texture({ source: new TextureSource({ width, height }) });

const textures = () => ({
  radial: { texture: sized(68, 68), contentSize: 64 },
  head: { texture: sized(22, 22), contentSize: 20 },
  cone: { texture: sized(136, 136), length: 128, halfWidth: 64, margin: 4 },
});

const nightLighting = (lamps = [{ cell: [1, 1], radius: 50, head: true }]) => ({
  night: true,
  ambient: 0x3a4260,
  lamps: lamps.map(lamp => ({
    level: 0,
    color: 0xffc070,
    intensity: 0.9,
    flicker: 0,
    ...lamp,
  })),
});

const STEP = 32;

// камера в начале координат: сцена сдвинута на полэкрана
const setup = (cfg = lighting) => {
  const levelView = createLevelView();
  const service = createLighting(cfg, { levelView });
  const stage = new Container();

  stage.sortableChildren = true;
  stage.position.set(screen.width / 2, screen.height / 2);
  service.attachStage(stage, renderer);

  return { service, stage, levelView };
};

const frame = service => {
  Ticker.shared.lastTime += 16;
  service.render();
};

const overlays = stage =>
  stage.children.filter(child => child.label?.startsWith('lighting-'));
const overlayOf = (stage, level) =>
  stage.children.find(child => child.label === `lighting-${level}`);
const emissiveOf = (stage, level) =>
  stage.children.find(child => child.label === `emissive-${level}`);
const lampHeadsOf = (stage, level) =>
  stage.children.find(child => child.label === `lamp-heads-${level}`);

// Имитация частей карты: каждая статическая часть берёт ключ и, если она
// уровня >= 1, вносит вклад в маску
const makeParts = (service, key, cfg, floors = {}) => {
  const parts = [{ level: 0 }, ...Object.keys(floors).map(level => ({ level: Number(level) }))];

  for (const part of parts) {
    service.acquireMap(key, cfg, STEP, 1);

    if (part.level >= 1) {
      service.setLevelMask(part.level, floors[part.level], part);
    }
  }

  return parts;
};

const releaseParts = (service, key, parts) => {
  for (const part of parts) {
    service.releaseMap(key, part);
  }
};

// раскладки кадра по уровням: что сервис отдал оверлеям
const spyLayout = () => vi.spyOn(LevelLightMap.prototype, 'layout');
const lastItems = (spy, level) => {
  for (let i = spy.mock.calls.length - 1; i >= 0; i -= 1) {
    if (spy.mock.contexts[i].level === level) {
      return spy.mock.calls[i][0];
    }
  }

  return null;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('lighting: оверлеи уровней', () => {
  it('на ночной карте оверлей уровня 0 есть всегда, выше — только с этажом', () => {
    const { service, stage } = setup();

    makeParts(service, 'a', nightLighting());
    frame(service);

    expect(overlays(stage).map(o => o.label)).toEqual(['lighting-0']);

    service.setLevelMask(2, [[1, 1]], {});
    frame(service);

    expect(overlayOf(stage, 2)).toBeDefined();
    expect(overlayOf(stage, 1)).toBeUndefined();
  });

  it('zIndex оверлея и эмиссива — levelZ(40/45, L)', () => {
    const { service, stage } = setup();

    makeParts(service, 'a', nightLighting(), { 1: [[0, 0]] });
    service.addEmissive(new Sprite(), 1);
    frame(service);

    expect(overlayOf(stage, 0).zIndex).toBe(levelZ(LIGHT_OVERLAY_BASE_Z, 0));
    expect(overlayOf(stage, 1).zIndex).toBe(levelZ(LIGHT_OVERLAY_BASE_Z, 1));
    expect(emissiveOf(stage, 1).zIndex).toBe(levelZ(EMISSIVE_BASE_Z, 1));
  });

  it('оверлей кладётся на сцену умножением', () => {
    const { service, stage } = setup();

    makeParts(service, 'a', nightLighting());
    frame(service);

    const overlay = overlayOf(stage, 0);

    expect(overlay.filters).toHaveLength(1);
    expect(overlay.filters[0].blendMode).toBe('multiply');
    expect(overlay.filters[0].resolution).toBe(lighting.resolution);
  });

  it('вклад маски уровня исчезает — оверлей уровня уходит', () => {
    const { service, stage } = setup();
    const owner = {};

    makeParts(service, 'a', nightLighting());
    service.setLevelMask(1, [[0, 0]], owner);
    frame(service);
    expect(overlayOf(stage, 1)).toBeDefined();

    service.setLevelMask(1, [], owner);
    frame(service);
    expect(overlayOf(stage, 1)).toBeUndefined();
  });
});

describe('lighting: раскладка раз на трансформ сцены', () => {
  it('многократный render() за тик раскладывает источники один раз', () => {
    const { service, stage } = setup();
    const layout = spyLayout();

    makeParts(service, 'a', nightLighting());
    frame(service);

    const calls = layout.mock.calls.length;

    service.render();
    service.render();
    expect(layout.mock.calls.length).toBe(calls);

    // новый трансформ в том же тике (кадр камеры) — свежая раскладка
    stage.position.x += 5;
    service.render();
    expect(layout.mock.calls.length).toBe(calls + 1);
  });
});

describe('lighting: источник в нескольких уровнях', () => {
  it('источник с levels [0, 1] попадает в раскладку обоих уровней', () => {
    const { service } = setup();
    const layout = spyLayout();

    service.registerTextures(textures());
    makeParts(service, 'k', nightLighting([]), { 1: [[0, 0]] });
    service.addLight({ kind: 'radial', radius: 40, z: 0.6, level: 1, levels: [0, 1] });
    frame(service);

    expect(lastItems(layout, 0)).toHaveLength(1);
    expect(lastItems(layout, 1)).toHaveLength(1);
  });

  it('уровень без карты освещённости пропускается', () => {
    const { service } = setup();
    const layout = spyLayout();

    service.registerTextures(textures());
    makeParts(service, 'k', nightLighting([]));
    service.addLight({ kind: 'radial', radius: 40, z: 0.6, level: 1, levels: [0, 1] });
    frame(service);

    expect(lastItems(layout, 0)).toHaveLength(1);
    expect(lastItems(layout, 1)).toBeNull();
  });
});

describe('lighting: выключено и день', () => {
  it('enabled:false — все методы no-op', () => {
    const { service, stage } = setup({ ...lighting, enabled: false });

    makeParts(service, 'a', nightLighting());
    service.registerTextures(textures());
    frame(service);

    expect(service.enabled).toBe(false);
    expect(service.isNight()).toBe(false);
    expect(service.addLight({ kind: 'radial' })).toBeNull();
    expect(service.addEmissive(new Sprite(), 0)).toBe(false);
    expect(service.texture('radial')).toBeNull();
    expect(() => service.flash({ radius: 1, duration: 10 })).not.toThrow();
    expect(stage.children).toHaveLength(0);
  });

  it('night:false — оверлеев нет, addEmissive возвращает false', () => {
    const { service, stage } = setup();

    makeParts(service, 'a', { night: false, lamps: [{ cell: [1, 1] }] });
    service.registerTextures(textures());
    frame(service);

    expect(service.isNight()).toBe(false);
    expect(service.addEmissive(new Sprite(), 0)).toBe(false);
    expect(stage.children).toHaveLength(0);
  });

  it('карта без game.lighting — день', () => {
    const { service } = setup();

    makeParts(service, 'a', undefined);

    expect(service.isNight()).toBe(false);
  });
});

describe('lighting: clear()', () => {
  it('снимает оверлеи со сцены ДО destroy', () => {
    const { service, stage } = setup();
    const parents = [];
    const original = LevelLightMap.prototype.destroy;

    vi.spyOn(LevelLightMap.prototype, 'destroy').mockImplementation(
      function destroy() {
        parents.push(this.overlay.parent);
        original.call(this);
      },
    );

    const parts = makeParts(service, 'a', nightLighting(), { 1: [[0, 0]] });

    frame(service);
    releaseParts(service, 'a', parts);

    expect(parents).toEqual([null, null]);
    expect(overlays(stage)).toHaveLength(0);
  });

  it('не трогает текстуры, источники addLight и записи эмиссива', () => {
    const { service, stage } = setup();
    const assets = textures();
    const layout = spyLayout();

    service.registerTextures(assets);

    let parts = makeParts(service, 'a', nightLighting([]));
    const light = service.addLight({ kind: 'radial', radius: 20, level: 0 });
    const sprite = new Sprite();

    expect(service.addEmissive(sprite, 0)).toBe(true);
    frame(service);

    service.clear();

    expect(service.texture('radial')).toBe(assets.radial);
    expect(sprite.destroyed).toBe(false);
    expect(sprite.parent).toBeNull();

    // та же ночная карта снова: источник и спрайт на месте без повторной
    // регистрации
    releaseParts(service, 'a', parts);
    parts = makeParts(service, 'a', nightLighting([]));
    frame(service);

    expect(sprite.parent).toBe(emissiveOf(stage, 0));
    expect(lastItems(layout, 0)).toHaveLength(1);

    service.removeLight(light);
    frame(service);
    // трансформ тот же, но тик новый — раскладка есть и пустая
    expect(lastItems(layout, 0)).toHaveLength(0);
  });

  it('acquire ×3 → release ×3 → acquire того же ключа создаёт новые оверлеи', () => {
    const { service, stage } = setup();
    const parts = makeParts(service, 'a', nightLighting(), { 1: [[0, 0]], 2: [[0, 0]] });

    frame(service);

    const before = overlayOf(stage, 0);

    releaseParts(service, 'a', parts);
    expect(service.isNight()).toBe(false);
    expect(before.destroyed).toBe(true);

    makeParts(service, 'a', nightLighting());
    frame(service);

    expect(service.isNight()).toBe(true);
    expect(overlayOf(stage, 0)).toBeDefined();
    expect(overlayOf(stage, 0)).not.toBe(before);
  });
});

describe('lighting: registerTextures', () => {
  it('перезаписывает переданные ключи и не трогает остальные', () => {
    const { service } = setup();
    const first = textures();
    const second = textures();

    service.registerTextures({ radial: first.radial, head: first.head });
    service.registerTextures({ cone: first.cone });
    service.registerTextures({ radial: second.radial });

    expect(service.texture('radial')).toBe(second.radial);
    expect(service.texture('head')).toBe(first.head);
    expect(service.texture('cone')).toBe(first.cone);
  });

  it('свежая head заменяет текстуру у эмиссива со старой', () => {
    const { service } = setup();
    const first = textures();
    const second = textures();

    service.registerTextures({ head: first.head });
    makeParts(service, 'a', nightLighting([]));

    const glare = new Sprite(first.head.texture);

    service.addEmissive(glare, 0);
    service.registerTextures({ head: second.head });

    expect(glare.texture).toBe(second.head.texture);
  });

  it('фонари появляются в любом порядке acquireMap и регистрации текстур', () => {
    for (const order of ['texturesFirst', 'mapFirst']) {
      const { service, stage } = setup();
      const layout = spyLayout();

      if (order === 'texturesFirst') {
        service.registerTextures({ radial: textures().radial, head: textures().head });
        makeParts(service, 'a', nightLighting());
      } else {
        makeParts(service, 'a', nightLighting());
        frame(service);
        service.registerTextures({ radial: textures().radial, head: textures().head });
      }

      frame(service);

      expect(lastItems(layout, 0)).toHaveLength(1);
      expect(lampHeadsOf(stage, 0).children).toHaveLength(1);

      vi.restoreAllMocks();
    }
  });

  it('голова фонаря — светильник в асфальте: над дорогой, под танком', () => {
    const { service, stage } = setup();

    service.registerTextures({ radial: textures().radial, head: textures().head });
    makeParts(service, 'a', nightLighting());
    frame(service);

    const heads = lampHeadsOf(stage, 0);

    // дорога и следы — база 1, эффекты — 2, танк — 3
    expect(heads.zIndex).toBe(levelZ(LAMP_HEAD_BASE_Z, 0));
    expect(heads.zIndex).toBeGreaterThan(levelZ(1, 0));
    expect(heads.zIndex).toBeLessThan(levelZ(2, 0));
    expect(heads.children).toHaveLength(1);
    expect(emissiveOf(stage, 0)?.children ?? []).toHaveLength(0);
  });

  it('flash без radial и конус без cone — no-op без ошибки', () => {
    const { service } = setup();
    const layout = spyLayout();

    makeParts(service, 'a', nightLighting([]));
    service.addLight({ kind: 'cone', radius: 90, level: 0 });

    expect(() =>
      service.flash({ level: 0, x: 0, y: 0, radius: 40, duration: 100 }),
    ).not.toThrow();
    frame(service);

    expect(lastItems(layout, 0)).toHaveLength(0);
  });

  it('вспышка затухает и уходит после duration', () => {
    const { service } = setup();
    const layout = spyLayout();

    service.registerTextures(textures());
    makeParts(service, 'a', nightLighting([]));
    service.flash({ level: 0, x: 0, y: 0, radius: 40, intensity: 1, duration: 40 });
    frame(service);

    expect(lastItems(layout, 0)).toHaveLength(1);

    frame(service);
    frame(service);
    frame(service);

    expect(lastItems(layout, 0)).toHaveLength(0);
  });
});

describe('lighting: releaseMap и ключи', () => {
  it('на нуле текущего ключа — clear(), не на нуле — нет', () => {
    const { service } = setup();
    const parts = makeParts(service, 'a', nightLighting(), { 1: [[0, 0]] });

    service.releaseMap('a', parts[0]);
    expect(service.isNight()).toBe(true);

    service.releaseMap('a', parts[1]);
    expect(service.isNight()).toBe(false);
  });

  it('на нуле СТАРОГО ключа clear() не зовётся (обратный порядок)', () => {
    const { service, stage } = setup();
    const layout = spyLayout();

    service.registerTextures(textures());

    const oldParts = makeParts(service, 'a', nightLighting([{ cell: [1, 1], radius: 50 }]));

    // новые части раньше старых
    makeParts(
      service,
      'b',
      nightLighting([
        { cell: [2, 2], radius: 50 },
        { cell: [3, 3], radius: 50 },
      ]),
    );
    releaseParts(service, 'a', oldParts);
    frame(service);

    expect(service.isNight()).toBe(true);
    expect(overlayOf(stage, 0)).toBeDefined();
    expect(lastItems(layout, 0)).toHaveLength(2);
  });
});

describe('lighting: смена карты в порядке движка', () => {
  it('две карты одного размера с разными lamps — видны фонари новой', () => {
    const { service, stage } = setup();
    const layout = spyLayout();

    service.registerTextures(textures());

    const oldParts = makeParts(service, 'a', nightLighting([{ cell: [1, 1], radius: 50 }]));

    frame(service);
    releaseParts(service, 'a', oldParts);
    makeParts(
      service,
      'b',
      nightLighting([
        { cell: [2, 2], radius: 50 },
        { cell: [4, 4], radius: 50 },
      ]),
    );
    frame(service);

    const items = lastItems(layout, 0);

    expect(items).toHaveLength(2);
    expect(items[0].x).toBeCloseTo(2.5 * STEP);
    expect(overlayOf(stage, 0)).toBeDefined();
  });

  it('один ключ, разные этажи — маска только из клеток новой карты', () => {
    const { service } = setup();
    const setMask = vi.spyOn(LevelLightMap.prototype, 'setMask');
    const cfg = nightLighting([]);

    const oldParts = makeParts(service, 'k', cfg, { 1: [[0, 0], [1, 0]] });

    frame(service);
    releaseParts(service, 'k', oldParts);
    makeParts(service, 'k', cfg, { 1: [[5, 5]] });
    frame(service);

    const runs = setMask.mock.calls[setMask.mock.calls.length - 1][0];

    expect(runs).toEqual([{ col: 5, row: 5, length: 1 }]);
  });

  it('живой танк переживает ночь → ночь без повторной регистрации', () => {
    const { service, stage } = setup();
    const layout = spyLayout();

    service.registerTextures(textures());

    let parts = makeParts(service, 'a', nightLighting([]));
    const cone = service.addLight({ kind: 'cone', radius: 90, level: 0 });
    const glare = new Sprite(service.texture('head').texture);

    expect(service.addEmissive(glare, 0)).toBe(true);

    releaseParts(service, 'a', parts);
    parts = makeParts(service, 'b', nightLighting([]));
    frame(service);

    expect(lastItems(layout, 0)).toHaveLength(1);
    expect(lastItems(layout, 0)[0].texture).toBe(service.texture('cone').texture);
    expect(glare.parent).toBe(emissiveOf(stage, 0));
    expect(cone.radius).toBe(90);
  });

  it('ночь → день → ночь: блик скрыт днём и возвращается ночью', () => {
    const { service, stage } = setup();

    service.registerTextures(textures());

    let parts = makeParts(service, 'a', nightLighting([]));
    const glare = new Sprite();

    service.addEmissive(glare, 0);
    frame(service);
    expect(glare.parent).toBe(emissiveOf(stage, 0));

    releaseParts(service, 'a', parts);
    parts = makeParts(service, 'day', { night: false });
    frame(service);
    expect(glare.parent).toBeNull();
    expect(service.addEmissive(new Sprite(), 0)).toBe(false);

    releaseParts(service, 'day', parts);
    makeParts(service, 'c', nightLighting([]));
    frame(service);
    expect(glare.parent).toBe(emissiveOf(stage, 0));
  });
});

describe('lighting: эмиссив', () => {
  it('removeEmissive вынимает спрайт, но не уничтожает его', () => {
    const { service } = setup();

    makeParts(service, 'a', nightLighting([]));

    const sprite = new Sprite();

    service.addEmissive(sprite, 0);
    service.removeEmissive(sprite);

    expect(sprite.parent).toBeNull();
    expect(sprite.destroyed).toBe(false);
  });

  it('повторный addEmissive переносит спрайт на другой уровень', () => {
    const { service, stage } = setup();

    makeParts(service, 'a', nightLighting([]));

    const sprite = new Sprite();

    service.addEmissive(sprite, 0);
    service.addEmissive(sprite, 1);
    frame(service);

    expect(sprite.parent).toBe(emissiveOf(stage, 1));
    expect(emissiveOf(stage, 0).children).toHaveLength(0);
  });
});

// Крыши (`game.roofs`) — отдельная карта уровня со своей дырой, вершины
// объёмов — полумрак поверх источников.
describe('lighting: крыши и вершины объёмов', () => {
  // карты освещённости, прошедшие раскладку в последнем кадре
  const levelMaps = spy => [...new Set(spy.mock.contexts)];

  it('вклад с { roof: true } — своя карта, обычная маска без клеток крыш', () => {
    const { service, stage } = setup();
    const setMask = vi.spyOn(LevelLightMap.prototype, 'setMask');
    const slab = {};
    const roof = {};

    makeParts(service, 'k', nightLighting([]));
    service.setLevelMask(1, [[0, 0], [1, 0]], slab);
    service.setLevelMask(1, [[1, 0]], roof, { roof: true });
    frame(service);

    expect(overlayOf(stage, 1)).toBeDefined();
    expect(stage.children.find(child => child.label === 'lighting-roof-1')).toBeDefined();

    const runsOf = isRoof => {
      const index = setMask.mock.contexts.findIndex(map => map.roof === isRoof);

      return setMask.mock.calls[index][0];
    };

    expect(runsOf(false)).toEqual([{ col: 0, row: 0, length: 1 }]);
    expect(runsOf(true)).toEqual([{ col: 1, row: 0, length: 1 }]);
  });

  it('дыра карты крыш открывается, только когда крыша закрывает танк', () => {
    const { service, levelView } = setup();
    const layout = spyLayout();
    const k = parallax.shear;

    service.registerTextures(textures());
    makeParts(service, 'k', nightLighting([]));
    service.setLevelMask(1, [[5, 5]], {});
    service.setLevelMask(1, [[1, 0]], {}, { roof: true });

    // игрок на земле далеко от крыши: обычная карта открывает дыру, крыш — нет
    levelView.set(0, -300, -300, 0);

    for (let i = 0; i < 200; i += 1) {
      frame(service);
    }

    const maps = levelMaps(layout);
    const roofMap = maps.find(map => map.roof);
    const slabMap = maps.find(map => !map.roof && map.level === 1);

    expect(roofMap.hole.attached).toBe(false);
    expect(slabMap.hole.attached).toBe(true);

    // камера в (0, 0): центр клетки (48, 16) нарисован в w · (1 + k)
    levelView.set(0, 48 * (1 + k), 16 * (1 + k), 0);

    for (let i = 0; i < 200; i += 1) {
      frame(service);
    }

    expect(roofMap.hole.attached).toBe(true);
  });

  it('setVolumeTops рисует вершины, releaseMap снимает их вместе с владельцем', () => {
    const { service } = setup();
    const layout = spyLayout();
    const walls = {};

    makeParts(service, 'k', nightLighting([]));
    service.acquireMap('k', nightLighting([]), STEP, 1);
    service.setVolumeTops(0, [[0, 0], [1, 0]], 1, walls);
    frame(service);

    const ground = levelMaps(layout).find(map => map.level === 0);

    expect(ground.topGroups).toHaveLength(1);
    expect(ground.topGroups[0].volume).toBe(1);
    expect(ground.tops.children).toHaveLength(1);

    service.releaseMap('k', walls);
    frame(service);

    expect(ground.topGroups).toHaveLength(0);
    expect(ground.tops.children).toHaveLength(0);
  });
});

// Область фильтра оверлея — мировой прямоугольник карты (`filterArea`), а не
// экран через `boundsArea`: для `boundsArea` Pixi 8.19 применяет трансформ
// сцены дважды, и при камере вдали от начала карты фильтр пропускался —
// белый экран или пропавшая ночь
describe('lighting: область фильтра оверлея', () => {
  const size = { cols: 10, rows: 5 };
  const area = { x: -320, y: -320, width: 960, height: 800 };

  it('lightArea — карта плюс запас в её большую сторону', () => {
    expect(lightArea(size, STEP, { x: 1, y: 1 })).toEqual(area);
    expect(lightArea(size, STEP, { x: 0.5, y: 0.5 })).toEqual({
      x: -160,
      y: -160,
      width: 480,
      height: 400,
    });
  });

  it('оверлей мировой: filterArea и фон покрывают карту, boundsArea нет', () => {
    const { service, stage } = setup();

    service.acquireMap('k', nightLighting([]), STEP, 1, size);
    frame(service);

    const overlay = overlayOf(stage, 0);
    const base = overlay.children[0];

    expect(overlay.boundsArea).toBeFalsy();
    expect(overlay.filterArea).toMatchObject(area);
    expect(overlay.position.x).toBe(0);
    expect(overlay.position.y).toBe(0);
    expect(overlay.scale.x).toBe(1);
    expect(base.x).toBe(area.x);
    expect(base.y).toBe(area.y);
    expect(base.width).toBe(area.width);
    expect(base.height).toBe(area.height);
  });

  it('ресайз экрана и смена камеры не трогают область и трансформ оверлея', () => {
    const levelView = createLevelView();
    const service = createLighting(lighting, { levelView });
    const stage = new Container();
    const screenNow = { width: 800, height: 600 };

    stage.sortableChildren = true;
    service.attachStage(stage, { screen: screenNow });
    service.acquireMap('k', nightLighting([]), STEP, 1, size);
    service.setLevelMask(1, [[1, 1]], {});
    frame(service);

    // камера далеко на востоке, зум и окно другие
    screenNow.width = 500;
    screenNow.height = 900;
    stage.scale.set(0.6);
    stage.position.set(-2500, -900);
    frame(service);

    for (const level of [0, 1]) {
      const overlay = overlayOf(stage, level);

      expect(overlay.filterArea).toMatchObject(area);
      expect(overlay.position.x).toBe(0);
      expect(overlay.scale.x).toBe(1);
    }
  });

  it('область фильтра переживает замену цепочки фильтров (дыра)', () => {
    const map = new LevelLightMap({
      level: 1,
      ambient: 0x3a4260,
      resolution: 0.5,
      area,
    });
    const other = new AlphaFilter();

    map.overlay.filters = [other];
    map.overlay.filters = [];
    map.overlay.filters = [map.filter];

    expect(map.overlay.filterArea).toMatchObject(area);

    other.destroy();
    map.destroy();
  });
});

describe('lighting: засветы (lightsAt, onScreen)', () => {
  const lampAt = (cell, extra = {}) =>
    nightLighting([{ cell, radius: 50, head: true, ...extra }]);

  it('фонарь своего уровня светит в точку рядом, дальше радиуса — нет', () => {
    const { service } = setup();

    service.registerTextures(textures());
    makeParts(service, 'a', lampAt([1, 1]));
    Ticker.shared.lastTime += 16;

    const [hit] = service.lightsAt(60, 48, 0);

    expect(hit.light.x).toBe(48);
    expect(hit.strength).toBeGreaterThan(0);
    // направление от точки на фонарь — влево
    expect(Math.abs(hit.angle)).toBeCloseTo(Math.PI);
    expect(hit.color).toBe(0xffc070);
    expect(service.lightsAt(400, 400, 0)).toEqual([]);
    // фонарь уровня 0 не светит на плиту уровня 1
    expect(service.lightsAt(60, 48, 1)).toEqual([]);
  });

  it('чужая фара — источник, своя (exclude) и свет под корпусом — нет', () => {
    const { service } = setup();

    makeParts(service, 'a', lampAt([30, 30]));

    const cone = service.addLight({
      kind: 'cone',
      x: 0,
      y: 0,
      radius: 100,
      spread: 0.5,
      rotation: 0,
    });

    service.addLight({ kind: 'radial', x: 40, y: 0, radius: 60 });
    Ticker.shared.lastTime += 16;

    expect(service.lightsAt(40, 0, 0)[0].light).toBe(cone);
    expect(service.lightsAt(40, 0, 0, 1, [cone])).toEqual([]);
  });

  it('вспышка светит, пока не погасла', () => {
    const { service } = setup();

    service.registerTextures(textures());
    makeParts(service, 'a', lampAt([30, 30]));
    service.flash({ x: 0, y: 0, radius: 80, duration: 100 });

    expect(service.lightsAt(10, 0, 0)).toHaveLength(1);

    Ticker.shared.lastTime += 200;

    expect(service.lightsAt(10, 0, 0)).toEqual([]);
  });

  it('днём и без сервиса ночи засвета нет', () => {
    const { service } = setup();

    makeParts(service, 'a', { night: false, lamps: [] });

    expect(service.lightsAt(0, 0, 0)).toEqual([]);

    const off = createLighting({ ...lighting, enabled: false });

    expect(off.lightsAt(0, 0, 0)).toEqual([]);
    expect(off.onScreen(0, 0, 0, 10)).toBe(false);
  });

  it('бюджет: не больше maxLights засветов за тик, новый тик — заново', () => {
    const { service } = setup({ ...lighting, maxLights: 2 });

    makeParts(service, 'a', lampAt([1, 1]));
    Ticker.shared.lastTime += 16;

    expect(service.lightsAt(50, 48, 0)).toHaveLength(1);
    expect(service.lightsAt(52, 48, 0)).toHaveLength(1);
    expect(service.lightsAt(54, 48, 0)).toEqual([]);

    Ticker.shared.lastTime += 16;

    expect(service.lightsAt(54, 48, 0)).toHaveLength(1);
  });

  it('onScreen: точка у камеры видна, далеко за краем — нет', () => {
    const { service } = setup();

    makeParts(service, 'a', lampAt([1, 1]));

    expect(service.onScreen(0, 0, 0, 10)).toBe(true);
    expect(service.onScreen(5000, 0, 0, 10)).toBe(false);
  });
});

describe('lighting: лучи фонарей и тени', () => {
  const shaftAsset = () => ({ texture: sized(262, 262), contentSize: 256 });
  const spyShafts = () => vi.spyOn(LevelLightMap.prototype, 'layoutShafts');
  const lastShafts = (spy, level) => {
    for (let i = spy.mock.calls.length - 1; i >= 0; i -= 1) {
      if (spy.mock.contexts[i].level === level) {
        return spy.mock.calls[i][0];
      }
    }

    return null;
  };

  const withShaft = (cfg = lighting, lamps) => {
    const env = setup(cfg);

    env.service.registerTextures({ ...textures(), shaft: shaftAsset() });
    makeParts(env.service, 'a', nightLighting(lamps));

    return env;
  };

  it('фонарь с головой получает лучи: радиус — length · радиус фонаря', () => {
    const spy = spyShafts();
    const { service } = withShaft();

    frame(service);

    const [item] = lastShafts(spy, 0);

    expect(item.x).toBeCloseTo(48);
    expect(item.y).toBeCloseTo(48);
    expect(item.scale).toBeCloseTo((50 * lighting.shafts.length * 2) / 256);
    expect(item.alpha).toBeCloseTo(lighting.shafts.intensity * 0.9);
    expect(item.color).toBe(0xffc070);
    expect(item.shadows).toEqual([]);
  });

  it('без головы, без текстуры или с выключенными лучами — лучей нет', () => {
    let spy = spyShafts();
    let env = withShaft(lighting, [{ cell: [1, 1], radius: 50 }]);

    frame(env.service);
    expect(lastShafts(spy, 0)).toEqual([]);

    vi.restoreAllMocks();
    spy = spyShafts();
    env = withShaft({ ...lighting, shafts: { ...lighting.shafts, enabled: false } });
    frame(env.service);
    expect(lastShafts(spy, 0)).toEqual([]);

    vi.restoreAllMocks();
    spy = spyShafts();
    env = setup();
    env.service.registerTextures(textures());
    makeParts(env.service, 'a', nightLighting());
    frame(env.service);
    expect(lastShafts(spy, 0)).toEqual([]);
  });

  it('предмет в лучах своего уровня бросает клин, чужого уровня — нет', () => {
    const spy = spyShafts();
    const { service } = withShaft();
    const tank = {};
    const upstairs = {};

    service.setCaster(tank, { x: 68, y: 48, z: 0, level: 0, radius: 5 });
    service.setCaster(upstairs, { x: 48, y: 68, z: 1, level: 1, radius: 5 });
    frame(service);

    const [item] = lastShafts(spy, 0);

    expect(item.shadows).toHaveLength(1);
    // клин лежит за предметом, прочь от фонаря
    expect(item.shadows[0][2]).toBeGreaterThan(68);

    service.setCaster(tank, null);
    frame(service);

    expect(lastShafts(spy, 0)[0].shadows).toEqual([]);
  });

  it('теней на фонарь — не больше maxShadowCasters, ближайшие', () => {
    const spy = spyShafts();
    const { service } = withShaft();

    for (let i = 0; i < 6; i += 1) {
      service.setCaster({}, { x: 58 + i * 5, y: 48, z: 0, level: 0, radius: 1 });
    }

    frame(service);

    expect(lastShafts(spy, 0)[0].shadows).toHaveLength(
      lighting.shafts.maxShadowCasters,
    );
  });

  it('shadows: false — лучи без теней', () => {
    const spy = spyShafts();
    const { service } = withShaft({
      ...lighting,
      shafts: { ...lighting.shafts, shadows: false },
    });

    service.setCaster({}, { x: 68, y: 48, z: 0, level: 0, radius: 5 });
    frame(service);

    expect(lastShafts(spy, 0)[0].shadows).toEqual([]);
  });

  it('LevelLightMap: тени — инверсная маска контейнера лучей, без теней маски нет', () => {
    const levelMap = new LevelLightMap({
      level: 0,
      ambient: 0x3a4260,
      resolution: 0.5,
      area: { x: 0, y: 0, width: 100, height: 100 },
    });
    const item = {
      texture: sized(262, 262),
      x: 10,
      y: 20,
      scale: 0.5,
      rotation: 0.1,
      color: 0xffc070,
      alpha: 0.3,
      shadows: [[0, 0, 10, 0, 10, 10, 0, 10]],
    };

    levelMap.layoutShafts([item]);

    const [entry] = levelMap.shaftPool;

    expect(entry.sprite.blendMode).toBe('add');
    expect(entry.sprite.alpha).toBeCloseTo(0.3);
    expect(entry.container.mask).toBe(entry.shadow);
    expect(entry.container._maskOptions.inverse).toBe(true);

    levelMap.layoutShafts([{ ...item, shadows: [] }]);

    // геттер Pixi без маски отдаёт undefined
    expect(entry.container.mask).toBeFalsy();
    expect(entry.shadow.visible).toBe(false);

    // лишние записи пула прячутся, а не уничтожаются
    levelMap.layoutShafts([]);

    expect(entry.container.visible).toBe(false);

    levelMap.destroy();
  });
});

describe('lighting: свет верхнего уровня на рампах', () => {
  // рампа 0 → 1: клетки 2..5 × 1..2, в гриде уровня 0
  const lane = { axis: 0, sign: 1, from: 0, to: 1, col0: 2, col1: 5, row0: 1, row1: 2 };
  const spyRamps = () => vi.spyOn(LevelLightMap.prototype, 'layoutRamps');
  const lastRamps = (spy, level) => {
    for (let i = spy.mock.calls.length - 1; i >= 0; i -= 1) {
      if (spy.mock.contexts[i].level === level) {
        return spy.mock.calls[i][0];
      }
    }

    return null;
  };

  // карта с плитой уровня 1 и рампой 0 → 1 от части уровня 0
  const withRamp = (cfg = lighting) => {
    const env = setup(cfg);

    env.service.registerTextures(textures());
    env.parts = makeParts(env.service, 'a', nightLighting([]), { 1: [[6, 1]] });
    env.service.setRampWedges(0, [lane], env.parts[0]);

    return env;
  };

  const coneAt = (service, extra) =>
    service.addLight({
      kind: 'cone',
      x: 200,
      y: 40,
      radius: 90,
      rotation: Math.PI,
      level: 1,
      z: 1,
      ...extra,
    });

  it('источник уровня 1 кладётся в rampLights уровня 0, а не в его обычные источники', () => {
    const layout = spyLayout();
    const rampSpy = spyRamps();
    const { service } = withRamp();

    coneAt(service);
    frame(service);

    expect(lastItems(layout, 1)).toHaveLength(1);
    expect(lastItems(layout, 0)).toEqual([]);
    expect(lastRamps(rampSpy, 0)).toHaveLength(1);
    expect(lastRamps(rampSpy, 0)[0].alpha).toBeCloseTo(lighting.rampSpill);
    // у плиты рамп нет
    expect(lastRamps(rampSpy, 1)).toEqual([]);
  });

  it('танк на рампе (levels [0, 1]) не даёт двойного вклада в клин', () => {
    const rampSpy = spyRamps();
    const layout = spyLayout();
    const { service } = withRamp();

    coneAt(service, { level: 0, levels: [0, 1], z: 0.6 });
    frame(service);

    expect(lastItems(layout, 0)).toHaveLength(1);
    expect(lastRamps(rampSpy, 0)).toEqual([]);
  });

  it('источник уровня 0 на рампы уровня 0 сверху не попадает', () => {
    const rampSpy = spyRamps();
    const { service } = withRamp();

    coneAt(service, { level: 0, z: 0 });
    frame(service);

    expect(lastRamps(rampSpy, 0)).toEqual([]);
  });

  it('rampSpill ослабляет свет на клине, 0 — выключает', () => {
    let rampSpy = spyRamps();
    let env = withRamp({ ...lighting, rampSpill: 0.5 });

    coneAt(env.service);
    frame(env.service);
    expect(lastRamps(rampSpy, 0)[0].alpha).toBeCloseTo(0.5);

    vi.restoreAllMocks();
    rampSpy = spyRamps();
    env = withRamp({ ...lighting, rampSpill: 0 });
    coneAt(env.service);
    frame(env.service);
    expect(lastRamps(rampSpy, 0)).toEqual([]);
  });

  it('лимит maxLights считает и спрайты на клиньях', () => {
    const rampSpy = spyRamps();
    const layout = spyLayout();
    const { service } = withRamp({ ...lighting, maxLights: 1 });

    coneAt(service);
    frame(service);

    expect(lastItems(layout, 1)).toHaveLength(1);
    expect(lastRamps(rampSpy, 0)).toEqual([]);
  });

  it('маска — только клинья рамп, ведущих вверх с уровня; releaseMap снимает', () => {
    const setRamps = vi.spyOn(LevelLightMap.prototype, 'setRamps');
    const { service, parts } = withRamp();
    const descending = { ...lane, from: 1, to: 0 };

    service.setRampWedges(1, [descending], parts[1]);
    frame(service);

    const mapOf = level =>
      setRamps.mock.contexts.find(context => context.level === level);
    const ground = mapOf(0);

    expect(ground.ramps).toEqual([lane]);
    expect(ground.rampLights.mask).toBe(ground.rampMask);
    // нисходящая полоса (`from > to`) освещена картой своего уровня
    expect(mapOf(1).ramps).toEqual([]);

    service.releaseMap('a', parts[0]);
    frame(service);

    expect(ground.ramps).toEqual([]);
    expect(ground.rampLights.mask).toBeFalsy();
  });
});

// Фары и стены (этап 12): конус у стены рисуется веером по полигону
// видимости, ось, упёршаяся в стену, даёт отсвет; засвет за стеной не
// считается. Клетка 32 × 32, стены — вершины объёмов уровня (`setVolumeTops`)
describe('lighting: фары и стены', () => {
  const size = { cols: 20, rows: 20 };
  // столбец клеток 3 (x 96..128) — стена
  const column = Array.from({ length: 20 }, (_, row) => [3, row]);

  const scene = ({ cfg = lighting, walls = column } = {}) => {
    const context = setup(cfg);
    const { service } = context;

    service.registerTextures(textures());
    service.acquireMap('w', nightLighting([]), STEP, 1, size);
    service.setVolumeTops(0, walls, 1, {});

    const cone = service.addLight({
      kind: 'cone',
      level: 0,
      x: 40,
      y: 48,
      z: 0,
      radius: 90,
      spread: 0.5,
      rotation: 0,
      intensity: 0.9,
      color: 0xfff1c4,
    });

    return { ...context, cone };
  };
  const withHeadlights = (patch, extra = {}) => ({
    ...lighting,
    ...extra,
    headlights: { ...lighting.headlights, ...patch },
  });
  const coneTexture = service => service.texture('cone').texture;
  const radialTexture = service => service.texture('radial').texture;

  it('конус упёрся в стену — веер, в чистом поле — прежний спрайт', () => {
    const { service } = scene();
    const layout = spyLayout();

    frame(service);

    const [item] = lastItems(layout, 0).filter(
      entry => entry.texture === coneTexture(service),
    );

    expect(item.fan).not.toBeNull();

    // концы лучей не дальше грани стены x = 96
    const { points } = item.fan.shape;

    for (let i = 2; i < points.length; i += 2) {
      expect(points[i]).toBeLessThanOrEqual(96 + 1e-3);
    }

    const open = scene({ walls: [[15, 15]] });
    const openLayout = spyLayout();

    frame(open.service);

    const [free] = lastItems(openLayout, 0).filter(
      entry => entry.texture === coneTexture(open.service),
    );

    expect(free.fan).toBeNull();
  });

  it('отсвет — только при упоре оси в стену', () => {
    const { service } = scene();
    const layout = spyLayout();

    frame(service);

    const bounces = lastItems(layout, 0).filter(
      entry => entry.texture === radialTexture(service),
    );

    expect(bounces).toHaveLength(1);
    // центр — перед стеной, на оси фары
    expect(bounces[0].x).toBeLessThan(96);
    expect(bounces[0].y).toBeCloseTo(48);

    // ось мимо стены (фара смотрит вниз, вдоль стены): отсвета нет
    const side = scene();
    const sideLayout = spyLayout();

    side.service.updateLight(side.cone, { rotation: Math.PI / 2 });
    frame(side.service);

    expect(
      lastItems(sideLayout, 0).filter(
        entry => entry.texture === radialTexture(side.service),
      ),
    ).toHaveLength(0);
  });

  it('стена дальше maxDistance — без отсвета, но веер есть', () => {
    const { service } = scene({
      cfg: withHeadlights({
        bounce: { ...lighting.headlights.bounce, maxDistance: 30 },
      }),
    });
    const layout = spyLayout();

    frame(service);

    const items = lastItems(layout, 0);

    expect(items.filter(entry => entry.texture === radialTexture(service))).toHaveLength(0);
    expect(items.find(entry => entry.fan)).toBeDefined();
  });

  it('окклюзия выключена — прежнее поведение: спрайт, без отсвета', () => {
    const { service } = scene({
      cfg: withHeadlights({
        occlusion: { ...lighting.headlights.occlusion, enabled: false },
      }),
    });
    const layout = spyLayout();

    frame(service);

    const items = lastItems(layout, 0);

    expect(items).toHaveLength(1);
    expect(items[0].fan).toBeNull();
  });

  it('отсвет идёт в счёт maxLights', () => {
    const { service } = scene({ cfg: { ...lighting, maxLights: 1 } });
    const layout = spyLayout();

    frame(service);

    expect(lastItems(layout, 0)).toHaveLength(1);
  });

  it('отсвет раскладывается после фонарей и не вытесняет их из maxLights', () => {
    const context = setup({ ...lighting, maxLights: 2 });
    const { service } = context;

    service.registerTextures(textures());
    service.acquireMap('w', nightLighting([{ cell: [5, 5], radius: 50 }]), STEP, 1, size);
    service.setVolumeTops(0, column, 1, {});
    service.addLight({
      kind: 'cone',
      level: 0,
      x: 40,
      y: 48,
      z: 0,
      radius: 90,
      spread: 0.5,
      rotation: 0,
      intensity: 0.9,
    });

    const layout = spyLayout();

    frame(service);

    const items = lastItems(layout, 0);

    expect(items).toHaveLength(2);
    // конус и фонарь (центр клетки [5, 5] — 176, 176); пятна отсвета нет
    expect(items.some(entry => entry.x === 176 && entry.y === 176)).toBe(true);
    expect(items.some(entry => entry.texture === coneTexture(service))).toBe(true);
  });

  it('конус за экраном не считает веер', () => {
    const { service, cone } = scene();
    const layout = spyLayout();

    service.updateLight(cone, { x: 5000, y: 5000 });
    frame(service);

    expect(lastItems(layout, 0)).toEqual([]);
  });

  it('стоящая фара не пересчитывает веер; сдвинутая — пересчитывает', () => {
    const { service, cone } = scene();
    const layout = spyLayout();
    const fanOf = () =>
      lastItems(layout, 0).find(entry => entry.fan).fan.shape;

    frame(service);

    const first = fanOf();

    frame(service);
    expect(fanOf()).toBe(first);

    service.updateLight(cone, { x: 50 });
    frame(service);
    expect(fanOf()).not.toBe(first);
  });

  it('карта освещённости рисует веер мешем с текстурой конуса', () => {
    const { service } = scene();
    const layout = spyLayout();

    frame(service);

    const ground = layout.mock.contexts.find(map => map.level === 0);
    const [mesh] = ground.fanPool;

    expect(mesh.visible).toBe(true);
    expect(mesh.parent).toBe(ground.lights);
    expect(mesh.texture).toBe(coneTexture(service));
    expect(mesh.blendMode).toBe('add');
    // лучи вперёд, замыкающие назад (rays / 8, не меньше 3) и вершина
    const { rays } = lighting.headlights.occlusion;

    expect(mesh.geometry.positions.length).toBe(
      (rays + Math.max(3, Math.round(rays / 8)) + 1) * 2,
    );
    // веер замкнут: треугольник на каждую пару соседних лучей по кругу
    expect(mesh.geometry.indices.length).toBe(
      (rays + Math.max(3, Math.round(rays / 8))) * 3,
    );
    // спрайта конуса нет — только отсвет
    expect(
      ground.pool.filter(sprite => sprite.visible && sprite.texture === coneTexture(service)),
    ).toHaveLength(0);
  });

  it('засвет: фара за стеной точку не освещает', () => {
    const { service } = scene();

    frame(service);
    Ticker.shared.lastTime += 16;

    // перед стеной — светит, за стеной — нет
    expect(service.lightsAt(80, 48, 0)).toHaveLength(1);
    expect(service.lightsAt(120, 48, 0)).toEqual([]);

    const open = scene({ walls: [[15, 15]] });

    frame(open.service);
    Ticker.shared.lastTime += 16;
    expect(open.service.lightsAt(120, 48, 0)).toHaveLength(1);
  });
});

// Горка — препятствие фарам своего подножия (этап 14): полоса x 64..256,
// y 96..192, подъём на восток с уровня 0 на 1; клетка 32
describe('lighting: фары и рампы', () => {
  const size = { cols: 20, rows: 20 };
  const lane = { axis: 0, sign: 1, from: 0, to: 1, col0: 2, col1: 8, row0: 3, row1: 6 };

  const scene = light => {
    const context = setup();
    const { service } = context;

    service.registerTextures(textures());
    service.acquireMap('r', nightLighting([]), STEP, 1, size);
    service.setRampWedges(0, [lane], {});

    const cone = service.addLight({
      kind: 'cone',
      level: 0,
      z: 0,
      radius: 90,
      spread: 0.5,
      intensity: 0.9,
      color: 0xfff1c4,
      ...light,
    });

    return { ...context, cone };
  };
  const coneItem = (layout, service) =>
    lastItems(layout, 0).find(entry => entry.texture === service.texture('cone').texture);
  const ends = points => {
    const list = [];

    for (let i = 2; i < points.length; i += 2) {
      list.push([points[i], points[i + 1]]);
    }

    return list;
  };

  it('сбоку у верха горки — свет кончается на борту', () => {
    const { service } = scene({ x: 200, y: 48, rotation: Math.PI / 2 });
    const layout = spyLayout();

    frame(service);

    const item = coneItem(layout, service);

    expect(item.fan).not.toBeNull();

    for (const [, y] of ends(item.fan.shape.points)) {
      expect(y).toBeLessThanOrEqual(96 + 1e-3);
    }
  });

  it('за верхним торцом — свет кончается на торце', () => {
    const { service } = scene({ x: 300, y: 144, rotation: Math.PI });
    const layout = spyLayout();

    frame(service);

    for (const [x] of ends(coneItem(layout, service).fan.shape.points)) {
      expect(x).toBeGreaterThanOrEqual(256 - 1e-3);
    }
  });

  it('от подножия вверх по склону — склон освещён', () => {
    const { service } = scene({ x: 40, y: 144, rotation: 0 });
    const layout = spyLayout();

    frame(service);

    const item = coneItem(layout, service);
    const reach = Math.max(...ends(item.fan?.shape.points ?? [0, 0, 999, 0]).map(([x]) => x));

    // ось уходит далеко за подножие x = 64
    expect(reach).toBeGreaterThan(120);
  });

  it('фара на одной рампе: соседняя горка по-прежнему загораживает свет', () => {
    const context = setup();
    const { service } = context;
    // встречная горка: у x = 100 её борт на высоте ≈ 0.8
    const other = { ...lane, sign: -1, row0: 8, row1: 11 };

    service.registerTextures(textures());
    service.acquireMap('r', nightLighting([]), STEP, 1, size);
    service.setRampWedges(0, [lane, other], {});
    // фара у подножия первой горки (z ≈ 0.2) светит на юг, в борт второй
    // (y = 256)
    service.addLight({
      kind: 'cone',
      level: 0,
      x: 100,
      y: 180,
      z: 0.2,
      rotation: Math.PI / 2,
      radius: 90,
      spread: 0.5,
      intensity: 0.9,
    });

    const layout = spyLayout();

    frame(service);

    const item = coneItem(layout, service);

    expect(item.fan).not.toBeNull();

    // лучи над второй горкой (x 64..256) кончаются на её борту
    const over = ends(item.fan.shape.points).filter(([x]) => x > 70 && x < 250);

    expect(over.length).toBeGreaterThan(0);

    for (const [, y] of over) {
      expect(y).toBeLessThanOrEqual(256 + 1e-3);
    }
  });

  it('фара на самой рампе светит как раньше', () => {
    const { service } = scene({ x: 150, y: 144, z: 0.4, rotation: Math.PI / 2 });
    const layout = spyLayout();

    frame(service);

    expect(coneItem(layout, service).fan).toBeNull();
  });

  it('засвет: фара сбоку горки не светит на её склон', () => {
    const { service } = scene({ x: 200, y: 48, rotation: Math.PI / 2 });

    frame(service);
    Ticker.shared.lastTime += 16;

    expect(service.lightsAt(200, 80, 0)).toHaveLength(1);
    expect(service.lightsAt(200, 120, 0)).toEqual([]);
  });
});

describe('LevelLightMap: веера', () => {
  const make = () =>
    new LevelLightMap({
      level: 0,
      ambient: 0x3a4260,
      resolution: 0.5,
      area: { x: 0, y: 0, width: 100, height: 100 },
    });
  const fanItem = shape => ({
    texture: Texture.WHITE,
    color: 0xffffff,
    alpha: 1,
    fan: { shape, x: 0, y: 0, scale: 1 },
  });
  // вершина и `rays` концов лучей
  const shape = (rays, closed) => ({
    points: new Float32Array((rays + 1) * 2),
    uvs: new Float32Array((rays + 1) * 2),
    closed,
  });

  it('индексы меняются со сменой замкнутости, даже при том же их числе', () => {
    const map = make();

    // замкнутый из 4 лучей и открытый из 5 — по 4 треугольника
    map.layout([fanItem(shape(4, true))]);

    const [mesh] = map.fanPool;

    expect([...mesh.geometry.indices]).toEqual([0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1]);

    map.layout([fanItem(shape(5, false))]);
    expect([...mesh.geometry.indices]).toEqual([0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 5]);

    map.destroy();
  });

  it('destroy уничтожает геометрию вееров', () => {
    const map = make();

    map.layout([fanItem(shape(4, true))]);

    const [mesh] = map.fanPool;
    const geometry = mesh.geometry;
    const destroy = vi.spyOn(geometry, 'destroy');

    map.destroy();

    expect(destroy).toHaveBeenCalled();
  });
});
