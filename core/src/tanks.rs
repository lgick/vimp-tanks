//! Игровая симуляция «танки» поверх движкового каркаса `EngineSim`
//! (core/src/game.rs). Владеет участниками, снарядами, ботами и
//! снапшот-накопителями; движок зовёт callback'ы через `SimCtx`
//! (см. core/src/sim.rs, PLAN.md §3.6).

use indexmap::IndexMap;
use rapier2d::prelude::*;
use serde::{Deserialize, Serialize};

use crate::body_tag::BodyTag;
use crate::bomb::{Bomb, BombRow, BombSpawn};
use crate::bots::controller::BotBrain;
use vimp_engine_core::nav::navigation::NavigationSystem;
use vimp_engine_core::nav::spatial::{SpatialEntity, SpatialGrid};
use crate::config::{LevelRules, ModelConfig, PanelValue, WeaponConfig, WeaponKind, TanksConfig};
use crate::level::{self, LevelEvent};
use vimp_engine_core::config::{FieldValue, PLAYER_STATE_LEN};
use vimp_engine_core::events::CoreEvent;
use vimp_engine_core::map::{level_group, level_interaction, MapLevels};
use vimp_engine_core::physics::{is_map_object, round1, round2};
use vimp_engine_core::rng::Rng;
use vimp_engine_core::sim::{GameDef, GameSim, SimCtx};
use vimp_engine_core::snapshot::Block;
use crate::tank::{PlayerKeyBits, ShotCommand, Tank, TankRow};

/// Маркер игры для `EngineSim<TanksGame>` (единственная игра в дереве).
pub struct TanksGame;

/// Строка снапшота трассера: startX/Y, endX/Y, bodyX/Y + wasHit + shooterId
/// + уровни начала и конца луча (движковый `BlockKind::List16`).
struct TracerRow {
    floats: [f32; 6],
    was_hit: bool,
    shooter: u8,
    start_level: u8,
    end_level: u8,
}

impl TracerRow {
    fn fields(&self) -> Vec<FieldValue> {
        let mut fields: Vec<FieldValue> = self.floats.iter().copied().map(FieldValue::F32).collect();

        fields.push(FieldValue::U8(self.was_hit as u8));
        fields.push(FieldValue::U8(self.shooter));
        fields.push(FieldValue::U8(self.start_level));
        fields.push(FieldValue::U8(self.end_level));
        fields
    }
}

/// Строка снапшота взрыва: x/y/radius + уровень (движковый
/// `BlockKind::List16`, схема `w2e`).
struct ExplosionRow {
    x: f32,
    y: f32,
    radius: f32,
    level: u8,
}

impl ExplosionRow {
    fn fields(&self) -> Vec<FieldValue> {
        vec![
            FieldValue::F32(self.x),
            FieldValue::F32(self.y),
            FieldValue::F32(self.radius),
            FieldValue::U8(self.level),
        ]
    }
}

/// FNV-1a по гридам всех уровней карты. Отпечаток из `setId` и размерности
/// грида не различает две слоёные карты одного размера — все карты танков
/// объявляют `setId: 'c1'`, — а рестарт раунда зовёт `createMap` без
/// `clear()`, поэтому «карта не менялась» приходится доказывать содержимым.
fn levels_checksum(levels: &MapLevels) -> u64 {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;

    let mut hash = OFFSET;
    let mut eat = |value: u64| {
        for byte in value.to_le_bytes() {
            hash ^= byte as u64;
            hash = hash.wrapping_mul(PRIME);
        }
    };

    for level in 0..levels.level_count() as u8 {
        let Some(grid) = levels.grid(level) else {
            continue;
        };

        eat(level as u64);

        for row in grid {
            eat(row.len() as u64);

            for &tile in row {
                eat(tile as i64 as u64);
            }
        }
    }

    hash
}

impl GameDef for TanksGame {
    type Config = TanksConfig;
    type Sim = TanksSim;
}

/// Единственная игра в дереве репозитория — псевдоним для мест, которые
/// раньше работали с монолитным `GameState` (движковый generic-тип не
/// импортирует конкретную игру, см. `vimp_engine_core::game::EngineSim`).
pub type GameState = vimp_engine_core::game::EngineSim<TanksGame>;

/// Вид движковых+игровых ресурсов, которым пользуется ИИ бота
/// (core/src/bots/controller.rs) — имена полей/методов совпадают с
/// прежним монолитным `GameState`, чтобы тело `BotBrain` осталось
/// нетронутым.
pub(crate) struct BotView<'a> {
    pub world: &'a mut PhysicsWorld,
    pub nav: &'a Option<NavigationSystem>,
    pub spatial: &'a SpatialGrid,
    pub rng: &'a mut Rng,
    pub tanks: &'a mut IndexMap<u32, Tank>,
    pub key_bits: &'a PlayerKeyBits,
    pub weapons: &'a IndexMap<String, WeaponConfig>,
    /// Слоистая геометрия карты; `None` — одноуровневая карта.
    pub levels: Option<&'a MapLevels>,
}

