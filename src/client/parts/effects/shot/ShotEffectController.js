import { Container } from 'pixi.js';
import TracerEffect from './TracerEffect.js';
import ImpactEffect from './ImpactEffect.js';

export default class ShotEffectController extends Container {
  constructor(data, assets, dependencies) {
    super();

    this.zIndex = 2;

    this.startPositionX = data[0];
    this.startPositionY = data[1];
    this.endPositionX = data[2];
    this.endPositionY = data[3];
    this.soundPositionX = data[4];
    this.soundPositionY = data[5];
    this.hit = data[6];

    // якорь попадания в динамику карты — девятый элемент строки, только
    // у своего локально предсказанного трассера (см. build_tracer в
    // core/src/client/shot.rs); авторитетные трассеры (длина 8) его не
    // несут — data[8] === undefined
    this.anchorKey = null;
    this.anchorLocalX = 0;
    this.anchorLocalY = 0;

    if (Array.isArray(data[8])) {
      [this.anchorKey, this.anchorLocalX, this.anchorLocalY] = data[8];
    }

    this._assets = assets;
    this._soundManager = dependencies.soundManager;
    this._mapDynamics = dependencies.mapDynamics || null;

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
