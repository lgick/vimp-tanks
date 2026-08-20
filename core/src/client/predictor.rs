//! Client-side prediction своего танка — порт src/client/TankPredictor.js
//! (срез 2.6). Реплика авторитетной модели движения без Rapier-коллизий:
//! формулы тика — общие с Tank::update (crate::motion), интеграция —
//! эмпирический порядок Rapier (позиция скоростью ДО демпфирования,
//! затем damping v·= 1/(1+dt·d)), закреплённый паритет-тестом.
//!
//! Поток: apply_input пишет изменения клавиш в историю; update() шагает
//! симуляцию фикс-шагом; on_server_state() — reconciliation: состояние
//! берётся авторитетное и история ввода переигрывается от serverTime кадра
//! до текущей оценки серверного времени. Расхождение копится в visual_error
//! и экспоненциально затухает — без видимых рывков.

use std::collections::VecDeque;

use indexmap::IndexMap;

use crate::config::{KeyConfig, ModelConfig};
use crate::motion::{self, TurretInput};
use vimp_engine_core::client::collision::{Contact, collect_tile_contacts, obb_vs_obb};
use vimp_engine_core::client::raycast::Box2;
use vimp_engine_core::client::rigid_body::{
    Body, MAP_SURFACE, Surface, apply_contact_impulse, box_mass_properties, combine_surfaces,
    separate_bodies,
};
use vimp_engine_core::config::PLAYER_STATE_LEN;
use vimp_engine_core::physics::normalize_angle;

use super::Grid;
use super::predicted_set::PredictedBodies;

// максимальный возраст записей истории ввода (мс)
const HISTORY_MAX_AGE: f64 = 2000.0;

// скорость затухания визуальной ошибки (доля в секунду)
const ERROR_DECAY_RATE: f64 = 10.0;

// порог ошибки (юнитов), выше которого позиция снапится без сглаживания
const ERROR_SNAP_DISTANCE: f32 = 100.0;

// защита от «спирали смерти» аккумулятора (мс)
const MAX_ACCUMULATED_TIME: f64 = 100.0;

// проходов решателя по собранным контактам за один шаг (sequential impulse)
const SOLVER_ITERATIONS: usize = 4;

// неподвижный партнёр контакта со стеной (обратные массы нулевые, поэтому
// решатель его не двигает; координаты нужны только как плечо)
fn static_body(x: f32, y: f32) -> Body {
    Body {
        x,
        y,
        ..Body::default()
    }
}

/// Габариты и масс-инерционные свойства корпуса своего танка.
struct Shape {
    half_w: f32,
    half_h: f32,
    inv_mass: f32,
    inv_inertia: f32,
}

/// Состояние реплики (порядок полей — как player-блок кадра).
#[derive(Clone, Copy, Default)]
pub struct TankState {
    pub x: f32,
    pub y: f32,
    pub angle: f32,
    pub vx: f32,
    pub vy: f32,
    pub angvel: f32,
    pub gun_rotation: f32,
    pub throttle: f32,
}

impl TankState {
    pub fn from_array(s: [f32; PLAYER_STATE_LEN]) -> Self {
        Self {
            x: s[0],
            y: s[1],
            angle: s[2],
            vx: s[3],
            vy: s[4],
            angvel: s[5],
            gun_rotation: s[6],
            throttle: s[7],
        }
    }

    pub fn to_array(self) -> [f32; PLAYER_STATE_LEN] {
        [
            self.x,
            self.y,
            self.angle,
            self.vx,
            self.vy,
            self.angvel,
            self.gun_rotation,
            self.throttle,
        ]
    }
}

/// Предсказанное состояние для рендера (со сглаживающей визуальной ошибкой).
pub struct RenderState {
    pub x: f32,
    pub y: f32,
    pub angle: f32,
    pub gun_rotation: f32,
    pub vx: f32,
    pub vy: f32,
    pub engine_load: f32,
    pub angvel: f32,
}

struct HistoryEntry {
    time: f64,
    keys: u32,
    one_shot: u32,
}

struct KeyBit {
    bit: u32,
    one_shot: bool,
}

pub struct Predictor {
    step_ms: f64,
    models: IndexMap<String, ModelConfig>,
    model: Option<ModelConfig>,
    // габариты и масса корпуса (считает set_model)
    shape: Option<Shape>,

    // подсистемы предсказанного мира (динамика карты, чужие танки): часы у
    // них общие с этим предиктором, иначе контакт разрешался бы в разных
    // шагах. Без подсистем и без set_map проход столкновений — полный no-op,
    // а реплика движения остаётся бит-в-бит прежней (паритет с хостом)
    sets: Vec<Box<dyn PredictedBodies>>,
    grid: Option<Grid>,
    // часы симуляции, общие с предсказанным миром
    local_now: f64,

    // биты клавиш по именам (one-shot помечены в KeyBit)
    keys: IndexMap<String, KeyBit>,
    forward_bit: u32,
    back_bit: u32,
    left_bit: u32,
    right_bit: u32,
    gun_center_bit: u32,
    gun_left_bit: u32,
    gun_right_bit: u32,

    active: bool,
    frozen: bool,
    has_state: bool,
    pending_reset: bool,

    state: TankState,
    centering: bool,
    engine_load: f32,

    // живой ввод
    keys_mask: u32,
    one_shot_pending: u32,

    // история ввода и маска, действовавшая до самой старой записи
    history: VecDeque<HistoryEntry>,
    base_keys_mask: u32,

    visual_error: [f32; 3], // x, y, angle

    // окно локального времени истории ввода, переигранное последним
    // реконсилем: (начало, конец, число вводов) — уровень 1 детектора
    // рассинхрона движка
    replayed: Option<(f64, f64, usize)>,

