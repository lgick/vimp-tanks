import { describe, it, expect } from 'vitest';
import { tracerPieces } from '../../../../src/client/parts/effects/shot/tracerPieces.js';

// Куски трассера по сегментам уровней ядра (`core/src/shot_levels.rs`)
describe('tracerPieces', () => {
  it('без сегментов — один кусок на уровне конца', () => {
    expect(tracerPieces(null, 500, 1)).toEqual([{ from: 0, to: 500, level: 1 }]);
    expect(tracerPieces([], 500, 0)).toEqual([{ from: 0, to: 500, level: 0 }]);
  });

  it('с моста вниз: плита, затем земля за кромкой', () => {
    expect(
      tracerPieces(
        [
          { t0: 0, t1: 300, level: 1 },
          { t0: 300, t1: 1500, level: 0 },
        ],
        1500,
        0,
      ),
    ).toEqual([
      { from: 0, to: 300, level: 1 },
      { from: 300, to: 1500, level: 0 },
    ]);
  });

  it('сегменты длиннее луча обрезаются по его длине', () => {
    expect(
      tracerPieces(
        [
          { t0: 0, t1: 300, level: 1 },
          { t0: 300, t1: 1500, level: 0 },
        ],
        200,
        1,
      ),
    ).toEqual([{ from: 0, to: 200, level: 1 }]);
  });

  it('окно кромки поверх наземного сегмента — трассер остаётся на земле', () => {
    expect(
      tracerPieces(
        [
          { t0: 0, t1: 1500, level: 0 },
          { t0: 400, t1: 412.8, level: 1 },
        ],
        1500,
        0,
      ),
    ).toEqual([{ from: 0, to: 1500, level: 0 }]);
  });

  it('попадание в цель на кромке: последний кусок — от начала окна', () => {
    expect(
      tracerPieces(
        [
          { t0: 0, t1: 1500, level: 0 },
          { t0: 400, t1: 412.8, level: 1 },
        ],
        405,
        1,
      ),
    ).toEqual([
      { from: 0, to: 400, level: 0 },
      { from: 400, to: 405, level: 1 },
    ]);
  });

  it('уровень конца не совпал и окна нет — последний кусок получает уровень конца', () => {
    expect(
      tracerPieces(
        [
          { t0: 0, t1: 300, level: 1 },
          { t0: 300, t1: 600, level: 0 },
        ],
        600,
        1,
      ),
    ).toEqual([{ from: 0, to: 600, level: 1 }]);
  });

  it('соседние куски одного уровня склеиваются', () => {
    expect(
      tracerPieces(
        [
          { t0: 0, t1: 100, level: 0 },
          { t0: 100, t1: 200, level: 0 },
        ],
        200,
        0,
      ),
    ).toEqual([{ from: 0, to: 200, level: 0 }]);
  });
});
