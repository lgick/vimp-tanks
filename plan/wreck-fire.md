# План: взрыв, пожар и дым при гибели танка (парт `WreckFire`)

> **Где хранить.** По правилам пользователя план живёт в репозитории: `plan/wreck-fire.md`
> (один файл, без разбиения на файлы этапов). Выполненный этап помечается «✅ выполнен» рядом с
> заголовком. Когда все этапы выполнены — перенести файл в `plan/done/wreck-fire.md`
> (`git mv`, если файл уже в git, иначе обычный `mv`). **Коммиты не делать**: всё остаётся в
> рабочем дереве. Язык общения, комментариев в коде и плана — русский; `docs/en/*` и
> `CHANGELOG.md` — английский, `docs/ru/*` — русский.

## Контекст

Сейчас уничтожение танка почти не видно: корпус просто подменяется остовом, и над ним бесконечно
(до конца раунда) тлеет слабый дымок. Нужен эффект гибели: **взрыв → пожар, который через
некоторое время стихает → дым, который тоже со временем рассеивается**. Эффект должен выглядеть
реалистично и при этом почти не нагружать компьютер.

Согласовано с пользователем: все четыре дополнения входят в объём (звук взрыва, толчок
остова и соседей, копоть на земле, свет пожара ночью); общая длительность ≈ 30 с (огонь 9 с +
стихание 5 с + дым 15 с).

Ограничения задачи:

- Только клиентский рендер. Ядро (Rust, `core/`), хост, схема снапшота и протокол **не меняются**.
- Никаких runtime-фильтров (Blur/Displacement и т. п.) и новых аудиофайлов.
- Тряска камеры не добавляется: её ведёт ядро (`cameraShake` оружия), а ядро не трогаем.

## Как устроено сейчас (факты из кода — проверено)

- Строка танка `m1` — «горячая» (`src/config/snapshot.js`), поле `condition` — `u8` без
  интерполяции (дискретное): `3` цел, `2`/`1` повреждён, `0` уничтожен. Ядро ставит `0` в
  `Tank::take_damage` (`core/src/tank.rs`), а на новом раунде — `3` (`reset_vitals`). Остов
  остаётся в кадре до респауна: ряд `m1` у мёртвого танка продолжает приходить (его можно толкать
  взрывами, его несут поверхности).
- `gameSets.m1 = ['Tank', 'TankRadar', 'Smoke', 'Tracks', 'Dust']` (`src/config/client.js`):
  движок создаёт по экземпляру каждого парта на танк (`GameModel.create` →
  `new Part(data, assets, dependencies, { id })`), зовёт `update(data)` на каждый кадр и
  `destroy()` при удалении строки. Реестр партов — `src/client/parts/index.js`.
- `Tank.create()` (`src/client/parts/Tank.js`, ~1540 строк — **читать целиком не нужно, правки в
  нём не требуются**) при `condition === 0` показывает остов (обгоревший атлас модели, сбитая
  башня `WRECK_SKEW`), глушит двигатель и фары.
- `Smoke.js` для `condition === 0` даёт облачко-«burst» на переходе и **бесконечный** дым тления
  (30 частиц/с, размер 0.25) — именно его заменит новый эффект.
- Готовые кирпичи, которые переиспользуем:
  - `src/client/parts/ParticlePool.js` — пул `Particle` (контракт: сначала
    `container.removeParticle`, потом `release`).
  - `src/client/parts/Smoke.js`, `effects/explosion/SmokeEffect.js` — образец
    `ParticleContainer` + параллельного массива симуляции + пула; `Dust.js` — образец детектора
    перехода по данным ряда (приземление).
  - `src/client/parallax.js` — `applyParallax(target, camera, k, 1)`, `offsetPoint(x, y, camera, k)`,
    `reproject(x, y, camera, kHost, k)`; `src/client/camera.js` — `cameraCenter(parent, renderer)`;
    `src/client/levelZ.js` — `levelZ(base, level)`, `renderLevel(level, z)`.
  - `src/client/lighting/lightMath.js` — `flicker(seed, timeMs, strength)` (множитель в
    `[1 − strength, 1]`), `lightLevels(level, z, airborne)`.
  - Сервис `lighting` (`src/client/lighting/createLighting.js`): `enabled`, `addLight(light)` →
    handle, `updateLight(handle, patch)`, `removeLight(handle)`, `flash(options)` (no-op днём).
  - Сервис `blasts` (`src/client/blastEvents.js`): `exploded({ x, y, radius, level })` — каждый
    `Tank` сам решает, задел ли его взрыв (`src/client/blastJolt.js`). Взрыв ближе
    `underShare × длина корпуса` **подбрасывает** корпус (hop) с просадкой приземления — остов
    реагирует тоже (в `Tank._onBlast` нет проверки `condition`).
  - `soundManager`: `registerSound(name, { position })` → id (одноразовый звук сам
    снимается по окончании), `releaseSound(id)` — дать доиграть (так делает `Bomb.js`).
  - Бейкеры: `lightRadialTexture` (мягкое пятно, спад `(1 − t)²`, возвращает
    `{ texture, contentSize }`), `blurredCircleTexture` (`{ texture, contentSize }`),
    `scorchTexture` (`{ textures, contentSize }`). Движок отдаёт запечённый ассет только одному
    компоненту (`BakingProvider`), поэтому для нового парта заводятся **свои** записи в
    `bakedAssets` с теми же функциями-бейкерами (как `explosionTexture`/`smokeTexture` → один
    `blurredCircleTexture`).
