# Этап 2. Бустер теряет въезд на плиту (Я1) ✅ выполнен

**Файлы:** `core/src/surface.rs`, `core/src/tank.rs`, `core/src/tanks.rs`, `core/src/client/predictor.rs`,
`core/src/client/map_dynamics.rs`, `core/tests/sim.rs`, `tests/core/core.test.js`, `docs/en/core.md`,
`docs/ru/core.md`, `CHANGELOG.md`.

**Нельзя:** добавлять поля в `LevelState`, менять порог `count_boosts` (60), менять скорости фикстур
`flat_config_json()` / `config_json()`.

## Проблема (проверено на реальном ядре)

**Симптом.** В `tests/core/core.test.js` тест
`'с бустера на полном газу танк приземляется на плиту парковки'` коммит `d34e278` перенёс старт с реального
респауна `cell(9)` на `cell(8.5)` и оставил комментарий:
«…с самого респауна на maxForwardSpeed 130 танк въезжает на плиту так, что `p − v·dt` (surface::boost_dv) уже на
ней, и импульса нет — граничный случай ядра, не правило этого теста». В карте `downtown`
(`src/data/maps/downtown.js → respawns.team1`) такая точка есть: `spawn(9, 35, 0)`, в мире (121.6, 454.4). Каждый
игрок, который возродился там и поехал прямо на полном газу, проезжает плиту без импульса и до крыши-парковки
не допрыгивает. С этой же точки стартует p3 в `tests/scenarios/downtown_surfaces.json`: в конце прогона он стоит
на x = 244.7, на уровне 0, а на крышу не попадает.

**Замеры** (JS-харнесс `tests/core/helpers.js → makeCore()`, реальный конфиг, `downtown`, `tile = 12.8`,
`cell(v) = (v + 0.5)·tile`, полный газ вперёд):
- пиковая скорость по стартовой клетке x: `3: 491, 5: 491, 8: 484, 8.5: 484, 9: 138, 9.25: 490, 10: 484, 12: 484`;
- развёртка по 200 стартам от `cell(8.5)` = 115.2 с шагом 0.006: импульс теряют 5 стартов подряд,
  x = 115.998…116.022. Это окно шириной ≈0.03 на шаге пути ≈1.1 ед., то есть **≈2.5 % всех въездов на полном
  ходу**. С детерминированного респауна `spawn(9, 35)` — всегда.

**Причина.** `surface::boost_dv` (`core/src/surface.rs`, ~стр. 575–629) признаёт въезд, если клетка центра — бустер,
а клетка `p − v·dt` — нет. Здесь `v` — скорость НАЧАЛА шага. Но Rapier сдвигает тело скоростью ДО демпфирования и
хранит задемпфированную: `v_хранимая = v_интегр / (1 + linear·dt)`. То же делает клиентский интегратор движка:
`vimp-engine-core/src/client/rigid_body.rs → integrate`, комментарий «позиция интегрируется скоростью ДО
демпфирования, хранится задемпфированная скорость. Порядок эмпирический, повторяет Rapier». Отсюда смещение
прошлого шага:

```
p_N − p_{N−1} = v_start(N) · (1 + linear·dt) · dt
```

Измерено на ядре: отношение смещения к `v_start·dt` в среднем 1.02497, при `damping.linear = 3`, `dt = 1/120`
ожидается 1 + 3/120 = 1.025. Отклонение отдельных шагов ±1 % даёт округление вывода `position_of`/снапшота до
0.01, само тело не квантуется. Поэтому `p − v·dt` недолетает до прошлой позиции на `v·linear·dt²` ≈
130·3/14400 ≈ 0.027 ед. Если прошлый центр лежал в этой полосе перед кромкой, проекция уже на плите, и въезд
принимается за «ехал по той же плите».

Трасса у кромки (плита с x = 230.40, старт `cell(9)`): прошлый центр 230.37 — до плиты. Текущий центр 231.52 при
`vx = 134.39` даёт 231.52 − 134.39/120 = 230.40, то есть плиту, и импульса нет.

