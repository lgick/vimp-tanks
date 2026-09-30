//! Реакция корпуса на попадание hitscan (`models.js → hitResponse`). Только
//! хост: реплика попадания не предсказывает — свой танк получает скорость
//! после попадания в авторитетном кадре, дальше предиктор считает от неё
//! тем же кодом.
//!
//! Один импульс в точке попадания сдвигает танк очень по-разному: стоящий от
//! попадания в лоб отлетает в разы дальше едущего (тяга возвращает
//! потерянную скорость), вбок — в разы меньше, чем вдоль (боковое
//! сцепление), на масле, в грязи и на удержании бустера — иначе, чем на
//! асфальте. Поэтому импульс раскладывается в осях корпуса, и каждая часть
//! подгоняется под путь эталона.

use crate::config::{HitResponse, LevelRules, ModelConfig};
use crate::level::LevelState;
use crate::motion;
use crate::surface::{self, SurfaceMix};

/// Сколько секунд после удержания бустера прогон ведёт лишний путь толчка.
/// Разница скоростей с толчком и без гаснет не медленнее демпфирования: у
/// `m1` (3/с) за 2.5 с остаётся e^−7.5 ≈ 0.06 %.
const PATH_TIME: f32 = 2.5;

/// Потолок шагов прогона: крошечный `dt` или огромный остаток бустера не
/// превращают попадание в бесконечный цикл.
const MAX_STEPS: usize = 4096;

/// Состояние корпуса в момент попадания (`Tank::hit_state`): всё, от чего
/// зависит, как `Tank::update` погасит толчок.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HitState {
    /// поверхность под гусеницами — смесь `Tank::update` без удержания
    /// бустера: его прогон накладывает сам, пока оно не истекло
    pub mix: SurfaceMix,
    /// состояние уровня: полёт и удержание бустера
    pub level_state: LevelState,
    /// уклон вдоль курса (`LevelState::grade`)
    pub grade: f32,
    /// зажатые клавиши хода
    pub forward: bool,
    pub back: bool,
    /// газ (`Tank::engine_throttle`)
    pub throttle: f32,
    /// скорость вдоль курса
    pub speed: f32,
    /// скорость ленты поверхности вдоль курса
    pub belt: f32,
}

impl HitState {
    /// Эталон без хода: стоящий танк на асфальте.
    fn standing() -> Self {
        Self {
            mix: SurfaceMix::NEUTRAL,
            level_state: LevelState::default(),
            grade: 0.0,
            forward: false,
            back: false,
            throttle: 0.0,
            speed: 0.0,
            belt: 0.0,
        }
    }

    /// Эталон на ходу: танк едет вперёд по асфальту на потолке с полным
    /// газом.
    fn cruising(model: &ModelConfig) -> Self {
        Self {
            forward: true,
            throttle: 1.0,
            speed: model.max_forward_speed,
            ..Self::standing()
        }
    }

    fn drives(&self) -> bool {
        self.forward || self.back
    }
}

/// Импульс попадания по танку в осях корпуса: `(линейный, вращения)`.
/// `impulse` — импульс попадания в мире, `lever` — плечо точки попадания от
/// центра масс, `heading` — единичный курс корпуса, `mass` — масса корпуса,
/// `dt` — шаг симуляции.
///
/// - продольная часть подбирается прогоном (`Paths`) так, чтобы лишний путь
///   был как у эталона: без клавиш хода — стоящего танка на асфальте от
///   толчка × `idle_factor`, с клавишей хода — танка, едущего вперёд по
///   асфальту на потолке, от того же толчка против хода;
/// - вбок толчок гасят боковое сцепление, демпфирование и `drag`, линейно:
///   боковая часть — `lateral_factor` × доля этого сопротивления от
///   асфальтового (`lateral_resistance`);
/// - доворот корпуса (`spin_factor`) у едущего танка уводит путь: тяга
///   ведёт его по новому курсу.
#[allow(clippy::too_many_arguments)]
pub fn hit_impulse(
    impulse: (f32, f32),
    lever: (f32, f32),
    heading: (f32, f32),
    mass: f32,
    dt: f32,
    model: &ModelConfig,
    rules: &LevelRules,
    response: &HitResponse,
    state: &HitState,
) -> ((f32, f32), f32) {
    let (fx, fy) = heading;
    let (rx, ry) = (-fy, fx);
    let along = impulse.0 * fx + impulse.1 * fy;
    let across = impulse.0 * rx + impulse.1 * ry;
    let along = along * along_factor(along / mass, dt, model, rules, response, state);
    let across = across * response.lateral_factor * lateral_resistance(model, state);
    let torque = (lever.0 * impulse.1 - lever.1 * impulse.0) * response.spin_factor;

    ((fx * along + rx * across, fy * along + ry * across), torque)
}

