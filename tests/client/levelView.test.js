import { describe, it, expect, vi } from 'vitest';
import { Container } from 'pixi.js';
import { createLevelView } from '../../src/client/levelView.js';
import { seeThroughAlpha } from '../../src/client/seeThrough.js';
import { seeThrough, parallax } from '../../src/config/render.js';

// Сервис levelView: дыра в плите и alpha точечных сущностей обязаны
// считаться в ОДНОЙ системе координат — в нарисованной. Плита центрирует
// дыру по смещённой точке игрока (Map._applyHole), поэтому и расстояние до
// ящика на ней берётся между смещёнными точками, иначе круг прозрачности
// расходится с нарисованной дырой тем сильнее, чем дальше игрок от центра
// экрана и чем выше сущность.
describe('levelView: проекция 2.5D в формуле прозрачности', () => {
  // центр камеры в начале координат: смещение точки становится просто
  // умножением на (1 + k)
  const camera = { x: 0, y: 0, scaleX: 1, scaleY: 1 };
  const shear = parallax.shear;

  // та же формула, что у offsetPoint и у вершин клина
  const drawn = (x, y, k) => ({
    x: x + (x - camera.x) * k,
    y: y + (y - camera.y) * k,
  });

  // игрок под мостом, в стороне от центра камеры
  const playerX = 1000;
  const makeView = () => {
    const view = createLevelView(seeThrough);

    view.set(0, playerX, 0, 0);

    return view;
  };

  // сцена, из которой `cameraCenter` восстанавливает ровно `camera`:
  // `(screen / 2 - position) / scale` при единичном масштабе даёт (0, 0),
  // если сдвиг сцены равен половине полотна
  const withCamera = view => {
    const stage = new Container();

    stage.scale.set(1);
    stage.position.set(400, 300);
    view.attachStage(stage, { screen: { width: 800, height: 600 } });

    return view;
  };

  it('край дыры считается по нарисованным точкам, а не по мировым', () => {
    const view = withCamera(makeView());

    // ящик стоит на плите уровня 1: нарисован он смещённым, и ровно на
    // границе дыры — прозрачности быть не должно
    const boxX = (playerX + seeThrough.radius) / (1 + shear);

    expect(view.alphaFor(1, boxX, 0)).toBeCloseTo(1, 5);

    // по сырым мировым точкам тот же ящик оказался бы почти в центре дыры
    const rawDistance = boxX - playerX;

    expect(rawDistance).toBeLessThan(
      seeThrough.radius * (1 - seeThrough.softness),
    );
  });

  it('alpha сущности совпадает с формулой фильтра плиты в той же точке', () => {
    const view = withCamera(makeView());

    const entityX = 900;
    const entityY = 120;
    const point = drawn(entityX, entityY, shear);
    const player = drawn(playerX, 0, 0);

    expect(view.alphaFor(1, entityX, entityY)).toBeCloseTo(
      seeThroughAlpha({
        viewLevel: 0,
        viewX: player.x,
        viewY: player.y,
        level: 1,
        x: point.x,
        y: point.y,
        cfg: seeThrough,
      }),
      5,
    );
  });

  it('высота игрока тоже проецируется: на рампе дыра едет вместе с ним', () => {
    const view = createLevelView(seeThrough);

    // игрок уровня 0 поднялся по рампе на половину уровня
    view.set(0, playerX, 0, 0.5);
    withCamera(view);

    const player = drawn(playerX, 0, 0.5 * shear);
    const entityX = 900;
    const point = drawn(entityX, 0, shear);

    expect(view.alphaFor(1, entityX, 0)).toBeCloseTo(
      seeThroughAlpha({
        viewLevel: 0,
        viewX: player.x,
        viewY: player.y,
        level: 1,
        x: point.x,
        y: point.y,
        cfg: seeThrough,
      }),
      5,
    );
  });

  it('своя высота сущности важнее её уровня', () => {
    const view = withCamera(makeView());

    // дым над плитой уровня 1 нарисован выше самой плиты
    expect(view.alphaFor(1, 900, 0, 1.5)).not.toBeCloseTo(
      view.alphaFor(1, 900, 0),
      5,
    );
  });

  // центр камеры — свойство КАДРА: сервис добывает его сам по привязанной
  // сцене, а не ждёт, пока его опубликует парт локального танка
  it('alphaFor проецирует по камере сцены: её добывает сам сервис', () => {
    const view = createLevelView(seeThrough);
    const stage = new Container();

    stage.scale.set(1);
    stage.position.set(0, 0);
    view.attachStage(stage, { screen: { width: 800, height: 600 } });
    view.set(0, playerX, 0, 0);

    expect(view.camera()).toEqual(expect.objectContaining({ x: 400, y: 300 }));
    // проекция считается от этого центра, а не от мировых точек
    expect(view.alphaFor(1, 900, 0)).not.toBeCloseTo(
      createLevelView(seeThrough).alphaFor(1, 900, 0),
      5,
    );
  });

  it('пока сцена не двинулась, центр камеры считается один раз', () => {
    const view = createLevelView(seeThrough);
    const stage = new Container();
    const renderer = { screen: { width: 800, height: 600 } };

    stage.scale.set(1);
    view.attachStage(stage, renderer);

    const first = view.camera();

    // `cameraCenter` отдаёт новый объект на каждый вызов: та же ссылка и
    // значит «второй раз не считали»
    expect(view.camera()).toBe(first);
  });

  // за один тик общего тикера полотно рисуется несколько раз: движок зовёт
  // `app.render()` из `updateCoords` на каждый кадр камеры (сперва камера
  // дискретного кадра, следом предсказанная). Кеш, переживший сдвиг сцены,
  // считал бы проекцию 2.5D от чужого центра — на верхних уровнях это
  // дрожание тем сильнее, чем быстрее едет игрок
  it('сдвиг сцены внутри тика даёт свежий центр', () => {
    const view = createLevelView(seeThrough);
    const stage = new Container();

    stage.scale.set(1);
    stage.position.set(400, 300);
    view.attachStage(stage, { screen: { width: 800, height: 600 } });

    expect(view.camera()).toEqual(expect.objectContaining({ x: 0, y: 0 }));

    // движок применил вторую камеру того же тика
    stage.position.set(300, 300);

    expect(view.camera()).toEqual(expect.objectContaining({ x: 100, y: 0 }));

    // масштаб (динамический зум) — тоже часть трансформа
    stage.scale.set(2);

    expect(view.camera()).toEqual(expect.objectContaining({ x: 50, y: 0 }));
  });

  // Кадр, где сцена есть, а центра нет (масштаб сцены обнулён движком), —
  // аномалия, и потребители проекции её терпят молча (`offsetPoint`,
  // `modelLean`). Один раз сказать в консоль — единственный способ прижать
  // причину на проде; поток предупреждений там бесполезен
  it('сцена без масштаба: предупреждение один раз на сессию', () => {
    const view = createLevelView(seeThrough);
    const stage = new Container();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    stage.scale.set(0);
    view.attachStage(stage, { screen: { width: 800, height: 600 } });

    expect(view.camera()).toBe(null);
    expect(view.camera()).toBe(null);
    expect(warn).toHaveBeenCalledTimes(1);

    warn.mockRestore();
  });

  // Журнал клиентских ошибок движка (сервис `diagnostics`, vimp-engine
  // ≥ 0.35.0): то же одноразовое предупреждение уходит и туда — на проде
  // консоль игрока никто не читает
  describe('журнал движка (diagnostics)', () => {
    const zeroScale = view => {
      const stage = new Container();

      stage.scale.set(0);
      view.attachStage(stage, { screen: { width: 800, height: 600 } });
    };

    it('предупреждение уходит в журнал один раз, тем же объектом', () => {
      const view = createLevelView(seeThrough);
      const diagnostics = { warn: vi.fn() };
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      view.setDiagnostics(diagnostics);
      zeroScale(view);
      view.camera();
      view.camera();

      expect(diagnostics.warn).toHaveBeenCalledTimes(1);
      expect(diagnostics.warn).toHaveBeenCalledWith(
        'tanks.camera.missing',
        warn.mock.calls[0][1],
      );
      expect(warn.mock.calls[0][1]).toEqual(
        expect.objectContaining({
          destroyed: false,
          scale: { x: 0, y: 0 },
          screen: { width: 800, height: 600 },
        }),
      );

      warn.mockRestore();
    });

    it('первый непустой сервис побеждает', () => {
      const view = createLevelView(seeThrough);
      const first = { warn: vi.fn() };
      const second = { warn: vi.fn() };
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      view.setDiagnostics(null);
      view.setDiagnostics(first);
      view.setDiagnostics(second);
      zeroScale(view);
      view.camera();

      expect(first.warn).toHaveBeenCalledTimes(1);
      expect(second.warn).not.toHaveBeenCalled();

      warn.mockRestore();
    });

    it('без сервиса (старый движок) — только консоль', () => {
      const view = createLevelView(seeThrough);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      zeroScale(view);

      expect(() => view.camera()).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);

      warn.mockRestore();
    });
  });

  it('сцену берёт ПЕРВЫЙ позвавший: у радара своя проекция', () => {
    const view = createLevelView(seeThrough);
    const stage = new Container();
    const other = new Container();

    stage.scale.set(1);
    other.scale.set(2);
    view.attachStage(stage, { screen: { width: 800, height: 600 } });
    view.attachStage(other, { screen: { width: 200, height: 200 } });

    expect(view.camera()).toEqual(expect.objectContaining({ x: 400, y: 300 }));
  });

  // Движок вправе пересобрать полотно, а сервис живёт со ядром: на мёртвой
  // сцене `stage.scale` в PixiJS обнулён, и читать трансформ там — падение
  // прямо в `onRender`. Держать её вечно тоже нельзя: проекция 2.5D
  // выключилась бы до конца матча
  it('уничтоженная сцена: центра нет, а новую сцену сервис принимает', () => {
    const view = createLevelView(seeThrough);
    const stage = new Container();
    const fresh = new Container();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    stage.scale.set(1);
    view.attachStage(stage, { screen: { width: 800, height: 600 } });
    stage.destroy();

    expect(() => view.camera()).not.toThrow();
    expect(view.camera()).toBe(null);

    fresh.scale.set(1);
    view.attachStage(fresh, { screen: { width: 400, height: 200 } });

    expect(view.camera()).toEqual(expect.objectContaining({ x: 200, y: 100 }));

    warn.mockRestore();
  });

  it('без камеры (до первого кадра) точки остаются мировыми', () => {
    const view = makeView();

    expect(view.alphaFor(1, 900, 0)).toBeCloseTo(
      seeThroughAlpha({
        viewLevel: 0,
        viewX: playerX,
        viewY: 0,
        level: 1,
        x: 900,
        y: 0,
        cfg: seeThrough,
      }),
      5,
    );
  });
});
