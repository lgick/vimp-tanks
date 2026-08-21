//! Предсказание ЧУЖИХ танков, находящихся в контакте со своим — порт
//! `src/client/RemoteTanks.js` (срез tank-battle 2026-08).
//!
//! Зачем: свой танк рисуется «сейчас» (`predictor`), чужие — с задержкой
//! интерполяции (100 мс). Пока танки не соприкасаются, разницы не видно; при
//! толчке она вылезает с обеих сторон сразу: толкающий въезжает в
//! нарисованный чужой корпус (клиент контакт вообще не разрешал), а тот, кого
//! толкают, видит зазор — толкающий нарисован там, где был 100 мс назад.
//!
//! Механика предсказания (режимы `Follow`/`Predicted`, реконсиляция,
//! сглаживание ошибки, возврат в интерполяцию) — в [`super::predicted_set`],
//! общая с динамикой карты; здесь только своё: чтение блока модели, правило
//! захвата и формат рендер-строки.
//!
//! ⚠️ Охват намеренно узкий — только контактирующие танки. Предсказывать всех
//! подряд значит показывать дрожание экстраполяции там, где интерполяция
//! работает безупречно.
//!
//! ⚠️ Экстраполяция идёт БЕЗ демпфирования: ввод чужого игрока неизвестен, а
//! едущий танк держит газ, то есть его скорость за эти 100 мс примерно
//! постоянна. Применить демпфирование модели значило бы тормозить чужой танк
//! на ровном месте (linear 3 съедает ~23 % скорости за 100 мс), поэтому
//! `linear_damping`/`angular_damping` тела остаются нулевыми — отдельный путь
//! от своего танка, которому демпфирование применяется (`crate::motion`).

use std::any::Any;
use std::collections::HashSet;

use indexmap::IndexMap;

use vimp_engine_core::client::collision::obb_vs_obb;
use vimp_engine_core::client::game::PredictedRow;
use vimp_engine_core::client::interpolator::InterpolatedGame;
use vimp_engine_core::client::raycast::Box2;
use vimp_engine_core::client::rigid_body::{Surface, box_mass_properties};
use vimp_engine_core::client::unpack::{BlockData, DecodedSnapshot};
use vimp_engine_core::config::{FieldValue, SnapshotConfig};

use crate::config::ModelConfig;

use super::predicted_set::{
    PredictedBodies, PredictedBody, PredictedSet, ServerState, Transform, inflate_tank,
};

/// Упреждение проверки захвата (с). Критерий «корпуса уже пересеклись» здесь
/// не работает: на экране толкаемого чужой танк нарисован там, где был
/// `serverNow − delay`, то есть ЕЩЁ НЕ ДОЕХАЛ — контакт не наступит никогда,
/// и предсказание не включится. Поэтому проверка идёт по авторитетной
/// позиции, сдвинутой вперёд по её же скорости; захватить чуть раньше
/// безвредно (предсказанное тело просто точно следует за хостом), опоздать —
/// нет.
const CAPTURE_LOOKAHEAD: f32 = 0.2;

// потолок предсказанного множества (свалка из танков в узком проходе)
const MAX_PREDICTED_TANKS: usize = 6;

// индексы полей строки mN (x, y, angle, gunRotation, vx, vy, engineLoad,
// condition, size, team, angvel) — позиционный контракт со схемой снапшота
// игры (src/config/snapshot.js)
const FIELD_X: usize = 0;
const FIELD_Y: usize = 1;
const FIELD_ANGLE: usize = 2;
const FIELD_GUN: usize = 3;
const FIELD_VX: usize = 4;
const FIELD_VY: usize = 5;
const FIELD_ENGINE_LOAD: usize = 6;
const FIELD_CONDITION: usize = 7;
const FIELD_SIZE: usize = 8;
const FIELD_TEAM: usize = 9;
const FIELD_ANGVEL: usize = 10;

fn field_f32(fields: &[FieldValue], i: usize) -> f32 {
    match fields.get(i) {
        Some(FieldValue::F32(v)) => *v,
        _ => 0.0,
    }
}

fn field_u8(fields: &[FieldValue], i: usize) -> u8 {
    match fields.get(i) {
        Some(FieldValue::U8(v)) => *v,
        _ => 0,
    }
}

/// Ключ тела: модель плюс id игрока — id уникален только внутри блока модели.
fn body_key(model_key: &str, game_id: u32) -> String {
    format!("{model_key}:{game_id}")
}

