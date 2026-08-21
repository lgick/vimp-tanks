//! Динамика карты как предсказанное множество — порт
//! `src/client/MapDynamics.js` (срез tank-battle 2026-08). Единый источник
//! геометрии ящиков карты И их предиктор: механика режимов
//! (`Follow`/`Predicted`, реконсиляция, сглаживание ошибки) — общая, в
//! [`super::predicted_set`]; здесь своё — геометрия из MAP_DATA, чтение
//! блока `cN`, правило захвата и ДВА взгляда на бокс.
//!
//! Охват намеренно узкий: тела, не связанные со своим танком, остаются
//! в `Follow`. Иначе ящик, который толкает ЧУЖОЙ танк, опережал бы его
//! спрайт — со стороны это выглядит как толчок на расстоянии.
//!
//! Боксы хранятся как ЦЕНТР, тогда как в снапшоте `c1`/`c2` `[x, y, angle]` —
//! это «угол объекта» (позиция тела Rapier, см. `map::GameMap::create_dynamic`);
//! перевод — `box_center_from_origin`, обратный — [`origin_from_box_center`].
//! У геометрии два вида, и потребитель обязан брать свой:
//!   [`MapDynamics::render_box`] / [`MapDynamics::to_world`] — РЕНДЕРНЫЙ бокс
//!     (состояние плюс сглаживающая ошибка): где ящик нарисован. Для спрайтов
//!     и эффектов (JS-часть игры через WASM-границу);
//!   [`MapDynamics::sim_box`] / [`MapDynamics::sim_boxes`] /
//!     [`MapDynamics::to_local`] — СИМУЛЯЦИОННЫЙ бокс: где ящик у хоста. Для
//!     raycast'а выстрела — по той же причине, по которой выстрел строится из
//!     предсказанного состояния своего танка, а не из рендерного: иначе
//!     локальное попадание расходится с серверным.
//!
//! Геометрию задаёт только [`MapDynamics::set_map`] (MAP_DATA), заменяя её
//! целиком. Метода сброса здесь намеренно нет: CLEAR чистит полотно, а не
//! карту, и приходит в том числе на старте раунда БЕЗ последующей MAP_DATA.
//! Сброс по CLEAR стирал бы боксы навсегда — `update` обновляет только уже
//! известные ключи, — и танк с трассером переставал бы видеть динамику карты
//! после первого же раунда.

use std::any::Any;
use std::collections::HashMap;

use vimp_engine_core::client::collision::{box_center_from_origin, obb_vs_obb};
use vimp_engine_core::client::game::PredictedRow;
use vimp_engine_core::client::interpolator::InterpolatedGame;
use vimp_engine_core::client::raycast::Box2;
use vimp_engine_core::client::rigid_body::{MAP_SURFACE, box_mass_properties};
use vimp_engine_core::client::unpack::{BlockData, DecodedSnapshot};
use vimp_engine_core::config::{FieldValue, SnapshotConfig};
use vimp_engine_core::physics::deg_to_rad;

use super::ClientMapConfig;
use super::predicted_set::{
    CAPTURE_MARGIN, PredictedBodies, PredictedBody, PredictedSet, ServerState, Transform,
    inflate_tank,
};

// потолок предсказанного множества: транзитивный захват в стене canopy
// (20 ящиков) иначе втянул бы её целиком
const MAX_PREDICTED_BODIES: usize = 12;

// индексы полей строки cN (x, y, angle, vx, vy, angvel) — позиционный
// контракт со схемой снапшота игры (src/config/snapshot.js)
const FIELD_X: usize = 0;
const FIELD_Y: usize = 1;
const FIELD_ANGLE: usize = 2;
const FIELD_VX: usize = 3;
const FIELD_VY: usize = 4;
const FIELD_ANGVEL: usize = 5;

/// «Угол объекта» из центра бокса — обратный перевод
/// `box_center_from_origin`.
pub fn origin_from_box_center(x: f32, y: f32, angle: f32, half_w: f32, half_h: f32) -> [f32; 2] {
    let (sin, cos) = angle.sin_cos();

    [
        x - (cos * half_w - sin * half_h),
        y - (sin * half_w + cos * half_h),
    ]
}

fn field_f32(fields: &[FieldValue], i: usize) -> f32 {
    match fields.get(i) {
        Some(FieldValue::F32(v)) => *v,
        _ => 0.0,
    }
}

/// Ключ тела в множестве: индекс объекта в `physicsDynamic` — та же форма,
/// в которой динамику именует рендер игры (`d0`, `d1`, ...).
fn body_key(index: usize) -> String {
    format!("d{index}")
}

