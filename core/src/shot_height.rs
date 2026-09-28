//! Высота пули hitscan и насыпь рамп. Физика и лучи двумерны, а рампа —
//! склон: пуля летит на высоте ствола стрелка и упирается в насыпь (склон
//! сверху, борт, торец), только если та выше неё. Стражи рамп
//! (`map::ramp_guards`) — препятствие для ТЕЛ; пуле они давали упор у
//! верхней кромки, в кромку моста и в борт на полу. Одна модель на хост
//! (`TanksSim::process_hitscan`), предиктор (`ShotPredictor::cast_ray`) и
//! ботов (`bots::controller`) — копии расходятся молча. Уровень полёта и
//! пол под пулей — `shot_levels::ray_segments`.

use vimp_engine_core::client::raycast::walk_ray_cells;
use vimp_engine_core::map::MapLevels;

use crate::map_game::MapGame;
use crate::shot_levels::RaySegment;

/// Код попадания в строке трассера (`wasHit`, u8 схемы `w1`). Зеркало —
/// `W1_HIT_*` в src/client/snapshotFields.js.
pub const HIT_NONE: u8 = 0;
/// Тело или стена.
pub const HIT_TARGET: u8 = 1;
/// Склон рампы сверху: насыпь поднялась выше пули. Высота пули в точке —
/// высота склона.
pub const HIT_SLOPE: u8 = 2;
/// Грань насыпи — борт или торец, в который луч вошёл снаружи ниже её
/// верха. Клиент рисует её как грань стены.
pub const HIT_EMBANKMENT_FACE: u8 = 3;

/// Допуск «прогон начинается на границе сегмента», мировые единицы.
const ENTRY_EPS: f32 = 1e-3;

/// Высота пули вдоль луча, в уровнях: `base + rate · t`, `t` — дистанция
/// от дула вдоль луча (мировые единицы).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BulletLine {
    pub base: f32,
    pub rate: f32,
}

impl BulletLine {
    pub fn at(&self, t: f32) -> f32 {
        self.base + self.rate * t
    }
}

/// Линия пули стрелка. Корпус на высоте `z` (уровни), ствол на `barrel`
/// мировых единиц над полом, дуло в `muzzle_offset` вдоль луча впереди
/// центра корпуса. `slope_vec` — безразмерный уклон под корпусом
/// (`LevelState::slope_vec`: ноль вне склона и в полёте). Стоящий на склоне
/// наклонён вместе с корпусом, ствол идёт вдоль склона, и высота пули
/// меняется с уклоном по направлению выстрела. `level_height` — мировых
/// единиц на уровень (`MapLevels::level_height`).
pub fn bullet_line(
    z: f32,
    slope_vec: [f32; 2],
    dir: [f32; 2],
    barrel: f32,
    muzzle_offset: f32,
    level_height: f32,
) -> BulletLine {
    let rate = (slope_vec[0] * dir[0] + slope_vec[1] * dir[1]) / level_height;

    BulletLine {
        base: z + barrel / level_height + rate * muzzle_offset,
        rate,
    }
}

/// Дорастает ли танк до пули: верх корпуса `z + turret_top / level_height`
/// (уровни) не ниже высоты пули `h`. Одно правило на хост, предиктор и
/// ботов. Стоящий на полу танк (верх 3.0) всегда выше ствола (2.4) своего
/// уровня; не дорастает — наземный танк под пулей с моста и под пулей
/// стрелка, стоящего высоко на склоне.
pub fn tank_reaches(z: f32, turret_top: f32, level_height: f32, h: f32) -> bool {
    z + turret_top / level_height >= h
}

