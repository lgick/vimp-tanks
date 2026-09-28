import { describe, it, expect, afterEach, vi } from 'vitest';
import { Container, Texture } from 'pixi.js';
import WreckFire from '../../../src/client/parts/WreckFire.js';
import { levelZ } from '../../../src/client/levelZ.js';
import { fireEnd, emissionEnd } from '../../../src/client/wreckTimeline.js';
import { parallax, wreckFx } from '../../../src/config/render.js';

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
} = {}) => [x, y, 0, 0, 0, 0, 0, condition, size, 1, 0, z, level, 0, 0, 0];

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
    const { wreckScorchTexture, ...noScorch } = assets;
    const { part } = ignited({}, makeDeps(), noScorch);

    run(
      part,
      emissionEnd(wreckFx.fire, wreckFx.smoke) + wreckFx.smoke.lifetime.max,
    );

    expect(wreckScorchTexture).toBeDefined();
    expect(part._active).toBe(false);
    expect(part._onRender).toBe(null);
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

    expect(part._scorchX).toBe(100);
    expect(part._scorch.position.x).toBeCloseTo(100, 6);
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

  it('без сервисов эффект идёт без исключений', () => {
    const { part } = ignited({}, {});

    expect(() => {
      run(part, 2000);
      part.onRender();
    }).not.toThrow();
    expect(part._active).toBe(true);
  });
});
