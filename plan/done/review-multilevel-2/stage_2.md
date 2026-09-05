# Этап 2 (E). Движок: высота уровня, коллайдеры рампы, звук — Д3, Д9, Д14 ✅ выполнен (опубликованы `vimp-engine-core 0.13.0` и `vimp-engine 0.32.0`)

**Репо:** E (`/Users/dmitry/Sites/my/vimp`). **Зависимости:** этап 0.
**Заканчивается публикацией** `vimp-engine-core 0.13.0` и `vimp-engine 0.32.0`
— без неё этап 3 не стартует.

Все правки аддитивны: карта без новых полей ведёт себя бит-в-бит как раньше.

---

## 2.1 `levelHeight` — высота уровня в мировых единицах

### Проблема

`RampSample::slope` (`packages/engine/core/src/map.rs:981`):

```rust
slope: rise / span.max(f32::EPSILON),
```

`rise` — в уровнях, `span` — в мировых единицах. Итог — «уровней на пиксель»
(0.0087…0.039 на реальных картах), а все потребители (`climbGravity`,
`climbMaxSpeedFactor` в T `src/config/game.js`, `GRADE_SQUASH_GAIN` и
`DUST_CONFIG.minGrade` в партах) написаны под безразмерный тангенс. Эффекты
подъёма — доли процента.

### Решение

Новое необязательное поле корня карты `levelHeight` — сколько мировых единиц
занимает один уровень по высоте. Дефолт — размер тайла (`step * scale`), то
есть подъём «уровень на тайл» даёт уклон 1.0.

**Файлы и шаги:**

1. `packages/engine/core/src/map.rs`, `struct MapConfig` — добавить

   ```rust
   /// Высота ОДНОГО уровня в мировых единицах. Нужна, чтобы уклон рампы был
   /// безразмерным (rise * level_height / span), а не «уровней на пиксель».
   /// None — размер тайла (step * scale).
   #[serde(default)]
   pub level_height: Option<f32>,
   ```

   Сериализация camelCase уже настроена на структуре — проверить, что поле
   принимается как `levelHeight`.

2. `MapLevels` — сохранить эффективное значение (`level_height: f32`) рядом с
   `tile_size`; заполняется в `MapLevels::build` (`map.rs:726`) из аргумента.
   Сигнатура `build` меняется — поправить все вызовы (`GameMap::create`
   `map.rs:1172`, клиентская сторона `core/src/client/mod.rs`, тесты
   `map.rs:1602+`, тесты игры `T core/src/level.rs:352+`). Отклонение по
   сигнатуре записать: оно уедет в T этапом 3.

3. `ramp_at` (`map.rs:960-990`):

   ```rust
   slope: rise * self.level_height / span.max(f32::EPSILON),
   ```

   Тесты `ramp_sample_reports_slope_and_direction` (`map.rs:2027-2057`)
   пересчитать **осознанно**: при `level_height == tile_size` уклон «1 уровень
   на 6 тайлов» становится 1/6, а не 1/60.

4. `validate_levels` (`map.rs:161-316`): `levelHeight`, если задан, обязан
   быть конечным и `> 0`. Сообщение в том же стиле, что у `volumes`
   (`map.rs:322-345`).

5. `EngineConfig` (`packages/engine/core/src/config.rs`) — не трогаем;
   `levelHeight` живёт в карте, а не в конфиге, потому что зависит от
   масштаба конкретной карты.

6. Клиенту: `packages/engine/src/client/main.js`, `pushLayers`
   (`:640-662`) — добавить в контекст парта поле рядом с `volume`:

   ```js
   // мировых единиц на уровень: партам нужен для параллакса слоёв и
   // экструзии, 0/undefined — движок подставил размер тайла
   levelHeight: Number(data.levelHeight) || step * scale,
   ```

   Значение считать один раз до `pushLayers`, а не в теле цикла.

7. Ядру клиента: `levelHeight` уже поедет внутри JSON `set_map`
   (`main.js:581-597` отдаёт `data.levels`/`data.ramps`; добавить
   `levelHeight: data.levelHeight`), иначе клиентская `MapLevels` построит
   другой уклон, чем хостовая, и предсказание разъедется молча.

8. Правило контракта `packages/engine/src/devtools/contract/rules/e4-map-layers.js`:
   проверять тип и знак `levelHeight`, если поле есть. Добавить фикстуру
   `packages/engine/contract/fixtures/layered/bad-level-height.json`.

