# Этап 1 — крейт движка: слоёная геометрия карты

**Репозиторий:** `E` = `/Users/dmitry/Sites/my/vimp`
**Крейт:** `packages/engine/core` (`vimp-engine-core`)

Цель: движок умеет читать карту с надземными уровнями, строить для каждого
уровня свою статику с битовыми масками Rapier, отвечать на вопросы «есть ли
здесь пол уровня N», «я на рампе — какой прогресс», и строить нав-граф со
слоями и переходами. Игровой код (`vimp-tanks`) на этом этапе не трогаем.

Инвариант этапа: **карта без поля `levels` ведёт себя ровно как сегодня**.
Порядок вставки тел, значения `step`, содержимое `grid`, вывод нав-графа —
без изменений. Это проверяется существующими тестами крейта и (в этапе 8)
сценариями танков.

## 1.0 Подготовка

1. Выполнить связку репозиториев и базовую линию из `plan/README.md`.
2. `cd /Users/dmitry/Sites/my/vimp && cargo test --workspace --quiet` —
   зелёное.

## 1.1 `packages/engine/core/src/map.rs` — типы конфигурации

Добавить (рядом с `DynamicObjectConfig`):

```rust
/// Максимум поддерживаемых уровней: земля + одна эстакада. Больше двух
/// упирается в 2.5D-модель (у луча/танка ровно один «текущий» уровень) и
/// в бюджет масок Rapier, отведённый под уровни.
pub const MAX_LEVELS: usize = 2;

/// Описание НАДЗЕМНОГО уровня карты (level >= 1). Уровень 0 остаётся в
/// полях `map`/`physicsStatic`/`layers` — так карта старого формата
/// продолжает грузиться без единой правки.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapLevelConfig {
    /// Грид тайлов этого уровня; размерность обязана совпадать с `map`.
    /// Значение `0` — пустота (уровня здесь нет, видно нижний).
    pub map: Vec<Vec<i32>>,
    /// Тайлы, по которым МОЖНО ездить на этом уровне (плита моста).
    #[serde(default)]
    pub floor: Vec<i32>,
    /// Тайлы-стены этого уровня (перила): блокируют движение и луч.
    /// Тайл перил обычно входит и в `floor` — по нему нельзя ехать сквозь,
    /// но он часть плиты и экранирует луч снизу.
    #[serde(default)]
    pub walls: Vec<i32>,
    /// Рендер-слои этого грида (zIndex -> список тайлов). Клиентское поле,
    /// ядро его игнорирует.
    #[serde(default)]
    pub layers: IndexMap<String, Vec<i32>>,
}

/// Направление ПОДЪЁМА рампы (куда ехать, чтобы подняться).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RampDir {
    /// -y
    North,
    /// +y
    South,
    /// -x
    West,
    /// +x
    East,
}

impl RampDir {
    /// (ось: 0 = x, 1 = y; знак: +1 — подъём в сторону роста координаты).
    pub fn axis_sign(self) -> (u8, i8) {
        match self {
            RampDir::North => (1, -1),
            RampDir::South => (1, 1),
            RampDir::West => (0, -1),
            RampDir::East => (0, 1),
        }
    }
}

/// Рампа: тайл-переход между уровнями.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RampConfig {
    /// Индекс тайла в гриде уровня `from`.
    pub tile: i32,
    pub dir: RampDir,
    #[serde(default)]
    pub from: u8,
    #[serde(default = "default_ramp_to")]
    pub to: u8,
}

fn default_ramp_to() -> u8 {
    1
}
```

`DynamicObjectConfig` дополнить:

```rust
    /// Уровень, на котором стоит тело (0 — земля).
    #[serde(default)]
    pub level: u8,
```

`MapConfig` дополнить и изменить `respawns`:

```rust
    /// Надземные уровни: ключ — номер уровня строкой ("1"). Отсутствие поля
    /// = одноуровневая карта.
    #[serde(default)]
    pub levels: IndexMap<String, MapLevelConfig>,
    #[serde(default)]
    pub ramps: Vec<RampConfig>,
```

