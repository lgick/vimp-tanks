# Этап 3. T, ядро: N уровней, гейт рампы, ящики, наклон ✅ выполнен

**Репозиторий:** T (`/Users/dmitry/Sites/my/vimp-tanks`).
**Зависит от:** 2 (крейт 0.12.0 опубликован). **Блокирует:** 4, 5, 6, 7.

**Файлы:** `core/Cargo.toml`, `core/src/level.rs`, `core/src/tanks.rs`,
`core/src/tank.rs`, `core/src/motion.rs`, `core/src/config.rs`,
`src/host/index.js`, `src/client/index.js` (обе половины `requires`),
`src/config/game.js`, `src/config/snapshot.js`,
`src/client/snapshotFields.js`, `core/tests/sim.rs`.

## Цель

Закрыть задачи 1 (ящики падают), 4-физика (подъём чувствуется),
5 (нельзя заехать на рампу не с торца) и 6-ядро (N уровней).

Первым делом: `core/Cargo.toml` → `vimp-engine-core = "0.12.0"`,
`cargo update -p vimp-engine-core`. `[patch.crates-io]` не коммитить.

## 3.1 `step_level` на N уровней

`core/src/level.rs` содержит три жёстких допущения:

```rust
Transit::Ramp { .. } => level_group(0) | level_group(1),   // :70  — маска рампы
state.level = 0; state.z = 0.0;                            // :115 — приземление всегда на землю
state.level = if state.z >= 0.5 { high } else { low };     // :166 — порог середины
```

Правки:

1. **Маска на рампе** — объединение групп всех уровней `low..=high`:

```rust
Transit::Ramp { .. } => {
    // на рампе тело видит геометрию всех уровней, которые прогон
    // соединяет: иначе на рампе 0→2 танк провалился бы сквозь
    // промежуточную геометрию или упёрся в невидимую стену
    (low..=high).fold(Group::empty(), |acc, l| acc | level_group(l))
}
```

   `low`/`high` придётся хранить в самом `Transit::Ramp` (они уже
   известны в момент входа) — см. 3.2, где вариант всё равно меняется.

2. **Падение** — `Transit::Falling { elapsed, from }` →
   `Falling { elapsed, from, to }`, где
   `to = levels.landing_level(from, x, y)` вычисляется в момент срыва;
   высота — `fall.z_at(from as f32, to as f32, elapsed)`; по приземлении
   `state.level = to`, `state.z = to as f32`, событие `Landed` несёт
   высоту падения `(from - to)` для урона.

3. **Уровень на рампе** — `state.z.round().clamp(low as f32, high as f32) as u8`,
   а не порог `z >= 0.5`: на рампе 0 → 2 порог дал бы уровень 2 уже на
   первой трети прогона.

4. **`fall_elapsed`** (`level.rs:81-89`) — сейчас это обратная к
   `lerp(from, 0.0, t)`; переписать через `FallModel::elapsed_at(from,
   to, z)` движка. Функция нужна клиентской реплике (этап 5).

5. `LevelRules` (`core/src/config.rs:118-143`) и `coreParams.levels`
   (`src/config/game.js:44-48`):

```js
levels: {
  fallTime: 0.35,             // с на ОДИН уровень высоты (смысл поля уточнён)
  fallDamage: 15,             // урон за ОДИН уровень высоты
  maxFallDamage: 100,         // потолок
  climbGravity: 220,          // мировых единиц/с² на единицу продольного уклона
  climbMaxSpeedFactor: 0.55,  // множитель макс. скорости при уклоне 1.0
},
```

   `TanksConfig::validate` (там же) уже проверяет `fallTime > 0` —
   добавить проверки для новых полей (неотрицательность, `maxFallDamage
   >= fallDamage`, `climbMaxSpeedFactor ∈ [0, 1)`).

   Урон при приземлении — `fallDamage * height`, зажатый `maxFallDamage`:
   падение с уровня 1 остаётся ровно 15, поведение `overpass` не
   меняется.

## 3.2 Гейт входа на рампу (задача 5)

Нынешний гейт (`level.rs:137-161`):

```rust
let from_the_top = entered_at >= 0.5;
if from_the_top != (from_level == high) { /* прогон работает как плоскость */ }
```