**Почему без состояния.** `docs/en/core.md` («The boost entry has no state… A latch was rejected…») фиксирует
решение: въезд — чистая функция одного состояния. Иначе реконсиляция, тела карты без истории и кадр после
`reset` расходились бы с хостом. Поле «прошлая позиция» в `LevelState` этому противоречит. Готовая
`LevelState.prev_cell` тоже не подходит: на хосте `TanksSim::on_fixed_step` зовёт `update_levels` (оттуда
`level::step_level`, который пишет `prev_cell` = клетку ТЕКУЩЕЙ позиции) до `tank.update`, где стоит `boost_dv`.
Предиктор делает так же: `Predictor::step_level` вызывается «до применения ввода». Правильное исправление —
учесть демпфирование в самой проекции. Оно точное для всех четырёх вызывающих, без нового состояния.

## Решение

### 2.1. Красный JS-тест

`tests/core/core.test.js`, тест `'с бустера на полном газу танк приземляется на плиту парковки'`. Заменить

```js
      // полтайла до респауна «бустер → рампа → крыша-парковка» (cell(9)):
      // с самого респауна на maxForwardSpeed 130 танк въезжает на плиту так,
      // что `p − v·dt` (surface::boost_dv) уже на ней, и импульса нет —
      // граничный случай ядра, не правило этого теста
      core.spawn_actor(1, 'm1', 1, cell(8.5), cell(35), 0);
```

на

```js
      // респаун «бустер → рампа → крыша-парковка»
      core.spawn_actor(1, 'm1', 1, cell(9), cell(35), 0);
```

`npx vitest run tests/core/core.test.js --reporter=dot` должен упасть: пик ниже 1.05.

### 2.2. Красный Rust-тест свойства (все фазы въезда)

`core/tests/sim.rs`: сразу после теста `boost_fires_once_per_entry` (~стр. 3071–3089), до doc-комментария
`make_core_with_held_boost`, добавить:

```rust
#[test]
fn boost_fires_for_every_entry_phase() {
    // фаза въезда — где стоял центр на шаге до плиты. Проекция `p − v·dt` без
    // поправки на демпфирование недолетала до прошлой позиции на v·linear·dt²
    // (≈0.05 при 260), и въезд из этой полосы перед кромкой терял импульс.
    // 100 стартов с шагом 0.024 покрывают больше одного шага пути (≈2.2).
    // Бустер с удержанием: импульс 220 при любой фазе много выше порога 60
    let plate = |x: usize, y: usize| if (10..13).contains(&x) && (10..12).contains(&y) { 47 } else { 0 };
    let map = surface_map_json(40, plate, boost_game(47, "east"));
    let missed: Vec<f32> = (0..100)
        .map(|i| 200.0 + i as f32 * 0.024)
        .filter(|&x| {
            let mut core = make_core_with_held_boost();

            core.load_map(&map).unwrap();
            core.spawn_actor(1, "m1", 1, x, 336.0, 0.0).unwrap();
            core.apply_input(1, 1, "down", "forward");

            count_boosts(&mut core, 1, 150) != 1
        })
        .collect();

    assert!(missed.is_empty(), "въезд без ровно одного импульса со старта x = {missed:?}");
}
```

Хелперы `surface_map_json`, `boost_game`, `count_boosts`, `make_core_with_held_boost` в файле уже есть (~стр.
2995–3110). Плита — колонки 10..13, строки 10..12 при шаге 32, то есть x ∈ [320, 416), y ∈ [320, 384).

`cargo test -p vimp-tanks-core --test sim boost_fires_for_every_entry_phase -q` **до исправления** должен упасть. Если тест
зелёный, сделать шаг 0.006 при 400 стартах и перепроверить. Тест сдаётся красным: без этого он ничего не
доказывает.

### 2.3. Исправление `boost_dv`

`core/src/surface.rs`, функция `boost_dv` (~стр. 575–629).

1. Doc-комментарий над функцией заменить целиком на:

   ```rust
   /// Разовый импульс бустера (Δv по осям мира). Состояния нет: въезд — чистая
   /// функция текущих позиции и скорости, поэтому реконсиляция и тела без
   /// истории дают тот же результат, что хост.
   ///
   /// Импульс, если тело не в полёте, клетка центра — бустер с направлением
   /// `dir`, клетка прошлого шага `p − v·(1 + linear_damping·dt)·dt` того же
   /// уровня — НЕ бустер с тем же `dir` (вне сетки — не бустер) и
   /// `v·dir ≥ minEntrySpeed`. Условие «не бустер с тем же `dir`», а не «другая
   /// клетка»: переход между клетками одной плиты не должен давать повторный
   /// импульс.
   ///
   /// Множитель `1 + linear_damping·dt`: Rapier (и клиентский
   /// `rigid_body::integrate` движка) сдвигает тело скоростью ДО демпфирования,
   /// а хранит задемпфированную — скорость начала шага, умноженная на него, и
   /// есть скорость, с которой тело прошло прошлый шаг. Без множителя проекция
   /// недолетала на `v·linear_damping·dt²` (≈0.03 при 130 ед/с), и въезд с
   /// прошлым центром в этой полосе перед кромкой терял импульс.
   ///
   /// `vx`/`vy` — скорость НАЧАЛА шага, до всех импульсов шага;
   /// `linear_damping` — линейное демпфирование самого тела (модель танка,
   /// тело карты).
   ```

