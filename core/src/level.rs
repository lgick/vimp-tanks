//! Правила 2.5D-уровней: рампы, обрывы, падение. Чистые функции над
//! `MapLevels` (геометрия слоёв, крейт движка) — авторитетный путь
//! (`TanksSim::update_levels`) и клиентская реплика (`client::predictor`)
//! обязаны звать ровно их, иначе предсказание уровня разъедется с
//! авторитетным молча.

use rapier2d::prelude::Group;
use serde::{Deserialize, Serialize};
use vimp_engine_core::map::{level_group, FallModel, MapLevels, RampSample, STATIC_LEVEL_GROUP};
use vimp_engine_core::physics::lerp;

use crate::config::LevelRules;

/// Состояние перехода между уровнями.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Transit {
    /// Стоит на своём уровне.
    Grounded,
    /// Центр корпуса на клетке рампы: коллизии ВСЕХ уровней прогона.
    /// `climbing` — прошёл ли танк гейт входа (иначе прогон работает для
    /// него как плоская клетка его уровня, см. `entry_is_legal`);
    /// `low`/`high` — границы прогона: они нужны и маске, и снапу уровня.
    Ramp { climbing: bool, low: u8, high: u8 },
    /// Свободное падение с обрыва: остаются только стены, ввод заблокирован.
    /// `from` — уровень срыва, `to` — уровень приземления (он выбран в
    /// момент срыва: под танком может быть не земля, а нижняя плита).
    Falling { elapsed: f32, from: u8, to: u8 },
}

/// Уровень танка/тела и его визуальная высота.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct LevelState {
    pub level: u8,
    /// 0.0 — земля, 1.0 — плита первого уровня; дробные значения —
    /// рампа/падение.
    pub z: f32,
    pub transit: Transit,
    /// Клетка центра корпуса на прошлом шаге; `(-1, -1)` — неизвестна
    /// (спавн, первый шаг, точка вне карты). Ею гейт рампы отличает заход
    /// с торца прогона от заезда в него сбоку.
    pub prev_cell: (i32, i32),
    /// Вектор уклона: уровней на мировую единицу, `(0, 0)` вне рампы.
    /// Заполняется из `RampSample { dir, slope }` и только при `climbing`.
    pub slope_vec: [f32; 2],
}

impl Default for LevelState {
    fn default() -> Self {
        Self {
            level: 0,
            z: 0.0,
            transit: Transit::Grounded,
            prev_cell: (-1, -1),
            slope_vec: [0.0, 0.0],
        }
    }
}

/// Что случилось на этом шаге.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LevelEvent {
    None,
    /// Танк только что коснулся опоры после падения; `height` — высота
    /// падения в уровнях (по ней считается урон).
    Landed { height: u8 },
}

impl LevelState {
    /// Игнорирует ли ввод (падение).
    pub fn input_locked(&self) -> bool {
        matches!(self.transit, Transit::Falling { .. })
    }

    /// Битовая маска уровней, которые тело сейчас видит физически.
    /// `Falling` — только группа статики: падающий пролетает за время
    /// падения около семи тайлов, и без стен он проходил бы сквозь здание и
    /// приземлялся внутри него; при этом ни танки, ни ящики, ни лучи, ни
    /// взрывы его не достают — они живут в группах уровней.
    pub fn collision_mask(&self) -> Group {
        match self.transit {
            Transit::Falling { .. } => STATIC_LEVEL_GROUP,
            // на рампе тело видит геометрию всех уровней, которые прогон
            // соединяет: иначе на рампе 0 → 2 танк провалился бы сквозь
            // промежуточную геометрию или упёрся в невидимую стену
            Transit::Ramp { low, high, .. } => (low..=high)
                .fold(Group::empty(), |acc, level| acc | level_group(level)),
            Transit::Grounded => level_group(self.level),
        }
    }

    /// Продольный уклон под курсом `(heading_x, heading_y)`: положительный
    /// — в горку. Вне рампы всегда 0, поэтому одноуровневая карта считает
    /// движение прежними формулами бит-в-бит.
    pub fn grade(&self, heading_x: f32, heading_y: f32) -> f32 {
        self.slope_vec[0] * heading_x + self.slope_vec[1] * heading_y
    }
}

