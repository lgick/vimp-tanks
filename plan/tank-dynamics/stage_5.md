# Этап 5. Клиент: дым выхлопа, буксование, пыль приземления

Требует этап 3 (`vz` в кадре) и этап 4 (колбэк приземления в `Tank.js`).

Цель: газ должен быть виден. Чем сильнее газует танк — тем гуще выхлоп;
упёршись в стену — буксует и поднимает пыль из-под гусениц; приземление
выбивает пыль и даёт звук. Всё пропорционально размеру танка.

Файлы: `src/client/parts/Smoke.js`, `src/client/parts/Dust.js` (новый),
`src/client/parts/index.js`, `src/config/client.js`, `src/config/render.js`,
`src/config/sounds.js`, `src/config/game.js`, `tests/client/parts/`.

## Что уже есть и что переиспользуется

- `engineLoad` (`M1_ENGINE_LOAD`) — готовый сигнал: `0` холостой, `~1`
  полный ход, `> 1` напряжение (газ в стену). Порог `> 1.0` уже
  используется как «буксует» в `Tracks.js` (`if (this._engineLoad > 1.0)`)
  и в звуке (`STRAIN_ENGINE_RATE`, `Tank.js`).
- `ParticlePool` (`src/client/parts/ParticlePool.js`) — пул `Particle`;
  `get(texture)` / `release(particle)`, снимать из контейнера
  (`removeParticle`) обязан вызывающий.
- `Smoke.js` — готовый долгоживущий эмиттер на танк: `ParticleContainer` с
  `boundsArea`, ручная подписка на `Ticker.shared`, `onRender` с
  `applyParallax` и `levelView`, пропорция по размеру танка
  (`_particleScaleMultiplier = Math.max(0.5, Math.sqrt(w·h·0.001))`,
  `Smoke.js:104`), точка выхлопа за кормой (`offsetBack = _height · 0.22`,
  `:373`).
- `blurredCircleTexture` (`src/client/bakers/blurredCircleTexture.js`) —
  один бейкер, из которого уже сделаны три ассета разными `params`.
  Новую текстуру пыли заводить кодом не нужно, только записью в
  `bakedAssets`.
- `Tracks.js` — геометрия точек контакта гусениц:
  `_trackOffset = (size·3 / 2) · 0.7`, `_backwardOffset = size·3 · 0.4`,
  точки считаются как `cos/sin(rotation ± π/2)`.

## 5.1. Выхлоп по газу — в `Smoke.js`

Сейчас `_updateParticles` (`:220`) выбирает `numStreams`/`spawnRate`
только по `_condition`. Добавить второй, независимый канал.

`SMOKE_CONFIG` — новый блок:

```js
// выхлоп по газу: канал, независимый от дыма повреждений
exhaust: {
  // частиц в секунду при полном газе
  spawnRate: 45,
  // частиц в секунду при холостом ходе (лёгкое дрожание над трубой)
  idleSpawnRate: 4,
  // ниже этой нагрузки выхлопа нет вовсе
  minLoad: 0.05,
  // размер относительно дыма повреждений
  startSizeFactor: 0.6,
  endSizeFactor: 1.6,
  startAlpha: 0.05,
  color: 0x555555,
  lifetime: { min: 350, max: 750 },
},
```

В `_updateParticles`:

```js
// канал выхлопа: интенсивность — это газ, а не повреждения. `min(load, 1)`
// отсекает «напряжение» (> 1): упёршийся в стену танк дымит не сильнее,
// чем едущий на полном газу, — за упор отвечает пыль из-под гусениц
const gas = Math.min(this._engineLoad, 1);
const exhaustRate = gas < SMOKE_CONFIG.exhaust.minLoad
  ? 0
  : lerp(
      SMOKE_CONFIG.exhaust.idleSpawnRate,
      SMOKE_CONFIG.exhaust.spawnRate,
      gas,
    );
```

