import { ParticleContainer, Rectangle } from 'pixi.js';
import ParticlePool from '../../ParticlePool.js';
import BaseEffect from '../BaseEffect.js';

// область разлёта частиц дыма взрыва вокруг локального центра эффекта (0, 0)
const BOUNDS_AREA = new Rectangle(-200, -400, 400, 800);

export default class SmokeEffect extends BaseEffect {
  constructor(assets) {
    super();

    this.explosionTexture = assets.explosionTexture;

    this._particleContainer = new ParticleContainer({
      texture: this.explosionTexture,
      boundsArea: BOUNDS_AREA,
      dynamicProperties: {
        position: true,
        vertex: true,
        rotation: true,
        color: true,
      },
    });
    this.addChild(this._particleContainer);

    // симуляция каждой частицы хранится отдельно от Particle
    // (у Particle нет customData)
    this._particles = [];
    this._isSpawning = true;

    this._particleSpawnRateMs = 50;
    this._particleMaxLifeMs = 2000;

    // Размеры
    this._minStartScale = 0.02;
    this._maxStartScale = 0.05;

    this._startAlpha = 0.1;
    this._initialOffsetX = 15;
    this._initialOffsetY = 15;

    this._lastSpawnTime = 0;

    // стартовый залп
    for (let i = 0; i < 30; i += 1) {
      this._createParticle();
    }
  }

  stopSpawning() {
    this._isSpawning = false;
  }

  _createParticle() {
    // получение из пула вместо new Sprite
    const view = ParticlePool.get(this.explosionTexture);

    // вариация цвета
    const grayLevel = 0.2 + Math.random() * 0.4;
    const colorVal = Math.floor(grayLevel * 255);

    view.tint = (colorVal << 16) | (colorVal << 8) | colorVal;

    // размер
    const startScale =
      this._minStartScale +
      Math.random() * (this._maxStartScale - this._minStartScale);

    // искажение пропорций
    const aspectX = 0.6 + Math.random() * 0.8;
    const aspectY = 0.6 + Math.random() * 0.8;

    view.scaleX = startScale * aspectX;
    view.scaleY = startScale * aspectY;

    view.alpha = this._startAlpha + Math.random() * 0.1;
    view.rotation = Math.random() * Math.PI * 2;

    // начальная позиция
    view.x = (Math.random() - 0.5) * this._initialOffsetX;
    view.y = (Math.random() - 0.5) * this._initialOffsetY;

    const particle = {
      view,
      life: 0,
      maxLife: this._particleMaxLifeMs * (0.7 + Math.random() * 0.6),
      aspectRatioX: aspectX,
      aspectRatioY: aspectY,

      // движение
      vx: (Math.random() - 0.5) * 0.2,
      vy: -0.3 - Math.random() * 0.4,

      // рыскание (Sway)
      swaySpeed: 0.002 + Math.random() * 0.003,
      swayAmp: 0.025 + Math.random() * 0.05,
      swayOffset: Math.random() * 100,
      rotationSpeed: (Math.random() - 0.5) * 0.05,
      targetScale: 0.08 + Math.random() * 0.08,
      startScale,
    };

    this._particleContainer.addParticle(view);
    this._particles.push(particle);
  }

  _update(deltaMs) {
    if (this.isComplete) {
      return;
    }

    // ограничение в 100мс,
    // чтобы предотвратит спавн тысячи частиц
    deltaMs = Math.min(deltaMs, 100);

    if (this._isSpawning) {
      this._lastSpawnTime += deltaMs;

      while (this._lastSpawnTime > this._particleSpawnRateMs) {
        this._createParticle();
        this._lastSpawnTime -= this._particleSpawnRateMs;
      }
    }

    for (let i = this._particles.length - 1; i >= 0; i -= 1) {
      const particle = this._particles[i];
      const view = particle.view;

      particle.life += deltaMs;

      if (particle.life >= particle.maxLife) {
        // возвращение в пул
        this._particleContainer.removeParticle(view);
        ParticlePool.release(view);
        this._particles.splice(i, 1);
      } else {
        const progress = particle.life / particle.maxLife;

        // физика
        particle.vy *= 0.98;
        particle.vx *= 0.95;

        const sway =
          Math.sin(particle.life * particle.swaySpeed + particle.swayOffset) *
          particle.swayAmp;

        view.x += (particle.vx + sway) * (deltaMs / 16);
        view.y += particle.vy * (deltaMs / 16);
        view.rotation += particle.rotationSpeed * (deltaMs / 16);

        // масштаб
        const ease = 1 - Math.pow(1 - progress, 3);
        const currentBaseScale =
          particle.startScale +
          (particle.targetScale - particle.startScale) * ease;

        view.scaleX = currentBaseScale * particle.aspectRatioX;
        view.scaleY = currentBaseScale * particle.aspectRatioY;

        // альфа
        if (progress < 0.1) {
          view.alpha = (progress / 0.1) * this._startAlpha;
        } else if (progress > 0.4) {
          const fadeP = (progress - 0.4) / 0.6;
          view.alpha = this._startAlpha * (1 - fadeP);
        } else {
          view.alpha = this._startAlpha;
        }
      }
    }

    if (!this._isSpawning && this._particles.length === 0 && this._isStarted) {
      this._completeEffect();

      // destroy, если эффект завершен, чтобы отписаться от тикера
      if (!this.destroyed) {
        this.destroy();
      }
    }
  }

  destroy(options) {
    // при уничтожении эффекта возвращение живых частиц в пул
    for (let i = 0; i < this._particles.length; i += 1) {
      ParticlePool.release(this._particles[i].view);
    }

    this._particles = [];

    // super.destroy уничтожит ParticleContainer как обычного ребёнка
    // (children: true из BaseEffect); частицы, уже возвращённые в пул,
    // повторно не трогаются
    super.destroy(options);
  }
}