/// Модель падения по правилам игры — одна траектория на танки и на тела
/// карты (её же зовёт движок в `step_body_level`).
pub fn fall_model(rules: &LevelRules) -> FallModel {
    FallModel {
        time_per_level: rules.fall_time,
    }
}

/// Сколько времени прошло с начала падения с уровня `from` на уровень `to`
/// до высоты `z` — обратная к `FallModel::z_at`. Нужна клиентской реплике:
/// кадр везёт авторитетные `z`/`level`, но не фазу падения, а восстанавливать
/// её обнулением нельзя — высота своего танка тогда зависела бы от длины
/// реплея, а не от времени падения.
pub fn fall_elapsed(z: f32, from: u8, to: u8, rules: &LevelRules) -> f32 {
    let fall = fall_model(rules);

    if from <= to {
        return fall.duration((from as f32 - to as f32).abs());
    }

    fall.elapsed_at(from as f32, to as f32, z)
}

/// Шаг правил уровня для точки `(x, y)`. Вызывается ДО применения ввода и
/// ДО шага физики — так маска коллизий уже верна для наступающего шага.
pub fn step_level(
    state: &mut LevelState,
    x: f32,
    y: f32,
    levels: &MapLevels,
    rules: &LevelRules,
    dt: f32,
) -> LevelEvent {
    // одноуровневая карта: уровня как понятия нет
    if !levels.is_layered() {
        *state = LevelState::default();

        return LevelEvent::None;
    }

    let cell = cell_of(levels, x, y);
    let event = step_layered(state, x, y, cell, levels, rules, dt);

    // клетка пишется ВСЕГДА, а не только на рампе: иначе после проезда по
    // плите значение протухло бы, и гейт судил бы вход по древней клетке
    state.prev_cell = cell;

    event
}

// шаг на многоуровневой карте; `prev_cell` обновляет вызывающий
fn step_layered(
    state: &mut LevelState,
    x: f32,
    y: f32,
    cell: (i32, i32),
    levels: &MapLevels,
    rules: &LevelRules,
    dt: f32,
) -> LevelEvent {
    if let Transit::Falling { elapsed, from, to } = state.transit {
        let fall = fall_model(rules);
        let elapsed = elapsed + dt;

        state.slope_vec = [0.0, 0.0];
        state.z = fall.z_at(from as f32, to as f32, elapsed);

        if elapsed >= fall.duration(from as f32 - to as f32) {
            state.level = to;
            state.z = to as f32;
            state.transit = Transit::Grounded;

            return LevelEvent::Landed { height: from - to };
        }

        state.transit = Transit::Falling { elapsed, from, to };

        return LevelEvent::None;
    }

    if let Some(ramp) = levels.ramp_at(x, y) {
        let (low, high) = if ramp.from < ramp.to {
            (ramp.from, ramp.to)
        } else {
            (ramp.to, ramp.from)
        };

        // гейт решается ОДИН раз, при входе на прогон: уровень танка по
        // дороге меняется, и пересчёт на каждом шаге отменял бы подъём на
        // его середине
        let climbing = match state.transit {
            Transit::Ramp { climbing, .. } => climbing,
            _ => entry_is_legal(state, &ramp, cell, levels),
        };

        state.transit = Transit::Ramp {
            climbing,
            low,
            high,
        };

        // заехавшему сбоку прогон работает как обычная плоская клетка его
        // уровня — до тех пор, пока он с прогона не сойдёт
        if !climbing {
            state.slope_vec = [0.0, 0.0];
            state.z = state.level as f32;

            return LevelEvent::None;
        }

        state.slope_vec = [ramp.dir[0] * ramp.slope, ramp.dir[1] * ramp.slope];
        state.z = lerp(ramp.from as f32, ramp.to as f32, ramp.progress);
        // уровень щёлкает по ближайшему целому, а не по порогу «выше
        // половины»: на прогоне 0 → 2 порог отдал бы уровень 2 уже на первой
        // трети. Коллизии на рампе всё равно всех уровней прогона, поэтому
        // щелчок не создаёт ни проваливания, ни толчка
        state.level = state.z.round().clamp(low as f32, high as f32) as u8;

        return LevelEvent::None;
    }

    state.transit = Transit::Grounded;
    state.slope_vec = [0.0, 0.0];

    if state.level >= 1 && !levels.has_floor(state.level, x, y) {
        state.transit = Transit::Falling {
            elapsed: 0.0,
            from: state.level,
            // приземление — не всегда земля: под обрывом может лежать плита
            // нижнего уровня
            to: levels.landing_level(state.level, x, y),
        };
        state.z = state.level as f32;

        return LevelEvent::None;
    }

    state.z = state.level as f32;

    LevelEvent::None
}