/// Предсказанная динамика карты.
pub struct MapDynamics {
    set: PredictedSet,
    // индекс объекта в physicsDynamic по ключу тела: render_data обязан
    // отдавать id строки, а не позицию тела в множестве — совпадать они
    // перестанут, как только из множества исчезнет хоть одно тело
    indices: HashMap<String, u32>,
    // реестр ключей снапшота: по setId карты берётся id блока для рендер-строк
    snapshot: SnapshotConfig,
    // ключ блока динамики текущей карты (c1/c2) и его id в схеме
    set_id: Option<String>,
    set_key_id: Option<u8>,
}

impl MapDynamics {
    pub fn new(snapshot: &SnapshotConfig) -> Self {
        Self {
            set: PredictedSet::new(MAX_PREDICTED_BODIES),
            indices: HashMap::new(),
            snapshot: snapshot.clone(),
            set_id: None,
            set_key_id: None,
        }
    }

    /// Данные карты (MAP_DATA): геометрия, масс-инерционные свойства и
    /// стартовые трансформы динамики. Заменяет геометрию целиком.
    pub(crate) fn set_map(&mut self, cfg: &ClientMapConfig) {
        let scale = cfg.scale;

        self.set.bodies_mut().clear();
        self.indices.clear();
        self.set_id = cfg.set_id.clone();
        self.set_key_id = self
            .set_id
            .as_ref()
            .and_then(|key| self.snapshot.keys.get(key))
            .map(|schema| schema.id);

        for (index, item) in cfg.physics_dynamic.iter().enumerate() {
            let width = item.width * scale;
            let height = item.height * scale;
            let half_w = width / 2.0;
            let half_h = height / 2.0;
            let angle = deg_to_rad(item.angle);
            let center = box_center_from_origin(
                item.position[0] * scale,
                item.position[1] * scale,
                angle,
                half_w,
                half_h,
            );

            let mut body = PredictedBody::new(Transform {
                x: center[0],
                y: center[1],
                angle,
            });

            body.half_w = half_w;
            body.half_h = half_h;

            // масса и момент инерции прямоугольника (как у Rapier на хосте)
            let mass = box_mass_properties(width, height, item.density);

            body.body.inv_mass = mass.inv_mass;
            body.body.inv_inertia = mass.inv_inertia;
            body.body.linear_damping = item.linear_damping;
            body.body.angular_damping = item.angular_damping;
            // поверхность ящика; в контакте комбинируется правилом среднего
            body.surface = MAP_SURFACE;

            let key = body_key(index);

            self.indices.insert(key.clone(), index as u32);
            self.set.bodies_mut().insert(key, body);
        }
    }

    /// РЕНДЕРНЫЙ бокс тела (состояние плюс сглаживающая ошибка): где ящик
    /// нарисован. `None` — ключ неизвестен.
    pub fn render_box(&self, key: &str) -> Option<Box2> {
        self.set.bodies().get(key).map(render_obb)
    }

    /// СИМУЛЯЦИОННЫЙ бокс тела: где ящик «сейчас» у хоста.
    pub fn sim_box(&self, key: &str) -> Option<Box2> {
        self.set.bodies().get(key).map(sim_obb)
    }

    /// Все симуляционные боксы (raycast выстрела идёт по всей динамике).
    pub fn sim_boxes(&self) -> Vec<(&str, Box2)> {
        self.set
            .bodies()
            .iter()
            .map(|(key, body)| (key.as_str(), sim_obb(body)))
            .collect()
    }

    /// Переводит мировую точку СИМУЛЯЦИИ в локальный (неповёрнутый) фрейм
    /// ящика — для привязки эффекта попадания к телу. Фрейм именно
    /// симуляционный: точка приходит из raycast'а по [`Self::sim_boxes`], а
    /// материальная точка ящика в обоих фреймах имеет одни и те же
    /// локальные координаты.
    pub fn to_local(&self, key: &str, world_x: f32, world_y: f32) -> Option<[f32; 2]> {
        let obb = self.sim_box(key)?;
        let (sin, cos) = (-obb.angle).sin_cos();
        let rel_x = world_x - obb.x;
        let rel_y = world_y - obb.y;

        Some([cos * rel_x - sin * rel_y, sin * rel_x + cos * rel_y])
    }

    /// Обратный [`Self::to_local`]: локальная точка тела → мировая в
    /// РЕНДЕРНОМ фрейме. Тем и полезен, что фреймы разные: конец трассера
    /// считается по симуляции, а рисуется там, где ящик виден.
    pub fn to_world(&self, key: &str, local_x: f32, local_y: f32) -> Option<[f32; 2]> {
        let obb = self.render_box(key)?;
        let (sin, cos) = obb.angle.sin_cos();

        Some([
            obb.x + cos * local_x - sin * local_y,
            obb.y + sin * local_x + cos * local_y,
        ])
    }

    // обход строк блока динамики СВОЕЙ карты: ключи dN индексные, и блок
    // чужого конструктора карт (другой setId) увёл бы тела текущей карты
    // в чужие координаты
    fn block_key(&self) -> Option<&str> {
        self.set_id.as_deref()
    }
}

