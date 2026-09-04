# Этап 1. E, крейт: N уровней, наклон, падение, тела карты, `volumes` ✅ выполнен

**Репозиторий:** E (`/Users/dmitry/Sites/my/vimp`). **Зависит от:** 0.
**Блокирует:** 2 и всё, что после.

**Файлы:** `packages/engine/core/src/map.rs` (основное),
`packages/engine/core/src/nav/navigation.rs`,
`packages/engine/core/src/game.rs`, `packages/engine/core/src/config.rs`,
`packages/engine/contract/fixtures/layered/*.json`,
`packages/engine/core/CHANGELOG.md`, `packages/engine/core/Cargo.toml`.

## Цель

Снять двухуровневый потолок и дать игре примитивы, которых ей не хватает:
крутизну рампы, приземление на ближайшую нижнюю плиту, общую модель
падения, правила уровня для тел карты и визуальную высоту слоёв.

## 1.1 `MAX_LEVELS = 8` и настоящие биты уровней

Сейчас (`map.rs`):

```rust
pub const MAX_LEVELS: usize = 2;                       // :22
pub fn level_group(level: u8) -> Group {               // :448
    debug_assert!((level as usize) < MAX_LEVELS, "...");
    match level { 0 => Group::GROUP_1, _ => Group::GROUP_2 }   // :457-460
}
pub const STATIC_LEVEL_GROUP: Group = Group::GROUP_9;  // :469
```

Любой уровень ≥ 1 схлопывается в одну группу — это и есть главный
блокиратор задачи 6. Заменить на честный бит на уровень:

```rust
pub const MAX_LEVELS: usize = 8;
// STATIC_LEVEL_GROUP занимает бит 8 (GROUP_9), значит уровням остаются
// биты 0..7. Больше восьми уровней потребует переезда статической группы
const _: () = assert!(MAX_LEVELS <= 8);

pub fn level_group(level: u8) -> Group {
    debug_assert!((level as usize) < MAX_LEVELS,
        "level_group: level {level} is out of range (MAX_LEVELS: {MAX_LEVELS})");
    Group::from_bits_truncate(1u32 << (level as u32).min(MAX_LEVELS as u32 - 1))
}
```

`min(...)` — не украшение: в release-сборке `debug_assert!` выключен, а
сдвиг на ≥ 32 в Rust — паника/UB-подобное поведение; клампом уровень вне
диапазона схлопывается в верхний, как и раньше, но громко ловится в
отладке.

Обязательный инвариант: для 0 и 1 значения **прежние**
(`GROUP_1 = 1<<0`, `GROUP_2 = 1<<1`) — иначе рассыплется всё уже
собранное. Закрепить тестом.

Сопутствующие места: сообщение валидатора
`"map levels: {level_count} levels, at most {MAX_LEVELS} supported"`
(`map.rs:153-157`), `static_level_interaction`, `level_interaction`,
`levels_interaction`, тесты `map.rs` (~1296-1321), где ожидания записаны
константами `GROUP_1|STATIC`, `GROUP_2|STATIC`.

## 1.2 Многоуровневая рампа и её крутизна

`RampConfig { tile, dir, from, to }` уже несёт `from`/`to`
(`#[serde(default)]` = 0 и `default_ramp_to()` = 1). Снять предположение
`|to - from| == 1`.

`RampSample` (сейчас `{ progress, from, to }`, `map.rs:491-497`)
дополнить:

```rust
pub struct RampSample {
    pub progress: f32,
    pub from: u8,
    pub to: u8,
    /// Единичный вектор «в горку» в мировых координатах (из RampRun.axis/sign).
    pub dir: [f32; 2],
    /// Крутизна: уровней на мировую единицу вдоль `dir`, всегда > 0.
    pub slope: f32,
    /// Индекс прогона в `MapLevels::runs` и его ось (0 = x, 1 = y).
    /// Нужны игре, чтобы отличить заход на прогон с торца от заезда
    /// сбоку: гейт сравнивает клетку входа с предыдущей клеткой танка
    /// вдоль оси прогона (см. stage_3.md §3.2).
    pub run: u16,
    pub axis: u8,
}
```

Считается в `ramp_at` (`map.rs:820-839`) по данным `RampRun`:

```rust
let span = run.max - run.min;                       // длина прогона, мировые единицы
let slope = (run.to as f32 - run.from as f32).abs() / span.max(f32::EPSILON);
let dir = match (run.axis, run.sign) {
    (0, s) => [s as f32, 0.0],
    (_, s) => [0.0, s as f32],
};
// индекс прогона уже известен: его отдаёт `run_cells[cy][cx]`
```