// клетка точки; `(-1, -1)` вне карты
fn cell_of(levels: &MapLevels, x: f32, y: f32) -> (i32, i32) {
    levels
        .cell_at(x, y)
        .map_or((-1, -1), |(cx, cy)| (cx as i32, cy as i32))
}

// индекс прогона рампы в клетке (по центру клетки), None — не рампа
fn run_at_cell(levels: &MapLevels, cell: (i32, i32)) -> Option<u16> {
    if cell.0 < 0 || cell.1 < 0 {
        return None;
    }

    let size = levels.tile_size();
    let x = (cell.0 as f32 + 0.5) * size;
    let y = (cell.1 as f32 + 0.5) * size;

    levels.ramp_at(x, y).map(|sample| sample.run)
}

// Законен ли заход на прогон: бок и торцы прогона открыты (в клетку у
// вершины на `overpass` можно въехать прямо с земли), и без гейта это
// бесплатный подъём мимо самой рампы. Переход даёт только заход с торца,
// отвечающего своему уровню: снизу — подъём, сверху — спуск.
fn entry_is_legal(
    state: &LevelState,
    ramp: &RampSample,
    cell: (i32, i32),
    levels: &MapLevels,
) -> bool {
    let prev = state.prev_cell;

    let (low, high) = if ramp.from < ramp.to {
        (ramp.from, ramp.to)
    } else {
        (ramp.to, ramp.from)
    };

    // клетка неизвестна (спавн прямо на прогоне, первый шаг): судить не по
    // чему, поэтому работает правило первой итерации — половина прогона.
    // Заехать так сбоку нельзя: в движении клетка известна всегда
    if prev.0 < 0 || prev.1 < 0 {
        return (ramp.progress >= 0.5) == (state.level == high);
    }

    // прошлая клетка внутри того же прогона — это не вход
    if run_at_cell(levels, prev) == Some(ramp.run) {
        return false;
    }

    let (dx, dy) = (cell.0 - prev.0, cell.1 - prev.1);
    let (along, across, uphill) = if ramp.axis == 0 {
        (dx, dy, ramp.dir[0])
    } else {
        (dy, dx, ramp.dir[1])
    };

    // сосед клетки входа ВДОЛЬ оси прогона: ни диагональ, ни бок
    if along.abs() != 1 || across != 0 {
        return false;
    }

    // торец обязан отвечать уровню танка: у подножия — нижний, у вершины —
    // верхний
    let expected = if along as f32 * uphill > 0.0 { low } else { high };

    state.level == expected
}

#[cfg(test)]
mod tests {
    use super::*;

    use indexmap::IndexMap;
    use vimp_engine_core::map::{MapLevelConfig, RampConfig, RampDir};

    const TILE: f32 = 10.0;
    const DT: f32 = 1.0 / 120.0;