```rust
-    pub respawns: IndexMap<String, Vec<[f32; 3]>>,
+    /// [x, y, angleDeg] либо [x, y, angleDeg, level] — 4-й элемент
+    /// необязателен: без него уровень выводится из геометрии
+    /// (`GameMap::level_at`).
+    pub respawns: IndexMap<String, Vec<Vec<f32>>>,
```

> **Ловушка.** `Vec<[f32; 3]>` отбивает массив из 4 чисел ошибкой
> `invalid length 4`. Смена типа на `Vec<Vec<f32>>` — обязательна, иначе
> карта с уровнем в респауне не загрузится вовсе.

## 1.2 `map.rs` — маски слоёв

```rust
use rapier2d::prelude::{Group, InteractionGroups, InteractionTestMode};

/// Битовая маска слоя для InteractionGroups. Уровень 0 — GROUP_1,
/// уровень 1 — GROUP_2. Тела за пределами реестра (не выставившие группы)
/// остаются в `Group::ALL` и поэтому продолжают взаимодействовать с
/// уровнем 0 — старые карты и старые игры не замечают появления слоёв.
pub fn level_group(level: u8) -> Group {
    match level {
        0 => Group::GROUP_1,
        _ => Group::GROUP_2,
    }
}

/// Маска «я на уровне `level` и вижу только его».
pub fn level_interaction(level: u8) -> InteractionGroups {
    let group = level_group(level);

    InteractionGroups::new(group, group, InteractionTestMode::And)
}

/// Маска «я вижу все уровни из `mask`» (танк на рампе).
pub fn levels_interaction(mask: Group) -> InteractionGroups {
    InteractionGroups::new(mask, mask, InteractionTestMode::And)
}
```

## 1.3 `map.rs` — `MapLevels`: слоёная геометрия без физического мира

Ключевая структура этапа. **Её строит и хост (внутри `GameMap`), и
клиентская реплика игры** (этап 5) — из одних и тех же полей `MAP_DATA`.
Одна реализация правил на обе стороны: иначе предсказание уровня разъедется
с авторитетным молча.

```rust
/// Результат попадания точки на рампу.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RampSample {
    /// 0.0 у подножия прогона, 1.0 на его верхней кромке.
    pub progress: f32,
    pub from: u8,
    pub to: u8,
}

/// Прогон рампы: максимальная непрерывная линия тайлов одной рампы вдоль её
/// оси в одной строке (ось x) или колонке (ось y).
#[derive(Clone, Serialize, Deserialize)]
pub struct RampRun {
    /// 0 = x, 1 = y.
    pub axis: u8,
    /// +1 — подъём в сторону роста координаты.
    pub sign: i8,
    pub from: u8,
    pub to: u8,
    /// Границы прогона по своей оси в МИРОВЫХ (масштабированных) единицах.
    pub min: f32,
    pub max: f32,
}

/// Слоистая геометрия карты без физического мира: гриды уровней, списки
/// сплошных тайлов, прогоны рамп. Хост держит её внутри `GameMap`,
/// клиентская реплика игры строит из полей MAP_DATA — правила уровней у
/// обеих сторон читаются отсюда и только отсюда.
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct MapLevels {
    /// Гриды по индексу уровня: [0] — земля, [1] — эстакада.
    grids: Vec<Vec<Vec<i32>>>,
    /// Тайлы-стены по уровням (для 0 — `physicsStatic`, для N — `walls`).
    solid: Vec<Vec<i32>>,
    /// Тайлы-пол по уровням (для 0 — пусто: земля есть везде внутри карты).
    floor: Vec<Vec<i32>>,
    runs: Vec<RampRun>,
    /// Параллелен `grids[0]`: индекс прогона рампы в клетке либо -1.
    run_cells: Vec<Vec<i16>>,
    /// Размер тайла в МИРОВЫХ единицах (step * scale).
    tile_size: f32,
}
```

Методы:

