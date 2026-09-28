import { Container, Sprite, Ticker } from 'pixi.js';
import { lerp, clamp, randomRange } from 'vimp-engine/lib/math.js';
import ParticleChannel from './ParticleChannel.js';
import { levelZ, renderLevel } from '../levelZ.js';
import { cameraCenter } from '../camera.js';
import { applyParallax, offsetPoint, reproject } from '../parallax.js';
import { flicker, lightLevels } from '../lighting/lightMath.js';
import { colorRamp, lerpColor } from '../colorRamp.js';
import {
  fireIntensity,
  smokeRate,
  emissionEnd,
  smokeAlpha,
} from '../wreckTimeline.js';
import {
  parallax as parallaxConfig,
  wreckFx,
  lighting as lightingConfig,
} from '../../config/render.js';
import {
  M1_X,
  M1_Y,
  M1_ANGLE,
  M1_CONDITION,
  M1_SIZE,
  M1_Z,
  M1_LEVEL,
} from '../snapshotFields.js';

// как дым (Smoke): над корпусом (3), под перекрывателем объёма (5)
const WRECK_FIRE_BASE_Z = 4;
// как воронка (FunnelEffect): над следами (1), под танком (3)
const SCORCH_BASE_Z = 2;
// отступ boundsArea вокруг эмиттера — как у Smoke
const BOUNDS_PADDING = 400;
// потолок шага симуляции: после сна вкладки не рождается тысяча частиц
const MAX_TICK_MS = 100;
const TAU = Math.PI * 2;

// случайное значение из диапазона конфига `{ min, max }`
const pick = range => randomRange(range.min, range.max);

// Гибель танка: взрыв, пожар и дым над остовом (конфиг — `wreckFx` в
// src/config/render.js). Парт сам ловит переход `condition: >0 → 0` в ряду
// танка; пока танк жив, он простаивает без тикера и без `onRender`.
// Только рендер: ядро и протокол об эффекте не знают
export default class WreckFire extends Container {
  constructor(data, assets, dependencies = {}) {
    super();

    this._readRow(data);
    this._condition = data[M1_CONDITION];

    this.zIndex = levelZ(WRECK_FIRE_BASE_Z, this._level);
    this.visible = false;

    const fireAsset = assets.wreckFireTexture;
    const smokeAsset = assets.wreckSmokeTexture;

    this._fireAsset = fireAsset || null;
    this._smokeAsset = smokeAsset || null;
    // без ассета копоти эффект идёт без неё
    this._scorchAsset = assets.wreckScorchTexture || null;
    this._fireUnit = fireAsset ? 1 / fireAsset.contentSize : 0;
    this._smokeUnit = smokeAsset ? 1 / smokeAsset.contentSize : 0;
    this._enabled = wreckFx.enabled && !!fireAsset && !!smokeAsset;

    this._renderer = dependencies.renderer || null;
    this._levelView = dependencies.levelView || null;
    this._soundManager = dependencies.soundManager || null;
    this._blasts = dependencies.blasts || null;
    // ночью — свой свет пожара; днём сервиса нет или он выключен
    this._lighting = dependencies.lighting?.enabled
      ? dependencies.lighting
      : null;

    this._active = false;
    this._elapsed = 0;
    this._flameAcc = 0;
    this._smokeAcc = 0;
    this._seed = 0;
    this._tickListener = null;
    this._light = null;
    this._soundId = null;
    this._scorch = null;

    // каналы и спрайты заводятся лениво при первой гибели (`_ensureViews`)
    this._fire = null;
    this._smoke = null;
    this._glow = null;
    this._flash = null;
    this._flashAge = 0;

    // `onRender` здесь НЕ назначается: живой танк не стоит ни кадра.
    // Первый ряд уже с condition 0 — танк погиб до нас, взрыва нет
  }

  // x, y, курс, высота, уровень и размер из ряда m1. Курс и масштаб
  // размера — `_heading`/`_sizeScale`: `_rotation` и `_scale` — внутренние
  // поля Container, их перезапись ломает трансформ
  _readRow(data) {
    this._x = data[M1_X];
    this._y = data[M1_Y];
    this._heading = data[M1_ANGLE];
    this._z = data[M1_Z] || 0;
    this._physLevel = data[M1_LEVEL] || 0;
    this._level = renderLevel(data[M1_LEVEL], this._z);

    const size = data[M1_SIZE] || wreckFx.referenceSize;

    this._length = size * 4;
    this._width = size * 3;
    this._sizeScale = size / wreckFx.referenceSize;
  }

