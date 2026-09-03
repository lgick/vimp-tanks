//! Правила 2.5D-уровней: рампы, обрывы, падение. Чистые функции над
//! `MapLevels` (геометрия слоёв, крейт движка) — авторитетный путь
//! (`TanksSim::update_levels`) и клиентская реплика (`client::predictor`)
//! обязаны звать ровно их, иначе предсказание уровня разъедется с
//! авторитетным молча.

use rapier2d::prelude::Group;
use serde::{Deserialize, Serialize};
use vimp_engine_core::map::{level_group, MapLevels};
use vimp_engine_core::physics::lerp;

use crate::config::LevelRules;

/// Состояние перехода между уровнями.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Transit {
    /// Стоит на своём уровне.
    Grounded,
    /// Центр корпуса на клетке рампы: коллизии ОБОИХ уровней.
    Ramp,
    /// Свободное падение с обрыва: коллизий нет, ввод заблокирован.
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
    /// `Falling` — пустая маска: падающий не задевает ничего.
    pub fn collision_mask(&self) -> Group {
        match self.transit {
            Transit::Falling { .. } => Group::NONE,
            Transit::Ramp => level_group(0) | level_group(1),
            Transit::Grounded => level_group(self.level),
        }
    }
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

        state.transit = Transit::Ramp;
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
            transit: Transit::Ramp,
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

        assert_eq!(state.transit, Transit::Ramp);
        assert!((state.z - 0.2).abs() < 1e-5, "z = {}", state.z);
        assert_eq!(state.level, 0);

        step_level(&mut state, 17.0, 15.0, &levels, &rules(), 1.0 / 120.0);

        assert!((state.z - 0.7).abs() < 1e-5, "z = {}", state.z);
        assert_eq!(state.level, 1);
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
        assert_eq!(state.collision_mask(), Group::NONE);
        assert!(state.input_locked());
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
