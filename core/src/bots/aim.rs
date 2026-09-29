//! Прицел бота «как у человека»: время реакции, сходящаяся ошибка наведения,
//! дрожь, сбой после выстрела, очереди с паузами, лимит башни.

use std::f32::consts::TAU;

use serde::{Deserialize, Serialize};
use vimp_engine_core::rng::Rng;

use super::profile::BotProfile;

/// Постоянная спада сбоя прицела после выстрела, с.
const RECOIL_DECAY: f32 = 0.3;
/// Ствол ближе этого угла (рад) к направлению появления цели: бот «ждал из-за
/// угла», реакция быстрее.
pub(crate) const PRE_AIMED_ANGLE: f32 = 0.3;
/// Множитель реакции у «ждавшего» бота.
const PRE_AIMED_REACTION: f32 = 0.6;
/// Поперечная скорость цели (ед./с), при которой начальная ошибка максимальна.
const LATERAL_SPEED_FULL: f32 = 150.0;
/// Доля `aim_error`, которую добавляет езда на полной скорости.
const MOTION_ERROR: f32 = 0.15;
/// Ошибка на каждый рад/с угловой скорости цели.
const TRACKING_ERROR: f32 = 0.1;
/// Башня держит угол точнее этого (рад): клавиши отпущены.
const TURRET_DEADBAND: f32 = 0.03;
/// Запас до лимита башни (рад), с которого просят довернуть корпус.
const HULL_REQUEST_MARGIN: f32 = 0.1;
/// «В молоко»: цель пропала не дольше стольких секунд назад.
const PANIC_WINDOW: f32 = 0.4;

/// Состояние прицела по текущей цели. Едет в дамп вместе с мозгом.
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Aim {
    pub target: Option<u32>,
    pub acquired_at: f32,
    /// До этого момента башня не реагирует на новую цель (время реакции).
    pub react_until: f32,
    /// Начальная ошибка наведения, рад (со знаком).
    pub error0: f32,
    pub tremor_phase: f32,
    /// Частота дрожи, рад/с.
    pub tremor_freq: f32,
    /// Сбой прицела после выстрела, рад (со знаком), спадает с постоянной
    /// `RECOIL_DECAY`.
    pub recoil: f32,
    pub burst_left: u8,
    pub next_shot_at: f32,
    /// Когда цель видели последний раз.
    pub last_seen: Option<f32>,
    /// Для «стрельбы в молоко»: когда цель пропала из вида.
    pub lost_at: Option<f32>,
    /// Выстрел «в молоко» по этому исчезновению разыгран и выпал.
    pub panic: bool,
    /// Желаемый поворот корпуса, рад: цель за лимитом башни.
    pub hull_request: Option<f32>,
    /// Множитель ошибки прицела (ответный огонь на отходе). В дамп не едет:
    /// мозг ставит его каждый тик.
    #[serde(skip, default = "unit_penalty")]
    pub aim_penalty: f32,
}

fn unit_penalty() -> f32 {
    1.0
}

impl Default for Aim {
    fn default() -> Self {
        Self {
            target: None,
            acquired_at: 0.0,
            react_until: 0.0,
            error0: 0.0,
            tremor_phase: 0.0,
            tremor_freq: 0.0,
            recoil: 0.0,
            burst_left: 0,
            next_shot_at: 0.0,
            last_seen: None,
            lost_at: None,
            panic: false,
            hull_request: None,
            aim_penalty: unit_penalty(),
        }
    }
}

/// Какую клавишу башни держать.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct TurretKeys {
    pub left: bool,
    pub right: bool,
}

impl Aim {
    /// Захват цели: новая цель или снова видна после долгой невидимости.
    /// `lateral_speed` — поперечная к линии на бота скорость цели, ед./с;
    /// `pre_aimed` — ствол уже смотрит в сторону появления.
    pub(crate) fn retarget(
        &mut self,
        target: u32,
        clock: f32,
        profile: &BotProfile,
        rng: &mut Rng,
        lateral_speed: f32,
        pre_aimed: bool,
    ) {
        let mut reaction = profile.reaction_time * rng.range(0.8, 1.3);

        if pre_aimed {
            reaction *= PRE_AIMED_REACTION;
        }

        let fast = (lateral_speed / LATERAL_SPEED_FULL).min(1.0);

        self.target = Some(target);
        self.acquired_at = clock;
        self.react_until = clock + reaction;
        self.error0 = rng.range(-1.0, 1.0) * profile.aim_error * (1.0 + 0.5 * fast);
        self.tremor_phase = rng.range(0.0, TAU);
        self.tremor_freq = rng.range(1.5, 3.0) * TAU;
        self.burst_left = roll_burst(profile, rng);
        self.next_shot_at = self.react_until;
        self.lost_at = None;
        self.panic = false;
        self.hull_request = None;
    }

