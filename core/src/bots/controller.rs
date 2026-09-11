use std::cell::Cell;
use std::f32::consts::PI;

use rapier2d::prelude::*;
use serde::{Deserialize, Serialize};

use crate::tanks::BotView;
use vimp_engine_core::map::{level_group, levels_interaction_on_ramp};
use vimp_engine_core::nav::navigation::PathPoint;

// константы поведения бота (из src/server/modules/bots/BotController.js)
const AI_UPDATE_INTERVAL: f32 = 0.1;
const TARGET_PREDICTION_FACTOR: f32 = 0.2;
const OBSTACLE_AVOIDANCE_RAY_LENGTH: f32 = 50.0;
const MIN_TARGET_DISTANCE: f32 = 30.0;
const MAX_FIRING_DISTANCE: f32 = 500.0;

// снижение меткости
const AIM_INACCURACY: f32 = 0.5;
const MIN_FIRING_DELAY: f32 = 0.5;
const RANDOM_FIRING_DELAY: f32 = 0.5;

// использование бомб
const BOMB_USAGE_DISTANCE: f32 = 100.0;
const BOMB_COOLDOWN: f32 = 0.0;

const REPATH_INTERVAL: f32 = 1.0;
const TARGET_SCAN_INTERVAL: f32 = 1.5;

const FORWARD: Vector = Vector::new(1.0, 0.0);
const RIGHT: Vector = Vector::new(0.0, 1.0);

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BotState {
    Patrolling,
    Navigating,
    Attacking,
    Searching,
    ClearingObstacle,
    Dead,
    Idle,
}

/// Удерживаемые клавиши бота (JS _keyStates).
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
enum HeldKey {
    Forward,
    Back,
    Left,
    Right,
    GunLeft,
    GunRight,
}

const HELD_KEYS: [HeldKey; 6] = [
    HeldKey::Forward,
    HeldKey::Back,
    HeldKey::Left,
    HeldKey::Right,
    HeldKey::GunLeft,
    HeldKey::GunRight,
];

enum MoveTarget {
    Player(u32),
    Point([f32; 2]),
}

/// ИИ одного бота (порт BotController): навигация, прицеливание,
/// стрельба. Ввод генерируется внутри ядра — бот дёргает те же клавиши,
/// что и игрок.
#[derive(Serialize, Deserialize)]
pub struct BotBrain {
    pub game_id: u32,
    pub state: BotState,

    target: Option<u32>,
    path: Option<Vec<PathPoint>>,
    path_index: usize,

    repath_timer: f32,
    target_scan_timer: f32,
    ai_update_timer: f32,
    firing_timer: f32,
    bomb_cooldown_timer: f32,

    last_known_position: Option<[f32; 2]>,

    stuck_timer: f32,
    last_position: Option<[f32; 2]>,

    reposition_timer: f32,
    reposition_target: Option<[f32; 2]>,

    patrol_target: Option<PathPoint>,

    key_states: [bool; 6],

    // кэш кадра (JS _updateCachedData)
    #[serde(skip)]
    my_position: Option<[f32; 2]>,
    /// Уровень бота на этом кадре (2.5D-карты); 0 у одноуровневой карты.
    #[serde(skip)]
    my_level: u8,
}

fn dist_sq(a: [f32; 2], b: [f32; 2]) -> f32 {
    let dx = a[0] - b[0];
    let dy = a[1] - b[1];

    dx * dx + dy * dy
}

fn rotate(v: Vector, angle: f32) -> Vector {
    Rotation::from_angle(angle).transform_vector(v)
}

fn normalize_angle(angle: f32) -> f32 {
    angle.sin().atan2(angle.cos())
}

impl BotBrain {
    pub fn new(game_id: u32, rng: &mut vimp_engine_core::rng::Rng) -> Self {
        Self {
            game_id,
            state: BotState::Patrolling,
            target: None,
            path: None,
            path_index: 0,
            repath_timer: rng.next_f32() * REPATH_INTERVAL,
            target_scan_timer: rng.next_f32() * TARGET_SCAN_INTERVAL,
            ai_update_timer: 0.0,
            firing_timer: 0.0,
            bomb_cooldown_timer: 0.0,
            last_known_position: None,
            stuck_timer: 0.0,
            last_position: None,
            reposition_timer: 0.0,
            reposition_target: None,
            patrol_target: None,
            key_states: [false; 6],
            my_position: None,
            my_level: 0,
        }
    }

    /// Своя позиция как точка пути (с уровнем).
    fn my_point(&self) -> Option<PathPoint> {
        Some(PathPoint {
            pos: self.my_position?,
            level: self.my_level,
        })
    }

