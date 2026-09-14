//! Общие формулы движения танка — единый источник для авторитетного пути
//! (Tank::update: импульсы Rapier) и клиентской реплики предикта
//! (client::predictor: интеграция без коллизий, срез 2.6).
//!
//! Все функции mass-free: возвращают Δv/Δω/ускорение на единицу массы —
//! авторитетный путь домножает результат на массу/инерцию тела.

use crate::config::{LevelRules, ModelConfig, SurfaceRules};
use crate::surface::SurfaceMix;
use vimp_engine_core::physics::{clamp, lerp};

/// Габариты корпуса модели: ширина и высота коллайдера.
/// Одна формула на обе стороны — хост ставит `cuboid(width/2, height/2)`
/// (`Tank::new`), реплика строит по ним свой OBB.
pub fn body_size(model: &ModelConfig) -> (f32, f32) {
    (model.size * 4.0, model.size * 3.0)
}

/// Дистанция предсказания контактов корпуса. Хост отдаёт её Rapier как
/// `soft_ccd_prediction` (`Tank::new`), реплика — в `obb_vs_obb_within` /
/// `collect_block_contacts`. Число ОБЯЗАНО быть одно на обе стороны: иначе
/// стороны видят контакт на разных шагах и предсказание молча расходится с
/// сервером на касательных ударах.
pub fn contact_prediction(width: f32, height: f32) -> f32 {
    width.min(height)
}

/// Клавиши башни на тике.
#[derive(Clone, Copy)]
pub struct TurretInput {
    pub center: bool,
    pub left: bool,
    pub right: bool,
}

/// Шаг башни: центрирование либо ручной поворот.
/// Возвращает (gun_rotation, centering).
pub fn step_turret(
    gun_rotation: f32,
    centering: bool,
    input: TurretInput,
    model: &ModelConfig,
    dt: f32,
) -> (f32, bool) {
    let mut gun = gun_rotation;
    let mut centering = centering || input.center;

    if centering {
        gun = lerp(gun, 0.0, (model.gun_center_speed * dt).min(1.0));

        if gun.abs() < 0.01 {
            gun = 0.0;
            centering = false;
        }

        // ручной поворот во время центрирования отменяет центрирование
        if input.left || input.right {
            centering = false;
        }
    } else {
        let rotation_amount = model.gun_rotation_speed * dt;

        if input.left {
            gun = (gun - rotation_amount).max(-model.max_gun_angle);
        } else if input.right {
            gun = (gun + rotation_amount).min(model.max_gun_angle);
        }
    }

    (gun, centering)
}

/// Дроссель: плавный набор при газе, спад без газа.
pub fn step_throttle(throttle: f32, gas: bool, model: &ModelConfig, dt: f32) -> f32 {
    if gas {
        (throttle + model.throttle_increase_rate * dt).min(1.0)
    } else {
        (throttle - model.throttle_decrease_rate * dt).max(0.0)
    }
}

/// Δv против бокового скольжения (боковое сцепление).
pub fn lateral_dv(lateral_vel: f32, model: &ModelConfig, dt: f32) -> f32 {
    -lateral_vel * model.lateral_grip * dt
}

/// Ускорение вдоль корпуса: тяга от дросселя либо активное торможение
/// при отпущенном газе, плюс скатывающая составляющая уклона.
///
/// `grade` — продольный уклон под курсом корпуса (`LevelState::grade`):
/// положительный в горку, отрицательный под горку, 0 вне рампы. На нуле
/// формула бит-в-бит совпадает с прежней — одноуровневые карты не замечают
/// появления рамп.
pub fn drive_accel(
    throttle: f32,
    forward: bool,
    back: bool,
    forward_speed: f32,
    grade: f32,
    model: &ModelConfig,
    rules: &LevelRules,
) -> f32 {
    // в горку потолок скорости ниже: двигатель не тянет полный газ вверх.
    // `.max(0.25)` — осознанный нижний предел: уклон безразмерный, и на
    // отвесной карте (`levelHeight` много больше тайла) множитель ушёл бы
    // в ноль и ниже, то есть потолок скорости стал бы отрицательным и
    // подъём — невозможным вовсе. На демо-картах (уклон ≤ 0.5) предел не
    // достигается: он включается с уклона 1.5
    let limit = model.max_forward_speed
        * (1.0 - rules.climb_max_speed_factor * grade.max(0.0)).max(0.25);
    let mut accel = 0.0;

    if throttle > 0.0 {
        if forward && forward_speed < limit {
            accel = throttle * model.acceleration_factor;
        } else if back && forward_speed > model.max_reverse_speed {
            accel = -throttle * model.acceleration_factor;
        }
    }

    if accel == 0.0 && !forward && !back {
        accel = -forward_speed * model.braking_factor;
    }

    // скатывание: на крутом подъёме при нулевом газе результат отрицателен,
    // и танк сползает вниз — ровно то, чего ждёт игрок от горки
    accel - grade * rules.climb_gravity
}

