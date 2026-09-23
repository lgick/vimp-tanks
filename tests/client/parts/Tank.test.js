import { describe, it, expect, vi, afterEach } from 'vitest';
import { Container, Texture, TextureSource, Ticker } from 'pixi.js';
import Tank, {
  calculateEngineSoundParams,
  shadowOffset,
} from '../../../src/client/parts/Tank.js';
import {
  shadow,
  parallax,
  seeThrough,
  landing,
  surfaceFx,
  tilt,
  tankLight,
  recoil,
  blastJolt,
} from '../../../src/config/render.js';
import { createLevelView } from '../../../src/client/levelView.js';
import { createLighting } from '../../../src/client/lighting/createLighting.js';
import { createShotEvents } from '../../../src/client/shotEvents.js';
import { createBlastEvents } from '../../../src/client/blastEvents.js';
import { createTankModel } from '../../../src/client/tank3d/model.js';

// Part танка поверх Pixi Container: проверяется только звуковой контур
// (регистрация/обновление/снятие) — визуал рендером не трогаем.

// габариты текстуры — часть геометрии квада (`src/client/tilt.js`), а не
// украшение: у Texture.EMPTY нулевой размер, и любой наклон выродился бы в
// точку
const sized = (width, height) =>
  new Texture({ source: new TextureSource({ width, height }) });

const liveTextures = () => ({
  body: sized(40, 30),
  gun: sized(20, 20),
  gunAnchor: { x: 0.5, y: 0.5 },
});

const assets = {
  tankTexture: {
    liveTeamId1: liveTextures(),
    liveTeamId2: liveTextures(),
    destroyed: sized(40, 30),
  },
};

// углы квада PerspectiveMesh: сетка идёт построчно, углы — первая и
// последняя вершины первого и последнего ряда
const quad = mesh => {
  const { positions } = mesh.geometry;
  const last = positions.length - 2;
  const rowEnd = 2 * (Math.sqrt(positions.length / 2) - 1);

  return [
    { x: positions[0], y: positions[1] },
    { x: positions[rowEnd], y: positions[rowEnd + 1] },
    { x: positions[last], y: positions[last + 1] },
    { x: positions[last - rowEnd], y: positions[last - rowEnd + 1] },
  ];
};

// engineConfig = null — звук не загрузился (нет кодека/файла)
const makeSoundManager = (engineConfig = { volume: 0.8 }) => ({
  getSoundConfig: vi.fn(() => engineConfig),
  registerSound: vi.fn(() => (engineConfig ? Symbol('sound') : null)),
  updateSoundData: vi.fn(),
  unregisterSound: vi.fn(),
});

// [x, y, rotation, gunRotation, vX, vY, engineLoad, condition, size, teamId]
const data = (condition = 100) => [0, 0, 0, 0, 0, 0, 0, condition, 10, 1];

const makeTank = (soundManager, condition) =>
  new Tank(data(condition), assets, { soundManager });

describe('Tank: звук двигателя', () => {
  it('регистрирует звук при создании живого танка', () => {
    const soundManager = makeSoundManager();

    makeTank(soundManager);

    expect(soundManager.registerSound).toHaveBeenCalledTimes(1);
    expect(soundManager.registerSound.mock.calls[0][0]).toBe('tankEngine');
  });

  it('update обновляет данные звука, а не регистрирует заново', () => {
    const soundManager = makeSoundManager();
    const tank = makeTank(soundManager);

    tank.update(data());

    expect(soundManager.registerSound).toHaveBeenCalledTimes(1);
    expect(soundManager.updateSoundData).toHaveBeenCalledTimes(1);
  });

  it('возвращает звук живому танку, у которого регистрацию снял CLEAR', () => {
    const soundManager = makeSoundManager();
    const tank = makeTank(soundManager);

    // частичный CLEAR: SoundManager.reset() унёс регистрацию вместе с
    // сущностью, но танк на полотне остался
    tank._soundId = null;

    tank.update(data());

    expect(soundManager.registerSound).toHaveBeenCalledTimes(2);
  });

  it('не регистрирует звук, которого нет в конфиге, на каждом кадре', () => {
    const soundManager = makeSoundManager(null);
    const tank = makeTank(soundManager);

    tank.update(data());
    tank.update(data());

    // registerSound вернул бы null и писал бы warn 30 раз в секунду
    expect(soundManager.registerSound).not.toHaveBeenCalled();
  });

  it('уничтоженный танк снимает регистрацию и не заводит её снова', () => {
    const soundManager = makeSoundManager();
    const tank = makeTank(soundManager);
    const soundId = soundManager.registerSound.mock.results[0].value;

    tank.update([0, 0, 0, 0, 0, 0, 0, 0, 10, 1]); // condition 0

    expect(soundManager.unregisterSound).toHaveBeenCalledWith(soundId);

    tank.update([0, 0, 0, 0, 0, 0, 0, 0, 10, 1]);

    expect(soundManager.registerSound).toHaveBeenCalledTimes(1);
  });

  it('destroy снимает регистрацию звука', () => {
    const soundManager = makeSoundManager();
    const tank = makeTank(soundManager);
    const soundId = soundManager.registerSound.mock.results[0].value;

    tank.destroy();

    expect(soundManager.unregisterSound).toHaveBeenCalledWith(soundId);
  });
});

