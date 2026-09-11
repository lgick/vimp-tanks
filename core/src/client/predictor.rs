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
use rapier2d::prelude::Group;

use crate::config::{KeyConfig, LevelRules, ModelConfig};
use crate::level::{self, Footprint, LevelState, Transit, LEVEL_EPSILON};
use crate::motion::{self, TurretInput};
use vimp_engine_core::client::collision::{
    BlockContact, Contact, Manifold, collect_block_contacts_into, obb_manifold,
};
use vimp_engine_core::client::raycast::Box2;
use vimp_engine_core::client::rigid_body::{
    Body, ContactImpulses, MAP_SURFACE, Surface, apply_contact_impulse, box_mass_properties,
    combine_surfaces, separate_bodies,
};
use vimp_engine_core::config::PLAYER_STATE_LEN;
use vimp_engine_core::map::{MapLevels, RampGuard, STATIC_LEVEL_GROUP, level_group, ramp_guards};
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
    /// наклон корпуса: предсказан теми же функциями `motion`, что считает
    /// хост, — рендер своего танка не ждёт кадра
    pub pitch: f32,
    pub roll: f32,
    /// вертикальная скорость полёта (уровней/с, 0 на земле)
    pub vz: f32,
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
    /// Стражи прогонов рампы текущей карты: геометрия зависит только от неё,
    /// а шаг зовётся 120 раз в секунду плюс на каждом шаге реплея. Считается
    /// движком (`map::ramp_guards`) — формула одна на хост и на реплику.
    guards: Vec<RampGuard>,

    // буферы шага: `resolve_world` зовётся 120 раз в секунду плюс на каждом
    // шаге реплея, и вектор на каждый вызов — чистая нагрузка на аллокатор.
    // Берутся через `mem::take`, потому что шаг одновременно держит `&mut
    // self.sets`
    sim: Vec<Body>,
    geometry: Vec<(f32, f32)>,
    surfaces: Vec<Surface>,
    masks: Vec<Group>,
    contacts: Vec<(usize, usize, Contact, Surface, ContactImpulses)>,
    separations: Vec<(usize, usize, Contact)>,
    block_hits: Vec<BlockContact>,

    /// Уровень/высота/переход своего танка. Считается теми же функциями
    /// `crate::level`, что и на хосте, — иначе реплика уедет от
    /// авторитетного уровня и на границе рампы танк начнёт мигать между
    /// слоями
    level_state: LevelState,
    level_rules: LevelRules,
    /// Авторитетные `(z, level, vz)` своего танка из последнего сырого
    /// кадра: уровень и фаза полёта принадлежат хосту, реплика их только
    /// доигрывает (см. `correct_level`). Вертикальная скорость приезжает
    /// явно, потому что по высоте фаза баллистики неоднозначна — одному
    /// `z` отвечают и подъём, и снижение
    authoritative_level: Option<(f32, u8, f32)>,
    /// Сколько кадров подряд авторитетный уровень держится ВЫШЕ уровня
    /// реплики. Подъём принимается только по стойкому несогласию
    /// (`LevelRules::level_adopt_frames`): одиночный кадр выше — это
    /// запаздывание, а не подъём (см. `correct_level`)
    level_disagreement: u8,
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
    /// Наклон корпуса реплики, рад. Живёт отдельно от `TankState`: тот
    /// позиционно связан с `PLAYER_STATE_LEN = 8` и меняться не может.
    pitch: f32,
    roll: f32,

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
            guards: Vec::new(),
            sim: Vec::new(),
            geometry: Vec::new(),
            surfaces: Vec::new(),
            masks: Vec::new(),
            contacts: Vec::new(),
            separations: Vec::new(),
            block_hits: Vec::new(),
            level_state: LevelState::default(),
            level_rules,
            authoritative_level: None,
            level_disagreement: 0,
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
            pitch: 0.0,
            roll: 0.0,
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

        self.guards = ramp_guards(&levels);
        self.levels = Some(levels);

        // геометрия сменилась: клетка входа, вердикт гейта и вся история
        // уровня относятся к СТАРОЙ карте. Оставить их — значит судить вход
        // на прогон новой карты по клетке прежней (см. `entry_is_legal`), а
        // `rewind_level_state` восстановил бы снимок, снятый на другой
        // геометрии, обойдя ветку «истории нет, берём из кадра»
        self.level_state = LevelState::default();
        self.level_history.clear();
        self.authoritative_level = None;
        self.level_disagreement = 0;
    }

    /// Геометрия карты предикта: по ней же рендер берёт прогоны рамп
    /// (`ClientCore::ramp_runs`), и по ней проверяется, что обе клиентские
    /// подсистемы получили одну и ту же карту.
    pub(crate) fn levels(&self) -> Option<&Rc<MapLevels>> {
        self.levels.as_ref()
    }

    /// Авторитетные высота и уровень своего танка из сырого кадра.
    /// Запоминаются целиком (фазу падения по ним восстановит
    /// `on_server_state`), а поправка уровня применяется только вне
    /// перехода: на рампе реплика идёт впереди кадра, и коррекция тянула бы
    /// подъём назад каждым тиком.
    ///
    /// Сам по себе кадр уровень реплики НЕ перебивает: за ним всегда идёт
    /// `on_server_state`, который откатывает состояние на шаг кадра и
    /// переигрывает ввод — там уровень и пересчитывается теми же правилами,
    /// что у хоста (`ClientGame::push_frame`: `begin_reconcile` вызывается
    /// только вместе с player-блоком). Кадр применяется как есть лишь там,
    /// где откатываться некуда, — см. `rewind_level_state`.
    ///
    /// Прежняя поправка «вне перехода принять уровень кадра» ломала спуск:
    /// кадры в полёте несут ещё ВЕРХНИЙ уровень, и уже приземлившуюся
    /// реплику подбрасывало обратно на мост (`level = 1, z = 1`). Дальше
    /// чужим уровнем считалось всё: маска коллизий била танк о перила,
    /// которых для него у хоста нет, а рендер давал корпусу масштаб и тинт
    /// эстакады.
    pub fn correct_level(&mut self, authoritative: Option<(f32, u8, f32)>) {
        // `None` — своей строки в кадре нет (танк уничтожен, частичный
        // CLEAR, null-маркер): прошлое значение обязано уйти, иначе ветки
        // `airborne`, «понижение» и «истории нет» в `rewind_level_state`
        // продолжали бы действовать по протухшим данным
        self.authoritative_level = authoritative;

        if authoritative.is_none() {
            self.level_disagreement = 0;
        }
    }

    /// Взять уровень и высоту из кадра как есть. Зовётся там, где
    /// предсказания уровня ещё нет и переигрывать нечего
    /// (`TanksClient::track_frame`): первый кадр со своим танком и
    /// респаун (`condition` 0 → живой) — уровень остался бы нулевым, хотя
    /// и спавн, и респаун бывают на плите.
    pub fn adopt_level(&mut self, z: f32, level: u8, vz: f32) {
        self.authoritative_level = Some((z, level, vz));
        self.level_disagreement = 0;
        self.set_grounded(z, level);
    }

    // «уровень из кадра как есть»: тело стоит на опоре, переход закончен.
    // Одно тело на все три пути, которые это делают (`adopt_level`, ветки
    // коррекции уровня в `on_server_state`, `rewind_level_state` с пустой
    // историей) — три копии расходились бы молча
    fn set_grounded(&mut self, z: f32, level: u8) {
        self.level_state.level = level;
        self.level_state.z = z;
        self.level_state.transit = Transit::Grounded;
        self.level_state.slope_vec = [0.0, 0.0];
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
        self.level_disagreement = 0;
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
        self.pitch = 0.0;
        self.roll = 0.0;
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
        // опора — по габариту корпуса, ровно как у хоста: кадр, снятый у
        // самой кромки, иначе читался бы как «танк в воздухе», хотя хост
        // держит его на плите углом корпуса
        let footprint = self.footprint();
        let supported = |z_level: u8| {
            self.levels.as_ref().is_some_and(|levels| {
                level::has_support(levels, z_level, self.state.x, self.state.y, &footprint)
            })
        };
        // высота ровно на уровне полёт НЕ отменяет: баллистика начинает
        // падение с нулевой вертикальной скорости, и первые тики дуги
        // отходят от плиты на тысячные доли уровня. Судит опора — она и
        // есть правило хоста.
        //
        // Ненулевая вертикальная скорость в кадре — полёт сама по себе, без
        // оглядки на опору и высоту: это ПРЫЖОК. На взлёте `z` ещё равен
        // уровню отрыва, плита под танком есть, и по высоте полёт
        // неотличим от езды — только `vz` и отличает
        let airborne = self.authoritative_level.filter(|&(z, level, vz)| {
            !on_ramp && (vz != 0.0 || (level >= 1 && z <= level as f32 && !supported(level)))
        });

        if let Some((z, level, vz)) = airborne {
            // куда летим, решает та же геометрия, что у хоста: у ПРЫЖКА
            // цель — своя же плита (тело ушло вверх с неё и на неё
            // вернётся), у ПАДЕНИЯ — уровень под обрывом, где лежит не
            // всегда земля. Отличает их высота: у падения `z` уже ниже
            // своего уровня, а плиты под ним нет — иначе падать было бы не
            // с чего. Без этой ветки прыжок над своей плитой получал целью
            // землю: реплика проваливалась сквозь плиту, ввод оставался
            // запертым до кадра о приземлении, и газ на каждом прыжке
            // расходился с авторитетным
            let fresh_to = self.levels.as_ref().map_or(0, |levels| {
                if z >= level as f32 && levels.has_floor(level, self.state.x, self.state.y) {
                    level
                } else {
                    levels.landing_level(level, self.state.x, self.state.y)
                }
            });

            // высота и вертикальная скорость берутся из ОДНОГО кадра и
            // потому лежат на одной параболе. Своя скорость сюда не
            // годится: состояние уровня откатывается к последнему снимку
            // НЕ ПОЗЖЕ кадра, а реплей начинается уже ПОСЛЕ него, так что
            // вертикаль реплики отстаёт от кадра ровно на шаг. Пара «своя
            // скорость + высота кадра» лежит тогда на разных дугах и
            // подбрасывает полёт на каждой коррекции (замер: реплика
            // уходила на 0.015 уровня выше хоста и приземлялась двумя
            // тиками позже, теряя эти два тика газа).
            //
            // Из своего состояния переносится только то, чего в кадре нет:
            // вершина дуги (она нужна урону, а урон считает хост — реплике
            // довольно её не занижать) и цель полёта, выбранная в момент
            // отрыва
            let (peak, to) = match self.level_state.transit {
                Transit::Airborne { from, peak, to, .. } if from == level => (peak, to),
                _ => (z.max(level as f32), fresh_to),
            };

            self.level_disagreement = 0;
            self.level_state.level = level;
            self.level_state.z = z;
            self.level_state.transit = Transit::Airborne {
                vz,
                from: level,
                to,
                peak: peak.max(z),
            };
            // прыжок перелетает стены: пока танк выше уровня отрыва на
            // `jump_clearance`, маска пуста — то же правило, что у хоста
            self.level_state.clear_walls =
                z >= level as f32 + self.level_rules.jump_clearance;
        } else if let Some((z, level, _)) = self
            .authoritative_level
            .filter(|&(_, level, _)| !on_ramp && level < self.level_state.level)
        {
            // ПОНИЖЕНИЕ уровня из кадра принимается всегда. Запоздавший
            // кадр может врать только в одну сторону — «я ещё наверху»:
            // ниже своего уровня хост объявляет танк лишь по факту
            // приземления. Поэтому кадр НИЖЕ реплики означает, что спуск
            // случился, а реплика его не предсказала, — и без этой ветки
            // расхождение вечное: уровень считает один реплей, а он
            // применяет реверс по СВОИМ временам и у самой кромки
            // возвращает корпус на плиту, тогда как хост тот же реверс
            // получает уже в падении (замер: реплика застревает на
            // `level = 1, z = 1`, хост стоит на земле).
            //
            // Подъём так принимать нельзя (вернётся старый баг: кадры,
            // летящие к клиенту во время спуска, несут верхний уровень и
            // подбрасывают приземлившуюся реплику обратно на мост), и
            // прогон рампы исключён: там кадр отстаёт как раз вниз —
            // и по состоянию реплики, и по карте под авторитетной позицией.
            self.level_disagreement = 0;
            self.set_grounded(z, level);
        } else if let Some((z, level, _)) = self.authoritative_level.filter(|&(z, level, _)| {
            // кадр обязан быть снят НА ОПОРЕ: `z` ровно на своём уровне.
            // Пока хост падает, он держит `level` тем уровнем, с которого
            // сорвался (`level::step_layered`), а `z` ведёт вниз дробным —
            // и такой кадр «выше реплики» по определению, всё падение
            // подряд. Считать его несогласием значит через
            // `level_adopt_frames` кадров закинуть уже приземлившуюся
            // реплику обратно на мост: под плитой опора уровня 1 ЕСТЬ,
            // поэтому ветка `airborne` этот кадр не перехватывает. Тот же
            // признак «стою, а не в переходе», что у `level::body_on_ramp`
            (z - level as f32).abs() <= LEVEL_EPSILON
                && !on_ramp
                && level > self.level_state.level
        }) {
            // ПОДЪЁМ принимается только по СТОЙКОМУ несогласию. Запоздавший
            // кадр врёт ровно в эту сторону («я ещё наверху»), и принимать
            // его мгновенно нельзя — вернётся баг со спуском. Но и не
            // принимать вовсе тоже нельзя: разошедшийся однажды вердикт
            // гейта, респаун на плите без `camera.forceReset` или снап
            // уровня на хосте оставляли реплику НИЖЕ хоста навсегда — с
            // чужой маской коллизий, чужим слоем, тинтом и масштабом.
            //
            // Кадр запаздывает на буфер интерполяции (десятки мс), поэтому
            // несогласие длиной `level_adopt_frames` (по умолчанию 8, около
            // 0.4 с) запаздыванием быть уже не может. Любой другой исход —
            // согласие и прогон рампы счётчик обнуляют, а кадр в переходе
            // (падение) до счётчика не доходит вовсе — его отсекает фильтр
            // «кадр снят на опоре» выше
            self.level_disagreement = self.level_disagreement.saturating_add(1);

            if self.level_disagreement >= self.level_rules.level_adopt_frames {
                self.level_disagreement = 0;
                self.set_grounded(z, level);
            }
        } else {
            self.level_disagreement = 0;

            if !climbing
                && let Transit::Airborne { from, to, .. } = self.level_state.transit
                && to < from
                && self.level_state.z < from as f32
            {
                // кадр говорит, что танк уже на опоре: доигрывать своё
                // ПАДЕНИЕ реплике нечего. Прыжок над своей же плитой
                // (`to == from`) — другое дело: там кадр «стою на плите»
                // и есть нормальный вид полёта, потому что вертикального
                // состояния кадр пока не везёт (это чинит этап 3), и
                // обрыв дуги здесь стоил бы реплике целого прыжка
                self.level_state.transit = Transit::Grounded;
            }
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
            pitch: self.pitch,
            roll: self.roll,
            vz: match self.level_state.transit {
                Transit::Airborne { vz, .. } => vz,
                _ => 0.0,
            },
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

        // падение: ввод ДВИЖЕНИЯ игнорируется целиком — зеркало раннего
        // выхода `Tank::update`. Хост в падении не двигает ни газ, ни тягу:
        // клавиши остаются нажатыми и подхватятся при приземлении.
        // Реплика с обнулённой маской вместо раннего выхода спускала газ и
        // тормозила тягой — расхождения тихо копились на каждом падении.
        // Башня и наклон корпуса считаются ДО выхода: в полёте они работают
        let damping = (model.damping.linear, model.damping.angular);

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

        // локальные оси корпуса: forward = (cos, sin), right = (−sin, cos)
        let (sin, cos) = self.state.angle.sin_cos();

        (self.pitch, self.roll) = self.step_tilt(cos, sin, dt);

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

        self.state.throttle =
            motion::step_throttle(self.state.throttle, forward || back, model, dt);

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

    // наклон корпуса: те же функции `motion` и в том же порядке, что у
    // хоста (`Tank::step_tilt`). В снапшот истории уровня наклон НЕ
    // кладётся: после реконсиляции его перебьёт авторитетное значение из
    // кадра, а между кадрами он доигрывается сглаживанием — на позицию
    // это не влияет и паритет не трогает
    fn step_tilt(&self, heading_x: f32, heading_y: f32, dt: f32) -> (f32, f32) {
        let vz = match self.level_state.transit {
            Transit::Airborne { vz, .. } => vz,
            _ => 0.0,
        };
        let (target_pitch, target_roll) = motion::tilt_target(
            self.level_state.slope_vec,
            (heading_x, heading_y),
            vz,
            self.level_state.airborne(),
            &self.level_rules,
        );

        (
            motion::approach_tilt(self.pitch, target_pitch, &self.level_rules, dt),
            motion::approach_tilt(self.roll, target_roll, &self.level_rules, dt),
        )
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

            return;
        }

        // история кадр не покрывает (после reset, смены карты, длинной
        // паузы или скачка RTT): откатываться некуда, и состояние из самого
        // кадра, а не остаётся от предсказания. Иначе на спуске реплика
        // доигрывала бы чужой уровень — тот самый, что приехал в кадре
        // ПЕРЕД падением. Фазу падения тут же восстановит `on_server_state`
        let Some((z, level, _)) = self.authoritative_level else {
            return;
        };

        self.set_grounded(z, level);
    }

    /// Опора корпуса под текущим курсом — тот же прямоугольник, что у
    /// хоста (`Tank::footprint`): срыв с обрыва судит габарит, а не точку
    /// центра. Без модели габаритов ещё нет, и правило падает на центр.
    fn footprint(&self) -> Footprint {
        self.shape.as_ref().map_or_else(Footprint::point, |shape| Footprint {
            angle: self.state.angle,
            half_w: shape.half_w,
            half_h: shape.half_h,
        })
    }

    /// Правила уровня одного шага — до применения ввода, ровно как в
    /// TanksSim::update_levels: иначе шаг падения посчитался бы по позиции,
    /// которую ввод уже сдвинул. Событие приземления реплика игнорирует:
    /// урон авторитетен и приедет кадром панели.
    fn step_level(&mut self, dt: f32) {
        let Some(levels) = &self.levels else {
            return;
        };

        let footprint = self.footprint();

        level::step_level(
            &mut self.level_state,
            self.state.x,
            self.state.y,
            [self.state.vx, self.state.vy],
            &footprint,
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

        // буферы шага (поля структуры): берутся на время шага, потому что
        // он одновременно держит `&mut self.sets`; возвращаются в конце
        let mut sim = std::mem::take(&mut self.sim);
        let mut geometry = std::mem::take(&mut self.geometry);
        let mut surfaces = std::mem::take(&mut self.surfaces);
        let mut masks = std::mem::take(&mut self.masks);
        let mut contacts = std::mem::take(&mut self.contacts);
        let mut separations = std::mem::take(&mut self.separations);
        let mut block_hits = std::mem::take(&mut self.block_hits);

        sim.clear();
        geometry.clear();
        surfaces.clear();
        masks.clear();
        contacts.clear();
        separations.clear();

        // тела шага: индекс 0 — свой танк, дальше предсказанные тела
        // подсистем в порядке их регистрации, затем статические партнёры
        // контактов со стенами. Решатель работает по индексам: две
        // изменяемые ссылки на элементы одного среза сразу не взять
        sim.push(Body {
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
        });
        // маска уровней своего танка: в падении это группа статики — тел
        // падающий не задевает, но стены обоих уровней задевает (то же
        // правило, что у хоста в `level::LevelState::collision_mask`)
        let tank_mask = self.level_state.collision_mask();
        // свой танк на прогоне: стражи его не держат (`map::body_filter`)
        let tank_on_ramp = self.level_state.on_ramp();

        geometry.push((tank_obb.half_w, tank_obb.half_h));
        surfaces.push(Surface {
            friction: model.fixture.friction,
            restitution: model.fixture.restitution,
        });

        // захват и шаг предсказанных подсистем (ящики карты, чужие танки)
        let mut bodies = Vec::new();
        let map = self.levels.as_ref();

        for set in &mut self.sets {
            set.capture(&tank_obb, local_now);

            // стражей проходит насквозь только тело, ЗАКОННО едущее по
            // прогону: у тел карты такого режима нет вовсе, а чужой танк
            // судится одной функцией на все стороны (`level::body_on_ramp`)
            let climbs = set.climbs_ramps();

            for body in set.predicted_bodies_mut() {
                body.on_ramp = climbs
                    && map.is_some_and(|levels| {
                        level::body_on_ramp(levels, body.body.x, body.body.y, body.z, body.level)
                    });
                sim.push(body.body);
                geometry.push((body.half_w, body.half_h));
                surfaces.push(body.surface);
                bodies.push(body);
            }
        }

        let movable = sim.len();
        // импульсы идут по КАЖДОЙ точке манифольда, а позиционная коррекция —
        // по одной (самой глубокой) точке пары: развод по обеим точкам
        // растолкал бы тела вдвое, поэтому списки разные

        // маска тела шага: индекс 0 — свой танк (переход по рампе даёт все
        // уровни прогона), остальные — правило движка
        // (`body_collision_mask`): на опоре свой уровень, в падении только
        // статика. Тела разных уровней друг друга не касаются: танк на
        // мосту не толкает ящик под мостом
        masks.push(tank_mask);
        masks.extend(bodies.iter().map(|body| body.collision_mask()));

        // стражи прогона не держат тело, законно едущее по прогону: индекс 0
        // — свой танк, дальше предсказанные тела
        let on_ramp = |index: usize| {
            if index == 0 {
                tank_on_ramp
            } else {
                bodies[index - 1].on_ramp
            }
        };

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
                    block_hits.clear();
                    collect_block_contacts_into(
                        &obb,
                        levels.static_blocks(level),
                        prediction,
                        &mut block_hits,
                    );

                    for hit in &block_hits {
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
            // берёт их у движка (`map::ramp_guards`, посчитаны на загрузке
            // карты): формула одна на обе стороны, иначе предсказание
            // въезжает на прогон сбоку там, где хост держит
            for guard in &self.guards {
                let box2 = Box2 {
                    x: guard.x,
                    y: guard.y,
                    angle: 0.0,
                    half_w: guard.half_w,
                    half_h: guard.half_h,
                };

                for index in 0..movable {
                    // страж существует только для тел уровня, с которого
                    // прогон начинается, и тело, ЗАКОННО поднимающееся по
                    // прогону, проходит его насквозь (`map::body_filter`):
                    // ящик карты таким не бывает, а чужой танк, заехавший
                    // сбоку, борт видит — как и на хосте
                    if !masks[index].intersects(level_group(guard.low)) || on_ramp(index) {
                        continue;
                    }

                    let obb = Box2 {
                        x: sim[index].x,
                        y: sim[index].y,
                        angle: sim[index].angle,
                        half_w: geometry[index].0,
                        half_h: geometry[index].1,
                    };
                    // стражи собираются тем же манифольдом с зазором, что и
                    // стены: иначе они держали бы не на том шаге и не тем
                    // плечом
                    let Some(manifold) = obb_manifold(&obb, &box2, prediction) else {
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
            // кратно их числу. Глубина за шаг уходит не вся, а по закону
            // контактной пружины хоста (`penetration_correction`)
            for (a, b, contact) in &separations {
                let (body_a, body_b) = pair_mut(&mut sim, *a, *b);

                separate_bodies(body_a, body_b, contact, dt);
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

        // буферы возвращаются на место — со следующего шага они работают уже
        // на своей ёмкости
        self.sim = sim;
        self.geometry = geometry;
        self.surfaces = surfaces;
        self.masks = masks;
        self.contacts = contacts;
        self.separations = separations;
        self.block_hits = block_hits;
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
    fn parked_tank_keeps_its_tilt() {
        // регрессия на исторический баг: наклон, восстановленный клиентом из
        // разницы высот между кадрами, у стоящего танка замирал в нуле.
        // Наклон считается из `slope_vec`, поэтому стоящий на рампе танк
        // держит его сколько угодно шагов
        let mut p = make_predictor();

        seed(&mut p, 0.0);
        p.update(0.0);
        p.level_state.slope_vec = [0.33, 0.0];

        // 600 шагов без единой клавиши: танк стоит на месте
        for i in 1..=600 {
            p.update(i as f64 * STEP_MS);
        }

        let expected = (0.33f32 * p.level_rules.tilt_gain).atan();

        assert!(
            (p.pitch - expected).abs() < 1e-3,
            "стоящий на рампе танк обязан держать наклон: pitch={}",
            p.pitch
        );
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
        // подсистема чужих танков (`climbs_ramps`): её телам прогон
        // рампы доступен, телам карты — нет
        climbs: bool,
    }

    impl BoxSet {
        // двойник подсистемы ТАНКОВ: её тела по прогону поднимаются
        fn climbing(x: f32) -> Self {
            let mut set = Self::new(x);

            set.climbs = true;

            set
        }

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
                climbs: false,
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

        fn climbs_ramps(&self) -> bool {
            self.climbs
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

    // уровень и высота тела двойника: по ним судится вердикт гейта чужого
    // танка (`level::body_on_ramp`)
    fn set_box_height(p: &mut Predictor, level: u8, z: f32) {
        let body = p.predicted_sets_mut()[0]
            .set_mut()
            .bodies_mut()
            .get_mut("box")
            .unwrap();

        body.level = level;
        body.z = z;
    }

    // ящик подсистемы на заданной точке карты (стражи судят по клетке, а
    // конструктор двойника кладёт ящик в фиксированную точку)
    fn place_box(p: &mut Predictor, x: f32, y: f32) {
        let body = p.predicted_sets_mut()[0]
            .set_mut()
            .bodies_mut()
            .get_mut("box")
            .unwrap();

        body.body.x = x;
        body.body.y = y;
        body.follow = Transform { x, y, angle: 0.0 };
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
            [p.state.vx, p.state.vy],
            &p.footprint(),
            &levels,
            &p.level_rules,
            (STEP_MS / 1000.0) as f32,
        );

        state
    }

    // реплика на земле ПОД плитой моста (колонки 3–4: x от 120 до 200):
    // отсюда проверяется приём подъёма из кадра
    fn under_the_bridge(p: &mut Predictor) {
        p.state.x = 140.0;
        p.state.y = 100.0;
        p.step_time = 0.0;
        p.step(0);

        assert_eq!(p.level_state().level, 0);
    }

    // кадр, который держит танк на плите уровня 1
    fn frame_above(p: &mut Predictor) {
        p.correct_level(Some((1.0, 1, 0.0)));
        p.on_server_state([140.0, 100.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], false, 0.0, 0.0, 0.0);
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

    // Стражей прогона проходит насквозь только тело, ЗАКОННО едущее по
    // прогону. Ящик карты таким не бывает: хост телам карты
    // `levels_interaction_on_ramp` не ставит вовсе
    // (`GameMap::step_dynamic_levels`), поэтому столкнутый на прогон ящик
    // упирается в борт — и у хоста, и у реплики
    #[test]
    fn a_predicted_map_body_on_the_run_is_held_by_the_guard() {
        let mut p = make_predictor();

        apply_map(&mut p, &wide_ramp_map());
        // свой танк уведён за карту: проверяются только стражи
        p.state.x = 400.0;
        p.state.y = 400.0;
        p.add_predicted_set(Box::new(BoxSet::new(0.0)));
        // клетка прогона (3, 1) — СЕРЕДИНА блока полос: корпус налезает на
        // нижний борт (граница блока по y = 40)
        place_box(&mut p, 140.0, 48.0);
        p.step(0);

        let body = box_body(&mut p);

        assert!(!body.on_ramp, "ящик карты помечен как едущий по прогону");
        assert!(
            body.body.y > 48.0,
            "борт прогона ящик не удержал: y = {}",
            body.body.y
        );
    }

    // чужой танк на клетке прогона, чья высота РОВНО на уровне: хост отказал
    // ему гейту (`level::step_layered` кладёт `z = level` ровно), значит
    // борта он видит — реплика обязана держать его так же
    #[test]
    fn a_remote_tank_on_the_run_at_level_height_is_held_by_the_guard() {
        let mut p = make_predictor();

        apply_map(&mut p, &wide_ramp_map());
        p.state.x = 400.0;
        p.state.y = 400.0;
        p.add_predicted_set(Box::new(BoxSet::climbing(0.0)));
        place_box(&mut p, 140.0, 48.0);
        set_box_height(&mut p, 0, 0.0);
        p.step(0);

        let body = box_body(&mut p);

        assert!(
            !body.on_ramp,
            "танк с высотой ровно по уровню помечен как поднимающийся"
        );
        assert!(
            body.body.y > 48.0,
            "борт прогона чужой танк не удержал: y = {}",
            body.body.y
        );
    }

    // и обратное: дробная высота строки означает, что гейт хоста танк
    // прошёл и поднимается законно, — борта он не видит
    #[test]
    fn a_remote_tank_climbing_the_run_passes_the_guard() {
        let mut p = make_predictor();

        apply_map(&mut p, &wide_ramp_map());
        p.state.x = 400.0;
        p.state.y = 400.0;
        p.add_predicted_set(Box::new(BoxSet::climbing(0.0)));
        place_box(&mut p, 140.0, 48.0);
        set_box_height(&mut p, 0, 0.25);
        p.step(0);

        let body = box_body(&mut p);

        assert!(body.on_ramp, "поднимающийся чужой танк не помечен");
        assert!(
            (body.body.y - 48.0).abs() < 1e-5,
            "страж вытолкнул поднимающийся танк с прогона: y = {}",
            body.body.y
        );
    }

    // обратная половина того же правила: тело того же уровня РЯДОМ с
    // прогоном борт держит — иначе «сняли стражей всем»
    #[test]
    fn a_predicted_body_off_the_run_is_held_by_the_side_guard() {
        let mut p = make_predictor();

        apply_map(&mut p, &wide_ramp_map());
        p.state.x = 400.0;
        p.state.y = 400.0;
        p.add_predicted_set(Box::new(BoxSet::new(0.0)));
        // клетка над СЕРЕДИНОЙ блока (колонка 3): корпус заходит на борт.
        // Клетка подножия (колонка 2) с `vimp-engine-core` 0.17.0 открыта —
        // на горку въезжают с любой стороны
        place_box(&mut p, 140.0, 32.0);
        p.step(0);

        let body = box_body(&mut p);

        assert!(!body.on_ramp, "тело вне прогона помечено как на прогоне");
        assert!(
            body.body.y < 32.0,
            "борт прогона тело не удержал: y = {}",
            body.body.y
        );
    }

    // и третья половина: клетку ПОДНОЖИЯ борт не закрывает — заезд на горку
    // законен с любой стороны, судит его гейт (`level::entry_is_legal`)
    #[test]
    fn a_predicted_body_enters_the_foot_cell_from_the_side() {
        let mut p = make_predictor();

        apply_map(&mut p, &wide_ramp_map());
        p.state.x = 400.0;
        p.state.y = 400.0;
        p.add_predicted_set(Box::new(BoxSet::new(0.0)));
        // над клеткой подножия (колонка 2: x от 80 до 120)
        place_box(&mut p, 100.0, 32.0);
        p.step(0);

        let body = box_body(&mut p);

        assert!(
            body.body.y > 31.9,
            "борт удержал тело у подножия: y = {}",
            body.body.y
        );
    }

    #[test]
    fn a_falling_replica_freezes_the_input_exactly_like_the_host() {
        // `Tank::update` в падении выходит РАНЬШЕ газа и тяги: клавиши
        // остаются нажатыми и подхватятся при приземлении. Реплика с одной
        // лишь обнулённой маской спускала газ и тормозила тягой —
        // расхождение копилось на каждом падении. Башня — исключение: она
        // считается ДО раннего выхода на обеих сторонах
        let mut p = make_predictor();

        p.state.throttle = 1.0;
        p.state.gun_rotation = 0.5;
        p.centering = true;
        p.level_state.transit = Transit::Airborne {
            vz: 0.0,
            from: 1,
            to: 0,
            peak: 1.0,
        };

        p.step(0);

        assert_eq!(p.state.throttle, 1.0, "газ в падении не спускается");
        assert!(
            p.state.gun_rotation < 0.5,
            "башня в полёте работает: {}",
            p.state.gun_rotation
        );
        assert_eq!(p.engine_load, 0.0, "нагрузка двигателя обнулена");
    }

    #[test]
    fn a_falling_replica_pitches_with_its_vertical_speed() {
        let mut p = make_predictor();

        p.level_state.transit = Transit::Airborne {
            vz: -2.0,
            from: 1,
            to: 0,
            peak: 1.0,
        };

        p.step(0);

        assert!(p.pitch < 0.0, "нос на снижении опущен: {}", p.pitch);
        assert_eq!(p.roll, 0.0, "крена в полёте нет");
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
    fn replica_hanging_over_the_edge_keeps_its_level() {
        let mut p = make_predictor();

        apply_map(&mut p, &layered_map());
        p.level_state = LevelState {
            level: 1,
            z: 1.0,
            transit: Transit::Grounded,
            ..LevelState::default()
        };
        // плита моста — колонки 3–4 (x от 120 до 200), корпус 8×6: центр за
        // кромкой, задние углы (x=198) ещё на плите
        p.state.x = 202.0;
        p.state.y = 100.0;
        p.step(0);

        assert_eq!(p.level_state().transit, Transit::Grounded);
        assert_eq!(p.level_state().level, 1);
        assert!(!p.level_state().input_locked(), "ввод у кромки не заперт");

        // ещё немного вперёд — корпус целиком за кромкой, и реплика падает
        p.state.x = 206.0;
        p.step(0);

        assert!(matches!(
            p.level_state().transit,
            Transit::Airborne { from: 1, to: 0, .. }
        ));
    }

    #[test]
    fn falling_replica_hits_walls_but_not_bodies() {
        let mut p = make_predictor();

        apply_map(&mut p, &layered_map());
        p.level_state = LevelState {
            level: 1,
            z: 1.0,
            transit: Transit::Airborne {
                vz: 0.0,
                from: 1,
                to: 0,
                peak: 1.0,
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
            transit: Transit::Airborne {
                vz: 0.0,
                from: 1,
                to: 0,
                peak: 1.0,
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
    fn correct_level_does_not_overwrite_the_prediction() {
        // кадр только запоминается: уровень пересчитает реплей
        // (`on_server_state`), и на рампе тоже — там кадр отстаёт на буфер
        // интерполяции и тянул бы подъём назад каждым тиком
        let mut p = make_predictor();

        apply_map(&mut p, &layered_map());

        let flat = p.level_state();

        p.correct_level(Some((1.0, 1, 0.0)));
        assert_eq!(p.level_state(), flat);

        p.state.x = 90.0;
        p.state.y = 100.0;
        p.step(0);

        let on_ramp = p.level_state();

        p.correct_level(Some((1.0, 1, 0.0)));
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

        p.correct_level(Some((0.6, 1, 0.0)));
        p.on_server_state([90.0, 100.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], false, 0.0, 0.0, 0.0);

        assert!(
            !p.level_state().input_locked(),
            "подъём по рампе принят за падение: {:?}",
            p.level_state().transit
        );
    }

    #[test]
    fn a_jump_over_its_own_slab_returns_to_it() {
        // прыжок с рампы на СВОЙ же уровень: кадр несёт `z` ровно на плите
        // (или чуть выше) и ненулевую `vz`. Целью такого полёта обязана
        // быть та же плита — с целью «земля» реплика проваливалась сквозь
        // неё и держала ввод запертым до кадра о приземлении, теряя газ
        let mut p = make_predictor();

        apply_map(&mut p, &layered_map());

        // плита уровня 1 (колонки 3 и 4: x от 120 до 200)
        p.state.x = 140.0;
        p.state.y = 100.0;
        p.level_state.level = 1;
        p.level_state.z = 1.0;

        p.correct_level(Some((1.0, 1, 1.2)));
        p.on_server_state([140.0, 100.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], false, 0.0, 0.0, 0.0);

        assert!(
            matches!(
                p.level_state().transit,
                Transit::Airborne { to: 1, from: 1, .. }
            ),
            "прыжок над своей плитой целится мимо неё: {:?}",
            p.level_state().transit
        );

        // дуга обязана кончиться на своей же плите и отпустить ввод
        for _ in 0..240 {
            p.step_time += STEP_MS;
            p.step(0);
        }

        assert_eq!(p.level_state().level, 1);
        assert_eq!(p.level_state().z, 1.0);
        assert!(!p.level_state().input_locked());
    }

    #[test]
    fn the_frame_sets_the_vertical_speed_of_a_flight_in_progress() {
        // высота и скорость обязаны приехать из ОДНОГО кадра: состояние
        // уровня откатывается к снимку НЕ ПОЗЖЕ кадра, а реплей идёт уже
        // после него, поэтому своя вертикаль отстаёт от кадра на шаг. Пара
        // «своя скорость + высота кадра» лежит на другой дуге и с каждой
        // коррекцией подбрасывает полёт выше хоста
        let mut p = make_predictor();

        apply_map(&mut p, &layered_map());

        p.state.x = 140.0;
        p.state.y = 100.0;
        p.level_state.level = 1;
        p.level_state.z = 1.0;

        p.correct_level(Some((1.0, 1, 1.2)));
        p.on_server_state([140.0, 100.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], false, 0.0, 0.0, 0.0);

        p.step_time += STEP_MS;
        p.step(0);

        // следующий кадр той же дуги: скорость в нём уже другая
        p.correct_level(Some((1.02, 1, 0.9)));
        p.on_server_state(
            [140.0, 100.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            false,
            p.step_time,
            0.0,
            p.step_time,
        );

        let Transit::Airborne { vz, .. } = p.level_state().transit else {
            panic!("полёт прерван: {:?}", p.level_state().transit);
        };

        assert!(
            (vz - 0.9).abs() < 1e-6,
            "вертикальная скорость взята не из кадра: {vz}"
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

        p.correct_level(Some((0.9, 1, 0.0)));
        p.on_server_state([140.0, 100.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], false, 0.0, 0.0, 0.0);

        assert!(
            !p.level_state().input_locked(),
            "запоздавший кадр принят за падение: {:?}",
            p.level_state().transit
        );
    }

    #[test]
    fn a_descent_does_not_lift_the_replica_back_onto_the_bridge() {
        // Спуск с моста целиком, кадр за кадром. Реплика уже приземлилась и
        // едет ПОД плитой; кадры приходят с запозданием: сперва снятые ещё
        // на мосту (`z` ровно на уровне), потом снятые в полёте (`z`
        // дробный, `level` ещё верхний — хост всё падение держит уровень
        // срыва). Ветка `airborne` их не перехватывает: под плитой опора
        // уровня 1 ЕСТЬ. Без проверки «кадр снят на опоре» счётчик
        // несогласия добирал `level_adopt_frames` прямо на падении и
        // забрасывал приземлившуюся реплику обратно на мост — тот самый
        // баг, который чинил `plan/done/ramp-entry-descent.md`
        let mut p = make_predictor();

        apply_map(&mut p, &layered_map());

        // уровень 0 под плитой моста (колонки 3 и 4: x от 120 до 200)
        p.state.x = 140.0;
        p.state.y = 100.0;
        p.step_time = 0.0;
        p.step(0);

        assert_eq!(p.level_state().level, 0);

        // три кадра «ещё на мосту» (буфер интерполяции + RTT) и восемь
        // кадров полёта — вместе заведомо больше `level_adopt_frames`
        let mut frames: Vec<(f32, u8)> = vec![(1.0, 1); 3];

        for i in 0..8 {
            frames.push((1.0 - (i as f32 + 1.0) / 9.0, 1));
        }

        for &(z, level) in &frames {
            for _ in 0..4 {
                p.step_time += STEP_MS;
                p.step(0);
            }

            let t = p.step_time;

            p.correct_level(Some((z, level, 0.0)));
            p.on_server_state(
                [140.0, 100.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
                false,
                t,
                0.0,
                t,
            );

            assert_eq!(
                p.level_state().level,
                0,
                "реплику подняло на мост кадром спуска (z = {z})"
            );
        }
    }

    #[test]
    fn persistent_disagreement_is_adopted_and_holds() {
        // обратная половина: хост ДЕЙСТВИТЕЛЬНО стоит на плите (`z` ровно на
        // своём уровне), и стойкое несогласие обязано приняться — иначе
        // реплика, оказавшаяся ниже хоста, останется там навсегда
        let mut p = make_predictor();

        apply_map(&mut p, &layered_map());

        p.state.x = 140.0;
        p.state.y = 100.0;
        p.step_time = 0.0;
        p.step(0);

        let mut trace = Vec::new();

        for _ in 0..16 {
            // четыре шага предсказания между кадрами: 120 Гц против 30
            for _ in 0..4 {
                p.step_time += STEP_MS;
                p.step(0);
            }

            let t = p.step_time;

            p.correct_level(Some((1.0, 1, 0.0)));
            p.on_server_state(
                [140.0, 100.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
                false,
                t,
                0.0,
                t,
            );
            trace.push(p.level_state().level);
        }

        // принят — и держится, а не мигает раз в `level_adopt_frames` кадров
        assert!(
            trace[trace.len() - 4..].iter().all(|&level| level == 1),
            "уровень не принят или мигает: {trace:?}"
        );
    }

    #[test]
    fn late_frame_from_the_bridge_does_not_lift_a_landed_replica() {
        // на спуске кадры в полёте везут ещё ВЕРХНИЙ уровень. Реплика,
        // которая уже приземлилась и едет ПОД плитой, обязана считать
        // уровень сама: иначе её подбрасывало на мост, и дальше всё — маска
        // коллизий, масштаб корпуса, тинт — считалось чужим уровнем
        let mut p = make_predictor();

        apply_map(&mut p, &layered_map());

        // уровень 0 под плитой моста (колонки 3 и 4: x от 120 до 200)
        p.state.x = 140.0;
        p.state.y = 100.0;
        p.step_time = 0.0;
        p.step(0);

        assert_eq!(p.level_state().level, 0);

        // запоздавший кадр, снятый ещё на мосту
        p.correct_level(Some((1.0, 1, 0.0)));

        assert_eq!(p.level_state().level, 0, "кадр перебил предсказание");

        p.on_server_state([140.0, 100.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], false, 0.0, 0.0, 0.0);

        assert_eq!(p.level_state().level, 0, "реплику подняло реплеем");
        assert_eq!(p.level_state().z, 0.0);
    }

    #[test]
    fn frame_below_the_replica_lowers_its_level() {
        // зеркало `late_frame_from_the_bridge_does_not_lift_a_landed_replica`:
        // кадр НИЖЕ реплики — это уже случившийся спуск, который реплика не
        // предсказала (реверс у самой кромки она применяет по своим
        // временам и падения не начинает). Без этой ветки расхождение
        // вечное: хост на земле, реплика на мосту
        let mut p = make_predictor();

        apply_map(&mut p, &layered_map());

        // на плите моста (колонки 3–4: x от 120 до 200)
        p.state.x = 140.0;
        p.state.y = 100.0;
        p.level_state = LevelState {
            level: 1,
            z: 1.0,
            transit: Transit::Grounded,
            ..LevelState::default()
        };
        p.step_time = 0.0;
        p.step(0);

        assert_eq!(p.level_state().level, 1);

        // хост давно на земле
        p.correct_level(Some((0.0, 0, 0.0)));
        p.on_server_state([140.0, 100.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], false, 0.0, 0.0, 0.0);

        assert_eq!(p.level_state().level, 0, "понижение из кадра не принято");
        assert_eq!(p.level_state().z, 0.0);
        assert_eq!(p.level_state().transit, Transit::Grounded);
    }

    // смена карты — это другая геометрия: клетка входа и вердикт гейта от
    // прежней карты судили бы вход на прогон новой, а история уровня
    // восстановила бы снимок, снятый на чужих тайлах
    #[test]
    fn set_map_clears_the_level_state() {
        let mut p = make_predictor();

        apply_map(&mut p, &layered_map());
        under_the_bridge(&mut p);

        p.level_state = LevelState {
            level: 1,
            z: 1.0,
            transit: Transit::Grounded,
            prev_cell: (3, 2),
            ..LevelState::default()
        };
        p.correct_level(Some((1.0, 1, 0.0)));

        apply_map(&mut p, &layered_map());

        assert_eq!(p.level_state(), LevelState::default());
        assert!(p.level_history.is_empty(), "история уровня старой карты");
        assert_eq!(p.authoritative_level, None);
    }

    // кадр без своей строки (танк уничтожен, частичный CLEAR, null-маркер)
    // обязан снимать авторитетный уровень: иначе ветки `airborne` и
    // «понижение» продолжают судить по протухшим данным
    #[test]
    fn a_frame_without_our_row_clears_the_authoritative_level() {
        let mut p = make_predictor();

        apply_map(&mut p, &layered_map());
        p.correct_level(Some((1.0, 1, 0.0)));

        assert!(p.authoritative_level.is_some());

        p.correct_level(None);

        assert_eq!(p.authoritative_level, None);
    }

    // подъём принимается ТОЛЬКО по стойкому несогласию: один-два кадра
    // выше реплики — это запаздывание, и принять их значит вернуть старый
    // баг со спуском (кадры в полёте везут ещё верхний уровень)
    #[test]
    fn a_single_frame_above_the_replica_does_not_lift_it() {
        let mut p = make_predictor();

        apply_map(&mut p, &layered_map());
        under_the_bridge(&mut p);

        for _ in 0..2 {
            frame_above(&mut p);
        }

        assert_eq!(p.level_state().level, 0, "реплику подняло одним кадром");
    }

    // но и не принимать подъём вовсе нельзя: разошедшийся вердикт гейта,
    // респаун на плите или снап уровня на хосте оставляли бы реплику НИЖЕ
    // хоста навсегда
    #[test]
    fn a_persistent_frame_above_the_replica_lifts_it() {
        let mut p = make_predictor();

        apply_map(&mut p, &layered_map());
        under_the_bridge(&mut p);

        for _ in 0..p.level_rules.level_adopt_frames {
            frame_above(&mut p);
        }

        assert_eq!(p.level_state().level, 1, "стойкое несогласие не принято");
        assert_eq!(p.level_state().z, 1.0);
        assert_eq!(p.level_state().transit, Transit::Grounded);
    }

    // согласие обнуляет счётчик немедленно: «выше / согласие / выше» — это
    // не несогласие, а чередование запаздывающих кадров
    #[test]
    fn alternating_disagreement_does_not_lift_the_replica() {
        let mut p = make_predictor();

        apply_map(&mut p, &layered_map());
        under_the_bridge(&mut p);

        for _ in 0..p.level_rules.level_adopt_frames * 2 {
            frame_above(&mut p);
            // кадр согласен с репликой
            p.correct_level(Some((0.0, 0, 0.0)));
            p.on_server_state([140.0, 100.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], false, 0.0, 0.0, 0.0);
        }

        assert_eq!(p.level_state().level, 0, "чередование подняло реплику");
    }

    // на прогоне рампы подъём не принимается никогда — как и понижение:
    // там кадр отстаёт по высоте по определению
    #[test]
    fn a_frame_above_the_replica_on_a_run_never_lifts_it() {
        let mut p = make_predictor();

        apply_map(&mut p, &layered_map());

        // колонка 2 — прогон рампы (x от 80 до 120)
        p.state.x = 90.0;
        p.state.y = 100.0;
        p.step_time = 0.0;
        p.step(0);

        assert!(matches!(p.level_state().transit, Transit::Ramp { .. }));

        for _ in 0..p.level_rules.level_adopt_frames * 2 {
            p.correct_level(Some((2.0, 2, 0.0)));
            p.on_server_state([90.0, 100.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], false, 0.0, 0.0, 0.0);
        }

        assert!(
            p.level_state().level < 2,
            "кадр поднял реплику на прогоне: {:?}",
            p.level_state()
        );
    }

    #[test]
    fn a_frame_from_the_ramp_does_not_lower_a_climbing_replica() {
        // на прогоне кадр отстаёт как раз ВНИЗ: реплика поднялась, а кадр
        // ещё везёт нижний уровень. Понижение там принимать нельзя
        let mut p = make_predictor();

        apply_map(&mut p, &layered_map());

        // колонка 2 — прогон рампы (x от 80 до 120)
        p.state.x = 110.0;
        p.state.y = 100.0;
        p.level_state = LevelState {
            level: 1,
            z: 1.0,
            transit: Transit::Grounded,
            ..LevelState::default()
        };
        p.step_time = 0.0;
        // шаг нужен, чтобы история уровня покрыла кадр: с пустой историей
        // откат и так берёт состояние из кадра (`rewind_level_state`)
        p.step(0);

        p.correct_level(Some((0.0, 0, 0.0)));
        p.on_server_state([110.0, 100.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], false, 0.0, 0.0, 0.0);

        assert_eq!(p.level_state().level, 1, "кадр с прогона стянул реплику вниз");
    }

    #[test]
    fn the_first_frame_is_adopted_as_is() {
        // первый кадр со своим танком: предсказания ещё нет, и respawn на
        // плите обязан приехать из кадра
        let mut p = make_predictor();

        apply_map(&mut p, &layered_map());

        p.state.x = 140.0;
        p.state.y = 100.0;
        p.adopt_level(1.0, 1, 0.0);

        assert_eq!(p.level_state().level, 1);
        assert_eq!(p.level_state().z, 1.0);
    }

    #[test]
    fn empty_level_history_takes_the_state_from_the_frame() {
        // история не покрывает кадр (после reset): откат обязан взять
        // уровень из самого кадра, а не оставить предсказанный
        let mut p = make_predictor();

        apply_map(&mut p, &layered_map());

        p.state.x = 140.0;
        p.state.y = 100.0;
        p.level_state.level = 1;
        p.level_state.z = 1.0;
        p.level_state.transit = Transit::Grounded;
        p.level_history.clear();

        p.correct_level(Some((0.0, 0, 0.0)));
        p.on_server_state([140.0, 100.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], false, 0.0, 0.0, 0.0);

        assert_eq!(p.level_state().level, 0);
        assert_eq!(p.level_state().z, 0.0);
    }

    #[test]
    fn reconcile_restores_the_fall_speed_from_the_frame() {
        let mut p = make_predictor();

        apply_map(&mut p, &layered_map());

        // реплика полёта ещё не начала: своей скорости у неё нет, и фазу
        // задаёт кадр — по высоте она неоднозначна (подъём и снижение
        // проходят одно и то же `z`)
        p.correct_level(Some((0.5, 1, -1.4)));
        p.on_server_state([0.0; 8], false, 0.0, 0.0, 0.0);

        assert!(
            matches!(p.level_state().transit, Transit::Airborne { vz, from: 1, to: 0, .. }
                if (vz + 1.4).abs() < 1e-5),
            "{:?}",
            p.level_state().transit
        );
        assert_eq!(p.level_state().z, 0.5);
        assert_eq!(p.level_state().level, 1);
    }

    // ПРЫЖОК: на взлёте `z` ещё равен уровню отрыва и плита под танком
    // есть — по высоте полёт неотличим от езды. Отличает его только
    // вертикальная скорость кадра, и без неё реплика оставалась бы на
    // земле, пока танк на экране уже в воздухе
    #[test]
    fn jump_phase_survives_reconciliation() {
        let mut p = make_predictor();

        apply_map(&mut p, &layered_map());
        p.set_grounded(1.0, 1);

        p.correct_level(Some((1.0, 1, 2.0)));
        p.on_server_state([0.0; 8], false, 0.0, 0.0, 0.0);

        assert!(
            matches!(p.level_state().transit, Transit::Airborne { vz, from: 1, .. }
                if (vz - 2.0).abs() < 1e-5),
            "{:?}",
            p.level_state().transit
        );
    }

    #[test]
    fn reconcile_ends_the_fall_when_the_frame_says_grounded() {
        let mut p = make_predictor();

        apply_map(&mut p, &layered_map());
        p.level_state = LevelState {
            level: 1,
            z: 0.5,
            transit: Transit::Airborne {
                vz: -1.0,
                from: 1,
                to: 0,
                peak: 1.0,
            },
            ..LevelState::default()
        };

        p.correct_level(Some((0.0, 0, 0.0)));
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
            transit: Transit::Airborne {
                vz: -0.5,
                from: 3,
                to: 1,
                peak: 3.0,
            },
            ..LevelState::default()
        };

        // кадр застал падение на половине высоты (3 → 1)
        p.correct_level(Some((2.0, 3, -1.5)));
        p.on_server_state([140.0, 100.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], false, 0.0, 0.0, 0.0);

        // цель падения — плита уровня 1, а не земля, и скорость кадра не
        // обнулена
        assert!(
            matches!(p.level_state().transit, Transit::Airborne { vz, from: 3, to: 1, .. }
                if (vz + 1.5).abs() < 1e-5),
            "{:?}",
            p.level_state().transit
        );
        assert_eq!(p.level_state().z, 2.0);
    }

    #[test]
    fn replica_lands_from_level_three_where_the_host_does() {
        let mut p = make_predictor();

        apply_map(&mut p, &tall_map());
        p.level_state = LevelState {
            level: 3,
            z: 3.0,
            transit: Transit::Airborne {
                vz: 0.0,
                from: 3,
                to: 1,
                peak: 3.0,
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
        p.correct_level(Some((0.0, 0, 0.0)));
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

        // предсказание убежало вперёд и заехало на прогон ПО ДИАГОНАЛИ в
        // дальний край клетки (колонка 2, строка 1, x = 110): прогон там
        // уже на 0.75 уровня выше танка, и гейт такой вход не пускает
        p.step_time = STEP_MS;
        p.state.x = 110.0;
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
        p.correct_level(Some((0.0, 0, 0.0)));
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