```rust
impl MapLevels {
    /// `grid0`/`solid0` — грид и стены уровня 0; `levels` — конфиги
    /// надземных уровней (ключ — номер строкой); `ramps` — конфиги рамп;
    /// `tile_size` — УЖЕ масштабированный размер тайла.
    pub fn build(
        grid0: &[Vec<i32>],
        solid0: &[i32],
        levels: &IndexMap<String, MapLevelConfig>,
        ramps: &[RampConfig],
        tile_size: f32,
    ) -> Self;

    /// Есть ли надземные уровни (2.5D-режим).
    pub fn is_layered(&self) -> bool;
    /// Число уровней, включая землю (1 у обычной карты).
    pub fn level_count(&self) -> usize;
    pub fn tile_size(&self) -> f32;

    pub fn grid(&self, level: u8) -> Option<&Vec<Vec<i32>>>;
    pub fn solid(&self, level: u8) -> &[i32];
    pub fn floor(&self, level: u8) -> &[i32];

    /// (колонка, строка) по мировой точке; None вне карты.
    pub fn cell_at(&self, x: f32, y: f32) -> Option<(usize, usize)>;

    /// Есть ли пол уровня `level` в точке. Для уровня 0 — true везде внутри
    /// карты (под мостом земля никуда не девается).
    pub fn has_floor(&self, level: u8, x: f32, y: f32) -> bool;

    /// Стена уровня `level` в точке.
    pub fn is_solid(&self, level: u8, x: f32, y: f32) -> bool;

    /// Наивысший уровень, у которого есть пол в точке. Спавн без явного
    /// уровня приземляется сюда.
    pub fn level_at(&self, x: f32, y: f32) -> u8;

    /// Рампа под точкой.
    pub fn ramp_at(&self, x: f32, y: f32) -> Option<RampSample>;
}
```

### Алгоритм `build`

1. `grids[0] = grid0.to_vec()`, `solid[0] = solid0.to_vec()`,
   `floor[0] = vec![]`.
2. Для каждого `level` из `levels`, отсортированного по числовому ключу
   (детерминизм!): распарсить ключ в `u8`; уровень `0` в `levels`
   **запрещён** (см. валидацию); индексы должны идти подряд от 1 без
   пропусков. Класть `grid`, `walls` → `solid[level]`,
   `floor[level]` → `floor[level]`.
3. `run_cells` заполнить `-1` размерами `grids[0]`.
4. Прогоны рамп: для каждого `RampConfig` в порядке объявления, взять
   `(axis, sign) = dir.axis_sign()` и грид уровня `from`.
   * Для `axis == 1` (вертикальная рампа): сканировать колонки `x` слева
     направо, внутри колонки строки `y` сверху вниз; найдя первую клетку с
     `tile`, расширить вниз, пока тайл тот же; получить `[y0..y1]`;
     `min = y0 as f32 * tile_size`, `max = (y1 + 1) as f32 * tile_size`.
   * Для `axis == 0` — симметрично по строкам.
   * Записать индекс прогона во все клетки прогона в `run_cells`.
   * Клетка, уже занятая прогоном, пропускается (первая объявленная рампа
     выигрывает — детерминированно).
   * Если прогонов стало больше `i16::MAX`, лишние игнорируются.
5. `tile_size` сохранить.

### `ramp_at`

```rust
let (cx, cy) = self.cell_at(x, y)?;
let index = *self.run_cells.get(cy)?.get(cx)?;
if index < 0 { return None; }
let run = &self.runs[index as usize];
let value = if run.axis == 0 { x } else { y };
let span = run.max - run.min;
let raw = if span <= 0.0 { 0.0 } else { (value - run.min) / span };
let progress = if run.sign > 0 { raw } else { 1.0 - raw };

Some(RampSample { progress: progress.clamp(0.0, 1.0), from: run.from, to: run.to })
```

## 1.4 `map.rs` — `MapConfig::validate`

Новый метод, вызывается из `GameMap::create` (а точнее из
`EngineSim::load_map` до создания тел — см. 1.7). Возвращает
`Result<(), String>`; текст ошибки уходит наружу как ошибка `load_map`.

Проверки:

1. `levels` не пуст → ключи парсятся в `u8`, все `>= 1`, идут подряд от 1,
   максимум `MAX_LEVELS - 1` уровней.
2. Размерность каждого `levels[n].map` совпадает с `map` (число строк и
   длина каждой строки).
