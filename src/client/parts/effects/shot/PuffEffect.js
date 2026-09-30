import { Sprite } from 'pixi.js';
import BaseEffect from '../BaseEffect.js';
import { clamp } from 'vimp-engine/lib/math.js';
import { impactSmoke as impactSmokeConfig } from '../../../../config/render.js';

/**
 * Клубы одного разрыва: направление, скорость, размер, время жизни, цвет и
 * поворот спрайта каждого — случайные в пределах конфига. Считаются раз при
 * попадании.
 *
 * @param {object} config  `impactSmoke` из src/config/render.js
 * @param {number} dirX    направление выброса (к стрелку), единичный вектор
 * @param {number} dirY
 * @param {() => number} rng  0..1
 * @returns {{ vx: number, vy: number, size: number, lifetime: number,
 *   color: number, rotation: number }[]}
 */
export function rollPuffs(config, dirX, dirY, rng = Math.random) {
  const puffs = [];
  const count = Math.max(0, Math.round(config.count));
  const baseAngle = Math.atan2(dirY, dirX);
  const range = (limits, u) => limits.min + (limits.max - limits.min) * u;

  for (let i = 0; i < count; i += 1) {
    // (0, 0) — точка без направления: клубы во все стороны
    const angle =
      dirX === 0 && dirY === 0
        ? rng() * Math.PI * 2
        : baseAngle + (rng() * 2 - 1) * config.spread;
    const speed = range(config.speed, rng());

    puffs.push({
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: range(config.size, rng()),
      lifetime: range(config.lifetime, rng()),
      color: config.colors[Math.floor(rng() * config.colors.length)],
      rotation: rng() * Math.PI * 2,
    });
  }

  return puffs;
}

/**
 * Клуб в момент `elapsed` (мс) в осях эффекта: тормозит экспоненциально
 * (`drag`, 1/с — путь `v/drag · (1 − e^(−drag·t))`), растёт до `grow`
 * стартового размера (быстро в начале) и тает по квадрату. null — клуб
 * отжил.
 *
 * @param {object} puff    из `rollPuffs`
 * @param {number} elapsed
 * @param {object} config  `impactSmoke` из src/config/render.js
 * @returns {{ x: number, y: number, size: number, alpha: number } | null}
 */
export function puffState(puff, elapsed, config) {
  if (elapsed >= puff.lifetime) {
    return null;
  }

  const u = clamp(elapsed / puff.lifetime, 0, 1);
  const seconds = elapsed / 1000;
  const travel =
    config.drag > 0
      ? (1 - Math.exp(-config.drag * seconds)) / config.drag
      : seconds;
  const grown = 1 - (1 - u) * (1 - u);
  const life = 1 - u;

  return {
    x: puff.vx * travel,
    y: puff.vy * travel,
    size: puff.size * (1 + (config.grow - 1) * grown),
    alpha: config.alpha * life * life,
  };
}

// Клуб дыма разрыва снаряда: несколько размытых кругов (`smokeTexture`)
// вылетают из точки попадания к стрелку, растут и тают. Спрайтов — единицы,
// поэтому простой Container + Sprite без ParticleContainer (как у
// ImpactEffect). Эффект живёт в мире: за стрелком не следует
export default class PuffEffect extends BaseEffect {
  constructor(
    x,
    y,
    dirX,
    dirY,
    onComplete,
    assets,
    config = impactSmokeConfig,
    rng = Math.random,
  ) {
    super(onComplete);

    this.position.set(x, y);
    this.config = config;
    this.elapsedTime = 0;

    const { texture, contentSize } = assets.smokeTexture;

    // размер клуба задан в юнитах мира и нормируется по нарисованному
    // кругу текстуры, а не по холсту с запасом под размытие
    this._unitScale = 1 / contentSize;
    this.puffs = rollPuffs(config, dirX, dirY, rng);
    this.sprites = this.puffs.map(puff => {
      const sprite = new Sprite(texture);

      sprite.anchor.set(0.5);
      sprite.tint = puff.color;
      sprite.rotation = puff.rotation;
      this.addChild(sprite);

      return sprite;
    });
  }

  _update(deltaMs) {
    if (this.isComplete) {
      return;
    }

    this.elapsedTime += deltaMs;

    let alive = 0;

    this.puffs.forEach((puff, i) => {
      const state = puffState(puff, this.elapsedTime, this.config);
      const sprite = this.sprites[i];

      sprite.visible = state !== null;

      if (state) {
        alive += 1;
        sprite.position.set(state.x, state.y);
        sprite.scale.set(state.size * this._unitScale);
        sprite.alpha = state.alpha;
      }
    });

    if (alive === 0) {
      this._completeEffect();
    }
  }

  destroy(options) {
    this.puffs = [];
    this.sprites = [];
    super.destroy(options);
  }
}
