import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Container, Texture } from 'pixi.js';
import ShotEffectController from '../../../../src/client/parts/effects/shot/ShotEffectController.js';
import { parallax, tracer } from '../../../../src/config/render.js';
import { cameraCenter } from '../../../../src/client/camera.js';
import { OCCLUDER_BASE_Z, levelZ } from '../../../../src/client/levelZ.js';
import { raisedPoint } from '../../../../src/client/wallFace.js';

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

    controller.flash._update(controller.flash.config.duration);

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
  const wallVolumes = (heightAt = (level, x) => (x >= 96 && x < 128 ? 1 : 0)) => ({
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

    const end = raisedPoint(
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

    const missed = wallShot(0, { data: [10, 40, 96, 40, 0, 0, false, 1, 0, 0] });

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

  it('искры — в своём слое на высоте ствола, сторона грани — каждый кадр', () => {
    const controller = wallShot(0);
    const stage = controller.parent;

    controller.run();
    finishTracer(controller);

    const layer = controller.impact.parent;

    expect(layer).not.toBe(controller);
    expect(layer.label).toBe('shot-impact');
    expect(layer.parent).toBe(stage);
    expect(layer.zIndex).toBe(WALL_HIT_Z);

    controller.onRender();

    expect(layer.scale.x).toBeCloseTo(1 + tracer.height * parallax.shear, 6);
    expect(layer.alpha).toBe(0.7);
    expect(layer.tint).toBe(0xb0b0c0);

    // камера ушла за стену: искры под перекрывателем
    stage.position.x = 400 - 300;
    controller.onRender();
    expect(layer.zIndex).toBe(SHOT_Z);

    controller.destroy();

    expect(layer.destroyed).toBe(true);
    expect(stage.children).not.toContain(layer);
  });

  it('попадание не в стену — искры в самом контроллере', () => {
    const controller = wallShot(0, { volumes: wallVolumes(() => 0) });

    controller.run();
    finishTracer(controller);

    expect(controller.impact.parent).toBe(controller);
  });
});
