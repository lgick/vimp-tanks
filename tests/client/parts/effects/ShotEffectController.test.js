import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Container, Texture } from 'pixi.js';
import ShotEffectController from '../../../../src/client/parts/effects/shot/ShotEffectController.js';

// Проверяется проводка якоря попадания, а не отрисовка: контроллер обязан
// пересчитать точку удара по ТЕКУЩЕМУ трансформу задетого ящика и уметь
// обойтись без якоря (авторитетный трассер) и без сервиса (спектатор).
const assets = {
  impactParticleTexture: { texture: Texture.EMPTY, contentSize: 8 },
};

let soundManager;

const created = [];

// сервис mapDynamics (порт core.map_dynamics_to_world): ящик с подвижным
// центром, локальная точка якоря переводится в мировую его трансформом
const makeMapDynamics = box => ({
  box,
  toWorld(key, localX, localY) {
    if (key !== 'd0' || !this.box) {
      return null;
    }

    const cos = Math.cos(this.box.angle);
    const sin = Math.sin(this.box.angle);

    return {
      x: this.box.x + cos * localX - sin * localY,
      y: this.box.y + sin * localX + cos * localY,
    };
  },
});

const makeController = (data, dependencies = {}) => {
  const controller = new ShotEffectController(data, assets, {
    soundManager,
    ...dependencies,
  });
  const stage = new Container();

  stage.addChild(controller);
  created.push(controller);

  return controller;
};

// доводит трассер до конца анимации (дальше контроллер создаёт попадание)
const finishTracer = controller =>
  controller.tracer._update(controller.tracer.animationDuration + 1);

beforeEach(() => {
  soundManager = {
    registerSound: vi.fn(() => 'sound-1'),
    unregisterSound: vi.fn(),
  };
});

afterEach(() => {
  for (const controller of created.splice(0)) {
    if (!controller.destroyed) {
      controller.destroy();
    }
  }
});

describe('ShotEffectController: попадание без якоря', () => {
  it('промах (hit=false): попадание не создаётся', () => {
    const controller = makeController([0, 0, 100, 0, 0, 0, false, 1]);

    controller.run();
    finishTracer(controller);

    expect(controller.impact).toBeNull();
  });

  it('попадание в стену (строка длины 8): эффект в мировой точке удара', () => {
    const controller = makeController([0, 0, 100, 0, 0, 0, true, 1]);

    controller.run();
    finishTracer(controller);

    expect(controller.impact).not.toBeNull();
    expect(controller.impact.x).toBe(100);
    expect(controller.impact.y).toBe(0);
  });

  it('якорь есть, но сервиса нет (спектатор): откат к мировой точке', () => {
    const controller = makeController([0, 0, 100, 0, 0, 0, true, 1, ['d0', -5, 0]]);

    controller.run();
    finishTracer(controller);

    expect(controller.impact.x).toBe(100);
    expect(controller.impact.y).toBe(0);
  });
});

describe('ShotEffectController: попадание в динамику карты (якорь)', () => {
  // ящик с центром (10, 10); якорь (-10, 0) — его левая грань
  let mapDynamics;

  beforeEach(() => {
    mapDynamics = makeMapDynamics({ x: 10, y: 10, angle: 0 });
  });

  it('осколки появляются в мировой точке удара по ящику', () => {
    const controller = makeController([0, 0, 0, 10, 0, 0, true, 1, ['d0', -10, 0]], {
      mapDynamics,
    });

    controller.run();
    finishTracer(controller);

    expect(controller.impact).not.toBeNull();
    expect(controller.impact.x).toBeCloseTo(0, 6);
    expect(controller.impact.y).toBeCloseTo(10, 6);
  });

  it('точка удара берётся из ТЕКУЩЕГО трансформа ящика, а не из момента выстрела', () => {
    const controller = makeController([0, 0, 0, 10, 0, 0, true, 1, ['d0', -10, 0]], {
      mapDynamics,
    });

    controller.run();

    // ящик уехал за время анимации трассера: центр (60, 60),
    // якорь (-10, 0) от центра → точка удара (50, 60)
    mapDynamics.box = { x: 60, y: 60, angle: 0 };

    finishTracer(controller);

    expect(controller.impact.x).toBeCloseTo(50, 6);
    expect(controller.impact.y).toBeCloseTo(60, 6);
  });

  // осколки должны остаться там, где пуля встретила препятствие,
  // и НЕ ехать за ящиком дальше
  it('осколки остаются на месте, когда ящик едет дальше', () => {
    const controller = makeController([0, 0, 0, 10, 0, 0, true, 1, ['d0', -10, 0]], {
      mapDynamics,
    });

    controller.run();
    finishTracer(controller);

    const spawnX = controller.impact.x;
    const spawnY = controller.impact.y;

    mapDynamics.box = { x: 90, y: 90, angle: Math.PI / 2 };
    controller.impact._update(16);

    expect(controller.impact.x).toBe(spawnX);
    expect(controller.impact.y).toBe(spawnY);
  });

  it('ящик исчез (смена карты): откат к точке удара из данных трассера', () => {
    const controller = makeController([0, 0, 0, 10, 0, 0, true, 1, ['d0', -10, 0]], {
      mapDynamics,
    });

    controller.run();

    mapDynamics.box = null;

    finishTracer(controller);

    expect(controller.impact.x).toBe(0);
    expect(controller.impact.y).toBe(10);
  });
});
