import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Container, Texture } from 'pixi.js';
import ShotEffectController from '../../../../src/client/parts/effects/shot/ShotEffectController.js';
import { muzzleFlashLife } from '../../../../src/client/parts/effects/shot/MuzzleFlashEffect.js';
import {
  parallax,
  tracer,
  impactFlash,
  impactSmoke,
  lighting as lightingConfig,
} from '../../../../src/config/render.js';
import { cameraCenter } from '../../../../src/client/camera.js';
import { OCCLUDER_BASE_Z, levelZ } from '../../../../src/client/levelZ.js';
import { offsetPoint, reproject } from '../../../../src/client/parallax.js';
import {
  rampSurfaceAt,
  rampSlopeAt,
  rampFaceAt,
} from '../../../../src/client/rampSurface.js';
import { crossingDistance } from '../../../../src/client/wallFace.js';
import {
  W1_HIT_SLOPE,
  W1_HIT_EMBANKMENT_FACE,
} from '../../../../src/client/snapshotFields.js';

// Проверяется проводка якоря попадания, а не отрисовка: контроллер обязан
// пересчитать точку удара по ТЕКУЩЕМУ трансформу задетого ящика и уметь
// обойтись без якоря (авторитетный трассер) и без сервиса (спектатор).
// Строка w1: [startX, startY, endX, endY, bodyX, bodyY, wasHit, shooterId,
// startLevel, endLevel] + якорь одиннадцатым элементом у своего трассера.
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
    const controller = makeController([0, 0, 100, 0, 0, 0, false, 1, 0, 0]);

    controller.run();
    finishTracer(controller);

    expect(controller.impact).toBeNull();
  });

  it('попадание в стену (строка длины 10): эффект в мировой точке удара', () => {
    const controller = makeController([0, 0, 100, 0, 0, 0, true, 1, 0, 0]);

    controller.run();
    finishTracer(controller);

    expect(controller.impact).not.toBeNull();
    expect(controller.impact.x).toBe(100);
    expect(controller.impact.y).toBe(0);
  });

  it('якорь есть, но сервиса нет (спектатор): откат к мировой точке', () => {
    const controller = makeController([
      0,
      0,
      100,
      0,
      0,
      0,
      true,
      1,
      0,
      0,
      ['d0', -5, 0],
    ]);

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
    const controller = makeController(
      [0, 0, 0, 10, 0, 0, true, 1, 0, 0, ['d0', -10, 0]],
      {
        mapDynamics,
      },
    );

    controller.run();
    finishTracer(controller);

    expect(controller.impact).not.toBeNull();
    expect(controller.impact.x).toBeCloseTo(0, 6);
    expect(controller.impact.y).toBeCloseTo(10, 6);
  });

  it('точка удара берётся из ТЕКУЩЕГО трансформа ящика, а не из момента выстрела', () => {
    const controller = makeController(
      [0, 0, 0, 10, 0, 0, true, 1, 0, 0, ['d0', -10, 0]],
      {
        mapDynamics,
      },
    );

    controller.run();

    // ящик уехал за время анимации трассера: центр (60, 60),
    // якорь (-10, 0) от центра → точка удара (50, 60)
    mapDynamics.box = { x: 60, y: 60, angle: 0 };

    finishTracer(controller);

    expect(controller.impact.x).toBeCloseTo(50, 6);
    expect(controller.impact.y).toBeCloseTo(60, 6);
    // разрыв — там же, где осколки, а не в точке из данных трассера
    expect(controller.hitFlash.x).toBeCloseTo(50, 6);
    expect(controller.hitFlash.y).toBeCloseTo(60, 6);
  });

  // осколки должны остаться там, где пуля встретила препятствие,
  // и НЕ ехать за ящиком дальше
  it('осколки остаются на месте, когда ящик едет дальше', () => {
    const controller = makeController(
      [0, 0, 0, 10, 0, 0, true, 1, 0, 0, ['d0', -10, 0]],
      {
        mapDynamics,
      },
    );

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
    const controller = makeController(
      [0, 0, 0, 10, 0, 0, true, 1, 0, 0, ['d0', -10, 0]],
      {
        mapDynamics,
      },
    );

    controller.run();

    mapDynamics.box = null;

    finishTracer(controller);

    expect(controller.impact.x).toBe(0);
    expect(controller.impact.y).toBe(10);
  });
});

