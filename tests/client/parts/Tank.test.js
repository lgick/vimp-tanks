import { describe, it, expect, vi } from 'vitest';
import { Container, Texture } from 'pixi.js';
import Tank, {
  calculateEngineSoundParams,
} from '../../../src/client/parts/Tank.js';
import { shadow, parallax } from '../../../src/config/render.js';

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

  // камера — трансформ сцены плюс размер полотна (src/client/camera.js):
  // при пустом трансформе её центр — середина полотна
  const renderer = { screen: { width: 800, height: 600 } };

  const makeView = () => ({
    level: 0,
    x: 0,
    y: 0,
    set() {},
    setCamera() {},
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

  // проекция 2.5D: смещается КОРПУС, тень остаётся в мировой точке. Раньше
  // было наоборот, и тень выглядела выше танка
  it('корпус уезжает от тени тем сильнее, чем выше танк', () => {
    const { tank } = onStage({ levelView: makeView() });

    tank.update(row(0, 0, 100, 100));
    tank.onRender();

    expect(tank.x).toBeCloseTo(100);
    expect(tank._shadow.x).toBeCloseTo(100);

    tank.update(row(0, 2, 100, 100));
    tank.onRender();

    const low = Math.abs(tank.x - tank._shadow.x);

    tank.update(row(0, 4, 100, 100));
    tank.onRender();

    expect(Math.abs(tank.x - tank._shadow.x)).toBeGreaterThan(low);
  });

  // масштаб высоты — та же проекция, что у плиты: танк на уровне 1 крупнее
  // наземного ровно настолько же, насколько крупнее сама плита под ним
  it('корпус на высоте крупнее ровно на shear', () => {
    const { tank } = onStage({ levelView: makeView() });

    tank.update(row(0, 0, 100, 100));

    const ground = tank.body.scale.x;

    tank.update(row(1, 1, 100, 100));

    expect(tank.body.scale.x / ground).toBeCloseTo(1 + parallax.shear, 6);
    expect(tank.gun.scale.x).toBeCloseTo(tank.body.scale.x, 6);
    // обломки едут по той же проекции: иначе подбитый танк съедет с плиты
    expect(tank.wreck.scale.x).toBeCloseTo(tank.body.scale.x, 6);
  });

  // тень — силуэт корпуса: круглая тень нормировалась по `size` (2 единицы
  // при корпусе 8 × 6) и её мягкий ореол вылезал из-под углов вращающегося
  // корпуса серым кружком
  it('тень при z = 0 не крупнее корпуса больше, чем на sizeFactor', () => {
    const { tank } = onStage({ levelView: makeView() });

    tank.update(row(0, 0, 100, 100));
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

  it('с высотой тень растёт и бледнеет', () => {
    const { tank } = onStage({ levelView: makeView() });

    tank.update(row(0, 0, 100, 100));
    tank.onRender();

    const groundScale = tank._shadow.scale.x;
    const groundAlpha = tank._shadow.alpha;

    tank.update(row(1, 1, 100, 100));
    tank.onRender();

    expect(tank._shadow.scale.x).toBeGreaterThan(groundScale);
    expect(tank._shadow.alpha).toBeLessThan(groundAlpha);
  });

  it('тень всегда стоит в мировой точке танка', () => {
    const { tank } = onStage({ levelView: makeView() });

    tank.update(row(0, 3, 100, 250));
    tank.onRender();

    expect(tank._shadow.x).toBeCloseTo(100);
    expect(tank._shadow.y).toBeCloseTo(250);
    // корпус при этом уехал от центра камеры (400, 300)
    expect(tank.x).toBeLessThan(100);
    expect(tank.y).toBeLessThan(250);
  });

  it('корпус уезжает сильнее у края экрана, чем в центре камеры', () => {
    const { tank } = onStage({ levelView: makeView() });

    // центр камеры — (400, 300): в нём сдвига нет вовсе
    tank.update(row(0, 3, 400, 300));
    tank.onRender();

    expect(Math.abs(tank.x - tank._shadow.x)).toBeCloseTo(0);

    tank.update(row(0, 3, 100, 300));
    tank.onRender();

    expect(Math.abs(tank.x - tank._shadow.x)).toBeGreaterThan(0);
  });

  // в levelView, в звук и в уклон уходит НЕсмещённая точка: иначе поехали бы
  // и дыра в плите, и панорама своего танка
  it('в levelView уходит мировая, а не нарисованная точка', () => {
    const set = vi.fn();
    const localPlayer = { is: () => true };
    const { tank } = onStage({ levelView: { ...makeView(), set }, localPlayer });

    tank.update(row(1, 1, 100, 250));
    tank.onRender();

    expect(set).toHaveBeenLastCalledWith(1, 100, 250, 1);
    expect(tank.x).not.toBeCloseTo(100);
  });

  // центр камеры считает один владелец за кадр — свой танк: сервис
  // проецирует по нему и игрока, и сущность, когда считает alpha
  it('свой танк публикует центр камеры в levelView', () => {
    const setCamera = vi.fn();
    const localPlayer = { is: () => true };
    const { tank } = onStage({
      levelView: { ...makeView(), setCamera },
      localPlayer,
    });

    tank.update(row(1, 1, 100, 250));
    tank.onRender();

    expect(setCamera).toHaveBeenLastCalledWith(
      expect.objectContaining({ x: 400, y: 300 }),
    );
  });

  it('чужой танк центр камеры не публикует', () => {
    const setCamera = vi.fn();
    const localPlayer = { is: () => false };
    const { tank } = onStage({
      levelView: { ...makeView(), setCamera },
      localPlayer,
    });

    tank.update(row(1, 1, 100, 250));
    tank.onRender();

    expect(setCamera).not.toHaveBeenCalled();
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
});

// Д9: слушатель — центр камеры, то есть свой же танк. Источник, лежащий
// ровно на слушателе, HRTF сворачивает в гребенчатую окраску («гул»), а
// расхождение камеры и танка в пару пикселей кидает звук целиком в одно
// ухо. Свой двигатель принадлежит игроку, а не миру.
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
