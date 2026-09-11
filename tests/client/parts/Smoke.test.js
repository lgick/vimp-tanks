import { describe, it, expect, afterEach } from 'vitest';
import { Container, Texture } from 'pixi.js';
import Smoke from '../../../src/client/parts/Smoke.js';
import { parallax } from '../../../src/config/render.js';

// Проекция высоты: дым на мосту стоит на мосту, а не на земле под ним.
// Частицы живут в мировых координатах, контейнер парта единичный — сдвиг и
// масштаб ставит трансформ контейнера, той же формулой, что у плиты.

const assets = {
  smokeTexture: { texture: Texture.EMPTY, contentSize: 32 },
};

// [x, y, angle, gunRotation, vX, vY, engineLoad, condition, size, teamId,
//  angvel, z, level]
const row = (x = 0, y = 0, z = 0, level = 0) => [
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

// тот же ряд, но с газом и осмысленным condition: канал выхлопа читает
// engineLoad, а не повреждения
const gasRow = (engineLoad, condition = 3, size = 10) => [
  0,
  0,
  0,
  0,
  0,
  0,
  engineLoad,
  condition,
  size,
  1,
  0,
  0,
  0,
];

// созданные парты держат слушатель Ticker.shared до destroy()
const created = [];

// камера — трансформ сцены плюс размер полотна (src/client/camera.js):
// при пустом трансформе её центр — середина полотна
const renderer = { screen: { width: 800, height: 600 } };

const onStage = data => {
  const smoke = new Smoke(data, assets, {
    renderer,
    levelView: {
      alphaFor: () => 1,
      tintFor: () => 0xffffff,
    },
  });
  const stage = new Container();

  stage.addChild(smoke);
  created.push(smoke);

  return smoke;
};

afterEach(() => {
  for (const smoke of created.splice(0)) {
    if (!smoke.destroyed) {
      smoke.destroy();
    }
  }
});

describe('Smoke: проекция высоты', () => {
  it('на земле сдвига и масштаба нет', () => {
    const smoke = onStage(row(100, 100));

    smoke.onRender();

    expect(smoke.position.x).toBeCloseTo(0, 6);
    expect(smoke.position.y).toBeCloseTo(0, 6);
    expect(smoke.scale.x).toBeCloseTo(1, 6);
  });

  it('на высоте облако уезжает от центра камеры и растёт', () => {
    const smoke = onStage(row(100, 100, 1, 1));

    smoke.onRender();

    expect(smoke.scale.x).toBeCloseTo(1 + parallax.shear, 6);
    // сдвиг ставится трансформом: -camera * k (src/client/parallax.js)
    expect(smoke.position.x).toBeCloseTo(-400 * parallax.shear, 6);
    expect(smoke.position.y).toBeCloseTo(-300 * parallax.shear, 6);
  });

  it('высота едет из снапшота: подъём меняет проекцию', () => {
    const smoke = onStage(row(100, 100));

    smoke.onRender();

    expect(smoke.scale.x).toBeCloseTo(1, 6);

    smoke.update(row(100, 100, 2, 2));
    smoke.onRender();

    expect(smoke.scale.x).toBeCloseTo(1 + 2 * parallax.shear, 6);
  });
});

// счётчик спавнов по каналам: живых частиц за секунду считать нельзя —
// часть из них к концу прогона уже отжила своё
const countSpawns = smoke => {
  const kinds = [];
  const spawn = smoke.spawnParticle.bind(smoke);

  smoke.spawnParticle = (streamIndex, numStreams, kind = 'damage') => {
    kinds.push(kind);
    spawn(streamIndex, numStreams, kind);
  };

  return kinds;
};

// секунда прогона тикера кадрами по 100 мс
const runSecond = smoke => {
  for (let i = 0; i < 10; i += 1) {
    smoke._updateParticles(100);
  }
};

describe('Smoke: выхлоп по газу', () => {
  it('целый танк на газу дымит из трубы', () => {
    const smoke = onStage(gasRow(1));
    const kinds = countSpawns(smoke);

    runSecond(smoke);

    expect(kinds.filter(kind => kind === 'exhaust').length).toBeGreaterThan(0);
  });

  it('на холостом ходу выхлоп реже, чем на полном газу', () => {
    const idle = onStage(gasRow(0.1));
    const full = onStage(gasRow(1));
    const idleKinds = countSpawns(idle);
    const fullKinds = countSpawns(full);

    runSecond(idle);
    runSecond(full);

    expect(idleKinds.length).toBeGreaterThan(0);
    expect(idleKinds.length).toBeLessThan(fullKinds.length);
  });

  it('уничтоженный танк выхлопа не даёт: газа нет', () => {
    const smoke = onStage(gasRow(1, 0));
    const kinds = countSpawns(smoke);

    runSecond(smoke);

    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds.every(kind => kind === 'damage')).toBe(true);
  });

  it('выхлоп пропорционален размеру танка', () => {
    // множитель размера зажат снизу (max(0.5, ...)), поэтому сравниваются
    // размеры выше зажима
    const small = onStage(gasRow(1, 3, 10));
    const big = onStage(gasRow(1, 3, 20));

    // один короткий кадр: частицы ещё живы и сравнимы по стартовому размеру
    small._updateParticles(200);
    big._updateParticles(200);

    expect(big._particles[0].view.scaleX).toBeGreaterThan(
      small._particles[0].view.scaleX,
    );
  });
});