3. `levels[n].walls ⊆ levels[n].floor` — перила обязаны быть частью плиты
   (иначе перила «висят в воздухе» и луч снизу их не увидит).
4. Каждый `ramps[i].tile` встречается в гриде уровня `ramps[i].from` хотя
   бы раз.
5. `ramps[i].from != ramps[i].to`, оба `< level_count`.
6. Каждый респаун — массив длиной 3 или 4; если 4, то `level < level_count`.
7. Каждый `physicsDynamic[i].level < level_count`.

> Почему громко: любая из этих ошибок в рантайме молчит. Карта с
> рассинхроном размерностей гридов даёт танк, проваливающийся в пустоту, и
> ни одной строки в консоли.

## 1.5 `map.rs` — `GameMap`

```rust
#[derive(Serialize, Deserialize)]
pub struct GameMap {
    pub set_id: String,
    pub step: f32,
    /// Сетка тайлов уровня 0 (немасштабируемая) — источник нав-сетки.
    pub grid: Vec<Vec<i32>>,
    pub physics_static: Vec<i32>,
    /// [x, y, angleDeg] или [x, y, angleDeg, level] (масштабированные x/y).
    pub respawns: IndexMap<String, Vec<Vec<f32>>>,
    /// Слоистая геометрия (пустая у одноуровневой карты).
    levels: MapLevels,
    static_bodies: Vec<RigidBodyHandle>,
    dynamic_bodies: Vec<RigidBodyHandle>,
    /// Уровень каждого динамического тела, параллелен `dynamic_bodies`.
    dynamic_levels: Vec<u8>,
}
```

Новые публичные методы-делегаты (тонкие обёртки над `self.levels`):

```rust
pub fn levels(&self) -> &MapLevels;
pub fn is_layered(&self) -> bool;
pub fn level_count(&self) -> usize;
pub fn level_at(&self, x: f32, y: f32) -> u8;
pub fn has_floor(&self, level: u8, x: f32, y: f32) -> bool;
pub fn ramp_at(&self, x: f32, y: f32) -> Option<RampSample>;
/// Уровень динамического тела по его индексу в блоке снапшота.
pub fn dynamic_level(&self, index: usize) -> u8;
```

### `create`

```rust
let scale = cfg.scale.unwrap_or(default_scale);
let step = cfg.step * scale;

let levels = MapLevels::build(&cfg.map, &cfg.physics_static, &cfg.levels, &cfg.ramps, step);
```

`respawns` масштабируются с сохранением хвоста:

```rust
arr.iter()
   .map(|point| {
       let mut out = point.clone();
       if out.len() >= 2 { out[0] *= scale; out[1] *= scale; }
       out
   })
   .collect()
```

### `create_static` — по уровням

Переписать так, чтобы жадный блочный поиск шёл **по каждому уровню**, в
порядке 0, 1, …; в каждом уровне — прежний порядок обхода (строки сверху
вниз, колонки слева направо). Тогда для одноуровневой карты порядок вставки
тел не меняется вовсе.

```rust
fn create_static(&mut self, world: &mut PhysicsWorld) {
    for level in 0..self.levels.level_count() as u8 {
        let Some(grid) = self.levels.grid(level) else { continue };
        let solid = self.levels.solid(level).to_vec();

        let mut work: Vec<Vec<Option<i32>>> = grid
            .iter()
            .map(|row| row.iter().map(|&tile| Some(tile)).collect())
            .collect();

        for y in 0..work.len() {
            for x in 0..work[y].len() {
                let is_static = work[y][x].is_some_and(|tile| solid.contains(&tile));

                if is_static {
                    let (width, height) = search_static_block(&mut work, &solid, self.step, y, x);
                    // ... как сейчас, плюс:
                    world.insert_collider(
                        ColliderBuilder::cuboid(width / 2.0, height / 2.0)
                            .friction(DEFAULT_FRICTION)
                            .restitution(DEFAULT_RESTITUTION)
                            .collision_groups(level_interaction(level)),
                        Some(body),
                    );
                    self.static_bodies.push(body);
                }
            }
        }
    }
}
```

