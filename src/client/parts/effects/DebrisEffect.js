import { Sprite } from 'pixi.js';
import BaseEffect from './BaseEffect.js';
import { lerp, randomRange } from 'vimp-engine/lib/math.js';

// Разлёт обломков разрушенного пропа: несколько щепок из `debrisTexture`
// разлетаются во все стороны, крутятся, тормозят и гаснут. Живёт в мировых
// координатах, как ImpactEffect: за телом не следует. Разовый — его
// запускает MapObject только на переходе в состояние «разрушен»
export default class DebrisEffect extends BaseEffect {
  // x, y — мировой центр тела; size — размер тела в мировых единицах
  // (разброс стартовых точек); debris — ассет { textures, contentSize }
  constructor(x, y, size, onComplete, debris) {
    super(onComplete);

    this.x = x;
    this.y = y;

    this._textures = debris.textures;
    this._contentSize = debris.contentSize;

    this.config = {
      particleCount: Math.round(randomRange(6, 10)),
      particleMinSize: 1.5, // длина щепки в мире
      particleMaxSize: 4,
      minInitialSpeed: 30,
      maxInitialSpeed: 140,
      maxSpin: 12, // рад/с
      dragCoefficient: 5,
      minLifetime: 1200, // мс
      maxLifetime: 2200,
      fadeOutStart: 0.6,
      color: [0x6b5a44, 0x5a4a38, 0x7a6a55, 0x3f3a33],
    };

    this.particlesData = [];

    this._createParticles(size / 2);
  }

  _createParticles(spread) {
    const { config } = this;

    for (let i = 0; i < config.particleCount; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const speed = randomRange(config.minInitialSpeed, config.maxInitialSpeed);
      const texture =
        this._textures[Math.floor(Math.random() * this._textures.length)];
      const sprite = new Sprite(texture);
      const start = randomRange(0, spread);

      sprite.anchor.set(0.5);
      sprite.tint =
        config.color[Math.floor(Math.random() * config.color.length)];
      sprite.scale.set(
        randomRange(config.particleMinSize, config.particleMaxSize) /
          this._contentSize,
      );

      this.particlesData.push({
        sprite,
        x: Math.cos(angle) * start,
        y: Math.sin(angle) * start,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        rotation: Math.random() * Math.PI * 2,
        spin: randomRange(-config.maxSpin, config.maxSpin),
        lifetime: randomRange(config.minLifetime, config.maxLifetime),
        age: 0,
      });

      this.addChild(sprite);
    }
  }

  _update(deltaMs) {
    if (this.isComplete) {
      return;
    }

    const { config } = this;
    const dt = deltaMs / 1000;
    const damping = Math.max(0, 1 - config.dragCoefficient * dt);
    let active = 0;

    for (const particle of this.particlesData) {
      if (particle.age >= particle.lifetime) {
        continue;
      }

      particle.age += deltaMs;
      particle.vx *= damping;
      particle.vy *= damping;
      particle.spin *= damping;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.rotation += particle.spin * dt;

      const progress = particle.age / particle.lifetime;
      const { sprite } = particle;

      sprite.position.set(particle.x, particle.y);
      sprite.rotation = particle.rotation;
      sprite.alpha =
        progress < config.fadeOutStart
          ? 1
          : lerp(
              1,
              0,
              Math.min(
                (progress - config.fadeOutStart) / (1 - config.fadeOutStart),
                1,
              ),
            );

      if (particle.age >= particle.lifetime) {
        sprite.visible = false;
      } else {
        active += 1;
      }
    }

    if (active === 0 && this._isStarted) {
      this._completeEffect();
    }
  }

  destroy(options) {
    this.particlesData = [];
    super.destroy(options);
  }
}