// ключ модели из ключа тела
fn model_of(key: &str) -> &str {
    key.split(':').next().unwrap_or("")
}

/// Дискретные поля строки танка: симуляции они не нужны, а рендер-строка
/// обязана повторять форму блока модели целиком.
struct TankMeta {
    /// id ключа модели в схеме снапшота — им строка уходит в рендер-тик
    key_id: Option<u8>,
    game_id: u32,
    gun: f32,
    engine_load: f32,
    condition: u8,
    size: u8,
    team: u8,
}

/// Предсказание чужих танков в контакте.
pub struct RemoteTanks {
    set: PredictedSet,
    models: IndexMap<String, ModelConfig>,
    snapshot: SnapshotConfig,
    // дискретные поля тел (ключи те же, что у множества)
    meta: IndexMap<String, TankMeta>,
    // свой танк исключается из предсказания: им владеет предиктор
    own_game_id: Option<u32>,
}

impl RemoteTanks {
    pub fn new(models: &IndexMap<String, ModelConfig>, snapshot: &SnapshotConfig) -> Self {
        Self {
            set: PredictedSet::new(MAX_PREDICTED_TANKS),
            models: models.clone(),
            snapshot: snapshot.clone(),
            meta: IndexMap::new(),
            own_game_id: None,
        }
    }

    /// Свой танк (player-блок кадра): его тело в множестве не заводится.
    pub fn set_own_game_id(&mut self, game_id: Option<u32>) {
        self.own_game_id = game_id;
    }

    /// Смена карты/очистка полотна: чужие танки заводятся заново кадрами.
    pub fn reset(&mut self) {
        self.set.bodies_mut().clear();
        self.meta.clear();
    }

    /// СИМУЛЯЦИОННЫЕ боксы корпусов по `gameId` — цели raycast выстрела:
    /// интерполированные корпуса отстают на `interpolation.delay`, и по
    /// едущему танку луч ушёл бы мимо.
    pub fn sim_boxes(&self) -> Vec<(u32, Box2)> {
        self.set
            .bodies()
            .iter()
            .filter_map(|(key, body)| Some((self.meta.get(key)?.game_id, sim_obb(body))))
            .collect()
    }

    /// Переносит мировую точку из СИМУЛЯЦИОННОГО фрейма корпуса в РЕНДЕРНЫЙ.
    /// Луч считается там, где танк у хоста, а рисуется трассер там, где танк
    /// виден: по едущему корпусу это разные места (`delay×v` — до габарита),
    /// и без переноса трассер обрывался бы в воздухе. `None` — танк неизвестен.
    pub fn to_render_point(&self, game_id: u32, world_x: f32, world_y: f32) -> Option<[f32; 2]> {
        let body = self.body_by_game_id(game_id)?;
        let sim = sim_obb(body);
        let (sin, cos) = (-sim.angle).sin_cos();
        let rel_x = world_x - sim.x;
        let rel_y = world_y - sim.y;
        let local_x = cos * rel_x - sin * rel_y;
        let local_y = sin * rel_x + cos * rel_y;

        // рендерный фрейм: состояние плюс сглаживающая ошибка (у follow-тела
        // ошибка нулевая, и это ровно интерполированный трансформ)
        let render = body.render_transform();
        let (render_sin, render_cos) = render.angle.sin_cos();

        Some([
            render.x + render_cos * local_x - render_sin * local_y,
            render.y + render_sin * local_x + render_cos * local_y,
        ])
    }

    // id игрока уникален только внутри блока модели, а ключ тела — «модель:id»;
    // на цели raycast'а модель неизвестна, поэтому поиск идёт по мета-записям
    fn body_by_game_id(&self, game_id: u32) -> Option<&PredictedBody> {
        let key = self
            .meta
            .iter()
            .find(|(_, meta)| meta.game_id == game_id)
            .map(|(key, _)| key)?;

        self.set.bodies().get(key)
    }
}

impl PredictedBodies for RemoteTanks {
    fn set(&self) -> &PredictedSet {
        &self.set
    }

    fn set_mut(&mut self) -> &mut PredictedSet {
        &mut self.set
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }

