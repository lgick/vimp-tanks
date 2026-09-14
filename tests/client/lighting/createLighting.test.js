import { describe, it, expect, vi, afterEach } from 'vitest';
import { Container, Sprite, Texture, TextureSource, Ticker } from 'pixi.js';
import { createLighting } from '../../../src/client/lighting/createLighting.js';
import LevelLightMap from '../../../src/client/lighting/LevelLightMap.js';
import { createLevelView } from '../../../src/client/levelView.js';
import { levelZ } from '../../../src/client/levelZ.js';
import {
  LIGHT_OVERLAY_BASE_Z,
  EMISSIVE_BASE_Z,
} from '../../../src/client/lighting/lightMath.js';
import { lighting } from '../../../src/config/render.js';

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

  it('свежая head заменяет текстуру у бликов со старой', () => {
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
      expect(emissiveOf(stage, 0).children).toHaveLength(1);

      vi.restoreAllMocks();
    }
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