/// Первая стена воздушного сегмента, дорастающая до пули. Клетки сегмента
/// обходятся по порядку; на входе в клетку смотрятся стены уровней от пола
/// до уровня полёта (`levels.solid(k)`), и стена засчитывается, если её верх
/// `k + wall_height(k, tile)` не ниже пули. Дистанция — от начала ЛУЧА;
/// None — стен выше пули нет. Обычный сегмент стены судит по-старому
/// (коллайдеры хоста, `ray_vs_grid` предиктора).
pub fn first_tall_wall(
    levels: &MapLevels,
    map_game: &MapGame,
    segment: &RaySegment,
    origin: [f32; 2],
    dir: [f32; 2],
    bullet: &BulletLine,
) -> Option<f32> {
    let grid = levels.grid(0)?;
    let rows = grid.len();
    let cols = grid.first().map_or(0, |row| row.len());
    let tile = levels.tile_size();

    if segment.t1 <= segment.t0 || rows == 0 || cols == 0 || tile <= 0.0 {
        return None;
    }

    let mut hit = None;

    // обход — от начала ЛУЧА, как в `ray_segments`: клетки и дистанции входа
    // совпадают с нарезкой, первая клетка сегмента входит ровно на `t0`
    walk_ray_cells(origin, dir, segment.t1, rows, cols, tile, |cx, cy, t| {
        // клетка, в которую луч входит на `t1`, — уже следующего сегмента
        if t >= segment.t1 {
            return false;
        }

        // клетки прошлых сегментов
        if t < segment.t0 || cx < 0 || cy < 0 {
            return true;
        }

        let h = bullet.at(t);
        let tall = (segment.level..=segment.fly).any(|k| {
            levels
                .grid(k)
                .and_then(|g| g.get(cy as usize))
                .and_then(|row| row.get(cx as usize))
                .is_some_and(|&cell| {
                    levels.solid(k).contains(&cell) && f32::from(k) + map_game.wall_height(k, cell) >= h
                })
        });

        if tall {
            hit = Some(t);

            return false;
        }

        true
    });

    hit
}

/// Встреча пули с насыпью рампы.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EmbankmentHit {
    /// дистанция вдоль луча
    pub t: f32,
    /// уровень ПРОЕКЦИИ конца — `fly` сегмента (у обычного сегмента — его
    /// уровень)
    pub level: u8,
    /// `HIT_SLOPE` или `HIT_EMBANKMENT_FACE`
    pub code: u8,
}

// параметры входа и выхода луча o + d·t в полосу [lo, hi]; None — мимо
fn slab(o: f32, d: f32, lo: f32, hi: f32) -> Option<(f32, f32)> {
    if d.abs() < 1e-9 {
        return (lo..=hi).contains(&o).then_some((f32::NEG_INFINITY, f32::INFINITY));
    }

    let a = (lo - o) / d;
    let b = (hi - o) / d;

    Some(if a < b { (a, b) } else { (b, a) })
}

/// Первая встреча пули с насыпью рамп на отрезке луча `segment`.
/// Учитываются прогоны, чей НИЖНИЙ уровень — пол сегмента. Внутри прогона
/// высота склона и пули вдоль прямого луча линейны, поэтому точка
/// считается точно. Правила:
///   - луч вошёл в прогон снаружи в пределах сегмента, а насыпь на входе
///     выше пули — грань (`HIT_EMBANKMENT_FACE`): борт или торец;
///   - внутри прогона склон поднялся выше пули — склон (`HIT_SLOPE`).
///
/// Верхний торец пулю не останавливает: выше него плита, и на неё луч
/// поднимает `ray_segments`.
pub fn embankment_hit(
    levels: &MapLevels,
    origin: [f32; 2],
    dir: [f32; 2],
    segment: &RaySegment,
    bullet: &BulletLine,
) -> Option<EmbankmentHit> {
    let (t0, t1, level) = (segment.t0, segment.t1, segment.level);
    let mut best: Option<EmbankmentHit> = None;

    for run in levels.runs() {
        if run.from.min(run.to) != level {
            continue;
        }

        let span = run.max - run.min;

        if span <= 0.0 {
            continue;
        }

        let along_x = run.axis == 0;
        let (ao, ad) = if along_x { (origin[0], dir[0]) } else { (origin[1], dir[1]) };
        let (co, cd) = if along_x { (origin[1], dir[1]) } else { (origin[0], dir[0]) };
        let (Some(along), Some(cross)) = (
            slab(ao, ad, run.min, run.max),
            slab(co, cd, run.cross_min, run.cross_max),
        ) else {
            continue;
        };
        let t_in = t0.max(along.0).max(cross.0);
        let t_out = t1.min(along.1).min(cross.1);

        if !(t_in <= t_out) {
            continue;
        }

        let surface = |t: f32| {
            let progress = ((ao + ad * t - run.min) / span).clamp(0.0, 1.0);
            let progress = if run.sign > 0 { progress } else { 1.0 - progress };

            run.from as f32 + (run.to as f32 - run.from as f32) * progress
        };
        let gap_in = surface(t_in) - bullet.at(t_in);
        let gap_out = surface(t_out) - bullet.at(t_out);
        // луч вошёл в прогон снаружи в пределах этого сегмента, а не начал
        // сегмент уже внутри насыпи (стрелок на склоне, смена уровня полёта над
        // склоном)
        let entry = along.0.max(cross.0);
        let hit = if gap_in > 0.0 {
            let code = if entry >= t0 - ENTRY_EPS { HIT_EMBANKMENT_FACE } else { HIT_SLOPE };

            Some((t_in, code))
        } else if gap_out > 0.0 {
            Some((t_in + (-gap_in) / (gap_out - gap_in) * (t_out - t_in), HIT_SLOPE))
        } else {
            None
        };

        if let Some((t, code)) = hit
            && best.is_none_or(|b| t < b.t)
        {
            best = Some(EmbankmentHit {
                t,
                level: segment.fly,
                code,
            });
        }
    }

    best
}