- PixiJS 8.19: у `ParticleContainer` один режим смешивания на контейнер (`ParticleContainerPipe`
  берёт `container.groupBlendMode`) → пламя (additive) и дым (normal) — два контейнера.
  `onRender` — аксессор (`Container.onRender = fn | null`), вызывается и у невидимых контейнеров;
  `onRender = null` снимает регистрацию.

## Решение (обзор)

Новый парт **`WreckFire`** в `gameSets.m1`. Он получает тот же ряд, что и `Tank`, и сам
отслеживает переход `condition: >0 → 0` («погиб на глазах»). Пока танк жив — парт простаивает с
нулевой стоимостью (нет тикера, `onRender = null`, `visible = false`).

Таймлайн (значения по умолчанию, все — в `src/config/render.js → wreckFx`):

```
t = 0         ВЗРЫВ: вспышка (180 мс), огненный шар (~0.5–0.85 с), искры (~0.3–0.7 с),
              облако чёрного дыма, звук tankExplosion, ночная вспышка света,
              толчок через шину blasts (остов подпрыгивает, соседей качает), копоть на земле
0 … 9 с       ПОЖАР в полную силу: языки пламени из моторного отделения и погона башни,
              оранжевый отсвет, ночью — мерцающий тёплый свет; густой чёрный дым
9 … 14 с      пламя СТИХАЕТ: частота, размер языков, отсвет и свет → 0; дым светлеет
14 … 29 с     только ДЫМ: всё реже, светлее, прозрачнее → 0
≈ 33 с        последние клубы растворились: тикер снят, парт снова простаивает
до респауна   на земле остаётся копоть (1 спрайт)
```

Ключевые решения и почему:

1. **Только клиент, детектор перехода.** `condition` дискретный `u8`, переход приходит точно.
   Протокол не меняется; игрок, подключившийся позже, не увидит взрыва давно погибшего танка —
   это правильно (первый ряд уже с `0` → эффекта нет).
2. **Отдельный парт, а не `Smoke`/`ExplosionEffect`.** `ExplosionEffect` — эффект события `w2e`
   с обликом бомбы (голубой tint, воронка, радиус = радиус урона); `Smoke` — дым живого танка
   (повреждения, выхлоп). Свой парт = свой жизненный цикл и нулевая цена для живых танков.
3. **Два канала частиц**: пламя/огненный шар/искры — аддитивный `ParticleContainer`, дым —
   обычный. Мелкий общий помощник `ParticleChannel` (контейнер + массив симуляции + пул + потолок).
4. **Высота частиц в 2.5D.** У каждой частицы своя высота `h` (в уровнях): дым поднимается и
   рисуется через `reproject` — столб дыма «наклоняется» от центра камеры и растёт, как всё
   высокое в этой проекции (GTA 2). Цена — одна формула на частицу за кадр.
5. **Ночь.** Пламя остаётся ПОД картой освещённости (как дульная вспышка и осколки), но само
   светит: мерцающий `addLight` (`lighting.wreckFire`) + разовая `lighting.flash.wreck`. Перенос
   в эмиссивный слой не делаем — это потребовало бы отдельной проекции/прозрачности в чужом
   контейнере сервиса.
