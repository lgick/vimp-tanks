//! Разбиение луча выстрела на сегменты (2.5D-карты). Пуля летит на своей
//! высоте (`shot_height::BulletLine`): уровень полёта — высший уровень не
//! выше пули, пол под ней — плита этого уровня или та, на которую упало
//! бы тело. Авторитетный hitscan, клиентский предиктор выстрела и боты
//! зовут ровно эту функцию, иначе трассер игрока разойдётся с
//! попаданием, посчитанным хостом.

use vimp_engine_core::client::raycast::walk_ray_cells;
use vimp_engine_core::map::MapLevels;

use crate::shot_height::BulletLine;

/// Запас на округление высоты пули: пуля ровно на уровне плиты — над ней.
const FLY_EPS: f32 = 1e-4;

/// Отрезок луча. `t` — дистанция вдоль НОРМАЛИЗОВАННОГО направления от
/// точки старта, в мировых единицах. `level` — уровень ПОЛА под пулей: по
/// нему фильтр коллизий, стены и насыпь рамп. `fly` — уровень ПОЛЁТА:
/// высший уровень не выше пули, в его проекции рисуются трассер и конец
/// луча. `fly > level` — воздушный сегмент: пуля над полом ниже своего
/// уровня и поражает только то, что до неё дорастает (`shot_height`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RaySegment {
    pub t0: f32,
    pub t1: f32,
    pub level: u8,
    pub fly: u8,
}

impl RaySegment {
    /// Воздушный сегмент: пуля над полом ниже уровня полёта.
    pub fn is_air(&self) -> bool {
        self.fly > self.level
    }
}

/// Один сегмент уровня 0 на всю дальность — луч одноуровневой карты.
fn ground_only(range: f32) -> Vec<RaySegment> {
    vec![RaySegment {
        t0: 0.0,
        t1: range,
        level: 0,
        fly: 0,
    }]
}

/// Пол под пулей, летящей на уровне `fly`, в мировой точке: сам `fly`,
/// если там его плита (у земли плита везде), иначе уровень, на который
/// упало бы тело (`MapLevels::landing_level`). Вне карты — земля.
pub fn floor_under(levels: &MapLevels, fly: u8, x: f32, y: f32) -> u8 {
    if fly == 0 || levels.has_floor(fly, x, y) {
        fly
    } else {
        levels.landing_level(fly, x, y)
    }
}

/// Сегменты луча от `origin` в направлении `dir` (единичном) длиной
/// `range`. `bullet` — высота пули вдоль луча (`shot_height::bullet_line`);
/// без неё (рендер трассера, `shot_segments`) пуля летит ровно на уровне
/// стрелка `level`.
///
/// В каждой клетке (на входе в неё) уровень полёта — высший уровень карты
/// не выше пули, пол — `floor_under`. Сегмент кончается там, где меняется
/// пара (пол, полёт):
///
/// * пуля с плиты не падает — над клеткой без плиты своего уровня она
///   летит воздушным сегментом, над плитой своего уровня (другой мост) —
///   снова обычным;
/// * пуля с земли идёт под плитой: окна у кромки нет, танк на мосту
///   снизу недосягаем;
/// * пуля со склона вверх (ствол задран) поднимается над плитой и летит
///   по ней; вниз — опускается на нижний уровень.
///
/// Одноуровневая карта даёт ровно один сегмент `[0, range]` уровня 0 —
/// путь стрельбы на таких картах обязан остаться прежним бит-в-бит.
pub fn ray_segments(
    levels: &MapLevels,
    origin: [f32; 2],
    dir: [f32; 2],
    range: f32,
    level: u8,
    bullet: Option<&BulletLine>,
) -> Vec<RaySegment> {
    if !levels.is_layered() {
        return ground_only(range);
    }

    // сетка земли задаёт размеры: гриды всех уровней у карты одинаковы
    let Some(grid) = levels.grid(0) else {
        return ground_only(range);
    };

    let rows = grid.len();
    let cols = grid.first().map_or(0, |row| row.len());
    let tile = levels.tile_size();

    if rows == 0 || cols == 0 || tile <= 0.0 {
        return ground_only(range);
    }

    let top = (levels.level_count() - 1) as u8;
    // уровень полёта на дистанции `t`
    let fly_at = |t: f32| -> u8 {
        match bullet {
            Some(line) => (line.at(t) + FLY_EPS).floor().clamp(0.0, f32::from(top)) as u8,
            None => level.min(top),
        }
    };
    // растущая пуля (ствол задран на склоне) может подняться и с земли
    let rising = bullet.is_some_and(|line| line.rate > 0.0);
    let mut out: Vec<RaySegment> = Vec::new();
    // (пол, полёт) текущего сегмента
    let mut current: Option<(u8, u8)> = None;
    let mut t0 = 0.0f32;

    walk_ray_cells(origin, dir, range, rows, cols, tile, |cx, cy, t| {
        let fly = fly_at(t);
        let center = [(cx as f32 + 0.5) * tile, (cy as f32 + 0.5) * tile];
        let state = (floor_under(levels, fly, center[0], center[1]), fly);

        match current {
            None => current = Some(state),
            Some(prev) if prev != state => {
                if t > t0 {
                    out.push(RaySegment {
                        t0,
                        t1: t,
                        level: prev.0,
                        fly: prev.1,
                    });
                    t0 = t;
                }

                current = Some(state);
            }
            _ => {}
        }

        // над землёй пуля, что не поднимается, уровня уже не сменит
        state != (0, 0) || rising
    });

    let (floor, fly) = current.unwrap_or((level.min(top), level.min(top)));

    out.push(RaySegment {
        t0,
        t1: range,
        level: floor,
        fly,
    });
    out
}

