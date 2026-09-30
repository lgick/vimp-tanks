# Этап 4. Парт `src/client/parts/WreckFire.js` (новый) ✅ выполнен

## 4.1 Константы, импорты, состояние

```js
import { Container, Sprite, Ticker } from 'pixi.js';
import { lerp, clamp, randomRange } from 'vimp-engine/lib/math.js';
import ParticleChannel from './ParticleChannel.js';
import { levelZ, renderLevel } from '../levelZ.js';
import { cameraCenter } from '../camera.js';
import { applyParallax, offsetPoint, reproject } from '../parallax.js';
import { flicker, lightLevels } from '../lighting/lightMath.js';
import { colorRamp, lerpColor } from '../colorRamp.js';
import { fireIntensity, smokeRate, emissionEnd, smokeAlpha } from '../wreckTimeline.js';
import {
  parallax as parallaxConfig,
  wreckFx,
  lighting as lightingConfig,
} from '../../config/render.js';
import { M1_X, M1_Y, M1_ANGLE, M1_CONDITION, M1_SIZE, M1_Z, M1_LEVEL } from '../snapshotFields.js';

// как дым (Smoke): над корпусом (3), под перекрывателем объёма (5)
const WRECK_FIRE_BASE_Z = 4;
// как воронка (FunnelEffect): над следами (1), под танком (3)
const SCORCH_BASE_Z = 2;
// отступ boundsArea вокруг эмиттера — как у Smoke
const BOUNDS_PADDING = 400;
// потолок шага симуляции: после сна вкладки не рождается тысяча частиц
const MAX_TICK_MS = 100;
const TAU = Math.PI * 2;
```

Конструктор `constructor(data, assets, dependencies = {})`:

- поля из ряда: `_x, _y` (`M1_X/Y`), `_rotation` (`M1_ANGLE`), `_z` (`M1_Z || 0`),
  `_physLevel` (`M1_LEVEL || 0`), `_level = renderLevel(M1_LEVEL, _z)`, `_condition`
  (`M1_CONDITION`), размер `size = data[M1_SIZE] || wreckFx.referenceSize`:
  `_length = size * 4`, `_width = size * 3`, `_scale = size / wreckFx.referenceSize`;
- `this.zIndex = levelZ(WRECK_FIRE_BASE_Z, this._level)`; `this.visible = false`;
- ассеты: `assets.wreckFireTexture`, `assets.wreckSmokeTexture` (оба `{ texture, contentSize }`),
  `assets.wreckScorchTexture` (`{ textures, contentSize }`, может отсутствовать → без копоти);
  `_fireUnit = 1 / fire.contentSize`, `_smokeUnit = 1 / smoke.contentSize`;
  `_enabled = wreckFx.enabled && !!fireAsset && !!smokeAsset`;
- сервисы: `_renderer`, `_levelView`, `_soundManager`, `_blasts`,
  `_lighting = dependencies.lighting?.enabled ? dependencies.lighting : null` (как в `Tank`);
- состояние эффекта: `_active = false`, `_elapsed = 0`, `_flameAcc = 0`, `_smokeAcc = 0`,
  `_seed = 0`, `_tickListener = null`, `_light = null`, `_soundId = null`, `_scorch = null`,
  `_views = null` (каналы и спрайты заводятся лениво при первой гибели).
- **НЕ** назначать `onRender` в конструкторе: живой танк не должен стоить ни кадра.
- Если первый ряд уже с `condition === 0` — ничего не делать (танк погиб до нас).

`_ensureViews()` (один раз): `this._smoke = new ParticleChannel({ texture: smokeTex, max:
wreckFx.maxSmoke, padding: BOUNDS_PADDING })`, `this._fire = new ParticleChannel({ texture: fireTex,
max: wreckFx.maxFire, blendMode: 'add', padding: BOUNDS_PADDING })`; `this._glow` и `this._flash` —
`Sprite(fireTex)`, `anchor 0.5`, `blendMode = 'add'`, `visible = false`. Порядок детей:
`addChild(this._glow, this._smoke.container, this._fire.container, this._flash)` — отсвет под
дымом, пламя поверх дыма (яркие языки сквозь тёмный дым), вспышка сверху.

