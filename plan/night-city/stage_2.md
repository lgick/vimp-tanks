# Этап 2. Поверхности для танков: ядро, предиктор, паритет ✅ выполнен

**Репозиторий:** `vimp-tanks`. **Зависит от:** этапа 1.
**Перед началом:** `plan/night-city/README.md` → «Общий контекст»; `docs/en/core.md` → разделы «motion.rs»,
«2.5D levels», «The level replica on the client».

## Цель

Клетки карты с поверхностями меняют движение танка одинаково на хосте (Rapier) и в клиентской реплике:

| Тип | Эффект |
| --- | --- |
| `sand` / `mud` | меньше тяга и потолок скорости, дополнительное сопротивление |
| `water` (мелководье) | умеренное сопротивление и потеря тяги |
| `oil` | почти нет бокового сцепления и торможения, повороты резче → занос и волчок |
| `conveyor` | подвижный пол: скорость «грунта» равна скорости ленты по стрелке |
| `boost` | разовый импульс по стрелке плиты при въезде по направлению стрелки |

Сэмплинг — **раздельно по гусеницам** (2 точки на гусеницу). Разница тяги гусениц даёт разворачивающий момент.

## 2.1 Конфигурация

1. `src/config/game.js` → `coreParams.surfaces` (значения стартовые, балансируются на этапе 9):
   ```js
   surfaces: {
     trackYawGain: 0.004,      // Δω на единицу разницы тяги гусениц (1/ед. длины)
     trackSampleX: 0.6,        // точки вдоль корпуса, доля полудлины
     trackSampleY: 0.75,       // линия гусеницы, доля полуширины
     types: {
       sand:     { accel: 0.6,  maxSpeed: 0.55, drag: 1.2, grip: 1.0,  brake: 1.0, turn: 0.8 },
       mud:      { accel: 0.45, maxSpeed: 0.4,  drag: 2.0, grip: 0.9,  brake: 1.0, turn: 0.7 },
       water:    { accel: 0.7,  maxSpeed: 0.6,  drag: 1.5, grip: 0.8,  brake: 0.8, turn: 0.85 },
       oil:      { accel: 0.35, maxSpeed: 1.0,  drag: 0.0, grip: 0.08, brake: 0.1, turn: 1.6, angularDrag: -0.5 },
       conveyor: { belt: 60 },                                   // ед./с по стрелке
       boost:    { boostDv: 160, boostMaxSpeed: 340, minEntrySpeed: 20 },
     },
   },
   ```
   Смысл множителей: `accel` — тяга; `maxSpeed` — потолок скорости; `drag` — доп. линейное сопротивление, 1/с;
   `grip` — боковое сцепление; `brake` — торможение без газа; `turn` — поворот; `angularDrag` — доп. угловое
   сопротивление, 1/с (отрицательное ослабляет демпфирование — даёт волчок, ограничить снизу `-angular damping`
   модели). Нейтральные значения: множители `1`, добавки `0`, `belt 0`.
2. `core/src/config.rs`: `SurfaceRules { track_yaw_gain, track_sample_x, track_sample_y, types: BTreeMap<String, SurfaceType> }`,
   `SurfaceType` с `#[serde(default)]` на нейтральные значения для множителей (`accel`, `maxSpeed`, `drag`, `grip`,
   `brake`, `turn`, `angularDrag`). Поля вида — **`Option<f32>`** (`belt`, `boostDv`, `boostMaxSpeed`, `minEntrySpeed`):
   с нейтральным значением по умолчанию (`belt 0`) после разбора уже нельзя отличить «поле не задано» от «задано 0»,
   и вид поверхности определить было бы нечем. Вид вычисляется при `validate()` и кэшируется
   (`SurfaceKind::Plain | Conveyor | Boost`). Поле `surfaces: SurfaceRules` добавить **в оба**
   `TanksConfig` (≈315) и `TanksClientConfig` (≈526): на клиент они приходят через `prediction.coreParams`
   без правок движка.