// плеск под гусеницами: петля `tankWater`, пока живой танк на воде и не в
// полёте; громкость и скорость воспроизведения — от скорости хода
describe('Tank: звук воды', () => {
  const { minVolume, fullSpeed, rate } = surfaceFx.water.sound;
  const WATER_VOLUME = 0.4;

  const makeWaterSoundManager = () => {
    const configs = {
      tankEngine: { volume: 0.8 },
      tankWater: { volume: WATER_VOLUME },
    };

    return {
      getSoundConfig: vi.fn(name => configs[name] || null),
      registerSound: vi.fn(name => Symbol(name)),
      updateSoundData: vi.fn(),
      unregisterSound: vi.fn(),
    };
  };

  // вода — всё, что правее x = 100
  const surfaces = { kindAt: vi.fn(x => (x > 100 ? 'water' : null)) };

  // полный ряд m1 до M1_ROLL
  const row = ({ x = 0, vx = 0, vy = 0, condition = 100, vz = 0 } = {}) => [
    x,
    0,
    0,
    0,
    vx,
    vy,
    0,
    condition,
    10,
    1,
    0,
    0,
    0,
    vz,
    0,
    0,
  ];

  const waterCalls = (mock, name = 'tankWater') =>
    mock.mock.calls.filter(call => call[0] === name);

  const waterId = soundManager =>
    soundManager.registerSound.mock.results.find(
      result => result.value.description === 'tankWater',
    )?.value;

  const makeWaterTank = (soundManager, dependencies = { surfaces }) =>
    new Tank(row(), assets, { soundManager, ...dependencies });

  it('въезд в воду регистрирует петлю tankWater', () => {
    const soundManager = makeWaterSoundManager();
    const tank = makeWaterTank(soundManager);

    tank.update(row());

    expect(waterCalls(soundManager.registerSound)).toHaveLength(0);

    tank.update(row({ x: 200 }));

    expect(waterCalls(soundManager.registerSound)).toHaveLength(1);
  });

  it('в воде обновляет громкость и rate от скорости', () => {
    const soundManager = makeWaterSoundManager();
    const tank = makeWaterTank(soundManager);

    tank.update(row({ x: 200 }));

    const standing = waterCalls(soundManager.registerSound)[0][1];

    expect(standing.volume).toBeCloseTo(WATER_VOLUME * minVolume);
    expect(standing.rate).toBeCloseTo(rate.min);

    tank.update(row({ x: 200, vx: fullSpeed * 0.6, vy: fullSpeed * 0.8 }));

    const id = waterId(soundManager);
    const [updatedId, full] = soundManager.updateSoundData.mock.calls.at(-1);

    expect(updatedId).toBe(id);
    expect(full.volume).toBeCloseTo(WATER_VOLUME);
    expect(full.rate).toBeCloseTo(rate.max);
    expect(full.position).toEqual({ x: 200, y: 0 });
    expect(waterCalls(soundManager.registerSound)).toHaveLength(1);
  });

  it('выезд из воды снимает петлю', () => {
    const soundManager = makeWaterSoundManager();
    const tank = makeWaterTank(soundManager);

    tank.update(row({ x: 200 }));
    tank.update(row());

    expect(soundManager.unregisterSound).toHaveBeenCalledWith(
      waterId(soundManager),
    );
  });

  it('смерть в воде снимает петлю и не заводит её снова', () => {
    const soundManager = makeWaterSoundManager();
    const tank = makeWaterTank(soundManager);

    tank.update(row({ x: 200 }));
    tank.update(row({ x: 200, condition: 0 }));

    expect(soundManager.unregisterSound).toHaveBeenCalledWith(
      waterId(soundManager),
    );

    tank.update(row({ x: 200, condition: 0 }));

    expect(waterCalls(soundManager.registerSound)).toHaveLength(1);
  });

  it('destroy снимает петлю', () => {
    const soundManager = makeWaterSoundManager();
    const tank = makeWaterTank(soundManager);

    tank.update(row({ x: 200 }));
    tank.destroy();

    expect(soundManager.unregisterSound).toHaveBeenCalledWith(
      waterId(soundManager),
    );
  });

  it('в полёте над водой звука нет', () => {
    const soundManager = makeWaterSoundManager();
    const tank = makeWaterTank(soundManager);

    tank.update(row({ x: 200, vz: -1 }));

    expect(waterCalls(soundManager.registerSound)).toHaveLength(0);
  });

  it('без сервиса surfaces звука воды нет', () => {
    const soundManager = makeWaterSoundManager();
    const tank = makeWaterTank(soundManager, {});

    tank.update(row({ x: 200 }));

    expect(waterCalls(soundManager.registerSound)).toHaveLength(0);
  });
});

// 2.5D: уровень танка задаёт слой отрисовки, а свой танк ещё и сообщает
// сервису levelView, где он и на каком уровне — по этому плита моста над
// игроком становится полупрозрачной (Map.onRender).
describe('Tank: уровни 2.5D', () => {
  // строка m1 целиком: [..., angvel, z, level]. По умолчанию тело СТОИТ на
  // своём уровне (`z === level`) — так его и отдаёт хост; `z` ниже уровня
  // означает падение, и уровень отрисовки идёт за высотой
  const row = (level, z = level, x = 0, y = 0) => [
    x,
    y,
    0,
    0,
    0,
    0,
    0,
    100,
    10,
    1,
    0,
    z,
    level,
  ];

  const makeLevelView = () => ({
    level: 0,
    x: 0,
    y: 0,
    set: vi.fn(function set(level, x, y, z) {
      this.level = level;
      this.x = x;
      this.y = y;
      this.z = z;
    }),
    alphaFor: () => 1,
    tintFor: () => 0xffffff,
  });

  // localPlayer — движковый сервис: сравнивает id сущности со своим gameId
  const makeLocalPlayer = myId => ({ is: id => String(id) === String(myId) });

  const makeTankAt = (level, dependencies, id = '1') =>
    new Tank(
      row(level),
      assets,
      { soundManager: makeSoundManager(), ...dependencies },
      { id },
    );

  it('zIndex следует за уровнем', () => {
    const tank = makeTankAt(0, {});

    expect(tank.zIndex).toBe(3);

    tank.update(row(1));

    expect(tank.zIndex).toBe(103);

    tank.update(row(0));

    expect(tank.zIndex).toBe(3);
  });

  it('падающий танк переходит на нижний слой по высоте, а не по level', () => {
    // пока тело падает, хост держит `level` уровнем, с которого оно
    // сорвалось: без правила по высоте танк рисовался бы слоем эстакады до
    // самого касания
    const tank = makeTankAt(1, {});

    expect(tank.zIndex).toBe(103);

    // первая половина падения — ещё слой эстакады
    tank.update(row(1, 0.8));

    expect(tank.zIndex).toBe(103);

    // ниже половины — слой земли
    tank.update(row(1, 0.3));

    expect(tank.zIndex).toBe(3);
  });

  it('подъём по рампе слой не дёргает', () => {
    // на прогоне `level` и есть `round(z)`, поэтому правило по высоте его
    // не трогает
    const tank = makeTankAt(0, {});

    tank.update(row(0, 0.4));

    expect(tank.zIndex).toBe(3);

    tank.update(row(1, 0.6));

    expect(tank.zIndex).toBe(103);
  });

  it('свой танк публикует свой уровень и позицию в levelView', () => {
    const levelView = makeLevelView();
    const tank = makeTankAt(0, {
      levelView,
      localPlayer: makeLocalPlayer('1'),
    });

    tank.update(row(1, 1, 320, 640));

    expect(levelView.set).toHaveBeenCalledWith(1, 320, 640, 1);
  });

  // свой танк строится из FIRST_SHOT_DATA, то есть до первого бинарного
  // кадра: в конструкторе `localPlayer.id` ещё null, и флаг, посчитанный
  // один раз, был бы навсегда false
  it('свой танк узнаётся, даже если localPlayer заполнился после создания', () => {
    const levelView = makeLevelView();
    let myId = null;
    const tank = makeTankAt(0, {
      levelView,
      localPlayer: { is: id => myId !== null && String(id) === String(myId) },
    });

    tank.update(row(1, 1, 320, 640));

    expect(levelView.set).not.toHaveBeenCalled();

    myId = '1';
    tank.update(row(1, 1, 320, 640));

    expect(levelView.set).toHaveBeenCalledWith(1, 320, 640, 1);
  });

  it('чужой танк в levelView не пишет', () => {
    const levelView = makeLevelView();
    const tank = makeTankAt(0, {
      levelView,
      localPlayer: makeLocalPlayer('7'),
    });

    tank.update(row(1, 1, 320, 640));

    expect(levelView.set).not.toHaveBeenCalled();
  });
});