    /// Карта 4×4: колонка x=2 — плита моста (тайл 2), клетка (1, 1) —
    /// рампа (тайл 3) уровня 0, поднимающая на восток.
    fn layered() -> MapLevels {
        let mut grid0 = vec![vec![0, 0, 0, 0]; 4];
        let mut grid1 = vec![vec![0, 0, 0, 0]; 4];

        for row in grid1.iter_mut() {
            row[2] = 2;
        }

        grid0[1][1] = 3;

        let mut levels: IndexMap<String, MapLevelConfig> = IndexMap::new();

        levels.insert(
            "1".to_string(),
            MapLevelConfig {
                map: grid1,
                floor: vec![2],
                walls: Vec::new(),
                layers: IndexMap::new(),
                volumes: IndexMap::new(),
            },
        );

        let ramps = vec![RampConfig {
            tile: 3,
            dir: RampDir::East,
            from: 0,
            to: 1,
        }];

        MapLevels::build(&grid0, &[], &levels, &ramps, TILE)
    }

    /// Карта 6×6 с тремя уровнями: рампа (тайл 3) занимает клетки (1, 1) и
    /// (2, 1) и поднимает СРАЗУ с 0 на 2; колонка x=3 — плита уровня 2,
    /// колонка x=4 — плита только уровня 1 (под ней падают с 2 на 1).
    fn tall() -> MapLevels {
        let mut grid0 = vec![vec![0; 6]; 6];
        let mut grid1 = vec![vec![0; 6]; 6];
        let mut grid2 = vec![vec![0; 6]; 6];

        grid0[1][1] = 3;
        grid0[1][2] = 3;

        for row in grid1.iter_mut() {
            row[3] = 2;
            row[4] = 2;
        }

        for row in grid2.iter_mut() {
            row[3] = 2;
        }

        let mut levels: IndexMap<String, MapLevelConfig> = IndexMap::new();

        for (key, map) in [("1", grid1), ("2", grid2)] {
            levels.insert(
                key.to_string(),
                MapLevelConfig {
                    map,
                    floor: vec![2],
                    walls: Vec::new(),
                    layers: IndexMap::new(),
                    volumes: IndexMap::new(),
                },
            );
        }

        let ramps = vec![RampConfig {
            tile: 3,
            dir: RampDir::East,
            from: 0,
            to: 2,
        }];

        MapLevels::build(&grid0, &[], &levels, &ramps, TILE)
    }

    fn flat() -> MapLevels {
        MapLevels::build(
            &vec![vec![0, 0, 0, 0]; 4],
            &[],
            &IndexMap::new(),
            &[],
            TILE,
        )
    }

    fn rules() -> LevelRules {
        LevelRules {
            fall_time: 0.35,
            fall_damage: 15.0,
            max_fall_damage: 100.0,
            climb_gravity: 220.0,
            climb_max_speed_factor: 0.55,
        }
    }

    fn grounded(level: u8) -> LevelState {
        LevelState {
            level,
            z: level as f32,
            ..LevelState::default()
        }
    }

    #[test]
    fn flat_map_keeps_level_zero() {
        let mut state = LevelState {
            level: 1,
            z: 1.0,
            transit: Transit::Ramp {
                climbing: true,
                low: 0,
                high: 1,
            },
            prev_cell: (1, 1),
            slope_vec: [0.1, 0.0],
        };

        let event = step_level(&mut state, 15.0, 15.0, &flat(), &rules(), DT);

        assert_eq!(event, LevelEvent::None);
        assert_eq!(state, LevelState::default());
    }

    #[test]
    fn ramp_raises_z_and_snaps_level_at_half() {
        let levels = layered();
        let mut state = LevelState::default();

        // подъезд к подножию прогона: клетка (0, 1), уровень 0
        step_level(&mut state, 5.0, 15.0, &levels, &rules(), DT);

        // клетка рампы — x от 10 до 20, подъём на восток
        step_level(&mut state, 12.0, 15.0, &levels, &rules(), DT);

        assert!(
            matches!(
                state.transit,
                Transit::Ramp {
                    climbing: true,
                    low: 0,
                    high: 1
                }
            ),
            "{:?}",
            state.transit
        );
        assert!((state.z - 0.2).abs() < 1e-5, "z = {}", state.z);
        assert_eq!(state.level, 0);

        step_level(&mut state, 17.0, 15.0, &levels, &rules(), DT);

        assert!((state.z - 0.7).abs() < 1e-5, "z = {}", state.z);
        assert_eq!(state.level, 1);
    }

