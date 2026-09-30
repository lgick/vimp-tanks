// Интеграционные тесты симуляции: сценарии портированы с поведения
// текущего JS-сервера (tests/server/integration/) как эталона Этапа 2.

use std::sync::OnceLock;

use vimp_engine_core::config::FieldValue;
use vimp_engine_core::events::CoreEvent;
use vimp_engine_core::snapshot::Block;
use vimp_tanks_core::bots::brain::{BotMode, BotStats};
use vimp_tanks_core::bots::BotBrain;
use vimp_tanks_core::config::BotSkill;
use vimp_tanks_core::GameCore;

const DT: f32 = 1.0 / 120.0;

/// Конфиг ядра — зеркало src/config/game.js + src/data/*.js (собирается на
/// JS через src/lib/coreConfig.js). Плоский JSON заворачивается в
/// `{engine: {...}, game: {...}}` (PLAN.md §3.4) с одним и тем же объектом
/// по обе стороны — каждая половина деэерилизует лишние для себя поля молча.
fn config_json() -> String {
    wrap_config(flat_config_json())
}

/// Плоский конфиг → `{engine: {...}, game: {...}}` с ним по обе стороны.
fn wrap_config(flat: serde_json::Value) -> String {
    serde_json::json!({ "engine": flat.clone(), "game": flat }).to_string()
}

fn flat_config_json() -> serde_json::Value {
    serde_json::json!({
        "timeStep": DT,
        "friendlyFire": false,
        "mapScale": 0.3,
        "mapSetId": "c1",
        "models": {
            "m1": {
                "currentWeapon": "w1",
                "size": 2,
                "barrelHeight": 2.4,
                "turretTop": 3.0,
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
            }
        },
        "weapons": {
            "w1": {
                "type": "hitscan",
                "impulseMagnitude": 7500000,
                "damage": 40,
                "range": 1500,
                "fireRate": 0.01,
                "spread": 0,
                "consumption": 1,
                "cameraShake": { "intensity": 20, "duration": 200 }
            },
            "w2": {
                "type": "explosive",
                "time": 300,
                "shotOutcomeId": "w2e",
                "size": 8,
                "fireRate": 0.1,
                "damage": 70,
                "radius": 50,
                "impulseMagnitude": 2000000,
                "cameraShake": { "intensity": 30, "duration": 400 }
            }
        },
        "playerKeys": {
            "forward": { "key": 1 },
            "back": { "key": 2 },
            "left": { "key": 4 },
            "right": { "key": 8 },
            "gunCenter": { "key": 16, "type": 1 },
            "gunLeft": { "key": 32 },
            "gunRight": { "key": 64 },
            "fire": { "key": 128, "type": 1 },
            "nextWeapon": { "key": 256, "type": 1 },
            "prevWeapon": { "key": 512, "type": 1 }
        },
        "levels": {
            "fallTime": 0.35,
            "fallDamage": 30,
            "fallDamageFreeHeight": 0.5,
            "rampLaunchFactor": 0.35,
            "maxLaunchVz": 3.5,
            "jumpClearance": 0.45
        },
        "surfaces": {
            "trackYawGain": 0.004,
            "trackSampleX": 0.6,
            "trackSampleY": 0.75,
            "types": {
                "sand": { "accel": 0.6, "maxSpeed": 0.55, "drag": 1.2, "grip": 1.0, "brake": 1.0, "turn": 0.8 },
                "mud": { "accel": 0.45, "maxSpeed": 0.4, "drag": 2.0, "grip": 0.9, "brake": 1.0, "turn": 0.7 },
                "water": { "accel": 0.7, "maxSpeed": 0.6, "drag": 1.5, "grip": 0.8, "brake": 0.8, "turn": 0.85 },
                "oil": { "accel": 0.35, "maxSpeed": 1.0, "drag": 0.0, "grip": 0.08, "brake": 0.1, "turn": 1.6, "angularDrag": -0.5, "slickTime": 1.5 },
                "conveyor": { "belt": 60 },
                "boost": { "boostDv": 160, "boostMaxSpeed": 340, "minEntrySpeed": 20 }
            }
        },
        "props": {
            "fence": { "hp": 30, "damagedAt": 0, "bulletFactor": 1.0, "blastFactor": 1.0, "ramThreshold": 60, "ramDamagePerSpeed": 0.5 },
            "crate": { "hp": 120, "damagedAt": 0.5, "bulletFactor": 0.5, "blastFactor": 1.5, "ramThreshold": 140, "ramDamagePerSpeed": 0.6 },
            "barrel": { "hp": 40, "damagedAt": 0, "bulletFactor": 1.0, "blastFactor": 1.0, "ramThreshold": 150, "ramDamagePerSpeed": 1.0,
                "chainDelay": 0.15,
                "blast": { "radius": 70, "damage": 80, "impulse": 2500000, "cameraShake": { "intensity": 30, "duration": 400 } } }
        },
        "panel": {
            "health": { "key": "h", "value": 100 },
            "w1": { "key": "w1", "value": 200 },
            "w2": { "key": "w2", "value": 100 }
        },
        "snapshot": {
            "version": 5,
            "port": 5,
            "keys": {
                "m1": { "id": 1, "kind": "indexed8", "class": "hot", "fields": [
                    { "name": "x", "ty": "f32", "interp": "lerp" },
                    { "name": "y", "ty": "f32", "interp": "lerp" },
                    { "name": "angle", "ty": "f32", "interp": "lerpAngle" },
                    { "name": "gunRotation", "ty": "f32", "interp": "lerpAngle" },
                    { "name": "vx", "ty": "f32", "interp": "lerp" },
                    { "name": "vy", "ty": "f32", "interp": "lerp" },
                    { "name": "engineLoad", "ty": "f32", "interp": "lerp" },
                    { "name": "condition", "ty": "u8" },
                    { "name": "size", "ty": "u8" },
                    { "name": "team", "ty": "u8" },
                    { "name": "angvel", "ty": "f32", "interp": "lerp" },
                    { "name": "z", "ty": "f32", "interp": "lerp" },
                    { "name": "level", "ty": "u8" },
                    { "name": "vz", "ty": "f32", "interp": "lerp" },
                    { "name": "pitch", "ty": "f32", "interp": "lerp" },
                    { "name": "roll", "ty": "f32", "interp": "lerp" }
                ] },
                "w1": { "id": 2, "kind": "list16", "class": "event", "fields": [
                    { "name": "startX", "ty": "f32" },
                    { "name": "startY", "ty": "f32" },
                    { "name": "endX", "ty": "f32" },
                    { "name": "endY", "ty": "f32" },
                    { "name": "bodyX", "ty": "f32" },
                    { "name": "bodyY", "ty": "f32" },
                    { "name": "wasHit", "ty": "u8" },
                    { "name": "shooterId", "ty": "u8" },
                    { "name": "startLevel", "ty": "u8" },
                    { "name": "endLevel", "ty": "u8" }
                ] },
                "w2": { "id": 3, "kind": "indexed32", "class": "event", "fields": [
                    { "name": "x", "ty": "f32" },
                    { "name": "y", "ty": "f32" },
                    { "name": "angle", "ty": "f32" },
                    { "name": "size", "ty": "u8" },
                    { "name": "time", "ty": "u16" },
                    { "name": "ownerId", "ty": "u8" },
                    { "name": "level", "ty": "u8" }
                ] },
                "w2e": { "id": 4, "kind": "list16", "class": "event", "fields": [
                    { "name": "x", "ty": "f32" },
                    { "name": "y", "ty": "f32" },
                    { "name": "radius", "ty": "f32" },
                    { "name": "level", "ty": "u8" }
                ] },
                "c1": { "id": 5, "kind": "indexedNoNull8", "class": "hot", "optionalFrom": 3, "fields": [
                    { "name": "x", "ty": "f32", "interp": "lerp" },
                    { "name": "y", "ty": "f32", "interp": "lerp" },
                    { "name": "angle", "ty": "f32", "interp": "lerpAngle" },
                    { "name": "vx", "ty": "f32", "interp": "lerp" },
                    { "name": "vy", "ty": "f32", "interp": "lerp" },
                    { "name": "angvel", "ty": "f32", "interp": "lerp" }
                ] },
                "c2": { "id": 6, "kind": "indexedNoNull8", "class": "hot", "optionalFrom": 3, "fields": [
                    { "name": "x", "ty": "f32", "interp": "lerp" },
                    { "name": "y", "ty": "f32", "interp": "lerp" },
                    { "name": "angle", "ty": "f32", "interp": "lerpAngle" },
                    { "name": "vx", "ty": "f32", "interp": "lerp" },
                    { "name": "vy", "ty": "f32", "interp": "lerp" },
                    { "name": "angvel", "ty": "f32", "interp": "lerp" }
                ] }
            }
        },
        "seed": 42
    })
}

/// Небольшая карта: периметр из стен, шаг 32, масштаб 1.
fn map_json() -> String {
    let mut grid: Vec<Vec<i32>> = vec![vec![0; 20]; 20];

    for x in 0..20 {
        grid[0][x] = 1;
        grid[19][x] = 1;
    }

    for row in grid.iter_mut() {
        row[0] = 1;
        row[19] = 1;
    }

    serde_json::json!({
        "setId": "c1",
        "scale": 1,
        "step": 32,
        "map": grid,
        "physicsStatic": [1],
        "physicsDynamic": [],
        "respawns": {
            "team1": [[100, 100, 0], [100, 200, 0]],
            "team2": [[500, 100, 180], [500, 200, 180]]
        }
    })
    .to_string()
}

/// Слоёная карта: тот же периметр, плита моста (тайл 2 уровня 1) в
/// колонках 10..12 строк 5..14 и рампа (тайл 3 уровня 0) в строке 9,
/// колонках 6..9, поднимающая на восток к подножию плиты.
fn layered_map_json() -> String {
    let mut grid: Vec<Vec<i32>> = vec![vec![0; 20]; 20];

    for x in 0..20 {
        grid[0][x] = 1;
        grid[19][x] = 1;
    }

    for row in grid.iter_mut() {
        row[0] = 1;
        row[19] = 1;
    }

    for x in 6..10 {
        grid[9][x] = 3;
    }

    let mut slab: Vec<Vec<i32>> = vec![vec![0; 20]; 20];

    for row in slab.iter_mut().take(15).skip(5) {
        for cell in row.iter_mut().take(13).skip(10) {
            *cell = 2;
        }
    }

    serde_json::json!({
        "setId": "c1",
        "scale": 1,
        "step": 32,
        "map": grid,
        "physicsStatic": [1],
        "physicsDynamic": [],
        "respawns": {
            "team1": [[100, 100, 0]],
            "team2": [[500, 100, 180]]
        },
        "levels": {
            "1": { "map": slab, "floor": [2], "walls": [] }
        },
        "ramps": [{ "tile": 3, "dir": "east", "from": 0, "to": 1 }]
    })
    .to_string()
}

/// Карта на три уровня: плита уровня 1 — колонки 7..12, плита уровня 2 —
/// колонки 10..11 (колонки 7..9 — терраса уровня 1 под открытым небом).
/// Рампа 1 → 2 идёт по строке 9 через колонки 7..9.
fn terraced_map_json() -> String {
    let mut grid: Vec<Vec<i32>> = vec![vec![0; 20]; 20];

    for x in 0..20 {
        grid[0][x] = 1;
        grid[19][x] = 1;
    }

    for row in grid.iter_mut() {
        row[0] = 1;
        row[19] = 1;
    }

    let mut slab1: Vec<Vec<i32>> = vec![vec![0; 20]; 20];
    let mut slab2: Vec<Vec<i32>> = vec![vec![0; 20]; 20];

    for row in slab1.iter_mut().take(15).skip(5) {
        for cell in row.iter_mut().take(13).skip(7) {
            *cell = 2;
        }
    }

    for row in slab2.iter_mut().take(15).skip(5) {
        for cell in row.iter_mut().take(12).skip(10) {
            *cell = 2;
        }
    }

    // рампа 1 → 2 в строке 9, колонки 7..9 (тайл прогона живёт в гриде
    // своего нижнего уровня)
    for x in 7..10 {
        slab1[9][x] = 3;
    }

    serde_json::json!({
        "setId": "c1",
        "scale": 1,
        "step": 32,
        "map": grid,
        "physicsStatic": [1],
        "physicsDynamic": [],
        "respawns": {
            "team1": [[100, 100, 0]],
            "team2": [[500, 100, 180]]
        },
        "levels": {
            "1": { "map": slab1, "floor": [2, 3], "walls": [] },
            "2": { "map": slab2, "floor": [2], "walls": [] }
        },
        "ramps": [{ "tile": 3, "dir": "east", "from": 1, "to": 2 }]
    })
    .to_string()
}

/// Точка на плите моста (колонка 11, строка 8).
const SLAB: (f32, f32) = (368.0, 272.0);
/// Точка на земле вне плиты и вне рампы.
const GROUND: (f32, f32) = (112.0, 112.0);

/// Уровень танка из players_data (индекс 12 строки схемы m1).
fn level_of(core: &GameCore, game_id: u32) -> u64 {
    let data: serde_json::Value = serde_json::from_str(&core.players_data()).unwrap();

    data["m1"][game_id.to_string()][12].as_u64().unwrap()
}

/// Наклон корпуса из players_data (индексы 14/15 строки схемы m1).
fn tilt_of(core: &GameCore, game_id: u32) -> (f32, f32) {
    let data: serde_json::Value = serde_json::from_str(&core.players_data()).unwrap();
    let row = &data["m1"][game_id.to_string()];

    (
        row[14].as_f64().unwrap() as f32,
        row[15].as_f64().unwrap() as f32,
    )
}

/// Угол башни из players_data (индекс 3 строки схемы m1).
fn gun_rotation_of(core: &GameCore, game_id: u32) -> f32 {
    let data: serde_json::Value = serde_json::from_str(&core.players_data()).unwrap();

    data["m1"][game_id.to_string()][3].as_f64().unwrap() as f32
}

/// Координата x танка из players_data (индекс 0 строки схемы m1).
fn tank_x(core: &GameCore, game_id: u32) -> f32 {
    let data: serde_json::Value = serde_json::from_str(&core.players_data()).unwrap();

    data["m1"][game_id.to_string()][0].as_f64().unwrap() as f32
}

fn make_core() -> GameCore {
    GameCore::new(&config_json()).unwrap()
}

/// Ядро тестового конфига с другим сидом ГСЧ (`seed` и в `engine`, и в `game`).
fn make_core_seeded(seed: u64) -> GameCore {
    let mut flat = flat_config_json();

    flat["seed"] = serde_json::json!(seed);

    GameCore::new(&wrap_config(flat)).unwrap()
}

fn steps(core: &mut GameCore, count: usize) {
    for _ in 0..count {
        core.step(DT);
    }
}

fn events(core: &mut GameCore) -> Vec<CoreEvent> {
    serde_json::from_str(&core.take_events()).unwrap()
}

#[test]
fn tank_drives_forward() {
    let mut core = make_core();

    core.spawn_actor(1, "m1", 1, 0.0, 0.0, 0.0).unwrap();
    core.apply_input(1, 1, "down", "forward");

    steps(&mut core, 120);

    let pos = core.position_of(1);

    assert!(pos[0] > 100.0, "танк должен уехать вперёд, x = {}", pos[0]);
    assert!(pos[1].abs() < 1.0, "без увода в сторону, y = {}", pos[1]);
    assert_eq!(core.last_input_seq(1), 1);
}

#[test]
fn tank_collides_with_map_walls() {
    let mut core = make_core();

    core.load_map(&map_json()).unwrap();
    // танк смотрит на левую стену (x=32 — внутренняя грань)
    core.spawn_actor(1, "m1", 1, 100.0, 100.0, 180.0).unwrap();
    core.apply_input(1, 1, "down", "forward");

    steps(&mut core, 400);

    let pos = core.position_of(1);

    assert!(
        pos[0] > 32.0,
        "стена должна остановить танк, x = {}",
        pos[0]
    );
}

#[test]
fn hitscan_shot_kills_after_three_hits() {
    let mut core = make_core();

    // стрелок смотрит на цель в упор
    core.spawn_actor(1, "m1", 1, 0.0, 0.0, 0.0).unwrap();
    core.spawn_actor(2, "m1", 2, 60.0, 0.0, 0.0).unwrap();

    // прогрев: broad-phase узнаёт о новых телах на шаге мира
    core.step(DT);
    core.take_events();

    // три выстрела с паузой больше кулдауна (0.01 c)
    for _ in 0..3 {
        core.apply_input(1, 1, "down", "fire");
        steps(&mut core, 4);
    }

    let all = events(&mut core);

    let kills: Vec<_> = all
        .iter()
        .filter(|e| matches!(e, CoreEvent::Death { .. }))
        .collect();

    assert_eq!(kills.len(), 1, "события: {all:?}");

    if let CoreEvent::Death { victim, killer } = kills[0] {
        assert_eq!(*victim, 2);
        assert_eq!(*killer, 1);
    }

    assert!(!core.is_alive(2));
    assert!(core.is_alive(1));

    // здоровье цели снижалось по 40 (100 → 60 → 20 → 0)
    let healths: Vec<f64> = all
        .iter()
        .filter_map(|e| match e {
            CoreEvent::PanelSet { id: 2, field, value } if field == "health" => Some(*value),
            _ => None,
        })
        .collect();

    assert_eq!(healths, vec![60.0, 20.0, 0.0]);

    // патроны стрелка списаны трижды
    let ammo: Vec<f64> = all
        .iter()
        .filter_map(|e| match e {
            CoreEvent::PanelSet { id: 1, field, value } if field == "w1" => Some(*value),
            _ => None,
        })
        .collect();

    assert_eq!(ammo, vec![199.0, 198.0, 197.0]);
}

#[test]
fn friendly_fire_disabled_blocks_damage() {
    let mut core = make_core();

    core.spawn_actor(1, "m1", 1, 0.0, 0.0, 0.0).unwrap();
    core.spawn_actor(2, "m1", 1, 60.0, 0.0, 0.0).unwrap();

    core.step(DT);
    core.take_events();

    core.apply_input(1, 1, "down", "fire");
    steps(&mut core, 4);

    let all = events(&mut core);

    assert!(
        !all.iter()
            .any(|e| matches!(e, CoreEvent::PanelSet { id: 2, field, .. } if field == "health")),
        "урон по своей команде запрещён: {all:?}"
    );
    assert!(core.is_alive(2));
}

#[test]
fn bomb_detonates_and_damages_nearby_enemy() {
    let mut core = make_core();

    core.spawn_actor(1, "m1", 1, 0.0, 0.0, 0.0).unwrap();
    core.spawn_actor(2, "m1", 2, 20.0, 0.0, 0.0).unwrap();

    core.take_events();

    // переключение на бомбу (w2) и выстрел
    core.apply_input(1, 1, "down", "nextWeapon");
    core.step(DT);
    core.apply_input(1, 2, "down", "fire");

    // 300 мс жизни бомбы + запас
    steps(&mut core, 50);

    let all = events(&mut core);

    // жертва получила урон с falloff (< 70, эпицентр на стрелке)
    let victim_health: Vec<f64> = all
        .iter()
        .filter_map(|e| match e {
            CoreEvent::PanelSet { id: 2, field, value } if field == "health" => Some(*value),
            _ => None,
        })
        .collect();

    assert_eq!(victim_health.len(), 1, "события: {all:?}");
    assert!(victim_health[0] < 100.0 && victim_health[0] > 0.0);

    // стрелок своей команды не пострадал (friendly fire off:
    // владелец бомбы — та же команда)
    assert!(
        !all.iter()
            .any(|e| matches!(e, CoreEvent::PanelSet { id: 1, field, .. } if field == "health")),
        "владелец не должен получить урон: {all:?}"
    );
}

#[test]
fn weapon_switch_cycles_and_reports() {
    let mut core = make_core();

    core.spawn_actor(1, "m1", 1, 0.0, 0.0, 0.0).unwrap();
    core.take_events();

    core.apply_input(1, 1, "down", "nextWeapon");
    core.step(DT);

    let all = events(&mut core);

    assert!(
        all.iter().any(
            |e| matches!(e, CoreEvent::PanelActive { id: 1, field } if field == "w2")
        ),
        "события: {all:?}"
    );

    core.apply_input(1, 2, "down", "nextWeapon");
    core.step(DT);

    let all = events(&mut core);

    assert!(
        all.iter().any(
            |e| matches!(e, CoreEvent::PanelActive { id: 1, field } if field == "w1")
        ),
        "цикл должен вернуться к w1: {all:?}"
    );
}

#[test]
fn bot_moves_on_map() {
    let mut core = make_core();

    core.load_map(&map_json()).unwrap();
    core.spawn_scripted_actor(1, "m1", 1, 100.0, 100.0, 0.0).unwrap();

    let start = core.position_of(1);

    // 3 секунды патрулирования
    steps(&mut core, 360);

    let end = core.position_of(1);
    let dist_sq = (end[0] - start[0]).powi(2) + (end[1] - start[1]).powi(2);

    assert!(dist_sq > 100.0, "бот должен патрулировать, прошёл {dist_sq}");
}

#[test]
fn bots_fight_each_other() {
    let mut core = make_core();

    core.load_map(&map_json()).unwrap();
    core.spawn_scripted_actor(1, "m1", 1, 150.0, 200.0, 0.0).unwrap();
    core.spawn_scripted_actor(2, "m1", 2, 300.0, 200.0, 180.0).unwrap();

    // до 60 секунд боя (боты мажут, как люди). Проверяется завязка боя;
    // исход — в `bots_duel_ends_with_a_kill`
    let mut damaged = false;

    for _ in 0..60 {
        steps(&mut core, 120);

        if events(&mut core).iter().any(
            |e| matches!(e, CoreEvent::PanelSet { field, value, .. } if field == "health" && *value < 100.0),
        ) {
            damaged = true;
            break;
        }
    }

    assert!(damaged, "боты в прямой видимости должны наносить урон");
}

