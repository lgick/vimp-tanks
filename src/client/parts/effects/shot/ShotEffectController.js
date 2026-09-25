import { Container } from 'pixi.js';
import TracerEffect from './TracerEffect.js';
import { tracerPieces } from './tracerPieces.js';
import ImpactEffect from './ImpactEffect.js';
import MuzzleFlashEffect from './MuzzleFlashEffect.js';
import { levelZ } from '../../../levelZ.js';
import { cameraCenter } from '../../../camera.js';
import { applyParallax } from '../../../parallax.js';
import { EMISSIVE_BASE_Z } from '../../../lighting/lightMath.js';
import {
  parallax as parallaxConfig,
  lighting as lightingConfig,
} from '../../../../config/render.js';
import {
  W1_START_X,
  W1_START_Y,
  W1_START_LEVEL,
  W1_END_X,
  W1_END_Y,
  W1_BODY_X,
  W1_BODY_Y,
  W1_WAS_HIT,
  W1_SHOOTER_ID,
  W1_END_LEVEL,
  W1_ANCHOR,
} from '../../../snapshotFields.js';

// базовый zIndex трассера и осколков внутри своего уровня
const SHOT_BASE_Z = 2;

export default class ShotEffectController extends Container {
  constructor(data, assets, dependencies) {
    super();

    this.startPositionX = data[W1_START_X];
    this.startPositionY = data[W1_START_Y];
    this.endPositionX = data[W1_END_X];
    this.endPositionY = data[W1_END_Y];
    this.soundPositionX = data[W1_BODY_X];
    this.soundPositionY = data[W1_BODY_Y];
    this.hit = data[W1_WAS_HIT];

    // 2.5D: осколки и вспышка — на уровне КОНЦА луча, иначе осколки
    // провалятся под мост. Трассер режется по сегментам уровней ядра и
    // рисуется кусками на своих уровнях (`_layerFor`): луч с моста идёт над
    // плитой и падает за кромкой. Уровень начала (`W1_START_LEVEL`) нужен
    // сегментам и вспышке выстрела на стволе
    this.endLevel = data[W1_END_LEVEL] || 0;
    this.startLevel = data[W1_START_LEVEL] || 0;
    this.zIndex = levelZ(SHOT_BASE_Z, this.endLevel);

    // якорь попадания в динамику карты — одиннадцатый элемент строки, только
    // у своего локально предсказанного трассера (см. build_tracer в
    // core/src/client/shot.rs); авторитетные трассеры (длина 10) его не
    // несут — data[W1_ANCHOR] === undefined
    this.anchorKey = null;
    this.anchorLocalX = 0;
    this.anchorLocalY = 0;

    if (Array.isArray(data[W1_ANCHOR])) {
      [this.anchorKey, this.anchorLocalX, this.anchorLocalY] = data[W1_ANCHOR];
    }

    this._assets = assets;
    this._soundManager = dependencies.soundManager;

    // свой ли это выстрел: звук своего выстрела берёт позицию корпуса
    // стрелка на момент выстрела, а слушатель — центр камеры, то есть
    // предсказанный свой танк. Предсказанный локальный выстрел и его
    // авторитетное эхо не совпадают по позиции — один и тот же выстрел
    // звучал то по центру, то целиком в одно ухо. Свой выстрел принадлежит
    // игроку, а не миру, поэтому не панорамируется
    this._isLocalShot =
      dependencies.localPlayer?.is(data[W1_SHOOTER_ID]) === true;

    // отдача: танк стрелка откатывается (src/client/recoil.js). Эффект
    // создаётся раз на выстрел — свой предсказанный, а авторитетный дубль
    // ядро отфильтровывает
    dependencies.shots?.fired(data[W1_SHOOTER_ID]);
    this._mapDynamics = dependencies.mapDynamics || null;
    // дуло стрелка: пока идут трассер и вспышка, они держатся у ствола
    // едущего танка (сервис `shots`, src/client/shotEvents.js)
    this._shots = dependencies.shots || null;
    this._shooterId = data[W1_SHOOTER_ID];
    this._levelView = dependencies.levelView || null;
    // ночь: вспышка выстрела на стволе (no-op днём)
    this._lighting = dependencies.lighting || null;

    // трассер и осколки уступают видимость игроку под плитой ровно так же,
    // как всё остальное на верхнем уровне (единая формула — в levelView).
    // `onRender` — аксессор Container, назначается свойством
    this._renderer = dependencies.renderer || null;

    if (this._levelView || this._renderer) {
      this.onRender = () => {
        if (this._levelView) {
          this.alpha = this._levelView.alphaFor(
            this.endLevel,
            this.endPositionX,
            this.endPositionY,
          );
          this.tint = this._levelView.tintFor(this.endLevel);
        }

        // проекция высоты: трассер и осколки на мосту стоят на мосту.
        // Дети контроллера авторятся в мировых координатах, сам он
        // единичный — трансформ контейнера даёт им ровно offsetPoint
        const camera = cameraCenter(this.parent, this._renderer);

        applyParallax(this, camera, this.endLevel * parallaxConfig.shear, 1);

        for (const [level, layer] of this.layers) {
          if (this._levelView) {
            layer.alpha = this._levelView.alphaFor(level, layer.refX, layer.refY);
            layer.tint = this._levelView.tintFor(level);
          }

          applyParallax(layer, camera, level * parallaxConfig.shear, 1);
        }

        this._followMuzzle();
        this._placeFlash(camera);
      };
    }

    this.tracer = null;
    // контейнеры кусков трассера по уровням (см. _layerFor): level -> Container
    this.layers = new Map();
    this.impact = null;
    // вспышка у дула; пока её нет, ждать нечего
    this.flash = null;
    this._flashComplete = true;
    this._isDestroyed = false;

    // флаги для управления жизненным циклом
    this._visualsComplete = false;
    this._soundComplete = false;

    // звук выстрела в момент старта эффекта
    this._soundId = this._soundManager.registerSound(
      'shot',
      {
        position: { x: this.soundPositionX, y: this.soundPositionY },
        spatial: !this._isLocalShot,
      },
      () => {
        this._soundComplete = true;
        this._soundId = null;
        this._tryDestroy();
      },
    );

    // если по какой-то причине звук не запустился,
    // сразу считаем его "завершенным"
    if (!this._soundId) {
      this._soundComplete = true;
    }
  }

