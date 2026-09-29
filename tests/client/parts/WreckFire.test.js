import { describe, it, expect, afterEach, vi } from 'vitest';
import { Container, Texture } from 'pixi.js';
import WreckFire from '../../../src/client/parts/WreckFire.js';
import { levelZ } from '../../../src/client/levelZ.js';
import {
  fireEnd,
  emissionEnd,
  fireIntensity,
} from '../../../src/client/wreckTimeline.js';
import { lighting, parallax, wreckFx } from '../../../src/config/render.js';

// Гибель танка: парт ловит переход condition >0 → 0 и ведёт взрыв, пожар
// и дым до их конца; живой танк не стоит ни кадра

const assets = {
  wreckFireTexture: { texture: Texture.EMPTY, contentSize: 64 },
  wreckSmokeTexture: { texture: Texture.EMPTY, contentSize: 16 },
  wreckScorchTexture: {
    textures: [Texture.EMPTY, Texture.EMPTY],
    contentSize: 40,
  },
};

// полный ряд m1: [x, y, angle, gunRotation, vx, vy, engineLoad, condition,
//  size, team, angvel, z, level, vz, pitch, roll]
const row = ({
  x = 100,
  y = 100,
  condition = 3,
  z = 0,
  level = 0,
  size = 3,
  vz = 0,
} = {}) => [x, y, 0, 0, 0, 0, 0, condition, size, 1, 0, z, level, vz, 0, 0];

const makeDeps = () => ({
  renderer: { screen: { width: 800, height: 600 } },
  levelView: { alphaFor: () => 1, tintFor: () => 0xffffff },
  soundManager: { registerSound: vi.fn(() => 's1'), releaseSound: vi.fn() },
  lighting: {
    enabled: true,
    addLight: vi.fn(light => ({ ...light })),
    updateLight: vi.fn(),
    removeLight: vi.fn(),
    flash: vi.fn(),
  },
  blasts: { exploded: vi.fn() },
});

// созданные парты держат слушатель Ticker.shared до destroy()
const created = [];

// парт на сцене (Container): копоть — его сиблинг
const onStage = (data = row(), deps = makeDeps(), partAssets = assets) => {
  const part = new WreckFire(data, partAssets, deps);
  const stage = new Container();

  stage.addChild(part);
  created.push(part);

  return { part, stage, deps };
};

// живой танк на сцене, погибший на глазах
const ignited = (options = {}, deps = makeDeps(), partAssets = assets) => {
  const scene = onStage(row(options), deps, partAssets);

  scene.part.update(row({ ...options, condition: 0 }));

  return scene;
};

// прокрутка времени кадрами по 100 мс; `each` — проверка на каждом шаге
const run = (part, ms, each) => {
  for (let t = 0; t < ms; t += 100) {
    part._tick(100);
    each?.();
  }
};

const scorchesOf = (stage, part) =>
  stage.children.filter(child => child !== part);

afterEach(() => {
  for (const part of created.splice(0)) {
    if (!part.destroyed) {
      part.destroy();
    }
  }
});

describe('WreckFire: простой', () => {
  it('живой танк: ни onRender, ни тикера', () => {
    const { part } = onStage();

    expect(part._onRender).toBe(null);
    expect(part._active).toBe(false);
    expect(part._tickListener).toBe(null);
  });

  it('танк погиб до нас: взрыва нет', () => {
    const { part, deps } = onStage(row({ condition: 0 }));

    part.update(row({ condition: 0 }));

    expect(deps.soundManager.registerSound).not.toHaveBeenCalled();
    expect(deps.blasts.exploded).not.toHaveBeenCalled();
    expect(deps.lighting.flash).not.toHaveBeenCalled();
    expect(part._onRender).toBe(null);
  });
});