#[test]
fn bots_duel_ends_with_a_kill() {
    let mut core = make_core();

    core.load_map(&map_json()).unwrap();
    core.spawn_scripted_actor(1, "m1", 1, 150.0, 300.0, 0.0).unwrap();
    core.spawn_scripted_actor(2, "m1", 2, 450.0, 300.0, 180.0).unwrap();

    let killed = (0..60).any(|_| {
        steps(&mut core, 120);
        events(&mut core)
            .iter()
            .any(|e| matches!(e, CoreEvent::Death { .. }))
    });

    assert!(killed, "за 60 с дуэли никто не погиб");
}

#[test]
fn bot_accuracy_is_human_like() {
    let mut core = make_core();

    core.load_map(&map_json()).unwrap();
    core.spawn_scripted_actor(1, "m1", 1, 150.0, 300.0, 0.0).unwrap();
    core.spawn_actor(2, "m1", 2, 450.0, 300.0, 180.0).unwrap();
    core.state_mut().sim.debug_set_bot_skill(1, BotSkill::Normal);

    let mut hits = 0;

    // 30 с порциями по 0.1 с: цели возвращается здоровье, чтобы она не
    // умерла, и каждое попадание — это `PanelSet health` меньше 100; импульс
    // попаданий сдвигает цель — она возвращается на место
    for _ in 0..300 {
        steps(&mut core, 12);
        hits += events(&mut core)
            .iter()
            .filter(|e| {
                matches!(e, CoreEvent::PanelSet { id: 2, field, value } if field == "health" && *value < 100.0)
            })
            .count();
        core.reset_actor(2, 2, 450.0, 300.0, 180.0);
        core.state_mut().sim.debug_set_health(2, 100.0);
    }

    let shots = core.state().sim.bot_debug(1).unwrap().stats.shots_fired;
    let accuracy = hits as f32 / shots.max(1) as f32;

    assert!(shots > 10, "бот почти не стрелял: {shots}");
    assert!(
        (0.2..=0.9).contains(&accuracy),
        "меткость {accuracy}: {hits} попаданий из {shots}"
    );
}

/// Дуэль двух ботов до первой смерти (не дольше 60 с): победитель или `None`.
fn duel_winner(
    a: (f32, f32, f32),
    b: (f32, f32, f32),
    skills: [BotSkill; 2],
    seed: u64,
) -> Option<u32> {
    let mut core = make_core_seeded(seed);

    core.load_map(&map_json()).unwrap();
    core.spawn_scripted_actor(1, "m1", 1, a.0, a.1, a.2).unwrap();
    core.spawn_scripted_actor(2, "m1", 2, b.0, b.1, b.2).unwrap();
    core.state_mut().sim.debug_set_bot_skill(1, skills[0]);
    core.state_mut().sim.debug_set_bot_skill(2, skills[1]);

    for _ in 0..60 {
        steps(&mut core, 120);

        let death = events(&mut core).into_iter().find_map(|e| match e {
            CoreEvent::Death { victim, killer } => Some((victim, killer)),
            _ => None,
        });

        if let Some((victim, killer)) = death {
            // самоубийство (падение, своя бомба) — победа другого
            return Some(if killer == victim { 3 - victim } else { killer });
        }
    }

    None
}

/// Сиды дуэлей `hard_bots_beat_easy_bots_more_often`.
const DUEL_SEEDS: [u64; 3] = [42, 7, 2026];

/// Минимальная доля завершившихся дуэлей (победитель есть; замер: 36 из 36).
const DUEL_DECIDED_SHARE: f32 = 0.8;

/// Минимальная доля побед `hard` среди завершившихся дуэлей (замер: 32 из 36).
const HARD_WIN_SHARE: f32 = 0.75;

#[test]
fn hard_bots_beat_easy_bots_more_often() {
    let layouts = [
        ((150.0, 300.0, 0.0), (450.0, 300.0, 180.0)),
        ((150.0, 150.0, 0.0), (450.0, 450.0, 180.0)),
        ((150.0, 450.0, 0.0), (450.0, 150.0, 180.0)),
        ((300.0, 120.0, 90.0), (300.0, 500.0, 270.0)),
        ((120.0, 120.0, 45.0), (500.0, 500.0, 225.0)),
        ((200.0, 300.0, 90.0), (450.0, 250.0, 0.0)),
    ];
    let mut decided = 0;
    let mut hard_wins = 0;
    let mut results = Vec::new();

    // каждая расстановка — с обеих сторон и на нескольких сидах, чтобы итог
    // не решали одна-две партии и сторона старта
    for seed in DUEL_SEEDS {
        for (a, b) in layouts {
            for (skills, hard_id) in [
                ([BotSkill::Hard, BotSkill::Easy], 1),
                ([BotSkill::Easy, BotSkill::Hard], 2),
            ] {
                let winner = duel_winner(a, b, skills, seed);

                if winner.is_some() {
                    decided += 1;
                }

                if winner == Some(hard_id) {
                    hard_wins += 1;
                }

                results.push((seed, hard_id, winner));
            }
        }
    }

    assert!(
        decided as f32 >= DUEL_DECIDED_SHARE * results.len() as f32,
        "завершились {decided} дуэлей из {}: {results:?}",
        results.len()
    );
    assert!(
        hard_wins as f32 >= HARD_WIN_SHARE * decided as f32,
        "hard выиграл {hard_wins} из {decided}: {results:?}"
    );
}

#[test]
fn remove_players_and_shots_reports_names() {
    let mut core = make_core();

    core.spawn_actor(1, "m1", 1, 0.0, 0.0, 0.0).unwrap();

    let names: Vec<String> =
        serde_json::from_str(&core.remove_players_and_shots()).unwrap();

    assert!(names.contains(&"m1".to_string()));
    assert!(names.contains(&"w1".to_string()));
    assert!(names.contains(&"w2".to_string()));
    assert!(names.contains(&"w2e".to_string()));
    assert!(core.position_of(1).is_empty());
}

#[test]
fn reset_actor_moves_and_stops() {
    let mut core = make_core();

    core.spawn_actor(1, "m1", 1, 0.0, 0.0, 0.0).unwrap();
    core.apply_input(1, 1, "down", "forward");
    steps(&mut core, 60);

    core.reset_actor(1, 2, 500.0, 300.0, 90.0);

    let pos = core.position_of(1);

    assert_eq!(pos, vec![500.0, 300.0]);

    // клавиши сброшены — танк не продолжает ехать
    steps(&mut core, 30);

    let pos_after = core.position_of(1);

    assert!((pos_after[0] - 500.0).abs() < 0.5);
    assert!((pos_after[1] - 300.0).abs() < 0.5);
}

#[test]
fn state_dump_restores_identical_simulation() {
    let mut core = make_core();

    core.load_map(&map_json()).unwrap();
    core.spawn_actor(1, "m1", 1, 100.0, 100.0, 0.0).unwrap();
    core.spawn_scripted_actor(2, "m1", 2, 400.0, 400.0, 180.0).unwrap();
    core.apply_input(1, 1, "down", "forward");

    steps(&mut core, 60);
    core.pack_body().unwrap(); // дренаж накопителей перед дампом
    core.take_events();

    let dump = core.serialize_state().unwrap();

    let mut restored = make_core();

    restored.deserialize_state(&dump).unwrap();

    // продолжение симуляции бит-в-бит (Spike B: эстафета без разрыва)
    steps(&mut core, 120);
    steps(&mut restored, 120);

    assert_eq!(core.position_of(1), restored.position_of(1));
    assert_eq!(core.position_of(2), restored.position_of(2));
}

// ***** производные данные карты (поле `game`) ***** //

/// Дамп состояния с подменённым полем `game` карты: так в ядро попадает
/// карта, которую хук `on_map_loaded` не видел.
fn dump_with_map_game(core: &mut GameCore, game: serde_json::Value) -> Vec<u8> {
    core.pack_body().unwrap();
    core.take_events();

    let mut dump: serde_json::Value =
        serde_json::from_slice(&core.serialize_state().unwrap()).unwrap();

    dump["map"]["game"] = game;

    serde_json::to_vec(&dump).unwrap()
}

#[test]
fn map_load_rebuilds_derived_data_and_resets_the_round() {
    let mut core = make_core();

    core.load_map(&map_json()).unwrap();

    let sim = &core.state().sim;

    assert_eq!((sim.map_derived_rebuilds(), sim.round_state_resets()), (1, 1));

    // рестарт раунда — та же карта: хук зовётся снова
    core.load_map(&map_json()).unwrap();
    steps(&mut core, 2);

    let sim = &core.state().sim;

    assert_eq!((sim.map_derived_rebuilds(), sim.round_state_resets()), (2, 2));
}

#[test]
fn map_game_is_parsed_on_load_and_broken_game_fails_the_load() {
    let mut core = make_core();
    let mut map: serde_json::Value = serde_json::from_str(&map_json()).unwrap();

    map["game"] = serde_json::json!({
        "surfaces": { "0": { "41": "sand" } },
        "lighting": { "ambient": 0.2 }
    });
    core.load_map(&map.to_string()).unwrap();

    assert_eq!(core.state().sim.map_game().surfaces["0"].len(), 1);

    map["game"] = serde_json::json!({ "surfaces": { "0": { "41": 5 } } });

    // ошибка — через EngineSim: JsError вне WASM не создаётся
    let error = core.state_mut().load_map(&map.to_string()).unwrap_err();

    assert!(error.contains("map game"), "{error}");
}

#[test]
fn deserialize_rebuilds_map_derived_data_once_on_first_step() {
    for map in [map_json(), layered_map_json()] {
        let mut core = make_core();

        core.load_map(&map).unwrap();
        steps(&mut core, 5);

        let dump = dump_with_map_game(&mut core, serde_json::json!({
            "surfaces": { "0": { "41": "sand" } }
        }));
        let mut restored = make_core();

        restored.deserialize_state(&dump).unwrap();

        let sim = &restored.state().sim;

        assert_eq!((sim.map_derived_rebuilds(), sim.round_state_resets()), (0, 0));

        steps(&mut restored, 1);

        let sim = &restored.state().sim;

        // только пересборка, без сброса раунда: разрушения из дампа живут
        assert_eq!((sim.map_derived_rebuilds(), sim.round_state_resets()), (1, 0));
        assert_eq!(sim.map_game().surfaces["0"].len(), 1);

        steps(&mut restored, 1);

        assert_eq!(restored.state().sim.map_derived_rebuilds(), 1);
    }
}

#[test]
fn broken_map_game_after_deserialize_reports_an_event_and_keeps_stepping() {
    let mut core = make_core();

    core.load_map(&map_json()).unwrap();
    core.spawn_actor(1, "m1", 1, 100.0, 100.0, 0.0).unwrap();
    core.apply_input(1, 1, "down", "forward");
    steps(&mut core, 5);

    let dump = dump_with_map_game(&mut core, serde_json::json!({ "surfaces": 5 }));
    let mut restored = make_core();

    restored.deserialize_state(&dump).unwrap();

    let before = restored.position_of(1);

    steps(&mut restored, 30);

    // танк едет дальше по нейтральному пути
    assert!(restored.position_of(1) != before);
    assert!(restored.state().sim.map_game().surfaces.is_empty());

    let raw: Vec<serde_json::Value> = serde_json::from_str(&restored.take_events()).unwrap();
    let reported: Vec<&serde_json::Value> = raw
        .iter()
        .filter(|event| event["type"] == "custom")
        .filter(|event| event["data"]["type"] == "mapDerivedError")
        .collect();

    assert_eq!(reported.len(), 1, "{raw:?}");
    assert!(reported[0]["data"]["message"].as_str().unwrap().contains("map game"));

    // флаг снят: второй шаг ошибку не повторяет
    steps(&mut restored, 1);

    assert!(!restored.take_events().contains("mapDerivedError"));
}

#[test]
fn clear_resets_world() {
    let mut core = make_core();

    core.load_map(&map_json()).unwrap();
    core.spawn_actor(1, "m1", 1, 100.0, 100.0, 0.0).unwrap();
    core.spawn_scripted_actor(2, "m1", 2, 400.0, 400.0, 180.0).unwrap();

    steps(&mut core, 10);
    core.clear();

    assert!(core.position_of(1).is_empty());
    assert!(core.position_of(2).is_empty());
    assert_eq!(core.map_info(), "null");

    // мир пригоден к новой карте и новым игрокам
    core.load_map(&map_json()).unwrap();
    core.spawn_actor(3, "m1", 1, 100.0, 100.0, 0.0).unwrap();
    steps(&mut core, 10);

    assert!(!core.position_of(3).is_empty());
}

/// Конфиг с заданной дальностью и импульсом пули; остальное — flat_config_json().
fn config_json_with_bullet(range: f32, impulse: f32) -> String {
    let mut flat = flat_config_json();

    flat["weapons"]["w1"]["range"] = serde_json::json!(range);
    flat["weapons"]["w1"]["impulseMagnitude"] = serde_json::json!(impulse);

    wrap_config(flat)
}

/// Карта из map_json() с одним динамическим ящиком 32×32 в позиции (x, y).
/// Демпфирование нулевое: смещение от импульса читается без затухания.
fn map_with_box_json(x: f32, y: f32) -> String {
    let mut map: serde_json::Value = serde_json::from_str(&map_json()).unwrap();

    map["physicsDynamic"] = serde_json::json!([{
        "density": 100,
        "position": [x, y],
        "angle": 0,
        "width": 32,
        "height": 32,
        "linearDamping": 0,
        "angularDamping": 0
    }]);

    map.to_string()
}

/// Строка снапшота единственного динамического тела карты
/// (Map.getDynamicMapData); `with_velocities` — как у схемы `c1`/`c2`
/// с опциональным хвостом (см. src/config/snapshot.js).
fn dynamic_box_row(core: &GameCore, with_levels: bool, with_velocities: bool) -> Vec<FieldValue> {
    let state = core.state();
    let map = state.map.as_ref().expect("карта загружена");
    let rows = map.dynamic_map_data(&state.world, with_levels, with_velocities);
    let (_, fields) = rows.first().expect("на карте один динамический ящик");

    fields.clone()
}

/// X единственного динамического тела карты (Map.getDynamicMapData).
fn dynamic_box_x(core: &GameCore) -> f32 {
    match dynamic_box_row(core, false, false)[0] {
        FieldValue::F32(x) => x,
        _ => panic!("поле x строки динамики должно быть f32"),
    }
}

#[test]
fn hitscan_impulse_independent_of_weapon_range() {
    // ящик стоит перед стрелком: луч проходит через его середину по Y
    // (тело — «угол объекта», коллайдер смещён на полгабарита)
    const BOX_X: f32 = 200.0;
    const BOX_Y: f32 = 84.0;
    const IMPULSE: f32 = 7_500_000.0;

    let displacement = |range: f32| {
        let mut core = GameCore::new(&config_json_with_bullet(range, IMPULSE)).unwrap();

        core.load_map(&map_with_box_json(BOX_X, BOX_Y)).unwrap();
        core.spawn_actor(1, "m1", 1, 100.0, 100.0, 0.0).unwrap();

        // прогрев: broad-phase узнаёт о новых телах на шаге мира
        core.step(DT);

        let before = dynamic_box_x(&core);

        core.apply_input(1, 1, "down", "fire");
        steps(&mut core, 10);

        dynamic_box_x(&core) - before
    };

    let short = displacement(200.0);
    let long = displacement(1500.0);

    assert!(short > 0.0, "ящик должен сдвинуться от попадания, Δx = {short}");

    // импульс строится от нормализованного direction·impulseMagnitude —
    // одинаков для короткого и длинного range при равном impulseMagnitude
    assert!(
        (short - long).abs() < 1e-3,
        "Δx короткого ({short}) и длинного ({long}) оружия должны совпасть",
    );
}

/// Взрыв двигает динамику карты: у тела карты движковый тег
/// (`MAP_OBJECT_TAG`), а не игровой `BodyTag` — он не должен исключать
/// тело из целей детонации (импульс без урона, как в Bomb.detonate).
#[test]
fn explosion_pushes_dynamic_map_box() {
    // угол ящика; расстояние до бомбы считается от центра коллайдера
    // (126, 126), он должен лечь в радиус 50
    const BOX_X: f32 = 110.0;
    const BOX_Y: f32 = 110.0;

    // общий сценарий: выстрел бомбой рядом с ящиком (fire) либо покой
    let displacement = |fire: bool| {
        let mut core = make_core();

        core.load_map(&map_with_box_json(BOX_X, BOX_Y)).unwrap();
        core.spawn_actor(1, "m1", 1, 100.0, 100.0, 0.0).unwrap();

        // прогрев: broad-phase узнаёт о новых телах на шаге мира
        core.step(DT);

        let before = dynamic_box_x(&core);

        if fire {
            // переключение на бомбу (w2) и выстрел
            core.apply_input(1, 1, "down", "nextWeapon");
            core.step(DT);
            core.apply_input(1, 2, "down", "fire");
        }

        // 300 мс жизни бомбы + запас
        steps(&mut core, 50);

        dynamic_box_x(&core) - before
    };

    let idle = displacement(false);
    let blast = displacement(true);

    assert!(idle.abs() < 1e-3, "без выстрела ящик стоит, Δx = {idle}");
    assert!(blast > 0.0, "взрыв должен оттолкнуть ящик, Δx = {blast}");
}

/// Кадр v4: движущееся тело карты отдаёт хвост со скоростями, покоящееся —
/// только трансформацию (клиент предсказывает динамику по этим скоростям).
#[test]
fn dynamic_box_ships_velocity_tail_only_while_moving() {
    const BOX_X: f32 = 200.0;
    const BOX_Y: f32 = 84.0;

    let mut core = GameCore::new(&config_json_with_bullet(1500.0, 7_500_000.0)).unwrap();

    core.load_map(&map_with_box_json(BOX_X, BOX_Y)).unwrap();
    core.spawn_actor(1, "m1", 1, 100.0, 100.0, 0.0).unwrap();
    core.step(DT);

    // до выстрела ящик стоит: хвоста нет даже при запросе скоростей
    assert_eq!(dynamic_box_row(&core, false, true).len(), 3);
    // голова со схемой 2.5D — [x, y, angle, z, level], хвоста по-прежнему нет
    assert_eq!(dynamic_box_row(&core, true, true).len(), 5);

    core.apply_input(1, 1, "down", "fire");
    steps(&mut core, 10);

    let moving = dynamic_box_row(&core, true, true);

    assert_eq!(moving.len(), 8, "ящик едет — строка обязана нести скорости");

    // индекс скоростей съехал с 3 на 5: перед ними идут z и level
    match moving[5] {
        FieldValue::F32(vx) => assert!(vx > 0.0, "vx должен быть положительным: {vx}"),
        _ => panic!("поле vx строки динамики должно быть f32"),
    }

    // схема без хвоста ширину строки не меняет
    assert_eq!(dynamic_box_row(&core, true, false).len(), 5);
}

// Примечание: конструктор GameCore::new теперь отклоняет невалидную
// snapshot-схему (SnapshotConfig::validate, см. core/src/config.rs), но
// проверить это интеграционным тестом здесь нельзя — JsError::new вызывает
// wasm-bindgen import, недоступный на нативном таргете `cargo test`
// (паника "cannot call wasm-bindgen imported functions on non-wasm
// targets" на любом Err-пути `Result<_, JsError>`, не только в этой
// проверке). Покрытие валидации — юнит-тесты `config.rs::validate_tests`,
// которые тестируют `SnapshotConfig::validate()` напрямую, в обход
// wasm-bindgen обёртки.

/// Та же слоёная карта, но колонка 10 плиты — перила (тайл 4: и пол, и
/// стена уровня 1). Ими закрыт западный край моста — кроме строки 9, куда
/// приходит рампа: перила поперёк её вершины валидатор считает рампой,
/// ведущей в пустоту (въехать некуда).
fn railed_map_json() -> String {
    let mut map: serde_json::Value = serde_json::from_str(&layered_map_json()).unwrap();

    {
        let slab = map["levels"]["1"]["map"].as_array_mut().unwrap();

        for (index, row) in slab.iter_mut().enumerate().take(15).skip(5) {
            if index == 9 {
                continue;
            }

            row.as_array_mut().unwrap()[10] = serde_json::json!(4);
        }
    }

    map["levels"]["1"]["floor"] = serde_json::json!([2, 4]);
    map["levels"]["1"]["walls"] = serde_json::json!([4]);

    map.to_string()
}

/// Здоровье, объявленное панелью для игрока `id` (последнее значение).
fn health_of(all: &[CoreEvent], id: u32) -> Option<f64> {
    all.iter()
        .filter_map(|event| match event {
            CoreEvent::PanelSet { id: got, field, value } if *got == id && field == "health" => {
                Some(*value)
            }
            _ => None,
        })
        .last()
}

/// Один выстрел активным оружием игрока 1 и `count` шагов после него.
fn fire(core: &mut GameCore, seq: u32, count: usize) {
    core.apply_input(1, seq, "down", "fire");
    steps(core, count);
}

#[test]
fn spawn_on_slab_starts_on_level_one() {
    let mut core = make_core();

    core.load_map(&layered_map_json()).unwrap();
    core.spawn_actor(1, "m1", 1, SLAB.0, SLAB.1, 0.0).unwrap();
    core.spawn_actor(2, "m1", 2, GROUND.0, GROUND.1, 0.0).unwrap();

    steps(&mut core, 2);

    assert_eq!(level_of(&core, 1), 1, "танк на плите — уровень 1");
    assert_eq!(level_of(&core, 2), 0, "танк на земле — уровень 0");
}

#[test]
fn set_actor_level_overrides_geometry() {
    let mut core = make_core();

    core.load_map(&layered_map_json()).unwrap();
    core.spawn_actor(1, "m1", 1, SLAB.0, SLAB.1, 0.0).unwrap();

    steps(&mut core, 2);
    assert_eq!(level_of(&core, 1), 1);

    // респаун под мостом: уровень назван явно и геометрия его не перебивает
    core.set_actor_level(1, 0);
    steps(&mut core, 2);

    assert_eq!(level_of(&core, 1), 0);
}

#[test]
fn state_dump_keeps_the_tank_level() {
    let mut core = make_core();

    core.load_map(&layered_map_json()).unwrap();
    core.spawn_actor(1, "m1", 1, SLAB.0, SLAB.1, 0.0).unwrap();
    steps(&mut core, 2);
    // под мостом: уровень задан явно и расходится с геометрией
    core.set_actor_level(1, 0);
    steps(&mut core, 2);
    core.pack_body().unwrap();
    core.take_events();

    let dump = core.serialize_state().unwrap();
    let mut restored = make_core();

    restored.deserialize_state(&dump).unwrap();
    steps(&mut restored, 2);

    assert_eq!(level_of(&restored, 1), 0, "уровень из дампа пересчитан по геометрии");
}

