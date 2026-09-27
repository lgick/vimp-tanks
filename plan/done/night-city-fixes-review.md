# План: исправления по код-ревью задачи `night-city-fixes`

## Контекст

Ревью охватывает всю задачу `plan/done/night-city-fixes.md` (14 этапов) в репозитории `vimp-tanks`
(`/Users/dmitry/Sites/my/vimp-tanks`): коммиты a80573d, e7312c2, 0f3de75, b7141b4, 1c65833, 7f71abb (только
части этой задачи), 2dd43f9, bb767f8, b4ea92b, efae406 (этапы 12–14) и b85943e (первое ревью). Код tank-3d /
tank-volume, лежащий в тех же коммитах, в ревью не входит. Смотрелось текущее состояние файлов на HEAD
(`435941c`), то есть уже с учётом задач `crash` и `client-reports`, сделанных после.

Движок за время задачи менялся (`7c38ae75`/`be761c8d` — детектор рассинхрона в devtools, `b51c8b6a` — порог
обусловленности блока 2×2 в `rigid_body.rs`). Это отдельные задачи движка со своими планами
(`../vimp/plan/done/divergence-*.md`), в этот план они не входят.

Базовая линия на момент ревью: `npx eslint .` — чисто, `npx vitest run` — 870/870 зелёные.

Критических ошибок (падений, порчи данных, рассинхрона хоста и реплики) не найдено. Найдено 4 проблемы средней
важности (одна по производительности, две скрытые ошибки логики, одна в документации: она учит паттерну, который
возвращает исправленный баг) и набор мелких замечаний по DRY, читаемости, тестам и производительности.

### Сводка находок

| # | Важность | Критерий | Суть | Этап |
| --- | --- | --- | --- | --- |
| M1 | средняя | производительность | Пока открыта дыра see-through, карта освещённости верхнего уровня рисуется в полном разрешении, а не в `lighting.resolution` (0.5). На `downtown` это почти всё время: игрок на земле | 1 |
| M2 | средняя | работоспособность, поддерживаемость | У прозрачности неоновых вывесок два автора: `NeonSign.update` (учитывает `roofAlpha`) и `createLighting.updateEmissive` (перезаписывает её через `alphaFor`). Правильный результат держится только на порядке вызовов. Документация устарела | 2 |
| L1 | низкая | работоспособность | В режиме `seeThrough.mode = 'layer'` вывеска на крыше не гаснет вместе с крышей (`roofAlpha` берётся из силы дыры, а в этом режиме она всегда 0). Кроме того, `roofAlpha` считается до `updateSeeThrough`, то есть отстаёт на кадр | 2 |
| M3 | средняя | работоспособность | Если уровень состоит только из крыш (`game.roofs`), весь его свет (фонари, вывески, фары, лучи) молча отбрасывается: раскладка проверяет только `map.levels`, а не `map.roofLevels` | 3 |
| M4 | средняя | документированность | `docs/*/extending.md` требует `filter.padding = blurMargin(blur)`, хотя после этапа 5 правило — `blurPadding(blur)` (вдвое больше). Новый баркер по этой инструкции вернёт «квадрат вокруг воронки» | 4 |
| L3 | низкая | DRY, ресурсы | Один и тот же код выпечки с размытием (`BlurFilter` + `padding` + `generateTexture`) повторён в 9 баркерах. `BlurFilter` после выпечки ни в одном из них не освобождается | 4 |
| L4 | низкая | DRY | Кривые спада света продублированы: у конуса `(1 − t)(1 − 0.35t)` — в `headlightConeTexture` и `lightMath.lightStrength`, у пятна `(1 − t)²` — в `lightRadialTexture` и `lightMath.radialFalloff`. Если поправить одну копию, засветы молча разойдутся с картинкой | 5 |
| L5 | низкая | DRY, производительность | Засвет (glint) почти дословно повторён в `Tank` и `MapObject`. Массив `exclude` своих фар создаётся каждый кадр. `setCaster` вызывается каждый кадр с новым объектом, в том числе днём | 6 |
| L2 | низкая | читаемость, DRY | Логика «сглаживание дыры раз на тик» написана дважды, и одноимённая переменная `stepped` в двух местах значит противоположное (`layerSeeThrough.js:48` — «уже шагали», `createLighting.js:1554` — «новый тик») | 7 |
| L6 | низкая | тестируемость | Два дубля конфига (`surfaceFx.tracks.oil.trail` ↔ `slickTime`, `surfaceFx.boost.boostMinSpeed` ↔ `minEntrySpeed`) связаны только комментариями. Поле `game.roofs` не проверяет ни один тест или валидатор: только `console.warn` в рантайме | 8 |
| L7 | низкая | читаемость, надёжность | Ядро: чтобы в полёте только уменьшить остаток масла, `apply_slick` вызывается с фиктивным `SurfaceMix::NEUTRAL` и 9 аргументами (на хосте и в реплике); индекс `slick_type` из состояния без проверки границ; устаревший комментарий в тесте | 9 |
| L8 | низкая | производительность, масштабируемость | Грани объёмов (~1700 квадов) и клинья рамп пересчитывают и перезаливают вершины каждый кадр, даже когда камера стоит. Окклюзия фары прогоняет 64+ луча даже там, где рядом нет ни стены, ни горки | 10 |
| L9 | низкая | читаемость, документированность | `createLighting.js`: описание сервиса стоит над `lightArea`, два комментария слиплись в один, `bounces` объявлен после замыкания, которое его использует. `TracerEffect`: мёртвый алиас `this.graphics`, в `ShotEffectController` конфиг передаётся как `undefined` | 11 |
| L10 | низкая | поддерживаемость | `createLighting.js` вырос до 1581 строки (маски, препятствия и окклюзия, раскладка, лучи, дыры, эмиссив, засветы) | 12 (необязательный) |
| M5 | средняя | работоспособность (видимая ошибка) | Кирпич на гранях зданий «утекает в землю», когда камера приближается к стене, и «вырастает из земли», когда отдаляется: UV грани пересчитываются каждый кадр так, что кирпич держит постоянный экранный размер, а ряды прибавляются и убавляются у основания. В GTA 2 текстура привязана к стене и искажается вместе с ней. Найдено пользователем после ревью | 13 |
| M6 | средняя | работоспособность (видимая ошибка) | Фары, направленные на стену, не освещают её, а светят «под неё»: веер света обрывается на подножии стены (след клетки на полу), а видимая грань над подножием остаётся тёмной. Найдено пользователем | 14 |
| M7 | средняя | работоспособность (видимая ошибка) | Выстрел в стену попадает «под неё». Трассер кончается на подножии, и половину искр закрывает грань. Ночью при камере за стеной трассер рисуется поверх крыши до её подножия. На ходу `TracerEffect.shiftTo` уводит конец луча внутрь стены на длину пройденного танком пути (до ~21 ед.). Найдено пользователем | 14 |
| M8 | средняя | работоспособность (видимая ошибка) | Горка освещается фарами не как объём. У подножия свет — резкий прямоугольник следа полосы на полу, а нарисованный клин (трапеция, шире к верху) по бокам и у верха остаётся тёмным; мягкий край конуса пропадает. Мягкий свет появляется, только когда танк заехал на горку. Борта и торец насыпи фарами не освещаются вовсе. Найдено пользователем при проверке этапа 14 | 14 (14.5) |

## Статус этапов

| # | Этап | Находки | Статус |
| --- | --- | --- | --- |
| 1 | Разрешение карты освещённости под дырой | M1 | ✅ выполнен |
| 2 | Вывески на крышах: один автор прозрачности | M2, L1 | ✅ выполнен |
| 3 | Уровень из одних крыш теряет свет | M3 | ✅ выполнен |
| 4 | Выпечка с размытием: хелпер, освобождение фильтра, документация | M4, L3 | ✅ выполнен |
| 5 | Кривые спада света — один источник | L4 | ✅ выполнен |
| 6 | Засвет и тени лучей: общий модуль | L5 | ✅ выполнен |
| 7 | Сглаживание дыры раз на тик: один хелпер | L2 | ✅ выполнен |
| 8 | Тесты-страховки: дубли конфига и `game.roofs` | L6 | ✅ выполнен |
| 9 | Ядро: остаток масла — читаемость и защита | L7 | ✅ выполнен |
| 10 | Производительность: меши объёмов и окклюзия фар | L8 | ✅ выполнен |
| 11 | Читаемость `createLighting.js` и трассера | L9 | ✅ выполнен |
| 12 | (необязательный) Разделение `createLighting.js` на модули | L10 | ✅ выполнен |
| 13 | Грани объёмов: текстура привязана к стене, как в GTA 2 | M5 | ✅ выполнен |
| 14 | Фары и выстрелы у стены: свет на грани, попадание в грань; горки | M6, M7, M8 | ✅ выполнен |

Выполненный этап отмечается «✅ выполнен» в заголовке и в таблице. Когда выполнены все обязательные этапы
(12 — по решению пользователя), файл переносится в `plan/done/` через `git mv`, без коммита.

**Порядок и зависимости.** Этапы 1, 2, 3, 6, 8, 9 независимы. Этап 4 делается раньше этапа 5: оба правят
`headlightConeTexture.js` и `lightRadialTexture.js`. Этап 7 — после этапа 1 (оба правят `updateHoles` в
`createLighting.js`). Этап 11 — после этапов 1, 2, 3 и 7 (все правят `createLighting.js`). Этап 12 — последним.
Этап 13 добавлен после ревью (ошибку нашёл пользователь). Его выполнять **раньше этапа 10**: оба правят
`updateWallMesh` в `src/client/parts/map/extrusion.js`. Из оставшихся этапов только он исправляет видимую
игроку ошибку, поэтому его брать первым из невыполненных.
Этап 14 добавлен после ревью (ошибки нашёл пользователь). Его выполнять **раньше этапов 11 и 12**: он правит
`occlusionOf`/`layoutLights` в `createLighting.js`, которые этап 11 причёсывает, а этап 12 выносит в модули. Этап
10 (уже выполнен) он дополняет: `anyCellIn` работает и с новой сеткой объёмов (`Float32Array`).
Номера строк ниже даны по HEAD `435941c`; после правок предыдущих этапов они сдвигаются, поэтому место искать по
приведённому фрагменту кода (`grep -n`).

## Общие правила для исполнителя (прочитать перед любым этапом)

1. **Никаких `git commit`.** Изменения остаются в рабочем дереве.
2. **Код**: ES-модули, `===`, только `let`/`const`, фигурные скобки обязательны, без двух заглавных подряд в
   именах. Комментарии в коде — на русском, в стиле окружающего кода (объясняют «почему»). `src/host/` —
   Worker-safe (этот план его не трогает).
3. **PixiJS**: `onRender` назначается свойством (аксессор `Container`), регистрация тестируется через
   `part._onRender`. Анимация по времени шагает раз за тик (`Ticker.shared.lastTime`).
4. **Документация**: функциональная правка обновляет парные `docs/en/` и `docs/ru/` (таблица «область →
   страница» в `CLAUDE.md`). Раздел ищется по заголовку (`grep -n "^#" docs/en/<page>.md`).
5. **CHANGELOG.md** (английский): только в `## [Unreleased]`, под `### Fixed` / `### Changed`. Тесты, рефакторинг
   и `docs/` записями не являются — у каждого этапа ниже прямо сказано, нужна ли запись.
6. **Проверки в конце каждого этапа** (тихие флаги):
   ```bash
   npx eslint .
   npm test -- --silent
   npm run core:test          # только после правок core/ (этап 9)
   npm run core:build         # после правок core/ (этап 9), перед npm run build
   npm run build              # этапы 4, 5, 9, 10, 13, 14 (баркеры, ядро, меши, сервисы)
   npm run sim:scenarios      # этап 9 (после core:build и build)
   ```
7. **Паритет ядра** (этап 9): порядок операций в `Tank::update` (`core/src/tank.rs`) и
   `Predictor::step_inner` (`core/src/client/predictor.rs`) обязан совпадать дословно; нейтральный путь — бит в
   бит прежний. Закрывается `npm run core:test` (в т. ч. `client::predictor::parity`).
8. **Визуальная проверка** — `npm run dev` (матч во вкладке браузера), карта `downtown` (единственная ночная).
   Для этапов 1, 2, 3, 4, 10, 13, 14 она обязательна, потому что композитинг PixiJS юнит-тесты не ловят.

---

## Этап 1. Разрешение карты освещённости под дырой (M1) ✅ выполнен

### Проблема

`LevelLightMap` (`src/client/lighting/LevelLightMap.js:125-129`) кладёт на оверлей проходной фильтр
`AlphaFilter` с `resolution = lighting.resolution` (0.5) и `blendMode = 'multiply'`. Когда у оверлея уровня `L ≥ 1`
открывается дыра, `holeOverlay.apply` (`src/client/parts/map/holeOverlay.js:45-48`) **заменяет** цепочку на
`[hole.filter]`. Сервис потом восстанавливает только режим наложения
(`src/client/lighting/createLighting.js:1099-1105`):

```js
if (levelMap.hole.attached) {
  levelMap.hole.filter.blendMode = 'multiply';
} else if (overlay.filters?.[0] !== levelMap.filter) {
  overlay.filters = [levelMap.filter];
}
```

Разрешение у фильтра дыры остаётся по умолчанию (1). Для обычной карты уровня дыра открыта при условии
`below = levelView.level < L` (`createLighting.js:1062, 1096`), то есть **всегда, когда игрок на земле**. На
`downtown` оверлей уровня 1 (во весь экран: `filterArea` — вся карта с запасом) почти всё время рисуется в полном
разрешении — примерно в 4 раза больше пикселей, чем обещает `render.js → lighting.resolution`.

### Решение

Отвечать за цепочку фильтров должен сам `LevelLightMap`: у него есть и `filter`, и `hole`, и `resolution`.

1. `src/client/lighting/LevelLightMap.js` — новый метод рядом с `place`:
   ```js
   // Цепочка фильтров оверлея после шага дыры. Фильтр дыры заменяет
   // проходной целиком, поэтому и режим наложения (multiply), и разрешение
   // карты он обязан нести сам: без этого под плитой, то есть почти всё
   // время игрока на земле, карта рисовалась в полном разрешении. Без дыры
   // возвращается проходной фильтр
   syncFilters() {
     if (this.hole.attached) {
       this.hole.filter.blendMode = 'multiply';
       this.hole.filter.resolution = this.resolution;
     } else if (this.overlay.filters?.[0] !== this.filter) {
       this.overlay.filters = [this.filter];
     }
   }
   ```