  update(data) {
    const prev = this._condition;
    const prevLevel = this._level;

    this._readRow(data);

    // остов могли столкнуть с моста — эффект едет на слой нового уровня
    if (this._level !== prevLevel) {
      this.zIndex = levelZ(WRECK_FIRE_BASE_Z, this._level);
    }

    if (this._active) {
      this._fire.follow(this._x, this._y);
      this._smoke.follow(this._x, this._y);
    }

    const condition = data[M1_CONDITION];

    // короткий ряд без condition состояние не меняет (как в Tank.update)
    if (condition === undefined || condition === prev) {
      return;
    }

    this._condition = condition;

    if (condition === 0 && prev > 0) {
      // погиб на глазах
      this._ignite();
    } else if (condition > 0 && prev === 0) {
      // респаун: новый раунд восстанавливает карту — гасим сразу
      this._reset();
    }
  }

  _ensureViews() {
    if (this._fire) {
      return;
    }

    const fireTexture = this._fireAsset.texture;

    this._smoke = new ParticleChannel({
      texture: this._smokeAsset.texture,
      max: wreckFx.maxSmoke,
      padding: BOUNDS_PADDING,
    });
    this._fire = new ParticleChannel({
      texture: fireTexture,
      max: wreckFx.maxFire,
      blendMode: 'add',
      padding: BOUNDS_PADDING,
    });

    const glowSprite = () => {
      const sprite = new Sprite(fireTexture);

      sprite.anchor.set(0.5);
      sprite.blendMode = 'add';
      sprite.visible = false;

      return sprite;
    };

    this._glow = glowSprite();
    this._flash = glowSprite();

    // отсвет под дымом, пламя поверх дыма (яркие языки сквозь тёмный
    // дым), вспышка сверху
    this.addChild(
      this._glow,
      this._smoke.container,
      this._fire.container,
      this._flash,
    );
  }

  _ignite() {
    if (!this._enabled) {
      return;
    }

    // дёшево и страхует от повторной гибели без респауна
    this._reset();
    this._ensureViews();

    this._elapsed = 0;
    this._flameAcc = 0;
    this._smokeAcc = 0;
    // мерцание у каждого остова своё
    this._seed = Math.random() * 1000;
    this._active = true;
    this.visible = true;
    this._fire.follow(this._x, this._y);
    this._smoke.follow(this._x, this._y);

    this._explode();
    this._notify();
    this._addLight();
    this._addScorch();

    this._tickListener = ticker => this._tick(ticker.deltaMS);
    Ticker.shared.add(this._tickListener);
    // `onRender` — аксессор Container: назначается СВОЙСТВОМ
    this.onRender = () => this._render();
  }

  // вспышка, огненный шар, искры, облако дыма
  _explode() {
    const flash = this._flash;

    this._flashAge = 0;
    flash.position.set(this._x, this._y);
    flash.tint = wreckFx.flash.color;
    flash.visible = true;
    this._stepFlash(0);

    for (let i = 0; i < wreckFx.fireball.count; i += 1) {
      this._spawnFireball();
    }

    for (let i = 0; i < wreckFx.sparks.count; i += 1) {
      this._spawnSpark();
    }

    for (let i = 0; i < wreckFx.smoke.burst.count; i += 1) {
      this._spawnSmoke(1, true);
    }
  }

  // звук, ночная вспышка, толчок
  _notify() {
    if (wreckFx.sound && this._soundManager) {
      this._soundId = this._soundManager.registerSound(wreckFx.sound, {
        position: { x: this._x, y: this._y },
      });
    }

    // ночь: вспышка на уровне остова (no-op днём)
    this._lighting?.flash({
      ...lightingConfig.flash.wreck,
      level: this._level,
      x: this._x,
      y: this._y,
      z: this._z,
    });

    // толчок: остов под «взрывом» подпрыгивает, соседи качаются
    // (src/client/blastJolt.js)
    if (wreckFx.joltRadius > 0) {
      this._blasts?.exploded({
        x: this._x,
        y: this._y,
        radius: wreckFx.joltRadius * this._sizeScale,
        level: this._physLevel,
      });
    }
  }