2. В сигнатуру между `vy: f32,` и `dt: f32,` добавить параметр `linear_damping: f32,`. Атрибут
   `#[allow(clippy::too_many_arguments)]` уже стоит.

3. Проверку «с той же плиты» заменить. Было:

   ```rust
       let from_same_plate = matches!(
           map.sample(level, x - vx * dt, y - vy * dt),
           Some((_, SurfaceKind::Boost { .. }, prev_dir)) if prev_dir == dir
       );
   ```

   Стало:

   ```rust
       // смещение прошлого шага: скорость до демпфирования (см. выше)
       let back = (1.0 + linear_damping * dt) * dt;
       let from_same_plate = matches!(
           map.sample(level, x - vx * back, y - vy * back),
           Some((_, SurfaceKind::Boost { .. }, prev_dir)) if prev_dir == dir
       );
   ```

   При `linear_damping = 0.0` `back` в f32 бит-в-бит равен `dt`, и поведение прежнее. На этом держатся тела карты
   без демпфирования и существующие юнит-тесты. Остальное тело функции не менять.

### 2.4. Вызывающие (четыре места)

1. `core/src/tank.rs`, `Tank::update` (~стр. 616–630), вызов `surface::boost_dv(` — после `start_velocity.y,`
   вставить `model.damping.linear,`:

   ```rust
               let (boost_x, boost_y) = surface::boost_dv(
                   map,
                   self.level_state.level,
                   self.level_state.airborne(),
                   position.x,
                   position.y,
                   start_velocity.x,
                   start_velocity.y,
                   model.damping.linear,
                   dt,
               );
   ```

   Тело танка создаётся с `.linear_damping(model.damping.linear)` (~стр. 207). Строкой ниже тот же
   `model.damping.linear` уже уходит в `boost_damping_dv`.

2. `core/src/client/predictor.rs`, `step_inner` (~стр. 1175–1186), вызов `surface::boost_dv(` — после `start_vy,`
   вставить `damping.0,`. Переменная `damping = (model.damping.linear, model.damping.angular)` объявлена в этой
   же функции (~стр. 1064), а ниже `damping.0` уже передаётся в `boost_damping_dv`.

3. `core/src/tanks.rs`, `apply_body_surfaces` (~стр. 1539–1581). Сейчас там:

   ```rust
               let vel = body.linvel();
               …
               let (boost_x, boost_y) =
                   surface::boost_dv(surfaces, state.level, falling, center.x, center.y, vel.x, vel.y, dt);
   ```

   Стало:

   ```rust
               let (boost_x, boost_y) = surface::boost_dv(
                   surfaces,
                   state.level,
                   falling,
                   center.x,
                   center.y,
                   vel.x,
                   vel.y,
                   body.linear_damping(),
                   dt,
               );
   ```

   `body` — тело карты Rapier (`&mut RigidBody`). Демпфирование ему задаёт движок из данных карты, геттер
   `RigidBody::linear_damping()` есть в rapier2d 0.34 (`Cargo.lock`).

4. `core/src/client/map_dynamics.rs`, `pre_step` (~стр. 480–495):

   ```rust
               let (boost_x, boost_y) = surface::boost_dv(map, body.level, falling, x, y, vx, vy, dt);
   ```

   Стало (поле реплики заполняется из данных карты, ~стр. 188: `body.body.linear_damping = item.linear_damping;`):

   ```rust
               let (boost_x, boost_y) =
                   surface::boost_dv(map, body.level, falling, x, y, vx, vy, body.body.linear_damping, dt);
   ```

   Doc-комментарий `pre_step` («те же `surface::body_mix`, `body_dv` и `boost_dv`, что у хоста… Состояния нет…»)
   остаётся верным.

### 2.5. Юнит-тесты `surface.rs`

