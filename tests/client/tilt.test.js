import { describe, it, expect } from 'vitest';
import { tiltCorners } from '../../src/client/tilt.js';
import { parallax, tilt } from '../../src/config/render.js';

// Чистая математика наклона корпуса: PixiJS здесь не нужен — функция
// возвращает восемь чисел в порядке `PerspectiveMesh.setCorners`
// (левый верх → правый верх → правый низ → левый низ).

const base = {
  width: 40,
  height: 30,
  anchorX: 0.5,
  anchorY: 0.5,
  rotation: 0,
  pitch: 0,
  roll: 0,
  shear: parallax.shear,
};

const corners = overrides => {
  const flat = tiltCorners({ ...base, ...overrides });

  return [
    { x: flat[0], y: flat[1] },
    { x: flat[2], y: flat[3] },
    { x: flat[4], y: flat[5] },
    { x: flat[6], y: flat[7] },
  ];
};

describe('tiltCorners', () => {
  it('нулевой наклон даёт прямоугольник', () => {
    const [lt, rt, rb, lb] = corners();

    expect(lt.x).toBeCloseTo(-20, 6);
    expect(lt.y).toBeCloseTo(-15, 6);
    expect(rt.x).toBeCloseTo(20, 6);
    expect(rt.y).toBeCloseTo(-15, 6);
    expect(rb.x).toBeCloseTo(20, 6);
    expect(rb.y).toBeCloseTo(15, 6);
    expect(lb.x).toBeCloseTo(-20, 6);
    expect(lb.y).toBeCloseTo(15, 6);
  });

  it('нулевой наклон уважает якорь', () => {
    const [lt, , rb] = corners({ anchorX: 0, anchorY: 1 });

    expect(lt.x).toBeCloseTo(0, 6);
    expect(lt.y).toBeCloseTo(-30, 6);
    expect(rb.x).toBeCloseTo(40, 6);
    expect(rb.y).toBeCloseTo(0, 6);
  });

  // нос (экранный верх квада) поднимается: уезжает вверх — потому что
  // поднявшаяся точка проецируется выше, — и вширь, потому что она ближе к
  // «камере» (та же проекция, что у плиты уровня)
  it('тангаж поднимает нос', () => {
    const flat = corners();
    const tilted = corners({ pitch: 0.3 });

    expect(tilted[0].y).toBeLessThan(flat[0].y);
    expect(tilted[1].y).toBeLessThan(flat[1].y);
    expect(tilted[1].x).toBeGreaterThan(flat[1].x);
    expect(tilted[0].x).toBeLessThan(flat[0].x);

    // корма уходит вниз и сужается
    expect(tilted[2].y).toBeGreaterThan(flat[2].y);
    expect(tilted[2].x).toBeLessThan(flat[2].x);
    expect(tilted[3].x).toBeGreaterThan(flat[3].x);
  });

  it('крен наклоняет борта', () => {
    const [lt, rt, rb, lb] = corners({ roll: 0.3 });

    // правый борт поднялся, левый опустился
    expect(rt.y).toBeLessThan(lt.y);
    expect(rb.y).toBeLessThan(lb.y);

    // и поднявшийся борт стал длиннее: он ближе к наблюдателю
    expect(rb.y - rt.y).toBeGreaterThan(lb.y - lt.y);
  });

  it('поворот спрайта коммутирует', () => {
    const turned = corners({ rotation: Math.PI / 2 });
    const flat = corners();

    // поворот квада на π/2 при нулевом наклоне — просто поворот углов
    turned.forEach((point, i) => {
      expect(point.x).toBeCloseTo(-flat[i].y, 6);
      expect(point.y).toBeCloseTo(flat[i].x, 6);
    });
  });

  // зеркальность наклона: знак тангажа меняет ширину краёв местами. По
  // вертикали зеркала нет и быть не может — `lift` проецирует поднявшийся
  // край ВВЕРХ по экрану при любом знаке, это не поворот картинки
  it('наклон симметричен', () => {
    const up = corners({ pitch: 0.3 });
    const down = corners({ pitch: -0.3 });

    expect(down[3].x).toBeCloseTo(up[0].x, 6);
    expect(down[2].x).toBeCloseTo(up[1].x, 6);
    expect(down[0].x).toBeCloseTo(up[3].x, 6);
    expect(down[1].x).toBeCloseTo(up[2].x, 6);

    // поднимается противоположный край
    expect(down[2].y).toBeLessThan(corners()[2].y);
    expect(down[3].y).toBeLessThan(corners()[3].y);
  });

  it('нулевая высота спрайта не даёт NaN', () => {
    const flat = tiltCorners({ ...base, height: 0, pitch: 0.3, roll: 0.2 });

    expect(flat.every(Number.isFinite)).toBe(true);
  });

  it('lift двигает поднявшийся край вверх', () => {
    const [lt] = corners({ pitch: 0.3 });
    const raised = 15 * Math.sin(0.3);
    const k = (raised / 30) * parallax.shear;

    expect(lt.y).toBeCloseTo(
      -15 * Math.cos(0.3) * (1 + k) - raised * tilt.lift,
      6,
    );
  });
});