    /// Трансформы из интерполированного сэмпла. Состоянием предсказанных тел
    /// владеет симуляция, им обновляется только `follow` — эталон, по
    /// которому решается возврат в интерполяцию.
    ///
    /// Танк, пропавший из блока своей модели (вышел из игры, сменил команду,
    /// это свой танк), из множества удаляется: null-маркеров в сэмпле нет —
    /// интерполяция отдаёт только строки, присутствующие в обоих кадрах.
    fn update(&mut self, game: &InterpolatedGame) {
        let mut seen: HashSet<String> = HashSet::new();

        for (model_key, rows) in &game.blocks {
            let Some(model) = self.models.get(model_key) else {
                continue;
            };
            let key_id = self.snapshot.keys.get(model_key).map(|schema| schema.id);
            let friction = model.fixture.friction;
            let restitution = model.fixture.restitution;
            let density = model.fixture.density;

            for row in rows {
                if self.own_game_id == Some(row.id) {
                    continue;
                }

                let key = body_key(model_key, row.id);
                let transform = Transform {
                    x: field_f32(&row.fields, FIELD_X),
                    y: field_f32(&row.fields, FIELD_Y),
                    angle: field_f32(&row.fields, FIELD_ANGLE),
                };
                let size = field_u8(&row.fields, FIELD_SIZE);
                let size_changed = self.meta.get(&key).map(|meta| meta.size) != Some(size);
                let body = self.set.bodies_mut().entry(key.clone()).or_insert_with(|| {
                    let mut body = PredictedBody::new(transform);

                    body.surface = Surface {
                        friction,
                        restitution,
                    };

                    body
                });

                body.follow = transform;

                if !body.is_predicted() {
                    body.body.x = transform.x;
                    body.body.y = transform.y;
                    body.body.angle = transform.angle;
                }

                if size_changed {
                    apply_size(body, size, density);
                }

                self.meta.insert(
                    key.clone(),
                    TankMeta {
                        key_id,
                        game_id: row.id,
                        gun: field_f32(&row.fields, FIELD_GUN),
                        engine_load: field_f32(&row.fields, FIELD_ENGINE_LOAD),
                        condition: field_u8(&row.fields, FIELD_CONDITION),
                        size,
                        team: field_u8(&row.fields, FIELD_TEAM),
                    },
                );
                seen.insert(key);
            }
        }

        // блока модели в сэмпле нет — судить о её танках не по чему
        let present: HashSet<&str> = game
            .blocks
            .keys()
            .filter(|key| self.models.contains_key(*key))
            .map(|key| key.as_str())
            .collect();
        let keep = |key: &str| !present.contains(model_of(key)) || seen.contains(key);

        self.set.bodies_mut().retain(|key, _| keep(key));
        self.meta.retain(|key, _| keep(key));
    }

    /// Авторитетное состояние известных тел из сырого кадра (реконсиляция).
    fn snapshot_bodies(&self, snapshot: &DecodedSnapshot) -> Vec<(String, ServerState)> {
        let mut entries = Vec::new();

        for model_key in self.models.keys() {
            let Some(BlockData::Indexed8(items)) = snapshot.block_by_key(model_key) else {
                continue;
            };

            for (id, row) in items {
                let Some(fields) = row else {
                    continue;
                };
                let key = body_key(model_key, *id as u32);

                if !self.set.bodies().contains_key(&key) {
                    continue;
                }

                entries.push((
                    key,
                    ServerState {
                        x: field_f32(fields, FIELD_X),
                        y: field_f32(fields, FIELD_Y),
                        angle: field_f32(fields, FIELD_ANGLE),
                        vx: field_f32(fields, FIELD_VX),
                        vy: field_f32(fields, FIELD_VY),
                        angvel: field_f32(fields, FIELD_ANGVEL),
                    },
                ));
            }
        }

        entries
    }

    /// Переводит в `Predicted` чужие танки, попавшие в раздутый OBB своего.
    /// Транзитивного замыкания нет: цепочка «танк толкает танк толкает танк»
    /// практически не встречается, а лишние предсказанные тела — это лишнее
    /// дрожание на чужих экранах.
    ///
    /// Обломки (`condition 0`) захватываются наравне с живыми: их тело хост
    /// из мира не убирает (`remove_player` зовётся только на выходе игрока,
    /// смене команды и новом раунде), а значит они остаются толкаемым
    /// препятствием.
    fn capture(&mut self, tank: &Box2, local_now: f64) {
        let inflated = inflate_tank(tank);
        let max = self.set.max_predicted();
        let mut predicted = self.set.count_predicted();

        for body in self.set.bodies_mut().values_mut() {
            if body.is_predicted() || predicted >= max {
                continue;
            }

            if obb_vs_obb(&inflated, &capture_obb(body)).is_some() {
                body.promote(local_now);
                predicted += 1;
            }
        }
    }