Оба поля нужны игре: продольный уклон под танком —
`slope * dot(dir, heading)` (этап 3.5), клиент по ним рисует ракурс
(этап 6.4).

Новая проверка в `validate_levels`: для прогона `from → to` ни один
промежуточный уровень `L` (`min(from,to) < L < max(from,to)`) не должен
иметь `floor` над клетками прогона — иначе рампа прошивает чужую плиту.
Сообщение:
`ramp {index} climbs {from}->{to} through level {L} floor at ({x}, {y})`.

## 1.3 Приземление на ближайший нижний уровень

```rust
impl MapLevels {
    /// Уровень, на который приземлится тело, сорвавшееся с `from` в точке
    /// (x, y): ближайший уровень строго ниже `from`, у которого в этой
    /// клетке есть `floor`; 0, если такого нет (земля есть везде внутри
    /// карты).
    pub fn landing_level(&self, from: u8, x: f32, y: f32) -> u8 {
        for level in (1..from).rev() {
            if self.has_floor(level, x, y) { return level; }
        }
        0
    }
}
```

Заменяет три жёстких «падаем на 0»:

1. `validate_level_edges` (`map.rs:270-309`) — открытый край плиты сейчас
   требует проходимой земли **уровня 0**; должен требовать проходимой
   поверхности `landing_level` (плита уровня N-1 под обрывом — законный
   обрыв, а не дыра);
2. `NavigationSystem::connect_ledges` (`nav/navigation.rs:295-347`) —
   ребро-обрыв всегда ведёт в `closest_visible_node_on(0, …)`; должно
   вести на `landing_level`, а `LEDGE_PENALTY` (1500.0,
   `navigation.rs:15`) — умножаться на высоту падения `(from - to)`;
3. правила падения в игре (этап 3.1).

## 1.4 Падение как общий примитив

Новый тип рядом с `MapLevels` — единственная траектория падения на всю
экосистему:

```rust
/// Геометрия падения. Игра добавляет поверх свои правила (блокировка
/// ввода, урон), но саму траекторию обязана брать здесь — иначе ящик и
/// танк падают по-разному, и это расходится молча.
#[derive(Clone, Copy, Debug)]
pub struct FallModel { pub time_per_level: f32 }   // по умолчанию 0.35

impl FallModel {
    /// Длительность падения на высоту `height` уровней.
    pub fn duration(&self, height: f32) -> f32 { height.abs() * self.time_per_level }
    /// Высота через `elapsed` секунд после срыва с `from` на `to`.
    pub fn z_at(&self, from: f32, to: f32, elapsed: f32) -> f32 {
        let d = self.duration(from - to);
        let t = if d <= 0.0 { 1.0 } else { (elapsed / d).clamp(0.0, 1.0) };
        lerp(from, to, t)
    }
    /// Обратная к `z_at`: сколько уже длится падение, если высота `z`.
    pub fn elapsed_at(&self, from: f32, to: f32, z: f32) -> f32 { /* ... */ }
}
```

Модель остаётся линейной (как нынешний `lerp` в танках), но длительность
растёт с высотой: падение с уровня 3 втрое дольше падения с уровня 1.
`elapsed_at` нужна клиентской реплике для восстановления фазы падения из
авторитетного кадра.

## 1.5 Правила уровня у тел карты (задача 1)

Сегодня `GameMap` держит `dynamic_levels: Vec<u8>`, параллельный
`dynamic_bodies`, и назначает группу один раз в `create_dynamic`
(`map.rs:973-1012`, `.collision_groups(level_interaction(data.level))`).
После этого уровень тела не меняется никогда.

Добавить:

```rust
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct BodyLevelState {
    pub level: u8,
    pub z: f32,
    /// Some((to, elapsed)) — падение на уровень `to`.
    pub falling: Option<(u8, f32)>,
}

pub enum BodyLevelEvent { None, Landed }

/// Шаг правил уровня для ОДНОГО тела. Свободная функция: её зовёт и хост
/// (через `GameMap::step_dynamic_levels`), и клиентская реплика игры для
/// предсказанных тел — иначе ящик у зрителя падает не туда, куда на хосте.
pub fn step_body_level(
    state: &mut BodyLevelState, x: f32, y: f32,
    levels: &MapLevels, fall: &FallModel, dt: f32,
) -> BodyLevelEvent;

/// Маска тела: в падении — только статика (стены есть, тел нет).
pub fn body_collision_mask(state: &BodyLevelState) -> Group;
```

