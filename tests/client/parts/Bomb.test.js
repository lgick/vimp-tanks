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
