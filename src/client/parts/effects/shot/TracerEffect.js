import { Graphics } from 'pixi.js';
import BaseEffect from '../BaseEffect.js';
import { lerp, clamp } from 'vimp-engine/lib/math.js';
import { tracer as tracerConfig } from '../../../../config/render.js';

/**
 * Видимый отрезок трассера: расстояния хвоста и головы от дула. Хвост
 * растёт прямо от дула — отступа нет, линия выходит из ствола, — и не
 * длиннее `max(trailLength, totalDist · trailShare)`; к концу пути он
 * стягивается к цели. Доля от длины луча держит у дальнего выстрела линию
 * от ствола в первых кадрах: голова там проходит сотни единиц за кадр.
 *
 * @param {object} p
 * @param {number} p.progress     0..1 — доля пройденного пути
 * @param {number} p.totalDist    длина луча
 * @param {number} p.trailLength  наименьшая наибольшая длина хвоста
 * @param {number} [p.trailShare] доля луча, которой хвост может достигать
 * @returns {{ tail: number, head: number }}
 */
export function tracerSpan({
  progress,
  totalDist,
  trailLength,
  trailShare = 0,
}) {
  const head = totalDist * clamp(progress, 0, 1);
  const longest = Math.max(trailLength, totalDist * trailShare);
  const maxTrail = lerp(longest, 0, clamp(progress, 0, 1));

  return { tail: Math.max(0, head - maxTrail), head };
}

export default class TracerEffect extends BaseEffect {
  constructor(startX, startY, endX, endY, onComplete, config = tracerConfig) {
    super(onComplete);

    this.startPositionX = startX;
    this.startPositionY = startY;
    this.endPositionX = endX;
    this.endPositionY = endY;
    this.config = config;

    // свечение складывается со сценой: трассер — это свет, а не краска
    this.graphics = new Graphics();
    this.graphics.blendMode = 'add';
    this.addChild(this.graphics);

    this.elapsedTime = 0;
    this.progress = 0;
    this._aim();

    this.animationDuration = clamp(
      (this.totalDist / config.speed) * 1000,
      config.minDuration,
      config.maxDuration,
    );
  }

  // направление и длина луча от текущего дула к неподвижной цели
  _aim() {
    const dx = this.endPositionX - this.startPositionX;
    const dy = this.endPositionY - this.startPositionY;

    this.totalDist = Math.hypot(dx, dy);

    if (this.totalDist > 0.001) {
      this.nx = dx / this.totalDist;
      this.ny = dy / this.totalDist;
    } else {
      this.nx = 0;
      this.ny = 0;
      this.totalDist = 0;
    }
  }

  /**
   * Дуло сдвинулось (танк едет): луч переносится ЦЕЛИКОМ — начало в новое
   * дуло, конец на тот же сдвиг, направление и длина прежние. Перестраивать
   * луч к неподвижной цели нельзя: у танка вплотную к стене дуло уже в
   * стене, луч почти нулевой, и при езде вдоль стены он растягивался бы
   * назад к старой точке. Прогресс и длительность пролёта не меняются
   */
  shiftTo(x, y) {
    if (this.isComplete) {
      return;
    }

    this.endPositionX += x - this.startPositionX;
    this.endPositionY += y - this.startPositionY;
    this.startPositionX = x;
    this.startPositionY = y;
    this._draw();
  }

  _draw() {
    this.graphics.clear();

    const { tail, head } = tracerSpan({
      progress: this.progress,
      totalDist: this.totalDist,
      trailLength: this.config.trailLength,
      trailShare: this.config.trailShare,
    });

    if (head - tail > 0.001) {
      this._drawTrail(
        tail,
        head,
        lerp(this.config.alphaStart, this.config.alphaEnd, this.progress),
      );
    }
  }

  _update(deltaMs) {
    if (this.isComplete) {
      return;
    }

    this.elapsedTime += deltaMs;
    this.progress = Math.min(this.elapsedTime / this.animationDuration, 1);
    this._draw();

    if (this.elapsedTime >= this.animationDuration) {
      this.graphics.clear();
      this._completeEffect();
    }
  }

  // хвост гаснет к дулу: подотрезки с растущей к голове альфой (по квадрату). Сначала
  // все слои свечения, потом ядро — иначе свечение следующего подотрезка
  // легло бы поверх ядра предыдущего
  _drawTrail(tail, head, alpha) {
    const { color, coreColor, coreWidth, glowWidth, glowAlpha } = this.config;
    const steps = Math.max(1, this.config.fadeSteps);
    const point = distance => [
      this.startPositionX + this.nx * distance,
      this.startPositionY + this.ny * distance,
    ];
    const pieces = [];

    for (let i = 0; i < steps; i += 1) {
      const from = point(lerp(tail, head, i / steps));
      const to = point(lerp(tail, head, (i + 1) / steps));

      // квадрат: яркость собрана у головы, хвост быстро сходит на нет —
      // так выглядит смазанная в движении точка, а не ровная полоса
      const share = (i + 1) / steps;

      pieces.push({ from, to, fade: share * share });
    }

    for (const { from, to, fade } of pieces) {
      this.graphics
        .moveTo(from[0], from[1])
        .lineTo(to[0], to[1])
        .stroke({
          width: glowWidth,
          color,
          alpha: alpha * glowAlpha * fade,
          cap: 'round',
        });
    }

    for (const { from, to, fade } of pieces) {
      this.graphics
        .moveTo(from[0], from[1])
        .lineTo(to[0], to[1])
        .stroke({
          width: coreWidth,
          color: coreColor,
          alpha: alpha * fade,
          cap: 'round',
        });
    }
  }

  destroy(options) {
    if (this.graphics) {
      this.graphics.clear();
    }

    super.destroy(options);
  }
}