  // мерцающий свет пожара (только если есть сервис)
  _addLight() {
    if (!this._lighting) {
      return;
    }

    this._light = this._lighting.addLight({
      kind: 'radial',
      radius: lightingConfig.wreckFire.radius * this._sizeScale,
      color: lightingConfig.wreckFire.color,
      intensity: 0,
    });
  }

  // копоть — сиблинг на сцене в точке гибели: не едет за остовом, если его
  // потом столкнут
  _addScorch() {
    const asset = this._scorchAsset;

    if (!wreckFx.scorch.enabled || !asset || !this.parent) {
      return;
    }

    const { textures } = asset;
    const sprite = new Sprite(
      textures[Math.floor(Math.random() * textures.length)],
    );

    sprite.anchor.set(0.5);
    sprite.rotation = Math.random() * TAU;
    sprite.alpha = 0;
    sprite.zIndex = levelZ(SCORCH_BASE_Z, this._level);

    this._scorch = sprite;
    this._scorchX = this._x;
    this._scorchY = this._y;
    this._scorchZ = this._z;
    this._scorchLevel = this._level;
    this._scorchScale =
      (wreckFx.scorch.size * this._sizeScale) / asset.contentSize;
    this._scorchAge = 0;
    this._scorchAlpha = 0;

    // сиблинг добавлен мимо GameView.add (как ExplosionEffectController.run)
    this.parent.addChild(sprite);
    this.parent.sortChildren();
  }

  // точка на корпусе: `points` — доли [вдоль курса, поперёк], `spread` — разброс
  _hullPoint(points, spread) {
    const [u0, v0] = points[Math.floor(Math.random() * points.length)];
    const u = (u0 + randomRange(-spread, spread) / 2) * this._length;
    const v = (v0 + randomRange(-spread, spread) / 2) * this._width;
    const cos = Math.cos(this._heading);
    const sin = Math.sin(this._heading);

    return { x: this._x + cos * u - sin * v, y: this._y + sin * u + cos * v };
  }

  // языки пламени: стихающий пожар даёт их мельче
  _spawnFlame(intensity) {
    const { fire, wind } = wreckFx;
    const point = this._hullPoint(fire.points, fire.spread);
    const p = this._fire.spawn({
      kind: 'flame',
      x: point.x,
      y: point.y,
      vx:
        wind.x * 0.5 + randomRange(-fire.jitter, fire.jitter) * this._sizeScale,
      vy:
        wind.y * 0.5 + randomRange(-fire.jitter, fire.jitter) * this._sizeScale,
      windX: wind.x,
      windY: wind.y,
      // живёт полсекунды — сопротивление не нужно
      drag: 0,
      h: 0,
      rise: fire.rise,
      age: 0,
      life: pick(fire.lifetime),
      size0:
        pick(fire.size) *
        this._sizeScale *
        (0.6 + 0.4 * intensity) *
        this._fireUnit,
      grow: fire.grow,
      aspectX: randomRange(0.8, 1.2),
      aspectY: randomRange(0.8, 1.2),
      spin: randomRange(-1, 1),
      alpha: fire.alpha,
      tint: 0xffffff,
      scaleX: 0,
      scaleY: 0,
    });

    if (p) {
      p.view.rotation = Math.random() * TAU;
      this._applyFire(p, 0);
    }
  }

  // горящие клубы разлетаются из корпуса и тормозят
  _spawnFireball() {
    const { fireball, wind } = wreckFx;
    const point = this._hullPoint([[0, 0]], 0.8);
    const angle = Math.random() * TAU;
    const speed = pick(fireball.speed) * this._sizeScale;
    const p = this._fire.spawn({
      kind: 'fireball',
      x: point.x,
      y: point.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      windX: wind.x,
      windY: wind.y,
      drag: fireball.drag,
      h: 0,
      rise: fireball.rise,
      age: 0,
      life: pick(fireball.lifetime),
      size0: pick(fireball.size) * this._sizeScale * this._fireUnit,
      grow: fireball.grow,
      aspectX: randomRange(0.8, 1.2),
      aspectY: randomRange(0.8, 1.2),
      spin: randomRange(-1, 1),
      alpha: fireball.alpha,
      tint: 0xffffff,
      scaleX: 0,
      scaleY: 0,
    });

    if (p) {
      p.view.rotation = Math.random() * TAU;
      this._applyFire(p, 0);
    }
  }