/// Достаёт ли луч на дистанции `t` пол уровня `level`: есть ли на `t`
/// сегмент с таким полом (обычный или воздушный). Дорастает ли цель до
/// пули, решает `shot_height::tank_reaches`.
pub fn covers_level(segments: &[RaySegment], t: f32, level: u8) -> bool {
    segments
        .iter()
        .any(|seg| t >= seg.t0 && t <= seg.t1 && seg.level == level)
}

/// Уровень ПРОЕКЦИИ луча на дистанции `t` (`fly` сегмента) — на нём клиент
/// рисует конец промаха. На границе двух сегментов берётся верхний.
pub fn level_at_distance(segments: &[RaySegment], t: f32) -> Option<u8> {
    segments
        .iter()
        .filter(|seg| t >= seg.t0 && t <= seg.t1)
        .map(|seg| seg.fly)
        .max()
}

#[cfg(test)]
mod tests {
    use super::*;

    use indexmap::IndexMap;
    use vimp_engine_core::map::MapLevelConfig;

    const TILE: f32 = 10.0;
    const RANGE: f32 = 100.0;

    /// Карта 8×8: колонки 3..5 — плита моста (тайл 2), клетка (5, 4) —
    /// перила (тайл 4, стена уровня 1).
    fn layered() -> MapLevels {
        let grid0 = vec![vec![0; 8]; 8];
        let mut grid1 = vec![vec![0; 8]; 8];

        for row in grid1.iter_mut() {
            for cell in row.iter_mut().take(6).skip(3) {
                *cell = 2;
            }
        }

        grid1[4][5] = 4;

        let mut levels: IndexMap<String, MapLevelConfig> = IndexMap::new();

        levels.insert(
            "1".to_string(),
            MapLevelConfig {
                map: grid1,
                floor: vec![2, 4],
                walls: vec![4],
                layers: IndexMap::new(),
                volumes: IndexMap::new(),
            },
        );

        MapLevels::build(&grid0, &[], &levels, &[], TILE, None)
    }

