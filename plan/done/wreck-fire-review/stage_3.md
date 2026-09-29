# Этап 3. Спавнеры частиц: DRY, имена для чисел, мёртвые поля (Д1–Д4) ✅ выполнен

**Файл:** `src/client/parts/WreckFire.js`. Поведение не меняется: те же распределения и формулы. Защита —
существующие тесты и тесты этапов 1–2.

## 3.1. Именованные константы (Д2)

Константы модуля — в шапке рядом с `MAX_TICK_MS`/`TAU`, каждая с комментарием по-русски:

```js
// разброс формы клуба: растяжение по осям (доли) и скорость вращения, рад/с
const FIRE_ASPECT = { min: 0.8, max: 1.2 };
const FIRE_SPIN = 1;
const SMOKE_ASPECT = { min: 0.7, max: 1.3 };
const SMOKE_SPIN = 0.3;
// стихающий пожар мельчит языки: размер на нулевой силе — доля полного
const FLAME_MIN_SCALE = 0.6;
// языки сносит ветром вполсилы: живут меньше секунды
const FLAME_WIND_SHARE = 0.5;
// огненный шар рождается у центра корпуса с этим разбросом (доли корпуса)
const FIREBALL_SPREAD = 0.8;
// клубы облака взрыва живут короче и крупнее обычных
const BURST_LIFE_SCALE = 0.8;
const BURST_SIZE_SCALE = 1.3;
// искра к концу жизни укорачивается на эту долю
const SPARK_SHRINK = 0.5;
```

Заменить литералы:
- `0.6 + 0.4 * intensity` → `lerp(FLAME_MIN_SCALE, 1, intensity)`. Значение то же;
- `wind.x * 0.5` / `wind.y * 0.5` → `* FLAME_WIND_SHARE`;
- `randomRange(0.8, 1.2)` → `pick(FIRE_ASPECT)`;
- `randomRange(-1, 1)` → `randomRange(-FIRE_SPIN, FIRE_SPIN)`;
- `_hullPoint([[0, 0]], 0.8)` → `_hullPoint(CENTER, FIREBALL_SPREAD)`. Объявить `const CENTER = [[0, 0]];` в шапке,
  чтобы не создавать массив на каждый клуб;
- `burst ? 0.8 : 1` и `burst ? 1.3 : 1` → см. 3.3;
- `randomRange(0.7, 1.3)` → `pick(SMOKE_ASPECT)`;
- `randomRange(-0.3, 0.3)` → `randomRange(-SMOKE_SPIN, SMOKE_SPIN)`;
- в `_applyFire`, ветка искры: `1 - 0.5 * t` → `1 - SPARK_SHRINK * t`.

Перед заменой проверить, что `lerp` и `pick` уже импортированы или объявлены в модуле; `pick({ min, max })`
обязан давать то же распределение, что `randomRange(min, max)`.

## 3.2. Общий каркас состояния частицы (Д1)

Функция модуля под константами:

```js
// состояние частицы: у всех видов один набор полей — одна форма объекта
// для JIT; поля, которых у вида нет, нейтральные
const particleSim = fields => ({
  kind: 'flame',
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  windX: 0,
  windY: 0,
  drag: 0,
  h: 0,
  rise: 0,
  age: 0,
  life: 1,
  size0: 0,
  width: 0,
  grow: 1,
  aspectX: 1,
  aspectY: 1,
  spin: 0,
  alpha: 1,
  scaleX: 0,
  scaleY: 0,
  ...fields,
});
```

`ParticleChannel.spawn` дописывает `view`, одинаково для всех. В `_spawnFlame`, `_spawnFireball` и `_spawnSpark`
передавать в `this._fire.spawn(particleSim({ … }))` только поля, отличные от нейтральных:
- пламя: `kind`, `x`, `y`, `vx`, `vy`, `windX`, `windY`, `rise`, `life`, `size0`, `grow`, `aspectX`, `aspectY`,
  `spin`, `alpha`;
- огненный шар: то же плюс `drag`;
- искра: `kind`, `x`, `y`, `vx`, `vy`, `drag`, `life`, `size0`, `width`.

Поле `tint` удалить отовсюду: оно нигде не читается, цвет пишется прямо в `view.tint`.

## 3.3. Дым без булева флага (Д3)

`_spawnSmoke(heat, burst)` разделить на два тонких метода над общим `_emitSmoke`:
- `_emitSmoke({ heat, speed, lifeScale, sizeScale, alpha })`. Перенести сюда тело нынешнего `_spawnSmoke`,
  заменив ветвления по `burst` на параметры:
  - `speed` — сырая скорость из конфига, на `this._sizeScale` она умножается внутри `_emitSmoke`, как сейчас;
  - `life: pick(smoke.lifetime) * lifeScale`;
  - `size0: pick(smoke.size) * this._sizeScale * sizeScale * this._smokeUnit`;
  - `alpha` — как передан.

  Состояние собирать через `particleSim({ kind: 'smoke', … })`, без поля `tint`. Локальная `tint` остаётся и
  пишется в `p.view.tint`, как сейчас;
- `_spawnSmoke(heat)` → `this._emitSmoke({ heat, speed: randomRange(0, smoke.speed),
  lifeScale: 1, sizeScale: 1, alpha: lerp(smoke.tailAlpha, smoke.alpha, heat) })`;
- `_spawnBurstSmoke()` → `this._emitSmoke({ heat: 1, speed: pick(smoke.burst.speed),
  lifeScale: BURST_LIFE_SCALE, sizeScale: BURST_SIZE_SCALE, alpha: smoke.burst.alpha })`;
- вызовы: в `_explode` — `this._spawnBurstSmoke()`, в `_tick` — `this._spawnSmoke(intensity)`.

Сверить с нынешним телом: какие выражения зависят от `burst` (скорость, альфа, жизнь, размер) — ровно они и
становятся параметрами; порядок вызовов `randomRange`/`pick` не менять, чтобы тесты с подменённым `Math.random`
не разъехались.

## 3.4. Мёртвая запись вида (Д4)

Удалить метод `_writeView` (стр. 571–580) и его вызовы в конце `_applyFire` и `_applySmoke`. Единственный
писатель `view.x/y/scaleX/scaleY` — `_render`. Он зовётся как `onRender` перед каждым кадром, пока `_active`:
`onRender` назначается в `_ignite`, снимается только в `_finish`/`_reset`. Без камеры он пишет мировые
координаты, потому что `reproject` без камеры отдаёт `{ x, y, scale: 1 }`. `view.rotation`, `tint` и `alpha`
по-прежнему пишутся в `_applyFire`/`_applySmoke`: от проекции они не зависят. Над циклом по частицам в `_render`
добавить комментарий: «единственное место, где пишутся позиция и масштаб вида частицы».

**Проверить** до и после: тест «частица на высоте уезжает от центра камеры» вызывает `onRender`, значит не
сломается. `grep -n "p.view.x\|view.scaleX" tests/client/parts/WreckFire.test.js`: ни один тест не должен читать
позицию вида без `onRender()`. Если такой найдётся, добавить `part.onRender()` перед проверкой.

## Проверка этапа

`npx eslint . --quiet`, `npm test -- --silent`: зелёные, число тестов не меняется. Документация и CHANGELOG не
меняются (рефакторинг).

> Общий контекст, находки и правила — в [README.md](README.md).