    fn key_bit(&self, game: &BotView<'_>, key: HeldKey) -> u32 {
        let bits = &game.key_bits;

        match key {
            HeldKey::Forward => bits.forward,
            HeldKey::Back => bits.back,
            HeldKey::Left => bits.left,
            HeldKey::Right => bits.right,
            HeldKey::GunLeft => bits.gun_left,
            HeldKey::GunRight => bits.gun_right,
        }
    }

    /// Обновляет клавишу только при изменении состояния (JS _setKeyState).
    fn set_key_state(&mut self, game: &mut BotView<'_>, key: HeldKey, is_down: bool) {
        let index = HELD_KEYS.iter().position(|&k| k == key).unwrap();

        if self.key_states[index] != is_down {
            self.key_states[index] = is_down;

            let bit = self.key_bit(game, key);
            let action = if is_down { "down" } else { "up" };

            game.update_tank_keys(self.game_id, action, bit);
        }
    }

    fn press_one_shot(&self, game: &mut BotView<'_>, bit: u32) {
        game.update_tank_keys(self.game_id, "down", bit);
    }

    fn release_all_keys(&mut self, game: &mut BotView<'_>) {
        for key in HELD_KEYS {
            self.set_key_state(game, key, false);
        }
    }

    /// Главный метод обновления (вызывается на каждом тике ядра).
    pub(crate) fn update(&mut self, game: &mut BotView<'_>, dt: f32) {
        self.my_position = game.tank_position_rounded(self.game_id);
        self.my_level = game.tank_level(self.game_id);

        let has_body = game
            .tanks
            .get(&self.game_id)
            .map(|tank| tank.body)
            .is_some_and(|handle| game.world.bodies.get(handle).is_some());

        if !has_body || !game.tank_alive(self.game_id) {
            if self.state != BotState::Dead {
                self.state = BotState::Dead;
                self.release_all_keys(game);
            }

            return;
        }

        // танк в падении не управляется: любые клавиши всё равно
        // игнорируются ядром, а таймер застревания за 0.35 c успел бы
        // сорвать бота в ClearingObstacle на ровном месте
        if game.tank_input_locked(self.game_id) {
            self.release_all_keys(game);
            self.stuck_timer = 0.0;
            self.last_position = self.my_position;

            return;
        }

        self.ai_update_timer -= dt;
        self.firing_timer = (self.firing_timer - dt).max(0.0);
        self.bomb_cooldown_timer = (self.bomb_cooldown_timer - dt).max(0.0);
        self.repath_timer -= dt;
        self.target_scan_timer -= dt;
        self.reposition_timer = (self.reposition_timer - dt).max(0.0);

        // обнаружение застревания
        self.stuck_timer += dt;

        if self.stuck_timer >= 1.5 {
            self.stuck_timer = 0.0;

            if let Some(current) = self.my_position {
                if let Some(last) = self.last_position {
                    let moving_state = matches!(
                        self.state,
                        BotState::Navigating | BotState::Searching | BotState::Patrolling
                    );

                    if moving_state && dist_sq(current, last) < 10.0 {
                        self.state = BotState::ClearingObstacle;
                    }
                }

                self.last_position = Some(current);
            }
        }

        if self.ai_update_timer <= 0.0 {
            self.ai_update_timer = AI_UPDATE_INTERVAL;
            self.make_decision(game);
        }

        if self.state == BotState::ClearingObstacle {
            self.handle_clearing_obstacle(game);
        } else {
            self.execute_movement(game);
            self.execute_aim_and_shoot(game);
        }
    }

    /// Принятие решений: атаковать видимого врага, идти к последней
    /// известной позиции или патрулировать.
    fn make_decision(&mut self, game: &mut BotView<'_>) {
        if self.target_scan_timer > 0.0 && self.state != BotState::Patrolling {
            return;
        }

        self.target_scan_timer = TARGET_SCAN_INTERVAL;

        self.target = self.find_closest_enemy(game);

        if let Some(target) = self.target {
            self.patrol_target = None;
            self.path = None;

            if let Some(target_pos) = game.tank_position_rounded(target) {
                self.last_known_position = Some(target_pos);

                let visible = match (&game.nav, self.my_position) {
                    (Some(nav), Some(my)) => !nav.has_obstacle_between(my, target_pos),
                    _ => false,
                };

                self.state = if visible {
                    BotState::Attacking
                } else {
                    BotState::Navigating
                };
            }

            return;
        }

        if self.last_known_position.is_some() {
            self.state = BotState::Searching;
            return;
        }

        self.state = BotState::Patrolling;

        if self.patrol_target.is_none() {
            self.set_new_patrol_target(game);
        }
    }

