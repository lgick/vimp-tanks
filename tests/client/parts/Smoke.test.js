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