9. Capability: `packages/engine/src/lib/capabilities.js` — `map.levelHeight`,
   `since: '0.32.0'`; пересобрать `packages/engine/contract/surface.json`
   (только добавления, удалений быть не должно).

---

## 2.2 Коллайдеры прогона рампы (Д3, жалоба 3)

### Проблема

`GameMap::create_static` (`map.rs:1220-1258`) строит статические тела только
по `solid(level)` — то есть по `physicsStatic` уровня 0 и `walls` надземных
уровней. Клетки рампы не входят ни туда, ни туда ни на одной карте, поэтому
**физически рампа не существует**: заезд сбоку и въезд под клин с
«неправильного» торца запрещены только логикой (`T core/src/level.rs:265`
`entry_is_legal`), которая ставит `climbing = false`, но не мешает танку
ехать по клеткам прогона.

Пользователь видит: «на трамплин можно забраться сбоку» и «танк заехал под
горку, а нарисован на ней».

### Решение — группа-«страж»

Стенка, которую видит стоящий на земле, но не видит поднимающийся по прогону.

1. `map.rs` рядом с `STATIC_LEVEL_GROUP` (`:586`):

   ```rust
   /// Борта и «неправильный» торец прогона рампы. Отдельный бит, потому что
   /// тело, законно поднимающееся по прогону, обязано проходить сквозь торец
   /// наверху, оставаясь при этом в группах уровней прогона.
   pub const RAMP_GUARD_GROUP: Group = Group::GROUP_10;
   ```

   (`GROUP_9` занят статикой; проверить, что `GROUP_10` свободен — поиск по
   `Group::GROUP_` в крейте.)

2. Фильтрация. Правило Rapier: пара взаимодействует, если
   `(a.memberships & b.filter) != 0 && (b.memberships & a.filter) != 0`.

   | Кто | memberships | filter |
   | --- | --- | --- |
   | страж | `RAMP_GUARD_GROUP` | `level_group(low)` — уровень, с которого прогон начинается |
   | тело `Grounded` / тело карты | `level_group(level)` (как сейчас) | `level_group(level) \| RAMP_GUARD_GROUP` |
   | тело `Ramp { climbing: true }` | объединение уровней прогона (как сейчас) | то же **без** `RAMP_GUARD_GROUP` |

   Так законный въезд с нижнего торца свободен (там стража нет), бок и
   верхний торец закрыты, а поднявшийся танк выезжает наверх, не задев
   стража. Танк уровня 2, проезжающий над клетками прогона 0 → 1, не
   пересекается со стражем: `guard.filter = level_group(0)`, а его
   memberships — `level_group(2)`.

   Функцию сборки фильтра тела экспортировать из движка
   (`pub fn body_filter(mask: Group, ignore_ramp_guard: bool) -> Group`),
   чтобы игра не собирала биты руками — иначе появится вторая копия правила.

3. Геометрия. В `create_static` после цикла по уровням пройти по
   `self.levels.runs()` (см. `RampRun`, `map.rs:629-642`: `axis`, `sign`,
   `from`, `to`, `min`, `max`, `cross_min`, `cross_max`):

   - **борта** — два коллайдера-кубоида длиной во весь прогон и толщиной в
     небольшую долю тайла (например `step * 0.1`), прижатые к границам
     `cross_min`/`cross_max`;
   - **торец сверху** — один кубоид поперёк прогона на дальней от подножия
     стороне (сторона определяется знаком `sign`); ставится **всегда**, даже
     если сверху плита: тело уровня `to` его не увидит по фильтру, а тело
     уровня `from` — увидит.

   Нижний торец не закрывается никогда — это законный вход.

   Тела класть в `self.static_bodies` с уровнем `low` в `self.static_levels`,
   чтобы существующая обвязка (пересчёт групп, снапшоты) их не потеряла.

4. Тесты крейта (`map.rs`, `mod tests`):
   - `ramp_guard_blocks_a_body_of_the_lower_level_from_the_side` — тело
     уровня `from`, двигающееся поперёк прогона, останавливается;
   - `ramp_guard_lets_a_climbing_body_through` — тело с маской прогона и без
     бита стража проходит торец;
   - `ramp_guard_ignores_bodies_of_other_levels` — тело уровня 2 над
     прогоном 0 → 1 не задевает стража;
   - существующие тесты групп (`map.rs:1602-1620`) обязаны остаться
     зелёными: одноуровневая карта стражей не получает вовсе (проверить
     ранним выходом при `!is_layered()`).

