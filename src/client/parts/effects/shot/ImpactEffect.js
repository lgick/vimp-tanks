import { Sprite } from 'pixi.js';
import BaseEffect from '../BaseEffect.js';
import { lerp, randomRange } from 'vimp-engine/lib/math.js';
import { reproject } from '../../../parallax.js';

export default class ImpactEffect extends BaseEffect {
  // Осколки живут в мировых координатах и остаются лежать там, где пуля
  // встретила препятствие, — даже если задетый ящик поедет дальше. Задача
  // «попасть в правильную точку» решается на стороне ShotEffectController:
  // он пересчитывает точку удара по актуальному трансформу ящика в момент
  // запуска эффекта (см. якорь трассера в core/src/client/shot.rs).
  // Высоту поверхности под осколками (склон рампы) даёт контроллер через
  // `surfaceK`, а проекцию — `project`. Осколки попадания в стену, в грань
  // насыпи и воздушного попадания рождаются на высоте `startK` и за
  // `fallDuration` падают на поверхность.
  constructor(
    x,
    y,
    impactDirectionX,
    impactDirectionY,
    onComplete,
    assets,
    { surfaceK = null, startK = null } = {},
  ) {
    super(onComplete);

    this.x = x; // координата X центра эффекта
    this.y = y; // координата Y центра эффекта

    this._assets = assets;

    const { texture, contentSize } = this._assets.impactParticleTexture;

    this._particleTexture = texture;

    // размер осколка задан в юнитах мира и нормируется
    // по нарисованному кругу текстуры, а не по холсту с запасом под размытие
    this._textureContentSize = contentSize;

    this.config = {
      particleCount: randomRange(2, 4), // количество осколков
      particleMinSize: 0.8, // минимальный размер осколка
      particleMaxSize: 2.4, // максимальный размер осколка

      // начальная скорость разлета
      minInitialSpeed: 10, // пикселей в секунду
      maxInitialSpeed: 300, // пикселей в секунду

      // жизненный цикл осколков
      minLifetime: 8000, // мс
      maxLifetime: 15000, // мс

      color: [0x333333, 0x222222, 0x444444], // массив цветов для осколков

      fadeOutStart: 0.8, // начинать угасание, когда прошло 80% времени жизни

      // управление направлением разлета
      impactDirectionX, // компонента X базового направления отлета
      impactDirectionY, // компонента Y
      spreadAngle: 60, // угол разброса в градусах

      // параметры для управления движением и остановкой
      // коэффициент сопротивления (чем выше, тем быстрее остановка)
      dragCoefficient: 13,
      // порог скорости, ниже которого частица считается "остановившейся"
      minSpeedThreshold: 1.0,
      // сколько времени частица лежит неподвижно перед угасанием (мс)
      lingerDuration: 6000,

      // мс: падение осколка с высоты рождения на поверхность
      fallDuration: 250,
    };

    // обработка случая, когда impactDirection (0,0) - например, выстрел в точку
    // в этом случае частицы разлетятся во все стороны
    if (
      this.config.impactDirectionX === 0 &&
      this.config.impactDirectionY === 0
    ) {
      this.useOmnidirectionalSpread = true; // флаг для разлета во все стороны
    } else {
      this.useOmnidirectionalSpread = false;
    }

    this.particlesData = []; // хранение данные для управления логикой
    this.elapsedTime = 0;

    // 2.5D: коэффициент проекции поверхности под мировой точкой (склон
    // рампы) или null — пол контейнера-хозяина. Даёт контроллер выстрела
    this._surfaceK = typeof surfaceK === 'function' ? surfaceK : null;

    // 2.5D: коэффициент проекции высоты, на которой осколки рождаются
    // (попадание в стену — высота ствола); null — сразу на поверхности.
    // С неё осколок падает на поверхность за `fallDuration`
    this._startK = typeof startK === 'number' ? startK : null;

    this._createParticles();
  }

  // коэффициент проекции поверхности под осколком; null — пол хозяина
  _kAt(pData) {
    return this._surfaceK
      ? this._surfaceK(this.x + pData.x, this.y + pData.y)
      : null;
  }

  _createParticles() {
    let baseAngleRad;

    if (!this.useOmnidirectionalSpread) {
      baseAngleRad = Math.atan2(
        this.config.impactDirectionY,
        this.config.impactDirectionX,
      );
    }

    const spreadAngleRad = this.config.spreadAngle * (Math.PI / 180);
    const halfSpreadRad = spreadAngleRad / 2;

    for (let i = 0, len = this.config.particleCount; i < len; i += 1) {
      let particleAngle;

      if (this.useOmnidirectionalSpread) {
        particleAngle = Math.random() * Math.PI * 2;
      } else {
        particleAngle =
          baseAngleRad + randomRange(-halfSpreadRad, halfSpreadRad);
      }

      const initialSpeed = randomRange(
        this.config.minInitialSpeed,
        this.config.maxInitialSpeed,
      );

      // спрайт для частицы
      const sprite = new Sprite(this._particleTexture);
      sprite.anchor.set(0.5);

      const particleData = {
        sprite, // ссылка на спрайт
        x: 0,
        y: 0,
        vx: Math.cos(particleAngle) * initialSpeed,
        vy: Math.sin(particleAngle) * initialSpeed,
        size: randomRange(
          this.config.particleMinSize,
          this.config.particleMaxSize,
        ),
        color: Array.isArray(this.config.color)
          ? this.config.color[
              Math.floor(Math.random() * this.config.color.length)
            ]
          : this.config.color,
        lifetime: randomRange(this.config.minLifetime, this.config.maxLifetime),
        age: 0,
        alpha: 1.0,
        active: true,
        isMoving: true,
        timeSinceStopped: 0,
        k: null,
        lift: 1, // доля высоты рождения, убывает от 1 до 0
      };

      particleData.k = this._kAt(particleData);

      // начальный цвет
      sprite.tint = particleData.color;

      this.particlesData.push(particleData);
      this.addChild(sprite);
    }
  }

