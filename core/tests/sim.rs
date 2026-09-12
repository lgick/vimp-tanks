// Интеграционные тесты симуляции: сценарии портированы с поведения
// текущего JS-сервера (tests/server/integration/) как эталона Этапа 2.

use vimp_engine_core::config::FieldValue;
use vimp_engine_core::events::CoreEvent;
use vimp_tanks_core::GameCore;

const DT: f32 = 1.0 / 120.0;

/// Конфиг ядра — зеркало src/config/game.js + src/data/*.js (собирается на
/// JS через src/lib/coreConfig.js). Плоский JSON заворачивается в
/// `{engine: {...}, game: {...}}` (PLAN.md §3.4) с одним и тем же объектом
/// по обе стороны — каждая половина деэерилизует лишние для себя поля молча.
fn config_json() -> String {
    let flat = flat_config_json();

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

    // до 60 секунд боя (боты мажут: AIM_INACCURACY). Проверяется завязка боя,
    // а не его исход: добить противника мешает патрулирование — бот уезжает
    // и залипает у стены, это отдельное поведение нав-системы
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

    serde_json::json!({ "engine": flat.clone(), "game": flat }).to_string()
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
    const BOX_X: f32 = 120.0;
    const BOX_Y: f32 = 130.0;

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

    serde_json::json!({ "engine": flat.clone(), "game": flat }).to_string()
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
fn shot_past_the_ledge_hits_the_ground_tank() {
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

    assert!(
        health_of(&all, 2).is_some_and(|h| h < 100.0),
        "за кромкой луч падает на землю: {all:?}"
    );
}

#[test]
fn ground_shot_hits_the_tank_on_the_open_edge() {
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

    assert!(
        health_of(&all, 2).is_some_and(|h| h < 100.0),
        "кромка без перил открыта снизу: {all:?}"
    );
}

#[test]
fn ground_shot_stops_at_the_second_slab_cell() {
    let mut core = make_core();

    core.load_map(&layered_map_json()).unwrap();
    // тот же выстрел снизу, но цель — во ВТОРОЙ клетке плиты: проба
    // уровня 1 живёт только в клетке кромки
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
        "вглубь плиты проба не достаёт: {all:?}"
    );
}

#[test]
fn railing_protects_the_tank_from_below() {
    let mut core = make_core();

    core.load_map(&railed_map_json()).unwrap();
    // тот же выстрел снизу, но первая клетка плиты на пути — перила
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
