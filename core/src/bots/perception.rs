//! Восприятие бота: что он знает о врагах (радар, видимость, память об
//! уроне) и что стоит на линии выстрела.

use rapier2d::prelude::*;
use serde::{Deserialize, Serialize};
use vimp_engine_core::map::{level_group, levels_interaction_on_ramp};

use super::geom::{angle_of, dist, dist_sq, normalize_angle};
use super::profile::BotProfile;
use super::steering::SelfState;
use crate::body_tag::BodyTag;
use crate::shot_height::bullet_line;
use crate::tanks::BotView;

/// Дальше этого (ед.) бот врага не видит, даже в прямой видимости.
pub(crate) const VIEW_RANGE: f32 = 900.0;
/// Дальность `w1`, если у оружия она не задана.
const DEFAULT_RANGE: f32 = 1500.0;
/// Ствол врага смотрит на бота точнее этого угла (рад) — враг целится в него.
const AIMING_AT_ME_ANGLE: f32 = 0.15;
/// Постоянная спада недавнего урона, с.
const DAMAGE_DECAY: f32 = 3.0;

/// Что стоит на линии выстрела бота по цели. Правила — те же, что у хоста
/// (`shot_height`, `shot_levels`): видимость по сетке уровня стрелка,
/// пол под пулей на дистанции цели, «дорастает» ли цель до пули, насыпь рампы;
/// на своём уровне — физический луч, как у hitscan.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum FireLine {
    Clear,
    /// Стена на сетке уровня стрелка (`has_obstacle_between_on`) или статика
    /// карты на луче.
    Wall,
    /// Цель на уровне, которого пуля не касается, или пуля проходит над/под ней.
    OutOfReach,
    /// Насыпь рампы выше пули раньше цели.
    Embankment,
    /// Союзный танк раньше цели: hitscan остановится на нём (`process_hitscan`).
    Ally(u32),
    /// Ящик/бочка/забор раньше цели.
    Prop,
    /// Дальше дальности оружия (`WeaponConfig::range` у `w1`).
    OutOfRange,
}

/// Дальность пушки: у `w1`, а не у текущего оружия — бомба дальности не имеет.
fn gun_range(game: &BotView<'_>) -> f32 {
    game.weapon_index("w1")
        .and_then(|index| game.weapons.get_index(index))
        .and_then(|(_, weapon)| weapon.range)
        .unwrap_or(DEFAULT_RANGE)
}

pub(crate) fn fire_line(
    game: &BotView<'_>,
    shooter_id: u32,
    my_level: u8,
    target_id: u32,
) -> FireLine {
    let Some(tank) = game.tanks.get(&shooter_id) else {
        return FireLine::Wall;
    };
    let Some(body) = game.world.bodies.get(tank.body) else {
        return FireLine::Wall;
    };
    let Some(target_pos) = game.tank_position_rounded(target_id) else {
        return FireLine::Wall;
    };

    let my_position = body.translation();
    let range = gun_range(game);
    let direction = Vector::new(target_pos[0], target_pos[1]) - my_position;

    if direction.length() > range {
        return FireLine::OutOfRange;
    }

    let visible = game.nav.as_ref().is_some_and(|nav| {
        !nav.has_obstacle_between_on(my_level, [my_position.x, my_position.y], target_pos)
    });

    if !visible {
        return FireLine::Wall;
    }

    // цель на чужом уровне может быть закрыта плитой моста или быть ниже
    // либо выше пули: тогда не стреляем, а идём к ней
    if let Some(levels) = game.levels {
        let Some(target_tank) = game.tanks.get(&target_id) else {
            return FireLine::OutOfReach;
        };
        let dir = direction.normalize_or_zero();
        let bullet = bullet_line(
            tank.level_state.z,
            tank.level_state.slope_vec,
            [dir.x, dir.y],
            tank.barrel_height(),
            0.0,
            levels.level_height(),
        );
        let segments = crate::shot_levels::ray_segments(
            levels,
            [my_position.x, my_position.y],
            [dir.x, dir.y],
            range,
            my_level,
            Some(&bullet),
        );

        let target_distance = direction.length();
        let target_z = target_tank.level_state.z;
        // пол под пулей на дистанции цели — один из уровней, которых касается
        // цель (у стоящей — её уровень, у танка на рампе — оба соседних), и цель
        // дорастает до пули (`shot_height`): танк на земле с моста, танк на мосту
        // с земли и наземный танк под пулей стрелка высоко на склоне не достать —
        // не тратим выстрел
        let covered = (target_z.floor() as u8..=target_z.ceil() as u8)
            .any(|lvl| crate::shot_levels::covers_level(&segments, target_distance, lvl));

        if !covered
            || !crate::shot_height::tank_reaches(
                target_z,
                target_tank.hit_top(),
                levels.level_height(),
                bullet.at(target_distance),
            )
        {
            return FireLine::OutOfReach;
        }

        // насыпь рампы выше пули закрывает цель (`shot_height`): танк высоко на
        // рампе с земли не достать — не тратим выстрел, путь приведёт к нему
        if crate::shot_height::first_embankment_hit(
            levels,
            &segments,
            [my_position.x, my_position.y],
            [dir.x, dir.y],
            &bullet,
        )
        .is_some_and(|hit| hit.t < direction.length())
        {
            return FireLine::Embankment;
        }
    }

    // межуровневый выстрел судят только правила уровней: воздушные сегменты
    // пролетают над пропами
    if game.tank_level(target_id) != my_level {
        return FireLine::Clear;
    }

    physical_line(game, shooter_id, my_level, target_id, target_pos)
}

