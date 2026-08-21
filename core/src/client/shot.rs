//! Клиентский визуальный спавн снарядов своего танка — порт
//! src/client/ShotPredictor.js (срез 2.6): при нажатии fire трассер (w1)
//! и бомба (w2) появляются немедленно, не дожидаясь подтверждения хостом
//! (delay + RTT). Физика/урон/взрыв (w2e) — авторитетные (ядро хоста).
//!
//! try_fire() реплицирует авторитетный гейт (кулдаун/патроны, формулы
//! muzzle/direction из Tank::muzzle_position/fire_direction) и возвращает
//! данные в формате снапшота для обычного parse-конвейера; конечная точка
//! трассера — приближённый raycast по стенам карты, динамике и танкам.
//! filter_frame_game() подавляет авторитетные дубли своих выстрелов
//! (хост помечает события id автора: tracers[7], bombs[5]).

use std::collections::VecDeque;

use indexmap::IndexMap;
use serde_json::{Map, Value, json};

use crate::config::{ModelConfig, WeaponConfig, WeaponKind};
use vimp_engine_core::client::interpolator::InterpolatedGame;
use vimp_engine_core::client::raycast::{Box2, ray_vs_box, ray_vs_grid};
use vimp_engine_core::client::unpack::{BlockData, DecodedSnapshot};
use vimp_engine_core::config::FieldValue;
use vimp_engine_core::rng::Rng;

// индексы полей строки m1 (x, y, angle, gunRotation, vx, vy, engineLoad,
// condition, size, teamId) — позиционный контракт со схемой opcodes.js.
const TANK_FIELD_X: usize = 0;
const TANK_FIELD_Y: usize = 1;
const TANK_FIELD_ANGLE: usize = 2;
const TANK_FIELD_SIZE: usize = 8;

fn field_f32(fields: &[FieldValue], i: usize) -> f32 {
    match fields[i] {
        FieldValue::F32(v) => v,
        _ => 0.0,
    }
}

fn field_u8(fields: &[FieldValue], i: usize) -> u8 {
    match fields[i] {
        FieldValue::U8(v) => v,
        _ => 0,
    }
}

use super::map_dynamics::MapDynamics;
use super::predictor::RenderState;
use super::remote_tanks::RemoteTanks;
use super::{ClientMapConfig, Grid};

// максимальный возраст неподтверждённого локального выстрела (мс);
// старше — хост выстрел отклонил, запись не должна съедать чужие дубли
const PENDING_MAX_AGE: f64 = 2000.0;

// максимальный возраст алиаса своей бомбы (мс). Алиас снимается по null
// детонации; этот срок — только страховка от утечки, если null потерялся,
// поэтому он с запасом больше любого разумного weapon.time.
const BOMB_ALIAS_MAX_AGE: f64 = 60_000.0;

struct TankTarget {
    x: f32,
    y: f32,
    angle: f32,
    size: f32,
}

/// Геометрия предсказанного мира для raycast трассера: подсистемы живут
/// в предикторе (`MapDynamics`, `RemoteTanks`), а не в `ShotPredictor`, и
/// приходят сюда на время выстрела.
#[derive(Clone, Copy, Default)]
pub struct ShotWorld<'a> {
    pub dynamics: Option<&'a MapDynamics>,
    pub remote_tanks: Option<&'a RemoteTanks>,
}

// что луч встретил ближе всего: стену, ящик динамики карты или чужой танк
enum RayTarget {
    Wall,
    Dynamic(String),
    Tank(u32),
}

struct PendingShot {
    time: f64,
    weapon: String,
}

struct PendingBomb {
    time: f64,
    weapon: String,
    local_id: String,
}

// подтверждённая своя бомба: локальный id, под которым она живёт на
// полотне, и время подтверждения (страховка от утечки алиаса по возрасту)
struct BombAlias {
    local_id: String,
    time: f64,
}

pub struct ShotPredictor {
    weapons: IndexMap<String, WeaponConfig>,
    models: IndexMap<String, ModelConfig>,
    model: Option<ModelConfig>,
    current_weapon: Option<String>,

    // локальные кулдауны: имя оружия → localTime готовности
    cooldown_until: IndexMap<String, f64>,

    // патроны из панели: имя оружия → количество (нет ключа = неизвестно)
    ammo: IndexMap<String, f64>,

    // мир для raycast трассера (динамика карты и чужие танки — в подсистемах
    // предиктора, они приходят в try_fire отдельно, см. ShotWorld)
    grid: Option<Grid>,
    tanks: IndexMap<u32, TankTarget>,

    // неподтверждённые локальные выстрелы
    pending_tracers: VecDeque<PendingShot>,
    pending_bombs: VecDeque<PendingBomb>,
    expired_local_bombs: Vec<(String, String)>, // (localId, weapon)

    // подтверждённые свои бомбы: авторитетный id → (локальный id, время
    // подтверждения). Сущность на полотне живёт под локальным id от спавна
    // до детонации — иначе её пришлось бы удалить и создать заново, что
    // рвёт одноразовый звук и перезапускает таймер.
    bomb_aliases: IndexMap<String, BombAlias>,
    local_bomb_seq: u32,

    rng: Rng,
}

impl ShotPredictor {
    pub fn new(
        models: &IndexMap<String, ModelConfig>,
        weapons: &IndexMap<String, WeaponConfig>,
        seed: u64,
    ) -> Self {
        Self {
            weapons: weapons.clone(),
            models: models.clone(),
            model: None,
            current_weapon: None,
            cooldown_until: IndexMap::new(),
            ammo: IndexMap::new(),
            grid: None,
            tanks: IndexMap::new(),
            pending_tracers: VecDeque::new(),
            pending_bombs: VecDeque::new(),
            expired_local_bombs: Vec::new(),
            bomb_aliases: IndexMap::new(),
            local_bomb_seq: 0,
            rng: Rng::new(seed),
        }
    }