/// Ближайшая встреча пули с насыпью по всем сегментам луча (`ray_segments`).
pub fn first_embankment_hit(
    levels: &MapLevels,
    segments: &[RaySegment],
    origin: [f32; 2],
    dir: [f32; 2],
    bullet: &BulletLine,
) -> Option<EmbankmentHit> {
    segments
        .iter()
        .filter(|segment| segment.t1 > segment.t0)
        .filter_map(|segment| embankment_hit(levels, origin, dir, segment, bullet))
        .min_by(|a, b| a.t.total_cmp(&b.t))
}

#[cfg(test)]
mod tests {
    use super::*;

    use indexmap::IndexMap;
    use vimp_engine_core::map::{MapLevelConfig, RampConfig, RampDir};

    const TILE: f32 = 10.0;
    const EPS: f32 = 1e-3;

    /// Пуля пола: ствол 1.0 при клетке 10.
    const FLOOR: BulletLine = BulletLine { base: 0.1, rate: 0.0 };

    /// Карта 10×3: рампа в строке 1, колонки 3..5 (x 30..60), подъём на
    /// восток 0 → 1; плита уровня 1 в колонках 6..9. `level_height` —
    /// по умолчанию, клетка 10.
    fn ramp_map() -> MapLevels {
        let mut grid0 = vec![vec![0; 10]; 3];
        let mut grid1 = vec![vec![0; 10]; 3];

        for cell in grid0[1].iter_mut().take(6).skip(3) {
            *cell = 3;
        }

        for cell in grid1[1].iter_mut().skip(6) {
            *cell = 2;
        }

        let mut levels: IndexMap<String, MapLevelConfig> = IndexMap::new();

        levels.insert(
            "1".to_string(),
            MapLevelConfig {
                map: grid1,
                floor: vec![2],
                walls: vec![],
                layers: IndexMap::new(),
                volumes: IndexMap::new(),
            },
        );

        let ramps = [RampConfig { tile: 3, dir: RampDir::East, from: 0, to: 1 }];

        MapLevels::build(&grid0, &[], &levels, &ramps, TILE, None)
    }

    /// Карта 10×3, клетка 10: стена земли (тайл 1) в колонке 8 (x 80..90) во
    /// всех строках; у уровня 1 — стена без плиты (тайл 4) в колонке 6 строки 0.
    fn walled_map() -> MapLevels {
        let mut grid0 = vec![vec![0; 10]; 3];
        let mut grid1 = vec![vec![0; 10]; 3];

        for row in grid0.iter_mut() {
            row[8] = 1;
        }

        grid1[0][6] = 4;

        let mut levels: IndexMap<String, MapLevelConfig> = IndexMap::new();

        levels.insert(
            "1".to_string(),
            MapLevelConfig {
                map: grid1,
                floor: vec![],
                walls: vec![4],
                layers: IndexMap::new(),
                volumes: IndexMap::new(),
            },
        );

        MapLevels::build(&grid0, &[1], &levels, &[], TILE, None)
    }

    fn heights(value: serde_json::Value) -> MapGame {
        MapGame::from_value(&serde_json::json!({ "wallHeights": value })).unwrap()
    }

    /// Воздушный сегмент над землёй на высоте моста.
    const AIR: RaySegment = RaySegment { t0: 0.0, t1: 100.0, level: 0, fly: 1 };

    /// Пуля с моста.
    const BRIDGE: BulletLine = BulletLine { base: 1.1, rate: 0.0 };

    fn tall_wall(map_game: &MapGame, segment: &RaySegment, origin: [f32; 2], bullet: &BulletLine) -> Option<f32> {
        first_tall_wall(&walled_map(), map_game, segment, origin, [1.0, 0.0], bullet)
    }