5. Клиенту нужны данные для рисования клина (этап 4). В контекст парта
   (`pushLayers`) добавить описание прогонов слоя:

   ```js
   // прогоны рамп этого уровня: [tileIndex, dirX, dirY, from, to] — клиент
   // строит по ним клин с нарастающей высотой (парту грид уже дан)
   ramps: (level === 0 ? data.ramps : []).filter(r => (r.from ?? 0) === level),
   ```

   Точную форму согласовать с этапом 4 (что удобнее парту: конфиги рамп или
   готовые прогоны с координатами). Решение записать в отклонениях.

---

## 2.3 Валидация пересечения прогонов (Д16)

`push_run` (`map.rs:668-716`, конфликт решается на `:697-700`) молча отдаёт
клетку первому объявленному прогону. Две рампы, поделившие клетку, дают
поведение, которое не выводится из карты.

В `validate_levels` добавить проверку: множества клеток разных прогонов не
пересекаются; сообщение — с координатами первой общей клетки и индексами
рамп. Фикстура `packages/engine/contract/fixtures/layered/bad-ramps-overlap.json`
+ тест правила `e4`.

---

## 2.4 `with_levels` по индексам, а не по именам (Д16)

`packages/engine/core/src/game.rs:326-331` решает, писать ли `z`/`level` в
строку динамики, сравнивая **имена** полей схемы:

```rust
schema.fields[3].name == "z" && schema.fields[4].name == "level"
```

Переименование поля в игре молча возвращает плоскую строку — класс ошибок
«тихий отказ», против которого написан весь `docs/ai/10-pitfalls.md`.

Заменить на явный признак в схеме (например `kind: 'level'` у поля) либо на
проверку по индексам с ошибкой при несовпадении. Выбрать первое, если схема
допускает расширение; решение записать. Тест: игра с переименованным полем
получает **ошибку конфигурации**, а не тихо усечённую строку.

---

## 2.5 Единый источник длительности падения (Д14)

Сейчас длительность падения берётся из двух независимых полей:

- ящики на хосте — `EngineConfig::map_fall_time`
  (`packages/engine/core/src/config.rs`, используется в `game.rs:73,254`);
- танки и **предсказание тех же ящиков на клиенте** — из игрового
  `coreParams.levels.fallTime` (T `src/config/game.js:46`,
  T `core/src/client/predictor.rs:334`).

`src/config/game.js` не задаёт `mapFallTime` вовсе — совпадение 0.35
случайное. Изменит игрок `fallTime` — ящик у хоста и у его же клиента полетит
с разной скоростью.

Решение: если игра объявила `coreParams.levels.fallTime`, движок берёт его
как `mapFallTime` (в `buildCoreConfig`, `packages/engine/src/lib/coreConfig.js`),
а собственный ключ остаётся дефолтом для игр без уровней. Альтернатива —
запретить игре собственное поле и читать движковое; выбрать первое (игра
владеет правилами), решение записать в отклонениях. Тест —
`tests/lib/coreConfig.test.js`: объявленный игрой `fallTime` доезжает в
движковую половину.

---

## 2.6 `SoundManager`: непространственные источники (Д9)

### Проблема

`packages/engine/src/client/SoundManager.js:91` вешает
`pannerAttr(PANNER_SETTINGS)` на **каждый** звук, а `PANNER_SETTINGS`
(`:10-19`) — `panningModel: 'HRTF'`. Слушатель стоит в центре камеры
(`main.js:893`), камера — это предсказанная позиция своего танка, поэтому свой
двигатель попадает в ветку `_updateSpatialSound` (`:429-432`):

```js
if (distance > MIN_SPATIAL_DISTANCE) { sound.pos(x - lx, 0, y - ly, soundId); }
else { sound.pos(0, 0, 0, soundId); }   // "отключение панорамирования" — неправда
```

Панорама не отключается: источник ставится ровно на слушателя, и браузер
сворачивает петлю с фронтальной HRIR — гребенчатая окраска, которую игрок
слышит как гул. А `MIN_SPATIAL_DISTANCE = 1` (один пиксель) — слишком узкая
дед-зона: азимут в Web Audio зависит от направления, а не от расстояния,
поэтому расхождение камеры и танка в 2 пикселя даёт полную панораму.

