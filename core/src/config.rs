//! Игровая половина конфигурации (движковая — `vimp_engine_core::config`):
//! модели/оружие/клавиши/панель. Корневой init-JSON, который собирает JS,
//! имеет форму `{engine: {...}, game: {...}}` (PLAN.md §3.4) — `engine`
//! парсится как `vimp_engine_core::config::EngineConfig`, `game` — как
//! `TanksConfig`/`TanksClientConfig` ниже.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyConfig {
    pub key: u32,
    /// 0 — удерживаемая, 1 — одноразовая (one-shot) клавиша.
    #[serde(default, rename = "type")]
    pub kind: u8,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelValue {
    pub value: f64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Damping {
    pub linear: f32,
    pub angular: f32,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fixture {
    pub density: f32,
    pub friction: f32,
    pub restitution: f32,
}

/// Параметры модели танка (src/data/models.js, поле constructor игнорируется).
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConfig {
    pub current_weapon: String,
    pub size: f32,
    pub acceleration_factor: f32,
    pub braking_factor: f32,
    pub max_forward_speed: f32,
    pub max_reverse_speed: f32,
    pub base_turn_torque_factor: f32,
    pub damping: Damping,
    pub fixture: Fixture,
    pub lateral_grip: f32,
    pub turn_speed_threshold: f32,
    pub base_turn_factor_ratio: f32,
    pub reverse_turn_multiplier: f32,
    pub throttle_increase_rate: f32,
    pub throttle_decrease_rate: f32,
    pub strain_factor: f32,
    pub max_gun_angle: f32,
    pub gun_rotation_speed: f32,
    pub gun_center_speed: f32,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraShake {
    pub intensity: f64,
    pub duration: f64,
}

/// Тип оружия — определяет серверную механику выстрела.
#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WeaponKind {
    Hitscan,
    Explosive,
}

/// Параметры оружия (src/data/weapons.js, поле constructor игнорируется).
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeaponConfig {
    #[serde(rename = "type")]
    pub kind: WeaponKind,
    #[serde(default)]
    pub impulse_magnitude: f32,
    #[serde(default)]
    pub damage: f64,
    /// Дальность hitscan-луча (юниты).
    #[serde(default)]
    pub range: Option<f32>,
    /// Кулдаун между выстрелами (секунды).
    #[serde(default)]
    pub fire_rate: f32,
    /// Разброс в радианах.
    #[serde(default)]
    pub spread: f32,
    /// Расход патронов за выстрел (по умолчанию 1).
    #[serde(default)]
    pub consumption: Option<f64>,
    #[serde(default)]
    pub camera_shake: Option<CameraShake>,
    /// Время жизни снаряда (ms, explosive).
    #[serde(default)]
    pub time: f32,
    /// Id эффекта детонации (например 'w2e').
    #[serde(default)]
    pub shot_outcome_id: Option<String>,
    /// Размер снаряда (сторона квадрата).
    #[serde(default)]
    pub size: f32,
    /// Радиус взрыва.
    #[serde(default)]
    pub radius: f32,
}

/// Правила 2.5D-уровней (game.js coreParams.levels). Одноуровневая карта
/// их не использует, поэтому все поля имеют умолчания: игра, забывшая
/// секцию, не падает — она просто не платит за падение.
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelRules {
    /// Длительность падения на ОДИН уровень высоты (секунды): падение с
    /// уровня 2 на землю вдвое дольше падения с уровня 1.
    #[serde(default = "default_fall_time")]
    pub fall_time: f32,
    /// Урон при приземлении за ОДИН уровень высоты (0 — падение бесплатно).
    #[serde(default)]
    pub fall_damage: f64,
    /// Потолок урона падения: с высокой башни танк не обязан умирать всегда.
    #[serde(default = "default_max_fall_damage")]
    pub max_fall_damage: f64,
    /// Мировых единиц/с² на единицу продольного уклона: постоянное
    /// торможение в горку и разгон под горку.
    #[serde(default)]
    pub climb_gravity: f32,
    /// На сколько уклон 1.0 срезает потолок скорости (доля, `[0, 1)`).
    #[serde(default)]
    pub climb_max_speed_factor: f32,
}

impl Default for LevelRules {
    fn default() -> Self {
        Self {
            fall_time: default_fall_time(),
            fall_damage: 0.0,
            max_fall_damage: default_max_fall_damage(),
            // умолчание 0: игра, не объявившая уклон, ездит прежними
            // формулами бит-в-бит
            climb_gravity: 0.0,
            climb_max_speed_factor: 0.0,
        }
    }
}

fn default_fall_time() -> f32 {
    0.35
}

fn default_max_fall_damage() -> f64 {
    100.0
}

/// Игровая половина init-JSON хостового ядра (`GameCore::new`) — см.
/// `vimp_engine_core::sim::GameDef::Config`.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TanksConfig {
    #[serde(default)]
    pub friendly_fire: bool,
    pub models: IndexMap<String, ModelConfig>,
    pub weapons: IndexMap<String, WeaponConfig>,
    pub player_keys: IndexMap<String, KeyConfig>,
    /// Стартовые значения панели: health + боезапас по оружию (game.js panel).
    pub panel: IndexMap<String, PanelValue>,
    /// Правила 2.5D-уровней (coreParams.levels); одноуровневая карта их
    /// не касается, поэтому секция необязательна.
    #[serde(default)]
    pub levels: LevelRules,
}

impl TanksConfig {
    /// Проверяет, что каждый ключ панели, кроме `health`, — это боезапас
    /// существующего оружия (`weapons`); иначе панель и `try_fire`/`cycle_weapon`
    /// молча рассинхронизируются (PLAN.md §5.9).
    pub fn validate(&self) -> Result<(), String> {
        for key in self.panel.keys() {
            if key != "health" && !self.weapons.contains_key(key) {
                return Err(format!(
                    "panel key '{key}' has no matching entry in weapons"
                ));
            }
        }

        if self.levels.fall_time <= 0.0 {
            return Err(format!(
                "levels.fallTime must be > 0, got {}",
                self.levels.fall_time
            ));
        }

        if self.levels.fall_damage < 0.0 {
            return Err(format!(
                "levels.fallDamage must be >= 0, got {}",
                self.levels.fall_damage
            ));
        }

        if self.levels.max_fall_damage < self.levels.fall_damage {
            return Err(format!(
                "levels.maxFallDamage must be >= levels.fallDamage ({}), got {}",
                self.levels.fall_damage, self.levels.max_fall_damage
            ));
        }

        if self.levels.climb_gravity < 0.0 {
            return Err(format!(
                "levels.climbGravity must be >= 0, got {}",
                self.levels.climb_gravity
            ));
        }

        if !(0.0..1.0).contains(&self.levels.climb_max_speed_factor) {
            return Err(format!(
                "levels.climbMaxSpeedFactor must be in [0, 1), got {}",
                self.levels.climb_max_speed_factor
            ));
        }

        Ok(())
    }
}

/// Корневой init-JSON `GameCore::new` (PLAN.md §3.4): движковая половина
/// (`engine`) + игровая (`game`), собирает JS-обёртка одним объектом.
#[derive(Clone, Deserialize)]
pub struct RootConfig {
    pub engine: vimp_engine_core::config::EngineConfig,
    pub game: TanksConfig,
}

/// Корневой init-JSON `ClientCore::new`.
#[derive(Clone, Deserialize)]
pub struct RootClientConfig {
    pub engine: vimp_engine_core::config::EngineClientConfig,
    pub game: TanksClientConfig,
}

/// Игровая половина init-JSON клиентского ядра (`ClientCore::new`).
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TanksClientConfig {
    pub models: IndexMap<String, ModelConfig>,
    pub weapons: IndexMap<String, WeaponConfig>,
    pub player_keys: IndexMap<String, KeyConfig>,
    /// Сид PRNG разброса локальных трассеров (не синхронизирован с хостом —
    /// авторитетный трассер приходит кадром).
    #[serde(default = "default_seed")]
    pub seed: u64,
    /// Правила 2.5D-уровней (coreParams.levels) — те же, что у хоста:
    /// реплика считает падение и рампы теми же функциями `crate::level`,
    /// и разное `fallTime` заставило бы танк мигать уровнем.
    #[serde(default)]
    pub levels: LevelRules,
}

fn default_seed() -> u64 {
    0x5644_4d49_5056_494d // произвольная константа
}

#[cfg(test)]
mod validate_tests {
    use super::*;

    fn weapon() -> WeaponConfig {
        WeaponConfig {
            kind: WeaponKind::Hitscan,
            impulse_magnitude: 0.0,
            damage: 0.0,
            range: None,
            fire_rate: 0.0,
            spread: 0.0,
            consumption: None,
            camera_shake: None,
            time: 0.0,
            shot_outcome_id: None,
            size: 0.0,
            radius: 0.0,
        }
    }

    fn config_with_panel_keys(keys: &[&str]) -> TanksConfig {
        let mut weapons = IndexMap::new();
        weapons.insert("w1".to_string(), weapon());
        weapons.insert("w2".to_string(), weapon());

        let mut panel = IndexMap::new();
        for key in keys {
            panel.insert((*key).to_string(), PanelValue { value: 0.0 });
        }

        TanksConfig {
            friendly_fire: false,
            models: IndexMap::new(),
            weapons,
            player_keys: IndexMap::new(),
            panel,
            levels: LevelRules::default(),
        }
    }

    #[test]
    fn panel_matching_weapons_and_health_passes() {
        assert!(config_with_panel_keys(&["health", "w1", "w2"])
            .validate()
            .is_ok());
    }

    #[test]
    fn panel_key_without_weapon_fails() {
        let err = config_with_panel_keys(&["health", "w3"])
            .validate()
            .unwrap_err();

        assert!(err.contains("w3"));
    }

    #[test]
    fn level_rules_default_when_absent() {
        let json = serde_json::json!({
            "models": {},
            "weapons": {},
            "playerKeys": {},
            "panel": {}
        });
        let cfg: TanksConfig = serde_json::from_value(json).unwrap();

        assert_eq!(cfg.levels.fall_time, 0.35);
        assert_eq!(cfg.levels.fall_damage, 0.0);
        assert_eq!(cfg.levels.max_fall_damage, 100.0);
        assert_eq!(cfg.levels.climb_gravity, 0.0);
        assert_eq!(cfg.levels.climb_max_speed_factor, 0.0);
        assert!(cfg.validate().is_ok());
    }

    #[test]
    fn validate_rejects_zero_fall_time() {
        let mut cfg = config_with_panel_keys(&["health"]);

        cfg.levels.fall_time = 0.0;

        assert!(cfg.validate().unwrap_err().contains("fallTime"));
    }

    #[test]
    fn validate_rejects_negative_fall_damage() {
        let mut cfg = config_with_panel_keys(&["health"]);

        cfg.levels.fall_damage = -1.0;

        assert!(cfg.validate().unwrap_err().contains("fallDamage"));
    }

    #[test]
    fn validate_rejects_cap_below_fall_damage() {
        let mut cfg = config_with_panel_keys(&["health"]);

        cfg.levels.fall_damage = 40.0;
        cfg.levels.max_fall_damage = 20.0;

        assert!(cfg.validate().unwrap_err().contains("maxFallDamage"));
    }

    #[test]
    fn validate_rejects_negative_climb_gravity() {
        let mut cfg = config_with_panel_keys(&["health"]);

        cfg.levels.climb_gravity = -1.0;

        assert!(cfg.validate().unwrap_err().contains("climbGravity"));
    }

    #[test]
    fn validate_rejects_climb_factor_out_of_range() {
        let mut cfg = config_with_panel_keys(&["health"]);

        cfg.levels.climb_max_speed_factor = 1.0;

        assert!(cfg.validate().unwrap_err().contains("climbMaxSpeedFactor"));
    }

    #[test]
    fn weapon_index_matches_config_key_order() {
        let cfg = config_with_panel_keys(&["health", "w1", "w2"]);

        assert_eq!(cfg.weapons.get_index_of("w1"), Some(0));
        assert_eq!(cfg.weapons.get_index_of("w2"), Some(1));
    }
}
