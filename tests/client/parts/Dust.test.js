import { describe, it, expect, vi, afterEach } from 'vitest';
import { Container, Texture } from 'pixi.js';
import Dust from '../../../src/client/parts/Dust.js';
import ParticlePool from '../../../src/client/parts/ParticlePool.js';
import { landing } from '../../../src/config/render.js';

// Пыль — отдельная часть, а не канал внутри Smoke: она живёт на земле, у неё
// своя текстура и своя геометрия (две точки контакта гусениц, не труба).
// Два триггера: буксование (engineLoad > 1 при стоящем танке) и приземление
// (детектор по vz, тот же, что в Tank.js).

const assets = {
  dustTexture: { texture: Texture.EMPTY, contentSize: 32 },
};

// [x, y, angle, gunRotation, vX, vY, engineLoad, condition, size, teamId,
//  angvel, z, level, vz, pitch, roll]
const row = ({ engineLoad = 0, vx = 0, vy = 0, vz = 0, condition = 3 } = {}) => [
  0,
  0,
  0,
  0,
  vx,
  vy,
  engineLoad,
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

const renderer = { screen: { width: 800, height: 600 } };

const levelView = {
  alphaFor: () => 1,
  tintFor: () => 0xffffff,
};

// созданные парты держат слушатель Ticker.shared до destroy()
const created = [];

const makeDust = (dependencies = {}, data = row()) => {
  const dust = new Dust(data, assets, { renderer, levelView, ...dependencies });
  const stage = new Container();

  stage.addChild(dust);
  created.push(dust);

  return dust;
};

afterEach(() => {
  for (const dust of created.splice(0)) {
    if (!dust.destroyed) {
      dust.destroy();
    }
  }
});

describe('Dust: проводка', () => {
  // `onRender` у Container — аксессор: одноимённый метод на прототипе
  // затенил бы его сеттер, оставив `_onRender` null
  it('регистрирует колбэк onRender в PixiJS', () => {
    const dust = makeDust();

    expect(typeof dust._onRender).toBe('function');
  });

  it('без сервисов levelView и renderer колбэка нет вовсе', () => {
    const dust = new Dust(row(), assets, {});

    created.push(dust);

    expect(dust._onRender).toBe(null);
  });
});

describe('Dust: буксование', () => {
  it('упор в стену поднимает пыль из-под гусениц', () => {
    const dust = makeDust({}, row({ engineLoad: 1.6 }));

    // кадр короче времени жизни частицы: спавн виден по живым частицам
    dust._updateParticles(200);

    expect(dust._particles.length).toBeGreaterThan(0);
  });

  it('без напряжения пыли нет', () => {
    const dust = makeDust({}, row({ engineLoad: 1.0 }));

    dust._updateParticles(1000);

    expect(dust._particles.length).toBe(0);
  });

  it('едущий танк не буксует', () => {
    const dust = makeDust({}, row({ engineLoad: 1.6, vx: 50 }));

    dust._updateParticles(1000);

    expect(dust._particles.length).toBe(0);
  });
});

describe('Dust: приземление', () => {
  it('жёсткое касание даёт всплеск', () => {
    const dust = makeDust({}, row({ vz: -8 }));

    expect(dust._particles.length).toBe(0);

    dust.update(row({ vz: 0 }));

    expect(dust._particles.length).toBeGreaterThan(0);
  });

  it('мягкое касание всплеска не даёт', () => {
    const dust = makeDust({}, row({ vz: -landing.minImpact / 2 }));

    dust.update(row({ vz: 0 }));

    expect(dust._particles.length).toBe(0);
  });

  it('приземление зовёт звук ровно один раз', () => {
    const registerSound = vi.fn();
    const soundManager = {
      getSoundConfig: () => ({ volume: 0.7 }),
      registerSound,
    };
    const dust = makeDust({ soundManager }, row({ vz: -8 }));

    dust.update(row({ vz: 0 }));
    dust.update(row({ vz: 0 }));

    expect(registerSound).toHaveBeenCalledTimes(1);
    expect(registerSound.mock.calls[0][0]).toBe('tankLanding');
  });

  it('без ассета звука приземление проходит без исключения', () => {
    const soundManager = {
      getSoundConfig: () => undefined,
      registerSound: vi.fn(),
    };
    const dust = makeDust({ soundManager }, row({ vz: -8 }));

    expect(() => dust.update(row({ vz: 0 }))).not.toThrow();
    expect(soundManager.registerSound).not.toHaveBeenCalled();
  });
});

describe('Dust: жизненный цикл', () => {
  it('destroy возвращает частицы в пул', () => {
    const dust = makeDust({}, row({ engineLoad: 1.6 }));

    dust._updateParticles(200);

    const count = dust._particles.length;
    const release = vi.spyOn(ParticlePool, 'release');

    dust.destroy();

    expect(count).toBeGreaterThan(0);
    expect(release).toHaveBeenCalledTimes(count);

    release.mockRestore();
  });
});