  // искры: быстрые штрихи из центра, вытянутые по скорости
  _spawnSpark() {
    const { sparks } = wreckFx;
    const angle = Math.random() * TAU;
    const speed = pick(sparks.speed) * this._sizeScale;
    const p = this._fire.spawn({
      kind: 'spark',
      x: this._x,
      y: this._y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      windX: 0,
      windY: 0,
      drag: sparks.drag,
      h: 0,
      rise: 0,
      age: 0,
      life: pick(sparks.lifetime),
      // длина штриха; ширина — отдельно
      size0: sparks.length * this._sizeScale * this._fireUnit,
      width: sparks.width * this._sizeScale * this._fireUnit,
      grow: 1,
      aspectX: 1,
      aspectY: 1,
      spin: 0,
      alpha: 1,
      tint: 0xffffff,
      scaleX: 0,
      scaleY: 0,
    });

    if (p) {
      p.view.rotation = angle;
      this._applyFire(p, 0);
    }
  }

  // клуб дыма: `heat` 1 — чёрный густой (пожар), 0 — светлый редкий (после)
  _spawnSmoke(heat, burst) {
    const { fire, smoke, wind } = wreckFx;
    const point = this._hullPoint(fire.points, fire.spread);
    const angle = Math.random() * TAU;
    const speed =
      (burst ? pick(smoke.burst.speed) : randomRange(0, smoke.speed)) *
      this._sizeScale;
    const r = Math.random();
    const tint = lerpColor(
      lerpColor(smoke.cooling[0], smoke.cooling[1], r),
      lerpColor(smoke.burning[0], smoke.burning[1], r),
      heat,
    );
    const p = this._smoke.spawn({
      kind: 'smoke',
      x: point.x,
      y: point.y,
      vx: Math.cos(angle) * speed + wind.x,
      vy: Math.sin(angle) * speed + wind.y,
      windX: wind.x,
      windY: wind.y,
      drag: smoke.drag,
      h: 0,
      rise: smoke.rise,
      age: 0,
      life: pick(smoke.lifetime) * (burst ? 0.8 : 1),
      size0:
        pick(smoke.size) *
        this._sizeScale *
        (burst ? 1.3 : 1) *
        this._smokeUnit,
      grow: smoke.grow,
      aspectX: randomRange(0.7, 1.3),
      aspectY: randomRange(0.7, 1.3),
      spin: randomRange(-0.3, 0.3),
      alpha: burst
        ? smoke.burst.alpha
        : lerp(smoke.tailAlpha, smoke.alpha, heat),
      tint,
      scaleX: 0,
      scaleY: 0,
    });

    if (p) {
      p.view.tint = tint;
      p.view.rotation = Math.random() * TAU;
      this._applySmoke(p, 0);
    }
  }

  _tick(deltaMs) {
    if (!this._active) {
      return;
    }

    const dt = clamp(deltaMs, 0, MAX_TICK_MS);

    this._elapsed += dt;

    const intensity = fireIntensity(this._elapsed, wreckFx.fire);

    // рождение по накопителю: дробная частота не теряется между кадрами
    this._flameAcc += (wreckFx.fire.rate * intensity * dt) / 1000;

    while (this._flameAcc >= 1) {
      this._flameAcc -= 1;
      this._spawnFlame(intensity);
    }

    this._smokeAcc +=
      (smokeRate(this._elapsed, wreckFx.fire, wreckFx.smoke) * dt) / 1000;

    while (this._smokeAcc >= 1) {
      this._smokeAcc -= 1;
      this._spawnSmoke(intensity, false);
    }

    this._stepChannel(this._fire, dt, p => this._applyFire(p, dt));
    this._stepChannel(this._smoke, dt, p => this._applySmoke(p, dt));
    this._stepFlash(dt);
    this._stepGlow(intensity);
    this._stepLight(intensity);
    this._stepScorch(dt);

    if (
      this._elapsed >= emissionEnd(wreckFx.fire, wreckFx.smoke) &&
      this._fire.size === 0 &&
      this._smoke.size === 0 &&
      !this._flash.visible
    ) {
      this._finish();
    }
  }

