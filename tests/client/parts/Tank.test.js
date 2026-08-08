import { describe, it, expect, vi } from 'vitest';
import { Texture } from 'pixi.js';
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