impl BotView<'_> {
    pub fn tank_alive(&self, game_id: u32) -> bool {
        self.tanks.get(&game_id).is_some_and(|tank| tank.is_alive())
    }

    pub fn tank_position_rounded(&self, game_id: u32) -> Option<[f32; 2]> {
        let tank = self.tanks.get(&game_id)?;
        let body = self.world.bodies.get(tank.body)?;
        let pos = body.translation();

        Some([round2(pos.x), round2(pos.y)])
    }

    pub fn update_tank_keys(&mut self, game_id: u32, action: &str, bit: u32) {
        if let Some(tank) = self.tanks.get_mut(&game_id) {
            tank.update_keys(action, bit, self.key_bits);
        }
    }

    pub fn weapon_index(&self, name: &str) -> Option<usize> {
        self.weapons.get_index_of(name)
    }

    /// Уровень танка (2.5D-карты); 0 у одноуровневой карты.
    pub fn tank_level(&self, game_id: u32) -> u8 {
        self.tanks
            .get(&game_id)
            .map_or(0, |tank| tank.level_state.level)
    }

    /// Заблокирован ли ввод (танк в падении).
    pub fn tank_input_locked(&self, game_id: u32) -> bool {
        self.tanks
            .get(&game_id)
            .is_some_and(|tank| tank.level_state.input_locked())
    }
}

pub struct TanksSim {
    key_bits: PlayerKeyBits,
    player_keys: IndexMap<String, crate::config::KeyConfig>,
    friendly_fire: bool,
    models: IndexMap<String, ModelConfig>,
    weapons: IndexMap<String, WeaponConfig>,
    panel: IndexMap<String, PanelValue>,
    pub(crate) tanks: IndexMap<u32, Tank>,
    bots: IndexMap<u32, BotBrain>,

    shots: IndexMap<u32, Bomb>,
    shots_at_time: Vec<Vec<u32>>,
    current_shot_id: u32,
    current_step_tick: usize,
    max_shot_time_in_steps: usize,

    new_tracers: IndexMap<usize, Vec<TracerRow>>,
    new_bombs: IndexMap<usize, IndexMap<u32, Option<BombRow>>>,
    weapon_effects: IndexMap<String, Vec<ExplosionRow>>,
    pending_null_tanks: Vec<(String, u32)>,

    cached_players: IndexMap<u32, (String, TankRow)>,

    level_rules: LevelRules,
    /// Слоистая геометрия текущей карты. `None` — карта ещё не приезжала
    /// или она одноуровневая. Обновляется в `on_fixed_step` по карте из
    /// `SimCtx` (у `spawn_actor` карты нет вовсе).
    levels: Option<MapLevels>,
    /// Отпечаток карты, из которой снята копия слоёв: setId, размерность
    /// грида уровня 0 и контрольная сумма гридов всех уровней. Сменился —
    /// слои пересобираются.
    levels_fingerprint: Option<(String, usize, usize, u64)>,
    /// Танки, заспавненные до того, как слои доехали, — им уровень
    /// назначается первым же `update_levels`.
    levels_dirty: bool,
}

impl GameSim<TanksGame> for TanksSim {
    fn new(cfg: &TanksConfig, engine_cfg: &vimp_engine_core::config::EngineConfig) -> Self {
        let max_lifetime_ms = cfg
            .weapons
            .values()
            .filter(|w| w.kind != WeaponKind::Hitscan)
            .map(|w| w.time)
            .fold(0.0f32, f32::max);

        let max_lifetime_with_buffer = (max_lifetime_ms / 1000.0) * 1.5;
        let max_shot_time_in_steps =
            ((max_lifetime_with_buffer / engine_cfg.time_step).ceil() as usize).max(1);

        Self {
            key_bits: PlayerKeyBits::from_config(&cfg.player_keys),
            player_keys: cfg.player_keys.clone(),
            friendly_fire: cfg.friendly_fire,
            models: cfg.models.clone(),
            weapons: cfg.weapons.clone(),
            panel: cfg.panel.clone(),
            tanks: IndexMap::new(),
            bots: IndexMap::new(),
            shots: IndexMap::new(),
            shots_at_time: vec![Vec::new(); max_shot_time_in_steps],
            current_shot_id: 0,
            current_step_tick: 0,
            max_shot_time_in_steps,
            new_tracers: IndexMap::new(),
            new_bombs: IndexMap::new(),
            weapon_effects: IndexMap::new(),
            pending_null_tanks: Vec::new(),
            cached_players: IndexMap::new(),
            level_rules: cfg.levels,
            levels: None,
            levels_fingerprint: None,
            levels_dirty: false,
        }
    }

    fn spawn_actor(
        &mut self,
        world: &mut PhysicsWorld,
        events: &mut Vec<CoreEvent>,
        game_id: u32,
        model_name: &str,
        team_id: u8,
        x: f32,
        y: f32,
        angle_deg: f32,
    ) -> Result<(), String> {
        let model = self
            .models
            .get(model_name)
            .ok_or_else(|| format!("unknown model '{model_name}'"))?
            .clone();

        let tank = Tank::new(
            world, &self.weapons, &self.panel, model_name, &model, game_id, team_id, x, y, angle_deg,
        );

        events.push(CoreEvent::PanelActive {
            id: game_id,
            field: self
                .weapons
                .get_index(tank.current_weapon)
                .map(|(name, _)| name.clone())
                .unwrap_or_default(),
        });
        events.push(CoreEvent::PanelSet {
            id: game_id,
            field: "health".to_string(),
            value: tank.health,
        });

        self.tanks.insert(game_id, tank);

        // карта уже могла приехать: назначаем уровень по геометрии сразу,
        // иначе первый кадр покажет танк на земле внутри плиты моста
        self.apply_geometry_level(world, game_id, x, y);

        Ok(())
    }

    fn remove_actor(&mut self, world: &mut PhysicsWorld, game_id: u32) {
        if let Some(tank) = self.tanks.shift_remove(&game_id) {
            world.remove_body(tank.body);
            self.cached_players.shift_remove(&game_id);
            self.pending_null_tanks.push((tank.model, game_id));
        }
    }

