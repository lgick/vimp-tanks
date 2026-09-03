//! Разбиение луча выстрела на сегменты по уровням (2.5D-карты). Правила
//! из plan/stage_4.md; авторитетный hitscan и клиентский предиктор
//! выстрела зовут ровно эту функцию, иначе трассер игрока разойдётся с
//! попаданием, посчитанным хостом.

use vimp_engine_core::client::raycast::walk_ray_cells;
use vimp_engine_core::map::MapLevels;

/// Отрезок луча, целиком лежащий на одном уровне. `t` — дистанция вдоль
/// НОРМАЛИЗОВАННОГО направления от точки старта, в мировых единицах.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RaySegment {
    pub t0: f32,
    pub t1: f32,
    pub level: u8,
}

/// Один сегмент уровня 0 на всю дальность — луч одноуровневой карты.
fn ground_only(range: f32) -> Vec<RaySegment> {
    vec![RaySegment {
        t0: 0.0,
        t1: range,
        level: 0,
    }]
}

/// Сегменты луча от `origin` в направлении `dir` (единичном) длиной
/// `range`, выпущенного с уровня `level`.
///
/// Одноуровневая карта даёт ровно один сегмент `[0, range]` уровня 0 —
/// путь стрельбы на таких картах обязан остаться прежним бит-в-бит.
pub fn ray_segments(
    levels: &MapLevels,
    origin: [f32; 2],
    dir: [f32; 2],
    range: f32,
    level: u8,
) -> Vec<RaySegment> {
    if !levels.is_layered() {
        return ground_only(range);
    }

    let Some(grid) = levels.grid(1) else {
        return ground_only(range);
    };

    let rows = grid.len();
    let cols = grid.first().map_or(0, |row| row.len());
    let tile = levels.tile_size();

    if rows == 0 || cols == 0 || tile <= 0.0 {
        return ground_only(range);
    }

    let floor = levels.floor(1);
    let solid = levels.solid(1);

    // плита/перила в клетке сетки уровня 1 (вне сетки — ни того, ни другого)
    let tile_at = |cx: i64, cy: i64| -> Option<i32> {
        if cx < 0 || cy < 0 || cy as usize >= rows {
            return None;
        }

        grid[cy as usize].get(cx as usize).copied()
    };
    let is_slab = |cx: i64, cy: i64| tile_at(cx, cy).is_some_and(|t| floor.contains(&t));
    let is_railing = |cx: i64, cy: i64| tile_at(cx, cy).is_some_and(|t| solid.contains(&t));

    if level >= 1 {
        // первая клетка БЕЗ плиты (или выход за границы карты) — там луч
        // «падает» на землю и обратно уже не поднимается
        let mut t_drop = range;

        walk_ray_cells(origin, dir, range, rows, cols, tile, |cx, cy, t| {
            if is_slab(cx, cy) {
                return true;
            }

            t_drop = t;

            false
        });

        if t_drop >= range {
            return vec![RaySegment {
                t0: 0.0,
                t1: range,
                level: 1,
            }];
        }

        return vec![
            RaySegment {
                t0: 0.0,
                t1: t_drop,
                level: 1,
            },
            RaySegment {
                t0: t_drop,
                t1: range,
                level: 0,
            },
        ];
    }

    // первая клетка С плитой: в ней (и только в ней) луч уровня 0 может
    // достать танк уровня 1, стоящий на открытой кромке
    let mut t_slab = range;
    let mut slab_cell: Option<(i64, i64)> = None;

    walk_ray_cells(origin, dir, range, rows, cols, tile, |cx, cy, t| {
        if !is_slab(cx, cy) {
            return true;
        }

        t_slab = t;
        slab_cell = Some((cx, cy));

        false
    });

    let mut out = ground_only(range);

    let Some((cx, cy)) = slab_cell else {
        return out;
    };

    if t_slab >= range || is_railing(cx, cy) {
        return out;
    }

    // стартовая клетка посещается с t = 0: стрелок ПОД мостом бьёт вверх
    // только стоя под самой кромкой (у соседней клетки против направления
    // луча плиты нет), иначе он «простреливал» бы плиту из глубины
    if t_slab <= 0.0 {
        let step_x: i64 = if dir[0] > 0.0 { 1 } else { -1 };
        let step_y: i64 = if dir[1] > 0.0 { 1 } else { -1 };

        if is_slab(cx - step_x, cy - step_y) {
            return out;
        }
    }

    // проба уровня 1 внутри ОДНОЙ клетки кромки. Верхняя граница — выход
    // из этой клетки; считаем её как t_slab + диагональ клетки, чего
    // заведомо хватает на любой угол входа, а лишнее отрежет проверка
    // «ближайшее попадание» (сегменты перекрываются, минимальный toi
    // выигрывает)
    let cell_span = tile * std::f32::consts::SQRT_2;

    out.push(RaySegment {
        t0: t_slab,
        t1: (t_slab + cell_span).min(range),
        level: 1,
    });

    out
}