/// Доля сопротивления вбок от асфальтового: `(D' + G · grip + drag) / (D + G)`,
/// `D` — `damping.linear`, `G` — `lateralGrip`. `D'` — демпфирование, при
/// удержании бустера снятое (`surface::boost_damping_dv`); в полёте есть
/// только оно. На асфальте ровно 1, не меньше нуля.
fn lateral_resistance(model: &ModelConfig, state: &HitState) -> f32 {
    let damping = model.damping.linear;
    let asphalt = damping + model.lateral_grip;
    let current = if state.level_state.input_locked() {
        damping
    } else {
        let held = if state.level_state.boost_left > 0.0 { 0.0 } else { damping };

        held + model.lateral_grip * state.mix.grip + state.mix.drag
    };

    if asphalt > 0.0 {
        (current / asphalt).max(0.0)
    } else {
        1.0
    }
}

/// Множитель продольной части для толчка `push` (Δv вдоль курса): толчок того
/// же знака, чей лишний путь равен пути эталона, делённый на `push`. Не
/// нашёлся (вырожденная модель, нулевой толчок) — множитель без подгонки:
/// `idle_factor` без хода, 1 на ходу.
fn along_factor(
    push: f32,
    dt: f32,
    model: &ModelConfig,
    rules: &LevelRules,
    response: &HitResponse,
    state: &HitState,
) -> f32 {
    let plain = if state.drives() { 1.0 } else { response.idle_factor };

    if !(push != 0.0 && push.is_finite() && dt > 0.0) {
        return plain;
    }

    let target = if state.drives() {
        Paths::new(&HitState::cruising(model), dt, model, rules).of(-push.abs())
    } else {
        Paths::new(&HitState::standing(), dt, model, rules).of(push.abs() * response.idle_factor)
    };

    if !(target > 0.0 && target.is_finite()) {
        return plain;
    }

    Paths::new(state, dt, model, rules)
        .solve(push, target)
        .map_or(plain, |fitted| fitted / push)
}

/// Лишний путь толчка вдоль курса для одного состояния: заезд без толчка
/// считается один раз, заезды с толчком сравниваются с ним.
struct Paths<'a> {
    state: &'a HitState,
    model: &'a ModelConfig,
    rules: &'a LevelRules,
    dt: f32,
    /// скорости заезда без толчка по шагам
    free: Vec<f32>,
}

impl<'a> Paths<'a> {
    fn new(state: &'a HitState, dt: f32, model: &'a ModelConfig, rules: &'a LevelRules) -> Self {
        let time = PATH_TIME + state.level_state.boost_left.max(0.0);
        let steps = ((time / dt).ceil() as usize).min(MAX_STEPS);
        let mut paths = Self {
            state,
            model,
            rules,
            dt,
            free: Vec::with_capacity(steps),
        };
        let mut free = Vec::with_capacity(steps);

        paths.ride(state.speed, steps, |_, v| free.push(v));
        paths.free = free;
        paths
    }

    /// Лишний путь в сторону толчка `push` (Δv вдоль курса): разница с
    /// заездом без толчка. Толчок против хода, который тяга гасит, — тоже
    /// положителен: это путь, потерянный в сторону толчка.
    fn of(&self, push: f32) -> f64 {
        let mut shift = 0.0;

        self.ride(self.state.speed + push, self.free.len(), |step, v| {
            shift += f64::from(v) - f64::from(self.free[step]);
        });

        shift * f64::from(self.dt) * f64::from(push.signum())
    }