    pub(crate) fn reset(&mut self) {
        *self = Self::default();
    }

    /// Спад сбоя после выстрела.
    pub(crate) fn decay(&mut self, dt: f32) {
        self.recoil *= (-dt / RECOIL_DECAY).exp();
    }

    /// Учёт видимости цели. Исчезновение запоминается, и выстрел «в молоко»
    /// разыгрывается по нему один раз.
    pub(crate) fn note_sight(
        &mut self,
        visible: bool,
        clock: f32,
        profile: &BotProfile,
        rng: &mut Rng,
    ) {
        if visible {
            self.last_seen = Some(clock);
            self.lost_at = None;
            self.panic = false;
            return;
        }

        if self.lost_at.is_none() && self.last_seen.is_some() {
            self.lost_at = Some(clock);
            self.panic = rng.next_f32() < profile.panic_fire;
        }
    }

    /// Цель не видна с `acquired_at`/`last_seen` дольше `time`.
    pub(crate) fn unseen_for(&self, clock: f32, time: f32) -> bool {
        clock - self.last_seen.unwrap_or(self.acquired_at) > time
    }

    /// Текущая ошибка наведения, рад. `speed_ratio` — своя скорость вперёд
    /// в долях максимальной, `angular_speed` — угловая скорость цели
    /// относительно бота, рад/с.
    pub(crate) fn error(
        &self,
        clock: f32,
        profile: &BotProfile,
        speed_ratio: f32,
        angular_speed: f32,
    ) -> f32 {
        let settle = self.error0 * (-(clock - self.acquired_at) / profile.aim_settle_time).exp();
        let tremor = profile.aim_tremor * (self.tremor_phase + clock * self.tremor_freq).sin();
        let motion = MOTION_ERROR * profile.aim_error * speed_ratio.abs().min(1.0);
        let tracking = TRACKING_ERROR * angular_speed.abs();

        (settle + tremor + self.recoil + settle.signum() * (motion + tracking)) * self.aim_penalty
    }

    /// Клавиши башни, чтобы ствол встал на угол `rel` от оси корпуса. За
    /// лимитом башни `lim` ствол упирается в лимит, а `hull_request` просит
    /// довернуть корпус. До конца реакции башня стоит.
    pub(crate) fn turret(
        &mut self,
        rel: f32,
        gun_rotation: f32,
        lim: f32,
        clock: f32,
    ) -> TurretKeys {
        if clock < self.react_until {
            self.hull_request = None;
            return TurretKeys::default();
        }

        self.hull_request = (rel.abs() > lim - HULL_REQUEST_MARGIN).then_some(rel);

        let diff = rel.clamp(-lim, lim) - gun_rotation;

        if diff.abs() <= TURRET_DEADBAND {
            return TurretKeys::default();
        }

        TurretKeys {
            left: diff < 0.0,
            right: diff > 0.0,
        }
    }

    /// Реакция прошла, пауза очереди кончилась.
    pub(crate) fn ready(&self, clock: f32) -> bool {
        clock >= self.react_until && clock >= self.next_shot_at
    }

    /// Цель пропала только что, и выстрел «в молоко» выпал.
    pub(crate) fn panic_pending(&self, clock: f32) -> bool {
        self.panic && self.lost_at.is_some_and(|at| clock - at < PANIC_WINDOW)
    }

    /// Выстрел сделан: сбой прицела и учёт очереди.
    pub(crate) fn on_shot(&mut self, clock: f32, profile: &BotProfile, rng: &mut Rng) {
        let side = if rng.next_f32() < 0.5 { -1.0 } else { 1.0 };

        self.recoil += rng.range(0.3, 1.0) * 0.5 * profile.aim_error * side;
        self.panic = false;
        self.burst_left = self.burst_left.saturating_sub(1);

        if self.burst_left > 0 {
            self.next_shot_at = clock + profile.shot_interval * rng.range(0.9, 1.2);
        } else {
            self.burst_left = roll_burst(profile, rng);
            self.next_shot_at = clock + rng.range(profile.burst_pause[0], profile.burst_pause[1]);
        }
    }
}

