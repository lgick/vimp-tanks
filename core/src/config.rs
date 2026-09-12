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

/// Тряска камеры на приземлении (`coreParams.levels.landingShake`). Порог
/// `min_impact` и шкала `full_impact` численно повторяют блок `landing` из
/// `src/config/render.js` (просадка корпуса, пыль и звук на клиенте):
/// общего источника у клиентского рендера и WASM нет, поэтому значения
/// обязаны меняться парой — иначе камера тряхнётся без пыли или наоборот.
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LandingShake {
    /// Интенсивность при полном ударе (те же единицы, что у оружия).
    pub intensity: f64,
    /// Длительность тряски, мс.
    pub duration: f64,
    /// |vz| касания (уровней/с), ниже которого приземление мягкое и
    /// тряски нет вовсе.
    pub min_impact: f32,
    /// |vz| касания, дающий полную интенсивность.
    pub full_impact: f32,
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
    /// Сколько кадров подряд кадр обязан держать уровень ВЫШЕ реплики,
    /// чтобы она приняла подъём (`client::predictor`). Понижение уровня
    /// принимается сразу — запоздавший кадр врёт только вверх, — поэтому
    /// подъём нужно отличать от запаздывания: буфер интерполяции меряется
    /// десятками миллисекунд, а восемь кадров при ~20 кадрах/с — это около
    /// 0.4 с, заведомо больше буфера и незаметно как «мигание».
    #[serde(default = "default_level_adopt_frames")]
    pub level_adopt_frames: u8,
    /// Насколько высота прогона в точке входа может отстоять от высоты
    /// тела при заходе на горку сбоку или наискось (в уровнях). Заход в
    /// лоб начинается у самого торца, а вход поперёк оси попадает в любую
    /// точку клетки: без потолка крутая горка подкидывала бы танк на целый
    /// уровень. Граница ИСКЛЮЧАЮЩАЯ — скачок ровно на пол-уровня уже
    /// незаконен: на прогоне длиной в одну клетку (бортов у него нет) он
    /// давал видимый щелчок корпуса и тени.
    #[serde(default = "default_max_side_entry_rise")]
    pub max_side_entry_rise: f32,
    /// Множитель вертикальной скорости на вылете с верхнего торца рампы.
    /// 0.0 — прыжка нет вовсе (прежнее поведение), 1.0 — вся вертикальная
    /// составляющая скорости на уклоне уходит в полёт.
    #[serde(default = "default_ramp_launch_factor")]
    pub ramp_launch_factor: f32,
    /// Минимальная вертикальная скорость (уровней/с) на вылете, ниже
    /// которой прыжок не начинается: иначе съезд по рампе шагом рождал бы
    /// микропрыжки на каждой клетке.
    #[serde(default = "default_min_launch_vz")]
    pub min_launch_vz: f32,
    /// Потолок вертикальной скорости вылета (уровней/с). Без него дуга
    /// зависит только от уклона и скорости: крутой прогон `terraces`
    /// давал 9.2 уровней/с — подскок на 2.6 уровня, перелёт периметра
    /// карты и 39 HP урона за прыжок. 0 — потолка нет (прежнее
    /// поведение).
    #[serde(default = "default_max_launch_vz")]
    pub max_launch_vz: f32,
    /// Мёртвая зона урона падения (в уровнях): высота дуги, которая
    /// ничего не стоит. Прыжок с рампы возвращает танк на ту же плиту и
    /// не обязан стоить HP, а обрыв обязан.
    #[serde(default = "default_fall_damage_free_height")]
    pub fall_damage_free_height: f32,
    /// Насколько выше уровня взлёта (в уровнях) танк перестаёт видеть
    /// стены — то есть перепрыгивает препятствия.
    #[serde(default = "default_jump_clearance")]
    pub jump_clearance: f32,
    /// Во сколько раз безразмерный уклон превращается в угол наклона
    /// корпуса. 1.0 — наклон равен арктангенсу уклона (физически честно и
    /// визуально слабо на пологих рампах).
    #[serde(default = "default_tilt_gain")]
    pub tilt_gain: f32,
    /// Наклон носа в полёте: сколько радиан на единицу вертикальной
    /// скорости (уровней/с). Нос задран на взлёте, опущен на снижении.
    #[serde(default = "default_tilt_air_gain")]
    pub tilt_air_gain: f32,
    /// Скорость возврата корпуса к целевому наклону, 1/с. Ноль — наклон
    /// мгновенный и дёрганый.
    #[serde(default = "default_tilt_response")]
    pub tilt_response: f32,
    /// Потолок наклона по модулю, рад.
    #[serde(default = "default_tilt_max")]
    pub tilt_max: f32,
    /// Тряска камеры на приземлении. `None` (блока нет в конфиге) — тряски
    /// нет, поведение бит-в-бит прежнее; то же решение, что у
    /// `WeaponConfig::camera_shake`.
    #[serde(default)]
    pub landing_shake: Option<LandingShake>,
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
            level_adopt_frames: default_level_adopt_frames(),
            max_side_entry_rise: default_max_side_entry_rise(),
            ramp_launch_factor: default_ramp_launch_factor(),
            min_launch_vz: default_min_launch_vz(),
            max_launch_vz: default_max_launch_vz(),
            fall_damage_free_height: default_fall_damage_free_height(),
            jump_clearance: default_jump_clearance(),
            tilt_gain: default_tilt_gain(),
            tilt_air_gain: default_tilt_air_gain(),
            tilt_response: default_tilt_response(),
            tilt_max: default_tilt_max(),
            landing_shake: None,
        }
    }
}