// Признаки высоты и уровня (задачи 3 и 4 мастер-плана): тень — самый дешёвый
// и самый читаемый из них, дальше идёт масштаб корпуса. Ни бейджа уровня,
// ни наклона корпуса больше нет (этапы 5 и 5.2 кодревью): уровень читается
// по кольцу на радаре, затемнению нижних слоёв, тени и параллаксу.
describe('Tank: признаки уровня и высоты', () => {
  const viewAssets = {
    ...assets,
    tankShadowTexture: { texture: Texture.EMPTY, contentSize: 24 },
  };

  // строка m1 целиком: [..., angvel, z, level, vz, pitch, roll]. По
  // умолчанию тело СТОИТ на своём уровне (`z === level`) — так его и отдаёт
  // хост; `z` ниже уровня означает падение, и уровень отрисовки идёт за
  // высотой
  const row = (level, z = level, x = 0, y = 0, air = {}) => [
    x,
    y,
    0,
    0,
    0,
    0,
    0,
    100,
    10,
    1,
    0,
    z,
    level,
    air.vz || 0,
    air.pitch || 0,
    air.roll || 0,
  ];

  // просадка идёт по времени: единственный её источник — общий тикер
  const advance = ms => {
    Ticker.shared.deltaMS = ms;
  };

  afterEach(() => {
    advance(1000 / 60);
  });

  // камера — трансформ сцены плюс размер полотна (src/client/camera.js):
  // при пустом трансформе её центр — середина полотна
  const renderer = { screen: { width: 800, height: 600 } };

  // двойник сервиса: центр камеры он добывает сам, как настоящий
  // (`src/client/levelView.js`), — парт его больше не публикует
  const makeView = () => {
    const view = createLevelView(seeThrough);

    return {
      level: 0,
      x: 0,
      y: 0,
      set() {},
      attachStage: (stage, viewRenderer) =>
        view.attachStage(stage, viewRenderer),
      camera: () => view.camera(),
      alphaFor: () => 1,
      tintFor: () => 0xffffff,
    };
  };

  const onStage = (dependencies, id = '1') => {
    const tank = new Tank(
      row(0),
      viewAssets,
      { soundManager: makeSoundManager(), renderer, ...dependencies },
      { id },
    );
    const stage = new Container();

    stage.scale.set(1);
    stage.addChild(tank);

    return { tank, stage };
  };

  // точка опоры под тенью: тень сдвинута от света на постоянный вектор в
  // осях экрана, проекция считается от точки без этого сдвига
  const OFFSET = shadowOffset();
  const shadowX = tank => tank._shadow.x - OFFSET.x;
  const shadowY = tank => tank._shadow.y - OFFSET.y;

  // проекция 2.5D: смещается КОРПУС — на подъём НАД ОПОРОЙ. Тень лежит на
  // самой опоре, поэтому разъезд показывает высоту прыжка, а не высоту
  // яруса над нулём карты
  it('корпус уезжает от тени тем выше, чем выше прыжок', () => {
    const { tank } = onStage({ levelView: makeView() });

    // начало прыжка: тень ещё ровно под корпусом
    tank.update(row(0, 0, 100, 100, { vz: -2 }));
    tank.onRender();

    expect(tank.x).toBeCloseTo(100, 6);
    expect(shadowX(tank)).toBeCloseTo(100);

    tank.update(row(0, 2, 100, 100, { vz: -2 }));
    tank.onRender();

    const low = Math.abs(tank.x - shadowX(tank));

    tank.update(row(0, 4, 100, 100, { vz: -2 }));
    tank.onRender();

    expect(Math.abs(tank.x - shadowX(tank))).toBeGreaterThan(low);
  });

  // масштаб высоты — та же проекция, что у плиты: танк на уровне 1 крупнее
  // наземного ровно настолько же, насколько крупнее сама плита под ним.
  // Масштаба у меша нет, он внутри углов квада (`src/client/tilt.js`)
  const quadWidth = mesh => quad(mesh)[1].x - quad(mesh)[0].x;

  it('корпус на высоте крупнее ровно на shear', () => {
    const { tank } = onStage({ levelView: makeView() });

    tank.update(row(0, 0, 100, 100));

    const ground = quadWidth(tank.body);
    const groundGun = quadWidth(tank.gun);
    const groundWreck = quadWidth(tank.wreck);

    tank.update(row(1, 1, 100, 100));

    expect(quadWidth(tank.body) / ground).toBeCloseTo(1 + parallax.shear, 6);
    expect(quadWidth(tank.gun) / groundGun).toBeCloseTo(1 + parallax.shear, 6);
    // обломки едут по той же проекции: иначе подбитый танк съедет с плиты
    expect(quadWidth(tank.wreck) / groundWreck).toBeCloseTo(
      1 + parallax.shear,
      6,
    );
  });

  // наклон корпуса — авторитетный: углы приходят в кадре, клиент их только
  // рисует (поэтому меш, а не спрайт)
  it('корпус деформируется на рампе', () => {
    const { tank } = onStage({ levelView: makeView() });

    tank.update(row(0, 0, 100, 100, { pitch: 0.3 }));
    tank.onRender();

    const [lt, rt, rb, lb] = quad(tank.body);

    // квад перестал быть прямоугольником: нос (+u, правый край) поднялся
    // и стал шире кормы
    expect(rb.y - rt.y).toBeGreaterThan(lb.y - lt.y);
    expect(rt.y).toBeLessThan(-15);
  });

  it('приземление даёт просадку и гаснет', () => {
    const { tank } = onStage({ levelView: makeView() });

    tank.update(row(0, 1, 100, 100, { vz: -8 }));
    tank.onRender();

    expect(tank._squash).toBe(0);

    tank.update(row(0, 0, 100, 100, { vz: 0 }));
    tank.onRender();

    expect(tank._squash).toBeGreaterThan(0);
    // удар быстрее fullImpact просаживает корпус целиком
    expect(tank._landImpact).toBe(1);

    // корпус сжат по вертикали, но не по горизонтали
    const [lt, , rb] = quad(tank.body);

    expect(rb.y - lt.y).toBeLessThan(30);
    expect(rb.x - lt.x).toBeCloseTo(40, 6);

    advance(landing.duration);
    tank.onRender();

    expect(tank._squash).toBe(0);
    expect(quad(tank.body)[2].y - quad(tank.body)[0].y).toBeCloseTo(30, 6);
  });

  it('продолжающийся полёт касанием не считается', () => {
    const { tank } = onStage({ levelView: makeView() });

    tank.update(row(0, 1, 100, 100, { vz: -6 }));
    tank.update(row(0, 0.5, 100, 100, { vz: -3 }));
    tank.onRender();

    expect(tank._landTimer).toBe(0);
    expect(tank._squash).toBe(0);
  });

  it('мягкое касание просадки не даёт', () => {
    const { tank } = onStage({ levelView: makeView() });

    tank.update(row(0, 0.1, 100, 100, { vz: -0.5 }));
    tank.update(row(0, 0, 100, 100, { vz: 0 }));
    tank.onRender();

    expect(tank._squash).toBe(0);
  });

  // короткий ряд (кадр без хвоста vz/pitch/roll) не должен уводить квад в
  // NaN: та же страховка `|| 0`, что у engineLoad
  it('короткий ряд не роняет наклон', () => {
    const { tank } = onStage({ levelView: makeView() });

    tank.update([100, 100, 0, 0, 0, 0, 0, 100, 10, 1, 0, 0, 0]);
    tank.onRender();

    expect(
      Array.from(tank.body.geometry.positions).every(Number.isFinite),
    ).toBe(true);
  });

  // тень — силуэт корпуса: круглая тень нормировалась по `size` (2 единицы
  // при корпусе 8 × 6) и её мягкий ореол вылезал из-под углов вращающегося
  // корпуса серым кружком
  it('в начале прыжка тень не крупнее корпуса больше, чем на sizeFactor', () => {
    const { tank } = onStage({ levelView: makeView() });

    tank.update(row(0, 0, 100, 100, { vz: -2 }));
    tank.onRender();

    const { contentSize } = viewAssets.tankShadowTexture;
    // длина корпуса на экране: полотно танка — 4 × размер модели
    const bodyLength = tank._size * 4;
    const shadowLength = tank._shadow.scale.x * contentSize;

    expect(shadowLength).toBeCloseTo(bodyLength * shadow.sizeFactor, 6);
    expect(shadowLength / bodyLength).toBeLessThan(1.1);
    // масштаб один на обе оси: текстура уже в пропорции корпуса
    expect(tank._shadow.scale.y).toBeCloseTo(tank._shadow.scale.x, 6);
  });

  it('с подъёмом над опорой тень растёт и бледнеет', () => {
    const { tank } = onStage({ levelView: makeView() });

    tank.update(row(0, 0, 100, 100, { vz: -2 }));
    tank.onRender();

    const groundScale = tank._shadow.scale.x;
    const groundAlpha = tank._shadow.alpha;

    tank.update(row(0, 1, 100, 100, { vz: -2 }));
    tank.onRender();

    expect(tank._shadow.scale.x).toBeGreaterThan(groundScale);
    expect(tank._shadow.alpha).toBeLessThan(groundAlpha);
  });

  // На земле тень есть, но сдвинута ОТ света: без сдвига она легла бы
  // ровно под корпусом серым ореолом. Сдвиг — в осях экрана, поэтому от
  // курса он не зависит
  it('у стоящего танка тень сдвинута от света при любом курсе', () => {
    const { tank } = onStage({ levelView: makeView() });

    for (const angle of [0, Math.PI]) {
      const standing = row(2, 2, 100, 100);

      standing[2] = angle;
      tank.update(standing);
      tank.onRender();

      expect(tank._shadow.visible).toBe(true);
      expect(tank._shadow.alpha).toBeCloseTo(shadow.groundAlpha, 6);
      // свет с северо-запада — тень уходит на юго-восток от опоры
      expect(tank._shadow.x - shadowX(tank)).toBeGreaterThan(0);
      expect(tank._shadow.y - shadowY(tank)).toBeGreaterThan(0);
    }

    // опора — плита уровня 2: тень лежит в её проекции, а не на земле
    expect(shadowX(tank)).toBeCloseTo(tank.x, 6);
  });

  it('сдвиг тени — против lightDir, длиной groundOffset', () => {
    const offset = shadowOffset([-1, 0], 3);

    expect(offset.x).toBeCloseTo(3, 6);
    expect(offset.y).toBeCloseTo(0, 6);

    const diagonal = shadowOffset(tilt.lightDir, shadow.groundOffset);

    expect(Math.hypot(diagonal.x, diagonal.y)).toBeCloseTo(
      shadow.groundOffset,
      6,
    );
  });

  it('без сдвига тень есть только в полёте', () => {
    const saved = shadow.groundOffset;

    shadow.groundOffset = 0;

    try {
      const { tank } = onStage({ levelView: makeView() });

      tank.update(row(2, 2, 100, 100));
      tank.onRender();

      expect(tank._shadow).toBe(null);

      tank.update(row(0, 1, 100, 100, { vz: -3 }));
      tank.onRender();
      tank.update(row(0, 0, 100, 100));
      tank.onRender();

      expect(tank._shadow.visible).toBe(false);
    } finally {
      shadow.groundOffset = saved;
    }
  });

  it('у остова тени нет', () => {
    const { tank } = onStage({ levelView: makeView() });

    tank.update(row(0, 0, 100, 100));
    tank.onRender();

    expect(tank._shadow.visible).toBe(true);

    const wreck = row(0, 0, 100, 100);

    wreck[7] = 0;
    tank.update(wreck);
    tank.onRender();

    expect(tank._shadow.visible).toBe(false);
  });

  it('после приземления тень остаётся, но с прозрачностью земли', () => {
    const { tank } = onStage({ levelView: makeView() });

    tank.update(row(0, 1, 100, 100, { vz: -3 }));
    tank.onRender();

    expect(tank._shadow.visible).toBe(true);

    tank.update(row(0, 0, 100, 100));
    tank.onRender();

    expect(tank._shadow.visible).toBe(true);
    expect(tank._shadow.alpha).toBeCloseTo(shadow.groundAlpha, 6);
  });

  it('в полёте тень отстаёт от корпуса', () => {
    const { tank } = onStage({ levelView: makeView() });

    tank.update(row(2, 2.3, 100, 100, { vz: -2 }));
    tank.onRender();

    const low = Math.abs(shadowX(tank) - tank.x);

    expect(low).toBeGreaterThan(0);

    tank.update(row(2, 3, 100, 100, { vz: -2 }));
    tank.onRender();

    expect(Math.abs(shadowX(tank) - tank.x)).toBeGreaterThan(low);
  });

  // падение с обрыва: опорой остаётся покинутая плита (ядро держит её в
  // `level` всю дугу), и тень обязана остаться на ней
  it('падение с обрыва оставляет тень на покинутой плите', () => {
    const { tank } = onStage({ levelView: makeView() });

    tank.update(row(1, 0.4, 100, 100, { vz: -4 }));
    tank.onRender();

    // проекция уровня 1 от центра камеры (400, 300)
    expect(shadowX(tank)).toBeCloseTo(100 + (100 - 400) * parallax.shear, 6);
    expect(shadowY(tank)).toBeCloseTo(100 + (100 - 300) * parallax.shear, 6);
    // корпус ниже опоры — он уехал к центру камеры сильнее тени
    expect(tank.x).toBeGreaterThan(shadowX(tank));
  });

  // масштаб и прозрачность раньше росли от высоты над нулём карты — это
  // была компенсация ошибки проекции: прыжок на верхнем ярусе обязан
  // выглядеть так же, как такой же прыжок на земле
  it('масштаб и прозрачность тени считают подъём над опорой', () => {
    const { tank } = onStage({ levelView: makeView() });

    tank.update(row(0, 0.5, 100, 100, { vz: -2 }));
    tank.onRender();

    const groundScale = tank._shadow.scale.x;
    const groundAlpha = tank._shadow.alpha;

    tank.update(row(2, 2.5, 100, 100, { vz: -2 }));
    tank.onRender();

    expect(tank._shadow.scale.x).toBeCloseTo(groundScale, 6);
    expect(tank._shadow.alpha).toBeCloseTo(groundAlpha, 6);
  });

  it('тень летящего танка стоит в мировой точке покинутой земли', () => {
    const { tank } = onStage({ levelView: makeView() });

    tank.update(row(0, 3, 100, 250, { vz: -2 }));
    tank.onRender();

    expect(shadowX(tank)).toBeCloseTo(100);
    expect(shadowY(tank)).toBeCloseTo(250);
    // корпус при этом уехал от центра камеры (400, 300)
    expect(tank.x).toBeLessThan(100);
    expect(tank.y).toBeLessThan(250);
  });

  it('корпус уезжает сильнее у края экрана, чем в центре камеры', () => {
    const { tank } = onStage({ levelView: makeView() });

    // центр камеры — (400, 300): в нём сдвига нет вовсе
    tank.update(row(0, 3, 400, 300, { vz: -2 }));
    tank.onRender();

    expect(Math.abs(tank.x - shadowX(tank))).toBeCloseTo(0);

    tank.update(row(0, 3, 100, 300, { vz: -2 }));
    tank.onRender();

    expect(Math.abs(tank.x - shadowX(tank))).toBeGreaterThan(0);
  });

  // в levelView, в звук и в уклон уходит НЕсмещённая точка: иначе поехали бы
  // и дыра в плите, и панорама своего танка
  it('в levelView уходит мировая, а не нарисованная точка', () => {
    const set = vi.fn();
    const localPlayer = { is: () => true };
    const { tank } = onStage({
      levelView: { ...makeView(), set },
      localPlayer,
    });

    tank.update(row(1, 1, 100, 250));
    tank.onRender();

    expect(set).toHaveBeenLastCalledWith(1, 100, 250, 1);
    expect(tank.x).not.toBeCloseTo(100);
  });

  // центр камеры — свойство КАДРА, а не парта: танк лишь привязывает к
  // сервису сцену, а считает центр сервис — один раз на тик и для всех
  it('танк привязывает сцену к сервису камеры', () => {
    const view = makeView();
    const attachStage = vi.fn(view.attachStage);
    const localPlayer = { is: () => true };
    const { tank, stage } = onStage({
      levelView: { ...view, attachStage },
      localPlayer,
    });

    tank.update(row(1, 1, 100, 250));
    tank.onRender();

    expect(attachStage).toHaveBeenLastCalledWith(stage, renderer);
    expect(view.camera()).toEqual(expect.objectContaining({ x: 400, y: 300 }));
  });

  // и ЧУЖОЙ танк тоже: без локального (наблюдатель, промежуток до
  // респауна) камеры иначе не было бы вовсе
  it('чужой танк тоже привязывает сцену', () => {
    const view = makeView();
    const attachStage = vi.fn(view.attachStage);
    const localPlayer = { is: () => false };
    const { tank } = onStage({
      levelView: { ...view, attachStage },
      localPlayer,
    });

    tank.update(row(1, 1, 100, 250));
    tank.onRender();

    expect(attachStage).toHaveBeenCalled();
  });

  // тень лежит на слое ОПОРЫ — той плиты, с которой танк оторвался: ядро
  // держит её в `level` всю дугу, поэтому и падение с эстакады рисует тень
  // на эстакаде, а не на земле под ней
  it('тень остаётся на уровне опоры, а не под корпусом', () => {
    const { tank } = onStage({ levelView: makeView() });

    // прыжок с земли
    tank.update(row(0, 0.5, 100, 100, { vz: 2 }));
    tank.onRender();

    expect(tank._shadow.zIndex).toBe(2);

    // падение с эстакады: корпус уже ниже её плиты, тень осталась на ней
    tank.update(row(1, 0.8, 100, 100, { vz: -2 }));
    tank.onRender();

    expect(tank._shadow.zIndex).toBe(102);
  });

  it('тень уходит вместе с танком: движок про неё не знает', () => {
    const { tank, stage } = onStage({ levelView: makeView() });

    tank.update(row(0, 1, 100, 100, { vz: -3 }));
    tank.onRender();

    expect(stage.children).toHaveLength(2);

    tank.destroy();

    expect(stage.children).toHaveLength(0);
  });

  // светотень наклона — множитель ПОВЕРХ тинта уровня, а не его замена.
  // Эффект односторонний: подсветки нет в самой формуле (`tiltShade`),
  // поэтому наклон навстречу свету оставляет тинт нетронутым
  it('наклон затемняет корпус, ровная земля — нет', () => {
    const { tank } = onStage({ levelView: makeView() });

    tank.update(row(0, 0, 100, 100));
    tank.onRender();

    expect(tank.tint).toBe(0xffffff);

    tank.update(row(0, 0, 100, 100, { pitch: -0.5 }));
    tank.onRender();

    const dark = tank.tint;

    expect(dark).toBeLessThan(0xffffff);

    // наклон навстречу свету не подсвечивает и не темнит: ровный тинт
    tank.update(row(0, 0, 100, 100, { pitch: 0.5 }));
    tank.onRender();

    expect(tank.tint).toBe(0xffffff);
  });
});