## 4.2 `update(data)` — детектор перехода

```js
update(data) {
  const prev = this._condition;
  // x, y, rotation, z, physLevel, size — как в конструкторе; при смене уровня
  // отрисовки — новый zIndex (остов могли столкнуть с моста)
  ...
  if (this._active) { this._fire.follow(this._x, this._y); this._smoke.follow(this._x, this._y); }

  const condition = data[M1_CONDITION];

  // короткий ряд без condition состояние не меняет (как в Tank.update)
  if (condition === undefined || condition === prev) { return; }

  this._condition = condition;

  if (condition === 0 && prev > 0) {
    this._ignite();          // погиб на глазах
  } else if (condition > 0 && prev === 0) {
    this._reset();           // респаун: новый раунд восстанавливает карту — гасим сразу
  }
}
```

## 4.3 `_ignite()` — взрыв

```js
_ignite() {
  if (!this._enabled) { return; }
  this._reset();                 // дёшево и страхует от повторной гибели без респауна
  this._ensureViews();
  this._elapsed = 0; this._flameAcc = 0; this._smokeAcc = 0;
  this._seed = Math.random() * 1000;   // мерцание у каждого остова своё
  this._active = true;
  this.visible = true;
  this._fire.follow(this._x, this._y); this._smoke.follow(this._x, this._y);

  this._explode();   // вспышка, шар, искры, облако дыма
  this._notify();    // звук, ночная вспышка, толчок
  this._addLight();  // мерцающий свет пожара (только если есть сервис)
  this._addScorch(); // копоть-сиблинг

  this._tickListener = ticker => this._tick(ticker.deltaMS);
  Ticker.shared.add(this._tickListener);
  // `onRender` — аксессор Container: назначается СВОЙСТВОМ
  this.onRender = () => this._render();
}
```

`_explode()`: вспышка — `_flashAge = 0`, позиция `(_x, _y)`, `tint = wreckFx.flash.color`,
`visible = true`, `_stepFlash(0)`; затем `fireball.count × _spawnFireball()`,
`sparks.count × _spawnSpark()`, `smoke.burst.count × _spawnSmoke(1, true)`.

`_notify()`:

```js
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
// толчок: остов под «взрывом» подпрыгивает, соседи качаются (src/client/blastJolt.js)
if (wreckFx.joltRadius > 0) {
  this._blasts?.exploded({
    x: this._x,
    y: this._y,
    radius: wreckFx.joltRadius * this._scale,
    level: this._physLevel,
  });
}
```

`_addLight()`: `if (!this._lighting) return;` → `this._light = this._lighting.addLight({ kind:
'radial', radius: lightingConfig.wreckFire.radius * this._scale, color:
lightingConfig.wreckFire.color, intensity: 0 })`.

`_addScorch()`: только если `wreckFx.scorch.enabled`, есть ассет копоти и `this.parent`.
Случайный вариант `textures[Math.floor(Math.random() * textures.length)]`, `Sprite`, `anchor 0.5`,
случайный поворот, `alpha 0`, `zIndex = levelZ(SCORCH_BASE_Z, this._level)`; запомнить точку
гибели `_scorchX/_scorchY/_scorchZ/_scorchLevel`, базовый масштаб
`_scorchScale = wreckFx.scorch.size * this._scale / asset.contentSize`, `_scorchAge = 0`,
`_scorchAlpha = 0`; `this.parent.addChild(sprite); this.parent.sortChildren();` (как
`ExplosionEffectController.run`: сиблинг добавлен мимо `GameView.add`). Копоть лежит в точке
гибели и **не** едет за остовом, если его потом столкнут.

## 4.4 Точка на корпусе и спавнеры