    /// Строки предсказанных танков для рендер-тика — та же форма блока
    /// модели, что и у кадра, поэтому они просто перекрывают
    /// интерполированные строки тех же танков.
    fn render_data(&self) -> Vec<PredictedRow> {
        self.set
            .bodies()
            .iter()
            .filter(|(_, body)| body.is_predicted())
            .filter_map(|(key, body)| {
                let meta = self.meta.get(key)?;
                let render = body.render_transform();

                Some(PredictedRow {
                    key_id: meta.key_id?,
                    id: meta.game_id,
                    fields: vec![
                        render.x,
                        render.y,
                        render.angle,
                        meta.gun,
                        body.body.vx,
                        body.body.vy,
                        meta.engine_load,
                        meta.condition as f32,
                        meta.size as f32,
                        meta.team as f32,
                        body.body.angvel,
                    ],
                })
            })
            .collect()
    }
}

// габариты и масса из size кадра (соотношение сторон 4:3, как у корпуса на
// хосте, см. `crate::tank`); размер танка, в отличие от динамики карты,
// картой не масштабируется
fn apply_size(body: &mut PredictedBody, size: u8, density: f32) {
    let width = size as f32 * 4.0;
    let height = size as f32 * 3.0;
    let mass = box_mass_properties(width, height, density);

    body.half_w = width / 2.0;
    body.half_h = height / 2.0;
    body.body.inv_mass = mass.inv_mass;
    body.body.inv_inertia = mass.inv_inertia;
}

// OBB для проверки захвата: авторитетная позиция с упреждением
// (см. [`CAPTURE_LOOKAHEAD`]), а не отстающая интерполированная
fn capture_obb(body: &PredictedBody) -> Box2 {
    let (x, y, angle, vx, vy) = if body.has_server {
        let server = body.last_server;

        (server.x, server.y, server.angle, server.vx, server.vy)
    } else {
        (body.follow.x, body.follow.y, body.follow.angle, 0.0, 0.0)
    };

    Box2 {
        x: x + vx * CAPTURE_LOOKAHEAD,
        y: y + vy * CAPTURE_LOOKAHEAD,
        angle,
        half_w: body.half_w,
        half_h: body.half_h,
    }
}