    /// Карта 8×8 на три уровня: плита уровня 1 — колонки 3..6, плита
    /// уровня 2 — колонки 3..5. Клетка (3, 4) уровня 1 — перила (тайл 4).
    fn terraced() -> MapLevels {
        let grid0 = vec![vec![0; 8]; 8];
        let mut grid1 = vec![vec![0; 8]; 8];
        let mut grid2 = vec![vec![0; 8]; 8];

        for row in grid1.iter_mut() {
            for cell in row.iter_mut().take(7).skip(3) {
                *cell = 2;
            }
        }

        for row in grid2.iter_mut() {
            for cell in row.iter_mut().take(6).skip(3) {
                *cell = 2;
            }
        }

        grid1[4][3] = 4;

        let mut levels: IndexMap<String, MapLevelConfig> = IndexMap::new();

        levels.insert(
            "1".to_string(),
            MapLevelConfig {
                map: grid1,
                floor: vec![2, 4],
                walls: vec![4],
                layers: IndexMap::new(),
                volumes: IndexMap::new(),
            },
        );
        levels.insert(
            "2".to_string(),
            MapLevelConfig {
                map: grid2,
                floor: vec![2],
                walls: vec![],
                layers: IndexMap::new(),
                volumes: IndexMap::new(),
            },
        );

        MapLevels::build(&grid0, &[], &levels, &[], TILE, None)
    }

    /// Карта 8×8: плита уровня 1 — колонки 1..2 и 5..6, между ними земля,
    /// перил нет.
    fn gapped() -> MapLevels {
        let grid0 = vec![vec![0; 8]; 8];
        let mut grid1 = vec![vec![0; 8]; 8];

        for row in grid1.iter_mut() {
            for col in [1, 2, 5, 6] {
                row[col] = 2;
            }
        }

        let mut levels: IndexMap<String, MapLevelConfig> = IndexMap::new();

        levels.insert(
            "1".to_string(),
            MapLevelConfig {
                map: grid1,
                floor: vec![2, 4],
                walls: vec![4],
                layers: IndexMap::new(),
                volumes: IndexMap::new(),
            },
        );

        MapLevels::build(&grid0, &[], &levels, &[], TILE, None)
    }

    fn flat() -> MapLevels {
        MapLevels::build(&vec![vec![0; 8]; 8], &[], &IndexMap::new(), &[], TILE, None)
    }

    /// Ровная пуля стрелка уровня `level`: ствол 1.0 при клетке 10.
    fn level_bullet(level: u8) -> BulletLine {
        BulletLine {
            base: f32::from(level) + 0.1,
            rate: 0.0,
        }
    }

    fn seg(t0: f32, t1: f32, level: u8, fly: u8) -> RaySegment {
        RaySegment { t0, t1, level, fly }
    }

    #[test]
    fn flat_map_gives_one_ground_segment() {
        let bare = ray_segments(&flat(), [5.0, 5.0], [1.0, 0.0], RANGE, 0, None);
        let shot = ray_segments(&flat(), [5.0, 5.0], [1.0, 0.0], RANGE, 0, Some(&level_bullet(0)));

        assert_eq!(bare, ground_only(RANGE));
        assert_eq!(shot, ground_only(RANGE));
    }

    #[test]
    fn bridge_ray_flies_over_the_ground() {
        // старт в колонке 3 (плита), луч на восток: колонка 6 плиты не
        // имеет — дальше пуля летит над землёй на высоте моста
        let segments =
            ray_segments(&layered(), [35.0, 5.0], [1.0, 0.0], RANGE, 1, Some(&level_bullet(1)));

        assert_eq!(segments, vec![seg(0.0, 25.0, 1, 1), seg(25.0, RANGE, 0, 1)]);
        assert!(segments[1].is_air());
    }

    #[test]
    fn bridge_ray_over_full_slab_stays_up() {
        // луч вдоль плиты (на юг по колонке 4) не покидает её до конца карты
        let segments =
            ray_segments(&layered(), [45.0, 5.0], [0.0, 1.0], 70.0, 1, Some(&level_bullet(1)));

        assert_eq!(segments, vec![seg(0.0, 70.0, 1, 1)]);
    }

    #[test]
    fn ground_ray_passes_under_the_slab() {
        // окна у кромки нет: пуля с земли идёт под плитой
        let segments =
            ray_segments(&layered(), [5.0, 5.0], [1.0, 0.0], RANGE, 0, Some(&level_bullet(0)));

        assert_eq!(segments, ground_only(RANGE));
    }

    #[test]
    fn miss_level_of_a_ground_ray_stays_on_the_ground() {
        let segments =
            ray_segments(&layered(), [5.0, 5.0], [1.0, 0.0], RANGE, 0, Some(&level_bullet(0)));

        assert_eq!(segments, ground_only(RANGE));
        assert_eq!(level_at_distance(&segments, RANGE), Some(0));
    }