// Д9: позиция звука выстрела — корпус стрелка на момент выстрела, а
// слушатель — центр камеры, то есть предсказанный свой танк. Предсказанный
// локальный выстрел и его авторитетное эхо по позиции не совпадают: один и
// тот же выстрел звучал то по центру, то целиком в одно ухо. Свой выстрел
// принадлежит игроку, а не миру.
describe('ShotEffectController: свой выстрел непространственный', () => {
  // shooterId — восьмой элемент строки w1
  const row = shooterId => [0, 0, 100, 0, 0, 0, false, shooterId, 0, 0];

  it('свой выстрел регистрируется с spatial: false', () => {
    makeController(row(1), { localPlayer: { is: id => String(id) === '1' } });

    expect(soundManager.registerSound.mock.calls[0][1].spatial).toBe(false);
  });

  it('чужой выстрел остаётся пространственным', () => {
    makeController(row(2), { localPlayer: { is: id => String(id) === '1' } });

    expect(soundManager.registerSound.mock.calls[0][1].spatial).toBe(true);
  });

  it('без сервиса localPlayer (спектатор) звук пространственный', () => {
    makeController(row(1));

    expect(soundManager.registerSound.mock.calls[0][1].spatial).toBe(true);
  });
});

// отдача: эффект выстрела сообщает id стрелка сервису `shots`
describe('ShotEffectController: отдача стрелка', () => {
  const row = shooterId => [0, 0, 100, 0, 0, 0, false, shooterId, 0, 0];

  it('сообщает shots.fired с id стрелка', () => {
    const shots = { fired: vi.fn() };

    makeController(row(5), { shots });

    expect(shots.fired).toHaveBeenCalledWith(5);
  });

  it('без сервиса shots эффект создаётся как прежде', () => {
    expect(() => makeController(row(5))).not.toThrow();
  });
});

describe('ShotEffectController: вспышка у дула', () => {
  // промах: [startX, startY, endX, endY, bodyX, bodyY, hit, shooter, ...]
  const row = [10, 20, 110, 20, 0, 0, false, 1, 0, 0];

  it('вспышка стоит в точке вылета и смотрит вдоль луча', () => {
    const controller = makeController(row);

    controller.run();

    expect(controller.flash.x).toBe(10);
    expect(controller.flash.y).toBe(20);
    expect(controller.flash.dirX).toBeCloseTo(1, 6);
    expect(controller.flash.dirY).toBeCloseTo(0, 6);
  });

  // Кадр без трансформа сцены: центра камеры нет вовсе (`cameraCenter`), и
  // `applyParallax` сбрасывает трансформ контроллера в единичный — дети
  // рисуются по сырым мировым точкам. Вспышка обязана лечь ровно в точку
  // вылета (случай `ratio === 1`), а не остаться в проекции прошлого кадра,
  // и падать в `onRender` нельзя
  it('кадр без центра камеры: вспышка в точке вылета, без падения', () => {
    // выстрел с моста вниз: уровни начала и конца разные, то есть перенос
    // вспышки в этом кадре вообще требуется
    const controller = makeController([10, 20, 110, 20, 0, 0, false, 1, 1, 0], {
      renderer: { screen: { width: 800, height: 600 } },
    });

    controller.run();
    // кадр с камерой: вспышка уезжает в проекцию уровня начала луча
    controller.onRender();

    expect(controller.flash.x).not.toBeCloseTo(10, 6);

    // движок обнулил масштаб сцены — центра камеры больше нет
    controller.parent.scale.set(0);

    expect(() => controller.onRender()).not.toThrow();
    expect(controller.flash.x).toBeCloseTo(10, 6);
    expect(controller.flash.y).toBeCloseTo(20, 6);
    expect(controller.flash.scale.x).toBeCloseTo(1, 6);
  });

  it('контроллер ждёт конца вспышки', () => {
    soundManager.registerSound = vi.fn(() => null);

    const controller = makeController(row);

    controller.run();
    finishTracer(controller);

    // трассер закончен, звука нет, но вспышка ещё идёт: её время
    // шагает отдельно
    expect(controller._isDestroyed).toBe(false);

    // языки уже погасли, ударное кольцо ещё идёт
    controller.flash._update(controller.flash.config.duration);
    expect(controller._isDestroyed).toBe(false);

    controller.flash._update(muzzleFlashLife(controller.flash.config));
    expect(controller._isDestroyed).toBe(true);
  });
});