Он закрывает только верхнюю половину прогона. Заход **сбоку в нижнюю
половину** (а на `overpass` клетка подножия достижима прямо с земли)
по-прежнему даёт бесплатный подъём — это и есть задача 5.

**Решение — гейт по фактической клетке входа.** `LevelState` получает
поле `prev_cell: (i32, i32)` — клетка центра корпуса на прошлом шаге,
`(-1, -1)` = «неизвестно» (спавн, первый шаг). Пишется в конце
`step_level` **всегда**, а не только на рампе, иначе после проезда по
плите значение протухнет.

Вход `Grounded → Ramp` легален, если выполнены три условия:

1. `prev_cell` лежит **вне** этого прогона (индекс прогона в
   `run_cells` другой или -1);
2. `prev_cell` — сосед клетки входа **вдоль оси прогона** (`axis`), то
   есть смещение ровно на одну клетку по оси и ноль поперёк: ни
   диагональ, ни бок;
3. торец соответствует уровню танка: вход у подножия ⇔
   `level == min(from, to)`, вход у вершины ⇔ `level == max(from, to)`.

Иначе — прогон работает как плоская клетка уровня танка
(`z = level as f32`, уровень не меняется) до схода с прогона.
Решение принимается **один раз, при входе**, и хранится в варианте:

```rust
pub enum Transit {
    Grounded,
    /// `climbing` — прошёл ли танк гейт входа (иначе прогон плоский для
    /// него); `low`/`high` — границы прогона, нужны маске и снапу уровня.
    Ramp { climbing: bool, low: u8, high: u8 },
    Falling { elapsed: f32, from: u8, to: u8 },
}
```

Форма дампа `LevelState`/`Transit` (`#[serde(tag = "kind")]`) меняется —
запись в `CHANGELOG.md` (`### ⚠️ Breaking`) и в `docs/en|ru/core.md`
рядом с описанием дампа `BotBrain`.

Индекс прогона и его ось приходят из `RampSample` (поля `run`, `axis`
добавлены на этапе 1.2 ровно для этого гейта): «та же рампа» — это
совпадение `run`, а «сосед вдоль оси» проверяется по `axis`.

## 3.3 Тесты-воспроизведения задачи 5 (писать ДО правки, красными)

В `core/src/level.rs` (фикстура `layered()` там уже есть — карта 4×4 с
плитой в колонке x=2 и рампой в клетке (1,1)):

* `ramp_is_not_entered_from_the_side` — танк уровня 0 въезжает в клетку
  подножия **поперёк оси** прогона → уровень и `z` не меняются;
* `ramp_is_not_entered_from_under_the_bridge` — фикстура, где под плитой
  уровня 1 проходит проезд уровня 0, упирающийся в верхний торец
  прогона; танк уровня 0 доезжает до торца → уровень и `z` не меняются;
* `ramp_is_not_entered_diagonally` — вход по диагонали → не поднимает.

Обязаны остаться зелёными: `ramp_raises_z_and_snaps_level_at_half`
(вход снизу поднимает), `ramp_entered_from_the_top_lowers_the_tank`
(спуск), `ramp_entered_from_the_side_does_not_lift`.

## 3.4 Ящики (задача 1)

Шаг правил для тел карты делает движок (stage_1 §1.5) — в танках менять
нужно только потребление новых полей:

1. **Схема** `src/config/snapshot.js`, ключи `c1` и `c2` (сейчас
   `optionalFrom: 3`, поля `x, y, angle, vx, vy, angvel`):

```js
c1: {
  id: 5, kind: 'indexedNoNull8', class: 'hot', optionalFrom: 5,
  fields: [
    { name: 'x', ty: 'f32', interp: 'lerp' },
    { name: 'y', ty: 'f32', interp: 'lerp' },
    { name: 'angle', ty: 'f32', interp: 'lerpAngle' },
    // 2.5D: высота и уровень тела карты. Обязательная голова, а не
    // хвост: покоящееся тело хвост не шлёт, и уровень читался бы нулём
    { name: 'z', ty: 'f32', interp: 'lerp' },
    { name: 'level', ty: 'u8' },
    { name: 'vx', ty: 'f32', interp: 'lerp' },
    { name: 'vy', ty: 'f32', interp: 'lerp' },
    { name: 'angvel', ty: 'f32', interp: 'lerp' },
  ],
},
```
   `c2` — так же (схемы совпадают по форме).