    /// Толчок знака `push`, чей лишний путь равен `target`: регула фальси
    /// (Иллинойс) на отрезке, найденном удвоением от `|push|`. Путь растёт с
    /// толчком; отрезок не нашёлся или путь не число — `None`.
    fn solve(&self, push: f32, target: f64) -> Option<f32> {
        let sign = f64::from(push.signum());
        let miss = |p: f64| self.of((sign * p) as f32) - target;
        let (mut low, mut miss_low) = (0.0, -target);
        let mut high = f64::from(push.abs());
        let mut miss_high = miss(high);

        for _ in 0..40 {
            if !miss_high.is_finite() || miss_high >= 0.0 {
                break;
            }

            (low, miss_low) = (high, miss_high);
            high *= 2.0;
            miss_high = miss(high);
        }

        if !(miss_high.is_finite() && miss_high >= 0.0) {
            return None;
        }

        // тот же конец отрезка остался дважды подряд — его промах вдвое
        // меньше (Иллинойс): иначе регула фальси ползёт к корню с одной
        // стороны
        let mut kept = 0;

        for _ in 0..40 {
            let p = (low * miss_high - high * miss_low) / (miss_high - miss_low);
            let miss_p = miss(p);

            if !miss_p.is_finite() {
                return None;
            }

            if miss_p.abs() <= 1e-4 * target {
                return Some((sign * p) as f32);
            }

            if miss_p < 0.0 {
                (low, miss_low) = (p, miss_p);

                if kept == 1 {
                    miss_high *= 0.5;
                }

                kept = 1;
            } else {
                (high, miss_high) = (p, miss_p);

                if kept == -1 {
                    miss_low *= 0.5;
                }

                kept = -1;
            }
        }

        Some((sign * 0.5 * (low + high)) as f32)
    }

