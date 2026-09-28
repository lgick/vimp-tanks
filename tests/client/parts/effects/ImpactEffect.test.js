import { describe, it, expect, vi } from 'vitest';
import { Container, Texture } from 'pixi.js';
import ImpactEffect from '../../../../src/client/parts/effects/shot/ImpactEffect.js';
import { offsetPoint, applyParallax } from '../../../../src/client/parallax.js';

// Осколки на склоне рампы лежат на склоне: контроллер выстрела даёт
// `surfaceK` (проекцию поверхности под мировой точкой), а `project`
// переносит каждый осколок из проекции хозяина в проекцию своей высоты.

const SHEAR = 0.22;
const CONTENT_SIZE = 8;
const assets = {
  impactParticleTexture: { texture: Texture.EMPTY, contentSize: CONTENT_SIZE },
};
const camera = { x: 0, y: 0 };

// склон 0 → 1 уровень вдоль +x на [50, 150], вне его — пол хозяина
const slopeK = x => (x >= 50 && x <= 150 ? ((x - 50) / 100) * SHEAR : null);

// эффект в (100, 0); все осколки встают в мировой (80, 0) за один тик
const makeEffect = options => {
  const effect = new ImpactEffect(100, 0, -1, 0, () => {}, assets, options);

  for (const p of effect.particlesData) {
    p.x = -20;
    p.y = 0;
    p.vx = 0;
    p.vy = 0;
    p.isMoving = true;
  }

  effect._update(0);

  return effect;
};

describe('ImpactEffect: осколки на склоне рампы', () => {
  it('осколок на склоне — в проекции склона', () => {
    const surfaceK = vi.fn(slopeK);
    const effect = makeEffect({ surfaceK });
    const p = effect.particlesData[0];
    const k = 0.3 * SHEAR;

    effect.project(camera, 0);

    expect(effect.x + p.sprite.x).toBeCloseTo(
      offsetPoint(80, 0, camera, k).x,
      9,
    );
    expect(p.sprite.scale.x).toBeCloseTo((p.size / CONTENT_SIZE) * (1 + k), 9);
    expect(surfaceK).toHaveBeenCalledWith(80, 0);
  });

  it('хозяин с ненулевой проекцией: мировая точка — проекция склона', () => {
    const effect = makeEffect({ surfaceK: slopeK });
    const p = effect.particlesData[0];
    const kHost = SHEAR;
    const k = 0.3 * SHEAR;
    const host = new Container();

    applyParallax(host, camera, kHost, 1);
    effect.project(camera, kHost);

    const localX = effect.x + p.sprite.x;
    const localY = effect.y + p.sprite.y;
    const expected = offsetPoint(80, 0, camera, k);

    expect(localX * host.scale.x + host.position.x).toBeCloseTo(expected.x, 9);
    expect(localY * host.scale.y + host.position.y).toBeCloseTo(expected.y, 9);
  });

  it('у лежащего осколка высота кешируется', () => {
    const surfaceK = vi.fn(slopeK);
    const effect = makeEffect({ surfaceK });
    const calls = surfaceK.mock.calls.length;

    effect._update(16);
    effect._update(16);
    effect.project(camera, 0);

    expect(surfaceK.mock.calls.length).toBe(calls);
  });

  it('вне рампы — сырая позиция и масштаб', () => {
    const effect = makeEffect({ surfaceK: () => null });
    const p = effect.particlesData[0];

    effect.project(camera, SHEAR);

    expect(p.sprite.x).toBe(p.x);
    expect(p.sprite.y).toBe(p.y);
    expect(p.sprite.scale.x).toBeCloseTo(p.size / CONTENT_SIZE, 9);
  });

  it('без surfaceK project ничего не меняет', () => {
    const effect = makeEffect();
    const p = effect.particlesData[0];

    p.sprite.position.set(7, 9);
    p.sprite.scale.set(3);
    effect.project(camera, SHEAR);

    expect(p.sprite.x).toBe(7);
    expect(p.sprite.y).toBe(9);
    expect(p.sprite.scale.x).toBe(3);
  });

  it('без камеры — сырая позиция и масштаб', () => {
    const effect = makeEffect({ surfaceK: slopeK });
    const p = effect.particlesData[0];

    effect.project(null, SHEAR);

    expect(p.sprite.x).toBe(p.x);
    expect(p.sprite.y).toBe(p.y);
    expect(p.sprite.scale.x).toBeCloseTo(p.size / CONTENT_SIZE, 9);
  });
});
