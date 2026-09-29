//! Вождение бота: решение «какие клавиши», лучи объезда препятствий,
//! детектор застревания.

use std::cell::Cell;
use std::f32::consts::PI;

use rapier2d::prelude::*;
use serde::{Deserialize, Serialize};

use super::geom::{dist, normalize_angle, rotate};
use crate::tanks::BotView;
use vimp_engine_core::map::{level_group, levels_interaction_on_ramp};

/// Ниже этой скорости (ед./с) при зажатом газе бот считается стоящим.
pub(crate) const STUCK_SPEED: f32 = 6.0;
/// Сколько секунд подряд бот стоит при зажатом газе до срабатывания.
pub(crate) const STUCK_LOW_SPEED_TIME: f32 = 0.6;
/// Окно проверки смещения, с.
pub(crate) const STUCK_WINDOW: f32 = 1.0;
/// За окно с газом бот обязан сместиться хотя бы на столько, ед.
pub(crate) const STUCK_WINDOW_MIN_MOVE: f32 = 5.0;
/// Предел разворота на месте после отъезда назад, с.
pub(crate) const UNSTUCK_TURN_MAX: f32 = 0.6;
/// Манёвр выхода удался, если бот сместился больше чем на столько, ед. ...
pub(crate) const RESOLVE_MOVE: f32 = 12.0;
/// ... за столько секунд после конца манёвра.
pub(crate) const RESOLVE_TIME: f32 = 2.0;
/// Сторож: бот не сместился на `WATCHDOG_MOVE` ед. за `WATCHDOG_TIME` с.
pub(crate) const WATCHDOG_TIME: f32 = 5.0;
pub(crate) const WATCHDOG_MOVE: f32 = 8.0;
/// Окно, в котором считаются попытки выхода (эскалация), с.
pub(crate) const ATTEMPT_WINDOW: f32 = 6.0;
/// Препятствие прямо по курсу при таком медленном ходе (ед./с) ...
const BLOCKED_SPEED: f32 = 10.0;
/// ... дольше стольких секунд — тоже застревание.
const BLOCKED_TIME: f32 = 0.3;
/// Доля окна, в течение которой газ должен быть зажат.
const WINDOW_DRIVE_SHARE: f32 = 0.7;

/// Какие клавиши движения зажать.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct DriveCommand {
    pub forward: bool,
    pub back: bool,
    pub left: bool,
    pub right: bool,
}

pub(crate) struct DriveInput {
    /// Знаковый угол от оси корпуса до желаемого направления, рад:
    /// `atan2(fwd.perp_dot(dir), fwd.dot(dir))`, как в прежнем `move_to`.
    /// Знак: `> 0` — нажимать Right (соглашение прежнего кода).
    pub angle: f32,
    pub distance: f32,
    pub forward_speed: f32,
    /// Модель: `maxForwardSpeed`.
    pub max_speed: f32,
    pub allow_reverse: bool,
    /// Задний ход разрешён ближе этой дистанции.
    pub reverse_distance: f32,
    pub arrive_radius: f32,
    pub blocked_ahead: bool,
}

/// Чистое решение «какие клавиши» (без мира).
pub(crate) fn decide_drive(input: &DriveInput, prev: DriveCommand) -> DriveCommand {
    let mut cmd = DriveCommand::default();

    if input.distance <= input.arrive_radius {
        return cmd;
    }

    // цель сзади и близко: сдать назад, руля по корме
    let reverse =
        input.allow_reverse && input.angle.abs() > 2.2 && input.distance < input.reverse_distance;
    let err = if reverse {
        normalize_angle(input.angle - PI)
    } else {
        input.angle
    };

    // руль с гистерезисом: начатый поворот держится до меньшей ошибки
    let turning_same_way = (err > 0.0 && prev.right) || (err < 0.0 && prev.left);
    let threshold = if turning_same_way { 0.04 } else { 0.08 };

    if err.abs() > threshold {
        cmd.right = err > 0.0;
        cmd.left = err < 0.0;
    }

    if reverse {
        cmd.back = true;
        return cmd;
    }

    if input.blocked_ahead {
        return cmd;
    }

    let angle = input.angle.abs();

    cmd.forward = if angle < 0.35 {
        true
    } else if angle <= 1.2 {
        // притормозить перед поворотом
        input.forward_speed < 0.6 * input.max_speed
    } else {
        // разворот на месте
        false
    };

    cmd
}