// Д9: слушатель — центр камеры, то есть свой же танк. Источник, лежащий
// ровно на слушателе, HRTF сворачивает в гребенчатую окраску («гул»), а
// расхождение камеры и танка в пару пикселей кидает звук целиком в одно
// ухо. Свой двигатель принадлежит игроку, а не миру.
// Свет по карте нормалей: у меша с картой — свой шейдер (меш перестаёт
// батчиться), без карты — прежний батченый меш и светотень `tiltShade`
describe('Tank: свет по карте нормалей', () => {
  const litLive = () => ({
    ...liveTextures(),
    bodyNormal: sized(40, 30),
    gunNormal: sized(20, 20),
  });
  const litAssets = {
    tankTexture: {
      liveTeamId1: litLive(),
      liveTeamId2: litLive(),
      destroyed: sized(40, 30),
      destroyedNormal: sized(40, 30),
    },
  };
  const make = (textures, condition = 100) =>
    new Tank(data(condition), textures, {
      soundManager: makeSoundManager(),
    });

  it('с картами нормалей у корпуса и пушки свой шейдер', () => {
    const tank = make(litAssets);

    expect(tank._lightShaders.get(tank.body)).toBe(tank.body.shader);
    expect(tank._lightShaders.get(tank.gun)).toBe(tank.gun.shader);
    expect(tank.body.batched).toBe(false);
  });

  it('без карт нормалей меш остаётся батченым', () => {
    const tank = make(assets);

    expect(tank._lightShaders.size).toBe(0);
    expect(tank.body.shader).toBe(null);
    expect(tank.body.batched).toBe(true);
  });

  it('tankLight.enabled = false возвращает прежний путь', () => {
    tankLight.enabled = false;

    try {
      const tank = make(litAssets);

      expect(tank._lightShaders.size).toBe(0);
      expect(tank.body.batched).toBe(true);
    } finally {
      tankLight.enabled = true;
    }
  });

  it('текстура шейдера следует за текстурой меша', () => {
    const tank = make(litAssets);
    const live = litAssets.tankTexture.liveTeamId1;
    const shader = tank._lightShaders.get(tank.body);

    expect(shader.resources.uTexture).toBe(live.body.source);
    expect(shader.resources.uNormal).toBe(live.bodyNormal.source);
  });

  it('остов получает свой шейдер', () => {
    const tank = make(litAssets, 0);

    expect(tank._lightShaders.get(tank.wreck)).toBe(tank.wreck.shader);
  });

  it('destroy уничтожает шейдеры, но не текстуры', () => {
    const tank = make(litAssets);
    const shader = tank._lightShaders.get(tank.body);
    const source = litAssets.tankTexture.liveTeamId1.body.source;

    tank.destroy();

    expect(shader.resources).toBe(null);
    expect(source.destroyed).toBe(false);
  });
});