6. **Толчок — через существующую шину `blasts`.** `exploded({ x, y, radius: joltRadius, level })`
   в точке остова: остов подпрыгивает (взрыв «под корпусом» → hop), соседние танки качает.
   **Правок в `Tank.js` нет.**
7. **`Smoke.js` перестаёт дымить у остова** (`condition 0`): иначе дым шёл бы двойной и
   бесконечный, а по требованию он должен пройти.
8. **Копоть** — сиблинг на сцене с `zIndex = levelZ(2, level)` (как воронка `FunnelEffect`):
   под танком, над следами. Лежит в точке гибели, живёт до респауна.

### Бюджет производительности

- Живые частицы на один горящий остов: пламя ≈ `36/с × ≤0.65 с ≈ 23` + разово 14 (шар) + 12
  (искры) ≤ потолка `maxFire = 64`; дым ≈ `12/с × ≤4.2 с ≈ 50` + разово 12 ≤ `maxSmoke = 80`.
  Инвариант закрепляется тестом конфига.
- ≈ 4 draw call на горящий остов (отсвет, дым, пламя, вспышка); текстуры пекутся один раз на
  старте; фильтров нет.
- Живой танк: 0 тикеров, 0 `onRender`; остов после ≈ 33 с — только `onRender` копоти
  (одна `offsetPoint` за кадр).
- `deltaMs` зажат 100 мс (после переключения вкладки не рождается тысяча частиц); частицы из
  пула; потолки каналов — жёсткие.

---

## Этап 1. Конфиг

### 1.1 `src/config/render.js`

Добавить новый экспорт (после `blastJolt`, перед `tracer`; комментарии — по-русски, в стиле
файла):

```js
// Гибель танка (`src/client/parts/WreckFire.js`): взрыв, пожар и дым над
// остовом. Только рендер — ядро о них не знает. Время — мс, длины и
// скорости — мировые единицы (корпус m1 — 12 × 9), высота подъёма — уровни.
// Числа подобраны под танк размера `referenceSize`; у другого размера
// длины, скорости и радиусы масштабируются пропорционально
export const wreckFx = {
  // false — гибель без эффекта (остов просто появляется)
  enabled: true,

  // size m1 (src/data/models.js): под него подобраны числа ниже
  referenceSize: 3,

  // потолки живых частиц на один остов: канал пламени (шар, искры, языки)
  // и канал дыма. При упоре частица просто не рождается
  maxFire: 64,
  maxSmoke: 80,

  // общий снос дыма и пламени (мировых единиц в секунду): все столбы
  // дыма на карте клонятся в одну сторону
  wind: { x: 5, y: -3 },

  // визуальный толчок через шину `blasts`: остов подпрыгивает (взрыв под
  // корпусом), соседние танки в радиусе качает. 0 — без толчка
  joltRadius: 18,

  // звук взрыва (src/config/sounds.js); null — без звука
  sound: 'tankExplosion',

  // вспышка: один аддитивный спрайт, растёт и гаснет
  flash: { duration: 180, startSize: 12, endSize: 40, alpha: 1, color: 0xfff1c8 },

  // огненный шар: горящие клубы разлетаются из корпуса и тормозят
  fireball: {
    count: 14,
    speed: { min: 15, max: 50 },
    drag: 4, // 1/с
    size: { min: 4, max: 7 }, // стартовый диаметр
    grow: 2.2, // во сколько раз вырастает к концу жизни
    lifetime: { min: 450, max: 850 },
    rise: 0.5, // подъём за жизнь, уровни
    alpha: 0.95,
  },

  // искры: быстрые короткие штрихи, вытянутые по скорости
  sparks: {
    count: 12,
    speed: { min: 70, max: 160 },
    drag: 3,
    length: 2.4,
    width: 0.5,
    lifetime: { min: 300, max: 700 },
    colors: [0xffe6a8, 0xff6a1a], // цвет в начале и в конце жизни
  },

  // пламя: непрерывные языки из точек корпуса
  fire: {
    duration: 9000, // полная сила
    fadeOut: 5000, // затухание до нуля
    rate: 36, // частиц/с на полной силе
    // точки пожара в долях корпуса [вдоль курса, поперёк]: моторное
    // отделение (корма) и погон башни; spread — разброс в тех же долях
    points: [
      [-0.3, 0],
      [0.05, 0],
    ],
    spread: 0.4,
    size: { min: 2.5, max: 4.5 },
    grow: 1.6,
    lifetime: { min: 300, max: 650 },
    jitter: 4, // случайный боковой снос языка
    rise: 0.35,
    alpha: 0.85,
    // цвет по доле жизни частицы: [доля, цвет] — от почти белого ядра
    // через оранжевый к тёмно-красному (общий для пламени и огненного шара)
    ramp: [
      [0, 0xfff4c8],
      [0.2, 0xffc24a],
      [0.5, 0xf2661a],
      [0.8, 0x8c240a],
      [1, 0x240804],
    ],
  },

  // отсвет пламени: один аддитивный спрайт над остовом, дышит с пламенем
  glow: { size: 28, alpha: 0.3, color: 0xff8a30, flicker: 0.35 },

  // дым: пока горит — чёрный и густой, после пожара — светлее и реже
  smoke: {
    rate: 12, // частиц/с на полной силе пожара
    tailRate: 7, // частиц/с сразу после пожара, дальше спадает до 0
    tail: 15000, // сколько ещё дымит после пожара
    burst: { count: 12, speed: { min: 12, max: 30 }, alpha: 0.55 },
    size: { min: 3, max: 5 },
    grow: 3.8,
    lifetime: { min: 2600, max: 4200 },
    speed: 6, // начальный разброс скорости
    drag: 1.5, // 1/с: скорость частицы сходится к ветру
    rise: 1.4,
    alpha: 0.42, // пик прозрачности при пожаре
    tailAlpha: 0.2, // пик после пожара
    burning: [0x141210, 0x2a2622], // диапазон цвета при пожаре
    cooling: [0x4a4744, 0x625e5a], // диапазон цвета после
  },

  // копоть на земле в точке гибели; живёт до респауна
  scorch: { enabled: true, size: 26, alpha: 0.55, fadeIn: 400 },
};
```