Отдельный аккумулятор `this._timeSinceExhaust` и отдельный цикл спавна,
рядом с существующим. `spawnParticle` получает третий режим: расширить
сигнатуру до `spawnParticle(streamIndex, numStreams, kind)`, где `kind` —
`'damage' | 'burst' | 'exhaust'`, и выбирать по нему таблицу размеров,
альфы, цвета и времени жизни. Точка спавна и начальные скорости у выхлопа
те же, что у дыма повреждений (та же труба) — код `:364-380` не трогать.

Пропорция размеру танка уже обеспечена `_particleScaleMultiplier`;
множители выхлопа применяются поверх него, как у существующих каналов
(`:309`, `:413`).

Уничтоженный танк (`_condition === 0`) выхлопа не даёт: газа нет. Условие —
`this._condition > 0`.

## 5.2. Буксование и пыль приземления — новая часть `Dust.js`

Отдельная часть, а не канал внутри `Smoke.js`, потому что:
пыль живёт **на земле** (базовый zIndex у следов гусениц), а дым — над
танком; у пыли своя текстура, свой цвет и своя геометрия (две точки
контакта, не труба).

`src/client/parts/Dust.js`, по образцу `Smoke.js`:

```js
const DUST_BASE_Z = 2;   // над следами гусениц (1), под танком (3)
```

Читает: `M1_X, M1_Y, M1_ANGLE, M1_VX, M1_VY, M1_ENGINE_LOAD, M1_SIZE,
M1_CONDITION, M1_Z, M1_LEVEL, M1_VZ`.

Структура повторяет `Smoke.js`: `ParticleContainer` с
`dynamicProperties: { position, vertex, rotation, color }`, `boundsArea`
с отступом, ручная подписка на `Ticker.shared`, `onRender` с
`levelView.alphaFor/tintFor` и `applyParallax(this, camera, z · shear, 1)`,
`destroy()` возвращает частицы в `ParticlePool`.

Два триггера:

**а) Буксование.** В `_updateParticles`:

```js
// упор в стену: газ есть, а танк не едет. `engineLoad > 1` — тот же
// порог «напряжения», по которому Tracks.js штампует следы, а Tank.js
// поднимает высоту тона двигателя
const strain = Math.max(0, this._engineLoad - 1);
const speed = Math.hypot(this._vx, this._vy);
const spinning = strain > 0 && speed < DUST_CONFIG.maxSpinSpeed;
const rate = spinning ? DUST_CONFIG.spawnRate * Math.min(strain, 1) : 0;
```

Спавн — по двум точкам контакта гусениц, геометрия скопирована из
`Tracks.createTrackMarksAtPreviousPosition()`
(`_trackOffset`, `_backwardOffset`, `cos/sin(rotation ± π/2)`). Начальная
скорость частицы — **назад** вдоль корпуса (гусеница выбрасывает грунт
против направления тяги) плюс случайный разброс.

**б) Приземление.** Всплеск из `DUST_CONFIG.landingBurst` частиц по обеим
точкам контакта, радиально наружу, с размером и количеством, умноженными
на силу удара (0..1). Триггер — тот же детектор, что в `Tank.js`
(этап 4, 4.3в): `_prevVz < -landing.minImpact && _vz === 0`. Детектор
повторяется в `Dust.js` самостоятельно (обе части получают один и тот же
ряд снапшота, связывать их через колбэк не нужно — это дешевле и не
создаёт зависимости между частями).

Пропорция размеру: `_particleScaleMultiplier` — та же формула, что в
`Smoke.js:104`.

`DUST_CONFIG` держать в самом `Dust.js` (как `SMOKE_CONFIG` в `Smoke.js`);
в `src/config/render.js` выносить только то, что делит с другими частями —
здесь ничего.

## 5.3. Регистрация части