#[test]
fn ramp_lifts_tank_to_level_one() {
    let mut core = make_core();

    core.load_map(&layered_map_json()).unwrap();
    // подножие рампы: колонка 6, строка 9
    core.spawn_actor(1, "m1", 1, 208.0, 304.0, 0.0).unwrap();
    core.apply_input(1, 1, "down", "forward");

    steps(&mut core, 2);
    assert_eq!(level_of(&core, 1), 0, "у подножия рампа ещё внизу");

    steps(&mut core, 120);

    assert_eq!(level_of(&core, 1), 1, "проехав рампу, танк наверху");
}

// Пуля летит на высоте ствола (`shot_height`): ствол 2.4 при уровне 32 —
// пуля пола на 0.075 уровня, склон рампы (x 192..320) дорастает до неё на
// x = 201.6. Танк дальше по склону с земли недосягаем.
#[test]
fn ground_shot_stops_on_the_slope_before_a_tank_high_on_the_ramp() {
    let mut core = make_core();

    core.load_map(&layered_map_json()).unwrap();
    core.spawn_actor(2, "m1", 2, 208.0, 304.0, 0.0).unwrap();
    core.spawn_actor(1, "m1", 1, 100.0, 304.0, 0.0).unwrap();
    core.apply_input(2, 1, "down", "forward");

    for _ in 0..200 {
        steps(&mut core, 1);

        if tank_z(&core, 2) >= 0.6 {
            break;
        }
    }

    assert!(tank_z(&core, 2) >= 0.6, "цель не поднялась: z={}", tank_z(&core, 2));

    core.take_events();
    fire(&mut core, 1, 1);

    assert_eq!(health_of(&events(&mut core), 2), None, "насыпь закрыла цель");
}

#[test]
fn ground_shot_hits_a_tank_at_the_foot_of_the_ramp() {
    let mut core = make_core();

    core.load_map(&layered_map_json()).unwrap();
    core.spawn_actor(2, "m1", 2, 196.0, 304.0, 0.0).unwrap();
    core.spawn_actor(1, "m1", 1, 100.0, 304.0, 0.0).unwrap();
    steps(&mut core, 2);
    core.take_events();
    fire(&mut core, 1, 1);

    let health = health_of(&events(&mut core), 2);

    assert!(health.is_some_and(|h| h < 100.0), "цель у подножия поражена: {health:?}");
}

// Пуля с моста не падает: над рампой и землёй она летит на высоте моста,
// танк на земле до неё не дорастает.
#[test]
fn bridge_shot_down_the_ramp_passes_over_a_ground_tank() {
    let mut core = make_core();

    core.load_map(&layered_map_json()).unwrap();
    core.spawn_actor(1, "m1", 1, 352.0, 304.0, 180.0).unwrap();
    core.spawn_actor(2, "m1", 2, 150.0, 304.0, 0.0).unwrap();
    steps(&mut core, 2);
    assert_eq!(level_of(&core, 1), 1, "стрелок на плите");
    core.take_events();
    fire(&mut core, 1, 1);

    let health = health_of(&events(&mut core), 2);

    assert_eq!(health, None, "пуля с моста прошла над целью под рампой: {health:?}");
}

// Танк на середине рампы (верх 0.69) ниже пули с моста (1.075).
#[test]
fn bridge_shot_passes_over_a_tank_midway_up_the_ramp() {
    let mut core = make_core();

    core.load_map(&layered_map_json()).unwrap();
    core.spawn_actor(1, "m1", 1, 400.0, 304.0, 180.0).unwrap();
    core.spawn_actor(2, "m1", 2, 208.0, 304.0, 0.0).unwrap();
    core.apply_input(2, 1, "down", "forward");

    for _ in 0..200 {
        steps(&mut core, 1);

        if tank_z(&core, 2) >= 0.6 {
            break;
        }
    }

    assert!(tank_z(&core, 2) >= 0.6, "цель не поднялась: z={}", tank_z(&core, 2));
    assert_eq!(level_of(&core, 1), 1, "стрелок на плите");

    core.take_events();
    fire(&mut core, 1, 1);

    assert_eq!(health_of(&events(&mut core), 2), None, "пуля прошла над целью на рампе");
}

#[test]
fn turret_works_while_falling() {
    // правило полёта: газ и корпус заблокированы, а башня работает
    let mut core = make_core();

    core.load_map(&layered_map_json()).unwrap();
    core.spawn_actor(1, "m1", 1, GROUND.0, GROUND.1, 0.0).unwrap();

    steps(&mut core, 2);

    // над землёй плиты нет: уровень 1 в этой точке — обрыв
    core.set_actor_level(1, 1);
    steps(&mut core, 2);
    assert_eq!(level_of(&core, 1), 1, "танк в полёте");

    let before = gun_rotation_of(&core, 1);

    core.apply_input(1, 1, "down", "gunLeft");
    steps(&mut core, 10);

    assert_eq!(level_of(&core, 1), 1, "танк всё ещё в полёте");
    assert!(
        gun_rotation_of(&core, 1) < before,
        "башня падающего танка обязана поворачиваться"
    );
}

#[test]
fn landing_applies_fall_damage() {
    let mut core = make_core();

    core.load_map(&layered_map_json()).unwrap();
    core.spawn_actor(1, "m1", 1, GROUND.0, GROUND.1, 0.0).unwrap();

    steps(&mut core, 2);
    core.take_events();

    // над землёй плиты нет: уровень 1 в этой точке — обрыв
    core.set_actor_level(1, 1);
    steps(&mut core, 2);
    assert_eq!(level_of(&core, 1), 1);

    // fallTime = 0.35 c = 42 шага
    steps(&mut core, 50);

    let all = events(&mut core);
    let health = all
        .iter()
        .filter_map(|event| match event {
            CoreEvent::PanelSet { id: 1, field, value } if field == "health" => Some(*value),
            _ => None,
        })
        .last();

    assert_eq!(health, Some(85.0), "приземление стоит fallDamage");
    assert_eq!(level_of(&core, 1), 0, "танк оказался на земле");

    // добивание падениями: 100 - 15 * 7 < 0
    let mut killed = false;

    for _ in 0..7 {
        core.set_actor_level(1, 1);
        steps(&mut core, 52);

        killed = events(&mut core)
            .iter()
            .any(|event| matches!(event, CoreEvent::Death { victim: 1, killer: 1 }));

        if killed {
            break;
        }
    }

    assert!(killed, "смерть от падения засчитывается самоубийством");
}

/// Конфиг из `config_json()` с блоком `levels.landingShake`.
fn config_json_with_landing_shake(min_impact: f32, full_impact: f32) -> String {
    let mut flat = flat_config_json();

    flat["levels"]["landingShake"] = serde_json::json!({
        "intensity": 6.0,
        "duration": 300.0,
        "minImpact": min_impact,
        "fullImpact": full_impact
    });

    wrap_config(flat)
}

/// Роняет танк с уровня 1 на землю и отдаёт тряски, случившиеся за падение.
fn shakes_after_a_fall(config: &str) -> Vec<(u32, f64, f64)> {
    let mut core = GameCore::new(config).unwrap();

    core.load_map(&layered_map_json()).unwrap();
    core.spawn_actor(1, "m1", 1, GROUND.0, GROUND.1, 0.0).unwrap();

    steps(&mut core, 2);
    core.take_events();

    // над землёй плиты нет: уровень 1 в этой точке — обрыв
    core.set_actor_level(1, 1);
    steps(&mut core, 2);
    assert_eq!(level_of(&core, 1), 1);

    // fallTime = 0.35 c = 42 шага
    steps(&mut core, 50);
    assert_eq!(level_of(&core, 1), 0, "танк обязан приземлиться");

    events(&mut core)
        .iter()
        .filter_map(|event| match event {
            CoreEvent::Shake { id, intensity, duration } => Some((*id, *intensity, *duration)),
            _ => None,
        })
        .collect()
}

#[test]
fn hard_landing_shakes_the_camera_once() {
    let shakes = shakes_after_a_fall(&config_json_with_landing_shake(1.5, 6.0));

    assert_eq!(shakes.len(), 1, "ровно одна тряска на приземление");

    let (id, intensity, duration) = shakes[0];

    assert_eq!(id, 1, "трясёт камеру тому, кто приземлился");
    assert_eq!(duration, 300.0);
    assert!(
        intensity > 0.0 && intensity <= 6.0,
        "интенсивность зажата потолком, получено {intensity}"
    );
}

#[test]
fn soft_landing_does_not_shake_the_camera() {
    // порог выше скорости касания при падении с одного уровня
    let shakes = shakes_after_a_fall(&config_json_with_landing_shake(8.0, 12.0));

    assert!(shakes.is_empty(), "мягкое касание камеру не трогает");
}

#[test]
fn landing_shake_intensity_is_capped() {
    // fullImpact ниже реальной скорости касания: k зажимается единицей
    let shakes = shakes_after_a_fall(&config_json_with_landing_shake(0.5, 2.0));

    assert_eq!(shakes.len(), 1);
    assert_eq!(shakes[0].1, 6.0, "сильнее полного удара тряски не бывает");
}

#[test]
fn landing_without_the_config_block_does_not_shake() {
    // `config_json()` блока landingShake не объявляет — поведение прежнее
    let shakes = shakes_after_a_fall(&config_json());

    assert!(shakes.is_empty(), "без блока в конфиге тряски нет вовсе");
}

#[test]
fn hull_hanging_over_the_edge_does_not_fall() {
    let mut core = make_core();

    core.load_map(&layered_map_json()).unwrap();
    // плита уровня 1 — колонки 10..12, то есть восточная кромка на x=416.
    // Центр корпуса уже за кромкой, но сам корпус ещё лежит на плите
    core.spawn_actor(1, "m1", 1, 418.0, 272.0, 0.0).unwrap();
    steps(&mut core, 2);
    core.set_actor_level(1, 1);
    steps(&mut core, 30);

    assert_eq!(level_of(&core, 1), 1, "свес за кромку — ещё не срыв");

    // ввод не заперт: реверс возвращает танк на плиту
    core.apply_input(1, 1, "down", "back");
    steps(&mut core, 60);

    assert_eq!(level_of(&core, 1), 1, "реверс у кромки удержал на уровне");
    assert!(
        tank_x(&core, 1) < 414.0,
        "танк не поехал назад: x={}",
        tank_x(&core, 1)
    );

    // а корпус целиком за кромкой падает, как и прежде
    core.apply_input(1, 1, "up", "back");
    core.apply_input(1, 1, "down", "forward");
    steps(&mut core, 200);

    assert_eq!(level_of(&core, 1), 0, "корпус за кромкой — падение");
}

#[test]
fn second_layered_map_of_the_same_size_rebuilds_levels() {
    let mut core = make_core();

    core.load_map(&layered_map_json()).unwrap();
    core.spawn_actor(1, "m1", 1, SLAB.0, SLAB.1, 0.0).unwrap();
    steps(&mut core, 2);
    assert_eq!(level_of(&core, 1), 1);

    // та же размерность и тот же setId, но плиты в этой точке больше нет:
    // отпечаток обязан заметить смену содержимого слоёв
    let mut other: serde_json::Value = serde_json::from_str(&layered_map_json()).unwrap();

    other["levels"]["1"]["map"] = serde_json::json!(vec![vec![0; 20]; 20]);
    // плиты нет — рампе некуда вести, иначе карту отвергнет валидатор
    other["ramps"] = serde_json::json!([]);

    core.load_map(&other.to_string()).unwrap();
    steps(&mut core, 2);

    assert_eq!(level_of(&core, 1), 0, "слои пересобраны по новой карте");
}

#[test]
fn falling_tank_stops_at_the_wall() {
    let mut core = make_core();

    core.load_map(&layered_map_json()).unwrap();
    // разгон на запад, к стене периметра (колонка 0: x от 0 до 32)
    core.spawn_actor(1, "m1", 1, 400.0, 112.0, 180.0).unwrap();
    core.apply_input(1, 1, "down", "forward");

    for _ in 0..600 {
        core.step(DT);

        if tank_x(&core, 1) < 80.0 {
            break;
        }
    }

    let x_before = tank_x(&core, 1);

    assert!(x_before < 80.0, "танк не разогнался: x={x_before}");

    // обрыв под танком: дальше он летит по инерции, ввод заблокирован
    core.set_actor_level(1, 1);
    steps(&mut core, 60);

    let x_after = tank_x(&core, 1);

    assert_eq!(level_of(&core, 1), 0, "танк приземлился");
    assert!(
        x_after > 32.0,
        "падающий прошёл сквозь стену периметра: x={x_after}"
    );
    assert!(x_after < x_before, "инерция падения не сработала");
}

#[test]
fn tanks_on_different_levels_do_not_collide() {
    let mut core = make_core();

    core.load_map(&layered_map_json()).unwrap();
    core.spawn_actor(1, "m1", 1, SLAB.0, SLAB.1, 0.0).unwrap();
    core.spawn_actor(2, "m1", 2, GROUND.0, GROUND.1, 0.0).unwrap();

    steps(&mut core, 2);

    // второй танк переезжает под мост и остаётся на земле
    core.reset_actor(2, 2, SLAB.0, SLAB.1, 0.0);
    core.set_actor_level(2, 0);

    steps(&mut core, 120);

    let a = core.position_of(1);
    let b = core.position_of(2);

    assert!(
        (a[0] - SLAB.0).abs() < 1.0 && (a[1] - SLAB.1).abs() < 1.0,
        "танк уровня 1 стоит на месте: {a:?}"
    );
    assert!(
        (b[0] - SLAB.0).abs() < 1.0 && (b[1] - SLAB.1).abs() < 1.0,
        "танк уровня 0 стоит на месте: {b:?}"
    );

    // контроль: на одном уровне те же тела расталкиваются
    core.set_actor_level(2, 1);
    steps(&mut core, 120);

    let a = core.position_of(1);
    let b = core.position_of(2);
    let distance = ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt();

    assert!(distance > 1.0, "на одном уровне контакт есть: {distance}");
}


#[test]
fn bridge_shot_hits_bridge_tank_not_ground_tank() {
    let mut core = make_core();

    core.load_map(&layered_map_json()).unwrap();
    // стрелок на западном краю плиты, обе цели — в одной точке на востоке:
    // одна на мосту, вторая под ним
    core.spawn_actor(1, "m1", 1, 336.0, 272.0, 0.0).unwrap();
    core.spawn_actor(2, "m1", 2, 400.0, 272.0, 0.0).unwrap();
    core.spawn_actor(3, "m1", 2, 400.0, 272.0, 0.0).unwrap();

    // уровень назначается после первого шага: он пересчитывает уровни всех
    // танков по свежей геометрии карты
    steps(&mut core, 2);
    core.set_actor_level(3, 0);
    steps(&mut core, 2);

    assert_eq!(level_of(&core, 1), 1);
    assert_eq!(level_of(&core, 2), 1);
    assert_eq!(level_of(&core, 3), 0);
    core.take_events();

    fire(&mut core, 1, 4);

    let all = events(&mut core);

    assert!(health_of(&all, 2).is_some_and(|h| h < 100.0), "события: {all:?}");
    assert_eq!(health_of(&all, 3), None, "под мостом плита экранирует: {all:?}");
}

#[test]
fn shot_past_the_ledge_passes_over_the_ground_tank() {
    let mut core = make_core();

    core.load_map(&layered_map_json()).unwrap();
    core.spawn_actor(1, "m1", 1, 336.0, 272.0, 0.0).unwrap();
    // цель за восточной кромкой моста, на земле
    core.spawn_actor(2, "m1", 2, 460.0, 272.0, 0.0).unwrap();

    steps(&mut core, 2);
    assert_eq!(level_of(&core, 1), 1);
    assert_eq!(level_of(&core, 2), 0);
    core.take_events();

    fire(&mut core, 1, 4);

    let all = events(&mut core);

    assert_eq!(health_of(&all, 2), None, "за кромкой пуля летит над землёй: {all:?}");
}

#[test]
fn ground_shot_does_not_reach_a_tank_on_the_open_edge() {
    let mut core = make_core();

    core.load_map(&layered_map_json()).unwrap();
    // стрелок на земле западнее моста, цель — в первой же клетке плиты
    core.spawn_actor(1, "m1", 1, 290.0, 272.0, 0.0).unwrap();
    core.spawn_actor(2, "m1", 2, 336.0, 272.0, 0.0).unwrap();

    steps(&mut core, 2);
    assert_eq!(level_of(&core, 1), 0);
    assert_eq!(level_of(&core, 2), 1);
    core.take_events();

    fire(&mut core, 1, 4);

    let all = events(&mut core);

    assert_eq!(health_of(&all, 2), None, "пуля с земли идёт под плитой: {all:?}");
}

#[test]
fn ground_shot_stops_at_the_second_slab_cell() {
    let mut core = make_core();

    core.load_map(&layered_map_json()).unwrap();
    // тот же выстрел снизу, но цель — во ВТОРОЙ клетке плиты: пуля с
    // земли идёт под плитой
    core.spawn_actor(1, "m1", 1, 290.0, 272.0, 0.0).unwrap();
    core.spawn_actor(2, "m1", 2, 376.0, 272.0, 0.0).unwrap();

    steps(&mut core, 2);
    assert_eq!(level_of(&core, 2), 1);
    core.take_events();

    fire(&mut core, 1, 4);

    let all = events(&mut core);

    assert_eq!(
        health_of(&all, 2),
        None,
        "пуля с земли идёт под плитой: {all:?}"
    );
}

#[test]
fn railing_protects_the_tank_from_below() {
    let mut core = make_core();

    core.load_map(&railed_map_json()).unwrap();
    // тот же выстрел снизу, первая клетка плиты на пути — перила; пуля с
    // земли идёт под плитой
    core.spawn_actor(1, "m1", 1, 290.0, 272.0, 0.0).unwrap();
    // за перилами: клетка перил непроезжая, цель стоит на следующей плите
    core.spawn_actor(2, "m1", 2, 368.0, 272.0, 0.0).unwrap();

    steps(&mut core, 2);
    assert_eq!(level_of(&core, 2), 1);
    core.take_events();

    fire(&mut core, 1, 4);

    let all = events(&mut core);

    assert_eq!(health_of(&all, 2), None, "перила закрывают край: {all:?}");
}

#[test]
fn falling_tank_is_not_hit() {
    let mut core = make_core();

    core.load_map(&layered_map_json()).unwrap();
    core.spawn_actor(1, "m1", 1, 112.0, 112.0, 0.0).unwrap();
    core.spawn_actor(2, "m1", 2, 172.0, 112.0, 0.0).unwrap();

    steps(&mut core, 2);
    core.take_events();

    // контроль: на земле цель поражается
    fire(&mut core, 1, 4);
    assert!(health_of(&events(&mut core), 2).is_some());

    // уровень 1 над открытой землёй — обрыв: танк падает
    core.set_actor_level(2, 1);
    steps(&mut core, 2);
    core.take_events();

    // fallTime = 0.35 c = 42 шага: выстрел и проверка — внутри падения
    fire(&mut core, 2, 4);

    let all = events(&mut core);

    assert_eq!(health_of(&all, 2), None, "падающий неуязвим: {all:?}");
}

#[test]
fn slab_shields_the_explosion() {
    // бомба на земле ровно под танком на мосту: плита экранирует взрыв
    let mut core = make_core();

    core.load_map(&layered_map_json()).unwrap();
    core.spawn_actor(1, "m1", 1, 368.0, 300.0, 0.0).unwrap();
    core.spawn_actor(2, "m1", 2, 368.0, 272.0, 0.0).unwrap();

    steps(&mut core, 2);
    core.set_actor_level(1, 0);
    steps(&mut core, 2);

    assert_eq!(level_of(&core, 1), 0, "стрелок под мостом");
    assert_eq!(level_of(&core, 2), 1, "цель на мосту");
    core.take_events();

    core.apply_input(1, 1, "down", "nextWeapon");
    steps(&mut core, 1);
    fire(&mut core, 2, 50);

    let all = events(&mut core);

    assert_eq!(health_of(&all, 2), None, "плита экранирует взрыв: {all:?}");

    // та же бомба, сброшенная на мосту, цель достаёт
    let mut core = make_core();

    core.load_map(&layered_map_json()).unwrap();
    core.spawn_actor(1, "m1", 1, 368.0, 300.0, 0.0).unwrap();
    core.spawn_actor(2, "m1", 2, 368.0, 272.0, 0.0).unwrap();

    steps(&mut core, 2);
    assert_eq!(level_of(&core, 1), 1);
    core.take_events();

    core.apply_input(1, 1, "down", "nextWeapon");
    steps(&mut core, 1);
    fire(&mut core, 2, 50);

    let all = events(&mut core);

    assert!(
        health_of(&all, 2).is_some_and(|h| h < 100.0),
        "на одном уровне взрыв достаёт: {all:?}"
    );
}

#[test]
fn bomb_dropped_over_the_void_lands_on_the_ground() {
    let mut core = make_core();

    core.load_map(&layered_map_json()).unwrap();
    // верхняя половина рампы: уровень 1, но плиты под танком нет
    core.spawn_actor(1, "m1", 1, 280.0, 304.0, 0.0).unwrap();
    // цель на земле рядом с рампой
    core.spawn_actor(2, "m1", 2, 280.0, 336.0, 0.0).unwrap();

    steps(&mut core, 2);
    // уровень назван явно: спавн на рампе геометрия считает заездом сбоку и
    // держит на земле, а тест про бомбу требует стрелка наверху
    core.set_actor_level(1, 1);
    steps(&mut core, 2);
    assert_eq!(level_of(&core, 1), 1, "танк на верхней половине рампы");
    assert_eq!(level_of(&core, 2), 0);
    core.take_events();

    core.apply_input(1, 1, "down", "nextWeapon");
    steps(&mut core, 1);
    fire(&mut core, 2, 50);

    let all = events(&mut core);

    assert!(
        health_of(&all, 2).is_some_and(|h| h < 100.0),
        "бомба над пустотой ложится на ближайшую опору снизу — здесь это \
         земля: {all:?}"
    );
}

