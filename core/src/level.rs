//! Правила 2.5D-уровней: рампы, обрывы, падение. Чистые функции над
//! `MapLevels` (геометрия слоёв, крейт движка) — авторитетный путь
//! (`TanksSim::update_levels`) и клиентская реплика (`client::predictor`)
//! обязаны звать ровно их, иначе предсказание уровня разъедется с
//! авторитетным молча.

use rapier2d::prelude::Group;
use serde::{Deserialize, Serialize};
use vimp_engine_core::map::{level_group, MapLevels, STATIC_LEVEL_GROUP};
use vimp_engine_core::physics::lerp;

use crate::config::LevelRules;

/// Состояние перехода между уровнями.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Transit {
    /// Стоит на своём уровне.
    Grounded,
    /// Центр корпуса на клетке рампы: коллизии ОБОИХ уровней.
    /// `entered_at` — прогресс прогона в момент захода на него, `from_level`
    /// — уровень танка в тот же момент. Пара нужна, чтобы отличить заход с
    /// торца прогона (подъём/спуск) от заезда в него сбоку (см. `step_level`).
    Ramp { entered_at: f32, from_level: u8 },
    /// Свободное падение с обрыва: остаются только стены, ввод заблокирован.
    Falling { elapsed: f32, from: u8 },
}

/// Уровень танка/тела и его визуальная высота.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct LevelState {
    pub level: u8,
    /// 0.0 — земля, 1.0 — плита моста; дробные значения — рампа/падение.
    pub z: f32,
    pub transit: Transit,
}

impl Default for LevelState {
    fn default() -> Self {
        Self {
            level: 0,
            z: 0.0,
            transit: Transit::Grounded,
        }
    }
}

/// Что случилось на этом шаге.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LevelEvent {
    None,
    /// Танк только что коснулся земли после падения.
    Landed,
}

impl LevelState {
    /// Игнорирует ли ввод (падение).
    pub fn input_locked(&self) -> bool {
        matches!(self.transit, Transit::Falling { .. })
    }

    /// Битовая маска уровней, которые тело сейчас видит физически.
    /// `Falling` — только группа статики: падающий пролетает за `fallTime`
    /// около семи тайлов, и без стен он проходил бы сквозь здание и
    /// приземлялся внутри него; при этом ни танки, ни ящики, ни лучи, ни
    /// взрывы его не достают — они живут в группах уровней.
    pub fn collision_mask(&self) -> Group {
        match self.transit {
            Transit::Falling { .. } => STATIC_LEVEL_GROUP,
            Transit::Ramp { .. } => level_group(0) | level_group(1),
            Transit::Grounded => level_group(self.level),
        }
    }
}

