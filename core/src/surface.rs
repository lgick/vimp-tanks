//! Поверхности клеток карты (песок, грязь, вода, масло, конвейер, бустер):
//! плотная таблица `SurfaceMap` и чистые функции над ней. Авторитетный путь
//! (`Tank::update`) и клиентская реплика (`Predictor::step_inner`) обязаны
//! звать ровно их — иначе предсказание движения на поверхности молча
//! разойдётся с сервером.
//!
//! Таблица строится одной функцией (`build_map`) на обеих сторонах: хост —
//! из `GameMap`, клиент — из MAP_DATA. Поле карты `game.surfaces` проверяет
//! `MapGame::validate_surfaces`.

use vimp_engine_core::map::MapLevels;

use crate::config::{SurfaceKind, SurfaceRules, SurfaceType};
use crate::level::LevelState;
use crate::map_game::{MapGame, SurfaceTileDef};

/// Код направления плиты: `0` — нет направления.
const DIR_NONE: u8 = 0;

/// Код направления по имени (`north` = −y, `south` = +y, `west` = −x,
/// `east` = +x — как у `ramps`).
fn dir_code(name: &str) -> Option<u8> {
    match name {
        "north" => Some(1),
        "south" => Some(2),
        "west" => Some(3),
        "east" => Some(4),
        _ => None,
    }
}

/// Единичный вектор направления по коду; `(0, 0)` — без направления.
fn dir_vec(code: u8) -> (f32, f32) {
    match code {
        1 => (0.0, -1.0),
        2 => (0.0, 1.0),
        3 => (-1.0, 0.0),
        4 => (1.0, 0.0),
        _ => (0.0, 0.0),
    }
}

/// Разобранная запись `game.surfaces`: тайл уровня и его поверхность.
pub(crate) struct ResolvedTile {
    pub(crate) level: u8,
    pub(crate) tile: i32,
    pub(crate) name: String,
    /// Индекс типа в `SurfaceRules::types` (порядок `BTreeMap`).
    type_index: usize,
    dir: u8,
}