#[test]
fn players_json_matches_schema_width() {
    let mut core = make_core();

    core.spawn_actor(1, "m1", 1, 0.0, 0.0, 0.0).unwrap();
    steps(&mut core, 1);

    let schema = flat_config_json();
    let width = schema["snapshot"]["keys"]["m1"]["fields"]
        .as_array()
        .unwrap()
        .len();

    let data: serde_json::Value = serde_json::from_str(&core.players_data()).unwrap();
    let row = data["m1"]["1"].as_array().unwrap();

    assert_eq!(row.len(), width, "строка JSON-пути обязана быть полной");
}

// Утверждения к отладочным сценариям tests/scenarios/*.json: раннер
// сценариев проверяет только движковые инварианты и расхождение
// предсказания, поэтому «уровень действительно сменился», «бот заехал на
// мост» и «взрыв экранирован» живут здесь, а не читаются глазами в дампах.

#[test]
fn tank_climbs_the_ramp_and_falls_back_to_the_ground() {
    // сценарий tests/scenarios/bridge.json + fall.json: 0 → 1 → 0
    let mut core = make_core();

    core.load_map(&layered_map_json()).unwrap();
    // подножие рампы, движение на восток: рампа → плита → кромка плиты
    core.spawn_actor(1, "m1", 1, 208.0, 304.0, 0.0).unwrap();
    core.apply_input(1, 1, "down", "forward");

    steps(&mut core, 2);
    assert_eq!(level_of(&core, 1), 0, "старт на земле");

    let mut climbed = None;
    let mut landed = None;

    for tick in 0..900 {
        core.step(DT);

        let level = level_of(&core, 1);

        if climbed.is_none() && level == 1 {
            climbed = Some(tick);
        } else if climbed.is_some() && level == 0 {
            landed = Some(tick);
            break;
        }
    }

    assert!(climbed.is_some(), "танк не поднялся на плиту");
    assert!(
        landed.is_some(),
        "съехав с кромки плиты, танк обязан вернуться на землю"
    );
    // плита кончается на колонке 12 (x < 416): приземление — восточнее
    assert!(
        tank_x(&core, 1) > 416.0,
        "приземление за кромкой плиты, x = {}",
        tank_x(&core, 1)
    );
}

// наклон корпуса авторитетен: он едет в кадре, а не восстанавливается
// клиентом из разницы высот между кадрами (у стоящего танка та нулевая)
#[test]
fn tank_row_carries_tilt() {
    let mut core = make_core();

    core.load_map(&layered_map_json()).unwrap();
    // подножие рампы, движение на восток
    core.spawn_actor(1, "m1", 1, 208.0, 304.0, 0.0).unwrap();
    // и второй танк вдали от рампы — на ровной земле
    core.spawn_actor(2, "m1", 2, 100.0, 100.0, 0.0).unwrap();

    steps(&mut core, 2);

    // на ровной земле корпус не наклонён
    assert_eq!(tilt_of(&core, 2), (0.0, 0.0));

    core.apply_input(1, 1, "down", "forward");

    let mut on_ramp = None;

    for _ in 0..900 {
        core.step(DT);

        let (pitch, roll) = tilt_of(&core, 1);

        if pitch != 0.0 || roll != 0.0 {
            on_ramp = Some((pitch, roll));
            break;
        }
    }

    let (pitch, _) = on_ramp.expect("на прогоне рампы корпус обязан наклониться");

    // рампа ведёт вверх: нос задран
    assert!(pitch > 0.0, "pitch = {pitch}");
}

#[test]
fn box_pushed_off_the_slab_falls_to_the_ground() {
    // задача 1 итерации 2: тело карты живёт по тем же правилам уровня, что
    // танк — за кромкой плиты оно падает и меняет группу коллизий
    let mut core = GameCore::new(&config_json_with_bullet(1500.0, 7_500_000.0)).unwrap();
    let mut map: serde_json::Value = serde_json::from_str(&layered_map_json()).unwrap();

    // ящик на плите у её восточной кромки (плита — колонки 10..12)
    map["physicsDynamic"] = serde_json::json!([{
        "density": 100,
        "position": [384.0, 272.0],
        "angle": 0,
        "width": 32,
        "height": 32,
        "linearDamping": 0,
        "angularDamping": 0,
        "level": 1
    }]);

    core.load_map(&map.to_string()).unwrap();
    core.spawn_actor(1, "m1", 1, 336.0, 288.0, 0.0).unwrap();
    core.set_actor_level(1, 1);
    steps(&mut core, 2);

    let level_of_box = |row: &[FieldValue]| match row[4] {
        FieldValue::U8(level) => level,
        _ => panic!("поле level строки динамики должно быть u8"),
    };
    let z_of_box = |row: &[FieldValue]| match row[3] {
        FieldValue::F32(z) => z,
        _ => panic!("поле z строки динамики должно быть f32"),
    };

    assert_eq!(
        level_of_box(&dynamic_box_row(&core, true, false)),
        1,
        "ящик стоит на плите"
    );

    core.apply_input(1, 1, "down", "fire");
    steps(&mut core, 400);

    let after = dynamic_box_row(&core, true, false);

    assert_eq!(level_of_box(&after), 0, "вытолкнутый ящик — на земле");
    assert_eq!(z_of_box(&after), 0.0, "и его высота обнулилась");

    let state = core.state();
    let map = state.map.as_ref().expect("карта загружена");

    assert_eq!(map.dynamic_levels(), vec![0], "группа тела сменилась на земную");
}

/// Карта, где прогон рампы лежит в гриде УРОВНЯ 1 (`from: 1, to: 2`), а под
/// ним — проезжая земля со стеной на клетке (10, 9). Ею проверяется маска
/// танка, заехавшего ПОД прогон.
fn overhead_map_json() -> String {
    let mut grid: Vec<Vec<i32>> = vec![vec![0; 20]; 20];

    for x in 0..20 {
        grid[0][x] = 1;
        grid[19][x] = 1;
    }

    for row in grid.iter_mut() {
        row[0] = 1;
        row[19] = 1;
    }

    // стена уровня 0 ПОД клеткой прогона 1 → 2
    grid[9][10] = 1;

    let mut slab1: Vec<Vec<i32>> = vec![vec![0; 20]; 20];
    let mut slab2: Vec<Vec<i32>> = vec![vec![0; 20]; 20];

    for row in slab1.iter_mut().take(15).skip(5) {
        for cell in row.iter_mut().take(15).skip(8) {
            *cell = 2;
        }
    }

    // прогон 1 → 2 — строка 9, колонки 9..12
    for x in 9..13 {
        slab1[9][x] = 3;
    }

    for row in slab2.iter_mut().take(15).skip(5) {
        for cell in row.iter_mut().take(15).skip(13) {
            *cell = 2;
        }
    }

    serde_json::json!({
        "setId": "c1",
        "scale": 1,
        "step": 32,
        "map": grid,
        "physicsStatic": [1],
        "physicsDynamic": [],
        "respawns": {
            "team1": [[100, 100, 0]],
            "team2": [[500, 100, 180]]
        },
        "levels": {
            "1": { "map": slab1, "floor": [2, 3], "walls": [] },
            "2": { "map": slab2, "floor": [2], "walls": [] }
        },
        "ramps": [{ "tile": 3, "dir": "east", "from": 1, "to": 2 }]
    })
    .to_string()
}

#[test]
fn ground_wall_under_a_high_ramp_stops_the_tank() {
    // дефект Д2 итерации 2: под клетками прогона 1 → 2 танк уровня 0 брал
    // маску уровней прогона и проезжал сквозь стены СВОЕГО уровня
    let mut core = make_core();

    core.load_map(&overhead_map_json()).unwrap();

    // клетка (7, 9) уровня 0, носом на восток; стена — клетка (10, 9)
    core.spawn_actor(1, "m1", 1, 240.0, 304.0, 0.0).unwrap();
    steps(&mut core, 2);
    core.set_actor_level(1, 0);
    core.apply_input(1, 1, "down", "forward");

    for _ in 0..900 {
        core.step(DT);

        assert_eq!(level_of(&core, 1), 0, "под прогоном танк остаётся на земле");
    }

    let x = tank_x(&core, 1);

    assert!(x > 280.0, "танк обязан доехать до стены, x = {x}");
    assert!(x < 320.0, "стена уровня 0 обязана остановить танк, x = {x}");
}

#[test]
fn scripted_bot_drives_onto_the_bridge() {
    // сценарий tests/scenarios/bots_bridge.json: нав-граф слоёной карты
    // действительно приводит бота наверх, а не только строит путь
    let mut core = make_core();

    core.load_map(&layered_map_json()).unwrap();
    core.spawn_scripted_actor(1, "m1", 1, 112.0, 304.0, 0.0).unwrap();
    // цель на плите: гейт входа (level.rs) пускает на прогон только с
    // торца, поэтому бот обязан ИДТИ на мост нав-графом, а не задеть рампу
    // боком по дороге к случайной точке патруля
    core.spawn_actor(2, "m1", 2, SLAB.0, SLAB.1, 180.0).unwrap();
    core.set_actor_level(2, 1);

    let mut reached = false;

    // до 60 секунд: путь наверх один — через подножие рампы
    for _ in 0..7200 {
        core.step(DT);

        if level_of(&core, 1) == 1 {
            reached = true;
            break;
        }
    }

    assert!(reached, "бот ни разу не заехал на мост");
}

/// Демо-карта 2.5D целиком (src/data/maps/overpass.js), сериализованная
/// скриптом экспорта; синхронность фикстуры с модулем стережёт
/// tests/config/game.test.js.
fn overpass_map_json() -> &'static str {
    include_str!("../../tests/core/fixtures/overpass.json")
}

fn downtown_map_json() -> &'static str {
    include_str!("../../tests/core/fixtures/downtown.json")
}

/// Фикстура `downtown` (тестовая база ботов на многоуровневой карте)
/// грузится ядром.
#[test]
fn downtown_fixture_loads() {
    let mut core = make_core();

    core.load_map(downtown_map_json()).unwrap();
}

/// Критерий приёмки уклона: дефолтные `climbGravity`/`climbMaxSpeedFactor`
/// обязаны оставлять рампы демо-карты проезжаемыми на полном газе.
#[test]
fn overpass_ramp_is_climbed_at_full_throttle() {
    let mut core = make_core();

    core.load_map(overpass_map_json()).unwrap();

    // северная рампа — тайл 4, клетки x 3..5, y 32..34 (подъём на север);
    // клетка карты — 32 × scale 0.4 = 12.8 мировых единиц
    let cell = |x: f32, y: f32| ((x + 0.5) * 12.8, (y + 0.5) * 12.8);
    // старт — клетка ПЕРЕД подножием: на прогон заходят с торца
    let (x, y) = cell(4.0, 35.0);

    core.spawn_actor(1, "m1", 1, x, y, 270.0).unwrap();
    core.apply_input(1, 1, "down", "forward");

    steps(&mut core, 2);
    assert_eq!(level_of(&core, 1), 0, "старт на земле");

    let mut climbed = false;

    for _ in 0..600 {
        core.step(DT);

        if level_of(&core, 1) == 1 {
            climbed = true;
            break;
        }
    }

    assert!(climbed, "рампа overpass обязана проезжаться на полном газе");
}

/// Риск итерации 2: стражи прогона (`GameMap::create_ramp_guards`) не имеют
/// права ловить танк, законно поднявшийся по рампе. Контакт со стражем виден
/// по угловой скорости: прогон прямой, руля нет, крутить танк нечему.
#[test]
fn a_climbing_tank_never_touches_a_ramp_guard() {
    let mut core = make_core();

    core.load_map(overpass_map_json()).unwrap();

    let cell = |x: f32, y: f32| ((x + 0.5) * 12.8, (y + 0.5) * 12.8);
    let (x, y) = cell(4.0, 35.0);

    core.spawn_actor(1, "m1", 1, x, y, 270.0).unwrap();
    core.apply_input(1, 1, "down", "forward");
    steps(&mut core, 2);

    let mut max_angvel: f32 = 0.0;

    // подъём и ВЫЕЗД с прогона: корпус сходит с клеток прогона позже центра
    for _ in 0..600 {
        core.step(DT);
        max_angvel = max_angvel.max(angvel_of(&core, 1).abs());
    }

    assert_eq!(level_of(&core, 1), 1, "танк обязан подняться на плиту");
    assert!(
        max_angvel < 0.2,
        "прогон обязан проезжаться без контакта со стражем, |angvel| = {max_angvel}"
    );
}

/// Угловая скорость танка из players_data (индекс 10 строки схемы m1).
fn angvel_of(core: &GameCore, game_id: u32) -> f32 {
    let data: serde_json::Value = serde_json::from_str(&core.players_data()).unwrap();

    data["m1"][game_id.to_string()][10].as_f64().unwrap() as f32
}

#[test]
fn overpass_loads_and_places_respawns_on_their_levels() {
    let mut core = make_core();

    core.load_map(overpass_map_json())
        .expect("overpass обязан проходить валидацию карты");

    // респауны карты объявлены в НЕмасштабированных единицах: хост
    // умножает их на scale (0.4) до спавна — RoundManager.createMap
    let at = |x: f32, y: f32| (x * 0.4, y * 0.4);
    // мостовой респаун team1 (объявлен уровнем 1) и наземный team2:
    // уровень тут берётся из геометрии, без set_actor_level
    let (x, y) = at(336.0, 944.0);
    core.spawn_actor(1, "m1", 1, x, y, 0.0).unwrap();

    let (x, y) = at(2352.0, 208.0);
    core.spawn_actor(2, "m1", 2, x, y, 180.0).unwrap();

    steps(&mut core, 2);

    assert_eq!(level_of(&core, 1), 1, "мостовой респаун — уровень 1");
    assert_eq!(level_of(&core, 2), 0, "наземный респаун — уровень 0");
}

#[test]
fn upper_slab_shields_the_explosion_from_the_terrace() {
    // бомба на уровне 2 не достаёт цель, стоящую уровнем ниже
    let mut core = make_core();

    core.load_map(&terraced_map_json()).unwrap();
    core.spawn_actor(1, "m1", 1, 368.0, 300.0, 0.0).unwrap();
    core.spawn_actor(2, "m1", 2, 368.0, 272.0, 0.0).unwrap();

    steps(&mut core, 2);
    core.set_actor_level(2, 1);
    steps(&mut core, 2);

    assert_eq!(level_of(&core, 1), 2, "стрелок на верхней плите");
    assert_eq!(level_of(&core, 2), 1, "цель уровнем ниже");
    core.take_events();

    core.apply_input(1, 1, "down", "nextWeapon");
    steps(&mut core, 1);
    fire(&mut core, 2, 50);

    let all = events(&mut core);

    assert_eq!(
        health_of(&all, 2),
        None,
        "взрыв уровня 2 не идёт вниз: {all:?}"
    );
}

#[test]
fn bomb_dropped_over_the_void_lands_on_the_slab_below() {
    // над разрывом плиты уровня 2 бомба ложится на плиту уровня 1, а не
    // улетает на землю
    let mut core = make_core();

    core.load_map(&terraced_map_json()).unwrap();
    // верхняя половина рампы 1 → 2: уровень 2, но плиты уровня 2 нет,
    // а плита уровня 1 под ней есть
    core.spawn_actor(1, "m1", 1, 304.0, 304.0, 0.0).unwrap();
    // цель на террасе уровня 1 рядом с рампой
    core.spawn_actor(2, "m1", 2, 304.0, 336.0, 0.0).unwrap();

    steps(&mut core, 2);
    // уровень назван явно: спавн на рампе геометрия считает заездом сбоку
    core.set_actor_level(1, 2);
    steps(&mut core, 2);

    assert_eq!(level_of(&core, 1), 2, "стрелок на верхней половине рампы");
    assert_eq!(level_of(&core, 2), 1, "цель на террасе уровня 1");
    core.take_events();

    core.apply_input(1, 1, "down", "nextWeapon");
    steps(&mut core, 1);
    fire(&mut core, 2, 50);

    let all = events(&mut core);

    assert!(
        health_of(&all, 2).is_some_and(|h| h < 100.0),
        "бомба легла на плиту уровня 1: {all:?}"
    );
}

/// Демо-карта на три уровня (src/data/maps/terraces.js), сериализованная
/// скриптом экспорта; синхронность фикстуры с модулем стережёт
/// tests/core/fixtures.test.js.
fn terraces_map_json() -> &'static str {
    include_str!("../../tests/core/fixtures/terraces.json")
}

/// Центр клетки карты `terraces` в мировых единицах: 32 * scale 0.4 = 12.8.
fn terraces_cell(x: f32, y: f32) -> (f32, f32) {
    ((x + 0.5) * 12.8, (y + 0.5) * 12.8)
}

/// Высота танка из players_data (индекс 11 строки схемы m1).
fn tank_z(core: &GameCore, game_id: u32) -> f32 {
    let data: serde_json::Value = serde_json::from_str(&core.players_data()).unwrap();

    data["m1"][game_id.to_string()][11].as_f64().unwrap() as f32
}

/// Координата y танка из players_data (индекс 1 строки схемы m1).
fn tank_y(core: &GameCore, game_id: u32) -> f32 {
    let data: serde_json::Value = serde_json::from_str(&core.players_data()).unwrap();

    data["m1"][game_id.to_string()][1].as_f64().unwrap() as f32
}

#[test]
fn terraces_loads_with_three_levels() {
    let mut core = make_core();

    core.load_map(terraces_map_json())
        .expect("terraces обязан проходить валидацию карты");

    // ни одного set_actor_level: уровень точки даёт геометрия
    let (x, y) = terraces_cell(58.0, 21.0);
    core.spawn_actor(1, "m1", 1, x, y, 180.0).unwrap();

    let (x, y) = terraces_cell(20.0, 20.0);
    core.spawn_actor(2, "m1", 2, x, y, 0.0).unwrap();

    let (x, y) = terraces_cell(45.0, 18.0);
    core.spawn_actor(3, "m1", 1, x, y, 180.0).unwrap();

    steps(&mut core, 2);

    assert_eq!(level_of(&core, 1), 0, "точка на земле — уровень 0");
    assert_eq!(level_of(&core, 2), 1, "точка на террасе — уровень 1");
    assert_eq!(level_of(&core, 3), 2, "точка на верхней площадке — уровень 2");
}

// Прогон 1 → 2 (`rampStep`, клетки x 31..33 строки 21, подъём на восток)
// лежит на террасе. Ствол стрелка на склоне опущен вдоль него: за подножием
// пуля уходит ниже настила, но плита террасы под ней — пуля остаётся на
// уровне 1 и достаёт танк на террасе, а не проваливается под неё.
#[test]
fn shot_down_the_upper_ramp_hits_a_tank_on_the_terrace() {
    let mut core = make_core();

    core.load_map(terraces_map_json()).unwrap();

    // носом на запад, кормой к подножию прогона
    let (x, y) = terraces_cell(28.0, 21.0);
    core.spawn_actor(1, "m1", 1, x, y, 180.0).unwrap();

    let (x, y) = terraces_cell(20.0, 21.0);
    core.spawn_actor(2, "m1", 2, x, y, 0.0).unwrap();

    steps(&mut core, 2);
    assert_eq!(level_of(&core, 1), 1, "стрелок на террасе");
    assert_eq!(level_of(&core, 2), 1, "цель на террасе");

    core.apply_input(1, 1, "down", "back");

    for _ in 0..400 {
        steps(&mut core, 1);

        if tank_z(&core, 1) >= 1.4 {
            break;
        }
    }

    assert!(tank_z(&core, 1) >= 1.4, "стрелок не заехал на прогон: z={}", tank_z(&core, 1));
    core.apply_input(1, 2, "up", "back");

    core.take_events();
    fire(&mut core, 3, 1);

    let health = health_of(&events(&mut core), 2);

    assert!(
        health.is_some_and(|h| h < 100.0),
        "пуля вниз по рампе осталась на террасе: {health:?}"
    );
}

#[test]
fn tank_climbs_two_levels_in_one_ramp() {
    // задача 6 итерации 2: крутой прогон 0 → 2 проезжается одним заездом
    let mut core = make_core();

    core.load_map(terraces_map_json()).unwrap();

    // подножие крутой рампы (клетки x 53..56 строки 21, подъём на запад);
    // старт — клетка ПЕРЕД торцом: на прогон заходят с торца
    let (x, y) = terraces_cell(58.0, 21.0);

    core.spawn_actor(1, "m1", 1, x, y, 180.0).unwrap();
    core.apply_input(1, 1, "down", "forward");

    steps(&mut core, 2);
    assert_eq!(level_of(&core, 1), 0, "старт на земле");

    let mut seen_middle = false;
    let mut climbed = false;

    for _ in 0..900 {
        core.step(DT);

        match level_of(&core, 1) {
            1 => seen_middle = true,
            2 => {
                climbed = true;
                break;
            }
            _ => {}
        }
    }

    assert!(climbed, "танк не поднялся на уровень 2 одним прогоном");
    assert!(seen_middle, "подъём обязан пройти через промежуточный уровень 1");
}

#[test]
fn terraces_ramp_launches_the_tank() {
    // верхний торец крутого прогона 0 → 2 работает трамплином: сойдя с
    // него на ходу, танк уходит в полёт выше уровня отрыва и возвращается
    // на верхнюю площадку, а не приклеивается к плите
    let mut core = make_core();

    core.load_map(terraces_map_json()).unwrap();

    let (x, y) = terraces_cell(58.0, 21.0);

    core.spawn_actor(1, "m1", 1, x, y, 180.0).unwrap();
    core.apply_input(1, 1, "down", "forward");
    steps(&mut core, 2);

    let mut peak = 0.0_f32;
    let mut climbed = false;
    let mut landed = false;

    for _ in 0..900 {
        core.step(DT);

        if level_of(&core, 1) == 2 {
            climbed = true;
        }

        if !climbed {
            continue;
        }

        peak = peak.max(tank_z(&core, 1));

        // дуга кончилась: высота вернулась ровно на целый уровень
        if peak > 2.0 && (tank_z(&core, 1) - 2.0).abs() < 1e-3 {
            landed = true;
            break;
        }
    }

    assert!(climbed, "танк не поднялся на уровень 2 одним прогоном");
    assert!(
        peak > 2.0,
        "сход с прогона обязан подбросить танк выше уровня отрыва, peak = {peak}"
    );
    // верхняя граница так же обязательна, как нижняя: без неё регрессия
    // настройки (rampLaunchFactor 1.0 давал дугу в 2.6 уровня) тесту
    // невидима
    // граница совпадает с `fallDamageFreeHeight`: дуга выше мёртвой зоны —
    // это уже настройка, при которой прыжок с рампы стоит HP
    assert!(
        peak < 2.0 + 0.5,
        "дуга прыжка обязана оставаться внутри мёртвой зоны урона, peak = {peak}"
    );
    assert!(landed, "прыжок обязан закончиться приземлением");
    assert_eq!(level_of(&core, 1), 2, "после прыжка танк на верхней площадке");
}