// OBB корпуса в том виде, в каком его видит хост «сейчас»:
//   predicted — своё состояние, оно и есть «сейчас» (ошибка косметическая);
//   follow — последний авторитетный кадр, а НЕ интерполированный трансформ:
//     тот отстаёт на interpolation.delay, и по едущему танку луч ушёл бы мимо
fn sim_obb(body: &PredictedBody) -> Box2 {
    let (x, y, angle) = if body.is_predicted() {
        (body.body.x, body.body.y, body.body.angle)
    } else if body.has_server {
        (
            body.last_server.x,
            body.last_server.y,
            body.last_server.angle,
        )
    } else {
        (body.follow.x, body.follow.y, body.follow.angle)
    };

    Box2 {
        x,
        y,
        angle,
        half_w: body.half_w,
        half_h: body.half_h,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vimp_engine_core::client::interpolator::InterpolatedRow;
    use vimp_engine_core::client::unpack::DecodedBlock;
    use vimp_engine_core::config::BlockSchema;

    use crate::client::predicted_set::Mode;

    fn model_config() -> ModelConfig {
        serde_json::from_value(serde_json::json!({
            "currentWeapon": "w1",
            "size": 10,
            "accelerationFactor": 1000,
            "brakingFactor": 0.3,
            "maxForwardSpeed": 260,
            "maxReverseSpeed": -130,
            "baseTurnTorqueFactor": 215,
            "damping": { "linear": 3, "angular": 100.0 },
            "fixture": { "density": 1, "friction": 0.5, "restitution": 0.1 },
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

    // две модели: id ключей 1 и 6, как в схеме снапшота игры
    fn models() -> IndexMap<String, ModelConfig> {
        let mut models = IndexMap::new();

        models.insert("m1".to_string(), model_config());
        models.insert("m2".to_string(), model_config());

        models
    }

    fn snapshot_config() -> SnapshotConfig {
        let schema = |id: u8| -> BlockSchema {
            serde_json::from_value(serde_json::json!({
                "id": id,
                "kind": "indexed8",
                "class": "hot",
                "fields": [
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
                    { "name": "angvel", "ty": "f32", "interp": "lerp" }
                ]
            }))
            .unwrap()
        };
        let mut keys = IndexMap::new();

        keys.insert("m1".to_string(), schema(1));
        keys.insert("m2".to_string(), schema(6));

        SnapshotConfig {
            version: 5,
            port: 5,
            keys,
        }
    }

    fn remote_tanks() -> RemoteTanks {
        RemoteTanks::new(&models(), &snapshot_config())
    }

    // строка танка: живой (condition 3), size 10 → корпус 40×30
    fn tank_row(x: f32, y: f32, angle: f32, vx: f32, vy: f32, angvel: f32) -> Vec<FieldValue> {
        vec![
            FieldValue::F32(x),
            FieldValue::F32(y),
            FieldValue::F32(angle),
            FieldValue::F32(0.0),
            FieldValue::F32(vx),
            FieldValue::F32(vy),
            FieldValue::F32(0.0),
            FieldValue::U8(3),
            FieldValue::U8(10),
            FieldValue::U8(1),
            FieldValue::F32(angvel),
        ]
    }

    fn at(x: f32, y: f32) -> Vec<FieldValue> {
        tank_row(x, y, 0.0, 0.0, 0.0, 0.0)
    }

    // интерполированный сэмпл: скоростей он не несёт (см. snapshot_bodies)
    fn game(rows: &[(&str, u32, Vec<FieldValue>)]) -> InterpolatedGame {
        let mut blocks: IndexMap<String, Vec<InterpolatedRow>> = IndexMap::new();

        for (model_key, id, fields) in rows {
            blocks
                .entry(model_key.to_string())
                .or_default()
                .push(InterpolatedRow {
                    id: *id,
                    fields: fields.clone(),
                });
        }

        InterpolatedGame { blocks }
    }

    // сырой кадр блока модели (`Indexed8`, null-маркер — удаление строки)
    fn snapshot(rows: &[(u8, Option<Vec<FieldValue>>)]) -> DecodedSnapshot {
        let mut items = IndexMap::new();

        for (id, fields) in rows {
            items.insert(*id, fields.clone());
        }

        DecodedSnapshot {
            blocks: vec![DecodedBlock {
                key: "m1".to_string(),
                key_id: 1,
                data: BlockData::Indexed8(items),
            }],
        }
    }

    // OBB своего танка (центр), которым проверяется захват
    fn tank_obb(x: f32, y: f32) -> Box2 {
        Box2 {
            x,
            y,
            angle: 0.0,
            half_w: 4.0,
            half_h: 3.0,
        }
    }

    fn body<'a>(tanks: &'a RemoteTanks, key: &str) -> &'a PredictedBody {
        &tanks.set().bodies()[key]
    }

    // — чтение блока модели —

    #[test]
    fn update_creates_follow_body() {
        let mut tanks = remote_tanks();

        tanks.update(&game(&[("m1", 7, tank_row(100.0, 50.0, 0.5, 0.0, 0.0, 0.0))]));

        let body = body(&tanks, "m1:7");

        assert_eq!(body.mode, Mode::Follow);
        assert_eq!((body.body.x, body.body.y, body.body.angle), (100.0, 50.0, 0.5));
    }

    #[test]
    fn update_takes_geometry_and_mass_from_size() {
        let mut tanks = remote_tanks();

        tanks.update(&game(&[("m1", 7, at(0.0, 0.0))]));

        let body = body(&tanks, "m1:7");
        let mass = 1.0 * 40.0 * 30.0;
        let inertia = (mass * (40.0 * 40.0 + 30.0 * 30.0)) / 12.0;

        assert_eq!((body.half_w, body.half_h), (20.0, 15.0));
        assert!((1.0 / body.body.inv_mass - mass).abs() < 1e-3);
        assert!((1.0 / body.body.inv_inertia - inertia).abs() < 1e-1);
    }

    #[test]
    fn update_moves_follow_body_directly() {
        let mut tanks = remote_tanks();

        tanks.update(&game(&[("m1", 7, at(0.0, 0.0))]));
        tanks.update(&game(&[("m1", 7, tank_row(30.0, 40.0, 1.0, 0.0, 0.0, 0.0))]));

        let body = body(&tanks, "m1:7");

        assert_eq!((body.body.x, body.body.y, body.body.angle), (30.0, 40.0, 1.0));
    }

    // null-маркеров в сэмпле нет: пропавшая строка и есть удаление
    #[test]
    fn update_drops_bodies_missing_from_the_block() {
        let mut tanks = remote_tanks();

        tanks.update(&game(&[("m1", 7, at(0.0, 0.0)), ("m1", 8, at(80.0, 0.0))]));
        tanks.update(&game(&[("m1", 8, at(80.0, 0.0))]));

        assert!(!tanks.set().bodies().contains_key("m1:7"));
        assert!(tanks.set().bodies().contains_key("m1:8"));
    }

    // блока модели в сэмпле нет — судить о её танках не по чему
    #[test]
    fn update_keeps_bodies_of_absent_blocks() {
        let mut tanks = remote_tanks();

        tanks.update(&game(&[("m1", 7, at(0.0, 0.0)), ("m2", 3, at(80.0, 0.0))]));
        tanks.update(&game(&[("m2", 3, at(80.0, 0.0))]));

        assert!(tanks.set().bodies().contains_key("m1:7"));
    }

    #[test]
    fn update_excludes_own_tank() {
        let mut tanks = remote_tanks();

        tanks.set_own_game_id(Some(7));
        tanks.update(&game(&[("m1", 7, at(0.0, 0.0)), ("m1", 8, at(80.0, 0.0))]));

        assert!(!tanks.set().bodies().contains_key("m1:7"));
        assert!(tanks.set().bodies().contains_key("m1:8"));
    }

    #[test]
    fn update_ignores_unknown_blocks() {
        let mut tanks = remote_tanks();

        tanks.update(&game(&[("w1", 0, at(0.0, 0.0))]));

        assert!(tanks.set().bodies().is_empty());
        assert!(tanks.render_data().is_empty());
    }

    #[test]
    fn update_of_predicted_body_touches_only_follow() {
        let mut tanks = remote_tanks();

        tanks.update(&game(&[("m1", 7, at(0.0, 0.0))]));
        tanks.capture(&tank_obb(-15.0, 0.0), 1000.0);
        tanks.update(&game(&[("m1", 7, at(999.0, 999.0))]));

        let body = body(&tanks, "m1:7");

        assert_eq!(body.body.x, 0.0); // не улетел на 999
        assert_eq!(
            body.follow,
            Transform {
                x: 999.0,
                y: 999.0,
                angle: 0.0,
            }
        );
    }

    // — захват —

    #[test]
    fn capture_promotes_touching_tank_only() {
        let mut tanks = remote_tanks();

        tanks.update(&game(&[("m1", 7, at(0.0, 0.0))]));
        tanks.capture(&tank_obb(-15.0, 0.0), 1000.0);

        assert_eq!(body(&tanks, "m1:7").mode, Mode::Predicted);

        let mut tanks = remote_tanks();

        tanks.update(&game(&[("m1", 7, at(0.0, 0.0))]));
        tanks.capture(&tank_obb(500.0, 500.0), 1000.0);

        assert_eq!(body(&tanks, "m1:7").mode, Mode::Follow);
    }

    // ключевое отличие от динамики карты: критерий «корпуса уже пересеклись»
    // на отстающей интерполяции не срабатывает никогда
    #[test]
    fn capture_uses_authoritative_position_with_lookahead() {
        let mut tanks = remote_tanks();

        // нарисован в (-100, 0) и не касается; авторитетно едет навстречу и
        // через CAPTURE_LOOKAHEAD окажется в контакте
        tanks.update(&game(&[("m1", 7, at(-100.0, 0.0))]));
        tanks.begin_reconcile(&snapshot(&[(
            7,
            Some(tank_row(-100.0, 0.0, 0.0, 500.0, 0.0, 0.0)),
        )]));
        tanks.capture(&tank_obb(-15.0, 0.0), 1000.0);

        assert_eq!(body(&tanks, "m1:7").mode, Mode::Predicted);
    }

    #[test]
    fn capture_of_moving_tank_keeps_the_drawn_transform() {
        let mut tanks = remote_tanks();

        // нарисован в (0, 0), авторитетно уже проехал 10 юнитов навстречу
        tanks.update(&game(&[("m1", 7, at(0.0, 0.0))]));
        tanks.begin_reconcile(&snapshot(&[(
            7,
            Some(tank_row(10.0, 0.0, 0.0, -60.0, 0.0, 0.0)),
        )]));
        tanks.capture(&tank_obb(-15.0, 0.0), 1000.0);

        let rows = tanks.render_data();

        assert_eq!(body(&tanks, "m1:7").body.x, 10.0); // состояние авторитетное
        assert_eq!(rows[0].fields[0], 0.0); // а нарисован там же, где был
        assert_eq!(rows[0].fields[1], 0.0);
    }

    #[test]
    fn capture_has_no_transitive_closure() {
        let mut tanks = remote_tanks();

        // корпус 40×30: 7-й в контакте, 8-й вплотную к нему, но не к танку
        tanks.update(&game(&[("m1", 7, at(0.0, 0.0)), ("m1", 8, at(41.0, 0.0))]));
        tanks.capture(&tank_obb(-15.0, 0.0), 1000.0);

        assert_eq!(body(&tanks, "m1:7").mode, Mode::Predicted);
        assert_eq!(body(&tanks, "m1:8").mode, Mode::Follow);
    }

    // хост убирает тело из мира только на выходе/смене команды/раунде,
    // поэтому обломки остаются твёрдыми и толкаемыми
    #[test]
    fn capture_takes_destroyed_tanks_too() {
        let mut tanks = remote_tanks();
        let mut row = at(0.0, 0.0);

        row[FIELD_CONDITION] = FieldValue::U8(0);

        tanks.update(&game(&[("m1", 7, row)]));
        tanks.capture(&tank_obb(-15.0, 0.0), 1000.0);

        assert_eq!(body(&tanks, "m1:7").mode, Mode::Predicted);
    }

    #[test]
    fn capture_respects_the_predicted_cap() {
        let mut tanks = remote_tanks();
        let rows: Vec<(&str, u32, Vec<FieldValue>)> = (0..10)
            .map(|i| ("m1", i as u32, at(i as f32 * 41.0, 0.0)))
            .collect();

        tanks.update(&game(&rows));
        tanks.capture(
            &Box2 {
                x: 200.0,
                y: 0.0,
                angle: 0.0,
                half_w: 250.0,
                half_h: 250.0,
            },
            1000.0,
        );

        assert_eq!(tanks.set().count_predicted(), MAX_PREDICTED_TANKS);
    }

    #[test]
    fn capture_seeds_state_from_the_authoritative_frame() {
        let mut tanks = remote_tanks();

        tanks.update(&game(&[("m1", 7, at(0.0, 0.0))]));
        tanks.begin_reconcile(&snapshot(&[(
            7,
            Some(tank_row(5.0, 5.0, 0.0, 10.0, -2.0, 0.3)),
        )]));
        tanks.finish_reconcile();
        tanks.capture(&tank_obb(-15.0, 5.0), 1000.0);

        let body = body(&tanks, "m1:7");

        assert_eq!(body.body.x, 5.0);
        assert_eq!(body.body.vx, 10.0);
        assert_eq!(body.body.angvel, 0.3);
    }

    #[test]
    fn capture_seeds_from_follow_before_the_first_frame() {
        let mut tanks = remote_tanks();

        tanks.update(&game(&[("m1", 7, at(0.0, 0.0))]));
        tanks.capture(&tank_obb(-15.0, 0.0), 1000.0);

        let body = body(&tanks, "m1:7");

        assert_eq!(body.body.x, 0.0);
        assert_eq!(body.body.vx, 0.0);
    }

    // — реконсиляция —

    #[test]
    fn reconcile_reads_velocities_of_known_tanks_only() {
        let mut tanks = remote_tanks();

        tanks.update(&game(&[("m1", 7, at(0.0, 0.0))]));
        tanks.capture(&tank_obb(-15.0, 0.0), 1000.0);
        tanks.begin_reconcile(&snapshot(&[
            (7, Some(tank_row(200.0, 0.0, 0.0, 40.0, -5.0, 1.5))),
            // танк вне множества (null-маркер) кадром не заводится
            (9, None),
        ]));

        let body = body(&tanks, "m1:7");

        assert_eq!(body.body.x, 200.0);
        assert_eq!(body.body.vx, 40.0);
        assert_eq!(body.body.angvel, 1.5);
        assert!(!tanks.set().bodies().contains_key("m1:9"));
    }

    // — экстраполяция —

    #[test]
    fn extrapolation_runs_without_damping() {
        let mut tanks = remote_tanks();

        tanks.update(&game(&[("m1", 7, at(0.0, 0.0))]));
        tanks.begin_reconcile(&snapshot(&[(
            7,
            Some(tank_row(0.0, 0.0, 0.0, 10.0, 0.0, 2.0)),
        )]));
        tanks.finish_reconcile();
        tanks.capture(&tank_obb(-15.0, 0.0), 1000.0);
        tanks.integrate_predicted(0.1);

        let body = body(&tanks, "m1:7");

        // демпфирование модели (linear 3, angular 100) съело бы и скорость,
        // и доворот — чужой танк тормозил бы на ровном месте
        assert_eq!(body.body.x, 1.0);
        assert_eq!(body.body.vx, 10.0);
        assert_eq!(body.body.angvel, 2.0);
    }

    // — рендер-строки —

    #[test]
    fn render_data_repeats_the_model_block_row() {
        let mut tanks = remote_tanks();

        tanks.update(&game(&[("m1", 7, tank_row(0.0, 0.0, 0.5, 0.0, 0.0, 0.0))]));
        tanks.begin_reconcile(&snapshot(&[(
            7,
            Some(tank_row(0.0, 0.0, 0.5, 3.0, -1.0, 0.7)),
        )]));
        tanks.finish_reconcile();
        tanks.capture(&tank_obb(-15.0, 0.0), 1000.0);

        let rows = tanks.render_data();

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].key_id, 1);
        assert_eq!(rows[0].id, 7);
        assert_eq!(
            rows[0].fields,
            vec![0.0, 0.0, 0.5, 0.0, 3.0, -1.0, 0.0, 3.0, 10.0, 1.0, 0.7]
        );
    }

    #[test]
    fn render_data_is_empty_without_predicted_tanks() {
        let mut tanks = remote_tanks();

        tanks.update(&game(&[("m1", 7, at(0.0, 0.0))]));

        assert!(tanks.render_data().is_empty());
    }

    #[test]
    fn render_data_keeps_models_apart() {
        let mut tanks = remote_tanks();

        tanks.update(&game(&[("m1", 7, at(0.0, 0.0)), ("m2", 7, at(100.0, 0.0))]));
        tanks.capture(
            &Box2 {
                x: 50.0,
                y: 0.0,
                angle: 0.0,
                half_w: 250.0,
                half_h: 250.0,
            },
            1000.0,
        );

        let rows = tanks.render_data();
        let mut key_ids: Vec<u8> = rows.iter().map(|row| row.key_id).collect();

        key_ids.sort_unstable();

        assert_eq!(key_ids, vec![1, 6]);
        assert!(rows.iter().all(|row| row.id == 7));
    }

    // — цели raycast выстрела —

    #[test]
    fn sim_boxes_are_authoritative_and_keyed_by_game_id() {
        let mut tanks = remote_tanks();

        // нарисован в (0, 0), авторитетно уже проехал 60 юнитов вправо
        tanks.update(&game(&[("m1", 7, at(0.0, 0.0))]));
        tanks.begin_reconcile(&snapshot(&[(
            7,
            Some(tank_row(60.0, 0.0, 0.0, 600.0, 0.0, 0.0)),
        )]));

        let boxes = tanks.sim_boxes();

        assert_eq!(boxes.len(), 1);
        assert_eq!(boxes[0].0, 7);
        // корпус там, где танк у хоста, а не там, где он нарисован
        assert_eq!(boxes[0].1.x, 60.0);
        assert_eq!((boxes[0].1.half_w, boxes[0].1.half_h), (20.0, 15.0));
    }

    #[test]
    fn to_render_point_moves_a_sim_point_onto_the_drawn_hull() {
        let mut tanks = remote_tanks();

        tanks.update(&game(&[("m1", 7, at(0.0, 0.0))]));
        tanks.begin_reconcile(&snapshot(&[(
            7,
            Some(tank_row(60.0, 0.0, 0.0, 600.0, 0.0, 0.0)),
        )]));

        // левая грань авторитетного корпуса (центр 60, halfW 20) → та же
        // материальная точка нарисованного корпуса (центр 0)
        let point = tanks.to_render_point(7, 40.0, 0.0).unwrap();

        assert!((point[0] + 20.0).abs() < 1e-3);
        assert!(point[1].abs() < 1e-3);
    }

    #[test]
    fn to_render_point_of_unknown_tank_is_none() {
        let mut tanks = remote_tanks();

        tanks.update(&game(&[("m1", 7, at(0.0, 0.0))]));

        assert!(tanks.to_render_point(9, 0.0, 0.0).is_none());
    }

    // — сброс —

    #[test]
    fn reset_clears_every_body() {
        let mut tanks = remote_tanks();

        tanks.update(&game(&[("m1", 7, at(0.0, 0.0))]));
        tanks.capture(&tank_obb(-15.0, 0.0), 1000.0);
        tanks.reset();

        assert!(tanks.set().bodies().is_empty());
        assert!(tanks.render_data().is_empty());

        // после сброса тело заводится заново как follow
        tanks.update(&game(&[("m1", 7, at(1.0, 1.0))]));

        assert_eq!(body(&tanks, "m1:7").mode, Mode::Follow);
    }
}