  // обратный цикл: отжившие частицы уходят в пул прямо на проходе
  _stepChannel(channel, dt, apply) {
    const { items } = channel;

    for (let i = items.length - 1; i >= 0; i -= 1) {
      const p = items[i];

      p.age += dt;

      if (p.age >= p.life) {
        channel.removeAt(i);
      } else {
        apply(p);
      }
    }
  }

  // скорость сходится к ветру; возвращает долю жизни частицы
  _move(p, sec) {
    const damp = Math.exp(-p.drag * sec);

    p.vx = p.windX + (p.vx - p.windX) * damp;
    p.vy = p.windY + (p.vy - p.windY) * damp;
    p.x += p.vx * sec;
    p.y += p.vy * sec;

    return p.age / p.life;
  }

  // непроецированный вид: проекцию наложит `_render`; без камеры (например,
  // в тестах) вид остаётся мировым
  _writeView(p) {
    const view = p.view;

    view.x = p.x;
    view.y = p.y;
    view.scaleX = p.scaleX;
    view.scaleY = p.scaleY;
  }

  // пламя, огненный шар, искры
  _applyFire(p, dt) {
    const sec = dt / 1000;
    const t = this._move(p, sec);
    const view = p.view;

    if (p.kind === 'spark') {
      const { colors } = wreckFx.sparks;

      p.scaleX = p.size0 * (1 - 0.5 * t);
      p.scaleY = p.width;
      view.rotation = Math.atan2(p.vy, p.vx);
      view.tint = lerpColor(colors[0], colors[1], t);
      view.alpha = 1 - t;
    } else {
      const ease = 1 - (1 - t) * (1 - t);
      const size = p.size0 * (1 + (p.grow - 1) * ease);

      p.scaleX = size * p.aspectX;
      p.scaleY = size * p.aspectY;
      p.h = p.rise * ease;
      view.rotation += p.spin * sec;
      view.tint = colorRamp(wreckFx.fire.ramp, t);
      view.alpha = p.alpha * (1 - t * t);
    }

    this._writeView(p);
  }

  _applySmoke(p, dt) {
    const sec = dt / 1000;
    const t = this._move(p, sec);
    const view = p.view;
    const size = p.size0 * (1 + (p.grow - 1) * (1 - (1 - t) ** 3));

    p.scaleX = size * p.aspectX;
    p.scaleY = size * p.aspectY;
    p.h = p.rise * (1 - (1 - t) * (1 - t));
    view.rotation += p.spin * sec;
    view.alpha = smokeAlpha(t, p.alpha);

    this._writeView(p);
  }

  _stepFlash(dt) {
    const flash = this._flash;

    if (!flash.visible) {
      return;
    }

    const { duration, startSize, endSize, alpha } = wreckFx.flash;

    this._flashAge += dt;

    const t = duration > 0 ? this._flashAge / duration : 1;

    if (t >= 1) {
      flash.visible = false;
      return;
    }

    const size =
      lerp(startSize, endSize, 1 - (1 - t) * (1 - t)) * this._sizeScale;

    flash.scale.set(size * this._fireUnit);
    flash.alpha = alpha * (1 - t) * (1 - t);
  }

  // отсвет едет за остовом и дышит с пламенем
  _stepGlow(intensity) {
    const glow = this._glow;
    const config = wreckFx.glow;

    glow.visible = intensity > 0;

    if (!glow.visible) {
      return;
    }

    glow.position.set(this._x, this._y);
    glow.scale.set(config.size * this._sizeScale * this._fireUnit);
    glow.tint = config.color;
    glow.alpha =
      config.alpha *
      intensity *
      flicker(this._seed, this._elapsed, config.flicker);
  }

  _stepLight(intensity) {
    if (!this._light) {
      return;
    }

    if (intensity <= 0) {
      this._removeLight();
      return;
    }

    const config = lightingConfig.wreckFire;

    this._lighting.updateLight(this._light, {
      x: this._x,
      y: this._y,
      z: this._z,
      level: this._level,
      levels: lightLevels(this._physLevel, this._z, false),
      intensity:
        config.intensity *
        intensity *
        flicker(this._seed + 1, this._elapsed, config.flicker),
    });
  }