/// Разбор `game.surfaces` против правил: уровень существует, тип объявлен,
/// `dir` задан ровно у направленных типов. Геометрию (стены, рампы) не
/// смотрит — это делает `MapGame::validate_surfaces`.
pub(crate) fn resolve_tiles(
    game: &MapGame,
    rules: &SurfaceRules,
    level_count: usize,
) -> Result<Vec<ResolvedTile>, String> {
    let mut out = Vec::new();

    for (level_key, tiles) in &game.surfaces {
        let level = level_key
            .parse::<u8>()
            .map_err(|_| format!("game.surfaces: '{level_key}' is not a level number"))?;

        if level as usize >= level_count {
            return Err(format!("game.surfaces: level {level} does not exist on this map"));
        }

        for (tile_key, def) in tiles {
            let tile = tile_key.parse::<i32>().map_err(|_| {
                format!("game.surfaces.{level}: '{tile_key}' is not a tile id")
            })?;
            let (name, dir) = match def {
                SurfaceTileDef::Name(name) => (name, None),
                SurfaceTileDef::Full { r#type, dir } => (r#type, dir.as_deref()),
            };
            let Some(type_index) = rules.types.keys().position(|key| key == name) else {
                return Err(format!(
                    "game.surfaces.{level}.{tile}: unknown surface type '{name}'"
                ));
            };
            let kind = rules.types[name].kind(name)?;
            let directed = !matches!(kind, SurfaceKind::Plain);

            let dir = match (directed, dir) {
                (true, None) => {
                    return Err(format!(
                        "game.surfaces.{level}.{tile}: surface '{name}' requires `dir`"
                    ));
                }
                (true, Some(dir)) => dir_code(dir).ok_or_else(|| {
                    format!(
                        "game.surfaces.{level}.{tile}: unknown dir '{dir}' \
                         (north/south/west/east)"
                    )
                })?,
                (false, Some(_)) => {
                    return Err(format!(
                        "game.surfaces.{level}.{tile}: surface '{name}' takes no `dir`"
                    ));
                }
                (false, None) => DIR_NONE,
            };

            out.push(ResolvedTile {
                level,
                tile,
                name: name.clone(),
                type_index,
                dir,
            });
        }
    }

    Ok(out)
}

/// Плотная таблица поверхностей карты по уровням.
#[derive(Clone, Debug)]
pub struct SurfaceMap {
    /// По уровню — клетки строками (`cy * cols + cx`): `0` — нейтрально,
    /// `k` — индекс типа + 1.
    per_level: Vec<Vec<u8>>,
    /// Параллельно `per_level`: код направления клетки.
    dirs: Vec<Vec<u8>>,
    cols: usize,
    rows: usize,
    /// Мировой размер клетки (`step · scale`).
    tile_size: f32,
    /// Описания типов по индексу `k − 1` с вычисленным видом: горячему пути
    /// не нужно искать тип по имени и заново выводить вид на каждой выборке.
    types: Vec<(SurfaceType, SurfaceKind)>,
}

impl SurfaceMap {
    /// Одна функция на обе стороны. `grids[n]` — грид уровня `n`,
    /// `tile_size` — мировой размер клетки.
    pub fn build(
        grids: &[&[Vec<i32>]],
        tile_size: f32,
        game: &MapGame,
        rules: &SurfaceRules,
    ) -> Result<Self, String> {
        if rules.types.len() > u8::MAX as usize {
            return Err(format!(
                "surfaces.types: at most {} types, got {}",
                u8::MAX,
                rules.types.len()
            ));
        }

        let types = rules
            .types
            .iter()
            .map(|(name, params)| params.kind(name).map(|kind| (*params, kind)))
            .collect::<Result<Vec<_>, _>>()?;
        let rows = grids.first().map_or(0, |grid| grid.len());
        let cols = grids
            .first()
            .and_then(|grid| grid.first())
            .map_or(0, |row| row.len());
        let mut per_level = vec![vec![0u8; rows * cols]; grids.len()];
        let mut dirs = vec![vec![DIR_NONE; rows * cols]; grids.len()];

        for resolved in resolve_tiles(game, rules, grids.len())? {
            let level = resolved.level as usize;

            for (cy, row) in grids[level].iter().enumerate().take(rows) {
                for (cx, &tile) in row.iter().enumerate().take(cols) {
                    if tile == resolved.tile {
                        per_level[level][cy * cols + cx] = (resolved.type_index + 1) as u8;
                        dirs[level][cy * cols + cx] = resolved.dir;
                    }
                }
            }
        }

        Ok(Self {
            per_level,
            dirs,
            cols,
            rows,
            tile_size,
            types,
        })
    }

    /// Мировой размер клетки.
    pub fn tile_size(&self) -> f32 {
        self.tile_size
    }

    /// Непустая клетка уровня под точкой: индекс в строках уровня и `k`
    /// (индекс типа + 1). Клетка вне сетки и нейтральная клетка — `None`.
    fn cell(&self, level: u8, x: f32, y: f32) -> Option<(usize, u8)> {
        // `!(x >= 0)` отсекает и NaN
        if self.tile_size <= 0.0 || !(x >= 0.0) || !(y >= 0.0) {
            return None;
        }

        let cx = (x / self.tile_size).floor() as usize;
        let cy = (y / self.tile_size).floor() as usize;

        if cx >= self.cols || cy >= self.rows {
            return None;
        }

        let index = cy * self.cols + cx;
        let k = *self.per_level.get(level as usize)?.get(index)?;

        (k != 0).then_some((index, k))
    }

    /// Поверхность в точке уровня: параметры, вид и код направления.
    /// Клетка вне сетки и нейтральная клетка — `None`.
    fn sample(&self, level: u8, x: f32, y: f32) -> Option<(&SurfaceType, SurfaceKind, u8)> {
        let (index, k) = self.cell(level, x, y)?;
        let (params, kind) = &self.types[k as usize - 1];

        Some((params, *kind, self.dirs[level as usize][index]))
    }

    /// Индекс типа поверхности в точке уровня (порядок `SurfaceRules::types`);
    /// `None` — нейтрально. Потребитель — рендер эффектов
    /// (`ClientCore::surface_at`): та же таблица, что у физики.
    pub fn type_at(&self, level: u8, x: f32, y: f32) -> Option<usize> {
        self.cell(level, x, y).map(|(_, k)| k as usize - 1)
    }

    /// Направление стрелки клетки: `0..3` — север/юг/запад/восток (порядок
    /// `ramps`); `None` — нейтральная клетка или тип без направления.
    pub fn dir_at(&self, level: u8, x: f32, y: f32) -> Option<u8> {
        let (index, _) = self.cell(level, x, y)?;
        let code = self.dirs[level as usize][index];

        (code != DIR_NONE).then(|| code - 1)
    }
}

/// Таблица поверхностей карты — единая точка входа хоста
/// (`TanksSim::rebuild_map_derived`) и клиента (`TanksClient::set_map`).
/// `grid0` — грид уровня 0, остальные уровни берутся из `levels`.
/// `None` — карта поверхностей не объявила: движение идёт нейтральным путём
/// без выборок.
pub fn build_map(
    game: &MapGame,
    rules: &SurfaceRules,
    levels: &MapLevels,
    grid0: &[Vec<i32>],
    tile_size: f32,
) -> Result<Option<SurfaceMap>, String> {
    if game.surfaces.is_empty() {
        return Ok(None);
    }

    game.validate_surfaces(rules, levels)?;

    let mut grids: Vec<&[Vec<i32>]> = vec![grid0];

    for level in 1..levels.level_count() {
        if let Some(grid) = levels.grid(level as u8) {
            grids.push(grid);
        }
    }

    SurfaceMap::build(&grids, tile_size, game, rules).map(Some)
}

/// Смешанные коэффициенты шага под корпусом.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SurfaceMix {
    /// Тяга левой и правой гусениц.
    pub accel_l: f32,
    pub accel_r: f32,
    pub max_speed: f32,
    /// Доп. линейное сопротивление, 1/с.
    pub drag: f32,
    /// Доп. угловое сопротивление, 1/с.
    pub angular_drag: f32,
    pub grip: f32,
    pub brake: f32,
    pub turn: f32,
    /// Скорость «грунта» (ленты конвейера) по осям мира.
    pub belt_x: f32,
    pub belt_y: f32,
}

impl SurfaceMix {
    /// Асфальт: множители `1`, добавки `0`. На нём формулы движения дают
    /// бит-в-бит прежний результат.
    pub const NEUTRAL: Self = Self {
        accel_l: 1.0,
        accel_r: 1.0,
        max_speed: 1.0,
        drag: 0.0,
        angular_drag: 0.0,
        grip: 1.0,
        brake: 1.0,
        turn: 1.0,
        belt_x: 0.0,
        belt_y: 0.0,
    };
}

/// Параметры одной точки сэмплинга.
#[derive(Clone, Copy)]
struct PointSample {
    accel: f32,
    max_speed: f32,
    drag: f32,
    angular_drag: f32,
    grip: f32,
    brake: f32,
    turn: f32,
    belt: (f32, f32),
}

impl PointSample {
    const NEUTRAL: Self = Self {
        accel: 1.0,
        max_speed: 1.0,
        drag: 0.0,
        angular_drag: 0.0,
        grip: 1.0,
        brake: 1.0,
        turn: 1.0,
        belt: (0.0, 0.0),
    };
}