```js
// точка на корпусе: `points` — доли [вдоль курса, поперёк], `spread` — разброс
_hullPoint(points, spread) {
  const [u0, v0] = points[Math.floor(Math.random() * points.length)];
  const u = (u0 + randomRange(-spread, spread) / 2) * this._length;
  const v = (v0 + randomRange(-spread, spread) / 2) * this._width;
  const cos = Math.cos(this._rotation);
  const sin = Math.sin(this._rotation);
  return { x: this._x + cos * u - sin * v, y: this._y + sin * u + cos * v };
}
```

Запись частицы (общая форма для обоих каналов): `{ view, kind, x, y, vx, vy, windX, windY, drag,
h, rise, age, life, size0, grow, aspectX, aspectY, spin, alpha, tint, scaleX, scaleY }`.
`size0` хранится уже в масштабе текстуры (`× _fireUnit` или `× _smokeUnit`). После каждого
успешного `spawn` сразу вызвать метод вида с `dt = 0` (`_applyFire(p, 0)` / `_applySmoke(p, 0)`),
чтобы частица из пула не мелькнула с чужими параметрами до первого тика; `view.rotation` —
случайный.

- `_spawnFlame(intensity)` (канал `_fire`, `kind: 'flame'`): точка `_hullPoint(fire.points,
fire.spread)`; скорость `wind × 0.5 + randomRange(−jitter, jitter) × _scale` по каждой оси,
  `drag: 0` (живёт полсекунды — сопротивление не нужно); `size0 = randomRange(size) × _scale ×
(0.6 + 0.4 × intensity)` — стихающий пожар даёт языки мельче; `life = randomRange(lifetime)`;
  `rise: fire.rise`, `grow: fire.grow`, `alpha: fire.alpha`, `aspectX/Y ∈ [0.8, 1.2]`,
  `spin ∈ [−1, 1]` рад/с.
- `_spawnFireball()` (`kind: 'fireball'`): точка `_hullPoint([[0, 0]], 0.8)`; радиальная
  скорость — случайный угол, модуль `randomRange(fireball.speed) × _scale`; `windX/Y = wind`,
  `drag: fireball.drag`; `size0`, `grow`, `life`, `rise`, `alpha` — из `fireball`.
- `_spawnSpark()` (`kind: 'spark'`): из центра; угол случайный, модуль
  `randomRange(sparks.speed) × _scale`; `windX/Y = 0`, `drag: sparks.drag`; `h = 0`, `rise = 0`;
  длина/ширина штриха `sparks.length/width × _scale × _fireUnit`.
- `_spawnSmoke(heat, burst)` (канал `_smoke`, `kind: 'smoke'`): точка
  `_hullPoint(fire.points, fire.spread)`; угол случайный, модуль — `burst ?
randomRange(smoke.burst.speed) : randomRange(0, smoke.speed)` (× `_scale`), к скорости
  прибавить ветер; `windX/Y = wind`, `drag: smoke.drag`; `r = Math.random()`,
  `tint = lerpColor(lerpColor(cooling[0], cooling[1], r), lerpColor(burning[0], burning[1], r), heat)`
  (задаётся один раз); пик прозрачности `burst ? smoke.burst.alpha : lerp(smoke.tailAlpha,
smoke.alpha, heat)`; `life = randomRange(smoke.lifetime) × (burst ? 0.8 : 1)`;
  `size0 = randomRange(smoke.size) × _scale × (burst ? 1.3 : 1) × _smokeUnit`; `aspectX/Y ∈
[0.7, 1.3]`, `spin ∈ [−0.3, 0.3]`, `rise: smoke.rise`, `grow: smoke.grow`.

## 4.5 `_tick(deltaMs)` — симуляция (Ticker.shared)