/// Сколько времени прошло с начала падения с уровня `from` до высоты `z`
/// — обратная к `lerp(from, 0.0, elapsed / fall_time)` из `step_level`.
/// Нужна клиентской реплике: кадр везёт авторитетные `z`/`level`, но не
/// фазу падения, а восстанавливать её обнулением нельзя — высота своего
/// танка тогда зависела бы от длины реплея, а не от времени падения.
pub fn fall_elapsed(z: f32, from: u8, rules: &LevelRules) -> f32 {
    if from == 0 {
        return rules.fall_time;
    }

    let t = 1.0 - (z / from as f32).clamp(0.0, 1.0);

    t * rules.fall_time
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

    if let Transit::Falling { elapsed, from } = state.transit {
        let elapsed = elapsed + dt;
        let t = (elapsed / rules.fall_time).clamp(0.0, 1.0);

        state.z = lerp(from as f32, 0.0, t);

        if t >= 1.0 {
            state.level = 0;
            state.z = 0.0;
            state.transit = Transit::Grounded;

            return LevelEvent::Landed;
        }

        state.transit = Transit::Falling { elapsed, from };

        return LevelEvent::None;
    }

    if let Some(ramp) = levels.ramp_at(x, y) {
        let (low, high) = if ramp.from < ramp.to {
            (ramp.from, ramp.to)
        } else {
            (ramp.to, ramp.from)
        };

        // условия захода на прогон: `Grounded` → `Ramp` пишет их, дальше они
        // держатся до схода с рампы (уровень по дороге меняется, поэтому
        // пересчитывать гейт на каждом шаге нельзя)
        let (entered_at, from_level) = match state.transit {
            Transit::Ramp {
                entered_at,
                from_level,
            } => (entered_at, from_level),
            _ => (ramp.progress, state.level),
        };

        state.transit = Transit::Ramp {
            entered_at,
            from_level,
        };

        // бок прогона открыт: в клетку у вершины можно въехать прямо с земли,
        // и без гейта это бесплатный подъём мимо самой рампы. Переход даёт
        // только заход с торца, отвечающего своему уровню: снизу — подъём,
        // сверху — спуск. Заехавшему сбоку прогон работает как обычная
        // плоская клетка его уровня
        let from_the_top = entered_at >= 0.5;

        if from_the_top != (from_level == high) {
            state.z = state.level as f32;

            return LevelEvent::None;
        }

        state.z = lerp(ramp.from as f32, ramp.to as f32, ramp.progress);
        // уровень щёлкает на середине; коллизии на рампе всё равно обоих
        // уровней, поэтому щелчок не создаёт ни проваливания, ни толчка
        state.level = if state.z >= 0.5 { high } else { low };

        return LevelEvent::None;
    }

    state.transit = Transit::Grounded;

    if state.level >= 1 && !levels.has_floor(state.level, x, y) {
        state.transit = Transit::Falling {
            elapsed: 0.0,
            from: state.level,
        };
        state.z = state.level as f32;

        return LevelEvent::None;
    }

    state.z = state.level as f32;

    LevelEvent::None
}

#[cfg(test)]
mod tests {
    use super::*;

    use indexmap::IndexMap;
    use vimp_engine_core::map::{MapLevelConfig, RampConfig, RampDir};

    const TILE: f32 = 10.0;