// разрыв снаряда в точке попадания: вспышка веером к стрелку, клуб дыма и
// ночной блик
describe('ShotEffectController: разрыв при попадании', () => {
  const hitRow = [10, 20, 110, 20, 0, 0, true, 1, 0, 0];
  const withSmoke = {
    ...assets,
    smokeTexture: { texture: Texture.EMPTY, contentSize: 8 },
  };
  const makeWithAssets = (data, extraAssets, dependencies = {}) => {
    const controller = new ShotEffectController(data, extraAssets, {
      soundManager,
      ...dependencies,
    });

    new Container().addChild(controller);
    created.push(controller);

    return controller;
  };

  it('попадание: вспышка разрыва в точке удара, языки к стрелку', () => {
    const controller = makeController(hitRow);

    controller.run();
    finishTracer(controller);

    expect(controller.hitFlash.parent).toBe(controller);
    expect(controller.hitFlash.config).toBe(impactFlash);
    expect(controller.hitFlash.x).toBe(110);
    expect(controller.hitFlash.y).toBe(20);
    expect(controller.hitFlash.dirX).toBeCloseTo(-1, 6);
    expect(controller.hitFlash.dirY).toBeCloseTo(0, 6);
  });

  it('промах: разрыва нет', () => {
    const controller = makeController([10, 20, 110, 20, 0, 0, false, 1, 0, 0]);

    controller.run();
    finishTracer(controller);

    expect(controller.hitFlash).toBeNull();
    expect(controller.hitSmoke).toBeNull();
  });

  it('клуб дыма — при текстуре дыма, в той же точке, к стрелку', () => {
    const controller = makeWithAssets(hitRow, withSmoke);

    controller.run();
    finishTracer(controller);

    expect(controller.hitSmoke.parent).toBe(controller);
    expect(controller.hitSmoke.x).toBe(110);
    expect(controller.hitSmoke.puffs).toHaveLength(impactSmoke.count);

    for (const puff of controller.hitSmoke.puffs) {
      expect(puff.vx).toBeLessThan(0);
    }

    // дым под аддитивным пламенем
    expect(controller.getChildIndex(controller.hitSmoke)).toBeLessThan(
      controller.getChildIndex(controller.hitFlash),
    );
  });

  it('без текстуры дыма — только вспышка', () => {
    const controller = makeController(hitRow);

    controller.run();
    finishTracer(controller);

    expect(controller.hitSmoke).toBeNull();
    expect(controller.hitFlash).not.toBeNull();
  });

  it('ночь: блик разрыва на уровне конца в точке удара', () => {
    const lighting = { flash: vi.fn(), isNight: () => true };
    const controller = makeController([10, 20, 110, 20, 0, 0, true, 1, 1, 1], {
      lighting,
    });

    controller.run();
    finishTracer(controller);

    expect(lighting.flash).toHaveBeenLastCalledWith({
      ...lightingConfig.flash.hit,
      level: 1,
      x: 110,
      y: 20,
      z: 1,
    });
  });

  it('контроллер ждёт конца разрыва', () => {
    soundManager.registerSound = vi.fn(() => null);

    const controller = makeWithAssets(hitRow, withSmoke);

    controller.run();
    finishTracer(controller);
    controller.flash._update(muzzleFlashLife(controller.flash.config));

    // осколки легли и погасли, но дым ещё тает
    controller.impact._completeEffect();
    controller.hitFlash._update(muzzleFlashLife(impactFlash));
    expect(controller._isDestroyed).toBe(false);

    controller.hitSmoke._update(impactSmoke.lifetime.max);
    expect(controller._isDestroyed).toBe(true);
  });
});

// танк едет: начало луча и вспышка идут за его ТЕКУЩИМ дулом, точка удара
// остаётся на месте
describe('ShotEffectController: привязка к дулу', () => {
  const row = [10, 20, 110, 20, 0, 0, false, 1, 0, 0];

  it('трассер и вспышка следуют за дулом стрелка', () => {
    let muzzle = { x: 10, y: 20 };
    const shots = { fired: vi.fn(), muzzle: vi.fn(() => muzzle) };
    const controller = makeController(row, {
      shots,
      renderer: { screen: { width: 800, height: 600 } },
    });

    controller.run();
    muzzle = { x: 10, y: 35 };
    controller.onRender();

    expect(shots.muzzle).toHaveBeenCalledWith(1);
    // луч перенесён целиком: и начало, и конец сдвинулись на 15
    expect(controller.tracer.startPositionY).toBe(35);
    expect(controller.tracer.endPositionY).toBe(35);
    expect(controller.flash.y).toBeCloseTo(35, 6);
  });

  it('без дула (стрелок уничтожен) эффект остаётся на месте', () => {
    const shots = { fired: vi.fn(), muzzle: () => null };
    const controller = makeController(row, {
      shots,
      renderer: { screen: { width: 800, height: 600 } },
    });

    controller.run();
    controller.onRender();

    expect(controller.tracer.startPositionY).toBe(20);
  });
});