    #[test]
    fn ramp_entered_from_the_side_does_not_lift() {
        let levels = layered();
        let mut state = LevelState::default();

        // клетка рампы у вершины (progress 0.7) достижима с земли сбоку
        step_level(&mut state, 17.0, 15.0, &levels, &rules(), DT);

        assert_eq!(state.level, 0);
        assert_eq!(state.z, 0.0);

        // гейт держится и когда танк доехал по прогону до его подножия
        step_level(&mut state, 12.0, 15.0, &levels, &rules(), DT);

        assert_eq!(state.level, 0);
        assert_eq!(state.z, 0.0);

        // сойдя с рампы, танк снова может зайти на неё снизу
        step_level(&mut state, 5.0, 15.0, &levels, &rules(), DT);
        step_level(&mut state, 12.0, 15.0, &levels, &rules(), DT);

        assert!((state.z - 0.2).abs() < 1e-5, "z = {}", state.z);
    }

    #[test]
    fn ramp_is_not_entered_from_the_side() {
        let levels = layered();
        let mut state = LevelState::default();

        // клетка (1, 0) — соседняя ПОПЕРЁК оси прогона
        step_level(&mut state, 15.0, 5.0, &levels, &rules(), DT);
        step_level(&mut state, 15.0, 15.0, &levels, &rules(), DT);

        assert!(
            matches!(state.transit, Transit::Ramp { climbing: false, .. }),
            "{:?}",
            state.transit
        );
        assert_eq!(state.level, 0);
        assert_eq!(state.z, 0.0);
        assert_eq!(state.slope_vec, [0.0, 0.0]);
    }

    #[test]
    fn ramp_is_not_entered_from_under_the_bridge() {
        let levels = layered();
        let mut state = LevelState::default();

        // клетка (2, 1) — проезд уровня 0 ПОД плитой, упирающийся в верхний
        // торец прогона
        step_level(&mut state, 25.0, 15.0, &levels, &rules(), DT);
        step_level(&mut state, 17.0, 15.0, &levels, &rules(), DT);

        assert!(
            matches!(state.transit, Transit::Ramp { climbing: false, .. }),
            "{:?}",
            state.transit
        );
        assert_eq!(state.level, 0);
        assert_eq!(state.z, 0.0);
    }

    #[test]
    fn ramp_is_not_entered_diagonally() {
        let levels = layered();
        let mut state = LevelState::default();

        // клетка (0, 0) — диагональный сосед клетки входа
        step_level(&mut state, 5.0, 5.0, &levels, &rules(), DT);
        step_level(&mut state, 12.0, 15.0, &levels, &rules(), DT);

        assert!(
            matches!(state.transit, Transit::Ramp { climbing: false, .. }),
            "{:?}",
            state.transit
        );
        assert_eq!(state.level, 0);
        assert_eq!(state.z, 0.0);
    }

    #[test]
    fn ramp_entered_from_the_top_lowers_the_tank() {
        let levels = layered();
        let mut state = grounded(1);

        // спуск: танк уровня 1 приезжает по плите и заходит на прогон с его
        // верхнего торца
        step_level(&mut state, 25.0, 15.0, &levels, &rules(), DT);
        step_level(&mut state, 17.0, 15.0, &levels, &rules(), DT);

        assert_eq!(state.level, 1);
        assert!((state.z - 0.7).abs() < 1e-5, "z = {}", state.z);

        step_level(&mut state, 12.0, 15.0, &levels, &rules(), DT);

        assert_eq!(state.level, 0);
        assert!((state.z - 0.2).abs() < 1e-5, "z = {}", state.z);
    }

    #[test]
    fn ramp_sets_both_level_masks() {
        let levels = layered();
        let mut state = LevelState::default();

        step_level(&mut state, 5.0, 15.0, &levels, &rules(), DT);
        step_level(&mut state, 12.0, 15.0, &levels, &rules(), DT);

        let mask = state.collision_mask();

        assert!(mask.contains(level_group(0)));
        assert!(mask.contains(level_group(1)));
    }