    fn reset_actor(&mut self, world: &mut PhysicsWorld, game_id: u32, team_id: u8, x: f32, y: f32, angle_deg: f32) {
        if let Some(tank) = self.tanks.get_mut(&game_id) {
            if let Some(body) = world.bodies.get_mut(tank.body) {
                tank.change_player_data(team_id, x, y, angle_deg, body);
            }
        }

        self.apply_geometry_level(world, game_id, x, y);
    }

    fn set_actor_level(&mut self, world: &mut PhysicsWorld, game_id: u32, level: u8) {
        if let Some(tank) = self.tanks.get_mut(&game_id) {
            tank.set_level(level);
            tank.sync_collision_groups(world);
        }
    }

    fn reset_all_vitals(&mut self, events: &mut Vec<CoreEvent>) {
        let panel = &self.panel;
        let weapons = &self.weapons;

        for tank in self.tanks.values_mut() {
            tank.reset_vitals(panel, weapons, events);
        }
    }

    fn spawn_scripted_actor(
        &mut self,
        world: &mut PhysicsWorld,
        rng: &mut Rng,
        events: &mut Vec<CoreEvent>,
        game_id: u32,
        model_name: &str,
        team_id: u8,
        x: f32,
        y: f32,
        angle_deg: f32,
    ) -> Result<(), String> {
        self.spawn_actor(world, events, game_id, model_name, team_id, x, y, angle_deg)?;

        if !self.bots.contains_key(&game_id) {
            let brain = BotBrain::new(game_id, rng);

            self.bots.insert(game_id, brain);
        }

        Ok(())
    }

    fn remove_scripted_actor(&mut self, world: &mut PhysicsWorld, game_id: u32) {
        self.bots.shift_remove(&game_id);
        self.remove_actor(world, game_id);
    }

    fn apply_input(&mut self, game_id: u32, seq: u32, action: &str, key_name: &str) {
        let bit = self.player_keys.get(key_name).map(|k| k.key).unwrap_or(0);

        if let Some(tank) = self.tanks.get_mut(&game_id) {
            tank.last_input_seq = seq;
            tank.update_keys(action, bit, &self.key_bits);
        }
    }

    fn last_input_seq(&self, game_id: u32) -> u32 {
        self.tanks.get(&game_id).map(|tank| tank.last_input_seq).unwrap_or(0)
    }

    fn is_alive(&self, game_id: u32) -> bool {
        self.tanks.get(&game_id).is_some_and(|tank| tank.is_alive())
    }

    fn actor_position(&self, world: &PhysicsWorld, game_id: u32) -> Option<[f32; 2]> {
        let tank = self.tanks.get(&game_id)?;
        let body = world.bodies.get(tank.body)?;
        let pos = body.translation();

        Some([round2(pos.x), round2(pos.y)])
    }

    fn prediction_state(&self, world: &PhysicsWorld, game_id: u32) -> Option<([f32; PLAYER_STATE_LEN], bool)> {
        let tank = self.tanks.get(&game_id)?;
        let body = world.bodies.get(tank.body)?;

        Some(tank.prediction_state(body))
    }

    fn alive_players_flat(&self, world: &PhysicsWorld) -> Vec<f32> {
        let mut out = Vec::new();

        for (id, tank) in &self.tanks {
            if !tank.is_alive() {
                continue;
            }

            let Some(body) = world.bodies.get(tank.body) else {
                continue;
            };
            let pos = body.translation();

            out.push(*id as f32);
            out.push(tank.team_id as f32);
            out.push(round2(pos.x));
            out.push(round2(pos.y));
        }

        out
    }

    fn players_json(&self) -> String {
        use serde_json::{Map, Value};

        let mut by_model: Map<String, Value> = Map::new();

        for (game_id, (model, row)) in &self.cached_players {
            // полный порядок полей схемы m1: 7 float, condition, size,
            // team, angvel, z, level, vz, pitch, roll. Раньше метод
            // обрывался на team, из-за чего первый кадр (FIRST_SHOT_DATA) и
            // бинарные кадры имели разную ширину строки — с приходом level
            // это стало ошибкой
            let mut arr: Vec<Value> = Vec::with_capacity(16);

            for value in row.floats {
                arr.push(Value::from(value as f64));
            }

            arr.push(Value::from(row.condition));
            arr.push(Value::from(row.size));
            arr.push(Value::from(row.team));
            arr.push(Value::from(row.angvel as f64));
            arr.push(Value::from(row.z as f64));
            arr.push(Value::from(row.level));
            arr.push(Value::from(row.vz as f64));
            arr.push(Value::from(row.pitch as f64));
            arr.push(Value::from(row.roll as f64));

            by_model
                .entry(model.clone())
                .or_insert_with(|| Value::Object(Map::new()))
                .as_object_mut()
                .unwrap()
                .insert(game_id.to_string(), Value::Array(arr));
        }

        Value::Object(by_model).to_string()
    }

    fn on_fixed_step(&mut self, ctx: &mut SimCtx, dt: f32) {
        // слои карты приезжают вместе с картой, а `spawn_actor` карты не
        // видит: держим копию геометрии и пересчитываем уровни всех танков,
        // когда она сменилась
        self.sync_levels(ctx);
        self.update_levels(ctx, dt);

        let ids: Vec<u32> = self.tanks.keys().copied().collect();

        for id in ids {
            let shot;

            {
                let Some(tank) = self.tanks.get_mut(&id) else {
                    continue;
                };
                let Some(body) = ctx.world.bodies.get_mut(tank.body) else {
                    continue;
                };
                let Some(model) = self.models.get(&tank.model) else {
                    continue;
                };

                shot = tank.update(
                    dt,
                    body,
                    model,
                    &self.weapons,
                    &self.key_bits,
                    &self.level_rules,
                    ctx.rng,
                    ctx.events,
                );
            }

            if let Some(shot) = shot {
                let weapon_index = self.tanks[&id].current_weapon;
                let kind = self.weapons[weapon_index].kind;

                match kind {
                    WeaponKind::Hitscan => {
                        let tracer = self.process_hitscan(ctx, id, weapon_index, &shot);

                        self.new_tracers.entry(weapon_index).or_default().push(tracer);
                    }
                    WeaponKind::Explosive => {
                        let (shot_id, row) = self.create_weapon_action(ctx, id, weapon_index, &shot);

                        self.new_bombs
                            .entry(weapon_index)
                            .or_default()
                            .insert(shot_id, Some(row));
                    }
                }
            }
        }

        self.process_shots_expired_by_time(ctx);
    }