3. `TanksConfig::validate()` (≈333): `accel ∈ [0, 2]`, `maxSpeed ∈ (0, 2]`, `grip ≥ 0`, `brake ≥ 0`, `turn ≥ 0`,
   `angularDrag ≥ -model.damping.angular` (для каждой модели), `boostMaxSpeed > 0`, `minEntrySpeed ≥ 0`,
   `track_sample_* ∈ (0, 1]`. Типы `conveyor`/`boost` различаются по наличию `belt`/`boostDv`.
   Имя типа — любое, но у каждого описания должен быть ровно один «вид» (обычный, конвейер или бустер):
   `belt` и `boostDv` вместе — ошибка; `boostMaxSpeed`/`minEntrySpeed` без `boostDv` — ошибка.
   При заданном `boostDv` оба поля **обязательны**: значений по умолчанию нет, отсутствие любого — ошибка `validate()`
   с именем типа. Умолчание для порога въезда и потолка скорости молча меняло бы поведение плиты при опечатке в конфиге.

## 2.2 Поле карты `game.surfaces`

```js
game: {
  surfaces: {
    '0': { 41: 'sand', 42: 'mud', 43: 'water', 44: 'oil',
           45: { type: 'conveyor', dir: 'east' }, 46: { type: 'conveyor', dir: 'west' },
           47: { type: 'boost', dir: 'north' } },
    '1': { 44: 'oil' },
  },
}
```

Ключ — уровень, внутри — id тайла сетки этого уровня (`map` для `0`, `levels[n].map` для `n`). `dir` обязателен для
`conveyor` и `boost` (`north` = −y, `south` = +y, `west` = −x, `east` = +x — как у `ramps`).
Валидация при загрузке (хост — `on_map_loaded` возвращает `Err`; клиент — `set_map`, та же функция):
уровень существует, тип есть в `coreParams.surfaces.types`, `dir` задан ровно для направленных типов,
тайл не является стеной (`physicsStatic` / `walls`) или рампой. Одна функция `MapGame::validate_surfaces(&SurfaceRules, &MapLevels | сетки)`.

## 2.3 `core/src/surface.rs` — чистые функции

1. `SurfaceMap` — плотная таблица `per_level: Vec<Vec<u8>>` (0 — нейтрально, `k` — индекс типа + 1) и
   `dirs: Vec<Vec<u8>>`, `cols`, `rows`, `tile_size`.
   - Хост строит её в `rebuild_map_derived()` (этап 1.4.2) из `ctx.map`: сетка уровня 0 — **поле** `GameMap.grid` (метода `grid()` у
     `GameMap` нет), уровни — `map.levels().grid(l) -> Option<&Vec<Vec<i32>>>`, если карта слоёная.
     **Не опираться на `TanksSim.levels`**: на плоской карте оно `None`.
   - Клиент строит её в `TanksClient::set_map` из `ClientMapConfig` (`map: Vec<Vec<i32>>`) и передаёт в `Predictor`
     (`Rc<SurfaceMap>`).
   - Один конструктор `SurfaceMap::build(grids: &[&[Vec<i32>]], tile_size: f32, game: &MapGame, rules: &SurfaceRules) -> Result<_, String>`
     на обе стороны. Тип клеток — `i32`, как в движке. `tile_size` — мировой размер клетки: на хосте `step` уже
     умножен на `scale` (`scaleMapData`), на клиенте `set_map` получает `step` и `scale` отдельно. Одинаковое значение
     на обеих сторонах закрепить тестом.
2. `SurfaceMix` (`Copy`, `PartialEq`) — смешанные коэффициенты шага:
   `accel_l, accel_r, max_speed, drag, angular_drag, grip, brake, turn, belt_x, belt_y`; константа `SurfaceMix::NEUTRAL`.
