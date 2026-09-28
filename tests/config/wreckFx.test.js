import { describe, it, expect } from 'vitest';
import models from '../../src/data/models.js';
import soundsConfig from '../../src/config/sounds.js';
import { wreckFx, lighting } from '../../src/config/render.js';

const positiveRange = range => {
  expect(range.min).toBeGreaterThan(0);
  expect(range.max).toBeGreaterThanOrEqual(range.min);
};

// Гибель танка (`src/client/parts/WreckFire.js`): числа эффекта
describe('wreckFx', () => {
  it('длительности, скорости, размеры и потолки положительны', () => {
    const { flash, fireball, sparks, fire, glow, smoke, scorch } = wreckFx;

    expect(wreckFx.maxFire).toBeGreaterThan(0);
    expect(wreckFx.maxSmoke).toBeGreaterThan(0);
    expect(wreckFx.joltRadius).toBeGreaterThanOrEqual(0);

    expect(flash.duration).toBeGreaterThan(0);
    expect(flash.startSize).toBeGreaterThan(0);
    expect(flash.endSize).toBeGreaterThan(0);

    expect(fireball.count).toBeGreaterThan(0);
    positiveRange(fireball.speed);
    positiveRange(fireball.size);
    positiveRange(fireball.lifetime);
    expect(fireball.drag).toBeGreaterThan(0);
    expect(fireball.grow).toBeGreaterThan(0);

    expect(sparks.count).toBeGreaterThan(0);
    positiveRange(sparks.speed);
    positiveRange(sparks.lifetime);
    expect(sparks.length).toBeGreaterThan(0);
    expect(sparks.width).toBeGreaterThan(0);

    expect(fire.duration).toBeGreaterThan(0);
    expect(fire.fadeOut).toBeGreaterThan(0);
    expect(fire.rate).toBeGreaterThan(0);
    expect(fire.points.length).toBeGreaterThan(0);
    positiveRange(fire.size);
    positiveRange(fire.lifetime);
    expect(fire.grow).toBeGreaterThan(0);

    expect(glow.size).toBeGreaterThan(0);

    expect(smoke.rate).toBeGreaterThan(0);
    expect(smoke.tailRate).toBeGreaterThan(0);
    expect(smoke.tail).toBeGreaterThan(0);
    expect(smoke.burst.count).toBeGreaterThan(0);
    positiveRange(smoke.burst.speed);
    positiveRange(smoke.size);
    positiveRange(smoke.lifetime);
    expect(smoke.speed).toBeGreaterThan(0);
    expect(smoke.drag).toBeGreaterThan(0);
    expect(smoke.grow).toBeGreaterThan(0);

    expect(scorch.size).toBeGreaterThan(0);
    expect(scorch.fadeIn).toBeGreaterThan(0);
  });

  it('градиент пламени — от доли 0 до 1 по возрастанию', () => {
    const shares = wreckFx.fire.ramp.map(([share]) => share);

    expect(shares[0]).toBe(0);
    expect(shares.at(-1)).toBe(1);

    for (let i = 1; i < shares.length; i += 1) {
      expect(shares[i]).toBeGreaterThan(shares[i - 1]);
    }
  });

  it('referenceSize — размер модели m1', () => {
    expect(wreckFx.referenceSize).toBe(models.m1.size);
  });

  it('звук гибели есть в sounds.js', () => {
    expect(soundsConfig.sounds[wreckFx.sound]).toBeDefined();
  });

  // штатный режим не должен упираться в потолки каналов
  it('бюджет частиц не режет штатный режим', () => {
    const { fire, fireball, sparks, smoke } = wreckFx;

    expect(
      (fire.rate * fire.lifetime.max) / 1000 + fireball.count + sparks.count,
    ).toBeLessThanOrEqual(wreckFx.maxFire);
    expect(
      (smoke.rate * smoke.lifetime.max) / 1000 + smoke.burst.count,
    ).toBeLessThanOrEqual(wreckFx.maxSmoke);
  });

  it('свет гибели и пожара: радиус и сила положительны, мерцание в [0, 1]', () => {
    for (const light of [lighting.flash.wreck, lighting.wreckFire]) {
      expect(light.radius).toBeGreaterThan(0);
      expect(light.intensity).toBeGreaterThan(0);
    }

    for (const strength of [lighting.wreckFire.flicker, wreckFx.glow.flicker]) {
      expect(strength).toBeGreaterThanOrEqual(0);
      expect(strength).toBeLessThanOrEqual(1);
    }
  });
});
