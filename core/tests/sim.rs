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
            "fallDamage": 15
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
                    { "name": "level", "ty": "u8" }
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

/// Точка на плите моста (колонка 11, строка 8).
const SLAB: (f32, f32) = (368.0, 272.0);
/// Точка на земле вне плиты и вне рампы.
const GROUND: (f32, f32) = (112.0, 112.0);

/// Уровень танка из players_data (индекс 12 строки схемы m1).
fn level_of(core: &GameCore, game_id: u32) -> u64 {
    let data: serde_json::Value = serde_json::from_str(&core.players_data()).unwrap();

    data["m1"][game_id.to_string()][12].as_u64().unwrap()
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
fn dynamic_box_row(core: &GameCore, with_velocities: bool) -> Vec<FieldValue> {
    let state = core.state();
    let map = state.map.as_ref().expect("карта загружена");
    let rows = map.dynamic_map_data(&state.world, with_velocities);
    let (_, fields) = rows.first().expect("на карте один динамический ящик");

    fields.clone()
}

/// X единственного динамического тела карты (Map.getDynamicMapData).
fn dynamic_box_x(core: &GameCore) -> f32 {
    match dynamic_box_row(core, false)[0] {
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
    assert_eq!(dynamic_box_row(&core, true).len(), 3);

    core.apply_input(1, 1, "down", "fire");
    steps(&mut core, 10);

    let moving = dynamic_box_row(&core, true);

    assert_eq!(moving.len(), 6, "ящик едет — строка обязана нести скорости");

    match moving[3] {
        FieldValue::F32(vx) => assert!(vx > 0.0, "vx должен быть положительным: {vx}"),
        _ => panic!("поле vx строки динамики должно быть f32"),
    }

    // схема без хвоста ширину строки не меняет
    assert_eq!(dynamic_box_row(&core, false).len(), 3);
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
        "бомба над пустотой ложится на землю: {all:?}"
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

#[test]
fn scripted_bot_drives_onto_the_bridge() {
    // сценарий tests/scenarios/bots_bridge.json: нав-граф слоёной карты
    // действительно приводит бота наверх, а не только строит путь
    let mut core = make_core();

    core.load_map(&layered_map_json()).unwrap();
    core.spawn_scripted_actor(1, "m1", 1, 112.0, 304.0, 0.0).unwrap();

    let mut reached = false;

    // до 60 секунд патрулирования: цель патруля случайна, мост выпадает не
    // с первой попытки
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