3. `fn tank_mix(map, rules, level_state: &LevelState, x, y, angle, half_w, half_h) -> SurfaceMix`:
   - `Transit::Airborne` → `NEUTRAL`.
   - Уровень сэмпла — `level_state.level`; клетка вне сетки → нейтрально.
   - Полуразмеры — те же, что у `Footprint` (`level.rs` ≈193) и `Shape` предиктора (`predictor.rs` ≈336):
     `half_w = width/2 = size·2` — полудлина **вдоль оси `x`** (курс), `half_h = height/2 = size·1.5` — полуширина.
     Перестановка выносит точки сэмплинга за нос и корму; unit-тест проверяет, что все 4 точки лежат внутри корпуса.
   - Точки в системе корпуса (ось `x` — вперёд, как у `body_size`: длина `size*4` по `x`):
     левая гусеница `(±sx·hw, −sy·hh)`, правая `(±sx·hw, +sy·hh)` (знак стороны сверить с `turn_delta` тестом).
   - Каждая гусеница — среднее своих 2 точек. `accel_l`/`accel_r` — по гусеницам; остальные поля — среднее 4 точек;
     `belt` — среднее векторов ленты (`dir · belt`).
4. **У бустера нет состояния.** Въезд определяется чистой функцией текущего состояния тела (позиция, скорость),
   а не защёлкой. Причина: защёлку нельзя честно восстановить при реконсиляции. Позиция в кадре — это позиция после
   интегрирования, и по ней не понять, оценил ли хост въезд на этом шаге. Кроме того, у тел карты истории нет, а у
   своего танка история не покрывает кадр после `reset` или скачка RTT. Функция одного и того же состояния на обеих
   сторонах даёт одинаковый результат, поэтому паритет сохраняется без истории, без поля в `LevelState`, без правок
   дампа и без ловушки со сбросом `LevelState` на плоской карте (`step_level` ≈305–306).
5. `fn boost_dv(map, rules, level: u8, airborne: bool, x, y, vx, vy, dt) -> (f32, f32)`
   (на примитивах: этап 3 вызывает её для тел карты, у которых `LevelState` нет):
   - `cur = cell(x, y)` на уровне `level`; `prev = cell(x − vx·dt, y − vy·dt)` на том же уровне;
   - импульс, если: не в полёте; `cur` — бустер с направлением `dir`; `prev` — **не** бустер с тем же `dir`
     (клетка вне сетки считается «не бустером»); `v·dir ≥ minEntrySpeed`;
   - `dv = dir · min(boostDv, max(0, boostMaxSpeed − v·dir))`, иначе `(0, 0)`.
   Условие на `prev` — «не бустер с тем же `dir`», а **не** «другая клетка»: иначе переход между соседними
   клетками одной плиты (бустер на `downtown` — 2×3) давал бы повторный импульс. Соседние плиты с разным `dir`
   считаются разными бустерами.
   Известная цена: при отскоке на границе плиты (контакт развернул скорость) возможен редкий пропуск или повторный
   импульс. Для бустера это приемлемо; записать в `core.md`.

## 2.4 Формулы в `core/src/motion.rs`

Все функции без массы, Δv/Δω за шаг. Нейтральный путь обязан давать **бит-в-бит** прежний результат:
в вызывающем коде ветка `if mix == SurfaceMix::NEUTRAL { старые вызовы }`, либо формулы, дающие точные IEEE-тождества.
Проверяется тестом на битовое равенство.

- Скорость относительно «грунта»: `v_rel = v − belt`; `forward_speed_rel`, `lateral_rel` — проекции `v_rel`.
- `lateral_dv_on(lateral_rel, model, mix.grip, dt) = lateral_dv(lateral_rel, model, dt) · grip`.
- `drive_accel_on(throttle, forward, back, forward_speed_rel, grade, model, rules, mix)`:
  потолок `limit · mix.max_speed`, тяга `· (accel_l + accel_r)/2`, торможение без газа `· mix.brake`.
- `track_yaw_dv(throttle, forward, back, mix, model, rules_surfaces, dt)`:
  `(accel_l − accel_r) · throttle · acceleration_factor · track_yaw_gain · dt · sign(направление хода)`.
  Знак: левая гусеница в грязи (меньше тяга) → танк уводит в сторону грязи. Закрепить unit-тестом.
