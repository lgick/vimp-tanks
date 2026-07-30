import { describe, it, expect } from 'vitest';
import { rangeToPattern } from '../../scripts/lib/rangeToPattern.js';

// Brute-force проверка: для нескольких диапазонов (включая реальные границы
// формы — maxPlayers 1-8, roundTime/mapTime 10-3600) перебираем каждое целое
// число от 0 до max+запас и сверяем regex.test(String(n)) с n∈[min,max].
// Нетривиальный рекурсивный генератор (build-game-manifest.js уже словил
// в нём один regex-precedence баг) — покрытие полным перебором, а не
// точечными кейсами, единственное, что реально ловит регрессию

function assertExactRange(min, max, margin = 5) {
  const re = new RegExp(`^(?:${rangeToPattern(min, max)})$`);

  for (let n = 0; n <= max + margin; n += 1) {
    const expected = n >= min && n <= max;

    expect(re.test(String(n)), `n=${n}, min=${min}, max=${max}`).toBe(expected);
  }
}

describe('rangeToPattern', () => {
  it('однозначные диапазоны (например maxPlayers 1-8)', () => {
    assertExactRange(1, 8);
  });

  it('пересекает границу разрядности (roundTime/mapTime 10-3600)', () => {
    assertExactRange(10, 3600);
  });

  it('диапазон из одного числа', () => {
    assertExactRange(5, 5);
  });

  it('диапазон, начинающийся с 0', () => {
    assertExactRange(0, 12);
  });

  it('диапазон, кратный степени десяти на границах', () => {
    assertExactRange(100, 999);
  });

  it('бросает при min > max', () => {
    expect(() => rangeToPattern(9, 1)).toThrow(/min 9 > max 1/);
  });
});
