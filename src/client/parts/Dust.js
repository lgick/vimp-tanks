import { Container, ParticleContainer, Rectangle, Ticker } from 'pixi.js';
import ParticlePool from './ParticlePool.js';
import { randomRange } from 'vimp-engine/lib/math.js';
import { levelZ } from '../levelZ.js';
import { cameraCenter } from '../camera.js';
import { applyParallax } from '../parallax.js';
import {
  parallax as parallaxConfig,
  landing as landingConfig,
} from '../../config/render.js';
import { landingImpact } from '../landing.js';
import {
  M1_X,
  M1_Y,
  M1_ANGLE,
  M1_VX,
  M1_VY,
  M1_ENGINE_LOAD,
  M1_CONDITION,
  M1_SIZE,
  M1_Z,
  M1_LEVEL,
  M1_VZ,
} from '../snapshotFields.js';

// базовый zIndex пыли внутри своего уровня: над следами гусениц (1), под
// танком (3) — пыль живёт НА земле, в отличие от дыма (4), который над танком
const DUST_BASE_Z = 2;

// отступ вокруг эмиттера для boundsArea: покрывает разлёт частиц
const BOUNDS_PADDING = 300;

// базовый видимый размер частицы в юнитах мира: нормировка по нарисованному
// кругу текстуры делает вид частиц независимым от запаса под размытие
const DUST_PARTICLE_BASE_SIZE = 6;

const DUST_CONFIG = {
  // пыль оседает: живёт меньше дыма и почти не летит
  lifetime: { min: 300, max: 700 },

  startSizeFactor: 0.7,
  endSizeFactor: 2.0,

  startAlpha: 0.35,
  endAlpha: 0.0,

  // белая текстура, крашенная в цвет грунта
  color: 0x9c8f77,

  // сопротивление воздуха (та же форма, что у дыма)
  airResistance: 0.86,

  // буксование: частиц в секунду на каждую точку контакта при полном упоре
  spawnRate: 30,

  // выше этой скорости танк едет, а не буксует (мировых единиц в секунду)
  maxSpinSpeed: 8,

  // выброс грунта назад вдоль корпуса плюс разброс
  spinVelocity: {
    back: { min: 20, max: 70 },
    side: { min: -25, max: 25 },
  },

  // приземление: частиц на каждую точку контакта при полном ударе. Число
  // считается от силы удара (`landingBurst × impact`), а мягкое касание
  // (impact = 0) не даёт ни одной — порог живёт в `landing.minImpact`
  landingBurst: 14,

  // радиальная скорость разлёта при приземлении
  landingVelocity: { min: 40, max: 110 },

  // во сколько раз крупнее частицы всплеска
  landingSizeFactor: 1.6,
};

export default class Dust extends Container {
  constructor(data, assets, dependencies = {}) {
    super();

    this._level = data[M1_LEVEL] || 0;
    this.zIndex = levelZ(DUST_BASE_Z, this._level);

    const { texture, contentSize } = assets.dustTexture;

    this._dustTexture = texture;
    this._textureScale = DUST_PARTICLE_BASE_SIZE / contentSize;

    this._x = data[M1_X];
    this._y = data[M1_Y];
    this._rotation = data[M1_ANGLE];
    this._vx = data[M1_VX] || 0;
    this._vy = data[M1_VY] || 0;
    this._engineLoad = data[M1_ENGINE_LOAD] || 0;
    this._condition = data[M1_CONDITION];
    this._z = data[M1_Z] || 0;
    this._vz = data[M1_VZ] || 0;
    this._prevVz = this._vz;

    this._size = data[M1_SIZE];

    const tankHeight = this._size * 3;

    // геометрия точек контакта гусениц — та же, что у следов
    // (`Tracks.createTrackMarksAtPreviousPosition`): пыль поднимается
    // оттуда же, откуда штампуется след
    this._trackOffset = (tankHeight / 2) * 0.7;
    this._backwardOffset = tankHeight * 0.4;

    this._particleScaleMultiplier = Math.max(
      0.5,
      Math.sqrt(this._size * 4 * tankHeight * 0.001),
    );

    this._particles = [];
    this._timeSinceSpawn = 0;

    this._levelView = dependencies.levelView || null;
    this._renderer = dependencies.renderer || null;
    this._soundManager = dependencies.soundManager || null;

    const landingSound = this._soundManager?.getSoundConfig('tankLanding');

    // ассета может не быть: без конфига звук просто не проигрывается
    this._landingVolume = landingSound?.volume || 0;
    this._hasLandingSound = !!landingSound;

    // прозрачность над игроком и затемнение под ним — общая формула
    // levelView. `onRender` — аксессор Container, назначается свойством
    if (this._levelView || this._renderer) {
      this.onRender = () => {
        if (this._levelView) {
          this.alpha = this._levelView.alphaFor(
            this._level,
            this._x,
            this._y,
            this._z,
          );
          this.tint = this._levelView.tintFor(this._level);
        }

        // пыль лежит на той же плите, что и танк: та же проекция высоты,
        // что у дыма, следов и корпуса
        applyParallax(
          this,
          cameraCenter(this.parent, this._renderer),
          this._z * parallaxConfig.shear,
          1,
        );
      };
    }

    this._particleContainer = new ParticleContainer({
      texture: this._dustTexture,
      boundsArea: new Rectangle(
        this._x - BOUNDS_PADDING,
        this._y - BOUNDS_PADDING,
        BOUNDS_PADDING * 2,
        BOUNDS_PADDING * 2,
      ),
      dynamicProperties: {
        position: true,
        vertex: true,
        rotation: true,
        color: true,
      },
    });
    this.addChild(this._particleContainer);

    this._tickListener = ticker => this._updateParticles(ticker.deltaMS);
    Ticker.shared.add(this._tickListener);
  }