    /// Карта 4×4: колонка x=2 — плита моста (тайл 2), клетка (1, 1) —
    /// рампа (тайл 3) уровня 0, поднимающая на восток.
    fn layered() -> MapLevels {
        let grid0 = vec![vec![0, 0, 0, 0]; 4];
        let mut grid1 = vec![vec![0, 0, 0, 0]; 4];

        for row in grid1.iter_mut() {
            row[2] = 2;
        }

        let mut grid0 = grid0;

        grid0[1][1] = 3;

        let mut levels: IndexMap<String, MapLevelConfig> = IndexMap::new();

        levels.insert(
            "1".to_string(),
            MapLevelConfig {
                map: grid1,
                floor: vec![2],
                walls: Vec::new(),
                layers: IndexMap::new(),
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
        }
    }

    #[test]
    fn flat_map_keeps_level_zero() {
        let mut state = LevelState {
            level: 1,
            z: 1.0,
            transit: Transit::Ramp {
                entered_at: 0.0,
                from_level: 0,
            },
        };

        let event = step_level(&mut state, 15.0, 15.0, &flat(), &rules(), 1.0 / 120.0);

        assert_eq!(event, LevelEvent::None);
        assert_eq!(state, LevelState::default());
    }

    #[test]
    fn ramp_raises_z_and_snaps_level_at_half() {
        let levels = layered();
        let mut state = LevelState::default();

        // клетка рампы — x от 10 до 20, подъём на восток
        step_level(&mut state, 12.0, 15.0, &levels, &rules(), 1.0 / 120.0);

        assert!(
            matches!(state.transit, Transit::Ramp { entered_at, from_level: 0 }
                if (entered_at - 0.2).abs() < 1e-5),
            "{:?}",
            state.transit
        );
        assert!((state.z - 0.2).abs() < 1e-5, "z = {}", state.z);
        assert_eq!(state.level, 0);

        step_level(&mut state, 17.0, 15.0, &levels, &rules(), 1.0 / 120.0);

        assert!((state.z - 0.7).abs() < 1e-5, "z = {}", state.z);
        assert_eq!(state.level, 1);
    }

    #[test]
    fn ramp_entered_from_the_side_does_not_lift() {
        let levels = layered();
        let mut state = LevelState::default();

        // клетка рампы у вершины (progress 0.7) достижима с земли сбоку
        step_level(&mut state, 17.0, 15.0, &levels, &rules(), 1.0 / 120.0);

        assert_eq!(state.level, 0);
        assert_eq!(state.z, 0.0);

        // гейт держится и когда танк доехал по прогону до его подножия
        step_level(&mut state, 12.0, 15.0, &levels, &rules(), 1.0 / 120.0);

        assert_eq!(state.level, 0);
        assert_eq!(state.z, 0.0);

        // сойдя с рампы, танк снова может зайти на неё снизу
        step_level(&mut state, 5.0, 15.0, &levels, &rules(), 1.0 / 120.0);
        step_level(&mut state, 12.0, 15.0, &levels, &rules(), 1.0 / 120.0);

        assert!((state.z - 0.2).abs() < 1e-5, "z = {}", state.z);
    }

    #[test]
    fn ramp_entered_from_the_top_lowers_the_tank() {
        let levels = layered();
        let mut state = LevelState {
            level: 1,
            z: 1.0,
            transit: Transit::Grounded,
        };

        // спуск: танк уровня 1 заходит на прогон с его верхнего торца
        step_level(&mut state, 17.0, 15.0, &levels, &rules(), 1.0 / 120.0);

        assert_eq!(state.level, 1);
        assert!((state.z - 0.7).abs() < 1e-5, "z = {}", state.z);

        step_level(&mut state, 12.0, 15.0, &levels, &rules(), 1.0 / 120.0);

        assert_eq!(state.level, 0);
        assert!((state.z - 0.2).abs() < 1e-5, "z = {}", state.z);
    }

    #[test]
    fn ramp_sets_both_level_masks() {
        let levels = layered();
        let mut state = LevelState::default();

        step_level(&mut state, 12.0, 15.0, &levels, &rules(), 1.0 / 120.0);

        let mask = state.collision_mask();

        assert!(mask.contains(level_group(0)));
        assert!(mask.contains(level_group(1)));
    }

    #[test]
    fn slab_keeps_the_tank_grounded() {
        let levels = layered();
        let mut state = LevelState {
            level: 1,
            z: 1.0,
            transit: Transit::Grounded,
        };

        // колонка x=2 — плита
        let event = step_level(&mut state, 25.0, 25.0, &levels, &rules(), 1.0 / 120.0);

        assert_eq!(event, LevelEvent::None);
        assert_eq!(state.transit, Transit::Grounded);
        assert_eq!(state.level, 1);
        assert_eq!(state.z, 1.0);
    }

    #[test]
    fn leaving_slab_starts_falling() {
        let levels = layered();
        let mut state = LevelState {
            level: 1,
            z: 1.0,
            transit: Transit::Grounded,
        };

        // колонка x=3 — плиты нет
        step_level(&mut state, 35.0, 25.0, &levels, &rules(), 1.0 / 120.0);

        assert!(matches!(state.transit, Transit::Falling { from: 1, .. }));
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

        assert_eq!(fall_elapsed(1.0, 1, &rules), 0.0);
        assert!((fall_elapsed(0.5, 1, &rules) - rules.fall_time * 0.5).abs() < 1e-6);
        assert_eq!(fall_elapsed(0.0, 1, &rules), rules.fall_time);
        // высота вне диапазона (кадр старой карты) не даёт отрицательной фазы
        assert_eq!(fall_elapsed(2.0, 1, &rules), 0.0);
        assert_eq!(fall_elapsed(0.5, 0, &rules), rules.fall_time);
    }

    #[test]
    fn falling_lands_after_fall_time() {
        let levels = layered();
        let rules = rules();
        let mut state = LevelState {
            level: 1,
            z: 1.0,
            transit: Transit::Grounded,
        };

        let dt = 1.0 / 120.0;

        step_level(&mut state, 35.0, 25.0, &levels, &rules, dt);

        let mut landed = false;

        for _ in 0..1000 {
            if step_level(&mut state, 35.0, 25.0, &levels, &rules, dt) == LevelEvent::Landed {
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
}