  _stepScorch(dt) {
    if (!this._scorch) {
      return;
    }

    const { alpha, fadeIn } = wreckFx.scorch;

    this._scorchAge += dt;
    this._scorchAlpha =
      alpha * (fadeIn > 0 ? clamp(this._scorchAge / fadeIn, 0, 1) : 1);
  }

  // Позиции пишутся здесь, а не в тикере: камера (трансформ сцены) к этому
  // моменту актуальна, и столб дыма не дрожит при движении камеры.
  // Идемпотентно: движок может рисовать несколько раз за тик
  _render() {
    const camera = cameraCenter(this.parent, this._renderer);
    const shear = parallaxConfig.shear;

    if (this._active) {
      // как Smoke: контейнер в проекции высоты остова, частицы в мировых
      // координатах
      const kHost = this._z * shear;

      applyParallax(this, camera, kHost, 1);

      if (this._levelView) {
        this.alpha = this._levelView.alphaFor(
          this._level,
          this._x,
          this._y,
          this._z,
        );
        this.tint = this._levelView.tintFor(this._level);
      }

      // своя высота частицы: столб дыма клонится от центра камеры и растёт
      for (const channel of [this._fire, this._smoke]) {
        for (const p of channel.items) {
          const q = reproject(p.x, p.y, camera, kHost, kHost + p.h * shear);

          p.view.x = q.x;
          p.view.y = q.y;
          p.view.scaleX = p.scaleX * q.scale;
          p.view.scaleY = p.scaleY * q.scale;
        }
      }
    }

    if (this._scorch) {
      // копоть — сиблинг в точке гибели: своя проекция, как у воронки
      // (ExplosionEffectController._applyHeight)
      const k = this._scorchZ * shear;
      const view = offsetPoint(this._scorchX, this._scorchY, camera, k);

      this._scorch.position.set(view.x, view.y);
      this._scorch.scale.set(this._scorchScale * (1 + k));

      const see = this._levelView
        ? this._levelView.alphaFor(
            this._scorchLevel,
            this._scorchX,
            this._scorchY,
            this._scorchZ,
          )
        : 1;

      this._scorch.alpha = this._scorchAlpha * see;

      if (this._levelView) {
        this._scorch.tint = this._levelView.tintFor(this._scorchLevel);
      }
    }
  }

  // дым прошёл: тикер снят; копоть продолжает проецироваться своим
  // `onRender` — одна `offsetPoint` за кадр
  _finish() {
    this._stopTicker();
    this._active = false;
    this._flash.visible = false;
    this._glow.visible = false;
    this._removeLight();
    this.visible = false;

    if (!this._scorch) {
      this.onRender = null;
    }
  }

  // респаун, повторная гибель, destroy: всё гаснет сразу
  _reset() {
    this._stopTicker();

    if (this._fire) {
      this._fire.clear();
      this._smoke.clear();
      this._flash.visible = false;
      this._glow.visible = false;
    }

    this._removeLight();

    if (this._soundId !== null) {
      // дать доиграть; повтор для уже снятого id — no-op
      this._soundManager?.releaseSound(this._soundId);
      this._soundId = null;
    }

    if (this._scorch) {
      // в PixiJS 8 destroy снимает спрайт с родителя; текстура общая
      this._scorch.destroy({ texture: false, textureSource: false });
      this._scorch = null;
    }

    this._active = false;
    this.visible = false;
    this.onRender = null;
  }

  _stopTicker() {
    if (this._tickListener) {
      Ticker.shared.remove(this._tickListener);
      this._tickListener = null;
    }
  }

  _removeLight() {
    if (this._light) {
      this._lighting.removeLight(this._light);
      this._light = null;
    }
  }

  destroy(options) {
    this._reset();

    // children: true после ...options и не переопределяется извне: иначе
    // уже возвращённые в пул частицы остались бы в живом контейнере (как
    // Smoke). Текстуры общие (запечённые) — их парт не уничтожает
    super.destroy({
      texture: false,
      textureSource: false,
      ...options,
      children: true,
    });
  }
}
