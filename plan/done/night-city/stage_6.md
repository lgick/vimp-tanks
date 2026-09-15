# Этап 6. Разрушаемые объекты: клиент ✅ выполнен

**Репозиторий:** `vimp-tanks`. **Зависит от:** этапа 5.
**Перед началом:** `plan/night-city/README.md` → «Общий контекст»; `docs/en/core.md` → «Map dynamics», «The shot's raycast world»;
`docs/en/architecture.md` → «Texture and particle lifecycle».

## Цель

Клиент показывает состояния пропов (цел, повреждён, обломки или копоть) и корректно предсказывает мир с разрушенными
телами: не упирается в обломки и не обрывает трассер об них.

## 6.1 Картинки состояний

1. Поля карты: `physicsDynamic[i].img` — целое состояние (как сейчас);
   `physicsDynamic[i].game.imgDamaged`, `game.imgDestroyed` — необязательные PNG (заглушки делаются на этапе 9).
   Для бочки без `imgDestroyed` используется процедурная копоть (6.2).
2. `scripts/lib/collectMissingImages.js`: учитывать `game.imgDamaged`/`game.imgDestroyed`
   (+ тест `tests/scripts/collectMissingImages.test.js`). Правило `E2` движка эти поля не видит — проверка остаётся
   за скриптом манифеста.

## 6.2 Бейкеры

- `src/client/bakers/scorchTexture.js` — пятно копоти (варианты, как у `funnelTexture`; правила `blurMargin`).
- `src/client/bakers/debrisTexture.js` — набор мелких щепок/досок для разлёта при разрушении (серый, тинтуется).
- Регистрация: `bakers/index.js`, `src/config/client.js → bakedAssets.vimp` с `component: 'Map'`.

## 6.3 `src/client/parts/map/MapObject.js`

1. `update(data)` (≈127–155) читает `data[C_STATE]`.
2. Переход состояния:
   - `0 ↔ 1` — смена текстуры на `imgDamaged` (загрузка через `Assets.load` с проверкой `this.destroyed` после `await`);
   - `→ 2` — текстура `imgDestroyed` или копоть; `zIndex = levelZ(1, level)` (под танками); разовый разлёт обломков
     (как `ImpactEffect`: несколько спрайтов из `debrisTexture`, в мировых координатах) и звук `propBreak`;
   - `2 → 0` (новый раунд) — исходная текстура и `zIndex`.
3. Альфа, тинт и параллакс — без изменений (существующий `render()`).
4. Первый кадр со `state = 2` (подключение посреди раунда) — сразу состояние обломков, без разлёта и звука.
5. Текстуры ассетов не выгружать (`Assets.unload` запрещён — `architecture.md`).

## 6.4 Радар

Правок нет. `MapRadar` тела карты не отражает: его `update() {}` пустой (`src/client/parts/MapRadar.js` ≈84), строки
`c1` он получает, но не читает, поэтому скрывать разрушенные тела не на чем. Это совпадает с решением «радар не
меняется» (README). Отображение пропов на радаре — отдельная функция, в этот план не входит.

## 6.5 Предсказание (`core/src/client/map_dynamics.rs`, `predicted_set.rs`, `shot.rs`)

