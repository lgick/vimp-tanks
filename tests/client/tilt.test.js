import { describe, it, expect } from 'vitest';
import { tiltCorners, tiltShade, scaleTint } from '../../src/client/tilt.js';
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
  lift: tilt.lift,
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

  // нос — `+u` (правый край квада, текстура вытянута по `x`), как у ядра
  // (`motion::tilt_target`) и фар. Поднявшийся нос уезжает вверх по экрану
  // и вширь — он ближе к «камере» (та же проекция, что у плиты уровня)
  it('тангаж поднимает нос +u', () => {
    const flat = corners();
    const tilted = corners({ pitch: 0.3 });

    // нос: правые углы уехали вверх, а сам нос раздался по высоте
    expect(tilted[1].y).toBeLessThan(flat[1].y);
    expect(tilted[2].y).toBeLessThan(flat[2].y);
    expect(tilted[2].y - tilted[1].y).toBeGreaterThan(flat[2].y - flat[1].y);

    // корма опустилась и сузилась
    expect(tilted[0].y).toBeGreaterThan(flat[0].y);
    expect(tilted[3].y - tilted[0].y).toBeLessThan(flat[3].y - flat[0].y);

    // корпус укоротился по ходу, а не перекосился вбок
    expect(tilted[1].x - tilted[0].x).toBeLessThan(flat[1].x - flat[0].x);
  });

  it('крен поднимает борт +v', () => {
    const flat = corners();
    const [lt, rt, rb, lb] = corners({ roll: 0.3 });

    // нижний борт (+v) поднялся — уехал вверх, верхний (−v) опустился
    expect(lb.y).toBeLessThan(flat[3].y);
    expect(rb.y).toBeLessThan(flat[2].y);
    expect(lt.y).toBeGreaterThan(flat[0].y);
    expect(rt.y).toBeGreaterThan(flat[1].y);

    // поднявшийся борт стал длиннее: он ближе к наблюдателю
    expect(rb.x - lb.x).toBeGreaterThan(rt.x - lt.x);
  });

  // `lift` уводит поднявшийся край вверх ПО ЭКРАНУ при любом курсе:
  // контейнер танка повёрнут на курс, и локальное «вверх» с ним не
  // совпадает. Переводим углы в экранные оси и сравниваем с ровным танком
  it.each([0, Math.PI / 2, Math.PI])(
    'lift уводит край вверх по экрану при курсе %f',
    heading => {
      const screenX = ({ x, y }) =>
        y * -Math.sin(heading) + x * Math.cos(heading);
      const screenY = ({ x, y }) =>
        x * Math.sin(heading) + y * Math.cos(heading);

      const flat = corners({ heading });
      const lifted = corners({ heading, pitch: 0.3 });
      const bare = corners({ heading, pitch: 0.3, lift: 0 });

      // нос (+u) — правые углы квада: с `lift` они выше, чем без него,
      // а по экранной горизонтали сдвига нет
      [1, 2].forEach(i => {
        expect(screenY(lifted[i])).toBeLessThan(screenY(bare[i]));
        expect(screenX(lifted[i])).toBeCloseTo(screenX(bare[i]), 6);
      });

      // и ровный танк `lift` не трогает
      expect(corners({ heading, lift: 0 })).toEqual(flat);
    },
  );

  it('поворот спрайта коммутирует', () => {
    const turned = corners({ rotation: Math.PI / 2 });
    const flat = corners();

    // поворот квада на π/2 при нулевом наклоне — просто поворот углов
    turned.forEach((point, i) => {
      expect(point.x).toBeCloseTo(-flat[i].y, 6);
      expect(point.y).toBeCloseTo(flat[i].x, 6);
    });
  });

  // зеркальность наклона: знак тангажа меняет высоту краёв местами. По
  // вертикали зеркала нет и быть не может — `lift` проецирует поднявшийся
  // край ВВЕРХ по экрану при любом знаке, это не поворот картинки
  it('наклон симметричен', () => {
    const up = corners({ pitch: 0.3 });
    const down = corners({ pitch: -0.3 });

    expect(down[0].x).toBeCloseTo(-up[1].x, 6);
    expect(down[3].x).toBeCloseTo(-up[2].x, 6);
    expect(down[3].y - down[0].y).toBeCloseTo(up[2].y - up[1].y, 6);
    expect(down[2].y - down[1].y).toBeCloseTo(up[3].y - up[0].y, 6);

    // поднимается противоположный край — корма
    expect(down[0].y).toBeLessThan(corners()[0].y);
    expect(down[3].y).toBeLessThan(corners()[3].y);
  });

  // подъём — отдельное слагаемое, а не часть проекции: без него наклон
  // остаётся чистым сжатием квада
  it('lift = 0 оставляет наклон чистым сжатием', () => {
    const [lt, rt, rb, lb] = corners({ pitch: 0.3, lift: 0 });

    // края разъехались по высоте (проекция высоты осталась)
    expect(rb.y - rt.y).toBeGreaterThan(lb.y - lt.y);

    // а по горизонтали квад только сжался: нос и корма подтянулись
    expect(rt.x).toBeLessThan(20);
    expect(lt.x).toBeGreaterThan(-20);
    expect(rt.x).toBeCloseTo(
      20 * Math.cos(0.3) * (1 + ((20 * Math.sin(0.3)) / 30) * parallax.shear),
      6,
    );
  });

  it('нулевая высота спрайта не даёт NaN', () => {
    const flat = tiltCorners({ ...base, height: 0, pitch: 0.3, roll: 0.2 });

    expect(flat.every(Number.isFinite)).toBe(true);
  });

  it('lift двигает поднявшийся край вверх', () => {
    const [, rt] = corners({ pitch: 0.3 });
    const raised = 20 * Math.sin(0.3);
    const k = (raised / 30) * parallax.shear;

    expect(rt.y).toBeCloseTo(-15 * (1 + k) - raised * tilt.lift, 6);
  });
});

