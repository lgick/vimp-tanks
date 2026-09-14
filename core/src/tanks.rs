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
use crate::config::{
    CameraShake, LevelRules, ModelConfig, PanelValue, PropRules, SurfaceRules, TanksConfig, WeaponConfig, WeaponKind,
};
use crate::level::{self, LevelEvent};
use crate::map_game::MapGame;
use crate::props::{DamageCause, PropTransition, Props};
use crate::surface::{self, SurfaceMap};
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

/// Взрыв в точке: бомба собирает его из своего оружия, бочка — из
/// `coreParams.props.<тип>.blast`. Урон и импульс спадают линейно к краю
/// радиуса.
struct Blast {
    x: f32,
    y: f32,
    level: u8,
    radius: f32,
    damage: f64,
    impulse: f32,
    /// Владелец взрыва: `(game_id, team, weapon)`. `None` — бочка: урон без
    /// проверки дружественного огня, смерть — самоубийство.
    owner: Option<(u32, u8, usize)>,
    /// Тряска камеры задетого танка без владельца (у бомбы — из оружия).
    shake: Option<CameraShake>,
    /// Тело-источник, которое взрыв не задевает (тело бомбы).
    source: Option<RigidBodyHandle>,
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
    /// Разобранное поле `game` текущей карты. Пересобирается только
    /// `rebuild_map_derived`.
    map_game: MapGame,
    /// Правила поверхностей (coreParams.surfaces).
    surface_rules: SurfaceRules,
    /// Таблица поверхностей текущей карты; `None` — карта их не объявила
    /// (или пересборка упала) и движение идёт нейтральным путём.
    /// Пересобирается только `rebuild_map_derived`.
    surfaces: Option<SurfaceMap>,
    /// Производные данные карты нужно пересобрать на ближайшем шаге: хук
    /// `on_map_loaded` после `deserialize` не зовётся. Ставит `deserialize`,
    /// снимает `rebuild_map_derived`. К отпечатку слоёв не привязан: тот на
    /// плоской карте всегда `None`.
    map_derived_dirty: bool,
    /// Сколько раз вызваны `rebuild_map_derived` и `reset_round_state` (для
    /// тестов порядка вызовов).
    map_derived_rebuilds: u32,
    round_state_resets: u32,
    /// Правила разрушаемых тел карты (coreParams.props).
    prop_rules: PropRules,
    /// Шагов до детонации от чужого взрыва по индексу типа пропа.
    prop_chain_steps: Vec<u32>,
    /// Пропы текущей карты: строятся в `reset_round_state`, едут в дамп.
    props: Props,
    /// Скорости танков и пропов до шага мира — для тарана в `on_contacts`.
    /// Живёт внутри одного фиксированного шага, в дамп не едет.
    pre_step_vel: IndexMap<RigidBodyHandle, Vector>,
    /// Ключ снапшота строки взрыва (`w2e`) для взрывов пропов — берётся у
    /// первого взрывного оружия.
    blast_outcome_id: Option<String>,
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
            map_game: MapGame::default(),
            surface_rules: cfg.surfaces.clone(),
            surfaces: None,
            map_derived_dirty: false,
            map_derived_rebuilds: 0,
            round_state_resets: 0,
            prop_rules: cfg.props.clone(),
            prop_chain_steps: cfg.props.chain_steps(engine_cfg.time_step),
            props: Props::default(),
            pre_step_vel: IndexMap::new(),
            blast_outcome_id: cfg
                .weapons
                .values()
                .filter(|w| w.kind == WeaponKind::Explosive)
                .find_map(|w| w.shot_outcome_id.clone()),
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

    fn on_map_loaded(&mut self, ctx: &mut SimCtx) -> Result<(), String> {
        self.rebuild_map_derived(ctx)?;
        self.reset_round_state(ctx)?;

        Ok(())
    }

    fn on_fixed_step(&mut self, ctx: &mut SimCtx, dt: f32) {
        // после `deserialize` хук карты не звали: производные данные
        // пересобираются здесь, один раз
        if self.map_derived_dirty {
            self.rebuild_map_derived_on_step(ctx);
        }

        // слои карты приезжают вместе с картой, а `spawn_actor` карты не
        // видит: держим копию геометрии и пересчитываем уровни всех танков,
        // когда она сменилась
        self.sync_levels(ctx);
        self.update_levels(ctx, dt);
        // импульсы поверхностей телам карты — до `world.step`, как у танков
        self.apply_body_surfaces(ctx, dt);

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
                    self.surfaces.as_ref(),
                    &self.surface_rules,
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

        // отложенные детонации — по возрастанию индекса (детерминизм)
        for index in self.props.tick_detonations() {
            self.destroy_prop(ctx, index);
        }

        // последним: все импульсы шага применены, контакт ещё не решён
        self.record_pre_step_vel(ctx);
    }