    accumulator: f64,
    last_update_time: Option<f64>,
}

impl Predictor {
    pub fn new(
        step_ms: f64,
        player_keys: &IndexMap<String, KeyConfig>,
        models: &IndexMap<String, ModelConfig>,
    ) -> Self {
        let mut keys = IndexMap::new();

        for (name, key) in player_keys {
            keys.insert(
                name.clone(),
                KeyBit {
                    bit: key.key,
                    one_shot: key.kind == 1,
                },
            );
        }

        let bit = |name: &str| keys.get(name).map(|k| k.bit).unwrap_or(0);

        Self {
            step_ms,
            models: models.clone(),
            model: None,
            shape: None,
            sets: Vec::new(),
            grid: None,
            local_now: 0.0,
            forward_bit: bit("forward"),
            back_bit: bit("back"),
            left_bit: bit("left"),
            right_bit: bit("right"),
            gun_center_bit: bit("gunCenter"),
            gun_left_bit: bit("gunLeft"),
            gun_right_bit: bit("gunRight"),
            keys,
            active: false,
            frozen: false,
            has_state: false,
            pending_reset: true,
            state: TankState::default(),
            centering: false,
            engine_load: 0.0,
            keys_mask: 0,
            one_shot_pending: 0,
            history: VecDeque::new(),
            base_keys_mask: 0,
            visual_error: [0.0; 3],
            replayed: None,
            accumulator: 0.0,
            last_update_time: None,
        }
    }

    /// Модель танка пользователя (известна при авторизации).
    pub fn set_model(&mut self, model_name: &str) {
        self.model = self.models.get(model_name).cloned();
        // габарит 4:3 от size и масс-инерционные свойства корпуса: модель за
        // игру не меняется, а шагов симуляции (живых плюс replay) сотни
        // в секунду
        self.shape = self.model.as_ref().map(|model| {
            let width = model.size * 4.0;
            let height = model.size * 3.0;
            // размер танка, в отличие от динамики карты, картой не масштабируется
            let mass = box_mass_properties(width, height, model.fixture.density);

            Shape {
                half_w: width / 2.0,
                half_h: height / 2.0,
                inv_mass: mass.inv_mass,
                inv_inertia: mass.inv_inertia,
            }
        });
    }

    /// Подсистема предсказанного мира. Её тела шагает этот предиктор
    /// (`integrate_predicted`, `decay_error`), поэтому контакт со своим
    /// танком разрешается в одном шаге, а replay реконсиляции переигрывает
    /// и её тела.
    pub fn add_predicted_set(&mut self, set: Box<dyn PredictedBodies>) {
        self.sets.push(set);
    }

    /// Подсистемы предсказанного мира (реконсиляция, рендер-блоки).
    pub fn predicted_sets_mut(&mut self) -> &mut [Box<dyn PredictedBodies>] {
        &mut self.sets
    }

    pub fn predicted_sets(&self) -> &[Box<dyn PredictedBodies>] {
        &self.sets
    }

    /// Стены карты (MAP_DATA) — тайловая сетка для сбора контактов.
    pub fn set_map(&mut self, map_json: &str) -> Result<(), String> {
        let cfg: super::ClientMapConfig =
            serde_json::from_str(map_json).map_err(|e| e.to_string())?;

        self.grid = Some(Grid {
            map: cfg.map,
            solid_tiles: cfg.physics_static,
            tile_size: cfg.step * cfg.scale,
        });

        Ok(())
    }

    /// Предикт включается для играющего (keySet 1) и выключается у спектатора.
    pub fn set_active(&mut self, is_active: bool) {
        if is_active && !self.active {
            self.pending_reset = true;
        }

        self.active = is_active;

        if !is_active {
            self.has_state = false;
        }
    }

    /// Заморозка на серверном состоянии (танк уничтожен).
    pub fn freeze(&mut self, is_frozen: bool) {
        self.frozen = is_frozen;
    }

    /// Полный сброс (respawn/телепорт/смена карты): состояние возьмётся
    /// из следующего player-блока без replay.
    pub fn reset(&mut self) {
        self.pending_reset = true;
        // до прихода следующего player-блока рендерить нечего: иначе предикт
        // дорисовывает актора в позиции уже несуществующего мира
        self.has_state = false;
        self.history.clear();
        self.base_keys_mask = 0;
        self.keys_mask = 0; // сервер сбрасывает клавиши при респауне (resetKeys)
        self.one_shot_pending = 0;
        self.visual_error = [0.0; 3];
        self.replayed = None;
        self.accumulator = 0.0;
    }

    /// Есть ли предсказанное состояние для рендера.
    pub fn has_state(&self) -> bool {
        self.active && self.has_state && self.model.is_some()
    }

    /// Предсказанное состояние в раскладке player-блока (уровень 1 детектора
    /// рассинхрона). Снимается движком перед `on_server_state`, то есть до
    /// затирания предикта авторитетным состоянием.
    pub fn predicted_state(&self) -> Option<[f32; PLAYER_STATE_LEN]> {
        self.has_state().then(|| self.state.to_array())
    }

    /// Окно локального времени истории ввода, переигранное последним
    /// реконсилем: (начало, конец, число вводов).
    pub fn replayed_inputs(&self) -> Option<(f64, f64, usize)> {
        self.replayed
    }