// Визуальная отдача: событие приходит через сервис `shots` по id танка,
// анимация идёт по времени (общий тикер)
describe('Tank: отдача после выстрела', () => {
  const make = (condition = 100) => {
    const shots = createShotEvents();
    const tank = new Tank(
      data(condition),
      assets,
      { soundManager: makeSoundManager(), shots },
      { id: '1' },
    );

    new Container().addChild(tank);

    return { tank, shots };
  };

  const frame = (tank, ms) => {
    Ticker.shared.deltaMS = ms;
    tank.onRender();
  };

  afterEach(() => {
    Ticker.shared.deltaMS = 1000 / 60;
  });

  it('выстрел откатывает башню и корпус назад и гаснет', () => {
    const { tank, shots } = make();

    shots.fired(1);
    frame(tank, recoil.attack * recoil.duration);

    // ствол по курсу (+x): откат к −x, башня дальше корпуса
    expect(tank.gun.x).toBeCloseTo(-(recoil.gunKick + recoil.bodyKick), 6);
    expect(tank.body.x).toBeCloseTo(-recoil.bodyKick, 6);
    expect(tank._recoilTilt.pitch).toBeCloseTo(recoil.rock, 6);

    frame(tank, recoil.duration);

    expect(tank.gun.x).toBe(0);
    expect(tank.body.x).toBe(0);
    expect(tank._recoilTilt.pitch).toBe(0);
  });

  it('чужой выстрел танк не трогает', () => {
    const { tank, shots } = make();

    shots.fired(2);
    frame(tank, recoil.attack * recoil.duration);

    expect(tank.gun.x).toBe(0);
  });

  it('повторный выстрел на спаде возвращает отдачу на пик', () => {
    const { tank, shots } = make();

    shots.fired(1);
    frame(tank, recoil.duration * 0.8);

    const decayed = tank.gun.x;

    shots.fired(1);
    frame(tank, 0);

    expect(tank.gun.x).toBeLessThan(decayed);
    expect(tank.gun.x).toBeCloseTo(-(recoil.gunKick + recoil.bodyKick), 6);
  });

  it('у остова отдачи нет', () => {
    const { tank, shots } = make(0);

    shots.fired(1);
    frame(tank, recoil.attack * recoil.duration);

    expect(tank.gun.x).toBe(0);
    expect(tank.body.x).toBe(0);
  });

  it('recoil.enabled = false выключает отдачу', () => {
    recoil.enabled = false;

    try {
      const { tank, shots } = make();

      shots.fired(1);
      frame(tank, recoil.attack * recoil.duration);

      expect(tank.gun.x).toBe(0);
    } finally {
      recoil.enabled = true;
    }
  });

  // дуло — та же формула, что у ядра: 0.55 длины корпуса по курсу башни
  it('отдаёт мировую точку дула по курсу башни', () => {
    const { tank, shots } = make();
    const length = tank._size * 4;

    expect(shots.muzzle(1)).toEqual({ x: length * 0.55, y: 0 });

    tank._gunRotation = Math.PI / 2;

    const side = shots.muzzle(1);

    expect(side.x).toBeCloseTo(0, 6);
    expect(side.y).toBeCloseTo(length * 0.55, 6);
  });

  it('у остова дула нет', () => {
    const { shots } = make(0);

    expect(shots.muzzle(1)).toBe(null);
  });

  it('destroy отписывает танк от выстрелов', () => {
    const { tank, shots } = make();
    const onFired = vi.spyOn(tank, '_onFired');

    tank.destroy();
    shots.fired(1);

    expect(onFired).not.toHaveBeenCalled();
  });
});