fn point_sample(map: &SurfaceMap, level: u8, x: f32, y: f32) -> PointSample {
    let Some((params, kind, dir)) = map.sample(level, x, y) else {
        return PointSample::NEUTRAL;
    };
    let belt = match kind {
        SurfaceKind::Conveyor { belt } => {
            let (dx, dy) = dir_vec(dir);

            (dx * belt, dy * belt)
        }
        _ => (0.0, 0.0),
    };

    PointSample {
        accel: params.accel,
        max_speed: params.max_speed,
        drag: params.drag,
        angular_drag: params.angular_drag,
        grip: params.grip,
        brake: params.brake,
        turn: params.turn,
        belt,
    }
}

/// Мировые точки сэмплинга гусениц: `[левая·нос, левая·корма, правая·нос,
/// правая·корма]`. Система корпуса: ось `x` — курс, `half_w` — полудлина
/// вдоль курса, `half_h` — полуширина (те же полуразмеры, что у `Footprint`
/// и `Shape` предиктора). Левая гусеница — `−y` корпуса: при курсе на восток
/// левый борт смотрит на север (−y мира), как у `turn_delta`, где `left`
/// даёт отрицательную Δω.
pub fn track_points(
    rules: &SurfaceRules,
    x: f32,
    y: f32,
    angle: f32,
    half_w: f32,
    half_h: f32,
) -> [(f32, f32); 4] {
    let (sin, cos) = angle.sin_cos();
    let along = rules.track_sample_x * half_w;
    let side = rules.track_sample_y * half_h;
    let to_world = |fx: f32, fy: f32| (x + cos * fx - sin * fy, y + sin * fx + cos * fy);

    [
        to_world(along, -side),
        to_world(-along, -side),
        to_world(along, side),
        to_world(-along, side),
    ]
}

/// Смешанные коэффициенты под корпусом: по 2 точки на гусеницу. Тяга — по
/// гусеницам отдельно, остальное — среднее 4 точек, лента — среднее
/// векторов. В полёте поверхности нет.
#[allow(clippy::too_many_arguments)]
pub fn tank_mix(
    map: &SurfaceMap,
    rules: &SurfaceRules,
    level_state: &LevelState,
    x: f32,
    y: f32,
    angle: f32,
    half_w: f32,
    half_h: f32,
) -> SurfaceMix {
    if level_state.airborne() {
        return SurfaceMix::NEUTRAL;
    }

    let points = track_points(rules, x, y, angle, half_w, half_h);
    let s = points.map(|(px, py)| point_sample(map, level_state.level, px, py));
    let avg = |f: fn(&PointSample) -> f32| (f(&s[0]) + f(&s[1]) + f(&s[2]) + f(&s[3])) * 0.25;

    SurfaceMix {
        accel_l: (s[0].accel + s[1].accel) * 0.5,
        accel_r: (s[2].accel + s[3].accel) * 0.5,
        max_speed: avg(|p| p.max_speed),
        drag: avg(|p| p.drag),
        angular_drag: avg(|p| p.angular_drag),
        grip: avg(|p| p.grip),
        brake: avg(|p| p.brake),
        turn: avg(|p| p.turn),
        belt_x: avg(|p| p.belt.0),
        belt_y: avg(|p| p.belt.1),
    }
}

/// Остаток скользкой поверхности: обновляет таймер состояния уровня и
/// подтягивает `mix` к параметрам следа. Без следа — `mix` как есть
/// (нейтральный путь бит-в-бит).
///
/// Пока хоть одна точка гусениц стоит на типе с `slickTime`, остаток полный
/// (из нескольких — наибольший) и `mix` не трогается: он уже скользкий.
/// После съезда остаток `t = slick_left / slickTime` тянет коэффициенты к
/// параметрам следа и линейно спадает за `slickTime`. `max_speed`, `drag`
/// и лента не трогаются. В полёте остаток спадает, но не применяется.
#[allow(clippy::too_many_arguments)]
pub fn apply_slick(
    map: &SurfaceMap,
    rules: &SurfaceRules,
    level_state: &mut LevelState,
    x: f32,
    y: f32,
    angle: f32,
    half_w: f32,
    half_h: f32,
    mix: SurfaceMix,
    dt: f32,
) -> SurfaceMix {
    if level_state.airborne() {
        decay_slick(level_state, dt);

        return mix;
    }

    let mut on_slick: Option<(u8, f32)> = None;

    for (px, py) in track_points(rules, x, y, angle, half_w, half_h) {
        let Some((_, k)) = map.cell(level_state.level, px, py) else {
            continue;
        };
        let Some(time) = map.types[k as usize - 1].0.slick_time else {
            continue;
        };

        if on_slick.is_none_or(|(_, best)| time > best) {
            on_slick = Some((k, time));
        }
    }

    if let Some((k, time)) = on_slick {
        level_state.slick_left = time;
        level_state.slick_type = k;

        return mix;
    }

    if level_state.slick_left <= 0.0 || level_state.slick_type == 0 {
        return mix;
    }

    let params = &map.types[level_state.slick_type as usize - 1].0;
    let Some(slick_time) = params.slick_time else {
        return mix;
    };
    let t = level_state.slick_left / slick_time;
    let lerp = |from: f32, to: f32| from + (to - from) * t;
    let turn = lerp(1.0, params.turn);
    let out = SurfaceMix {
        accel_l: mix.accel_l.min(lerp(1.0, params.accel)),
        accel_r: mix.accel_r.min(lerp(1.0, params.accel)),
        angular_drag: mix.angular_drag.min(lerp(0.0, params.angular_drag)),
        grip: mix.grip.min(lerp(1.0, params.grip)),
        brake: mix.brake.min(lerp(1.0, params.brake)),
        turn: if params.turn >= 1.0 { mix.turn.max(turn) } else { mix.turn.min(turn) },
        ..mix
    };

    decay_slick(level_state, dt);

    out
}

