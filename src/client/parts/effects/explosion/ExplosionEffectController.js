import { Container } from 'pixi.js';
import ExplosionEffect from './ExplosionEffect.js';
import FunnelEffect from './FunnelEffect.js';
import { REFERENCE_BLAST_RADIUS } from './SmokeEffect.js';

export default class ExplosionEffectController extends Container {
  constructor(data, assets, dependencies) {
    super();

    this.originX = data[0];
    this.originY = data[1];
    // радиус - единственный источник масштаба для вспышки, воронки и дыма:
    // гард здесь избавляет всех троих от NaN, если сервер его не прислал
    this.radius = data[2] ?? REFERENCE_BLAST_RADIUS;

    this._assets = assets;
    this._soundManager = dependencies.soundManager;

    this.x = this.originX;
    this.y = this.originY;

    this.explosion = null;
    this.funnel = null;
    this._isStarted = false;
    this._isDestroyed = false;

    this._soundId = this._soundManager.registerSound('explosion', {
      position: {
        x: this.originX,
        y: this.originY,
      },
    });
  }

  // вспышка и воронка с дымом поднимаются вместе: воронка живёт много дольше
  // вспышки, и именно её завершение уничтожает контроллер
  run() {
    // повторный run поднял бы вторую пару эффектов поверх первой,
    // потеряв ссылки на неё: старая пара осталась бы на сцене и в тикере
    if (this._isDestroyed || this._isStarted) {
      return;
    }

    this._isStarted = true;

    // сцену очистили до старта - поднимать эффекты некуда, а ждать нечего:
    // уничтожает контроллер только завершение воронки, которой не будет
    if (!this.parent) {
      this.destroy();
      return;
    }

    this.explosion = new ExplosionEffect(
      this.originX,
      this.originY,
      this.radius,
      this._onExplosionComplete.bind(this),
      this._assets,
    );

    this.explosion.zIndex = 4;

    this.funnel = new FunnelEffect(
      this.originX,
      this.originY,
      this.radius,
      this._onFunnelComplete.bind(this),
      this._assets,
    );

    this.funnel.zIndex = 2;

    // эффекты добавляются вне GameView.add - порядок слоёв пересчитывается тут,
    // одной сортировкой на оба
    this.parent.addChild(this.explosion, this.funnel);
    this.parent.sortChildren();

    this.explosion.run();
    this.funnel.run();
  }

  _onExplosionComplete() {
    if (this._isDestroyed) {
      return;
    }

    if (this.explosion) {
      this.explosion.destroy();
      this.explosion = null;
    }
  }

  _onFunnelComplete() {
    if (this._isDestroyed) {
      return;
    }

    // когда исчезает воронка (она длится дольше взрыва),
    // уничтожение всего контроллера
    this.destroy();
  }

  destroy() {
    if (this._isDestroyed) {
      return;
    }

    this._isDestroyed = true;

    if (this._soundId) {
      this._soundManager.unregisterSound(this._soundId);
      this._soundId = null;
    }

    if (this.explosion) {
      this.explosion.destroy();
      this.explosion = null;
    }

    if (this.funnel) {
      this.funnel.destroy();
      this.funnel = null;
    }

    if (this.parent) {
      this.parent.removeChild(this);
    }

    super.destroy({
      children: true,
    });
  }
}