describe('WreckFire: взрыв', () => {
  it('переход 3 → 0 зажигает эффект', () => {
    const { part, stage, deps } = ignited();

    // регистрация, а не только тело: onRender — аксессор Container
    expect(typeof part._onRender).toBe('function');
    expect(part._fire.size).toBeGreaterThanOrEqual(wreckFx.fireball.count);
    expect(part._smoke.size).toBeGreaterThanOrEqual(wreckFx.smoke.burst.count);
    expect(deps.soundManager.registerSound).toHaveBeenCalledWith(
      'tankExplosion',
      { position: { x: 100, y: 100 } },
    );
    expect(deps.lighting.flash).toHaveBeenCalledWith(
      expect.objectContaining({ level: 0, x: 100, y: 100 }),
    );
    expect(deps.blasts.exploded).toHaveBeenCalledWith({
      x: 100,
      y: 100,
      radius: 18,
      level: 0,
    });
    expect(deps.lighting.addLight).toHaveBeenCalledTimes(1);

    const scorches = scorchesOf(stage, part);

    expect(scorches).toHaveLength(1);
    expect(scorches[0].zIndex).toBe(levelZ(2, 0));
  });

  it('размер корпуса масштабирует толчок, свет и копоть', () => {
    // корпус вдвое больше опорного — масштаб 2
    const { part, deps } = ignited({ size: wreckFx.referenceSize * 2 });

    expect(deps.blasts.exploded).toHaveBeenCalledWith(
      expect.objectContaining({ radius: wreckFx.joltRadius * 2 }),
    );
    expect(deps.lighting.addLight).toHaveBeenCalledWith(
      expect.objectContaining({ radius: lighting.wreckFire.radius * 2 }),
    );
    expect(part._scorch.scale).toBeCloseTo(
      (wreckFx.scorch.size * 2) / assets.wreckScorchTexture.contentSize,
      6,
    );
  });

  it('вспышка гаснет через flash.duration', () => {
    const { part } = ignited();
    const { duration } = wreckFx.flash;
    // мелкими шагами: `_tick` режет шаг до MAX_TICK_MS
    const advance = ms => {
      for (let t = 0; t < ms; t += 10) {
        part._tick(10);
      }
    };

    expect(part._flash.visible).toBe(true);

    advance(duration - 10);

    expect(part._flash.visible).toBe(true);

    advance(10);

    expect(part._flash.visible).toBe(false);
  });
});

describe('WreckFire: таймлайн', () => {
  it('пожар горит, затем стихает и гасит свет', () => {
    const { part, deps } = ignited();

    run(part, wreckFx.fire.duration / 2);

    expect(part._fire.size).toBeGreaterThan(0);

    const { calls } = deps.lighting.updateLight.mock;

    expect(calls.length).toBeGreaterThan(0);
    expect(calls[calls.length - 1][1].intensity).toBeGreaterThan(0);

    run(
      part,
      fireEnd(wreckFx.fire) +
        wreckFx.fire.lifetime.max -
        wreckFx.fire.duration / 2,
    );

    expect(part._fire.size).toBe(0);
    expect(deps.lighting.removeLight).toHaveBeenCalled();
  });

  it('дым проходит: тикер снят, копоть остаётся со своим onRender', () => {
    const { part } = ignited();

    run(
      part,
      emissionEnd(wreckFx.fire, wreckFx.smoke) + wreckFx.smoke.lifetime.max,
    );

    expect(part._fire.size).toBe(0);
    expect(part._smoke.size).toBe(0);
    expect(part._active).toBe(false);
    expect(part._tickListener).toBe(null);
    expect(typeof part._onRender).toBe('function');
  });

  it('без ассета копоти по окончании onRender снят', () => {
    const noScorch = { ...assets, wreckScorchTexture: undefined };
    const { part } = ignited({}, makeDeps(), noScorch);

    run(
      part,
      emissionEnd(wreckFx.fire, wreckFx.smoke) + wreckFx.smoke.lifetime.max,
    );

    expect(part._active).toBe(false);
    expect(part._onRender).toBe(null);
  });

  it('свет пожара едет за остовом, сила в пределах мерцания', () => {
    const { part, deps } = ignited();

    part.update(row({ condition: 0, x: 150 }));
    part._tick(100);

    const { calls } = deps.lighting.updateLight.mock;
    const [handle, patch] = calls[calls.length - 1];
    const { intensity, flicker } = lighting.wreckFire;
    // сила без мерцания через 100 мс после гибели
    const steady = intensity * fireIntensity(100, wreckFx.fire);

    expect(handle).toBe(part._light);
    expect(patch).toMatchObject({
      x: 150,
      y: 100,
      z: 0,
      level: 0,
      levels: [0],
    });
    expect(patch.intensity).toBeGreaterThanOrEqual(steady * (1 - flicker));
    expect(patch.intensity).toBeLessThanOrEqual(steady);
  });

  it('копоть проявляется за fadeIn и видна через levelView', () => {
    const deps = makeDeps();

    deps.levelView.alphaFor = () => 0.5;

    const { part } = ignited({}, deps);

    expect(part._scorch.alpha).toBe(0);

    run(part, wreckFx.scorch.fadeIn);

    expect(part._scorch.alpha).toBeCloseTo(wreckFx.scorch.alpha, 6);

    part.onRender();

    expect(part._scorch.sprite.alpha).toBeCloseTo(
      wreckFx.scorch.alpha * 0.5,
      6,
    );
  });

  it('потолки каналов не превышаются', () => {
    const { part } = ignited();

    run(part, emissionEnd(wreckFx.fire, wreckFx.smoke), () => {
      expect(part._fire.size).toBeLessThanOrEqual(wreckFx.maxFire);
      expect(part._smoke.size).toBeLessThanOrEqual(wreckFx.maxSmoke);
    });
  });
});