`search_static_block` вынести из `impl GameMap` в свободную функцию с
параметрами `(work, solid, step, y0, x0)` — она больше не может брать
`self.physics_static`, потому что список сплошных тайлов теперь свой у
каждого уровня.

> **Совместимость.** Раньше коллайдеры статики не выставляли группы вовсе,
> то есть имели `InteractionGroups::all()`. Теперь уровень 0 получает
> `GROUP_1/GROUP_1`. Для тела с `ALL/ALL` (всё, чему группы не выставили)
> проверка `And` по-прежнему проходит: `(GROUP_1 & ALL) != 0 && (ALL &
> GROUP_1) != 0`. Поведение одноуровневого мира не меняется.

### `create_dynamic`

Добавить `.collision_groups(level_interaction(data.level))` и
`self.dynamic_levels.push(data.level)`.

### `destroy`

Дополнительно очистить `dynamic_levels`.

## 1.6 `packages/engine/core/src/client/raycast.rs` — обход клеток лучом

Игра (этап 4/5) обязана уметь ходить лучом по клеткам и принимать решения
на каждой границе. Сегодня `ray_vs_grid` инкапсулирует DDA целиком.
Разложить его на переиспользуемый обходчик, а `ray_vs_grid` оставить как
тонкую обёртку — его текущие тесты обязаны остаться зелёными без правок.

```rust
/// Обход клеток сетки вдоль луча (DDA). Колбэк получает клетку и дистанцию
/// ВХОДА в неё вдоль луча (0.0 для стартовой клетки) и возвращает `false`,
/// чтобы остановить обход. Обход прекращается сам, когда пройденная
/// дистанция превысила `range` или луч вышел за пределы сетки по обеим осям.
///
/// Вынесено из `ray_vs_grid`, чтобы игра могла принять СВОЁ решение на
/// каждой клетке (2.5D: смена уровня луча на кромке плиты) вместо
/// единственного зашитого «стена — стоп».
pub fn walk_ray_cells(
    origin: [f32; 2],
    dir: [f32; 2],
    range: f32,
    rows: usize,
    cols: usize,
    tile_size: f32,
    mut visit: impl FnMut(i64, i64, f32) -> bool,
)
```

`ray_vs_grid` переписать через `walk_ray_cells`:

```rust
pub fn ray_vs_grid(origin, dir, range, map, solid_tiles, tile_size) -> Option<f32> {
    let rows = map.len();
    let cols = map.first().map(|row| row.len()).unwrap_or(0);

    if rows == 0 || cols == 0 || solid_tiles.is_empty() {
        return None;
    }

    let mut hit = None;

    walk_ray_cells(origin, dir, range, rows, cols, tile_size, |cx, cy, t| {
        let solid = cy >= 0
            && (cy as usize) < rows
            && cx >= 0
            && (cx as usize) < cols
            && solid_tiles.contains(&map[cy as usize][cx as usize]);

        if solid {
            hit = Some(t);
            return false;
        }

        true
    });

    hit
}
```

> **Проверка эквивалентности обязательна.** Все существующие тесты
> `raycast::tests` (`grid_ray_hits_wall_to_the_right`,
> `grid_start_inside_wall_hits_at_zero`, `grid_diagonal_and_vertical_rays`,
> …) обязаны пройти без единой правки. Особое внимание: стартовая клетка
> посещается с `t = 0.0`, а клетки за `range` не посещаются вовсе.

## 1.7 `sim.rs` / `game.rs` — уровень участника и выбор нав-графа

### `sim.rs`

В трейт `GameSim<G>` добавить метод с реализацией по умолчанию:

```rust
    /// Явный уровень участника на 2.5D-карте (`respawns[i][3]`). Игра без
    /// уровней метод не реализует — движок зовёт его только когда карта
    /// слоёная и точка респауна назвала уровень.
    fn set_actor_level(&mut self, _world: &mut PhysicsWorld, _game_id: u32, _level: u8) {}
```

### `game.rs`

```rust
    pub fn set_actor_level(&mut self, game_id: u32, level: u8) {
        self.sim.set_actor_level(&mut self.world, game_id, level);
    }
```

`load_map`: валидация до создания тел, слоёный нав-граф для слоёной карты.