    /// Новая случайная цель патрулирования + путь к ней.
    fn set_new_patrol_target(&mut self, game: &mut BotView<'_>) {
        let Some(nav) = &game.nav else {
            return;
        };

        let random = nav.random_point(&mut game.rng);

        if let (Some(node), Some(my)) = (random, self.my_point()) {
            self.patrol_target = Some(node);
            self.path = nav.find_path_on(my, node);
            self.path_index = 0;
        }
    }

    /// Движение согласно текущему состоянию.
    fn execute_movement(&mut self, game: &mut BotView<'_>) {
        if let Some(target) = self.target {
            if !game.tank_alive(target) {
                self.target = None;
                self.last_known_position = None;
                self.make_decision(game);
                return;
            }
        }

        if self.state == BotState::Attacking || self.state == BotState::Navigating {
            let Some(target) = self.target else {
                return;
            };

            if self.reposition_timer > 0.0 && self.reposition_target.is_some() {
                let reposition = self.reposition_target.unwrap();

                self.move_to(game, MoveTarget::Point(reposition));

                if let Some(my) = self.my_position {
                    if dist_sq(my, reposition) < 50.0 * 50.0 {
                        self.reposition_timer = 0.0;
                    }
                }
            } else {
                self.move_to(game, MoveTarget::Player(target));
            }

            return;
        }

        if self.state == BotState::Searching {
            if let Some(last_known) = self.last_known_position {
                self.move_to(game, MoveTarget::Point(last_known));

                if let Some(my) = self.my_position {
                    if dist_sq(my, last_known) < MIN_TARGET_DISTANCE * MIN_TARGET_DISTANCE {
                        self.last_known_position = None;
                    }
                }

                return;
            }
        }

        if self.state == BotState::Patrolling {
            if self.path.is_some() && self.patrol_target.is_some() {
                let patrol = self.patrol_target.unwrap();

                self.follow_path(game);

                if let Some(my) = self.my_position {
                    if dist_sq(my, patrol.pos) < MIN_TARGET_DISTANCE * MIN_TARGET_DISTANCE {
                        self.patrol_target = None;
                        self.path = None;
                    }
                }
            } else if self.path.is_none() {
                self.set_new_patrol_target(game);
            }

            return;
        }

        self.release_all_keys(game);
    }

    /// Движение по текущему пути.
    fn follow_path(&mut self, game: &mut BotView<'_>) {
        let Some(path) = &self.path else {
            return;
        };

        if self.path_index >= path.len() {
            return;
        }

        let next = path[self.path_index];

        // смена уровня между точками пути — это рампа или обрыв. Порог
        // «дошёл до точки» на переходе делаем шире: на рампе танк
        // физически не может встать точно в узел уровня, к которому едет
        let reach = if next.level != self.my_level {
            MIN_TARGET_DISTANCE * 2.0
        } else {
            MIN_TARGET_DISTANCE
        };

        self.move_to(game, MoveTarget::Point(next.pos));

        if let Some(my) = self.my_position {
            let distance_sq = dist_sq(my, next.pos);

            if distance_sq < reach * reach {
                self.path_index += 1;
            }
        }
    }

    /// Ближайший живой враг (через пространственную сетку). Цель своего
    /// уровня всегда предпочтительнее: по чужому уровню бот чаще всего не
    /// может стрелять, и без этого предпочтения он застревал бы в
    /// Attacking, глядя в плиту моста.
    fn find_closest_enemy(&self, game: &BotView<'_>) -> Option<u32> {
        let my = self.my_position?;
        let my_team = game.tanks.get(&self.game_id)?.team_id;

        let candidates = game.spatial.query_nearby(my[0], my[1]);
        let mut same_level: Option<(u32, f32)> = None;
        let mut other_level: Option<(u32, f32)> = None;

        for candidate in candidates {
            if candidate.game_id == self.game_id || candidate.team_id == my_team {
                continue;
            }

            let distance_sq = dist_sq(my, [candidate.x, candidate.y]);

            if distance_sq >= MAX_FIRING_DISTANCE * MAX_FIRING_DISTANCE * 1.5 {
                continue;
            }

            let slot = if game.tank_level(candidate.game_id) == self.my_level {
                &mut same_level
            } else {
                &mut other_level
            };

            if slot.is_none_or(|(_, best)| distance_sq < best) {
                *slot = Some((candidate.game_id, distance_sq));
            }
        }

        same_level.or(other_level).map(|(id, _)| id)
    }