2. `src/client/lighting/createLighting.js`, `updateHoles`: блок из 7 строк после `applyHole(...)` (комментарий
   «фильтр дыры сам становится последним…» и `if/else if`) заменить вызовом `levelMap.syncFilters();`.
   Комментарий перенести в метод, как в п. 1.
3. Координаты дыры от разрешения фильтра не зависят: шейдер (`src/client/seeThrough.js`, `mainFragment`) считает
   `pixel = uOutputFrame.xy + uv * uInputSize.xy` в логических единицах Pixi. **Это обязательно подтвердить
   визуально** (п. «Проверка»). Если центр дыры уезжает, п. 1 откатить, а в комментарий к `syncFilters` записать,
   почему разрешение у дыры оставлено полным.

### Тесты

`tests/client/lighting/createLighting.test.js` — по образцу блока `describe('lighting: область фильтра оверлея')`
(≈ стр. 699) и тестов дыры в `describe('lighting: крыши и вершины объёмов')` (≈ стр. 609):
- `it('открытая дыра несёт разрешение карты и multiply')`: ночная карта с маской уровня 1, игрок на уровне 0
  (`levelView.set(0, …)`), несколько кадров (`Ticker.shared.lastTime += 16` и `frame(service)`), пока дыра не
  подключится. У оверлея `lighting-1`: `overlay.filters[0] !== levelMap.filter`,
  `overlay.filters[0].resolution === cfg.resolution`, `overlay.filters[0].blendMode === 'multiply'`.
- `it('закрытая дыра возвращает проходной фильтр')`: игрок поднялся на уровень 1 → через кадры
  `overlay.filters[0].resolution === cfg.resolution` (это снова `AlphaFilter`).

### Документация

- `docs/en/architecture.md` (≈ стр. 413–415, абзац про дыру оверлея: «its filter is the last in the chain and
  carries the `multiply` blend itself») → «…carries the `multiply` blend and the map's `resolution` itself»; то же
  в `docs/ru/architecture.md`.
- `docs/en|ru/configuration.md`, строка таблицы `resolution` (≈ стр. 343): добавить «including while a
  see-through hole is open» / «в том числе при открытой дыре see-through».

### CHANGELOG

`### Fixed`: «The night light map of an upper level keeps `lighting.resolution` while the player is below it; it
used to render at full resolution whenever its see-through hole was open.»

### Проверка

Общие проверки п. 6. Вручную: `npm run dev`, `downtown`, ночь. (а) Танк под эстакадой: дыра в плите и в ночи
центрирована на танке, её край совпадает с дырой плиты. (б) Танк на земле вдали от моста: ночь выглядит как раньше
(край света может стать чуть мягче — так и задумано при 0.5). (в) DevTools → Performance: время кадра на земле не
больше, чем до правки.

---

## Этап 2. Вывески на крышах: один автор прозрачности (M2, L1) ✅ выполнен

### Проблема

1. **Два автора `alpha` у эмиссива.** Прозрачность спрайтов вывески выставляет `NeonSign.update`
   (`src/client/parts/map/NeonSign.js:91-118`): `see = roofAlpha ?? levelView.alphaFor(...)`, умноженное на
   мерцание. Но `createLighting.updateEmissive` (`createLighting.js:1126-1132`) на каждой раскладке перезаписывает
   ту же `alpha` у всех спрайтов сессии:
   ```js
   if (levelView) {
     for (const [sprite, level] of emissive) {
       sprite.alpha = levelView.alphaFor(level, sprite.x, sprite.y, 0);
     }
   }
   ```
   Спрайты эмиссива есть только у `NeonSign` (`grep -rn "addEmissive(" src/client`). Правильный результат держится
   на порядке: `MapLayer.render` сначала зовёт `lighting.render()`, потом `updateLayerAnimations`. Если порядок
   поменяется (например, повторная раскладка в том же кадре), вывеска на крыше гаснет «кругом вокруг игрока» и
   теряет мерцание — ровно то, от чего этап 2 плана `night-city-fixes` ввёл `roofAlpha`. Кроме того,
   `docs/*/architecture.md` (≈ стр. 418: «Their transparency is `levelView.alphaFor`») описывает прежнее
   поведение.
2. **`roofAlpha` в режиме `'layer'`** (`src/client/parts/map/MapLayer.js:341-346`):
   ```js
   const roofAlpha =
     this._roof && this._levelView
       ? 1 + (this._levelView.cfg.minAlpha - 1) * this._hole.strength
       : null;
   ```
   В режиме `seeThrough.mode = 'layer'` дыра не шагает (`layerSeeThrough.js:76-86` меняет `container.alpha`),
   `strength` остаётся 0, поэтому `roofAlpha = 1`. Крыша гаснет до `layerAlpha`, а эмиссивная вывеска на ней
   (живёт вне контейнера слоя) светит в полную силу.
3. `roofAlpha` считается **до** `updateSeeThrough(...)` (`MapLayer.js:358-360`), то есть по силе дыры
   прошлого кадра.

### Решение

1. `createLighting.js`, `updateEmissive`: удалить цикл по `emissive` (строки 1126-1132 вместе с комментарием
   «спрайты сессии уже в нарисованных координатах…»). Головы фонарей (`map.lamps`) остаются как есть.
   К методу `addEmissive` дописать в комментарий: «Прозрачность и позицию спрайта ведёт владелец (он же снимает
   спрайт `removeEmissive`): сервис только держит его в контейнере уровня».
2. `MapLayer.js` — новый метод рядом с `_seeThroughView`:
   ```js
   // Прозрачность крыши для её вывесок: эмиссив живёт вне контейнера слоя,
   // фильтра дыры и alpha слоя не видит и гаснет по этому числу. 'layer' —
   // alpha самого слоя; 'hole' — alpha в центре дыры (вывеска гаснет вся, а
   // не кругом). null — слой не крыша
   _roofAlpha() {
     if (!this._roof || !this._levelView) {
       return null;
     }

     if (this._levelView.mode === 'layer') {
       return this._container.alpha;
     }

     return 1 + (this._levelView.cfg.minAlpha - 1) * this._hole.strength;
   }
   ```
3. `MapLayer.render`: блок `updateSeeThrough` (`if (this._level >= 1 || this._occluder) {...}`) поставить **перед**
   блоком `if (this._animations) {...}`, а в `updateLayerAnimations` передавать `roofAlpha: this._roofAlpha()`
   вместо локальной переменной. Комментарий «вывески на крыше гаснут вместе с ней…» оставить у вызова.

### Тесты

- `tests/client/lighting/createLighting.test.js`, блок `describe('lighting: эмиссив')` (≈ стр. 576):
  `it('сервис не трогает прозрачность эмиссива: её ведёт владелец')`: ночная карта с `levelView` (игрок на
  уровне 0), `const sprite = new Sprite(); sprite.alpha = 0.37; service.addEmissive(sprite, 1); frame(service);`
  → `expect(sprite.alpha).toBe(0.37)`. Если какой-то существующий тест ждал от сервиса `alpha` эмиссива по
  `alphaFor`, он закреплял старое поведение с двумя авторами: перенести ожидание в тест `NeonSign`/
  `layerAnimations` (там `alpha` выставляет владелец).
- `tests/client/parts/map/MapLayer.test.js`, блок `describe('прозрачность крыши')` (≈ стр. 1012):
  - `it("_roofAlpha: режим 'layer' — alpha слоя")`: слой-крыша, `seeThrough.mode = 'layer'`, игрок под крышей;
    после нескольких `render()` `layer._roofAlpha()` равен `container.alpha` и меньше 1.
  - `it("_roofAlpha: режим 'hole' — alpha центра дыры")`: `1 + (minAlpha − 1)·strength`.
  - `it('не крыша — null')`.
  - Настройку режима и игрока взять из соседнего теста `"режим 'layer': крыша гаснет только над танком"`
    (≈ стр. 1079).

### Документация