1. В существующих вызовах `boost_dv(` в `#[cfg(test)]` (~стр. 985, 987, 989, 990, 991, 993, 994, 1002, 1022, 1044,
   1056 — всего 11) перед последним аргументом `DT` вставить `0.0,`, например:
   `boost_dv(&map, 0, false, 30.5, y, 120.0, 0.0, 0.0, DT)`. Ожидания не менять: при нулевом демпфировании
   поведение бит-в-бит прежнее. **Не трогать** вызовы `boost_damping_dv(…, DT)`: у них тоже `, DT)` в конце.
   Найти все нужные места: `grep -n "boost_dv(" core/src/surface.rs`.

2. После теста `boost_fires_on_entry_only` добавить (полоса `boost_strip("east")` — колонки 3..6 при шаге 10, плита
   с x = 30; `boostDv` 160, `boostMaxSpeed` 340):

   ```rust
   #[test]
   fn boost_entry_accounts_for_damping() {
       // тело прошло прошлый шаг скоростью до демпфирования: v·(1 + l·dt)·dt
       let map = boost_strip("east");

       // p − v·dt = 30.01 — уже плита, p − v·(1 + 3·dt)·dt = 29.985 — асфальт:
       // въезд, а не «та же плита»
       assert_eq!(boost_dv(&map, 0, false, 31.01, 25.0, 120.0, 0.0, 3.0, DT), (160.0, 0.0));
       // без демпфирования — прежняя проекция, импульса нет
       assert_eq!(boost_dv(&map, 0, false, 31.01, 25.0, 120.0, 0.0, 0.0, DT), (0.0, 0.0));
       // шаг после въезда: прошлая точка на плите — повтора нет
       assert_eq!(boost_dv(&map, 0, false, 45.0, 25.0, 120.0, 0.0, 3.0, DT), (0.0, 0.0));
   }
   ```

   Запас по f32: 30.01 и 29.985 отстоят от кромки 30.0 на 0.01 и 0.015.

### 2.6. Документация (en + ru)

