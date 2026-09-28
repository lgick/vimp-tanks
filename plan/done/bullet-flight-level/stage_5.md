# Этап 5. Клиент: пол под концом луча, грани и осколки воздушного попадания ✅ выполнен

Контекст — `plan/bullet-flight-level/README.md`, раздел «Модель», пункты 7–8. Этап требует этапов 1 (`ImpactEffect`
с `startK`, осколки в контроллере, `_debrisStartK`), 3 (`shot_levels::floor_under`, `shot_segments` отдаёт `fly`) и
4 (`endLevel` строки — уровень полёта).

## Как устроено сейчас (проверено по коду)

- `src/client/shotEvents.js`, `path(x0, y0, x1, y1, level)`, зовёт `segments(…)` — это ABI `core.shot_segments`.
  После этапа 3 третье число тройки — `fly`, и воздушный кусок трассера рисуется в проекции уровня полёта.
- `src/client/parts/effects/shot/tracerPieces.js` строит куски `[{ from, to, level }]`. Соседние куски одного
  уровня склеиваются, последний кусок берёт уровень конца строки (`W1_END_LEVEL`).
- `ShotEffectController`: контроллер, осколки и конец трассера стоят в проекции `endLevel`. Грань стены ищется по
  `this._volumes.heightAt(this.endLevel, …)`, грань насыпи — по `this._rampRuns.faceAt(this.endLevel, …)`,
  силуэт отвёрнутой грани — `kLine = (endLevel + volume)·shear`. Осколки ложатся на
  `rampRuns.heightAt(endLevel, x, y)` или на пол `endLevel`.
- Сервис `rampRuns` в `src/client/index.js` (≈ 138–162): `forLevel`, `heightAt`, `slopeAt`, `faceAt`.

**Что ломается при воздушном конце** (`endLevel` = уровень полёта, пол ниже): грань стены или насыпи ищется на
уровне полёта, где её нет, и конец рисуется без грани. Осколки, упавшие мимо рампы, висят на высоте моста. Нужен
**пол под точкой** — ядро его знает (`shot_levels::floor_under`).

## 5.1. Ядро клиента — `core/src/lib.rs`

Рядом с `shot_segments`, в том же `impl` и стиле:
```rust
/// Уровень пола под мировой точкой для пули, летящей на уровне `level`:
/// сам `level`, если там его плита (у земли — всегда), иначе уровень
/// приземления — то же правило, что у сегментов луча
/// (`shot_levels::floor_under`). По нему клиент ищет грань стены или
/// насыпи под пулей с моста и кладёт осколки её попадания на пол под ними.
/// Карты нет — `level`.
pub fn floor_level(&self, level: u8, x: f32, y: f32) -> u8 {
    let Some(levels) = self.state.game().levels() else {
        return level;
    };

    shot_levels::floor_under(levels, level, x, y)
}
```
Если `shot_levels` в `lib.rs` не импортирован под этим именем, писать путь, как у `shot_segments`. Затем
`npm run core:build`.

## 5.2. Сервис — `src/client/index.js`, объект `rampRuns`

После `faceAt`:
```js
// уровень пола под мировой точкой для пули уровня `level`
// (core.floor_level): у пули с моста над землёй пол ниже уровня конца —
// по нему ищется грань под пулей и ложатся осколки
floorAt(level, x, y) {
  return core.floor_level(level, x, y);
},
```
Комментарий над `rampRuns` в `services` (≈ 82) дополнить: «…и пол под концом выстрела (`floorAt`)».

## 5.3. Контроллер — `ShotEffectController.js`

1. Хелпер рядом с `_wallAt`:
   ```js
   // Уровень пола под мировой точкой для конца луча. `endLevel` — уровень
   // полёта пули: у пули с моста над землёй пол ниже (`rampRuns.floorAt`,
   // core.floor_level). Без сервиса — уровень конца, как раньше
   _floorAt(x, y) {
     const floor = this._rampRuns?.floorAt?.(this.endLevel, x, y);

     return Number.isInteger(floor) ? floor : this.endLevel;
   }
   ```
