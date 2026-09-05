import { Container } from 'pixi.js';
import ExplosionEffect from './ExplosionEffect.js';
import FunnelEffect from './FunnelEffect.js';
import { REFERENCE_BLAST_RADIUS } from './SmokeEffect.js';
import { levelZ } from '../../../levelZ.js';
import { cameraCenter } from '../../../camera.js';
import { offsetPoint } from '../../../parallax.js';
import { parallax as parallaxConfig } from '../../../../config/render.js';
import {
  W2E_X,
  W2E_Y,
  W2E_RADIUS,
  W2E_LEVEL,
} from '../../../snapshotFields.js';

// базовые zIndex вспышки и воронки внутри своего уровня
const EXPLOSION_BASE_Z = 4;
const FUNNEL_BASE_Z = 2;

export default class ExplosionEffectController extends Container {
  constructor(data, assets, dependencies) {
    super();

    this.originX = data[W2E_X];
    this.originY = data[W2E_Y];
    // радиус - единственный источник масштаба для вспышки, воронки и дыма:
    // гард здесь избавляет всех троих от NaN, если сервер его не прислал
    this.radius = data[W2E_RADIUS] ?? REFERENCE_BLAST_RADIUS;
    // 2.5D: уровень взрыва — плита моста экранирует его и вверх, и вниз,
    // значит и рисуется он только на своём слое
    this._level = data[W2E_LEVEL] || 0;

    this._assets = assets;
    this._soundManager = dependencies.soundManager;
    this._levelView = dependencies.levelView || null;
    this._renderer = dependencies.renderer || null;

    // вспышка и воронка живут СИБЛИНГАМИ на сцене (у них свои zIndex),
    // поэтому прозрачность ставится им, а не контроллеру.
    // `onRender` — аксессор Container, назначается свойством
    if (this._levelView || this._renderer) {
      this.onRender = () => {
        if (this._levelView) {
          this._updateSeeThrough();
        }

        this._applyHeight();
      };
    }

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

  _updateSeeThrough() {
    const alpha = this._levelView.alphaFor(
      this._level,
      this.originX,
      this.originY,
    );
    const tint = this._levelView.tintFor(this._level);

    if (this.explosion) {
      this.explosion.alpha = alpha;
      this.explosion.tint = tint;
    }

    if (this.funnel) {
      this.funnel.alpha = alpha;
      this.funnel.tint = tint;
    }
  }

  // Проекция высоты: взрыв на мосту стоит на мосту, а не на земле под ним —
  // тот же сдвиг и тот же масштаб, что у плиты (`src/client/parallax.js`).
  // Вспышка и воронка живут сиблингами на сцене, поэтому проекция ставится
  // каждой из них, а не контроллеру
  _applyHeight() {
    const k = this._level * parallaxConfig.shear;
    const camera = cameraCenter(this.parent, this._renderer);
    const view = offsetPoint(this.originX, this.originY, camera, k);

    for (const target of [this.explosion, this.funnel]) {
      if (target) {
        target.position.set(view.x, view.y);
        target.scale.set(1 + k);
      }
    }
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

    this.explosion.zIndex = levelZ(EXPLOSION_BASE_Z, this._level);

    this.funnel = new FunnelEffect(
      this.originX,
      this.originY,
      this.radius,
      this._onFunnelComplete.bind(this),
      this._assets,
    );

    this.funnel.zIndex = levelZ(FUNNEL_BASE_Z, this._level);

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