    /// Движение к цели (gameId или точка) с обходом препятствий.
    fn move_to(&mut self, game: &mut BotView<'_>, target: MoveTarget) {
        let Some(tank) = game.tanks.get(&self.game_id) else {
            return;
        };
        let Some(body) = game.world.bodies.get(tank.body) else {
            return;
        };

        let my_position = body.translation();
        let my_rotation = *body.rotation();
        let my_body_handle = tank.body;

        let target_position = match target {
            MoveTarget::Point(point) => Vector::new(point[0], point[1]),
            MoveTarget::Player(id) => {
                let Some(pos) = game.tank_position_rounded(id) else {
                    return;
                };
                let mut position = Vector::new(pos[0], pos[1]);

                if let Some(target_body) = game
                    .tanks
                    .get(&id)
                    .and_then(|t| game.world.bodies.get(t.body))
                {
                    // упреждение по скорости цели
                    position += target_body.linvel() * TARGET_PREDICTION_FACTOR;
                }

                position
            }
        };

        let direction_to_target = target_position - my_position;

        if direction_to_target.length_squared() < MIN_TARGET_DISTANCE * MIN_TARGET_DISTANCE {
            self.set_key_state(game, HeldKey::Forward, false);
            self.set_key_state(game, HeldKey::Left, false);
            self.set_key_state(game, HeldKey::Right, false);
            return;
        }

        let dir_norm = direction_to_target.normalize_or_zero();
        let layered = game.levels.is_some_and(|levels| levels.is_layered());
        let final_direction = avoid_obstacles(
            game,
            my_body_handle,
            my_position,
            dir_norm,
            self.my_level,
            layered,
        );

        let forward_vec = my_rotation.transform_vector(FORWARD);
        let angle_to_target = forward_vec
            .perp_dot(final_direction)
            .atan2(forward_vec.dot(final_direction));
        let turn_threshold = 0.2;

        if angle_to_target > turn_threshold {
            self.set_key_state(game, HeldKey::Right, true);
            self.set_key_state(game, HeldKey::Left, false);
        } else if angle_to_target < -turn_threshold {
            self.set_key_state(game, HeldKey::Left, true);
            self.set_key_state(game, HeldKey::Right, false);
        } else {
            self.set_key_state(game, HeldKey::Left, false);
            self.set_key_state(game, HeldKey::Right, false);
        }

        if angle_to_target.abs() < PI / 1.5 {
            self.set_key_state(game, HeldKey::Forward, true);
        } else {
            self.set_key_state(game, HeldKey::Forward, false);
        }
    }