/// Клетка карты `overpass` в мировых единицах: 32 × scale 0.4.
fn overpass_cell(x: f32, y: f32) -> (f32, f32) {
    ((x + 0.5) * 12.8, (y + 0.5) * 12.8)
}

/// Границы карты `overpass` с запасом в одну клетку: width 80, height 60,
/// клетка 12.8 мировых единиц.
fn overpass_bounds() -> (f32, f32, f32, f32) {
    (12.8, 80.0 * 12.8 - 12.8, 12.8, 60.0 * 12.8 - 12.8)
}

#[test]
fn a_jump_never_leaves_the_map() {
    // Главная защита проблемы 3: пока дуга ниже `jumpClearance`, маска в
    // полёте остаётся STATIC_LEVEL_GROUP, и периметр карты держит танк.
    // Тест ловит любую настройку, при которой это перестаёт быть правдой
    // (maxLaunchVz вверх, jumpClearance вниз, fallTime вниз).
    let mut core = make_core();

    core.load_map(overpass_map_json()).unwrap();

    // первая точка респауна team1 — подножие северной рампы, носом на север
    let (x, y) = overpass_cell(3.0, 38.0);

    core.spawn_actor(1, "m1", 1, x, y, 270.0).unwrap();
    core.apply_input(1, 1, "down", "forward");
    steps(&mut core, 2);

    let (min_x, max_x, min_y, max_y) = overpass_bounds();
    let mut peak = 0.0_f32;
    let mut climbed = false;
    let mut jumped = false;

    for _ in 0..900 {
        core.step(DT);

        let (x, y) = (tank_x(&core, 1), tank_y(&core, 1));

        assert!(
            x > min_x && x < max_x && y > min_y && y < max_y,
            "танк вышел за периметр карты: ({x}, {y})"
        );

        let z = tank_z(&core, 1);

        if level_of(&core, 1) == 1 {
            climbed = true;
        }

        // на плите танк лежит ровно на 1.0; всё, что выше, — дуга прыжка
        if climbed && z > 1.0 + 1e-3 {
            jumped = true;
        }

        peak = peak.max(z);
    }

    assert!(climbed, "танк обязан подняться на плиту моста");
    assert!(
        jumped,
        "сход с рампы обязан оторвать танк от плиты — иначе тест сторожит пустоту"
    );
    // нижней границы у `peak` здесь нет намеренно: факт отрыва уже
    // утверждает `jumped` (строго выше плиты), а число вроде «дуга не ниже
    // 0.05» привязало бы тест к крутизне рампы именно этой карты

    // `clear_walls` наружу ядро не отдаёт, но включается он ровно по
    // высоте: z ≥ уровень отрыва + jumpClearance. Прыжок идёт с плиты
    // (уровень 1), значит порог — 1.45
    assert!(
        peak < 1.0 + 0.45,
        "дуга обязана оставаться ниже jumpClearance, peak = {peak}"
    );
}

#[test]
fn a_jump_lands_on_the_bridge() {
    // Проверка ширины проезжей плиты: замеренный горизонт прыжка с рампы —
    // 3.5 тайла, на трёхтайловой плите танк бил в дальние перила
    let mut core = make_core();

    core.load_map(overpass_map_json()).unwrap();

    let (x, y) = overpass_cell(3.0, 38.0);

    core.spawn_actor(1, "m1", 1, x, y, 270.0).unwrap();
    core.apply_input(1, 1, "down", "forward");
    steps(&mut core, 2);

    let mut climbed = false;
    let mut jumped = false;
    let mut airborne = false;
    let mut landing_row = 0.0_f32;

    for _ in 0..900 {
        core.step(DT);

        let z = tank_z(&core, 1);

        if level_of(&core, 1) == 1 {
            climbed = true;
        }

        // на плите танк лежит ровно на 1.0; всё, что выше, — дуга прыжка
        let above_slab = climbed && z > 1.0 + 1e-3;

        if above_slab {
            jumped = true;
        }

        // ряд посадки берётся в МОМЕНТ касания, а не в конце прогона: газ
        // держится все 900 шагов, и к концу танк уже доехал до дальних
        // перил — его финальный ряд говорит о габарите корпуса у перил, а
        // не о том, куда положил его прыжок
        if airborne && !above_slab {
            landing_row = tank_y(&core, 1) / 12.8;
        }

        airborne = above_slab;
    }

    assert!(climbed, "танк обязан подняться на плиту");
    assert!(
        jumped,
        "танк обязан именно ПРЫГНУТЬ, а не доехать: тест сторожит ширину плиты"
    );
    assert_eq!(
        level_of(&core, 1),
        1,
        "после прыжка танк остаётся на плите моста"
    );
    assert!(
        (tank_z(&core, 1) - 1.0).abs() < 1e-3,
        "прыжок обязан закончиться приземлением на плиту, z = {}",
        tank_z(&core, 1)
    );

    // посадка обязана попасть в проезжую часть (ряды 26..30), а не в перила
    // (25 и 31): отрыв идёт с ряда 31, замеренная посадка — ряд 28.1.
    // ВНИМАНИЕ: границы здесь — ряды перил ЭТОЙ плиты, вписанные числом, а
    // не выведенные из карты. Проверка сторожит «танк сел на плиту, а не в
    // перила» при нынешней геометрии; сузить саму плиту так, чтобы она
    // покраснела, не выйдет — вместе с плитой уезжают и перила, а числа
    // остаются. Ширину плиты держит замер в docs/*/extending.md
    assert!(
        landing_row > 26.0 && landing_row < 31.0,
        "посадка обязана попасть в проезжую часть, ряд = {landing_row}"
    );
}

#[test]
fn a_ramp_jump_shakes_the_camera_less_than_a_fall() {
    // главное свойство настройки приземления: сход с рампы читается
    // толчком слабее, чем падение с целого уровня. Оба прогона идут на
    // одном и том же блоке landingShake, сравниваются только интенсивности
    let config = config_json_with_landing_shake(1.5, 6.0);

    let mut core = GameCore::new(&config).unwrap();

    core.load_map(terraces_map_json()).unwrap();

    let (x, y) = terraces_cell(58.0, 21.0);

    core.spawn_actor(1, "m1", 1, x, y, 180.0).unwrap();
    core.apply_input(1, 1, "down", "forward");
    steps(&mut core, 2);
    core.take_events();

    let mut jump_shake = 0.0_f64;
    let mut climbed = false;
    let mut peak = 0.0_f32;

    for _ in 0..900 {
        core.step(DT);

        for event in events(&mut core) {
            if let CoreEvent::Shake { intensity, .. } = event {
                jump_shake = jump_shake.max(intensity);
            }
        }

        if level_of(&core, 1) == 2 {
            climbed = true;
        }

        if !climbed {
            continue;
        }

        peak = peak.max(tank_z(&core, 1));

        // дуга кончилась: высота вернулась ровно на целый уровень
        if peak > 2.0 && (tank_z(&core, 1) - 2.0).abs() < 1e-3 {
            break;
        }
    }

    assert!(jump_shake > 0.0, "прыжок обязан тряхнуть камеру");

    let fall_shake = shakes_after_a_fall(&config)[0].1;

    assert!(
        jump_shake < fall_shake,
        "прыжок с рампы ({jump_shake}) обязан быть тише падения с уровня ({fall_shake})"
    );
}

#[test]
fn tank_cannot_enter_the_ramp_from_under_the_slab() {
    // задача 5 итерации 2: у верхнего торца рампы — проезд уровня 0 под
    // плитой. Оттуда на прогон заезжают, но не поднимаются: гейт входа
    // требует торца, отвечающего уровню танка
    let mut core = make_core();

    core.load_map(terraces_map_json()).unwrap();

    // под плитой террасы, носом на юг; уровень объявлен явно (геометрия под
    // плитой отдала бы 1) — так же поступает хост с respawns[i][3]
    let (x, y) = terraces_cell(24.0, 28.0);

    core.spawn_actor(1, "m1", 1, x, y, 90.0).unwrap();

    steps(&mut core, 2);
    core.set_actor_level(1, 0);
    steps(&mut core, 2);

    assert_eq!(level_of(&core, 1), 0, "старт на земле под плитой");
    core.apply_input(1, 1, "down", "forward");

    for _ in 0..900 {
        core.step(DT);

        assert_eq!(
            level_of(&core, 1),
            0,
            "заезд на прогон сверху обязан оставить танк на земле, y = {}",
            tank_y(&core, 1)
        );
    }

    // прогон занимает строки 31..34, и с итерации 2 его «неправильный»
    // торец закрыт стражем (`ramp_guard_interaction`): въезд под клин
    // сверху обязан упираться в него, а не проезжать прогон насквозь
    assert!(
        tank_y(&core, 1) < 31.0 * 12.8,
        "страж прогона обязан остановить танк перед клином, y = {}",
        tank_y(&core, 1)
    );
}

#[test]
fn crate_pushed_off_the_upper_slab_lands_on_the_lower_one() {
    // задача 1 итерации 2: ящик у разрыва перил верхней площадки падает не
    // на землю, а на плиту террасы этажом ниже
    let mut core = GameCore::new(&config_json_with_bullet(1500.0, 7_500_000.0)).unwrap();

    core.load_map(terraces_map_json()).unwrap();

    // первый ящик карты стоит на клетке (41, 25) уровня 2; разрыв перил —
    // строка 26, под ней плита уровня 1
    let (x, y) = terraces_cell(41.0, 22.0);

    core.spawn_actor(1, "m1", 1, x, y, 90.0).unwrap();
    core.set_actor_level(1, 2);
    steps(&mut core, 2);

    let crate_row = |core: &GameCore| {
        let state = core.state();
        let map = state.map.as_ref().expect("карта загружена");
        let rows = map.dynamic_map_data(&state.world, true, false);
        let (_, fields) = rows.first().expect("ящик площадки — первый в списке");

        fields.clone()
    };
    let level_of_crate = |row: &[FieldValue]| match row[4] {
        FieldValue::U8(level) => level,
        _ => panic!("поле level строки динамики должно быть u8"),
    };
    let z_of_crate = |row: &[FieldValue]| match row[3] {
        FieldValue::F32(z) => z,
        _ => panic!("поле z строки динамики должно быть f32"),
    };

    assert_eq!(
        level_of_crate(&crate_row(&core)),
        2,
        "ящик стоит на верхней площадке"
    );

    core.apply_input(1, 1, "down", "fire");
    steps(&mut core, 400);

    let after = crate_row(&core);

    assert_eq!(
        level_of_crate(&after),
        1,
        "вытолкнутый ящик приземлился на плиту террасы, а не на землю"
    );
    assert_eq!(z_of_crate(&after), 1.0, "и его высота — ровно уровень 1");
}

/// Карта с ШИРОКОЙ рампой: тайл прогона занимает блок строк 8..10 в
/// колонках 6..9. Движок режет такой блок на три параллельных прогона (по
/// прогону на строку), поэтому ею проверяется перестроение между полосами
/// прямо на подъёме. Синтетическая копия блока `rampNorth` карты
/// `overpass` (3 × 3): реальные карты живут в JS и в rust-тесты не
/// загружаются.
fn wide_ramp_map_json() -> String {
    let mut grid: Vec<Vec<i32>> = vec![vec![0; 20]; 20];

    for x in 0..20 {
        grid[0][x] = 1;
        grid[19][x] = 1;
    }

    for row in grid.iter_mut() {
        row[0] = 1;
        row[19] = 1;
    }

    for row in grid.iter_mut().take(11).skip(8) {
        for cell in row.iter_mut().take(10).skip(6) {
            *cell = 3;
        }
    }

    let mut slab: Vec<Vec<i32>> = vec![vec![0; 20]; 20];

    for row in slab.iter_mut().take(15).skip(5) {
        for cell in row.iter_mut().take(13).skip(10) {
            *cell = 2;
        }
    }

    serde_json::json!({
        "setId": "c1",
        "scale": 1,
        "step": 32,
        "map": grid,
        "physicsStatic": [1],
        "physicsDynamic": [],
        "respawns": {
            "team1": [[100, 100, 0]],
            "team2": [[500, 100, 180]]
        },
        "levels": {
            "1": { "map": slab, "floor": [2], "walls": [] }
        },
        "ramps": [{ "tile": 3, "dir": "east", "from": 0, "to": 1 }]
    })
    .to_string()
}

#[test]
fn wide_ramp_is_climbed_across_lanes() {
    let mut core = make_core();

    core.load_map(&wide_ramp_map_json()).unwrap();
    // подножие средней полосы (колонка 5, строка 9), нос повёрнут вбок:
    // танк едет наискось и на подъёме переезжает в соседнюю полосу
    core.spawn_actor(1, "m1", 1, 176.0, 304.0, -20.0).unwrap();
    core.apply_input(1, 1, "down", "forward");

    steps(&mut core, 2);
    assert_eq!(level_of(&core, 1), 0, "у подножия рампа ещё внизу");

    let start_y = tank_y(&core, 1);

    steps(&mut core, 150);

    assert_eq!(
        level_of(&core, 1),
        1,
        "подъём не сорвался на границе полос: x = {}, y = {}",
        tank_x(&core, 1),
        tank_y(&core, 1)
    );
    assert!(
        (start_y - tank_y(&core, 1)) >= 32.0,
        "танк обязан был сменить полосу: y {start_y} → {}",
        tank_y(&core, 1)
    );
}

#[test]
fn a_ramp_jump_costs_no_health() {
    // прыжок с рампы возвращает танк на ту же плиту: дуга ниже мёртвой
    // зоны `fallDamageFreeHeight`, и платить за неё танк не обязан
    let mut core = make_core();

    core.load_map(terraces_map_json()).unwrap();

    let (x, y) = terraces_cell(58.0, 21.0);

    core.spawn_actor(1, "m1", 1, x, y, 180.0).unwrap();
    steps(&mut core, 2);
    core.take_events();

    core.apply_input(1, 1, "down", "forward");

    let mut climbed = false;
    let mut landed = false;

    for _ in 0..900 {
        core.step(DT);

        if level_of(&core, 1) == 2 {
            climbed = true;
        }

        if climbed && (tank_z(&core, 1) - 2.0).abs() < 1e-3 && level_of(&core, 1) == 2 {
            landed = true;
        }

        if landed {
            break;
        }
    }

    assert!(climbed, "танк не поднялся на уровень 2 одним прогоном");
    assert!(landed, "прыжок обязан закончиться приземлением");

    let health = events(&mut core)
        .iter()
        .filter_map(|event| match event {
            CoreEvent::PanelSet { id: 1, field, value } if field == "health" => Some(*value),
            _ => None,
        })
        .last();

    assert_eq!(health, None, "подскок с рампы не обязан стоить HP");
}

#[test]
fn a_one_level_fall_still_costs_the_old_price() {
    // цена падения ровно с одного уровня — `fallDamage · (1 − freeHeight)`.
    // Тест сторожит пару: поправить `fallDamage`, забыв про мёртвую зону,
    // значит молча удвоить цену обрыва
    const FALL_DAMAGE: f64 = 30.0;
    const FREE_HEIGHT: f64 = 0.5;

    let mut core = make_core();

    core.load_map(&layered_map_json()).unwrap();
    core.spawn_actor(1, "m1", 1, GROUND.0, GROUND.1, 0.0).unwrap();

    steps(&mut core, 2);
    core.take_events();

    // над землёй плиты нет: уровень 1 в этой точке — обрыв
    core.set_actor_level(1, 1);
    steps(&mut core, 2);
    assert_eq!(level_of(&core, 1), 1);

    // fallTime = 0.35 c = 42 шага
    steps(&mut core, 50);

    let health = events(&mut core)
        .iter()
        .filter_map(|event| match event {
            CoreEvent::PanelSet { id: 1, field, value } if field == "health" => Some(*value),
            _ => None,
        })
        .last();

    assert_eq!(
        health,
        Some(100.0 - FALL_DAMAGE * (1.0 - FREE_HEIGHT)),
        "падение с одного уровня стоит fallDamage · (1 − freeHeight)"
    );
    assert_eq!(level_of(&core, 1), 0, "танк оказался на земле");
}

// ---- поверхности (этап 2) ----

/// Плоская карта `cols`×20 клеток без стен (шаг 32, масштаб 1): `fill` —
/// тайл клетки, `game` — поле `game` карты.
fn surface_map_json(cols: usize, fill: impl Fn(usize, usize) -> i32, game: serde_json::Value) -> String {
    let grid: Vec<Vec<i32>> = (0..20).map(|y| (0..cols).map(|x| fill(x, y)).collect()).collect();

    serde_json::json!({
        "setId": "c1",
        "scale": 1,
        "step": 32,
        "map": grid,
        "physicsStatic": [1],
        "physicsDynamic": [],
        "respawns": { "team1": [[100, 100, 0]], "team2": [[500, 100, 180]] },
        "game": game
    })
    .to_string()
}

fn boost_game(tile: i32, dir: &str) -> serde_json::Value {
    serde_json::json!({ "surfaces": { "0": { tile.to_string(): { "type": "boost", "dir": dir } } } })
}

/// Строка m1 танка из players_data: x, y, angle, gunRotation, vx, vy, …
fn tank_row_of(core: &GameCore, game_id: u32) -> Vec<f32> {
    let data: serde_json::Value = serde_json::from_str(&core.players_data()).unwrap();

    data["m1"][game_id.to_string()]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_f64().unwrap_or(0.0) as f32)
        .collect()
}

/// Сколько импульсов бустера получил танк за `count` шагов после первого: скачок
/// скорости за шаг больше 60 (тяга за шаг — не больше 8.3).
fn count_boosts(core: &mut GameCore, game_id: u32, count: usize) -> usize {
    // строка танка появляется в players_data только после первого шага
    core.step(DT);

    let mut last = tank_row_of(core, game_id);
    let mut boosts = 0;

    for _ in 0..count {
        core.step(DT);

        let row = tank_row_of(core, game_id);

        if ((row[4] - last[4]).powi(2) + (row[5] - last[5]).powi(2)).sqrt() > 60.0 {
            boosts += 1;
        }

        last = row;
    }

    boosts
}

#[test]
fn sand_lowers_the_steady_speed() {
    let run = |game: serde_json::Value| {
        let mut core = make_core();

        core.load_map(&surface_map_json(80, |_, _| 41, game)).unwrap();
        core.spawn_actor(1, "m1", 1, 100.0, 336.0, 0.0).unwrap();
        core.apply_input(1, 1, "down", "forward");
        steps(&mut core, 480);

        tank_row_of(&core, 1)[4]
    };
    let sand = run(serde_json::json!({ "surfaces": { "0": { "41": "sand" } } }));
    let asphalt = run(serde_json::Value::Null);

    assert!(sand <= 0.55 * 260.0, "песок выше потолка maxSpeed · maxForwardSpeed: {sand}");
    assert!(sand <= asphalt * 0.7, "песок обязан быть медленнее асфальта на 30 %: {sand} vs {asphalt}");
}

#[test]
fn boost_fires_once_per_entry() {
    // плита 2×3 на восток: строки 10..12, колонки 10..13
    let mut core = make_core();
    let plate = |x: usize, y: usize| if (10..13).contains(&x) && (10..12).contains(&y) { 47 } else { 0 };

    core.load_map(&surface_map_json(40, plate, boost_game(47, "east"))).unwrap();
    core.spawn_actor(1, "m1", 1, 200.0, 336.0, 0.0).unwrap();
    core.apply_input(1, 1, "down", "forward");

    assert_eq!(count_boosts(&mut core, 1, 150), 1, "проезд вдоль плиты 2×3 — один импульс");

    // стоянка на плите 60 шагов
    let mut core = make_core();

    core.load_map(&surface_map_json(40, plate, boost_game(47, "east"))).unwrap();
    core.spawn_actor(1, "m1", 1, 368.0, 336.0, 0.0).unwrap();

    assert_eq!(count_boosts(&mut core, 1, 60), 0, "стоянка на плите — ни одного");
}

/// Ядро с бустером удержания (значения `src/config/game.js`); общий
/// конфиг теста держит старую плиту без удержания — проверку обратной
/// совместимости.
fn make_core_with_held_boost() -> GameCore {
    let mut flat = flat_config_json();

    flat["surfaces"]["types"]["boost"] = serde_json::json!({
        "boostDv": 220, "boostMaxSpeed": 480, "minEntrySpeed": 20, "boostTime": 1.2, "boostSpeedFactor": 1.8
    });

    GameCore::new(&wrap_config(flat)).unwrap()
}

/// Разгон по асфальту до полной скорости и въезд на поперечную полосу
/// бустера (колонки 30..32): возвращает ядро на шаге импульса.
fn drive_onto_boost(mut core: GameCore) -> GameCore {
    let strip = |x: usize, _| if (30..32).contains(&x) { 47 } else { 0 };

    core.load_map(&surface_map_json(90, strip, boost_game(47, "east"))).unwrap();
    core.spawn_actor(1, "m1", 1, 100.0, 336.0, 0.0).unwrap();
    core.apply_input(1, 1, "down", "forward");
    core.step(DT);

    let mut last = tank_row_of(&core, 1)[4];

    for _ in 0..600 {
        core.step(DT);

        let vx = tank_row_of(&core, 1)[4];

        if vx - last > 60.0 {
            return core;
        }

        last = vx;
    }

    panic!("танк не доехал до бустера");
}

