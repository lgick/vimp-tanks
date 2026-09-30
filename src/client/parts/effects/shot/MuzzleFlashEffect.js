import { Graphics } from 'pixi.js';
import BaseEffect from '../BaseEffect.js';
import { clamp } from 'vimp-engine/lib/math.js';
import { muzzleFlash as muzzleFlashConfig } from '../../../../config/render.js';

/**
 * Языки пламени одного выстрела: случайные длина и угол каждого в пределах
 * конфига. Считаются раз при выстреле — вспышка не мерцает формой.
 *
 * @param {object} config  `muzzleFlash` из src/config/render.js
 * @param {() => number} rng  0..1
 * @returns {{ forward: {angle: number, length: number}[],
 *   sides: number[] }} углы — относительно оси выстрела, длины — доли
 */
export function rollMuzzleFlash(config, rng = Math.random) {
  const forward = [];
  const count = Math.max(1, config.spikes);

  for (let i = 0; i < count; i += 1) {
    // языки раскладываются веером по всему разбросу, со случайным сдвигом
    // внутри своей доли — без комков и без ровного частокола
    const slot = count === 1 ? 0.5 : (i + rng()) / count;

    forward.push({
      angle: (slot * 2 - 1) * config.spread,
      length: 1 - rng() * config.jitter,
    });
  }

  // боковые выбросы тоже неровные; без `sideLength` их нет
  const sides = config.sideLength
    ? [1 - rng() * config.jitter, 1 - rng() * config.jitter]
    : [];

  return { forward, sides };
}

// вершин у многоугольника огненного шара: на радиусе в пару единиц мира
// граней не видно
const BALL_SIDES = 12;

/**
 * Полная длительность вспышки, мс: языки или ударное кольцо — что дольше.
 *
 * @param {object} config  `muzzleFlash`/`impactFlash` из src/config/render.js
 * @returns {number}
 */
export function muzzleFlashLife(config) {
  return Math.max(config.duration || 0, config.ring?.duration || 0);
}

/**
 * Ударное кольцо вспышки в момент `elapsed` (мс): радиус растёт быстро в
 * начале (ease-out по квадрату), яркость гаснет по квадрату. null — кольца
 * нет в конфиге или оно уже погасло.
 *
 * @param {number} elapsed
 * @param {object} config  `muzzleFlash`/`impactFlash` из src/config/render.js
 * @returns {{ radius: number, width: number, alpha: number,
 *   color: number } | null}
 */
export function muzzleRingShape(elapsed, config) {
  const ring = config.ring;

  if (!ring || !(ring.duration > 0) || elapsed >= ring.duration) {
    return null;
  }

  const t = clamp(elapsed / ring.duration, 0, 1);
  const grow = 1 - (1 - t) * (1 - t);
  const life = 1 - t;

  return {
    radius: ring.radius * grow,
    width: ring.width,
    alpha: ring.alpha * life * life,
    color: ring.color ?? config.coreColor,
  };
}

/**
 * Полигоны вспышки в её собственных осях: дуло в (0, 0), выстрел вдоль
 * `(dirX, dirY)`. Каждый язык — узкий треугольник; каждый слой (`layers`)
 * рисует все языки в своём масштабе и со своей яркостью, так край выходит
 * мягким без текстур и фильтров. Огненный шар (`ball`) — круг в дуле теми
 * же слоями; его полигоны идут после языков всех слоёв. С `t` от 0 до 1
 * вспышка быстро гаснет (яркость по квадрату) и немного сжимается.
 *
 * @param {object} p
 * @param {number} p.dirX
 * @param {number} p.dirY
 * @param {number} p.t       0..1 — доля прожитой длительности
 * @param {object} p.roll    `rollMuzzleFlash`
 * @param {object} p.config  `muzzleFlash` из src/config/render.js
 * @returns {{ points: number[], color: number, alpha: number }[]}
 */
export function muzzleFlashShape({ dirX, dirY, t, roll, config }) {
  const life = 1 - clamp(t, 0, 1);
  const glow = life * life;
  const size = 1 - config.shrink * (1 - life);
  const baseAngle = Math.atan2(dirY, dirX);
  const polygons = [];

  // язык: треугольник от дула вдоль угла `angle`
  const spike = (angle, length, width) => {
    const ax = Math.cos(angle);
    const ay = Math.sin(angle);
    const half = width / 2;

    return [
      -ay * half,
      ax * half,
      ax * length,
      ay * length,
      ay * half,
      -ax * half,
    ];
  };

  for (const layer of config.layers) {
    const scale = layer.scale * size;
    const color = layer.core ? config.coreColor : config.color;
    const alpha = layer.alpha * glow;

    if (alpha <= 0) {
      continue;
    }

    for (const { angle, length } of roll.forward) {
      polygons.push({
        points: spike(
          baseAngle + angle,
          config.length * length * scale,
          config.width * scale,
        ),
        color,
        alpha,
      });
    }

    roll.sides.forEach((length, i) => {
      polygons.push({
        points: spike(
          baseAngle + (i === 0 ? Math.PI / 2 : -Math.PI / 2),
          config.sideLength * length * scale,
          config.sideWidth * scale,
        ),
        color,
        alpha,
      });
    });
  }

  if (config.ball?.radius > 0) {
    for (const layer of config.layers) {
      const alpha = layer.alpha * glow;

      if (alpha <= 0) {
        continue;
      }

      const radius = config.ball.radius * layer.scale * size;
      const points = [];

      for (let i = 0; i < BALL_SIDES; i += 1) {
        const angle = (i / BALL_SIDES) * Math.PI * 2;

        points.push(Math.cos(angle) * radius, Math.sin(angle) * radius);
      }

      polygons.push({
        points,
        color: layer.core ? config.coreColor : config.color,
        alpha,
      });
    }
  }

  return polygons;
}

export default class MuzzleFlashEffect extends BaseEffect {
  constructor(
    x,
    y,
    dirX,
    dirY,
    onComplete,
    config = muzzleFlashConfig,
    rng = Math.random,
  ) {
    super(onComplete);

    // вспышка рисуется вокруг своего начала: контроллер двигает и
    // масштабирует её целиком, когда уровень дула не совпадает с уровнем
    // конца луча
    this.position.set(x, y);

    this.dirX = dirX;
    this.dirY = dirY;
    this.config = config;
    this.roll = rollMuzzleFlash(config, rng);
    this.elapsedTime = 0;

    this.graphics = new Graphics();
    this.graphics.blendMode = 'add';
    this.addChild(this.graphics);
  }

  _update(deltaMs) {
    if (this.isComplete) {
      return;
    }

    this.elapsedTime += deltaMs;
    this.graphics.clear();

    if (this.elapsedTime >= muzzleFlashLife(this.config)) {
      this._completeEffect();

      return;
    }

    const t = this.config.duration
      ? this.elapsedTime / this.config.duration
      : 1;

    if (t < 1) {
      const polygons = muzzleFlashShape({
        dirX: this.dirX,
        dirY: this.dirY,
        t,
        roll: this.roll,
        config: this.config,
      });

      for (const { points, color, alpha } of polygons) {
        this.graphics.poly(points).fill({ color, alpha });
      }
    }

    const ring = muzzleRingShape(this.elapsedTime, this.config);

    if (ring && ring.radius > 0 && ring.alpha > 0) {
      this.graphics
        .circle(0, 0, ring.radius)
        .stroke({ width: ring.width, color: ring.color, alpha: ring.alpha });
    }
  }

  destroy(options) {
    if (this.graphics) {
      this.graphics.clear();
    }

    super.destroy(options);
  }
}