describe('ShotEffectController: трассер по уровням', () => {
  // выстрел с моста (уровень 1) вдаль: плита — первые 300 единиц луча,
  // дальше луч падает на землю (уровень 0)
  const row = [10, 20, 910, 20, 0, 0, false, 1, 1, 0];
  const night = isNight => ({ flash: vi.fn(), isNight: () => isNight });
  const bridge = () => ({
    fired: vi.fn(),
    muzzle: () => null,
    path: vi.fn(() => [
      { t0: 0, t1: 300, level: 1 },
      { t0: 300, t1: 900, level: 0 },
    ]),
  });
  const graphicsIn = container =>
    container.children.filter(child => child.constructor.name === 'Graphics');

  it('сегменты берутся у сервиса shots от дула с уровня стрелка', () => {
    const shots = bridge();
    const controller = makeController(row, { shots });

    controller.run();

    expect(shots.path).toHaveBeenCalledWith(10, 20, 910, 20, 1);
    expect(controller.tracer.pieces).toEqual([
      { from: 0, to: 300, level: 1 },
      { from: 300, to: 900, level: 0 },
    ]);
  });

  it('днём кусок моста — в слое уровня 1 над плитой, кусок земли — в контроллере', () => {
    const controller = makeController(row, { shots: bridge() });

    controller.run();

    const layer = controller.layers.get(1);

    expect(layer.parent).toBe(controller.parent);
    // levelZ(SHOT_BASE_Z = 2, 1)
    expect(layer.zIndex).toBe(102);
    expect(controller.layers.has(0)).toBe(false);
    expect(graphicsIn(layer)).toHaveLength(1);
    expect(graphicsIn(controller)).toHaveLength(1);
  });

  it('линия режется на кромке: у каждого уровня своя часть', () => {
    const controller = makeController(row, { shots: bridge() });

    controller.run();
    controller.tracer._update(controller.tracer.animationDuration * 0.9);

    const [bridgeGraphics] = graphicsIn(controller.layers.get(1));
    const [groundGraphics] = graphicsIn(controller);

    // голова уже за кромкой: рисуют оба уровня
    expect(bridgeGraphics.bounds.maxX).toBeLessThanOrEqual(310 + 1);
    expect(groundGraphics.bounds.minX).toBeGreaterThanOrEqual(310 - 1);
  });

  it('ночью все куски — над картой освещённости своего уровня', () => {
    const controller = makeController(row, {
      shots: bridge(),
      lighting: night(true),
    });

    controller.run();

    // levelZ(EMISSIVE_BASE_Z = 45, L)
    expect(controller.layers.get(1).zIndex).toBe(145);
    expect(controller.layers.get(0).zIndex).toBe(45);
    expect(graphicsIn(controller)).toHaveLength(0);
    // осколки и вспышка остаются в контроллере, под картой освещённости
    expect(controller.flash.parent).toBe(controller);
  });

  it('слой повторяет проекцию своего уровня и прозрачность по своему куску', () => {
    const alphaFor = vi.fn(() => 0.3);
    const levelView = { alphaFor, tintFor: () => 0xb0b0c0 };
    const controller = makeController(row, {
      shots: bridge(),
      levelView,
      renderer: { screen: { width: 800, height: 600 } },
    });

    controller.run();
    controller.onRender();

    const layer = controller.layers.get(1);

    expect(layer.alpha).toBe(0.3);
    expect(layer.tint).toBe(0xb0b0c0);
    // середина куска моста: 150 единиц от дула
    expect(alphaFor).toHaveBeenCalledWith(1, 160, 20);
    expect(layer.scale.x).toBeCloseTo(1 + parallax.shear);
  });

  it('без сервиса сегментов — один кусок на уровне конца в контроллере', () => {
    const controller = makeController(row);

    controller.run();

    expect(controller.tracer.pieces).toEqual([{ from: 0, to: 900, level: 0 }]);
    expect(controller.layers.size).toBe(0);
  });

  it('уничтожение снимает слои со сцены', () => {
    const controller = makeController(row, {
      shots: bridge(),
      lighting: night(true),
    });
    const stage = controller.parent;

    controller.run();

    const layers = [...controller.layers.values()];

    controller.destroy();

    for (const layer of layers) {
      expect(layer.destroyed).toBe(true);
      expect(stage.children).not.toContain(layer);
    }
  });
});