1. **`ServerState` не менять.** Это общая структура фреймворка предсказанного мира. Её собирают литералом
   `remote_tanks.rs` ≈230 (удалённые танки, к пропам отношения не имеют), `map_dynamics.rs` ≈508 и `predicted_set.rs`
   ≈141, 215, 654, 683, 796, 824 (в том числе тесты). Новое поле ломало бы сборку во всех этих местах, а у удалённых
   танков было бы всегда нулём.
   Вместо этого `PredictedBody` (`predicted_set.rs` ≈87) получает поле `collidable: bool`, `true` в `PredictedBody::new`
   (≈125). Литералом `PredictedBody` не собирается, поэтому другие места не затрагиваются. Выставляет поле **только**
   `MapDynamics` — `collidable = row[FIELD_STATE] < 2`:
   - в `update` (≈271–308) — из интерполированной строки, **только внутри ветки `if !body.is_predicted()`**, рядом с
     `body.level`. Предсказанным телом владеет симуляция, а интерполированная строка отстаёт на буфер: запись в него
     вернула бы `collidable = true` телу, которое `begin_reconcile` уже пометил разрушенным по сырому кадру, и реплика
     снова упёрлась бы в обломки до конца буфера;
   - в `snapshot_rows` (≈479–529) — строка возвращает `collidable` рядом с `level`;
   - в своём `begin_reconcile` (≈323) — **до** `self.set.begin_reconcile`, тем же проходом, что уже ставит
     `set_level_state`: переигранные шаги видят авторитетное значение с первого шага.
   Удалённые танки и фреймворк не меняются.
2. `capture` (≈345–411): тела с `!collidable` не захватываются; уже захваченные понижаются в `Follow`
   (`demote_idle`/`release_predicted`).
3. Контакты: маски тел собирает `Predictor::resolve_world` (`predictor.rs` ≈1256,
   `masks.extend(bodies.iter().map(|body| body.collision_mask()))`). Править `PredictedBody::collision_mask`
   (`predicted_set.rs` ≈198): при `!collidable` — пустая группа, и тело не участвует в контактах. Отдельной проверки
   в `resolve_world` не добавлять — одно место на правило.
4. `sim_boxes` (≈208): тела с `!collidable` исключаются — локальный трассер не обрывается об обломки.
5. `render_data` — пишет `state`.
6. Осознанное ограничение: пока кадр с `state = 2` не пришёл, реплика сталкивается с забором, уже сломанным на хосте
   (~`interpolation.delay`). Записать в `core.md`.

## 6.6 Звуки

`src/config/sounds.js`: `propBreak` (на существующий файл `hit` с другой громкостью/приоритетом) и, при необходимости,
`fenceBreak`. Взрыв бочки звучит через `ExplosionEffect` (строка `w2e`), отдельный звук не нужен.

## 6.7 Тесты

- `tests/client/parts/map/MapObject.test.js`: смена текстур по состояниям, `zIndex` обломков, возврат при `0`,
  отсутствие эффекта при первом кадре со `state = 2`, защита `destroyed` после `await`.
- Rust: `map_dynamics.rs` — разрушенное тело не захватывается, понижается, не в `sim_boxes`;
  `predicted_set.rs` — `collision_mask` пустая при `!collidable`, `PredictedBody::new` даёт `collidable = true`;
  `map_dynamics.rs` — `update` и `MapDynamics::begin_reconcile` выставляют `collidable` из `FIELD_STATE` строки кадра
  (в `begin_reconcile` — до `PredictedSet::begin_reconcile`); `update` **не** трогает `collidable` предсказанного тела:
  тело в `Predicted`, сырой кадр дал `state = 2`, интерполированная строка ещё с `state = 0` → после `update` поле
  остаётся `false`; удалённые танки остаются `collidable`;
  `shot.rs` — луч проходит сквозь разрушенное тело.
- `tests/core/clientCore.test.js`: кадр с `state` декодируется, `render_rows` содержат `state`.

## 6.8 Документация и журнал

- `docs/en|ru/architecture.md`: состояния `MapObject`, владение текстурами состояний.
- `docs/en|ru/core.md`: разрушенные тела в предсказании и в `sim_boxes`, ограничение задержки.
- `docs/en|ru/extending.md`: рецепт «New prop» (поля карты, картинки, конфиг `props`, проверки).
- `docs/en|ru/configuration.md`: новые бейкеры и звуки.
- `CHANGELOG.md` → `### Added`.

## Критерии готовности

Проверки из README зелёные; `npm run build` не находит отсутствующих картинок; в `npm run dev` на фикстурной карте
(или временно в `garden`, без сохранения) забор ломается, бочка взрывается, в новом раунде всё возвращается.