В блок `lighting` (тот же файл):

```js
  flash: {
    explosion: { ... как было ... },
    shot: { ... как было ... },
    // гибель танка: ярче и дольше выстрела, теплее взрыва бомбы
    wreck: { radius: 150, intensity: 1.1, duration: 320, color: 0xffa050 },
  },

  // пожар остова (`WreckFire`): мерцающий тёплый свет, сила следует за
  // силой пламени и гаснет вместе с ним
  wreckFire: { radius: 70, intensity: 0.75, color: 0xff9040, flicker: 0.45 },
```

`wreckFx` в `src/config/client.js → parts` **не** добавлять (как `recoil`/`blastJolt`/`tracer`:
парт импортирует `render.js` напрямую).

### 1.2 `src/config/sounds.js`

В `sounds` (рядом с `explosion`):

```js
  // гибель танка (`WreckFire`): тот же файл, что у взрыва бомбы, тише —
  // рядом с остовом часто рвётся и сама бомба
  tankExplosion: { file: 'explosion', priority: 100, volume: 0.6 },
```

Прецедент переиспользования файла — `propBreak` (файл `hit`); новые ассеты не нужны.

### 1.3 Тест `tests/config/wreckFx.test.js` (новый)

- все длительности/скорости/размеры/потолки положительны; `fire.ramp` начинается с доли `0`,
  кончается `1`, доли возрастают;
- `wreckFx.referenceSize === models.m1.size` (`src/data/models.js`, default export);
- `sounds.sounds[wreckFx.sound]` существует (`src/config/sounds.js`, default export с полем
  `sounds`);
- бюджет не режет штатный режим:
  `fire.rate * fire.lifetime.max / 1000 + fireball.count + sparks.count <= maxFire` и
  `smoke.rate * smoke.lifetime.max / 1000 + smoke.burst.count <= maxSmoke`;
- `lighting.flash.wreck` и `lighting.wreckFire`: `radius > 0`, `intensity > 0`;
  `0 <= lighting.wreckFire.flicker <= 1`, `0 <= glow.flicker <= 1`.

---

## Этап 2. Чистые помощники (без PixiJS)

### 2.1 `src/client/colorRamp.js` (новый)

```js
// Цвета 0xRRGGBB: смешивание по каналам. Чистые функции, PixiJS не нужен

// a → b по доле t ∈ [0, 1] (t зажимается)
export function lerpColor(a, b, t) { /* по каналам R, G, B: Math.round(lerp) */ }

// градиент по опорным точкам `[[доля, цвет], ...]` (доли по возрастанию):
// до первой — первый цвет, после последней — последний
export function colorRamp(stops, t) { /* найти пару соседних опор, lerpColor */ }
```