#[test]
fn boost_hold_keeps_speed_above_max() {
    // через boostTime/2 после импульса: с удержанием скорость выше потолка
    // танка (260), без него демпфирование гасит её до потолка
    let mut held = drive_onto_boost(make_core_with_held_boost());
    let mut plain = drive_onto_boost(make_core());

    steps(&mut held, 72);
    steps(&mut plain, 72);

    let held_vx = tank_row_of(&held, 1)[4];
    let plain_vx = tank_row_of(&plain, 1)[4];

    assert!(held_vx > 400.0, "удержание обязано держать скорость: {held_vx}");
    assert!(plain_vx < 270.0, "без удержания скорость гаснет до потолка: {plain_vx}");
}

#[test]
fn boost_hold_expires() {
    // boostTime (1.2 с = 144 шага) + 0.5 с: удержание кончилось, скорость
    // вернулась к потолку тяги
    let mut core = drive_onto_boost(make_core_with_held_boost());

    steps(&mut core, 144 + 60);

    let vx = tank_row_of(&core, 1)[4];

    assert!(vx < 270.0, "после удержания скорость — у потолка тяги: {vx}");
    assert!(vx > 240.0, "танк на газу держит полный ход: {vx}");
}

#[test]
fn boost_entry_from_off_the_grid_fires() {
    let mut core = make_core();

    core.load_map(&surface_map_json(40, |x, _| if x == 0 { 47 } else { 0 }, boost_game(47, "east")))
        .unwrap();
    core.spawn_actor(1, "m1", 1, -60.0, 336.0, 0.0).unwrap();
    core.apply_input(1, 1, "down", "forward");

    assert_eq!(count_boosts(&mut core, 1, 120), 1, "прошлая клетка вне карты — это въезд");
}

#[test]
fn conveyor_under_a_bridge_does_not_move_the_bridge_tank() {
    let ground: Vec<Vec<i32>> = vec![vec![45; 20]; 20];
    let slab: Vec<Vec<i32>> = (0..20)
        .map(|y| (0..20).map(|x| if (5..16).contains(&x) && (5..16).contains(&y) { 2 } else { 0 }).collect())
        .collect();
    let map = serde_json::json!({
        "setId": "c1",
        "scale": 1,
        "step": 32,
        "map": ground,
        "physicsStatic": [1],
        "physicsDynamic": [],
        "respawns": { "team1": [[100, 100, 0]], "team2": [[500, 100, 180]] },
        "levels": { "1": { "map": slab, "floor": [2], "walls": [] } },
        "game": { "surfaces": { "0": { "45": { "type": "conveyor", "dir": "south" } } } }
    })
    .to_string();
    let mut core = make_core();

    core.load_map(&map).unwrap();
    core.spawn_actor(1, "m1", 1, 320.0, 320.0, 0.0).unwrap();
    core.spawn_actor(2, "m1", 2, 100.0, 100.0, 0.0).unwrap();
    steps(&mut core, 120);

    assert_eq!(level_of(&core, 1), 1);
    assert!(tank_row_of(&core, 1)[5].abs() < 0.5, "танк на мосту стоит: {:?}", tank_row_of(&core, 1));
    assert!(tank_row_of(&core, 2)[5] > 20.0, "танк на земле едет с лентой: {:?}", tank_row_of(&core, 2));
}

#[test]
fn oil_turn_keeps_more_sideways_speed_than_asphalt() {
    let lateral = |game: serde_json::Value| {
        let mut core = make_core();

        core.load_map(&surface_map_json(80, |_, _| 44, game)).unwrap();
        core.spawn_actor(1, "m1", 1, 100.0, 320.0, 0.0).unwrap();
        core.apply_input(1, 1, "down", "forward");
        steps(&mut core, 240);
        core.apply_input(1, 2, "down", "right");
        steps(&mut core, 30);

        let row = tank_row_of(&core, 1);
        let (sin, cos) = row[2].sin_cos();

        (-row[4] * sin + row[5] * cos).abs()
    };
    let oil = lateral(serde_json::json!({ "surfaces": { "0": { "44": "oil" } } }));
    let asphalt = lateral(serde_json::Value::Null);

    assert!(oil > asphalt, "на масле танк заносит сильнее: {oil} vs {asphalt}");
}

// масло в колонках 0..6 (x < 192), дальше асфальт. Танк едет на восток,
// через `delay` шагов после съезда (корма за краем пятна) жмёт поворот на
// 36 шагов (0.3 с); результат — модуль боковой скорости
fn lateral_after_oil_exit(game: serde_json::Value, delay: usize) -> f32 {
    let mut core = make_core();

    core.load_map(&surface_map_json(120, |x, _| if x < 6 { 44 } else { 0 }, game)).unwrap();
    core.spawn_actor(1, "m1", 1, 100.0, 320.0, 0.0).unwrap();
    core.apply_input(1, 1, "down", "forward");

    let mut guard = 0;

    // до первого шага строк игроков ещё нет
    while guard == 0 || tank_row_of(&core, 1)[0] < 192.0 + 40.0 {
        steps(&mut core, 1);
        guard += 1;
        assert!(guard < 600, "танк не съехал с масла");
    }

    steps(&mut core, delay);
    core.apply_input(1, 2, "down", "right");
    steps(&mut core, 36);

    let row = tank_row_of(&core, 1);
    let (sin, cos) = row[2].sin_cos();

    (-row[4] * sin + row[5] * cos).abs()
}

#[test]
fn oil_residue_keeps_sliding_after_leaving_patch() {
    let oil = lateral_after_oil_exit(serde_json::json!({ "surfaces": { "0": { "44": "oil" } } }), 0);
    let asphalt = lateral_after_oil_exit(serde_json::Value::Null, 0);

    assert!(oil > asphalt, "после съезда с масла танк ещё заносит: {oil} vs {asphalt}");
}

#[test]
fn oil_residue_expires() {
    // slickTime 1.5 с = 180 шагов, плюс запас
    let oil = lateral_after_oil_exit(serde_json::json!({ "surfaces": { "0": { "44": "oil" } } }), 190);
    let asphalt = lateral_after_oil_exit(serde_json::Value::Null, 190);

    assert!((oil - asphalt).abs() <= asphalt * 0.01 + 1e-3, "остаток истёк — как асфальт: {oil} vs {asphalt}");
}

#[test]
fn map_without_surfaces_moves_exactly_as_before() {
    let run = |map: String| {
        let mut core = make_core();

        core.load_map(&map).unwrap();
        core.spawn_actor(1, "m1", 1, 100.0, 200.0, 0.0).unwrap();
        core.apply_input(1, 1, "down", "forward");
        steps(&mut core, 120);
        core.apply_input(1, 2, "down", "right");
        steps(&mut core, 120);

        core.players_data()
    };
    let bare = run(map_json());
    // поверхность объявлена, но её тайла на карте нет: таблица строится,
    // а движение обязано остаться бит-в-бит прежним
    let mut with_game: serde_json::Value = serde_json::from_str(&map_json()).unwrap();

    with_game["game"] = serde_json::json!({ "surfaces": { "0": { "99": "sand" } } });

    assert_eq!(bare, run(with_game.to_string()));
}

// ---- поверхности для тел карты (этап 3) ----

/// Карта с ящиками 32×32: `crates` — углы объектов и уровни.
fn with_crates(map_json: String, crates: &[([f32; 2], u8)]) -> String {
    let mut map: serde_json::Value = serde_json::from_str(&map_json).unwrap();

    map["physicsDynamic"] = crates
        .iter()
        .map(|(position, level)| {
            serde_json::json!({
                "density": 1,
                "position": position,
                "angle": 0,
                "width": 32,
                "height": 32,
                "linearDamping": 0.5,
                "level": level
            })
        })
        .collect();

    map.to_string()
}

fn conveyor_game(dir: &str) -> serde_json::Value {
    serde_json::json!({ "surfaces": { "0": { "45": { "type": "conveyor", "dir": dir } } } })
}

/// Лента на восток везде, кроме плиты-бустера на восток в колонках 10..13.
fn crate_boost_map_json(crates: &[([f32; 2], u8)]) -> String {
    let game = serde_json::json!({ "surfaces": { "0": {
        "45": { "type": "conveyor", "dir": "east" },
        "47": { "type": "boost", "dir": "east" }
    } } });

    with_crates(surface_map_json(40, |x, _| if (10..13).contains(&x) { 47 } else { 45 }, game), crates)
}

/// Центр и скорость ящика `index` без округления кадра: `[cx, cy, vx, vy]`.
fn crate_state(core: &GameCore, index: usize) -> [f32; 4] {
    let state = core.state();
    let handle = state.map.as_ref().unwrap().dynamic_handle(index).unwrap();
    let body = &state.world.bodies[handle];
    let center = state.world.colliders[body.colliders()[0]].translation();
    let vel = body.linvel();

    [center.x, center.y, vel.x, vel.y]
}

#[test]
fn crate_on_a_conveyor_moves_along_the_arrow() {
    let mut core = make_core();

    core.load_map(&with_crates(surface_map_json(40, |_, _| 45, conveyor_game("east")), &[([200.0, 300.0], 0)]))
        .unwrap();

    let start = crate_state(&core, 0);

    steps(&mut core, 240);

    let end = crate_state(&core, 0);

    assert!(end[0] - start[0] > 60.0, "лента везёт ящик по стрелке: {start:?} → {end:?}");
    assert!((end[1] - start[1]).abs() < 0.5, "поперёк стрелки ящик не едет: {start:?} → {end:?}");
}

#[test]
fn conveyor_under_a_bridge_moves_only_the_ground_crate() {
    let ground: Vec<Vec<i32>> = vec![vec![45; 20]; 20];
    let slab: Vec<Vec<i32>> = (0..20)
        .map(|y| (0..20).map(|x| if (5..16).contains(&x) && (5..16).contains(&y) { 2 } else { 0 }).collect())
        .collect();
    let map = serde_json::json!({
        "setId": "c1",
        "scale": 1,
        "step": 32,
        "map": ground,
        "physicsStatic": [1],
        "physicsDynamic": [],
        "respawns": { "team1": [[100, 100, 0]], "team2": [[500, 100, 180]] },
        "levels": { "1": { "map": slab, "floor": [2], "walls": [] } },
        "game": conveyor_game("south")
    })
    .to_string();
    let mut core = make_core();

    // ящик 0 — на мосту, ящик 1 — на ленте под мостом
    core.load_map(&with_crates(map, &[([304.0, 304.0], 1), ([176.0, 176.0], 0)])).unwrap();

    let bridge = crate_state(&core, 0);
    let ground = crate_state(&core, 1);

    steps(&mut core, 120);

    assert!((crate_state(&core, 0)[1] - bridge[1]).abs() < 0.5, "ящик на мосту стоит: {:?}", crate_state(&core, 0));
    assert!(crate_state(&core, 1)[1] - ground[1] > 20.0, "ящик под мостом едет: {:?}", crate_state(&core, 1));
}

#[test]
fn boost_pushes_a_crate_once() {
    let mut core = make_core();

    core.load_map(&crate_boost_map_json(&[([200.0, 300.0], 0)])).unwrap();

    let mut last = crate_state(&core, 0);
    let mut boosts = 0;

    for _ in 0..360 {
        core.step(DT);

        let now = crate_state(&core, 0);

        if (now[2] - last[2]).hypot(now[3] - last[3]) > 60.0 {
            boosts += 1;
        }

        last = now;
    }

    assert_eq!(boosts, 1, "лента довозит ящик до плиты — один импульс");
    assert!(last[0] > 416.0, "ящик проехал плиту: {last:?}");
}

#[test]
fn destroyed_crate_takes_no_surface_forces() {
    let map = with_crates(surface_map_json(40, |_, _| 45, conveyor_game("east")), &[([200.0, 300.0], 0)]);
    let mut core = make_core();

    core.load_map(&map).unwrap();
    core.pack_body().unwrap();
    core.take_events();

    // байт состояния тела пишет игра (этап 5); здесь он подменяется в дампе
    let mut dump: serde_json::Value = serde_json::from_slice(&core.serialize_state().unwrap()).unwrap();

    assert_eq!(dump["map_body_state"], serde_json::json!([0]));
    dump["map_body_state"] = serde_json::json!([2]);

    let mut destroyed = make_core();

    destroyed.deserialize_state(&serde_json::to_vec(&dump).unwrap()).unwrap();

    let start = crate_state(&destroyed, 0);

    steps(&mut destroyed, 120);
    steps(&mut core, 120);

    assert_eq!(crate_state(&destroyed, 0), start, "разрушенный ящик лента не везёт");
    assert!(crate_state(&core, 0)[0] - start[0] > 10.0, "целый ящик едет: {:?}", crate_state(&core, 0));
}

#[test]
fn state_dump_restores_identical_simulation_on_surfaces() {
    let mut core = make_core();

    // ящик 0 едет по ленте, ящик 1 въедет на плиту бустера уже после дампа
    core.load_map(&crate_boost_map_json(&[([40.0, 100.0], 0), ([260.0, 400.0], 0)])).unwrap();
    steps(&mut core, 60);

    assert!(crate_state(&core, 1)[0] < 320.0, "до дампа ящик 1 ещё не на плите");

    core.pack_body().unwrap();
    core.take_events();

    let dump = core.serialize_state().unwrap();
    let mut restored = make_core();

    restored.deserialize_state(&dump).unwrap();

    let mut peak = 0.0f32;

    for _ in 0..240 {
        core.step(DT);
        restored.step(DT);
        peak = peak.max(crate_state(&restored, 1)[2]);
    }

    assert!(peak > 150.0, "ящик 1 получил импульс бустера после дампа: {peak}");

    for index in 0..2 {
        assert_eq!(crate_state(&core, index), crate_state(&restored, index), "ящик {index}");
    }
}

// ---- разрушаемые объекты (этап 5) ----

/// Карта с телами карты 32×32: угол объекта, уровень и тип пропа (`None` —
/// обычный неразрушаемый ящик).
fn with_props(map_json: String, bodies: &[([f32; 2], u8, Option<&str>)]) -> String {
    let mut map: serde_json::Value = serde_json::from_str(&map_json).unwrap();

    map["physicsDynamic"] = bodies
        .iter()
        .map(|(position, level, prop)| {
            let mut body = serde_json::json!({
                "density": 100,
                "position": position,
                "angle": 0,
                "width": 32,
                "height": 32,
                "linearDamping": 3,
                "angularDamping": 3,
                "level": level
            });

            if let Some(prop) = prop {
                body["game"] = serde_json::json!({ "prop": prop });
            }

            body
        })
        .collect();

    map.to_string()
}

/// Конфиг, у которого `c1`/`c2` объявляют роли `z`/`level`/`state`, как
/// src/config/snapshot.js: движок пишет байт состояния в строку тела.
fn config_json_with_body_state() -> String {
    let mut flat = flat_config_json();
    let fields = serde_json::json!([
        { "name": "x", "ty": "f32", "interp": "lerp" },
        { "name": "y", "ty": "f32", "interp": "lerp" },
        { "name": "angle", "ty": "f32", "interp": "lerpAngle" },
        { "name": "z", "ty": "f32", "interp": "lerp", "role": "z" },
        { "name": "level", "ty": "u8", "role": "level" },
        { "name": "state", "ty": "u8", "role": "state" },
        { "name": "vx", "ty": "f32", "interp": "lerp" },
        { "name": "vy", "ty": "f32", "interp": "lerp" },
        { "name": "angvel", "ty": "f32", "interp": "lerp" }
    ]);

    for key in ["c1", "c2"] {
        flat["snapshot"]["keys"][key]["optionalFrom"] = serde_json::json!(6);
        flat["snapshot"]["keys"][key]["fields"] = fields.clone();
    }

    wrap_config(flat)
}

/// Конфиг с другим уроном взрыва бочки.
fn config_json_with_barrel_damage(damage: f64) -> String {
    let mut flat = flat_config_json();

    flat["props"]["barrel"]["blast"]["damage"] = serde_json::json!(damage);

    wrap_config(flat)
}

/// Байты состояния тел карты (`map_body_state` дампа).
fn body_states(core: &GameCore) -> Vec<u8> {
    let dump: serde_json::Value = serde_json::from_slice(&core.serialize_state().unwrap()).unwrap();

    serde_json::from_value(dump["map_body_state"].clone()).unwrap()
}

fn body_enabled(core: &GameCore, index: usize) -> bool {
    let state = core.state();
    let handle = state.map.as_ref().unwrap().dynamic_handle(index).unwrap();

    state.world.bodies[handle].is_enabled()
}

fn prop_hp(core: &GameCore, index: usize) -> f32 {
    core.state().sim.props().get(index).unwrap().hp
}

/// Сколько строк `w2e` накопилось с прошлой сборки кадра.
fn explosion_rows(core: &mut GameCore) -> usize {
    core.state_mut()
        .build_snapshot_blocks()
        .into_iter()
        .map(|(key, block)| match block {
            Block::List16(rows) if key == "w2e" => rows.len(),
            _ => 0,
        })
        .sum()
}

/// Байт `state` строки тела `index` в блоке `c1` собранного кадра.
fn frame_state(core: &mut GameCore, index: u8) -> u8 {
    let blocks = core.state_mut().build_snapshot_blocks();
    let rows = blocks
        .into_iter()
        .find_map(|(key, block)| match block {
            Block::IndexedNoNull8(rows) if key == "c1" => Some(rows),
            _ => None,
        })
        .expect("блок c1 в кадре");
    let (_, fields) = rows.into_iter().find(|(id, _)| *id == index).expect("строка тела");

    match fields[5] {
        FieldValue::U8(state) => state,
        _ => panic!("поле state строки тела должно быть u8"),
    }
}

fn deaths(all: &[CoreEvent]) -> Vec<(u32, u32)> {
    all.iter()
        .filter_map(|event| match event {
            CoreEvent::Death { victim, killer } => Some((*victim, *killer)),
            _ => None,
        })
        .collect()
}

#[test]
fn shots_break_a_fence_and_take_a_crate_through_the_damaged_stage() {
    let mut core = GameCore::new(&config_json_with_body_state()).unwrap();

    core.load_map(&with_props(map_json(), &[([200.0, 84.0], 0, Some("fence"))])).unwrap();
    core.spawn_actor(1, "m1", 1, 100.0, 100.0, 0.0).unwrap();
    core.step(DT);

    fire(&mut core, 1, 3);

    assert_eq!(body_states(&core), vec![2], "пуля 40 ломает забор (30 HP)");
    assert!(!body_enabled(&core, 0), "разрушенное тело отключено");
    assert_eq!(frame_state(&mut core, 0), 2);

    let mut core = GameCore::new(&config_json_with_body_state()).unwrap();

    core.load_map(&with_props(map_json(), &[([200.0, 84.0], 0, Some("crate"))])).unwrap();
    core.spawn_actor(1, "m1", 1, 100.0, 100.0, 0.0).unwrap();
    core.step(DT);

    let mut states = Vec::new();

    for seq in 1..=6 {
        fire(&mut core, seq, 3);
        states.push(body_states(&core)[0]);

        if seq == 4 {
            assert_eq!(frame_state(&mut core, 0), 1, "стадия «повреждён» в кадре");
        }
    }

    // пуля по ящику — 40 × 0.5 = 20 HP; стадия — ниже 60 из 120
    assert_eq!(states, vec![0, 0, 0, 1, 1, 2]);
    assert!(!body_enabled(&core, 0));
    assert_eq!(frame_state(&mut core, 0), 2);
}

#[test]
fn ramming_at_full_speed_breaks_a_fence_slow_push_does_not() {
    let mut fast = make_core();

    fast.load_map(&with_props(map_json(), &[([400.0, 84.0], 0, Some("fence"))])).unwrap();
    fast.spawn_actor(1, "m1", 1, 60.0, 100.0, 0.0).unwrap();
    fast.apply_input(1, 1, "down", "forward");

    let mut broke_at = None;

    for step in 0..360 {
        fast.step(DT);

        if broke_at.is_none() && body_states(&fast)[0] == 2 {
            broke_at = Some(step);
        }
    }

    assert!(broke_at.is_some(), "таран на скорости ломает забор, HP {}", prop_hp(&fast, 0));

    let mut slow = make_core();

    // танк 8×6 стоит вплотную к забору и толкает его с места
    slow.load_map(&with_props(map_json(), &[([104.5, 84.0], 0, Some("fence"))])).unwrap();
    slow.spawn_actor(1, "m1", 1, 100.0, 100.0, 0.0).unwrap();
    slow.apply_input(1, 1, "down", "forward");
    steps(&mut slow, 240);

    assert_eq!(body_states(&slow), vec![0]);
    assert_eq!(prop_hp(&slow, 0), 30.0, "медленное толкание урона не наносит");
    assert!(dynamic_box_x(&slow) > 130.0, "забор уехал перед танком: {}", dynamic_box_x(&slow));
}

#[test]
fn shot_barrel_explodes_and_its_kill_is_a_suicide() {
    let mut core = GameCore::new(&config_json_with_barrel_damage(500.0)).unwrap();

    core.load_map(&with_props(map_json(), &[([200.0, 84.0], 0, Some("barrel"))])).unwrap();
    core.spawn_actor(1, "m1", 1, 100.0, 100.0, 0.0).unwrap();
    core.spawn_actor(2, "m1", 2, 216.0, 140.0, 0.0).unwrap();
    core.step(DT);
    core.take_events();
    explosion_rows(&mut core);

    fire(&mut core, 1, 3);

    let all = events(&mut core);

    assert_eq!(body_states(&core), vec![2]);
    assert_eq!(explosion_rows(&mut core), 1, "взрыв бочки — строка w2e");
    assert_eq!(deaths(&all), vec![(2, 2)], "смерть от бочки — самоубийство: {all:?}");
    assert!(
        all.iter().any(|event| matches!(event, CoreEvent::Shake { id: 2, .. })),
        "тряска из blast.cameraShake: {all:?}"
    );
    assert_eq!(health_of(&all, 1), None, "стрелок вне радиуса: {all:?}");
}