    fn on_contacts(&mut self, ctx: &mut SimCtx, pairs: &[(ColliderHandle, ColliderHandle)]) {
        self.process_rams(ctx, pairs);

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

        self.map_game = MapGame::default();
        self.surfaces = None;
        self.map_derived_dirty = false;

        self.props = Props::default();
        self.pre_step_vel.clear();
    }

    fn serialize(&self) -> serde_json::Value {
        let dump = TanksDump {
            tanks: &self.tanks,
            bots: &self.bots,
            shots: &self.shots,
            shots_at_time: &self.shots_at_time,
            current_shot_id: self.current_shot_id,
            current_step_tick: self.current_step_tick,
            props: &self.props,
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
        // пропы — из дампа: `rebuild_map_derived` их не пересобирает, иначе
        // разрушенное на прошлом хосте восстановилось бы
        self.props = dump.props;
        self.pre_step_vel.clear();

        self.new_tracers.clear();
        self.new_bombs.clear();
        self.weapon_effects.clear();
        self.pending_null_tanks.clear();
        self.cached_players.clear();

        // слои в дамп не едут (карта восстанавливается своим путём):
        // уровни танков пересчитает первый же `update_levels`
        self.levels_dirty = true;
        // хук `on_map_loaded` при восстановлении не зовётся: данные из поля
        // `game` карты пересоберёт первый же шаг
        self.map_derived_dirty = true;

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
    /// Пересобирает данные, выводимые из карты и конфига (`map_game`,
    /// `surfaces`).
    /// Единственное место разбора `game`: зовётся из `on_map_loaded` и из
    /// `on_fixed_step` по флагу `map_derived_dirty`. При ошибке производные
    /// данные остаются пустыми — нейтральный путь.
    fn rebuild_map_derived(&mut self, ctx: &SimCtx) -> Result<(), String> {
        self.map_derived_dirty = false;
        self.map_derived_rebuilds = self.map_derived_rebuilds.wrapping_add(1);
        self.map_game = MapGame::default();
        self.surfaces = None;

        if let Some(map) = ctx.map.as_ref() {
            self.map_game = MapGame::from_value(map.game_data())?;
            // сетка уровня 0 — поле `GameMap::grid`, надземные — слои карты:
            // `self.levels` на плоской карте `None`. `step` на хосте уже
            // умножен на `scale`
            self.surfaces = surface::build_map(
                &self.map_game,
                &self.surface_rules,
                map.levels(),
                &map.grid,
                map.step,
            )?;
        }

        Ok(())
    }

    /// Пересборка по флагу из шага: вернуть `Err` из `on_fixed_step` некуда,
    /// поэтому ошибка уходит событием `custom` (`mapDerivedError`) в
    /// `HostPlugin.onCoreEvent`. Шаг продолжается без производных данных.
    fn rebuild_map_derived_on_step(&mut self, ctx: &mut SimCtx) {
        if let Err(message) = self.rebuild_map_derived(ctx) {
            ctx.events.push(CoreEvent::Custom {
                data: serde_json::json!({ "type": "mapDerivedError", "message": message }),
            });
        }
    }

    /// Сбрасывает состояние, живущее внутри раунда. Зовётся только из
    /// `on_map_loaded`: при рестарте раунда карта та же, а сброс нужен; после
    /// `deserialize` это состояние восстановлено из дампа. Пропы строятся
    /// заново — это и есть восстановление разрушенного в начале раунда
    /// (тела карты движок уже пересоздал, `map_body_state` обнулил).
    fn reset_round_state(&mut self, ctx: &mut SimCtx) -> Result<(), String> {
        self.round_state_resets = self.round_state_resets.wrapping_add(1);
        self.props = Props::default();
        self.pre_step_vel.clear();

        if let Some(map) = ctx.map.as_ref() {
            self.props = Props::build(map, &self.prop_rules)?;
        }

        Ok(())
    }

    /// Пропы текущей карты (для тестов).
    pub fn props(&self) -> &Props {
        &self.props
    }

    /// Урон пропу `index` (сырой, без множителя) и реакция на переход:
    /// `Damaged` → состояние `1`, `Destroyed` → `destroy_prop`, `Primed` —
    /// ничего (бочка видна целой до самой детонации).
    fn damage_prop(&mut self, ctx: &mut SimCtx, index: usize, amount: f32, cause: DamageCause) {
        match self.props.damage(index, amount, cause, &self.prop_rules, &self.prop_chain_steps) {
            PropTransition::Damaged => {
                if let Some(state) = ctx.map_body_state.get_mut(index) {
                    *state = 1;
                }
            }
            PropTransition::Destroyed => self.destroy_prop(ctx, index),
            PropTransition::Primed | PropTransition::None => {}
        }
    }

    /// Разрушение пропа: состояние `2`, тело останавливается и отключается
    /// (из мира не удаляется — тела карты удаляет только движок). Тип с
    /// `blast` взрывается в этом же вызове.
    fn destroy_prop(&mut self, ctx: &mut SimCtx, index: usize) {
        let Some(kind) = self.props.get(index).map(|prop| prop.kind) else {
            return;
        };

        if let Some(state) = ctx.map_body_state.get_mut(index) {
            *state = 2;
        }

        let map: &Option<vimp_engine_core::map::GameMap> = ctx.map;
        let Some(map) = map.as_ref() else {
            return;
        };
        let Some(handle) = map.dynamic_handle(index) else {
            return;
        };
        let level = map.dynamic_level(index);
        // позиция тела — угол объекта: центр берём у коллайдера
        let center = ctx.world.bodies.get(handle).and_then(|body| {
            body.colliders()
                .first()
                .and_then(|collider| ctx.world.colliders.get(*collider))
                .map(|collider| collider.translation())
        });

        if let Some(body) = ctx.world.bodies.get_mut(handle) {
            body.set_linvel(Vector::ZERO, false);
            body.set_angvel(0.0, false);
            body.set_enabled(false);
        }

        let Some(spec) = self.prop_rules.types.values().nth(kind).and_then(|prop| prop.blast.clone()) else {
            return;
        };
        let Some(center) = center else {
            return;
        };
        let row = self.explode(
            ctx,
            &Blast {
                x: center.x,
                y: center.y,
                level,
                radius: spec.radius,
                damage: spec.damage,
                impulse: spec.impulse,
                owner: None,
                shake: spec.camera_shake,
                source: Some(handle),
            },
        );

        if let Some(outcome_id) = self.blast_outcome_id.clone() {
            self.weapon_effects.entry(outcome_id).or_default().push(row);
        }
    }

    /// Скорости танков и целых пропов перед шагом мира. На карте без пропов
    /// таблица пуста — таран не считается вовсе.
    fn record_pre_step_vel(&mut self, ctx: &SimCtx) {
        self.pre_step_vel.clear();

        if self.props.is_empty() {
            return;
        }

        let Some(map) = ctx.map.as_ref() else {
            return;
        };

        for tank in self.tanks.values() {
            if let Some(body) = ctx.world.bodies.get(tank.body) {
                self.pre_step_vel.insert(tank.body, body.linvel());
            }
        }

        for (index, entry) in self.props.entries.iter().enumerate() {
            if entry.as_ref().is_none_or(|prop| prop.is_destroyed()) {
                continue;
            }

            let Some(handle) = map.dynamic_handle(index) else {
                continue;
            };

            if let Some(body) = ctx.world.bodies.get(handle).filter(|body| body.is_enabled()) {
                self.pre_step_vel.insert(handle, body.linvel());
            }
        }
    }

    /// Таран: начавшийся контакт «танк ↔ проп». Скорость удара —
    /// `max(0, (v_tank − v_prop) · n)` по скоростям до шага, `n` — от танка к
    /// пропу (нормаль первого манифолда, без него — между центрами). Выше
    /// `ramThreshold` проп получает `(impact − ramThreshold) · ramDamagePerSpeed`;
    /// танк урона не получает. Длительное толкание урона не наносит:
    /// `Started` приходит один раз на контакт.
    fn process_rams(&mut self, ctx: &mut SimCtx, pairs: &[(ColliderHandle, ColliderHandle)]) {
        if self.pre_step_vel.is_empty() {
            return;
        }

        let map: &Option<vimp_engine_core::map::GameMap> = ctx.map;
        let Some(map) = map.as_ref() else {
            return;
        };
        let mut hits: Vec<(usize, f32)> = Vec::new();

        {
            let world = &*ctx.world;
            let parent = |collider: ColliderHandle| world.colliders.get(collider).and_then(|c| c.parent());
            let is_tank = |body: RigidBodyHandle| {
                world
                    .bodies
                    .get(body)
                    .is_some_and(|body| matches!(BodyTag::decode(body.user_data), Some(BodyTag::Player { .. })))
            };

            for &(h1, h2) in pairs {
                let (Some(b1), Some(b2)) = (parent(h1), parent(h2)) else {
                    continue;
                };
                let (tank_collider, tank_body, prop_collider, prop_body) = match (is_tank(b1), is_tank(b2)) {
                    (true, false) => (h1, b1, h2, b2),
                    (false, true) => (h2, b2, h1, b1),
                    _ => continue,
                };
                let Some(index) = map.dynamic_index_of(world, prop_body) else {
                    continue;
                };
                let Some(prop) = self.props.get(index) else {
                    continue;
                };
                let Some(rule) = self.prop_rules.types.values().nth(prop.kind) else {
                    continue;
                };
                let (Some(v_tank), Some(v_prop)) =
                    (self.pre_step_vel.get(&tank_body), self.pre_step_vel.get(&prop_body))
                else {
                    continue;
                };
                let centers = world.colliders.get(tank_collider).zip(world.colliders.get(prop_collider));
                let normal = world
                    .narrow_phase
                    .contact_pair(h1, h2)
                    .and_then(|pair| {
                        let manifold = pair.manifolds.first()?;
                        // нормаль манифолда направлена от collider1 к collider2
                        let sign = if pair.collider1 == tank_collider { 1.0 } else { -1.0 };

                        Some(manifold.data.normal * sign)
                    })
                    .filter(|normal| normal.length_squared() > 0.0)
                    .or_else(|| {
                        centers.map(|(tank, prop)| (prop.translation() - tank.translation()).normalize_or_zero())
                    });
                let Some(normal) = normal else {
                    continue;
                };
                let impact = (*v_tank - *v_prop).dot(normal).max(0.0);

                if impact > rule.ram_threshold {
                    hits.push((index, (impact - rule.ram_threshold) * rule.ram_damage_per_speed));
                }
            }
        }

        for (index, amount) in hits {
            self.damage_prop(ctx, index, amount, DamageCause::Ram);
        }
    }

    /// Разобранное поле `game` текущей карты.
    pub fn map_game(&self) -> &MapGame {
        &self.map_game
    }

    /// Таблица поверхностей текущей карты.
    pub fn surface_map(&self) -> Option<&SurfaceMap> {
        self.surfaces.as_ref()
    }

    /// Сколько раз пересобирались производные данные карты (для тестов).
    pub fn map_derived_rebuilds(&self) -> u32 {
        self.map_derived_rebuilds
    }

    /// Сколько раз сбрасывалось состояние раунда (для тестов).
    pub fn round_state_resets(&self) -> u32 {
        self.round_state_resets
    }

    /// Поверхности для тел карты (ящики, бочки): лента, сопротивление и
    /// бустер по клетке ЦЕНТРА тела. Состояния на тело нет — дамп не
    /// меняется. Уровень и полёт тела движок уже посчитал на этом шаге
    /// (`step_dynamic_levels` идёт до `on_fixed_step`). Разрушенное тело
    /// (`map_body_state >= 2`) и отключённое тело сил не получают.
    fn apply_body_surfaces(&mut self, ctx: &mut SimCtx, dt: f32) {
        let (Some(surfaces), Some(map)) = (self.surfaces.as_ref(), ctx.map.as_ref()) else {
            return;
        };
        let world = &mut *ctx.world;

        for index in 0..map.dynamic_body_count() {
            if ctx.map_body_state.get(index).is_some_and(|state| *state >= 2) {
                continue;
            }

            let Some(body) = map
                .dynamic_handle(index)
                .and_then(|handle| world.bodies.get_mut(handle))
                .filter(|body| body.is_enabled())
            else {
                continue;
            };
            // позиция тела — угол объекта: клетку спрашиваем по центру
            // коллайдера, как движок в `step_dynamic_levels`
            let Some(center) = body
                .colliders()
                .first()
                .and_then(|collider| world.colliders.get(*collider))
                .map(|collider| collider.translation())
            else {
                continue;
            };
            let state = map.dynamic_level_state(index);
            let falling = state.falling.is_some();
            let vel = body.linvel();
            let (mix, kind) = surface::body_mix(surfaces, state.level, falling, center.x, center.y);
            let (drag_x, drag_y) = surface::body_dv(mix, kind, &self.surface_rules, vel.x, vel.y, dt);
            let (boost_x, boost_y) =
                surface::boost_dv(surfaces, state.level, falling, center.x, center.y, vel.x, vel.y, dt);
            let dv = Vector::new(drag_x + boost_x, drag_y + boost_y);

            if dv.x != 0.0 || dv.y != 0.0 {
                body.apply_impulse(dv * body.mass(), true);
            }
        }
    }

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
            self.apply_fall_damage(ctx, id, height);
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

        // страховка на случай конфига, не прошедшего `validate()`
        // (реплика строится из сетевых данных): деления на ноль быть не
        // должно ни при каких входных данных
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
    fn apply_fall_damage(&mut self, ctx: &mut SimCtx, game_id: u32, height: f32) {
        // урон считает не вся дуга, а её часть выше мёртвой зоны: прыжок
        // с рампы возвращает танк на ту же плиту и стоить HP не обязан,
        // а обрыв обязан. `fallDamage` — цена за уровень СВЕРХ зоны,
        // поэтому падение ровно с одного уровня стоит
        // `fallDamage · (1 − freeHeight)`
        let paid = (height - self.level_rules.fall_damage_free_height).max(0.0);
        let damage =
            (self.level_rules.fall_damage * paid as f64).min(self.level_rules.max_fall_damage);

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
                let hit_prop = ctx
                    .map
                    .as_ref()
                    .and_then(|map| map.dynamic_index_of(ctx.world, handle))
                    .filter(|index| self.props.get(*index).is_some());

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

                // множитель `bulletFactor` применяет сама `Props::damage`
                if let Some(index) = hit_prop {
                    self.damage_prop(ctx, index, weapon.damage as f32, DamageCause::Bullet);
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
                let position = ctx.world.bodies[bomb.body].translation();
                let explosion = self.explode(
                    ctx,
                    &Blast {
                        x: position.x,
                        y: position.y,
                        level: bomb.level,
                        radius: weapon.radius,
                        damage: weapon.damage,
                        impulse: weapon.impulse_magnitude,
                        owner: Some((bomb.owner_id, bomb.team_id, weapon_index)),
                        shake: None,
                        source: Some(bomb.body),
                    },
                );

                self.weapon_effects.entry(outcome_id).or_default().push(explosion);
            }

            ctx.world.remove_body(bomb.body);

            self.new_bombs.entry(weapon_index).or_default().insert(shot_id, None);
        }

        self.current_step_tick = (self.current_step_tick + 1) % self.max_shot_time_in_steps;
    }

    /// Взрыв (порт Bomb.detonate): урон/импульс по целям в радиусе, данные
    /// взрыва для клиента. Источник — бомба или разрушенная бочка (`Blast`).
    fn explode(&mut self, ctx: &mut SimCtx, blast: &Blast) -> ExplosionRow {
        let radius = blast.radius;
        let damage = blast.damage;
        let impulse_magnitude = blast.impulse;
        let friendly_fire = self.friendly_fire;
        // маска уровня взрыва: читается ДО цикла — внутри занят ctx.world
        let bomb_bit = self
            .levels
            .as_ref()
            .filter(|levels| levels.is_layered())
            .map(|_| level_group(blast.level));

        let bomb_position = Vector::new(blast.x, blast.y);
        let map: &Option<vimp_engine_core::map::GameMap> = ctx.map;

        struct Target {
            handle: RigidBodyHandle,
            // None — динамика карты: импульс без урона (проп — урон пропу)
            tag: Option<BodyTag>,
            // индекс пропа среди тел карты
            prop: Option<usize>,
            // точка отсчёта: центр коллайдера у тел карты, тело — у танка
            center: Vector,
            distance: f32,
        }

        let mut targets: Vec<Target> = Vec::new();

        {
            let aabb = Aabb::from_half_extents(bomb_position, Vector::new(radius, radius));

            for (_collider_handle, collider) in ctx.world.intersect_aabb_conservative(aabb, QueryFilter::new()) {
                let Some(parent) = collider.parent() else {
                    continue;
                };

                if Some(parent) == blast.source {
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

                // отключённое тело (разрушенный проп) не цель: в этом же шаге
                // его коллайдер ещё лежит в дереве запросов
                if !body.is_dynamic() || !body.is_enabled() {
                    continue;
                }

                let tag = BodyTag::decode(body.user_data);
                let map_object = is_map_object(body.user_data);

                // тело без метки вовсе целью не считается (JS: !userData?.type)
                if tag.is_none() && !map_object {
                    continue;
                }

                // позиция тела карты — угол объекта: расстояние и точка
                // импульса считаются от центра коллайдера
                let center = if map_object { collider.translation() } else { body.translation() };
                let distance = (center - bomb_position).length();

                if distance < radius && !targets.iter().any(|t| t.handle == parent) {
                    let prop = map
                        .as_ref()
                        .filter(|_| map_object)
                        .and_then(|map| map.dynamic_index_of(ctx.world, parent))
                        .filter(|index| self.props.get(*index).is_some());

                    targets.push(Target { handle: parent, tag, prop, center, distance });
                }
            }
        }

        for target in targets {
            let falloff = 1.0 - target.distance / radius;
            let actual_damage = (damage * falloff as f64).round();
            let actual_impulse = impulse_magnitude * falloff;

            if let Some(BodyTag::Player { game_id, team_id }) = target.tag {
                match blast.owner {
                    Some((owner_id, owner_team, weapon_index)) => {
                        if friendly_fire || owner_team != team_id {
                            self.apply_damage(ctx, game_id, owner_id, weapon_index, Some(actual_damage));
                        }
                    }
                    // бочка: дружественного огня нет, смерть — самоубийство
                    None => self.apply_damage_raw(ctx, game_id, game_id, actual_damage, blast.shake.as_ref()),
                }
            }

            // множитель `blastFactor` применяет сама `Props::damage`; бочка
            // вернёт `Primed`, забор и ящик — `Destroyed`/`Damaged`
            if let Some(index) = target.prop {
                self.damage_prop(ctx, index, actual_damage as f32, DamageCause::Blast);
            }

            if actual_impulse > 0.0 && target.distance > 0.0 {
                // только что разрушенное этим взрывом тело уже отключено
                if let Some(body) = ctx.world.bodies.get_mut(target.handle).filter(|body| body.is_enabled()) {
                    let direction = (target.center - bomb_position).normalize_or_zero();
                    let impulse_vector = direction * actual_impulse;

                    body.apply_impulse_at_point(impulse_vector, target.center, true);
                }
            }
        }

        ExplosionRow {
            x: round1(bomb_position.x),
            y: round1(bomb_position.y),
            radius,
            level: blast.level,
        }
    }

    /// Урон игроку от оружия (Game.applyDamage): дружественный огонь, тряска
    /// камеры оружия, kill-событие.
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
        let shake = weapon.camera_shake.clone();
        let damage = damage_override.unwrap_or(weapon.damage);

        self.apply_damage_raw(ctx, target_id, shooter_id, damage, shake.as_ref());
    }

    /// Урон игроку без правил оружия: тряска камеры, урон, kill-событие.
    fn apply_damage_raw(&mut self, ctx: &mut SimCtx, victim: u32, killer: u32, amount: f64, shake: Option<&CameraShake>) {
        if !self.is_alive(victim) {
            return;
        }

        if let Some(shake) = shake {
            ctx.events.push(CoreEvent::Shake {
                id: victim,
                intensity: shake.intensity,
                duration: shake.duration,
            });
        }

        let destroyed = {
            let tank = self.tanks.get_mut(&victim).unwrap();
            let Some(body) = ctx.world.bodies.get_mut(tank.body) else {
                return;
            };

            tank.take_damage(amount, body, ctx.events)
        };

        if destroyed {
            ctx.events.push(CoreEvent::Death { victim, killer });
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
    props: &'a Props,
}

#[derive(Deserialize)]
struct TanksDumpOwned {
    tanks: IndexMap<u32, Tank>,
    bots: IndexMap<u32, BotBrain>,
    shots: IndexMap<u32, Bomb>,
    shots_at_time: Vec<Vec<u32>>,
    current_shot_id: u32,
    current_step_tick: usize,
    #[serde(default)]
    props: Props,
}
