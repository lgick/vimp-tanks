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
use std::rc::Rc;

use indexmap::IndexMap;

use crate::config::{KeyConfig, LevelRules, ModelConfig};
use crate::level::{self, LevelState, Transit};
use crate::motion::{self, TurretInput};
use vimp_engine_core::client::collision::{
    Contact, Manifold, collect_block_contacts, obb_manifold,
};
use vimp_engine_core::client::raycast::Box2;
use vimp_engine_core::client::rigid_body::{
    Body, ContactImpulses, MAP_SURFACE, Surface, apply_contact_impulse, box_mass_properties,
    combine_surfaces, separate_bodies,
};
use vimp_engine_core::config::PLAYER_STATE_LEN;
use vimp_engine_core::map::{MapLevels, RampRun, STATIC_LEVEL_GROUP, level_group};
use vimp_engine_core::physics::normalize_angle;

use super::map_dynamics::MapDynamics;
use super::remote_tanks::RemoteTanks;
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
    /// дистанция спекулятивного контакта — та же, что хост отдаёт Rapier
    /// (`motion::contact_prediction`)
    prediction: f32,
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
    /// визуальная высота 0..1 (рампа/падение) и дискретный уровень —
    /// предсказанные теми же правилами, что считает хост
    pub z: f32,
    pub level: u8,
    /// танк падает (ввод заблокирован): правило уровня сброшенной бомбы
    /// (`level::bomb_level`) обязано видеть его так же, как хост
    pub falling: bool,
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
    levels: Option<Rc<MapLevels>>,
    /// Уровень/высота/переход своего танка. Считается теми же функциями
    /// `crate::level`, что и на хосте, — иначе реплика уедет от
    /// авторитетного уровня и на границе рампы танк начнёт мигать между
    /// слоями
    level_state: LevelState,
    level_rules: LevelRules,
    /// Авторитетные `(z, level)` своего танка из последнего сырого кадра:
    /// уровень и фаза падения принадлежат хосту, реплика их только
    /// доигрывает (см. `correct_level`)
    authoritative_level: Option<(f32, u8)>,
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

    /// История состояния уровня по шагам (локальное время шага). Реплей
    /// начинается с авторитетной ПОЗИЦИИ, а `LevelState` — не позиция: его
    /// `prev_cell` и вердикт гейта продолжались с конца прошлого реплея, и
    /// на клетке входа в прогон гейт щёлкал только у клиента. Снапшот
    /// откатывает состояние уровня туда же, куда откатывается позиция
    level_history: VecDeque<(f64, LevelState)>,
    /// Локальное время шага, который сейчас считается (живого или
    /// переигранного): им подписываются снапшоты уровня
    step_time: f64,

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
        level_rules: LevelRules,
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
            levels: None,
            level_state: LevelState::default(),
            level_rules,
            authoritative_level: None,
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
            level_history: VecDeque::new(),
            step_time: 0.0,
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
            let (width, height) = motion::body_size(model);
            // размер танка, в отличие от динамики карты, картой не масштабируется
            let mass = box_mass_properties(width, height, model.fixture.density);

            Shape {
                half_w: width / 2.0,
                half_h: height / 2.0,
                inv_mass: mass.inv_mass,
                inv_inertia: mass.inv_inertia,
                prediction: motion::contact_prediction(width, height),
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

    /// Подсистема динамики карты, если она зарегистрирована: её геометрию
    /// читают потребители за WASM-границей (рендерные боксы эффектов) и
    /// raycast выстрела (симуляционные).
    pub fn map_dynamics(&self) -> Option<&MapDynamics> {
        self.sets
            .iter()
            .find_map(|set| set.as_any().downcast_ref::<MapDynamics>())
    }

    pub fn map_dynamics_mut(&mut self) -> Option<&mut MapDynamics> {
        self.sets
            .iter_mut()
            .find_map(|set| set.as_any_mut().downcast_mut::<MapDynamics>())
    }

    /// Подсистема чужих танков, если она зарегистрирована: её корпуса —
    /// цели raycast выстрела (симуляционные боксы).
    pub fn remote_tanks(&self) -> Option<&RemoteTanks> {
        self.sets
            .iter()
            .find_map(|set| set.as_any().downcast_ref::<RemoteTanks>())
    }

    /// Та же подсистема на запись: ей задают свой gameId (исключение из
    /// множества) и сбрасывают её по CLEAR/MAP_DATA.
    pub fn remote_tanks_mut(&mut self) -> Option<&mut RemoteTanks> {
        self.sets
            .iter_mut()
            .find_map(|set| set.as_any_mut().downcast_mut::<RemoteTanks>())
    }

    /// Геометрия карты (MAP_DATA) — слои, стены и рампы для сбора контактов
    /// и правил уровня. Структуру строит `TanksClient::set_map` и отдаёт её
    /// же предсказанию выстрела: разбирать JSON здесь второй раз нельзя,
    /// иначе луч и контакт могут разъехаться.
    pub(crate) fn set_map(&mut self, cfg: &super::ClientMapConfig, levels: Rc<MapLevels>) {
        // геометрия динамики — целиком из этой карты (см. map_dynamics.rs:
        // сброса по CLEAR у неё намеренно нет)
        let fall = level::fall_model(&self.level_rules);

        if let Some(dynamics) = self.map_dynamics_mut() {
            dynamics.set_map(cfg);
            dynamics.set_levels(Rc::clone(&levels), fall);
        }

        self.levels = Some(levels);
    }

    /// Геометрия карты предикта — для проверки того, что обе клиентские
    /// подсистемы получили одну и ту же карту.
    #[cfg(test)]
    pub(crate) fn levels(&self) -> Option<&Rc<MapLevels>> {
        self.levels.as_ref()
    }

    /// Авторитетные высота и уровень своего танка из сырого кадра.
    /// Запоминаются целиком (фазу падения по ним восстановит
    /// `on_server_state`), а поправка уровня применяется только вне
    /// перехода: на рампе реплика идёт впереди кадра, и коррекция тянула бы
    /// подъём назад каждым тиком.
    pub fn correct_level(&mut self, z: f32, level: u8) {
        self.authoritative_level = Some((z, level));

        if matches!(self.level_state.transit, Transit::Grounded) && self.level_state.level != level
        {
            self.level_state.level = level;
            self.level_state.z = level as f32;
        }
    }

    /// Предсказанное состояние уровня своего танка.
    pub fn level_state(&self) -> LevelState {
        self.level_state
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
        self.level_state = LevelState::default();
        self.authoritative_level = None;
        // до прихода следующего player-блока рендерить нечего: иначе предикт
        // дорисовывает актора в позиции уже несуществующего мира
        self.has_state = false;
        self.history.clear();
        self.level_history.clear();
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

        // линейное затухание визуальной ошибки за `1/ERROR_DECAY_RATE`
        // секунды: на кадре длиннее 100 мс ошибка снимается целиком
        // (тот же закон у тел PredictedSet::decay_error)
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
            self.accumulator -= self.step_ms;
            // остаток аккумулятора — это время ПОСЛЕ шага, поэтому шаг
            // подписывается им же: реконсиль ищет снапшот по этому времени
            self.step_time = local_now - self.accumulator;
            self.step(keys);
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

        // состояние уровня откатывается туда же, куда позиция: `prev_cell`
        // и вердикт гейта обязаны отвечать шагу, на котором снят кадр, а не
        // концу прошлого реплея — иначе на клетке входа в прогон гейт
        // щёлкает только у клиента
        self.rewind_level_state(server_time - offset);

        // фаза падения берётся из кадра (`z` ниже своего уровня = танк в
        // воздухе), а не из прошлой ветки предсказания: иначе высота своего
        // танка определялась бы длиной реплея — при скачке RTT она дёргалась
        // бы, а на длинном реплее падение доигрывалось бы раньше времени.
        //
        // На прогоне рампы `z` тоже ниже своего уровня (level = z.round()),
        // но теперь об этом спрашивают не карту под авторитетной позицией, а
        // откаченное состояние: поднимающийся по прогону не падает по
        // определению — тот же вопрос, на который отвечает хост
        // вердикт гейта («поднимаюсь законно») — из откаченного состояния,
        // а сам факт «стою на прогоне» — из КАРТЫ под авторитетной позицией:
        // хост не начинает падение на клетке прогона вовсе
        // (`level::step_layered` спрашивает `ramp_at` раньше любых проверок
        // опоры), а на крутом прогоне 0 → 2 высота дробная по определению.
        // Без карты реплика читала бы эту дробную высоту как «танк в
        // воздухе», запирала ввод и на каждом кадре теряла газ, который хост
        // в это время набирал
        let climbing = self.level_state.on_ramp();
        let on_ramp = climbing
            || self.levels.as_ref().is_some_and(|levels| {
                levels.ramp_at(self.state.x, self.state.y).is_some()
            });
        // и ровно так же, как у хоста, падение начинается только там, где
        // под телом нет плиты своего уровня: кадр, снятый на прогоне, может
        // приехать к реплике, уже съехавшей с него, и «z ниже уровня» тогда
        // говорит лишь о запаздывании кадра
        let has_floor = |z_level: u8| {
            self.levels
                .as_ref()
                .is_some_and(|levels| levels.has_floor(z_level, self.state.x, self.state.y))
        };
        let airborne = self.authoritative_level.filter(|&(z, level)| {
            !on_ramp && level >= 1 && z < level as f32 && !has_floor(level)
        });

        if let Some((z, level)) = airborne {
            // куда падаем, решает та же геометрия, что у хоста: под обрывом
            // может лежать не земля, а плита нижнего уровня
            let to = self
                .levels
                .as_ref()
                .map_or(0, |levels| levels.landing_level(level, self.state.x, self.state.y));

            self.level_state.level = level;
            self.level_state.z = z;
            self.level_state.transit = Transit::Falling {
                elapsed: level::fall_elapsed(z, level, to, &self.level_rules),
                from: level,
                to,
            };
        } else if !climbing
            && let Transit::Falling { .. } = self.level_state.transit
        {
            // кадр говорит, что танк уже на опоре: доигрывать своё падение
            // реплике нечего
            self.level_state.transit = Transit::Grounded;
        }

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

            self.step_time = t - offset;
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
            z: self.level_state.z,
            level: self.level_state.level,
            falling: self.level_state.input_locked(),
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
        self.step_inner(keys);
        // снапшот пишется ВСЕГДА, включая ранние выходы шага (нет модели):
        // дыра в истории означала бы откат к состоянию другого шага
        self.push_level_snapshot();
    }

    fn step_inner(&mut self, keys: u32) {
        let dt = (self.step_ms / 1000.0) as f32;

        self.step_level(dt);

        let Some(model) = &self.model else {
            return;
        };

        // падение: ввод игнорируется ЦЕЛИКОМ — зеркало раннего выхода
        // `Tank::update`. Хост в падении не двигает ни башню, ни газ, ни
        // тягу: клавиши остаются нажатыми и подхватятся при приземлении.
        // Реплика с обнулённой маской вместо раннего выхода доводила
        // центрирование башни, спускала газ и тормозила тягой — все три
        // расхождения тихо копились на каждом падении
        let damping = (model.damping.linear, model.damping.angular);

        if self.level_state.input_locked() {
            self.engine_load = 0.0;
            self.resolve_world(dt);
            self.integrate(damping.0, damping.1, dt);

            return;
        }

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
        let grade = self.level_state.grade(cos, sin);
        let accel = motion::drive_accel(
            self.state.throttle,
            forward,
            back,
            forward_speed,
            grade,
            model,
            &self.level_rules,
        );
        let forward_dv = accel * dt;

        self.state.vx += cos * forward_dv - sin * lateral_dv;
        self.state.vy += sin * forward_dv + cos * lateral_dv;

        self.engine_load = motion::engine_load(self.state.throttle, forward_speed, model);

        self.state.angvel += motion::turn_delta(left, right, forward_speed, model, dt);

        // контакты решаются ДО интеграции позиции — тот же порядок, что у
        // Rapier: контакт строится на позе НАЧАЛА шага с запасом
        // `soft_ccd_prediction`, скорости правятся импульсами, и только
        // потом тело едет. Обратный порядок уводил реплику внутрь стены на
        // целый шаг (до 1.24 юнита на полном ходу): плечо единственной
        // точки контакта получалось другим, чем у хоста, и предсказание
        // молча расходилось с сервером на касательных ударах
        self.resolve_world(dt);

        self.integrate(damping.0, damping.1, dt);
    }

    // интеграция и затухание (эмпирический порядок Rapier, зафиксирован
    // паритет-тестом: позиция интегрируется скоростью до демпфирования,
    // хранится задемпфированная скорость). Тела предсказанных подсистем
    // едут тем же шагом и в том же порядке: импульсы уже решены выше
    fn integrate(&mut self, linear: f32, angular: f32, dt: f32) {
        self.state.x += self.state.vx * dt;
        self.state.y += self.state.vy * dt;
        self.state.angle = normalize_angle(self.state.angle + self.state.angvel * dt);

        self.state.vx *= 1.0 / (1.0 + dt * linear);
        self.state.vy *= 1.0 / (1.0 + dt * linear);
        self.state.angvel *= 1.0 / (1.0 + dt * angular);

        for set in &mut self.sets {
            set.integrate_predicted(dt);
        }
    }

    // снапшот состояния уровня после шага; хранится столько же, сколько
    // история ввода — реплей длиннее неё невозможен
    fn push_level_snapshot(&mut self) {
        let min_time = self.step_time - HISTORY_MAX_AGE;

        while self.level_history.front().is_some_and(|(t, _)| *t < min_time) {
            self.level_history.pop_front();
        }

        self.level_history.push_back((self.step_time, self.level_state));
    }

    // откатывает состояние уровня к шагу, на котором снят кадр: всё, что
    // было предсказано позже, реплей посчитает заново
    fn rewind_level_state(&mut self, local_time: f64) {
        while self
            .level_history
            .back()
            .is_some_and(|(t, _)| *t > local_time)
        {
            self.level_history.pop_back();
        }

        if let Some((_, state)) = self.level_history.back() {
            self.level_state = *state;
        }
    }

    /// Правила уровня одного шага — до применения ввода, ровно как в
    /// TanksSim::update_levels: иначе шаг падения посчитался бы по позиции,
    /// которую ввод уже сдвинул. Событие приземления реплика игнорирует:
    /// урон авторитетен и приедет кадром панели.
    fn step_level(&mut self, dt: f32) {
        let Some(levels) = &self.levels else {
            return;
        };

        level::step_level(
            &mut self.level_state,
            self.state.x,
            self.state.y,
            levels,
            &self.level_rules,
            dt,
        );
    }

    /// Столкновения одного шага: свой танк, предсказанные тела подсистем и
    /// стены разрешаются в ОДНОЙ симуляции — потому нарисованный танк и
    /// нарисованное тело не выдавливают друг друга.
    /// Без карты и без подсистем — полный no-op (см. инвариант в структуре).
    fn resolve_world(&mut self, dt: f32) {
        // заморожен — танком владеет сервер: уничтоженный корпус ничего не
        // толкает, а захват тел в предсказание привязал бы их к нему
        // (см. release_predicted). Проверка защитная: при `frozen` сюда не
        // доходит `update`, второго пути вызова искать не нужно
        if self.frozen || (self.levels.is_none() && self.sets.is_empty()) {
            return;
        }

        let (Some(model), Some(shape)) = (&self.model, &self.shape) else {
            return;
        };

        let local_now = self.local_now;
        // дистанция спекулятивного контакта — одна на все пары шага, как у
        // хоста: `soft_ccd_prediction` стоит на теле танка
        let prediction = shape.prediction;
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
        // маска уровней своего танка: в падении это группа статики — тел
        // падающий не задевает, но стены обоих уровней задевает (то же
        // правило, что у хоста в `level::LevelState::collision_mask`)
        let tank_mask = self.level_state.collision_mask();
        let mut geometry = vec![(tank_obb.half_w, tank_obb.half_h)];
        let mut surfaces = vec![Surface {
            friction: model.fixture.friction,
            restitution: model.fixture.restitution,
        }];

        // захват и шаг предсказанных подсистем (ящики карты, чужие танки)
        let mut bodies = Vec::new();

        for set in &mut self.sets {
            set.capture(&tank_obb, local_now);

            for body in set.predicted_bodies_mut() {
                sim.push(body.body);
                geometry.push((body.half_w, body.half_h));
                surfaces.push(body.surface);
                bodies.push(body);
            }
        }

        let movable = sim.len();
        // импульсы идут по КАЖДОЙ точке манифольда, а позиционная коррекция —
        // по одной (самой глубокой) точке пары: развод по обеим точкам
        // растолкал бы тела вдвое
        let mut contacts: Vec<(usize, usize, Contact, Surface, ContactImpulses)> = Vec::new();
        let mut separations: Vec<(usize, usize, Contact)> = Vec::new();

        // маска тела шага: индекс 0 — свой танк (переход по рампе даёт все
        // уровни прогона), остальные — правило движка
        // (`body_collision_mask`): на опоре свой уровень, в падении только
        // статика. Тела разных уровней друг друга не касаются: танк на
        // мосту не толкает ящик под мостом
        let mut masks = Vec::with_capacity(movable);

        masks.push(tank_mask);
        masks.extend(bodies.iter().map(|body| body.collision_mask()));

        // контакты со стенами (партнёр — статика в точке задетого тайла):
        // стены собираются по КАЖДОМУ уровню из маски тела
        if let Some(levels) = &self.levels {
            for index in 0..movable {
                let mask = masks[index];
                let obb = Box2 {
                    x: sim[index].x,
                    y: sim[index].y,
                    angle: sim[index].angle,
                    half_w: geometry[index].0,
                    half_h: geometry[index].1,
                };

                for level in 0..levels.level_count() as u8 {
                    // стена уровня несёт свою группу И группу статики
                    // (`static_level_interaction` в движке), поэтому маска
                    // падающего собирает стены всех уровней
                    if !mask.intersects(level_group(level) | STATIC_LEVEL_GROUP) {
                        continue;
                    }

                    // стены берутся СКЛЕЕННЫМИ блоками — той же геометрией,
                    // по которой хост поставил коллайдеры
                    // (`GameMap::create_static`). Поклеточный сбор давал
                    // корпусу на длинной стене несколько контактов там, где у
                    // хоста один, и касательный удар об угол разрешался по
                    // другой оси — предсказание расходилось молча
                    let hits =
                        collect_block_contacts(&obb, levels.static_blocks(level), prediction);

                    for hit in hits {
                        let partner = sim.len();

                        sim.push(static_body(hit.block_x, hit.block_y));
                        geometry.push((0.0, 0.0));
                        surfaces.push(MAP_SURFACE);
                        push_manifold(
                            &mut contacts,
                            &mut separations,
                            index,
                            partner,
                            &hit.manifold,
                            combine_surfaces(&surfaces[index], &MAP_SURFACE),
                        );
                    }
                }
            }

            // стражи прогонов рампы: борта и «неправильный» торец. Их
            // геометрии нет ни в одном гриде — хост ставит их отдельными
            // коллайдерами (`GameMap::create_ramp_guards`), поэтому реплика
            // обязана собрать их теми же формулами: иначе предсказание
            // въезжает на прогон сбоку там, где хост держит
            let climbing = self.level_state.on_ramp();
            let thickness = levels.tile_size() * 0.1;
            // огораживается БЛОК полос широкой горки, а не каждая полоса:
            // борта ставятся по внешним границам блока, торец — один во всю
            // его ширину (`GameMap::create_ramp_guards`)
            let mut blocks: Vec<RampRun> = Vec::new();

            for run in levels.runs() {
                if let Some(block) = blocks.iter_mut().find(|block| block.block == run.block) {
                    block.cross_min = block.cross_min.min(run.cross_min);
                    block.cross_max = block.cross_max.max(run.cross_max);
                } else {
                    blocks.push(run.clone());
                }
            }

            for run in &blocks {
                let low = run.from.min(run.to);
                let half_main = (run.max - run.min) / 2.0;
                let half_cross = (run.cross_max - run.cross_min) / 2.0;
                let main = (run.min + run.max) / 2.0;
                let cross = (run.cross_min + run.cross_max) / 2.0;
                // «неправильный» торец — дальний по ходу подъёма
                let far = if run.sign > 0 { run.max } else { run.min };
                let guard = |main: f32, cross: f32, half_main: f32, half_cross: f32| {
                    let (x, y) = if run.axis == 0 {
                        (main, cross)
                    } else {
                        (cross, main)
                    };
                    let (half_w, half_h) = if run.axis == 0 {
                        (half_main, half_cross)
                    } else {
                        (half_cross, half_main)
                    };

                    Box2 {
                        x,
                        y,
                        angle: 0.0,
                        half_w,
                        half_h,
                    }
                };
                let guards = [
                    guard(main, run.cross_min, half_main, thickness / 2.0),
                    guard(main, run.cross_max, half_main, thickness / 2.0),
                    guard(far, cross, thickness / 2.0, half_cross),
                ];

                for index in 0..movable {
                    // страж существует только для тел уровня, с которого
                    // прогон начинается, и законно поднимающийся проходит
                    // его насквозь (`map::body_filter`)
                    if !masks[index].intersects(level_group(low)) || (index == 0 && climbing) {
                        continue;
                    }

                    let obb = Box2 {
                        x: sim[index].x,
                        y: sim[index].y,
                        angle: sim[index].angle,
                        half_w: geometry[index].0,
                        half_h: geometry[index].1,
                    };

                    for box2 in &guards {
                        // стражи собираются тем же манифольдом с зазором, что
                        // и стены: иначе они держали бы не на том шаге и не
                        // тем плечом
                        let Some(manifold) = obb_manifold(&obb, box2, prediction) else {
                            continue;
                        };
                        let partner = sim.len();

                        sim.push(static_body(box2.x, box2.y));
                        geometry.push((0.0, 0.0));
                        surfaces.push(MAP_SURFACE);
                        push_manifold(
                            &mut contacts,
                            &mut separations,
                            index,
                            partner,
                            &manifold,
                            combine_surfaces(&surfaces[index], &MAP_SURFACE),
                        );
                    }
                }
            }
        }

        // свой танк ↔ каждое предсказанное тело и все пары между собой
        for a in 0..movable {
            for b in (a + 1)..movable {
                // тела разных уровней не касаются
                if (masks[a] & masks[b]).is_empty() {
                    continue;
                }

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

                if let Some(manifold) = obb_manifold(&obb_a, &obb_b, prediction) {
                    push_manifold(
                        &mut contacts,
                        &mut separations,
                        a,
                        b,
                        &manifold,
                        combine_surfaces(&surfaces[a], &surfaces[b]),
                    );
                }
            }
        }

        if !contacts.is_empty() {
            // развод по глубине — ровно один раз на ПАРУ: повтор на каждой
            // итерации (или на каждой точке манифольда) расталкивал бы тела
            // кратно их числу
            for (a, b, contact) in &separations {
                let (body_a, body_b) = pair_mut(&mut sim, *a, *b);

                separate_bodies(body_a, body_b, contact);
            }

            // контакты собраны один раз, импульсы проходят по ним несколько
            // раз — это же заменяет внутренние итерации выталкивания из
            // тайловой сетки
            for _ in 0..SOLVER_ITERATIONS {
                for (a, b, contact, surface, acc) in &mut contacts {
                    let (body_a, body_b) = pair_mut(&mut sim, *a, *b);

                    apply_contact_impulse(body_a, body_b, contact, surface, dt, acc);
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
        for (a, b, ..) in &contacts {
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

// точки манифольда пары в списки шага: импульсы получает каждая точка,
// позиционную коррекцию — только самая глубокая
fn push_manifold(
    contacts: &mut Vec<(usize, usize, Contact, Surface, ContactImpulses)>,
    separations: &mut Vec<(usize, usize, Contact)>,
    a: usize,
    b: usize,
    manifold: &Manifold,
    surface: Surface,
) {
    separations.push((a, b, manifold.deepest()));

    for point in manifold.as_slice() {
        contacts.push((a, b, *point, surface, ContactImpulses::default()));
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
        let mut p = Predictor::new(STEP_MS, &cfg.player_keys, &cfg.models, cfg.levels);

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
            let mut p = Predictor::new(10.0, &cfg.player_keys, &cfg.models, cfg.levels);

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

    // карта подаётся так же, как её подаёт TanksClient::set_map: разбор
    // один, сетка одна на все подсистемы
    pub fn apply_map(p: &mut Predictor, json: &str) {
        let mut cfg: super::super::ClientMapConfig = serde_json::from_str(json).unwrap();
        let levels = Rc::new(cfg.take_levels());

        p.set_map(&cfg, levels);
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

        fn as_any(&self) -> &dyn std::any::Any {
            self
        }

        fn as_any_mut(&mut self) -> &mut dyn std::any::Any {
            self
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

        apply_map(
            &mut reference,
            &serde_json::json!({
                "step": 40, "scale": 1, "map": [[0]],
                "physicsStatic": [], "physicsDynamic": []
            })
            .to_string(),
        );

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

        apply_map(&mut p, &wall_grid());
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

        apply_map(&mut p, &wall_grid());
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

    // — 2.5D: уровни, рампы, падение —

    // слоёная карта 6×6 клеток по 40 юнитов (тот же формат, что MAP_DATA):
    //   колонка 1 — перила уровня 1 (тайл 4) без плиты;
    //   колонка 2 — рампа на восток (тайл 3);
    //   колонки 3–4 — плита моста (тайл 2);
    //   колонка 5 — стена уровня 0 (тайл 1)
    fn layered_map() -> String {
        serde_json::json!({
            "step": 40,
            "scale": 1,
            "map": vec![vec![0, 0, 3, 0, 0, 1]; 6],
            "physicsStatic": [1],
            "physicsDynamic": [],
            "levels": {
                "1": {
                    "map": vec![vec![0, 4, 0, 2, 2, 0]; 6],
                    "floor": [2],
                    "walls": [4],
                },
            },
            "ramps": [{ "tile": 3, "dir": "east", "from": 0, "to": 1 }],
        })
        .to_string()
    }

    // реплика обязана считать уровень ровно теми же функциями, что хост
    fn reference_level(p: &Predictor, from: LevelState, x: f32, y: f32) -> LevelState {
        let levels = Rc::clone(p.levels().unwrap());
        let mut state = from;

        level::step_level(
            &mut state,
            x,
            y,
            &levels,
            &p.level_rules,
            (STEP_MS / 1000.0) as f32,
        );

        state
    }

    // ШИРОКАЯ горка: блок тайлов рампы 2 клетки в длину и 3 в ширину.
    // Движок режет его на три полосы-прогона, и КАЖДЫЙ прогон получает
    // борта-стражи по обеим своим поперечным границам — то есть внутренние
    // границы блока тоже огорожены. Этой картой проверяется, что заезд с
    // подножия широкой горки реплика не блокирует.
    fn wide_ramp_map() -> String {
        let mut grid = vec![vec![0, 0, 0, 0, 0, 0]; 6];

        for row in grid.iter_mut().take(4).skip(1) {
            row[2] = 3;
            row[3] = 3;
        }

        serde_json::json!({
            "step": 40,
            "scale": 1,
            "map": grid,
            "physicsStatic": [1],
            "physicsDynamic": [],
            "levels": {
                "1": {
                    "map": vec![vec![0, 0, 0, 0, 2, 2]; 6],
                    "floor": [2],
                    "walls": [],
                },
            },
            "ramps": [{ "tile": 3, "dir": "east", "from": 0, "to": 1 }],
        })
        .to_string()
    }

    #[test]
    fn replica_drives_onto_a_wide_ramp() {
        let mut p = make_predictor();

        apply_map(&mut p, &wide_ramp_map());
        // подножие средней полосы: клетка (1, 2), центр (60, 100)
        p.state.x = 60.0;
        p.state.y = 100.0;
        p.state.vx = 300.0;

        for _ in 0..60 {
            p.step(0);
        }

        assert!(
            p.state.x > 90.0,
            "реплика не пустила танк на широкую горку: x = {}",
            p.state.x
        );
        assert!(
            p.level_state().z > 0.0,
            "подъём не начался: {:?}",
            p.level_state()
        );
    }

    // заезд по ГРАНИЦЕ полос широкой горки: стражи огораживают блок полос
    // целиком, поэтому внутренних бортов нет и танк входит на клин с любой
    // точки подножия, а не только по центру полосы
    #[test]
    fn replica_drives_onto_a_wide_ramp_off_centre() {
        let mut p = make_predictor();

        apply_map(&mut p, &wide_ramp_map());
        // ровно на границе полос 1 и 2: корпус лежит в обеих
        p.state.x = 60.0;
        p.state.y = 80.0;
        p.state.vx = 300.0;

        for _ in 0..60 {
            p.step(0);
        }

        assert!(
            p.state.x > 90.0,
            "танк упёрся во внутренний борт блока: x = {}",
            p.state.x
        );
    }

    #[test]
    fn replica_climbs_the_ramp() {
        let mut p = make_predictor();

        apply_map(&mut p, &layered_map());
        // подъезд к подножию: гейт входа судит вход по прошлой клетке, и
        // без шага перед рампой прогон работал бы как плоскость
        p.state.x = 60.0;
        p.state.y = 100.0;
        p.step(0);

        p.state.x = 90.0; // клетка рампы: x от 80 до 120

        let expected = reference_level(&p, p.level_state(), 90.0, 100.0);

        p.step(0);

        assert_eq!(p.level_state(), expected);
        assert!(matches!(p.level_state().transit, Transit::Ramp { .. }));
        assert!((p.level_state().z - 0.25).abs() < 1e-5);
        assert_eq!(p.level_state().level, 0);

        // вторая половина прогона — уровень щёлкает на середине
        p.state.x = 110.0;

        let expected = reference_level(&p, p.level_state(), 110.0, 100.0);

        p.step(0);

        assert_eq!(p.level_state(), expected);
        assert_eq!(p.level_state().level, 1);

        // с рампы на плиту: переход закончен
        p.state.x = 140.0;
        p.step(0);

        assert_eq!(p.level_state().transit, Transit::Grounded);
        assert_eq!(p.level_state().level, 1);
        assert_eq!(p.level_state().z, 1.0);
    }

    #[test]
    fn a_falling_replica_freezes_the_input_exactly_like_the_host() {
        // `Tank::update` в падении выходит РАНЬШЕ башни, газа и тяги:
        // клавиши остаются нажатыми и подхватятся при приземлении. Реплика
        // с одной лишь обнулённой маской доводила центрирование, спускала
        // газ и тормозила тягой — расхождение копилось на каждом падении
        let mut p = make_predictor();

        p.state.throttle = 1.0;
        p.state.gun_rotation = 0.5;
        p.centering = true;
        p.level_state.transit = Transit::Falling {
            elapsed: 0.0,
            from: 1,
            to: 0,
        };

        p.step(0);

        assert_eq!(p.state.throttle, 1.0, "газ в падении не спускается");
        assert_eq!(p.state.gun_rotation, 0.5, "башня в падении не едет");
        assert_eq!(p.engine_load, 0.0, "нагрузка двигателя обнулена");
    }

    #[test]
    fn replica_falls_off_the_ledge() {
        let mut p = make_predictor();

        apply_map(&mut p, &layered_map());
        p.level_state = LevelState {
            level: 1,
            z: 1.0,
            transit: Transit::Grounded,
            ..LevelState::default()
        };
        p.state.x = 20.0; // колонка 0: плиты нет
        p.state.y = 100.0;
        p.step(0);

        assert!(p.level_state().input_locked());

        // управление заблокировано: газ в падении не действует
        let x_before = p.state.x;

        for _ in 0..10 {
            p.step(p.forward_bit);
        }

        assert_eq!(p.state.x, x_before);

        // приземление за fallTime
        let steps = (p.level_rules.fall_time as f64 / (STEP_MS / 1000.0)).ceil() as usize + 1;

        for _ in 0..steps {
            p.step(0);
        }

        assert_eq!(p.level_state().transit, Transit::Grounded);
        assert_eq!(p.level_state().level, 0);
        assert_eq!(p.level_state().z, 0.0);
    }

    #[test]
    fn falling_replica_hits_walls_but_not_bodies() {
        let mut p = make_predictor();

        apply_map(&mut p, &layered_map());
        p.level_state = LevelState {
            level: 1,
            z: 1.0,
            transit: Transit::Falling {
                elapsed: 0.0,
                from: 1,
                to: 0,
            },
            ..LevelState::default()
        };
        // корпус заходит в стену уровня 0 (колонка 5: x от 200 до 240)
        // (корпус 8×6: левая грань 199, правая — внутри стены)
        p.state.x = 202.0;
        p.state.y = 100.0;
        p.step(0);

        // стена выталкивает: падающий не проходит сквозь здание
        assert!(
            p.state.x < 202.0,
            "стена уровня 0 не задета в падении: x={}",
            p.state.x
        );
    }

    #[test]
    fn falling_replica_ignores_bodies() {
        let mut p = make_predictor();
        let mut set = BoxSet::new(40.0);

        set.set.bodies_mut()["box"].level = 0;

        p.add_predicted_set(Box::new(set));
        p.level_state = LevelState {
            level: 1,
            z: 1.0,
            transit: Transit::Falling {
                elapsed: 0.0,
                from: 1,
                to: 0,
            },
            ..LevelState::default()
        };
        p.state.x = 26.0; // правый край танка 30, левая грань ящика 30
        p.state.y = 20.0;
        p.state.vx = 200.0;

        for _ in 0..30 {
            p.step(0);
        }

        let body = box_body(&mut p).body;

        // ящик не сдвинут: падающий проходит сквозь тела
        assert_eq!(body.x, 40.0);
        assert_eq!(body.vx, 0.0);
    }

    #[test]
    fn tank_and_box_on_different_levels_do_not_touch() {
        let mut p = make_predictor();
        let mut set = BoxSet::new(40.0);

        set.set.bodies_mut()["box"].level = 1; // ящик на мосту, танк на земле

        p.add_predicted_set(Box::new(set));
        p.state.x = 26.0; // правый край танка 30, левая грань ящика 30
        p.state.y = 20.0;
        p.state.vx = 200.0;

        for _ in 0..30 {
            p.step(0);
        }

        let body = box_body(&mut p).body;

        assert_eq!(body.x, 40.0);
        assert_eq!(body.vx, 0.0);
    }

    #[test]
    fn wall_of_the_other_level_is_ignored() {
        let mut p = make_predictor();

        apply_map(&mut p, &layered_map());
        // перила уровня 1 (колонка 1) танку уровня 0 не помеха
        p.state.x = 20.0;
        p.state.y = 100.0;
        p.state.vx = 300.0;

        // ввод удерживается: иначе демпфирование гасит скорость раньше,
        // чем корпус пересечёт колонку перил
        for _ in 0..60 {
            p.step(p.forward_bit);
        }

        assert!(p.state.x > 80.0, "танк застрял на перилах: x={}", p.state.x);
    }

    #[test]
    fn correct_level_only_when_grounded() {
        let mut p = make_predictor();

        apply_map(&mut p, &layered_map());

        // на плоскости кадр перебивает реплику
        p.correct_level(1.0, 1);
        assert_eq!(p.level_state().level, 1);
        assert_eq!(p.level_state().z, 1.0);

        // на рампе — нет: кадр отстаёт на буфер интерполяции
        p.state.x = 90.0;
        p.state.y = 100.0;
        p.step(0);

        let on_ramp = p.level_state();

        p.correct_level(1.0, 1);
        assert_eq!(p.level_state(), on_ramp);
    }

    #[test]
    fn ramp_frame_is_not_read_as_a_fall() {
        // на прогоне уровень щёлкает по `z.round()`, поэтому кадр сплошь и
        // рядом приходит с `z` НИЖЕ своего уровня. Принять это за падение —
        // значит заглушить ввод на половине каждой рампы: тяга реплики
        // уезжает от хоста, и детектор расхождения рвёт порог по throttle
        let mut p = make_predictor();

        apply_map(&mut p, &layered_map());

        // клетка прогона (колонка 2: x от 80 до 120), первая половина
        p.state.x = 90.0;
        p.state.y = 100.0;
        p.step(0);

        assert!(
            matches!(p.level_state().transit, Transit::Ramp { climbing: true, .. }),
            "{:?}",
            p.level_state().transit
        );

        p.correct_level(0.6, 1);
        p.on_server_state([90.0, 100.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], false, 0.0, 0.0, 0.0);

        assert!(
            !p.level_state().input_locked(),
            "подъём по рампе принят за падение: {:?}",
            p.level_state().transit
        );
    }

    #[test]
    fn late_frame_over_a_floor_is_not_read_as_a_fall() {
        // кадр, снятый на прогоне, приезжает к реплике, уже съехавшей с него
        // на плиту: `z` в нём ниже уровня, но под танком пол — падать некуда
        let mut p = make_predictor();

        apply_map(&mut p, &layered_map());

        // плита уровня 1 (колонки 3 и 4: x от 120 до 200)
        p.state.x = 140.0;
        p.state.y = 100.0;
        p.level_state.level = 1;
        p.level_state.z = 1.0;

        p.correct_level(0.9, 1);
        p.on_server_state([140.0, 100.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], false, 0.0, 0.0, 0.0);

        assert!(
            !p.level_state().input_locked(),
            "запоздавший кадр принят за падение: {:?}",
            p.level_state().transit
        );
    }

    #[test]
    fn reconcile_restores_the_fall_phase_from_the_frame() {
        let mut p = make_predictor();

        apply_map(&mut p, &layered_map());
        p.level_state = LevelState {
            level: 1,
            z: 0.75,
            transit: Transit::Falling {
                elapsed: 0.25 * p.level_rules.fall_time,
                from: 1,
                to: 0,
            },
            ..LevelState::default()
        };

        // кадр застал падение на половине высоты
        p.correct_level(0.5, 1);
        p.on_server_state([0.0; 8], false, 0.0, 0.0, 0.0);

        let expected = level::fall_elapsed(0.5, 1, 0, &p.level_rules);

        assert!(
            matches!(p.level_state().transit, Transit::Falling { elapsed, from: 1, to: 0 }
                if (elapsed - expected).abs() < 1e-5),
            "{:?}",
            p.level_state().transit
        );
        assert_eq!(p.level_state().z, 0.5);
        assert_eq!(p.level_state().level, 1);
    }

    #[test]
    fn reconcile_ends_the_fall_when_the_frame_says_grounded() {
        let mut p = make_predictor();

        apply_map(&mut p, &layered_map());
        p.level_state = LevelState {
            level: 1,
            z: 0.5,
            transit: Transit::Falling {
                elapsed: 0.5 * p.level_rules.fall_time,
                from: 1,
                to: 0,
            },
            ..LevelState::default()
        };

        p.correct_level(0.0, 0);
        p.on_server_state([0.0; 8], false, 0.0, 0.0, 0.0);

        assert_eq!(p.level_state().transit, Transit::Grounded);
    }

    // слоёная карта 6×6 с двумя надземными уровнями: колонки 1–2 — плита
    // уровня 3 (и уровней 1–2 под ней), колонка 3 — плита только уровня 1.
    // С кромки уровня 3 в колонке 3 падают не на землю, а на плиту 1
    fn tall_map() -> String {
        let level = |cols: &[usize]| -> Vec<Vec<i32>> {
            (0..6)
                .map(|_| {
                    (0..6)
                        .map(|x| if cols.contains(&x) { 2 } else { 0 })
                        .collect()
                })
                .collect()
        };

        serde_json::json!({
            "step": 40,
            "scale": 1,
            "map": vec![vec![0; 6]; 6],
            "physicsStatic": [1],
            "physicsDynamic": [],
            "levels": {
                "1": { "map": level(&[1, 2, 3]), "floor": [2], "walls": [] },
                "2": { "map": level(&[1, 2]), "floor": [2], "walls": [] },
                "3": { "map": level(&[1, 2]), "floor": [2], "walls": [] },
            },
        })
        .to_string()
    }

    #[test]
    fn reconcile_restores_the_fall_onto_an_intermediate_slab() {
        let mut p = make_predictor();

        apply_map(&mut p, &tall_map());

        // танк сорвался с уровня 3 над колонкой 3 (x от 120 до 160)
        p.level_state = LevelState {
            level: 3,
            z: 2.9,
            transit: Transit::Falling {
                elapsed: 0.1 * p.level_rules.fall_time,
                from: 3,
                to: 1,
            },
            ..LevelState::default()
        };

        // кадр застал падение на половине высоты (3 → 1)
        p.correct_level(2.0, 3);
        p.on_server_state([140.0, 100.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], false, 0.0, 0.0, 0.0);

        let expected = level::fall_elapsed(2.0, 3, 1, &p.level_rules);

        // цель падения — плита уровня 1, а не земля, и фаза не обнулена
        assert!(
            matches!(p.level_state().transit, Transit::Falling { elapsed, from: 3, to: 1 }
                if (elapsed - expected).abs() < 1e-5),
            "{:?}",
            p.level_state().transit
        );
        assert!(expected > 0.0);
        assert_eq!(p.level_state().z, 2.0);
    }

    #[test]
    fn replica_lands_from_level_three_where_the_host_does() {
        let mut p = make_predictor();

        apply_map(&mut p, &tall_map());
        p.level_state = LevelState {
            level: 3,
            z: 3.0,
            transit: Transit::Falling {
                elapsed: 0.0,
                from: 3,
                to: 1,
            },
            ..LevelState::default()
        };
        p.state.x = 140.0;
        p.state.y = 100.0;

        // падение на два уровня длится вдвое дольше падения на один
        let steps =
            (2.0 * p.level_rules.fall_time as f64 / (STEP_MS / 1000.0)).ceil() as usize + 1;

        for _ in 0..steps {
            p.step(0);
        }

        assert_eq!(p.level_state().transit, Transit::Grounded);
        assert_eq!(p.level_state().level, 1);
        assert_eq!(p.level_state().z, 1.0);
    }

    #[test]
    fn ramp_climb_survives_the_replay() {
        let mut p = make_predictor();

        apply_map(&mut p, &layered_map());

        // заход на прогон с торца: подножие (колонка 1), затем клетка рампы
        p.state.x = 60.0;
        p.state.y = 100.0;
        p.step(0);
        p.state.x = 90.0;
        p.step(0);

        assert!(matches!(
            p.level_state().transit,
            Transit::Ramp { climbing: true, .. }
        ));

        // реконсиляция с реплеем трёх шагов: кадр везёт уровень 0 — на
        // рампе он отстаёт, и подъём обязан пережить и его, и реплей
        p.correct_level(0.0, 0);
        p.on_server_state(
            [90.0, 100.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            false,
            0.0,
            0.0,
            3.0 * STEP_MS,
        );

        assert_ne!(p.level_state().prev_cell, (-1, -1), "клетка потеряна реплеем");
        assert!(matches!(
            p.level_state().transit,
            Transit::Ramp { climbing: true, .. }
        ));

        // подъём продолжается: вторая половина прогона щёлкает уровень
        p.state.x = 110.0;
        p.step(0);

        assert_eq!(p.level_state().level, 1);
    }

    #[test]
    fn reconcile_does_not_carry_a_stale_gate_verdict_onto_the_run() {
        let mut p = make_predictor();

        apply_map(&mut p, &layered_map());

        // шаг у подножия прогона (колонка 1, строка 2)
        p.step_time = 0.0;
        p.state.x = 60.0;
        p.state.y = 100.0;
        p.step(0);

        // предсказание убежало вперёд и заехало на прогон ПО ДИАГОНАЛИ
        // (колонка 2, строка 1): гейт такой вход не пускает
        p.step_time = STEP_MS;
        p.state.x = 90.0;
        p.state.y = 60.0;
        p.step(0);

        assert!(
            matches!(
                p.level_state().transit,
                Transit::Ramp { climbing: false, .. }
            ),
            "{:?}",
            p.level_state().transit
        );

        // кадр снят на шаге у подножия и везёт законный вход с торца.
        // Реплей обязан судить его гейтом ЭТОГО шага: без отката состояния
        // уровня отказ диагонального входа наследовался бы прогоном
        p.correct_level(0.0, 0);
        p.on_server_state(
            [90.0, 100.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            false,
            0.0,
            0.0,
            STEP_MS,
        );

        assert!(
            matches!(
                p.level_state().transit,
                Transit::Ramp { climbing: true, .. }
            ),
            "{:?}",
            p.level_state().transit
        );
        assert_eq!(p.level_state().prev_cell, (2, 2));
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
    use super::tests::{apply_map, core_config, engine_config};
    use super::*;
    use crate::tanks::GameState;
    use rapier2d::prelude::*;

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

        let mut predictor = Predictor::new(STEP_MS, &cfg.player_keys, &cfg.models, cfg.levels);

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

    /// Карта-фикстура «длинная стена вдоль строки 31» — та же геометрия, по
    /// которой хост склеивает перила `overpass`: тайл 12.8 (`step` 32 ×
    /// `scale` 0.4), колонки 6..48 строки 31 дают ОДИН блок с центром
    /// (345.6, 403.2) и полуразмерами (268.8, 6.4).
    fn long_wall_map() -> String {
        let rows = 34;
        let cols = 48;
        let grid: Vec<Vec<i32>> = (0..rows)
            .map(|y| {
                (0..cols)
                    .map(|x| i32::from(y == 31 && (6..cols).contains(&x)))
                    .collect()
            })
            .collect();

        serde_json::json!({
            "setId": "c1",
            "step": 32,
            "scale": 0.4,
            "map": grid,
            "physicsStatic": [1],
            "physicsDynamic": [],
            "respawns": {
                "team1": [[100.0, 100.0, 0.0]],
                "team2": [[200.0, 100.0, 0.0]]
            }
        })
        .to_string()
    }

    /// Стартовая поза шага: позиция, угол и скорости, одинаковые у хоста и
    /// реплики бит в бит.
    #[derive(Clone, Copy)]
    struct Pose {
        x: f32,
        y: f32,
        angle: f32,
        vx: f32,
        vy: f32,
        angvel: f32,
    }

    // Прогон core+replica на карте: хост получает карту через
    // `EngineSim::load_map`, реплика — ту же строку через `set_map`, обе
    // стороны стартуют из ОДНОЙ позы (реплика сеется авторитетным
    // состоянием хоста, offset 0 → реплей пуст).
    fn simulate_on_map(
        map_json: &str,
        pose: Pose,
        steps: usize,
        schedule: &[(usize, u32)],
    ) -> ([f32; PLAYER_STATE_LEN], TankState) {
        let cfg = core_config();
        let mut game = GameState::new(engine_config(), &cfg);

        game.load_map(map_json).unwrap();
        game.spawn_actor(1, "m1", 1, pose.x, pose.y, 0.0).unwrap();

        {
            let handle = game.sim.tanks[&1].body;
            let body = &mut game.world.bodies[handle];

            body.set_rotation(Rotation::new(pose.angle), true);
            body.set_linvel(Vector::new(pose.vx, pose.vy), true);
            body.set_angvel(pose.angvel, true);
        }

        let seed = {
            let tank = &game.sim.tanks[&1];
            let (state, _) = tank.prediction_state(&game.world.bodies[tank.body]);

            state
        };

        let mut predictor = Predictor::new(STEP_MS, &cfg.player_keys, &cfg.models, cfg.levels);

        predictor.set_model("m1");
        predictor.set_active(true);
        apply_map(&mut predictor, map_json);
        predictor.on_server_state(seed, false, 0.0, 0.0, 0.0);

        let mut current_mask = 0u32;

        for i in 0..steps {
            if let Some((_, mask)) = schedule.iter().find(|(step, _)| *step == i) {
                current_mask = *mask;
            }

            game.step(DT);
            predictor.step(current_mask);
        }

        let tank = &game.sim.tanks[&1];
        let (state, _) = tank.prediction_state(&game.world.bodies[tank.body]);

        (state, predictor.state)
    }

    // покомпонентная разница с допусками сценария `bridge.json`
    // (`divergence.thresholds`): пороги и есть определение «предсказание
    // совпало с сервером», ослаблять их нельзя
    fn expect_scenario_thresholds(core: [f32; PLAYER_STATE_LEN], replica: TankState) {
        let got = replica.to_array();
        let names = ["x", "y", "angle", "vx", "vy", "angvel"];
        let thresholds = [3.0, 3.0, 0.06, 25.0, 25.0, 1.5];
        let mut broken = Vec::new();

        for (index, threshold) in thresholds.iter().enumerate() {
            let delta = (got[index] - core[index]).abs();

            if delta > *threshold {
                broken.push(format!(
                    "{}: Δ{:.4} > {} (replica {:.4}, core {:.4})",
                    names[index], delta, threshold, got[index], core[index]
                ));
            }
        }

        assert!(broken.is_empty(), "расхождение с хостом: {}", broken.join("; "));
    }

    // поза кадра `bridge.json` (serverTime 1700000003500), с которой
    // касательный удар об угол перил разводил предсказание с сервером
    fn grazing_pose() -> Pose {
        Pose {
            x: 72.61,
            y: 395.07,
            angle: 0.0,
            vx: 148.85,
            vy: 0.87,
            angvel: 0.0,
        }
    }

    // Касательный удар об угол длинной стены на полном ходу. Хост видит
    // СПЕКУЛЯТИВНЫЙ контакт до перекрытия (`soft_ccd_prediction` =
    // min(width, height)) и ведёт по паре манифольд из двух точек; реплика
    // раньше интегрировала позицию внутрь стены, реагировала уже изнутри и
    // ставила ЕДИНСТВЕННУЮ точку в середину грани — плеча не было вовсе,
    // и корпус не разворачивался там, где сервер его разворачивал.
    //
    // Горизонт прогона — 4 шага: ровно столько реплика идёт свободно между
    // авторитетными кадрами (снапшот 30 Гц при шаге 120 Гц), и на этом же
    // горизонте контракт `predictionDrift` сравнивает её с сервером.
    #[test]
    fn grazing_corner_hit_matches_the_host() {
        let (core, replica) = simulate_on_map(&long_wall_map(), grazing_pose(), 4, &[]);

        expect_scenario_thresholds(core, replica);
    }

    // Кадр самого удара: до правки реплика на нём не разворачивалась совсем
    // (замер: `angvel` 0.000 против 5.521 у хоста).
    #[test]
    fn the_hit_frame_spins_the_hull_like_the_host() {
        let (core, replica) = simulate_on_map(&long_wall_map(), grazing_pose(), 1, &[]);

        expect_scenario_thresholds(core, replica);
        assert!(
            replica.angvel > core[5] / 2.0,
            "реплика обязана развернуться вместе с хостом: {} против {}",
            replica.angvel,
            core[5]
        );
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