#[test]
fn barrel_hurts_a_nearby_tank_without_killing_it() {
    let mut core = make_core();

    core.load_map(&with_props(map_json(), &[([200.0, 84.0], 0, Some("barrel"))])).unwrap();
    core.spawn_actor(1, "m1", 1, 100.0, 100.0, 0.0).unwrap();
    // своя команда стрелка: у бочки дружественного огня нет
    core.spawn_actor(2, "m1", 1, 216.0, 140.0, 0.0).unwrap();
    core.step(DT);
    core.take_events();

    fire(&mut core, 1, 3);

    let all = events(&mut core);

    assert!(health_of(&all, 2).is_some_and(|h| h > 0.0 && h < 100.0), "события: {all:?}");
    assert!(deaths(&all).is_empty());
}

/// Бочки 0 и 1 почти вплотную: центры в 33 единицах, взрыв первой (80 с
/// линейным спадом на радиусе 70) снимает второй все 40 HP.
fn chained_barrels_map_json() -> String {
    with_props(map_json(), &[([200.0, 84.0], 0, Some("barrel")), ([233.0, 84.0], 0, Some("barrel"))])
}

/// Стреляет в бочку 0 и шагает до её взрыва; номер шага от выстрела.
fn shoot_first_barrel(core: &mut GameCore) -> usize {
    core.apply_input(1, 1, "down", "fire");

    for step in 0..10 {
        core.step(DT);

        if body_states(core)[0] == 2 {
            return step;
        }
    }

    panic!("бочка 0 не взорвалась от выстрела");
}

#[test]
fn chained_barrel_explodes_after_the_chain_delay() {
    let mut core = make_core();

    core.load_map(&chained_barrels_map_json()).unwrap();
    core.spawn_actor(1, "m1", 1, 100.0, 100.0, 0.0).unwrap();
    core.step(DT);
    explosion_rows(&mut core);

    shoot_first_barrel(&mut core);

    assert_eq!(body_states(&core), vec![2, 0], "вторая бочка до взрыва цела");
    assert!(body_enabled(&core, 1), "и её тело включено");
    assert_eq!(prop_hp(&core, 1), 0.0);
    assert_eq!(explosion_rows(&mut core), 1, "в шаге выстрела — один взрыв");

    let mut delay = 0;

    while body_states(&core)[1] != 2 {
        core.step(DT);
        delay += 1;

        assert!(delay < 60, "вторая бочка так и не взорвалась");
    }

    // chainDelay 0.15 с при шаге 1/120 — 18 шагов
    assert_eq!(delay, 18);
    assert!(!body_enabled(&core, 1));
    assert_eq!(explosion_rows(&mut core), 1);
}

#[test]
fn barrel_on_level_one_does_not_hurt_the_ground_tank() {
    let mut core = make_core();

    core.load_map(&with_props(layered_map_json(), &[([368.0, 256.0], 1, Some("barrel"))])).unwrap();
    // стрелок на плите, бочка на плите по лучу; цели — в одной точке
    // рядом с бочкой: одна на мосту, вторая под ним
    core.spawn_actor(1, "m1", 1, 336.0, 272.0, 0.0).unwrap();
    core.spawn_actor(2, "m1", 2, 384.0, 320.0, 0.0).unwrap();
    core.spawn_actor(3, "m1", 2, 384.0, 320.0, 0.0).unwrap();

    steps(&mut core, 2);
    core.set_actor_level(3, 0);
    steps(&mut core, 2);

    assert_eq!((level_of(&core, 2), level_of(&core, 3)), (1, 0));
    core.take_events();

    fire(&mut core, 1, 4);

    let all = events(&mut core);

    assert_eq!(body_states(&core), vec![2]);
    assert!(health_of(&all, 2).is_some_and(|h| h < 100.0), "танк на мосту задет: {all:?}");
    assert_eq!(health_of(&all, 3), None, "плита экранирует взрыв бочки: {all:?}");
}

#[test]
fn destroyed_fence_lets_rays_tanks_and_blasts_through() {
    use rapier2d::prelude::{QueryFilter, Ray, Vector};

    let mut core = make_core();

    core.load_map(&with_props(map_json(), &[([200.0, 84.0], 0, Some("fence"))])).unwrap();
    core.spawn_actor(1, "m1", 1, 180.0, 100.0, 0.0).unwrap();
    core.step(DT);

    fire(&mut core, 1, 3);

    assert_eq!(body_states(&core), vec![2]);

    // луч, каким бот ищет препятствия, сквозь обломки проходит
    let ray = Ray::new(Vector::new(190.0, 100.0), Vector::new(1.0, 0.0));
    let hit = core.state().world.cast_ray(&ray, 60.0, true, QueryFilter::new().exclude_sensors());

    assert!(hit.is_none(), "разрушенное тело не видно лучам");

    // бомба рядом с обломками их не толкает
    let before = dynamic_box_x(&core);

    core.apply_input(1, 2, "down", "nextWeapon");
    core.step(DT);
    core.apply_input(1, 3, "down", "fire");
    steps(&mut core, 50);

    assert_eq!(dynamic_box_x(&core), before, "бомба не толкает разрушенное тело");

    // танк проезжает там, где стоял забор
    core.apply_input(1, 4, "down", "forward");
    steps(&mut core, 120);

    assert!(tank_x(&core, 1) > 240.0, "танк проехал сквозь обломки: {}", tank_x(&core, 1));
}

#[test]
fn map_reload_restores_destroyed_props() {
    let map = with_props(map_json(), &[([200.0, 84.0], 0, Some("fence")), ([300.0, 300.0], 0, None)]);
    let mut core = make_core();

    core.load_map(&map).unwrap();
    core.spawn_actor(1, "m1", 1, 100.0, 100.0, 0.0).unwrap();
    core.step(DT);

    fire(&mut core, 1, 3);

    assert_eq!(body_states(&core), vec![2, 0]);

    // рестарт раунда: движок перезагружает ту же карту
    core.load_map(&map).unwrap();

    assert_eq!(body_states(&core), vec![0, 0]);
    assert!(body_enabled(&core, 0));
    assert_eq!(prop_hp(&core, 0), 30.0);
    assert!(core.state().sim.props().get(1).is_none(), "тело без `game.prop` — не проп");
}

#[test]
fn unknown_prop_fails_the_map_load() {
    let mut core = make_core();
    // ошибка — через EngineSim: JsError вне WASM не создаётся
    let error = core
        .state_mut()
        .load_map(&with_props(map_json(), &[([200.0, 84.0], 0, Some("tree"))]))
        .unwrap_err();

    assert!(error.contains("physicsDynamic[0].game.prop") && error.contains("tree"), "{error}");
}

#[test]
fn state_dump_restores_identical_simulation_with_a_pending_detonation() {
    let mut core = make_core();

    core.load_map(&chained_barrels_map_json()).unwrap();
    core.spawn_actor(1, "m1", 1, 100.0, 100.0, 0.0).unwrap();
    core.spawn_actor(2, "m1", 2, 266.0, 150.0, 0.0).unwrap();
    core.step(DT);

    shoot_first_barrel(&mut core);
    steps(&mut core, 5);

    assert_eq!(body_states(&core), vec![2, 0], "вторая бочка взведена, но цела");

    core.pack_body().unwrap();
    core.take_events();

    let dump = core.serialize_state().unwrap();
    let mut restored = make_core();

    restored.deserialize_state(&dump).unwrap();

    assert_eq!(restored.state().sim.props(), core.state().sim.props());

    steps(&mut core, 60);
    steps(&mut restored, 60);

    assert_eq!(body_states(&restored), vec![2, 2], "детонация из дампа состоялась");
    assert_eq!(body_states(&core), body_states(&restored));
    assert_eq!(core.state().sim.props(), restored.state().sim.props());
    assert_eq!(core.position_of(1), restored.position_of(1));
    assert_eq!(core.position_of(2), restored.position_of(2));
    assert_eq!(core.take_events(), restored.take_events());
}

/// Регрессия центра взрыва: позиция тела карты — угол объекта, и импульс,
/// приложенный к углу, закручивал ящик. От центра коллайдера — без вращения.
#[test]
fn bomb_pushes_a_map_box_from_its_center() {
    let mut core = make_core();

    core.load_map(&map_with_box_json(110.0, 110.0)).unwrap();
    core.spawn_actor(1, "m1", 1, 100.0, 100.0, 0.0).unwrap();
    core.step(DT);

    core.apply_input(1, 1, "down", "nextWeapon");
    core.step(DT);
    core.apply_input(1, 2, "down", "fire");
    steps(&mut core, 50);

    let state = core.state();
    let handle = state.map.as_ref().unwrap().dynamic_handle(0).unwrap();
    let body = &state.world.bodies[handle];

    assert!(body.linvel().length() > 1.0, "взрыв толкает ящик: {:?}", body.linvel());
    assert!(body.angvel().abs() < 1e-4, "импульс через центр не закручивает: {}", body.angvel());
}

/// Арена 30×20 тайлов (шаг 32, масштаб 1): периметр и внутренняя стена в
/// колонке 15, строки 0..=13 — проход внизу, строки 14..18.
fn walled_arena_json() -> String {
    let mut grid: Vec<Vec<i32>> = vec![vec![0; 30]; 20];

    for x in 0..30 {
        grid[0][x] = 1;
        grid[19][x] = 1;
    }

    for row in grid.iter_mut() {
        row[0] = 1;
        row[29] = 1;
    }

    for row in grid.iter_mut().take(14) {
        row[15] = 1;
    }

    serde_json::json!({
        "setId": "c1",
        "scale": 1,
        "step": 32,
        "map": grid,
        "physicsStatic": [1],
        "physicsDynamic": [],
        "respawns": {
            "team1": [[160, 96, 0]],
            "team2": [[800, 96, 180]]
        }
    })
    .to_string()
}

/// Шагает до `max_steps`, копя события; `true`, как только здоровье `id`
/// упало ниже 100.
fn wounded_within(core: &mut GameCore, id: u32, max_steps: usize) -> bool {
    let mut all = Vec::new();

    for step in 0..max_steps {
        core.step(DT);

        if step % 120 == 0 {
            all.extend(events(core));

            if health_of(&all, id).is_some_and(|health| health < 100.0) {
                return true;
            }
        }
    }

    all.extend(events(core));
    health_of(&all, id).is_some_and(|health| health < 100.0)
}

fn distance(a: &[f32], b: &[f32]) -> f32 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt()
}

#[test]
fn bot_drives_around_a_wall_to_the_enemy() {
    let mut core = make_core();

    core.load_map(&walled_arena_json()).unwrap();
    core.spawn_scripted_actor(1, "m1", 1, 5.0 * 32.0, 3.0 * 32.0, 0.0).unwrap();
    core.spawn_actor(2, "m1", 2, 25.0 * 32.0, 3.0 * 32.0, 180.0).unwrap();

    // 45 с: путь за стену один — через проход внизу
    assert!(
        wounded_within(&mut core, 2, 5400),
        "бот не добрался до врага за стеной"
    );
}

#[test]
fn stuck_bot_backs_off_the_wall() {
    let mut core = make_core();

    core.load_map(&walled_arena_json()).unwrap();
    // вплотную к внутренней стене, лицом к ней; враг за стеной
    core.spawn_scripted_actor(1, "m1", 1, 15.0 * 32.0 - 7.0, 3.0 * 32.0, 0.0).unwrap();
    core.spawn_actor(2, "m1", 2, 25.0 * 32.0, 3.0 * 32.0, 180.0).unwrap();

    let start = core.position_of(1);

    steps(&mut core, 1200);

    let moved = distance(&start, &core.position_of(1));
    let stats = core.state().sim.bot_debug(1).unwrap().stats;

    assert!(moved > 60.0, "бот не отъехал от стены: {moved}");
    assert!(
        stats.stuck_events == 0 || stats.unstuck_resolved > 0,
        "застревание без выхода: {stats:?}"
    );
}

#[test]
fn bot_climbs_the_ramp_after_a_side_approach() {
    let mut core = make_core();

    core.load_map(&layered_map_json()).unwrap();
    // сбоку от прогона (строка 9), нос на север — в борт рампы
    core.spawn_scripted_actor(1, "m1", 1, 7.5 * 32.0, 11.5 * 32.0, 270.0).unwrap();
    core.spawn_actor(2, "m1", 2, SLAB.0, SLAB.1, 180.0).unwrap();
    core.set_actor_level(2, 1);

    let mut reached = false;

    for _ in 0..3600 {
        core.step(DT);

        if level_of(&core, 1) == 1 {
            reached = true;
            break;
        }
    }

    assert!(reached, "бот не заехал на мост с бокового подхода");
}

#[test]
fn bot_on_the_bridge_gets_down_to_a_ground_enemy() {
    let mut core = make_core();

    core.load_map(overpass_map_json()).unwrap();
    // точка респауна на плите (spawnOn(10, 29, 0, 1)) и наземный враг
    // (респаун team2 [1584, 1168]); масштаб карты 0.4
    core.spawn_scripted_actor(1, "m1", 1, 336.0 * 0.4, 944.0 * 0.4, 0.0).unwrap();
    core.set_actor_level(1, 1);
    core.spawn_actor(2, "m1", 2, 1584.0 * 0.4, 1168.0 * 0.4, 180.0).unwrap();

    steps(&mut core, 2);
    assert_eq!(level_of(&core, 1), 1);

    let wounded = wounded_within(&mut core, 2, 7200);

    assert_eq!(level_of(&core, 1), 0, "бот не спустился с моста");
    assert!(wounded, "бот не ранил наземного врага");
}

#[test]
fn bots_do_not_stall_on_downtown() {
    let map = downtown_map_json();
    let parsed: serde_json::Value = serde_json::from_str(map).unwrap();
    let scale = parsed["scale"].as_f64().unwrap() as f32;
    let mut core = make_core();

    core.load_map(map).unwrap();

    let mut ids = Vec::new();

    for (team, key) in [(1u8, "team1"), (2u8, "team2")] {
        for point in parsed["respawns"][key].as_array().unwrap().iter().take(4) {
            let id = ids.len() as u32 + 1;
            let x = point[0].as_f64().unwrap() as f32 * scale;
            let y = point[1].as_f64().unwrap() as f32 * scale;
            let angle = point[2].as_f64().unwrap() as f32;

            core.spawn_scripted_actor(id, "m1", team, x, y, angle).unwrap();
            ids.push(id);
        }
    }

    // самое длинное окно «жив и сместился меньше 8 ед.» на бота; выборка в
    // Engage и Hold окно прерывает (стоять и стрелять, держать засаду — норма)
    let mut anchor: Vec<Option<(Vec<f32>, usize)>> = vec![None; ids.len()];
    let mut longest = vec![0usize; ids.len()];

    for sample in 0..180 {
        steps(&mut core, 60);

        for (i, &id) in ids.iter().enumerate() {
            let debug = core.state().sim.bot_debug(id).unwrap();

            if !core.is_alive(id) || debug.mode == "engage" || debug.mode == "hold" {
                anchor[i] = None;
                continue;
            }

            let pos = core.position_of(id);

            match &anchor[i] {
                Some((start, since)) if distance(start, &pos) < 8.0 => {
                    longest[i] = longest[i].max(sample - since);
                }
                _ => anchor[i] = Some((pos, sample)),
            }
        }
    }

    for (i, &id) in ids.iter().enumerate() {
        let stats = core.state().sim.bot_debug(id).unwrap().stats;

        assert!(
            longest[i] as f32 * 0.5 <= 6.0,
            "бот {id} стоял {} с: {stats:?}",
            longest[i] as f32 * 0.5
        );
        assert!(stats.watchdog_resets <= 3, "бот {id}: сторож {stats:?}");
    }
}

/// Арена 60×20 тайлов (шаг 32, масштаб 1, ширина 1920) с парой стенок
/// посередине.
fn wide_arena_json() -> String {
    let mut grid: Vec<Vec<i32>> = vec![vec![0; 60]; 20];

    for x in 0..60 {
        grid[0][x] = 1;
        grid[19][x] = 1;
    }

    for row in grid.iter_mut() {
        row[0] = 1;
        row[59] = 1;
    }

    for y in 4..9 {
        grid[y][28] = 1;
    }

    for y in 11..16 {
        grid[y][31] = 1;
    }

    serde_json::json!({
        "setId": "c1",
        "scale": 1,
        "step": 32,
        "map": grid,
        "physicsStatic": [1],
        "physicsDynamic": [],
        "respawns": {
            "team1": [[96, 320, 0]],
            "team2": [[1820, 320, 180]]
        }
    })
    .to_string()
}

#[test]
fn bot_finds_an_enemy_across_the_map() {
    let mut core = make_core();

    core.load_map(&wide_arena_json()).unwrap();
    core.spawn_scripted_actor(1, "m1", 1, 96.0, 320.0, 0.0).unwrap();
    core.spawn_actor(2, "m1", 2, 1820.0, 320.0, 180.0).unwrap();

    assert!(distance(&core.position_of(1), &core.position_of(2)) > 1500.0);
    // 40 с: враг дальше дальности пушки и вне видимости — бот знает о нём
    // только по радару
    assert!(
        wounded_within(&mut core, 2, 4800),
        "бот не нашёл врага на другом краю карты"
    );
}

#[test]
fn bot_does_not_waste_shots_into_a_crate() {
    // ящик 32×32 (тело — угол, коллайдер смещён на полгабарита) вплотную к
    // врагу, ровно на прямой бот—враг. Толкать ящик корпусом боту можно,
    // стрелять в него — нет
    const BOX_X: f32 = 384.0;
    const BOX_Y: f32 = 284.0;

    let mut core = make_core();

    core.load_map(&map_with_box_json(BOX_X, BOX_Y)).unwrap();
    core.spawn_scripted_actor(1, "m1", 1, 120.0, 300.0, 0.0).unwrap();
    core.spawn_actor(2, "m1", 2, 420.0, 300.0, 180.0).unwrap();

    steps(&mut core, 360);

    // пушка молчит; бомба вплотную к врагу (ящик отодвинут) — не выстрел в ящик
    let gun_shots = events(&mut core)
        .iter()
        .filter(|e| matches!(e, CoreEvent::PanelSet { id: 1, field, .. } if field == "w1"))
        .count();
    let stats = core.state().sim.bot_debug(1).unwrap().stats;

    assert_eq!(gun_shots, 0, "бот стрелял в ящик: {stats:?}");
}

#[test]
fn wounded_bot_retreats_and_fires_back() {
    let mut core = make_core();

    core.load_map(&map_json()).unwrap();
    core.spawn_scripted_actor(1, "m1", 1, 150.0, 200.0, 0.0).unwrap();
    // неподвижный враг в прямой видимости: с 25 HP бот погиб бы от одного
    // выстрела, а отход запускает и видимый враг ближе 450
    core.spawn_actor(2, "m1", 2, 450.0, 200.0, 180.0).unwrap();
    core.state_mut().sim.debug_set_health(1, 25.0);

    let enemy_start = core.position_of(2);
    let start_gap = distance(&core.position_of(1), &enemy_start);
    let mut retreat: Option<(usize, u32)> = None;
    let mut gap_grew = false;
    let mut shots = 0;

    // 4 с, режим — каждые 0.1 с
    for sample in 0..40 {
        steps(&mut core, 12);

        let debug = core.state().sim.bot_debug(1).unwrap();

        shots = debug.stats.shots_fired;

        if debug.mode == "retreat" && retreat.is_none() {
            retreat = Some((sample, shots));
        }

        if core.is_alive(1) && distance(&core.position_of(1), &enemy_start) > start_gap + 40.0 {
            gap_grew = true;
        }
    }

    let (at, shots_before) = retreat.expect("раненый бот не отступал");

    assert!(at < 20, "отступление началось только на {} с", at as f32 * 0.1);
    assert!(gap_grew, "бот не отъехал от врага");
    assert!(shots > shots_before, "бот не отстреливался на отходе");
}

#[test]
fn team_focuses_one_target() {
    let mut core = make_core();

    core.load_map(&map_json()).unwrap();

    for (id, y) in [(1, 150.0), (2, 250.0), (3, 350.0)] {
        core.spawn_scripted_actor(id, "m1", 1, 100.0, y, 0.0).unwrap();
    }

    // неподвижные враги в прямой видимости; не умирают, чтобы фокус не сменился
    core.spawn_actor(4, "m1", 2, 400.0, 250.0, 180.0).unwrap();
    core.spawn_actor(5, "m1", 2, 430.0, 350.0, 180.0).unwrap();

    for id in [4, 5] {
        core.state_mut().sim.debug_set_health(id, 1.0e6);
    }

    steps(&mut core, 600);

    let focus = core.state().sim.team_focus(1);
    let focused = [1, 2, 3]
        .iter()
        .filter(|&&id| core.state().sim.bot_debug(id).unwrap().target == focus)
        .count();

    assert!(focus.is_some(), "у команды нет фокуса");
    assert!(focused >= 2, "в фокус {focus:?} бьют только {focused} из 3");
}

#[test]
fn clear_resets_team_boards() {
    let mut core = make_core();

    core.load_map(&map_json()).unwrap();
    core.spawn_scripted_actor(1, "m1", 1, 100.0, 250.0, 0.0).unwrap();
    core.spawn_scripted_actor(2, "m1", 2, 400.0, 250.0, 180.0).unwrap();

    for id in [1, 2] {
        core.state_mut().sim.debug_set_health(id, 1.0e6);
    }

    let mut focused = false;

    for _ in 0..600 {
        core.step(DT);

        if core.state().sim.team_focus(1).is_some() {
            focused = true;
            break;
        }
    }

    assert!(focused, "у команды нет фокуса");

    // смена карты: движок зовёт clear перед load_map
    core.clear();

    assert_eq!(core.state().sim.team_focus(1), None, "доска пережила clear");
}

/// Арена 60×20 тайлов (шаг 32, масштаб 1): периметр и стена в колонке 45,
/// строки 0..=13 — проход внизу.
fn long_walled_arena_json() -> String {
    let mut grid: Vec<Vec<i32>> = vec![vec![0; 60]; 20];

    for x in 0..60 {
        grid[0][x] = 1;
        grid[19][x] = 1;
    }

    for row in grid.iter_mut() {
        row[0] = 1;
        row[59] = 1;
    }

    for row in grid.iter_mut().take(14) {
        row[45] = 1;
    }

    serde_json::json!({
        "setId": "c1",
        "scale": 1,
        "step": 32,
        "map": grid,
        "physicsStatic": [1],
        "physicsDynamic": [],
        "respawns": {
            "team1": [[160, 160, 0]],
            "team2": [[1600, 160, 180]]
        }
    })
    .to_string()
}