```js
_tick(deltaMs) {
  if (!this._active) { return; }
  const dt = clamp(deltaMs, 0, MAX_TICK_MS);
  this._elapsed += dt;
  const intensity = fireIntensity(this._elapsed, wreckFx.fire);

  // рождение по накопителю: дробная частота не теряется между кадрами
  this._flameAcc += (wreckFx.fire.rate * intensity * dt) / 1000;
  while (this._flameAcc >= 1) { this._flameAcc -= 1; this._spawnFlame(intensity); }
  this._smokeAcc += (smokeRate(this._elapsed, wreckFx.fire, wreckFx.smoke) * dt) / 1000;
  while (this._smokeAcc >= 1) { this._smokeAcc -= 1; this._spawnSmoke(intensity, false); }

  this._stepChannel(this._fire, dt, p => this._applyFire(p, dt));
  this._stepChannel(this._smoke, dt, p => this._applySmoke(p, dt));
  this._stepFlash(dt);
  this._stepGlow(intensity);
  this._stepLight(intensity);
  this._stepScorch(dt);

  if (this._elapsed >= emissionEnd(wreckFx.fire, wreckFx.smoke)
      && this._fire.size === 0 && this._smoke.size === 0 && !this._flash.visible) {
    this._finish();
  }
}
```

`_stepChannel(channel, dt, apply)`: обратный цикл по `channel.items`: `p.age += dt`; если
`p.age >= p.life` → `channel.removeAt(i)`; иначе `apply(p)`.

Общая физика в `_applyFire`/`_applySmoke` (sec = dt / 1000): скорость сходится к ветру
`damp = Math.exp(−p.drag × sec)`: `p.vx = p.windX + (p.vx − p.windX) × damp` (то же для `vy`),
`p.x += p.vx × sec`, `p.y += p.vy × sec`, `t = p.age / p.life`. Затем:

- **flame / fireball**: `grow = 1 + (p.grow − 1) × (1 − (1 − t)²)`; `size = p.size0 × grow`;
  `p.scaleX = size × p.aspectX`, `p.scaleY = size × p.aspectY`; `p.h = p.rise × (1 − (1 − t)²)`;
  `view.rotation += p.spin × sec`; `view.tint = colorRamp(wreckFx.fire.ramp, t)`;
  `view.alpha = p.alpha × (1 − t²)`.
- **spark**: `p.scaleX = p.size0 (длина) × (1 − 0.5t)`, `p.scaleY = ширина`;
  `view.rotation = Math.atan2(p.vy, p.vx)`; `view.tint = lerpColor(colors[0], colors[1], t)`;
  `view.alpha = 1 − t`.
- **smoke**: `grow = 1 + (p.grow − 1) × (1 − (1 − t)³)`; масштабы как выше;
  `p.h = p.rise × (1 − (1 − t)²)`; `view.rotation += p.spin × sec`;
  `view.alpha = smokeAlpha(t, p.alpha)`; `tint` не меняется.
- В конце — непроецированный вид: `view.x = p.x; view.y = p.y; view.scaleX = p.scaleX;
view.scaleY = p.scaleY` (проекцию наложит `_render`; без камеры — например, в тестах — вид
  остаётся мировым).

`_stepFlash(dt)`: если `!this._flash.visible` — выход; `_flashAge += dt`;
`t = duration > 0 ? _flashAge / duration : 1`; при `t >= 1` → `visible = false`; иначе
`size = lerp(startSize, endSize, 1 − (1 − t)²) × _scale`, `scale.set(size × _fireUnit)`,
`alpha = flash.alpha × (1 − t)²`.

`_stepGlow(intensity)`: `visible = intensity > 0`; позиция `(_x, _y)` (едет за остовом);
`scale.set(glow.size × _scale × _fireUnit)`; `tint = glow.color`;
`alpha = glow.alpha × intensity × flicker(_seed, _elapsed, glow.flicker)`.

`_stepLight(intensity)`: нет `_light` → выход; `intensity <= 0` → `_removeLight()`; иначе
`updateLight(_light, { x, y, z: _z, level: _level, levels: lightLevels(_physLevel, _z, false),
intensity: wreckFire.intensity × intensity × flicker(_seed + 1, _elapsed, wreckFire.flicker) })`.

