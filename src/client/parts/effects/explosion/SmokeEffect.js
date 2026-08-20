import { ParticleContainer, Rectangle } from 'pixi.js';
import ParticlePool from '../../ParticlePool.js';
import BaseEffect from '../BaseEffect.js';

// радиус взрыва, под который подобраны размеры дыма (бомба w2):
// та же эталонная бомба стоит за геометрией воронки в FunnelEffect
// у оружия с другим радиусом геометрия султана масштабируется пропорционально,
// а времена жизни и прозрачность остаются - они задают характер, не габарит
export const REFERENCE_BLAST_RADIUS = 50;

// размеры области разлёта частиц дыма эталонного взрыва вокруг локального
// центра эффекта (0, 0); масштабируются вместе с султаном, иначе
// ParticleContainer отсечёт частицы крупного взрыва
const BOUNDS_WIDTH = 400;
const BOUNDS_HEIGHT = 800;

export default class SmokeEffect extends BaseEffect {
  constructor(assets, radius = REFERENCE_BLAST_RADIUS) {
    super();

    const blastScale = radius / REFERENCE_BLAST_RADIUS;

    this._blastScale = blastScale;

    const { texture, contentSize } = assets.explosionTexture;

    this.explosionTexture = texture;

    // размеры частиц задаются в юнитах мира,
    // масштаб нормируется по нарисованному кругу (не по холсту с размытием)
    this._unitScale = 1 / contentSize;

    const boundsWidth = BOUNDS_WIDTH * blastScale;
    const boundsHeight = BOUNDS_HEIGHT * blastScale;

    this._particleContainer = new ParticleContainer({
      texture: this.explosionTexture,
      // создаётся per-instance, а не как общая константа,
      // чтобы не делить один мутируемый Rectangle между эффектами
      boundsArea: new Rectangle(
        -boundsWidth / 2,
        -boundsHeight / 2,
        boundsWidth,
        boundsHeight,
      ),
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

    // Размеры (в юнитах мира)
    this._minStartSize = 2.1 * blastScale;
    this._maxStartSize = 5.2 * blastScale;
    this._minTargetSize = 8.3 * blastScale;
    this._maxTargetSize = 16.6 * blastScale;

    this._startAlpha = 0.1;
    this._initialOffsetX = 15 * blastScale;
    this._initialOffsetY = 15 * blastScale;

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
    // получение из пула вместо new Particle
    const view = ParticlePool.get(this.explosionTexture);

    // вариация цвета
    const grayLevel = 0.2 + Math.random() * 0.4;
    const colorVal = Math.floor(grayLevel * 255);

    view.tint = (colorVal << 16) | (colorVal << 8) | colorVal;

    // размер
    const startScale =
      (this._minStartSize +
        Math.random() * (this._maxStartSize - this._minStartSize)) *
      this._unitScale;

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

      // движение (скорости - тоже геометрия: иначе крупный султан
      // поднимался бы непропорционально медленно)
      vx: (Math.random() - 0.5) * 0.2 * this._blastScale,
      vy: (-0.3 - Math.random() * 0.4) * this._blastScale,

      // рыскание (Sway): амплитуда - смещение, частота - характер
      swaySpeed: 0.002 + Math.random() * 0.003,
      swayAmp: (0.025 + Math.random() * 0.05) * this._blastScale,
      swayOffset: Math.random() * 100,
      rotationSpeed: (Math.random() - 0.5) * 0.05,
      targetScale:
        (this._minTargetSize +
          Math.random() * (this._maxTargetSize - this._minTargetSize)) *
        this._unitScale,
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