### Решение

1. `registerSound(soundName, data, callback)` принимает `data.spatial`
   (по умолчанию `true`). Значение хранится в регистрации и обновляется через
   `updateSoundData` — свой танк узнаёт «локальность» не в конструкторе.
2. `_updateSpatialSound(sound, soundId, x, y, volume, spatial)`:

   ```js
   if (spatial === false) {
     // источник игрока: звук не принадлежит миру, он принадлежит игроку.
     // equalpower вместо HRTF — HRTF на нулевой дистанции даёт гребенчатую
     // окраску («гул»), а не тишину панорамы
     sound.pannerAttr({ panningModel: 'equalpower' }, soundId);
     sound.pos(0, 0, 0, soundId);
     sound.volume(volume, soundId);

     return;
   }
   ```

   `pannerAttr` ставится один раз на экземпляр звука — не звать каждый кадр
   (флаг в регистрации `_pannerApplied`).
3. Ту же ветку применить в `processAudibility` (`:305-311`), где
   одноразовые звуки позиционируются при старте, иначе свой выстрел
   останется панорамным.
4. Не звать `sound.rate()`, если значение не изменилось
   (`updateActiveSounds`, `:344-346`). Howler на каждый вызов делает два
   `seek()`, переписывает `_rateSeek`/`_playStart` и пересоздаёт таймер конца
   петли (`howler.js:1542-1573`) — на 60 Гц это заметная нагрузка и лишние
   события `_ended` на каждом обороте петли.
5. `MIN_SPATIAL_DISTANCE` поднять с 1 до величины порядка половины тайла
   (например 16) и объяснить комментарием, что это дед-зона по **направлению**,
   а не по громкости. Значение подобрать вместе с этапом 6.

### Тесты

`tests/client/SoundManager.test.js` (создать, если нет):
- `spatial: false` не зовёт `sound.pos(x, y)` с ненулевыми аргументами;
- `spatial: false` ставит `equalpower` ровно один раз;
- повторный `updateActiveSounds` с тем же `rate` не зовёт `sound.rate`.

---

## 2.7 Документация, журналы, релиз

- `docs/en/plugin-api.md` + `docs/ru/…`: `levelHeight` в описании формата
  карты; `ramps` в контексте парта; `spatial` в `registerSound`.
- `docs/en/configuration.md` + `ru`: `mapFallTime` и его связь с игровым
  `fallTime`.
- `docs/en/client.md` + `ru`: раздел звука — пространственные и
  непространственные источники, почему у своего танка второе.
- `docs/en/debugging.md` + `ru`: новые правила контракта (`levelHeight`,
  пересечение прогонов).
- `packages/engine/core/CHANGELOG.md`: `### ⚠️ Breaking` (сигнатура
  `MapLevels::build`, смысл `RampSample::slope`) + `### Migration` (что
  сделать игре: ничего, если `levelHeight` не задан и уклон не использовался;
  пересчитать константы подъёма, если использовался) + `### Added`
  (`levelHeight`, `RAMP_GUARD_GROUP`, коллайдеры прогона) + `### Fixed`.
- `packages/engine/CHANGELOG.md`: `### Added` (`levelHeight` в контексте
  парта, `spatial` в `SoundManager`, capability `map.levelsHeight`),
  `### Fixed` (двойной источник `fallTime`, `with_levels` по именам полей).
- **Релиз делает пользователь**: `vimp-engine-core 0.13.0`,
  `vimp-engine 0.32.0`. Публикация обязана произойти до старта этапа 3.

## Критерии приёмки

- [x] `cargo test --workspace` зелёный: **170 passed** (база 159, +11).
- [x] `npx eslint .` — 0 ошибок; `npx vitest run` — **2331 passed**, 183
      файла (база 2318).
- [x] `cargo clippy --workspace` — 1 предупреждение (`needless_range_loop`,
      `map.rs`), ровно база этапа 0, новых нет.
- [x] Одноуровневая карта: `flat_map_interactions_are_unchanged` и
      `flat_map_has_no_ramp_guards` (`map.rs`) + `legacy_map_has_no_levels`;
      строка динамики — `dynamics_row_stays_flat_without_roles` (`game.rs`).