2. `_wallAt(nx, ny)` — грань ищется на полу под пулей, у результата есть поле `base`:
   - ветка `W1_HIT_EMBANKMENT_FACE`:
     ```js
     const ahead = 2 * WALL_EDGE_TOLERANCE;
     const base = this._floorAt(
       this.endPositionX + nx * ahead,
       this.endPositionY + ny * ahead,
     );
     const found = this._rampRuns?.faceAt?.(
       base,
       this.endPositionX,
       this.endPositionY,
       nx,
       ny,
       WALL_EDGE_TOLERANCE,
     );

     return found ? { ...found, base } : null;
     ```
   - ветка объёмов: точку за гранью (`probe`) вынести в переменные `px`/`py`, затем
     ```js
     const base = this._floorAt(px, py);
     const volume = this._volumes.heightAt(base, px, py);

     return volume > 0 ? { face, volume, base } : null;
     ```
   - комментарий метода дополнить: «…грань стоит на полу под пулей (`_floorAt`): у пули с моста — на земле.
     `base` — уровень этого пола».
3. `_wallEnd`: `const { face, volume, base } = this._wall;` и `kLine: (base + volume) * shear`. Конец на грани к
   камере остаётся `(this.endLevel + tracerConfig.height) * shear` — это высота пули. Комментарий поля
   `this._wall` в конструкторе: «`{ face, volume, base }`».
4. `_debrisSurface()` — поверхность под осколком с учётом пола под ним:
   ```js
   return (x, y) => {
     const floor = this._floorAt(x, y);
     const height = ramps.heightAt(floor, x, y);

     if (height !== null) {
       return height * shear;
     }

     // пол ниже уровня конца (пуля с моста над землёй): осколки на нём
     return floor < level ? floor * shear : null;
   };
   ```
   Комментарий метода дополнить: «…Пол под осколком — `_floorAt`: осколки попадания пули с моста падают на землю,
   а не висят на высоте моста».
5. `_debrisStartK()` — рождение на высоте нарисованного конца:
   ```js
   _debrisStartK() {
     const { shear } = parallaxConfig;

     if (this._wall) {
       return (this.endLevel + tracerConfig.height) * shear;
     }

     // склон: конец нарисован на склоне — осколки сразу на нём
     if (this.hitCode === W1_HIT_SLOPE) {
       return null;
     }

     // воздушное попадание (танк у верха рампы с моста): конец нарисован
     // на уровне полёта, пол под ним ниже — осколки падают на него
     return this._floorAt(this.endPositionX, this.endPositionY) < this.endLevel
       ? this.endLevel * shear
       : null;
   }
   ```
   Комментарий метода переписать по смыслу: «коэффициент высоты рождения осколков: у стены и грани насыпи —
   высота ствола; у воздушного попадания — уровень полёта; иначе null — сразу на поверхности».
6. Комментарий в конструкторе про уровень конца («…луч с моста идёт над плитой и падает за кромкой») заменить:
   «…луч с моста идёт над плитой и дальше на её высоте (воздушный сегмент ядра)».

## 5.4. `tracerPieces.js` и `shotEvents.js`

Кода не менять. Шапку `tracerPieces.js` переписать:
```js
// Куски трассера по уровням: сегменты луча из ядра (`shots.path`) →
// непересекающиеся отрезки `[{ from, to, level }]` от 0 до `total`.
//
// Сегменты (`core/src/shot_levels.rs`) идут встык, `level` сегмента — уровень
// ПОЛЁТА пули: луч с моста над землёй рисуется на высоте моста. Если
// сегменты перекрываются, выигрывает начатый раньше (луч продолжает свой
// уровень).
//
// Уровень конца — из строки трассера (`W1_END_LEVEL`): попадание судит хост,
// и осколки лежат там же. Рендер режет луч без наклона ствола (`shot_segments`
// не знает, что стрелок на склоне), поэтому, если последний кусок не совпал с
// уровнем конца, он получает уровень конца — от начала сегмента этого уровня,
// накрывающего конец, либо целиком.
// Без сегментов — один кусок на уровне конца, как было.
```
В `shotEvents.js` комментарий у `path` дополнить: «…`level` в элементах — уровень полёта сегмента».

## 5.5. Тесты

1. `tests/core/clientCore.test.js`, блок «слоёная карта»: новый тест «floor_level: пол под пулей». Без карты
   `client.floor_level(1, 352, 300) === 1`. На `layeredMap`: `floor_level(1, 352, 300) === 1` (плита),
   `floor_level(1, 450, 300) === 0` (за кромкой), `floor_level(1, 250, 304) === 0` (рампа), `floor_level(0, 100,
   100) === 0`.