  update(data) {
    const level = data[M1_LEVEL] || 0;

    if (level !== this._level) {
      this._level = level;
      this.zIndex = levelZ(DUST_BASE_Z, level);
    }

    this._x = data[M1_X];
    this._y = data[M1_Y];
    this._rotation = data[M1_ANGLE];
    this._vx = data[M1_VX] || 0;
    this._vy = data[M1_VY] || 0;
    this._engineLoad = data[M1_ENGINE_LOAD] || 0;
    this._condition = data[M1_CONDITION];
    this._z = data[M1_Z] || 0;
    this._vz = data[M1_VZ] || 0;

    this._particleContainer.boundsArea.x = this._x - BOUNDS_PADDING;
    this._particleContainer.boundsArea.y = this._y - BOUNDS_PADDING;

    // касание: тот же детектор, что в `Tank.js` — общая функция. Обе части
    // получают один и тот же ряд снапшота, поэтому связывать их колбэком
    // не нужно
    const impact = landingImpact(this._prevVz, this._vz, landingConfig);

    if (impact > 0) {
      this._triggerLandingBurst(impact);
      this._playLandingSound(impact);
    }

    this._prevVz = this._vz;
  }

  _playLandingSound(impact) {
    if (!this._hasLandingSound) {
      return;
    }

    this._soundManager.registerSound('tankLanding', {
      position: { x: this._x, y: this._y },
      volume: this._landingVolume * impact,
    });
  }

  // точки контакта гусениц: сторона `side` — -1 (левая) или 1 (правая)
  _contactPoint(side) {
    const sideAngle = this._rotation + Math.PI / 2;

    return {
      x:
        this._x +
        Math.cos(sideAngle) * this._trackOffset * side -
        Math.cos(this._rotation) * this._backwardOffset,
      y:
        this._y +
        Math.sin(sideAngle) * this._trackOffset * side -
        Math.sin(this._rotation) * this._backwardOffset,
    };
  }

  // всплеск пыли из-под обеих гусениц: радиально наружу, размером и числом
  // по силе удара
  _triggerLandingBurst(impact) {
    const count = Math.round(DUST_CONFIG.landingBurst * impact);

    if (count <= 0) {
      return;
    }

    for (let side = -1; side <= 1; side += 2) {
      const point = this._contactPoint(side);

      for (let i = 0; i < count; i += 1) {
        const angle = randomRange(0, Math.PI * 2);
        const speed =
          randomRange(
            DUST_CONFIG.landingVelocity.min,
            DUST_CONFIG.landingVelocity.max,
          ) * impact;

        this._spawnParticle(
          point.x,
          point.y,
          Math.cos(angle) * speed,
          Math.sin(angle) * speed,
          DUST_CONFIG.landingSizeFactor * impact,
        );
      }
    }
  }

  // буксование: гусеница выбрасывает грунт НАЗАД, против направления тяги
  _spawnSpinDust() {
    const backAngle = this._rotation + Math.PI;
    const sideAngle = this._rotation + Math.PI / 2;

    for (let side = -1; side <= 1; side += 2) {
      const point = this._contactPoint(side);

      const back = randomRange(
        DUST_CONFIG.spinVelocity.back.min,
        DUST_CONFIG.spinVelocity.back.max,
      );
      const lateral = randomRange(
        DUST_CONFIG.spinVelocity.side.min,
        DUST_CONFIG.spinVelocity.side.max,
      );

      this._spawnParticle(
        point.x,
        point.y,
        Math.cos(backAngle) * back + Math.cos(sideAngle) * lateral,
        Math.sin(backAngle) * back + Math.sin(sideAngle) * lateral,
        1,
      );
    }
  }