describe('WreckFire: сброс', () => {
  it('респаун посреди пожара гасит всё, повторная гибель зажигает снова', () => {
    const { part, stage, deps } = ignited();
    const fire = part._fire;
    const smoke = part._smoke;

    run(part, 1000);
    part.update(row({ condition: 3 }));

    expect(part._fire.size).toBe(0);
    expect(part._smoke.size).toBe(0);
    expect(deps.lighting.removeLight).toHaveBeenCalled();
    expect(part._onRender).toBe(null);
    expect(scorchesOf(stage, part)).toHaveLength(0);
    expect(deps.soundManager.releaseSound).toHaveBeenCalledWith('s1');

    part.update(row({ condition: 0 }));

    expect(part._active).toBe(true);
    expect(part._fire).toBe(fire);
    expect(part._smoke).toBe(smoke);
    expect(part.children).toHaveLength(4);
    expect(part._fire.size).toBeGreaterThan(0);
  });

  it('destroy посреди пожара', () => {
    const { part, stage, deps } = ignited();

    run(part, 1000);
    part.destroy();

    expect(part.destroyed).toBe(true);
    expect(part._tickListener).toBe(null);
    expect(deps.lighting.removeLight).toHaveBeenCalled();
    expect(scorchesOf(stage, part)).toHaveLength(0);
    expect(deps.soundManager.releaseSound).toHaveBeenCalledWith('s1');
  });
});

describe('WreckFire: проекция 2.5D', () => {
  it('частица на высоте уезжает от центра камеры', () => {
    const { part } = ignited();
    const p = part._smoke.items[0];

    p.h = 1;
    p.x = 100;
    part.onRender();

    // сцена без трансформа: центр камеры — середина полотна (400, 300)
    expect(p.view.x).toBeCloseTo(400 + (100 - 400) * (1 + parallax.shear), 6);
  });

  it('остов на плите: свой слой и проекция контейнера', () => {
    const { part } = ignited({ z: 1, level: 1 });

    expect(part.zIndex).toBe(levelZ(4, 1));

    part.onRender();

    expect(part.scale.x).toBeCloseTo(1 + parallax.shear, 6);
  });

  it('остов сменил уровень — эффект едет на его слой', () => {
    const { part } = ignited();

    part.update(row({ condition: 0, z: 1, level: 1 }));

    expect(part.zIndex).toBe(levelZ(4, 1));
  });

  it('эмиттер едет за остовом, копоть остаётся в точке гибели', () => {
    const { part } = ignited();

    part.update(row({ condition: 0, x: 300 }));
    part._tick(100);
    part.onRender();

    const flames = part._fire.items.filter(p => p.kind === 'flame');

    expect(flames.length).toBeGreaterThan(0);

    for (const p of flames) {
      expect(Math.abs(p.x - 300)).toBeLessThanOrEqual(part._length);
    }

    expect(part._scorch.x).toBe(100);
    expect(part._scorch.sprite.position.x).toBeCloseTo(100, 6);
  });
});