// Попадание в стену (этап 14 ревью): луч хоста кончается на подножии стены,
// а видимый конец трассера и искры — на её грани на высоте ствола. Стена —
// клетка 3 (x 96..128) уровня 0, выстрел по +x в её кромку x = 96
describe('ShotEffectController: попадание в грань стены', () => {
  const row = [10, 40, 96, 40, 0, 0, true, 1, 0, 0];
  const WALL_HIT_Z = levelZ(OCCLUDER_BASE_Z + 0.5, 0);
  const SHOT_Z = levelZ(2, 0);
  const renderer = { screen: { width: 800, height: 600 } };
  const wallVolumes = (
    heightAt = (level, x) => (x >= 96 && x < 128 ? 1 : 0),
  ) => ({
    cellSize: () => ({ cellW: 32, cellH: 32 }),
    heightAt: vi.fn(heightAt),
  });
  // центр камеры в (camX, 40): сцена сдвинута на полэкрана
  const wallShot = (camX, { data = row, volumes = wallVolumes() } = {}) => {
    let stage = null;
    const levelView = {
      camera: () => cameraCenter(stage, renderer),
      alphaFor: () => 0.7,
      tintFor: () => 0xb0b0c0,
    };
    const controller = makeController(data, { levelView, renderer, volumes });

    stage = controller.parent;
    stage.position.set(400 - camX, 300 - 40);

    return controller;
  };

  it('грань к камере: конец трассера на грани на высоте ствола, над перекрывателем', () => {
    const controller = wallShot(0);

    controller.run();

    const end = reproject(
      96,
      40,
      { x: 0, y: 40 },
      0,
      tracer.height * parallax.shear,
    );

    expect(controller.zIndex).toBe(WALL_HIT_Z);
    expect(controller.tracer.endPositionX).toBeCloseTo(end.x, 6);
    expect(controller.tracer.endPositionY).toBeCloseTo(end.y, 6);
    // точка удара для искр — исходная
    expect(controller.endPositionX).toBe(96);

    // разрыв — на видимом конце, на грани, а не у подножия
    finishTracer(controller);
    expect(controller.hitFlash.x).toBeCloseTo(end.x, 6);
    expect(controller.hitFlash.y).toBeCloseTo(end.y, 6);
  });

  it('грань от камеры: трассер обрывается на силуэте крыши', () => {
    const controller = wallShot(300);

    controller.run();

    // верх стены (объём 1) в проекции: 96 + (96 − 300)·shear
    const silhouette = 96 + (96 - 300) * parallax.shear;

    expect(controller.tracer.endPositionX).toBeCloseTo(silhouette, 6);
    expect(controller.tracer.totalDist).toBeLessThan(86);
    expect(controller.zIndex).toBe(SHOT_Z);
  });

  it('попадание не в стену и промах — прежнее поведение', () => {
    const open = wallShot(0, { volumes: wallVolumes(() => 0) });

    open.run();
    expect(open.zIndex).toBe(SHOT_Z);
    expect(open.tracer.endPositionX).toBe(96);

    const missed = wallShot(0, {
      data: [10, 40, 96, 40, 0, 0, false, 1, 0, 0],
    });

    missed.run();
    expect(missed.zIndex).toBe(SHOT_Z);
    expect(missed.tracer.endPositionX).toBe(96);
    expect(missed.tracer._stopLine).toBeNull();
  });

  it('трассер получает линию грани: на ходу конец не заходит в стену', () => {
    const muzzle = { x: 10, y: 40 };
    const controller = wallShot(0);

    controller._shots = { muzzle: () => muzzle };
    controller.run();

    const stop = controller.tracer.endPositionX;

    expect(controller.tracer._stopLine).toEqual({ axis: 'x', coord: stop });

    // танк проехал к стене 20 единиц: луч перенесён, но конец — на грани
    muzzle.x = 30;
    controller.onRender();

    expect(controller.tracer.startPositionX).toBe(30);
    expect(controller.tracer.endPositionX).toBeCloseTo(stop, 6);
  });

  it('осколки в контроллере падают с высоты ствола, сторона грани — каждый кадр', () => {
    const controller = wallShot(0);
    const stage = controller.parent;

    controller.run();
    finishTracer(controller);

    expect(controller.impact.parent).toBe(controller);
    expect(controller.impact._startK).toBeCloseTo(
      tracer.height * parallax.shear,
      9,
    );
    // падают, грань к камере: над перекрывателем
    expect(controller.zIndex).toBe(WALL_HIT_Z);

    // камера ушла за стену: осколки под перекрывателем
    stage.position.x = 400 - 300;
    controller.onRender();
    expect(controller.zIndex).toBe(SHOT_Z);

    // камера вернулась, осколки уже на полу, но разрыв ещё на грани на
    // высоте ствола: над перекрывателем
    stage.position.x = 400 - 0;
    controller.impact._update(300);
    controller.onRender();
    expect(controller.zIndex).toBe(WALL_HIT_Z);

    // разрыв погас: под перекрывателем, как осколки на полу
    controller.hitFlash._update(muzzleFlashLife(impactFlash));
    controller.onRender();
    expect(controller.zIndex).toBe(SHOT_Z);

    controller.destroy();

    // отдельного слоя осколков нет: после уборки сцена пуста
    expect(stage.children).toEqual([]);
  });

  it('попадание не в стену — осколки в самом контроллере, без высоты рождения', () => {
    const controller = wallShot(0, { volumes: wallVolumes(() => 0) });

    controller.run();
    finishTracer(controller);

    expect(controller.impact.parent).toBe(controller);
    expect(controller.impact._startK).toBeNull();
  });
});