/// Состояние своего танка, собранное мозгом один раз за тик.
#[derive(Clone, Copy, Debug)]
pub(crate) struct SelfState {
    pub id: u32,
    pub body: RigidBodyHandle,
    pub pos: Vector,
    pub heading: f32,
    pub forward_speed: f32,
    pub level: u8,
    pub half_length: f32,
    pub half_width: f32,
}

impl SelfState {
    pub(crate) fn read(game: &BotView<'_>, id: u32) -> Option<Self> {
        let tank = game.tanks.get(&id)?;
        let body = game.world.bodies.get(tank.body)?;
        let (half_length, half_width) = tank.half_extents();

        Some(Self {
            id,
            body: tank.body,
            pos: body.translation(),
            heading: body.rotation().angle(),
            forward_speed: game.tank_forward_speed(id),
            level: tank.level_state.level,
            half_length,
            half_width,
        })
    }

    pub(crate) fn forward(&self) -> Vector {
        Vector::new(self.heading.cos(), self.heading.sin())
    }

    pub(crate) fn pos_array(&self) -> [f32; 2] {
        [self.pos.x, self.pos.y]
    }

    /// Знаковый угол от оси корпуса до направления `dir`.
    pub(crate) fn angle_to(&self, dir: Vector) -> f32 {
        let fwd = self.forward();

        fwd.perp_dot(dir).atan2(fwd.dot(dir))
    }
}

/// Итог лучей объезда.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Avoidance {
    /// Скорректированное направление.
    pub dir: Vector,
    pub blocked_ahead: bool,
    /// Дистанция до пропа (ящик/забор/бочка) прямо по курсу, если он первый на центральном луче.
    pub prop_ahead: Option<f32>,
    /// Доля свободной длины диагональных лучей слева/справа (1 — чисто).
    pub left_free: f32,
    pub right_free: f32,
}

/// Лучи объезда: центральный, два от передних углов корпуса и два
/// диагональных. Динамические объекты карты лучи не видят (бот их
/// таранит), на слоёной карте — только препятствия своего уровня.
pub(crate) fn probe_obstacles(
    game: &BotView<'_>,
    me: &SelfState,
    desired: Vector,
    layered: bool,
) -> Avoidance {
    let len = (24.0 + 0.25 * me.forward_speed.abs()).clamp(24.0, 70.0);
    let fwd = me.forward();
    let right = Vector::new(-fwd.y, fwd.x);
    let corner = me.pos + fwd * (0.8 * me.half_length);

    let bodies = &game.world.bodies;
    let is_map_object = |collider: &Collider| {
        collider
            .parent()
            .and_then(|parent| bodies.get(parent))
            .is_some_and(|body| vimp_engine_core::physics::is_map_object(body.user_data))
    };
    let skipped_prop = Cell::new(false);
    let predicate = |_handle: ColliderHandle, collider: &Collider| {
        if is_map_object(collider) {
            skipped_prop.set(true);
            return false; // игнорирование, луч продолжается
        }

        true
    };

    let filter = || {
        let mut filter = QueryFilter::new()
            .exclude_sensors()
            .exclude_rigid_body(me.body);

        // объезжаем препятствия СВОЕГО уровня: перила моста над головой
        // бота на земле — не препятствие. На одноуровневой карте фильтра
        // по группам нет вовсе.
        // Стражи прогона рампы (`RAMP_GUARD_GROUP`) лучами НЕ видны: прогон
        // шириной в тайл — коридор, и боковые лучи упирались бы в его борта
        // на каждом подъезде, разворачивая бота от подножия. Заезд сбоку
        // держат сами стражи и нав-граф, который через клетки прогона путь
        // не прокладывает
        if layered {
            filter = filter.groups(levels_interaction_on_ramp(level_group(me.level)));
        }

        filter
    };

    // доля свободной длины луча и нормаль попадания
    let cast = |origin: Vector, dir: Vector, length: f32| {
        let ray = Ray::new(origin, dir * length);

        game.world
            .cast_ray_and_get_normal(&ray, 1.0, true, filter().predicate(&predicate))
            .map(|(_, hit)| (hit.time_of_impact, hit.normal))
    };

    let center = cast(me.pos, desired, len);
    let center_skipped_prop = skipped_prop.replace(false);
    let front_left = cast(corner - right * me.half_width, desired, 0.8 * len);
    let front_right = cast(corner + right * me.half_width, desired, 0.8 * len);
    let diag_left = cast(me.pos, rotate(desired, -0.6), 0.6 * len);
    let diag_right = cast(me.pos, rotate(desired, 0.6), 0.6 * len);

    // проп прямо по курсу: центральный луч пропустил объект карты, и он
    // ближе первого настоящего препятствия
    let prop_ahead = if center_skipped_prop {
        let ray = Ray::new(me.pos, desired * len);

        game.world
            .cast_ray(&ray, 1.0, true, filter())
            .filter(|(handle, _)| game.world.colliders.get(*handle).is_some_and(is_map_object))
            .map(|(_, toi)| toi * len)
    } else {
        None
    };

    let mut repulse = Vector::ZERO;
    let mut slide = Vector::ZERO;

    for (hit, k) in [
        (center, 1.2),
        (front_left, 1.0),
        (front_right, 1.0),
        (diag_left, 0.6),
        (diag_right, 0.6),
    ] {
        if let Some((f, normal)) = hit {
            let w = (1.0 - f) * (1.0 - f);

            repulse += normal * (w * k);
        }
    }

    // скольжение вдоль стены прямо по курсу
    if let Some((f, normal)) = center {
        if f < 0.6 {
            let mut t = Vector::new(-normal.y, normal.x);

            if t.dot(desired) < 0.0 {
                t = -t;
            }

            slide = t * (1.0 - f);
        }
    }

    let corrected = (desired + repulse + slide).normalize_or_zero();
    let fraction = |hit: Option<(f32, Vector)>| hit.map_or(1.0, |(f, _)| f);

    Avoidance {
        dir: if corrected == Vector::ZERO {
            desired
        } else {
            corrected
        },
        blocked_ahead: fraction(center) < 0.4
            && fraction(front_left) < 0.6
            && fraction(front_right) < 0.6,
        prop_ahead,
        left_free: fraction(diag_left),
        right_free: fraction(diag_right),
    }
}