#[test]
fn leading_bot_waits_for_the_team() {
    let mut core = make_core();

    core.load_map(&long_walled_arena_json()).unwrap();
    // двое сзади, лидер (id 3) в 800 ед. впереди, у стены; враги за стеной
    core.spawn_scripted_actor(1, "m1", 1, 500.0, 150.0, 0.0).unwrap();
    core.spawn_scripted_actor(2, "m1", 1, 500.0, 250.0, 0.0).unwrap();
    core.spawn_scripted_actor(3, "m1", 1, 1300.0, 150.0, 0.0).unwrap();
    core.spawn_actor(4, "m1", 2, 1600.0, 96.0, 180.0).unwrap();
    core.spawn_actor(5, "m1", 2, 1600.0, 192.0, 180.0).unwrap();

    // равная агрессия: фланкер — бот 1 (меньший id), не лидер
    for id in [1, 2, 3] {
        core.state_mut().sim.debug_set_bot_skill(id, BotSkill::Normal);
    }

    let mut regrouped = false;
    let mut gathered = false;

    for _ in 0..100 {
        steps(&mut core, 12);

        regrouped |= core.state().sim.bot_debug(3).unwrap().mode == "regroup";

        let positions: Vec<Vec<f32>> = [1, 2, 3].iter().map(|&id| core.position_of(id)).collect();
        let center = [
            positions.iter().map(|p| p[0]).sum::<f32>() / 3.0,
            positions.iter().map(|p| p[1]).sum::<f32>() / 3.0,
        ];

        gathered |= positions.iter().all(|p| distance(p, &center) < 400.0);
    }

    assert!(regrouped, "лидер не ждал команду");
    assert!(gathered, "команда так и не собралась");
}

// ***** приёмка ИИ ботов: матчи 4×4 на слоёных картах ***** //

/// Снимок одного бота раз в 0.5 с матча.
#[derive(Clone)]
struct BotSample {
    pos: Vec<f32>,
    alive: bool,
    mode: &'static str,
    /// Уровень из players_data; `None`, если танка там нет (мёртв).
    level: Option<u64>,
}

/// Журнал матча ботов (`run_bot_match`).
struct MatchLog {
    /// (game_id, команда) по порядку спавна.
    bots: Vec<(u32, u8)>,
    /// `samples[k][i]` — k-я выборка бота `bots[i]`.
    samples: Vec<Vec<BotSample>>,
    stats: Vec<BotStats>,
    /// Урон, полученный танками каждой команды: (команда 1, команда 2).
    damage_taken: (f64, f64),
    deaths: usize,
    seconds: f32,
}

impl MatchLog {
    fn index(&self, id: u32) -> usize {
        self.bots.iter().position(|&(bot, _)| bot == id).unwrap()
    }

    /// Самое длинное окно «жив, не в `Engage`/`Hold`, сместился меньше
    /// 8 ед.», с.
    fn longest_stall(&self, id: u32) -> f32 {
        let i = self.index(id);
        let mut anchor: Option<(&[f32], usize)> = None;
        let mut longest = 0usize;

        for (k, sample) in self.samples.iter().map(|row| &row[i]).enumerate() {
            if !sample.alive || sample.mode == "engage" || sample.mode == "hold" {
                anchor = None;
                continue;
            }

            match anchor {
                Some((start, since)) if distance(start, &sample.pos) < 8.0 => {
                    longest = longest.max(k - since);
                }
                _ => anchor = Some((&sample.pos, k)),
            }
        }

        longest as f32 * 0.5
    }

    /// Урон, нанесённый командой: `friendlyFire` выключен, поэтому это урон,
    /// полученный противником (с учётом его падений с высоты).
    fn damage_by_team(&self, team: u8) -> f64 {
        if team == 1 {
            self.damage_taken.1
        } else {
            self.damage_taken.0
        }
    }

    fn replans(&self, id: u32) -> u32 {
        self.stats[self.index(id)].replans
    }

    fn route_failures(&self, id: u32) -> u32 {
        self.stats[self.index(id)].route_failures
    }

    fn watchdog_resets(&self, id: u32) -> u32 {
        self.stats[self.index(id)].watchdog_resets
    }

    /// Хоть один бот был на уровне ≥ 1; хоть один спустился на уровень 0
    /// после уровня ≥ 1.
    fn levels_used(&self) -> (bool, bool) {
        let mut upper = false;
        let mut came_down = false;

        for i in 0..self.bots.len() {
            let mut was_up = false;

            for sample in self.samples.iter().map(|row| &row[i]) {
                match sample.level {
                    Some(level) if level >= 1 => was_up = true,
                    Some(0) if was_up => came_down = true,
                    _ => {}
                }
            }

            upper |= was_up;
        }

        (upper, came_down)
    }
}

/// Спавнит по `per_team` ботов на первых точках `respawns.team1/team2`
/// карты (точки в немасштабированных единицах; уровень — 4-й элемент).
fn spawn_bot_teams(core: &mut GameCore, map_json: &str, per_team: usize) -> Vec<(u32, u8)> {
    spawn_teams(core, map_json, per_team, true)
}

/// То же, что `spawn_bot_teams`; `with_ai: false` — танки без ИИ.
fn spawn_teams(core: &mut GameCore, map_json: &str, per_team: usize, with_ai: bool) -> Vec<(u32, u8)> {
    spawn_teams_in_order(core, map_json, per_team, with_ai, [1, 2])
}

/// То же, что `spawn_teams`, команды спавнятся в порядке `order` (id — по
/// порядку спавна).
fn spawn_teams_in_order(
    core: &mut GameCore,
    map_json: &str,
    per_team: usize,
    with_ai: bool,
    order: [u8; 2],
) -> Vec<(u32, u8)> {
    let parsed: serde_json::Value = serde_json::from_str(map_json).unwrap();
    let scale = parsed["scale"].as_f64().unwrap() as f32;
    let mut bots = Vec::new();

    for team in order {
        let key = format!("team{team}");
        let points = parsed["respawns"][key.as_str()].as_array().unwrap();

        assert!(points.len() >= per_team, "на карте мало респаунов {key}");

        for point in points.iter().take(per_team) {
            let id = bots.len() as u32 + 1;
            let x = point[0].as_f64().unwrap() as f32 * scale;
            let y = point[1].as_f64().unwrap() as f32 * scale;
            let angle = point[2].as_f64().unwrap() as f32;

            if with_ai {
                core.spawn_scripted_actor(id, "m1", team, x, y, angle).unwrap();
            } else {
                core.spawn_actor(id, "m1", team, x, y, angle).unwrap();
            }

            if let Some(level) = point.get(3).and_then(|level| level.as_u64()) {
                core.set_actor_level(id, level as u8);
            }

            bots.push((id, team));
        }
    }

    bots
}

/// Матч ботов `per_team` на `per_team`: `seconds` симуляции, выборка
/// каждые 0.5 с, события копятся.
fn run_bot_match(map_json: &str, per_team: usize, seconds: f32) -> MatchLog {
    let mut core = make_core();

    core.load_map(map_json).unwrap();

    let bots = spawn_bot_teams(&mut core, map_json, per_team);
    let mut health: std::collections::HashMap<u32, f64> =
        bots.iter().map(|&(id, _)| (id, 100.0)).collect();
    let mut damage_taken = (0.0, 0.0);
    let mut deaths = 0;
    let mut samples = Vec::new();

    for _ in 0..(seconds * 2.0) as usize {
        steps(&mut core, 60);

        for event in events(&mut core) {
            match event {
                CoreEvent::PanelSet { id, field, value } if field == "health" => {
                    let Some(&(_, team)) = bots.iter().find(|&&(bot, _)| bot == id) else {
                        continue;
                    };
                    let drop = (health[&id] - value).max(0.0);

                    health.insert(id, value);

                    if team == 1 {
                        damage_taken.0 += drop;
                    } else {
                        damage_taken.1 += drop;
                    }
                }
                CoreEvent::Death { .. } => deaths += 1,
                _ => {}
            }
        }

        let data: serde_json::Value = serde_json::from_str(&core.players_data()).unwrap();

        samples.push(
            bots.iter()
                .map(|&(id, _)| BotSample {
                    pos: core.position_of(id),
                    alive: core.is_alive(id),
                    mode: core.state().sim.bot_debug(id).unwrap().mode,
                    level: data["m1"][id.to_string()][12].as_u64(),
                })
                .collect(),
        );
    }

    let stats = bots
        .iter()
        .map(|&(id, _)| core.state().sim.bot_debug(id).unwrap().stats)
        .collect();

    MatchLog {
        bots,
        samples,
        stats,
        damage_taken,
        deaths,
        seconds,
    }
}

/// Матч 4×4 на 120 с — один на карту на весь прогон тестов (тесты карты
/// читают общий журнал).
fn match_on(map: &'static str) -> &'static MatchLog {
    static DOWNTOWN: OnceLock<MatchLog> = OnceLock::new();
    static TERRACES: OnceLock<MatchLog> = OnceLock::new();
    static OVERPASS: OnceLock<MatchLog> = OnceLock::new();

    let (cell, json) = match map {
        "downtown" => (&DOWNTOWN, downtown_map_json()),
        "terraces" => (&TERRACES, terraces_map_json()),
        "overpass" => (&OVERPASS, overpass_map_json()),
        _ => unreachable!("нет фикстуры {map}"),
    };

    cell.get_or_init(|| run_bot_match(json, 4, 120.0))
}

fn assert_never_stall(map: &'static str) {
    let log = match_on(map);

    for &(id, _) in &log.bots {
        let stats = log.stats[log.index(id)];

        assert!(
            log.longest_stall(id) <= 6.0,
            "{map}: бот {id} стоял {} с: {stats:?}",
            log.longest_stall(id)
        );
        assert!(log.watchdog_resets(id) <= 3, "{map}: бот {id}, сторож: {stats:?}");
    }
}

fn assert_fight(map: &'static str) {
    let log = match_on(map);

    assert!(log.damage_by_team(1) > 0.0, "{map}: команда 1 не нанесла урона");
    assert!(log.damage_by_team(2) > 0.0, "{map}: команда 2 не нанесла урона");
    assert!(log.deaths > 0, "{map}: за {} с никто не погиб", log.seconds);
}

fn assert_use_levels(map: &'static str) {
    let (upper, came_down) = match_on(map).levels_used();

    assert!(upper, "{map}: ни один бот не был на уровне ≥ 1");
    assert!(came_down, "{map}: ни один бот не спустился на уровень 0");
}

fn assert_replans_bounded(map: &'static str) {
    let log = match_on(map);
    let minutes = log.seconds / 60.0;

    for &(id, _) in &log.bots {
        let replans = log.replans(id);
        let failures = log.route_failures(id);

        assert!(
            replans as f32 <= 90.0 * minutes,
            "{map}: бот {id} перестроил маршрут {replans} раз за {} с ({})",
            log.seconds,
            log.stats[log.index(id)].replan_causes
        );
        assert!(
            (failures as f32) / (replans.max(1) as f32) < 0.1,
            "{map}: бот {id}: {failures} неудач из {replans} перестроений"
        );
    }
}

#[test]
fn bots_never_stall_downtown() {
    assert_never_stall("downtown");
}

#[test]
fn bots_never_stall_terraces() {
    assert_never_stall("terraces");
}

#[test]
fn bots_never_stall_overpass() {
    assert_never_stall("overpass");
}

#[test]
fn bots_fight_on_downtown() {
    assert_fight("downtown");
}

#[test]
fn bots_fight_on_terraces() {
    assert_fight("terraces");
}

#[test]
fn bots_fight_on_overpass() {
    assert_fight("overpass");
}

#[test]
fn bots_use_levels_on_downtown() {
    assert_use_levels("downtown");
}

#[test]
fn bots_use_levels_on_terraces() {
    assert_use_levels("terraces");
}

#[test]
fn bots_use_levels_on_overpass() {
    assert_use_levels("overpass");
}

#[test]
fn bot_replans_are_bounded_downtown() {
    assert_replans_bounded("downtown");
}

#[test]
fn bot_replans_are_bounded_terraces() {
    assert_replans_bounded("terraces");
}

#[test]
fn bot_replans_are_bounded_overpass() {
    assert_replans_bounded("overpass");
}

#[test]
fn bot_match_is_deterministic() {
    let run = || {
        let map = downtown_map_json();
        let mut core = make_core();

        core.load_map(map).unwrap();

        let bots = spawn_bot_teams(&mut core, map, 4);

        steps(&mut core, 60 * 120);

        bots.iter().map(|&(id, _)| core.position_of(id)).collect::<Vec<_>>()
    };

    assert_eq!(run(), run(), "два прогона матча разошлись");
}

/// Матч ботов `per_team` на `per_team`, дамп на шаге `before` и
/// восстановление в новом ядре: (исходное ядро, восстановленное, боты).
fn dump_and_restore(
    map: &str,
    per_team: usize,
    before: usize,
) -> (GameCore, GameCore, Vec<(u32, u8)>) {
    let mut core = make_core();

    core.load_map(map).unwrap();

    let bots = spawn_bot_teams(&mut core, map, per_team);

    steps(&mut core, before);
    core.pack_body().unwrap(); // дренаж накопителей перед дампом
    core.take_events();

    let dump = core.serialize_state().unwrap();
    let mut restored = make_core();

    restored.deserialize_state(&dump).unwrap();

    (core, restored, bots)
}

/// Оба ядра идут `count` шагов, боты в них совпадают побитово.
fn assert_bots_stay_identical(
    core: &mut GameCore,
    restored: &mut GameCore,
    bots: &[(u32, u8)],
    count: usize,
) {
    steps(core, count);
    steps(restored, count);

    for &(id, _) in bots {
        assert_eq!(core.position_of(id), restored.position_of(id), "бот {id}");
        assert_eq!(
            core.state().sim.bot_debug(id).unwrap().mode,
            restored.state().sim.bot_debug(id).unwrap().mode,
            "бот {id}"
        );
    }
}

#[test]
fn bot_dump_restores_identical_simulation() {
    let (mut core, mut restored, bots) = dump_and_restore(terraces_map_json(), 2, 20 * 120);

    assert_bots_stay_identical(&mut core, &mut restored, &bots, 20 * 120);
}

#[test]
fn bot_dump_restores_ten_bots_identically() {
    // 5×5: id переходят через 9 → 10, а ключи JSON-объекта идут как строки
    // (`1, 10, 2, …`) — порядок танков и ботов держит `ordered_map`. Дамп — на
    // шаге, не кратном числу ботов (очередь `ai_turn` не с нуля), и посреди
    // периода досок команд (гистерезис фокуса и ролей)
    let (mut core, mut restored, bots) = dump_and_restore(downtown_map_json(), 5, 10 * 120 + 3);
    let sim_dump = |core: &GameCore| {
        let dump: serde_json::Value =
            serde_json::from_slice(&core.serialize_state().unwrap()).unwrap();

        dump["sim"].clone()
    };

    assert_eq!(
        core.state().sim.ai_order(),
        restored.state().sim.ai_order(),
        "очередь бюджета маршрутов после восстановления другая"
    );
    assert!(
        sim_dump(&core) == sim_dump(&restored),
        "состояние игры после восстановления другое"
    );

    assert_bots_stay_identical(&mut core, &mut restored, &bots, 10 * 120);
}

/// Ожидания общего бюджета поисков маршрута (`route_waits`) по порядку
/// спавна; команды спавнятся в порядке `order`.
fn route_waits_downtown(per_team: usize, seconds: usize, order: [u8; 2]) -> Vec<u32> {
    let map = downtown_map_json();
    let mut core = make_core();

    core.load_map(map).unwrap();

    let bots = spawn_teams_in_order(&mut core, map, per_team, true, order);

    steps(&mut core, seconds * 120);

    bots.iter()
        .map(|&(id, _)| core.state().sim.bot_debug(id).unwrap().stats.route_waits)
        .collect()
}

#[test]
fn route_budget_is_shared_fairly() {
    // 5×5 на downtown, 30 с, дважды: команды спавнятся в прямом и обратном
    // порядке. Половины по спавну — это команды, поэтому перекос от карты в
    // сумме двух прогонов гасится, а перекос от порядка обхода — нет. Без
    // очереди (порядок спавна) последние ждали вдвое дольше: 122 против 58;
    // с очередью — 94 против 89
    const K: f32 = 1.5;

    let mut first = 0;
    let mut last = 0;
    let mut runs = Vec::new();

    for order in [[1, 2], [2, 1]] {
        let waits = route_waits_downtown(5, 30, order);
        let (head, tail) = waits.split_at(waits.len() / 2);

        first += head.iter().sum::<u32>();
        last += tail.iter().sum::<u32>();
        runs.push((order, waits));
    }

    assert!(
        last as f32 <= K * first.max(1) as f32,
        "последние по порядку ждут бюджет дольше первых: {last} против {first}, по прогонам {runs:?}"
    );
}

#[test]
fn old_bot_dump_still_loads() {
    // мозг в форме `BotBrain` до нового ИИ (bots::controller, HEAD 32e229f)
    let old = serde_json::json!({
        "game_id": 1,
        "state": "Patrolling",
        "target": null,
        "path": null,
        "path_index": 0,
        "repath_timer": 0.0,
        "target_scan_timer": 0.5,
        "ai_update_timer": 0.1,
        "firing_timer": 0.0,
        "bomb_cooldown_timer": 0.0,
        "last_known_position": null,
        "stuck_timer": 0.0,
        "last_position": [10.0, 20.0],
        "reposition_timer": 0.0,
        "reposition_target": null,
        "patrol_target": null,
        "key_states": [false, false, false, false, false, false]
    });
    let brain: BotBrain = serde_json::from_value(old).unwrap();

    assert_eq!(brain.game_id, 1);
    assert_eq!(brain.mode, BotMode::Roam);
}

/// Среднее время `core.step(DT)` на `downtown` с 5×5 танками за 60 с, мкс.
fn mean_step_micros(with_ai: bool) -> f64 {
    let map = downtown_map_json();
    let mut core = make_core();

    core.load_map(map).unwrap();
    spawn_teams(&mut core, map, 5, with_ai);

    let count = 60 * 120;
    let mut total = std::time::Duration::ZERO;

    for _ in 0..count {
        let start = std::time::Instant::now();

        core.step(DT);
        total += start.elapsed();
    }

    total.as_secs_f64() * 1.0e6 / count as f64
}

/// Бот против неподвижного танка человека на `distance` ед. (не дольше 60 с):
/// (время убийства в секундах или `None`, выстрелы, попадания).
fn kill_run(skill: BotSkill, distance: f32, seed: u64) -> (Option<f32>, u32, u32) {
    let mut core = make_core_seeded(seed);

    core.load_map(&map_json()).unwrap();
    core.spawn_scripted_actor(1, "m1", 1, 100.0, 300.0, 0.0)
        .unwrap();
    core.spawn_actor(2, "m1", 2, 100.0 + distance, 300.0, 180.0)
        .unwrap();
    core.state_mut().sim.debug_set_bot_skill(1, skill);

    let mut health = 100.0;
    let mut hits = 0;
    let mut kill_time = None;

    // порции по 0.1 с: попадание — `PanelSet health` меньше прошлого значения
    for portion in 1..=600 {
        steps(&mut core, 12);

        for event in events(&mut core) {
            match event {
                CoreEvent::PanelSet {
                    id: 2,
                    field,
                    value,
                } if field == "health" => {
                    if value < health {
                        hits += 1;
                    }

                    health = value;
                }
                CoreEvent::Death { victim: 2, .. } => kill_time = Some(portion as f32 * 0.1),
                _ => {}
            }
        }

        if kill_time.is_some() {
            break;
        }
    }

    let shots = core.state().sim.bot_debug(1).unwrap().stats.shots_fired;

    (kill_time, shots, hits)
}

/// Сила пресетов для подбора `coreParams.bots.presets`: бот против неподвижного
/// танка человека на 200/300/450 ед., 8 сидов на дистанцию, не дольше 60 с.
/// Секции `bots` в тестовом конфиге нет: меряются дефолты ядра
/// (`default_bot_presets`), правку `game.js` сначала перенести туда.
/// `cargo test -q -p vimp-tanks-core --test sim bot_skill_report -- --ignored --nocapture`
#[test]
#[ignore]
fn bot_skill_report() {
    let skills = [
        ("easy", BotSkill::Easy),
        ("normal", BotSkill::Normal),
        ("hard", BotSkill::Hard),
    ];

    for (name, skill) in skills {
        let mut kills = 0;
        let mut kill_time = 0.0;
        let mut shots = 0;
        let mut hits = 0;

        for distance in [200.0, 300.0, 450.0] {
            for seed in 1..=8 {
                let (time, run_shots, run_hits) = kill_run(skill, distance, seed);

                if let Some(time) = time {
                    kills += 1;
                    kill_time += time;
                }

                shots += run_shots;
                hits += run_hits;
            }
        }

        println!(
            "{name}: убийств {kills} из 24, среднее время {:.1} с, меткость {:.2} ({hits}/{shots})",
            kill_time / kills.max(1) as f32,
            hits as f32 / shots.max(1) as f32
        );
    }
}

/// Причины перестроений по ботам (матчи 4×4 по 120 с, как у `assert_replans_bounded`).
/// `cargo test -q -p vimp-tanks-core --test sim replan_causes_report -- --ignored --nocapture`
#[test]
#[ignore]
fn replan_causes_report() {
    for map in ["downtown", "terraces", "overpass"] {
        let log = match_on(map);

        for &(id, team) in &log.bots {
            let stats = &log.stats[log.index(id)];

            println!(
                "{map} бот {id} (команда {team}): всего {}; {}",
                stats.replans, stats.replan_causes
            );
        }
    }
}

/// Замер вклада ИИ (этап 7.3): `cargo test --release -q -p vimp-tanks-core
/// --test sim bench_bot_ai_downtown -- --ignored --nocapture`.
#[test]
#[ignore]
fn bench_bot_ai_downtown() {
    let idle = mean_step_micros(false);
    let bots = mean_step_micros(true);

    println!(
        "downtown 5×5, 60 с: шаг без ИИ {idle:.1} мкс, с ботами {bots:.1} мкс, вклад ИИ {:.1} мкс",
        bots - idle
    );
}