// подъём 0 → 1 вдоль +x на [64, 128], полоса по y 16..80
const runs = [
  {
    axis: 0,
    sign: 1,
    from: 0,
    to: 1,
    min: 64,
    max: 128,
    crossMin: 16,
    crossMax: 80,
  },
];
// сервис rampRuns на настоящих функциях src/client/rampSurface.js
const makeRampRuns = () => ({
  heightAt: vi.fn((level, x, y) => rampSurfaceAt(runs, level, x, y)),
  slopeAt: vi.fn((level, x, y) => rampSlopeAt(runs, level, x, y)),
  faceAt: vi.fn((...args) => rampFaceAt(runs, ...args)),
});

describe('ShotEffectController: осколки на склоне рампы', () => {
  // попадание в танк на склоне у верха рампы: танк виден лучам обоих
  // уровней, и его осколки лежат на склоне
  const row = [10, 40, 120, 40, 10, 40, 1, 1, 0, 0];
  const renderer = { screen: { width: 800, height: 600 } };
  // центр камеры в (camX, 40): сцена сдвинута на полэкрана
  const rampShot = (camX, { data = row, ...dependencies } = {}) => {
    const controller = makeController(data, { renderer, ...dependencies });

    controller.parent.position.set(400 - camX, 300 - 40);
    controller.run();
    finishTracer(controller);

    return controller;
  };
  // осколки встают в мировых x (первый — xs[0], остальные — последний из
  // xs) за один тик: нулевая скорость, высота берётся в точке остановки
  const land = (controller, xs) => {
    const { impact } = controller;

    impact.particlesData.forEach((p, i) => {
      p.x = xs[Math.min(i, xs.length - 1)] - impact.x;
      p.y = 0;
      p.vx = 0;
      p.vy = 0;
      p.isMoving = true;
    });

    impact._update(0);

    return impact.particlesData;
  };
  const camera = { x: 0, y: 40 };

  it('осколок на склоне — в проекции склона', () => {
    const rampRuns = makeRampRuns();
    const controller = rampShot(0, { rampRuns });
    const [p] = land(controller, [96]);

    expect(typeof controller._onRender).toBe('function');

    controller.onRender();

    const expected = offsetPoint(96, 40, camera, 0.5 * parallax.shear);

    expect(controller.impact.x + p.sprite.x).toBeCloseTo(expected.x, 6);
    expect(controller.impact.y + p.sprite.y).toBeCloseTo(expected.y, 6);
    expect(rampRuns.heightAt).toHaveBeenCalledWith(0, 96, 40);
  });

  it('два осколка на разной высоте сдвинуты каждый по своей', () => {
    const controller = rampShot(0, { rampRuns: makeRampRuns() });
    const [low, high] = land(controller, [72, 120]);

    controller.onRender();

    const lowPoint = offsetPoint(72, 40, camera, (8 / 64) * parallax.shear);
    const highPoint = offsetPoint(120, 40, camera, (56 / 64) * parallax.shear);
    const lowX = controller.impact.x + low.sprite.x;
    const highX = controller.impact.x + high.sprite.x;

    expect(lowX).toBeCloseTo(lowPoint.x, 6);
    expect(highX).toBeCloseTo(highPoint.x, 6);
    expect(lowX - 72).not.toBeCloseTo(highX - 120, 3);
  });

  it('уровень конца 1: мировая точка после трансформа контроллера — на склоне', () => {
    const rampRuns = makeRampRuns();
    const controller = rampShot(0, {
      data: [10, 40, 120, 40, 0, 0, true, 1, 0, 1],
      rampRuns,
    });
    const [p] = land(controller, [96]);

    controller.onRender();

    const expected = offsetPoint(96, 40, camera, 0.5 * parallax.shear);
    const worldX =
      (controller.impact.x + p.sprite.x) * controller.scale.x +
      controller.position.x;

    expect(controller.scale.x).toBeCloseTo(1 + parallax.shear, 6);
    expect(worldX).toBeCloseTo(expected.x, 6);
    expect(rampRuns.heightAt).toHaveBeenCalledWith(1, 96, 40);
  });

  it('вне рампы и без сервиса rampRuns — сырая позиция', () => {
    const off = rampShot(0, { rampRuns: makeRampRuns() });
    const [offPiece] = land(off, [40]);

    off.onRender();
    expect(offPiece.sprite.x).toBe(offPiece.x);

    const bare = rampShot(0);
    const [barePiece] = land(bare, [96]);

    bare.onRender();
    expect(barePiece.sprite.x).toBe(barePiece.x);
  });

  it('попадание в стену: осколки в контроллере падают на склон', () => {
    const rampRuns = makeRampRuns();
    const volumes = {
      cellSize: () => ({ cellW: 32, cellH: 32 }),
      heightAt: vi.fn((level, x) => (x >= 96 && x < 128 ? 1 : 0)),
    };
    const controller = rampShot(0, {
      data: [10, 40, 96, 40, 0, 0, true, 1, 0, 0],
      volumes,
      rampRuns,
    });

    controller.onRender();

    expect(controller.impact.parent).toBe(controller);
    expect(controller.impact._startK).not.toBeNull();
    expect(rampRuns.heightAt).toHaveBeenCalled();
  });
});

