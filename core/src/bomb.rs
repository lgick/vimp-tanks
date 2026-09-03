use rapier2d::prelude::*;
use serde::{Deserialize, Serialize};

use crate::body_tag::BodyTag;
use crate::config::WeaponConfig;
use vimp_engine_core::config::FieldValue;
use vimp_engine_core::map::level_interaction;
use vimp_engine_core::physics::round2;

/// Строка снапшота бомбы: [x, y, angle, size, time, ownerId, level] (движковый
/// `BlockKind::Indexed32` — форма, не игровая сущность; движок принимает
/// `Vec<FieldValue>` в порядке `w2`-схемы opcodes.js).
pub struct BombRow {
    pub x: f32,
    pub y: f32,
    pub angle: f32,
    pub size: u8,
    pub time: u16,
    pub owner: u8,
    /// Уровень бомбы: клиент рисует её на этом слое.
    pub level: u8,
}

impl BombRow {
    pub fn fields(&self) -> Vec<FieldValue> {
        vec![
            FieldValue::F32(self.x),
            FieldValue::F32(self.y),
            FieldValue::F32(self.angle),
            FieldValue::U8(self.size),
            FieldValue::U16(self.time),
            FieldValue::U8(self.owner),
            FieldValue::U8(self.level),
        ]
    }
}

/// Взрывной снаряд (порт src/server/parts/Bomb.js).
/// Логика детонации — в game.rs (ей нужен доступ к урону и событиям).
#[derive(Serialize, Deserialize)]
pub struct Bomb {
    pub shot_id: u32,
    pub weapon: usize,
    pub owner_id: u32,
    pub team_id: u8,
    /// Уровень, на котором лежит бомба: взрыв поражает только его.
    pub level: u8,
    pub body: RigidBodyHandle,
}

impl Bomb {
    pub fn new(
        world: &mut PhysicsWorld,
        weapon_index: usize,
        weapon: &WeaponConfig,
        shot_id: u32,
        owner_id: u32,
        team_id: u8,
        level: u8,
        position: Vector,
    ) -> Self {
        let tag = BodyTag::Shot {
            shot_id,
            team_id,
            owner_id,
            weapon: weapon_index as u8,
        };

        let body = world.insert_body(
            RigidBodyBuilder::fixed()
                .translation(position)
                .user_data(tag.encode()),
        );

        // сенсор: детектирует контакты, но не участвует в столкновениях;
        // события контактов собирает game (для не-explosive снарядов в будущем)
        world.insert_collider(
            ColliderBuilder::cuboid(weapon.size / 2.0, weapon.size / 2.0)
                .sensor(true)
                .collision_groups(level_interaction(level))
                .active_events(ActiveEvents::COLLISION_EVENTS),
            Some(body),
        );

        Self {
            shot_id,
            weapon: weapon_index,
            owner_id,
            team_id,
            level,
            body,
        }
    }

    /// Строка снапшота (Bomb.getData): [x, y, angle, size, time, ownerId,
    /// level].
    pub fn snapshot_row(&self, world: &PhysicsWorld, weapon: &WeaponConfig) -> BombRow {
        let body = &world.bodies[self.body];
        let pos = body.translation();

        BombRow {
            x: round2(pos.x),
            y: round2(pos.y),
            angle: round2(body.rotation().angle()),
            size: weapon.size as u8,
            time: weapon.time as u16,
            owner: self.owner_id as u8,
            level: self.level,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use vimp_engine_core::map::level_group;

    fn weapon() -> WeaponConfig {
        serde_json::from_value(serde_json::json!({
            "type": "explosive",
            "time": 300,
            "shotOutcomeId": "w2e",
            "size": 8,
            "fireRate": 0.1,
            "damage": 70,
            "radius": 50,
            "impulseMagnitude": 0
        }))
        .unwrap()
    }

    #[test]
    fn bomb_collider_carries_the_level_group() {
        let mut world = PhysicsWorld::new();
        let bomb = Bomb::new(
            &mut world,
            0,
            &weapon(),
            1,
            7,
            1,
            1,
            Vector::new(10.0, 20.0),
        );

        assert_eq!(bomb.level, 1);
        assert_eq!(bomb.snapshot_row(&world, &weapon()).level, 1);

        let handle = world.bodies[bomb.body].colliders()[0];
        let groups = world.colliders[handle].collision_groups();

        assert_eq!(groups.memberships, level_group(1));
        assert_eq!(groups.filter, level_group(1));
        assert!(!groups.memberships.contains(level_group(0)));
    }
}