```rust
    pub fn load_map(&mut self, json: &str) -> Result<(), String> {
        let map_cfg: MapConfig = serde_json::from_str(json).map_err(|e| format!("bad map json: {e}"))?;

        map_cfg.validate()?;

        if let Some(mut old) = self.map.take() {
            old.destroy(&mut self.world);
        }

        let map = GameMap::create(&mut self.world, &map_cfg, self.cfg.map_scale, &self.cfg.map_set_id);

        // одноуровневая карта идёт прежним путём бит-в-бит: слоёный
        // генератор для неё дал бы тот же граф, но лишним кодом на пути
        self.nav = Some(if map.is_layered() {
            NavigationSystem::generate_layered(map.levels(), map.step)
        } else {
            NavigationSystem::generate(&map.grid, &map.physics_static, map.step)
        });

        self.map = Some(map);

        Ok(())
    }
```

`map_info_json`: добавить `"levels": map.level_count()` — хост и клиент
узнают о слоёности, не разбирая гриды.

## 1.8 `abi.rs` — новый метод ядра

В `export_game_core_abi!`, СРАЗУ ПОСЛЕ `spawn_scripted_actor`
(append-only — существующие методы не трогать, не переименовывать, не менять
арность; см. комментарий «ЗАМОРОЖЕНО» в шапке файла):

```rust
            /// Явный уровень участника на слоёной карте (`respawns[i][3]`).
            /// Движок зовёт сразу после `spawn_actor`/`reset_actor`, когда
            /// точка респауна назвала уровень; игра без слоёв метод
            /// игнорирует (дефолт трейта — no-op).
            pub fn set_actor_level(&mut self, game_id: u32, level: u8) {
                self.state.set_actor_level(game_id, level);
            }
```

Проверить `packages/engine/tests/devtools/surface.test.js`, раздел `abi`:
если он фиксирует список методов — добавить туда `set_actor_level`.

## 1.9 `nav/navigation.rs` — слоёный нав-граф

Добавить, не ломая существующий API (его использует любая игра):

```rust
/// Точка пути с уровнем: смена уровня между соседними точками означает
/// проезд по рампе или прыжок с обрыва.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PathPoint {
    pub pos: [f32; 2],
    pub level: u8,
}
```

Поля `NavigationSystem` дополнить:

```rust
    /// Уровень каждого узла, параллелен `nodes`. Пусто у одноуровневого
    /// графа — тогда все узлы считаются уровнем 0.
    node_levels: Vec<u8>,
    /// Сетки проходимости надземных уровней (индекс 0 = уровень 1).
    /// `nav_grid` остаётся сеткой уровня 0.
    upper_grids: Vec<Vec<Vec<u8>>>,
```

Новый конструктор:

```rust
    /// Граф со слоями: узлы каждого уровня + рёбра переходов.
    pub fn generate_layered(levels: &MapLevels, step: f32) -> Self
```

Алгоритм:

1. Уровень 0 — как в `generate`: `nav_grid[y][x] = 1`, если тайл в
   `levels.solid(0)`.
2. Для каждого уровня `L >= 1`: клетка **проходима**, если тайл входит в
   `levels.floor(L)` и НЕ входит в `levels.solid(L)`. Иначе непроходима.
3. Расстановка узлов: тот же шаг `step * COEF_GRID_STEP`, тот же порядок
   обхода (x внешний, y внутренний), но для каждого уровня по очереди
   (0, затем 1). Узлы уровня 1 добавляются в общий `nodes` после узлов
   уровня 0; `node_levels` заполняется параллельно.
4. Рёбра внутри уровня: как сейчас, но проверка видимости идёт по сетке
   **своего** уровня (`has_obstacle_between_on(level, a, b)`), и соединяются
   только узлы одного уровня.
5. **Рёбра рамп** (двусторонние). Для каждого `RampRun`:
   * `bottom` — центр нижней кромки прогона, `top` — центр верхней кромки
     (по оси прогона; поперечная координата — середина прогона, для чего
     `MapLevels` должен отдать поперечные границы прогона — добавить в
     `RampRun` поля `cross_min`/`cross_max`, заполняемые при `build`).
   * найти ближайший видимый узел уровня `from` к `bottom` и ближайший
     видимый узел уровня `to` к `top`;
   * добавить ребро в обе стороны с весом = евклидова дистанция между
     узлами.
   * если хотя бы одного узла нет — рампу пропустить (карта без узла у
     подножия просто не используется ботами).
