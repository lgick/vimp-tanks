import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Container, Texture } from 'pixi.js';
import ExplosionEffectController from '../../../../src/client/parts/effects/explosion/ExplosionEffectController.js';
import { REFERENCE_BLAST_RADIUS } from '../../../../src/client/parts/effects/explosion/SmokeEffect.js';

// Контроллер - единственный, кто знает радиус взрыва: он раздаёт его вспышке
// и воронке, а та - дыму. Без этой проводки эффект любого оружия рисовался бы
// облаком эталонной бомбы.
// contentSize - диаметр нарисованной фигуры (холст шире на запас под размытие)
const assets = {
  explosionTexture: { texture: Texture.EMPTY, contentSize: 100 },
  funnelTexture: {
    textures: [Texture.EMPTY, Texture.EMPTY],
    contentSize: 66,
  },
};

let soundManager;

const created = [];

// формат серверной строки: [x, y, radius]
const makeController = (data = [100, 200, 50]) => {
  const controller = new ExplosionEffectController(data, assets, {
    soundManager,
  });
  const stage = new Container();

  stage.addChild(controller);
  created.push(controller);

  return { controller, stage };
};

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

// прокрутка вспышки до доли её длительности
const advanceExplosion = (explosion, progress) =>
  explosion._update(explosion._durationMs * progress);

describe('ExplosionEffectController: радиус доходит до эффектов', () => {
  it('вспышка и дым масштабируются по радиусу оружия', () => {
    const { controller } = makeController([100, 200, 100]);

    controller.run();

    expect(controller.explosion._radius).toBe(100);
    expect(controller.funnel._smoke._blastScale).toBe(
      100 / REFERENCE_BLAST_RADIUS,
    );
  });

  it('удвоение радиуса удваивает габариты дыма', () => {
    const { controller: reference } = makeController([0, 0, 50]);
    const { controller: bigger } = makeController([0, 0, 100]);

    reference.run();
    bigger.run();

    const referenceSmoke = reference.funnel._smoke;
    const biggerSmoke = bigger.funnel._smoke;

    expect(biggerSmoke._maxTargetSize).toBeCloseTo(
      referenceSmoke._maxTargetSize * 2,
      10,
    );
    expect(biggerSmoke._initialOffsetX).toBeCloseTo(
      referenceSmoke._initialOffsetX * 2,
      10,
    );

    // времена жизни от радиуса не зависят
    expect(biggerSmoke._particleMaxLifeMs).toBe(
      referenceSmoke._particleMaxLifeMs,
    );
  });

  it('без радиуса в данных подставляется эталонный, а не NaN', () => {
    const { controller } = makeController([100, 200]);

    controller.run();

    expect(controller.radius).toBe(REFERENCE_BLAST_RADIUS);
    expect(Number.isFinite(controller.funnel._smoke._blastScale)).toBe(true);
  });

  it('размер воронки нормирован по силуэту и следует радиусу взрыва', () => {
    const { controller } = makeController();

    controller.run();

    // 50 * 0.168 / 66 с разбросом +-15%
    const expected = (50 * 0.168) / assets.funnelTexture.contentSize;
    const scale = controller.funnel._funnel.scale.x;

    expect(scale).toBeGreaterThan(expected * 0.85);
    expect(scale).toBeLessThan(expected * 1.15);
  });
});