    #[test]
    fn tank_reaches_by_its_top() {
        assert!(tank_reaches(0.0, 3.0, 32.0, 0.075));
        assert!(!tank_reaches(0.0, 3.0, 32.0, 1.075));
        assert!(tank_reaches(0.99, 3.0, 32.0, 1.075));
    }

    #[test]
    fn low_wall_is_flown_over() {
        let map_game = heights(serde_json::json!({ "0": { "1": 1.0 } }));

        assert_eq!(tall_wall(&map_game, &AIR, [5.0, 15.0], &BRIDGE), None);
    }

    #[test]
    fn wall_without_height_stops_the_bullet() {
        assert_eq!(tall_wall(&MapGame::default(), &AIR, [5.0, 15.0], &BRIDGE), Some(75.0));
    }

    #[test]
    fn tall_wall_stops_the_bullet() {
        let map_game = heights(serde_json::json!({ "0": { "1": 2.0 } }));

        assert_eq!(tall_wall(&map_game, &AIR, [5.0, 15.0], &BRIDGE), Some(75.0));
    }

    #[test]
    fn falling_bullet_meets_a_low_wall() {
        // на t = 75 пуля на высоте 0.925 — ниже верха стены 1.0
        let map_game = heights(serde_json::json!({ "0": { "1": 1.0 } }));
        let bullet = BulletLine { base: 1.3, rate: -0.005 };

        assert_eq!(tall_wall(&map_game, &AIR, [5.0, 15.0], &bullet), Some(75.0));
    }

    #[test]
    fn wall_of_the_fly_level_counts() {
        // стена уровня 1 в колонке 6 строки 0: верх 1.35 выше пули
        let map_game = heights(serde_json::json!({ "0": { "1": 1.0 }, "1": { "4": 0.35 } }));

        assert_eq!(tall_wall(&map_game, &AIR, [5.0, 5.0], &BRIDGE), Some(55.0));
    }

    #[test]
    fn wall_past_the_segment_end_is_ignored() {
        let segment = RaySegment { t0: 0.0, t1: 70.0, level: 0, fly: 1 };

        assert_eq!(tall_wall(&MapGame::default(), &segment, [5.0, 15.0], &BRIDGE), None);
    }

    #[test]
    fn wall_entered_before_the_segment_is_ignored() {
        // луч вошёл в стену колонки 8 на t = 75, раньше `t0`: это клетка
        // прошлого сегмента
        let segment = RaySegment { t0: 80.0, t1: 100.0, level: 0, fly: 1 };

        assert_eq!(tall_wall(&MapGame::default(), &segment, [5.0, 15.0], &BRIDGE), None);
    }

    fn hit(origin: [f32; 2], dir: [f32; 2], t0: f32, t1: f32, level: u8, bullet: BulletLine) -> Option<EmbankmentHit> {
        let segment = RaySegment { t0, t1, level, fly: level };

        embankment_hit(&ramp_map(), origin, dir, &segment, &bullet)
    }

    #[test]
    fn floor_bullet_up_the_ramp_stops_on_the_slope() {
        let found = hit([5.0, 15.0], [1.0, 0.0], 0.0, 100.0, 0, FLOOR).expect("склон");

        assert_eq!(found.code, HIT_SLOPE);
        assert_eq!(found.level, 0);
        assert!((found.t - 28.0).abs() < EPS, "t = {}", found.t);
    }

    #[test]
    fn bridge_bullet_goes_down_the_ramp() {
        let bullet = BulletLine { base: 1.1, rate: 0.0 };

        assert_eq!(hit([75.0, 15.0], [-1.0, 0.0], 15.0, 100.0, 0, bullet), None);
    }

    #[test]
    fn bullet_along_the_slope_passes_the_top_end() {
        // правила торца больше нет: на плиту пулю поднимает `ray_segments`
        let bullet = bullet_line(1.0 / 3.0, [1.0 / 3.0, 0.0], [1.0, 0.0], 1.0, 0.0, 10.0);

        assert_eq!(hit([40.0, 15.0], [1.0, 0.0], 0.0, 100.0, 0, bullet), None);
    }

    #[test]
    fn side_shot_hits_the_embankment_face() {
        let found = hit([45.0, 28.0], [0.0, -1.0], 0.0, 100.0, 0, FLOOR).expect("борт");

        assert_eq!(found.code, HIT_EMBANKMENT_FACE);
        assert!((found.t - 8.0).abs() < EPS, "t = {}", found.t);
    }