fn default_fall_time() -> f32 {
    0.35
}

fn default_max_fall_damage() -> f64 {
    100.0
}

fn default_level_adopt_frames() -> u8 {
    8
}

fn default_max_side_entry_rise() -> f32 {
    0.5
}

fn default_ramp_launch_factor() -> f32 {
    1.0
}

fn default_min_launch_vz() -> f32 {
    0.35
}

// потолок дуги: 3.5 уровней/с при g = 16.33 дают подскок 0.375 уровня —
// заметный на глаз прыжок, который не перелетает перила и не долетает до
// `jump_clearance`
fn default_max_launch_vz() -> f32 {
    3.5
}

// дуга ниже половины уровня урона не стоит: это подскок, а не падение
fn default_fall_damage_free_height() -> f32 {
    0.5
}

// выше максимальной дуги при дефолтном потолке (3.5^2 / (2 * 16.33) = 0.375):
// перелёт стен остаётся механикой, но дефолтной настройкой недостижим.
// Менять только парой с `default_max_launch_vz`/`default_fall_time`
fn default_jump_clearance() -> f32 {
    0.45
}

fn default_tilt_gain() -> f32 {
    2.0
}

fn default_tilt_air_gain() -> f32 {
    0.12
}

fn default_tilt_response() -> f32 {
    12.0
}