- `turn_delta · mix.turn`.
- `surface_drag_dv(v_rel, mix.drag, dt) = −v_rel · drag · dt` (по обеим осям);
  `angular_drag_dw(angvel, mix.angular_drag, dt) = −angvel · angular_drag · dt`.
- Unit-тесты: нейтральный `mix` ⇒ битовое равенство со старыми функциями на наборе входов; на песке установившаяся
  скорость не выше `maxSpeed · max_forward_speed` и заметно ниже асфальтовой (не «≈ потолку»: потолок лишь отсекает
  тягу, а равновесие тяги, демпфирования и `drag` может лечь ниже него); масло почти не гасит боковую скорость;
  лента разгоняет стоящий танк **в сторону** `belt`: скорость растёт монотонно и остаётся `≤ belt`. Равенства `belt`
  не ждать: линейное демпфирование Rapier на хосте (и `integrate` в реплике) тянет к нулю абсолютную скорость, а не
  скорость относительно ленты, поэтому равновесие ложится ниже `belt`. Порог задать долей (например, `≥ 0.6 · belt`
  через 3 с) и записать причину.

## 2.5 Хост: `Tank::update` (`core/src/tank.rs` ≈441–556)

1. `TanksSim` хранит `surfaces: Option<SurfaceMap>` (строится в `rebuild_map_derived()`, этап 1.4.2)
   и передаёт `Option<&SurfaceMap>` в `tank.update(...)` рядом с `&level_rules`; `None` → `SurfaceMix::NEUTRAL`
   и нулевой импульс бустера.
2. Порядок внутри `update` не меняется, добавляются вставки:
   - после раннего выхода при `input_locked()` (≈498): `let mix = surface::tank_mix(...)` (угол — из тела) и
     **снимок скорости начала шага** `(vx0, vy0) = body.linvel()` — до `lateral_dv_on` и тяги. Rapier меняет `linvel`
     сразу при `apply_impulse`, поэтому любое чтение скорости после бокового импульса (≈517) или тяги (≈535) уже
     другое. Реплика (2.6.2) берёт те же `(vx0, vy0)` — скорость до всех импульсов шага;
   - `step_throttle` без изменений;
   - `forward_speed`/`lateral` считаются от `v_rel` (≈507–508);
   - боковой импульс — `lateral_dv_on` (≈511–517);
   - `drive_accel_on` (≈521–536);
   - новые импульсы: `surface_drag_dv · mass` и `boost_dv · mass` (прикладываются к телу в этом же месте).
     `boost_dv` получает **`(vx0, vy0)`** и `dt` шага — и для порога `minEntrySpeed`, и для `prev = cell(p − v·dt)`.
     Скорость после бокового импульса и тяги сюда не передаётся;
   - поворот: `turn_delta · mix.turn + track_yaw_dv + angular_drag_dw`, умноженные на `inertia` (≈541–545).
3. **Проверить обломки** (`condition 0`): вызывается ли для них `Tank::update`. Если нет, пассивные силы
   (лента, сопротивление) к обломкам не применяются, и это фиксируется в `gameplay.md` как осознанное ограничение.
   Реплика и хост должны вести себя одинаково.
4. `engine_load` использует `forward_speed_rel` — проверить, что звук на ленте не «воет».

## 2.6 Реплика: `Predictor::step_inner` (`core/src/client/predictor.rs` ≈942–1027)

1. `Predictor` хранит `surface_map: Option<Rc<SurfaceMap>>` и `surface_rules`. Имя `surfaces` **занято**:
   это буфер контактов `surfaces: Vec<Surface>` (`predictor.rs` ≈175, используется в `resolve_world` ≈1179); `set_map` (≈397) принимает
   `SurfaceMap`, `Predictor::new` (≈254) — `SurfaceRules`. Сброс при смене карты — вместе с уровнями.