    #[test]
    fn side_shot_at_the_foot_clears_a_low_side() {
        let bullet = BulletLine { base: 0.2, rate: 0.0 };

        assert_eq!(hit([33.0, 28.0], [0.0, -1.0], 0.0, 100.0, 0, bullet), None);
    }

    #[test]
    fn shot_from_under_the_bridge_hits_the_top_end_face() {
        let found = hit([75.0, 15.0], [-1.0, 0.0], 0.0, 100.0, 0, FLOOR).expect("торец");

        assert_eq!(found.code, HIT_EMBANKMENT_FACE);
        assert!((found.t - 15.0).abs() < EPS, "t = {}", found.t);
    }

    #[test]
    fn other_level_or_short_segment_misses() {
        assert_eq!(hit([5.0, 15.0], [1.0, 0.0], 0.0, 100.0, 1, FLOOR), None);
        assert_eq!(hit([5.0, 15.0], [1.0, 0.0], 0.0, 20.0, 0, FLOOR), None);
    }

    #[test]
    fn first_hit_over_segments_is_the_nearest() {
        let segments = [
            RaySegment { t0: 0.0, t1: 100.0, level: 0, fly: 0 },
            RaySegment { t0: 0.0, t1: 0.0, level: 1, fly: 1 },
        ];
        let found =
            first_embankment_hit(&ramp_map(), &segments, [5.0, 15.0], [1.0, 0.0], &FLOOR).expect("склон");

        assert!((found.t - 28.0).abs() < EPS, "t = {}", found.t);
    }

    #[test]
    fn segment_starting_on_the_run_edge_hits_the_face() {
        // сегмент начинается ровно на торце x = 60
        let found = hit([75.0, 15.0], [-1.0, 0.0], 15.0, 100.0, 0, FLOOR).expect("торец");

        assert_eq!(found.code, HIT_EMBANKMENT_FACE);
        assert!((found.t - 15.0).abs() < EPS, "t = {}", found.t);
    }

    #[test]
    fn segment_started_inside_the_embankment_hits_the_slope() {
        // склон на x = 45 — 0.5, выше пули; сегмент начат внутри прогона
        let bullet = BulletLine { base: 0.3, rate: 0.0 };
        let found = hit([45.0, 15.0], [1.0, 0.0], 0.0, 100.0, 0, bullet).expect("склон");

        assert_eq!(found.code, HIT_SLOPE);
        assert!(found.t.abs() < EPS, "t = {}", found.t);
    }

    #[test]
    fn air_hit_carries_the_fly_level() {
        let segment = RaySegment { t0: 0.0, t1: 100.0, level: 0, fly: 1 };
        let found = embankment_hit(&ramp_map(), [5.0, 15.0], [1.0, 0.0], &segment, &FLOOR).expect("склон");

        assert_eq!(found.level, 1);
        assert_eq!(found.code, HIT_SLOPE);
    }

    #[test]
    fn bridge_bullet_over_an_air_segment_misses() {
        let segment = RaySegment { t0: 0.0, t1: 100.0, level: 0, fly: 1 };
        let bullet = BulletLine { base: 1.1, rate: 0.0 };

        assert_eq!(embankment_hit(&ramp_map(), [75.0, 15.0], [-1.0, 0.0], &segment, &bullet), None);
    }

    #[test]
    fn bullet_line_on_the_floor_is_flat() {
        let line = bullet_line(0.0, [0.0, 0.0], [1.0, 0.0], 2.4, 5.0, 32.0);

        assert_eq!(line.rate, 0.0);
        assert!((line.base - 2.4 / 32.0).abs() < 1e-6);
    }

    #[test]
    fn bullet_line_across_the_slope_is_flat() {
        let line = bullet_line(0.5, [0.25, 0.0], [0.0, 1.0], 1.0, 0.0, 10.0);

        assert_eq!(line.rate, 0.0);
        assert!((line.base - 0.6).abs() < 1e-6);
    }

    #[test]
    fn bullet_line_along_the_slope_follows_it() {
        let line = bullet_line(0.5, [0.25, 0.0], [1.0, 0.0], 1.0, 0.0, 10.0);

        assert!((line.rate - 0.025).abs() < 1e-6);

        let shifted = bullet_line(0.5, [0.25, 0.0], [1.0, 0.0], 1.0, 4.0, 10.0);

        assert!((shifted.base - (line.base + 0.025 * 4.0)).abs() < 1e-6);
    }
}
