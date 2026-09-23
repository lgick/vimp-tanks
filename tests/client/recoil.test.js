import { describe, it, expect } from 'vitest';
import { recoilAmount, recoilOffsets } from '../../src/client/recoil.js';
import { recoil } from '../../src/config/render.js';

// Визуальная отдача: чистая математика, PixiJS не нужен

describe('recoilAmount', () => {
  const { duration, attack } = recoil;

  it('в покое и после конца — 0', () => {
    expect(recoilAmount(-1, duration, attack)).toBe(0);
    expect(recoilAmount(0, duration, attack)).toBe(0);
    expect(recoilAmount(duration, duration, attack)).toBe(0);
    expect(recoilAmount(duration * 2, duration, attack)).toBe(0);
  });

  it('пик 1 на конце роста', () => {
    expect(recoilAmount(attack * duration, duration, attack)).toBeCloseTo(1, 6);
  });

  it('рост и спад монотонны', () => {
    const peak = attack * duration;
    let previous = 0;

    for (let t = 1; t <= peak; t += 1) {
      const value = recoilAmount(t, duration, attack);

      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }

    // пик (1) может лечь между целыми миллисекундами — спад меряем от него
    previous = 1;

    for (let t = peak + 1; t < duration; t += 1) {
      const value = recoilAmount(t, duration, attack);

      expect(value).toBeLessThanOrEqual(previous);
      previous = value;
    }
  });

  it('нулевая длительность отдачи не даёт', () => {
    expect(recoilAmount(10, 0, attack)).toBe(0);
  });
});

describe('recoilOffsets', () => {
  const at = gunRotation =>
    recoilOffsets({ amount: 1, gunRotation, config: recoil });

  it('ствол вперёд: башня и корпус уезжают назад, нос поднимается', () => {
    const { gun, body, pitch, roll } = at(0);

    expect(gun.x).toBeCloseTo(-recoil.gunKick, 6);
    expect(gun.y).toBeCloseTo(0, 6);
    expect(body.x).toBeCloseTo(-recoil.bodyKick, 6);
    expect(pitch).toBeCloseTo(recoil.rock, 6);
    expect(roll).toBeCloseTo(0, 6);
  });

  it('ствол к борту +v: откат вдоль ствола, крен поднимает этот борт', () => {
    const { gun, pitch, roll } = at(Math.PI / 2);

    expect(gun.x).toBeCloseTo(0, 6);
    expect(gun.y).toBeCloseTo(-recoil.gunKick, 6);
    expect(pitch).toBeCloseTo(0, 6);
    expect(roll).toBeCloseTo(recoil.rock, 6);
  });

  it('нулевая амплитуда ничего не двигает', () => {
    const { gun, body, pitch, roll } = recoilOffsets({
      amount: 0,
      gunRotation: 1,
      config: recoil,
    });

    expect(Math.hypot(gun.x, gun.y, body.x, body.y, pitch, roll)).toBe(0);
  });
});