  _spawnParticle(x, y, vx, vy, sizeMultiplier) {
    const startSizeFactor = DUST_CONFIG.startSizeFactor * sizeMultiplier;
    const endSizeFactor = DUST_CONFIG.endSizeFactor * sizeMultiplier;

    const view = ParticlePool.get(this._dustTexture);
    const startScale =
      startSizeFactor * this._particleScaleMultiplier * this._textureScale;

    view.tint = DUST_CONFIG.color;
    view.x = x;
    view.y = y;
    view.alpha = DUST_CONFIG.startAlpha;
    view.scaleX = startScale;
    view.scaleY = startScale;
    view.rotation = randomRange(0, Math.PI * 2);

    this._particles.push({
      view,
      x,
      y,
      vx,
      vy,
      age: 0,
      lifetime: randomRange(DUST_CONFIG.lifetime.min, DUST_CONFIG.lifetime.max),
      startSizeFactor,
      endSizeFactor,
      rotSpeed: randomRange(-1, 1),
    });

    this._particleContainer.addParticle(view);
  }

  _updateParticles(deltaMs) {
    if (deltaMs <= 0) {
      return;
    }

    const deltaTime = deltaMs / 1000.0;

    this._timeSinceSpawn += deltaMs;

    // упор в стену: газ есть, а танк не едет. `engineLoad > 1` — тот же
    // порог «напряжения», по которому Tracks.js штампует следы, а Tank.js
    // поднимает высоту тона двигателя
    const strain = Math.max(0, this._engineLoad - 1);
    const speed = Math.hypot(this._vx, this._vy);
    const spinning =
      this._condition > 0 && strain > 0 && speed < DUST_CONFIG.maxSpinSpeed;
    const rate = spinning ? DUST_CONFIG.spawnRate * Math.min(strain, 1) : 0;

    if (rate > 0) {
      const interval = 1000.0 / rate;

      while (this._timeSinceSpawn >= interval) {
        this._spawnSpinDust();
        this._timeSinceSpawn -= interval;
      }
    } else {
      this._timeSinceSpawn = 0;
    }

    const frictionFactor = Math.pow(DUST_CONFIG.airResistance, deltaMs / 16.0);

    // обратный цикл для безопасного удаления
    for (let i = this._particles.length - 1; i >= 0; i -= 1) {
      const particle = this._particles[i];

      particle.age += deltaMs;

      if (particle.age >= particle.lifetime) {
        this._particleContainer.removeParticle(particle.view);
        ParticlePool.release(particle.view);
        this._particles.splice(i, 1);
        continue;
      }

      particle.vx *= frictionFactor;
      particle.vy *= frictionFactor;

      particle.x += particle.vx * deltaTime;
      particle.y += particle.vy * deltaTime;

      const lifeProgress = particle.age / particle.lifetime;
      const ease = 1 - (1 - lifeProgress) * (1 - lifeProgress);

      const currentScale =
        (particle.startSizeFactor +
          (particle.endSizeFactor - particle.startSizeFactor) * ease) *
        this._particleScaleMultiplier *
        this._textureScale;

      const view = particle.view;

      view.x = particle.x;
      view.y = particle.y;
      view.scaleX = currentScale;
      view.scaleY = currentScale;
      view.alpha =
        DUST_CONFIG.startAlpha +
        (DUST_CONFIG.endAlpha - DUST_CONFIG.startAlpha) * lifeProgress;
      view.rotation += particle.rotSpeed * deltaTime;
    }
  }

  _stopTimer() {
    if (this._tickListener) {
      Ticker.shared.remove(this._tickListener);
      this._tickListener = null;
    }
  }

  destroy(options) {
    this._stopTimer();

    // все активные частицы в пул
    for (let i = 0; i < this._particles.length; i += 1) {
      ParticlePool.release(this._particles[i].view);
    }

    this._particles = [];

    // children: true идёт после ...options и не переопределяется извне:
    // отключение children оставило бы уже возвращённые в пул частицы
    // висеть в живом _particleContainer (двойное использование)
    super.destroy({
      texture: false,
      textureSource: false,
      ...options,
      children: true,
    });
  }
}