  run() {
    if (this._isDestroyed) {
      return;
    }

    this._lighting?.flash({
      ...lightingConfig.flash.shot,
      level: this.startLevel,
      x: this.startPositionX,
      y: this.startPositionY,
      z: this.startLevel,
    });

    // вспышка у дула — по направлению луча: оно и есть направление ствола
    const dx = this.endPositionX - this.startPositionX;
    const dy = this.endPositionY - this.startPositionY;
    const dist = Math.hypot(dx, dy);

    if (dist > 0.001) {
      this._flashComplete = false;
      this.flash = new MuzzleFlashEffect(
        this.startPositionX,
        this.startPositionY,
        dx / dist,
        dy / dist,
        () => {
          this._flashComplete = true;
          this._tryDestroy();
        },
      );
      this.addChild(this.flash);
      this.flash.run();
    }

    const pieces = tracerPieces(
      this._shots?.path?.(
        this.startPositionX,
        this.startPositionY,
        this.endPositionX,
        this.endPositionY,
        this.startLevel,
      ),
      dist,
      this.endLevel,
    );

    this.tracer = new TracerEffect(
      this.startPositionX,
      this.startPositionY,
      this.endPositionX,
      this.endPositionY,
      this._onTracerComplete.bind(this),
      undefined,
      {
        pieces,
        layerFor: level => this._layerFor(level, pieces),
      },
    );

    this.addChild(this.tracer);
    this.tracer.run();
  }

  // Контейнер куска трассера уровня `level`. Днём кусок уровня конца
  // рисуется в самом контроллере, как раньше. Остальные уровни — соседние
  // контейнеры на сцене со своими zIndex и проекцией. Ночью трассер — свет:
  // под картой освещённости (multiply) вдали от фар он гас до `ambient`, и
  // дальний выстрел «не появлялся», поэтому все его куски — над картой
  // своего уровня (эмиссив). Осколки и вспышка остаются под ней
  _layerFor(level, pieces) {
    const night = Boolean(this._lighting?.isNight?.());

    if ((!night && level === this.endLevel) || !this.parent) {
      return this;
    }

    let layer = this.layers.get(level);

    if (!layer) {
      const piece = pieces.find(entry => entry.level === level);
      const mid = piece ? (piece.from + piece.to) / 2 : 0;
      const dx = this.endPositionX - this.startPositionX;
      const dy = this.endPositionY - this.startPositionY;
      const total = Math.hypot(dx, dy) || 1;

      layer = new Container();
      layer.label = `shot-tracer-${level}`;
      layer.eventMode = 'none';
      layer.zIndex = levelZ(night ? EMISSIVE_BASE_Z : SHOT_BASE_Z, level);
      // точка, по которой слой уступает видимость игроку под плитой
      layer.refX = this.startPositionX + (dx / total) * mid;
      layer.refY = this.startPositionY + (dy / total) * mid;
      this.parent.addChild(layer);
      this.layers.set(level, layer);
    }

    return layer;
  }