/// `lateral_dv` на поверхности: боковое сцепление × `grip`. `lateral_rel` —
/// боковая скорость относительно «грунта» (`v − belt`). На нейтральном
/// `mix` (`grip` = 1) — бит-в-бит `lateral_dv`.
pub fn lateral_dv_on(lateral_rel: f32, model: &ModelConfig, grip: f32, dt: f32) -> f32 {
    lateral_dv(lateral_rel, model, dt) * grip
}

/// `drive_accel` на поверхности: потолок скорости × `max_speed`, тяга ×
/// среднее тяги гусениц, торможение без газа × `brake`.
/// `forward_speed_rel` — продольная скорость относительно «грунта».
/// Множители стоят последними, поэтому на нейтральном `mix` результат
/// бит-в-бит равен `drive_accel` (умножение на 1.0 — точное тождество).
#[allow(clippy::too_many_arguments)]
pub fn drive_accel_on(
    throttle: f32,
    forward: bool,
    back: bool,
    forward_speed_rel: f32,
    grade: f32,
    model: &ModelConfig,
    rules: &LevelRules,
    mix: &SurfaceMix,
) -> f32 {
    let limit = model.max_forward_speed
        * (1.0 - rules.climb_max_speed_factor * grade.max(0.0)).max(0.25)
        * mix.max_speed;
    let traction = (mix.accel_l + mix.accel_r) * 0.5;
    let mut accel = 0.0;

    if throttle > 0.0 {
        if forward && forward_speed_rel < limit {
            accel = throttle * model.acceleration_factor * traction;
        } else if back && forward_speed_rel > model.max_reverse_speed {
            accel = -throttle * model.acceleration_factor * traction;
        }
    }

    if accel == 0.0 && !forward && !back {
        accel = -forward_speed_rel * model.braking_factor * mix.brake;
    }

    accel - grade * rules.climb_gravity
}

/// Δω от разницы тяги гусениц: гусеница на вязкой поверхности тянет слабее,
/// и танк уводит в её сторону. Знак хода: вперёд `+1`, назад `−1`, без
/// клавиш хода `0`.
pub fn track_yaw_dv(
    throttle: f32,
    forward: bool,
    back: bool,
    mix: &SurfaceMix,
    model: &ModelConfig,
    rules: &SurfaceRules,
    dt: f32,
) -> f32 {
    let direction = if forward {
        1.0
    } else if back {
        -1.0
    } else {
        0.0
    };

    (mix.accel_l - mix.accel_r)
        * throttle
        * model.acceleration_factor
        * rules.track_yaw_gain
        * dt
        * direction
}

/// Δv доп. линейного сопротивления поверхности по обеим осям: тормозит
/// скорость относительно «грунта».
pub fn surface_drag_dv(v_rel: (f32, f32), drag: f32, dt: f32) -> (f32, f32) {
    (-v_rel.0 * drag * dt, -v_rel.1 * drag * dt)
}

/// Δω доп. углового сопротивления поверхности.
pub fn angular_drag_dw(angvel: f32, angular_drag: f32, dt: f32) -> f32 {
    -angvel * angular_drag * dt
}

