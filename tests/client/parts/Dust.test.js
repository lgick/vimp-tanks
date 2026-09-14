import { describe, it, expect, vi, afterEach } from 'vitest';
import { Container, Texture } from 'pixi.js';
import Dust from '../../../src/client/parts/Dust.js';
import ParticlePool from '../../../src/client/parts/ParticlePool.js';
import { landing, surfaceFx } from '../../../src/config/render.js';

// startSizeFactor обычной пыли (DUST_CONFIG в Dust.js)
const DUST_START_SIZE = 0.7;

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

  it('продолжающийся полёт всплеска не даёт', () => {
    const dust = makeDust({}, row({ vz: -6 }));

    dust.update(row({ vz: -3 }));

    expect(dust._particles.length).toBe(0);
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

// сервис поверхностей: клетки по x шириной 20 — [0, 20) песок, [20, 40)
// бустер на восток, [40, 60) вторая клетка той же плиты, [60, 80) вода,
// [80, 100) масло, дальше нейтрально
const surfaceAt = x => {
  if (x < 0) {
    return null;
  }

  return ['sand', 'boost', 'boost', 'water', 'oil'][Math.floor(x / 20)] ?? null;
};

const makeSurfaces = () => ({
  kindAt: vi.fn(x => surfaceAt(x)),
  dirAt: vi.fn(x => (surfaceAt(x) === 'boost' ? [1, 0] : null)),
});

// ряд с позицией: `row` держит x = 0
const at = (x, options = {}) => {
  const data = row(options);

  data[0] = x;

  return data;
};

describe('Dust: поверхности', () => {
  it('без сервиса surfaces поведение прежнее: на ходу пыли нет', () => {
    const dust = makeDust({}, at(10, { vx: 50 }));

    dust.update(at(10, { vx: 50 }));
    dust._updateParticles(200);

    expect(dust._surfaceKind).toBe(null);
    expect(dust._particles.length).toBe(0);
  });

  it('песок пылит на ходу светлой пылью', () => {
    const dust = makeDust({ surfaces: makeSurfaces() }, at(10, { vx: 50 }));

    dust.update(at(10, { vx: 50 }));
    dust._updateParticles(200);

    expect(dust._particles.length).toBeGreaterThan(0);
    expect(dust._particles[0].view.tint).toBe(surfaceFx.sand.color);
  });

  it('грязь даёт тёмные крупные комья', () => {
    const surfaces = { kindAt: () => 'mud', dirAt: () => null };
    const dust = makeDust({ surfaces }, at(10, { vx: 50 }));

    dust.update(at(10, { vx: 50 }));
    dust._updateParticles(200);

    expect(dust._particles.length).toBeGreaterThan(0);
    expect(dust._particles[0].view.tint).toBe(surfaceFx.mud.color);
    expect(dust._particles[0].startSizeFactor).toBeGreaterThan(
      DUST_START_SIZE,
    );
  });

  it('стоящий танк на песке не пылит', () => {
    const dust = makeDust({ surfaces: makeSurfaces() }, at(10));

    dust.update(at(10));
    dust._updateParticles(500);

    expect(dust._particles.length).toBe(0);
  });

  it('масло не пылит даже при буксовании', () => {
    const dust = makeDust(
      { surfaces: makeSurfaces() },
      at(90, { engineLoad: 1.6 }),
    );

    dust.update(at(90, { engineLoad: 1.6 }));
    dust._updateParticles(200);

    expect(dust._particles.length).toBe(0);
  });

  it('въезд в воду со скоростью даёт разовый всплеск', () => {
    const dust = makeDust({ surfaces: makeSurfaces() }, at(58, { vx: 50 }));

    dust.update(at(58, { vx: 50 }));
    expect(dust._particles.length).toBe(0);

    dust.update(at(62, { vx: 50 }));
    const burst = dust._particles.length;

    expect(burst).toBe(surfaceFx.water.entryBurst * 2);
    expect(dust._particles[0].view.tint).toBe(surfaceFx.water.color);

    dust.update(at(64, { vx: 50 }));
    expect(dust._particles.length).toBe(burst);
  });

  it('въезд на бустер по стрелке даёт одну вспышку', () => {
    const dust = makeDust({ surfaces: makeSurfaces() }, at(17, { vx: 50 }));

    dust.update(at(18, { vx: 50 }));
    dust.update(at(22, { vx: 50 }));

    expect(dust._particles.length).toBe(surfaceFx.boost.burst);
    expect(dust._particles[0].view.tint).toBe(surfaceFx.boost.color);

    // переход на вторую клетку той же плиты вспышки не даёт
    dust.update(at(42, { vx: 50 }));

    expect(dust._particles.length).toBe(surfaceFx.boost.burst);
  });

  it('въезд против стрелки или медленнее порога вспышки не даёт', () => {
    const against = makeDust({ surfaces: makeSurfaces() }, at(62, { vx: -50 }));

    against.update(at(62, { vx: -50 }));
    against.update(at(58, { vx: -50 }));

    const slow = { vx: surfaceFx.boost.boostMinSpeed / 2 };
    const crawl = makeDust({ surfaces: makeSurfaces() }, at(18, slow));

    crawl.update(at(18, slow));
    crawl.update(at(21, slow));

    const flashes = dust =>
      dust._particles.filter(p => p.view.tint === surfaceFx.boost.color);

    expect(flashes(against).length).toBe(0);
    expect(flashes(crawl).length).toBe(0);
  });

  it('первый кадр на плите бустера вспышки не даёт', () => {
    const dust = makeDust({ surfaces: makeSurfaces() }, at(30, { vx: 50 }));

    dust.update(at(30, { vx: 50 }));

    expect(dust._particles.length).toBe(0);
  });

  it('респаун прямо на плите бустера вспышки не даёт', () => {
    const dust = makeDust({ surfaces: makeSurfaces() }, at(10, { vx: 50 }));

    dust.update(at(10, { vx: 50 }));
    dust.update(at(10, { vx: 50, condition: 0 }));
    dust.update(at(30, { vx: 50, condition: 3 }));

    expect(dust._particles.length).toBe(0);
  });

  it('скачок позиции (телепорт) на плиту вспышки не даёт', () => {
    const jump = surfaceFx.boost.resetDistance + 1;
    const surfaces = makeSurfaces();
    const dust = makeDust({ surfaces }, at(-jump, { vx: 50 }));

    dust.update(at(-jump, { vx: 50 }));
    dust.update(at(30, { vx: 50 }));

    expect(dust._particles.length).toBe(0);
  });

  it('колбэк onRender по-прежнему регистрируется', () => {
    const dust = makeDust({ surfaces: makeSurfaces() });

    expect(typeof dust._onRender).toBe('function');
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
