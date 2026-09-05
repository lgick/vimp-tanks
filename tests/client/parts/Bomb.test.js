import { describe, it, expect, vi, afterEach } from 'vitest';
import { Container, Texture, Ticker } from 'pixi.js';
import Bomb from '../../../src/client/parts/Bomb.js';
import { parallax } from '../../../src/config/render.js';

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

const makeBomb = (soundManager, dependencies = {}, row = params) => {
  const bomb = new Bomb(row, assets, { soundManager, ...dependencies });

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

// Проекция высоты: бомба на мосту рисуется смещённой ОТ центра камеры и
// увеличенной ровно так же, как плита под ней. Одно число на всю динамику
// (`src/config/render.js`, `parallax.shear`) — иначе бомба съедет с моста
describe('Bomb: проекция высоты', () => {
  // камера — трансформ сцены плюс размер полотна (src/client/camera.js)
  const renderer = { screen: { width: 800, height: 600 } };

  const onStage = row => {
    const bomb = makeBomb(makeSoundManager(), { renderer }, row);
    const stage = new Container();

    stage.addChild(bomb);

    return bomb;
  };

  it('на земле сдвига и масштаба нет', () => {
    const bomb = onStage([100, 100, 0, 16, 3000, 1, 0]);

    bomb.onRender();

    expect(bomb.x).toBeCloseTo(100, 6);
    expect(bomb.y).toBeCloseTo(100, 6);
    expect(bomb.scale.x).toBeCloseTo(1, 6);
  });

  it('на уровне 1 бомба уезжает от центра камеры и становится крупнее', () => {
    const bomb = onStage([100, 100, 0, 16, 3000, 1, 1]);

    bomb.onRender();

    // центр камеры — (400, 300): точка уезжает ОТ него
    expect(bomb.x).toBeLessThan(100);
    expect(bomb.y).toBeLessThan(100);
    expect(bomb.scale.x).toBeCloseTo(1 + parallax.shear, 6);
    // мировая точка при этом не тронута: по ней считают звук и alpha
    expect(bomb._worldX).toBe(100);
    expect(bomb._worldY).toBe(100);
  });
});