1. `docs/en/core.md`, абзац **«The boost entry has no state.»** (~стр. 1404–1419):
   - «the cell `p − v·dt` on the same level» → «the cell of the previous step `p − v·(1 + linear·dt)·dt` on the
     same level»;
   - после предложения «…while neighbouring plates with different `dir` are different boosts.» вставить:

     > The factor `1 + linear·dt` (`linear` is the body's own linear damping: the tank model's `damping.linear`,
     > a map body's damping) is there because Rapier — and the client's `rigid_body::integrate` after it — moves a
     > body with the velocity *before* damping and stores the damped one: the step-start velocity times
     > `1 + linear·dt` is exactly the velocity that moved the body over the previous step. With plain `p − v·dt`
     > the look-back fell short by `v·linear·dt²` (≈ 0.03 units at 130 u/s), and a body whose previous centre lay
     > in that strip before the plate's edge lost the impulse — about 2.5 % of entries, and every straight
     > full-throttle run from the `downtown` respawn `spawn(9, 35)`.

   - абзац **«Order in `Tank::update`»** (~стр. 1459–1470): «(`boost_dv` gets `(vx0, vy0)` and the step's `dt`, both
     for `minEntrySpeed` and for `prev`;» → «(`boost_dv` gets `(vx0, vy0)`, the model's `damping.linear` and the
     step's `dt`, both for `minEntrySpeed` and for `prev`;».

2. `docs/ru/core.md`, абзац **«У въезда на бустер нет состояния.»** (~стр. 1352–1365):
   - «клетка `p − v·dt` того же уровня» → «клетка прошлого шага `p − v·(1 + linear·dt)·dt` того же уровня»;
   - после предложения «…а соседние плиты с разным `dir` — разные бустеры.» вставить:

     > Множитель `1 + linear·dt` (`linear` — линейное демпфирование самого тела: `damping.linear` модели танка,
     > демпфирование тела карты) нужен потому, что Rapier — и вслед за ним клиентский `rigid_body::integrate` —
     > сдвигает тело скоростью *до* демпфирования, а хранит задемпфированную: скорость начала шага, умноженная
     > на `1 + linear·dt`, и есть скорость, с которой тело прошло прошлый шаг. С простым `p − v·dt` проекция
     > недолетала на `v·linear·dt²` (≈ 0.03 ед. при 130 ед/с), и тело, чей прошлый центр лежал в этой полосе
     > перед кромкой плиты, теряло импульс — около 2.5 % въездов и каждый прямой проезд на полном газу с
     > респауна `downtown` `spawn(9, 35)`.

   - абзац **«Порядок в `Tank::update`»** (~стр. 1403–1415): «(`boost_dv` получает `(vx0, vy0)` и `dt` шага — и для
     `minEntrySpeed`, и для `prev`;» → «(`boost_dv` получает `(vx0, vy0)`, `damping.linear` модели и `dt` шага — и
     для `minEntrySpeed`, и для `prev`;».

Перенос строк — как у соседнего текста. Других упоминаний `p − v·dt` в docs нет: проверено по
`grep -n "v·dt" docs`.

### 2.7. CHANGELOG

В `CHANGELOG.md → ## [Unreleased]` подраздела `### Fixed` пока нет. Добавить его после `### Changed`, перед
`## [0.22.14]`:

```markdown
### Fixed

- A boost plate no longer skips its push for some entry positions — among
  them every straight full-throttle run from the `downtown` respawn in front
  of the parking-roof ramp: the entry check now accounts for the body's
  linear damping when it looks one step back (`surface::boost_dv`).
```

## Проверка

```bash
cargo test --workspace -q          # весь Rust, включая parity-сьют и sim.rs
npm run core:build                 # оба WASM-таргета: JS-тесты ядра грузят core/pkg-node
npx vitest run tests/core --reporter=dot
npx eslint . --quiet
npx vitest run --reporter=dot
```

Должны остаться зелёными, в частности:
- `core/src/surface.rs`: `boost_fires_on_entry_only`, `boost_entry_from_off_the_grid_fires`,
  `adjacent_plates_with_different_dirs_are_different_boosts`, `plate_without_hold_starts_nothing`,
  `held_boost_raises_the_ceiling_until_it_expires`;
- `core/src/client/predictor.rs → mod parity`: `boost_pad_fires_once`, `boost_plate_2x3_lengthwise`,
  `boost_adjacent_plates_different_dir`, `boost_against_arrow_does_nothing`,
  `boost_reconcile_replays_one_impulse_per_entry`, `boost_hold_at_full_speed_in_parity`,
  `boost_hold_reconcile_rewinds_the_timer`;
- `core/tests/sim.rs`: `boost_fires_once_per_entry`, `boost_entry_from_off_the_grid_fires`,
  `boost_hold_keeps_speed_above_max`, `boost_hold_expires`, `boost_pushes_a_crate_once` и новый
  `boost_fires_for_every_entry_phase`.

Необязательная контрольная развёртка на игровом конфиге. Файл кладётся во временный каталог сессии, не в
репозиторий, запуск — из корня проекта. До исправления она давала `misses 5/200`, после должна дать
`misses 0/200`:

```js
// sweep.mjs — node <путь>/sweep.mjs (cwd = корень vimp-tanks)
import { makeCore } from '<абсолютный путь к>/vimp-tanks/tests/core/helpers.js';
import downtown from '<абсолютный путь к>/vimp-tanks/src/data/maps/downtown.js';

const DT = 1 / 120;
const tile = 32 * downtown.scale;
const cell = v => (v + 0.5) * tile;
const bad = [];

for (let k = 0; k < 200; k += 1) {
  const sx = cell(8.5) + k * 0.006;
  const core = makeCore();

  core.load_map(JSON.stringify(downtown));
  core.spawn_actor(1, 'm1', 1, sx, cell(35), 0);
  core.apply_input(1, 1, 'down', 'forward');

  let prev = core.position_of(1)[0];
  let peak = 0;

  for (let i = 0; i < 200; i += 1) {
    core.step(DT);
    const x = core.position_of(1)[0];
    peak = Math.max(peak, (x - prev) / DT);
    prev = x;
  }

  if (peak < 300) {
    bad.push(sx.toFixed(3));
  }
}

console.log(`misses ${bad.length}/200`, bad.join(' '));
```

## Критерий готовности

- JS-тест из 2.1 зелёный на `cell(9)`, комментария про «граничный случай» нет.
- `boost_fires_for_every_entry_phase` был красным до правки и зелёный после.
- Весь `cargo test --workspace -q`, `vitest` и `eslint` зелёные.
- В `LevelState` новых полей нет. `core.md` en/ru и CHANGELOG (`### Fixed`) обновлены.