/// Допуск «ствол в цели», рад: угловая полудлина цели × `fire_tolerance`.
pub(crate) fn fire_tolerance(target_half_length: f32, distance: f32, profile: &BotProfile) -> f32 {
    ((target_half_length / distance.max(1.0)).atan() * profile.fire_tolerance).max(0.01)
}

/// Выстрелов в очереди: целое из `burst_shots`, включительно.
fn roll_burst(profile: &BotProfile, rng: &mut Rng) -> u8 {
    let [lo, hi] = profile.burst_shots;
    let lo = lo.max(1);
    let hi = hi.max(lo);
    let span = f32::from(hi - lo + 1);

    (lo + (rng.next_f32() * span) as u8).min(hi)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> BotProfile {
        BotProfile {
            aim_error: 0.2,
            aim_tremor: 0.0,
            ..BotProfile::default()
        }
    }

    #[test]
    fn aim_error_settles() {
        let profile = profile();
        let mut rng = Rng::new(9);

        for _ in 0..20 {
            let mut aim = Aim::default();

            aim.retarget(2, 1.0, &profile, &mut rng, 0.0, false);

            let start = aim.error(1.0, &profile, 0.0, 0.0);
            let later = aim.error(1.0 + 3.0 * profile.aim_settle_time, &profile, 0.0, 0.0);

            assert!((start.abs() - aim.error0.abs()).abs() < 1e-6);
            assert!(later.abs() < 0.1 * aim.error0.abs() + 1e-6);
        }
    }

    #[test]
    fn pre_aimed_reacts_faster() {
        let profile = profile();
        let mut slow = Aim::default();
        let mut fast = Aim::default();

        slow.retarget(2, 0.0, &profile, &mut Rng::new(4), 0.0, false);
        fast.retarget(2, 0.0, &profile, &mut Rng::new(4), 0.0, true);

        assert!((fast.react_until - PRE_AIMED_REACTION * slow.react_until).abs() < 1e-6);
    }

    #[test]
    fn turret_waits_for_reaction_and_respects_the_limit() {
        let profile = profile();
        let mut aim = Aim::default();

        aim.retarget(2, 0.0, &profile, &mut Rng::new(1), 0.0, false);

        assert_eq!(aim.turret(2.0, 0.0, 1.4, 0.0), TurretKeys::default());
        assert!(aim.hull_request.is_none());

        let keys = aim.turret(2.0, 0.0, 1.4, aim.react_until);

        assert!(keys.right && !keys.left);
        assert_eq!(aim.hull_request, Some(2.0));

        // ствол уже в лимите: башня стоит, корпус всё ещё просят довернуть
        let keys = aim.turret(2.0, 1.4, 1.4, aim.react_until);

        assert_eq!(keys, TurretKeys::default());
        assert!(aim.hull_request.is_some());
    }

    #[test]
    fn burst_size_stays_in_range() {
        let profile = BotProfile {
            burst_shots: [2, 4],
            ..BotProfile::default()
        };
        let mut rng = Rng::new(2);
        let mut seen = [false; 5];

        for _ in 0..200 {
            let n = roll_burst(&profile, &mut rng);

            assert!((2..=4).contains(&n));
            seen[n as usize] = true;
        }

        assert!(seen[2] && seen[3] && seen[4]);
    }

    #[test]
    fn panic_fire_is_rolled_once_per_disappearance() {
        let profile = BotProfile {
            panic_fire: 1.0,
            ..BotProfile::default()
        };
        let mut rng = Rng::new(3);
        let mut aim = Aim::default();

        aim.note_sight(true, 1.0, &profile, &mut rng);
        aim.note_sight(false, 1.1, &profile, &mut rng);

        assert!(aim.panic_pending(1.2));
        assert!(!aim.panic_pending(1.6), "окно «в молоко» прошло");

        aim.on_shot(1.2, &profile, &mut rng);

        assert!(!aim.panic_pending(1.3), "один выстрел на исчезновение");
    }
}