describe('ShotEffectController: выстрел в насыпь рампы', () => {
  const WALL_HIT_Z = levelZ(OCCLUDER_BASE_Z + 0.5, 0);
  const renderer = { screen: { width: 800, height: 600 } };
  // ядро остановило пулю на склоне x = 76 (склон там 12/64)
  const slopeRow = [10, 40, 76, 40, 10, 40, W1_HIT_SLOPE, 1, 0, 0];
  // выстрел на север в борт y = 80
  const faceRow = [96, 100, 96, 80, 96, 100, W1_HIT_EMBANKMENT_FACE, 1, 0, 0];
  // центр камеры в `camera`: сцена сдвинута на полэкрана
  const embankmentShot = (camera, data, dependencies = {}) => {
    let stage = null;
    const levelView = {
      camera: () => cameraCenter(stage, renderer),
      alphaFor: () => 1,
      tintFor: () => 0xffffff,
    };
    const controller = makeController(data, {
      levelView,
      renderer,
      ...dependencies,
    });

    stage = controller.parent;
    stage.position.set(400 - camera.x, 300 - camera.y);
    controller.run();

    return controller;
  };

  it('склон: конец на склоне на высоте пули, осколки там же', () => {
    const camera = { x: 0, y: 40 };
    const rampRuns = makeRampRuns();
    const controller = embankmentShot(camera, slopeRow, { rampRuns });
    const end = reproject(76, 40, camera, 0, (12 / 64) * parallax.shear);

    expect(rampRuns.slopeAt).toHaveBeenCalledWith(0, 76, 40);
    expect(controller.tracer.endPositionX).toBeCloseTo(end.x, 6);
    expect(controller.tracer._stopLine).toEqual({
      axis: 'x',
      coord: controller.tracer.endPositionX,
    });
    expect(controller.endPositionX).toBe(76);

    finishTracer(controller);

    expect(controller.impact.parent).toBe(controller);
    expect(controller.impact.x).toBe(76);
  });

  it('грань насыпи к камере: конец на высоте ствола, осколки падают с высоты ствола', () => {
    const camera = { x: 96, y: 200 };
    const controller = embankmentShot(camera, faceRow, {
      rampRuns: makeRampRuns(),
    });
    const end = reproject(96, 80, camera, 0, tracer.height * parallax.shear);

    expect(controller.zIndex).toBe(WALL_HIT_Z);
    expect(controller.tracer.endPositionY).toBeCloseTo(end.y, 6);

    finishTracer(controller);

    expect(controller.impact.parent).toBe(controller);
    expect(controller.impact._startK).toBeCloseTo(
      (0 + tracer.height) * parallax.shear,
      9,
    );
  });

  it('грань насыпи от камеры: обрыв на силуэте', () => {
    const camera = { x: 96, y: 0 };
    const controller = embankmentShot(camera, faceRow, {
      rampRuns: makeRampRuns(),
    });
    // верх борта над x = 96: (96 − 64)/64 = 0.5 уровня
    const t = crossingDistance({
      x0: 96,
      y0: 100,
      dx: 0,
      dy: -1,
      face: { axis: 'y', coord: 80, nx: 0, ny: 1 },
      camera,
      kBase: 0,
      kLine: 0.5 * parallax.shear,
    });

    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThan(20);
    expect(controller.tracer.endPositionY).toBeCloseTo(100 - t, 6);
  });

  it('без сервиса rampRuns — прежнее поведение', () => {
    const slope = embankmentShot({ x: 0, y: 40 }, slopeRow);

    expect(slope.tracer.endPositionX).toBe(76);
    expect(slope.tracer._stopLine).toBeNull();

    const face = embankmentShot({ x: 96, y: 200 }, faceRow);

    expect(face.tracer.endPositionY).toBe(80);
    expect(face.tracer._stopLine).toBeNull();
  });

  it('код 1 — конец не переносится', () => {
    const controller = embankmentShot(
      { x: 0, y: 40 },
      [10, 40, 76, 40, 10, 40, 1, 1, 0, 0],
      { rampRuns: makeRampRuns() },
    );

    expect(controller.tracer.endPositionX).toBe(76);
    expect(controller.tracer._stopLine).toBeNull();
  });
});