// Визуальная реакция на взрыв: событие приходит через сервис `blasts`,
// танк сам решает, задел ли его взрыв; анимация — по общему тикеру
describe('Tank: реакция на взрыв', () => {
  // m1: [x, y, angle, gun, vx, vy, load, condition, size, team, angvel, z,
  // level]; size 3 — корпус 12 × 9
  const row = (condition = 100) => [
    100,
    100,
    0,
    0,
    0,
    0,
    0,
    condition,
    3,
    1,
    0,
    0,
    0,
  ];
  const renderer = { screen: { width: 800, height: 600 } };

  const make = (condition = 100) => {
    const blasts = createBlastEvents();
    const tank = new Tank(
      row(condition),
      assets,
      { soundManager: makeSoundManager(), blasts, renderer },
      { id: '1' },
    );

    new Container().addChild(tank);

    return { tank, blasts };
  };

  const frame = (tank, ms) => {
    Ticker.shared.deltaMS = ms;
    tank.onRender();
  };

  afterEach(() => {
    Ticker.shared.deltaMS = 1000 / 60;
  });

  it('взрыв спереди поднимает нос, качка затухает', () => {
    const { tank, blasts } = make();

    blasts.exploded({ x: 120, y: 100, radius: 50, level: 0 });
    frame(tank, 1);

    expect(tank._blastTilt.pitch).toBeGreaterThan(0);
    expect(Math.abs(tank._blastTilt.roll)).toBeLessThan(1e-6);

    frame(tank, blastJolt.duration);

    expect(tank._blastTilt.pitch).toBe(0);
    expect(tank._blastKick).toBe(null);
  });

  it('взрыв вне радиуса и на другом уровне не трогает', () => {
    const { tank, blasts } = make();

    blasts.exploded({ x: 300, y: 100, radius: 50, level: 0 });
    blasts.exploded({ x: 110, y: 100, radius: 50, level: 1 });
    frame(tank, 1);

    expect(tank._blastKick).toBe(null);
  });

  it('взрыв под корпусом подбрасывает, на конце — просадка', () => {
    const { tank, blasts } = make();

    frame(tank, 1);

    const groundX = tank.x;
    const groundWidth =
      tank.body.geometry.positions[2] - tank.body.geometry.positions[0];

    blasts.exploded({ x: 101, y: 100, radius: 50, level: 0 });
    frame(tank, blastJolt.hopDuration / 2);

    expect(tank._blastLift).toBeGreaterThan(0);
    // видимая высота — в проекции (танк левее центра камеры уезжает влево)
    // и в масштабе корпуса
    expect(tank.x).toBeLessThan(groundX);
    expect(
      tank.body.geometry.positions[2] - tank.body.geometry.positions[0],
    ).toBeGreaterThan(groundWidth);

    frame(tank, blastJolt.hopDuration / 2);

    expect(tank._blastLift).toBe(0);
    expect(tank._landTimer).toBeGreaterThan(0);
  });

  it('слабый дальний взрыв не гасит качку от близкого', () => {
    const { tank, blasts } = make();

    blasts.exploded({ x: 110, y: 100, radius: 50, level: 0 });
    frame(tank, 1);

    const strong = tank._blastKick;

    blasts.exploded({ x: 145, y: 100, radius: 50, level: 0 });

    expect(tank._blastKick).toBe(strong);
  });

  it('blastJolt.enabled = false выключает реакцию', () => {
    blastJolt.enabled = false;

    try {
      const { tank, blasts } = make();

      blasts.exploded({ x: 110, y: 100, radius: 50, level: 0 });

      expect(tank._blastKick).toBe(null);
    } finally {
      blastJolt.enabled = true;
    }
  });

  it('destroy отписывает танк от взрывов', () => {
    const { tank, blasts } = make();
    const onBlast = vi.spyOn(tank, '_onBlast');

    tank.destroy();
    blasts.exploded({ x: 110, y: 100, radius: 50, level: 0 });

    expect(onBlast).not.toHaveBeenCalled();
  });
});