    /// Прицеливание и стрельба.
    fn execute_aim_and_shoot(&mut self, game: &mut BotView<'_>) {
        let target_alive = self.target.is_some_and(|t| game.tank_alive(t));

        if self.reposition_timer > 0.0 || self.state != BotState::Attacking || !target_alive {
            self.set_key_state(game, HeldKey::GunLeft, false);
            self.set_key_state(game, HeldKey::GunRight, false);
            return;
        }

        let target = self.target.unwrap();

        let Some(tank) = game.tanks.get(&self.game_id) else {
            return;
        };
        let Some(body) = game.world.bodies.get(tank.body) else {
            return;
        };

        let Some(target_pos) = game.tank_position_rounded(target) else {
            return;
        };

        let my_position = body.translation();
        let body_angle = body.rotation().angle();
        let gun_rotation = tank.gun_rotation;
        let current_weapon = tank.current_weapon;

        let visible = game.nav.as_ref().is_some_and(|nav| {
            !nav.has_obstacle_between_on(self.my_level, [my_position.x, my_position.y], target_pos)
        });

        if !visible {
            return;
        }

        let direction = Vector::new(target_pos[0], target_pos[1]) - my_position;

        // цель на чужом уровне может быть закрыта плитой моста: тогда не
        // стреляем, а идём к ней — путь пойдёт через рампу, потому что
        // `find_path_on` знает уровни
        if let Some(levels) = game.levels {
            let target_level = game.tank_level(target);
            let dir = direction.normalize_or_zero();
            let range = game
                .weapons
                .get_index(current_weapon)
                .and_then(|(_, weapon)| weapon.range)
                .unwrap_or(MAX_FIRING_DISTANCE);
            let segments = crate::shot_levels::ray_segments(
                levels,
                [my_position.x, my_position.y],
                [dir.x, dir.y],
                range,
                self.my_level,
            );

            if !crate::shot_levels::covers_level(&segments, direction.length(), target_level) {
                return;
            }
        }
        let distance_sq = direction.length_squared();
        let should_use_bomb = distance_sq < BOMB_USAGE_DISTANCE * BOMB_USAGE_DISTANCE
            && self.bomb_cooldown_timer <= 0.0;

        // боты рассчитаны на пару w1 (hitscan) / w2 (бомба), как в JS-версии
        let w1 = game.weapon_index("w1");
        let w2 = game.weapon_index("w2");

        if should_use_bomb {
            if w2.is_some() && Some(current_weapon) != w2 {
                let bit = game.key_bits.next_weapon;

                self.press_one_shot(game, bit);
                return;
            }
        } else if w2.is_some() && Some(current_weapon) == w2 {
            let bit = game.key_bits.next_weapon;

            self.press_one_shot(game, bit);
            return;
        }

        let target_angle = direction.y.atan2(direction.x)
            + game.rng.range(-AIM_INACCURACY / 2.0, AIM_INACCURACY / 2.0);

        let current_gun_angle = body_angle + gun_rotation;
        let angle_difference = normalize_angle(target_angle - current_gun_angle);
        let aim_threshold = 0.05;

        if angle_difference > aim_threshold {
            self.set_key_state(game, HeldKey::GunRight, true);
            self.set_key_state(game, HeldKey::GunLeft, false);
        } else if angle_difference < -aim_threshold {
            self.set_key_state(game, HeldKey::GunLeft, true);
            self.set_key_state(game, HeldKey::GunRight, false);
        } else {
            self.set_key_state(game, HeldKey::GunLeft, false);
            self.set_key_state(game, HeldKey::GunRight, false);

            if self.firing_timer <= 0.0 {
                let has_ammo = |index: Option<usize>| {
                    index.is_some_and(|i| {
                        game.tanks
                            .get(&self.game_id)
                            .is_some_and(|t| t.ammo.get(i).copied().unwrap_or(0.0) >= 1.0)
                    })
                };

                if should_use_bomb && Some(current_weapon) == w2 && has_ammo(w2) {
                    let bit = game.key_bits.fire;

                    self.press_one_shot(game, bit);
                    self.bomb_cooldown_timer = BOMB_COOLDOWN;
                    self.reposition_timer = 2.0;
                    self.calculate_new_combat_position(game);
                } else if !should_use_bomb
                    && Some(current_weapon) == w1
                    && distance_sq < MAX_FIRING_DISTANCE * MAX_FIRING_DISTANCE
                {
                    self.firing_timer =
                        MIN_FIRING_DELAY + game.rng.next_f32() * RANDOM_FIRING_DELAY;

                    if has_ammo(w1) {
                        let bit = game.key_bits.fire;

                        self.press_one_shot(game, bit);
                        self.reposition_timer = 2.0;
                        self.calculate_new_combat_position(game);
                    }
                }
            }
        }
    }

    /// Бот застрял: выравнивает башню по корпусу и стреляет в препятствие.
    fn handle_clearing_obstacle(&mut self, game: &mut BotView<'_>) {
        self.release_all_keys(game);

        let Some((body_angle, gun_rotation)) = game.tanks.get(&self.game_id).and_then(|tank| {
            game.world
                .bodies
                .get(tank.body)
                .map(|body| (body.rotation().angle(), tank.gun_rotation))
        }) else {
            self.state = BotState::Idle;
            return;
        };

        let current_gun_angle = body_angle + gun_rotation;
        let angle_difference = normalize_angle(body_angle - current_gun_angle);
        let aim_threshold = 0.1;

        if angle_difference > aim_threshold {
            self.set_key_state(game, HeldKey::GunRight, true);
        } else if angle_difference < -aim_threshold {
            self.set_key_state(game, HeldKey::GunLeft, true);
        } else {
            self.set_key_state(game, HeldKey::GunLeft, false);
            self.set_key_state(game, HeldKey::GunRight, false);

            let bit = game.key_bits.fire;

            self.press_one_shot(game, bit);
            self.ai_update_timer = 0.5;
            self.state = BotState::Patrolling;
        }
    }