/// Целевой наклон корпуса: продольный (`pitch`, нос вверх положителен) и
/// поперечный (`roll`, правый борт вниз положителен).
///
/// `slope_vec` — вектор уклона из `LevelState` (уровней на мировую
/// единицу, `[0,0]` вне рампы), `heading` — единичный вектор курса
/// корпуса, `vz` — вертикальная скорость (уровней/с, 0 на земле).
/// Вне рампы и вне полёта возвращает `(0.0, 0.0)`: одноуровневая карта
/// наклона не замечает.
pub fn tilt_target(
    slope_vec: [f32; 2],
    heading: (f32, f32),
    vz: f32,
    airborne: bool,
    rules: &LevelRules,
) -> (f32, f32) {
    if airborne {
        // в воздухе уклона под гусеницами нет: нос ведёт вертикальная
        // скорость, крена нет вовсе
        let pitch = clamp(vz * rules.tilt_air_gain, -rules.tilt_max, rules.tilt_max);

        return (pitch, 0.0);
    }

    // продольный уклон — вдоль курса, поперечный — вдоль левого борта
    let long = slope_vec[0] * heading.0 + slope_vec[1] * heading.1;
    let lat = -slope_vec[0] * heading.1 + slope_vec[1] * heading.0;

    let pitch = clamp(
        (long * rules.tilt_gain).atan(),
        -rules.tilt_max,
        rules.tilt_max,
    );
    let roll = clamp(
        (lat * rules.tilt_gain).atan(),
        -rules.tilt_max,
        rules.tilt_max,
    );

    (pitch, roll)
}

/// Шаг сглаживания наклона: экспоненциальный подход к цели.
/// Отдельная функция, чтобы хост и реплика гарантированно считали одно и
/// то же (обе стороны зовут её после `tilt_target`).
pub fn approach_tilt(current: f32, target: f32, rules: &LevelRules, dt: f32) -> f32 {
    lerp(current, target, (rules.tilt_response * dt).min(1.0))
}

/// Нагрузка двигателя (для звука): намерение + «напряжение».
pub fn engine_load(throttle: f32, forward_speed: f32, model: &ModelConfig) -> f32 {
    let strain = (throttle - speed_ratio(forward_speed, model)).max(0.0);

    clamp(throttle + strain * model.strain_factor, 0.0, 2.0)
}

/// Δω поворота корпуса с учётом порога скорости и заднего хода.
pub fn turn_delta(
    left: bool,
    right: bool,
    forward_speed: f32,
    model: &ModelConfig,
    dt: f32,
) -> f32 {
    let mut factor = 1.0;

    if forward_speed.abs() < model.turn_speed_threshold {
        factor = model.base_turn_factor_ratio;
    }

    if forward_speed < 0.0 {
        factor *= model.reverse_turn_multiplier;
    }

    let mut delta = 0.0;

    if left {
        delta = -model.base_turn_torque_factor * factor;
    }

    if right {
        delta = model.base_turn_torque_factor * factor;
    }

    delta * dt
}