2. **Константы** `src/client/snapshotFields.js`: `C_X = 0`, `C_Y = 1`,
   `C_ANGLE = 2`, `C_Z = 3`, `C_LEVEL = 4`, `C_VX = 5`, `C_VY = 6`,
   `C_ANGVEL = 7`. **Индексы скоростей съезжают** — пройти по всем
   потребителям (`src/client/parts/Map.js`,
   `core/src/client/map_dynamics.rs`, тесты).

3. **Клиентская реплика** `core/src/client/map_dynamics.rs`:
   `PredictedBody.level` сейчас заполняется один раз из
   `ClientMapConfig.physics_dynamic[i].level` (~:147) — теперь читается
   из строки кадра; тело получает `z`, а падение считает
   `vimp_engine_core::map::step_body_level` — та же функция, что на
   хосте.

4. Снять ограничение «ящик уровня 1 не ставить у разрыва перил» из
   `docs/en|ru/gameplay.md`, `docs/en|ru/extending.md` и из комментария в
   `src/data/maps/overpass.js` (~:182-187); в
   `plan/done/multilevel-maps/README.md` §«После первой итерации» пункт
   можно пометить закрытым этой итерацией.

## 3.5 Наклон в физике (задача 4, физическая половина)

`step_level` — единственное место, читающее `ramp_at`, поэтому уклон
считается там же и кладётся в состояние:

```rust
pub struct LevelState {
    pub level: u8,
    pub z: f32,
    pub transit: Transit,
    pub prev_cell: (i32, i32),
    /// Вектор уклона: уровней на мировую единицу, (0,0) вне рампы.
    /// Заполняется из RampSample { dir, slope } и только при climbing.
    pub slope_vec: [f32; 2],
}
```

`core/src/motion.rs::drive_accel` получает продольный уклон
`grade = slope_vec · heading` (положительный — в горку):

```rust
pub fn drive_accel(
    throttle: f32, forward: bool, back: bool, forward_speed: f32,
    grade: f32, model: &ModelConfig, rules: &LevelRules,
) -> f32 {
    let limit = model.max_forward_speed
        * (1.0 - rules.climb_max_speed_factor * grade.max(0.0)).max(0.25);
    // ... прежняя логика тяги/торможения, но с `limit` вместо max_forward_speed
    accel - grade * rules.climb_gravity
}
```

* на подъёме — ниже потолок скорости и постоянное торможение;
* на спуске (`grade < 0`) — разгон;
* при нулевом газе на крутом подъёме `accel < 0` — танк скатывается.

Обе стороны обязаны звать одну функцию: авторитетная (`Tank::update`,
`core/src/tank.rs:399-502`, домножает на массу для импульсов Rapier) и
реплика (`Predictor::step`, `core/src/client/predictor.rs:643-705`,
интегрирует вручную). Паритет закреплён `client::predictor::parity` —
после любой правки `motion.rs` обязателен `npm run core:test`.

**Критерий приёмки дефолтов:** рампы `overpass` штатно проезжаются на
полном газе, сценарий `tests/scenarios/bridge.json` остаётся зелёным.
Это условие, а не украшение: слишком большой `climbGravity` сделает
существующую карту непроходимой.

## 3.6 `requires`

`src/host/index.js`, клиентская половина (`src/client/index.js`) и
манифест: `requires: ['map.layers', 'map.levelsN']`. Иначе правило `B2`
красное, а на старом движке карта тихо соберётся без верхних уровней —
ровно тот молчаливый отказ, ради которого `requires` и существует.

## Тесты

`core/src/level.rs`: подъём 0 → 2 одной рампой (уровень щёлкает по
`z.round()`, маска содержит три группы); падение с 2 на плиту 1;
длительность падения пропорциональна высоте; урон пропорционален высоте
и зажат потолком; гейт (3.3).

`core/src/motion.rs`: установившаяся скорость на подъёме ниже, чем на
плоскости; на спуске выше; при нулевом газе на подъёме `accel < 0`;
на `grade = 0` результат бит-в-бит прежний (регресс одноуровневых карт).

`core/tests/sim.rs`: ящик, вытолкнутый с плиты, оказывается на земле и
меняет группу; обновить ожидания в тестах, где уровни сравниваются с
константами (`bomb_collider_carries_the_level_group` в `core/src/bomb.rs`,
`tanks_on_different_levels_do_not_collide`, `landing_applies_fall_damage`,
`players_json_matches_schema_width` — последний обязан поймать смену
ширины `c1`).

