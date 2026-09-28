import { describe, it, expect } from 'vitest';
import { lerpColor, colorRamp } from '../../src/client/colorRamp.js';

describe('lerpColor', () => {
  it('смешивает по каналам', () => {
    expect(lerpColor(0x000000, 0xffffff, 0.5)).toBe(0x808080);
    expect(lerpColor(0xff0000, 0x0000ff, 0.5)).toBe(0x800080);
  });

  it('на концах возвращает исходные цвета', () => {
    expect(lerpColor(0x123456, 0xabcdef, 0)).toBe(0x123456);
    expect(lerpColor(0x123456, 0xabcdef, 1)).toBe(0xabcdef);
  });

  it('зажимает долю за пределами [0, 1]', () => {
    expect(lerpColor(0x123456, 0xabcdef, -1)).toBe(0x123456);
    expect(lerpColor(0x123456, 0xabcdef, 2)).toBe(0xabcdef);
  });
});

describe('colorRamp', () => {
  const stops = [
    [0, 0x000000],
    [0.5, 0xffffff],
    [1, 0xff0000],
  ];

  it('на опоре возвращает её цвет', () => {
    expect(colorRamp(stops, 0)).toBe(0x000000);
    expect(colorRamp(stops, 0.5)).toBe(0xffffff);
    expect(colorRamp(stops, 1)).toBe(0xff0000);
  });

  it('между опорами смешивает соседние', () => {
    expect(colorRamp(stops, 0.25)).toBe(0x808080);
    expect(colorRamp(stops, 0.75)).toBe(0xff8080);
  });

  it('за краями возвращает крайние цвета', () => {
    expect(colorRamp(stops, -0.5)).toBe(0x000000);
    expect(colorRamp(stops, 1.5)).toBe(0xff0000);
  });

  it('с одной опорой всегда её цвет', () => {
    const single = [[0.3, 0x445566]];

    expect(colorRamp(single, 0)).toBe(0x445566);
    expect(colorRamp(single, 0.3)).toBe(0x445566);
    expect(colorRamp(single, 1)).toBe(0x445566);
  });
});