/// Детектор застревания: газ зажат, а бот не едет.
#[derive(Clone, Default, Serialize, Deserialize)]
pub(crate) struct StuckMonitor {
    pub(super) low_speed_time: f32,
    window_time: f32,
    window_start: Option<[f32; 2]>,
    window_drive_time: f32,
    #[serde(default)]
    blocked_time: f32,
    /// Моменты попыток выхода (часы бота) за последние `ATTEMPT_WINDOW` с.
    recent_attempts: Vec<f32>,
}

impl StuckMonitor {
    /// Сброс счётчиков (полёт, начало манёвра); история попыток остаётся.
    pub(crate) fn reset(&mut self) {
        self.low_speed_time = 0.0;
        self.window_time = 0.0;
        self.window_start = None;
        self.window_drive_time = 0.0;
        self.blocked_time = 0.0;
    }

    /// Тик детектора. `driving` — зажат газ (вперёд или назад),
    /// `blocked` — лучи видят стену прямо по курсу. `true` — застрял.
    pub(crate) fn update(
        &mut self,
        dt: f32,
        pos: [f32; 2],
        forward_speed: f32,
        driving: bool,
        blocked: bool,
    ) -> bool {
        let speed = forward_speed.abs();

        if driving && speed < STUCK_SPEED {
            self.low_speed_time += dt;
        } else {
            self.low_speed_time = 0.0;
        }

        if blocked && speed < BLOCKED_SPEED {
            self.blocked_time += dt;
        } else {
            self.blocked_time = 0.0;
        }

        let start = *self.window_start.get_or_insert(pos);

        self.window_time += dt;

        if driving {
            self.window_drive_time += dt;
        }

        let mut window_stuck = false;

        if self.window_time >= STUCK_WINDOW {
            window_stuck = self.window_drive_time >= WINDOW_DRIVE_SHARE * self.window_time
                && dist(start, pos) < STUCK_WINDOW_MIN_MOVE;
            self.window_start = Some(pos);
            self.window_time = 0.0;
            self.window_drive_time = 0.0;
        }

        let stuck = self.low_speed_time > STUCK_LOW_SPEED_TIME
            || window_stuck
            || self.blocked_time > BLOCKED_TIME;

        if stuck {
            self.reset();
        }

        stuck
    }

    /// Регистрирует попытку выхода и возвращает её номер (1 — первая) среди
    /// попыток за последние `ATTEMPT_WINDOW` с.
    pub(crate) fn register_attempt(&mut self, clock: f32) -> usize {
        self.recent_attempts.retain(|&t| clock - t < ATTEMPT_WINDOW);
        self.recent_attempts.push(clock);
        self.recent_attempts.len()
    }
}

