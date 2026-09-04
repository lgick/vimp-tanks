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
/// Правила (дословно те же, что были на двух уровнях, но на любом N):
///
/// * **вниз** — луч держит свой уровень, пока в клетке есть плита; в
///   первой клетке без неё падает на `landing_level` и продолжает уже
///   там. Падений может быть несколько подряд, уровень 0 — терминальный
///   (земля есть везде внутри карты);
/// * **вверх** — в первой клетке, где есть плита ближайшего уровня выше,
///   луч получает окно ровно на эту клетку (кромка); перила того уровня
///   окно закрывают. Дальше плита экранирует, луч идёт своим уровнем.
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

    let level_count = levels.level_count() as u8;

    // тайл уровня в клетке сетки (вне сетки — ничего)
    let tile_at = |lvl: u8, cx: i64, cy: i64| -> Option<i32> {
        if cx < 0 || cy < 0 || cy as usize >= rows {
            return None;
        }

        levels
            .grid(lvl)?
            .get(cy as usize)
            .and_then(|row| row.get(cx as usize))
            .copied()
    };
    let is_slab = |lvl: u8, cx: i64, cy: i64| {
        tile_at(lvl, cx, cy).is_some_and(|t| levels.floor(lvl).contains(&t))
    };
    let is_railing = |lvl: u8, cx: i64, cy: i64| {
        tile_at(lvl, cx, cy).is_some_and(|t| levels.solid(lvl).contains(&t))
    };
    // знак нуля обязателен: для осевого луча иначе проверялся бы
    // диагональный сосед вместо клетки строго позади
    let step = |d: f32| -> i64 {
        if d > 0.0 {
            1
        } else if d < 0.0 {
            -1
        } else {
            0
        }
    };

    let mut out: Vec<RaySegment> = Vec::new();
    // окно у кромки: выдаётся не более одного раза и только до первого
    // падения — сорвавшийся вниз луч наверх уже не смотрит
    let mut probe: Option<RaySegment> = None;
    let mut probe_done = false;
    // вход в СЛЕДУЮЩУЮ клетку = выход из клетки окна: точная верхняя
    // граница пробы. Оценка «диагональ клетки» была бы завышенной для
    // любого угла входа, кроме углового, и проба накрывала бы вторую
    // клетку плиты — танк на ней поражался бы с земли
    let mut probe_open = false;
    let mut current = level;
    let mut t0 = 0.0f32;

    walk_ray_cells(origin, dir, range, rows, cols, tile, |cx, cy, t| {
        if probe_open {
            if let Some(seg) = probe.as_mut() {
                seg.t1 = t;
            }

            probe_open = false;
        }

        // падение: в клетке нет плиты своего уровня
        if current >= 1 && !is_slab(current, cx, cy) {
            let center = [(cx as f32 + 0.5) * tile, (cy as f32 + 0.5) * tile];

            out.push(RaySegment {
                t0,
                t1: t,
                level: current,
            });

            current = levels.landing_level(current, center[0], center[1]);
            t0 = t;
            probe_done = true;
        }

        // окно у кромки уровня выше
        if !probe_done && t < range {
            let above = (current + 1..level_count).find(|&lvl| is_slab(lvl, cx, cy));

            if let Some(above) = above {
                probe_done = true;

                // стартовая клетка посещается с t = 0: стрелок ПОД плитой
                // бьёт вверх только стоя под самой кромкой (у соседней
                // клетки против направления луча плиты нет), иначе он
                // «простреливал» бы плиту из глубины
                let deep = t <= 0.0 && is_slab(above, cx - step(dir[0]), cy - step(dir[1]));

                // перила закрывают кромку от выстрела снизу
                if !deep && !is_railing(above, cx, cy) {
                    probe = Some(RaySegment {
                        t0: t,
                        t1: range,
                        level: above,
                    });
                    probe_open = true;
                }
            }
        }

        // ниже уровня 0 луч не падает, а окно уже решено — смотреть больше не на что
        current > 0 || !probe_done || probe_open
    });

    out.push(RaySegment {
        t0,
        t1: range,
        level: current,
    });

    if let Some(mut seg) = probe {
        seg.t1 = seg.t1.min(range);
        out.push(seg);
    }

    out
}