    /// Новая боевая позиция для стрейфа после выстрела.
    fn calculate_new_combat_position(&mut self, game: &mut BotView<'_>) {
        let Some(my) = self.my_position else {
            return;
        };

        let Some(rotation) = game
            .tanks
            .get(&self.game_id)
            .and_then(|tank| game.world.bodies.get(tank.body))
            .map(|body| *body.rotation())
        else {
            return;
        };

        let right_vec = rotation.transform_vector(RIGHT);
        let strafe_direction = if game.rng.next_f32() > 0.5 { 1.0 } else { -1.0 };
        let strafe_distance = game.rng.range(100.0, 200.0);

        let target = Vector::new(my[0], my[1]) + right_vec * (strafe_distance * strafe_direction);

        // точка годится, только если она проходима на МОЁМ уровне: иначе
        // бот на мосту побежит в точку, которой на мосту нет
        if let Some(nav) = game.nav.as_ref() {
            if !nav.is_walkable_on(self.my_level, target.x, target.y) {
                return;
            }
        }

        self.reposition_target = Some([target.x, target.y]);
    }
}

/// Локальное избегание препятствий тремя лучами; динамические объекты
/// карты игнорируются (бот их таранит).
fn avoid_obstacles(
    game: &BotView<'_>,
    my_body: RigidBodyHandle,
    my_position: Vector,
    desired_direction: Vector,
    my_level: u8,
    layered: bool,
) -> Vector {
    let rays = [
        desired_direction,
        rotate(desired_direction, PI / 6.0),
        rotate(desired_direction, -PI / 6.0),
    ];

    let mut steer_correction = Vector::ZERO;
    let mut obstacles_detected = false;
    let dynamic_obstacle_in_path = Cell::new(false);

    let bodies = &game.world.bodies;
    let predicate = |_handle: ColliderHandle, collider: &Collider| {
        let is_map_object = collider
            .parent()
            .and_then(|parent| bodies.get(parent))
            .is_some_and(|body| vimp_engine_core::physics::is_map_object(body.user_data));

        if is_map_object {
            dynamic_obstacle_in_path.set(true);
            return false; // игнорирование, луч продолжается
        }

        true
    };

    for dir in rays {
        let ray_vector = dir * OBSTACLE_AVOIDANCE_RAY_LENGTH;
        let ray = Ray::new(my_position, ray_vector);

        let mut filter = QueryFilter::new()
            .exclude_sensors()
            .exclude_rigid_body(my_body)
            .predicate(&predicate);

        // объезжаем препятствия СВОЕГО уровня: перила моста над головой
        // бота на земле — не препятствие. На одноуровневой карте фильтра
        // по группам нет вовсе — прежний путь бит-в-бит.
        // Стражи прогона рампы (`RAMP_GUARD_GROUP`) лучами НЕ видны: прогон
        // шириной в тайл — коридор, и боковые лучи упирались бы в его борта
        // на каждом подъезде, разворачивая бота от подножия. Заезд сбоку
        // держат сами стражи и нав-граф, который через клетки прогона путь
        // не прокладывает
        if layered {
            filter = filter.groups(levels_interaction_on_ramp(level_group(my_level)));
        }

        if game.world.cast_ray(&ray, 1.0, true, filter).is_some() {
            obstacles_detected = true;
            steer_correction -= ray_vector;
        }
    }

    // впереди только динамические объекты — курс не корректируется (таран)
    if dynamic_obstacle_in_path.get() && !obstacles_detected {
        return desired_direction;
    }

    if obstacles_detected {
        return (steer_correction + desired_direction).normalize_or_zero();
    }

    desired_direction
}

#[cfg(test)]
mod tests {
    use super::*;

    use indexmap::IndexMap;
    use vimp_engine_core::map::{MapConfig, MapLevels};
    use vimp_engine_core::nav::navigation::NavigationSystem;
    use vimp_engine_core::nav::spatial::{SpatialEntity, SpatialGrid};
    use vimp_engine_core::rng::Rng;

    use crate::config::{KeyConfig, ModelConfig, PanelValue, WeaponConfig};
    use crate::level::Transit;
    use crate::tank::{PlayerKeyBits, Tank};
    use crate::tanks::BotView;

    const TILE: f32 = 32.0;

    /// Фикстура tests/core/fixtures/layered.json (та же карта, что у
    /// JS-тестов ядра): 20×20, стены по периметру, рампа на восток
    /// (строка 9, колонки 6..9) и мост (тайл 2) в колонках 10..12,
    /// строках 5..14.
    fn levels() -> MapLevels {
        let cfg: MapConfig =
            serde_json::from_str(include_str!("../../../tests/core/fixtures/layered.json"))
                .unwrap();

        MapLevels::build(
            &cfg.map,
            &cfg.physics_static,
            &cfg.levels,
            &cfg.ramps,
            TILE,
            None,
        )
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
        .unwrap()
    }

