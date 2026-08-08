import { describe, it, expect, vi, afterEach } from 'vitest';
import { Texture, Ticker } from 'pixi.js';
import Bomb from '../../../src/client/parts/Bomb.js';

// Part бомбы: звуковой контур и снятие тика. Одноразовый сэмпл постановки
// живёт дольше самой сущности — её убирает детонация.

const assets = { bombTexture: Texture.EMPTY };

const makeSoundManager = () => ({
  registerSound: vi.fn(() => Symbol('planted')),
  releaseSound: vi.fn(),
  unregisterSound: vi.fn(),
  updateSoundData: vi.fn(() => true),
});

// [x, y, rotation, size, durationMs, ownerId]
const params = [10, 20, 0, 16, 3000, 1];

// созданные бомбы держат слушатель Ticker.shared до destroy() — иначе они
// копятся между тестами и ломают счётчик тикера
const created = [];

const makeBomb = soundManager => {
  const bomb = new Bomb(params, assets, { soundManager });

  created.push(bomb);

  return bomb;
};

afterEach(() => {
  for (const bomb of created.splice(0)) {
    if (!bomb.destroyed) {
      bomb.destroy();
    }
  }
});

describe('Bomb: звук постановки', () => {
  it('регистрирует сэмпл постановки в позиции бомбы', () => {
    const soundManager = makeSoundManager();

    makeBomb(soundManager);

    expect(soundManager.registerSound).toHaveBeenCalledWith(
      'bombHasBeenPlanted',
      { position: { x: 10, y: 20 } },
    );
  });

  it('destroy отпускает сэмпл, а не обрывает его', () => {
    const soundManager = makeSoundManager();
    const bomb = makeBomb(soundManager);
    const soundId = soundManager.registerSound.mock.results[0].value;

    bomb.destroy();

    expect(soundManager.releaseSound).toHaveBeenCalledWith(soundId);
    expect(soundManager.unregisterSound).not.toHaveBeenCalled();
  });

  it('destroy снимает слушатель тикера и не отпускает звук дважды', () => {
    const soundManager = makeSoundManager();
    const bomb = makeBomb(soundManager);
    const before = Ticker.shared.count;

    bomb.destroy();

    expect(Ticker.shared.count).toBe(before - 1);

    bomb.destroy({ children: false });

    expect(soundManager.releaseSound).toHaveBeenCalledTimes(1);
  });
});

describe('Bomb: авторитетная коррекция позиции', () => {
  it('update переносит спрайт и позицию сэмпла в присланную точку', () => {
    const soundManager = makeSoundManager();
    const bomb = makeBomb(soundManager);
    const soundId = soundManager.registerSound.mock.results[0].value;

    bomb.update([42, -17, 1.5, 16, 3000, 1]);

    expect(bomb.x).toBe(42);
    expect(bomb.y).toBe(-17);
    expect(bomb.rotation).toBe(1.5);
    expect(soundManager.updateSoundData).toHaveBeenCalledWith(soundId, {
      position: { x: 42, y: -17 },
    });
  });

  it('коррекция не пересоздаёт бомбу: таймер и звук заводятся один раз', () => {
    const soundManager = makeSoundManager();
    const before = Ticker.shared.count;
    const bomb = makeBomb(soundManager);

    bomb.update([42, -17, 0, 16, 3000, 1]);

    expect(soundManager.registerSound).toHaveBeenCalledTimes(1);
    expect(Ticker.shared.count).toBe(before + 1);
  });

  it('снятую регистрацию звука не дёргают повторно', () => {
    const soundManager = makeSoundManager();
    const bomb = makeBomb(soundManager);

    // регистрацию снял reset(): сэмпл одноразовый, перерегистрировать нечего
    soundManager.updateSoundData.mockReturnValueOnce(false);

    bomb.update([1, 2, 0, 16, 3000, 1]);
    bomb.update([3, 4, 0, 16, 3000, 1]);

    expect(soundManager.updateSoundData).toHaveBeenCalledTimes(1);

    // отпускать тоже нечего
    bomb.destroy();

    expect(soundManager.releaseSound).not.toHaveBeenCalled();
  });
});
