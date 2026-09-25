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
  // `options.pieces` — куски луча по уровням `[{ from, to, level }]`
  // (`tracerPieces`), `options.layerFor(level)` — контейнер, в котором
  // рисуется кусок уровня (своя проекция и zIndex). Без них — один кусок
  // во весь луч внутри самого эффекта
  constructor(
    startX,
    startY,
    endX,
    endY,
    onComplete,
    config = tracerConfig,
    options = {},
  ) {
    super(onComplete);

    this.startPositionX = startX;
    this.startPositionY = startY;
    this.endPositionX = endX;
    this.endPositionY = endY;
    this.config = config;

    // свечение складывается со сценой: трассер — это свет, а не краска.
    // По графике на уровень: в чужом контейнере она не ребёнок эффекта и
    // уничтожается им самим
    this._layerFor = options.layerFor || null;
    this.pieces = options.pieces?.length
      ? options.pieces
      : [{ from: 0, to: Infinity, level: null }];
    this._graphics = new Map();

    for (const { level } of this.pieces) {
      if (!this._graphics.has(level)) {
        const graphics = new Graphics();

        graphics.blendMode = 'add';
        (this._layerFor?.(level) || this).addChild(graphics);
        this._graphics.set(level, graphics);
      }
    }

    this.graphics = this._graphics.values().next().value;

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

  _clear() {
    for (const graphics of this._graphics.values()) {
      graphics.clear();
    }
  }

  _draw() {
    this._clear();

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
      this._clear();
      this._completeEffect();
    }
  }

  // хвост гаснет к дулу: подотрезки с растущей к голове альфой (по квадрату). Сначала
  // все слои свечения, потом ядро — иначе свечение следующего подотрезка
  // легло бы поверх ядра предыдущего. Подотрезок, пересекающий границу
  // уровней, режется по ней: каждая часть — в графику своего уровня
  _drawTrail(tail, head, alpha) {
    const { color, coreColor, coreWidth, glowWidth, glowAlpha } = this.config;
    const steps = Math.max(1, this.config.fadeSteps);
    const pieces = [];

    for (let i = 0; i < steps; i += 1) {
      const from = lerp(tail, head, i / steps);
      const to = lerp(tail, head, (i + 1) / steps);

      // квадрат: яркость собрана у головы, хвост быстро сходит на нет —
      // так выглядит смазанная в движении точка, а не ровная полоса
      const share = (i + 1) / steps;

      pieces.push({ from, to, fade: share * share });
    }

    const parts = this._split(pieces);

    for (const { graphics, from, to, fade } of parts) {
      graphics
        .moveTo(from[0], from[1])
        .lineTo(to[0], to[1])
        .stroke({
          width: glowWidth,
          color,
          alpha: alpha * glowAlpha * fade,
          cap: 'round',
        });
    }

    for (const { graphics, from, to, fade } of parts) {
      graphics
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

  // подотрезки `[{ from, to, fade }]` (дистанции от дула) → части по кускам
  // уровней `{ graphics, from: [x, y], to: [x, y], fade }`
  _split(segments) {
    const point = distance => [
      this.startPositionX + this.nx * distance,
      this.startPositionY + this.ny * distance,
    ];
    const parts = [];

    for (const { from, to, fade } of segments) {
      for (const piece of this.pieces) {
        const a = Math.max(from, piece.from);
        const b = Math.min(to, piece.to);

        if (b - a > 1e-6) {
          parts.push({
            graphics: this._graphics.get(piece.level),
            from: point(a),
            to: point(b),
            fade,
          });
        }
      }
    }

    return parts;
  }

  destroy(options) {
    for (const graphics of this._graphics.values()) {
      if (!graphics.destroyed) {
        graphics.clear();

        // графика в чужом контейнере — не ребёнок эффекта
        if (graphics.parent !== this) {
          graphics.destroy();
        }
      }
    }

    this._graphics.clear();
    super.destroy(options);
  }
}