`_stepScorch(dt)`: нет копоти → выход; `_scorchAge += dt`;
`_scorchAlpha = scorch.alpha × (scorch.fadeIn > 0 ? clamp(_scorchAge / scorch.fadeIn, 0, 1) : 1)`.

## 4.6 `_render()` — проекция 2.5D (через `onRender`)

Позиции пишутся в `onRender`, а не в тикере: камера (трансформ сцены) к этому моменту
актуальна, и столб дыма не дрожит при движении камеры. Функция идемпотентна (движок может
рисовать несколько раз за тик).

```js
_render() {
  const camera = cameraCenter(this.parent, this._renderer);
  const shear = parallaxConfig.shear;

  if (this._active) {
    // как Smoke: контейнер в проекции высоты остова, частицы в мировых координатах
    const kHost = this._z * shear;
    applyParallax(this, camera, kHost, 1);

    if (this._levelView) {
      this.alpha = this._levelView.alphaFor(this._level, this._x, this._y, this._z);
      this.tint = this._levelView.tintFor(this._level);
    }

    // своя высота частицы: столб дыма клонится от центра камеры и растёт
    for (const channel of [this._fire, this._smoke]) {
      for (const p of channel.items) {
        const q = reproject(p.x, p.y, camera, kHost, kHost + p.h * shear);
        p.view.x = q.x; p.view.y = q.y;
        p.view.scaleX = p.scaleX * q.scale; p.view.scaleY = p.scaleY * q.scale;
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
      ? this._levelView.alphaFor(this._scorchLevel, this._scorchX, this._scorchY, this._scorchZ)
      : 1;
    this._scorch.alpha = this._scorchAlpha * see;
    if (this._levelView) { this._scorch.tint = this._levelView.tintFor(this._scorchLevel); }
  }
}
```

## 4.7 Завершение, сброс, уничтожение

- `_finish()` (дым прошёл): `_stopTicker()`; `_active = false`; `_flash/_glow.visible = false`;
  `_removeLight()`; `this.visible = false`; если копоти нет — `this.onRender = null` (копоть
  продолжает проецироваться своим `onRender` — одна `offsetPoint` за кадр).
- `_reset()` (респаун, повторная гибель, destroy): `_stopTicker()`; каналы `clear()` (если
  заведены); вспышку/отсвет спрятать; `_removeLight()`; звук — `releaseSound(_soundId)` (дать
  доиграть; повтор для уже снятого id — no-op) и `_soundId = null`; копоть —
  `this._scorch.destroy({ texture: false, textureSource: false })` (в PixiJS 8 `destroy` снимает
  с родителя), `_scorch = null`; `_active = false`; `visible = false`; `onRender = null`.
- `_stopTicker()`: `Ticker.shared.remove(listener)`, `_tickListener = null`.
- `_removeLight()`: `_lighting.removeLight(_light)`, `_light = null`.
- `destroy(options)`:

```js
destroy(options) {
  this._reset();
  // children: true после ...options и не переопределяется извне: иначе
  // уже возвращённые в пул частицы остались бы в живом контейнере (как Smoke)
  super.destroy({ texture: false, textureSource: false, ...options, children: true });
}
```

Текстуры общие (запечённые) — никогда не уничтожать их из парта.

## 4.8 Тест `tests/client/parts/WreckFire.test.js` (новый)

Каркас (по образцу `tests/client/parts/Smoke.test.js` и `ExplosionEffectController.test.js`):

