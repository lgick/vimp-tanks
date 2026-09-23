import { describe, it, expect } from 'vitest';
import {
  blastStrength,
  blastKick,
  blastJoltState,
} from '../../src/client/blastJolt.js';
import { blastJolt } from '../../src/config/render.js';

// Визуальная реакция на взрыв: чистая математика, PixiJS не нужен

const fixed = value => () => value;

const kickAt = (blast, overrides = {}) =>
  blastKick({
    x: 0,
    y: 0,
    level: 0,
    heading: 0,
    hullLength: 12,
    blast: { radius: 50, level: 0, ...blast },
    config: blastJolt,
    rng: fixed(0.25),
    ...overrides,
  });

describe('blastStrength', () => {
  it('1 в центре, 0 на краю и вне радиуса', () => {
    expect(blastStrength(0, 50)).toBe(1);
    expect(blastStrength(25, 50)).toBeCloseTo(0.5, 6);
    expect(blastStrength(50, 50)).toBe(0);
    expect(blastStrength(80, 50)).toBe(0);
    expect(blastStrength(10, 0)).toBe(0);
  });
});

describe('blastKick', () => {
  it('вне радиуса и на другом уровне не задевает', () => {
    expect(kickAt({ x: 60, y: 0 })).toBe(null);
    expect(kickAt({ x: 20, y: 0, level: 1 })).toBe(null);
  });

  // сторона к взрыву подлетает: направление на взрыв в осях корпуса
  it('взрыв спереди — нос, сбоку — борт, с учётом курса', () => {
    const front = kickAt({ x: 20, y: 0 });

    expect(front.hop).toBe(false);
    expect(front.dirU).toBeCloseTo(1, 6);
    expect(front.dirV).toBeCloseTo(0, 6);

    // тот же взрыв при курсе π/2 — уже у борта −v
    const side = kickAt({ x: 20, y: 0 }, { heading: Math.PI / 2 });

    expect(side.dirU).toBeCloseTo(0, 6);
    expect(side.dirV).toBeCloseTo(-1, 6);
  });

  it('под корпусом — подброс', () => {
    const under = kickAt({ x: 2, y: 1 });

    expect(under.hop).toBe(true);
    expect(under.strength).toBeGreaterThan(0.9);
    expect(Math.hypot(under.dirU, under.dirV)).toBeCloseTo(1, 6);
  });
});

describe('blastJoltState', () => {
  const kick = {
    strength: 1,
    dirU: 1,
    dirV: 0,
    hop: false,
    phaseX: 0,
    phaseY: 0,
  };

  it('в первый миг сторона к взрыву поднята на rock', () => {
    const state = blastJoltState({ elapsed: 0, kick, config: blastJolt });

    expect(state.pitch).toBeCloseTo(blastJolt.rock, 6);
    expect(state.roll).toBeCloseTo(0, 6);
    expect(state.lift).toBe(0);
  });

  it('качка затухает и к концу реакция завершена', () => {
    const late = blastJoltState({
      elapsed: blastJolt.duration * 0.8,
      kick,
      config: blastJolt,
    });

    expect(Math.abs(late.pitch)).toBeLessThan(blastJolt.rock * 0.1);
    expect(
      blastJoltState({ elapsed: blastJolt.duration, kick, config: blastJolt })
        .done,
    ).toBe(true);
  });

  it('подброс — горб на hopDuration, потом высота 0', () => {
    const hopKick = { ...kick, hop: true };
    const middle = blastJoltState({
      elapsed: blastJolt.hopDuration / 2,
      kick: hopKick,
      config: blastJolt,
    });

    expect(middle.lift).toBeCloseTo(blastJolt.hop, 6);
    expect(
      blastJoltState({
        elapsed: blastJolt.hopDuration,
        kick: hopKick,
        config: blastJolt,
      }).lift,
    ).toBe(0);
  });

  it('встряска гаснет за shakeDuration', () => {
    const shaken = blastJoltState({
      elapsed: blastJolt.shakeDuration / 4,
      kick: { ...kick, phaseX: 1, phaseY: 2 },
      config: blastJolt,
    });

    expect(Math.hypot(shaken.shakeX, shaken.shakeY)).toBeGreaterThan(0);

    const calm = blastJoltState({
      elapsed: blastJolt.shakeDuration,
      kick: { ...kick, phaseX: 1, phaseY: 2 },
      config: blastJolt,
    });

    expect(calm.shakeX).toBe(0);
    expect(calm.shakeY).toBe(0);
  });
});