// 3D-модель живого танка (plan/tank-3d/): вместо плоских корпуса и башни,
// когда в ассетах есть атлас; остов остаётся плоским
describe('Tank: 3D-модель', () => {
  const atlas = () => ({
    texture: sized(100, 50),
    width: 100,
    height: 50,
    regions: {
      body: { x: 2, y: 2, w: 40, h: 30, originX: 22, originY: 17 },
      gun: { x: 44, y: 2, w: 40, h: 22, originX: 58.5, originY: 13 },
      trackSide: { x: 2, y: 34, w: 40, h: 5 },
      barrelSide: { x: 44, y: 34, w: 22, h: 3 },
      brakeSide: { x: 68, y: 34, w: 8, h: 4 },
      bottom: { x: 78, y: 34, w: 4, h: 4 },
    },
  });
  const modelAssets = {
    ...assets,
    tankModelTexture: { liveTeamId1: atlas(), liveTeamId2: atlas() },
  };
  const renderer = { screen: { width: 800, height: 600 } };

  const make = (textures = modelAssets, condition = 100, extra = {}) => {
    const tank = new Tank(
      data(condition),
      textures,
      { soundManager: makeSoundManager(), renderer, ...extra },
      { id: '1' },
    );

    new Container().addChild(tank);

    return tank;
  };

  it('живой танк рисуется моделью, плоские корпус и башня скрыты', () => {
    const tank = make();

    expect(tank._model.mesh.visible).toBe(true);
    expect(tank._model.mesh.parent).toBe(tank);
    expect(tank.body.visible).toBe(false);
    expect(tank.gun.visible).toBe(false);
  });

  it('без атласа — прежний плоский путь', () => {
    const tank = make(assets);

    expect(tank._model).toBe(null);
    expect(tank.body.visible).toBe(true);
  });

  it('остов — плоский', () => {
    const tank = make(modelAssets, 0);

    expect(tank._model).toBe(null);
    expect(tank.wreck.visible).toBe(true);
  });

  it('каждый кадр модель получает проекцию, свет и порядок граней', () => {
    const tank = make();
    const update = vi.spyOn(tank._model, 'update');

    tank.onRender();

    const [projected, shades, order] = update.mock.calls[0];
    const model = createTankModel();

    expect(projected).toHaveLength(model.vertices.length);
    expect(shades).toHaveLength(model.faces.length);
    expect(order.length).toBeGreaterThan(0);
    // ровный танк: верх палубы — яркость ровно 1
    const deck = model.faces.findIndex(f => f.material === 'hullTop');

    expect(shades[deck]).toBeCloseTo(1, 6);
  });

  it('отдача откатывает ствол модели, башня стоит', () => {
    const shots = createShotEvents();
    const tank = make(modelAssets, 100, { shots });
    const update = vi.spyOn(tank._model, 'update');
    const model = createTankModel();
    const brake = model.faces.find(f => f.material === 'brake').indices[0];
    const turret = model.faces.find(f => f.material === 'turretTop').indices[0];

    Ticker.shared.deltaMS = 0;
    tank.onRender();

    const before = update.mock.calls.at(-1)[0];

    shots.fired(1);
    Ticker.shared.deltaMS = recoil.attack * recoil.duration;
    tank.onRender();
    Ticker.shared.deltaMS = 1000 / 60;

    const after = update.mock.calls.at(-1)[0];

    // ствол откатился назад (−u), башня — только вместе с корпусом
    const barrelShift = after[brake][0] - before[brake][0];
    const turretShift = after[turret][0] - before[turret][0];

    expect(barrelShift).toBeLessThan(turretShift);
  });

  it('с атласом остова остов — та же модель со сбитой башней', () => {
    const tank = make(
      {
        ...modelAssets,
        tankModelTexture: {
          ...modelAssets.tankModelTexture,
          destroyed: atlas(),
        },
      },
      0,
    );

    expect(tank._model.mesh.visible).toBe(true);
    expect(tank.wreck.visible).toBe(false);
    expect(Math.abs(tank._wreckSkew)).toBeLessThanOrEqual(0.6);
  });

  // наклон модели уже в свете граней: светотень корпуса `tiltShade` поверх
  // неё затемнила бы наклон дважды — и при выключенном `tankLight`
  it('наклон модели не затемняет тинт танка', () => {
    tankLight.enabled = false;

    try {
      const view = createLevelView(seeThrough);
      const tank = make(modelAssets, 100, {
        levelView: {
          set() {},
          attachStage: (stage, viewRenderer) =>
            view.attachStage(stage, viewRenderer),
          camera: () => view.camera(),
          alphaFor: () => 1,
          tintFor: () => 0xffffff,
        },
      });

      // [x, y, …, z, level, vz, pitch, roll]: нос опущен от света
      tank.update([100, 100, 0, 0, 0, 0, 0, 100, 10, 1, 0, 0, 0, 0, -0.5, 0]);
      tank.onRender();

      expect(tank._model.mesh.visible).toBe(true);
      expect(tank.tint).toBe(0xffffff);
    } finally {
      tankLight.enabled = true;
    }
  });

  // тень по силуэту: сиблинг на сцене, по полигону на часть, прозрачность
  // фильтром — перекрытия частей не темнеют дважды
  it('тень по силуэту модели заменяет спрайт тени', () => {
    const tank = make({
      ...modelAssets,
      tankShadowTexture: { texture: Texture.EMPTY, contentSize: 24 },
    });

    tank.onRender();

    expect(tank._modelShadow.parent).toBe(tank.parent);
    expect(tank._modelShadow.visible).toBe(true);
    expect(tank._modelShadowAlpha.alpha).toBeCloseTo(shadow.groundAlpha, 6);
    expect(tank._shadow === null || tank._shadow.visible === false).toBe(true);
  });

  it('у остова тени нет, destroy убирает тень модели', () => {
    const tank = make();

    tank.onRender();

    const modelShadow = tank._modelShadow;

    tank.update([0, 0, 0, 0, 0, 0, 0, 0, 10, 1]);
    tank.onRender();

    expect(modelShadow.visible).toBe(false);

    tank.destroy();

    expect(modelShadow.destroyed).toBe(true);
  });

  it('destroy уничтожает меш модели', () => {
    const tank = make();
    const destroy = vi.spyOn(tank._model, 'destroy');

    tank.destroy();

    expect(destroy).toHaveBeenCalled();
  });
});

describe('Tank: свой двигатель непространственный', () => {
  const row = (id = '1') => ({ id });

  const makeTankFor = (soundManager, localPlayer) =>
    new Tank(data(), assets, { soundManager, localPlayer }, row());

  const lastCall = mock => mock.mock.calls[mock.mock.calls.length - 1];

  it('свой танк регистрирует звук с spatial: false', () => {
    const soundManager = makeSoundManager();

    new Tank(
      data(),
      assets,
      { soundManager, localPlayer: { is: id => id === '1' } },
      row(),
    );

    expect(soundManager.registerSound.mock.calls[0][1].spatial).toBe(false);
  });

  it('чужой танк остаётся пространственным', () => {
    const soundManager = makeSoundManager();

    new Tank(
      data(),
      assets,
      { soundManager, localPlayer: { is: () => false } },
      row('2'),
    );

    expect(soundManager.registerSound.mock.calls[0][1].spatial).toBe(true);
  });

  it('без сервиса localPlayer звук пространственный', () => {
    const soundManager = makeSoundManager();

    makeTank(soundManager);

    expect(soundManager.registerSound.mock.calls[0][1].spatial).toBe(true);
  });

  // парт своего танка строится из FIRST_SHOT_DATA, до первого бинарного
  // кадра: в конструкторе `localPlayer.id` ещё null, и флаг обязан
  // догнать через updateSoundData
  it('флаг догоняет, если localPlayer заполнился после создания', () => {
    let myId = null;
    const soundManager = makeSoundManager();
    const tank = new Tank(
      data(),
      assets,
      {
        soundManager,
        localPlayer: { is: id => myId !== null && String(id) === String(myId) },
      },
      row(),
    );

    expect(soundManager.registerSound.mock.calls[0][1].spatial).toBe(true);

    myId = '1';
    tank.update(data());

    expect(lastCall(soundManager.updateSoundData)[1].spatial).toBe(false);
  });

  // короткий ряд (m1 без хвоста) не должен ронять NaN в sound.rate:
  // clamp(undefined) даёт NaN, а NaN !== NaN — движок звал бы rate каждый
  // кадр и Web Audio отверг бы нефинитное значение
  it('короткий ряд не даёт NaN в параметрах звука', () => {
    const soundManager = makeSoundManager();
    const tank = makeTankFor(soundManager, { is: () => true });

    tank.update([0, 0, 0, 0, 0, 0]); // ряд обрывается до engineLoad

    const { rate, volume } = lastCall(soundManager.updateSoundData)[1];

    expect(Number.isFinite(rate)).toBe(true);
    expect(Number.isFinite(volume)).toBe(true);
  });

  it('позиция звука мировая и несмещённая', () => {
    const soundManager = makeSoundManager();
    const tank = makeTankFor(soundManager, { is: () => true });

    tank.update([120, 240, 0, 0, 0, 0, 0, 100, 10, 1, 0, 1, 1]);

    expect(lastCall(soundManager.updateSoundData)[1].position).toEqual({
      x: 120,
      y: 240,
    });
  });
});

