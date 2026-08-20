import { Sprite } from 'pixi.js';
import { clamp, randomRange } from 'vimp-engine/lib/math.js';
import SmokeEffect from './SmokeEffect.js';
import BaseEffect from '../BaseEffect.js';

// константы для _createFunnelSprite
// диаметр видимой воронки как доля от радиуса взрыва:
// след масштабируется вместе с мощностью оружия
// доля подобрана под эталонную бомбу REFERENCE_BLAST_RADIUS
const FUNNEL_TO_BLAST_RATIO = 0.168;
// базовая прозрачность: след едва читается и не спорит с игровыми объектами
const FUNNEL_BASE_ALPHA = 0.225;
// разброс размера воронок относительно базового
const FUNNEL_SIZE_JITTER = 0.15;

// времена жизни следа и его фаз
const FUNNEL_DURATION_MS = 20000;
// проявление: воронка поднимается вместе со вспышкой и под ней же,
// поэтому фаза короткая - она снимает щелчок, а не читается как анимация
// 0 - проявление мгновенное
const FUNNEL_FADE_IN_DURATION_MS = 50;
const FUNNEL_FADE_DURATION_MS = 4000; // затухание
const SMOKE_DURATION_MS = 4000; // время дыма

export default class FunnelEffect extends BaseEffect {
  constructor(x, y, radius, onComplete, assets) {
    super(onComplete);

    this._assets = assets;
    this._radius = radius;
    this.x = x;
    this.y = y;
    this._funnelDurationMs = FUNNEL_DURATION_MS;
    this._funnelFadeInDurationMs = FUNNEL_FADE_IN_DURATION_MS;
    this._funnelFadeDurationMs = FUNNEL_FADE_DURATION_MS;
    this._elapsedMs = 0;
    this._smokeDurationMs = SMOKE_DURATION_MS;
    this._smokeSpawningStopped = false;

    this._funnel = this._createFunnelSprite();
    this._smoke = new SmokeEffect(this._assets, this._radius);

    this.addChild(this._funnel, this._smoke);
  }

  _createFunnelSprite() {
    // ассет - набор силуэтов, воронка берёт случайный
    const { textures, contentSize } = this._assets.funnelTexture;
    const texture = textures[Math.floor(Math.random() * textures.length)];

    // текстура уже двухтоновая, tint не применяется
    const funnelSprite = new Sprite(texture);
    funnelSprite.anchor.set(0.5);
    funnelSprite.alpha = 0; // проявляется в _update

    // поворот и разброс размера, чтобы воронки не повторялись
    funnelSprite.rotation = Math.random() * Math.PI * 2;

    const size =
      this._radius *
      FUNNEL_TO_BLAST_RATIO *
      randomRange(1 - FUNNEL_SIZE_JITTER, 1 + FUNNEL_SIZE_JITTER);

    // масштаб нормируется по силуэту, а не по холсту:
    // запас под размытие не влияет на видимый размер воронки
    funnelSprite.scale.set(size / contentSize);

    return funnelSprite;
  }

  _onEffectStart() {
    // переопределение хука из BaseEffect
    // на случай, если в базовом классе появится логика
    super._onEffectStart();
    if (this._smoke) {
      this._smoke.run();
    }
  }

  _update(deltaMs) {
    if (this.isComplete) {
      return;
    }

    this._elapsedMs += deltaMs;

    // если время дыма закончилось
    if (
      !this._smokeSpawningStopped &&
      this._elapsedMs >= this._smokeDurationMs
    ) {
      this._smoke.stopSpawning();
      this._smokeSpawningStopped = true;
    }

    const timeLeft = this._funnelDurationMs - this._elapsedMs;

    // воронка проступает со вспышкой и затухает к концу жизни
    // нулевое проявление - деления нет, воронка видна сразу
    const fadeIn =
      this._funnelFadeInDurationMs > 0
        ? this._elapsedMs / this._funnelFadeInDurationMs
        : 1;
    const fadeOut = timeLeft / this._funnelFadeDurationMs;

    this._funnel.alpha =
      FUNNEL_BASE_ALPHA * clamp(Math.min(fadeIn, fadeOut), 0, 1);

    if (timeLeft <= 0) {
      this._completeEffect(); // метод из BaseEffect
    }
  }

  destroy(options) {
    // уничтожение эффекта перед super.destroy()
    if (this._smoke) {
      this._smoke.destroy();
      this._smoke = null;
    }

    this._funnel = null;

    super.destroy(options);
  }
}