6. **Рёбра обрывов** (односторонние, сверху вниз). Для каждой проходимой
   клетки уровня `L >= 1`, у которой есть сосед по 4 направлениям без пола
   уровня `L`: найти ближайший узел уровня `L` к центру клетки и ближайший
   узел уровня 0 к центру соседней клетки; добавить ОДНО ребро
   `верх -> низ` весом `distance + LEDGE_PENALTY`.
   ```rust
   /// Штраф ребра «спрыгнуть с обрыва» в единицах длины: бот выбирает
   /// прыжок, только если он экономит больше этого. Прыжок стоит здоровья
   /// (fallDamage игры), поэтому дешёвым он быть не должен.
   const LEDGE_PENALTY: f32 = 1500.0;
   ```
   Чтобы не плодить дубликаты, вести `HashSet` пар `(верх, низ)`.

Новые методы (старые оставить как есть — они означают «уровень 0»):

```rust
    pub fn is_walkable_on(&self, level: u8, x: f32, y: f32) -> bool;
    pub fn has_obstacle_between_on(&self, level: u8, start: [f32; 2], end: [f32; 2]) -> bool;
    pub fn find_path_on(&self, start: PathPoint, end: PathPoint) -> Option<Vec<PathPoint>>;
    pub fn random_point(&self, rng: &mut Rng) -> Option<PathPoint>;
    pub fn node_level(&self, index: usize) -> u8;
    pub fn level_count(&self) -> usize;
```

`find_path_on`:

* прямая видимость возможна только при `start.level == end.level` — тогда
  `has_obstacle_between_on(level, …)` и возврат `vec![end]`;
* иначе `closest_visible_node_on(start.level, start.pos)` и
  `closest_visible_node_on(end.level, end.pos)`, A* по общему графу
  (переходы едут по рёбрам рамп/обрывов), результат маппится в `PathPoint`
  с уровнем из `node_levels`, в конец дописывается `end`.

`pathfinder::find_path` менять не нужно — граф общий, рёбра уже несут
переходы.

## 1.10 `debug.rs` — дамп

В блок карты добавить:

```
"levels": <level_count>,
"layered": <bool>,
"staticByLevel": [<кол-во тел уровня 0>, <уровня 1>],
"ramps": [{ "axis", "sign", "from", "to", "min", "max" }, ...],
"dynamicLevels": [<уровень каждого динамического тела>]
```

В блок нав-графа: `"nodesByLevel": [...]`, `"rampEdges": N`,
`"ledgeEdges": N`.

Для подсчёта тел по уровням `GameMap` держит
`static_levels: Vec<u8>` параллельно `static_bodies` (заполняется в
`create_static`).

## 1.11 Тесты крейта

Все — в `#[cfg(test)] mod tests` соответствующих файлов.

### `map.rs`

| Имя теста | Что проверяет |
| --- | --- |
| `legacy_map_has_no_levels` | Карта без `levels`: `is_layered() == false`, `level_count() == 1`, число статических тел и их позиции те же, что до правки (эталон из существующего теста). |
| `layered_map_builds_static_per_level` | Карта 3×3 со стеной на L0 и плитой+перилами на L1: два тела, у каждого своя маска (`collision_groups().memberships`). |
| `dynamic_body_carries_level_group` | `physicsDynamic[0].level = 1` → маска `GROUP_2`. |
| `has_floor_reports_slab_and_ground` | `has_floor(0, …)` true внутри карты и false снаружи; `has_floor(1, …)` true только на плите. |
| `level_at_picks_highest_floor` | Точка под мостом → 1; точка на открытой земле → 0. |
| `ramp_progress_runs_from_bottom_to_top` | Вертикальная рампа из 3 тайлов, `dir: north`: `progress` 0 у нижней кромки, 1 у верхней, 0.5 в середине; для `south` — зеркально. |
| `ramp_runs_are_split_per_line` | Две рампы в соседних колонках дают два прогона с одинаковыми границами. |
| `respawn_accepts_three_and_four_numbers` | Обе формы парсятся; масштабируются только x/y. |
| `validate_rejects_mismatched_level_grid` | Грид уровня 1 другой размерности → ошибка с текстом про размерность. |
| `validate_rejects_railing_outside_floor` | `walls` не подмножество `floor` → ошибка. |
| `validate_rejects_unknown_ramp_tile` | Тайл рампы отсутствует в гриде → ошибка. |
| `validate_rejects_level_out_of_range` | `respawns[i][3] = 5` → ошибка. |