Правило: тело, под которым не осталось `floor` своего уровня (и уровень
≥ 1), срывается на `landing_level`; пока падает — маска
`STATIC_LEVEL_GROUP`; `z` идёт `from → to` по `FallModel`; по
приземлении получает `level_interaction(to)`. **Рампы телам недоступны**
— их толкают, а не ведут; на клетке рампы тело сохраняет свой уровень.

Хостовая обвязка на `GameMap`:

```rust
pub fn step_dynamic_levels(&mut self, world: &mut PhysicsWorld, fall: &FallModel, dt: f32);
pub fn dynamic_level_state(&self, index: usize) -> BodyLevelState;
```

**Зовёт её движок, не игра**: `SimCtx.map` — `&Option<GameMap>`
(`sim.rs:32`), у игры нет мутабельного доступа. Вызов ставится в
`EngineSim::step_fixed` (`game.rs:243`) **до** сборки `SimCtx` и до
`world.step_with_events`:

```rust
if let Some(map) = self.map.as_mut() {
    map.step_dynamic_levels(&mut self.world, &self.fall_model, self.time_step);
}
```

Параметр — новое необязательное поле движковой половины конфига
(`EngineConfig`, `config.rs:12-23`): `mapFallTime`, по умолчанию 0.35;
собирается в `packages/engine/src/lib/coreConfig.js` (этап 2).

### Строка снапшота

`dynamic_map_data` (`map.rs:1088-1124`) сегодня пишет `[x, y, angle]` +
необязательный хвост `[vx, vy, angvel]` (`optionalFrom`, покоящееся тело
хвост не шлёт). `z`/`level` обязаны попасть в **голову**:

```
[x, y, angle, z, level]  (+ хвост [vx, vy, angvel])   →  optionalFrom: 5
```

В хвост их класть нельзя: отсутствующий хвост декодируется нулями, и
покоящийся ящик на мосту у зрителя «упал» бы на землю.

Признак включения — схема набора карт, которую объявила игра
(`self.cfg.snapshot.keys.get(&map.set_id)`, `game.rs:307-322`): писать
`z`/`level`, если схема объявляет поля с именами `z` и `level` на
позициях 3 и 4. Если `SnapshotSchema` не хранит имена полей — включать по
признаку `optional_from == Some(5)` при ширине 8 и записать это в
доккомментарии как контракт. Игра со старой схемой получает прежние три
поля, `vimp-snakes` не трогается.

`GameMap::create` заполняет стартовое состояние из `dynamic_levels`
(`z = level as f32`, `falling: None`).

## 1.6 Высота слоя (`volumes`) — данные для задачи 7

`MapConfig` (уровень 0) и `MapLevelConfig` получают:

```rust
/// Визуальная высота рендер-слоя в уровнях: { "<ключ layers>": 0.6 }.
/// Ядро её не использует — поле едет клиенту и живёт только в рендере.
#[serde(default)]
pub volumes: IndexMap<String, f32>,
```

Проверка в `validate_levels`: ключ обязан быть ключом `layers` того же
уровня; значение конечно, `> 0`, `<= MAX_LEVELS as f32`. Сообщения:
`level {key} volumes names layer {layer}, which is not a render layer` и
`level {key} volumes layer {layer} height {h} is not in (0, {MAX_LEVELS}]`.

## 1.7 Нав-граф

`generate_layered` уже обходит `0..level_count` и строит рампы через
`run.from`/`run.to` — правка нужна только в `connect_ledges` (см. 1.3).
Тестовый `assert!(path.iter().any(|p| p.level == 1))`
(`navigation.rs:737`) про двухуровневую фикстуру — оставить.

## Тесты

В `map.rs`/`nav/navigation.rs` (`#[cfg(test)]`) + общий корпус
`packages/engine/contract/fixtures/layered/` (формат
`{ note, expect?, map }`, **ровно один дефект на файл** — Rust
останавливается на первой ошибке, JS собирает все; читают корпус
`map::tests::shared_layered_fixtures` и
`tests/devtools/contract/e4-map-layers.test.js`):

* `level_group` даёт разные биты для 0..7, ни один не пересекается со
  `STATIC_LEVEL_GROUP`; для 0 и 1 значения прежние;
* карта с уровнями 1..3 принимается; с дырой (1, 3) — отвергается;
  с девятью — отвергается по `MAX_LEVELS`;
* `landing_level`: с 2 над плитой 1 → 1; над открытой землёй → 0;
* открытый край плиты уровня 2 над плитой уровня 1 валиден (сегодня
  требует земли);
* рампа 0 → 2 валидна без промежуточной плиты и отвергается с ней;
* `RampSample.slope`: прогон в 2 клетки круче прогона в 4; `dir`
  совпадает со знаком оси; `progress` не изменился;