/// Фаза манёвра выхода из застревания.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub(crate) enum UnstuckPhase {
    /// Назад с рулём в свободную сторону; `forward` — сзади тоже стена,
    /// бот едет вперёд с тем же рулём.
    Reverse {
        left: f32,
        turn_right: bool,
        #[serde(default)]
        forward: bool,
    },
    /// Разворот на месте к текущей точке маршрута.
    Turn { left: f32 },
    /// Ствол по оси корпуса и огонь по пропу прямо по курсу.
    ShootProp { left: f32 },
    /// Объезд через временную точку в стороне.
    Detour { left: f32 },
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(angle: f32, distance: f32) -> DriveInput {
        DriveInput {
            angle,
            distance,
            forward_speed: 0.0,
            max_speed: 260.0,
            allow_reverse: true,
            reverse_distance: 4.0 * 32.0,
            arrive_radius: 10.0,
            blocked_ahead: false,
        }
    }

    const NONE: DriveCommand = DriveCommand {
        forward: false,
        back: false,
        left: false,
        right: false,
    };

    #[test]
    fn straight_ahead_is_full_throttle_without_steering() {
        let cmd = decide_drive(&input(0.0, 200.0), NONE);

        assert_eq!(
            cmd,
            DriveCommand {
                forward: true,
                ..NONE
            }
        );
    }

    #[test]
    fn target_at_a_right_angle_turns_in_place() {
        let cmd = decide_drive(&input(std::f32::consts::FRAC_PI_2, 200.0), NONE);

        assert!(cmd.right && !cmd.left);
        assert!(!cmd.forward && !cmd.back, "разворот на месте, без газа");
    }

    #[test]
    fn close_target_behind_is_reached_in_reverse() {
        // цель сзади чуть правее по курсу корпуса: корма смотрит левее цели
        let cmd = decide_drive(&input(PI - 0.3, 60.0), NONE);

        assert!(cmd.back && !cmd.forward);
        // ошибка кормы: normalize(π − 0.3 − π) = −0.3 → Left
        assert!(cmd.left && !cmd.right);
    }

    #[test]
    fn far_target_behind_turns_around() {
        let cmd = decide_drive(&input(PI - 0.3, 1000.0), NONE);

        assert!(!cmd.back && !cmd.forward);
        assert!(cmd.right, "разворот к цели");
    }

    #[test]
    fn steering_has_hysteresis() {
        let turning_right = DriveCommand {
            right: true,
            ..NONE
        };

        assert!(decide_drive(&input(0.06, 200.0), turning_right).right);
        assert!(!decide_drive(&input(0.06, 200.0), NONE).right);
        assert!(!decide_drive(&input(0.03, 200.0), turning_right).right);
    }

    #[test]
    fn blocked_ahead_holds_the_throttle() {
        let mut blocked = input(0.2, 200.0);

        blocked.blocked_ahead = true;

        let cmd = decide_drive(&blocked, NONE);

        assert!(!cmd.forward);
        assert!(cmd.right, "руль к просвету остаётся");
    }

    #[test]
    fn inside_the_arrive_radius_everything_is_released() {
        assert_eq!(decide_drive(&input(1.0, 5.0), NONE), NONE);
    }

    #[test]
    fn slows_down_before_a_turn() {
        let mut fast = input(0.8, 200.0);

        fast.forward_speed = 200.0;
        assert!(!decide_drive(&fast, NONE).forward);

        fast.forward_speed = 100.0;
        assert!(decide_drive(&fast, NONE).forward);
    }

    #[test]
    fn stuck_monitor_fires_on_a_stalled_throttle() {
        let mut monitor = StuckMonitor::default();
        let mut fired = false;

        for _ in 0..80 {
            fired |= monitor.update(0.01, [0.0, 0.0], 0.0, true, false);
        }

        assert!(fired, "0.8 с газа без движения — застревание");

        let mut monitor = StuckMonitor::default();

        for i in 0..300 {
            assert!(
                !monitor.update(0.01, [i as f32, 0.0], 100.0, true, false),
                "едущий бот не застрял"
            );
        }

        let mut monitor = StuckMonitor::default();

        for _ in 0..300 {
            assert!(
                !monitor.update(0.01, [0.0, 0.0], 0.0, false, false),
                "намеренная остановка без газа — не застревание"
            );
        }
    }

    #[test]
    fn attempts_expire_after_the_window() {
        let mut monitor = StuckMonitor::default();

        assert_eq!(monitor.register_attempt(0.0), 1);
        assert_eq!(monitor.register_attempt(1.0), 2);
        assert_eq!(monitor.register_attempt(6.5), 2);
    }
}