### `client/raycast.rs`

| Имя теста | Что проверяет |
| --- | --- |
| `walk_visits_start_cell_at_zero` | Первая посещённая клетка — стартовая, `t == 0.0`. |
| `walk_stops_on_false` | Колбэк, вернувший `false`, останавливает обход. |
| `walk_matches_ray_vs_grid` | Для набора направлений результат `ray_vs_grid` совпадает с ручной сборкой через `walk_ray_cells`. |

### `nav/navigation.rs`

| Имя теста | Что проверяет |
| --- | --- |
| `layered_graph_places_nodes_on_both_levels` | Узлы обоих уровней есть, `node_levels` согласован. |
| `upper_level_nodes_only_on_floor` | Ни один узел уровня 1 не стоит вне плиты. |
| `ramp_edge_connects_levels` | `find_path_on(L0 точка, L1 точка)` находит путь, и в нём есть переход уровня. |
| `no_path_between_levels_without_ramp` | Убрать рампу → путь между уровнями отсутствует (кроме ребра обрыва сверху вниз). |
| `ledge_edge_is_one_way` | Путь сверху вниз есть, снизу вверх через тот же обрыв — нет. |
| `legacy_generate_unchanged` | `generate` на старой сетке даёт то же число узлов/рёбер, что и до правки. |

### `game.rs`

| Имя теста | Что проверяет |
| --- | --- |
| `load_map_rejects_invalid_layers` | `load_map` с битой слоёной картой возвращает `Err`, мир остаётся без карты. |
| `load_map_picks_layered_nav` | Слоёная карта → в нав-графе узлы двух уровней. |

## 1.12 Changelog и документация движка

* `packages/engine/core/CHANGELOG.md` → `## [Unreleased]` → `### Added`:
  слоёные карты (`levels`, `ramps`, `MapLevels`, `RampRun`, маски слоёв),
  `GameSim::set_actor_level` + метод ABI, `walk_ray_cells`,
  `NavigationSystem::generate_layered`/`find_path_on`/`PathPoint`,
  `respawns` принимает 4-й элемент.
  **Заголовок именно `Added`** — ничего из принимавшегося раньше движок
  отвергать не начал, значит это minor, а не `⚠️ Breaking`.
* `docs/en/core.md` и `docs/ru/core.md`: раздел про слоёную карту —
  структура `MapLevels`, правила рамп, маски `InteractionGroups`, слоёный
  нав-граф, `set_actor_level`.
* `docs/ai/07-maps-and-assets.md`: описание новых полей формата (`levels`,
  `ramps`, `physicsDynamic[].level`, 4-й элемент респауна) + таблица
  «поле → потребитель».
* `docs/ai/05-wasm-core.md`: строка про `set_actor_level` в списке ABI.
* `docs/ai/10-pitfalls.md`: пункт «грид уровня другой размерности молчит»
  и «перила вне `floor` не экранируют луч».

## Критерии готовности этапа

```bash
cd /Users/dmitry/Sites/my/vimp
cargo test --workspace --quiet     # зелёное, включая все новые тесты
npx eslint .                       # зелёное (JS не трогали, но проверить)
```

* Ни один существующий тест крейта не правился ради прохождения.
* `git diff --stat` не содержит правок в `snapshot.rs`, `config.rs`
  (`PLAYER_STATE_LEN`), `unpack.rs` — формат кадра не менялся.

Отметить `✅ выполнен` в заголовке этого файла и в таблице
`plan/README.md`.