Тест `tests/client/colorRamp.test.js`: `lerpColor(0x000000, 0xffffff, 0.5) === 0x808080`;
концы `0`/`1`; зажим `t < 0`, `t > 1`; `colorRamp` на опоре возвращает её цвет, между опорами —
смешивание, за краями — крайние цвета; одна опора — всегда её цвет.

### 2.2 `src/client/wreckTimeline.js` (новый)

Все функции берут секции конфига параметрами (тестируемость без моков):

```js
// Таймлайн пожара остова (src/client/parts/WreckFire.js): чистые функции
// времени с момента гибели, мс

// сила пламени: 1 всё `fire.duration`, затем линейно до 0 за `fire.fadeOut`
// (`fadeOut` 0 — гаснет сразу)
export function fireIntensity(elapsed, fire) {}

// конец пожара, мс
export function fireEnd(fire) { return fire.duration + fire.fadeOut; }

// частота дыма, частиц/с: пока горит — от `tailRate` до `rate` по силе
// пламени; после — от `tailRate` линейно до 0 за `smoke.tail`
export function smokeRate(elapsed, fire, smoke) {}

// когда перестаёт рождаться последняя частица
export function emissionEnd(fire, smoke) { return fireEnd(fire) + smoke.tail; }

// прозрачность клуба дыма по доле жизни t: проявление за первые 12 %,
// плато, угасание с 45 % до конца (форма SmokeEffect)
export function smokeAlpha(t, peak) {}
```

Защита от деления на ноль: `fadeOut`/`tail` `<= 0` → мгновенно (`!(x > 0)`).

Тест `tests/client/wreckTimeline.test.js`: `fireIntensity` = 1 при 0 и при `duration`, 0.5 в
середине затухания, 0 после `fireEnd`, `fadeOut: 0`; `smokeRate` = `rate` в начале, `tailRate` в
`fireEnd`, половина `tailRate` в середине хвоста, 0 после `emissionEnd`; `smokeAlpha` — 0 при
`t = 0`, `peak` на плато, 0 при `t = 1`.

---

## Этап 3. Канал частиц `src/client/parts/ParticleChannel.js` (новый)

```js
import { ParticleContainer, Rectangle } from 'pixi.js';
import ParticlePool from './ParticlePool.js';

// Канал частиц одного вида: ParticleContainer (одна текстура и один режим
// смешивания на контейнер), параллельный массив симуляции (у Particle нет
// customData) и общий пул. `max` — бюджет: при упоре spawn возвращает null
export default class ParticleChannel {
  constructor({ texture, max, blendMode = 'normal', padding }) {
    this.texture = texture;
    this.max = max;
    this.items = [];
    this._padding = padding;
    this.container = new ParticleContainer({
      texture,
      boundsArea: new Rectangle(-padding, -padding, padding * 2, padding * 2),
      dynamicProperties: { position: true, vertex: true, rotation: true, color: true },
    });
    this.container.blendMode = blendMode;
  }

  get size() { return this.items.length; }

  // область частиц едет за эмиттером (как boundsArea в Smoke.update)
  follow(x, y) { /* boundsArea.x = x - padding; boundsArea.y = y - padding */ }

  // sim — состояние частицы; view берётся из пула и добавляется в контейнер
  spawn(sim) {
    if (this.items.length >= this.max) { return null; }
    const view = ParticlePool.get(this.texture);
    sim.view = view;
    this.container.addParticle(view);
    this.items.push(sim);
    return sim;
  }

  // сначала из контейнера, потом в пул — контракт ParticlePool
  removeAt(index) { /* splice(index, 1); container.removeParticle(view); ParticlePool.release(view) */ }

  // всё в пул; контейнер остаётся пригодным для нового пожара
  clear() { /* container.removeParticles(); release каждой view; items.length = 0 */ }
}
```

Тест `tests/client/parts/ParticleChannel.test.js` (`Texture.EMPTY`): потолок `max` (spawn сверх —
`null`, `container.particleChildren.length === size`); `removeAt` убирает ровно одну и из
контейнера; `clear` обнуляет и контейнер, и `items`; `blendMode` применяется; `follow` двигает
`boundsArea`.

---

## Этап 4. Парт `src/client/parts/WreckFire.js` (новый)

### 4.1 Константы, импорты, состояние

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
import { parallax as parallaxConfig, wreckFx, lighting as lightingConfig } from '../../config/render.js';
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

### 4.2 `update(data)` — детектор перехода

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