// спад остатка за шаг; на нуле след забывается
fn decay_slick(level_state: &mut LevelState, dt: f32) {
    level_state.slick_left = (level_state.slick_left - dt).max(0.0);

    if level_state.slick_left <= 0.0 {
        level_state.slick_type = 0;
    }
}

/// Поверхность под центром тела карты (ящика, бочки): коэффициенты клетки и
/// её вид. В полёте и на клетке без поверхности — `(NEUTRAL, Plain)`.
/// `x`/`y` — ЦЕНТР тела, а не позиция Rapier (угол объекта).
pub fn body_mix(map: &SurfaceMap, level: u8, falling: bool, x: f32, y: f32) -> (SurfaceMix, SurfaceKind) {
    if falling {
        return (SurfaceMix::NEUTRAL, SurfaceKind::Plain);
    }

    let Some((_, kind, _)) = map.sample(level, x, y) else {
        return (SurfaceMix::NEUTRAL, SurfaceKind::Plain);
    };
    let point = point_sample(map, level, x, y);
    let mix = SurfaceMix {
        accel_l: point.accel,
        accel_r: point.accel,
        max_speed: point.max_speed,
        drag: point.drag,
        angular_drag: point.angular_drag,
        grip: point.grip,
        brake: point.brake,
        turn: point.turn,
        belt_x: point.belt.0,
        belt_y: point.belt.1,
    };

    (mix, kind)
}

/// Δv тела карты от поверхности за шаг. Ветвление — по ВИДУ клетки, а не по
/// значению ленты: лента с `belt: 0` остаётся лентой.
///
/// - `Plain`, `Boost` — только сопротивление `−v · drag · dt` (импульс бустера
///   даёт отдельная [`boost_dv`]);
/// - `Conveyor` — только `(belt − v) · (bodyBeltCoupling + drag) · dt`: у тела
///   нет сцепления гусениц, и сопротивление относительно ленты поверх связи
///   молча удвоило бы её.
///
/// Масла у тел нет: боковое сцепление — модель гусениц, трение ящика задаёт
/// движок. `vx`/`vy` — скорость НАЧАЛА шага.
pub fn body_dv(
    mix: SurfaceMix,
    kind: SurfaceKind,
    rules: &SurfaceRules,
    vx: f32,
    vy: f32,
    dt: f32,
) -> (f32, f32) {
    match kind {
        SurfaceKind::Conveyor { .. } => {
            let coupling = rules.body_belt_coupling + mix.drag;

            ((mix.belt_x - vx) * coupling * dt, (mix.belt_y - vy) * coupling * dt)
        }
        SurfaceKind::Plain | SurfaceKind::Boost { .. } => {
            crate::motion::surface_drag_dv((vx, vy), mix.drag, dt)
        }
    }
}

/// Разовый импульс бустера (Δv по осям мира). Состояния нет: въезд — чистая
/// функция текущих позиции и скорости, поэтому реконсиляция и тела без
/// истории дают тот же результат, что хост.
///
/// Импульс, если тело не в полёте, клетка центра — бустер с направлением
/// `dir`, клетка `p − v·dt` того же уровня — НЕ бустер с тем же `dir` (вне
/// сетки — не бустер) и `v·dir ≥ minEntrySpeed`. Условие «не бустер с тем же
/// `dir`», а не «другая клетка»: переход между клетками одной плиты не
/// должен давать повторный импульс.
///
/// `vx`/`vy` — скорость НАЧАЛА шага, до всех импульсов шага.
#[allow(clippy::too_many_arguments)]
pub fn boost_dv(
    map: &SurfaceMap,
    level: u8,
    airborne: bool,
    x: f32,
    y: f32,
    vx: f32,
    vy: f32,
    dt: f32,
) -> (f32, f32) {
    if airborne {
        return (0.0, 0.0);
    }

    let Some((_, SurfaceKind::Boost { dv, max_speed, min_entry_speed, .. }, dir)) =
        map.sample(level, x, y)
    else {
        return (0.0, 0.0);
    };
    let from_same_plate = matches!(
        map.sample(level, x - vx * dt, y - vy * dt),
        Some((_, SurfaceKind::Boost { .. }, prev_dir)) if prev_dir == dir
    );

    if from_same_plate {
        return (0.0, 0.0);
    }

    let (dx, dy) = dir_vec(dir);
    let along = vx * dx + vy * dy;

    if along < min_entry_speed {
        return (0.0, 0.0);
    }

    let gain = dv.min((max_speed - along).max(0.0));

    if gain <= 0.0 {
        return (0.0, 0.0);
    }

    (dx * gain, dy * gain)
}

/// Запуск удержания бустера: вызывается на шаге, где [`boost_dv`] дал
/// импульс танку, с той же точкой. Плита с `boostTime` ставит таймер и
/// множитель потолка; плита без удержания текущее удержание не трогает.
pub fn start_boost_hold(map: &SurfaceMap, level_state: &mut LevelState, x: f32, y: f32) {
    let Some((_, SurfaceKind::Boost { hold, speed_factor, .. }, _)) =
        map.sample(level_state.level, x, y)
    else {
        return;
    };

    if hold > 0.0 {
        level_state.boost_left = hold;
        level_state.boost_factor = speed_factor;
    }
}

/// Спад удержания за шаг — один раз за шаг, до ветки полёта, на хосте и
/// реплике в одном месте. На нуле множитель возвращается к `1`.
pub fn decay_boost(level_state: &mut LevelState, dt: f32) {
    if level_state.boost_left <= 0.0 {
        return;
    }

    level_state.boost_left = (level_state.boost_left - dt).max(0.0);

    if level_state.boost_left <= 0.0 {
        level_state.boost_factor = 1.0;
    }
}

