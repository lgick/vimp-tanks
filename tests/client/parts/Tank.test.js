import { describe, it, expect, vi } from 'vitest';
import { Container, Texture } from 'pixi.js';
import Tank from '../../../src/client/parts/Tank.js';

// Part танка поверх Pixi Container: проверяется только звуковой контур
// (регистрация/обновление/снятие) — визуал рендером не трогаем.

const liveTextures = () => ({
  body: Texture.EMPTY,
  gun: Texture.EMPTY,
  gunAnchor: { x: 0.5, y: 0.5 },
});

const assets = {
  tankTexture: {
    liveTeamId1: liveTextures(),
    liveTeamId2: liveTextures(),
    destroyed: Texture.EMPTY,
  },
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

// 2.5D: уровень танка задаёт слой отрисовки, а свой танк ещё и сообщает
// сервису levelView, где он и на каком уровне — по этому плита моста над
// игроком становится полупрозрачной (Map.onRender).
describe('Tank: уровни 2.5D', () => {
  // строка m1 целиком: [..., angvel, z, level]
  const row = (level, z = 0, x = 0, y = 0) => [
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
    layered: false,
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
// и самый читаемый из них, бейдж — знак СВОЕГО уровня, и только на слоёной
// карте.
describe('Tank: признаки уровня и высоты', () => {
  const badges = [Texture.EMPTY, Texture.EMPTY, Texture.EMPTY];

  const viewAssets = {
    ...assets,
    tankShadowTexture: { texture: Texture.EMPTY, contentSize: 24 },
    levelBadgeTexture: badges,
  };

  // строка m1 целиком: [..., angvel, z, level]
  const row = (level, z = 0, x = 0, y = 0) => [
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

  // камера — трансформ сцены плюс размер полотна (src/client/camera.js):
  // при пустом трансформе её центр — середина полотна
  const renderer = { screen: { width: 800, height: 600 } };

  const makeView = (layered = true) => ({
    level: 0,
    x: 0,
    y: 0,
    layered,
    set() {},
    alphaFor: () => 1,
    tintFor: () => 0xffffff,
  });

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

  it('тень уезжает от корпуса тем сильнее, чем выше танк', () => {
    const { tank } = onStage({ levelView: makeView() });

    tank.update(row(0, 0, 100, 100));
    tank.onRender();

    expect(tank._shadow.x).toBeCloseTo(100);

    tank.update(row(0, 2, 100, 100));
    tank.onRender();

    const low = Math.abs(tank._shadow.x - tank.x);

    tank.update(row(0, 4, 100, 100));
    tank.onRender();

    expect(Math.abs(tank._shadow.x - tank.x)).toBeGreaterThan(low);
  });

  it('тень уезжает сильнее у края экрана, чем в центре камеры', () => {
    const { tank } = onStage({ levelView: makeView() });

    // центр камеры — (400, 300): в нём сдвига нет вовсе
    tank.update(row(0, 3, 400, 300));
    tank.onRender();

    expect(Math.abs(tank._shadow.x - tank.x)).toBeCloseTo(0);

    tank.update(row(0, 3, 100, 300));
    tank.onRender();

    expect(Math.abs(tank._shadow.x - tank.x)).toBeGreaterThan(0);
  });

  // тень лежит на слое, НАД которым висит танк: по ней и видно, что танк
  // поднялся по рампе, а не едет по земле
  it('тень остаётся на уровне под танком', () => {
    const { tank } = onStage({ levelView: makeView() });

    tank.update(row(1, 0.5, 100, 100));
    tank.onRender();

    expect(tank._shadow.zIndex).toBe(2);

    tank.update(row(1, 1.2, 100, 100));
    tank.onRender();

    expect(tank._shadow.zIndex).toBe(102);
  });

  it('тень уходит вместе с танком: движок про неё не знает', () => {
    const { tank, stage } = onStage({ levelView: makeView() });

    tank.onRender();

    expect(stage.children).toHaveLength(2);

    tank.destroy();

    expect(stage.children).toHaveLength(0);
  });

  // парты строятся из FIRST_SHOT_DATA, когда свой id ещё неизвестен: бейдж
  // обязан появиться позже, а не остаться скрытым навсегда
  it('бейдж уровня показывается только своему танку', () => {
    let myId = null;
    const localPlayer = {
      is: id => myId !== null && String(id) === String(myId),
    };
    const { tank } = onStage({ levelView: makeView(), localPlayer });

    tank.onRender();

    expect(tank._badge.visible).toBe(false);

    myId = '1';
    tank.onRender();

    expect(tank._badge.visible).toBe(true);
  });

  it('на плоской карте бейджа нет вовсе', () => {
    const { tank } = onStage({
      levelView: makeView(false),
      localPlayer: { is: () => true },
    });

    tank.onRender();

    expect(tank._badge.visible).toBe(false);
  });

  // значок печётся в «пекарских» пикселях, как и корпус, но добавляется
  // отдельным спрайтом: забыть про `_scaleFactor` — значит получить диск
  // вдвое шире танка, который ложится на корпус, и вместо танка на карте
  // виден белый кружок
  it('бейдж приведён к мировому масштабу корпуса', () => {
    const { tank } = onStage({
      levelView: makeView(),
      localPlayer: { is: () => true },
    });

    expect(tank._badge.scale.x).toBeCloseTo(tank._scaleFactor * 1.4);
    expect(tank._badge.scale.y).toBeCloseTo(tank._badge.scale.x);
  });

  // корпус — 4 × 3 размера (`src/data/models.js`), значит по полудлине это
  // два размера от центра; значок обязан выноситься дальше при ЛЮБОМ курсе
  it('бейдж не наезжает на корпус и не кружит вокруг него', () => {
    const { tank } = onStage({
      levelView: makeView(),
      localPlayer: { is: () => true },
    });

    const halfLength = tank._size * 2;

    for (const angle of [0, Math.PI / 4, Math.PI / 2, 2.5, -1.3]) {
      const data = row(0);

      data[2] = angle;
      tank.update(data);
      tank.onRender();

      // в мировых осях значок всегда строго под танком
      const badge = tank.toGlobal(tank._badge.position);

      expect(badge.x).toBeCloseTo(tank.x);
      expect(badge.y - tank.y).toBeGreaterThan(halfLength);
      expect(tank._badge.rotation).toBeCloseTo(-angle);
    }
  });

  it('бейдж берёт текстуру своего уровня', () => {
    const { tank } = onStage({
      levelView: makeView(),
      localPlayer: { is: () => true },
    });

    tank.update(row(2));
    tank.onRender();

    expect(tank._badge.texture).toBe(badges[2]);
  });
});