## Проверка

```bash
cd /Users/dmitry/Sites/my/vimp-tanks \
  && npm run core:build && npm run core:test \
  && npx eslint . && npm test -- --silent \
  && npm run build && npm run sim:scenarios
```

## Отклонения

1. **Гейт входа: спавн на прогоне судится старым правилом.** План требовал
   `prev_cell == (-1, -1)` → «вход незаконен», но точки спавна `overpass` и
   фикстуры `sim.rs` стоят ПРЯМО на клетке подножия: с жёстким запретом
   танк, очнувшийся на прогоне, не съезжал бы с него никогда (клетка
   прогона всегда «та же рампа»), и `ramp_lifts_tank_to_level_one`,
   `tank_climbs_the_ramp_and_falls_back_to_the_ground`,
   `scripted_bot_drives_onto_the_bridge` краснели. Решение: при неизвестной
   клетке работает правило первой итерации (`progress >= 0.5` против
   уровня танка). Эксплойта нет — в движении клетка известна всегда.
2. **Условие «сосед вдоль оси» оставлено дословно** (`|along| == 1`,
   `across == 0`), хотя оно отвергает и диагональный заход через торец.
   Тест `ramp_is_not_entered_diagonally` план требовал прямо, а бот и
   игрок заходят на рампу по нав-графу от подножия — измерено сценарием
   `bots_bridge.json` и тестом `scripted_bot_drives_onto_the_bridge`.
3. **`ramp_is_not_entered_from_under_the_bridge` без новой фикстуры**:
   в `layered()` клетка (2, 1) — это и есть проезд уровня 0 ПОД плитой,
   упирающийся в верхний торец прогона. Отдельная карта не понадобилась.
4. **Два теста первой итерации получили шаг подхода.** `ramp_raises_z_...`
   и `ramp_entered_from_the_top_...` начинались вызовом сразу на клетке
   рампы; теперь перед ним есть шаг на соседней клетке — иначе они
   проверяли бы не гейт, а его спавн-ветку (см. отклонение 1). Сами
   утверждения не менялись.
5. **`fall_elapsed` получила аргумент `to`** (падение не всегда до земли);
   `LevelEvent::Landed { height }` несёт высоту падения — по ней `tanks.rs`
   считает урон `fallDamage * height`, зажатый `maxFallDamage`.
6. **`ClientMapConfig` получил `layers`/`volumes`**: `validate_levels`
   крейта 0.12.0 принимает шесть аргументов и проверяет `volumes` по
   составу слоёв. Без полей клиент проходил бы проверку, которую хост
   завалил.
7. **Клиентская реплика динамики** (§3.4.3): `PredictedBody` получил `z` и
   `falling` (вместе с `level` это `BodyLevelState` движка), `MapDynamics`
   — `set_levels(levels, fall)` и шаг правил уровня в
   `integrate_predicted`. Отдельный метод, а не аргумент `set_map`: у
   `set_map` девять тестовых вызовов, и геометрия карты с правилами уровня
   приходят из разных мест. `render_data` теперь везёт `z` и `level` — без
   них движок дописал бы голову схемы нулями, и предсказанный ящик на
   мосту рисовался бы на земле. Реконсиляция уровня тел — этап 5.
8. **`scripted_bot_drives_onto_the_bridge` получил цель на плите.** Раньше
   бот заезжал на мост, задев рампу боком во время случайного патруля, —
   то есть тест проходил ровно из-за задачи 5. Теперь на плите стоит враг,
   и тест проверяет заявленное: нав-граф ведёт бота на мост через подножие.
9. **`bots_bridge.json`: игроку добавлен бросок бомбы** (`nextWeapon` +
   `fire` на тиках 400/420). Инвариант `snapshotKeysUsed` требует строк
   `w2`/`w2e`, а после смены физики боты за 15 с ни разу не сменили оружие
   — ключи зависели от их ГСЧ. Теперь бомба детерминирована, тема сценария
   (боты и мост) не изменилась.
10. **Добавлен `overpass_ramp_is_climbed_at_full_throttle`** (`sim.rs`):
    критерий приёмки дефолтов уклона нужно было чем-то закрепить, а
    `bridge.json` игровых правил не утверждает.