    /// Заезд вдоль курса с начальной скоростью `speed`: тот же шаг, что
    /// `Tank::update` делает вдоль курса (спад и удержание бустера, газ,
    /// тяга или торможение простоя, `drag` поверхности, компенсация
    /// демпфирования), и демпфирование Rapier `v / (1 + D · dt)`.
    /// Поверхность, лента и уклон — как в момент попадания. `each` получает
    /// скорость после шага.
    fn ride(&self, speed: f32, steps: usize, mut each: impl FnMut(usize, f32)) {
        let (state, model, dt) = (self.state, self.model, self.dt);
        let damping = model.damping.linear;
        let decay = 1.0 / (1.0 + dt * damping);
        let mut level_state = state.level_state;
        let mut throttle = state.throttle;
        let mut v = speed;

        for step in 0..steps {
            surface::decay_boost(&mut level_state, dt);

            // в полёте `update` выходит рано: остаётся одно демпфирование
            if !level_state.input_locked() {
                let mix = surface::boost_hold_mix(state.mix, &level_state);
                let u = v - state.belt;

                throttle = motion::step_throttle(throttle, state.drives(), model, dt);

                let mut dv = motion::drive_accel_on(
                    throttle,
                    state.forward,
                    state.back,
                    u,
                    state.grade,
                    model,
                    self.rules,
                    &mix,
                ) * dt;

                if mix != SurfaceMix::NEUTRAL {
                    dv += motion::surface_drag_dv((u, 0.0), mix.drag, dt).0;
                }

                dv += surface::boost_damping_dv((v, 0.0), damping, &level_state, dt).0;
                v += dv;
            }

            v *= decay;
            each(step, v);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DT: f32 = 1.0 / 120.0;

    // игровая `m1` (src/data/models.js): тяга, потолки и демпфирование —
    // те, под которые калибруется отброс
    fn model() -> ModelConfig {
        serde_json::from_value(serde_json::json!({
            "currentWeapon": "w1",
            "size": 3,
            "accelerationFactor": 1000,
            "brakingFactor": 0.3,
            "maxForwardSpeed": 130,
            "maxReverseSpeed": -65,
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

    fn rules() -> LevelRules {
        LevelRules::default()
    }

    fn response() -> HitResponse {
        HitResponse {
            lateral_factor: 1.65,
            idle_factor: 0.2,
            spin_factor: 0.03,
        }
    }

    const MIX: SurfaceMix = SurfaceMix::NEUTRAL;
    // песок, грязь, масло — как в src/config/game.js
    const SAND: SurfaceMix = SurfaceMix {
        accel_l: 0.6,
        accel_r: 0.6,
        max_speed: 0.55,
        drag: 1.2,
        turn: 0.8,
        ..MIX
    };
    const MUD: SurfaceMix = SurfaceMix {
        accel_l: 0.45,
        accel_r: 0.45,
        max_speed: 0.4,
        drag: 2.0,
        grip: 0.9,
        turn: 0.7,
        ..MIX
    };
    const OIL: SurfaceMix = SurfaceMix {
        accel_l: 0.35,
        accel_r: 0.35,
        grip: 0.08,
        brake: 0.1,
        turn: 1.6,
        angular_drag: -0.5,
        ..MIX
    };

    // толчок настоящего попадания `w1`: 1750000 / масса m1 (12 × 9 × 200)
    const PUSH: f32 = 1_750_000.0 / 21_600.0;

    fn path(state: &HitState, push: f32) -> f64 {
        Paths::new(state, DT, &model(), &rules()).of(push)
    }

    fn factor(state: &HitState, push: f32) -> f32 {
        along_factor(push, DT, &model(), &rules(), &response(), state)
    }

    fn reference(state: &HitState) -> f64 {
        if state.drives() {
            path(&HitState::cruising(&model()), -PUSH)
        } else {
            path(&HitState::standing(), PUSH * response().idle_factor)
        }
    }

    // без хода система линейна: путь — Δv / (D + B) с поправкой на шаг
    #[test]
    fn a_standing_path_is_the_idle_resistance() {
        let shift = path(&HitState::standing(), 10.0);

        assert!((shift - 10.0 / 3.3).abs() < 0.05, "{shift}");
    }

    // едущий по асфальту на потолке танк от толчка против хода теряет в
    // разы меньше пути, чем стоящий, а только что тронувшийся — почти как
    // без тяги: скорость ниже потолка, газ ещё набирается
    #[test]
    fn a_path_follows_the_speed_and_the_throttle() {
        let model = model();
        let cruising = path(&HitState::cruising(&model), -PUSH);
        let starting = path(
            &HitState {
                forward: true,
                throttle: 0.05,
                ..HitState::standing()
            },
            -PUSH,
        );

        assert!(cruising < 0.2 * PUSH as f64 / 3.3, "{cruising}");
        assert!(starting > 3.0 * cruising, "{starting} против {cruising}");
    }

    // на удержании бустера демпфирование снято: без хода толчок гаснет
    // одним торможением простоя, путь в разы длиннее
    #[test]
    fn a_boost_hold_lengthens_the_path() {
        let held = HitState {
            level_state: LevelState {
                boost_left: 1.2,
                boost_factor: 3.6,
                ..LevelState::default()
            },
            ..HitState::standing()
        };

        assert!(path(&held, 10.0) > 3.0 * path(&HitState::standing(), 10.0));
    }

    // подобранный толчок даёт путь эталона при любом ходе, поверхности,
    // скорости и газе — в том числе обе клавиши и удержание бустера
    #[test]
    fn the_fitted_push_matches_the_reference_path() {
        let model = model();
        let cruise = HitState::cruising(&model);
        let reverse = HitState {
            forward: false,
            back: true,
            speed: model.max_reverse_speed,
            ..cruise
        };
        let boost = LevelState {
            boost_left: 1.2,
            boost_factor: 3.6,
            ..LevelState::default()
        };

        for state in [
            HitState::standing(),
            HitState { mix: SAND, ..HitState::standing() },
            HitState { mix: OIL, ..HitState::standing() },
            HitState { level_state: boost, speed: 300.0, ..HitState::standing() },
            cruise,
            reverse,
            HitState { forward: true, throttle: 0.05, ..HitState::standing() },
            HitState { back: true, ..cruise },
            HitState { mix: SAND, speed: 71.5, ..cruise },
            HitState { mix: MUD, speed: 52.0, ..reverse },
            HitState { mix: OIL, speed: 117.0, ..cruise },
            HitState { level_state: boost, speed: 400.0, ..cruise },
        ] {
            for push in [-PUSH, PUSH] {
                let fitted = push * factor(&state, push);
                let shift = path(&state, fitted);
                let expected = reference(&state);

                assert!(fitted * push > 0.0, "{state:?}: {fitted}");
                assert!(
                    (shift - expected).abs() <= 1e-3 * expected,
                    "{state:?}, {push}: {shift} против {expected}"
                );
            }
        }
    }

    // эталоны — без подгонки: стоящий на асфальте — ровно `idle_factor`,
    // едущий на потолке от толчка против хода — 1
    #[test]
    fn the_references_keep_their_plain_factors() {
        let model = model();

        assert!((factor(&HitState::standing(), -PUSH) - 0.2).abs() < 1e-4);
        assert!((factor(&HitState::cruising(&model), -PUSH) - 1.0).abs() < 1e-3);
    }

    #[test]
    fn a_degenerate_push_falls_back_to_the_plain_factor() {
        let model = model();

        for push in [0.0, f32::INFINITY, f32::NAN] {
            assert_eq!(factor(&HitState::standing(), push), 0.2);
            assert_eq!(factor(&HitState::cruising(&model), push), 1.0);
        }
    }

    #[test]
    fn the_side_part_follows_the_lateral_resistance() {
        let model = model();
        let airborne = LevelState {
            transit: crate::level::Transit::Airborne {
                vz: 0.0,
                from: 1,
                to: 0,
                peak: 1.0,
            },
            ..LevelState::default()
        };
        let held = LevelState {
            boost_left: 1.0,
            ..LevelState::default()
        };

        for (state, expected) in [
            (HitState::standing(), 1.0),
            (HitState { mix: MUD, ..HitState::standing() }, (3.0 + 18.0 + 2.0) / 23.0),
            (HitState { mix: OIL, ..HitState::standing() }, (3.0 + 1.6) / 23.0),
            (HitState { level_state: held, ..HitState::standing() }, 20.0 / 23.0),
            (HitState { level_state: airborne, ..HitState::standing() }, 3.0 / 23.0),
        ] {
            let resistance = lateral_resistance(&model, &state);

            assert!((resistance - expected).abs() < 1e-6, "{state:?}: {resistance}");
        }

        // отрицательное сопротивление (`drag` ниже −D − G) не тянет к стрелку
        let pulling = HitState {
            mix: SurfaceMix { drag: -30.0, ..MIX },
            ..HitState::standing()
        };

        assert_eq!(lateral_resistance(&model, &pulling), 0.0);
    }

    #[test]
    fn hit_impulse_keeps_the_hull_axes_independent() {
        let model = model();
        let response = response();
        let standing = HitState::standing();
        let mass = 21_600.0;
        let impulse = (1_750_000.0, 1_750_000.0);
        let ((x, y), _) = hit_impulse(impulse, (0.0, 0.0), (1.0, 0.0), mass, DT, &model, &rules(), &response, &standing);

        assert!((x / 1_750_000.0 - response.idle_factor).abs() < 1e-4, "{x}");
        assert_eq!(y, 1_750_000.0 * response.lateral_factor);

        // курс 90°: вдоль корпуса — мировая Y, вбок — мировая −X
        let ((x, y), _) = hit_impulse(impulse, (0.0, 0.0), (0.0, 1.0), mass, DT, &model, &rules(), &response, &standing);

        assert_eq!(x, 1_750_000.0 * response.lateral_factor);
        assert!((y / 1_750_000.0 - response.idle_factor).abs() < 1e-4, "{y}");
    }

    #[test]
    fn hit_impulse_spin_is_the_lever_cross_impulse_scaled() {
        let model = model();
        let response = response();
        let standing = HitState::standing();
        let spin = |lever: (f32, f32), response: &HitResponse| {
            hit_impulse((0.0, 1000.0), lever, (1.0, 0.0), 21_600.0, DT, &model, &rules(), response, &standing).1
        };

        assert!((spin((-4.0, 0.0), &response) + 4.0 * 1000.0 * response.spin_factor).abs() < 1e-3);
        assert_eq!(spin((-4.0, 0.0), &HitResponse { spin_factor: 0.0, ..response }), 0.0);
        // плечо вдоль импульса вращения не даёт
        assert_eq!(spin((0.0, 3.0), &response), 0.0);
    }
}