/// Уровень луча на дистанции `t` от старта: по нему решается, поразит ли
/// выстрел цель, стоящую на своём уровне. Боты спрашивают это перед
/// стрельбой, чтобы не палить в плиту моста.
pub fn level_at_distance(segments: &[RaySegment], t: f32) -> Option<u8> {
    segments
        .iter()
        .filter(|seg| t >= seg.t0 && t <= seg.t1)
        // сегментов на `t` может быть два (проба уровня 1 лежит внутри
        // сегмента уровня 0) — берём ВЕРХНИЙ: именно он описывает
        // возможность попасть по мосту с земли
        .map(|seg| seg.level)
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
            },
        );

        MapLevels::build(&grid0, &[], &levels, &[], TILE)
    }

    fn flat() -> MapLevels {
        MapLevels::build(&vec![vec![0; 8]; 8], &[], &IndexMap::new(), &[], TILE)
    }

    #[test]
    fn flat_map_gives_one_ground_segment() {
        let segments = ray_segments(&flat(), [5.0, 5.0], [1.0, 0.0], RANGE, 0);

        assert_eq!(segments, ground_only(RANGE));
    }

    #[test]
    fn bridge_ray_drops_at_first_empty_cell() {
        // старт в колонке 3 (плита), луч на восток: колонка 6 плиты не имеет
        let segments = ray_segments(&layered(), [35.0, 5.0], [1.0, 0.0], RANGE, 1);

        assert_eq!(segments.len(), 2, "{segments:?}");
        assert_eq!(segments[0].level, 1);
        assert_eq!(segments[1].level, 0);
        assert!(
            (segments[0].t1 - 25.0).abs() < 1e-3,
            "кромка плиты на x = 60: {segments:?}"
        );
        assert_eq!(segments[0].t1, segments[1].t0);
        assert_eq!(segments[1].t1, RANGE);
    }

    #[test]
    fn bridge_ray_over_full_slab_stays_up() {
        // луч вдоль плиты (на юг по колонке 4) не покидает её до конца карты
        let segments = ray_segments(&layered(), [45.0, 5.0], [0.0, 1.0], 70.0, 1);

        assert_eq!(
            segments,
            vec![RaySegment {
                t0: 0.0,
                t1: 70.0,
                level: 1,
            }]
        );
    }

    #[test]
    fn ground_ray_probes_the_first_slab_cell() {
        // стрелок в колонке 0, луч на восток: кромка плиты на x = 30
        let segments = ray_segments(&layered(), [5.0, 5.0], [1.0, 0.0], RANGE, 0);

        assert_eq!(segments.len(), 2, "{segments:?}");
        assert_eq!(segments[0], ground_only(RANGE)[0]);
        assert_eq!(segments[1].level, 1);
        assert!(
            (segments[1].t0 - 25.0).abs() < 1e-3,
            "проба начинается на кромке: {segments:?}"
        );
        assert!(segments[1].t1 > segments[1].t0);
        assert!(segments[1].t1 < RANGE);
    }

    #[test]
    fn railing_cell_blocks_the_probe() {
        // строка 4: первая клетка плиты в колонке 3, но луч с востока
        // входит в колонку 5 — тайл перил
        let segments = ray_segments(&layered(), [75.0, 45.0], [-1.0, 0.0], RANGE, 0);

        assert_eq!(segments, ground_only(RANGE), "{segments:?}");
    }

    #[test]
    fn shooter_deep_under_the_bridge_has_no_probe() {
        // стрелок в колонке 4 (под серединой плиты), луч на восток:
        // соседняя клетка против луча — тоже плита
        let segments = ray_segments(&layered(), [45.0, 5.0], [1.0, 0.0], RANGE, 0);

        assert_eq!(segments, ground_only(RANGE), "{segments:?}");
    }

    #[test]
    fn level_at_distance_prefers_the_upper_segment() {
        // стрелок в колонке 0, луч на восток: на кромке плиты сегменты
        // уровней 0 и 1 перекрываются
        let segments = ray_segments(&layered(), [5.0, 5.0], [1.0, 0.0], RANGE, 0);
        let probe = segments[1];
        let inside = (probe.t0 + probe.t1) / 2.0;

        assert_eq!(level_at_distance(&segments, inside), Some(1));
        assert_eq!(level_at_distance(&segments, probe.t0 - 1.0), Some(0));
        assert_eq!(level_at_distance(&segments, probe.t1 + 1.0), Some(0));
        assert_eq!(level_at_distance(&segments, RANGE + 1.0), None);
    }

    #[test]
    fn shooter_under_the_edge_keeps_the_probe() {
        // стрелок в колонке 3 (первая клетка плиты), луч на восток:
        // соседней клетки плиты позади нет — он под самой кромкой
        let segments = ray_segments(&layered(), [35.0, 5.0], [1.0, 0.0], RANGE, 0);

        assert_eq!(segments.len(), 2, "{segments:?}");
        assert_eq!(segments[1].level, 1);
        assert_eq!(segments[1].t0, 0.0);
    }
}