```js
const assets = {
  wreckFireTexture: { texture: Texture.EMPTY, contentSize: 64 },
  wreckSmokeTexture: { texture: Texture.EMPTY, contentSize: 16 },
  wreckScorchTexture: { textures: [Texture.EMPTY, Texture.EMPTY], contentSize: 40 },
};
// полный ряд m1: [x, y, angle, gunRotation, vx, vy, engineLoad, condition,
//  size, team, angvel, z, level, vz, pitch, roll]
const row = ({ x = 100, y = 100, condition = 3, z = 0, level = 0, size = 3 } = {}) => [
  x,
  y,
  0,
  0,
  0,
  0,
  0,
  condition,
  size,
  1,
  0,
  z,
  level,
  0,
  0,
  0,
];
const makeDeps = () => ({
  renderer: { screen: { width: 800, height: 600 } },
  levelView: { alphaFor: () => 1, tintFor: () => 0xffffff },
  soundManager: { registerSound: vi.fn(() => 's1'), releaseSound: vi.fn() },
  lighting: {
    enabled: true,
    addLight: vi.fn(light => ({ ...light })),
    updateLight: vi.fn(),
    removeLight: vi.fn(),
    flash: vi.fn(),
  },
  blasts: { exploded: vi.fn() },
});
// парт на сцене (Container), созданные — в массив, afterEach → destroy() (снимает Ticker.shared)
// прокрутка времени — прямыми вызовами part._tick(100) в цикле
```

Случаи:

1. Живой танк: `part._onRender === null`, `part._active === false`, тикера нет.
2. Первый ряд уже с `condition 0`, затем ещё кадр с `0`: взрыва нет (`registerSound`,
   `blasts.exploded`, `lighting.flash` не вызывались), `_onRender === null`.
3. Переход `3 → 0`: `typeof part._onRender === 'function'` (регистрация — правило CLAUDE.md);
   `_fire.size >= fireball.count` (с искрами), `_smoke.size >= smoke.burst.count`;
   `registerSound('tankExplosion', { position: { x: 100, y: 100 } })`; `lighting.flash` с
   `level: 0, x: 100, y: 100`; `blasts.exploded({ x: 100, y: 100, radius: 18, level: 0 })`;
   `addLight` вызван один раз; копоть на сцене с `zIndex === levelZ(2, 0)`.
4. Пожар и затухание: в середине `fire.duration` канал пламени не пуст и `updateLight`
   зовётся с `intensity > 0`; после `fireEnd + fire.lifetime.max` канал пламени пуст и
   `removeLight` вызван.
5. Дым проходит: после `emissionEnd + smoke.lifetime.max` оба канала пусты,
   `_active === false`, `_tickListener === null`; с ассетом копоти `_onRender` остаётся
   функцией, без ассета копоти (отдельные `assets` без `wreckScorchTexture`) — `null`.
6. Потолки: за весь прогон `_fire.size <= maxFire`, `_smoke.size <= maxSmoke` на каждом шаге.
7. Респаун `0 → 3` посреди пожара: каналы пусты, `removeLight` вызван, `_onRender === null`,
   копоти на сцене нет, `releaseSound('s1')`; повторная гибель после респауна снова зажигает
   эффект (каналы переиспользуются, `_ensureViews` не создаёт вторые).
8. `destroy()` посреди пожара: то же, что в п. 7, + `part.destroyed === true`.
9. Высота частицы: сцена без трансформа → центр камеры `(400, 300)`; частице дыма вручную
   `p.h = 1`, `p.x = 100`, вызвать `part.onRender()` →
   `p.view.x ≈ 400 + (100 − 400) × (1 + parallax.shear)`.
10. Остов на плите (`level 1`, `z 1`): `zIndex === levelZ(4, 1)`, после `onRender`
    `part.scale.x ≈ 1 + parallax.shear`.
11. Эмиттер едет за остовом: `update(row({ condition: 0, x: 300 }))`, затем тик — новые языки
    пламени рождаются около `x = 300` (в пределах `length`); копоть осталась у `x = 100`.
12. `wreckFx.enabled = false` (мутировать и вернуть в `finally`) — переход ничего не делает.
13. Без сервисов (`dependencies = {}`) — эффект идёт без исключений.

> **Отклонение при реализации.** Поля `_rotation` и `_scale` из 4.1 названы `_heading` и
> `_sizeScale`: у `Container` в PixiJS 8 это внутренние поля трансформа, их перезапись ломала
> `scale.set` (падали тесты проекции).

> Общий контекст, факты из кода и решение — в [README.md](README.md).