  _update(deltaMs) {
    if (this.isComplete) {
      return;
    }

    this.elapsedTime += deltaMs;
    const deltaSeconds = deltaMs / 1000;
    let activeParticlesCount = 0;

    for (let i = 0, len = this.particlesData.length; i < len; i += 1) {
      const pData = this.particlesData[i];

      if (!pData.active) {
        continue;
      }

      activeParticlesCount += 1;
      pData.age += deltaMs;

      // падение с высоты рождения: с ускорением, как под тяжестью
      const fall = Math.min(pData.age / this.config.fallDuration, 1);

      pData.lift = 1 - fall * fall;

      if (pData.isMoving) {
        // сопротивление среды (drag)
        const speed = Math.hypot(pData.vx, pData.vy);

        if (speed > 0) {
          const dragForceMagnitude =
            speed * this.config.dragCoefficient * deltaSeconds;

          const speedReductionFactor = Math.max(
            0,
            1 - dragForceMagnitude / speed,
          );

          pData.vx *= speedReductionFactor;
          pData.vy *= speedReductionFactor;
        }

        pData.x += pData.vx * deltaSeconds;
        pData.y += pData.vy * deltaSeconds;

        // высота поверхности под осколком меняется, только пока он летит
        pData.k = this._kAt(pData);

        const currentSpeed = Math.hypot(pData.vx, pData.vy);

        // если частица остановилась
        if (currentSpeed < this.config.minSpeedThreshold) {
          pData.isMoving = false;
          pData.vx = 0;
          pData.vy = 0;
        }
        // частица остановилась
      } else {
        pData.timeSinceStopped += deltaMs;
      }

      // логика угасания и завершения жизни
      const currentLifetimeProgress = pData.age / pData.lifetime;

      if (
        !pData.isMoving &&
        pData.timeSinceStopped >= this.config.lingerDuration
      ) {
        // ускоренное угасание после остановки и задержки
        const timeIntoFade =
          pData.timeSinceStopped - this.config.lingerDuration;
        // угасание за короткое время, например, 1 секунда после lingerDuration
        const quickFadeDuration = Math.min(
          500,
          pData.lifetime * (1 - this.config.fadeOutStart),
        );
        pData.alpha = lerp(
          1.0,
          0.0,
          Math.min(timeIntoFade / quickFadeDuration, 1.0),
        );
      } else if (currentLifetimeProgress >= this.config.fadeOutStart) {
        // стандартное угасание по lifetime
        const timeIntoFade =
          pData.age - pData.lifetime * this.config.fadeOutStart;
        const fadeDuration = pData.lifetime * (1 - this.config.fadeOutStart);
        pData.alpha =
          fadeDuration > 0
            ? lerp(1.0, 0.0, Math.min(timeIntoFade / fadeDuration, 1.0))
            : 0.0;
      }

      if (pData.age >= pData.lifetime || pData.alpha < 0.01) {
        pData.active = false; // частица неактивна
        pData.alpha = 0; // полностью прозрачна
      }

      // обновление спрайта
      const pSprite = pData.sprite;

      pSprite.position.set(pData.x, pData.y);
      pSprite.alpha = pData.alpha;
      pSprite.visible = pData.active;

      const scale = pData.size / this._textureContentSize;

      pSprite.scale.set(scale);
    }

    if (activeParticlesCount === 0 && this._isStarted) {
      this._completeEffect();
    }
  }

  // Падает ли ещё хоть один осколок с высоты рождения
  isFalling() {
    return (
      this._startK !== null &&
      this.particlesData.some(pData => pData.active && pData.lift > 0)
    );
  }

  // 2.5D: осколок на склоне рампы лежит на склоне. Контейнер-хозяин уже в
  // проекции `kHost` (контроллер — уровень конца луча), осколок с высотой
  // поверхности `pData.k` переносится внутри неё в проекцию своей высоты
  // (`reproject`). Считается из `pData`, а не из спрайта: вызов
  // идемпотентен, порядок с тиком `_update` не важен. Осколки попадания
  // в стену рождаются на высоте `startK` и за `fallDuration` падают на
  // поверхность. Без `surfaceK` и `startK` — ничего не делает
  project(camera, kHost) {
    if (!this._surfaceK && this._startK === null) {
      return;
    }

    for (const pData of this.particlesData) {
      if (!pData.active) {
        continue;
      }

      const surface = pData.k ?? kHost;
      const k =
        this._startK === null
          ? surface
          : surface + (this._startK - surface) * pData.lift;
      const point = reproject(
        this.x + pData.x,
        this.y + pData.y,
        camera,
        kHost,
        k,
      );

      pData.sprite.position.set(point.x - this.x, point.y - this.y);
      pData.sprite.scale.set(
        (pData.size / this._textureContentSize) * point.scale,
      );
    }
  }

  destroy(options) {
    this.particlesData = [];
    super.destroy(options);
  }
}