2. Те же вставки в том же порядке, что на хосте: `mix` после ветки полёта (≈978–984), `v_rel`,
   `lateral_dv_on`, `drive_accel_on`, `surface_drag_dv` и `boost_dv` в `vx/vy` (≈1010–1011), угол — в `angvel`
   (≈1015), затем `resolve_world` и `integrate` без изменений. `boost_dv` получает те же `(vx0, vy0)`, что и хост:
   `vx/vy` состояния реплики, снятые в начале шага до `lateral_dv_on`. Тест паритета въезда на бустер на скорости,
   близкой к `minEntrySpeed`, ловит перепутанный снимок.
3. Состояния бустера в реплике нет, откатывать нечего. Тесты: реконсиляция (с историей и без неё — после `reset`)
   посреди плиты и за шаг до въезда даёт ровно один импульс на въезд, как на хосте.
4. `remote_tanks.rs` (экстраполяция чужих танков в контакте) поверхности **не учитывает** — осознанно, записать
   в `core.md`.

## 2.7 Паритет и тесты

1. `mod parity` (`predictor.rs` ≈3468), через `simulate_on_map` (≈3586) с фикстурами карт (inline-JSON, как
   `long_wall_map` ≈3544 и `layered_map` ≈2145) с `game.surfaces`:
   - `sand_straight_run` — разгон по песку;
   - `mud_under_left_track_yaws` — грязь только под одной гусеницей, прямой газ;
   - `oil_hard_turn_slides` — въезд на масло на скорости с поворотом;
   - `water_brake_release` — отпускание газа в воде;
   - `conveyor_idle_drift` — стоящий танк на ленте;
   - `conveyor_on_ground_ignored_on_bridge` — лента на уровне 0 под танком на уровне 1;
   - `boost_pad_fires_once` — проезд через бустер и стоянка на нём;
   - `boost_plate_2x3_lengthwise` — проезд вдоль плиты 2×3 одного `dir`: один импульс, не три;
   - `boost_adjacent_plates_different_dir` — две соседние плиты с разным `dir`: по импульсу на каждую;
   - `boost_against_arrow_does_nothing`.
   Пороги — `expect_scenario_thresholds` (≈3641); если сценарий требует более мягких порогов, задокументировать причину.
2. `core/tests/sim.rs` — правила: установившаяся скорость на песке не выше `maxSpeed · max_forward_speed` и меньше
   асфальтовой минимум на 30 %;
   бустер срабатывает ровно один раз на въезд, в том числе на плите 2×3 и на плоской карте при стоянке 60 шагов;
   въезд с края сетки (предыдущая клетка вне карты) срабатывает; лента под мостом не действует на танк на мосту;
   боковая скорость после поворота на масле больше, чем на асфальте; плоская карта без `game` — движение прежнее.
3. JS harness (`tests/core/core.test.js`): карта с `game.surfaces` загружается; неизвестный тип и `dir` у `sand`
   отклоняются с ошибкой.
4. `npm run core:test` обязателен.

## 2.8 Документация и журнал

- `docs/en|ru/core.md`: раздел «Surfaces» (модуль, сэмплинг гусеницами, формулы, `v_rel`, бустер без состояния —
  правило въезда по `prev = cell(p − v·dt)` и почему защёлка отвергнута, цена на отскоке, порядок в `Tank::update`
  и `step_inner`, что не учитывается: удалённые танки, обломки — если так).
- `docs/en|ru/configuration.md`: `coreParams.surfaces` по параметрам; поле карты `game.surfaces`.
- `docs/en|ru/gameplay.md`: раздел о поверхностях глазами игрока; боты поверхностей **не учитывают** — осознанно.
- `docs/en|ru/extending.md`: как добавить тип поверхности и разметить тайлы; предупреждение про бустер перед рампой
  (дальность прыжка растёт — длина площадки приземления).
- `CHANGELOG.md` → `### Added`. Формат дампа эстафеты не меняется: `LevelState` новых полей не получает.

## Критерии готовности

Все проверки из README зелёные, паритет проходит на всех новых сценариях, существующие 6+2 паритетных теста не менялись.