    fn on_contacts(&mut self, ctx: &mut SimCtx, pairs: &[(ColliderHandle, ColliderHandle)]) {
        for &(h1, h2) in pairs {
            let tag_of = |handle: ColliderHandle| {
                ctx.world
                    .colliders
                    .get(handle)
                    .and_then(|collider| collider.parent())
                    .and_then(|parent| {
                        ctx.world
                            .bodies
                            .get(parent)
                            .map(|body| (parent, BodyTag::decode(body.user_data)))
                    })
            };

            let Some((body_a, tag_a)) = tag_of(h1) else {
                continue;
            };
            let Some((body_b, tag_b)) = tag_of(h2) else {
                continue;
            };

            let (player_tag, shot_tag, shot_body) = match (tag_a, tag_b) {
                (
                    Some(BodyTag::Player { game_id, .. }),
                    Some(BodyTag::Shot { shot_id, owner_id, weapon, .. }),
                ) => (game_id, (shot_id, owner_id, weapon), body_b),
                (
                    Some(BodyTag::Shot { shot_id, owner_id, weapon, .. }),
                    Some(BodyTag::Player { game_id, .. }),
                ) => (game_id, (shot_id, owner_id, weapon), body_a),
                _ => continue,
            };

            let (_, owner_id, weapon_index) = shot_tag;
            let weapon_index = weapon_index as usize;

            if self
                .weapons
                .get_index(weapon_index)
                .is_some_and(|(_, w)| w.kind == WeaponKind::Explosive)
            {
                continue;
            }

            if ctx.bodies_to_destroy.contains(&shot_body) {
                continue;
            }

            self.apply_damage(ctx, player_tag, owner_id, weapon_index, None);
            ctx.bodies_to_destroy.push(shot_body);
        }
    }

    fn on_before_destroy(&mut self, world: &PhysicsWorld, handle: RigidBodyHandle) {
        let tag = world.bodies.get(handle).and_then(|body| BodyTag::decode(body.user_data));

        if let Some(BodyTag::Shot { shot_id, weapon, .. }) = tag {
            self.shots.shift_remove(&shot_id);
            self.new_bombs
                .entry(weapon as usize)
                .or_default()
                .insert(shot_id, None);
        }
    }

    fn on_ai_tick(&mut self, ctx: &mut SimCtx, dt: f32) {
        if self.bots.is_empty() {
            return;
        }

        let ids: Vec<u32> = self.bots.keys().copied().collect();

        for id in ids {
            if let Some(mut brain) = self.bots.shift_remove(&id) {
                let mut view = crate::tanks::BotView {
                    world: &mut *ctx.world,
                    nav: ctx.nav,
                    spatial: &*ctx.spatial,
                    rng: &mut *ctx.rng,
                    tanks: &mut self.tanks,
                    key_bits: &self.key_bits,
                    weapons: &self.weapons,
                    levels: self.levels.as_ref(),
                };

                brain.update(&mut view, dt);
                self.bots.insert(id, brain);
            }
        }

        self.rebuild_spatial_grid(ctx.world, ctx.spatial);
    }

    fn refresh_cached(&mut self, world: &PhysicsWorld) {
        for (game_id, tank) in &self.tanks {
            let Some(body) = world.bodies.get(tank.body) else {
                continue;
            };
            let Some(model) = self.models.get(&tank.model) else {
                continue;
            };

            self.cached_players
                .insert(*game_id, (tank.model.clone(), tank.snapshot_row(body, model.size)));
        }
    }

    fn build_snapshot_blocks(&mut self) -> (Vec<(String, Block)>, bool) {
        let mut blocks: Vec<(String, Block)> = Vec::new();
        let mut has_events = !self.pending_null_tanks.is_empty();

        let mut tanks_by_model: IndexMap<String, Vec<(u8, Option<TankRow>)>> = IndexMap::new();

        for (game_id, (model, row)) in &self.cached_players {
            tanks_by_model
                .entry(model.clone())
                .or_default()
                .push((*game_id as u8, Some(*row)));
        }

        for (model, game_id) in self.pending_null_tanks.drain(..) {
            tanks_by_model.entry(model).or_default().push((game_id as u8, None));
        }

        for (model, rows) in tanks_by_model {
            let rows = rows
                .into_iter()
                .map(|(id, row)| (id, row.map(|r| r.fields())))
                .collect();

            blocks.push((model, Block::Indexed8(rows)));
        }

        for (weapon_index, tracers) in self.new_tracers.drain(..) {
            if tracers.is_empty() {
                continue;
            }

            has_events = true;

            let name = self.weapons.get_index(weapon_index).unwrap().0.clone();
            let rows = tracers.iter().map(TracerRow::fields).collect();

            blocks.push((name, Block::List16(rows)));
        }

        for (weapon_index, bombs) in self.new_bombs.drain(..) {
            if bombs.is_empty() {
                continue;
            }

            has_events = true;

            let name = self.weapons.get_index(weapon_index).unwrap().0.clone();
            let rows = bombs
                .into_iter()
                .map(|(id, row)| (id, row.map(|r| r.fields())))
                .collect();

            blocks.push((name, Block::Indexed32(rows)));
        }

        for (outcome_id, explosions) in self.weapon_effects.drain(..) {
            if explosions.is_empty() {
                continue;
            }

            has_events = true;

            let rows = explosions.iter().map(ExplosionRow::fields).collect();

            blocks.push((outcome_id, Block::List16(rows)));
        }

        (blocks, has_events)
    }

