import { Sprite } from 'pixi.js';
import BaseEffect from '../BaseEffect.js';

export default class ExplosionEffect extends BaseEffect {
  constructor(x, y, radius, onComplete, assets) {
    super(onComplete); // конструктор BaseEffect

    // ассет взрыва: текстура + диаметр нарисованного круга
    const { texture, contentSize } = assets.explosionTexture;

    this.x = x;
    this.y = y;
    this._radius = radius;

    this._durationMs = 1500;
    this._elapsedMs = 0;

    // масштаб нормируется по нарисованному кругу, а не по холсту:
    // запас под размытие не должен влиять на видимый размер
    this._baseScale = (this._radius * 2) / contentSize;

    // спрайты
    // основное тело взрыва (голубое)
    this._mainBody = new Sprite(texture);
    this._mainBody.anchor.set(0.5);
    this._mainBody.tint = 0xadd8e6; // светло-голубой
    this._mainBody.scale.set(this._baseScale);

    // коллапсирующее ядро (серое)
    this._core = new Sprite(texture);
    this._core.anchor.set(0.5);
    this._core.tint = 0xd3d3d3; // светло-серый
    this._core.scale.set(this._baseScale); // начальный размер тот же

    this.addChild(this._mainBody, this._core);
  }

  // обновление анимации
  _update(deltaMs) {
    if (this.isComplete) {
      // проверка из BaseEffect
      return;
    }

    this._elapsedMs += deltaMs;

    if (this._elapsedMs <= this._durationMs) {
      const progress = this._elapsedMs / this._durationMs;
      this._draw(progress);
    } else {
      // метод из BaseEffect
      this._completeEffect();
    }
  }

  // отрисовка
  _draw(progress) {
    const easeInQuad = t => t * t;

    // анимация основного тела (затухание)
    this._mainBody.alpha = 0.6 * (1 - easeInQuad(progress));

    // анимация ядра (затухание и сжатие)
    const coreProgress = Math.min(1, progress * 1.5);
    this._core.alpha = 0.7 - coreProgress;
    this._core.scale.set(this._baseScale * (1 - coreProgress));
  }

  // уничтожение объекта
  destroy(options) {
    // вызов destroy из BaseEffect
    super.destroy(options);
  }
}