    #[test]
    fn terraced_ray_stays_over_the_upper_slab() {
        // луч уровня 2 вдоль плиты 2 (на юг по колонке 4) её не покидает
        let segments =
            ray_segments(&terraced(), [45.0, 5.0], [0.0, 1.0], 70.0, 2, Some(&level_bullet(2)));

        assert_eq!(segments, vec![seg(0.0, 70.0, 2, 2)]);
    }

    #[test]
    fn terrace_ray_flies_over_two_lower_floors() {
        // старт в колонке 3 на уровне 2, луч на восток: колонка 6 несёт
        // только плиту 1, колонка 7 — уже земля; пуля остаётся на уровне 2
        let segments =
            ray_segments(&terraced(), [35.0, 5.0], [1.0, 0.0], RANGE, 2, Some(&level_bullet(2)));

        assert_eq!(
            segments,
            vec![seg(0.0, 25.0, 2, 2), seg(25.0, 35.0, 1, 2), seg(35.0, RANGE, 0, 2)]
        );
    }

    #[test]
    fn bridge_ray_returns_onto_a_slab_of_its_level() {
        // с одного моста через провал на другой того же уровня
        let segments =
            ray_segments(&gapped(), [15.0, 5.0], [1.0, 0.0], RANGE, 1, Some(&level_bullet(1)));

        assert_eq!(
            segments,
            vec![
                seg(0.0, 15.0, 1, 1),
                seg(15.0, 35.0, 0, 1),
                seg(35.0, 55.0, 1, 1),
                seg(55.0, RANGE, 0, 1),
            ]
        );
    }

    #[test]
    fn rising_bullet_climbs_onto_the_slab() {
        // на входе в x = 30 (t = 25) пуля ≈ 0.93 — ещё под плитой, на
        // входе в x = 40 (t = 35) ≈ 1.27 — уже над ней
        let bullet = BulletLine {
            base: 0.1,
            rate: 1.0 / 30.0,
        };
        let segments = ray_segments(&layered(), [5.0, 5.0], [1.0, 0.0], RANGE, 0, Some(&bullet));

        assert_eq!(
            segments,
            vec![seg(0.0, 35.0, 0, 0), seg(35.0, 55.0, 1, 1), seg(55.0, RANGE, 0, 1)]
        );
    }

    #[test]
    fn falling_bullet_comes_down_to_the_ground() {
        // на входе в x = 40 (t = 5) пуля на высоте 0.85 — ниже плиты
        let bullet = BulletLine {
            base: 1.1,
            rate: -0.05,
        };
        let segments = ray_segments(&layered(), [35.0, 5.0], [1.0, 0.0], RANGE, 1, Some(&bullet));

        assert_eq!(segments, vec![seg(0.0, 5.0, 1, 1), seg(5.0, RANGE, 0, 0)]);
    }

    #[test]
    fn without_a_bullet_the_ray_flies_at_the_shooter_level() {
        let bare = ray_segments(&layered(), [35.0, 5.0], [1.0, 0.0], RANGE, 1, None);
        let shot =
            ray_segments(&layered(), [35.0, 5.0], [1.0, 0.0], RANGE, 1, Some(&level_bullet(1)));

        assert_eq!(bare, shot);
    }

    #[test]
    fn level_at_distance_in_the_air_is_the_fly_level() {
        let segments =
            ray_segments(&layered(), [35.0, 5.0], [1.0, 0.0], RANGE, 1, Some(&level_bullet(1)));

        assert_eq!(level_at_distance(&segments, RANGE), Some(1));
        assert!(covers_level(&segments, 50.0, 0));
        assert!(!covers_level(&segments, 50.0, 1));
    }

    #[test]
    fn floor_under_answers_by_the_slab() {
        assert_eq!(floor_under(&layered(), 1, 45.0, 5.0), 1);
        assert_eq!(floor_under(&layered(), 1, 75.0, 5.0), 0);
        assert_eq!(floor_under(&terraced(), 2, 65.0, 5.0), 1);
        assert_eq!(floor_under(&layered(), 0, -5.0, 5.0), 0);
    }
}