/// Доля текущей скорости от максимальной (Tank._getSpeedRatio),
/// округление до 4 знаков (JS +speedRatio.toFixed(4)).
fn speed_ratio(forward_speed: f32, model: &ModelConfig) -> f32 {
    let ratio = if forward_speed > 0.0 {
        clamp(forward_speed / model.max_forward_speed, 0.0, 1.0)
    } else if forward_speed < 0.0 {
        clamp((forward_speed / model.max_reverse_speed).abs(), 0.0, 1.0)
    } else {
        0.0
    };

    ((ratio as f64 * 10000.0).round() / 10000.0) as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::config::LevelRules;
    use crate::level::LevelState;

    fn rules() -> LevelRules {
        LevelRules {
            fall_time: 0.35,
            fall_damage: 15.0,
            max_fall_damage: 100.0,
            climb_gravity: 500.0,
            climb_max_speed_factor: 0.5,
            level_adopt_frames: 8,
            max_side_entry_rise: 0.5,
            ramp_launch_factor: 1.0,
            min_launch_vz: 0.35,
            max_launch_vz: 0.0,
            fall_damage_free_height: 0.5,
            jump_clearance: 0.2,
            tilt_gain: 2.0,
            tilt_air_gain: 0.12,
            tilt_response: 12.0,
            tilt_max: 0.6,
            landing_shake: None,
        }
    }

    fn model() -> ModelConfig {
        serde_json::from_value(serde_json::json!({
            "currentWeapon": "w1",
            "size": 2,
            "accelerationFactor": 1000,
            "brakingFactor": 0.3,
            "maxForwardSpeed": 260,
            "maxReverseSpeed": -130,
            "baseTurnTorqueFactor": 215,
            "damping": { "linear": 3, "angular": 100.0 },
            "fixture": { "density": 200, "friction": 0.5, "restitution": 0.1 },
            "lateralGrip": 20,
            "turnSpeedThreshold": 10,
            "baseTurnFactorRatio": 0.8,
            "reverseTurnMultiplier": 0.7,
            "throttleIncreaseRate": 2.0,
            "throttleDecreaseRate": 2.5,
            "strainFactor": 1.5,
            "maxGunAngle": 1.4,
            "gunRotationSpeed": 3.0,
            "gunCenterSpeed": 10.0
        }))
        .expect("тестовая модель")
    }

    #[test]
    fn flat_ground_is_bit_for_bit_the_old_formula() {
        let model = model();
        let rules = rules();

        // тяга
        assert_eq!(
            drive_accel(1.0, true, false, 0.0, 0.0, &model, &rules),
            model.acceleration_factor
        );
        // торможение без газа
        assert_eq!(
            drive_accel(0.0, false, false, 50.0, 0.0, &model, &rules),
            -50.0 * model.braking_factor
        );
        // потолок скорости не тронут
        assert_eq!(
            drive_accel(1.0, true, false, model.max_forward_speed, 0.0, &model, &rules),
            0.0
        );
    }

    #[test]
    fn uphill_is_slower_than_flat_and_downhill_is_faster() {
        let model = model();
        let rules = rules();

        let flat = drive_accel(1.0, true, false, 100.0, 0.0, &model, &rules);
        let up = drive_accel(1.0, true, false, 100.0, 0.33, &model, &rules);
        let down = drive_accel(1.0, true, false, 100.0, -0.33, &model, &rules);

        assert!(up < flat, "в горку тяга обязана быть меньше: {up} vs {flat}");
        assert!(
            down > flat,
            "под горку тяга обязана быть больше: {down} vs {flat}"
        );
    }

    #[test]
    fn uphill_lowers_the_speed_limit() {
        let model = model();
        let rules = rules();
        // уклон 0.5 — самый крутой прогон демо-карт (`terraces.rampSteep`):
        // потолок на нём 75 % от максимума
        let speed = model.max_forward_speed * 0.8;

        assert!(drive_accel(1.0, true, false, speed, 0.5, &model, &rules) < 0.0);
        assert!(drive_accel(1.0, true, false, speed, 0.0, &model, &rules) > 0.0);
    }

    #[test]
    fn a_reachable_grade_is_climbed_at_full_throttle() {
        let model = model();
        let rules = rules();

        // достижимые уклоны демо-карт: 0.11 (`rampLong`), 0.33
        // (`overpass.rampNorth`), 0.5 (`rampSteep`). На полном газе тяга
        // обязана оставаться положительной на каждом из них
        for grade in [0.11, 0.33, 0.5] {
            assert!(
                drive_accel(1.0, true, false, 0.0, grade, &model, &rules) > 0.0,
                "уклон {grade} обязан проезжаться на полном газе"
            );
        }
    }

    #[test]
    fn zero_throttle_uphill_rolls_the_tank_back() {
        let model = model();
        let rules = rules();

        assert!(drive_accel(0.0, false, false, 0.0, 0.5, &model, &rules) < 0.0);
    }

    // курс на восток: (cos 0, sin 0)
    const EAST: (f32, f32) = (1.0, 0.0);

    #[test]
    fn flat_ground_has_no_tilt() {
        let rules = rules();

        assert_eq!(tilt_target([0.0, 0.0], EAST, 0.0, false, &rules), (0.0, 0.0));
    }

    #[test]
    fn uphill_lifts_the_nose() {
        let rules = rules();

        let up = tilt_target([0.33, 0.0], EAST, 0.0, false, &rules);
        let down = tilt_target([-0.33, 0.0], EAST, 0.0, false, &rules);

        assert!(up.0 > 0.0, "нос в горку обязан подниматься: {}", up.0);
        assert!(down.0 < 0.0, "нос под горку обязан опускаться: {}", down.0);
        assert!(up.1.abs() < 1e-6, "крена вдоль курса быть не должно");
    }

    #[test]
    fn tilt_matches_grade_at_unit_gain() {
        let mut rules = rules();

        rules.tilt_gain = 1.0;

        let state = LevelState {
            slope_vec: [0.1, 0.0],
            ..LevelState::default()
        };
        let (pitch, _) = tilt_target(state.slope_vec, EAST, 0.0, false, &rules);

        assert!((pitch - state.grade(EAST.0, EAST.1).atan()).abs() < 1e-6);
    }

    #[test]
    fn side_slope_rolls_the_hull() {
        let rules = rules();

        // уклон поперёк курса: танк едет на восток, склон падает на юг
        let (pitch, roll) = tilt_target([0.0, 0.33], EAST, 0.0, false, &rules);

        assert!(pitch.abs() < 1e-6, "продольного наклона быть не должно");
        assert!(roll.abs() > 0.1, "поперечный уклон обязан кренить корпус");
    }

    #[test]
    fn tilt_is_capped() {
        let rules = rules();

        let (pitch, roll) = tilt_target([10.0, 10.0], EAST, 0.0, false, &rules);

        assert!(pitch <= rules.tilt_max && roll <= rules.tilt_max);
        assert!((pitch - rules.tilt_max).abs() < 1e-6);
    }

    #[test]
    fn airborne_pitch_follows_vz() {
        let rules = rules();

        // уклон под гусеницами в воздухе не считается — его там нет
        let up = tilt_target([0.5, 0.0], EAST, 2.0, true, &rules);
        let down = tilt_target([0.5, 0.0], EAST, -2.0, true, &rules);

        assert!(up.0 > 0.0 && down.0 < 0.0);
        assert_eq!(up.1, 0.0);
        assert_eq!(down.1, 0.0);
    }

    #[test]
    fn approach_tilt_converges() {
        let rules = rules();
        let dt = 1.0 / 60.0;
        let mut tilt = 0.0;

        for _ in 0..100 {
            tilt = approach_tilt(tilt, 0.4, &rules, dt);
        }

        assert!((tilt - 0.4).abs() < 1e-3, "наклон обязан сойтись: {tilt}");
    }

    const DT: f32 = 1.0 / 120.0;

    fn sand() -> SurfaceMix {
        SurfaceMix {
            accel_l: 0.6,
            accel_r: 0.6,
            max_speed: 0.55,
            drag: 1.2,
            turn: 0.8,
            ..SurfaceMix::NEUTRAL
        }
    }

    #[test]
    fn neutral_mix_is_bit_for_bit_the_old_formulas() {
        let model = model();
        let rules = rules();
        let mix = SurfaceMix::NEUTRAL;

        for (throttle, forward, back, speed, grade) in [
            (1.0, true, false, 0.0, 0.0),
            (0.7, true, false, 120.5, 0.33),
            (1.0, true, false, 260.0, 0.0),
            (0.4, false, true, -50.0, -0.2),
            (0.0, false, false, 87.3, 0.0),
            (0.3, false, false, -12.0, 0.5),
            (1.0, false, true, -130.0, 0.0),
        ] {
            assert_eq!(
                drive_accel_on(throttle, forward, back, speed, grade, &model, &rules, &mix).to_bits(),
                drive_accel(throttle, forward, back, speed, grade, &model, &rules).to_bits()
            );
        }

        for lateral in [0.0, -0.0, 13.7, -250.0] {
            assert_eq!(
                lateral_dv_on(lateral, &model, mix.grip, DT).to_bits(),
                lateral_dv(lateral, &model, DT).to_bits()
            );
        }

        for (left, right, speed) in [(true, false, 100.0), (false, true, 5.0), (false, true, -40.0)] {
            assert_eq!(
                (turn_delta(left, right, speed, &model, DT) * mix.turn).to_bits(),
                turn_delta(left, right, speed, &model, DT).to_bits()
            );
        }

        assert_eq!(track_yaw_dv(1.0, true, false, &mix, &model, &SurfaceRules::default(), DT), 0.0);
        assert_eq!(surface_drag_dv((120.0, -3.0), mix.drag, DT), (0.0, 0.0));
        assert_eq!(angular_drag_dw(2.0, mix.angular_drag, DT), 0.0);
    }

    // продольная скорость на полном газе вперёд — порядок реплики: Δv шага,
    // затем затухание Rapier
    fn run_forward(mix: &SurfaceMix, seconds: f32) -> f32 {
        let model = model();
        let rules = rules();
        let mut speed = 0.0f32;
        let mut throttle = 0.0f32;

        for _ in 0..(seconds / DT) as usize {
            throttle = step_throttle(throttle, true, &model, DT);

            let accel = drive_accel_on(throttle, true, false, speed, 0.0, &model, &rules, mix);

            speed += accel * DT + surface_drag_dv((speed, 0.0), mix.drag, DT).0;
            speed *= 1.0 / (1.0 + DT * model.damping.linear);
        }

        speed
    }

    #[test]
    fn sand_caps_and_slows_the_steady_speed() {
        let model = model();
        let sand = run_forward(&sand(), 5.0);
        let asphalt = run_forward(&SurfaceMix::NEUTRAL, 5.0);

        // не «≈ потолку»: потолок лишь отсекает тягу, а равновесие тяги,
        // демпфирования и `drag` может лечь ниже него
        assert!(sand <= 0.55 * model.max_forward_speed, "песок выше потолка: {sand}");
        assert!(sand < asphalt * 0.7, "песок обязан быть заметно медленнее: {sand} vs {asphalt}");
    }

    #[test]
    fn oil_barely_damps_sideways_speed() {
        let model = model();
        let asphalt = lateral_dv(100.0, &model, DT);
        let oil = lateral_dv_on(100.0, &model, 0.08, DT);

        assert!(oil.abs() < asphalt.abs() * 0.1, "масло гасит бок: {oil} vs {asphalt}");
    }

    #[test]
    fn weaker_left_track_yaws_towards_it() {
        let model = model();
        let rules = SurfaceRules::default();
        let mud_left = SurfaceMix {
            accel_l: 0.45,
            ..SurfaceMix::NEUTRAL
        };

        // влево — отрицательная Δω, как у `turn_delta` с клавишей `left`
        assert!(turn_delta(true, false, 100.0, &model, DT) < 0.0);
        assert!(track_yaw_dv(1.0, true, false, &mud_left, &model, &rules, DT) < 0.0);
        // задним ходом сильная правая гусеница разворачивает корпус обратно
        assert!(track_yaw_dv(1.0, false, true, &mud_left, &model, &rules, DT) > 0.0);
        assert_eq!(track_yaw_dv(1.0, false, false, &mud_left, &model, &rules, DT), 0.0);
    }

    // стоящий танк курсом на восток на ленте 60 ед./с: скорость по стрелке
    // ленты на каждом шаге за `seconds`
    fn run_on_belt(belt: (f32, f32), seconds: f32) -> Vec<f32> {
        let model = model();
        let rules = rules();
        let mix = SurfaceMix {
            belt_x: belt.0,
            belt_y: belt.1,
            ..SurfaceMix::NEUTRAL
        };
        let len = (belt.0 * belt.0 + belt.1 * belt.1).sqrt();
        let (mut vx, mut vy) = (0.0f32, 0.0f32);
        let mut out = Vec::new();

        for _ in 0..(seconds / DT) as usize {
            // курс на восток: forward = (1, 0), right = (0, 1)
            let forward_rel = vx - mix.belt_x;
            let lateral_rel = vy - mix.belt_y;
            let accel = drive_accel_on(0.0, false, false, forward_rel, 0.0, &model, &rules, &mix);

            vx += accel * DT;
            vy += lateral_dv_on(lateral_rel, &model, mix.grip, DT);
            vx *= 1.0 / (1.0 + DT * model.damping.linear);
            vy *= 1.0 / (1.0 + DT * model.damping.linear);

            out.push((vx * belt.0 + vy * belt.1) / len);
        }

        out
    }

    // Равенства `belt` ждать нельзя: линейное демпфирование Rapier на хосте
    // (и `integrate` в реплике) тянет к нулю АБСОЛЮТНУЮ скорость, а не
    // скорость относительно ленты, поэтому равновесие ложится ниже `belt`.
    // Поперёк корпуса ленту передаёт боковое сцепление (`lateralGrip` 20
    // против демпфирования 3 — равновесие ≈ 0.87·belt), вдоль — только
    // торможение без газа (`brakingFactor` 0.3 — равновесие ≈ 0.09·belt)
    #[test]
    fn conveyor_carries_a_standing_tank_towards_the_belt() {
        for (belt, min_share) in [((0.0, 60.0), 0.6), ((60.0, 0.0), 0.05)] {
            let speeds = run_on_belt(belt, 3.0);

            assert!(
                speeds.windows(2).all(|pair| pair[1] >= pair[0]),
                "скорость обязана расти монотонно: {belt:?}"
            );
            assert!(speeds.iter().all(|speed| *speed <= 60.0), "не быстрее ленты: {belt:?}");
            assert!(
                *speeds.last().unwrap() >= min_share * 60.0,
                "лента {belt:?} за 3 с разогнала лишь до {}",
                speeds.last().unwrap()
            );
        }
    }
}