/// Физический луч от дула к цели, как у `TanksSim::process_hitscan`: что он
/// встретит первым.
fn physical_line(
    game: &BotView<'_>,
    shooter_id: u32,
    my_level: u8,
    target_id: u32,
    target_pos: [f32; 2],
) -> FireLine {
    let Some(tank) = game.tanks.get(&shooter_id) else {
        return FireLine::Wall;
    };
    let Some(body) = game.world.bodies.get(tank.body) else {
        return FireLine::Wall;
    };
    let my_team = tank.team_id;
    let muzzle = tank.muzzle_position(body);
    let to_target = Vector::new(target_pos[0], target_pos[1]) - muzzle;
    let (target_half_length, _) = game.tank_half_extents(target_id);
    let length = to_target.length() + target_half_length;
    let dir = to_target.normalize_or_zero();

    if dir == Vector::ZERO {
        return FireLine::Clear;
    }

    let ray = Ray::new(muzzle, dir * length);
    let mut filter = QueryFilter::new()
        .exclude_sensors()
        .exclude_rigid_body(tank.body);

    if game.levels.is_some_and(|levels| levels.is_layered()) {
        filter = filter.groups(levels_interaction_on_ramp(level_group(my_level)));
    }

    let Some((handle, _)) = game.world.cast_ray(&ray, 1.0, true, filter) else {
        return FireLine::Clear;
    };
    let Some(hit_body) = game
        .world
        .colliders
        .get(handle)
        .and_then(|collider| collider.parent())
        .and_then(|parent| game.world.bodies.get(parent))
    else {
        return FireLine::Wall;
    };

    match BodyTag::decode(hit_body.user_data) {
        Some(BodyTag::Player { game_id, .. }) if game_id == target_id => FireLine::Clear,
        Some(BodyTag::Player { game_id, team_id }) if team_id == my_team => FireLine::Ally(game_id),
        // попасть в другого врага не жалко
        Some(BodyTag::Player { .. }) => FireLine::Clear,
        _ if vimp_engine_core::physics::is_map_object(hit_body.user_data) => FireLine::Prop,
        _ => FireLine::Wall,
    }
}

/// Сведения бота о враге.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub(crate) struct Contact {
    pub id: u32,
    pub pos: [f32; 2],
    pub level: u8,
    /// Скорость известна только у видимого врага; по радару — ноль.
    pub vel: [f32; 2],
    /// Состояние корпуса (3/2/1, `Tank::condition`): его видно на корпусе. У
    /// невидимого — последнее увиденное.
    pub condition: u8,
    pub updated_at: f32,
    pub seen_at: Option<f32>,
    pub visible: bool,
    pub fire_line: FireLine,
    pub aiming_at_me: bool,
}