    /// Изменение клавиши: обновляет живую маску и историю ввода.
    pub fn apply_input(&mut self, action: &str, name: &str, local_time: f64) {
        let Some(key) = self.keys.get(name) else {
            return;
        };

        let key_bit = key.bit;
        let mut one_shot = 0;

        if action == "down" {
            if key.one_shot {
                self.one_shot_pending |= key_bit;
                one_shot = key_bit;
            } else {
                self.keys_mask |= key_bit;
            }
        } else if action == "up" {
            self.keys_mask &= !key_bit;
        }

        self.history.push_back(HistoryEntry {
            time: local_time,
            keys: self.keys_mask,
            one_shot,
        });
        self.trim_history(local_time);
    }

    /// Продвигает симуляцию к текущему моменту (вызывается каждый рендер-тик).
    pub fn update(&mut self, local_now: f64) {
        let Some(last) = self.last_update_time else {
            self.last_update_time = Some(local_now);
            return;
        };

        let elapsed = local_now - last;

        self.last_update_time = Some(local_now);
        self.local_now = local_now;

        // затухание визуальной ошибки
        let decay = (1.0 - (elapsed / 1000.0) * ERROR_DECAY_RATE).max(0.0) as f32;

        for value in &mut self.visual_error {
            *value *= decay;
        }

        // у всего предсказанного мира одни часы
        for set in &mut self.sets {
            set.decay_error(elapsed);
        }

        if !self.has_state() || self.frozen {
            self.accumulator = 0.0;

            // симуляция не шагает (спектатор, уничтоженный танк, ожидание
            // первого authoritative-кадра) — тела предсказанного мира
            // отпускаются: без шага некому вернуть их в интерполяцию, а их
            // render_data продолжает перекрывать её каждый кадр, и ящик или
            // чужой танк застыл бы на экране навсегда
            for set in &mut self.sets {
                set.release_predicted();
            }

            return;
        }

        self.accumulator = (self.accumulator + elapsed).min(MAX_ACCUMULATED_TIME);

        while self.accumulator >= self.step_ms {
            let keys = self.keys_mask | self.one_shot_pending;

            self.one_shot_pending = 0;
            self.step(keys);
            self.accumulator -= self.step_ms;
        }
    }

    /// Reconciliation: авторитетное состояние сервера + replay истории ввода.
    pub fn on_server_state(
        &mut self,
        state: [f32; PLAYER_STATE_LEN],
        centering: bool,
        server_time: f64,
        offset: f64,
        local_now: f64,
    ) {
        if !self.active || self.model.is_none() {
            return;
        }

        self.local_now = local_now;

        let old = self.has_state.then_some(self.state);

        self.state = TankState::from_array(state);
        self.centering = centering;
        self.has_state = true;

        // replay: от serverTime кадра до текущей оценки серверного времени
        let server_now_est = local_now + offset;
        let mut history_index = 0;
        let mut replay_keys = self.base_keys_mask;
        let mut t = server_time;

        // маска, действовавшая на момент serverTime
        while history_index < self.history.len()
            && self.history[history_index].time + offset <= t
        {
            replay_keys = self.history[history_index].keys;
            history_index += 1;
        }

        let replayed_from = history_index;

        while t + self.step_ms <= server_now_est {
            t += self.step_ms;

            // записи, попавшие в этот шаг: обновляют маску и дают one-shot
            let mut one_shot = 0;

            while history_index < self.history.len()
                && self.history[history_index].time + offset <= t
            {
                replay_keys = self.history[history_index].keys;
                one_shot |= self.history[history_index].one_shot;
                history_index += 1;
            }

            self.step(replay_keys | one_shot);
        }

        // остаток времени доиграет update() своим аккумулятором
        self.accumulator = server_now_est - t;

        // окно переигранного ввода — в локальном времени (история хранит его)
        self.replayed = Some((
            server_time - offset,
            t - offset,
            history_index - replayed_from,
        ));

        let Some(old) = old else {
            self.pending_reset = false;
            self.visual_error = [0.0; 3];
            return;
        };

        if self.pending_reset {
            self.pending_reset = false;
            self.visual_error = [0.0; 3];
            return;
        }

        // расхождение старого предсказания с новым — в визуальную ошибку
        self.visual_error[0] += old.x - self.state.x;
        self.visual_error[1] += old.y - self.state.y;
        self.visual_error[2] += normalize_angle(old.angle - self.state.angle);

        if self.visual_error[0].hypot(self.visual_error[1]) > ERROR_SNAP_DISTANCE {
            self.visual_error = [0.0; 3];
        }
    }

    /// Состояние для рендера (со сглаживающей визуальной ошибкой).
    pub fn render_state(&self) -> Option<RenderState> {
        if !self.has_state() {
            return None;
        }

        Some(RenderState {
            x: self.state.x + self.visual_error[0],
            y: self.state.y + self.visual_error[1],
            angle: self.state.angle + self.visual_error[2],
            gun_rotation: self.state.gun_rotation,
            vx: self.state.vx,
            vy: self.state.vy,
            engine_load: self.engine_load,
            angvel: self.state.angvel,
        })
    }

    // подрезает историю, запоминая маску, действовавшую до её начала
    fn trim_history(&mut self, local_now: f64) {
        let min_time = local_now - HISTORY_MAX_AGE;

        while let Some(entry) = self.history.front() {
            if entry.time >= min_time {
                break;
            }

            self.base_keys_mask = entry.keys;
            self.history.pop_front();
        }
    }