* `FallModel::elapsed_at` — обратная к `z_at` (свойство, а не число);
  `duration` растёт с высотой;
* `step_body_level`: ящик за краем плиты приземляется на `landing_level`
  и меняет группу; ящик в глубине плиты неподвижен; на клетке рампы
  уровень не меняется;
* `dynamic_map_data` пишет 5 полей при новой схеме и 3 при старой;
  покоящееся тело по-прежнему не шлёт хвост;
* `connect_ledges` строит ребро на уровень 1, а не на 0, если под
  обрывом плита; штраф растёт с высотой;
* новые фикстуры: `bad-levels-too-many.json`,
  `bad-ramp-through-slab.json`, `bad-volumes-unknown-layer.json`,
  `bad-volumes-height.json`, `good-three-levels.json`.

## Проверка

```bash
cd /Users/dmitry/Sites/my/vimp \
  && cargo test -p vimp-engine-core --quiet \
  && cargo clippy -p vimp-engine-core --all-targets \
  && cargo test --workspace --quiet
```

Журнал: записи в `packages/engine/core/CHANGELOG.md` под
`## [Unreleased]` (`### ⚠️ Breaking` — `RampSample`, `MAX_LEVELS`,
сигнатура `dynamic_map_data`, форма строки динамики).

## Отклонения

1. **`validate_levels` сменила сигнатуру** (в плане это не значилось, но
   иначе §1.6 невыполним): перед `levels`/`ramps` добавлены `layers` и
   `volumes` УРОВНЯ 0 — он живёт в корне конфига карты, а проверка высот
   объявлена общей для всех уровней. Правка `ClientMapConfig` в танках
   (`core/src/client/mod.rs:421`) — этап 3. Записано в журнал крейта как
   breaking.
2. **`MapConfig` получил поле `layers`** (раньше ядро игнорировало рендер-
   поля): без области определения ключей проверять `volumes` уровня 0 не
   на чем.
3. **`GameMap::dynamic_levels` теперь отдаёт `Vec<u8>`, а не `&[u8]`**:
   параллельный массив уровней заменён на `Vec<BodyLevelState>`, а дамп
   `debug.rs` собирает список уровней на месте.
4. **Версия `core/Cargo.toml` не поднята**: релиз 0.12.0 делает этап 2,
   там же собирается `mapFallTime` в `coreConfig.js`. В файлах этапа
   `Cargo.toml` числился, но менять в нём на этом шаге нечего.
5. **4 новые фикстуры красят JS-правило `E4`** (`bad-levels-too-many`,
   `bad-ramp-through-slab`, `bad-volumes-height`,
   `bad-volumes-unknown-layer`): Rust их отвергает, JS-правило этих
   проверок ещё не знает — это ровно работа этапа 2. `good-three-levels`
   зелёная с обеих сторон. Rust-корпус (`shared_layered_fixtures`) зелёный.
6. **`cargo clippy` красный ровно как до этапа** (4 ошибки
   `approx_constant` в `physics.rs` и предупреждение про индекс `y` в
   `create_static` — базовая линия этапа 0); новых замечаний правки не
   добавили.

## Сделано

* `map.rs`: `MAX_LEVELS = 8` + `const _: () = assert!(MAX_LEVELS <= 8)`,
  побитовый `level_group`, `RampSample { dir, slope, run, axis }`,
  `MapLevels::landing_level`, `FallModel`/`DEFAULT_FALL_TIME`,
  `BodyLevelState`/`BodyLevelEvent`/`step_body_level`/`body_collision_mask`,
  `GameMap::step_dynamic_levels`/`dynamic_level_state`,
  `dynamic_map_data(world, with_levels, with_velocities)`, поля `volumes`
  (и `layers` у корня), проверки «рампа сквозь плиту» и «край плиты — на
  `landing_level`», `validate_volumes`.
* `config.rs`: `EngineConfig.mapFallTime` (дефолт `DEFAULT_FALL_TIME`).
* `game.rs`: `FallModel` в `EngineSim`, вызов `step_dynamic_levels` в
  начале `step_fixed`, включение `z`/`level` по именам полей 3 и 4 схемы.
* `nav/navigation.rs`: обрыв ведёт на `landing_level`, `LEDGE_PENALTY`
  умножается на высоту падения.
* Тесты: 13 новых (11 в `map.rs`, 2 в `nav/navigation.rs`), 159 зелёных;
  5 новых фикстур корпуса.
* Журнал `packages/engine/core/CHANGELOG.md` и `docs/en|ru/core.md`.