/// Достаёт ли луч на дистанции `t` цель, стоящую на уровне `level`.
///
/// Именно это спрашивают боты перед выстрелом: сегменты уровней 0 и 1 у
/// кромки плиты перекрываются, и «какой уровень выигрывает» дало бы
/// ложный запрет — наземный бот не стрелял бы в наземного врага,
/// оказавшегося в окне пробы.
pub fn covers_level(segments: &[RaySegment], t: f32, level: u8) -> bool {
    segments
        .iter()
        .any(|seg| t >= seg.t0 && t <= seg.t1 && seg.level == level)
}

/// Верхний уровень луча на дистанции `t` от старта. Для решения «попадёт
/// ли выстрел в цель» нужен `covers_level`; здесь `max` полезен там, где
/// нужен ровно один уровень — например конец трассера при промахе.
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
                volumes: IndexMap::new(),
            },
        );

        MapLevels::build(&grid0, &[], &levels, &[], TILE)
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
    fn probe_ends_at_the_border_of_the_edge_cell() {
        // кромка плиты на x = 30, вторая клетка плиты — x 40..50
        let segments = ray_segments(&layered(), [5.0, 5.0], [1.0, 0.0], RANGE, 0);
        let probe = segments[1];

        assert!(
            (probe.t1 - 35.0).abs() < 1e-3,
            "проба обязана кончиться на границе клетки: {segments:?}"
        );
        assert!(covers_level(&segments, 30.0, 1), "первая клетка плиты");
        assert!(
            !covers_level(&segments, 40.0, 1),
            "вторая клетка плиты танку с земли уже недоступна: {segments:?}"
        );
    }

    #[test]
    fn oblique_probe_is_shorter_than_the_cell_diagonal() {
        // луч входит в клетку плиты (3, 2) сбоку и почти сразу уходит
        // из неё вверх — оценка «диагональ» была бы вшестеро длиннее
        let segments = ray_segments(&layered(), [5.0, 55.0], [0.6, -0.8], RANGE, 0);
        let probe = segments[1];
        let span = probe.t1 - probe.t0;

        assert_eq!(probe.level, 1, "{segments:?}");
        assert!(
            span < TILE * std::f32::consts::SQRT_2,
            "проба длиннее диагонали клетки: {segments:?}"
        );
        assert!((span - 2.083).abs() < 1e-2, "{segments:?}");
    }

    #[test]
    fn axial_ray_checks_the_cell_strictly_behind() {
        let map = layered();

        // стрелок под серединой плиты (колонка 5, строка 5), луч строго
        // на север: клетка позади — (5, 6), тоже плита
        let deep = ray_segments(&map, [55.0, 55.0], [0.0, -1.0], RANGE, 0);

        assert_eq!(deep, ground_only(RANGE), "{deep:?}");

        // тот же луч из нижней строки: позади — край карты, значит
        // стрелок стоит под самой кромкой
        let edge = ray_segments(&map, [55.0, 75.0], [0.0, -1.0], RANGE, 0);

        assert_eq!(edge.len(), 2, "{edge:?}");
        assert_eq!(edge[1].level, 1);
        assert_eq!(edge[1].t0, 0.0);
    }

    #[test]
    fn miss_level_of_a_ground_ray_stays_on_the_ground() {
        // луч прошёл мимо кромки: последний сегмент списка — проба
        // уровня 1, но на конце луча действует уровень 0
        let segments = ray_segments(&layered(), [5.0, 5.0], [1.0, 0.0], RANGE, 0);

        assert_eq!(segments.last().map(|seg| seg.level), Some(1));
        assert_eq!(level_at_distance(&segments, RANGE), Some(0));
    }

    #[test]
    fn covers_level_sees_both_levels_inside_the_probe() {
        let segments = ray_segments(&layered(), [5.0, 5.0], [1.0, 0.0], RANGE, 0);
        let probe = segments[1];
        let inside = (probe.t0 + probe.t1) / 2.0;

        // наземная цель в окне пробы поражается — «максимум уровня» здесь
        // дал бы ложный запрет боту
        assert!(covers_level(&segments, inside, 0));
        assert!(covers_level(&segments, inside, 1));
        assert!(!covers_level(&segments, RANGE, 1));
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

    #[test]
    fn terraced_ray_stays_over_the_upper_slab() {
        // луч уровня 2 вдоль плиты 2 (на юг по колонке 4) её не покидает
        let segments = ray_segments(&terraced(), [45.0, 5.0], [0.0, 1.0], 70.0, 2);

        assert_eq!(
            segments,
            vec![RaySegment {
                t0: 0.0,
                t1: 70.0,
                level: 2,
            }]
        );
    }

    #[test]
    fn terraced_ray_drops_level_by_level() {
        // старт в колонке 3 на уровне 2, луч на восток: колонка 6 несёт
        // только плиту 1, колонка 7 — уже земля
        let segments = ray_segments(&terraced(), [35.0, 5.0], [1.0, 0.0], RANGE, 2);

        assert_eq!(segments.len(), 3, "{segments:?}");
        assert_eq!(
            segments,
            vec![
                RaySegment {
                    t0: 0.0,
                    t1: 25.0,
                    level: 2,
                },
                RaySegment {
                    t0: 25.0,
                    t1: 35.0,
                    level: 1,
                },
                RaySegment {
                    t0: 35.0,
                    t1: RANGE,
                    level: 0,
                },
            ]
        );
    }

    #[test]
    fn probe_gives_the_nearest_level_above() {
        // стрелок на земле в колонке 0, луч на восток: в первой клетке
        // плиты (колонка 3) есть и уровень 1, и уровень 2 — окно даёт
        // ровно ближайший сверху
        let segments = ray_segments(&terraced(), [5.0, 5.0], [1.0, 0.0], RANGE, 0);

        assert_eq!(segments.len(), 2, "{segments:?}");

        let probe = segments[1];

        assert_eq!(probe.level, 1, "{segments:?}");
        assert!((probe.t0 - 25.0).abs() < 1e-3, "{segments:?}");
        assert!((probe.t1 - 35.0).abs() < 1e-3, "{segments:?}");

        let inside = (probe.t0 + probe.t1) / 2.0;

        assert!(covers_level(&segments, inside, 1));
        assert!(
            !covers_level(&segments, inside, 2),
            "второй этаж с земли недосягаем: {segments:?}"
        );
    }

    #[test]
    fn probe_reaches_the_edge_of_the_level_above() {
        // стрелок уровня 1 в колонке 6, луч на запад: кромка плиты 2 —
        // колонка 5, окно накрывает ровно её
        let segments = ray_segments(&terraced(), [65.0, 5.0], [-1.0, 0.0], RANGE, 1);
        let probe = *segments.last().unwrap();

        assert_eq!(probe.level, 2, "{segments:?}");
        assert!((probe.t0 - 5.0).abs() < 1e-3, "{segments:?}");
        assert!((probe.t1 - 15.0).abs() < 1e-3, "{segments:?}");
        // за плитой 1 (колонка 2) луч уходит на землю
        assert_eq!(segments[0].level, 1);
        assert_eq!(segments[1].level, 0);
        assert!((segments[0].t1 - 35.0).abs() < 1e-3, "{segments:?}");
    }

    #[test]
    fn railing_closes_the_probe_on_a_terraced_map() {
        // строка 4: первая клетка плиты уровня 1 (колонка 3) — перила
        let segments = ray_segments(&terraced(), [5.0, 45.0], [1.0, 0.0], RANGE, 0);

        assert_eq!(segments, ground_only(RANGE), "{segments:?}");
    }
}