    fn remove_players_and_shots(&mut self, world: &mut PhysicsWorld) -> Vec<String> {
        let mut names: Vec<String> = Vec::new();

        for name in self.remove_shots(world) {
            if !names.contains(&name) {
                names.push(name);
            }
        }

        // все сконфигурированные модели, а не только модели живых танков:
        // иначе сразу после смены карты живых нет и частичный CLEAR не
        // чистит модельный набор на клиенте
        for name in self.models.keys() {
            if !names.contains(name) {
                names.push(name.clone());
            }
        }

        let tanks: Vec<Tank> = self.tanks.drain(..).map(|(_, tank)| tank).collect();

        for tank in tanks {
            world.remove_body(tank.body);
        }

        self.cached_players.clear();

        for name in self.weapons.keys() {
            if !names.contains(name) {
                names.push(name.clone());
            }
        }

        for weapon in self.weapons.values() {
            if let Some(outcome_id) = &weapon.shot_outcome_id {
                if !names.contains(outcome_id) {
                    names.push(outcome_id.clone());
                }
            }
        }

        names
    }

    fn clear(&mut self) {
        self.tanks.clear();
        self.bots.clear();

        self.new_tracers.clear();
        self.new_bombs.clear();
        self.weapon_effects.clear();
        self.pending_null_tanks.clear();
        self.cached_players.clear();

        self.current_shot_id = 0;
        self.shots.clear();

        for slot in &mut self.shots_at_time {
            slot.clear();
        }

        self.current_step_tick = 0;

        self.levels = None;
        self.levels_fingerprint = None;
        self.levels_dirty = false;
    }

    fn serialize(&self) -> serde_json::Value {
        let dump = TanksDump {
            tanks: &self.tanks,
            bots: &self.bots,
            shots: &self.shots,
            shots_at_time: &self.shots_at_time,
            current_shot_id: self.current_shot_id,
            current_step_tick: self.current_step_tick,
        };

        serde_json::to_value(dump).unwrap_or(serde_json::Value::Null)
    }

    fn deserialize(&mut self, value: serde_json::Value) -> Result<(), String> {
        let dump: TanksDumpOwned = serde_json::from_value(value).map_err(|e| e.to_string())?;

        self.tanks = dump.tanks;
        self.bots = dump.bots;
        self.shots = dump.shots;
        self.shots_at_time = dump.shots_at_time;
        self.current_shot_id = dump.current_shot_id;
        self.current_step_tick = dump.current_step_tick;

        self.new_tracers.clear();
        self.new_bombs.clear();
        self.weapon_effects.clear();
        self.pending_null_tanks.clear();
        self.cached_players.clear();

        // слои в дамп не едут (карта восстанавливается своим путём):
        // уровни танков пересчитает первый же `update_levels`
        self.levels_dirty = true;

        Ok(())
    }

    fn rebuild_spatial_grid(&self, world: &PhysicsWorld, spatial: &mut SpatialGrid) {
        spatial.clear();

        for (game_id, tank) in &self.tanks {
            if !tank.is_alive() {
                continue;
            }

            if let Some(body) = world.bodies.get(tank.body) {
                let pos = body.translation();

                spatial.insert(SpatialEntity {
                    game_id: *game_id,
                    team_id: tank.team_id,
                    x: round2(pos.x),
                    y: round2(pos.y),
                });
            }
        }
    }
}

impl TanksSim {
    /// Синхронизирует копию слоёв с картой из `SimCtx`. Отпечаток —
    /// `setId` + размерность грида уровня 0: карта сменилась, значит
    /// геометрию уровней надо пересобрать, а танкам переназначить уровень.
    fn sync_levels(&mut self, ctx: &SimCtx) {
        let layered = ctx.map.as_ref().filter(|map| map.is_layered());
        let fingerprint = layered.map(|map| {
            (
                map.set_id.clone(),
                map.grid.len(),
                map.grid.first().map_or(0, |row| row.len()),
                levels_checksum(map.levels()),
            )
        });

        if fingerprint == self.levels_fingerprint {
            return;
        }

        self.levels = layered.map(|map| map.levels().clone());
        self.levels_fingerprint = fingerprint;
        self.levels_dirty = true;
    }