describe('ShotEffectController: попадание пули с моста над нижним уровнем', () => {
  const renderer = { screen: { width: 800, height: 600 } };
  // конец x = 150 над землёй, уровень конца (полёта) — 1; рампа фикстуры —
  // x 64..128, точка 150 вне её
  const airRow = [300, 40, 150, 40, 300, 40, 1, 1, 1, 1];
  // центр камеры в `camera`: сцена сдвинута на полэкрана
  const bridgeShot = (camera, data, dependencies = {}) => {
    let stage = null;
    const levelView = {
      camera: () => cameraCenter(stage, renderer),
      alphaFor: () => 1,
      tintFor: () => 0xffffff,
    };
    const controller = makeController(data, {
      levelView,
      renderer,
      ...dependencies,
    });

    stage = controller.parent;
    stage.position.set(400 - camera.x, 300 - camera.y);
    controller.run();

    return controller;
  };

  it('осколки рождаются на уровне полёта и падают на пол', () => {
    const camera = { x: 0, y: 40 };
    const rampRuns = {
      ...makeRampRuns(),
      floorAt: vi.fn((level, x) => (x < 200 ? 0 : level)),
    };
    const controller = bridgeShot(camera, airRow, { rampRuns });

    finishTracer(controller);

    const { impact } = controller;

    expect(impact._startK).toBeCloseTo(1 * parallax.shear, 9);

    impact._update(300);
    controller.onRender();

    expect(impact.particlesData.length).toBeGreaterThan(0);

    for (const p of impact.particlesData) {
      // из проекции уровня 1 на пол 0
      const expected = reproject(
        impact.x + p.x,
        impact.y + p.y,
        camera,
        parallax.shear,
        0,
      );

      expect(impact.x + p.sprite.x).toBeCloseTo(expected.x, 6);
    }
  });

  it('попадание на плите — осколки сразу на поверхности', () => {
    const rampRuns = { ...makeRampRuns(), floorAt: vi.fn(level => level) };
    const controller = bridgeShot({ x: 0, y: 40 }, airRow, { rampRuns });

    finishTracer(controller);

    expect(controller.impact._startK).toBeNull();
  });

  it('грань насыпи под пулей ищется на полу', () => {
    // прогон 0 → 2 на [64, 128], полоса по y 16..80
    const steep = [
      {
        axis: 0,
        sign: 1,
        from: 0,
        to: 2,
        min: 64,
        max: 128,
        crossMin: 16,
        crossMax: 80,
      },
    ];
    const rampRuns = {
      heightAt: (level, x, y) => rampSurfaceAt(steep, level, x, y),
      slopeAt: (level, x, y) => rampSlopeAt(steep, level, x, y),
      faceAt: vi.fn((...args) => rampFaceAt(steep, ...args)),
      floorAt: vi.fn(() => 0),
    };
    const camera = { x: 112, y: 200 };
    // выстрел на север в борт y = 80 с уровня 1
    const controller = bridgeShot(
      camera,
      [112, 120, 112, 80, 112, 120, W1_HIT_EMBANKMENT_FACE, 1, 1, 1],
      { rampRuns },
    );
    const end = reproject(
      112,
      80,
      camera,
      1 * parallax.shear,
      (1 + tracer.height) * parallax.shear,
    );

    expect(rampRuns.faceAt.mock.calls[0][0]).toBe(0);
    expect(controller._wall.base).toBe(0);
    // склон на x = 112: (112 − 64) / 64 · 2
    expect(controller._wall.volume).toBeCloseTo(1.5, 6);
    expect(controller.tracer.endPositionY).toBeCloseTo(end.y, 6);
  });

  it('стена под пулей с моста ищется на полу', () => {
    const volumes = {
      cellSize: () => ({ cellW: 32, cellH: 32 }),
      heightAt: vi.fn((level, x) =>
        level === 0 && x >= 96 && x < 128 ? 1.5 : 0,
      ),
    };
    const rampRuns = { ...makeRampRuns(), floorAt: vi.fn(() => 0) };
    // камера за стеной
    const camera = { x: 300, y: 40 };
    const controller = bridgeShot(camera, [10, 40, 96, 40, 0, 0, 1, 1, 1, 1], {
      volumes,
      rampRuns,
    });

    expect(volumes.heightAt.mock.calls[0][0]).toBe(0);
    expect(controller._wall.base).toBe(0);

    const t = crossingDistance({
      x0: 10,
      y0: 40,
      dx: 1,
      dy: 0,
      face: controller._wall.face,
      camera,
      kBase: 1 * parallax.shear,
      kLine: (0 + 1.5) * parallax.shear,
    });
    expect(t).not.toBeNull();

    const along = Math.min(86, Math.max(0, t));

    expect(controller.tracer.endPositionX).toBeCloseTo(10 + along, 6);
  });
});