// прыжок с рампы или срыв с моста: в ряду vz ≠ 0, земли под остовом нет
describe('WreckFire: гибель в полёте', () => {
  it('копоть ждёт приземления и ложится в точке касания', () => {
    const { part, stage } = ignited({ z: 0.6, vz: -2 });

    expect(scorchesOf(stage, part)).toHaveLength(0);
    expect(part._scorchPending).toBe(true);

    part.update(row({ condition: 0, x: 130, z: 0, vz: 0 }));

    const scorches = scorchesOf(stage, part);

    expect(scorches).toHaveLength(1);
    expect(part._scorchPending).toBe(false);
    expect(part._scorch.x).toBe(130);
    expect(part._scorch.z).toBe(0);
    expect(scorches[0].zIndex).toBe(levelZ(2, 0));
  });

  it('тикер ждёт копоть', () => {
    const { part } = ignited({ z: 0.6, vz: -2 });

    run(
      part,
      emissionEnd(wreckFx.fire, wreckFx.smoke) + wreckFx.smoke.lifetime.max,
    );

    expect(part._tickListener).not.toBe(null);

    part.update(row({ condition: 0, vz: 0 }));
    run(part, wreckFx.scorch.fadeIn + 100);

    expect(part._tickListener).toBe(null);
    expect(typeof part._onRender).toBe('function');
    expect(part._scorch.alpha).toBeCloseTo(wreckFx.scorch.alpha, 6);
  });

  // респаун приходит ещё в полёте: касание земли живым танком копоть не
  // кладёт (`_reset` снимает ожидание)
  it('респаун до приземления — копоти нет и после касания', () => {
    const { part, stage } = ignited({ z: 0.6, vz: -2 });

    part.update(row({ condition: 3, z: 0.6, vz: -2 }));
    part.update(row({ condition: 3, vz: 0 }));

    expect(part._scorchPending).toBe(false);
    expect(scorchesOf(stage, part)).toHaveLength(0);
  });

  // танк ставится на землю в самом ряду респауна: копоть не создаётся
  // даже на миг (condition разбирается раньше касания)
  it('респаун в ряду с касанием — копоть не создаётся вовсе', () => {
    const { part, stage } = ignited({ z: 0.6, vz: -2 });
    const addChild = vi.spyOn(stage, 'addChild');

    part.update(row({ condition: 3, x: 900, vz: 0 }));

    expect(addChild).not.toHaveBeenCalled();
    expect(part._scorchPending).toBe(false);
    expect(part._scorch).toBe(null);
  });

  it('свет в полёте — только уровень отрисовки, на рампе — два уровня', () => {
    const { part, deps } = ignited({ z: 0.5, vz: -1 });
    const lastPatch = () => deps.lighting.updateLight.mock.calls.at(-1)[1];

    part._tick(100);

    expect(lastPatch().levels).toEqual([0]);

    // склон рампы: z дробный, vz 0 — свет в оба соседних уровня
    part.update(row({ condition: 0, z: 0.5, vz: 0 }));
    part._tick(100);

    expect(lastPatch().levels).toEqual([0, 1]);
  });
});

describe('WreckFire: выключатели', () => {
  it('wreckFx.enabled = false — переход ничего не делает', () => {
    const enabled = wreckFx.enabled;

    wreckFx.enabled = false;

    try {
      const { part, deps } = ignited();

      expect(part._active).toBe(false);
      expect(part._onRender).toBe(null);
      expect(deps.soundManager.registerSound).not.toHaveBeenCalled();
    } finally {
      wreckFx.enabled = enabled;
    }
  });

  it('ночи нет — ни вспышки, ни света', () => {
    const deps = makeDeps();

    deps.lighting.enabled = false;

    const { part } = ignited({}, deps);

    run(part, 500);

    expect(deps.lighting.flash).not.toHaveBeenCalled();
    expect(deps.lighting.addLight).not.toHaveBeenCalled();
    expect(deps.lighting.updateLight).not.toHaveBeenCalled();
    expect(part._light).toBe(null);
  });

  it('без сервисов эффект идёт без исключений', () => {
    const { part } = ignited({}, {});

    expect(() => {
      run(part, 2000);
      part.onRender();
    }).not.toThrow();
    expect(part._active).toBe(true);
  });
});