// Светотень наклона: скалярный множитель яркости по проекции нормали
// корпуса на направление света в экранных осях.
describe('tiltShade', () => {
  const shade = overrides =>
    tiltShade({
      angle: 0,
      pitch: 0,
      roll: 0,
      lightDir: [-1, 0],
      shading: 0.28,
      ...overrides,
    });

  it('ровный танк не затронут', () => {
    expect(shade()).toBe(1);
  });

  it('shading = 0 выключает светотень при любом наклоне', () => {
    expect(shade({ pitch: 0.6, roll: -0.4, shading: 0 })).toBe(1);
  });

  it('без направления света светотени нет', () => {
    expect(shade({ pitch: 0.4, lightDir: undefined })).toBe(1);
  });

  it('наклон от света затемняет, навстречу — не подсвечивает', () => {
    expect(shade({ pitch: -0.4 })).toBeLessThan(1);
    expect(shade({ pitch: 0.4 })).toBe(1);
  });

  it('полностью отвёрнутая грань темнее ровной ровно на shading', () => {
    // нормаль против света: pitch = π/2 при lightDir = [-1, 0]
    expect(shade({ pitch: -Math.PI / 2 })).toBeCloseTo(1 - 0.28, 6);
  });

  it('множитель зависит от курса', () => {
    const north = shade({ pitch: 0.4, angle: 0 });
    const south = shade({ pitch: 0.4, angle: Math.PI });

    expect(north).toBe(1);
    expect(south).toBeLessThan(1);
  });

  // крен поднимает борт +v (как в `tiltCorners`), и нормаль отклоняется к
  // −v: при курсе π/2 борт +v смотрит в экранный −x, то есть −v — в +x
  it('крен затемняет, когда свет со стороны поднятого борта', () => {
    expect(shade({ roll: 0.4, angle: Math.PI / 2 })).toBeLessThan(1);
    expect(shade({ roll: -0.4, angle: Math.PI / 2 })).toBe(1);
  });
});

describe('scaleTint', () => {
  it('половинит каналы', () => {
    expect(scaleTint(0xffffff, 0.5)).toBe(0x808080);
  });

  it('не выходит за 0xffffff', () => {
    expect(scaleTint(0xffffff, 2)).toBe(0xffffff);
  });

  it('чёрный остаётся чёрным', () => {
    expect(scaleTint(0x000000, 1.5)).toBe(0x000000);
  });

  it('каналы независимы', () => {
    expect(scaleTint(0x804020, 2)).toBe(0xff8040);
  });
});