describe('ExplosionEffectController: порядок эффектов', () => {
  it('run поднимает вспышку и воронку с дымом сразу', () => {
    const { controller, stage } = makeController();

    controller.run();

    expect(controller.explosion).not.toBeNull();
    expect(controller.funnel).not.toBeNull();
    expect(stage.children).toContain(controller.explosion);
    expect(stage.children).toContain(controller.funnel);
  });

  it('воронка с дымом живёт, пока вспышка догорает', () => {
    const { controller, stage } = makeController();

    controller.run();
    advanceExplosion(controller.explosion, 0.5);

    expect(controller.funnel).not.toBeNull();
    expect(controller.funnel._isStarted).toBe(true);
    expect(stage.children).toContain(controller.funnel);

    // вспышка ещё догорает
    expect(controller.explosion).not.toBeNull();
    expect(controller.explosion.destroyed).toBe(false);
  });

  it('повторный run не поднимает вторую пару эффектов', () => {
    const { controller, stage } = makeController();

    controller.run();

    const explosion = controller.explosion;
    const funnel = controller.funnel;

    controller.run();

    expect(controller.explosion).toBe(explosion);
    expect(controller.funnel).toBe(funnel);

    // контроллер + вспышка + воронка, без осиротевшего дубля
    expect(stage.children).toHaveLength(3);
  });

  it('завершение вспышки уничтожает её, воронка живёт дальше', () => {
    const { controller } = makeController();

    controller.run();
    advanceExplosion(controller.explosion, 0.5);

    const explosion = controller.explosion;
    const funnel = controller.funnel;

    explosion._completeEffect();

    expect(explosion.destroyed).toBe(true);
    expect(controller.explosion).toBeNull();
    expect(controller.funnel).toBe(funnel);
    expect(funnel.destroyed).toBe(false);
  });

  it('воронка проступает не мгновенно, а за время проявления', () => {
    const { controller } = makeController();

    controller.run();

    const funnel = controller.funnel;
    const fadeInMs = funnel._funnelFadeInDurationMs;

    expect(funnel._funnel.alpha).toBe(0);

    funnel._update(fadeInMs / 2);
    const halfAlpha = funnel._funnel.alpha;

    funnel._update(fadeInMs / 2);
    const fullAlpha = funnel._funnel.alpha;

    expect(halfAlpha).toBeGreaterThan(0);
    expect(fullAlpha).toBeGreaterThan(halfAlpha);

    // дальше альфа не растёт
    funnel._update(1000);
    expect(funnel._funnel.alpha).toBeCloseTo(fullAlpha, 5);
  });

  it('нулевое проявление показывает воронку сразу, а не гасит её в NaN', () => {
    const { controller } = makeController();

    controller.run();

    const funnel = controller.funnel;

    funnel._funnelFadeInDurationMs = 0;

    // без защиты это 0/0 на стартовом кадре: alpha уходит в NaN
    // и воронка молча не рисуется всю свою жизнь
    funnel._update(0);

    expect(Number.isNaN(funnel._funnel.alpha)).toBe(false);
    expect(funnel._funnel.alpha).toBeGreaterThan(0);
  });

  it('длинный тик, перепрыгнувший вспышку, не трогает воронку', () => {
    const { controller } = makeController();

    controller.run();

    const funnel = controller.funnel;

    // тик перепрыгнул всю вспышку целиком
    advanceExplosion(controller.explosion, 5);

    expect(controller.explosion).toBeNull();
    expect(controller.funnel).toBe(funnel);
    expect(funnel.destroyed).toBe(false);
  });

  // страховка: уничтожает контроллер только завершение воронки, поэтому
  // на очищенной сцене, где воронку поднять негде, он обязан убрать себя сам -
  // иначе звук, снятый с регистрации только в destroy, останется висеть
  it('run на очищенной сцене уничтожает контроллер и снимает звук', () => {
    const { controller, stage } = makeController();

    stage.removeChild(controller);
    controller.run();

    expect(controller.explosion).toBeNull();
    expect(controller.funnel).toBeNull();
    expect(controller.destroyed).toBe(true);
    expect(soundManager.unregisterSound).toHaveBeenCalledTimes(1);
  });

  it('завершение воронки уничтожает контроллер и снимает звук', () => {
    const { controller } = makeController();

    controller.run();
    controller.funnel._completeEffect();

    expect(controller.destroyed).toBe(true);
    expect(soundManager.unregisterSound).toHaveBeenCalledTimes(1);
  });
});