    // один фикс-шаг реплики движения: формулы тика общие с Tank::update
    // (crate::motion), интеграция — эмпирический порядок Rapier
    fn step(&mut self, keys: u32) {
        let Some(model) = &self.model else {
            return;
        };

        let dt = (self.step_ms / 1000.0) as f32;

        let forward = keys & self.forward_bit != 0;
        let back = keys & self.back_bit != 0;
        let left = keys & self.left_bit != 0;
        let right = keys & self.right_bit != 0;

        let turret = TurretInput {
            center: keys & self.gun_center_bit != 0,
            left: keys & self.gun_left_bit != 0,
            right: keys & self.gun_right_bit != 0,
        };

        (self.state.gun_rotation, self.centering) = motion::step_turret(
            self.state.gun_rotation,
            self.centering,
            turret,
            model,
            dt,
        );

        self.state.throttle =
            motion::step_throttle(self.state.throttle, forward || back, model, dt);

        // локальные оси корпуса: forward = (cos, sin), right = (−sin, cos)
        let (sin, cos) = self.state.angle.sin_cos();
        let forward_speed = self.state.vx * cos + self.state.vy * sin;
        let lateral_vel = -self.state.vx * sin + self.state.vy * cos;

        let lateral_dv = motion::lateral_dv(lateral_vel, model, dt);
        let accel = motion::drive_accel(self.state.throttle, forward, back, forward_speed, model);
        let forward_dv = accel * dt;

        self.state.vx += cos * forward_dv - sin * lateral_dv;
        self.state.vy += sin * forward_dv + cos * lateral_dv;

        self.engine_load = motion::engine_load(self.state.throttle, forward_speed, model);

        self.state.angvel += motion::turn_delta(left, right, forward_speed, model, dt);

        // интеграция и затухание (эмпирический порядок Rapier, зафиксирован
        // паритет-тестом: позиция интегрируется скоростью до демпфирования,
        // хранится задемпфированная скорость)
        self.state.x += self.state.vx * dt;
        self.state.y += self.state.vy * dt;
        self.state.angle = normalize_angle(self.state.angle + self.state.angvel * dt);

        self.state.vx *= 1.0 / (1.0 + dt * model.damping.linear);
        self.state.vy *= 1.0 / (1.0 + dt * model.damping.linear);
        self.state.angvel *= 1.0 / (1.0 + dt * model.damping.angular);

        self.resolve_world(dt);
    }

    /// Столкновения одного шага: свой танк, предсказанные тела подсистем и
    /// стены разрешаются в ОДНОЙ симуляции — потому нарисованный танк и
    /// нарисованное тело не выдавливают друг друга.
    /// Без карты и без подсистем — полный no-op (см. инвариант в структуре).
    fn resolve_world(&mut self, dt: f32) {
        // заморожен — танком владеет сервер: уничтоженный корпус ничего не
        // толкает, а захват тел в предсказание привязал бы их к нему
        // (см. release_predicted)
        if self.frozen || (self.grid.is_none() && self.sets.is_empty()) {
            return;
        }

        let (Some(model), Some(shape)) = (&self.model, &self.shape) else {
            return;
        };

        let local_now = self.local_now;
        let tank_obb = Box2 {
            x: self.state.x,
            y: self.state.y,
            angle: self.state.angle,
            half_w: shape.half_w,
            half_h: shape.half_h,
        };

        // тела шага: индекс 0 — свой танк, дальше предсказанные тела
        // подсистем в порядке их регистрации, затем статические партнёры
        // контактов со стенами. Решатель работает по индексам: две
        // изменяемые ссылки на элементы одного среза сразу не взять
        let mut sim = vec![Body {
            x: self.state.x,
            y: self.state.y,
            angle: self.state.angle,
            vx: self.state.vx,
            vy: self.state.vy,
            angvel: self.state.angvel,
            inv_mass: shape.inv_mass,
            inv_inertia: shape.inv_inertia,
            linear_damping: model.damping.linear,
            angular_damping: model.damping.angular,
        }];
        let mut geometry = vec![(tank_obb.half_w, tank_obb.half_h)];
        let mut surfaces = vec![Surface {
            friction: model.fixture.friction,
            restitution: model.fixture.restitution,
        }];

        // захват и шаг предсказанных подсистем (ящики карты, чужие танки)
        let mut bodies = Vec::new();

        for set in &mut self.sets {
            set.capture(&tank_obb, local_now);
            set.integrate_predicted(dt);

            for body in set.predicted_bodies_mut() {
                sim.push(body.body);
                geometry.push((body.half_w, body.half_h));
                surfaces.push(body.surface);
                bodies.push(body);
            }
        }

        let movable = sim.len();
        let mut contacts: Vec<(usize, usize, Contact, Surface)> = Vec::new();

        // контакты со стенами (партнёр — статика в точке задетого тайла)
        if let Some(grid) = &self.grid {
            for index in 0..movable {
                let obb = Box2 {
                    x: sim[index].x,
                    y: sim[index].y,
                    angle: sim[index].angle,
                    half_w: geometry[index].0,
                    half_h: geometry[index].1,
                };

                let hits =
                    collect_tile_contacts(&obb, &grid.map, &grid.solid_tiles, grid.tile_size);

                for hit in hits {
                    let partner = sim.len();

                    sim.push(static_body(hit.tile_x, hit.tile_y));
                    geometry.push((0.0, 0.0));
                    surfaces.push(MAP_SURFACE);
                    contacts.push((
                        index,
                        partner,
                        hit.contact,
                        combine_surfaces(&surfaces[index], &MAP_SURFACE),
                    ));
                }
            }
        }

        // свой танк ↔ каждое предсказанное тело и все пары между собой
        for a in 0..movable {
            for b in (a + 1)..movable {
                let obb_a = Box2 {
                    x: sim[a].x,
                    y: sim[a].y,
                    angle: sim[a].angle,
                    half_w: geometry[a].0,
                    half_h: geometry[a].1,
                };
                let obb_b = Box2 {
                    x: sim[b].x,
                    y: sim[b].y,
                    angle: sim[b].angle,
                    half_w: geometry[b].0,
                    half_h: geometry[b].1,
                };

                if let Some(contact) = obb_vs_obb(&obb_a, &obb_b) {
                    contacts.push((a, b, contact, combine_surfaces(&surfaces[a], &surfaces[b])));
                }
            }
        }

        if !contacts.is_empty() {
            // развод по глубине — ровно один раз на контакт: повтор на каждой
            // итерации расталкивал бы тела кратно числу итераций
            for (a, b, contact, _) in &contacts {
                let (body_a, body_b) = pair_mut(&mut sim, *a, *b);

                separate_bodies(body_a, body_b, contact);
            }

            // контакты собраны один раз, импульсы проходят по ним несколько
            // раз — это же заменяет внутренние итерации выталкивания из
            // тайловой сетки
            for _ in 0..SOLVER_ITERATIONS {
                for (a, b, contact, surface) in &contacts {
                    let (body_a, body_b) = pair_mut(&mut sim, *a, *b);

                    apply_contact_impulse(body_a, body_b, contact, surface);
                }
            }

            self.state.x = sim[0].x;
            self.state.y = sim[0].y;
            self.state.angle = normalize_angle(sim[0].angle);
            self.state.vx = sim[0].vx;
            self.state.vy = sim[0].vy;
            self.state.angvel = sim[0].angvel;

            for (offset, body) in bodies.iter_mut().enumerate() {
                body.body = sim[offset + 1];
            }
        }

        // тела, реально участвовавшие в контакте, держатся предсказанными
        // дольше
        for (a, b, _, _) in &contacts {
            for index in [*a, *b] {
                if index > 0 && index < movable {
                    bodies[index - 1].note_contact(local_now);
                }
            }
        }

        for set in &mut self.sets {
            set.demote_idle(local_now);
        }
    }
}