    /// Правила уровней для всех танков: рампы, обрывы, падение, маски
    /// коллизий. Идёт ДО применения ввода — маска обязана быть верной для
    /// наступающего шага физики.
    fn update_levels(&mut self, ctx: &mut SimCtx, dt: f32) {
        let dirty = self.levels_dirty;

        // заимствования слоёв и танков разводятся по полям: слои не нужно
        // вынимать из `self`, и ранний выход из обхода не может их потерять
        // (геометрия за шаг всё равно не меняется)
        let Self {
            levels,
            tanks,
            level_rules,
            ..
        } = self;

        let Some(levels) = levels.as_ref() else {
            return;
        };

        // урон приземления правит `self` целиком, поэтому он откладывается
        // до конца обхода; порядок событий тот же — внутри обхода их никто
        // больше не пишет
        let mut landed: Vec<(u32, f32, f32)> = Vec::new();

        for (id, tank) in tanks.iter_mut() {
            let Some(body) = ctx.world.bodies.get(tank.body) else {
                continue;
            };
            let pos = body.translation();
            // курс нужен опоре: срыв с обрыва судит габарит корпуса
            let footprint = tank.footprint(body.rotation().angle());

            if dirty {
                tank.set_level(levels.level_at(pos.x, pos.y));
            }

            let before = tank.level_state;
            let vel = body.linvel();
            let event = level::step_level(
                &mut tank.level_state,
                pos.x,
                pos.y,
                [vel.x, vel.y],
                &footprint,
                levels,
                level_rules,
                dt,
            );

            // не только маска уровней: смена «еду по прогону» открывает и
            // закрывает стражей прогона при неизменной маске
            if dirty
                || tank.level_state.collision_mask() != before.collision_mask()
                || tank.level_state.on_ramp() != before.on_ramp()
            {
                tank.sync_collision_groups(ctx.world);
            }

            if let LevelEvent::Landed { height, impact } = event {
                landed.push((*id, height, impact));
            }
        }

        self.levels_dirty = false;

        for (id, height, impact) in landed {
            self.push_landing_shake(ctx, id, impact);
            self.apply_fall_damage(ctx, id, height, impact);
        }
    }

    /// Тряска камеры тому, кто приземлился. Второй источник
    /// `CoreEvent::Shake` рядом с `weapon.camera_shake`: партам движок не
    /// раздаёт «тряхнуть камеру», поэтому правило авторитетно и живёт в
    /// ядре. Реплика (`client::predictor`) событий не собирает и
    /// приземление игнорирует — двойной тряски быть не может.
    fn push_landing_shake(&mut self, ctx: &mut SimCtx, game_id: u32, impact: f32) {
        let Some(shake) = &self.level_rules.landing_shake else {
            return;
        };

        let span = shake.full_impact - shake.min_impact;

        if span <= 0.0 {
            return;
        }

        // тот же порог, по которому клиент не даёт ни просадки, ни пыли,
        // ни звука: мягкое касание камеру не трогает
        let k = ((impact - shake.min_impact) / span).clamp(0.0, 1.0);

        if k <= 0.0 {
            return;
        }

        ctx.events.push(CoreEvent::Shake {
            id: game_id,
            intensity: shake.intensity * k as f64,
            duration: shake.duration,
        });
    }

    /// Урон при приземлении после падения с моста. Стрелка нет — урон
    /// приходит от самой карты, поэтому дружественный огонь и тряска
    /// оружия не при чём, а смерть засчитывается как самоубийство.
    fn apply_fall_damage(&mut self, ctx: &mut SimCtx, game_id: u32, height: f32, _impact: f32) {
        // урон пропорционален высоте падения от вершины дуги и зажат
        // потолком: падение с уровня 1 стоит ровно `fallDamage`, как в
        // первой итерации
        let damage = (self.level_rules.fall_damage * height as f64)
            .min(self.level_rules.max_fall_damage);

        if damage <= 0.0 {
            return;
        }

        let destroyed = {
            let Some(tank) = self.tanks.get_mut(&game_id) else {
                return;
            };
            let Some(body) = ctx.world.bodies.get_mut(tank.body) else {
                return;
            };

            tank.take_damage(damage, body, ctx.events)
        };

        if destroyed {
            ctx.events.push(CoreEvent::Death {
                victim: game_id,
                killer: game_id,
            });
        }
    }

    /// Уровень танка по геометрии карты (спавн/респаун): слои у `TanksSim`
    /// могут ещё не приехать — тогда уровень назначит `update_levels`.
    fn apply_geometry_level(&mut self, world: &mut PhysicsWorld, game_id: u32, x: f32, y: f32) {
        let Some(levels) = self.levels.as_ref() else {
            return;
        };
        let level = levels.level_at(x, y);

        if let Some(tank) = self.tanks.get_mut(&game_id) {
            tank.set_level(level);
            tank.sync_collision_groups(world);
        }
    }