    /// Модель танка пользователя (известна при авторизации).
    pub fn set_model(&mut self, model_name: &str) {
        self.model = self.models.get(model_name).cloned();
        self.current_weapon = self.model.as_ref().map(|m| m.current_weapon.clone());
    }

    /// Данные карты (MAP_DATA): сетка стен для raycast трассера; мировые
    /// координаты = тайлы × step × scale. Геометрию динамики карты держит
    /// `MapDynamics` — общий источник со своим танком.
    pub fn set_map(&mut self, map_json: &str) -> Result<(), String> {
        let cfg: ClientMapConfig = serde_json::from_str(map_json).map_err(|e| e.to_string())?;

        self.grid = Some(Grid {
            map: cfg.map,
            solid_tiles: cfg.physics_static,
            tile_size: cfg.step * cfg.scale,
        });

        self.reset();
        Ok(())
    }

    /// Обновляет позиции танков-целей raycast из дискретного кадра;
    /// динамику карты ведёт `MapDynamics`.
    pub fn update_world(&mut self, snapshot: &DecodedSnapshot) {
        for block in &snapshot.blocks {
            match &block.data {
                BlockData::Indexed8(items) => {
                    for (id, row) in items {
                        match row {
                            None => {
                                self.tanks.shift_remove(&(*id as u32));
                            }
                            Some(row) => {
                                self.tanks.insert(
                                    *id as u32,
                                    TankTarget {
                                        x: field_f32(row, TANK_FIELD_X),
                                        y: field_f32(row, TANK_FIELD_Y),
                                        angle: field_f32(row, TANK_FIELD_ANGLE),
                                        size: field_u8(row, TANK_FIELD_SIZE) as f32,
                                    },
                                );
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }

    /// Обновляет позиции танков-целей raycast из интерполированного сэмпла.
    /// Ключ блока — имя модели (`models`-реестр этой структуры), та же
    /// конвенция, что у `ClientState::set_model` (см. `client/mod.rs`);
    /// блок динамики карты читает `MapDynamics`.
    pub fn update_world_interpolated(&mut self, game: &InterpolatedGame) {
        for (key, rows) in &game.blocks {
            if !self.models.contains_key(key) {
                continue;
            }

            for row in rows {
                self.tanks.insert(
                    row.id,
                    TankTarget {
                        x: field_f32(&row.fields, TANK_FIELD_X),
                        y: field_f32(&row.fields, TANK_FIELD_Y),
                        angle: field_f32(&row.fields, TANK_FIELD_ANGLE),
                        size: field_u8(&row.fields, TANK_FIELD_SIZE) as f32,
                    },
                );
            }
        }
    }

    /// Синхронизация с панелью (порт PANEL_DATA): патроны и активное оружие.
    pub fn sync_panel(&mut self, items: &[String]) {
        for item in items {
            let mut parts = item.splitn(2, ':');
            let code = parts.next().unwrap_or("");
            let value = parts.next();

            if code == "wa" {
                if let Some(value) = value
                    && self.weapons.contains_key(value)
                {
                    self.current_weapon = Some(value.to_string());
                }
            } else if self.weapons.contains_key(code) {
                match value.and_then(|v| v.parse::<f64>().ok()) {
                    Some(v) => {
                        self.ammo.insert(code.to_string(), v);
                    }
                    None => {
                        self.ammo.shift_remove(code);
                    }
                }
            }
        }
    }

    /// Локальная реплика смены оружия (Tank::turn_weapon);
    /// авторитетное подтверждение придёт панелью ('wa').
    pub fn cycle_weapon(&mut self, back: bool) {
        let Some(current) = &self.current_weapon else {
            return;
        };

        let len = self.weapons.len() as isize;
        let mut key =
            self.weapons.get_index_of(current).unwrap_or(0) as isize + if back { -1 } else { 1 };

        if key < 0 {
            key = len - 1;
        } else if key >= len {
            key = 0;
        }

        self.current_weapon = self
            .weapons
            .get_index(key as usize)
            .map(|(name, _)| name.clone());
    }

    /// Локальный выстрел: гейт (кулдаун/патроны) + данные для рендера
    /// в формате снапшота ({ w1: [...] } или { w2: {...} }). `world` —
    /// предсказанная геометрия для луча (см. [`ShotWorld`]).
    pub fn try_fire(
        &mut self,
        render: &RenderState,
        my_game_id: u32,
        local_now: f64,
        world: ShotWorld<'_>,
    ) -> Option<Value> {
        let weapon_name = self.current_weapon.clone()?;
        let weapon = self.weapons.get(&weapon_name)?.clone();

        self.model.as_ref()?;

        // кулдаун (fireRate в секундах)
        if local_now
            < self
                .cooldown_until
                .get(&weapon_name)
                .copied()
                .unwrap_or(0.0)
        {
            return None;
        }

        // патроны: неизвестное количество не блокирует (хост авторитетен)
        let consumption = weapon.consumption.unwrap_or(1.0);

        if let Some(ammo) = self.ammo.get(&weapon_name).copied() {
            if ammo < consumption {
                return None;
            }

            self.ammo.insert(weapon_name.clone(), ammo - consumption);
        }

        self.cooldown_until.insert(
            weapon_name.clone(),
            local_now + weapon.fire_rate as f64 * 1000.0,
        );

        match weapon.kind {
            WeaponKind::Hitscan => {
                let tracer = self.build_tracer(&weapon, render, my_game_id, world);

                self.pending_tracers.push_back(PendingShot {
                    time: local_now,
                    weapon: weapon_name.clone(),
                });

                Some(json!({ weapon_name: [tracer] }))
            }
            WeaponKind::Explosive => {
                // следующий выстрел — только после подтверждения предыдущего
                if self.pending_bombs.iter().any(|p| p.weapon == weapon_name) {
                    return None;
                }

                self.local_bomb_seq += 1;

                // 'L' не встречается в base36-ключах хоста (строчные символы)
                let local_id = format!("L{}", self.local_bomb_seq);

                self.pending_bombs.push_back(PendingBomb {
                    time: local_now,
                    weapon: weapon_name.clone(),
                    local_id: local_id.clone(),
                });

                // бомба ложится ровно в предсказанную позицию танка:
                // экстраполировать её вперёд нечем — клиент своей латентности
                // не знает, а расхождение с хостом закрывает авторитетная
                // коррекция при подтверждении (см. filter_frame_game)
                Some(json!({
                    weapon_name: {
                        local_id: [render.x, render.y, 0, weapon.size, weapon.time, my_game_id],
                    },
                }))
            }
        }
    }

    /// Подавляет авторитетные дубли своих выстрелов в JSON-форме кадра
    /// (мутирует game на месте; вызывается до сериализации кадра).
    pub fn filter_frame_game(
        &mut self,
        game: &mut Map<String, Value>,
        my_game_id: Option<u32>,
        local_now: f64,
    ) {
        self.trim_pending(local_now);

        // инъекция null для бомб, чьи pending истекли без подтверждения
        for (local_id, weapon) in std::mem::take(&mut self.expired_local_bombs) {
            match game.get_mut(&weapon) {
                Some(Value::Object(bombs)) => {
                    bombs.insert(local_id, Value::Null);
                }
                _ => {
                    game.insert(weapon, json!({ local_id: null }));
                }
            }
        }

        let Some(my_id) = my_game_id else {
            return;
        };

        let weapon_names: Vec<String> = self.weapons.keys().cloned().collect();

        for weapon_name in weapon_names {
            let kind = self.weapons[&weapon_name].kind;

            match (kind, game.get_mut(&weapon_name)) {
                // трассеры: свой дубль гасит самую старую pending-запись (FIFO)
                (WeaponKind::Hitscan, Some(Value::Array(tracers))) => {
                    tracers.retain(|tracer| {
                        let is_mine = tracer
                            .get(7)
                            .and_then(Value::as_u64)
                            .is_some_and(|id| id == my_id as u64);

                        if is_mine
                            && let Some(index) = self
                                .pending_tracers
                                .iter()
                                .position(|p| p.weapon == weapon_name)
                        {
                            self.pending_tracers.remove(index);

                            return false;
                        }

                        true
                    });
                }
                // бомбы: при первом подтверждении своей — локальная L<n>
                // заменяется авторитетной сущностью; null взрыва проходит
                (WeaponKind::Explosive, Some(Value::Object(bombs))) => {
                    let confirmed: Vec<String> = bombs
                        .iter()
                        .filter(|(_, data)| {
                            data.get(5)
                                .and_then(Value::as_u64)
                                .is_some_and(|id| id == my_id as u64)
                        })
                        .map(|(id, _)| id.clone())
                        .collect();

                    for auth_id in confirmed {
                        let Some(index) = self
                            .pending_bombs
                            .iter()
                            .position(|p| p.weapon == weapon_name)
                        else {
                            continue;
                        };

                        let pending = self.pending_bombs.remove(index).unwrap();

                        // строка не выбрасывается, а остаётся в кадре под
                        // зарегистрированным алиасом: проход ниже переименует
                        // её в локальный id, и она одноразово поправит позицию
                        // на авторитетную (parse уйдёт в update, а не в create
                        // — таймер и одноразовый звук не рвутся)
                        self.bomb_aliases.insert(
                            auth_id,
                            BombAlias {
                                local_id: pending.local_id,
                                time: local_now,
                            },
                        );
                    }

                    // всё остальное под известным алиасом (в первую очередь
                    // null детонации) переименовывается в локальный id
                    let aliased: Vec<String> = bombs
                        .keys()
                        .filter(|id| self.bomb_aliases.contains_key(*id))
                        .cloned()
                        .collect();

                    for auth_id in aliased {
                        let value = bombs.remove(&auth_id).unwrap();
                        let local_id = self.bomb_aliases[&auth_id].local_id.clone();

                        if value.is_null() {
                            self.bomb_aliases.shift_remove(&auth_id);
                        }

                        bombs.insert(local_id, value);
                    }
                }
                _ => {}
            }
        }
    }

    /// Сброс режима игрок/наблюдатель: локальные ставки на выстрелы
    /// аннулируются, но подтверждённые бомбы продолжают жить под своими
    /// локальными id — их снимет авторитетный null детонации, который
    /// приходит позже keyset (state идёт через буфер интерполяции).
    pub fn reset_local(&mut self) {
        self.pending_tracers.clear();
        self.drain_pending_bombs_to_expired();
        self.cooldown_until.clear();
        self.ammo.clear();
        self.tanks.clear();
        self.current_weapon = self.model.as_ref().map(|m| m.current_weapon.clone());
    }

    /// Полный сброс (смена карты/clear): мира больше нет.
    pub fn reset(&mut self) {
        self.reset_local();
        self.bomb_aliases.clear();
        // после CLEAR полотно чистится целиком — доставлять null некому
        self.expired_local_bombs.clear();
    }

    // хоронит неподтверждённые локальные бомбы: null по локальному id
    // инжектится в ближайший кадр, иначе спрайт останется на полотне
    fn drain_pending_bombs_to_expired(&mut self) {
        for pending in std::mem::take(&mut self.pending_bombs) {
            self.expired_local_bombs
                .push((pending.local_id, pending.weapon));
        }
    }

    // собирает данные трассера: реплика формул Tank::muzzle_position/
    // fire_direction + приближённый raycast вместо world.cast_ray
    fn build_tracer(
        &mut self,
        weapon: &WeaponConfig,
        render: &RenderState,
        shooter: u32,
        world: ShotWorld<'_>,
    ) -> Value {
        let model = self.model.as_ref().unwrap();
        let total_angle = render.angle + render.gun_rotation;

        // дуло: смещение width·0.55 от центра (width = size·4, как Tank)
        let width = model.size * 4.0;
        let (sin, cos) = total_angle.sin_cos();
        let muzzle = [render.x + cos * width * 0.55, render.y + sin * width * 0.55];

        let mut direction = [cos, sin];

        if weapon.spread > 0.0 {
            let spread = self.rng.range(-weapon.spread, weapon.spread);
            let (s_sin, s_cos) = spread.sin_cos();

            direction = [
                s_cos * direction[0] - s_sin * direction[1],
                s_sin * direction[0] + s_cos * direction[1],
            ];
        }

        let len = direction[0].hypot(direction[1]);

        if len > 0.0 {
            direction = [direction[0] / len, direction[1] / len];
        }

        let range = weapon.range.unwrap_or(1000.0);
        let hit = self.cast_ray(muzzle, direction, range, shooter, world);
        let end_distance = hit.as_ref().map_or(range, |(distance, _)| *distance);
        let mut end_x = muzzle[0] + direction[0] * end_distance;
        let mut end_y = muzzle[1] + direction[1] * end_distance;

        // якорь попадания в динамику карты (девятый элемент строки, только
        // у своего локально предсказанного трассера — в кадр он не уходит):
        // по нему потребитель привязывает облако осколков к трансформу
        // задетого ящика, а не к мировой точке
        let mut anchor = None;

        if let Some((_, RayTarget::Dynamic(key))) = &hit
            && let Some(dynamics) = world.dynamics
            && let Some(local) = dynamics.to_local(key, end_x, end_y)
        {
            anchor = Some(json!([key, local[0], local[1]]));

            // луч шёл по симуляционной геометрии, а ящик нарисован в другом
            // фрейме (сглаживание/интерполяция) — конец трассера переносится
            // в ту же материальную точку нарисованного ящика, иначе на едущем
            // ящике он обрывался бы в воздухе
            if let Some(drawn) = dynamics.to_world(key, local[0], local[1]) {
                end_x = drawn[0];
                end_y = drawn[1];
            }
        }

        // попадание в чужой танк переносится так же: луч посчитан по корпусу
        // «сейчас», а нарисован танк там, где был serverNow − delay
        if let Some((_, RayTarget::Tank(game_id))) = &hit
            && let Some(tanks) = world.remote_tanks
            && let Some(drawn) = tanks.to_render_point(*game_id, end_x, end_y)
        {
            end_x = drawn[0];
            end_y = drawn[1];
        }

        let mut tracer = json!([
            muzzle[0],
            muzzle[1],
            end_x,
            end_y,
            render.x,
            render.y,
            hit.is_some(),
            shooter,
        ]);

        if let Some(anchor) = anchor
            && let Some(row) = tracer.as_array_mut()
        {
            row.push(anchor);
        }

        tracer
    }

    // ближайшее пересечение со стенами, динамикой карты и танками (кроме
    // своего); None = промах в пределах range
    fn cast_ray(
        &self,
        origin: [f32; 2],
        dir: [f32; 2],
        range: f32,
        my_id: u32,
        world: ShotWorld<'_>,
    ) -> Option<(f32, RayTarget)> {
        let mut closest: Option<(f32, RayTarget)> = None;

        let mut consider = |distance: Option<f32>, target: RayTarget| {
            if let Some(distance) = distance
                && closest
                    .as_ref()
                    .is_none_or(|(nearest, _)| distance < *nearest)
            {
                closest = Some((distance, target));
            }
        };

        if let Some(grid) = &self.grid {
            consider(
                ray_vs_grid(
                    origin,
                    dir,
                    range,
                    &grid.map,
                    &grid.solid_tiles,
                    grid.tile_size,
                ),
                RayTarget::Wall,
            );
        }

        // симуляционные, а не рендерные боксы: попадание должно совпасть
        // с авторитетным, а не с картинкой (см. map_dynamics.rs)
        if let Some(dynamics) = world.dynamics {
            for (key, obb) in dynamics.sim_boxes() {
                consider(
                    ray_vs_box(origin, dir, range, &obb),
                    RayTarget::Dynamic(key.to_string()),
                );
            }
        }

        // корпуса «сейчас», как их видит хост; интерполированные отстают на
        // interpolation.delay, и по едущему танку луч ушёл бы мимо — та же
        // причина, по которой динамика карты идёт через sim_boxes
        let sim_tanks = world
            .remote_tanks
            .map(|tanks| tanks.sim_boxes())
            .unwrap_or_default();

        for (id, tank) in &self.tanks {
            if *id == my_id {
                continue;
            }

            // габариты танка: width = size·4, height = size·3 (как Tank)
            let obb = sim_tanks
                .iter()
                .find(|(sim_id, _)| sim_id == id)
                .map(|(_, obb)| *obb)
                .unwrap_or(Box2 {
                    x: tank.x,
                    y: tank.y,
                    angle: tank.angle,
                    half_w: tank.size * 2.0,
                    half_h: tank.size * 1.5,
                });

            consider(ray_vs_box(origin, dir, range, &obb), RayTarget::Tank(*id));
        }

        closest
    }

    // отбрасывает протухшие неподтверждённые выстрелы
    fn trim_pending(&mut self, local_now: f64) {
        let min_time = local_now - PENDING_MAX_AGE;

        while self
            .pending_tracers
            .front()
            .is_some_and(|p| p.time < min_time)
        {
            self.pending_tracers.pop_front();
        }

        // истёкшие бомбы собираются в очередь на null-инъекцию (очистка холста)
        while self
            .pending_bombs
            .front()
            .is_some_and(|p| p.time < min_time)
        {
            let expired = self.pending_bombs.pop_front().unwrap();

            self.expired_local_bombs
                .push((expired.local_id, expired.weapon));
        }

        // страховка от утечки, если null детонации потерялся
        let alias_min_time = local_now - BOMB_ALIAS_MAX_AGE;

        self.bomb_aliases
            .retain(|_, alias| alias.time >= alias_min_time);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::client::predicted_set::PredictedBodies;

    // модель size 2 (width 8)
    fn models() -> IndexMap<String, ModelConfig> {
        serde_json::from_value(serde_json::json!({
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
        }))
        .unwrap()
    }

    // модель + hitscan w1 и explosive w2
    fn make_shot() -> ShotPredictor {
        let weapons: IndexMap<String, WeaponConfig> = serde_json::from_value(serde_json::json!({
            "w1": {
                "type": "hitscan",
                "range": 100,
                "fireRate": 0.5,
                "spread": 0,
                "consumption": 1
            },
            "w2": {
                "type": "explosive",
                "time": 300,
                "size": 8,
                "fireRate": 0.1
            }
        }))
        .unwrap();

        let mut shot = ShotPredictor::new(&models(), &weapons, 42);

        shot.set_model("m1");
        shot
    }

    fn render_at(x: f32, y: f32) -> RenderState {
        RenderState {
            x,
            y,
            angle: 0.0,
            gun_rotation: 0.0,
            vx: 0.0,
            vy: 0.0,
            engine_load: 0.0,
            angvel: 0.0,
        }
    }

    fn tracer_of(value: &Value) -> &Vec<Value> {
        value["w1"].as_array().unwrap()[0].as_array().unwrap()
    }

    #[test]
    fn fire_without_model_is_blocked() {
        let models = IndexMap::new();
        let weapons: IndexMap<String, WeaponConfig> = serde_json::from_value(
            serde_json::json!({ "w1": { "type": "hitscan", "fireRate": 0.5 } }),
        )
        .unwrap();
        let mut shot = ShotPredictor::new(&models, &weapons, 42);

        assert!(
            shot.try_fire(&render_at(0.0, 0.0), 1, 0.0, ShotWorld::default())
                .is_none()
        );
    }

    #[test]
    fn cooldown_blocks_next_shot() {
        let mut shot = make_shot();

        assert!(
            shot.try_fire(&render_at(0.0, 0.0), 1, 0.0, ShotWorld::default())
                .is_some()
        );
        // fireRate 0.5 c → до 500 мс выстрел заблокирован
        assert!(
            shot.try_fire(&render_at(0.0, 0.0), 1, 400.0, ShotWorld::default())
                .is_none()
        );
        assert!(
            shot.try_fire(&render_at(0.0, 0.0), 1, 500.0, ShotWorld::default())
                .is_some()
        );
    }

    #[test]
    fn ammo_gates_and_decrements() {
        let mut shot = make_shot();

        // неизвестный боезапас не блокирует (хост авторитетен)
        assert!(
            shot.try_fire(&render_at(0.0, 0.0), 1, 0.0, ShotWorld::default())
                .is_some()
        );

        shot.sync_panel(&["w1:1".to_string()]);
        assert!(
            shot.try_fire(&render_at(0.0, 0.0), 1, 1000.0, ShotWorld::default())
                .is_some()
        );
        // патроны списаны локально: 1 − 1 = 0
        assert!(
            shot.try_fire(&render_at(0.0, 0.0), 1, 2000.0, ShotWorld::default())
                .is_none()
        );
    }

    #[test]
    fn tracer_muzzle_formula_and_miss() {
        let mut shot = make_shot();
        let spawn = shot
            .try_fire(&render_at(10.0, 20.0), 2, 0.0, ShotWorld::default())
            .unwrap();
        let tracer = tracer_of(&spawn);

        // дуло: x + width·0.55 (width = size·4 = 8) при angle 0
        assert!((tracer[0].as_f64().unwrap() - 14.4).abs() < 1e-3);
        assert!((tracer[1].as_f64().unwrap() - 20.0).abs() < 1e-3);
        // промах: конец на дистанции range
        assert!((tracer[2].as_f64().unwrap() - 114.4).abs() < 1e-3);
        assert_eq!(tracer[6], Value::Bool(false));
        assert_eq!(tracer[7].as_u64(), Some(2));
        // центр танка для визуализации
        assert_eq!(tracer[4].as_f64(), Some(10.0));
        assert_eq!(tracer[5].as_f64(), Some(20.0));
    }

    #[test]
    fn tracer_clips_on_wall() {
        let mut shot = make_shot();
        let mut grid = vec![vec![0; 10]; 3];

        for row in &mut grid {
            row[5] = 1; // стена на x = 50–60
        }

        shot.set_map(
            &serde_json::json!({
                "step": 10,
                "scale": 1,
                "map": grid,
                "physicsStatic": [1],
                "physicsDynamic": []
            })
            .to_string(),
        )
        .unwrap();

        let spawn = shot
            .try_fire(&render_at(0.0, 15.0), 1, 0.0, ShotWorld::default())
            .unwrap();
        let tracer = tracer_of(&spawn);

        assert_eq!(tracer[6], Value::Bool(true));
        assert!((tracer[2].as_f64().unwrap() - 50.0).abs() < 1e-3);
    }

    #[test]
    fn tracer_hits_tank_but_not_own() {
        use vimp_engine_core::client::unpack::{BlockData, DecodedBlock, DecodedSnapshot};

        fn row(x: f32, team: u8) -> Vec<FieldValue> {
            vec![
                FieldValue::F32(x),
                FieldValue::F32(0.0),
                FieldValue::F32(0.0),
                FieldValue::F32(0.0),
                FieldValue::F32(0.0),
                FieldValue::F32(0.0),
                FieldValue::F32(0.0),
                FieldValue::U8(3),
                FieldValue::U8(2),
                FieldValue::U8(team),
            ]
        }

        let mut shot = make_shot();
        let mut items = IndexMap::new();

        // свой танк (id 1) на пути луча — игнорируется; чужой (id 2) — цель
        items.insert(1u8, Some(row(30.0, 1)));
        items.insert(2u8, Some(row(60.0, 2)));

        shot.update_world(&DecodedSnapshot {
            blocks: vec![DecodedBlock {
                key: "m1".to_string(),
                key_id: 1,
                data: BlockData::Indexed8(items),
            }],
        });

        let spawn = shot
            .try_fire(&render_at(0.0, 0.0), 1, 0.0, ShotWorld::default())
            .unwrap();
        let tracer = tracer_of(&spawn);

        // чужой танк: центр 60, halfW = size·2 = 4 → грань на 56
        assert_eq!(tracer[6], Value::Bool(true));
        assert!((tracer[2].as_f64().unwrap() - 56.0).abs() < 1e-3);
    }

    // — предсказанный мир в луче (динамика карты и чужие танки) —

    // блок динамики c1 и блок модели m1 — как в схеме снапшота игры
    fn snapshot_config() -> vimp_engine_core::config::SnapshotConfig {
        use vimp_engine_core::config::{BlockSchema, SnapshotConfig};

        let dynamics: BlockSchema = serde_json::from_value(serde_json::json!({
            "id": 5, "kind": "indexedNoNull8", "class": "hot", "optionalFrom": 3,
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
        let model: BlockSchema = serde_json::from_value(serde_json::json!({
            "id": 1, "kind": "indexed8", "class": "hot",
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
        .unwrap();
        let mut keys = IndexMap::new();

        keys.insert("c1".to_string(), dynamics);
        keys.insert("m1".to_string(), model);

        SnapshotConfig {
            version: 5,
            port: 5,
            keys,
        }
    }

    // один ящик: угол объекта (x, y − 10), 20×20 → halfW/halfH 10
    fn dynamics_at(x: f32, y: f32) -> MapDynamics {
        let cfg: ClientMapConfig = serde_json::from_value(serde_json::json!({
            "step": 10, "scale": 1, "setId": "c1", "map": [[0]], "physicsStatic": [1],
            "physicsDynamic": [
                { "position": [x, y - 10.0], "angle": 0.0, "width": 20.0, "height": 20.0,
                  "density": 1.0 }
            ]
        }))
        .unwrap();
        let mut dynamics = MapDynamics::new(&snapshot_config());

        dynamics.set_map(&cfg);
        dynamics
    }

    // авторитетный кадр блока динамики: [x, y, angle, vx, vy, angvel]
    fn dynamics_snapshot(values: [f32; 6]) -> DecodedSnapshot {
        use vimp_engine_core::client::unpack::DecodedBlock;

        let mut items = IndexMap::new();

        items.insert(0u8, values.iter().map(|v| FieldValue::F32(*v)).collect());

        DecodedSnapshot {
            blocks: vec![DecodedBlock {
                key: "c1".to_string(),
                key_id: 5,
                data: BlockData::IndexedNoNull8(items),
            }],
        }
    }

    // интерполированный сэмпл блока динамики: [x, y, angle]
    fn dynamics_game(values: [f32; 3]) -> InterpolatedGame {
        use vimp_engine_core::client::interpolator::InterpolatedRow;

        let mut blocks = IndexMap::new();

        blocks.insert(
            "c1".to_string(),
            vec![InterpolatedRow {
                id: 0,
                fields: values.iter().map(|v| FieldValue::F32(*v)).collect(),
            }],
        );

        InterpolatedGame { blocks }
    }

    // строка чужого танка (size 10 → корпус 40×30, живой)
    fn tank_row(x: f32, y: f32) -> Vec<FieldValue> {
        vec![
            FieldValue::F32(x),
            FieldValue::F32(y),
            FieldValue::F32(0.0),
            FieldValue::F32(0.0),
            FieldValue::F32(0.0),
            FieldValue::F32(0.0),
            FieldValue::F32(0.0),
            FieldValue::U8(3),
            FieldValue::U8(10),
            FieldValue::U8(2),
            FieldValue::F32(0.0),
        ]
    }

    fn tanks_game(x: f32, y: f32) -> InterpolatedGame {
        use vimp_engine_core::client::interpolator::InterpolatedRow;

        let mut blocks = IndexMap::new();

        blocks.insert(
            "m1".to_string(),
            vec![InterpolatedRow {
                id: 2,
                fields: tank_row(x, y),
            }],
        );

        InterpolatedGame { blocks }
    }

    fn tanks_snapshot(x: f32, y: f32) -> DecodedSnapshot {
        use vimp_engine_core::client::unpack::DecodedBlock;

        let mut items = IndexMap::new();

        items.insert(2u8, Some(tank_row(x, y)));

        DecodedSnapshot {
            blocks: vec![DecodedBlock {
                key: "m1".to_string(),
                key_id: 1,
                data: BlockData::Indexed8(items),
            }],
        }
    }

    #[test]
    fn tracer_clips_on_map_dynamics_and_carries_the_anchor() {
        let mut shot = make_shot();
        // ящик по курсу: центр (60, 0), halfW 10 → левая грань на x = 50
        let dynamics = dynamics_at(50.0, 0.0);
        let world = ShotWorld {
            dynamics: Some(&dynamics),
            remote_tanks: None,
        };
        let spawn = shot.try_fire(&render_at(0.0, 0.0), 1, 0.0, world).unwrap();
        let tracer = tracer_of(&spawn);

        assert_eq!(tracer[6], Value::Bool(true));
        assert!((tracer[2].as_f64().unwrap() - 50.0).abs() < 1e-3);

        // девятый элемент — якорь: ключ тела и точка удара в его фрейме
        let anchor = tracer[8].as_array().unwrap();

        assert_eq!(anchor[0], Value::String("d0".to_string()));
        assert!((anchor[1].as_f64().unwrap() + 10.0).abs() < 1e-3);
        assert!(anchor[2].as_f64().unwrap().abs() < 1e-3);
    }

    #[test]
    fn tracer_casts_by_sim_geometry_and_ends_on_the_drawn_box() {
        let mut shot = make_shot();
        // нарисован далеко в стороне (центр (60, 1000)), а у хоста — на
        // линии огня (центр (60, 0)): по рендерному боксу луч промахнулся бы
        let mut dynamics = dynamics_at(50.0, 1000.0);

        dynamics.begin_reconcile(&dynamics_snapshot([50.0, -10.0, 0.0, 0.0, 0.0, 0.0]));
        dynamics.update(&dynamics_game([50.0, 990.0, 0.0]));

        let world = ShotWorld {
            dynamics: Some(&dynamics),
            remote_tanks: None,
        };
        let spawn = shot.try_fire(&render_at(0.0, 0.0), 1, 0.0, world).unwrap();
        let tracer = tracer_of(&spawn);

        assert_eq!(tracer[6], Value::Bool(true));
        // конец трассера — та же материальная точка НАРИСОВАННОГО ящика
        assert!((tracer[2].as_f64().unwrap() - 50.0).abs() < 1e-3);
        assert!((tracer[3].as_f64().unwrap() - 1000.0).abs() < 1e-3);
    }

    #[test]
    fn tracer_casts_by_sim_hull_of_a_remote_tank_and_ends_on_the_drawn_one() {
        let mut shot = make_shot();
        let mut tanks = RemoteTanks::new(&models(), &snapshot_config());

        // нарисован в (60, 20) — мимо луча (halfH 15), авторитетно в (60, 0)
        tanks.set_own_game_id(Some(1));
        tanks.update(&tanks_game(60.0, 20.0));
        tanks.begin_reconcile(&tanks_snapshot(60.0, 0.0));
        shot.update_world_interpolated(&tanks_game(60.0, 20.0));

        let world = ShotWorld {
            dynamics: None,
            remote_tanks: Some(&tanks),
        };
        let spawn = shot.try_fire(&render_at(0.0, 0.0), 1, 0.0, world).unwrap();
        let tracer = tracer_of(&spawn);

        // хост по своей геометрии попадает — попадает и клиент
        assert_eq!(tracer[6], Value::Bool(true));
        // точка удара перенесена на нарисованный корпус (левая грань)
        assert!((tracer[2].as_f64().unwrap() - 40.0).abs() < 1e-3);
        assert!((tracer[3].as_f64().unwrap() - 20.0).abs() < 1e-3);
        // якорь — только у динамики карты; в танк его нет
        assert_eq!(tracer.len(), 8);
    }

    #[test]
    fn without_remote_tanks_the_ray_follows_the_drawn_hull() {
        let mut shot = make_shot();

        shot.update_world_interpolated(&tanks_game(60.0, 20.0));

        let spawn = shot
            .try_fire(&render_at(0.0, 0.0), 1, 0.0, ShotWorld::default())
            .unwrap();

        // нарисованный корпус выше линии огня — промах
        assert_eq!(tracer_of(&spawn)[6], Value::Bool(false));
    }

    #[test]
    fn bomb_spawn_gate_and_no_extrapolation() {
        let mut shot = make_shot();

        shot.cycle_weapon(false); // w1 → w2

        let mut render = render_at(10.0, 0.0);

        // скорость на позицию спавна не влияет: клиент своей латентности не
        // знает, экстраполировать нечем
        render.vx = 100.0;

        let spawn = shot
            .try_fire(&render, 3, 0.0, ShotWorld::default())
            .unwrap();
        let bomb = &spawn["w2"]["L1"];

        assert!((bomb[0].as_f64().unwrap() - 10.0).abs() < 1e-3);
        assert!((bomb[1].as_f64().unwrap()).abs() < 1e-3);
        assert_eq!(bomb[3].as_f64(), Some(8.0)); // size
        assert_eq!(bomb[5].as_u64(), Some(3)); // ownerId

        // вторая бомба до подтверждения первой — заблокирована
        assert!(
            shot.try_fire(&render, 3, 1000.0, ShotWorld::default())
                .is_none()
        );
    }

    #[test]
    fn filter_suppresses_own_tracer_fifo() {
        let mut shot = make_shot();

        shot.try_fire(&render_at(0.0, 0.0), 2, 0.0, ShotWorld::default()); // pending w1

        let mut game = serde_json::json!({
            "w1": [
                [0, 0, 1, 1, 0, 0, false, 2], // свой дубль
                [9, 9, 5, 5, 9, 9, true, 3]   // чужой
            ]
        });
        let map = game.as_object_mut().unwrap();

        shot.filter_frame_game(map, Some(2), 100.0);

        let tracers = map["w1"].as_array().unwrap();

        assert_eq!(tracers.len(), 1);
        assert_eq!(tracers[0][7].as_u64(), Some(3));

        // pending исчерпан: следующий свой трассер проходит (не подавляется)
        let mut game = serde_json::json!({ "w1": [[0, 0, 1, 1, 0, 0, false, 2]] });

        shot.filter_frame_game(game.as_object_mut().unwrap(), Some(2), 200.0);
        assert_eq!(game["w1"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn filter_aliases_own_bomb_to_local_id() {
        let mut shot = make_shot();

        shot.cycle_weapon(false);
        shot.try_fire(&render_at(0.0, 0.0), 2, 0.0, ShotWorld::default()); // pending L1

        let mut game = serde_json::json!({
            "w2": { "a1": [5.0, 5.0, 0, 8, 300, 2] }
        });
        let map = game.as_object_mut().unwrap();

        shot.filter_frame_game(map, Some(2), 100.0);

        // сущность уже стоит под L1: авторитетная строка приезжает под этим
        // же именем (update, а не create) и одноразово поправляет позицию —
        // хост ставит бомбу там, где танк оказался к приходу команды
        assert!(map["w2"].get("a1").is_none());
        assert_eq!(map["w2"]["L1"][0].as_f64(), Some(5.0));
        assert_eq!(map["w2"]["L1"][1].as_f64(), Some(5.0));

        // гейт снят: следующая бомба разрешена
        assert!(
            shot.try_fire(&render_at(0.0, 0.0), 2, 1000.0, ShotWorld::default())
                .is_some()
        );
    }

    #[test]
    fn filter_renames_detonation_null_to_local_id() {
        let mut shot = make_shot();

        shot.cycle_weapon(false);
        shot.try_fire(&render_at(0.0, 0.0), 2, 0.0, ShotWorld::default());

        let mut game = serde_json::json!({ "w2": { "a1": [5.0, 5.0, 0, 8, 300, 2] } });

        shot.filter_frame_game(game.as_object_mut().unwrap(), Some(2), 100.0);

        // детонация приходит под авторитетным id — клиент должен получить её
        // под тем именем, под которым сущность живёт на полотне
        let mut game = serde_json::json!({ "w2": { "a1": null } });
        let map = game.as_object_mut().unwrap();

        shot.filter_frame_game(map, Some(2), 400.0);

        assert!(map["w2"].get("a1").is_none());
        assert!(map["w2"]["L1"].is_null());

        // алиас снят вместе с сущностью
        assert!(shot.bomb_aliases.is_empty());
    }

    #[test]
    fn bomb_alias_expires_by_age() {
        let mut shot = make_shot();

        shot.cycle_weapon(false);
        shot.try_fire(&render_at(0.0, 0.0), 2, 0.0, ShotWorld::default());

        let mut game = serde_json::json!({ "w2": { "a1": [5.0, 5.0, 0, 8, 300, 2] } });

        shot.filter_frame_game(game.as_object_mut().unwrap(), Some(2), 100.0);
        assert_eq!(shot.bomb_aliases.len(), 1);

        // null детонации потерялся — алиас не должен жить вечно
        let mut game = serde_json::json!({ "w2": {} });

        shot.filter_frame_game(
            game.as_object_mut().unwrap(),
            Some(2),
            100.0 + BOMB_ALIAS_MAX_AGE + 1.0,
        );

        assert!(shot.bomb_aliases.is_empty());
    }

    #[test]
    fn filter_passes_nulls_and_foreign_bombs() {
        let mut shot = make_shot();

        shot.cycle_weapon(false);
        shot.try_fire(&render_at(0.0, 0.0), 2, 0.0, ShotWorld::default());

        let mut game = serde_json::json!({
            "w2": { "b2": null, "c3": [1.0, 1.0, 0, 8, 300, 5] }
        });
        let map = game.as_object_mut().unwrap();

        shot.filter_frame_game(map, Some(2), 100.0);

        // null взрыва и чужая бомба проходят, pending не тронут
        assert!(map["w2"]["b2"].is_null());
        assert!(map["w2"]["c3"].is_array());
        assert!(
            shot.try_fire(&render_at(0.0, 0.0), 2, 1000.0, ShotWorld::default())
                .is_none()
        );
    }

    #[test]
    fn expired_local_bomb_injects_null() {
        let mut shot = make_shot();

        shot.cycle_weapon(false);
        shot.try_fire(&render_at(0.0, 0.0), 2, 0.0, ShotWorld::default()); // pending L1

        // спустя PENDING_MAX_AGE подтверждения нет — null очищает холст
        let mut game = serde_json::json!({});

        shot.filter_frame_game(game.as_object_mut().unwrap(), Some(2), 3000.0);
        assert!(game["w2"]["L1"].is_null());
    }

    #[test]
    fn cycle_weapon_wraps_and_panel_syncs() {
        let mut shot = make_shot();

        assert_eq!(shot.current_weapon.as_deref(), Some("w1"));

        shot.cycle_weapon(false);
        assert_eq!(shot.current_weapon.as_deref(), Some("w2"));

        shot.cycle_weapon(false); // wrap вперёд
        assert_eq!(shot.current_weapon.as_deref(), Some("w1"));

        shot.cycle_weapon(true); // wrap назад
        assert_eq!(shot.current_weapon.as_deref(), Some("w2"));

        // авторитетное оружие панели
        shot.sync_panel(&["wa:w1".to_string()]);
        assert_eq!(shot.current_weapon.as_deref(), Some("w1"));

        // неизвестное оружие игнорируется
        shot.sync_panel(&["wa:zzz".to_string()]);
        assert_eq!(shot.current_weapon.as_deref(), Some("w1"));
    }

    #[test]
    fn reset_restores_default_weapon_and_clears_state() {
        let mut shot = make_shot();

        shot.cycle_weapon(false);
        shot.sync_panel(&["w1:5".to_string()]);
        shot.try_fire(&render_at(0.0, 0.0), 1, 0.0, ShotWorld::default());
        shot.reset();

        assert_eq!(shot.current_weapon.as_deref(), Some("w1"));
        assert!(shot.ammo.is_empty());
        assert!(shot.pending_bombs.is_empty());
        // кулдаун сброшен
        assert!(
            shot.try_fire(&render_at(0.0, 0.0), 1, 1.0, ShotWorld::default())
                .is_some()
        );
    }

    #[test]
    fn reset_local_keeps_bomb_alias() {
        let mut shot = make_shot();

        shot.cycle_weapon(false);
        shot.try_fire(&render_at(0.0, 0.0), 2, 0.0, ShotWorld::default());

        let mut game = serde_json::json!({ "w2": { "a1": [5.0, 5.0, 0, 8, 300, 2] } });

        shot.filter_frame_game(game.as_object_mut().unwrap(), Some(2), 100.0);
        assert_eq!(shot.bomb_aliases.len(), 1);

        // смерть игрока: keyset приходит раньше детонации, алиас обязан дожить
        shot.reset_local();

        let mut game = serde_json::json!({ "w2": { "a1": null } });
        let map = game.as_object_mut().unwrap();

        shot.filter_frame_game(map, Some(2), 400.0);

        assert!(map["w2"].get("a1").is_none());
        assert!(map["w2"]["L1"].is_null());
    }

    #[test]
    fn reset_buries_unconfirmed_local_bomb() {
        let mut shot = make_shot();

        shot.cycle_weapon(false);
        shot.try_fire(&render_at(0.0, 0.0), 2, 0.0, ShotWorld::default()); // pending L1, без подтверждения

        shot.reset_local();

        let mut game = serde_json::json!({});
        let map = game.as_object_mut().unwrap();

        shot.filter_frame_game(map, Some(2), 100.0);

        // локальная бомба похоронена: null по локальному id
        assert!(map["w2"]["L1"].is_null());
    }
}