impl PredictedBodies for MapDynamics {
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
    fn update(&mut self, game: &InterpolatedGame) {
        let Some(rows) = self.block_key().and_then(|key| game.blocks.get(key)) else {
            return;
        };

        for row in rows {
            let key = body_key(row.id as usize);
            let Some(body) = self.set.bodies_mut().get_mut(&key) else {
                continue;
            };

            let angle = field_f32(&row.fields, FIELD_ANGLE);
            let center = box_center_from_origin(
                field_f32(&row.fields, FIELD_X),
                field_f32(&row.fields, FIELD_Y),
                angle,
                body.half_w,
                body.half_h,
            );

            body.follow = Transform {
                x: center[0],
                y: center[1],
                angle,
            };

            if !body.is_predicted() {
                body.body.x = center[0];
                body.body.y = center[1];
                body.body.angle = angle;
            }
        }
    }

    /// Авторитетное состояние тел из сырого кадра (реконсиляция).
    fn snapshot_bodies(&self, snapshot: &DecodedSnapshot) -> Vec<(String, ServerState)> {
        let Some(BlockData::IndexedNoNull8(items)) =
            self.block_key().and_then(|key| snapshot.block_by_key(key))
        else {
            return Vec::new();
        };

        let mut entries = Vec::new();

        for (index, fields) in items {
            let key = body_key(*index as usize);
            let Some(body) = self.set.bodies().get(&key) else {
                continue;
            };

            let angle = field_f32(fields, FIELD_ANGLE);
            let center = box_center_from_origin(
                field_f32(fields, FIELD_X),
                field_f32(fields, FIELD_Y),
                angle,
                body.half_w,
                body.half_h,
            );

            entries.push((
                key,
                ServerState {
                    x: center[0],
                    y: center[1],
                    angle,
                    vx: field_f32(fields, FIELD_VX),
                    vy: field_f32(fields, FIELD_VY),
                    angvel: field_f32(fields, FIELD_ANGVEL),
                },
            ));
        }

        entries
    }

    /// Переводит в `Predicted` тела, связанные со своим танком: прямой
    /// контакт плюс транзитивно соседи по контакту (стопка ящиков едет
    /// как целое).
    fn capture(&mut self, tank: &Box2, local_now: f64) {
        let inflated = inflate_tank(tank);
        let max = self.set.max_predicted();
        let mut predicted: Vec<usize> = self
            .set
            .bodies()
            .values()
            .enumerate()
            .filter(|(_, body)| body.is_predicted())
            .map(|(index, _)| index)
            .collect();

        // прямой контакт с раздутым OBB своего танка
        let seeds: Vec<usize> = self
            .set
            .bodies()
            .values()
            .enumerate()
            .filter(|(_, body)| {
                !body.is_predicted() && obb_vs_obb(&inflated, &body.obb(0.0)).is_some()
            })
            .map(|(index, _)| index)
            .collect();

        for index in seeds {
            if predicted.len() >= max {
                break;
            }

            self.promote_at(index, local_now);
            predicted.push(index);
        }

        // транзитивное замыкание: соседи предсказанных тоже предсказываются
        let mut grown = true;

        while grown && predicted.len() < max {
            grown = false;

            for index in 0..self.set.bodies().len() {
                if predicted.len() >= max {
                    break;
                }

                let bodies = self.set.bodies();
                let body = &bodies[index];

                if body.is_predicted() {
                    continue;
                }

                let obb = body.obb(CAPTURE_MARGIN);
                let touches = predicted
                    .iter()
                    .any(|other| obb_vs_obb(&obb, &bodies[*other].obb(0.0)).is_some());

                if touches {
                    self.promote_at(index, local_now);
                    predicted.push(index);
                    grown = true;
                }
            }
        }
    }

    /// Строки предсказанных тел в соглашении «угол объекта» — ровно то, что
    /// ждёт рендер динамики карты (блок `cN` hot-буфера). Скорости строки
    /// движок дополняет нулями: рендеру они не нужны.
    fn render_data(&self) -> Vec<PredictedRow> {
        let Some(key_id) = self.set_key_id else {
            return Vec::new();
        };

        self.set
            .bodies()
            .iter()
            .filter(|(_, body)| body.is_predicted())
            .filter_map(|(key, body)| {
                // тело без записи в indices пропускается: подставленный ноль
                // перекрыл бы чужую строку (d0) — ровно тот тихий отказ,
                // ради которого id и перестал браться из позиции в множестве
                let id = *self.indices.get(key)?;
                debug_assert_eq!(*key, body_key(id as usize));

                let render = body.render_transform();
                let origin = origin_from_box_center(
                    render.x,
                    render.y,
                    render.angle,
                    body.half_w,
                    body.half_h,
                );

                Some(PredictedRow {
                    key_id,
                    id,
                    fields: vec![origin[0], origin[1], render.angle],
                })
            })
            .collect()
    }
}

