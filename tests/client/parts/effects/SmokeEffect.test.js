import { describe, it, expect, afterEach } from 'vitest';
import { Texture } from 'pixi.js';
import SmokeEffect, {
  REFERENCE_BLAST_RADIUS,
} from '../../../../src/client/parts/effects/explosion/SmokeEffect.js';

// Геометрия султана следует радиусу взрыва, времена жизни и альфа - нет.
// contentSize - диаметр нарисованного круга: холст запечённого ассета шире
// на запас под размытие, и этот запас не должен влиять на размер частиц.
const assets = {
  explosionTexture: { texture: Texture.EMPTY, contentSize: 100 },
};

const UNIT_SCALE = 1 / assets.explosionTexture.contentSize;

// границы, под которые подобран дым эталонного взрыва (в юнитах мира)
const BASE = {
  minStartSize: 2.1,
  maxStartSize: 5.2,
  minTargetSize: 8.3,
  maxTargetSize: 16.6,
  offset: 15,
  minRiseSpeed: 0.3,
  maxRiseSpeed: 0.7,
  maxSideSpeed: 0.1,
  minSwayAmp: 0.025,
  maxSwayAmp: 0.075,
};

const created = [];

const makeSmoke = radius => {
  const smoke = new SmokeEffect(assets, radius);

  created.push(smoke);

  return {
    smoke,
    blastScale: (radius ?? REFERENCE_BLAST_RADIUS) / REFERENCE_BLAST_RADIUS,
    particles: smoke._particles,
  };
};

afterEach(() => {
  for (const smoke of created.splice(0)) {
    if (!smoke.destroyed) {
      smoke.destroy();
    }
  }
});

describe('SmokeEffect: геометрия следует радиусу взрыва', () => {
  it('стартовый залп непустой', () => {
    expect(makeSmoke(REFERENCE_BLAST_RADIUS).particles.length).toBe(30);
  });

  for (const radius of [REFERENCE_BLAST_RADIUS, 120, 25]) {
    it(`размеры частиц пропорциональны радиусу ${radius}`, () => {
      const { particles, blastScale } = makeSmoke(radius);

      for (const { startScale, targetScale } of particles) {
        expect(startScale).toBeGreaterThanOrEqual(
          BASE.minStartSize * blastScale * UNIT_SCALE,
        );
        expect(startScale).toBeLessThanOrEqual(
          BASE.maxStartSize * blastScale * UNIT_SCALE,
        );
        expect(targetScale).toBeGreaterThanOrEqual(
          BASE.minTargetSize * blastScale * UNIT_SCALE,
        );
        expect(targetScale).toBeLessThanOrEqual(
          BASE.maxTargetSize * blastScale * UNIT_SCALE,
        );
      }
    });

    it(`разброс спавна и скорость подъёма пропорциональны радиусу ${radius}`, () => {
      const { particles, blastScale } = makeSmoke(radius);

      for (const particle of particles) {
        expect(Math.abs(particle.view.x)).toBeLessThanOrEqual(
          (BASE.offset * blastScale) / 2,
        );
        expect(Math.abs(particle.view.y)).toBeLessThanOrEqual(
          (BASE.offset * blastScale) / 2,
        );

        const { vx, vy, swayAmp } = particle;

        expect(-vy).toBeGreaterThanOrEqual(BASE.minRiseSpeed * blastScale);
        expect(-vy).toBeLessThanOrEqual(BASE.maxRiseSpeed * blastScale);

        expect(Math.abs(vx)).toBeLessThanOrEqual(
          BASE.maxSideSpeed * blastScale,
        );

        expect(swayAmp).toBeGreaterThanOrEqual(BASE.minSwayAmp * blastScale);
        expect(swayAmp).toBeLessThanOrEqual(BASE.maxSwayAmp * blastScale);
      }
    });

    it(`область разлёта частиц следует радиусу ${radius}`, () => {
      const { smoke, blastScale } = makeSmoke(radius);
      const bounds = smoke._particleContainer.boundsArea;

      // иначе ParticleContainer отсёк бы частицы крупного взрыва
      expect(bounds.width).toBeCloseTo(400 * blastScale, 5);
      expect(bounds.height).toBeCloseTo(800 * blastScale, 5);
      expect(bounds.x).toBeCloseTo(-bounds.width / 2, 5);
      expect(bounds.y).toBeCloseTo(-bounds.height / 2, 5);
    });
  }

  it('без радиуса используется эталонный: частицы не уходят в NaN', () => {
    const { particles } = makeSmoke(undefined);

    for (const particle of particles) {
      expect(Number.isFinite(particle.startScale)).toBe(true);
      expect(Number.isFinite(particle.view.x)).toBe(true);
    }
  });

  it('времена жизни от радиуса не зависят: масштабируется только геометрия', () => {
    const reference = makeSmoke(REFERENCE_BLAST_RADIUS).smoke;
    const bigger = makeSmoke(200).smoke;

    expect(bigger._particleMaxLifeMs).toBe(reference._particleMaxLifeMs);
    expect(bigger._particleSpawnRateMs).toBe(reference._particleSpawnRateMs);
    expect(bigger._startAlpha).toBe(reference._startAlpha);
  });

  it('масштаб нормируется по contentSize, а не по холсту с размытием', () => {
    const { smoke } = makeSmoke(REFERENCE_BLAST_RADIUS);

    // размер частицы зависит только от нарисованного круга: запас холста
    // под размытие в формулу не входит
    expect(smoke._unitScale).toBe(UNIT_SCALE);

    // вдвое больший нарисованный круг - вдвое меньший масштаб
    const denser = new SmokeEffect(
      { explosionTexture: { texture: Texture.EMPTY, contentSize: 200 } },
      REFERENCE_BLAST_RADIUS,
    );

    created.push(denser);

    expect(denser._unitScale).toBeCloseTo(smoke._unitScale / 2, 10);
  });
});