  // Танк едет, эффект живёт в мире: за время пролёта трассера корпус
  // проезжает свою длину, и при стрельбе вбок хвост отрывался от ствола. А
  // чужой танк ещё и нарисован с задержкой интерполяции. Поэтому трассер и
  // вспышка идут за ТЕКУЩИМ дулом стрелка: луч переносится целиком
  // (`TracerEffect.shiftTo`), без поворота. Осколки попадания появляются в
  // исходной точке удара — стена на месте
  _followMuzzle() {
    if (!this._shots || this.impact) {
      return;
    }

    const tracerRunning = this.tracer && !this.tracer.isComplete;
    const flashRunning = this.flash && !this.flash.isComplete;

    if (!tracerRunning && !flashRunning) {
      return;
    }

    const muzzle = this._shots.muzzle(this._shooterId);

    if (!muzzle) {
      return;
    }

    this.startPositionX = muzzle.x;
    this.startPositionY = muzzle.y;

    if (tracerRunning) {
      this.tracer.shiftTo(muzzle.x, muzzle.y);
    }
  }

  // Контроллер рисуется в проекции уровня КОНЦА луча, а дуло — на уровне
  // начала. Если они разные (выстрел с моста вниз), вспышку переносим так,
  // чтобы после проекции контроллера она легла в проекцию дула:
  // q = cam + (p − cam)·(1 + k_s)/(1 + k_e), масштаб — то же отношение
  _placeFlash(camera) {
    if (!this.flash || this.flash.destroyed) {
      return;
    }

    const ratio =
      (1 + this.startLevel * parallaxConfig.shear) /
      (1 + this.endLevel * parallaxConfig.shear);

    this.flash.position.set(
      camera.x + (this.startPositionX - camera.x) * ratio,
      camera.y + (this.startPositionY - camera.y) * ratio,
    );
    this.flash.scale.set(ratio);
  }

  // трассер завершил анимацию.
  // Его графика уже должна быть очищена TracerEffect'ом.
  // сам объект TracerEffect будет уничтожен в destroy
  _onTracerComplete() {
    if (this._isDestroyed) {
      return;
    }

    if (this.hit) {
      let impactX = this.endPositionX;
      let impactY = this.endPositionY;

      // ящик мог уехать за 45-80 мс анимации трассера (TracerEffect): точка
      // удара пересчитывается из ТЕКУЩЕГО трансформа ящика, а не из того,
      // что был в момент выстрела, — иначе облако осколков окажется позади
      // уехавшего ящика. Дальше осколки остаются лежать на месте: за ящиком
      // они не следуют (ImpactEffect работает в мире)
      if (this.anchorKey !== null && this._mapDynamics) {
        const point = this._mapDynamics.toWorld(
          this.anchorKey,
          this.anchorLocalX,
          this.anchorLocalY,
        );

        if (point) {
          impactX = point.x;
          impactY = point.y;
        }
      }

      const dx = impactX - this.startPositionX;
      const dy = impactY - this.startPositionY;
      const dist = Math.hypot(dx, dy);
      let impactDirectionX = 0,
        impactDirectionY = 0;

      if (dist > 0.001) {
        impactDirectionX = -(dx / dist);
        impactDirectionY = -(dy / dist);
      }

      this.impact = new ImpactEffect(
        impactX,
        impactY,
        impactDirectionX,
        impactDirectionY,
        this._onImpactComplete.bind(this), // callback
        this._assets,
      );

      this.addChild(this.impact);
      this.impact.run();

      // иначе, если попадания не было,
      // то после завершения трассера эффект считается завершенным
    } else {
      // визуальная часть завершена, попытка уничтожить объект
      this._visualsComplete = true;
      this._tryDestroy();
    }
  }

  _onImpactComplete() {
    if (this._isDestroyed) {
      return;
    }

    // визуальная часть завершена, попытка уничтожить объект
    this._visualsComplete = true;
    this._tryDestroy();
  }

  // проверяет, завершены ли звук и визуал, и если да, уничтожает объект
  _tryDestroy() {
    if (this._visualsComplete && this._soundComplete && this._flashComplete) {
      this.destroy();
    }
  }

  destroy() {
    if (this._isDestroyed) {
      return;
    }

    this._isDestroyed = true;

    // этот вызов остается на случай, если эффект уничтожат принудительно,
    // до того как звук закончится сам
    if (this._soundId) {
      this._soundManager.unregisterSound(this._soundId);
      this._soundId = null;
    }

    if (this.tracer) {
      this.tracer.destroy();
      this.tracer = null;
    }

    for (const layer of this.layers.values()) {
      layer.destroy({ children: true });
    }

    this.layers.clear();

    if (this.impact) {
      this.impact.destroy();
      this.impact = null;
    }

    if (this.flash) {
      this.flash.destroy();
      this.flash = null;
    }

    if (this.parent) {
      this.parent.removeChild(this);
    }

    // children:true уничтожит все, что еще осталось
    super.destroy({ children: true });
  }
}