2. `tests/client/tanksClientPlugin.test.js`, блок «ClientPlugin: сервис rampRuns»: в `makeRampCore` добавить
   `'floor_level': vi.fn(() => 0)`. Новый тест «floorAt спрашивает пол у ядра»: `rampRuns.floorAt(1, 96, 32) === 0`,
   `core.floor_level` вызван с `(1, 96, 32)`.
3. `tests/client/parts/effects/tracerPieces.test.js`: тест «воздушный сегмент того же уровня полёта — один
   кусок»: `tracerPieces([{ t0: 0, t1: 64, level: 1 }, { t0: 64, t1: 500, level: 1 }], 500, 1)` →
   `[{ from: 0, to: 500, level: 1 }]`. Тесты окна кромки остаются тестами перекрытия сегментов: в их названиях
   «окно кромки» заменить на «перекрытие сегментов», ожидания не менять.
4. `tests/client/parts/effects/ShotEffectController.test.js`, новый блок
   `describe('ShotEffectController: попадание пули с моста над нижним уровнем')`. Сцена и камера — как в блоке
   «попадание в грань стены» (`renderer`, сдвиг `stage.position.set(400 − camX, 300 − camY)`, `levelView` с
   `camera()`).
   - **«осколки рождаются на уровне полёта и падают на пол»**: строка `[300, 40, 150, 40, 300, 40, 1, 1, 1, 1]`
     (конец x = 150 над землёй, `endLevel` 1). `rampRuns = { ...makeRampRuns(), floorAt: vi.fn((level, x) =>
     (x < 200 ? 0 : level)) }` (рампа фикстуры — x 64..128, точка 150 вне её). После `run()` и
     `finishTracer`: `controller.impact._startK ≈ 1 * parallax.shear`. Затем `controller.impact._update(300)` и
     `controller.onRender()`: для осколка `p` — `controller.impact.x + p.sprite.x ≈ reproject(controller.impact.x
     + p.x, controller.impact.y + p.y, camera, parallax.shear, 0).x` (из проекции уровня 1 на пол 0);
   - **«попадание на плите — осколки сразу на поверхности»**: та же строка, `floorAt: vi.fn((level) => level)` →
     `controller.impact._startK === null`;
   - **«грань насыпи под пулей ищется на полу»**: прогон фикстуры `0 → 2`:
     `const steep = [{ axis: 0, sign: 1, from: 0, to: 2, min: 64, max: 128, crossMin: 16, crossMax: 80 }]`, сервис
     `{ heightAt: (l, x, y) => rampSurfaceAt(steep, l, x, y), slopeAt: …, faceAt: vi.fn((...a) =>
     rampFaceAt(steep, ...a)), floorAt: vi.fn(() => 0) }`. Строка `[112, 120, 112, 80, 112, 120,
     W1_HIT_EMBANKMENT_FACE, 1, 1, 1]` — выстрел на север в борт `y = 80` с уровня 1. Камера южнее борта (центр
     `(112, 200)`). После `run()`: `faceAt` вызван первым аргументом `0`, `controller._wall.base === 0`,
     `controller._wall.volume ≈ 1.5` (склон на x = 112 — `(112 − 64) / 64 · 2`), конец трассера ≈
     `reproject(112, 80, camera, 1 * parallax.shear, (1 + tracer.height) * parallax.shear).y`;
   - **«стена под пулей с моста ищется на полу»**: `volumes` из блока «попадание в грань стены» с
     `heightAt: vi.fn((level, x) => (level === 0 && x >= 96 && x < 128 ? 1.5 : 0))`, строка
     `[10, 40, 96, 40, 0, 0, 1, 1, 1, 1]`, `rampRuns = { ...makeRampRuns(), floorAt: vi.fn(() => 0) }`. После
     `run()`: `volumes.heightAt` вызван с уровнем `0`, `controller._wall.base === 0`. При камере за стеной (центр
     `(300, 40)`) конец трассера — `crossingDistance` с `kLine = (0 + 1.5) * parallax.shear`: проверить через
     `crossingDistance` из `src/client/wallFace.js` с теми же аргументами, что строит контроллер;
   - **«без floorAt — прежнее поведение»**: строки блоков «попадание в грань стены» и «выстрел в насыпь рампы» с
     сервисом без `floorAt` дают прежние ожидания (существующие тесты этих блоков зелёные без правок).
5. Команды: `npm run core:build`, `npx vitest run tests/client tests/core`, `npx eslint .`.

## Критерий готовности

- Тесты зелёные, eslint чистый.
- Этап отмечен «✅ выполнен» здесь и в `README.md`.