- [x] `surface.json` пересобран (`npm run surface:update`): одна строка
      добавлена (`map.levelHeight`), удалений нет.
- [ ] Пакеты опубликованы, версии в реестре видны — **делает пользователь**
      (`vimp-engine-core 0.13.0`, `vimp-engine 0.32.0`).

## Что сделано

Всё в `/Users/dmitry/Sites/my/vimp`, рабочее дерево, без коммита.

| Пункт | Файлы |
| --- | --- |
| 2.1 `levelHeight` | `core/src/map.rs` (`MapConfig::level_height`, `MapLevels::level_height`, `build` +1 аргумент, уклон `rise * level_height / span`, валидация), `src/client/main.js` (payload `set_map` + контекст парта), `src/host/meta/core/RoundManager.js` (`scaleMapData`), `src/lib/capabilities.js`, `contract/surface.json`, правило `e4-map-layers.js`, фикстура `bad-level-height.json` |
| 2.2 стражи прогона | `core/src/map.rs`: `RAMP_GUARD_GROUP`, `body_filter`, `levels_interaction_on_ramp`, `ramp_guard_interaction`, `GameMap::create_ramp_guards`; `ramps` в контексте парта (`main.js`) |
| 2.3 пересечение прогонов | `core/src/map.rs` (`validate_levels`), `e4-map-layers.js`, фикстура `bad-ramps-overlap.json` |
| 2.4 `with_levels` | `core/src/config.rs` (`FieldRole`, `BlockSchema::with_levels`, `validate_level_roles`), `core/src/game.rs` (проверка в `load_map`, чтение ролей) |
| 2.5 длительность падения | `src/lib/coreConfig.js`, `tests/lib/coreConfig.test.js` |
| 2.6 звук | `src/client/SoundManager.js`, `tests/client/SoundManager.test.js` |
| 2.7 документация | `docs/{en,ru}/{plugin-api,core,configuration,client,network,debugging}.md`, `packages/engine/CHANGELOG.md`, `packages/engine/core/CHANGELOG.md` |

## Отклонения от плана

1. **`levelHeight` масштабируется ядром** (`cfg.level_height * scale`), как
   `step`, а `scaleMapData` домножает его на хосте (ядро там зовётся со
   `scale: 1`). В плане этого не было; без масштабирования хост и клиент
   считали бы разный уклон на карте со `scale != 1` — молча.
2. **`MapLevels::build` получил 6-й аргумент, `validate_levels` — 7-й.**
   Как и предупреждал план, сигнатуры уехали; вызовы в T чинятся этапом 3
   (`core/src/{level,shot_levels,client/mod,client/map_dynamics,bots/controller}.rs`).
3. **Фильтр стража вынесен в три функции, а не в одну.** План просил
   `body_filter(mask, ignore_ramp_guard)`; он есть, но игре удобнее готовые
   маски, поэтому добавлены `levels_interaction_on_ramp(mask)` (тело на
   прогоне) и `ramp_guard_interaction(low)` (сам страж), а `levels_interaction`
   и `level_interaction` теперь включают бит стража в ФИЛЬТР. Членство групп
   не изменилось, поэтому одноуровневая карта ведёт себя как раньше.
4. **2.4 сделано ролями полей, а не индексами** (план разрешал выбрать
   первое). Дополнительно: поля с именами `z`/`level` на позициях 3 и 4 без
   ролей — теперь ошибка загрузки карты. Иначе обновление движка вернуло бы
   игре плоскую строку молча — ровно тот отказ, ради которого роли и
   вводились. Тест «переименованное поле даёт ошибку» заменён на три:
   роль не на своей позиции, половина пары, движковые имена без ролей.
5. **Форма `ramps` в контексте парта** — конфиги рамп этого уровня как
   объявлены в карте (`{tile, dir, from, to}`), отфильтрованные по
   `from === level`, а не готовые прогоны с координатами: грид уровня у
   парта уже есть, а прогоны он строит тем же обходом, что и ядро.
   Согласовать при старте этапа 4; если парту удобнее координаты — это
   правка одной строки `pushLayers`.
6. **`MIN_SPATIAL_DISTANCE` = 16** (плановое «порядка половины тайла»);
   окончательное значение подтверждается этапом 6.
7. **Версии не подняты и журналы не датированы**: релиз в этом репозитории
   ручной и его делает пользователь. Записи лежат в `## [Unreleased]` обоих
   журналов.
