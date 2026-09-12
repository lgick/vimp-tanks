import { describe, it, expect } from 'vitest';
import { landingImpact } from '../../src/client/landing.js';
import { landing } from '../../src/config/render.js';

// Чистая функция-детектор касания: общая для Tank.js (просадка корпуса) и
// Dust.js (всплеск пыли и звук). PixiJS здесь не нужен.
describe('landingImpact', () => {
  it('мягкое касание ниже minImpact не считается приземлением', () => {
    expect(landingImpact(-(landing.minImpact / 2), 0)).toBe(0);
  });

  it('касание ровно на fullImpact даёт полную силу', () => {
    expect(landingImpact(-landing.fullImpact, 0)).toBe(1);
  });

  it('промежуточное касание даёт долю от fullImpact', () => {
    expect(landingImpact(-landing.fullImpact / 2, 0)).toBe(0.5);
  });

  it('удар сильнее потолка не превышает 1', () => {
    expect(landingImpact(-landing.fullImpact * 3, 0)).toBe(1);
  });

  it('продолжающийся полёт касанием не считается', () => {
    expect(landingImpact(-landing.fullImpact, -3)).toBe(0);
  });

  it('взлёт касанием не считается', () => {
    expect(landingImpact(4, 0)).toBe(0);
  });

  it('NaN в любом аргументе даёт 0', () => {
    expect(landingImpact(NaN, 0)).toBe(0);
    expect(landingImpact(-landing.fullImpact, NaN)).toBe(0);
  });
});