`docs/en/architecture.md` (≈ стр. 416–418, «Emissive layer»): «Their transparency is `levelView.alphaFor`» →
«Their transparency and position are set by the owner on every draw (`NeonSign.update`: `levelView.alphaFor`, or
the roof's alpha for a sign standing on a roof — `MapLayer._roofAlpha`); the service only holds the sprite in its
level's container.» То же в `docs/ru/architecture.md`.

### CHANGELOG

`### Fixed`: «In the `layer` see-through mode a neon sign on a roof fades together with the roof instead of staying
fully lit.» (Удаление второго автора видимого поведения не меняет — записи нет.)

### Проверка

Общие проверки. Вручную: `npm run dev`, `downtown`, ночь: вывески HOTEL/BAR/CLUB/MOTEL мерцают как раньше; танк
заезжает за здание с вывеской — крыша и вывеска гаснут вместе. Режим `'layer'` проверить временной правкой
`seeThrough.mode` в `src/config/render.js` (правку вернуть!).

---

## Этап 3. Уровень из одних крыш теряет свет (M3) ✅ выполнен

### Проблема

`createLighting.syncLevels` (`createLighting.js:633-647`) убирает из обычной маски уровня клетки крыш. Если на
уровне **нет ничего, кроме крыш**, `syncLevelMap(map.levels, level, [], false)` удаляет обычную карту уровня, и
остаётся только карта крыш в `map.roofLevels`. Но раскладка смотрит только в `map.levels`:
- `layoutLights → push` (`createLighting.js:833`):
  `const levels = own.filter(level => map.levels.has(level));` — источник уровня отбрасывается целиком
  (`levels.length === 0` → `return`), и карта крыш не получает ни одного источника: ни неона вывесок, ни фонарей,
  ни фар танка на крыше;
- `layoutShafts` (`createLighting.js:996`): `!map.levels.has(lamp.level)` — лучей фонаря тоже нет.

На `downtown` ошибка не проявляется: на уровне 1 есть `SLAB`/`OIL`/`RAILING`. Но любая карта «город на крышах»
получит тёмные крыши без неона, и никакой ошибки при этом не будет.

### Решение

1. `createLighting.js`, рядом с `allLevelMaps`:
   ```js
   // есть ли у уровня хоть одна карта освещённости — обычная или крыш:
   // уровень может состоять из одних крыш, и его свет обязан дойти до них
   const hasLevelMap = level => map.levels.has(level) || map.roofLevels.has(level);
   ```
2. `push`: `own.filter(level => map.levels.has(level))` → `own.filter(hasLevelMap)`.
3. `layoutShafts`: `!map.levels.has(lamp.level)` → `!hasLevelMap(lamp.level)`.
4. `rampTargets` (построение по `map.levels.values()`) не трогать: клинья рамп живут только в обычных картах.

### Тесты

`createLighting.test.js`, блок `describe('lighting: крыши и вершины объёмов')`:
- `it('уровень из одних крыш получает свой свет')`: ночная карта. Часть уровня 1 вносит **только** вклад крыши
  (`setLevelMask(1, cells, owner, { roof: true })`), обычного вклада уровня 1 нет. Источник
  `addLight({ kind: 'radial', level: 1, x, y, radius, intensity: 1 })` над клеткой крыши. После `frame(service)`
  у оверлея `lighting-roof-1` в контейнере `lights` есть видимый спрайт. До правки их 0 — тест обязан падать без п. 2.
- `it('лучи фонаря уровня из одних крыш')`: то же с фонарём `head: true` в `game.lighting.lamps` на уровне 1 —
  у карты крыш есть видимый контейнер лучей (`shafts`).

### Документация

`docs/en|ru/configuration.md`, раздел «Roofs (`game.roofs`)» (≈ стр. 757): добавить фразу «A level may consist of
roofs only: its lights then go to the roof light map.» / «Уровень может состоять из одних крыш — тогда его свет
идёт в карту крыш.»

### CHANGELOG

`### Fixed`: «Lights on a level made only of roofs (`game.roofs`) now light those roofs; they used to be dropped.»

### Проверка

Общие проверки. Вручную на `downtown` — регрессии нет (неон крыш, фонари, фары на эстакаде).

---

## Этап 4. Выпечка с размытием: хелпер, освобождение фильтра, документация (M4, L3) ✅ выполнен

### Проблема

1. **Документация учит старому правилу.** `docs/en/extending.md:420-427` и `docs/ru/extending.md` (≈ стр. 413–420)
   требуют `filter.padding = blurMargin(blur)`. Этап 5 задачи установил, что так мусор пула текстур (Pixi 8.19,
   многопроходный `BlurFilter` без очистки временной текстуры) попадает на кромку выпечки. Верное правило —
   `filter.padding = blurPadding(blur)` (= `2·blurMargin`, `src/client/bakers/blurMargin.js`). Новый баркер,
   написанный по документации, вернёт «квадрат вокруг воронки».
2. **Дублирование.** Один и тот же блок
   ```js
   const filter = new BlurFilter({ strength: blur, quality });
   filter.padding = blurPadding(blur);
   graphics.filters = [filter];
   const texture = renderer.generateTexture({ target: graphics, frame: new Rectangle(0, 0, w, h) });
   graphics.destroy(true);
   ```
   повторён в 9 баркерах: `blurredCircleTexture`, `funnelTexture` (в цикле вариантов), `headlightConeTexture`,
   `lampHeadTexture`, `lightRadialTexture`, `scorchTexture` (в цикле), `tankShadowTexture`, `glintTexture`,
   `lightShaftTexture` (всё в `src/client/bakers/`). Исправление этапа 5 пришлось вносить в каждый из них.
3. **Утечка.** В Pixi 8 `Container.destroy` фильтры не уничтожает
   (`node_modules/pixi.js/lib/scene/container/Container.mjs`: только `this._filterEffect = null`), поэтому
   `BlurFilter` (с внутренними проходами и группами uniform) после каждой выпечки остаётся жить. Освобождает его
   только `neonCache.js` (`filter.destroy()`).

### Решение

1. Новый файл `src/client/bakers/bakeBlurred.js` (`blurMargin.js` остаётся чистым, без Pixi):
   ```js
   import { BlurFilter, Rectangle } from 'pixi.js';
   import { blurPadding } from './blurMargin.js';

   // Выпечка фигуры с размытием — одно место на все баркеры. padding фильтра —
   // `blurPadding(blur)`: промежуточные проходы BlurFilter пишут во временную
   // текстуру пула без очистки, и при меньшем padding мусор прошлых кадров
   // ложится светлой рамкой по краю текстуры (см. blurMargin.js). Кадр —
   // `width × height` от (0, 0): запас `blurMargin(blur)` вокруг фигуры
   // закладывает вызывающий. Фигура и фильтр после выпечки освобождаются —
   // `Container.destroy` фильтры не уничтожает
   export default function bakeBlurred(renderer, target, { blur, quality = 10, width, height }) {
     const filter = new BlurFilter({ strength: blur, quality });

     filter.padding = blurPadding(blur);
     target.filters = [filter];

     const texture = renderer.generateTexture({
       target,
       frame: new Rectangle(0, 0, width, height),
     });

     target.destroy(true);
     filter.destroy();

     return texture;
   }
   ```
   `target.filters` после выпечки **не** обнулять: тесты баркеров читают `options.target.filters[0].padding` уже
   после выпечки.
2. Перевести 9 баркеров из п. 2 «Проблемы» на `bakeBlurred`. Размеры кадра, `blur` и `quality` — **ровно прежние**
   у каждого баркера (у `tankShadowTexture` `quality` по умолчанию 20, у `scorchTexture` — жёстко 10 и т. д.):
   текстуры обязаны остаться бит в бит. Импорты `BlurFilter`/`Rectangle`/`blurPadding`, ставшие лишними, удалить.
   `neonCache.js` не трогать: он печёт два раза (ядро без фильтра, ореол с фильтром на дочернем `label`) и фильтр
   уже освобождает.
3. Документация — п. «Документация» ниже.

### Тесты

- Новый `tests/client/bakers/bakeBlurred.test.js` с моками `pixi.js` по образцу `scorchTexture.test.js`
  (моки `Graphics`, `BlurFilter` с `destroy()`, `Rectangle`):
  `it('padding фильтра — blurPadding(blur)')`, `it('кадр — width × height от (0, 0)')`,
  `it('фигура и фильтр освобождены')` (шпионы на `destroy`), `it('quality по умолчанию 10')`.
- В моках `BlurFilter` существующих тестов (`blurredCircleTexture`, `funnelTexture`, `glintTexture`,
  `lightShaftTexture`, `scorchTexture`, `tankShadowTexture` — `grep -ln "class BlurFilter" tests/client/bakers`)
  добавить пустой `destroy() {}`. Сами проверки не менять: они обязаны остаться зелёными.

### Документация

`docs/en/extending.md`, шаг 3 рецепта новой сущности (≈ стр. 420–427) переписать так:
«When using `BlurFilter`, bake through `bakeBlurred(renderer, graphics, { blur, quality, width, height })`
(`bakers/bakeBlurred.js`). It sets `filter.padding = blurPadding(blur)` — twice `blurMargin(blur)`: with a smaller
padding the blur passes read stale pixels of the texture pool, and the texture gets a light frame on its edge. The
canvas itself must still include a `blurMargin(blur)` allowance around the shape (`bakers/blurMargin.js`), or
`generateTexture` clips the blur at the frame.» Остальной текст шага (`contentSize`, общие баркеры) сохранить.
Та же правка в `docs/ru/extending.md`.

### CHANGELOG

`### Fixed`: «Procedural textures release their blur filter after baking.» (Хелпер — рефакторинг, записи нет.)

### Проверка

Общие проверки + `npm run build`. Вручную: `npm run dev`, `downtown`, ночь — фары, пятна фонарей, головы фонарей,
тени танков, копоть и воронка взрыва бочки, засветы и лучи выглядят как раньше; квадрата вокруг воронки нет.

---

## Этап 5. Кривые спада света — один источник (L4) ✅ выполнен

### Проблема

Засвет (`lightMath.lightStrength`) обязан совпадать с картинкой текстур, но формулы в них записаны независимо:
- конус: `headlightConeTexture.js:28` — `(1 - t) * (1 - t * 0.35)`; `lightMath.js:219` — то же с тем же `0.35`;
- пятно: `lightRadialTexture.js` — `drawRadialRings(..., t => (1 - t) * (1 - t))`; `lightMath.js:180-188`
  (`radialFalloff`) — `(1 − d/r)²`.

### Решение

1. `src/client/lighting/lightMath.js` (модуль чистый, без Pixi — его можно импортировать из баркеров):
   ```js
   // Профили яркости источников по доле `t ∈ [0, 1]` радиуса или длины. Одна
   // формула на текстуру (баркеры) и на засвет (`lightStrength`): засвет
   // обязан гаснуть ровно там, где гаснет картинка

   // пятно фонаря: `(1 − t)²` — центр не пересвечен плато
   export function radialProfile(t) {
     return (1 - t) * (1 - t);
   }

   // конус фары вдоль оси: яркий у фары, к концу сходит на нет
   const CONE_TAIL = 0.35;

   export function coneProfile(t) {
     return (1 - t) * (1 - t * CONE_TAIL);
   }
   ```
2. `radialFalloff`: `const t = 1 - Math.max(0, distance) / radius; return t * t;` →
   `return radialProfile(Math.max(0, distance) / radius);` (граничные проверки выше оставить).
3. `lightStrength`, ветка конуса: `(1 - t) * (1 - t * 0.35)` → `coneProfile(t)`.
4. `headlightConeTexture.js`: `const alpha = (1 - t) * (1 - t * 0.35);` → `const alpha = coneProfile(t);` +
   импорт из `../lighting/lightMath.js`.
5. `lightRadialTexture.js`: `t => (1 - t) * (1 - t)` → `radialProfile`.

Результаты обязаны быть бит в бит прежними (те же операции в том же порядке).

### Тесты

`tests/client/lighting/lightMath.test.js`: `radialProfile(0) === 1`, `radialProfile(1) === 0`,
`radialProfile(0.5) === 0.25`; `coneProfile(0) === 1`, `coneProfile(1) === 0`,
`coneProfile(0.5) === 0.5 * (1 - 0.175)`. Существующие тесты `radialFalloff`/`lightStrength` — без изменений и
зелёные.

### Документация / CHANGELOG

Нет (рефакторинг).

### Проверка

Общие проверки + `npm run build`.

---

## Этап 6. Засвет и тени лучей: общий модуль (L5) ✅ выполнен

### Проблема

1. `Tank._updateGlint` (`src/client/parts/Tank.js:1135-1203`) и `MapObject._updateGlint`
   (`src/client/parts/map/MapObject.js:248-306`) повторяют одно и то же: условия
   (`glints.enabled`, текстура `glint`, `isNight()`, `onScreen`), запрос `lightsAt(...)[0]`, ленивое создание пары
   `{ sprite, mask }` с `blendMode = 'add'` и `sprite.mask = mask`, раскладку текстуры, тинта и альфы
   (`Math.min(1, glints.intensity * hit.strength)`) и масштаба от `asset.contentSize`.
2. `Tank._updateGlint` на каждом кадре создаёт массив `[...this._headlights.cones, this._headlights.glow]` для
   `exclude`.
3. `Tank._updateCaster` (`Tank.js:1207-1219`) и `MapObject._updateCaster` (`MapObject.js:310-334`) каждый кадр
   создают новый объект и зовут `setCaster` — днём, без лучей и с `shafts.shadows: false` тоже, хотя тогда
   `casters` никто не читает (`createLighting.shadowsOf`).

### Решение

1. Новый модуль `src/client/parts/glint.js`:
   ```js
   import { Sprite } from 'pixi.js';
   import { lighting as lightingConfig } from '../../config/render.js';

   // Засвет (`lighting.glints`): блик на стороне предмета, обращённой к
   // сильнейшему источнику. Один код на `Tank` и `MapObject`: запрос к
   // сервису, спрайт-градиент `glintTexture` и маска-силуэт предмета.

   // сильнейший источник в мировой точке предмета или null: засвет
   // выключен, текстуры нет, день или предмет вне экрана
   export function glintHit(lighting, { x, y, z, level, reach, exclude = null }) {
     const asset = lighting?.texture('glint');

     if (!lightingConfig.glints?.enabled || !asset || !lighting.isNight()) {
       return null;
     }

     if (!lighting.onScreen(x, y, z, reach)) {
       return null;
     }

     return lighting.lightsAt(x, y, level, 1, exclude)[0] || null;
   }

   // пара «блик + маска» в `parent`: заводится на первом попадании
   export function ensureGlint(glint, parent, texture) {
     if (glint) {
       return glint;
     }

     const sprite = new Sprite(texture);
     const mask = new Sprite();

     sprite.anchor.set(0.5);
     sprite.blendMode = 'add';
     sprite.mask = mask;
     parent.addChild(mask, sprite);

     return { sprite, mask };
   }

   export function hideGlint(glint) {
     if (glint) {
       glint.sprite.visible = false;
     }
   }

   // блик к источнику: `size` — размер предмета (единицы контейнера), по
   // нему масштаб градиента; поворот `rotation` — в осях контейнера
   export function placeGlint(glint, { hit, asset, x, y, rotation, size }) {
     const { sprite } = glint;
     const glints = lightingConfig.glints;

     sprite.texture = asset.texture;
     sprite.visible = true;
     sprite.position.set(x, y);
     sprite.rotation = rotation;
     sprite.scale.set((size * glints.size) / asset.contentSize);
     sprite.tint = hit.color;
     sprite.alpha = Math.min(1, glints.intensity * hit.strength);
   }
   ```
   Маску каждый вызывающий по-прежнему раскладывает сам: у танка это якорь и масштаб корпуса с просадкой, у пропа —
   копия трансформа тела.
2. `Tank._updateGlint` переписать через `glintHit` / `ensureGlint` / `hideGlint` / `placeGlint`, сохранив:
   `z = this._viewZ()`, `reach = this._size * 2 * zScale`, `level = this._level`, поворот
   `hit.angle - this.rotation`, размер `Math.max(source.texture.width, source.texture.height) * size`, проверку
   «блик — последний ребёнок» (`this.children.at(-1) !== sprite → this.addChild(sprite)`) и раскладку маски.
3. `Tank`: в `_addLights` завести `this._ownLights = [...cones, glow]` (после создания `_headlights`), в
   `_removeLights` — `this._ownLights = null`. В `glintHit` передавать `exclude: this._ownLights`.
4. `MapObject._updateGlint` переписать так же (условия `this.sprite.visible && this._standing()` остаются снаружи:
   без них — `hideGlint`), `exclude` не передаётся, поворот `hit.angle`, размер `Math.max(this._width, this._height)`.
5. Сервис `createLighting.js` — новый публичный метод рядом с `setCaster`:
   ```js
   // нужны ли сервису предметы-тени: ночь, лучи и их тени включены. Иначе
   // `casters` никто не читает, и регистрировать их каждый кадр незачем
   castsShadows() {
     const shafts = cfg.shafts;

     return isNight() && Boolean(shafts?.enabled && shafts.shadows && shafts.maxShadowCasters > 0);
   },
   ```
6. `Tank._updateCaster` / `MapObject._updateCaster`: если `!this._lighting.castsShadows()` (или у пропа
   `!this._standing()`) — снять регистрацию, если она была (`setCaster(this, null)`, `this._caster = null`), и
   выйти. Иначе завести **один** объект `this._caster` на первом кадре, зарегистрировать его один раз
   (`setCaster(this, this._caster)`) и дальше каждый кадр только менять его поля (`x`, `y`, `z`, `level`,
   `radius`). Сервис хранит ссылку, поэтому изменения видны `shadowsOf` без повторного вызова. В `destroy` —
   как сейчас: `setCaster(this, null)`.

### Тесты

- Новый `tests/client/parts/glint.test.js`: `glintHit` возвращает null при `glints.enabled = false`, без текстуры,
  днём (`isNight → false`), вне экрана (`onScreen → false`); отдаёт первый ответ `lightsAt`; передаёт `exclude`.
  `ensureGlint` создаёт пару один раз и кладёт маску раньше блика; `placeGlint` ставит альфу
  `min(1, intensity·strength)`.
- Существующие тесты засвета и теней в `tests/client/parts/Tank.test.js` (≈ стр. 1927) и
  `tests/client/parts/map/MapObject.test.js` (≈ стр. 561) обязаны остаться зелёными. Проверки
  `toHaveBeenLastCalledWith(part, {...})` работают и с изменяемым объектом. Если тест ждёт вызова `setCaster` на
  каждом кадре, поправить ожидание на «зарегистрирован, поля актуальны».
- Добавить: `it('днём тени лучей не регистрируются')` для `Tank` и `MapObject` (сервис с дневной картой →
  `setCaster` не вызывался с объектом).
- `createLighting.test.js`: `it('castsShadows: только ночью и при включённых тенях лучей')`.

### Документация

`docs/en|ru/architecture.md`, абзац «Glints» (≈ стр. 457 en): упомянуть общий модуль `parts/glint.js` и то, что
предметы регистрируют тень, только когда `castsShadows()` (ночь и тени лучей включены).

### CHANGELOG

Нет (рефакторинг и микрооптимизация без видимых изменений).

### Проверка

Общие проверки. Вручную на `downtown`, ночь: засвет на танке в фарах другого танка и под фонарём, засвет на
бочках и ящиках, тени от танков в лучах фонарей — как раньше.

---

## Этап 7. Сглаживание дыры раз на тик: один хелпер (L2) ✅ выполнен

### Проблема

Правило «сила дыры шагает раз на тик общего тикера» реализовано дважды и по-разному:
- `src/client/parts/map/layerSeeThrough.js:47-53`:
  `const stepped = view.hole.tick === tick; … const rate = stepped ? 0 : Math.min(1, cfg.fadeRate * dt);` — здесь
  `stepped` значит «в этом тике уже шагали»;
- `src/client/lighting/createLighting.js:1554` (`render`):
  `const stepped = key === null || key.tick !== tick;` и в `updateHoles` (`:1053`)
  `const rate = stepped ? Math.min(1, see.fadeRate * dt) : 0;` — здесь `stepped` значит «новый тик».

Одинаковое имя с противоположным смыслом путает читателя. При этом у `LevelLightMap.hole` поле `tick`
(`holeOverlay.createHole`) уже есть, но не используется.

### Решение

1. `src/client/parts/map/holeOverlay.js` (там уже живут `createHole`/`advance`), добавить импорт `Ticker` из
   `pixi.js` и функцию:
   ```js
   // Шаг сглаживания дыры за эту отрисовку: доля перехода за время тика,
   // но РОВНО раз на тик общего тикера. За тик полотно может рисоваться не
   // раз, а `deltaMS` у всех отрисовок тика один: без отсечки дыра гасла бы
   // тем быстрее, чем больше отрисовок пришло в тик. Повторные отрисовки
   // того же тика получают 0 — сила остаётся, применение идёт каждый раз
   export function tickRate(hole, fadeRate) {
     const tick = Ticker.shared.lastTime;

     if (hole.tick === tick) {
       return 0;
     }

     hole.tick = tick;

     return Math.min(1, fadeRate * (Ticker.shared.deltaMS / 1000));
   }
   ```
2. `layerSeeThrough.updateSeeThrough`: строки с `tick`/`stepped`/`dt`/`rate` заменить на
   `const rate = tickRate(view.hole, cfg.fadeRate);`. Длинный комментарий о причине сократить до ссылки на
   `tickRate`. Импорт `Ticker` удалить, если он больше не нужен. Перекрыватель берёт тот же `rate`, как сейчас.
3. `createLighting.js`:
   - `updateHoles(camera)` — без параметра `stepped`; внутри цикла по картам, до ветки `'layer'`:
     `const rate = tickRate(levelMap.hole, see.fadeRate);` (импорт из `../parts/map/holeOverlay.js`, рядом с
     `advance`/`apply`). Строки `const dt = …` и `const rate = …` в начале функции удалить;
   - `render()`: удалить `const stepped = …` и передавать `updateHoles(camera)`. `layoutKey.tick` остаётся: он
     нужен кешу раскладки.

### Тесты

- `tests/client/parts/map/holeOverlay.test.js`: `it('tickRate: первая отрисовка тика шагает, повторные — 0')`,
  `it('tickRate: следующий тик снова шагает')`, `it('tickRate: не больше 1 при длинном тике')`. Время двигать через
  `Ticker.shared.lastTime` / `deltaMS`, как в `createLighting.test.js:69`.
- Все существующие тесты дыр (`MapLayer.test.js`, `createLighting.test.js`) — зелёные без правок ожиданий.

### Документация / CHANGELOG

Нет (рефакторинг).

### Проверка

Общие проверки. Вручную: въезд под эстакаду — плита и ночь над ней открываются так же плавно, как раньше.

---

## Этап 8. Тесты-страховки: дубли конфига и `game.roofs` (L6) ✅ выполнен

### Проблема

1. Клиенту конфиг ядра недоступен, поэтому два числа продублированы в `src/config/render.js` и связаны только
   комментариями: `surfaceFx.tracks.oil.trail` (1.5) ↔ `coreParams.surfaces.types.oil.slickTime`
   (`src/config/game.js`), `surfaceFx.boost.boostMinSpeed` (20) ↔ `coreParams.surfaces.types.boost.minEntrySpeed`.
   Для такого же дубля (`landing` ↔ `levels.landingShake`) в проекте уже есть страховка —
   `tests/config/landing.test.js`.
2. Поле карты `game.roofs` не проверяет ни ядро (`core/src/map_game.rs` его не знает), ни тесты. Ошибку
   (уровень без `levels[L]`, тайл крыши не в `floor`, крыша в одном слое с плитой) видно только по
   `console.warn` в рантайме (`MapLayer.isRoofLayer`, `src/client/parts/map/MapLayer.js:522-541`) или по
   поведению в браузере.

### Решение

1. Новый `tests/config/surfaces.test.js` по образцу `tests/config/landing.test.js` (комментарий в шапке — зачем):
   - `it('шлейф масляных следов длится столько же, сколько остаток масла в ядре')`:
     `expect(surfaceFx.tracks.oil.trail).toBe(gameConfig.coreParams.surfaces.types.oil.slickTime)`;
   - `it('порог вспышки бустера совпадает с порогом ядра')`:
     `expect(surfaceFx.boost.boostMinSpeed).toBe(gameConfig.coreParams.surfaces.types.boost.minEntrySpeed)`.
2. Правило «слой-крыша» не дублировать в тесте: в `MapLayer.js` добавить `export` к функции `isRoofLayer`, в её
   комментарий дописать «экспортируется для проверки карт в тестах».
3. Новый `tests/config/maps.test.js` (именно в `tests/config/`: `tests/data/**` не входит в `include` проектов
   `vitest.config.js`). Для каждой карты из `src/data/maps/index.js`, у которой есть `game.roofs`, и каждого ключа
   `L`:
   - `Number(L) >= 1` и `map.levels[L]` существует;
   - каждый тайл из `game.roofs[L]` входит в `map.levels[L].floor`;
   - каждый рендер-слой `map.levels[L].layers[layer]`, где есть хоть один тайл крыши, — крыша целиком:
     `isRoofLayer(map.game, Number(L), tiles) === true` (перед вызовом `vi.spyOn(console, 'warn')` и проверить, что
     предупреждения не было).
   - `it('каждая вывеска и декаль на уровне с крышами стоит на слое крыши, если её клетка — крыша')` — по желанию,
     если `game.signs`/`game.decals` описаны клетками и слоями (`downtown.js` ≈ стр. 498): клетка
     `levels[L].map[row][col]` — тайл крыши → `layer` вывески равен слою крыши.

### Документация / CHANGELOG

Нет (тесты). Комментарии у `trail` в `render.js` (≈ стр. 405–408) и у `boostMinSpeed` (≈ стр. 395–397) дополнить
ссылкой на `tests/config/surfaces.test.js`.

### Проверка

`npx eslint .`, `npm test -- --silent`. Контроль: временно поменять `trail` на 1.4 — тест обязан упасть (правку
вернуть).

---

## Этап 9. Ядро: остаток масла — читаемость и защита (L7) ✅ выполнен

### Проблема

1. Чтобы в полёте только уменьшить остаток масла, и хост (`core/src/tank.rs:504-521`), и реплика
   (`core/src/client/predictor.rs:1087-1101`) вызывают полную `surface::apply_slick(map, rules, &mut state, x, y,
   angle, half_w, half_h, SurfaceMix::NEUTRAL, dt)` и выбрасывают результат. Функция `decay_slick`, которая делает
   ровно это, приватна (`core/src/surface.rs:499`). Для бустера сделано иначе и понятнее: публичная `decay_boost`.
2. На хосте `tank_mix` и `apply_slick` (`tank.rs:530-557`) получают одинаковый список аргументов, а
   `body.rotation().angle()` и полугабариты считаются дважды.
3. `apply_slick` индексирует `map.types[level_state.slick_type as usize - 1]` (`surface.rs:476`), где `slick_type`
   взят из состояния, а не из карты. `LevelState` сериализуется (`#[serde(default)]`) и восстанавливается из дампа
   при передаче хоста. Устаревшее значение приведёт к панике WASM, а паника хоста роняет комнату. При нынешнем
   коде (сброс в `set_map`/`reset`/`change_player_data`, одинаковый конфиг при передаче хоста) недостижимо, но
   защита ничего не стоит.
4. Устаревший комментарий в тесте `surface.rs:747`: «порядок типов — `BTreeMap`: boost, conveyor, mud, sand» — с
   этапа 6 там есть `oil` (ожидание в тесте уже `Some(4)`).

### Решение

1. `surface.rs`: `fn decay_slick` → `pub fn decay_slick`, doc-комментарий:
   ```rust
   /// Спад остатка скользкой поверхности за шаг; на нуле след забывается.
   /// Хост и реплика зовут её в полёте, в одном и том же месте (ветка
   /// `input_locked`); вне полёта спад делает сама [`apply_slick`].
   ```
2. `tank.rs` — в ветке `if self.level_state.input_locked()` блок `if let Some(map) = surfaces { … apply_slick … }`
   заменить на `surface::decay_slick(&mut self.level_state, dt);`, комментарий оставить. **Эквивалентность**:
   сейчас `input_locked() == airborne()` (`level.rs:130`), и ветка полёта `apply_slick` делает ровно
   `decay_slick`. Без карты поверхностей остаток и так всегда 0.
3. `predictor.rs` — то же в ветке `if self.level_state.input_locked()` `step_inner`: блок
   `if let (Some(map), Some(shape)) = … { surface::apply_slick(…) }` → `surface::decay_slick(&mut self.level_state, dt);`.
4. `tank.rs`, основная ветка: перед `let mix = …` вычислить один раз
   `let angle = body.rotation().angle();` и `let (half_w, half_h) = (self.width / 2.0, self.height / 2.0);`, и
   передать их в `tank_mix` и `apply_slick` (порядок и сами вызовы не менять — паритет).
5. `surface.rs:476`:
   ```rust
   // тип следа берётся из состояния, а не из карты: состояние могло приехать
   // из дампа. Чужой индекс — следа нет (паника WASM уронила бы комнату)
   let Some((params, _)) = map.types.get(usize::from(level_state.slick_type) - 1) else {
       level_state.slick_left = 0.0;
       level_state.slick_type = 0;

       return mix;
   };
   ```
   (`slick_type != 0` уже проверен строкой выше.) Дальше `params` используется как раньше (было
   `&map.types[...].0`).
6. `surface.rs:747`: комментарий → «порядок типов — `BTreeMap`: boost, conveyor, mud, oil, sand».

### Тесты

- `surface.rs`, `mod tests`:
  - `#[test] fn stale_slick_type_is_forgotten()`: `LevelState { slick_left: 1.0, slick_type: 200, .. }`
    вне масла → `apply_slick` возвращает входной `mix`, паники нет, `(slick_left, slick_type) == (0.0, 0)`;
  - `#[test] fn decay_slick_drops_the_residue_and_forgets_the_type()`: `slick_left 0.3`, `decay_slick(…, 0.2)` →
    `≈ 0.1`, тип сохранён; ещё `0.2` → `(0.0, 0)`.
- Существующие `residue_decays_but_does_not_apply_in_flight`, паритет `oil_exit_turn_keeps_residue_in_parity`,
  `oil_residue_reconcile_rewinds_the_timer`, `boost_hold_*`, `core/tests/sim.rs` `oil_residue_*` — зелёные без
  правок.

### Документация

`docs/en/core.md` (≈ стр. 1164–1178, «Order in `Tank::update`» и «`Predictor::step_inner` mirrors it»): «in that
return (flight) `apply_slick` only decays the residue» → «in that return (flight) `decay_slick` drops the residue»;
«`apply_slick` (decay) inside it» → «`decay_slick` inside it». То же в `docs/ru/core.md`.

### CHANGELOG

Нет (рефакторинг и недостижимая при нынешнем коде защита).

### Проверка

```bash
npm run core:test
npm run core:build
npm test -- --silent
npm run build
npm run sim:scenarios       # 18/18, как до правки
```

---

## Этап 10. Производительность: меши объёмов и окклюзия фар (L8) ✅ выполнен

### Проблема

1. `MapLayer.render` (`src/client/parts/map/MapLayer.js:372-383`) каждый кадр для каждого среза зовёт
   `updateWallMesh` / `orderWallMesh` / `updateHeightMesh` (`src/client/parts/map/extrusion.js:306-390, 680-695`).
   Они пересчитывают все вершины (у `downtown` ~1700 квадов граней, то есть ~6800 вершин и UV плюс клинья рамп) и
   присваиванием `target.vertices = …` / `geometry.uvs = …` помечают буферы грязными — перезаливка на GPU идёт
   каждый кадр, **даже когда камера стоит** (танк стоит, наблюдатель).
   **После этапа 13** UV граней в кадре уже не пересчитываются, а `updateWallMesh` пишет только вершины по
   `heights` (плюс нахлёст у верхнего ряда). Кеш ниже от этого не меняется: он пропускает и этот пересчёт.
2. `createLighting.occlusionOf` (`createLighting.js:507-586`) для каждой видимой фары, которая сдвинулась или
   повернулась (то есть у каждого едущего танка — каждый кадр), строит веер из `rays` (64) лучей плюс лучи назад
   и `firstHit` — даже когда в габарите конуса нет ни одной клетки стены или рампы. Цена растёт линейно с числом
   танков на экране.

### Решение

1. `extrusion.js` — хелпер кеша камеры:
   ```js
   // Камера, по которой меш уже посчитан. База и высоты меша неизменны,
   // поэтому при той же камере вершины и UV те же — пересчёт и перезаливка
   // буферов на каждый кадр неподвижной камеры не нужны
   function sameCamera(slice, camera, bleedPx) {
     if (
       slice.cameraX === camera.x &&
       slice.cameraY === camera.y &&
       slice.cameraScale === camera.scaleX &&
       slice.cameraBleed === bleedPx
     ) {
       return true;
     }

     slice.cameraX = camera.x;
     slice.cameraY = camera.y;
     slice.cameraScale = camera.scaleX;
     slice.cameraBleed = bleedPx;

     return false;
   }
   ```
   - `updateWallMesh`: первой строкой `if (sameCamera(slice, camera, bleedPx)) { return; }`;
   - `updateHeightMesh`: первой строкой `if (sameCamera(slice, camera, 0)) { return; }`;
   - `orderWallMesh`: отдельный кеш только по `x`/`y` (поля `slice.orderX`/`slice.orderY`): при той же точке
     камеры — `return false` без цикла по квадам.
   Каждый срез в `_slices` — свой объект, поэтому поля кеша у всех свои. Порядок вызовов в `MapLayer.render` не
   менять.
2. `src/client/lighting/lightMath.js` — чистая функция:
   ```js
   // Есть ли ненулевая клетка сетки `cells` (`cols × rows`, построчно) в
   // прямоугольнике клеток [col0..col1] × [row0..row1] (включительно,
   // обрезается по сетке). Дешёвая проверка «рядом с конусом нет
   // препятствий» до обхода лучами
   export function anyCellIn(cells, cols, rows, col0, row0, col1, row1) { ... }
   ```
3. `createLighting.js`, `occlusionOf`: после вычисления `sx`, `sy`, `cellW`, `cellH` и **до** `obstaclesFor`/`coneFan`
   посчитать мировой AABB прямоугольника текстуры конуса: вдоль оси от `-alongBack` (`asset.margin * sx`) до
   `alongMax` (`(width - asset.margin) * sx`), поперёк `±acrossMax` (`(height / 2) * sy`); углы — `origin +
   along·(cos, sin) + across·(−sin, cos)`. Перевести AABB в клетки (`Math.floor(min / cell) - 1` …
   `Math.floor(max / cell) + 1` — запас в клетку на кромки). Если `anyCellIn` ложна и для
   `map.blockers.get(level)`, и для `map.rampCells.get(level)?.cells`, то закешировать и вернуть
   `{ key, texture: asset.texture, shape: null, hit: null }` без лучей. Это эквивалентно полному расчёту: без
   препятствий `coneFan` даёт `clipped = false` (→ `shape: null`), а `firstHit` — `null`, так как длина оси
   `light.radius ≤ alongMax`.

### Тесты

- `tests/client/parts/map/extrusion.test.js`:
  - `it('та же камера — вершины грани не пересчитываются')`: после `updateWallMesh(slice, camera, 2)` записать в
    `slice.target.vertices[0]` метку `12345`; повторный вызов с той же камерой метку сохраняет; вызов со сдвинутой
    камерой её перезаписывает;
  - то же для `updateHeightMesh` (клин рампы) и `orderWallMesh` (при той же камере возвращает `false`, индексы не
    тронуты).
- `tests/client/lighting/lightMath.test.js`: `anyCellIn` — пустая сетка, клетка внутри, на границе, вне,
  прямоугольник за краем сетки (обрезка).
- `tests/client/lighting/createLighting.test.js`, блок `describe('lighting: фары и стены')` (≈ стр. 1160) и
  `'lighting: фары и рампы'` (≈ стр. 1405): существующие тесты зелёные. Добавить
  `it('конус вдали от стен и рамп — без веера и отсвета')` на карте, где стены есть, но далеко от фары.

### Документация

`docs/en|ru/architecture.md`, абзац «Headlights and walls» (en ≈ стр. 450–458): «Cones whose texture rectangle
touches no wall or ramp cell skip the rays.» Абзац о гранях объёмов (`grep -n "faceBleedPx" docs/en/architecture.md`):
«The mesh is recomputed only when the camera moves.»

### CHANGELOG

`### Changed`: «Volume walls and ramp wedges skip their per-frame vertex update while the camera stands still, and
headlight cones far from walls and ramps skip the occlusion rays.»

### Проверка

Общие проверки + `npm run build`. Вручную: `npm run dev`, `downtown`, ночь. Грани зданий и клинья рамп при
движении и при остановке выглядят как раньше, стык с крышей не мерцает. Фары у стены обрезаются, у горки сбоку не
светят, в открытом поле — обычный конус. DevTools → Performance (танк стоит): `updateWallMesh` в профиле кадра
практически пропал.

---

## Этап 11. Читаемость `createLighting.js` и трассера (L9) ✅ выполнен

### Проблема

1. `createLighting.js:55-68`: описание сервиса («Сервис пула зависимостей `lighting`… Два вида состояния…») идёт без
   пустой строки прямо в комментарий `lightArea` и читается как документация `lightArea`. Кроме того, в списках
   состояний нет того, что добавила задача: карты крыш, вершины объёмов, клинья рамп, сетки препятствий и кеш
   вееров (состояние карты); предметы-тени и бюджет засветов (состояние сессии).
2. `layoutLights` (`createLighting.js:813-816`): два комментария слиплись. Первые две строки («источник с `levels`
   (танк на рампе)…») относятся к `push`, а стоят над `rampTargets`.
3. `const bounces = [];` (`createLighting.js:900`) объявлен **после** замыкания `push`, которое его использует. Это
   работает только потому, что `push` вызывается позже.
4. `TracerEffect.js:74`: `this.graphics = this._graphics.values().next().value;` — алиас нигде не используется
   (`grep -rn "tracer\.graphics" src tests` пусто).
5. `ShotEffectController.js:206-217`: `new TracerEffect(..., this._onTracerComplete.bind(this), undefined, {...})` —
   позиционный `undefined`, чтобы получить конфиг по умолчанию.

### Решение

1. Переставить: `lightArea` (со своим комментарием «Область карт освещённости…») — сразу после констант
   (`BOUNCE_PULL`), затем пустая строка, затем описание сервиса непосредственно над
   `export function createLighting`. В описание дописать:
   - состояние КАРТЫ: «…вклады масок этажей и крыш, вершины объёмов и клинья рамп (`tops`, `ramps`), сетки
     препятствий фар (`map.blockers`, `map.rampCells`) и кеш вееров (`fans`)»;
   - состояние СЕССИИ: «…предметы-тени лучей (`setCaster`) и бюджет засветов на тик (`lightsAt`)».
2. В `layoutLights` первый комментарий перенести над `const push = …`, над `rampTargets` оставить только
   «клинья рамп: уровень вершины → уровни подножия…».
3. `const bounces = [];` перенести выше `const push = …` (сразу после `const spill = …`), комментарий «пятна
   раскладываются после фонарей…» оставить в `push`.
4. `TracerEffect.js`: удалить строку с `this.graphics = …`.
5. `ShotEffectController.js`: к импорту из `render.js` добавить `tracer as tracerConfig`, вместо `undefined`
   передавать `tracerConfig`.

### Тесты / Документация / CHANGELOG

Нет (без изменения поведения). Общие проверки обязаны остаться зелёными.

---

## Этап 12 (необязательный). Разделение `createLighting.js` на модули (L10) ✅ выполнен

Выполнять только по отдельному решению пользователя, после этапов 1–11, отдельным заходом.

### Проблема

`src/client/lighting/createLighting.js` — 1581 строка, в одном замыкании семь зон: маски и карты уровней,
препятствия и окклюзия фар, раскладка источников, лучи и тени, дыры, эмиссив, засветы. В проекте уже принято
выносить такие зоны: `layerSeeThrough.js` и `layerAssets.js` вынесены из `MapLayer.js` ровно по этой причине.

### Решение (публичный API сервиса не меняется)

1. `src/client/lighting/occlusion.js` — `createOcclusion({ getMap, cfg })`: внутри `fans` (WeakMap),
   `blockersVersion`, `obstaclesFor`; наружу `sync(tops, ramps)` (бывшая `syncBlockers`),
   `occlusionOf(light, asset)`, `reachesPoint(light, x, y)`, `bounceOf(light, hit)`.
2. `src/client/lighting/glints.js` — `createGlintQuery({ getMap, lights, flashes, cfg, reachesPoint })`: наружу
   `lightsAt(x, y, level, limit, exclude)` с бюджетом на тик (`glintTick`/`glintCount`) и `candidatesAt`.
3. `src/client/lighting/shafts.js` — `layoutShafts({ map, casters, cfg, asset, camera, screen, now, stage, shear })`
   и `shadowsOf` как чистые функции от переданного состояния.
4. `createLighting.js` собирает их и оставляет себе жизненный цикл карты, маски, раскладку, дыры и эмиссив (цель —
   ≤ ~900 строк).
5. Все существующие тесты (`createLighting.test.js`, 70 шт.) зелёные **без правок**: они проверяют сервис через
   публичный API. Новые юнит-тесты модулей — по желанию.
6. `docs/en|ru/architecture.md`: если там перечислены файлы `src/client/lighting/`
   (`grep -n "lighting/" docs/en/architecture.md`), дописать новые модули.

CHANGELOG — нет (рефакторинг).

**Итог.** Вынесены `occlusion.js` (448 строк; `frameOf` экспортируется отдельно — им пользуется и `quadFanOf`),
`glints.js` (95) и `shafts.js` (137). `createLighting.js` сократился с 1879 до 1302 строк: цель «≤ ~900» ставилась
от 1581 строки, а этап 14 добавил свет на клиньях рамп (`quadFanOf`, `pushRampLights`), который по плану остаётся в
раскладке. В `architecture.md` файлы `src/client/lighting/` не перечислены — документация не менялась. Все 90
тестов `createLighting.test.js` зелёные без правок.

---

## Этап 13. Грани объёмов: текстура привязана к стене, как в GTA 2 (M5) ✅ выполнен

Добавлен после ревью: ошибку нашёл пользователь. **Выполнять до этапа 10** (оба правят `updateWallMesh`).

### Проблема

Жалоба: кирпичные стены зданий при приближении к стене «утекают в землю», при отдалении «вырастают из земли».
Настоящая стена при этом не прирастает, а искажается.

Причина (`src/client/parts/map/extrusion.js`, `src/client/parts/map/layerAssets.js`):
- `buildVolumeWalls` (≈ стр. 164–281) строит на каждую открытую сторону клетки один квад: вершины 0, 1 — верхняя
  кромка (высота `k1 = (level + volume)·shear`), 2, 3 — нижняя (`k0 = level·shear`). Текстура — полоса из
  `volume.faceTileRepeats` (12) копий тайла по вертикали (`bakeWallTextures`, `layerAssets.js` ≈ стр. 303–323).
- `updateWallMesh` (≈ стр. 306–342) **каждый кадр** пересчитывает нижнюю координату `v` так, чтобы кирпич держал
  постоянный размер:
  `span = depth · (k1 − k0) / cellWorld / tileRepeats`, где `depth` — расстояние от центра камеры до грани вдоль
  её нормали. Верх полосы (`v = 0`) приколочен к верхней кромке.
- Экранная высота грани равна `depth · (k1 − k0)`: она растёт при удалении грани от центра камеры и падает при
  приближении. Кирпич держит постоянный размер, поэтому разница заполняется **новыми рядами у основания**: камера
  удаляется — ряды «вырастают из земли», приближается — «утекают в землю». Так работает выбранная на этапе 3
  задачи модель «кирпич одного размера везде», а не случайная ошибка. Поэтому исправление — смена модели.

### Как это устроено в GTA 2

Город GTA 2 собран из кубических блоков. Каждой боковой грани блока назначен свой тайл, и он натянут на грань
**ровно один раз**. Камера смотрит сверху с перспективой: у центра экрана боковые грани видны почти с ребра и
узкие, к краям экрана — длинные. Текстура сжимается и растягивается **вместе с гранью**, и число рядов кирпича на
стене не меняется никогда. Это и есть «стена искажается».

У нас проекция 2.5D (`src/client/parallax.js`): точка на высоте `z` рисуется в `p + (p − cam)·z·shear`. Вдоль
вертикали грани экранная позиция линейна по высоте. Значит, текстура, привязанная к грани (`v` линейна по
высоте), даёт ровно поведение GTA 2: ряды идут равномерно и тянутся вместе с гранью.

### Решение

**A. UV граней фиксируются при сборке и больше не меняются.** Верхняя кромка — `v = 0`, нижняя —
`v = vBottom = volume · faceTilesPerLevel / copies`, где `copies = ceil(volume · faceTilesPerLevel)` — число копий
тайла в полосе (не меньше одной). Грань высотой `volume` уровней несёт `volume · faceTilesPerLevel` копий тайла.
Дробная часть отрезается снизу: у верхней кромки картинка тайла всегда начинается с его верха, так же, как
сейчас. По ширине тайл идёт один раз, как и сейчас.

**B. Сколько копий на уровень — `volume.faceTilesPerLevel`, по умолчанию 2.** Буквально по GTA 2 (куб: высота
уровня равна клетке, `tankModel.levelHeight = 12.8` — одна клетка `downtown`) было бы 1. Но наша проекция круче,
чем в GTA 2. При `shear = 0.22` на уровень и камере `baseScale 5:1` (1920 px экрана → масштаб сцены 5,
`src/config/client.js → canvasManager.canvases.vimp`) видимая полуширина ≈ 192 мировых единицы ≈ 15 клеток. Стена
в один уровень у края экрана высотой ≈ 192 · 0.22 ≈ 42 ед. ≈ 3.3 клетки, а при отдалении камеры на скорости
(`zoomOutFactor`) ещё выше. Кирпич выглядит «квадратным» (пропорции тайла) на расстоянии
`d = faceTilesPerLevel · клетка / shear` от центра камеры:
- `1` → d ≈ 58 ед. (≈ 0.3 полуэкрана): к краю экрана кирпич вытянут до ×3.3;
- `2` → d ≈ 116 ед. (≈ 0.6 полуэкрана): на типичных расстояниях кирпич как сейчас, к центру сплющен, к краю
  вытянут до ×1.7 (в покое).

Окончательное значение выбирается визуально **вместе с пользователем** (попробовать 1, 2, 3) и записывается в
«Итог этапа» с причиной.

**C. Сетка грани — `volume.faceSegments` рядов на уровень, по умолчанию 4.** Отображение текстуры на грань у нас
билинейное: `x(u, h) = p(u) + (p(u) − cam)·k(h)`, член `p(u)·k(h)`. Квад из двух треугольников интерполирует его
аффинно и ломает вертикальные швы кирпича на диагонали. Наибольшее отклонение — `w·Δk/4`: у стены в один уровень
(`w` = 12.8, `Δk` = 0.22) ≈ 0.7 мировой единицы ≈ 3.5 экранных пикселя при масштабе 5. Когда UV пересчитывались
каждый кадр, этот излом тоже был, но с неподвижной текстурой он заметнее. Если разбить грань на
`rows = ceil(volume · faceSegments)` рядов по высоте, ошибка падает в `rows` раз: при 4 рядах меньше пикселя. Тот
же приём уже применён у клина рампы (`volume.rampSegments`). Цена — примерно 5 тыс. квадов вместо ~1700 на
`downtown`: здания по 4 ряда, канал 1, перила 2. Это в пределах батча, меши уже режутся по `MAX_WALL_QUADS`.

### Шаги

1. `src/config/render.js`, объект `volume`: удалить `faceTileRepeats` (и его комментарий), добавить:
   ```js
   // копий картинки тайла на уровень высоты боковой грани. Текстура привязана
   // к стене, как в GTA 2: кирпич тянется и сжимается вместе с проекцией
   // 2.5D — у центра экрана грань короткая и кирпич сплющен, к краю вытянут,
   // — а число его рядов не меняется. Пропорции тайла кирпич сохраняет на
   // расстоянии `faceTilesPerLevel · клетка / shear` от центра камеры (при 2
   // на downtown ≈ 116 мировых единиц, ~0.6 полуэкрана)
   faceTilesPerLevel: 2,

   // рядов сетки грани на уровень высоты. Сдвиг параллакса по грани
   // билинеен, и квад из двух треугольников ломал швы кирпича по диагонали
   // (у стены в уровень до ~0.7 мировой единицы); 4 ряда — меньше пикселя
   faceSegments: 4,
   ```
2. `src/client/parts/map/extrusion.js`:
   - Новая чистая функция рядом с `wallEdges`:
     ```js
     // Копий картинки тайла в полосе боковой текстуры: грань высотой
     // `volume` уровней несёт `volume · tilesPerLevel` копий, полоса — их
     // округление вверх, не меньше одной. Одно число на выпечку полосы
     // (`layerAssets.js`) и на UV граней. Допуск — против float
     // (0.3 · 10 = 3.0000000000000004)
     export function wallStripCopies(volume, tilesPerLevel) {
       return Math.max(1, Math.ceil(volume * tilesPerLevel - 1e-9));
     }
     ```
   - `buildVolumeWalls`: параметр `tileRepeats = 1` заменить на `tilesPerLevel = 1` и `segments = 1`. Внутри:
     - `const rows = Math.max(1, Math.ceil(volume * segments - 1e-9));`
     - `const copies = wallStripCopies(volume, tilesPerLevel);`
       `const vBottom = (volume * tilesPerLevel) / copies;`
     - `const vertsPerEdge = (rows + 1) * 2;` — на ребро пары вершин рядов сверху вниз: вершина ряда `r`
       (`r = 0` — верх), сторона `s` (`0` — точка `a`, `1` — точка `b` ребра) имеет индекс
       `e · vertsPerEdge + r · 2 + s`;
     - `base` — как сейчас (мировые координаты точек ребра, одинаковые для всех рядов);
     - новый массив `heights` (Float32Array на вершину, как у клина рампы):
       `k1 − (k1 − k0) · r / rows`;
     - `uvs`: `u = s` (0 или 1), `v = vBottom · r / rows` — **и больше они не меняются**;
     - индексы ребра — по ряду `QUAD_INDICES` от `v = e · vertsPerEdge + r · 2` (`[v, v+1, v+3, v, v+3, v+2]`),
       `6 · rows` на ребро;
     - нарезка на меши — по рёбрам: `const edgesPerMesh = Math.max(1, Math.floor(MAX_WALL_QUADS / rows));`
       (вместо `MAX_WALL_QUADS` в `slice(first, first + …)`);
     - поля среза: `target, k: kSort, base, heights, rows, k0, k1, occluder: true, walls: true, normals, centers,
       facing`. `cellWorld` и `tileRepeats` удалить. `facing` — по элементу на ребро, как сейчас.
   - `updateWallMesh(slice, camera, bleedPx = 0)` — только вершины, UV не трогать:
     ```js
     const { target, base, heights, rows } = slice;
     const vertices = target.vertices;
     const vertsPerEdge = (rows + 1) * 2;
     const bleedWorld = bleedPx && camera.scaleX ? bleedPx / camera.scaleX : 0;

     for (let i = 0, len = heights.length; i < len; i += 1) {
       const x = base[i * 2];
       const y = base[i * 2 + 1];
       const dx = x - camera.x;
       const dy = y - camera.y;
       // нахлёст под верх объёма — только у верхнего ряда
       const top = i % vertsPerEdge < 2;
       const dist = Math.sqrt(dx * dx + dy * dy) || 1e-6;
       const k = heights[i] + (top ? bleedWorld / dist : 0);

       vertices[i * 2] = x + dx * k;
       vertices[i * 2 + 1] = y + dy * k;
     }

     target.vertices = vertices;
     ```
   - `orderWallMesh`: цикл по рёбрам (`facing.length`) как сейчас; при записи индексов ребра `q` писать все его
     `rows` рядов: `for (let r = 0; r < rows; r += 1) { const v = q * vertsPerEdge + r * 2; … QUAD_INDICES … }`.
   - Комментарии: блок над `buildVolumeWalls` (≈ стр. 58–78) и над `updateWallMesh` (≈ стр. 283–305) переписать.
     Вместо истории про «полосу по глубине грани» — модель GTA 2 (UV привязаны к стене, кирпич искажается вместе с
     гранью), почему не постоянный размер кирпича (ряды прирастали и убывали у основания) и зачем ряды сетки
     (билинейный сдвиг). В комментарии `wallEdges` дописать поле `tile` (сейчас в перечне его нет).
3. `src/client/parts/map/layerAssets.js`:
   - импорт `wallStripCopies` из `./extrusion.js`;
   - `bakeWallTextures`: `const repeats = Math.max(1, Math.round(volumeConfig.faceTileRepeats) || 1);` →
     `const repeats = wallStripCopies(spec.volume, volumeConfig.faceTilesPerLevel);`, комментарий над функцией
     (≈ стр. 293–302) — про полосу из `ceil(volume · faceTilesPerLevel)` копий;
   - вызов `buildVolumeWalls`: `tileRepeats: volumeConfig.faceTileRepeats` →
     `tilesPerLevel: volumeConfig.faceTilesPerLevel, segments: volumeConfig.faceSegments`.
4. `MapLayer.render` не меняется: он по-прежнему зовёт `updateWallMesh` и `orderWallMesh`.
5. Клин рампы и его юбку (`buildRampMeshes`, `buildRampSkirt`) не трогать: юбка тянет пиксели кромки, кирпича там
   нет.
6. После правок `grep -rn "faceTileRepeats\|tileRepeats\|cellWorld" src tests docs` должен быть пуст.

### Тесты

`tests/client/parts/map/extrusion.test.js`, блок `describe('extrusion: грани монолитного объёма')`:
- В хелпере `build` заменить `tileRepeats: 4` на `tilesPerLevel: 2, segments: 4`.
- Удалить тесты старой модели: «копий тайла по высоте тем больше, чем дальше грань от камеры», «вдоль прямой
  стены ряды кирпича не расходятся», «очень длинная грань упирается в конец полосы».
- Поправить под новую раскладку вершин (`vertsPerEdge = (rows + 1)·2` вместо 4):
  - «ширина грани — ровно одна картинка тайла»: у каждой пары вершин ряда `u` = 0 и 1, у точки `a` всех рядов
    одинаковое `u`;
  - «нахлёст под верх считается в экранных пикселях»: вершина 0 — по-прежнему верх; добавить проверку, что
    вершина нижнего ряда нахлёстом не сдвигается;
  - «порядок граней» (`positionOf`): первая вершина ребра — `q * vertsPerEdge`, а не `q * 4`;
  - «длинный контур режется на несколько мешей»: число рёбер (`quadsOf`) — прежние 5000, мешей больше одного.
- Новые:
  - `it('UV грани не зависят от камеры: текстура привязана к стене')`: скопировать `uvs` после сборки, дважды
    вызвать `updateWallMesh` с разными камерами — `uvs` не изменились;
  - `it('верх грани — v = 0, низ — volume · tilesPerLevel / копий полосы')`: `volume 1, tilesPerLevel 2` → низ
    `v = 1`; `volume 0.35, tilesPerLevel 2` → `0.7`; `volume 0.25, tilesPerLevel 1` → `0.25`;
  - `it('грань делится на ceil(volume · segments) рядов, высоты рядов равномерны')`: `volume 1, segments 4` →
    10 вершин на ребро; после `updateWallMesh(slice, camera, 0)` вершина ряда `r` стоит в
    `p + (p − cam)·(k1 − (k1 − k0)·r/4)`, её `v` = `vBottom·r/4`;
  - `it('wallStripCopies: округление вверх, не меньше одной')`: `(1, 2) → 2`, `(0.25, 2) → 1`, `(0.35, 2) → 1`,
    `(1.5, 1) → 2`, `(0, 1) → 1`, `(0.3, 10) → 3`.
- `tests/client/parts/map/MapLayer.test.js`, тест сборки с `faces: true` (≈ стр. 539–557): второй вызов
  `bakeTileLayer` (полоса) получает `map` из `wallStripCopies(volume, volume.faceTilesPerLevel)` строк.

### Документация

- `docs/en|ru/configuration.md`, таблица `volume`: в строке `faces` (en ≈ стр. 234) заменить описание полосы «по
  глубине грани» на модель GTA 2. Предложение для en: «every tile gets its own side texture, a strip of
  `ceil(volume · faceTilesPerLevel)` copies of its image, fixed to the wall like a GTA 2 block face: the tile spans
  the wall once across and `volume · faceTilesPerLevel` times down, so bricks stretch and squeeze with the
  projection (flattened near the screen centre, elongated toward its edges) and no rows appear or vanish at the
  base». Строку `faceTileRepeats` заменить двумя: `faceTilesPerLevel` (смысл, формула расстояния «квадратного»
  кирпича `faceTilesPerLevel · cell / shear`, выбранное значение) и `faceSegments` (ряды сетки, зачем).
- `docs/en|ru/architecture.md`, пункт «Volumes shift with the camera and occlude» (en ≈ стр. 314–320):
  «textured from a strip of `volume.faceTileRepeats` copies … so bricks keep one size … every vertex and its
  vertical UV recomputed per frame» → «textured from its tile's own strip with UVs fixed to the wall
  (`volume.faceTilesPerLevel` copies per level of height, like a GTA 2 block face), split into
  `volume.faceSegments` rows per level so the bilinear parallax does not bend the brick joints; only the vertices
  are recomputed per frame (`updateWallMesh`)».

### CHANGELOG

- `### Fixed`: «Brick walls no longer sink into the ground as the camera approaches them or grow out of it as it
  moves away: a volume's side texture is fixed to the wall and stretches with the 2.5D projection, as in GTA 2.»
- `### Changed`: «Render config: `volume.faceTileRepeats` is replaced by `volume.faceTilesPerLevel` (tile copies
  per level of wall height) and `volume.faceSegments` (mesh rows per level).»

### Проверка

Общие проверки + `npm run build`. Вручную: `npm run dev`, `downtown`, днём и ночью:
1. Подъехать к кирпичному зданию и отъехать от него (в т. ч. на скорости, когда камера отдаляется): число рядов
   кирпича на стене **не меняется**, стена только сжимается и вытягивается.
2. Вертикальные швы кирпича прямые, излома на диагонали грани нет.
3. Углы зданий: соседние грани сходятся без щелей. Стены канала (`volume 0.25`) и перила уровня 1 (`0.35`)
   выглядят без артефактов, стык грани с крышей не мерцает (`faceBleedPx`).
4. Подобрать `faceTilesPerLevel` вместе с пользователем (1, 2, 3), значение и причину записать в «Итог этапа»;
   при изменении — обновить комментарий в `render.js` и таблицу `configuration.md`.
5. DevTools → Performance: время кадра на `downtown` не выросло заметно (вершин примерно втрое больше, UV больше
   не пересчитываются).

### Итог этапа

`faceTilesPerLevel = 2` (по умолчанию) — принят пользователем при визуальной проверке на `downtown`: число рядов
кирпича при движении камеры не меняется, стена только сжимается и вытягивается. `faceSegments = 4`. Проверки:
`npx eslint .` — чисто, `npm test` — 893/893, `npm run build` — собран.

---

## Этап 14. Фары и выстрелы у стены: свет на грани, попадание в грань (M6, M7, M8) ✅ выполнен

Добавлен после ревью: ошибки нашёл пользователь. Выполнять **раньше этапов 11 и 12**.

### Проблема

Жалобы: (1) фары, направленные на стену, не освещают её, а светят как бы под неё; (2) выстрелы в стену попадают
не в неё, а под неё.

**Общая причина.** Свет и выстрел считаются в плоскости пола. Стена для них — клетки её следа на полу. Луч фары
(`lightMath.castRay`, веер `coneFan`) и луч выстрела хоста (`core/src/tanks.rs` ≈ 1431–1490:
`impact = origin + dir·distance`, округление до 0.1) останавливаются на кромке следа, то есть на **подножии**
стены. Видимая стена — это другое: грань объёма от подножия (`k0 = L·shear`) до верха (`k1 = (L + volume)·shear`)
и верх-крышка. Всё это лежит в перекрывателе `levelZ(5, L)` (`layerAssets.js`, `OCCLUDER_BASE_Z`).

**Фары (M6).**
- Карта освещённости уровня (`levelZ(40, L)`, multiply поверх перекрывателя) лежит в проекции пола. Пиксель над
  гранью в ней соответствует клеткам следа стены, а туда свет не дошёл. Поэтому видимая грань, обращённая к
  фаре, остаётся в полумраке. Верх объёма закрыт полумраком намеренно (`setTops`). Итог: свет кончается ровно на
  подножии, стена не освещается.
- При камере за стеной (упреждение камеры движка `lookAheadFactor` уводит центр на ~30 ед. вперёд на скорости, см.
  `plan/done/night-city-fixes.md`, этап 4) стена вытягивается навстречу танку. Её верх нависает над подножием, и
  освещённый пол у стены уходит под крышу — «светят под неё». Это геометрически честно: обращённая к танку грань
  с такой камеры не видна. Здесь не исправляется, см. «За рамками этапа».

**Выстрелы (M7).**
1. Конец трассера (`W1_END_X/Y`) — точка на подножии. Искры попадания (`ImpactEffect`) — ребёнок контроллера
   `levelZ(2, L)` (`ShotEffectController.js`, `SHOT_BASE_Z`), то есть **под** перекрывателем: половину облака
   искр закрывает грань, и видна только та часть, что на полу перед стеной.
2. Ночью куски трассера лежат в `levelZ(45, L)` (эмиссив, над всем). При камере за стеной подножие спрятано под
   нависшей крышей, а трассер рисуется **поверх крыши** до этого подножия и «уходит под здание».
3. `TracerEffect.shiftTo` (≈ стр. 104–121) переносит луч целиком вслед за дулом (`_followMuzzle`). Танк, который
   едет к стене со скоростью 260 ед./с, за 45–80 мс пролёта сдвигает конец луча до ~21 ед. (≈ 1.6 клетки)
   **внутрь** следа стены. Перенос целиком выбран намеренно (комментарий у `shiftTo`: у танка вплотную к стене
   дуло уже в стене, и перестроение к неподвижной цели ломалось), поэтому решение — не отказ от переноса, а
   ограничение конца гранью.

### Решение

**A. Фары: засветка грани (wash).** Часть луча фары, упёршаяся в стену, «заворачивается» на её видимую грань. Для
каждой пары соседних лучей веера, упёршихся в одну и ту же грань, строится квад:
- низ — точки упора на подножии (высота `L`, проекция пола — свет стыкуется с концом веера);
- верх — те же точки на высоте `L + h`, где `h = min(wash.height, объём стены)`;
- UV низа — точка упора в текстуре конуса (та же яркость, что у конца веера); UV верха — **конец того же луча**
  (`точка упора + dir·(reach − d)`, где яркость текстуры `coneProfile(1) = 0`).
Получается естественный спад: у подножия грань светится так же, как пол перед ней, выше гаснет. Квад рисуется,
только если грань смотрит на центр проекции (`n·(cam − p) > 0`), — иначе она под крышей. Квады лежат в карте
освещённости уровня фары, аддитивно, поверх них рисуются вершины объёмов (`tops`), так что на крышу свет не
попадает.

**B. Выстрелы: видимый конец на грани.**
- Сервис `volumes` (новый, как `rampRuns`/`surfaces`): высота объёма по клетке уровня, от `MapLayer`.
- Попадание в стену распознаётся на клиенте: конец луча лежит на кромке клетки (допуск 0.15 ед. — хост округляет
  до 0.1), а клетка за кромкой по ходу луча — объём уровня конца.
- Высота полёта пули `tracer.height` (уровни) — высота ствола модели. Грань смотрит на центр проекции — конец
  трассера и искры рисуются на грани на этой высоте, **над перекрывателем** (`levelZ(OCCLUDER_BASE_Z + 0.5, L)`,
  ниже карты освещённости). Грань отвёрнута (камера за стеной) — трассер обрезается на **силуэте крыши**
  (верхняя кромка грани в проекции `k1`), искры остаются под перекрывателем и прячутся под крышей.
- `shiftTo` не пускает конец луча за линию грани: после переноса длина обрезается по ней.

### Шаги

**14.1. Общая геометрия грани** — новый чистый модуль `src/client/wallFace.js` (без PixiJS):
```js
// Геометрия видимой грани стены для эффектов у стены: свет фар и попадание
// выстрела. Стена в физике и в лучах — след клеток на полу, а видимая стена —
// грань объёма от подножия до верха (`extrusion.js`). Здесь — какую грань
// задел луч, видна ли она из центра проекции и где на ней рисуется точка.

// Грань, на подножии которой лежит конец луча `(x, y)` с направлением
// `(dx, dy)`: конец на кромке клетки (допуск `tolerance`, мировые единицы).
// `{ axis: 'x' | 'y', coord, nx, ny }`: axis 'x' — кромка x = coord, нормаль
// (nx, ny) смотрит навстречу лучу. null — конец не на кромке.
// На углу берётся ось, по которой луч идёт круче (с неё он и вошёл)
export function edgeFace(x, y, dx, dy, cellW, cellH, tolerance) { … }

// Видна ли грань из центра проекции: смотрит на камеру
export function faceIsFront(face, x, y, camera) {
  return face.nx * (camera.x - x) + face.ny * (camera.y - y) > 0;
}

// Мировая точка, которая в проекции высоты `kBase` рисуется там же, где
// точка (x, y) в проекции `kRaised`: контейнер куска трассера стоит в
// проекции пола, а конец обязан лечь на грань на высоте ствола.
// q = (p·(1 + kRaised) − cam·kRaised + cam·kBase) / (1 + kBase)
export function raisedPoint(x, y, camera, kBase, kRaised) { … }

// Расстояние вдоль луча (x0, y0) + (dx, dy)·t, на котором его рисунок в
// проекции `kBase` пересекает линию грани, нарисованную на высоте `kLine`
// (силуэт верха стены). null — луч параллелен грани
export function crossingDistance({ x0, y0, dx, dy, face, camera, kBase, kLine }) { … }
```
Формула `crossingDistance` для `axis: 'x'`: линия `X = coord + (coord − cam.x)·kLine`; рисунок луча
`x(t) = x0 + dx·t + (x0 + dx·t − cam.x)·kBase`; `t = (X + cam.x·kBase − x0·(1 + kBase)) / (dx·(1 + kBase))`,
`null` при `|dx| < 1e-9`. Для `'y'` — то же по `y`.

**14.2. Сервис `volumes`** — новый `src/client/volumes.js`:
```js
// Сервис пула зависимостей `volumes`: высоты объёмов карты по клеткам уровней
// (стены зданий, канала, перила). Пишут статические слои `Map` (MapLayer —
// у него `data.volume` и грид), читают эффекты, которым нужно знать, где
// стоит видимая стена и какой она высоты (попадание выстрела в грань).
// По экземпляру на ядро (hooks.services), как levelView
export function createVolumes() {
  // owner -> { level, cells, volume }
  const owners = new Map();
  let cellW = 0;
  let cellH = 0;
  // level -> Map('col,row' -> volume): пересобирается лениво после правок
  let grids = null;

  return {
    // вклад слоя: клетки его тайлов и высота объёма в уровнях
    setLayerVolume(level, cells, volume, owner, { step, scale }) { … grids = null; },
    release(owner) { … grids = null; },
    // высота объёма в мировой точке уровня; 0 — объёма нет
    heightAt(level, x, y) { … },
    cellSize() { return { cellW, cellH }; },
  };
}
```
`cellW = step · baseScale(scale).x` (`tileGrid.baseScale`), `cellH` — по `y`. При нескольких слоях на клетке
берётся наибольшая высота.
Подключение:
- `src/client/index.js`: `serviceNames` — добавить `'volumes'`; в `hooks.services(core)` — `volumes: createVolumes()`.
- `src/config/client.js` → `componentDependencies`: `volumes: ['Map', 'ShotEffect']` с комментарием, как у
  соседних.
- `src/client/parts/map/MapLayer.js`: в конструкторе (рядом с `setVolumeTops`)
  `this._volumes = dependencies.volumes || null;`, при `this._volume > 0` —
  `this._volumes?.setLayerVolume(this._level, cellsOfTiles(this._map, this._tiles), this._volume, this, { step: this._step, scale: data.scale });`.
  В `destroy()` — `this._volumes?.release(this); this._volumes = null;`.
- Сервис освещения держит те же данные в своих `tops` (`setVolumeTops`). Этот дубль осознанный, объединять его —
  кандидат этапа 12 (освещение читает `volumes`). Отметить это в комментарии `createVolumes`.

**14.3. Засветка грани фарами** (`src/client/lighting/`):
1. `render.js → lighting.headlights` — новый ключ:
   ```js
   // засветка стены: часть луча, упёршаяся в стену, «заворачивается» на её
   // видимую грань — от подножия вверх на `height` уровней (не выше самой
   // стены); яркость — от точки упора до конца луча, то есть гаснет вверх.
   // intensity — множитель, 0 — без засветки
   wash: { height: 0.6, intensity: 1 },
   ```
2. `createLighting.js`, `syncBlockers`: сетка `map.blockers` хранит **высоту** объёма —
   `grid ||= new Float32Array(cols * rows); grid[i] = Math.max(grid[i], volume)` (`volume` уже есть в записях
   `tops`). В `obstaclesFor` `grid[index] === 1` → `grid[index] > 0`. `anyCellIn` (этап 10) сравнивает `!== 0` —
   работает без правок. Комментарий у `blockers` в `initMap` поправить («объём клетки в уровнях, 0 — пусто»).
3. `lightMath.coneFan` дополнительно возвращает `reaches` (`Float32Array` — предел каждого луча до края
   прямоугольника текстуры, переменная `reach` в цикле) и `forward` (число лучей вперёд, `count`): засветке нужна
   полная длина луча. Существующие тесты `coneFan` не меняются, добавить проверки новых полей.
4. `lightMath.js` — чистая функция:
   ```js
   // Засветка грани стены конусом фары. Для соседних лучей веера вперёд,
   // упёршихся в одну грань (`edgeFace`, клетка за кромкой — стена), — квад:
   // низ на подножии, верх на высоте `min(height, объём стены)`. UV низа —
   // точка упора, верха — конец того же луча: яркость гаснет вверх.
   // Возвращает { base, heights, uvs, indices, normals, mids } или null:
   // base — мировые точки (4 на квад: верх a, верх b, низ a, низ b, как у
   // граней `extrusion.js`), heights — высота вершины в уровнях над полом
   // стены, normals/mids — нормаль и середина подножия квада (видимость)
   export function wallWash({ x, y, points, reaches, forward, uvOf, wallAt, cellW, cellH, height }) { … }
   ```
   Луч `i` (`1 ≤ i ≤ forward`) «упёрся в стену», если `d_i < reaches[i] − 1e-6`, `edgeFace(p_i, dir_i, cellW,
   cellH, 1e-3)` не `null` и `wallAt(p_i + dir_i·0.01·min(cellW, cellH)) > 0`. Упор в рампу (`rampBlocks`) —
   не стена, засветки нет. Квад между `i` и `i + 1`, только если у обоих лучей одна ось и одна координата грани.
   `uvOf` — `fanUvs` для одной точки: вынести из `fanUvs` внутреннюю формулу в функцию и переиспользовать.
5. `occlusionOf`: после `coneFan`, если `cfg.headlights.wash?.intensity > 0`, посчитать
   `wash: wallWash({ …, wallAt: (wx, wy) => высота из map.blockers уровня, height: cfg.headlights.wash.height })`
   и положить в `result` (кеш тот же — ключ уже содержит `blockersVersion`). В ветке «препятствий рядом нет» —
   `wash: null`.
6. `occludeItem`: `item.wash = occlusion.wash`. `layoutLights → push`: засветка кладётся **только** в карту уровня
   самой фары (стены — препятствия её уровня): `perWash` (level → items), элемент
   `{ wash, level: light.level, texture: item.texture, color: item.color, alpha: item.alpha * wash.intensity }`,
   если у уровня есть обычная карта. В лимит `maxLights` не входит — это та же фара.
7. `LevelLightMap.js`: пул `washPool` (меши, как `fanPool`, `blendMode 'add'`, в контейнере `lights` после
   вееров), метод `layoutWashes(items, camera, shear)`:
   - буферы UV и индексов заливаются, только когда сменилась засветка (`mesh.wash !== item.wash`);
   - вершины — каждую раскладку: `p + (p − cam)·k`, `k = (item.level + heights[v])·shear` (оверлей в мировых
     координатах с единичным трансформом, см. этап 4 задачи);
   - видимость квада: `nx·(cam.x − mx) + ny·(cam.y − my) > 0`. Невидимый квад получает вырожденные индексы (все
     шесть — его первая вершина), переписываются они только при смене видимости, как в `orderWallMesh`;
   - `destroy()` уничтожает геометрию мешей засветки (как у вееров).
   Вызов — в `layoutLights`, в цикле по картам сразу после `levelMap.layout(...)`, только для обычных карт
   (`!levelMap.roof`): `levelMap.layoutWashes(perWash.get(levelMap.level) || [], camera, shear)`.

**14.4. Выстрел: видимый конец на грани** (`src/client/parts/effects/shot/`):
1. `render.js → tracer` — новый ключ:
   ```js
   // высота полёта пули над полом, уровни: высота ствола модели
   // (`tankModel.barrelHeight` 8 px · size 3 / 10 = 2.4 мировой единицы при
   // `tankModel.levelHeight` 12.8). На ней выстрел упирается в ГРАНЬ стены,
   // а не в её подножие на полу
   height: 0.19,
   ```
2. `OCCLUDER_BASE_Z` перенести из `layerAssets.js` в `src/client/levelZ.js` (`export`, с тем же комментарием),
   импортировать в `layerAssets.js` и в `ShotEffectController.js`. В контроллере:
   `const WALL_HIT_BASE_Z = OCCLUDER_BASE_Z + 0.5;` с комментарием «попадание в видимую грань — над перекрывателем
   (иначе грань закрывает искры), под картой освещённости».
3. `ShotEffectController`:
   - конструктор: `this._volumes = dependencies.volumes || null;`;
   - `run()`, до `tracerPieces`: если `this.hit && this._volumes`, найти грань — конец на кромке
     (`edgeFace(end, dir, cellW, cellH, 0.15)`, размеры — `volumes.cellSize()`) и
     `volumes.heightAt(this.endLevel, end + dir·0.01·cell) > 0`. Запомнить `this._wall = { face, volume }`.
   - при грани и камере (`this._levelView?.camera() ?? cameraCenter(this.parent, this._renderer)`):
     `kBase = endLevel·shear`;
     - `faceIsFront` → конец трассера `raisedPoint(end, camera, kBase, (endLevel + tracer.height)·shear)`,
       `this.zIndex = levelZ(WALL_HIT_BASE_Z, endLevel)`;
     - иначе → `t = crossingDistance({ …, kLine: (endLevel + volume)·shear })`, конец трассера —
       `start + dir·clamp(t, 0, dist)`; `zIndex` прежний (`SHOT_BASE_Z`).
   - `tracerPieces(...)` и `new TracerEffect(...)` получают **этот** конец и его длину. Точка удара для искр
     (`endPositionX/Y`, якорь `mapDynamics`) остаётся исходной.
   - `TracerEffect` получает `options.stopLine = { axis: face.axis, coord: координата конца трассера по оси }`.
4. Искры попадания в стену — в своём слое. В `_onTracerComplete`, если `this._wall`: завести
   `this._impactLayer` (`Container` на `this.parent`, `label 'shot-impact'`, `eventMode 'none'`) и положить
   `ImpactEffect` туда (он позиционирован в мировых координатах точки удара). В `onRender` каждый кадр:
   `applyParallax(this._impactLayer, camera, (endLevel + tracer.height)·shear, 1)`; `zIndex` — по стороне грани:
   `faceIsFront(...) ? levelZ(WALL_HIT_BASE_Z, endLevel) : levelZ(SHOT_BASE_Z, endLevel)` (отвёрнутая грань — искры
   под крышей); `alpha`/`tint` — как у слоёв трассера (`alphaFor`/`tintFor`). `destroy()` уничтожает слой вместе с
   `this.layers`.
5. `TracerEffect.shiftTo`: после переноса, если задан `stopLine` и составляющая направления по его оси не нулевая,
   `t = (coord − start[axis]) / n[axis]`; при `t < totalDist` → `totalDist = Math.max(0, t)`, конец
   `= start + n·totalDist`. Длина только укорачивается. В комментарий `shiftTo` дописать: «попадание в стену —
   конец не заходит за её грань, а скользит по ней».

### Тесты

- Новый `tests/client/wallFace.test.js`: `edgeFace` (кромка `x`, кромка `y`, не на кромке → null, угол → ось
  большей составляющей, нормаль навстречу лучу), `faceIsFront`, `raisedPoint` (рисунок `q` в `kBase` совпадает с
  рисунком `p` в `kRaised` — через `offsetPoint`), `crossingDistance` (рисунок точки на `t` лежит на линии грани;
  параллельный луч → null).
- Новый `tests/client/volumes.test.js`: `setLayerVolume`/`heightAt` (клетка, вне сетки → 0, два слоя → большая
  высота), `release`, пересборка после правок.
- `tests/client/lighting/lightMath.test.js`: `coneFan` отдаёт `reaches`/`forward`; `wallWash`: стена поперёк
  конуса → квады между соседними упёршимися лучами; `heights` = `min(height, объём)`; UV верха — конец луча; упор
  в рампу (`wallAt → 0`) → null; лучи в две разные грани (угол) → квад через угол не строится.
- `tests/client/lighting/createLighting.test.js`, блок `describe('lighting: фары и стены')`: у фары, упёршейся в
  стену, в оверлее уровня есть видимый меш засветки; в открытом поле его нет; камера за стеной → меш скрыт
  (индексы вырождены); засветка только в карте уровня фары; `wash.intensity: 0` → нет засветки;
  `obstaclesFor` по-прежнему видит стены (сетка высот).
- `tests/client/parts/effects/ShotEffectController.test.js` (заглушка `volumes` с `heightAt`/`cellSize`):
  - грань к камере → `zIndex` контроллера `levelZ(WALL_HIT_BASE_Z, L)`, конец трассера — `raisedPoint`;
  - грань от камеры → трассер короче исходного луча и кончается на силуэте, `zIndex` прежний;
  - попадание не в стену (`heightAt → 0`) и промах — поведение прежнее;
  - слой искр: проекция `(L + tracer.height)·shear`, `zIndex` меняется при смене стороны грани между кадрами,
    слой уничтожается в `destroy`.
- `tests/client/parts/effects/TracerEffect.test.js`: `shiftTo` со `stopLine` обрезает конец по линии, без него —
  прежний перенос; длина не растёт обратно.
- `tests/client/parts/map/MapLayer.test.js`: слой с объёмом регистрируется в `volumes` и снимается в `destroy`.
- `tests/config/client.test.js`: `volumes` есть и в `serviceNames`, и в `componentDependencies` (по образцу
  теста `rampRuns`, ≈ стр. 37). `tests/config/lighting.test.js`: `headlights.wash` — положительные `height` и
  `intensity`.
- Новый тест в `tests/config/` (по образцу `landing.test.js`): `tracer.height` ≈
  `tankModel.barrelHeight · size / 10 / tankModel.levelHeight` для модели из `src/data/models.js` (допуск 0.01).

### Документация

- `docs/en|ru/architecture.md`: в перечне сервисов (≈ стр. 168 en: «The same service names…») — `volumes`;
  абзац «Headlights and walls» — засветка грани (`wallWash`, `headlights.wash`, только грани к камере, `tops`
  закрывают крышу); абзац о выстреле (сервис `shots`, трассер по уровням) — видимый конец на грани:
  `tracer.height`, над перекрывателем при грани к камере, обрезка по силуэту крыши при отвёрнутой,
  `stopLine` у `shiftTo`.
- `docs/en|ru/configuration.md`: строки `headlights.wash` (таблица `lighting`) и `tracer.height` (таблица
  `tracer`, если её нет — абзац рядом с описанием трассера: `grep -n "tracer" docs/en/configuration.md`).

### CHANGELOG

- `### Fixed`: «Headlights pointed at a wall light its visible face: the part of the beam the wall stops is folded
  onto it, fading upward, instead of the light ending at the wall's foot.»
- `### Fixed`: «A shot into a wall ends on the wall's visible face at gun height, with its sparks drawn over the
  wall; with the camera past the wall the tracer stops at the roof's edge instead of running under the building,
  and it no longer slides into the wall while the shooter drives.»
- `### Added`: «Client service `volumes`: volume heights of the map's cells per level, filled by the map layers.»

### Проверка

Общие проверки + `npm run build` и `npx vimp-contract` (новое имя сервиса — правило C4). Вручную, `npm run dev`,
`downtown`, ночью и днём:
1. Танк стоит носом к кирпичной стене (камера на танке): грань в конусе освещена — ярче у подножия, выше гаснет;
   крыша остаётся тёмной; стены сбоку и за углом не светятся (окклюзия этапа 12 задачи).
2. Танк стоит у стены канала (`volume 0.25`) и у перил уровня 1 (`0.35`): засветка не выше самой стены.
3. Выстрел в стену стоя: трассер кончается на грани чуть выше подножия, искры видны на стене, а не на полу
   перед ней.
4. Выстрел в стену на ходу к ней: конец трассера не заходит в стену.
5. Разгон к стене, пока камера не ушла за неё: трассер обрывается на кромке крыши, не рисуется поверх неё; искр
   не видно (они за стеной).
6. Выстрел в танк у стены и промах — как раньше. Выстрел с моста по стене внизу — конец на грани нижнего уровня.

### 14.5. Горка: свет фары на клине и на насыпи (M8) ✅ выполнен

Добавлено после ручной проверки 14.1–14.4: ошибку нашёл пользователь (`downtown`, ночь, танк у подножия рамп
моста `RAMP_S` и рампы парковки `RAMP_E`, носом на подъём).

**Симптом.** Танк стоит на земле перед горкой: освещён резкий прямоугольник со скруглёнными углами, его края
не совпадают с нарисованным клином — полосы вдоль бортов и верх клина тёмные, мягкого края конуса нет. Стоит
чуть заехать на горку — свет становится мягким и заливает клин целиком. Борта и верхний торец насыпи (юбка
клина) не освещаются ни в одном положении — горка ведёт себя не так, как стены и здания после 14.3.

**Причины** (проверено по коду и снимкам):
1. *Проекция.* Клин рисуется с повершинной высотой (`extrusion.js`, `buildRampMeshes` + `updateHeightMesh`:
   `p + (p − cam)·h·shear`, `h = lerp(from, to, progress)`), то есть трапецией, расширяющейся к верху. Юбка
   (`buildRampSkirt`) — борта вдоль оси и торец на верхнем конце. А карта освещённости уровня `from` лежит в
   проекции ПОЛА: пиксель клина берёт свет той точки пола, что под ним нарисована, а не своей мировой точки.
   Освещённая область — след полосы на полу (прямоугольник), нарисованный клин — трапеция, поэтому края не
   совпадают. Для верхнего уровня (`rampSpill`, контейнер `rampLights`) маска уже в проекции клина
   (`rampWedgePolygon`), но сам свет внутри неё — тоже в проекции пола.
2. *Правило рампы.* `lightMath.rampBlocks`: «вышел из полосы — стоп». Лучи, покинувшие след полосы вбок или
   через верхний торец, гаснут — клетки пола вокруг следа, которые нарисованный клин накрывает, остаются
   тёмными, мягкий край конуса обрезан по кромке следа. На «своей» полосе (`home` в `obstaclesFor`) правило
   снято — поэтому на горке свет мягкий: он растекается за след и случайно заливает трапецию.
3. *Юбка.* Луч, упёршийся в борт или торец насыпи, просто обрывается (как стены до 14.3). `wallWash` грань
   не строит: `wallAt` смотрит только сетку объёмов (`map.blockers`), рамп в ней нет.

**Решение** (как у стен в 14.3 — свет в проекции той геометрии, на которую он падает):
1. *Свет на склоне в проекции клина.* У карты уровня `from` контейнер `rampLights` уже есть (маска — клинья в
   проекции клина). Часть веера фары уровня `from`, попавшая в полосу рампы, рисуется там отдельным мешем:
   - веер (`coneFan`, мировые точки) обрезается прямоугольником полосы (клетки `lane`), полигон режется вдоль
     оси на `volume.rampSegments` отрезков на клетку — как `rampWedgePolygon`;
   - вершина проецируется высотой клина в своей точке: `k = lerp(from, to, progress)·shear`; UV — `coneUv`
     мировой точки (яркость та же, что у пола);
   - чистая функция `lightMath.rampLight({ points, lane, frame, … })` → `{ base, heights, uvs, indices }`,
     раскладка — `LevelLightMap.layoutRampLights` (пул мешей, как `layoutWashes`).
   Свет верхнего уровня на клине (`perRamp`) переводится на тот же путь вместо текущего веера в проекции
   источника.
2. *Пол под клином не светится проекцией пола.* Обычный контейнер `lights` карты уровня `from` получает
   инверсную стенсил-маску «клинья» (второй `Graphics` с тем же контуром `rampWedgePolygon`, пересчёт в
   `place`): на нарисованном клине остаётся только свет в его проекции (п. 1), пол вокруг — как раньше.
3. *Правило выхода из полосы.* `rampBlocks`: выход **вбок** (шаг поперёк оси) — не стоп, луч идёт дальше по
   полу: мягкий край конуса ложится на пол у бортов. Выход **через верхний торец** — стоп, как сейчас (пол
   под мостом тёмный). Правило «вошёл через борт/торец выше фары на `RAMP_CLEARANCE` — стоп» не меняется.
4. *Засветка юбки.* `wallAt` в `occlusionOf` возвращает `max(объём стены, высота клина над уровнем в точке)`:
   высота клина — из `map.rampCells` (полоса клетки → `lerp(from, to, progress) − level` в точке зонда).
   Тогда `wallWash` строит квады на бортах и торце насыпи тем же путём, что на стенах (`edgeFace`, UV до
   конца луча, только грани к камере). Высота верха квада — `min(wash.height, высота клина в точке упора)`.

**Тесты.**
- `lightMath.test.js`: `rampBlocks` — выход вбок не стоп, через верхний торец — стоп; `rampLight` — полигон
  внутри полосы, высоты вершин по прогрессу вдоль оси, UV = `coneUv`, веер вне полосы → null.
- `createLighting.test.js` (`describe('lighting: фары и рампы')`): танк у подножия носом на подъём — в
  `rampLights` есть меш света клина, вершины в проекции клина (у верха сдвиг больше, чем у подножия); у
  обычного `lights` есть инверсная маска клиньев; мягкий край — лучи, вышедшие из полосы вбок, дальше
  кромки следа; засветка борта насыпи при фаре, упёршейся в борт, выше `RAMP_CLEARANCE`.
- `LevelLightMap`: `layoutRampLights` переиспользует пул, геометрия освобождается в `destroy`.

**Документация.** `docs/en|ru/architecture.md`, абзац «Headlights and walls» / «Фары и стены» и абзац о
свете на рампах: свет на клине — в проекции клина, маска пола под клином, правило выхода вбок, засветка
юбки. `configuration.md` — только если появится новый ключ (не планируется).

**CHANGELOG** (`### Fixed`): «Headlights pointed up a ramp light its whole drawn slope with a soft edge, not
a sharp rectangle of its footprint, and light the ramp's embankment sides like walls.»

**Проверка.** Общие + `npm run build`. Вручную, `downtown`, ночь: танк у подножия рампы моста и рампы
парковки носом на подъём — клин освещён целиком, мягко, без тёмных полос у бортов и у верха; пол у бортов
ловит край конуса; пол под мостом за верхним торцом тёмный; фара под углом к борту насыпи — борт освещён,
гаснет вверх; танк на горке — как было.

### За рамками этапа

Когда центр камеры уходит за стену (упреждение камеры движка на скорости), обращённая к танку грань не видна:
свет у её подножия и искры по-прежнему уходят под нависшую крышу, и это геометрически верно. Убрать эффект можно
только сменой центра проекции 2.5D: считать `levelView.camera()` от своего танка, а не от центра экрана.
Правка затронет весь 2.5D (слои, объёмы, танки, эффекты) и уберёт заодно цену этапа 4 задачи («танк у стены на
скорости на миг под её верхом»). Это отдельная задача, решение — за пользователем.

---

## Итоговая проверка (после всех выполненных этапов)

```bash
npx eslint .
npm run core:test
npm run core:build
npm test -- --silent
npm run build
npx vimp-contract
npm run sim:scenarios
```

Ручной прогон `npm run dev` на `downtown` ночью, за обе команды: эстакада и мосты (дыра в плите и в ночи), крыши с
вывесками (гаснут вместе, только когда закрывают танк), фары у стен и горок, засветы и лучи фонарей, взрыв бочки
(без квадрата у воронки), ресайз окна. Затем — перенос этого файла в `plan/done/` (`git mv`, без коммита).

## Проверено — замечаний нет

- **Паритет хоста и реплики** (этапы 6–7 задачи): порядок `decay_boost` → `input_locked` → `tank_mix` →
  `apply_slick` → `boost_hold_mix` → … → `boost_dv` / `start_boost_hold` → `boost_damping_dv` совпадает
  (`tank.rs:495-639`, `predictor.rs:1081-1211`). Остатки в `LevelState` откатываются историей уровня и сбрасываются
  в `set_map` / `reset` / `change_player_data`. Сброс плоской карты в `step_level` их сохраняет.
- **Защита реплики от NaN** (bb767f8): `update` и `on_server_state` сбрасывают реплику, тесты есть.
- **Обход лучей** на NaN/Infinity завершается: `lightMath.castRay` (`!(t < maxDist)`) и `walk_ray_cells` движка
  (`while traveled <= range`). `shots.path` отсекает нулевой и нечисловой луч. Уязвимостей не найдено: новых
  сетевых входов нет, кроме координат трассера из кадра, а они проверены.
- **Освобождение ресурсов**: геометрия вееров (`LevelLightMap.destroy`), боковые текстуры граней
  (`MapLayer.destroy`, `disposeAssets`), слои трассера (`ShotEffectController.destroy`), тени и засветы
  (`Tank`/`MapObject`). id звуков — `Symbol`, проверки на истинность корректны.
- **Покрытие тестами** по этапам задачи широкое (70 тестов сервиса освещения, паритет, `sim.rs`, сценарии).
- `volume.slices` при `faces: true` работает только как выключатель экструзии: это странно, но задокументировано
  (`configuration.md`), поэтому оставлено.

## Риски

1. **Этап 1**: центр дыры при `resolution 0.5` — только визуальная проверка. При смещении правку разрешения
   откатить и описать причину в комментарии.
2. **Этап 4**: текстуры обязаны остаться бит в бит — кадры и параметры фильтров не менять, сверить визуально.
3. **Этап 9**: паритет ядра. Любое расхождение в `npm run core:test` / `sim:scenarios` блокирует этап.
4. **Этап 10**: кеш по камере опирается на неизменность `base`/`heights` среза. Если в будущем меш начнут
   перестраивать на месте, кеш сбрасывать (`slice.cameraX = undefined`).
5. **Этап 12**: крупный рефакторинг — только отдельным заходом, после зелёной итоговой проверки остальных.
6. **Этап 13**: при привязанной текстуре кирпич у края экрана вытягивается, особенно на отдалённой камере. Это
   осознанная цена модели GTA 2, и её регулирует `faceTilesPerLevel`. Если пользователю не понравится ни одно
   значение, причина уже в крутизне проекции (`parallax.shear` на уровень), а её правка меняет весь 2.5D — это
   отдельная задача, не этот этап.
7. **Этап 14**: сторона грани (к камере / от неё) для трассера считается один раз при выстреле, а камера за
   45–80 мс пролёта сдвигается мало — допустимо. Для искр сторона пересчитывается каждый кадр. Попадание в
   стену распознаётся по геометрии конца луча (кромка + объём за ней): если хост когда-нибудь перестанет
   округлять конец до 0.1 или начнёт сдвигать его от стены, допуск `edgeFace` (0.15) пересмотреть.