impl MapDynamics {
    // перевод тела в предсказание по его позиции в множестве
    fn promote_at(&mut self, index: usize, local_now: f64) {
        if let Some((_, body)) = self.set.bodies_mut().get_index_mut(index) {
            body.promote(local_now);
        }
    }
}

// OBB тела в том виде, в каком его видит хост «сейчас»:
//   predicted — своё состояние, оно и есть «сейчас» (ошибка косметическая);
//   follow — последний авторитетный кадр, а НЕ интерполированный трансформ:
//     тот отстаёт на interpolation.delay, и по едущему ящику луч ушёл бы
//     мимо. Остаток расхождения ограничен интервалом снапшота.
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

// OBB тела в том виде, в каком оно нарисовано (со сглаживающей ошибкой)
fn render_obb(body: &PredictedBody) -> Box2 {
    let render = body.render_transform();

    Box2 {
        x: render.x,
        y: render.y,
        angle: render.angle,
        half_w: body.half_w,
        half_h: body.half_h,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use indexmap::IndexMap;
    use vimp_engine_core::client::interpolator::InterpolatedRow;
    use vimp_engine_core::client::unpack::DecodedBlock;
    use vimp_engine_core::config::BlockSchema;

    use crate::client::predicted_set::Mode;

    // блок динамики c1 (id 5) — как в схеме снапшота игры
    fn snapshot_config() -> SnapshotConfig {
        let schema: BlockSchema = serde_json::from_value(serde_json::json!({
            "id": 5,
            "kind": "indexedNoNull8",
            "class": "hot",
            "optionalFrom": 3,
            "fields": [
                { "name": "x", "ty": "f32", "interp": "lerp" },
                { "name": "y", "ty": "f32", "interp": "lerp" },
                { "name": "angle", "ty": "f32", "interp": "lerpAngle" },
                { "name": "vx", "ty": "f32", "interp": "lerp" },
                { "name": "vy", "ty": "f32", "interp": "lerp" },
                { "name": "angvel", "ty": "f32", "interp": "lerp" }
            ]
        }))
        .unwrap();
        let mut keys = IndexMap::new();

        keys.insert("c1".to_string(), schema);

        SnapshotConfig {
            version: 5,
            port: 5,
            keys,
        }
    }

    fn map_config(objects: serde_json::Value, scale: f32) -> ClientMapConfig {
        serde_json::from_value(serde_json::json!({
            "step": 32,
            "scale": scale,
            "setId": "c1",
            "map": [[0]],
            "physicsStatic": [1],
            "physicsDynamic": objects,
        }))
        .unwrap()
    }

    // один ящик: угол объекта (100, 0), 0°, width 40/height 20 (мир, после
    // scale) → halfW 20, halfH 10 → центр (120, 10)
    fn setup(scale: f32) -> MapDynamics {
        let mut dynamics = MapDynamics::new(&snapshot_config());

        dynamics.set_map(&map_config(
            serde_json::json!([
                { "position": [100.0, 0.0], "angle": 0.0, "width": 40.0, "height": 20.0,
                  "density": 1.0 }
            ]),
            scale,
        ));

        dynamics
    }

    // ряд одинаковых ящиков вплотную, начиная с угла объекта (0, 0)
    fn setup_row(count: usize, size: f32) -> MapDynamics {
        let objects: Vec<serde_json::Value> = (0..count)
            .map(|i| {
                serde_json::json!({
                    "position": [i as f32 * size, 0.0], "angle": 0.0,
                    "width": size, "height": size, "density": 1.0
                })
            })
            .collect();
        let mut dynamics = MapDynamics::new(&snapshot_config());

        dynamics.set_map(&map_config(serde_json::Value::Array(objects), 1.0));

        dynamics
    }

    // OBB танка (центр), которым проверяется захват тел в предсказание
    fn tank_obb(x: f32, y: f32) -> Box2 {
        Box2 {
            x,
            y,
            angle: 0.0,
            half_w: 4.0,
            half_h: 3.0,
        }
    }

    // интерполированный сэмпл блока динамики: ключ → строки [x, y, angle]
    fn game(key: &str, rows: &[(u32, [f32; 3])]) -> InterpolatedGame {
        let mut blocks = IndexMap::new();

        blocks.insert(
            key.to_string(),
            rows.iter()
                .map(|(id, values)| InterpolatedRow {
                    id: *id,
                    fields: values.iter().map(|v| FieldValue::F32(*v)).collect(),
                })
                .collect(),
        );

        InterpolatedGame { blocks }
    }

    // сырой кадр блока динамики: строка полной ширины (кадр отдаёт
    // отсутствующий хвост скоростей нулями, см. client/unpack.rs)
    fn snapshot(key: &str, rows: &[(u8, [f32; 6])]) -> DecodedSnapshot {
        let mut items = IndexMap::new();

        for (index, values) in rows {
            items.insert(*index, values.iter().map(|v| FieldValue::F32(*v)).collect());
        }

        DecodedSnapshot {
            blocks: vec![DecodedBlock {
                key: key.to_string(),
                key_id: 5,
                data: BlockData::IndexedNoNull8(items),
            }],
        }
    }

    fn body<'a>(dynamics: &'a MapDynamics, key: &str) -> &'a PredictedBody {
        &dynamics.set().bodies()[key]
    }

    fn body_mut<'a>(dynamics: &'a mut MapDynamics, key: &str) -> &'a mut PredictedBody {
        dynamics.set_mut().bodies_mut().get_mut(key).unwrap()
    }

    // — геометрия из MAP_DATA («угол объекта» → центр) —

    #[test]
    fn set_map_builds_boxes_around_center_not_origin() {
        let obb = setup(1.0).render_box("d0").unwrap();

        assert_eq!((obb.x, obb.y, obb.angle), (120.0, 10.0, 0.0));
        assert_eq!((obb.half_w, obb.half_h), (20.0, 10.0));
    }

    #[test]
    fn set_map_applies_map_scale() {
        // угол мира: (200, 0); halfW 40, halfH 20 → центр (240, 20)
        let obb = setup(2.0).render_box("d0").unwrap();

        assert_eq!((obb.x, obb.y), (240.0, 20.0));
        assert_eq!((obb.half_w, obb.half_h), (40.0, 20.0));
    }

    #[test]
    fn unknown_key_has_no_box() {
        assert!(setup(1.0).render_box("d1").is_none());
    }

    #[test]
    fn set_map_replaces_geometry_completely() {
        let mut dynamics = setup(1.0);

        dynamics.set_map(&map_config(serde_json::json!([]), 1.0));

        assert!(dynamics.render_box("d0").is_none());
        assert!(dynamics.sim_boxes().is_empty());
    }

    #[test]
    fn mass_properties_come_from_density_and_scaled_size() {
        // 40×20 × scale 2 → 80×40, density 1
        let dynamics = setup(2.0);
        let body = body(&dynamics, "d0");
        let mass = 1.0 * 80.0 * 40.0;
        let inertia = (mass * (80.0 * 80.0 + 40.0 * 40.0)) / 12.0;

        assert!((1.0 / body.body.inv_mass - mass).abs() < 1e-3);
        assert!((1.0 / body.body.inv_inertia - inertia).abs() < 1.0);
        assert_eq!(body.mode, Mode::Follow);
    }

    #[test]
    fn damping_comes_from_map_with_rapier_angular_default() {
        let mut dynamics = MapDynamics::new(&snapshot_config());

        dynamics.set_map(&map_config(
            serde_json::json!([
                { "position": [0.0, 0.0], "angle": 0.0, "width": 10.0, "height": 10.0,
                  "density": 1.0, "linearDamping": 5.0 }
            ]),
            1.0,
        ));

        let body = body(&dynamics, "d0");

        assert_eq!(body.body.linear_damping, 5.0);
        assert_eq!(body.body.angular_damping, 0.01);
    }

    // — чтение блока cN —

    #[test]
    fn update_moves_body_keeping_geometry() {
        let mut dynamics = setup(1.0);

        dynamics.update(&game(
            "c1",
            &[(0, [500.0, 50.0, std::f32::consts::FRAC_PI_2])],
        ));

        let obb = dynamics.render_box("d0").unwrap();

        // угол (500, 50) + поворот (20, 10) на 90° = (490, 70)
        assert!((obb.x - 490.0).abs() < 1e-3);
        assert!((obb.y - 70.0).abs() < 1e-3);
        assert_eq!((obb.half_w, obb.half_h), (20.0, 10.0));
    }

    #[test]
    fn update_ignores_foreign_map_block() {
        let mut dynamics = setup(1.0);

        dynamics.update(&game("c2", &[(0, [999.0, 999.0, 0.0])]));

        assert_eq!(dynamics.render_box("d0").unwrap().x, 120.0);
    }

    #[test]
    fn update_ignores_unknown_rows() {
        let mut dynamics = setup(1.0);

        dynamics.update(&game("c1", &[(9, [1.0, 2.0, 3.0])]));

        assert!(dynamics.render_box("d9").is_none());
    }

    // регресс: CLEAR чистит полотно, а не карту, и приходит в том числе на
    // старте раунда без MAP_DATA следом — геометрию стирать некому
    #[test]
    fn geometry_lives_until_next_map_data() {
        let mut dynamics = setup(1.0);

        dynamics.update(&game("c1", &[(0, [300.0, 0.0, 0.0])]));

        assert_eq!(dynamics.render_box("d0").unwrap().x, 320.0);
    }

    // — захват в предсказание —

    #[test]
    fn capture_promotes_touching_body() {
        let mut dynamics = setup(1.0);

        dynamics.capture(&tank_obb(96.0, 10.0), 1000.0);

        assert_eq!(body(&dynamics, "d0").mode, Mode::Predicted);
    }

    #[test]
    fn capture_leaves_distant_body_in_follow() {
        let mut dynamics = setup(1.0);

        dynamics.capture(&tank_obb(0.0, 0.0), 1000.0);

        assert_eq!(body(&dynamics, "d0").mode, Mode::Follow);
    }

    #[test]
    fn capture_margin_promotes_before_actual_touch() {
        let mut dynamics = setup(1.0);

        // правый край танка — 99, левая грань ящика — 100: зазор 1 юнит,
        // касания нет, но CAPTURE_MARGIN (2) его перекрывает
        dynamics.capture(&tank_obb(95.0, 10.0), 1000.0);

        assert_eq!(body(&dynamics, "d0").mode, Mode::Predicted);
    }

    #[test]
    fn capture_closes_over_neighbours() {
        let mut dynamics = setup_row(3, 20.0);

        // танк касается только первого ящика ряда
        dynamics.capture(&tank_obb(-3.0, 10.0), 1000.0);

        assert_eq!(dynamics.set().count_predicted(), 3);
    }

    #[test]
    fn capture_stops_at_max_predicted_bodies() {
        // стена из 20 ящиков вплотную — транзитивный захват втянул бы всю
        let mut dynamics = setup_row(20, 20.0);

        dynamics.capture(&tank_obb(-3.0, 10.0), 1000.0);

        assert_eq!(dynamics.set().count_predicted(), MAX_PREDICTED_BODIES);
    }

    #[test]
    fn capture_of_moving_body_keeps_sprite_in_place() {
        let mut dynamics = setup(1.0);

        dynamics.update(&game("c1", &[(0, [100.0, 0.0, 0.0])]));
        // авторитетный кадр впереди интерполяции
        dynamics.begin_reconcile(&snapshot("c1", &[(0, [110.0, 0.0, 0.0, 40.0, 0.0, 0.0])]));
        dynamics.finish_reconcile();

        let before = dynamics.render_box("d0").unwrap();

        dynamics.capture(&tank_obb(96.0, 10.0), 1000.0);

        let after = dynamics.render_box("d0").unwrap();

        // состояние — авторитетное, а нарисовано тело там же, где было
        assert!((body(&dynamics, "d0").body.x - 130.0).abs() < 1e-3);
        assert!((after.x - before.x).abs() < 1e-3);
        assert!((after.y - before.y).abs() < 1e-3);
    }

    // — реконсиляция —

    #[test]
    fn snapshot_bodies_convert_origin_and_read_velocities() {
        let dynamics = setup(1.0);
        let entries =
            dynamics.snapshot_bodies(&snapshot("c1", &[(0, [200.0, 0.0, 0.0, 40.0, -5.0, 1.5])]));

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].0, "d0");
        assert!((entries[0].1.x - 220.0).abs() < 1e-3); // угол → центр
        assert_eq!((entries[0].1.vx, entries[0].1.vy), (40.0, -5.0));
        assert_eq!(entries[0].1.angvel, 1.5);
    }

    #[test]
    fn snapshot_bodies_ignore_foreign_and_unknown_rows() {
        let dynamics = setup(1.0);

        assert!(
            dynamics
                .snapshot_bodies(&snapshot("c2", &[(0, [200.0, 0.0, 0.0, 0.0, 0.0, 0.0])]))
                .is_empty()
        );
        assert!(
            dynamics
                .snapshot_bodies(&snapshot("c1", &[(9, [200.0, 0.0, 0.0, 0.0, 0.0, 0.0])]))
                .is_empty()
        );
    }

    #[test]
    fn reconcile_keeps_divergence_in_error() {
        let mut dynamics = setup(1.0);

        dynamics.capture(&tank_obb(96.0, 10.0), 1000.0);
        dynamics.begin_reconcile(&snapshot("c1", &[(0, [100.0, 0.0, 0.0, 0.0, 0.0, 0.0])]));

        // «replay» сдвинул тело на 3 юнита
        body_mut(&mut dynamics, "d0").body.x += 3.0;
        dynamics.finish_reconcile();

        assert!((body(&dynamics, "d0").error.x + 3.0).abs() < 1e-3);
    }

    // — симуляция, рендер и возврат в интерполяцию —

    #[test]
    fn update_leads_follow_of_predicted_body_without_touching_state() {
        let mut dynamics = setup(1.0);

        dynamics.capture(&tank_obb(96.0, 10.0), 1000.0);

        let before = body(&dynamics, "d0").body.x;

        dynamics.update(&game("c1", &[(0, [500.0, 0.0, 0.0])]));

        assert_eq!(body(&dynamics, "d0").body.x, before);
        assert!((body(&dynamics, "d0").follow.x - 520.0).abs() < 1e-3);
    }

    #[test]
    fn body_returns_to_interpolation_after_hold() {
        let mut dynamics = setup(1.0);

        dynamics.capture(&tank_obb(96.0, 10.0), 1000.0);
        dynamics.update(&game("c1", &[(0, [100.0, 0.0, 0.0])]));

        dynamics.demote_idle(1200.0); // 200 мс < PREDICTION_HOLD_MS

        assert_eq!(body(&dynamics, "d0").mode, Mode::Predicted);

        dynamics.demote_idle(1400.0);

        assert_eq!(body(&dynamics, "d0").mode, Mode::Follow);
    }

    #[test]
    fn release_predicted_clears_render_rows() {
        let mut dynamics = setup(1.0);

        dynamics.capture(&tank_obb(96.0, 10.0), 1000.0);
        dynamics.update(&game("c1", &[(0, [300.0, 0.0, 0.0])]));
        dynamics.release_predicted();

        assert_eq!(body(&dynamics, "d0").mode, Mode::Follow);
        assert!((dynamics.render_box("d0").unwrap().x - 320.0).abs() < 1e-3);
        assert!(dynamics.render_data().is_empty());
    }

    #[test]
    fn render_data_returns_origin_not_center() {
        let mut dynamics = setup(1.0);

        dynamics.capture(&tank_obb(96.0, 10.0), 1000.0);
        dynamics.begin_reconcile(&snapshot("c1", &[(0, [300.0, 40.0, 0.0, 0.0, 0.0, 0.0])]));

        let rows = dynamics.render_data();

        // обратный перевод центра в «угол объекта» возвращает исходные числа
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0].key_id, rows[0].id), (5, 0));
        assert!((rows[0].fields[0] - 300.0).abs() < 1e-3);
        assert!((rows[0].fields[1] - 40.0).abs() < 1e-3);
    }

    #[test]
    fn render_data_accounts_for_rotation_and_error() {
        let mut dynamics = setup(1.0);

        dynamics.capture(&tank_obb(96.0, 10.0), 1000.0);
        dynamics.begin_reconcile(&snapshot(
            "c1",
            &[(0, [300.0, 40.0, std::f32::consts::FRAC_PI_2, 0.0, 0.0, 0.0])],
        ));
        body_mut(&mut dynamics, "d0").error = Transform {
            x: 5.0,
            y: 0.0,
            angle: 0.0,
        };

        let rows = dynamics.render_data();

        assert!((rows[0].fields[0] - 305.0).abs() < 1e-3);
        assert!((rows[0].fields[1] - 40.0).abs() < 1e-3);
    }

    // дыра в множестве: id строки — индекс объекта карты, а не позиция тела
    #[test]
    fn render_data_ids_survive_a_hole_in_the_set() {
        let mut dynamics = MapDynamics::new(&snapshot_config());

        dynamics.set_map(&map_config(
            serde_json::json!([
                { "position": [0.0, 0.0], "angle": 0.0, "width": 20.0, "height": 20.0,
                  "density": 1.0 },
                { "position": [200.0, 0.0], "angle": 0.0, "width": 20.0, "height": 20.0,
                  "density": 1.0 },
                { "position": [400.0, 0.0], "angle": 0.0, "width": 20.0, "height": 20.0,
                  "density": 1.0 }
            ]),
            1.0,
        ));

        // среднее тело исчезло из множества: позиции d0 и d2 стали 0 и 1
        dynamics.set_mut().bodies_mut().shift_remove("d1");

        for key in ["d0", "d2"] {
            body_mut(&mut dynamics, key).promote(1000.0);
        }

        let rows = dynamics.render_data();
        let ids: Vec<u32> = rows.iter().map(|row| row.id).collect();

        assert_eq!(ids, vec![0, 2]);
    }

    // тело, которого нет в indices, пропускается: подставленный ноль
    // перекрыл бы строку d0 (см. filter_map в render_data)
    #[test]
    fn render_data_skips_a_body_without_an_index() {
        let mut dynamics = MapDynamics::new(&snapshot_config());

        dynamics.set_map(&map_config(
            serde_json::json!([
                { "position": [0.0, 0.0], "angle": 0.0, "width": 20.0, "height": 20.0,
                  "density": 1.0 },
                { "position": [200.0, 0.0], "angle": 0.0, "width": 20.0, "height": 20.0,
                  "density": 1.0 }
            ]),
            1.0,
        ));

        // запись индекса пропала (рассинхрон реестра с множеством)
        dynamics.indices.remove("d1");

        for key in ["d0", "d1"] {
            body_mut(&mut dynamics, key).promote(1000.0);
        }

        let ids: Vec<u32> = dynamics.render_data().iter().map(|row| row.id).collect();

        assert_eq!(ids, vec![0]);
    }

    #[test]
    fn render_data_skips_follow_bodies() {
        let mut dynamics = MapDynamics::new(&snapshot_config());

        dynamics.set_map(&map_config(
            serde_json::json!([
                { "position": [0.0, 0.0], "angle": 0.0, "width": 20.0, "height": 20.0,
                  "density": 1.0 },
                { "position": [500.0, 0.0], "angle": 0.0, "width": 20.0, "height": 20.0,
                  "density": 1.0 }
            ]),
            1.0,
        ));
        dynamics.capture(&tank_obb(-3.0, 10.0), 1000.0);

        let rows = dynamics.render_data();

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, 0);
    }

    // — два взгляда на бокс —

    #[test]
    fn sim_box_of_follow_body_is_authoritative_not_interpolated() {
        let mut dynamics = setup(1.0);

        dynamics.begin_reconcile(&snapshot("c1", &[(0, [300.0, 0.0, 0.0, 50.0, 0.0, 0.0])]));
        dynamics.update(&game("c1", &[(0, [100.0, 0.0, 0.0])]));

        assert!((dynamics.sim_box("d0").unwrap().x - 320.0).abs() < 1e-3);
        // нарисован там, где отстаёт интерполяция
        assert!((dynamics.render_box("d0").unwrap().x - 120.0).abs() < 1e-3);
    }

    #[test]
    fn sim_box_without_server_frame_falls_back_to_interpolation() {
        let mut dynamics = setup(1.0);

        dynamics.update(&game("c1", &[(0, [500.0, 0.0, 0.0])]));

        assert!((dynamics.sim_box("d0").unwrap().x - 520.0).abs() < 1e-3);
    }

    #[test]
    fn render_and_sim_boxes_differ_exactly_by_smoothing_error() {
        let mut dynamics = setup(1.0);

        dynamics.capture(&tank_obb(96.0, 10.0), 1000.0);
        body_mut(&mut dynamics, "d0").error = Transform {
            x: 7.0,
            y: -2.0,
            angle: 0.0,
        };

        let sim = dynamics.sim_box("d0").unwrap();
        let render = dynamics.render_box("d0").unwrap();

        assert!((sim.x - 120.0).abs() < 1e-3);
        assert!((render.x - sim.x - 7.0).abs() < 1e-3);
        assert!((render.y - sim.y + 2.0).abs() < 1e-3);
    }

    #[test]
    fn to_local_uses_sim_frame_and_to_world_the_render_one() {
        let mut dynamics = setup(1.0);

        dynamics.begin_reconcile(&snapshot("c1", &[(0, [300.0, 0.0, 0.0, 50.0, 0.0, 0.0])]));
        dynamics.update(&game("c1", &[(0, [100.0, 0.0, 0.0])]));

        // левая грань авторитетного бокса (центр 320, halfW 20)
        let local = dynamics.to_local("d0", 300.0, 10.0).unwrap();

        assert!((local[0] + 20.0).abs() < 1e-3);
        assert!(local[1].abs() < 1e-3);

        // та же материальная точка на нарисованном (отстающем) ящике
        let world = dynamics.to_world("d0", local[0], local[1]).unwrap();

        assert!((world[0] - 100.0).abs() < 1e-3);
        assert!((world[1] - 10.0).abs() < 1e-3);
    }

    #[test]
    fn to_local_accounts_for_rotation() {
        let mut dynamics = setup(1.0);

        dynamics.update(&game(
            "c1",
            &[(0, [100.0, 0.0, std::f32::consts::FRAC_PI_2])],
        ));

        let obb = dynamics.render_box("d0").unwrap();
        // мировая точка на +X от центра; при повороте бокса на 90° это
        // соответствует локальной −Y (to_local вращает на −angle)
        let local = dynamics.to_local("d0", obb.x + 20.0, obb.y).unwrap();

        assert!(local[0].abs() < 1e-3);
        assert!((local[1] + 20.0).abs() < 1e-3);
    }

    #[test]
    fn unknown_key_has_no_frames() {
        let dynamics = setup(1.0);

        assert!(dynamics.to_local("d9", 0.0, 0.0).is_none());
        assert!(dynamics.to_world("d9", 0.0, 0.0).is_none());
    }

    // без setId рендерить нечего: строку некуда положить
    #[test]
    fn render_data_is_empty_without_set_id() {
        let mut dynamics = MapDynamics::new(&snapshot_config());
        let mut cfg = map_config(
            serde_json::json!([
                { "position": [0.0, 0.0], "angle": 0.0, "width": 20.0, "height": 20.0,
                  "density": 1.0 }
            ]),
            1.0,
        );

        cfg.set_id = None;
        dynamics.set_map(&cfg);
        dynamics.capture(&tank_obb(-3.0, 10.0), 1000.0);

        assert!(dynamics.render_data().is_empty());
    }
}