// две изменяемые ссылки на разные элементы среза
fn pair_mut(bodies: &mut [Body], a: usize, b: usize) -> (&mut Body, &mut Body) {
    let (left, right) = bodies.split_at_mut(a.max(b));

    if a < b {
        (&mut left[a], &mut right[0])
    } else {
        (&mut right[0], &mut left[b])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::TanksConfig;

    const STEP_MS: f64 = 1000.0 / 120.0;

    // конфиг — зеркало core/tests/sim.rs (модель m1 из src/data/models.js);
    // JSON плоский (движковые+игровые поля вперемешку) — каждая половина
    // деэерилизует лишние для себя поля молча (serde default/ignore).
    fn config_json() -> serde_json::Value {
        serde_json::json!({
            "timeStep": 1.0 / 120.0,
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
                    "impulseMagnitude": 5000,
                    "damage": 40,
                    "range": 1500,
                    "fireRate": 0.01,
                    "spread": 0,
                    "consumption": 1
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
                "fire": { "key": 128, "type": 1 }
            },
            "panel": {
                "health": { "value": 100 },
                "w1": { "value": 200 }
            },
            "snapshot": {
                "version": 3,
                "port": 5,
                "keys": { "m1": { "id": 1, "kind": "indexed8", "class": "hot" } }
            },
            "seed": 42
        })
    }

    pub fn core_config() -> TanksConfig {
        serde_json::from_value(config_json()).unwrap()
    }

    pub fn engine_config() -> vimp_engine_core::config::EngineConfig {
        serde_json::from_value(config_json()).unwrap()
    }

    fn make_predictor() -> Predictor {
        let cfg = core_config();
        let mut p = Predictor::new(STEP_MS, &cfg.player_keys, &cfg.models);

        p.set_model("m1");
        p.set_active(true);
        p
    }

    // авторитетное состояние покоя в момент t (offset 0 → replay пуст)
    fn seed(p: &mut Predictor, t: f64) {
        p.on_server_state([0.0; 8], false, t, 0.0, t);
    }

    #[test]
    fn input_updates_masks_and_history() {
        let mut p = make_predictor();

        p.apply_input("down", "forward", 0.0);
        assert_eq!(p.keys_mask, 1);

        p.apply_input("down", "fire", 1.0); // one-shot
        assert_eq!(p.keys_mask, 1);
        assert_eq!(p.one_shot_pending, 128);

        p.apply_input("up", "forward", 2.0);
        assert_eq!(p.keys_mask, 0);
        assert_eq!(p.history.len(), 3);

        p.apply_input("down", "unknown", 3.0); // неизвестная клавиша
        assert_eq!(p.history.len(), 3);
    }

    #[test]
    fn reset_drops_predicted_state() {
        let mut p = make_predictor();

        seed(&mut p, 0.0);
        p.update(0.0);
        assert!(p.has_state());

        // CLEAR/смена карты: рендерить нечего до следующего player-блока
        p.reset();

        assert!(!p.has_state());
        assert!(p.render_state().is_none());

        seed(&mut p, 100.0);
        assert!(p.has_state());
    }

    #[test]
    fn update_advances_simulation_with_fixed_steps() {
        let mut p = make_predictor();

        seed(&mut p, 0.0);
        p.update(0.0);
        p.apply_input("down", "forward", 0.0);

        for i in 1..=120 {
            p.update(i as f64 * STEP_MS);
        }

        let state = p.render_state().unwrap();

        assert!(state.x > 50.0, "танк должен уехать вперёд: x={}", state.x);
        assert!(state.vx > 0.0);
    }

    #[test]
    fn freeze_stops_stepping_but_error_decays() {
        let mut p = make_predictor();

        seed(&mut p, 0.0);
        p.update(0.0);
        p.visual_error = [10.0, 0.0, 0.0];
        p.freeze(true);
        p.apply_input("down", "forward", 0.0);
        p.update(50.0);

        assert_eq!(p.state.x, 0.0); // симуляция заморожена

        let expected = 10.0 * (1.0 - 0.05 * 10.0) as f32;

        assert!((p.visual_error[0] - expected).abs() < 1e-4);
    }

    #[test]
    fn replay_matches_continuous_simulation() {
        // шаг 10 мс: точен в f64 — число шагов детерминировано
        let make = || {
            let cfg = core_config();
            let mut p = Predictor::new(10.0, &cfg.player_keys, &cfg.models);

            p.set_model("m1");
            p.set_active(true);
            p
        };

        // непрерывная симуляция
        let mut continuous = make();

        seed(&mut continuous, 0.0);
        continuous.update(0.0);
        continuous.apply_input("down", "forward", 0.0);

        // состояние на 60-м шаге — «авторитетный кадр»
        for i in 1..=60 {
            continuous.update(i as f64 * 10.0);
        }

        let authoritative = continuous.state;
        let server_time = 600.0;

        for i in 61..=120 {
            continuous.update(i as f64 * 10.0);
        }

        // reconciliation: тот же ввод в истории + авторитетное состояние
        let mut replayed = make();

        seed(&mut replayed, 0.0);
        replayed.apply_input("down", "forward", 0.0);
        replayed.on_server_state(
            [
                authoritative.x,
                authoritative.y,
                authoritative.angle,
                authoritative.vx,
                authoritative.vy,
                authoritative.angvel,
                authoritative.gun_rotation,
                authoritative.throttle,
            ],
            false,
            server_time,
            0.0,
            1200.0,
        );

        assert!((replayed.state.x - continuous.state.x).abs() < 1e-3);
        assert!((replayed.state.vx - continuous.state.vx).abs() < 1e-3);
        assert!((replayed.state.throttle - continuous.state.throttle).abs() < 1e-5);
    }

    #[test]
    fn visual_error_accumulates_decays_and_snaps() {
        let mut p = make_predictor();

        seed(&mut p, 0.0);
        p.update(0.0);

        // расхождение: сервер видит танк в другом месте
        p.on_server_state([5.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], false, 10.0, 0.0, 10.0);
        assert!((p.visual_error[0] - (-5.0)).abs() < 1e-4);

        // рендер сглаживает ошибку
        let render = p.render_state().unwrap();

        assert!((render.x - (5.0 + p.visual_error[0])).abs() < 1e-4);

        // затухание
        p.update(50.0);
        assert!(p.visual_error[0].abs() < 5.0);

        // снап при большой ошибке
        p.on_server_state(
            [500.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            false,
            20.0,
            0.0,
            60.0,
        );
        assert_eq!(p.visual_error, [0.0; 3]);
    }

    #[test]
    fn reset_takes_next_state_without_replay_error() {
        let mut p = make_predictor();

        seed(&mut p, 0.0);
        p.reset();
        p.on_server_state([99.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], false, 5.0, 0.0, 5.0);

        assert_eq!(p.visual_error, [0.0; 3]);
        assert_eq!(p.state.x, 99.0);
    }

    #[test]
    fn predicted_state_mirrors_player_block_layout() {
        let mut p = make_predictor();

        assert!(p.predicted_state().is_none()); // состояния ещё нет

        let state = [1.0, 2.0, 0.3, 4.0, 5.0, 0.6, 0.7, 0.8];

        p.on_server_state(state, false, 0.0, 0.0, 0.0);
        assert_eq!(p.predicted_state(), Some(state));

        p.set_active(false);
        assert!(p.predicted_state().is_none());
    }

    #[test]
    fn replayed_inputs_reports_local_window() {
        let mut p = make_predictor();

        assert!(p.replayed_inputs().is_none());

        // offset 50: серверное время кадра 100 → локальное 50
        p.apply_input("down", "forward", 60.0);
        p.on_server_state([0.0; 8], false, 100.0, 50.0, 200.0);

        let (from, to, count) = p.replayed_inputs().unwrap();

        assert!((from - 50.0).abs() < 1e-9);
        assert!(to > from && to <= 200.0);
        assert_eq!(count, 1);

        // сброс забывает окно
        p.reset();
        assert!(p.replayed_inputs().is_none());
    }

    #[test]
    fn history_trim_keeps_base_mask() {
        let mut p = make_predictor();

        p.apply_input("down", "forward", 0.0);
        // запись старше HISTORY_MAX_AGE вытесняется, маска уходит в базу
        p.apply_input("down", "left", 3000.0);

        assert_eq!(p.history.len(), 1);
        assert_eq!(p.base_keys_mask, 1);
    }

    #[test]
    fn inactive_predictor_has_no_state() {
        let mut p = make_predictor();

        seed(&mut p, 0.0);
        assert!(p.has_state());

        p.set_active(false);
        assert!(!p.has_state());
        assert!(p.render_state().is_none());

        // состояние сервера игнорируется у спектатора
        p.on_server_state([1.0; 8], false, 5.0, 0.0, 5.0);
        assert!(!p.has_state());
    }

    // — столкновения предсказанного мира —

    use super::super::predicted_set::{
        Mode, PredictedBodies, PredictedBody, PredictedSet, ServerState, Transform,
    };
    use vimp_engine_core::client::game::PredictedRow;
    use std::cell::Cell;
    use std::rc::Rc;
    use vimp_engine_core::client::interpolator::InterpolatedGame;
    use vimp_engine_core::client::unpack::DecodedSnapshot;

    // сетка 3×3 клетки по 40 юнитов; сплошная колонна справа (x >= 80)
    fn wall_grid() -> String {
        serde_json::json!({
            "step": 40,
            "scale": 1,
            "map": [[0, 0, 1], [0, 0, 1], [0, 0, 1]],
            "physicsStatic": [1],
            "physicsDynamic": []
        })
        .to_string()
    }

    // минимальный двойник подсистемы с одним предсказанным ящиком
    struct BoxSet {
        set: PredictedSet,
        captures: Rc<Cell<usize>>,
        releases: Rc<Cell<usize>>,
    }

    impl BoxSet {
        fn new(x: f32) -> Self {
            let mut body = PredictedBody::new(Transform {
                x,
                y: 20.0,
                angle: 0.0,
            });

            body.half_w = 10.0;
            body.half_h = 10.0;
            body.body.inv_mass = 1.0 / 7373.0;
            body.body.inv_inertia = 1.0 / 452_985.0;
            body.surface.friction = 0.2;
            body.surface.restitution = 0.0;
            body.mode = Mode::Predicted;

            let mut set = PredictedSet::new(4);

            set.bodies_mut().insert("box".to_string(), body);

            Self {
                set,
                captures: Rc::new(Cell::new(0)),
                releases: Rc::new(Cell::new(0)),
            }
        }
    }

    impl PredictedBodies for BoxSet {
        fn set(&self) -> &PredictedSet {
            &self.set
        }

        fn set_mut(&mut self) -> &mut PredictedSet {
            &mut self.set
        }

        fn update(&mut self, _game: &InterpolatedGame) {}

        fn snapshot_bodies(&self, _snapshot: &DecodedSnapshot) -> Vec<(String, ServerState)> {
            Vec::new()
        }

        fn capture(&mut self, _tank: &Box2, _local_now: f64) {
            self.captures.set(self.captures.get() + 1);
        }

        fn render_data(&self) -> Vec<PredictedRow> {
            Vec::new()
        }

        // тело двойника предсказано изначально: возврат в интерполяцию тест
        // только считает, иначе ящик исчезал бы из решателя посреди сценария
        fn demote_idle(&mut self, _local_now: f64) {}

        fn release_predicted(&mut self) {
            self.releases.set(self.releases.get() + 1);
        }
    }

    // ящик подсистемы, добавленной предиктору
    fn box_body(p: &mut Predictor) -> &PredictedBody {
        &p.predicted_sets_mut()[0].set().bodies()["box"]
    }

    #[test]
    fn without_map_and_sets_there_are_no_collisions() {
        // предиктор без карты стоит внутри стены — и всё равно едет как
        // в пустоте (инвариант паритета с хостом)
        let mut p = make_predictor();
        let mut reference = make_predictor();

        reference
            .set_map(
                &serde_json::json!({
                    "step": 40, "scale": 1, "map": [[0]],
                    "physicsStatic": [], "physicsDynamic": []
                })
                .to_string(),
            )
            .unwrap();

        for predictor in [&mut p, &mut reference] {
            predictor.state.x = 85.0;
            predictor.state.vx = 100.0;
            predictor.step(0);
        }

        assert_eq!(p.state.to_array(), reference.state.to_array());
    }

    #[test]
    fn wall_stops_the_tank() {
        let mut p = make_predictor();

        p.set_map(&wall_grid()).unwrap();
        p.state.x = 74.0; // правый край танка 78, стена начинается с 80
        p.state.vx = 300.0;

        for _ in 0..60 {
            p.step(0);
        }

        // корпус не заходит за грань стены и не улетел сквозь неё
        assert!(p.state.x + 4.0 <= 80.001);
        assert!(p.state.vx < 1.0);
    }

    #[test]
    fn corner_hit_rotates_the_tank() {
        let mut p = make_predictor();

        p.set_map(&wall_grid()).unwrap();
        p.state.x = 74.0;
        p.state.y = 20.0;
        p.state.angle = 0.4; // корпус повёрнут — в стену войдёт угол
        p.state.vx = 300.0;
        p.step(0);

        assert_ne!(p.state.angvel, 0.0);
    }

    #[test]
    fn contact_moves_the_box() {
        let mut p = make_predictor();

        p.add_predicted_set(Box::new(BoxSet::new(40.0)));
        p.state.x = 26.0; // правый край танка 30, левая грань ящика 30
        p.state.y = 20.0;
        p.state.vx = 200.0;

        for _ in 0..30 {
            p.step(0);
        }

        let body = box_body(&mut p).body;

        assert!(body.x > 40.0);
        assert!(body.vx > 0.0);
    }

    #[test]
    fn tank_loses_speed_pushing_the_box() {
        let mut p = make_predictor();

        p.add_predicted_set(Box::new(BoxSet::new(40.0)));
        p.state.x = 26.0;
        p.state.y = 20.0;
        p.state.vx = 200.0;
        p.step(0);

        assert!(p.state.vx < 200.0);
    }

    // регресс: demote_idle зовётся только из шага симуляции, а рендер
    // предсказанных тел перекрывает интерполяцию каждый кадр —
    // остановившийся предиктор оставлял ящик застывшим на экране навсегда
    #[test]
    fn without_simulation_step_sets_release_bodies() {
        let mut p = make_predictor();
        let set = BoxSet::new(40.0);
        let releases = set.releases.clone();

        p.add_predicted_set(Box::new(set));
        p.set_active(false); // спектатор: шага нет

        p.update(1000.0);
        p.update(1016.0);

        assert!(releases.get() > 0);
    }

    #[test]
    fn freeze_disables_contacts_and_capture() {
        let mut p = make_predictor();
        let set = BoxSet::new(40.0);
        let captures = set.captures.clone();

        p.add_predicted_set(Box::new(set));
        p.freeze(true);
        p.state.x = 26.0; // правый край танка 30, левая грань ящика 30
        p.state.y = 20.0;
        p.state.vx = 200.0;
        p.step(0);

        let body = box_body(&mut p).body;

        assert_eq!(captures.get(), 0);
        assert_eq!(body.x, 40.0);
        assert_eq!(body.vx, 0.0);
    }

    #[test]
    fn box_out_of_contact_leaves_tank_untouched() {
        let mut p = make_predictor();
        let mut reference = make_predictor();

        p.add_predicted_set(Box::new(BoxSet::new(400.0)));

        for predictor in [&mut p, &mut reference] {
            predictor.state.vx = 100.0;
            predictor.step(0);
        }

        let body = box_body(&mut p).body;

        assert_eq!(body.x, 400.0);
        assert_eq!(body.vx, 0.0);
        assert_eq!(p.state.to_array(), reference.state.to_array());
    }
}

// Паритет реплики с Rapier-миром ядра — замена паритет-теста
// tests/core/predictorParity.test.js (JS-реплика удалена срезом 2.6).
// Формулы тика общие (crate::motion), тест ловит расхождение интеграции
// (ручная против Rapier). Сценарии и допуски — из JS-оригинала.
#[cfg(test)]
mod parity {
    use super::tests::{core_config, engine_config};
    use super::*;
    use crate::tanks::GameState;

    const DT: f32 = 1.0 / 120.0;
    const STEP_MS: f64 = 1000.0 / 120.0;

    fn key_bit(cfg: &crate::config::TanksConfig, name: &str) -> u32 {
        cfg.player_keys[name].key
    }

    // прогон core+replica с расписанием масок { шаг → маска }
    fn simulate(steps: usize, schedule: &[(usize, u32)]) -> ([f32; PLAYER_STATE_LEN], TankState) {
        let cfg = core_config();
        let mut game = GameState::new(engine_config(), &cfg);

        game.spawn_actor(1, "m1", 1, 0.0, 0.0, 0.0).unwrap();

        let mut predictor = Predictor::new(STEP_MS, &cfg.player_keys, &cfg.models);

        predictor.set_model("m1");
        predictor.set_active(true);
        predictor.on_server_state([0.0; PLAYER_STATE_LEN], false, 0.0, 0.0, 0.0);

        let one_shot_mask: u32 = cfg
            .player_keys
            .values()
            .filter(|k| k.kind == 1)
            .map(|k| k.key)
            .sum();

        let mut current_mask = 0u32;
        let mut seq = 0u32;

        for i in 0..steps {
            let scheduled = schedule.iter().find(|(step, _)| *step == i).map(|(_, m)| *m);

            if let Some(new_mask) = scheduled {
                // диф масок → down/up ядру (как JS-тест applyMask)
                for (name, key) in &cfg.player_keys {
                    let was = current_mask & key.key != 0;
                    let now = new_mask & key.key != 0;

                    if !was && now {
                        seq += 1;
                        game.apply_input(1, seq, "down", name);
                    } else if was && !now {
                        seq += 1;
                        game.apply_input(1, seq, "up", name);
                    }
                }

                current_mask = new_mask;
            }

            game.step(DT);

            // one-shot биты действуют только на шаге назначения
            let one_shot_now = scheduled.unwrap_or(0) & one_shot_mask;

            predictor.step(current_mask | one_shot_now);
        }

        let tank = &game.sim.tanks[&1];
        let body = &game.world.bodies[tank.body];
        let (state, _) = tank.prediction_state(body);

        (state, predictor.state)
    }

    fn expect_close(core: [f32; PLAYER_STATE_LEN], replica: TankState, tolerance: f32) {
        assert!(
            (replica.x - core[0]).abs() < tolerance,
            "x: replica {} vs core {}",
            replica.x,
            core[0]
        );
        assert!(
            (replica.y - core[1]).abs() < tolerance,
            "y: replica {} vs core {}",
            replica.y,
            core[1]
        );
        assert!(
            (replica.angle - core[2]).abs() < 0.02,
            "angle: replica {} vs core {}",
            replica.angle,
            core[2]
        );
        assert!((replica.vx - core[3]).abs() < tolerance);
        assert!((replica.vy - core[4]).abs() < tolerance);
        assert!((replica.gun_rotation - core[6]).abs() < 0.01);
        assert!((replica.throttle - core[7]).abs() < 0.001);
    }

    #[test]
    fn forward_acceleration() {
        let cfg = core_config();
        let (core, replica) = simulate(120, &[(0, key_bit(&cfg, "forward"))]);

        expect_close(core, replica, 0.5);
    }

    #[test]
    fn forward_with_right_turn() {
        let cfg = core_config();
        let mask = key_bit(&cfg, "forward") | key_bit(&cfg, "right");
        let (core, replica) = simulate(120, &[(0, mask)]);

        expect_close(core, replica, 0.5);
    }

    #[test]
    fn release_gas_and_brake() {
        let cfg = core_config();
        let (core, replica) = simulate(150, &[(0, key_bit(&cfg, "forward")), (90, 0)]);

        expect_close(core, replica, 0.5);
    }

    #[test]
    fn reverse_with_left_turn() {
        let cfg = core_config();
        let mask = key_bit(&cfg, "back") | key_bit(&cfg, "left");
        let (core, replica) = simulate(120, &[(0, mask)]);

        expect_close(core, replica, 0.5);
    }

    #[test]
    fn turret_rotation_and_centering() {
        let cfg = core_config();
        let (core, replica) = simulate(
            90,
            &[
                (0, key_bit(&cfg, "gunRight")),
                (40, key_bit(&cfg, "gunCenter")),
            ],
        );

        expect_close(core, replica, 0.5);
    }

    #[test]
    fn no_input_stays_put() {
        let (core, replica) = simulate(60, &[]);

        expect_close(core, replica, 0.001);
    }
}