fn default_tilt_max() -> f32 {
    0.6
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

        if self.levels.ramp_launch_factor < 0.0 {
            return Err(format!(
                "levels.rampLaunchFactor must be >= 0, got {}",
                self.levels.ramp_launch_factor
            ));
        }

        if self.levels.min_launch_vz < 0.0 {
            return Err(format!(
                "levels.minLaunchVz must be >= 0, got {}",
                self.levels.min_launch_vz
            ));
        }

        if self.levels.max_launch_vz < 0.0 {
            return Err(format!(
                "levels.maxLaunchVz must be >= 0, got {}",
                self.levels.max_launch_vz
            ));
        }

        if self.levels.fall_damage_free_height < 0.0 {
            return Err(format!(
                "levels.fallDamageFreeHeight must be >= 0, got {}",
                self.levels.fall_damage_free_height
            ));
        }

        if self.levels.jump_clearance < 0.0 {
            return Err(format!(
                "levels.jumpClearance must be >= 0, got {}",
                self.levels.jump_clearance
            ));
        }

        // потолок применяется ДО порога (core/src/level.rs), поэтому потолок
        // ниже порога — это не «низкий прыжок», а выключенный прыжок, причём
        // молча. Выключается прыжок нулевым rampLaunchFactor
        if self.levels.max_launch_vz > 0.0
            && self.levels.max_launch_vz < self.levels.min_launch_vz
        {
            return Err(format!(
                "levels.maxLaunchVz ({}) must be >= minLaunchVz ({}) - a lower \
                 ceiling disables jumping entirely; use rampLaunchFactor = 0 for that",
                self.levels.max_launch_vz, self.levels.min_launch_vz
            ));
        }

        // инвариант задачи «динамика танка»: перелёт стен остаётся механикой
        // ядра, но штатным прыжком недостижим. Ломается не только задранным
        // maxLaunchVz — достаточно поднять fallTime (гравитация падает, дуга
        // растёт). Карте, которой перелёт НУЖЕН, достаточно поднять
        // jumpClearance заодно с maxLaunchVz — проверка этого не запрещает,
        // она требует, чтобы намерение было записано в конфиг явно
        if self.levels.max_launch_vz > 0.0 && self.levels.jump_clearance > 0.0 {
            let g = 2.0 / (self.levels.fall_time * self.levels.fall_time);
            let peak = (self.levels.max_launch_vz * self.levels.max_launch_vz) / (2.0 * g);

            if peak >= self.levels.jump_clearance {
                return Err(format!(
                    "levels: jump arc maxLaunchVz^2/(2g) = {peak} must be < \
                     jumpClearance ({}); g = 2/fallTime^2 = {g}",
                    self.levels.jump_clearance
                ));
            }
        }

        if self.levels.tilt_gain < 0.0 {
            return Err(format!(
                "levels.tiltGain must be >= 0, got {}",
                self.levels.tilt_gain
            ));
        }

        if self.levels.tilt_air_gain < 0.0 {
            return Err(format!(
                "levels.tiltAirGain must be >= 0, got {}",
                self.levels.tilt_air_gain
            ));
        }

        if self.levels.tilt_response < 0.0 {
            return Err(format!(
                "levels.tiltResponse must be >= 0, got {}",
                self.levels.tilt_response
            ));
        }

        if !(0.0..=1.5).contains(&self.levels.tilt_max) {
            return Err(format!(
                "levels.tiltMax must be in [0, 1.5], got {}",
                self.levels.tilt_max
            ));
        }

        if let Some(shake) = &self.levels.landing_shake {
            if shake.intensity < 0.0 {
                return Err(format!(
                    "levels.landingShake.intensity must be >= 0, got {}",
                    shake.intensity
                ));
            }

            if shake.duration <= 0.0 {
                return Err(format!(
                    "levels.landingShake.duration must be > 0, got {}",
                    shake.duration
                ));
            }

            if shake.min_impact < 0.0 {
                return Err(format!(
                    "levels.landingShake.minImpact must be >= 0, got {}",
                    shake.min_impact
                ));
            }

            // равенство порогов — не «тряски нет», а опечатка: выключается
            // тряска отсутствием блока целиком
            if shake.full_impact <= shake.min_impact {
                return Err(format!(
                    "levels.landingShake.fullImpact ({}) must be > minImpact ({})",
                    shake.full_impact, shake.min_impact
                ));
            }
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
    fn validate_rejects_negative_max_launch_vz() {
        let mut cfg = config_with_panel_keys(&["health"]);

        cfg.levels.max_launch_vz = -1.0;

        assert!(cfg.validate().unwrap_err().contains("maxLaunchVz"));
    }

    #[test]
    fn defaults_keep_a_regular_jump_below_the_clearance() {
        let cfg = config_with_panel_keys(&["health"]);

        assert!(cfg.validate().is_ok(), "{:?}", cfg.validate());
    }

    #[test]
    fn validate_rejects_an_arc_that_reaches_the_clearance() {
        let mut cfg = config_with_panel_keys(&["health"]);

        cfg.levels.jump_clearance = 0.1;

        assert!(cfg.validate().unwrap_err().contains("jumpClearance"));
    }

    // гравитацию задаёт fallTime: поднять его — значит поднять дугу, не трогая
    // ни одного «прыжкового» поля
    #[test]
    fn validate_rejects_an_arc_grown_by_a_longer_fall_time() {
        let mut cfg = config_with_panel_keys(&["health"]);

        cfg.levels.fall_time = 0.5;

        assert!(cfg.validate().unwrap_err().contains("jumpClearance"));
    }

    #[test]
    fn validate_rejects_a_ceiling_below_the_launch_threshold() {
        let mut cfg = config_with_panel_keys(&["health"]);

        cfg.levels.max_launch_vz = 0.2;
        cfg.levels.min_launch_vz = 0.35;

        assert!(cfg.validate().unwrap_err().contains("maxLaunchVz"));
    }

    #[test]
    fn a_zero_ceiling_skips_the_arc_invariant() {
        let mut cfg = config_with_panel_keys(&["health"]);

        // 0 — потолка нет, дуга не ограничена: проверять нечего
        cfg.levels.max_launch_vz = 0.0;

        assert!(cfg.validate().is_ok());
    }

    #[test]
    fn validate_rejects_negative_fall_damage_free_height() {
        let mut cfg = config_with_panel_keys(&["health"]);

        cfg.levels.fall_damage_free_height = -1.0;

        assert!(cfg.validate().unwrap_err().contains("fallDamageFreeHeight"));
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

    fn shake() -> LandingShake {
        LandingShake {
            intensity: 1.0,
            duration: 120.0,
            min_impact: 2.0,
            full_impact: 6.0,
        }
    }

    #[test]
    fn validate_accepts_a_config_without_landing_shake() {
        let mut cfg = config_with_panel_keys(&["health"]);

        cfg.levels.landing_shake = None;

        assert!(cfg.validate().is_ok());
    }

    #[test]
    fn validate_rejects_negative_shake_intensity() {
        let mut cfg = config_with_panel_keys(&["health"]);

        cfg.levels.landing_shake = Some(LandingShake {
            intensity: -1.0,
            ..shake()
        });

        let err = cfg.validate().unwrap_err();

        assert!(err.contains("landingShake.intensity"));
    }

    #[test]
    fn validate_rejects_zero_shake_duration() {
        let mut cfg = config_with_panel_keys(&["health"]);

        cfg.levels.landing_shake = Some(LandingShake {
            duration: 0.0,
            ..shake()
        });

        let err = cfg.validate().unwrap_err();

        assert!(err.contains("landingShake.duration"));
    }

    #[test]
    fn validate_rejects_negative_shake_min_impact() {
        let mut cfg = config_with_panel_keys(&["health"]);

        cfg.levels.landing_shake = Some(LandingShake {
            min_impact: -0.5,
            ..shake()
        });

        let err = cfg.validate().unwrap_err();

        assert!(err.contains("landingShake.minImpact"));
    }

    // равные пороги — опечатка, а не «мягкая тряска»: `push_landing_shake`
    // на них молча выходит, и приземление перестаёт трясти камеру
    #[test]
    fn validate_rejects_shake_full_impact_equal_to_min() {
        let mut cfg = config_with_panel_keys(&["health"]);

        cfg.levels.landing_shake = Some(LandingShake {
            min_impact: 6.0,
            full_impact: 6.0,
            ..shake()
        });

        let err = cfg.validate().unwrap_err();

        assert!(err.contains("landingShake.fullImpact"));
    }

    #[test]
    fn weapon_index_matches_config_key_order() {
        let cfg = config_with_panel_keys(&["health", "w1", "w2"]);

        assert_eq!(cfg.weapons.get_index_of("w1"), Some(0));
        assert_eq!(cfg.weapons.get_index_of("w2"), Some(1));
    }
}