    fn weapons() -> IndexMap<String, WeaponConfig> {
        serde_json::from_value(serde_json::json!({
            "w1": {
                "type": "hitscan",
                "damage": 40,
                "range": 1500,
                "fireRate": 0.01,
                "consumption": 1
            }
        }))
        .unwrap()
    }

    fn panel() -> IndexMap<String, PanelValue> {
        let mut panel = IndexMap::new();

        panel.insert("health".to_string(), PanelValue { value: 100.0 });
        panel.insert("w1".to_string(), PanelValue { value: 10.0 });
        panel
    }

    fn key_bits() -> PlayerKeyBits {
        let keys: IndexMap<String, KeyConfig> = serde_json::from_value(serde_json::json!({
            "forward": { "key": 1 },
            "back": { "key": 2 },
            "left": { "key": 4 },
            "right": { "key": 8 },
            "gunLeft": { "key": 16 },
            "gunRight": { "key": 32 },
            "fire": { "key": 128, "type": 1 },
            "nextWeapon": { "key": 256, "type": 1 }
        }))
        .unwrap();

        PlayerKeyBits::from_config(&keys)
    }

    /// Мир с ботом и произвольным числом других танков.
    struct Fixture {
        world: PhysicsWorld,
        nav: Option<NavigationSystem>,
        spatial: SpatialGrid,
        rng: Rng,
        tanks: IndexMap<u32, Tank>,
        key_bits: PlayerKeyBits,
        weapons: IndexMap<String, WeaponConfig>,
        levels: MapLevels,
    }

    impl Fixture {
        fn new() -> Self {
            let levels = levels();
            let nav = NavigationSystem::generate_layered(&levels, TILE);

            Self {
                world: PhysicsWorld::new(),
                nav: Some(nav),
                spatial: SpatialGrid::new(1000.0),
                rng: Rng::new(7),
                tanks: IndexMap::new(),
                key_bits: key_bits(),
                weapons: weapons(),
                levels,
            }
        }

        fn add_tank(&mut self, game_id: u32, team_id: u8, x: f32, y: f32, level: u8) {
            let mut tank = Tank::new(
                &mut self.world,
                &self.weapons,
                &panel(),
                "m1",
                &model(),
                game_id,
                team_id,
                x,
                y,
                0.0,
            );

            if level > 0 {
                tank.set_level(level);
                tank.sync_collision_groups(&mut self.world);
            }

            self.spatial.insert(SpatialEntity {
                game_id,
                team_id,
                x,
                y,
            });

            self.tanks.insert(game_id, tank);
        }

