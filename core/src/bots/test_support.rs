//! Фикстура и фабрики для тестов ИИ (перенос из `mod tests` бывшего
//! `controller.rs`).

use indexmap::IndexMap;
use rapier2d::prelude::*;
use vimp_engine_core::map::{MapConfig, MapLevels};
use vimp_engine_core::nav::navigation::NavigationSystem;
use vimp_engine_core::nav::spatial::{SpatialEntity, SpatialGrid};
use vimp_engine_core::rng::Rng;

use super::brain::BotBrain;
use super::steering::SelfState;
use super::team::TeamBoard;
use crate::config::{
    BotRules, KeyConfig, LevelRules, ModelConfig, PanelValue, SurfaceRules, WeaponConfig,
};
use crate::tank::{PlayerKeyBits, Tank};
use crate::tanks::BotView;

pub(crate) const TILE: f32 = 32.0;

/// Фикстура tests/core/fixtures/layered.json (та же карта, что у
/// JS-тестов ядра): 20×20, стены по периметру, рампа на восток
/// (строка 9, колонки 6..9) и мост (тайл 2) в колонках 10..12,
/// строках 5..14.
pub(crate) fn levels() -> MapLevels {
    let cfg: MapConfig =
        serde_json::from_str(include_str!("../../../tests/core/fixtures/layered.json")).unwrap();

    MapLevels::build(
        &cfg.map,
        &cfg.physics_static,
        &cfg.levels,
        &cfg.ramps,
        TILE,
        None,
    )
}

pub(crate) fn model() -> ModelConfig {
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
        "gunCenterSpeed": 10.0,
        "barrelHeight": 2.4,
        "turretTop": 3.0
    }))
    .unwrap()
}

pub(crate) fn weapons() -> IndexMap<String, WeaponConfig> {
    serde_json::from_value(serde_json::json!({
        "w1": {
            "type": "hitscan",
            "damage": 40,
            "range": 1500,
            "fireRate": 0.01,
            "consumption": 1
        },
        "w2": {
            "type": "explosive",
            "time": 300,
            "fireRate": 0.5,
            "damage": 70,
            "radius": 50,
            "size": 4
        }
    }))
    .unwrap()
}

pub(crate) fn panel() -> IndexMap<String, PanelValue> {
    let mut panel = IndexMap::new();

    panel.insert("health".to_string(), PanelValue { value: 100.0 });
    panel.insert("w1".to_string(), PanelValue { value: 10.0 });
    panel.insert("w2".to_string(), PanelValue { value: 5.0 });
    panel
}

pub(crate) fn key_bits() -> PlayerKeyBits {
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
pub(crate) struct Fixture {
    pub world: PhysicsWorld,
    pub nav: Option<NavigationSystem>,
    pub spatial: SpatialGrid,
    pub rng: Rng,
    pub tanks: IndexMap<u32, Tank>,
    pub key_bits: PlayerKeyBits,
    pub weapons: IndexMap<String, WeaponConfig>,
    pub levels: MapLevels,
    pub models: IndexMap<String, ModelConfig>,
    pub rules: BotRules,
    pub level_rules: LevelRules,
    pub route_budget: u32,
    pub friendly_fire: bool,
    /// Доска команды бота; `None` — без команды.
    pub team: Option<TeamBoard>,
}

impl Fixture {
    pub fn new() -> Self {
        let levels = levels();
        let nav = NavigationSystem::generate_layered(&levels, TILE);
        let mut models = IndexMap::new();

        models.insert("m1".to_string(), model());

        Self {
            world: PhysicsWorld::new(),
            nav: Some(nav),
            spatial: SpatialGrid::new(1000.0),
            rng: Rng::new(7),
            tanks: IndexMap::new(),
            key_bits: key_bits(),
            weapons: weapons(),
            levels,
            models,
            rules: BotRules::default(),
            level_rules: LevelRules::default(),
            route_budget: u32::MAX,
            friendly_fire: false,
            team: None,
        }
    }

    pub fn add_tank(&mut self, game_id: u32, team_id: u8, x: f32, y: f32, level: u8) {
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

    /// Лучи видят новые тела только после шага мира: шаг без гравитации
    /// тела не сдвигает.
    pub fn sync_queries(&mut self) {
        self.world.gravity = Vector::ZERO;
        self.world.step();
    }

    /// Переносит танк в точку.
    pub fn move_tank(&mut self, game_id: u32, x: f32, y: f32) {
        let handle = self.tanks[&game_id].body;

        if let Some(body) = self.world.bodies.get_mut(handle) {
            body.set_translation(Vector::new(x, y), true);
        }
    }

    /// Шаг танков по их клавишам (движение, башня, смена оружия) и мира без
    /// гравитации. Выстрелы не исполняются: нажатие огня только гасится.
    pub fn step(&mut self, dt: f32) {
        let surface_rules = SurfaceRules::default();
        let mut events = Vec::new();

        for tank in self.tanks.values_mut() {
            let Some(body) = self.world.bodies.get_mut(tank.body) else {
                continue;
            };
            let model = &self.models[&tank.model];

            tank.update(
                dt,
                body,
                model,
                &self.weapons,
                &self.key_bits,
                &self.level_rules,
                None,
                &surface_rules,
                &mut self.rng,
                &mut events,
            );
        }

        self.world.integration_parameters.dt = dt;
        self.world.gravity = Vector::ZERO;
        self.world.step();
    }

    pub fn view(&mut self) -> BotView<'_> {
        BotView {
            world: &mut self.world,
            nav: &self.nav,
            spatial: &self.spatial,
            rng: &mut self.rng,
            tanks: &mut self.tanks,
            key_bits: &self.key_bits,
            weapons: &self.weapons,
            levels: Some(&self.levels),
            friendly_fire: self.friendly_fire,
            models: &self.models,
            rules: &self.rules,
            level_rules: &self.level_rules,
            route_budget: &mut self.route_budget,
            team: self.team.as_ref(),
        }
    }
}

/// Бот в кэшированном состоянии «стою здесь, на этом уровне».
pub(crate) fn brain_at(game_id: u32, position: [f32; 2], level: u8) -> BotBrain {
    let mut rng = Rng::new(3);
    let mut brain = BotBrain::new(game_id, &mut rng, &BotRules::default());

    brain.my_position = Some(position);
    brain.my_level = level;
    brain
}

/// Прицеленный в цель бот: дошло ли до выстрела за `attempts` тиков по
/// 0.05 с (восприятие обновляется каждый тик, реакция и очередь идут по
/// часам бота).
pub(crate) fn fires_within(fixture: &mut Fixture, brain: &mut BotBrain, attempts: usize) -> bool {
    const DT: f32 = 0.05;

    let shots = brain.stats.shots_fired;
    let mut view = fixture.view();

    for _ in 0..attempts {
        let Some(me) = SelfState::read(&view, brain.game_id) else {
            return false;
        };

        brain.clock += DT;
        brain
            .perception
            .update(&mut view, &me, &brain.profile, brain.clock, DT, false);
        brain.execute_aim_and_shoot(&mut view, DT);

        if brain.stats.shots_fired > shots {
            return true;
        }
    }

    false
}