/// Что бот знает о врагах и о полученном уроне. Обновляется раз в тик
/// решений; `rng` дёргается только на радарном тике, строго по контактам в
/// порядке `id`.
#[derive(Clone, Default, Serialize, Deserialize)]
pub(crate) struct Perception {
    /// Отсортированы по `id`.
    pub contacts: Vec<Contact>,
    radar_timer: f32,
    last_health: f64,
    /// Недавний урон: спадает экспонентой с постоянной 3 с.
    pub damage_recent: f32,
    pub last_damage_at: Option<f32>,
    pub last_attacker: Option<u32>,
}

impl Perception {
    pub(crate) fn update(
        &mut self,
        game: &mut BotView<'_>,
        me: &SelfState,
        profile: &BotProfile,
        clock: f32,
        dt: f32,
    ) {
        let my_team = game.tank_team(me.id);
        let my_pos = me.pos_array();

        // кандидаты: живые враги с телом, по возрастанию id
        let mut enemies: Vec<(u32, [f32; 2], u8)> = game
            .tanks
            .iter()
            .filter(|(id, tank)| **id != me.id && Some(tank.team_id) != my_team && tank.is_alive())
            .filter_map(|(id, _)| {
                game.tank_position_rounded(*id)
                    .map(|pos| (*id, pos, game.tank_level(*id)))
            })
            .collect();

        enemies.sort_by_key(|(id, _, _)| *id);

        // гибель видна: мёртвых и пропавших забыть
        self.contacts
            .retain(|contact| enemies.iter().any(|(id, _, _)| *id == contact.id));

        self.radar_timer -= dt;

        let radar_tick = self.radar_timer <= 0.0;

        if radar_tick {
            self.radar_timer = profile.radar_interval * game.rng.range(0.8, 1.2);
        }

        for &(id, pos, level) in &enemies {
            let visible = dist(my_pos, pos) <= VIEW_RANGE
                && game.nav.as_ref().is_none_or(|nav| {
                    // «взгляд с моста вниз»: у сетки верхнего уровня клетки без
                    // пола непрозрачны, а сквозь плиту игрок видит
                    !nav.has_obstacle_between_on(me.level, my_pos, pos)
                        || !nav.has_obstacle_between_on(level, my_pos, pos)
                });
            let index = self.contacts.iter().position(|contact| contact.id == id);

            if visible {
                let line_of_sight = game
                    .nav
                    .as_ref()
                    .is_none_or(|nav| !nav.has_obstacle_between_on(me.level, my_pos, pos));
                let to_me = angle_of([my_pos[0] - pos[0], my_pos[1] - pos[1]]);
                let aiming_at_me = line_of_sight
                    && normalize_angle(game.gun_world_angle(id) - to_me).abs() < AIMING_AT_ME_ANGLE;
                let contact = Contact {
                    id,
                    pos,
                    level,
                    vel: game.tank_linvel(id),
                    condition: game.tank_condition(id),
                    updated_at: clock,
                    seen_at: Some(clock),
                    visible: true,
                    fire_line: fire_line(game, me.id, me.level, id),
                    aiming_at_me,
                };

                self.put(index, contact);
                continue;
            }

            if radar_tick {
                let n = profile.radar_noise;
                let noisy = [
                    pos[0] + game.rng.range(-n, n),
                    pos[1] + game.rng.range(-n, n),
                ];
                let known = index.map(|i| self.contacts[i]);
                let contact = Contact {
                    id,
                    pos: noisy,
                    level,
                    vel: [0.0, 0.0],
                    // корпус невидимого врага бот не видел: считает целым
                    condition: known.map_or(3, |c| c.condition),
                    updated_at: clock,
                    seen_at: known.and_then(|c| c.seen_at),
                    visible: false,
                    fire_line: FireLine::Wall,
                    aiming_at_me: false,
                };

                self.put(index, contact);
            } else if let Some(i) = index {
                // пропал из виду между радарными тиками: помнится, где видели
                let contact = &mut self.contacts[i];

                contact.visible = false;
                contact.vel = [0.0, 0.0];
                contact.fire_line = FireLine::Wall;
                contact.aiming_at_me = false;
            }
        }

        self.update_damage(game, me, clock, dt);
    }

