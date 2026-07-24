import { describe, it, expect } from 'vitest';
import tanksAuthConfig from '../../src/config/auth.js';

// Перенесено из движка (tests/lib/validators.test.js, A3.5 плана отделения
// движка): проверяет саму игровую конфигурацию, а не движковый validateAuth.
describe('authSchema танков (src/config/auth.js)', () => {
  it('isValidModel принимает модели из данных игры', () => {
    const { isValidModel } = tanksAuthConfig.validators;

    expect(isValidModel('m1')).toBe(true);
    expect(isValidModel('m2')).toBe(false);
    expect(isValidModel('')).toBe(false);
  });

  it('все params ссылаются на существующие валидаторы', () => {
    const known = new Set(['isValidName', ...Object.keys(tanksAuthConfig.validators)]);

    for (const { options } of tanksAuthConfig.params) {
      expect(known.has(options.validator)).toBe(true);
    }
  });
});