    #[test]
    fn tall_ramp_climbs_two_levels_at_once() {
        let levels = tall();
        let mut state = LevelState::default();

        // подножие прогона — клетка (1, 1), вершина — (2, 1)
        step_level(&mut state, 5.0, 15.0, &levels, &rules(), DT);
        step_level(&mut state, 12.0, 15.0, &levels, &rules(), DT);

        assert!((state.z - 0.2).abs() < 1e-5, "z = {}", state.z);
        assert_eq!(state.level, 0);

        // уклон: два уровня на 20 мировых единиц
        assert!((state.slope_vec[0] - 0.1).abs() < 1e-6, "{:?}", state.slope_vec);
        assert_eq!(state.slope_vec[1], 0.0);

        // маска прогона 0 → 2 обязана нести все три уровня
        let mask = state.collision_mask();

        assert!(mask.contains(level_group(0)));
        assert!(mask.contains(level_group(1)));
        assert!(mask.contains(level_group(2)));

        step_level(&mut state, 22.0, 15.0, &levels, &rules(), DT);

        assert!((state.z - 1.2).abs() < 1e-5, "z = {}", state.z);
        assert_eq!(state.level, 1);

        step_level(&mut state, 29.0, 15.0, &levels, &rules(), DT);

        assert!((state.z - 1.9).abs() < 1e-5, "z = {}", state.z);
        assert_eq!(state.level, 2);
    }

    #[test]
    fn falling_lands_on_the_slab_below() {
        let levels = tall();
        let rules = rules();
        let mut state = grounded(2);

        // колонка x=4 несёт пол только уровня 1
        step_level(&mut state, 45.0, 15.0, &levels, &rules, DT);

        assert!(
            matches!(state.transit, Transit::Falling { from: 2, to: 1, .. }),
            "{:?}",
            state.transit
        );

        let mut event = LevelEvent::None;

        for _ in 0..1000 {
            event = step_level(&mut state, 45.0, 15.0, &levels, &rules, DT);

            if event != LevelEvent::None {
                break;
            }
        }

        assert_eq!(event, LevelEvent::Landed { height: 1 });
        assert_eq!(state.level, 1);
        assert_eq!(state.z, 1.0);
        assert_eq!(state.transit, Transit::Grounded);
    }

    #[test]
    fn fall_duration_grows_with_height() {
        let levels = tall();
        let rules = rules();

        // с уровня 2 на землю (колонка x=5 без плит) и с уровня 1 на землю
        let mut deep = grounded(2);
        let mut shallow = grounded(1);

        step_level(&mut deep, 55.0, 15.0, &levels, &rules, DT);
        step_level(&mut shallow, 55.0, 15.0, &levels, &rules, DT);

        let steps = |state: &mut LevelState| {
            let mut count = 0;

            while step_level(state, 55.0, 15.0, &levels, &rules, DT) == LevelEvent::None {
                count += 1;

                assert!(count < 1000, "падение обязано завершиться");
            }

            count
        };

        let shallow_steps = steps(&mut shallow);
        let deep_steps = steps(&mut deep);

        assert!(
            deep_steps > shallow_steps,
            "падение с 2 ({deep_steps}) обязано быть дольше падения с 1 ({shallow_steps})"
        );
        assert_eq!(deep.level, 0);
        assert_eq!(shallow.level, 0);
    }

    #[test]
    fn landed_carries_the_fall_height() {
        let levels = tall();
        let rules = rules();
        let mut state = grounded(2);

        step_level(&mut state, 55.0, 15.0, &levels, &rules, DT);

        let mut event = LevelEvent::None;

        for _ in 0..1000 {
            event = step_level(&mut state, 55.0, 15.0, &levels, &rules, DT);

            if event != LevelEvent::None {
                break;
            }
        }

        assert_eq!(event, LevelEvent::Landed { height: 2 });
    }