// Параметры звука двигателя: нагрузка задаёт и высоту тона, и громкость, а
// на холостых тон ещё и слегка покачивается — ровный бас ухо слышит как
// гул, а не как работающий двигатель.
describe('calculateEngineSoundParams', () => {
  it('на холостом ходу отдаёт базовый тон и пониженную громкость', () => {
    const { rate, volumeFactor } = calculateEngineSoundParams(0);

    expect(rate).toBeCloseTo(1, 6);
    expect(volumeFactor).toBeCloseTo(0.6, 6);
  });

  it('на полном ходу поднимает и тон, и громкость до максимума', () => {
    const { rate, volumeFactor } = calculateEngineSoundParams(1);

    expect(rate).toBeCloseTo(1.15, 6);
    expect(volumeFactor).toBeCloseTo(1, 6);
  });

  it('при напряжении (газ в стену) поднимает тон выше полного хода', () => {
    expect(calculateEngineSoundParams(2).rate).toBeCloseTo(1.25, 6);
  });

  it('ограничивает громкость на нагрузке свыше 1.0', () => {
    expect(calculateEngineSoundParams(3).volumeFactor).toBeCloseTo(1, 6);
  });

  it('монотонно повышает тон с ростом нагрузки', () => {
    const rates = [0, 0.25, 0.5, 0.75, 1].map(
      load => calculateEngineSoundParams(load).rate,
    );

    for (let i = 1; i < rates.length; i += 1) {
      expect(rates[i]).toBeGreaterThan(rates[i - 1]);
    }
  });

  it('нечисловая нагрузка не даёт NaN', () => {
    const { rate, volumeFactor } = calculateEngineSoundParams(undefined);

    expect(Number.isFinite(rate)).toBe(true);
    expect(Number.isFinite(volumeFactor)).toBe(true);
  });

  it('покачивает тон на холостых и не трогает его на полном ходу', () => {
    // четверть периода 2.5 Гц — максимум синуса
    const peakMs = 100;

    expect(calculateEngineSoundParams(0, peakMs).rate).toBeCloseTo(1.015, 6);
    expect(calculateEngineSoundParams(0, 0).rate).toBeCloseTo(1, 6);
    // на полном ходу покачивание выключено множителем (1 - baseLoad)
    expect(calculateEngineSoundParams(1, peakMs).rate).toBeCloseTo(1.15, 6);
  });
});

// Ночь: у живого танка два конуса фар и свет под корпусом (источники
// сессии сервиса), блики фар — эмиссивные спрайты в контейнере сервиса.
describe('Tank: фары (lighting)', () => {
  const headAsset = () => ({ texture: sized(22, 22), contentSize: 20 });
  const coneAsset = () => ({
    texture: sized(136, 136),
    length: 128,
    halfWidth: 64,
    margin: 4,
  });

  // m1: [x, y, angle, gun, vx, vy, load, condition, size, team, angvel, z, level]
  const row = (condition = 100, level = 0) => [
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    condition,
    10,
    1,
    0,
    level,
    level,
  ];

  // сервис на ночной карте с зарегистрированной `head` (её передаёт Map)
  const nightService = (night = true) => {
    const service = createLighting();

    service.registerTextures({ head: headAsset() });
    service.acquireMap('k', { night, lamps: [] }, 32, 1);

    return service;
  };

  const makeLitTank = (service, condition = 100, level = 0) =>
    new Tank(
      row(condition, level),
      { ...assets, headlightConeTexture: coneAsset() },
      { soundManager: makeSoundManager(), lighting: service },
    );

  it('живой танк заводит 2 конуса и свет под корпусом, без бликов на фарах', () => {
    const service = nightService();
    const addLight = vi.spyOn(service, 'addLight');
    const addEmissive = vi.spyOn(service, 'addEmissive');

    makeLitTank(service);

    expect(addLight.mock.calls.map(([light]) => light.kind)).toEqual([
      'cone',
      'cone',
      'radial',
    ]);
    // блик засвечивал полкорпуса: эмиссива у танка нет
    expect(addEmissive).not.toHaveBeenCalled();
    expect(service.texture('cone')).not.toBeNull();
  });

  it('конусы стоят на передней кромке корпуса по его курсу', () => {
    const service = nightService();
    const tank = makeLitTank(service);
    const [left, right] = tank._headlights.cones;

    // size 10: полкорпуса вдоль курса — 20, фары разнесены поперёк
    expect(left.x).toBeCloseTo(20);
    expect(right.x).toBeCloseTo(20);
    expect(left.y).toBeLessThan(0);
    expect(right.y).toBeGreaterThan(0);
    expect(left.rotation).toBe(0);
  });

  it('без ночи источники остаются', () => {
    const service = nightService(false);
    const tank = makeLitTank(service);

    expect(tank._headlights).not.toBeNull();
  });

  it('у обломка фар нет: переход в condition 0 снимает всё', () => {
    const service = nightService();
    const removeLight = vi.spyOn(service, 'removeLight');
    const tank = makeLitTank(service);

    tank.update(row(0));

    expect(removeLight).toHaveBeenCalledTimes(3);
    expect(tank._headlights).toBeNull();

    const wreck = makeLitTank(service, 0);

    expect(wreck._headlights).toBeNull();
  });

  it('destroy снимает источники', () => {
    const service = nightService();
    const removeLight = vi.spyOn(service, 'removeLight');
    const tank = makeLitTank(service);

    tank.destroy();

    expect(removeLight).toHaveBeenCalledTimes(3);
  });

  it('смена уровня переносит фары в карту нового уровня', () => {
    const service = nightService();
    const tank = makeLitTank(service);

    tank.update(row(100, 1));

    expect(tank._headlights.cones[0].level).toBe(1);
  });

  it('на рампе свет идёт в оба уровня, на плите — в один', () => {
    const service = nightService();
    const tank = makeLitTank(service);
    const onRamp = row(100, 1);

    // z = 0.6, vz = 0 (ряд без хвоста): танк на верхней половине рампы
    onRamp[11] = 0.6;
    tank.update(onRamp);

    expect(tank._headlights.cones[0].levels).toEqual([0, 1]);
    expect(tank._headlights.cones[1].levels).toEqual([0, 1]);
    expect(tank._headlights.glow.levels).toEqual([0, 1]);

    tank.update(row(100, 1));

    expect(tank._headlights.cones[0].levels).toEqual([1]);
  });

  it('колбэк onRender по-прежнему зарегистрирован', () => {
    const tank = makeLitTank(nightService());

    expect(typeof tank._onRender).toBe('function');
  });
});