    /// Мгновенный выстрел лучом (порт HitscanService.processShot).
    fn process_hitscan(&mut self, ctx: &mut SimCtx, shooter_id: u32, weapon_index: usize, shot: &ShotCommand) -> TracerRow {
        let weapon = self.weapons[weapon_index].clone();
        let range = weapon.range.unwrap_or(1000.0);
        // величина импульса — не зависит от дальности оружия (см. weapons.js);
        // раньше умножалась на вектор луча длиной range, из-за чего дальнобойное
        // оружие расшвыривало динамику карты кратно сильнее ближнего без единой
        // настраиваемой причины
        let impulse_magnitude = weapon.impulse_magnitude;

        // shot.direction нормализован (Tank::fire_direction): дистанция вдоль
        // луча измеряется в мировых единицах, а импульс строится от него же
        let dir = shot.direction;
        let origin = shot.start_point;
        let end_point_ray = origin + dir * range;

        let shooter_body = self.tanks[&shooter_id].body;
        let start_level = self.tanks[&shooter_id].level_state.level;

        let layered = self.levels.as_ref().is_some_and(MapLevels::is_layered);
        let segments = match self.levels.as_ref() {
            Some(levels) => crate::shot_levels::ray_segments(
                levels,
                [origin.x, origin.y],
                [dir.x, dir.y],
                range,
                start_level,
            ),
            None => vec![crate::shot_levels::RaySegment { t0: 0.0, t1: range, level: 0 }],
        };

        // ближайшее попадание среди сегментов: сегменты уровней 0 и 1
        // перекрываются у кромки плиты, минимальная дистанция выигрывает
        let mut hit: Option<(ColliderHandle, f32, u8)> = None;

        for segment in &segments {
            let length = segment.t1 - segment.t0;

            if length <= 0.0 {
                continue;
            }

            let ray = Ray::new(origin + dir * segment.t0, dir * length);
            let mut filter = QueryFilter::new().exclude_sensors().exclude_rigid_body(shooter_body);

            // одноуровневая карта фильтр по группам не ставит вовсе —
            // путь стрельбы обязан остаться прежним бит-в-бит
            if layered {
                filter = filter.groups(level_interaction(segment.level));
            }

            if let Some((collider_handle, toi)) = ctx.world.cast_ray(&ray, 1.0, true, filter) {
                let distance = segment.t0 + toi * length;

                if hit.is_none_or(|(_, best, _)| distance < best) {
                    hit = Some((collider_handle, distance, segment.level));
                }
            }
        }

        let was_hit = hit.is_some();
        let mut end_x = round1(end_point_ray.x);
        let mut end_y = round1(end_point_ray.y);
        // промах: уровень, действующий В КОНЦЕ луча, а не последний в
        // списке — проба уровня 1 у кромки плиты лежит внутри наземного
        // сегмента и последней в списке идёт именно она, из-за чего
        // наземный трассер рисовался бы на слое моста
        let mut end_level =
            crate::shot_levels::level_at_distance(&segments, range).unwrap_or(start_level);

        if let Some((collider_handle, distance, level)) = hit {
            let impact = origin + dir * distance;

            end_x = round1(impact.x);
            end_y = round1(impact.y);
            end_level = level;

            let hit_body_handle = ctx
                .world
                .colliders
                .get(collider_handle)
                .and_then(|collider| collider.parent());

            if let Some(handle) = hit_body_handle {
                let mut hit_player: Option<u32> = None;

                if let Some(body) = ctx.world.bodies.get_mut(handle) {
                    // если тело динамическое, то применение физического импульса
                    // (от нормализованного направления — величина не зависит от range)
                    if impulse_magnitude > 0.0 && body.is_dynamic() {
                        body.apply_impulse_at_point(dir * impulse_magnitude, impact, true);
                    }

                    if let Some(BodyTag::Player { game_id, .. }) = BodyTag::decode(body.user_data) {
                        hit_player = Some(game_id);
                    }
                }

                if let Some(target) = hit_player {
                    self.apply_damage(ctx, target, shooter_id, weapon_index, None);
                }
            }
        }

        TracerRow {
            floats: [
                round2(origin.x),
                round2(origin.y),
                end_x,
                end_y,
                round2(shot.body_position.x),
                round2(shot.body_position.y),
            ],
            was_hit,
            shooter: shooter_id as u8,
            start_level,
            end_level,
        }
    }

    /// Создаёт взрывной снаряд (Game._createWeaponAction).
    fn create_weapon_action(&mut self, ctx: &mut SimCtx, owner_id: u32, weapon_index: usize, shot: &ShotCommand) -> (u32, BombRow) {
        let weapon = self.weapons[weapon_index].clone();
        let lifetime_seconds = weapon.time / 1000.0;
        let mut lifetime_in_steps = (lifetime_seconds / ctx.cfg.time_step).ceil() as usize;

        if lifetime_in_steps < 1 {
            lifetime_in_steps = 1;
        }

        if lifetime_in_steps >= self.max_shot_time_in_steps {
            lifetime_in_steps = self.max_shot_time_in_steps - 1;
        }

        self.current_shot_id += 1;

        let shot_id = self.current_shot_id;
        let removal_tick = (self.current_step_tick + lifetime_in_steps) % self.max_shot_time_in_steps;
        let team_id = self.tanks[&owner_id].team_id;

        let owner = &self.tanks[&owner_id];
        // правило уровня бомбы — общее с клиентской репликой
        // (`level::bomb_level`)
        let level = level::bomb_level(
            self.levels.as_ref(),
            owner.level_state.level,
            shot.body_position.x,
            shot.body_position.y,
            owner.level_state.input_locked(),
        );

        let bomb = Bomb::new(
            ctx.world,
            &weapon,
            BombSpawn {
                weapon_index,
                shot_id,
                owner_id,
                team_id,
                level,
                position: shot.body_position,
            },
        );
        let row = bomb.snapshot_row(ctx.world, &weapon);

        self.shots.insert(shot_id, bomb);
        self.shots_at_time[removal_tick].push(shot_id);

        (shot_id, row)
    }

    /// Обрабатывает снаряды с истёкшим временем жизни (детонация).
    fn process_shots_expired_by_time(&mut self, ctx: &mut SimCtx) {
        let shot_ids = std::mem::take(&mut self.shots_at_time[self.current_step_tick]);

        for shot_id in shot_ids {
            let Some(bomb) = self.shots.shift_remove(&shot_id) else {
                continue;
            };

            let weapon_index = bomb.weapon;
            let weapon = self.weapons[weapon_index].clone();

            if let Some(outcome_id) = weapon.shot_outcome_id.clone() {
                let explosion = self.detonate(ctx, &bomb, weapon_index);

                self.weapon_effects.entry(outcome_id).or_default().push(explosion);
            }

            ctx.world.remove_body(bomb.body);

            self.new_bombs.entry(weapon_index).or_default().insert(shot_id, None);
        }

        self.current_step_tick = (self.current_step_tick + 1) % self.max_shot_time_in_steps;
    }