### 4.3 `_ignite()` — взрыв

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
  this._soundId = this._soundManager.registerSound(wreckFx.sound, { position: { x: this._x, y: this._y } });
}
// ночь: вспышка на уровне остова (no-op днём)
this._lighting?.flash({ ...lightingConfig.flash.wreck, level: this._level, x: this._x, y: this._y, z: this._z });
// толчок: остов под «взрывом» подпрыгивает, соседи качаются (src/client/blastJolt.js)
if (wreckFx.joltRadius > 0) {
  this._blasts?.exploded({ x: this._x, y: this._y, radius: wreckFx.joltRadius * this._scale, level: this._physLevel });
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

### 4.4 Точка на корпусе и спавнеры

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

### 4.5 `_tick(deltaMs)` — симуляция (Ticker.shared)

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

### 4.6 `_render()` — проекция 2.5D (через `onRender`)

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

### 4.7 Завершение, сброс, уничтожение

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

### 4.8 Тест `tests/client/parts/WreckFire.test.js` (новый)

Каркас (по образцу `tests/client/parts/Smoke.test.js` и `ExplosionEffectController.test.js`):

```js
const assets = {
  wreckFireTexture: { texture: Texture.EMPTY, contentSize: 64 },
  wreckSmokeTexture: { texture: Texture.EMPTY, contentSize: 16 },
  wreckScorchTexture: { textures: [Texture.EMPTY, Texture.EMPTY], contentSize: 40 },
};
// полный ряд m1: [x, y, angle, gunRotation, vx, vy, engineLoad, condition,
//  size, team, angvel, z, level, vz, pitch, roll]
const row = ({ x = 100, y = 100, condition = 3, z = 0, level = 0, size = 3 } = {}) =>
  [x, y, 0, 0, 0, 0, 0, condition, size, 1, 0, z, level, 0, 0, 0];
const makeDeps = () => ({
  renderer: { screen: { width: 800, height: 600 } },
  levelView: { alphaFor: () => 1, tintFor: () => 0xffffff },
  soundManager: { registerSound: vi.fn(() => 's1'), releaseSound: vi.fn() },
  lighting: { enabled: true, addLight: vi.fn(light => ({ ...light })), updateLight: vi.fn(),
              removeLight: vi.fn(), flash: vi.fn() },
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

---

## Этап 5. Регистрация парта и ассетов

1. `src/client/parts/index.js`: `import WreckFire from './WreckFire.js';` и добавить в экспорт.
2. `src/client/bakers/index.js`: `wreckFireTexture: lightRadialTexture`,
   `wreckSmokeTexture: blurredCircleTexture`, `wreckScorchTexture: scorchTexture`; поправить
   комментарий «четыре ассета — один и тот же размытый круг» (станет пять).
3. `src/config/client.js`:
   - `gameSets.m1: ['Tank', 'TankRadar', 'Smoke', 'Tracks', 'Dust', 'WreckFire']`;
   - `entitiesOnCanvas.WreckFire: 'vimp'`;
   - `bakedAssets.vimp` — три записи `component: 'WreckFire'`:
     ```js
     {
       // гибель танка: мягкое пятно с ярким центром — вспышка, огненный шар,
       // языки пламени, искры и отсвет (аддитивно, цвет даёт tint)
       name: 'wreckFireTexture',
       component: 'WreckFire',
       params: { radius: 32, rings: 24, blur: 2 },
     },
     {
       // клубы дыма над остовом: размытый круг, белый — цвет даёт tint
       name: 'wreckSmokeTexture',
       component: 'WreckFire',
       params: { radius: 8, blur: 3, quality: 20, color: 0xffffff },
     },
     {
       // копоть под остовом: те же пятна, что у разрушенного пропа
       name: 'wreckScorchTexture',
       component: 'WreckFire',
       params: { baseRadius: 20, irregularity: 5, blur: 4, numPoints: 16,
         color: 0x15120f, coreColor: 0x060505, coreRatio: 0.5, variants: 3 },
     },
     ```
   - `componentDependencies`: добавить `'WreckFire'` в конец списков `renderer`,
     `soundManager`, `blasts`, `levelView`, `lighting`; поправить их комментарии
     (`blasts` — «эффект взрыва и гибель танка сообщают точку…»).
4. `tests/config/client.test.js`: дополнить ожидаемые массивы `levelView` и `renderer`
   (`'WreckFire'` в конце) и добавить случай: `gameSets.m1` содержит `'WreckFire'`,
   `entitiesOnCanvas.WreckFire === 'vimp'`, `deps.blasts/lighting/soundManager` содержат
   `'WreckFire'`, `clientPlugin.parts.WreckFire` определён, у `WreckFire` три запечённых ассета
   и для каждого имени есть бейкер в `src/client/bakers/index.js`.

---

## Этап 6. `src/client/parts/Smoke.js` — остов больше не дымит

- `SMOKE_CONFIG`: убрать ключи `0` из `particleStartSizeFactor`, `particleEndSizeFactor`,
  `particleSpawnRate` и строки комментариев про «0 (уничтожен) — тление».
- `_updateParticles`: убрать ветку `condition === 0` (остаётся `numStreams = 0`), комментарий:
  «уничтожен: дым остова ведёт WreckFire (src/client/parts/WreckFire.js)».
- `_triggerSmokeBurst`: убрать ветку `condition === 0`.
- `update`: облако только на переходе в повреждённое состояние —
  `if (this._condition !== prevCondition && (this._condition === 1 || this._condition === 2))`.
- `tests/client/parts/Smoke.test.js`: случай «уничтоженный танк выхлопа не даёт» →
  «уничтоженный танк не дымит вовсе: дым остова ведёт WreckFire» (`kinds.length === 0`);
  новый случай: переход `3 → 0` в `update` не рождает облака (`_particles.length === 0`).

---

## Этап 7. Документация и журнал изменений

Каждая правка — в `docs/en/*` и зеркально в `docs/ru/*` (одинаковая структура).

- `gameplay.md` → «Weapons and the tank», абзац «Health is 100…»: уничтоженный танк взрывается
  (вспышка, огненный шар, искры, клуб чёрного дыма, свой звук; остов подпрыгивает, соседние
  танки качает — только визуально), горит ~9 с, пламя стихает к ~14 с, светлеющий дым
  рассеивается к ~30 с; ночью пожар мерцающе освещает округу; копоть на земле до конца раунда.
  Ссылка на `configuration.md` (`wreckFx`).
- `configuration.md`:
  - сниппет `gameSets` (m1 + `WreckFire`) и фраза «plus smoke, tank tracks and dust» → «…, dust
    and the wreck fire»;
  - абзац `bakedAssets`: `wreckFireTexture` (`lightRadialTexture`), `wreckSmokeTexture`
    (`blurredCircleTexture`), `wreckScorchTexture` (`scorchTexture`) — компонент `WreckFire`;
  - список `componentDependencies` (`renderer`, `soundManager`, `levelView`, `lighting`, `blasts`);
  - новый подраздел `### Wreck fire: wreckFx` (после таблиц 2.5D-рендера, рядом с `blastJolt`) —
    таблица ключей: `enabled`, `referenceSize`, `maxFire`/`maxSmoke`, `wind`, `joltRadius`,
    `sound`, `flash`, `fireball`, `sparks`, `fire` (включая `points`, `spread`, `ramp`), `glow`,
    `smoke` (включая `burst`, `tail`, `burning`/`cooling`), `scorch`; плюс таймлайн по
    умолчанию и бюджет частиц;
  - таблица `blastJolt`, строка `enabled`: реакция и на гибель танка (`wreckFx.joltRadius`);
  - таблица `lighting`: `flash.explosion`, `flash.shot`, `flash.wreck`; новая строка
    `wreckFire` (`radius`, `intensity`, `color`, `flicker`); вводный абзац раздела — «…the
    flashes of `ExplosionEffect`, `ShotEffect` and `WreckFire`»;
  - раздел `sounds.js`: абзац про `tankExplosion` (регистрирует парт `WreckFire`, файл
    `explosion`, тише взрыва бомбы).
- `architecture.md`:
  - абзац о шине `blasts`: её будит и `WreckFire` при гибели танка;
  - «Draw order across levels»: базовые значения + «`WreckFire` 4 (its scorch 2)»;
  - «Lighting (night)» → «Sources»: мерцающий свет пожара и вспышка гибели от `WreckFire`;
  - «Particle systems»: `WreckFire` — два `ParticleChannel` (`parts/ParticleChannel.js`:
    аддитивное пламя и обычный дым), своя высота частицы `h` через `reproject`.
- `extending.md` → «New client entity (part)», абзац о частицах: паттерн
  `Smoke`/`SmokeEffect`/`WreckFire`, для нескольких каналов — `ParticleChannel`.
- `CHANGELOG.md` → `## [Unreleased]` (английский, без тестов/доков/рефакторинга):

  ```md
  ### Added

  - A destroyed tank now explodes: a flash, a fireball, sparks and a burst of
    black smoke, with its own explosion sound; the wreck is tossed up and nearby
    tanks rock. The wreck then burns, the fire dies down after about 14 seconds,
    and the thinning smoke clears about 15 seconds later. At night the fire lights
    its surroundings with a flickering glow. A scorch mark stays on the ground
    until the next round.

  ### Changed

  - A wreck no longer smokes endlessly: its smoke comes from the fire and clears
    on its own.
  ```

- Проектный `CLAUDE.md` не меняется (ни команд, ни зависимостей не добавилось).

---

## Этап 8. Проверка

1. Форматирование изменённых JS/MD по `~/.prettierrc.mjs` (semi, singleQuote, trailingComma
   `all`, printWidth 80, arrowParens `avoid`; для `*.md` — printWidth 100, proseWrap `preserve`).
   Prettier в проекте не установлен: `npx --yes prettier@3 --config ~/.prettierrc.mjs --write
   <файлы> --log-level warn` (если сети нет — форматировать вручную по этим правилам).
2. `npx eslint . --quiet` — зелёный.
3. `npm test -- --silent` — зелёный (проекты `tanks` и `integration`).
4. `npm run build` (нужен `core/pkg-web/`; нет — `npm run core:build:web`), вывод не раздувать.
   Проверить, что в `dist/manifest.json`/сборке нет ошибок контракта.
5. `npm run sim -- --scenario tests/scenarios/combat.json` — раннер проверяет `gameSets` и
   `entitiesOnCanvas` (новый парт должен быть на полотне).
6. Ручная проверка в `npm run dev` (в браузере):
   - добавить ботов (чат-команда `/bot`, см. `docs/en/gameplay.md` → Chat), убить танк:
     вспышка → огненный шар и искры → пламя ~9 с → стихание → светлеющий дым → чисто к ~30 с;
     копоть остаётся; остов подпрыгнул, соседний танк качнуло;
   - ночная карта `downtown`: вспышка освещает округу, пожар мерцает и гаснет вместе с пламенем;
   - остов на мосту/плите (`overpass`): эффект на слое плиты, столб дыма клонится от центра
     камеры, при проезде игрока под плитой — прозрачность как у остального;
   - новый раунд посреди пожара: всё гаснет мгновенно, копоть исчезает;
   - убить сразу много танков (конец раунда): в DevTools → Performance FPS не проседает,
     число draw calls растёт примерно на 4 на горящий остов;
   - подключиться вторым клиентом к матчу с уже стоящим остовом — взрыва нет.

## Известные ограничения (осознанно)

- Новый раунд обрывает пожар сразу (карта восстанавливается) — последний погибший раунда
  горит лишь до рестарта.
- Игрок вышел из игры → строка `m1` удалена → парт уничтожен → эффект исчезает вместе с остовом.
- После потери WebGL-контекста движок пересоздаёт парты: уже горящий остов перестанет гореть
  (как у поздно подключившегося).
- Убийство бомбой даёт два взрыва на слух (бомба + танк) — намеренно, `tankExplosion` тише.

## Затрагиваемые файлы (сводка)

Новые: `src/client/parts/WreckFire.js`, `src/client/parts/ParticleChannel.js`,
`src/client/wreckTimeline.js`, `src/client/colorRamp.js`,
`tests/client/parts/WreckFire.test.js`, `tests/client/parts/ParticleChannel.test.js`,
`tests/client/wreckTimeline.test.js`, `tests/client/colorRamp.test.js`,
`tests/config/wreckFx.test.js`.

Изменяемые: `src/config/render.js`, `src/config/sounds.js`, `src/config/client.js`,
`src/client/parts/index.js`, `src/client/bakers/index.js`, `src/client/parts/Smoke.js`,
`tests/client/parts/Smoke.test.js`, `tests/config/client.test.js`, `CHANGELOG.md`,
`docs/{en,ru}/gameplay.md`, `docs/{en,ru}/configuration.md`, `docs/{en,ru}/architecture.md`,
`docs/{en,ru}/extending.md`.

Не трогаем: `core/**`, `src/host/**`, `src/config/snapshot.js`, `src/client/parts/Tank.js`.