        fn view(&mut self) -> BotView<'_> {
            BotView {
                world: &mut self.world,
                nav: &self.nav,
                spatial: &self.spatial,
                rng: &mut self.rng,
                tanks: &mut self.tanks,
                key_bits: &self.key_bits,
                weapons: &self.weapons,
                levels: Some(&self.levels),
            }
        }
    }

    /// Бот в кэшированном состоянии «стою здесь, на этом уровне».
    fn brain_at(game_id: u32, position: [f32; 2], level: u8) -> BotBrain {
        let mut rng = Rng::new(3);
        let mut brain = BotBrain::new(game_id, &mut rng);

        brain.my_position = Some(position);
        brain.my_level = level;
        brain
    }

    #[test]
    fn bot_path_crosses_the_ramp() {
        let mut fixture = Fixture::new();

        fixture.add_tank(1, 1, 112.0, 112.0, 0);

        let mut brain = brain_at(1, [112.0, 112.0], 0);
        let mut view = fixture.view();
        let mut crossed = false;

        // цель патрулирования случайна: ждём первую, что лежит на мосту
        for _ in 0..500 {
            brain.set_new_patrol_target(&mut view);

            if brain.patrol_target.is_some_and(|point| point.level == 1) {
                let path = brain.path.as_ref().expect("путь к мосту построен");

                assert!(
                    path.iter().any(|point| point.level == 1),
                    "путь на мост обязан содержать точку уровня 1: {path:?}"
                );

                crossed = true;
                break;
            }
        }

        assert!(crossed, "мост ни разу не выпал целью патрулирования");
    }

    #[test]
    fn bot_prefers_the_enemy_on_its_level() {
        let mut fixture = Fixture::new();

        fixture.add_tank(1, 1, 112.0, 112.0, 0);
        // ближний враг — на мосту, дальний — на земле
        fixture.add_tank(2, 2, 368.0, 208.0, 1);
        fixture.add_tank(3, 2, 112.0, 432.0, 0);

        let brain = brain_at(1, [112.0, 112.0], 0);
        let view = fixture.view();

        assert_eq!(brain.find_closest_enemy(&view), Some(3));
    }

    /// Прицеленный в цель бот: сколько попыток из `attempts` дошли до
    /// выстрела (разброс прицела случаен, поэтому попыток несколько).
    fn fires_within(fixture: &mut Fixture, brain: &mut BotBrain, attempts: usize) -> bool {
        let mut view = fixture.view();

        for _ in 0..attempts {
            brain.execute_aim_and_shoot(&mut view);

            if brain.firing_timer > 0.0 {
                return true;
            }
        }

        false
    }

    #[test]
    fn bot_holds_fire_through_the_slab() {
        let mut fixture = Fixture::new();

        // бот на мосту, цель — под плитой, на земле
        fixture.add_tank(1, 1, 368.0, 208.0, 1);
        fixture.add_tank(2, 2, 368.0, 432.0, 0);

        let mut brain = brain_at(1, [368.0, 208.0], 1);

        brain.state = BotState::Attacking;
        brain.target = Some(2);
        fixture.tanks[&1].gun_rotation = std::f32::consts::FRAC_PI_2;

        assert!(
            !fires_within(&mut fixture, &mut brain, 100),
            "плита моста экранирует цель — выстрела быть не должно"
        );
    }

    #[test]
    fn bot_fires_at_the_enemy_on_the_open_edge() {
        let mut fixture = Fixture::new();

        // бот на земле западнее моста, цель — на кромке без перил
        fixture.add_tank(1, 1, 200.0, 208.0, 0);
        fixture.add_tank(2, 2, 336.0, 208.0, 1);

        let mut brain = brain_at(1, [200.0, 208.0], 0);

        brain.state = BotState::Attacking;
        brain.target = Some(2);

        assert!(
            fires_within(&mut fixture, &mut brain, 100),
            "цель на открытой кромке достижима с земли"
        );
    }

    #[test]
    fn bot_fires_at_a_ground_enemy_inside_the_probe_window() {
        let mut fixture = Fixture::new();

        // оба на земле, но враг стоит ПОД кромкой плиты: на этой
        // дистанции луч везёт и сегмент уровня 1 (проба), и свой
        // наземный — «максимум уровня» запрещал бы выстрел
        fixture.add_tank(1, 1, 200.0, 208.0, 0);
        fixture.add_tank(2, 2, 336.0, 208.0, 0);

        let mut brain = brain_at(1, [200.0, 208.0], 0);

        brain.state = BotState::Attacking;
        brain.target = Some(2);

        assert!(
            fires_within(&mut fixture, &mut brain, 100),
            "наземная цель в окне пробы должна обстреливаться"
        );
    }

    #[test]
    fn falling_bot_releases_keys_and_does_not_get_stuck() {
        let mut fixture = Fixture::new();

        fixture.add_tank(1, 1, 368.0, 208.0, 1);

        let mut brain = brain_at(1, [368.0, 208.0], 1);

        brain.key_states = [true; 6];
        brain.stuck_timer = 1.4;
        fixture.tanks[&1].level_state.transit = Transit::Airborne {
            vz: 0.0,
            from: 1,
            to: 0,
            peak: 1.0,
        };

        let mut view = fixture.view();

        brain.update(&mut view, 0.2);

        assert_eq!(brain.key_states, [false; 6], "все клавиши отпущены");
        assert_eq!(brain.stuck_timer, 0.0, "падение не считается застреванием");
        assert!(matches!(brain.state, BotState::Patrolling));
    }

    #[test]
    fn combat_reposition_stays_on_the_level() {
        let mut fixture = Fixture::new();

        fixture.add_tank(1, 1, 368.0, 320.0, 1);

        let mut brain = brain_at(1, [368.0, 320.0], 1);
        let nav = fixture.nav.clone().unwrap();
        let mut accepted = 0;
        let mut rejected = 0;

        for _ in 0..60 {
            brain.reposition_target = None;

            let mut view = fixture.view();

            brain.calculate_new_combat_position(&mut view);

            match brain.reposition_target {
                Some(point) => {
                    assert!(
                        nav.is_walkable_on(1, point[0], point[1]),
                        "точка перепозиционирования вне моста: {point:?}"
                    );

                    accepted += 1;
                }
                None => rejected += 1,
            }
        }

        assert!(accepted > 0, "ни одна точка не подошла");
        assert!(rejected > 0, "точки за краем моста обязаны отбраковываться");
    }
}