    /// Вставка или замена контакта с сохранением порядка по `id`.
    fn put(&mut self, index: Option<usize>, contact: Contact) {
        match index {
            Some(i) => self.contacts[i] = contact,
            None => {
                let at = self.contacts.partition_point(|c| c.id < contact.id);

                self.contacts.insert(at, contact);
            }
        }
    }

    /// Урон: сколько потерял, когда и от кого (по тому, что бот видит).
    fn update_damage(&mut self, game: &BotView<'_>, me: &SelfState, clock: f32, dt: f32) {
        let health = game.tank_health(me.id);

        if health < self.last_health {
            self.damage_recent += (self.last_health - health) as f32;
            self.last_damage_at = Some(clock);

            let my_pos = me.pos_array();
            let nearest = |pick: &dyn Fn(&Contact) -> bool| {
                self.contacts
                    .iter()
                    .filter(|c| pick(c))
                    .min_by(|a, b| dist_sq(my_pos, a.pos).total_cmp(&dist_sq(my_pos, b.pos)))
                    .map(|c| c.id)
            };

            self.last_attacker = nearest(&|c| c.visible && c.aiming_at_me)
                .or_else(|| nearest(&|c| c.visible))
                .or_else(|| nearest(&|_| true));
        }

        // и урон, и респаун (здоровье выросло) — просто запомнить
        self.last_health = health;
        self.damage_recent *= (-dt / DAMAGE_DECAY).exp();
    }

    /// Все контакты невидимы (после респауна бот заново осматривается).
    pub(crate) fn forget_sight(&mut self) {
        for contact in &mut self.contacts {
            contact.visible = false;
            contact.aiming_at_me = false;
            contact.fire_line = FireLine::Wall;
        }
    }

    pub(crate) fn contact(&self, id: u32) -> Option<&Contact> {
        self.contacts.iter().find(|contact| contact.id == id)
    }

    pub(crate) fn visible_contacts(&self) -> impl Iterator<Item = &Contact> {
        self.contacts.iter().filter(|contact| contact.visible)
    }

    pub(crate) fn threats_near(
        &self,
        pos: [f32; 2],
        radius: f32,
    ) -> impl Iterator<Item = &Contact> {
        self.contacts
            .iter()
            .filter(move |contact| dist_sq(pos, contact.pos) <= radius * radius)
    }

    /// Ближайший видимый контакт ближе `radius`.
    pub(crate) fn nearest_visible(&self, pos: [f32; 2], radius: f32) -> Option<&Contact> {
        self.threats_near(pos, radius)
            .filter(|contact| contact.visible)
            .min_by(|a, b| dist_sq(pos, a.pos).total_cmp(&dist_sq(pos, b.pos)))
    }