    /// Детонация бомбы (порт Bomb.detonate): урон/импульс по целям в
    /// радиусе, данные взрыва для клиента.
    fn detonate(&mut self, ctx: &mut SimCtx, bomb: &Bomb, weapon_index: usize) -> ExplosionRow {
        let weapon = &self.weapons[weapon_index];
        let radius = weapon.radius;
        let damage = weapon.damage;
        let impulse_magnitude = weapon.impulse_magnitude;
        let friendly_fire = self.friendly_fire;
        // маска уровня бомбы: читается ДО цикла — внутри занят ctx.world
        let bomb_bit = self
            .levels
            .as_ref()
            .filter(|levels| levels.is_layered())
            .map(|_| level_group(bomb.level));

        let bomb_position = ctx.world.bodies[bomb.body].translation();

        struct Target {
            handle: RigidBodyHandle,
            // None — динамика карты: импульс без урона
            tag: Option<BodyTag>,
            distance: f32,
        }

        let mut targets: Vec<Target> = Vec::new();

        {
            let aabb = Aabb::from_half_extents(bomb_position, Vector::new(radius, radius));

            for (_collider_handle, collider) in ctx.world.intersect_aabb_conservative(aabb, QueryFilter::new()) {
                let Some(parent) = collider.parent() else {
                    continue;
                };

                if parent == bomb.body {
                    continue;
                }

                // уровень цели — из масок её коллайдера: плита моста
                // экранирует взрыв в обе стороны
                if let Some(bit) = bomb_bit {
                    if !collider.collision_groups().memberships.intersects(bit) {
                        continue;
                    }
                }

                let Some(body) = ctx.world.bodies.get(parent) else {
                    continue;
                };

                if !body.is_dynamic() {
                    continue;
                }

                let tag = BodyTag::decode(body.user_data);

                // тело без метки вовсе целью не считается (JS: !userData?.type)
                if tag.is_none() && !is_map_object(body.user_data) {
                    continue;
                }

                let distance = (body.translation() - bomb_position).length();

                if distance < radius && !targets.iter().any(|t| t.handle == parent) {
                    targets.push(Target { handle: parent, tag, distance });
                }
            }
        }

        for target in targets {
            let falloff = 1.0 - target.distance / radius;
            let actual_damage = (damage * falloff as f64).round();
            let actual_impulse = impulse_magnitude * falloff;

            if let Some(BodyTag::Player { game_id, team_id }) = target.tag {
                if friendly_fire || bomb.team_id != team_id {
                    self.apply_damage(ctx, game_id, bomb.owner_id, weapon_index, Some(actual_damage));
                }
            }

            if actual_impulse > 0.0 && target.distance > 0.0 {
                if let Some(body) = ctx.world.bodies.get_mut(target.handle) {
                    let direction = (body.translation() - bomb_position).normalize_or_zero();
                    let impulse_vector = direction * actual_impulse;
                    let point = body.translation();

                    body.apply_impulse_at_point(impulse_vector, point, true);
                }
            }
        }

        ExplosionRow {
            x: round1(bomb_position.x),
            y: round1(bomb_position.y),
            radius,
            level: bomb.level,
        }
    }

    /// Урон игроку (Game.applyDamage): дружественный огонь, тряска
    /// камеры, kill-событие.
    fn apply_damage(&mut self, ctx: &mut SimCtx, target_id: u32, shooter_id: u32, weapon_index: usize, damage_override: Option<f64>) {
        if !self.is_alive(target_id) {
            return;
        }

        let target_team = self.tanks[&target_id].team_id;
        let shooter_team = self.tanks.get(&shooter_id).map(|tank| tank.team_id);

        if !self.friendly_fire && shooter_team == Some(target_team) {
            return;
        }

        let weapon = &self.weapons[weapon_index];

        if let Some(shake) = &weapon.camera_shake {
            ctx.events.push(CoreEvent::Shake {
                id: target_id,
                intensity: shake.intensity,
                duration: shake.duration,
            });
        }

        let damage = damage_override.unwrap_or(weapon.damage);

        let destroyed = {
            let tank = self.tanks.get_mut(&target_id).unwrap();
            let Some(body) = ctx.world.bodies.get_mut(tank.body) else {
                return;
            };

            tank.take_damage(damage, body, ctx.events)
        };

        if destroyed {
            ctx.events.push(CoreEvent::Death { victim: target_id, killer: shooter_id });
        }
    }

    /// Удаляет все снаряды, сбрасывает кольцевой буфер (Game._removeShots).
    fn remove_shots(&mut self, world: &mut PhysicsWorld) -> Vec<String> {
        let mut names: Vec<String> = Vec::new();

        self.current_shot_id = 0;

        let shots: Vec<Bomb> = self.shots.drain(..).map(|(_, bomb)| bomb).collect();

        for bomb in shots {
            let name = self.weapons.get_index(bomb.weapon).unwrap().0.clone();

            if !names.contains(&name) {
                names.push(name);
            }

            world.remove_body(bomb.body);
        }

        for slot in &mut self.shots_at_time {
            slot.clear();
        }

        self.current_step_tick = 0;

        names
    }
}

#[derive(Serialize)]
struct TanksDump<'a> {
    tanks: &'a IndexMap<u32, Tank>,
    bots: &'a IndexMap<u32, BotBrain>,
    shots: &'a IndexMap<u32, Bomb>,
    shots_at_time: &'a Vec<Vec<u32>>,
    current_shot_id: u32,
    current_step_tick: usize,
}

#[derive(Deserialize)]
struct TanksDumpOwned {
    tanks: IndexMap<u32, Tank>,
    bots: IndexMap<u32, BotBrain>,
    shots: IndexMap<u32, Bomb>,
    shots_at_time: Vec<Vec<u32>>,
    current_shot_id: u32,
    current_step_tick: usize,
}
