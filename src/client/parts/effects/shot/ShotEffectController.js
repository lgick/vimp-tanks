import { Container } from 'pixi.js';
import TracerEffect from './TracerEffect.js';
import ImpactEffect from './ImpactEffect.js';
import { levelZ } from '../../../levelZ.js';
import { cameraCenter } from '../../../camera.js';
import { applyParallax } from '../../../parallax.js';
import { parallax as parallaxConfig } from '../../../../config/render.js';
import {
  W1_START_X,
  W1_START_Y,
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

    // 2.5D: трассер рисуется целиком на уровне КОНЦА луча — ломать линию
    // на кромке плиты отложено (plan/README.md), а осколки обязаны лежать
    // там же, где луч закончился, иначе они провалятся под мост. Уровень
    // начала (`W1_START_LEVEL`) кадром приходит, но до разлома линии он
    // здесь не нужен — читать его нечем
    this.endLevel = data[W1_END_LEVEL] || 0;
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
    this._mapDynamics = dependencies.mapDynamics || null;
    this._levelView = dependencies.levelView || null;

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
        applyParallax(
          this,
          cameraCenter(this.parent, this._renderer),
          this.endLevel * parallaxConfig.shear,
          1,
        );
      };
    }

    this.tracer = null;
    this.impact = null;
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

    this.tracer = new TracerEffect(
      this.startPositionX,
      this.startPositionY,
      this.endPositionX,
      this.endPositionY,
      this._onTracerComplete.bind(this),
    );

    this.addChild(this.tracer);
    this.tracer.run();
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
    if (this._visualsComplete && this._soundComplete) {
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

    if (this.impact) {
      this.impact.destroy();
      this.impact = null;
    }

    if (this.parent) {
      this.parent.removeChild(this);
    }

    // children:true уничтожит все, что еще осталось
    super.destroy({ children: true });
  }
}