/// Поднятый потолок скорости на время удержания. Без удержания — `mix` как
/// есть (нейтральный путь бит-в-бит).
pub fn boost_hold_mix(mix: SurfaceMix, level_state: &LevelState) -> SurfaceMix {
    if level_state.boost_left <= 0.0 {
        return mix;
    }

    SurfaceMix {
        max_speed: mix.max_speed * level_state.boost_factor,
        ..mix
    }
}

/// Δv компенсации линейного демпфирования на время удержания:
/// `(v + v·linear·dt) / (1 + linear·dt) = v` — после затухания интеграции
/// скорость остаётся прежней. Без удержания — нули. `v` — скорость НАЧАЛА
/// шага.
pub fn boost_damping_dv(v: (f32, f32), linear: f32, level_state: &LevelState, dt: f32) -> (f32, f32) {
    if level_state.boost_left <= 0.0 {
        return (0.0, 0.0);
    }

    (v.0 * linear * dt, v.1 * linear * dt)
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::level::Transit;
    use serde_json::json;

    const TILE: f32 = 10.0;

    fn rules() -> SurfaceRules {
        serde_json::from_value(json!({
            "trackYawGain": 0.004,
            "trackSampleX": 0.6,
            "trackSampleY": 0.75,
            "types": {
                "sand": { "accel": 0.6, "maxSpeed": 0.55, "drag": 1.2 },
                "mud": { "accel": 0.45, "maxSpeed": 0.4, "drag": 2.0, "grip": 0.9, "turn": 0.7 },
                "oil": { "accel": 0.35, "grip": 0.08, "brake": 0.1, "turn": 1.6, "angularDrag": -0.5, "slickTime": 1.5 },
                "conveyor": { "belt": 60 },
                "boost": { "boostDv": 160, "boostMaxSpeed": 340, "minEntrySpeed": 20 }
            }
        }))
        .unwrap()
    }

    fn game(value: serde_json::Value) -> MapGame {
        MapGame::from_value(&json!({ "surfaces": value })).unwrap()
    }

    fn grid(rows: usize, cols: usize, fill: impl Fn(usize, usize) -> i32) -> Vec<Vec<i32>> {
        (0..rows).map(|y| (0..cols).map(|x| fill(x, y)).collect()).collect()
    }

    fn build_flat(grid0: &[Vec<i32>], surfaces: serde_json::Value) -> Result<SurfaceMap, String> {
        SurfaceMap::build(&[grid0], TILE, &game(surfaces), &rules())
    }

    fn levels_of(grid0: &[Vec<i32>], solid: &[i32]) -> MapLevels {
        MapLevels::build(grid0, solid, &Default::default(), &[], TILE, None)
    }

    // центр клетки (cx, cy)
    fn center(cx: usize, cy: usize) -> (f32, f32) {
        ((cx as f32 + 0.5) * TILE, (cy as f32 + 0.5) * TILE)
    }

    #[test]
    fn build_marks_cells_by_tile_and_level() {
        let grid0 = grid(4, 4, |x, _| if x == 1 { 41 } else { 0 });
        let map = build_flat(&grid0, json!({ "0": { "41": "sand" } })).unwrap();
        let (x, y) = center(1, 2);

        assert!(map.sample(0, x, y).is_some());
        assert!(map.sample(0, center(0, 2).0, y).is_none());
        // вне сетки и на несуществующем уровне — нейтрально
        assert!(map.sample(0, -1.0, y).is_none());
        assert!(map.sample(0, 1000.0, y).is_none());
        assert!(map.sample(1, x, y).is_none());
        assert_eq!(map.tile_size(), TILE);
    }

    #[test]
    fn type_and_dir_accessors() {
        let grid0 = grid(1, 3, |x, _| 40 + x as i32);
        let map = build_flat(
            &grid0,
            json!({ "0": { "40": "sand", "41": { "type": "boost", "dir": "west" } } }),
        )
        .unwrap();

        // порядок типов — `BTreeMap`: boost, conveyor, mud, sand
        assert_eq!(map.type_at(0, center(0, 0).0, 5.0), Some(4));
        assert_eq!(map.type_at(0, center(1, 0).0, 5.0), Some(0));
        assert_eq!(map.type_at(0, center(2, 0).0, 5.0), None);
        assert_eq!(map.type_at(1, center(0, 0).0, 5.0), None);

        // стрелка есть только у направленных типов; west — индекс 2
        assert_eq!(map.dir_at(0, center(1, 0).0, 5.0), Some(2));
        assert_eq!(map.dir_at(0, center(0, 0).0, 5.0), None);
        assert_eq!(map.dir_at(0, center(2, 0).0, 5.0), None);
    }

    #[test]
    fn build_rejects_bad_definitions() {
        let grid0 = grid(4, 4, |_, _| 41);

        let unknown = build_flat(&grid0, json!({ "0": { "41": "lava" } }));
        let dir_on_plain = build_flat(&grid0, json!({ "0": { "41": { "type": "sand", "dir": "east" } } }));
        let no_dir = build_flat(&grid0, json!({ "0": { "41": "conveyor" } }));
        let bad_dir = build_flat(&grid0, json!({ "0": { "41": { "type": "boost", "dir": "e" } } }));
        let no_level = build_flat(&grid0, json!({ "1": { "41": "sand" } }));

        assert!(unknown.unwrap_err().contains("lava"));
        assert!(dir_on_plain.unwrap_err().contains("takes no `dir`"));
        assert!(no_dir.unwrap_err().contains("requires `dir`"));
        assert!(bad_dir.unwrap_err().contains("unknown dir"));
        assert!(no_level.unwrap_err().contains("does not exist"));
    }

    #[test]
    fn validate_rejects_walls_and_ramps() {
        let grid0 = grid(4, 4, |x, _| if x == 0 { 1 } else { 41 });
        let walls = levels_of(&grid0, &[1]);
        let ok = game(json!({ "0": { "41": "sand" } }));
        let on_wall = game(json!({ "0": { "1": "sand" } }));

        assert!(ok.validate_surfaces(&rules(), &walls).is_ok());
        assert!(on_wall.validate_surfaces(&rules(), &walls).unwrap_err().contains("wall"));

        let ramp_grid = grid(4, 4, |x, _| if x == 1 { 3 } else { 0 });
        let ramps: Vec<vimp_engine_core::map::RampConfig> =
            serde_json::from_value(json!([{ "tile": 3, "dir": "east", "from": 0, "to": 1 }])).unwrap();
        let upper: indexmap::IndexMap<String, vimp_engine_core::map::MapLevelConfig> =
            serde_json::from_value(json!({ "1": { "map": grid(4, 4, |x, _| i32::from(x >= 2) * 2), "floor": [2] } }))
                .unwrap();
        let layered = MapLevels::build(&ramp_grid, &[], &upper, &ramps, TILE, None);
        let on_ramp = game(json!({ "0": { "3": "sand" } }));

        assert!(on_ramp.validate_surfaces(&rules(), &layered).unwrap_err().contains("ramp"));
    }

    #[test]
    fn sample_points_lie_inside_the_hull() {
        let rules = rules();
        let (half_w, half_h) = (4.0, 3.0);

        for angle in [0.0f32, 0.7, 2.0, -2.5] {
            let (sin, cos) = angle.sin_cos();

            for (px, py) in track_points(&rules, 50.0, 60.0, angle, half_w, half_h) {
                // обратно в систему корпуса
                let (dx, dy) = (px - 50.0, py - 60.0);
                let local_x = dx * cos + dy * sin;
                let local_y = -dx * sin + dy * cos;

                assert!(local_x.abs() < half_w, "точка за носом/кормой: {local_x}");
                assert!(local_y.abs() < half_h, "точка за бортом: {local_y}");
            }
        }
    }

    #[test]
    fn left_track_is_the_north_side_heading_east() {
        let points = track_points(&rules(), 0.0, 0.0, 0.0, 4.0, 3.0);

        assert!(points[0].1 < 0.0 && points[1].1 < 0.0, "левая гусеница — север (−y)");
        assert!(points[2].1 > 0.0 && points[3].1 > 0.0, "правая гусеница — юг (+y)");
    }

    #[test]
    fn neutral_ground_and_flight_give_the_neutral_mix() {
        let grid0 = grid(10, 10, |_, _| 41);
        let map = build_flat(&grid0, json!({ "0": { "41": "sand" } })).unwrap();
        let rules = rules();
        let grounded = LevelState::default();
        let flying = LevelState {
            transit: Transit::Airborne { vz: 0.0, from: 0, to: 0, peak: 0.0 },
            ..LevelState::default()
        };

        assert_ne!(tank_mix(&map, &rules, &grounded, 50.0, 50.0, 0.0, 4.0, 3.0), SurfaceMix::NEUTRAL);
        assert_eq!(tank_mix(&map, &rules, &flying, 50.0, 50.0, 0.0, 4.0, 3.0), SurfaceMix::NEUTRAL);

        let empty = build_flat(&grid(10, 10, |_, _| 0), json!({ "0": { "41": "sand" } })).unwrap();

        assert_eq!(tank_mix(&empty, &rules, &grounded, 50.0, 50.0, 0.0, 4.0, 3.0), SurfaceMix::NEUTRAL);
    }

    #[test]
    fn mud_under_one_track_splits_the_traction() {
        // строки 0..5 — грязь (север), 5.. — асфальт: танк на границе y = 50
        let grid0 = grid(10, 10, |_, y| if y < 5 { 42 } else { 0 });
        let map = build_flat(&grid0, json!({ "0": { "42": "mud" } })).unwrap();
        let mix = tank_mix(&map, &rules(), &LevelState::default(), 50.0, 50.0, 0.0, 8.0, 6.0);

        assert_eq!(mix.accel_l, 0.45);
        assert_eq!(mix.accel_r, 1.0);
        assert!((mix.drag - 1.0).abs() < 1e-6, "среднее 4 точек: {}", mix.drag);
    }

    #[test]
    fn conveyor_mix_carries_the_belt_vector() {
        let grid0 = grid(10, 10, |_, _| 45);
        let map = build_flat(&grid0, json!({ "0": { "45": { "type": "conveyor", "dir": "west" } } })).unwrap();
        let mix = tank_mix(&map, &rules(), &LevelState::default(), 50.0, 50.0, 1.0, 4.0, 3.0);

        assert_eq!((mix.belt_x, mix.belt_y), (-60.0, 0.0));
        assert_eq!(mix.accel_l, 1.0);
    }

    // масло в колонках 0..5 (x < 50), дальше асфальт
    fn oil_patch() -> SurfaceMap {
        let grid0 = grid(10, 10, |x, _| if x < 5 { 44 } else { 0 });

        build_flat(&grid0, json!({ "0": { "44": "oil", "41": "sand" } })).unwrap()
    }

    fn slick_step(map: &SurfaceMap, state: &mut LevelState, x: f32, dt: f32) -> SurfaceMix {
        let rules = rules();
        let mix = tank_mix(map, &rules, state, x, 50.0, 0.0, 4.0, 3.0);

        apply_slick(map, &rules, state, x, 50.0, 0.0, 4.0, 3.0, mix, dt)
    }

    #[test]
    fn oil_residue_fades_linearly_after_leaving() {
        let map = oil_patch();
        let mut state = LevelState::default();
        let on_oil = tank_mix(&map, &rules(), &state, 25.0, 50.0, 0.0, 4.0, 3.0);

        // на масле таймер полный, `mix` — масляный как есть
        assert_eq!(slick_step(&map, &mut state, 25.0, 0.75), on_oil);
        assert_eq!(state.slick_left, 1.5);
        assert_ne!(state.slick_type, 0);

        // первый шаг после съезда — полный остаток, второй — половина
        let first = slick_step(&map, &mut state, 80.0, 0.75);
        let half = slick_step(&map, &mut state, 80.0, 0.75);

        assert!((first.grip - 0.08).abs() < 1e-6, "{}", first.grip);
        assert!((half.grip - (1.0 + (0.08 - 1.0) * 0.5)).abs() < 1e-6, "{}", half.grip);
        assert!((half.turn - 1.3).abs() < 1e-6, "turn > 1 тянется вверх: {}", half.turn);
        assert!((half.angular_drag + 0.25).abs() < 1e-6, "{}", half.angular_drag);
        assert_eq!(half.max_speed, 1.0, "потолок скорости остаток не трогает");

        // через slickTime — асфальт, след забыт
        assert_eq!(slick_step(&map, &mut state, 80.0, 0.75), SurfaceMix::NEUTRAL);
        assert_eq!((state.slick_left, state.slick_type), (0.0, 0));
    }

    #[test]
    fn surface_without_slick_time_leaves_no_residue() {
        let grid0 = grid(10, 10, |x, _| if x < 5 { 41 } else { 0 });
        let map = build_flat(&grid0, json!({ "0": { "41": "sand" } })).unwrap();
        let mut state = LevelState::default();

        slick_step(&map, &mut state, 25.0, 0.1);

        assert_eq!((state.slick_left, state.slick_type), (0.0, 0));
        assert_eq!(slick_step(&map, &mut state, 80.0, 0.1), SurfaceMix::NEUTRAL);
    }

    #[test]
    fn residue_decays_but_does_not_apply_in_flight() {
        let map = oil_patch();
        let mut state = LevelState::default();

        slick_step(&map, &mut state, 25.0, 0.5);
        state.transit = Transit::Airborne { vz: 0.0, from: 0, to: 0, peak: 0.0 };

        // даже над маслом в полёте таймер не взводится
        let mix = apply_slick(&map, &rules(), &mut state, 25.0, 50.0, 0.0, 4.0, 3.0, SurfaceMix::NEUTRAL, 0.5);

        assert_eq!(mix, SurfaceMix::NEUTRAL);
        assert_eq!(state.slick_left, 1.0);
    }

    // полоса бустера на восток в колонках 3..6
    fn boost_strip(dir: &str) -> SurfaceMap {
        let grid0 = grid(6, 10, |x, _| if (3..6).contains(&x) { 47 } else { 0 });

        build_flat(&grid0, json!({ "0": { "47": { "type": "boost", "dir": dir } } })).unwrap()
    }

    const DT: f32 = 1.0 / 120.0;

    #[test]
    fn boost_fires_on_entry_only() {
        let map = boost_strip("east");
        let y = 25.0;

        // прошлая клетка — асфальт: въезд
        assert_eq!(boost_dv(&map, 0, false, 30.5, y, 120.0, 0.0, DT), (160.0, 0.0));
        // прошлая клетка — та же плита: повторного импульса нет
        assert_eq!(boost_dv(&map, 0, false, 45.0, y, 120.0, 0.0, DT), (0.0, 0.0));
        // в полёте, против стрелки и ниже порога — ничего
        assert_eq!(boost_dv(&map, 0, true, 30.5, y, 120.0, 0.0, DT), (0.0, 0.0));
        assert_eq!(boost_dv(&map, 0, false, 59.5, y, -120.0, 0.0, DT), (0.0, 0.0));
        assert_eq!(boost_dv(&map, 0, false, 30.05, y, 10.0, 0.0, DT), (0.0, 0.0));
        // потолок скорости срезает импульс
        assert_eq!(boost_dv(&map, 0, false, 30.5, y, 300.0, 0.0, DT), (40.0, 0.0));
        assert_eq!(boost_dv(&map, 0, false, 31.0, y, 400.0, 0.0, DT), (0.0, 0.0));
    }

    #[test]
    fn boost_entry_from_off_the_grid_fires() {
        let grid0 = grid(6, 10, |x, _| i32::from(x == 0) * 47);
        let map = build_flat(&grid0, json!({ "0": { "47": { "type": "boost", "dir": "east" } } })).unwrap();

        assert_eq!(boost_dv(&map, 0, false, 0.5, 25.0, 120.0, 0.0, DT), (160.0, 0.0));
    }

    #[test]
    fn adjacent_plates_with_different_dirs_are_different_boosts() {
        let grid0 = grid(6, 10, |x, _| match x {
            3 => 47,
            4 => 48,
            _ => 0,
        });
        let map = build_flat(
            &grid0,
            json!({ "0": {
                "47": { "type": "boost", "dir": "east" },
                "48": { "type": "boost", "dir": "south" }
            } }),
        )
        .unwrap();

        // въезд с плиты «восток» на плиту «юг» со скоростью на юго-восток
        assert_eq!(boost_dv(&map, 0, false, 40.5, 25.0, 120.0, 120.0, DT), (0.0, 160.0));
    }

    // та же полоса, но плита с удержанием
    fn held_boost_strip() -> SurfaceMap {
        let grid0 = grid(6, 10, |x, _| if (3..6).contains(&x) { 47 } else { 0 });
        let mut held = rules();
        let boost = held.types.get_mut("boost").unwrap();

        boost.boost_time = Some(1.2);
        boost.boost_speed_factor = Some(1.8);

        SurfaceMap::build(&[&grid0], TILE, &game(json!({ "0": { "47": { "type": "boost", "dir": "east" } } })), &held)
            .unwrap()
    }

    #[test]
    fn plate_without_hold_starts_nothing() {
        let map = boost_strip("east");
        let mut state = LevelState::default();

        // импульс прежний бит-в-бит, удержания нет
        assert_eq!(boost_dv(&map, 0, false, 30.5, 25.0, 120.0, 0.0, DT), (160.0, 0.0));
        start_boost_hold(&map, &mut state, 30.5, 25.0);
        assert_eq!(state, LevelState::default());
        assert_eq!(boost_hold_mix(SurfaceMix::NEUTRAL, &state), SurfaceMix::NEUTRAL);
        assert_eq!(boost_damping_dv((300.0, 40.0), 3.0, &state, DT), (0.0, 0.0));
    }

    #[test]
    fn held_boost_raises_the_ceiling_until_it_expires() {
        let map = held_boost_strip();
        let mut state = LevelState::default();

        assert_eq!(boost_dv(&map, 0, false, 30.5, 25.0, 120.0, 0.0, DT), (160.0, 0.0));
        start_boost_hold(&map, &mut state, 30.5, 25.0);
        assert_eq!((state.boost_left, state.boost_factor), (1.2, 1.8));
        assert_eq!(boost_hold_mix(SurfaceMix::NEUTRAL, &state).max_speed, 1.8);

        // вне плиты удержание не запускается
        let mut off = LevelState::default();

        start_boost_hold(&map, &mut off, 5.0, 25.0);
        assert_eq!(off, LevelState::default());

        decay_boost(&mut state, 0.7);
        assert!((state.boost_left - 0.5).abs() < 1e-6);
        assert_eq!(state.boost_factor, 1.8);

        decay_boost(&mut state, 0.7);
        assert_eq!((state.boost_left, state.boost_factor), (0.0, 1.0));
        assert_eq!(boost_hold_mix(SurfaceMix::NEUTRAL, &state), SurfaceMix::NEUTRAL);
    }

    #[test]
    fn hold_compensation_cancels_one_damping_step() {
        let state = LevelState {
            boost_left: 1.0,
            boost_factor: 1.8,
            ..LevelState::default()
        };
        let (linear, v) = (3.0, (420.0, -35.0));
        let (dvx, dvy) = boost_damping_dv(v, linear, &state, DT);
        // затухание интеграции (`Predictor::integrate`, Rapier): v / (1 + l·dt)
        let damp = 1.0 / (1.0 + linear * DT);

        assert!(((v.0 + dvx) * damp - v.0).abs() < 1e-3);
        assert!(((v.1 + dvy) * damp - v.1).abs() < 1e-3);
    }

    #[test]
    fn body_mix_samples_the_centre_cell_and_ignores_flight() {
        let map = boost_strip("east");
        let (mix, kind) = body_mix(&map, 0, false, 45.0, 25.0);

        assert!(matches!(kind, SurfaceKind::Boost { .. }));
        assert_eq!(mix.drag, 0.0);
        // в полёте и на асфальте — нейтрально
        assert_eq!(body_mix(&map, 0, true, 45.0, 25.0), (SurfaceMix::NEUTRAL, SurfaceKind::Plain));
        assert_eq!(body_mix(&map, 0, false, 5.0, 25.0), (SurfaceMix::NEUTRAL, SurfaceKind::Plain));
    }

    #[test]
    fn body_dv_on_a_belt_is_the_coupling_alone() {
        let grid0 = grid(4, 4, |_, _| 45);
        let map = build_flat(&grid0, json!({ "0": { "45": { "type": "conveyor", "dir": "east" } } })).unwrap();
        let (mix, kind) = body_mix(&map, 0, false, 15.0, 15.0);
        let (dvx, dvy) = body_dv(mix, kind, &rules(), 20.0, 10.0, DT);

        // (belt − v) · bodyBeltCoupling · dt: сопротивления относительно
        // ленты поверх связи нет — оно удвоило бы связь
        assert!((dvx - 40.0 * 4.0 * DT).abs() < 1e-5, "{dvx}");
        assert!((dvy + 10.0 * 4.0 * DT).abs() < 1e-5, "{dvy}");
    }

    #[test]
    fn body_dv_keeps_a_zero_belt_a_belt_and_drags_on_plain() {
        let mut rules = rules();

        rules
            .types
            .insert("still".to_string(), serde_json::from_value(json!({ "belt": 0, "drag": 1.0 })).unwrap());

        let grid0 = grid(4, 8, |x, _| if x < 4 { 41 } else { 46 });
        let game = game(json!({ "0": { "41": "sand", "46": { "type": "still", "dir": "east" } } }));
        let map = SurfaceMap::build(&[&grid0], TILE, &game, &rules).unwrap();

        let (mix, kind) = body_mix(&map, 0, false, 15.0, 15.0);

        assert_eq!(body_dv(mix, kind, &rules, 10.0, 0.0, DT), (-10.0 * 1.2 * DT, 0.0));

        // лента с `belt: 0` — всё ещё лента: `drag` добавляется к связи
        let (mix, kind) = body_mix(&map, 0, false, 55.0, 15.0);
        let (dvx, _) = body_dv(mix, kind, &rules, 10.0, 0.0, DT);

        assert_eq!(kind, SurfaceKind::Conveyor { belt: 0.0 });
        assert!((dvx + 10.0 * (4.0 + 1.0) * DT).abs() < 1e-6, "{dvx}");
    }
}