    /// Угрозы для отхода: видимые контакты ближе `radius` и последний
    /// обидчик; по возрастанию `id`.
    pub(crate) fn retreat_threats(&self, pos: [f32; 2], radius: f32) -> Vec<Contact> {
        self.contacts
            .iter()
            .filter(|contact| {
                (contact.visible && dist_sq(pos, contact.pos) <= radius * radius)
                    || self.last_attacker == Some(contact.id)
            })
            .copied()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::bots::test_support::*;

    /// Обновление восприятия бота 1 через `dt` с.
    fn perceive(
        fixture: &mut Fixture,
        perception: &mut Perception,
        profile: &BotProfile,
        clock: f32,
        dt: f32,
    ) {
        let mut view = fixture.view();
        let me = SelfState::read(&view, 1).unwrap();

        perception.update(&mut view, &me, profile, clock, dt);
    }

    #[test]
    fn radar_updates_on_interval_with_noise() {
        let mut fixture = Fixture::new();

        fixture.add_tank(1, 1, 560.0, 300.0, 0);
        // за стеной периметра: невидим
        fixture.add_tank(2, 2, 700.0, 300.0, 0);

        let profile = BotProfile {
            radar_interval: 1.0,
            radar_noise: 20.0,
            ..BotProfile::default()
        };
        let mut perception = Perception::default();
        let max_error = 20.0 * std::f32::consts::SQRT_2;

        perceive(&mut fixture, &mut perception, &profile, 0.1, 0.1);

        let first = *perception.contact(2).expect("радар сработал сразу");

        assert!(!first.visible);
        assert!(dist(first.pos, [700.0, 300.0]) <= max_error);

        fixture.move_tank(2, 800.0, 300.0);

        let mut clock = 0.1;

        for _ in 0..2 {
            clock += 0.25;
            perceive(&mut fixture, &mut perception, &profile, clock, 0.25);
        }

        assert_eq!(
            perception.contact(2).unwrap().pos,
            first.pos,
            "через 0.5 с — прежняя"
        );

        for _ in 0..3 {
            clock += 0.25;
            perceive(&mut fixture, &mut perception, &profile, clock, 0.25);
        }

        let moved = perception.contact(2).unwrap().pos;

        assert!(
            dist(moved, [800.0, 300.0]) <= max_error,
            "через 1.25 с — новая: {moved:?}"
        );
    }

    #[test]
    fn visible_contact_is_exact() {
        let mut fixture = Fixture::new();

        fixture.add_tank(1, 1, 112.0, 112.0, 0);
        fixture.add_tank(2, 2, 300.0, 112.0, 0);

        let mut perception = Perception::default();

        perceive(
            &mut fixture,
            &mut perception,
            &BotProfile::default(),
            0.1,
            0.1,
        );

        let contact = perception.contact(2).unwrap();

        assert!(contact.visible);
        assert_eq!(contact.pos, [300.0, 112.0]);
        assert_eq!(contact.seen_at, Some(0.1));
    }

    #[test]
    fn dead_enemy_is_forgotten() {
        let mut fixture = Fixture::new();

        fixture.add_tank(1, 1, 112.0, 112.0, 0);
        fixture.add_tank(2, 2, 300.0, 112.0, 0);

        let mut perception = Perception::default();
        let profile = BotProfile::default();

        perceive(&mut fixture, &mut perception, &profile, 0.1, 0.1);
        assert!(perception.contact(2).is_some());

        fixture.tanks[&2].condition = 0;
        perceive(&mut fixture, &mut perception, &profile, 0.2, 0.1);

        assert!(perception.contact(2).is_none());
    }

    #[test]
    fn fire_line_out_of_range() {
        let mut fixture = Fixture::new();

        fixture.add_tank(1, 1, 112.0, 112.0, 0);
        fixture.add_tank(2, 2, 1700.0, 112.0, 0);

        let view = fixture.view();

        assert_eq!(fire_line(&view, 1, 0, 2), FireLine::OutOfRange);
    }

    #[test]
    fn fire_line_reports_a_prop() {
        let mut fixture = Fixture::new();

        fixture.add_tank(1, 1, 100.0, 112.0, 0);
        fixture.add_tank(2, 2, 300.0, 112.0, 0);

        // ящик карты между ботом и врагом
        let body = RigidBodyBuilder::dynamic()
            .translation(Vector::new(200.0, 112.0))
            .user_data(vimp_engine_core::physics::MAP_OBJECT_TAG)
            .build();
        let handle = fixture.world.bodies.insert(body);
        let world = &mut fixture.world;

        world.colliders.insert_with_parent(
            ColliderBuilder::cuboid(8.0, 8.0),
            handle,
            &mut world.bodies,
        );
        fixture.sync_queries();

        let view = fixture.view();

        assert_eq!(fire_line(&view, 1, 0, 2), FireLine::Prop);
    }
}