1. `src/client/parts/index.js` — импорт и запись `Dust` в объект экспорта.
2. `src/config/client.js`:
   - `parts.gameSets.m1` → `['Tank', 'TankRadar', 'Smoke', 'Tracks', 'Dust']`;
   - `parts.entitiesOnCanvas.Dust = 'vimp'`;
   - `parts.componentDependencies` — добавить `Dust` в массивы `renderer`
     и `levelView` (проекция высоты и see-through), и в `soundManager`,
     если звук приземления живёт здесь (см. 5.4);
   - `parts.bakedAssets.vimp` — новый ассет на существующем бейкере:

     ```js
     {
       name: 'dustTexture',
       component: 'Dust',
       params: {
         radius: 4,
         blur: 1,
         quality: 20,
         color: 0xffffff, // белый, красится tint'ом под цвет карты
       },
     },
     ```

## 5.4. Звук приземления

1. `src/config/sounds.js` — запись рядом с существующими:

   ```js
   tankLanding: { file: 'tank-landing', priority: 60, volume: 0.7 },
   ```

   Файлы `assets/sounds/tank-landing.{webm,mp3}` (`codecList` в том же
   файле) — если исходника нет, завести задачу отдельно; код обязан
   переживать отсутствие ассета без исключения (звук просто не
   проигрывается).

2. Проигрывание — в `Dust.js`, там же, где детектируется приземление:
   `this._soundManager?.registerSound('tankLanding', { position: { x, y }, spatial: true })`,
   громкость домножить на силу удара. Мягкое касание
   (`|vz| < landing.minImpact`) звука не даёт.

   Альтернатива — событие ядра + `soundCues` в `src/config/game.js:24-30`.
   Она хуже: `LevelEvent::Landed` есть только у хоста, а звук нужен на
   каждом клиенте и для каждого танка; клиентский детектор по `vz`
   работает одинаково для всех. Через `soundCues` идти не нужно.

## 5.5. Тряска камеры (опционально)

Проверить, есть ли у клиентского ядра публичный вызов тряски: в
`src/data/weapons.js` у оружия есть `cameraShake: {intensity, duration}`,
и его обрабатывает движок по событию выстрела/взрыва. Если аналогичный
вызов доступен части напрямую — дёрнуть его при жёстком приземлении
своего танка (`localPlayer`) с `intensity ∝ landImpact`. Если публичного
API нет — **пропустить**, не изобретая обходной путь.

## 5.6. Тесты этапа

`tests/client/parts/Smoke.test.js` (существующий):

1. `целый танк на газу дымит из трубы` — `condition: 3`, `engineLoad: 1`,
   прогон тикера → частицы появились (сегодня при `condition === 3`
   частиц нет вовсе).
2. `на холостом ходу выхлоп реже` — число частиц за 1 с при
   `engineLoad: 0.1` строго меньше, чем при `engineLoad: 1`.
3. `уничтоженный танк выхлопа не даёт` — `condition: 0` даёт только
   прежний канал повреждений (проверять по `kind` спавна или по счётчику).
4. `дым пропорционален размеру` — при `size: 4` начальный размер частицы
   больше, чем при `size: 2`.

`tests/client/parts/Dust.test.js` (новый):

5. `регистрирует колбэк onRender` (`typeof dust._onRender === 'function'`)
   и `без levelView колбэка нет` (`dust._onRender === null`) — правило
   проекта, зафиксированное в `tests/client/parts/Tracks.test.js`.
6. `буксование поднимает пыль` — `engineLoad: 1.6`, `vx/vy ≈ 0` → частицы
   есть; `engineLoad: 1.0` → частиц нет.
7. `едущий танк не буксует` — `engineLoad: 1.6` при большой скорости →
   частиц нет.
8. `приземление даёт всплеск` — ряд `vz: -8`, затем `vz: 0` → число
   частиц скачком выросло; при `vz: -0.5` → не выросло.
9. `приземление зовёт звук` — мок `soundManager` получил
   `registerSound('tankLanding', ...)` ровно один раз.
10. `destroy возвращает частицы в пул` — по образцу существующего теста
    `Smoke`.

## Готовность этапа

- [ ] `npx eslint .`, `npm test` зелёные
- [ ] Ручная проверка: `npm run dev`, упереться в стену на полном газу —
      идёт пыль из-под гусениц и густой выхлоп; отпустить газ — выхлоп
      спадает до дрожания