    #[test]
    fn slab_keeps_the_tank_grounded() {
        let levels = layered();
        let mut state = grounded(1);

        // колонка x=2 — плита
        let event = step_level(&mut state, 25.0, 25.0, &levels, &rules(), DT);

        assert_eq!(event, LevelEvent::None);
        assert_eq!(state.transit, Transit::Grounded);
        assert_eq!(state.level, 1);
        assert_eq!(state.z, 1.0);
    }

    #[test]
    fn leaving_slab_starts_falling() {
        let levels = layered();
        let mut state = grounded(1);

        // колонка x=3 — плиты нет
        step_level(&mut state, 35.0, 25.0, &levels, &rules(), DT);

        assert!(matches!(
            state.transit,
            Transit::Falling { from: 1, to: 0, .. }
        ));
        // стены остаются, тела — нет
        let mask = state.collision_mask();

        assert_eq!(mask, STATIC_LEVEL_GROUP);
        assert!(!mask.intersects(level_group(0)));
        assert!(!mask.intersects(level_group(1)));
        assert!(state.input_locked());
    }

    #[test]
    fn fall_elapsed_is_the_inverse_of_the_falling_lerp() {
        let rules = rules();

        assert_eq!(fall_elapsed(1.0, 1, 0, &rules), 0.0);
        assert!((fall_elapsed(0.5, 1, 0, &rules) - rules.fall_time * 0.5).abs() < 1e-6);
        assert_eq!(fall_elapsed(0.0, 1, 0, &rules), rules.fall_time);
        // высота вне диапазона (кадр старой карты) не даёт отрицательной фазы
        assert_eq!(fall_elapsed(2.0, 1, 0, &rules), 0.0);
        assert_eq!(fall_elapsed(0.5, 0, 0, &rules), 0.0);
        // падение на нижнюю плиту короче падения до земли
        assert!((fall_elapsed(1.5, 2, 1, &rules) - rules.fall_time * 0.5).abs() < 1e-6);
        assert!((fall_elapsed(1.0, 2, 0, &rules) - rules.fall_time).abs() < 1e-6);
    }

    #[test]
    fn falling_lands_after_fall_time() {
        let levels = layered();
        let rules = rules();
        let mut state = grounded(1);

        step_level(&mut state, 35.0, 25.0, &levels, &rules, DT);

        let mut landed = false;

        for _ in 0..1000 {
            if step_level(&mut state, 35.0, 25.0, &levels, &rules, DT)
                == (LevelEvent::Landed { height: 1 })
            {
                landed = true;
                break;
            }

            assert!(state.input_locked());
        }

        assert!(landed, "танк обязан приземлиться за fallTime");
        assert_eq!(state.level, 0);
        assert_eq!(state.z, 0.0);
        assert_eq!(state.transit, Transit::Grounded);
    }

    #[test]
    fn prev_cell_is_written_every_step() {
        let levels = layered();
        let mut state = LevelState::default();

        step_level(&mut state, 25.0, 25.0, &levels, &rules(), DT);

        assert_eq!(state.prev_cell, (2, 2));

        // точка вне карты снова делает клетку неизвестной
        step_level(&mut state, -5.0, 25.0, &levels, &rules(), DT);

        assert_eq!(state.prev_cell, (-1, -1));
    }

    #[test]
    fn grade_is_zero_off_the_ramp() {
        let levels = layered();
        let mut state = LevelState::default();

        step_level(&mut state, 25.0, 25.0, &levels, &rules(), DT);

        assert_eq!(state.grade(1.0, 0.0), 0.0);
    }

    #[test]
    fn grade_follows_the_heading() {
        let levels = layered();
        let mut state = LevelState::default();

        step_level(&mut state, 5.0, 15.0, &levels, &rules(), DT);
        step_level(&mut state, 12.0, 15.0, &levels, &rules(), DT);

        // курс в горку — уклон положительный, назад — отрицательный
        assert!(state.grade(1.0, 0.0) > 0.0);
        assert!(state.grade(-1.0, 0.0) < 0.0);
        // поперёк прогона уклона нет
        assert_eq!(state.grade(0.0, 1.0), 0.0);
    }
}
