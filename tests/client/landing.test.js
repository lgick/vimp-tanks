import { describe, it, expect } from 'vitest';
import { landingImpact } from '../../src/client/landing.js';

// Чистая функция-детектор касания: общая для Tank.js (просадка корпуса) и
// Dust.js (всплеск пыли и звук). PixiJS здесь не нужен.
//
// Пороги заданы литералом, а не импортом конфига: тест стережёт ФОРМУЛУ и
// не должен падать от настройки. Связь формулы с конфигом стережёт
// `tests/config/landing.test.js`.
const P = { minImpact: 1.5, fullImpact: 6 };

describe('landingImpact', () => {
  it('мягкое касание ниже minImpact не считается приземлением', () => {
    expect(landingImpact(-(P.minImpact / 2), 0, P)).toBe(0);
  });

  it('касание ровно на fullImpact даёт полную силу', () => {
    expect(landingImpact(-P.fullImpact, 0, P)).toBe(1);
  });

  it('промежуточное касание даёт долю от fullImpact', () => {
    expect(landingImpact(-P.fullImpact / 2, 0, P)).toBe(0.5);
  });

  it('удар сильнее потолка не превышает 1', () => {
    expect(landingImpact(-P.fullImpact * 3, 0, P)).toBe(1);
  });

  it('продолжающийся полёт касанием не считается', () => {
    expect(landingImpact(-P.fullImpact, -3, P)).toBe(0);
  });

  it('взлёт касанием не считается', () => {
    expect(landingImpact(4, 0, P)).toBe(0);
  });

  it('NaN в любом аргументе даёт 0', () => {
    expect(landingImpact(NaN, 0, P)).toBe(0);
    expect(landingImpact(-P.fullImpact, NaN, P)).toBe(0);
  });
});
