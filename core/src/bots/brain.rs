use rapier2d::prelude::*;
use serde::{Deserialize, Serialize};

use super::aim::{fire_tolerance, Aim, PRE_AIMED_ANGLE};
use super::geom::{angle_of, dist, dist_sq, normalize_angle, rotate};
use super::keys::{HeldKey, KeyPad};
use super::navigator::{
    AvoidMark, NavParams, NavStatus, Navigator, REPLAN_CAUSES, Waypoint, flank_zone,
};
use super::perception::{Contact, FireLine, Perception, fire_line};
use super::profile::BotProfile;
use super::steering::{
    decide_drive, probe_obstacles, Avoidance, DriveCommand, DriveInput, SelfState, StuckMonitor,
    UnstuckPhase, RESOLVE_MOVE, RESOLVE_TIME, UNSTUCK_TURN_MAX, WATCHDOG_MOVE, WATCHDOG_TIME,
};
use super::team::{Role, strength_of};
use crate::config::{BotRules, BotSkill};
use crate::tanks::BotView;
use vimp_engine_core::nav::navigation::{LegKind, NavigationSystem, PathPoint, PenaltyZone};

// константы поведения бота
const AI_UPDATE_INTERVAL: f32 = 0.1;

/// Период выбора цели, с.
const TARGET_INTERVAL: f32 = 0.3;
/// Цель держится не меньше, с (кроме гибели цели и свежего обидчика).
const TARGET_HOLD: f32 = 1.5;
/// Запись кэша стоимости маршрута до цели живёт, с.
const ROUTE_COST_TTL: f32 = 2.0;
/// Для скольких ближайших по прямой кандидатов уточняется стоимость маршрута.
const ROUTE_COST_CANDIDATES: usize = 3;
/// Прямая дистанция вместо маршрутной умножается на это.
const STRAIGHT_FACTOR: f32 = 1.3;
/// Минимальная выдержка режима, с (кроме переходов в `Dead` и из него).
const MODE_MIN_TIME: f32 = 0.5;
/// Дистанция боя (`engage_range`): `Hunt` → `Engage` и огонь из пушки в
/// атаке — не дальше `preferred_range[1]`, умноженного на это. Дальше видимую
/// цель атакующий бот не обстреливает, а подъезжает к ней; в обороне (`Hold`,
/// `Retreat`) и по свежему обидчику стреляет на любой дистанции.
const ENGAGE_RANGE_FACTOR: f32 = 1.3;
/// Обидчик «свежий» (ему бот отвечает огнём за дистанцией боя), пока ранил
/// бота не дольше стольких секунд назад.
const RETALIATE_TIME: f32 = 3.0;
/// `Engage` → `Hunt`: цель не видна дольше, с.
const LOST_SIGHT_TIME: f32 = 1.0;
/// `Engage` → `Hunt`: линия огня не чиста дольше, с.
const UNCLEAR_TIME: f32 = 1.5;
/// Цель снова видна после невидимости дольше этого, с: захват заново.
const REACQUIRE_TIME: f32 = 1.0;
/// Сколько секунд бот уезжает от своей бомбы.
const BOMB_EVADE_TIME: f32 = 1.0;
/// Бомба — ближе этой доли радиуса взрыва.
const BOMB_RANGE_SHARE: f32 = 0.8;
/// Пауза между нажатиями смены оружия, с.
const WEAPON_SWITCH_DELAY: f32 = 0.15;
/// Отклонение курса «змейки» от линии на цель, рад (около 61°): цель
/// остаётся в секторе башни.
const WEAVE_ANGLE: f32 = std::f32::consts::FRAC_PI_2 - 0.5;
/// Агрессивнее этого бот не пятится от близкого врага.
const BACK_OFF_AGGRESSION: f32 = 0.7;
/// Своя бомба при огне по своим — только у такого «драчуна».
const BOMB_FF_AGGRESSION: f32 = 0.8;
/// Урон от себя (приземление, своя бомба) бот замечает на ближайшем тике
/// решений: столько секунд после падения или взрыва обидчик не ищется.
const SELF_DAMAGE_WINDOW: f32 = 0.3;
/// Корпус доворачивается, пока цель не войдёт в сектор башни с таким
/// запасом, рад.
const HULL_TURN_MARGIN: f32 = 0.3;
/// Точка «змейки» не меняется из-за линии огня или упора чаще, с.
const WEAVE_REPICK_DELAY: f32 = 0.5;

/// Проп прямо по курсу ближе этого (ед.) простреливается при выходе из
/// застревания.
const SHOOT_PROP_DISTANCE: f32 = 20.0;
/// Пауза между выстрелами по пропу, с.
const SHOOT_PROP_DELAY: f32 = 0.3;

/// Радиус подсчёта перевеса сил, ед.
const ADVANTAGE_RADIUS: f32 = 350.0;
/// Контакт по радару идёт в подсчёт перевеса, если обновлён не раньше, с.
const ADVANTAGE_RADAR_AGE: f32 = 2.0;
/// Угрозы для отхода — видимые контакты ближе, ед.
const THREAT_RADIUS: f32 = 600.0;
/// Видимый враг ближе этого (ед.) — угроза рядом.
const THREAT_NEAR: f32 = 450.0;
/// Точка отхода перевыбирается раз в, с.
const RETREAT_REPICK: f32 = 1.0;
/// Сколько кандидатов в точки отхода собирается и сколько оценивается
/// маршрутом.
const RETREAT_CANDIDATES: usize = 12;
const RETREAT_ROUTED: usize = 4;
/// Штрафная зона угрозы в маршруте отхода: радиус (ед.) и цена за единицу.
const THREAT_ZONE_RADIUS: f32 = 220.0;
const THREAT_ZONE_COST: f32 = 4.0;
/// Цена прыжка с обрыва на отходе.
const RETREAT_LEDGE_SCALE: f32 = 0.3;
/// Бомба преследователю на отходе: враг позади ближе, ед.
const RETREAT_BOMB_DISTANCE: f32 = 60.0;
/// Агрессивнее этого бот отходит позже: порог здоровья × 0.6.
const LATE_RETREAT_AGGRESSION: f32 = 0.8;
/// Союзник рядом с точкой отхода (ед.) и союзник рядом с ботом для `Hold`.
const ALLY_NEAR: f32 = 250.0;
/// «Свои пошли вперёд»: союзники в `Hunt`/`Engage` ближе, ед.
const PUSH_RADIUS: f32 = 300.0;
/// Сбор: бот оторвался от центра группы на столько (ед.) ближе к цели.
const LEAD_GAP: f32 = 350.0;
/// Сбор окончен ближе этого к центру группы (ед.) или через столько секунд.
const REGROUP_RADIUS: f32 = 180.0;
const REGROUP_TIME: f32 = 4.0;
/// `Support` держится на столько (ед.) позади штурмовика.
const SUPPORT_GAP: f32 = 200.0;
/// Союзник ближе этого (ед.) уводит «змейку» в другую сторону.
const WEAVE_ALLY_RADIUS: f32 = 120.0;
/// Ответный огонь на отходе: множитель ошибки прицела.
const RETREAT_AIM_PENALTY: f32 = 1.3;

/// Режим бота (машина состояний).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum BotMode {
    Dead,
    /// Живых врагов нет: катается по случайным точкам.
    #[default]
    Roam,
    /// Едет к цели по маршруту.
    Hunt,
    /// Бой с видимой целью.
    Engage,
    /// Отход к своим, в укрытие, домой или вниз с моста.
    Retreat,
    /// Удержание позиции (засада) после отхода.
    Hold,
    /// Возврат к центру группы: бот оторвался вперёд без перевеса.
    Regroup,
}

impl BotMode {
    /// Имя режима для отладочного снимка.
    pub fn name(self) -> &'static str {
        match self {
            BotMode::Dead => "dead",
            BotMode::Roam => "roam",
            BotMode::Hunt => "hunt",
            BotMode::Engage => "engage",
            BotMode::Retreat => "retreat",
            BotMode::Hold => "hold",
            BotMode::Regroup => "regroup",
        }
    }
}

/// Всё, от чего зависят переходы режимов (снимок тика решений).
#[derive(Clone, Copy, Debug)]
pub(crate) struct ModeInputs {
    pub mode: BotMode,
    pub mode_age: f32,
    pub alive: bool,
    pub has_contacts: bool,
    pub health: f32,
    /// `profile.retreat_health`, у `aggression > 0.8` — × 0.6 («поздний отход»).
    pub retreat_hp: f32,
    pub retreat_advantage: f32,
    pub advantage: f32,
    /// С последнего урона, с.
    pub damage_age: Option<f32>,
    /// Видимый враг ближе 450.
    pub threat_visible_near: bool,
    pub target_visible: bool,
    pub target_fire_clear: bool,
    pub target_dist: f32,
    pub preferred_range: [f32; 2],
    pub lost_sight_for: f32,
    pub unclear_for: f32,
    /// `w1 < 1` и (`w2 < 1` или нет врага в радиусе бомбы).
    pub out_of_ammo: bool,
    pub retreat_arrived: bool,
    /// Сколько секунд нет видимых угроз.
    pub safe_for: f32,
    /// Союзник ближе 250.
    pub ally_near: bool,
    pub hold_expired: bool,
    /// Не меньше двух союзников ближе 300 в `Hunt`/`Engage`.
    pub allies_pushing: bool,
    /// Бот оторвался вперёд без перевеса.
    pub leading_alone: bool,
    pub regroup_done: bool,
    /// Видимый враг ближе `preferred_range[0]`.
    pub enemy_close: bool,
}

/// Дистанция боя по `preferred_range` бота, ед.
fn engage_range(preferred_range: [f32; 2]) -> f32 {
    ENGAGE_RANGE_FACTOR * preferred_range[1]
}

/// Переходы режимов — чистая функция, правила по приоритету (первое
/// сработавшее побеждает). Выдержка `MODE_MIN_TIME` действует для всех
/// правил, кроме гибели, респауна и ухода в отступление.
pub(crate) fn next_mode(i: &ModeInputs) -> BotMode {
    use BotMode::{Dead, Engage, Hold, Hunt, Regroup, Retreat, Roam};

    if !i.alive {
        return Dead;
    }

    if i.mode == Dead {
        return Roam;
    }

    let young = i.mode_age < MODE_MIN_TIME;

    if !i.has_contacts {
        return if young { i.mode } else { Roam };
    }

    let must_retreat = (i.health <= i.retreat_hp
        && (i.damage_age.is_some_and(|age| age < 4.0) || i.threat_visible_near))
        || (i.advantage < i.retreat_advantage && i.health < 70.0)
        || i.out_of_ammo;

    if matches!(i.mode, Hunt | Engage | Regroup) && must_retreat {
        return Retreat;
    }

    if young {
        return i.mode;
    }

    let engage =
        i.target_visible && i.target_fire_clear && i.target_dist <= engage_range(i.preferred_range);

    match i.mode {
        Retreat if i.retreat_arrived || (i.safe_for > 2.0 && i.ally_near) => Hold,
        Hold if i.health < 20.0 && i.threat_visible_near && i.mode_age > 1.0 => Retreat,
        Hold if i.enemy_close && i.health > i.retreat_hp => Engage,
        Hold if (i.hold_expired && i.advantage >= 1.0) || i.allies_pushing => Hunt,
        Hunt if i.leading_alone => Regroup,
        Regroup if i.regroup_done => Hunt,
        Hunt | Regroup if engage => Engage,
        Engage if i.lost_sight_for > LOST_SIGHT_TIME || i.unclear_for > UNCLEAR_TIME => Hunt,
        Roam => Hunt,
        mode => mode,
    }
}

/// Счётчики поведения для тестов и дампов (едут в дамп вместе с мозгом).
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
pub struct BotStats {
    pub stuck_events: u32,
    pub unstuck_resolved: u32,
    pub replans: u32,
    pub route_failures: u32,
    pub shots_fired: u32,
    pub watchdog_resets: u32,
    pub mode_changes: u32,
    /// Перестроения маршрута по причинам (`ReplanCause as usize`).
    #[serde(default)]
    pub replan_causes: [u32; REPLAN_CAUSES],
    /// Сколько раз поиск маршрута ждал общего бюджета (`plan` → `Waiting`).
    #[serde(default)]
    pub route_waits: u32,
}

/// Снимок мозга бота для тестов и отладки.
#[derive(Clone, Debug, Serialize)]
pub struct BotDebug {
    pub mode: &'static str,
    pub target: Option<u32>,
    pub route_len: usize,
    pub stats: BotStats,
    pub skill: BotSkill,
}

/// Как ехать к точке или по направлению.
#[derive(Clone, Copy)]
struct DriveOpts {
    arrive_radius: f32,
    allow_reverse: bool,
    /// Задний ход — к точке ближе этого, ед.
    reverse_distance: f32,
    /// Добавлять шум руля (не при точном рулении).
    noise: bool,
    /// Лучи объезда препятствий.
    avoid: bool,
}

/// ИИ одного бота: восприятие, режимы, навигация, прицел и огонь. Ввод
/// генерируется внутри ядра — бот дёргает те же клавиши, что и игрок.
#[derive(Serialize, Deserialize)]
pub struct BotBrain {
    pub game_id: u32,
    #[serde(default)]
    pub mode: BotMode,
    /// Когда включён текущий режим (часы бота).
    #[serde(default)]
    mode_since: f32,

    target: Option<u32>,
    /// Когда выбрана текущая цель.
    #[serde(default)]
    target_since: f32,
    /// До следующего выбора цели, с.
    #[serde(default)]
    target_timer: f32,
    /// Кэш стоимости маршрута до контакта: (id, стоимость, когда посчитана).
    #[serde(default)]
    route_costs: Vec<(u32, f32, f32)>,
    /// Где бот ожил.
    #[serde(default)]
    home: Option<PathPoint>,
    /// До этого момента бот «осматривается» в `Hunt`: газ отпущен.
    #[serde(default)]
    hesitate_until: f32,
    /// С какого момента цель не видна / линия огня не чиста.
    #[serde(default)]
    lost_sight_since: Option<f32>,
    #[serde(default)]
    unclear_since: Option<f32>,
    /// Что бот знает о врагах.
    #[serde(default)]
    pub(super) perception: Perception,
    /// Часы бота на последнем обновлении восприятия.
    #[serde(default)]
    perceived_at: f32,

    ai_update_timer: f32,

    /// Прицел по текущей цели.
    #[serde(default)]
    pub(super) aim: Aim,
    /// «Змейка» в бою: сторона (±1), когда её сменить, точка манёвра и
    /// когда она выбрана.
    #[serde(default)]
    weave_side: f32,
    #[serde(default)]
    weave_switch_at: f32,
    #[serde(default)]
    weave_point: Option<[f32; 2]>,
    #[serde(default)]
    weave_picked_at: f32,
    /// Цель целилась в бота на прошлом тике (уклонение по фронту).
    #[serde(default)]
    was_aimed_at: bool,
    /// Корпус доворачивается к цели за лимитом башни.
    #[serde(default)]
    hull_turn: bool,
    /// До этого момента бот уезжает от своей бомбы; где она лежит.
    #[serde(default)]
    evade_until: f32,
    #[serde(default)]
    bomb_pos: Option<[f32; 2]>,
    /// Когда положена последняя бомба: урон при её взрыве — от себя.
    #[serde(default)]
    bomb_dropped_at: Option<f32>,
    /// Последний тик падения (ввод заблокирован): урон сразу после него —
    /// от падения, а не от врага.
    #[serde(default)]
    fell_at: Option<f32>,
    /// Смена оружия: когда можно нажать снова и сколько нажатий подряд.
    #[serde(default)]
    weapon_switch_at: f32,
    #[serde(default)]
    switch_presses: u8,
    /// Следующий выстрел по пропу при выходе из застревания.
    #[serde(default)]
    prop_shot_at: f32,

    #[serde(default)]
    pub(super) keys: KeyPad,

    /// «Характер» бота (`coreParams.bots`); старый дамп без него получает
    /// пресет `normal` без разброса.
    #[serde(default)]
    pub profile: BotProfile,
    #[serde(default)]
    pub stats: BotStats,

    /// Маршрут по нав-графу (едет в дамп: после миграции хоста бот
    /// продолжает путь).
    #[serde(default)]
    pub(super) nav: Navigator,
    #[serde(default)]
    pub(super) stuck: StuckMonitor,
    /// Манёвр выхода из застревания; пока `Some`, перекрывает вождение.
    #[serde(default)]
    unstuck: Option<UnstuckPhase>,
    /// Сколько длится текущая фаза манёвра, с.
    #[serde(default)]
    unstuck_time: f32,
    /// Откуда меряется успех манёвра (позиция в его конце) и сколько
    /// ещё ждать смещения.
    #[serde(default)]
    resolve_from: Option<[f32; 2]>,
    #[serde(default)]
    resolve_timer: f32,
    /// Часы бота, с: идут и у мёртвого.
    #[serde(default)]
    pub(super) clock: f32,
    /// Шум руля: смещение угла и время до следующего розыгрыша.
    #[serde(default)]
    steer_bias: f32,
    #[serde(default)]
    steer_bias_timer: f32,
    /// Выравнивание на рампу завершено: бот едет по оси прогона.
    #[serde(default)]
    ramp_lock: bool,
    /// Сторож: где бот стоял и сколько там стоит.
    #[serde(default)]
    watchdog_pos: Option<[f32; 2]>,
    #[serde(default)]
    watchdog_time: f32,
    /// Отход: точка, когда выбрана и какую точку исключить (из `Hold`
    /// под огнём бот уходит в другое место).
    #[serde(default)]
    retreat_point: Option<PathPoint>,
    #[serde(default)]
    retreat_picked_at: f32,
    #[serde(default)]
    retreat_exclude: Option<[f32; 2]>,
    /// Когда бот последний раз видел врага.
    #[serde(default)]
    threat_seen_at: Option<f32>,
    /// Удержание: до какого момента, когда следующий сдвиг и куда.
    #[serde(default)]
    hold_until: f32,
    #[serde(default)]
    hold_shift_at: f32,
    #[serde(default)]
    hold_point: Option<[f32; 2]>,

    // кэш кадра (JS _updateCachedData)
    #[serde(skip)]
    pub(super) my_position: Option<[f32; 2]>,
    /// Уровень бота на этом кадре (2.5D-карты); 0 у одноуровневой карты.
    #[serde(skip)]
    pub(super) my_level: u8,
}

impl BotBrain {
    pub fn new(game_id: u32, rng: &mut vimp_engine_core::rng::Rng, rules: &BotRules) -> Self {
        Self {
            game_id,
            mode: BotMode::Roam,
            mode_since: 0.0,
            target: None,
            target_since: 0.0,
            target_timer: 0.0,
            route_costs: Vec::new(),
            home: None,
            hesitate_until: 0.0,
            lost_sight_since: None,
            unclear_since: None,
            perception: Perception::default(),
            perceived_at: 0.0,
            ai_update_timer: 0.0,
            aim: Aim::default(),
            weave_side: 1.0,
            weave_switch_at: 0.0,
            weave_point: None,
            weave_picked_at: 0.0,
            was_aimed_at: false,
            hull_turn: false,
            evade_until: 0.0,
            bomb_pos: None,
            bomb_dropped_at: None,
            fell_at: None,
            weapon_switch_at: 0.0,
            switch_presses: 0,
            prop_shot_at: 0.0,
            keys: KeyPad::default(),
            profile: BotProfile::roll(rules, rng),
            stats: BotStats::default(),
            nav: Navigator::default(),
            stuck: StuckMonitor::default(),
            unstuck: None,
            unstuck_time: 0.0,
            resolve_from: None,
            resolve_timer: 0.0,
            clock: 0.0,
            steer_bias: 0.0,
            steer_bias_timer: 0.0,
            ramp_lock: false,
            watchdog_pos: None,
            watchdog_time: 0.0,
            retreat_point: None,
            retreat_picked_at: 0.0,
            retreat_exclude: None,
            threat_seen_at: None,
            hold_until: 0.0,
            hold_shift_at: 0.0,
            hold_point: None,
            my_position: None,
            my_level: 0,
        }
    }

    /// Снимок для тестов и отладки.
    pub fn debug(&self) -> BotDebug {
        BotDebug {
            mode: self.mode.name(),
            target: self.target,
            route_len: self.nav.route_len(),
            stats: self.stats,
            skill: self.profile.skill,
        }
    }

    /// Текущая цель (для доски команды).
    pub(crate) fn target(&self) -> Option<u32> {
        self.target
    }

    /// Враги, которых бот сейчас видит (для доски команды).
    pub(crate) fn visible_enemies(&self) -> Vec<u32> {
        self.perception
            .visible_contacts()
            .map(|contact| contact.id)
            .collect()
    }

    fn set_key_state(&mut self, game: &mut BotView<'_>, key: HeldKey, is_down: bool) {
        self.keys.set(game, self.game_id, key, is_down);
    }

    fn press_one_shot(&self, game: &mut BotView<'_>, bit: u32) {
        self.keys.press_once(game, self.game_id, bit);
    }

    /// Жмёт огонь и считает выстрел.
    fn press_fire(&mut self, game: &mut BotView<'_>) {
        let bit = game.key_bits.fire;

        self.press_one_shot(game, bit);
        self.stats.shots_fired += 1;
    }

    fn release_all_keys(&mut self, game: &mut BotView<'_>) {
        self.keys.release_all(game, self.game_id);
    }

    fn release_movement(&mut self, game: &mut BotView<'_>) {
        self.keys.release_movement(game, self.game_id);
    }

    /// Главный метод обновления (вызывается на каждом тике ядра).
    pub(crate) fn update(&mut self, game: &mut BotView<'_>, dt: f32) {
        self.clock += dt;

        if !self.keys.synced() {
            self.keys.force_release_all(game, self.game_id);
        }

        self.my_position = game.tank_position_rounded(self.game_id);
        self.my_level = game.tank_level(self.game_id);

        let has_body = game
            .tanks
            .get(&self.game_id)
            .map(|tank| tank.body)
            .is_some_and(|handle| game.world.bodies.get(handle).is_some());

        if !has_body || !game.tank_alive(self.game_id) {
            if self.mode != BotMode::Dead {
                self.set_mode(BotMode::Dead);
                self.release_all_keys(game);
                self.nav.clear();
                self.unstuck = None;
                self.watchdog_pos = None;
                // попытки выхода и замер успеха до смерти не должны дожить
                // до респауна
                self.stuck = StuckMonitor::default();
                self.resolve_from = None;
                self.ramp_lock = false;
                self.aim.reset();
                self.hull_turn = false;
                self.weave_point = None;
                self.evade_until = 0.0;
                self.bomb_pos = None;
                self.bomb_dropped_at = None;
                self.retreat_point = None;
                self.retreat_exclude = None;
                self.hold_point = None;
            }

            return;
        }

        if self.mode == BotMode::Dead {
            self.set_mode(BotMode::Roam);
            self.home = self.my_position.map(|pos| PathPoint {
                pos,
                level: self.my_level,
            });
            self.perception.forget_sight();
        }

        // танк в падении не управляется: любые клавиши всё равно
        // игнорируются ядром, а стояние в полёте — не застревание
        if game.tank_input_locked(self.game_id) {
            self.fell_at = Some(self.clock);
            self.release_all_keys(game);
            self.stuck.reset();
            self.watchdog_pos = self.my_position;
            self.watchdog_time = 0.0;

            return;
        }

        let Some(me) = SelfState::read(game, self.game_id) else {
            return;
        };

        self.ai_update_timer -= dt;
        self.target_timer -= dt;
        self.nav.tick(dt);
        self.tick_steer_noise(game, dt);

        // решения — раз в `AI_UPDATE_INTERVAL` и сразу, если цель погибла
        let target_died = self.target.is_some_and(|target| !game.tank_alive(target));

        if self.ai_update_timer <= 0.0 || target_died {
            self.ai_update_timer = AI_UPDATE_INTERVAL;
            self.think(game, &me);
        }

        let line = self.attack_line(game, &me);

        self.execute_movement(game, &me, dt);

        // ствол при простреле пропа ведёт манёвр выхода
        if !matches!(self.unstuck, Some(UnstuckPhase::ShootProp { .. })) {
            self.aim_and_shoot(game, &me, line, dt);
        }

        self.track_resolve(&me, dt);
        self.watchdog(game, &me, dt);
    }

    /// Смена режима (выдержку `MODE_MIN_TIME` судит `next_mode`).
    fn set_mode(&mut self, mode: BotMode) {
        if mode == self.mode {
            return;
        }

        self.mode = mode;
        self.mode_since = self.clock;
        self.stats.mode_changes += 1;
    }

    /// Вход в режим: подготовка его состояния.
    fn enter_mode(&mut self, game: &mut BotView<'_>, mode: BotMode) {
        let prev = self.mode;

        self.set_mode(mode);

        match mode {
            BotMode::Roam => self.nav.clear(),
            BotMode::Retreat => {
                // из `Hold` под огнём — в другое место
                self.retreat_exclude = if prev == BotMode::Hold {
                    self.retreat_point.map(|point| point.pos)
                } else {
                    None
                };
                self.retreat_point = None;
                self.retreat_picked_at = self.clock - RETREAT_REPICK;
                self.hull_turn = false;
                self.weave_point = None;
            }
            BotMode::Hold => {
                self.hold_until =
                    self.clock + game.rng.range(4.0, 8.0) * (1.5 - self.profile.aggression);
                self.hold_shift_at = self.clock + game.rng.range(2.0, 3.0);
                self.hold_point = None;
                self.nav.clear();
            }
            _ => {}
        }
    }

    /// Шум руля: раз в 0.5–1 с новое смещение угла (человеческая неточность).
    fn tick_steer_noise(&mut self, game: &mut BotView<'_>, dt: f32) {
        self.steer_bias_timer -= dt;

        if self.steer_bias_timer <= 0.0 {
            self.steer_bias_timer = game.rng.range(0.5, 1.0);
            self.steer_bias = game.rng.range(-1.0, 1.0) * self.profile.steer_noise;
        }
    }

    /// Линия огня по контакту прицела (один расчёт на тик): в `Engage` всегда,
    /// в остальных режимах с прицелом — по видимому контакту.
    fn attack_line(&self, game: &BotView<'_>, me: &SelfState) -> Option<FireLine> {
        let contact = self.aim_contact(me.pos_array())?;
        let active = self.mode == BotMode::Engage || contact.visible;

        if !active || !game.tank_alive(contact.id) {
            return None;
        }

        Some(fire_line(game, self.game_id, self.my_level, contact.id))
    }

    /// Контакт текущей цели.
    fn target_contact(&self) -> Option<Contact> {
        self.target
            .and_then(|target| self.perception.contact(target))
            .copied()
    }

    /// Кого держит башня: в погоне, бою и сборе — цель; на отходе —
    /// ближайшую видимую угрозу; в засаде — видимую цель или ближайшую
    /// видимую угрозу, иначе заранее туда, откуда ждёт врага.
    fn aim_contact(&self, pos: [f32; 2]) -> Option<Contact> {
        match self.mode {
            BotMode::Hunt | BotMode::Engage | BotMode::Regroup => self.target_contact(),
            BotMode::Retreat => self
                .perception
                .nearest_visible(pos, THREAT_RADIUS)
                .copied()
                .or_else(|| self.target_contact()),
            BotMode::Hold => self
                .target_contact()
                .filter(|contact| contact.visible)
                .or_else(|| self.perception.nearest_visible(pos, THREAT_RADIUS).copied())
                .or_else(|| self.hold_threat(pos)),
            BotMode::Roam | BotMode::Dead => None,
        }
    }

    /// Угроза для засады: последний обидчик, иначе ближайший контакт.
    fn hold_threat(&self, pos: [f32; 2]) -> Option<Contact> {
        self.perception
            .last_attacker
            .and_then(|id| self.perception.contact(id))
            .or_else(|| {
                self.perception
                    .contacts
                    .iter()
                    .min_by(|a, b| dist_sq(pos, a.pos).total_cmp(&dist_sq(pos, b.pos)))
            })
            .copied()
    }

    /// Тик решений: восприятие → выбор цели → переходы режимов.
    fn think(&mut self, game: &mut BotView<'_>, me: &SelfState) {
        let dt = self.clock - self.perceived_at;
        let self_inflicted = self.self_inflicted_damage(game);

        self.perceived_at = self.clock;
        self.perception
            .update(game, me, &self.profile, self.clock, dt, self_inflicted);

        let damaged_now = self.perception.last_damage_at == Some(self.clock);
        let target_lost = self
            .target
            .is_some_and(|target| self.perception.contact(target).is_none());

        if target_lost {
            self.target = None;
        }

        if self.target_timer <= 0.0 || self.target.is_none() || damaged_now {
            self.target_timer = TARGET_INTERVAL;
            self.choose_target(game, me);
        }

        self.update_mode(game, me, damaged_now, self_inflicted);
    }

    /// Свежий урон — от себя: приземление после падения или своя бомба при
    /// огне по своим (взрыв через `fuse` после закладки). Обидчика у такого
    /// урона нет.
    fn self_inflicted_damage(&self, game: &BotView<'_>) -> bool {
        let within = |at: Option<f32>, delay: f32| {
            at.is_some_and(|at| self.clock - at < delay + SELF_DAMAGE_WINDOW)
        };
        let fuse = bomb_weapon(game).map_or(0.0, |bomb| bomb.fuse);

        within(self.fell_at, 0.0) || (game.friendly_fire && within(self.bomb_dropped_at, fuse))
    }

    /// Выбор цели по дистанции маршрута, видимости, угрозе, повреждённости
    /// и уровню (меньше оценка — лучше).
    fn choose_target(&mut self, game: &mut BotView<'_>, me: &SelfState) {
        let contacts = self.perception.contacts.clone();

        self.route_costs
            .retain(|(id, _, _)| contacts.iter().any(|contact| contact.id == *id));

        if contacts.is_empty() {
            self.target = None;
            return;
        }

        self.refresh_route_costs(game, me, &contacts);

        let clock = self.clock;
        let perception = &self.perception;
        // обидчик: ранил бота не дольше `window` с назад
        let recent_attacker =
            |id: u32, window: f32| perception.recent_attacker(clock, window) == Some(id);
        let focus = game.team.and_then(|team| team.focus);
        let mut best: Option<(u32, f32)> = None;

        for contact in &contacts {
            let straight = dist(me.pos_array(), contact.pos);
            let mut score = self
                .route_costs
                .iter()
                .find(|(id, _, _)| *id == contact.id)
                .map_or(straight * STRAIGHT_FACTOR, |(_, cost, _)| *cost);

            if contact.level != me.level {
                score *= 1.25;
            }

            if contact.visible {
                score *= if contact.fire_line == FireLine::Clear {
                    0.6
                } else {
                    0.85
                };
            }

            if contact.aiming_at_me || recent_attacker(contact.id, 2.0) {
                score *= 0.5;
            }

            score *= match contact.condition {
                1 => 0.8,
                2 => 0.9,
                _ => 1.0,
            };

            // общий фокус команды
            if focus == Some(contact.id) {
                score *= 0.75;
            }

            // гистерезис
            if self.target == Some(contact.id) {
                score *= 0.8;
            }

            // контакты идут по возрастанию id: при равенстве остаётся меньший
            if best.is_none_or(|(_, best_score)| score < best_score) {
                best = Some((contact.id, score));
            }
        }

        let Some((best_id, _)) = best else {
            return;
        };

        if self.target == Some(best_id) {
            return;
        }

        // цель держится `TARGET_HOLD`, если новый кандидат — не свежий обидчик
        let holding = self.target.is_some_and(|target| {
            self.perception.contact(target).is_some() && clock - self.target_since < TARGET_HOLD
        });

        if holding && !recent_attacker(best_id, 1.0) {
            return;
        }

        self.target = Some(best_id);
        self.target_since = clock;
        self.lost_sight_since = None;
        self.unclear_since = None;
    }

    /// Уточняет стоимость маршрута до трёх ближайших по прямой кандидатов,
    /// если запись старше `ROUTE_COST_TTL`. Каждый поиск — единица общего
    /// бюджета тика; нет бюджета — остаётся оценка по прямой.
    fn refresh_route_costs(
        &mut self,
        game: &mut BotView<'_>,
        me: &SelfState,
        contacts: &[Contact],
    ) {
        let my_pos = me.pos_array();
        let mut nearest: Vec<&Contact> = contacts.iter().collect();

        nearest.sort_by(|a, b| {
            dist_sq(my_pos, a.pos)
                .total_cmp(&dist_sq(my_pos, b.pos))
                .then(a.id.cmp(&b.id))
        });

        let params = self.nav_params(game, me);
        let start = PathPoint {
            pos: my_pos,
            level: me.level,
        };

        for contact in nearest.into_iter().take(ROUTE_COST_CANDIDATES) {
            let index = self
                .route_costs
                .iter()
                .position(|(id, _, _)| *id == contact.id);

            if index.is_some_and(|i| self.clock - self.route_costs[i].2 < ROUTE_COST_TTL) {
                continue;
            }

            let end = PathPoint {
                pos: contact.pos,
                level: contact.level,
            };
            let Some(cost) = self.nav.route_cost(game, start, end, &params, &[]) else {
                break;
            };
            // маршрута нет (радарная точка в стене, остров) — оценка по прямой
            let cost = cost.unwrap_or(dist(my_pos, contact.pos) * STRAIGHT_FACTOR);
            let entry = (contact.id, cost, self.clock);

            match index {
                Some(i) => self.route_costs[i] = entry,
                None => self.route_costs.push(entry),
            }
        }
    }

    /// Переходы режимов (тик решений): снимок `ModeInputs` → `next_mode`,
    /// плюс оборона при атаке.
    fn update_mode(
        &mut self,
        game: &mut BotView<'_>,
        me: &SelfState,
        damaged_now: bool,
        self_inflicted: bool,
    ) {
        let target = self.target_contact();

        match target {
            Some(contact) => {
                if contact.visible {
                    self.lost_sight_since = None;
                } else {
                    self.lost_sight_since.get_or_insert(self.clock);
                }

                if contact.visible && contact.fire_line == FireLine::Clear {
                    self.unclear_since = None;
                } else {
                    self.unclear_since.get_or_insert(self.clock);
                }
            }
            None => {
                self.lost_sight_since.get_or_insert(self.clock);
                self.unclear_since.get_or_insert(self.clock);
            }
        }

        let clock = self.clock;
        let pos = me.pos_array();
        let id = self.game_id;
        let since = |at: Option<f32>| at.map_or(0.0, |at| clock - at);

        if self.perception.visible_contacts().next().is_some() {
            self.threat_seen_at = Some(clock);
        }

        let health = game.tank_health(id) as f32;
        let advantage = self.advantage(game, pos, health);
        let late = if self.profile.aggression > LATE_RETREAT_AGGRESSION {
            0.6
        } else {
            1.0
        };
        let team = game.team;
        let tile = game.tile_size();
        let inputs = ModeInputs {
            mode: self.mode,
            mode_age: clock - self.mode_since,
            alive: true,
            has_contacts: !self.perception.contacts.is_empty(),
            health,
            retreat_hp: self.profile.retreat_health * late,
            retreat_advantage: self.profile.retreat_advantage,
            advantage,
            damage_age: self.perception.last_damage_at.map(|at| clock - at),
            threat_visible_near: self.perception.nearest_visible(pos, THREAT_NEAR).is_some(),
            target_visible: target.is_some_and(|contact| contact.visible),
            target_fire_clear: target
                .is_some_and(|contact| contact.visible && contact.fire_line == FireLine::Clear),
            target_dist: target.map_or(f32::MAX, |contact| dist(pos, contact.pos)),
            preferred_range: self.profile.preferred_range,
            lost_sight_for: since(self.lost_sight_since),
            unclear_for: since(self.unclear_since),
            out_of_ammo: self.out_of_ammo(game, me),
            retreat_arrived: self
                .retreat_point
                .is_some_and(|point| dist(pos, point.pos) < 1.5 * tile),
            safe_for: self.threat_seen_at.map_or(f32::MAX, |at| clock - at),
            ally_near: team
                .is_some_and(|team| team.allies_near(pos, ALLY_NEAR, id).next().is_some()),
            hold_expired: clock > self.hold_until,
            allies_pushing: team.is_some_and(|team| {
                team.allies_near(pos, PUSH_RADIUS, id)
                    .filter(|m| matches!(m.mode, Some(BotMode::Hunt | BotMode::Engage)))
                    .count()
                    >= 2
            }),
            leading_alone: self.leading_alone(game, pos, advantage),
            regroup_done: self.regroup_done(game, pos),
            enemy_close: self
                .perception
                .nearest_visible(pos, self.profile.preferred_range[0])
                .is_some(),
        };
        let mut next = next_mode(&inputs);

        // оборона при атаке: свежий урон от видимого обидчика — сразу в бой
        // (цель уже переключена `choose_target`), «змейка» сразу меняет
        // сторону. Урон от себя обидчика не имеет
        let attacker_visible = self
            .perception
            .last_attacker
            .and_then(|attacker| self.perception.contact(attacker))
            .is_some_and(|contact| contact.visible);

        if damaged_now
            && !self_inflicted
            && attacker_visible
            && matches!(self.mode, BotMode::Roam | BotMode::Hunt | BotMode::Regroup)
            && !matches!(next, BotMode::Retreat | BotMode::Dead)
        {
            next = BotMode::Engage;
            self.weave_switch_at = clock;
        }

        if next != self.mode {
            self.enter_mode(game, next);
        }

        // колебание: цель не видна — бот ненадолго «осматривается»
        if self.mode == BotMode::Hunt
            && self.hesitate_until <= self.clock
            && target.is_some_and(|contact| !contact.visible)
            && game.rng.next_f32() < self.profile.hesitation * 0.1
        {
            self.hesitate_until = self.clock + game.rng.range(0.3, 0.8);
        }
    }

    /// Перевес сил рядом: своя сила (здоровье / 100) плюс «сила» союзников
    /// ближе `ADVANTAGE_RADIUS` к «силе» врагов там же — видимых или
    /// недавно замеченных радаром. Врагов нет — 10.
    fn advantage(&self, game: &BotView<'_>, pos: [f32; 2], health: f32) -> f32 {
        let allies = health / 100.0
            + game.team.map_or(0.0, |team| {
                team.strength_near(pos, ADVANTAGE_RADIUS, self.game_id)
            });
        let enemies: f32 = self
            .perception
            .threats_near(pos, ADVANTAGE_RADIUS)
            .filter(|c| c.visible || self.clock - c.updated_at < ADVANTAGE_RADAR_AGE)
            .map(|c| strength_of(c.condition))
            .sum();

        if enemies <= 0.0 {
            10.0
        } else {
            allies / enemies
        }
    }

    /// Нечем воевать: пушка пуста и бомбы нет или врага в её радиусе нет.
    fn out_of_ammo(&self, game: &BotView<'_>, me: &SelfState) -> bool {
        if self.gun_ammo(game) {
            return false;
        }

        let Some(bomb) = bomb_weapon(game) else {
            return true;
        };

        game.ammo(me.id, bomb.index) < 1.0
            || !self.perception.visible_contacts().any(|contact| {
                contact.level == me.level && dist(me.pos_array(), contact.pos) < bomb.radius
            })
    }

    /// Бот оторвался вперёд без перевеса (условие `Regroup`): не фланкер,
    /// в команде хотя бы двое, `advantage < 1` и до цели он ближе центра
    /// группы больше чем на `LEAD_GAP`.
    fn leading_alone(&self, game: &BotView<'_>, pos: [f32; 2], advantage: f32) -> bool {
        let Some(team) = game.team else {
            return false;
        };
        let (Some(target), Some(centroid)) = (self.target_contact(), team.centroid) else {
            return false;
        };

        team.role(self.game_id) != Role::Flanker
            && team.members.len() >= 2
            && advantage < 1.0
            && dist(pos, target.pos) + LEAD_GAP < dist(centroid, target.pos)
    }

    /// Сбор окончен: бот у центра группы или собирается слишком долго.
    fn regroup_done(&self, game: &BotView<'_>, pos: [f32; 2]) -> bool {
        let long = self.mode == BotMode::Regroup && self.clock - self.mode_since > REGROUP_TIME;

        long || game
            .team
            .and_then(|team| team.centroid)
            .is_none_or(|centroid| dist(pos, centroid) < REGROUP_RADIUS)
    }

    /// Новая случайная цель катания, проходимая для корпуса.
    fn set_roam_goal(&mut self, game: &mut BotView<'_>, hull_width: f32) {
        let tile = game.tile_size();
        let Some(nav) = game.nav.as_ref() else {
            return;
        };

        if let Some(point) = nav.random_point_where(game.rng, None, hull_width) {
            self.nav.set_goal(point, false, tile);
        }
    }

    /// Движение согласно текущему режиму.
    fn execute_movement(&mut self, game: &mut BotView<'_>, me: &SelfState, dt: f32) {
        if self.unstuck.is_some() {
            self.run_unstuck(game, me, dt);
            return;
        }

        match self.mode {
            BotMode::Roam => {
                if self.nav.goal().is_none() || self.nav.arrived() {
                    self.set_roam_goal(game, 2.0 * me.half_width);
                }

                // недостижимая точка — выбрать другую
                if self.drive_route(game, me, dt) == Some(NavStatus::Unreachable) {
                    self.nav.fail_goal();
                }
            }
            BotMode::Hunt | BotMode::Engage if self.evade_until > self.clock => {
                self.drive_evade(game, me, dt);
            }
            BotMode::Hunt => self.drive_hunt(game, me, dt),
            BotMode::Engage => self.drive_engage(game, me, dt),
            BotMode::Retreat => self.drive_retreat(game, me, dt),
            BotMode::Hold => self.drive_hold(game, me, dt),
            BotMode::Regroup => self.drive_regroup(game, me, dt),
            BotMode::Dead => self.release_movement(game),
        }
    }

    /// Погоня: маршрут к контакту цели (у невидимой — радарная позиция с
    /// шумом: «туда, где видел на радаре»). `Flanker` обходит прямую линию
    /// «группа → фокус», `Support` держится позади штурмовика.
    fn drive_hunt(&mut self, game: &mut BotView<'_>, me: &SelfState, dt: f32) {
        let Some(contact) = self.target_contact() else {
            self.release_movement(game);
            return;
        };
        let tile = game.tile_size();
        let mut goal = PathPoint {
            pos: contact.pos,
            level: contact.level,
        };
        let mut zones = Vec::new();

        if let Some(team) = game.team {
            match team.role(self.game_id) {
                Role::Flanker => {
                    let far = dist(me.pos_array(), contact.pos)
                        > engage_range(self.profile.preferred_range);
                    let focus = team
                        .focus
                        .and_then(|focus| self.perception.contact(focus))
                        .map(|focus| focus.pos);

                    if far && let (Some(centroid), Some(focus)) = (team.centroid, focus) {
                        zones.push(flank_zone(me.level, centroid, focus));
                    }
                }
                Role::Support => {
                    if let Some(point) = self.support_point(game, me, &contact) {
                        goal = point;
                    }
                }
                Role::Assault => {}
            }
        }

        self.nav.set_goal(goal, true, tile);

        if self.hesitate_until > self.clock {
            self.release_movement(game);
            self.stuck.reset();
            return;
        }

        self.drive_route_with(game, me, dt, &zones, 4.0 * tile);
    }

    /// Точка `Support`: в `SUPPORT_GAP` позади ближайшего штурмовика на
    /// линии «союзник → цель», прижатая к проходимой клетке.
    fn support_point(
        &self,
        game: &BotView<'_>,
        me: &SelfState,
        target: &Contact,
    ) -> Option<PathPoint> {
        let team = game.team?;
        let nav = game.nav.as_ref()?;
        let pos = me.pos_array();
        let ally = team
            .members
            .iter()
            .filter(|m| m.id != self.game_id && team.role(m.id) == Role::Assault)
            .min_by(|a, b| {
                dist_sq(pos, a.pos)
                    .total_cmp(&dist_sq(pos, b.pos))
                    .then(a.id.cmp(&b.id))
            })?;
        let to_target = Vector::new(target.pos[0] - ally.pos[0], target.pos[1] - ally.pos[1])
            .normalize_or_zero();
        let behind = Vector::new(ally.pos[0], ally.pos[1]) - to_target * SUPPORT_GAP;
        let snapped = nav.nearest_walkable_on(
            ally.level,
            [behind.x, behind.y],
            2.0 * me.half_width,
            4.0 * game.tile_size(),
        )?;

        Some(PathPoint {
            pos: snapped,
            level: ally.level,
        })
    }

    /// Отход: точка выбирается при входе и раз в `RETREAT_REPICK`; маршрут
    /// обходит зоны угроз. Видимая угроза в стороне, противоположной точке,
    /// — задним ходом, лицом к ней.
    fn drive_retreat(&mut self, game: &mut BotView<'_>, me: &SelfState, dt: f32) {
        let tile = game.tile_size();

        if self.retreat_pick_due() {
            self.pick_retreat_point(game, me);
        }

        let Some(point) = self.retreat_point else {
            self.release_movement(game);
            return;
        };
        let pos = me.pos_array();
        let threats = self.perception.retreat_threats(pos, THREAT_RADIUS);
        let zones = threat_zones(&threats);
        let facing = self
            .perception
            .nearest_visible(pos, THREAT_RADIUS)
            .is_some_and(|threat| {
                let to_threat = angle_of([threat.pos[0] - pos[0], threat.pos[1] - pos[1]]);
                let to_point = angle_of([point.pos[0] - pos[0], point.pos[1] - pos[1]]);

                normalize_angle(to_point - to_threat).abs() > 2.0
            });
        let reverse_distance = if facing { 8.0 * tile } else { 4.0 * tile };

        self.nav.set_goal(point, false, tile);
        self.drive_route_with(game, me, dt, &zones, reverse_distance);
    }

    /// Пора выбрать точку отхода: при входе в `Retreat` (`enter_mode`
    /// сдвигает `retreat_picked_at` назад) и раз в `RETREAT_REPICK`. Выбор без
    /// точки тоже ждёт `RETREAT_REPICK`: иначе он повторялся бы каждый тик и
    /// тратил общий бюджет маршрутов.
    fn retreat_pick_due(&self) -> bool {
        self.clock - self.retreat_picked_at >= RETREAT_REPICK
    }

    /// Выбор точки отхода: кандидаты (союзник, дом, прыжок вниз, укрытия),
    /// предотбор по эвристике, оценка маршрутом с зонами угроз.
    fn pick_retreat_point(&mut self, game: &mut BotView<'_>, me: &SelfState) {
        let pos = me.pos_array();
        let threats = self.perception.retreat_threats(pos, THREAT_RADIUS);

        if *game.route_budget == 0 {
            // бюджета тика нет: кандидатов не собирать, выбор — на следующем
            // тике (`retreat_picked_at` не трогается), а пока — запасная
            // точка, чтобы бот не стоял
            if self.retreat_point.is_none() {
                self.retreat_point = self.fallback_retreat_point(game, me, &threats);
            }

            return;
        }

        let candidates = self.retreat_candidates(game, me, &threats);
        let params = self.nav_params(game, me);
        let zones = threat_zones(&threats);
        let start = PathPoint {
            pos,
            level: me.level,
        };
        let mut best: Option<(PathPoint, f32)> = None;

        // бюджет есть хотя бы на одного кандидата; оценка без маршрута тоже
        // его тратит, поэтому выбор ниже фиксируется в любом случае
        for point in rank_retreat_candidates(pos, &threats, candidates) {
            // бюджет кончился: стоимость маршрута и эвристика несравнимы
            // (эвристика бывает отрицательной) — хватит оценённых
            let Some(route) = self.nav.route_cost(game, start, point, &params, &zones) else {
                break;
            };
            // маршрута нет — не кандидат
            let Some(cost) = route else {
                continue;
            };
            let allies = game.team.map_or(0, |team| {
                team.allies_near(point.pos, ALLY_NEAR, self.game_id).count()
            });
            let seen = game
                .nav
                .as_ref()
                .is_some_and(|nav| !hidden_from(nav, me.level, &threats, point.pos));
            let score = cost - 200.0 * allies as f32 + if seen { 300.0 } else { 0.0 };

            if best.is_none_or(|(_, best_score)| score < best_score) {
                best = Some((point, score));
            }
        }

        self.retreat_picked_at = self.clock;
        self.retreat_point = best
            .map(|(point, _)| point)
            .or_else(|| self.fallback_retreat_point(game, me, &threats));
    }

    /// Запасная точка отхода: дом дальше 1.5 тайла, иначе — прочь от
    /// ближайшей угрозы на 6 тайлов.
    fn fallback_retreat_point(
        &self,
        game: &BotView<'_>,
        me: &SelfState,
        threats: &[Contact],
    ) -> Option<PathPoint> {
        let tile = game.tile_size();
        let pos = me.pos_array();
        let far_enough = |p: &PathPoint| dist(pos, p.pos) >= 1.5 * tile;

        self.home.filter(far_enough).or_else(|| {
            // прочь от ближайшей угрозы на 6 тайлов
            let threat = threats
                .iter()
                .min_by(|a, b| dist_sq(pos, a.pos).total_cmp(&dist_sq(pos, b.pos)))?;
            let away = (me.pos - Vector::new(threat.pos[0], threat.pos[1])).normalize_or_zero();
            let q = me.pos + away * (6.0 * tile);
            let snapped = game.nav.as_ref()?.nearest_walkable_on(
                me.level,
                [q.x, q.y],
                2.0 * me.half_width,
                4.0 * tile,
            )?;

            Some(PathPoint {
                pos: snapped,
                level: me.level,
            })
        })
    }

    /// Кандидаты в точки отхода (не больше `RETREAT_CANDIDATES`): за
    /// ближайшим союзником, который дальше от угроз, чем бот; дом; до двух
    /// клеток для прыжка вниз; укрытия по 8 направлениям, которых не видит
    /// ни одна угроза. Точки ближе 1.5 тайла к боту (или к исключённой)
    /// отбрасываются: там бот уже стоит.
    fn retreat_candidates(
        &self,
        game: &BotView<'_>,
        me: &SelfState,
        threats: &[Contact],
    ) -> Vec<PathPoint> {
        let Some(nav) = game.nav.as_ref() else {
            return Vec::new();
        };
        let tile = game.tile_size();
        let hull = 2.0 * me.half_width;
        let pos = me.pos_array();
        let min_threat_dist = |p: [f32; 2]| {
            threats
                .iter()
                .map(|threat| dist(threat.pos, p))
                .fold(f32::MAX, f32::min)
        };
        let exclude = self.retreat_exclude;
        let usable = |p: &PathPoint| {
            dist(pos, p.pos) >= 1.5 * tile
                && exclude.is_none_or(|excluded| dist(excluded, p.pos) >= 1.5 * tile)
        };
        let mut out: Vec<PathPoint> = Vec::new();

        // союзник
        if let Some(team) = game.team {
            let mine = min_threat_dist(pos);
            let ally = team
                .members
                .iter()
                .filter(|m| m.id != self.game_id && min_threat_dist(m.pos) > mine)
                .min_by(|a, b| {
                    dist_sq(pos, a.pos)
                        .total_cmp(&dist_sq(pos, b.pos))
                        .then(a.id.cmp(&b.id))
                });

            if let Some(ally) = ally {
                let to_me =
                    Vector::new(pos[0] - ally.pos[0], pos[1] - ally.pos[1]).normalize_or_zero();
                let q = Vector::new(ally.pos[0], ally.pos[1]) - to_me * (1.5 * tile);

                if let Some(p) = nav.nearest_walkable_on(ally.level, [q.x, q.y], hull, 2.0 * tile) {
                    out.push(PathPoint {
                        pos: p,
                        level: ally.level,
                    });
                }
            }
        }

        // дом
        if let Some(home) = self.home {
            out.push(home);
        }

        // прыжок вниз: клетки без пола своего уровня с проходимой землёй ниже
        if let Some(levels) = game.levels
            && me.level > 0
            && game.tank_health(me.id) > fall_cost(game) + 10.0
        {
            let cx = (pos[0] / tile).floor();
            let cy = (pos[1] / tile).floor();
            let mut drops: Vec<(f32, PathPoint)> = Vec::new();

            for dy in -5..=5 {
                for dx in -5..=5 {
                    let x = (cx + dx as f32 + 0.5) * tile;
                    let y = (cy + dy as f32 + 0.5) * tile;
                    let d = dist(pos, [x, y]);

                    if d > 5.0 * tile || x < 0.0 || y < 0.0 || levels.has_floor(me.level, x, y) {
                        continue;
                    }

                    let landing = levels.landing_level(me.level, x, y);

                    if landing >= me.level || !nav.is_walkable_on(landing, x, y) {
                        continue;
                    }

                    if let Some(p) = nav.nearest_walkable_on(landing, [x, y], hull, 2.0 * tile) {
                        drops.push((
                            d,
                            PathPoint {
                                pos: p,
                                level: landing,
                            },
                        ));
                    }
                }
            }

            // устойчивая сортировка: при равенстве — порядок обхода (y, x)
            drops.sort_by(|a, b| a.0.total_cmp(&b.0));
            out.extend(
                drops
                    .into_iter()
                    .filter(|(_, p)| usable(p))
                    .take(2)
                    .map(|(_, p)| p),
            );
        }

        // укрытия: 8 направлений × {5, 8} тайлов
        for k in 0..8 {
            let angle = k as f32 * std::f32::consts::FRAC_PI_4;
            let dir = Vector::new(angle.cos(), angle.sin());

            for radius in [5.0, 8.0] {
                let q = me.pos + dir * (radius * tile);
                let Some(p) = nav.nearest_walkable_on(me.level, [q.x, q.y], hull, 2.0 * tile)
                else {
                    continue;
                };

                if hidden_from(nav, me.level, threats, p) {
                    out.push(PathPoint {
                        pos: p,
                        level: me.level,
                    });
                }
            }
        }

        out.retain(|p| usable(p));
        out.truncate(RETREAT_CANDIDATES);
        out
    }

    /// Засада: газ не жать, корпус держит угрозу в секторе башни, башня
    /// заранее смотрит на неё; раз в 2–3 с — небольшой сдвиг поперёк линии
    /// на угрозу, если там тоже укрытие.
    fn drive_hold(&mut self, game: &mut BotView<'_>, me: &SelfState, dt: f32) {
        let tile = game.tile_size();
        let pos = me.pos_array();
        let threat = self.hold_threat(pos);

        if self.clock >= self.hold_shift_at {
            self.hold_shift_at = self.clock + game.rng.range(2.0, 3.0);
            self.hold_point = threat.and_then(|threat| self.pick_hold_shift(game, me, &threat));
        }

        if let Some(point) = self.hold_point {
            if dist(pos, point) > 0.3 * tile {
                let opts = DriveOpts {
                    arrive_radius: 0.3 * tile,
                    allow_reverse: true,
                    reverse_distance: 4.0 * tile,
                    noise: false,
                    avoid: true,
                };

                self.drive_toward(game, me, point, opts, dt);
                return;
            }

            self.hold_point = None;
        }

        if let Some(threat) = threat {
            let dir = (Vector::new(threat.pos[0], threat.pos[1]) - me.pos).normalize_or_zero();
            let angle = me.angle_to(dir);

            if dir != Vector::ZERO && angle.abs() > game.max_gun_angle(me.id) - HULL_TURN_MARGIN {
                self.turn_in_place(game, angle);
                self.stuck.reset();
                return;
            }
        }

        self.release_movement(game);
        self.stuck.reset();
    }

    /// Сдвиг в засаде: ±1 тайл поперёк линии на угрозу (сторона — жребий,
    /// затем другая), только в проходимую точку под корпус, скрытую от угроз.
    fn pick_hold_shift(
        &self,
        game: &mut BotView<'_>,
        me: &SelfState,
        threat: &Contact,
    ) -> Option<[f32; 2]> {
        let tile = game.tile_size();
        let dir = (Vector::new(threat.pos[0], threat.pos[1]) - me.pos).normalize_or_zero();

        if dir == Vector::ZERO {
            return None;
        }

        let side = if game.rng.next_f32() < 0.5 { -1.0 } else { 1.0 };
        let threats = self
            .perception
            .retreat_threats(me.pos_array(), THREAT_RADIUS);
        let nav = game.nav.as_ref()?;
        let hull = 2.0 * me.half_width;

        [side, -side].into_iter().find_map(|side| {
            let p = me.pos + Vector::new(-dir.y, dir.x) * (side * tile);
            let p = [p.x, p.y];
            let fits = nav.is_walkable_on(me.level, p[0], p[1])
                && nav.fits_on(me.level, p[0], p[1], hull)
                && !nav.has_obstacle_between_on(me.level, me.pos_array(), p);

            (fits && hidden_from(nav, me.level, &threats, p)).then_some(p)
        })
    }

    /// Сбор: маршрут к центру группы, прижатому к проходимой клетке на
    /// уровне ближайшего к нему члена команды.
    fn drive_regroup(&mut self, game: &mut BotView<'_>, me: &SelfState, dt: f32) {
        let tile = game.tile_size();
        let goal = game.team.and_then(|team| {
            let centroid = team.centroid?;
            let level = team
                .members
                .iter()
                .min_by(|a, b| {
                    dist_sq(centroid, a.pos)
                        .total_cmp(&dist_sq(centroid, b.pos))
                        .then(a.id.cmp(&b.id))
                })?
                .level;
            let pos = game
                .nav
                .as_ref()
                .and_then(|nav| {
                    nav.nearest_walkable_on(level, centroid, 2.0 * me.half_width, 4.0 * tile)
                })
                .unwrap_or(centroid);

            Some(PathPoint { pos, level })
        });
        let Some(goal) = goal else {
            self.release_movement(game);
            return;
        };

        self.nav.set_goal(goal, true, tile);
        self.drive_route(game, me, dt);
    }

    /// Бой: дальше `preferred_range[1]` — маршрут к цели; ближе
    /// `preferred_range[0]` — задним ходом от неё («драчун» — вплотную, до
    /// бомбы); внутри полосы — «змейка» в секторе башни. Цель за лимитом
    /// башни — сначала корпус к ней.
    fn drive_engage(&mut self, game: &mut BotView<'_>, me: &SelfState, dt: f32) {
        let Some(contact) = self.target_contact() else {
            self.release_movement(game);
            return;
        };
        let tile = game.tile_size();
        let to = Vector::new(contact.pos[0], contact.pos[1]) - me.pos;
        let distance = to.length();
        let dir = to.normalize_or_zero();
        let [near, far] = self.profile.preferred_range;

        if distance > far {
            let goal = PathPoint {
                pos: contact.pos,
                level: contact.level,
            };

            self.hull_turn = false;
            self.weave_point = None;
            self.nav.set_goal(goal, true, tile);
            self.drive_route(game, me, dt);
            return;
        }

        if self.aim.hull_request.is_some() {
            self.hull_turn = true;
        }

        if self.hull_turn {
            let angle = me.angle_to(dir);

            if angle.abs() > game.max_gun_angle(me.id) - HULL_TURN_MARGIN {
                self.turn_in_place(game, angle);
                self.stuck.reset();
                return;
            }

            self.hull_turn = false;
        }

        if distance < near {
            self.weave_point = None;

            if self.profile.aggression > BACK_OFF_AGGRESSION {
                let arrive_radius = bomb_weapon(game).map_or(tile, |bomb| 0.5 * bomb.radius);
                let opts = DriveOpts {
                    arrive_radius,
                    allow_reverse: true,
                    reverse_distance: 4.0 * tile,
                    noise: false,
                    avoid: true,
                };

                self.drive_toward(game, me, contact.pos, opts, dt);
            } else {
                // задним ходом, лицом к цели
                let back = me.pos - dir * (2.0 * tile);
                let opts = DriveOpts {
                    arrive_radius: 0.0,
                    allow_reverse: true,
                    reverse_distance: 4.0 * tile,
                    noise: false,
                    avoid: true,
                };

                self.drive_toward(game, me, [back.x, back.y], opts, dt);
            }

            return;
        }

        self.weave(game, me, &contact, dir, dt);
    }

    /// «Змейка» внутри полосы боя: сторона меняется по таймеру, при упоре и
    /// (кроме `easy`) когда цель навела ствол на бота; союзник или проп на
    /// линии огня — сразу новая позиция.
    fn weave(
        &mut self,
        game: &mut BotView<'_>,
        me: &SelfState,
        contact: &Contact,
        dir: Vector,
        dt: f32,
    ) {
        let tile = game.tile_size();
        let since_pick = self.clock - self.weave_picked_at;
        let mut repick = self
            .weave_point
            .is_none_or(|point| dist(me.pos_array(), point) < tile);
        let aimed = contact.aiming_at_me;
        let dodge = aimed
            && !self.was_aimed_at
            && self.profile.skill != BotSkill::Easy
            && game.rng.next_f32() < 0.5;

        self.was_aimed_at = aimed;

        if self.clock >= self.weave_switch_at || dodge {
            self.flip_weave_side(game);
            repick = true;
        }

        if since_pick > WEAVE_REPICK_DELAY {
            match contact.fire_line {
                FireLine::Ally(ally) => {
                    // в сторону от союзника
                    if let Some(pos) = game.tank_position_rounded(ally) {
                        let cross = dir.perp_dot(Vector::new(pos[0], pos[1]) - me.pos);

                        self.weave_side = if cross > 0.0 { -1.0 } else { 1.0 };
                    }

                    repick = true;
                }
                // ящик крепкий: не расстреливать, а сменить позицию
                FireLine::Prop => {
                    self.flip_weave_side(game);
                    repick = true;
                }
                _ => {}
            }
        }

        if repick {
            // сторона — прочь от близкого союзника
            if let Some(ally) = game.team.and_then(|team| {
                team.allies_near(me.pos_array(), WEAVE_ALLY_RADIUS, self.game_id)
                    .min_by(|a, b| {
                        dist_sq(me.pos_array(), a.pos).total_cmp(&dist_sq(me.pos_array(), b.pos))
                    })
            }) {
                let cross = dir.perp_dot(Vector::new(ally.pos[0], ally.pos[1]) - me.pos);

                self.weave_side = if cross > 0.0 { -1.0 } else { 1.0 };
            }

            self.weave_point = self.pick_weave_point(game, me, dir);
            self.weave_picked_at = self.clock;
        }

        let Some(point) = self.weave_point else {
            // манёвру некуда: стоять лицом к цели
            self.release_movement(game);
            self.stuck.reset();
            return;
        };
        // без заднего хода: задом к точке манёвра цель ушла бы за лимит башни
        let opts = DriveOpts {
            arrive_radius: 0.5 * tile,
            allow_reverse: false,
            reverse_distance: 4.0 * tile,
            noise: true,
            avoid: true,
        };

        if self.drive_toward(game, me, point, opts, dt) && since_pick > WEAVE_REPICK_DELAY {
            self.flip_weave_side(game);
            self.weave_point = None;
        }
    }

    fn flip_weave_side(&mut self, game: &mut BotView<'_>) {
        self.weave_side = if self.weave_side > 0.0 { -1.0 } else { 1.0 };
        self.weave_switch_at = self.clock + game.rng.range(1.5, 3.0);
    }

    /// Точка «змейки»: под `WEAVE_ANGLE` к линии на цель в 3–6 тайлах, на
    /// полу своего уровня, с местом под корпус и без стены до неё. Точку за
    /// краем, под которой есть проходимый уровень ниже, бот в азарте
    /// принимает с вероятностью `edge_risk` (разыгрывается на каждую
    /// проверку): съедет с обрыва. Иначе другая сторона, затем вперёд/назад.
    fn pick_weave_point(
        &mut self,
        game: &mut BotView<'_>,
        me: &SelfState,
        dir: Vector,
    ) -> Option<[f32; 2]> {
        let tile = game.tile_size();
        let hull_width = 2.0 * me.half_width;
        let nav = game.nav.as_ref()?;
        let levels = game.levels;
        let from = me.pos_array();
        let fits = |p: Vector| {
            nav.is_walkable_on(me.level, p.x, p.y)
                && nav.fits_on(me.level, p.x, p.y, hull_width)
                && !nav.has_obstacle_between_on(me.level, from, [p.x, p.y])
        };
        let drop_below = |p: Vector| {
            levels.is_some_and(|levels| {
                let landing = levels.landing_level(me.level, p.x, p.y);

                landing < me.level && nav.is_walkable_on(landing, p.x, p.y)
            })
        };
        let side = if self.weave_side < 0.0 { -1.0 } else { 1.0 };

        for side in [side, -side] {
            let m = rotate(dir, side * WEAVE_ANGLE);
            let p = me.pos + m * (game.rng.range(3.0, 6.0) * tile);
            let accepted =
                fits(p) || (drop_below(p) && game.rng.next_f32() < self.profile.edge_risk);

            if accepted {
                self.weave_side = side;
                return Some([p.x, p.y]);
            }
        }

        [dir, -dir]
            .into_iter()
            .map(|m| me.pos + m * (3.0 * tile))
            .find(|p| fits(*p))
            .map(|p| [p.x, p.y])
    }

    /// Отъезд от своей бомбы: газ прочь от точки, где она лежит (только что
    /// положенная под корпус — прочь от цели).
    fn drive_evade(&mut self, game: &mut BotView<'_>, me: &SelfState, dt: f32) {
        let tile = game.tile_size();
        let from_bomb = self
            .bomb_pos
            .map_or(Vector::ZERO, |bomb| me.pos - Vector::new(bomb[0], bomb[1]));
        let away = if from_bomb.length() > 1.0 {
            from_bomb.normalize_or_zero()
        } else {
            self.target_contact()
                .map(|contact| {
                    (me.pos - Vector::new(contact.pos[0], contact.pos[1])).normalize_or_zero()
                })
                .filter(|v| *v != Vector::ZERO)
                .unwrap_or(-me.forward())
        };
        let point = me.pos + away * (3.0 * tile);
        let opts = DriveOpts {
            arrive_radius: 0.0,
            allow_reverse: true,
            reverse_distance: 4.0 * tile,
            noise: false,
            avoid: true,
        };

        self.drive_toward(game, me, [point.x, point.y], opts, dt);
    }

    fn nav_params(&self, game: &BotView<'_>, me: &SelfState) -> NavParams {
        NavParams {
            hull_width: 2.0 * me.half_width,
            hull_half_length: me.half_length,
            tile: game.tile_size(),
            ledge_cost_scale: self.ledge_cost_scale(game),
        }
    }

    /// Цена прыжка с обрыва: агрессивный здоровый бот в погоне прыгает
    /// охотнее, раненый прыжком не рискует.
    fn ledge_cost_scale(&self, game: &BotView<'_>) -> f32 {
        let health = game.tank_health(self.game_id);
        let fall_cost = fall_cost(game);

        match self.mode {
            // на отходе спрыгнуть — способ оторваться
            BotMode::Retreat if health > fall_cost + 10.0 => RETREAT_LEDGE_SCALE,
            BotMode::Hunt if health > fall_cost + 20.0 => 1.0 - 0.6 * self.profile.aggression,
            _ => 1.0,
        }
    }

    /// Езда по маршруту навигатора; возвращает статус поиска, если он был
    /// на этом тике.
    fn drive_route(
        &mut self,
        game: &mut BotView<'_>,
        me: &SelfState,
        dt: f32,
    ) -> Option<NavStatus> {
        let reverse_distance = 4.0 * game.tile_size();

        self.drive_route_with(game, me, dt, &[], reverse_distance)
    }

    /// Езда по маршруту с добавочными штрафными зонами `extra` и дистанцией
    /// заднего хода `reverse_distance`.
    fn drive_route_with(
        &mut self,
        game: &mut BotView<'_>,
        me: &SelfState,
        dt: f32,
        extra: &[PenaltyZone],
        reverse_distance: f32,
    ) -> Option<NavStatus> {
        let params = self.nav_params(game, me);
        let me_point = PathPoint {
            pos: me.pos_array(),
            level: me.level,
        };
        let ramp_ends = game
            .tank_on_ramp(me.id)
            .then(|| game.levels?.ramp_at(me_point.pos[0], me_point.pos[1]))
            .flatten()
            .map(|ramp| [ramp.from, ramp.to]);
        let mut status = None;

        if self.nav.needs_replan(me_point, true, ramp_ends, &params) {
            status = Some(
                self.nav
                    .plan(game, me_point, &params, extra, &mut self.stats),
            );
        }

        let Some(waypoint) = self.nav.follow(game, me_point, &params, dt) else {
            self.release_movement(game);
            self.stuck.reset();
            self.ramp_lock = false;
            return status;
        };

        self.drive_waypoint(game, me, &waypoint, &params, reverse_distance, dt);

        status
    }

    /// Езда к точке маршрута: рампа — с выравниванием, прочее — обычным
    /// рулением с объездом.
    fn drive_waypoint(
        &mut self,
        game: &mut BotView<'_>,
        me: &SelfState,
        waypoint: &Waypoint,
        params: &NavParams,
        reverse_distance: f32,
        dt: f32,
    ) {
        let tile = params.tile;
        let ramp = match (waypoint.kind, waypoint.next) {
            (LegKind::Ramp { axis, .. }, _) => Some((axis, waypoint.from, waypoint.pos)),
            // у подножия: следующий участок — прогон
            (
                _,
                Some(vimp_engine_core::nav::navigation::RouteLeg {
                    kind: LegKind::Ramp { axis, .. },
                    point,
                }),
            ) if dist(me.pos_array(), waypoint.pos) < 3.0 * tile => {
                Some((axis, waypoint.pos, point.pos))
            }
            _ => None,
        };

        if let Some((axis, foot, top)) = ramp {
            self.drive_ramp(game, me, axis, foot, top, tile, dt);
            return;
        }

        self.ramp_lock = false;

        let arrive_radius = if waypoint.is_last {
            (0.8 * tile).max(12.0)
        } else {
            0.0
        };
        let opts = DriveOpts {
            arrive_radius,
            allow_reverse: true,
            reverse_distance,
            noise: true,
            avoid: true,
        };

        self.drive_toward(game, me, waypoint.pos, opts, dt);
    }

    /// Точное руление на рампу: гейт входа (`level.rs`, `entry_is_legal`)
    /// пускает на прогон только с торца. Бот выходит на ось прогона в
    /// точке захода `A` перед подножием, разворачивается по оси и едет
    /// прямо, подруливая к центру полосы. Подъём и спуск — одинаково.
    #[allow(clippy::too_many_arguments)]
    fn drive_ramp(
        &mut self,
        game: &mut BotView<'_>,
        me: &SelfState,
        axis: u8,
        foot: [f32; 2],
        top: [f32; 2],
        tile: f32,
        dt: f32,
    ) {
        let u = if axis == 0 {
            Vector::new((top[0] - foot[0]).signum(), 0.0)
        } else {
            Vector::new(0.0, (top[1] - foot[1]).signum())
        };
        let rel = me.pos - Vector::new(foot[0], foot[1]);
        // поперечная ошибка: знак — сторона от оси прогона
        let lateral = u.perp_dot(rel);
        let heading_error = me.angle_to(u);
        let distance = dist(me.pos_array(), top);
        let precise = DriveOpts {
            arrive_radius: 0.0,
            allow_reverse: false,
            reverse_distance: 4.0 * tile,
            noise: false,
            avoid: false,
        };
        // по оси прогона с малой поправкой к центру полосы
        let along_axis = rotate(u, -(0.02 * lateral).clamp(-0.2, 0.2));

        if game.tank_on_ramp(me.id) {
            self.ramp_lock = true;
            self.drive_dir(game, me, along_axis, distance, precise, dt);
            return;
        }

        // вышли из полосы — выравниваться заново
        if self.ramp_lock && (lateral.abs() > 0.8 * tile || heading_error.abs() > 0.6) {
            self.ramp_lock = false;
        }

        if !self.ramp_lock && lateral.abs() <= 0.4 * tile && heading_error.abs() <= 0.3 {
            self.ramp_lock = true;
        }

        if self.ramp_lock {
            self.drive_dir(game, me, along_axis, distance, precise, dt);
            return;
        }

        let approach = [foot[0] - u.x * tile, foot[1] - u.y * tile];

        if dist(me.pos_array(), approach) < 0.5 * tile {
            // в точке захода: разворот на месте по оси прогона
            if heading_error.abs() > 0.12 {
                self.turn_in_place(game, heading_error);
                self.stuck.reset();
            } else {
                self.ramp_lock = true;
                self.drive_dir(game, me, along_axis, distance, precise, dt);
            }

            return;
        }

        let to_approach = DriveOpts {
            arrive_radius: 0.0,
            allow_reverse: true,
            reverse_distance: 4.0 * tile,
            noise: false,
            avoid: true,
        };

        self.drive_toward(game, me, approach, to_approach, dt);
    }

    /// Езда к точке; возвращает, упёрся ли бот в препятствие по курсу.
    fn drive_toward(
        &mut self,
        game: &mut BotView<'_>,
        me: &SelfState,
        target: [f32; 2],
        opts: DriveOpts,
        dt: f32,
    ) -> bool {
        let to = Vector::new(target[0], target[1]) - me.pos;
        let distance = to.length();

        self.drive_dir(game, me, to.normalize_or_zero(), distance, opts, dt)
    }

    /// Езда по направлению `desired` на дистанцию `distance`: лучи объезда,
    /// расступиться с союзником, шум руля, клавиши, детектор застревания.
    /// Возвращает, упёрся ли бот в препятствие по курсу.
    fn drive_dir(
        &mut self,
        game: &mut BotView<'_>,
        me: &SelfState,
        desired: Vector,
        distance: f32,
        opts: DriveOpts,
        dt: f32,
    ) -> bool {
        let tile = game.tile_size();
        let layered = game.levels.is_some_and(|levels| levels.is_layered());
        let avoidance = if opts.avoid && desired != Vector::ZERO {
            probe_obstacles(game, me, desired, layered)
        } else {
            Avoidance {
                dir: desired,
                blocked_ahead: false,
                prop_ahead: None,
                left_free: 1.0,
                right_free: 1.0,
            }
        };

        let mut dir = avoidance.dir;

        if opts.avoid {
            dir += ally_push(game, me);
        }

        let dir = if dir.normalize_or_zero() == Vector::ZERO {
            desired
        } else {
            dir.normalize_or_zero()
        };

        let mut angle = me.angle_to(dir);

        if opts.noise && distance > tile {
            angle += self.steer_bias;
        }

        let max_speed = game.max_forward_speed(me.id);
        let cmd = decide_drive(
            &DriveInput {
                angle,
                distance,
                forward_speed: me.forward_speed,
                max_speed,
                allow_reverse: opts.allow_reverse,
                reverse_distance: opts.reverse_distance,
                arrive_radius: opts.arrive_radius,
                blocked_ahead: avoidance.blocked_ahead,
            },
            self.prev_command(),
        );

        self.apply_drive(game, cmd);

        // во время манёвра выхода детектор молчит: манёвр ограничен по времени
        if self.unstuck.is_none() {
            let blocked = avoidance.blocked_ahead && distance > opts.arrive_radius;

            if self.stuck.update(
                dt,
                me.pos_array(),
                me.forward_speed,
                cmd.forward || cmd.back,
                blocked,
            ) {
                self.stats.stuck_events += 1;
                self.start_unstuck(game, me, &avoidance);
            }
        }

        avoidance.blocked_ahead
    }

    fn prev_command(&self) -> DriveCommand {
        DriveCommand {
            forward: self.keys.is_down(HeldKey::Forward),
            back: self.keys.is_down(HeldKey::Back),
            left: self.keys.is_down(HeldKey::Left),
            right: self.keys.is_down(HeldKey::Right),
        }
    }

    /// Разворот на месте: руль в сторону знака `angle`, газ отпущен.
    fn turn_in_place(&mut self, game: &mut BotView<'_>, angle: f32) {
        self.apply_drive(
            game,
            DriveCommand {
                right: angle > 0.0,
                left: angle < 0.0,
                ..DriveCommand::default()
            },
        );
    }

    fn apply_drive(&mut self, game: &mut BotView<'_>, cmd: DriveCommand) {
        self.set_key_state(game, HeldKey::Forward, cmd.forward);
        self.set_key_state(game, HeldKey::Back, cmd.back);
        self.set_key_state(game, HeldKey::Left, cmd.left);
        self.set_key_state(game, HeldKey::Right, cmd.right);
    }

    /// Начало манёвра выхода. Эскалация по числу попыток за
    /// `ATTEMPT_WINDOW`: отъезд назад → то же с меткой на точке упора →
    /// прострел пропа или объезд → отказ от цели.
    fn start_unstuck(&mut self, game: &mut BotView<'_>, me: &SelfState, avoidance: &Avoidance) {
        let attempt = self.stuck.register_attempt(self.clock);
        let tile = game.tile_size();
        let turn_right = if avoidance.right_free != avoidance.left_free {
            avoidance.right_free > avoidance.left_free
        } else {
            game.rng.next_f32() < 0.5
        };
        let reverse = UnstuckPhase::Reverse {
            left: game.rng.range(0.45, 0.8),
            turn_right,
            forward: false,
        };

        self.unstuck_time = 0.0;
        self.resolve_from = None;
        self.ramp_lock = false;

        let phase = match attempt {
            1 => reverse,
            2 => {
                let contact = me.pos + me.forward() * me.half_length;

                self.nav.add_avoid(AvoidMark {
                    level: me.level,
                    center: [contact.x, contact.y],
                    radius: 1.5 * tile,
                    ttl: 10.0,
                });
                self.nav.request_replan();

                reverse
            }
            3 | 4 => {
                if avoidance
                    .prop_ahead
                    .is_some_and(|distance| distance <= SHOOT_PROP_DISTANCE)
                {
                    UnstuckPhase::ShootProp { left: 1.5 }
                } else {
                    // объезд через точку в стороне, где свободнее
                    let side = if turn_right { 2.0 } else { -2.0 };
                    let aside = me.pos + rotate(me.forward(), side) * (5.0 * tile);
                    let detour = game.nav.as_ref().and_then(|nav| {
                        nav.nearest_walkable_on(
                            me.level,
                            [aside.x, aside.y],
                            2.0 * me.half_width,
                            8.0 * tile,
                        )
                    });

                    match detour {
                        Some(pos) => {
                            let point = PathPoint {
                                pos,
                                level: me.level,
                            };

                            self.nav.set_goal(point, false, tile);

                            UnstuckPhase::Detour { left: 3.0 }
                        }
                        None => reverse,
                    }
                }
            }
            _ => {
                self.nav.fail_goal();

                reverse
            }
        };

        self.unstuck = Some(phase);
    }

    /// Шаг манёвра выхода из застревания.
    fn run_unstuck(&mut self, game: &mut BotView<'_>, me: &SelfState, dt: f32) {
        let Some(phase) = self.unstuck else {
            return;
        };

        self.unstuck_time += dt;

        let next = match phase {
            UnstuckPhase::Reverse {
                left,
                turn_right,
                forward,
            } => {
                // сзади тоже стена: вперёд с тем же рулём
                let forward =
                    forward || (self.unstuck_time >= 0.3 && me.forward_speed.abs() < 4.0);

                self.apply_drive(
                    game,
                    DriveCommand {
                        forward,
                        back: !forward,
                        left: !turn_right,
                        right: turn_right,
                    },
                );

                let left = left - dt;

                if left <= 0.0 {
                    self.unstuck_time = 0.0;
                    Some(UnstuckPhase::Turn {
                        left: UNSTUCK_TURN_MAX,
                    })
                } else {
                    Some(UnstuckPhase::Reverse {
                        left,
                        turn_right,
                        forward,
                    })
                }
            }
            UnstuckPhase::Turn { left } => {
                let target = self
                    .nav
                    .current_point()
                    .or(self.nav.goal())
                    .map(|point| point.pos);
                let angle = target.map(|pos| {
                    me.angle_to((Vector::new(pos[0], pos[1]) - me.pos).normalize_or_zero())
                });
                let left = left - dt;

                match angle {
                    Some(angle) if angle.abs() >= 0.3 && left > 0.0 => {
                        self.turn_in_place(game, angle);

                        Some(UnstuckPhase::Turn { left })
                    }
                    _ => None,
                }
            }
            UnstuckPhase::ShootProp { left } => {
                self.release_movement(game);
                self.shoot_along_hull(game);

                let left = left - dt;

                if left <= 0.0 {
                    self.keys.release_gun(game, self.game_id);
                    None
                } else {
                    Some(UnstuckPhase::ShootProp { left })
                }
            }
            UnstuckPhase::Detour { left } => {
                self.drive_route(game, me, dt);

                let left = left - dt;

                if left <= 0.0 || self.nav.arrived() {
                    None
                } else {
                    Some(UnstuckPhase::Detour { left })
                }
            }
        };

        self.unstuck = next;

        if next.is_none() {
            self.release_movement(game);
            self.stuck.reset();
            self.resolve_from = Some(me.pos_array());
            self.resolve_timer = RESOLVE_TIME;
        }
    }

    /// Ствол по оси корпуса и огонь (забор и ящик ломаются).
    fn shoot_along_hull(&mut self, game: &mut BotView<'_>) {
        let Some(tank) = game.tanks.get(&self.game_id) else {
            return;
        };
        let angle_difference = normalize_angle(-tank.gun_rotation);
        let aim_threshold = 0.1;

        if angle_difference > aim_threshold {
            self.set_key_state(game, HeldKey::GunRight, true);
            self.set_key_state(game, HeldKey::GunLeft, false);
            return;
        }

        if angle_difference < -aim_threshold {
            self.set_key_state(game, HeldKey::GunLeft, true);
            self.set_key_state(game, HeldKey::GunRight, false);
            return;
        }

        self.keys.release_gun(game, self.game_id);

        // по пропу — пушкой, не бомбой под себя
        let Some(w1) = game.weapon_index("w1") else {
            return;
        };

        if self.clock < self.prop_shot_at || !self.select_weapon(game, w1) {
            return;
        }

        self.press_fire(game);
        self.prop_shot_at = self.clock + SHOOT_PROP_DELAY;
    }

    /// Успех манёвра: за `RESOLVE_TIME` после его конца бот сместился.
    fn track_resolve(&mut self, me: &SelfState, dt: f32) {
        let Some(from) = self.resolve_from else {
            return;
        };

        self.resolve_timer -= dt;

        if dist(from, me.pos_array()) > RESOLVE_MOVE {
            self.stats.unstuck_resolved += 1;
            self.resolve_from = None;
        } else if self.resolve_timer <= 0.0 {
            self.resolve_from = None;
        }
    }

    /// Сторож: бот, который `WATCHDOG_TIME` не сдвинулся без намеренной
    /// остановки, сбрасывает маршрут и манёвр и едет заново.
    fn watchdog(&mut self, game: &mut BotView<'_>, me: &SelfState, dt: f32) {
        // намеренная остановка: бой с видимой целью, засада или бот
        // «осматривается»
        let intentional = (self.mode == BotMode::Engage
            && self.target_contact().is_some_and(|contact| contact.visible))
            || self.mode == BotMode::Hold
            || self.hesitate_until > self.clock;
        let pos = me.pos_array();

        match self.watchdog_pos {
            Some(start) if !intentional && dist(start, pos) < WATCHDOG_MOVE => {
                self.watchdog_time += dt;

                if self.watchdog_time >= WATCHDOG_TIME {
                    self.stats.watchdog_resets += 1;
                    self.nav.clear();
                    self.unstuck = None;
                    self.ramp_lock = false;
                    self.stuck.reset();
                    self.release_all_keys(game);
                    self.watchdog_pos = Some(pos);
                    self.watchdog_time = 0.0;
                }
            }
            _ => {
                self.watchdog_pos = Some(pos);
                self.watchdog_time = 0.0;
            }
        }
    }

    /// Прицеливание и стрельба (линия огня считается здесь же).
    #[cfg(test)]
    pub(super) fn execute_aim_and_shoot(&mut self, game: &mut BotView<'_>, dt: f32) {
        let Some(me) = SelfState::read(game, self.game_id) else {
            return;
        };
        let line = self.attack_line(game, &me);

        self.aim_and_shoot(game, &me, line, dt);
    }

    /// Есть ли патроны у пушки `w1`.
    fn gun_ammo(&self, game: &BotView<'_>) -> bool {
        game.weapon_index("w1")
            .is_some_and(|index| game.ammo(self.game_id, index) >= 1.0)
    }

    /// Прицел, башня, оружие и огонь по уже посчитанной линии огня. Башня
    /// ведёт контакт прицела (`aim_contact`; невидимый — по радару, «держит
    /// угол»), стрельба — только по видимому при чистой линии огня. На отходе
    /// ошибка прицела больше.
    fn aim_and_shoot(
        &mut self,
        game: &mut BotView<'_>,
        me: &SelfState,
        line: Option<FireLine>,
        dt: f32,
    ) {
        self.aim.decay(dt);
        self.aim.aim_penalty = if self.mode == BotMode::Retreat {
            RETREAT_AIM_PENALTY
        } else {
            1.0
        };

        let contact = self
            .aim_contact(me.pos_array())
            .filter(|contact| game.tank_alive(contact.id));
        let Some(contact) = contact else {
            if self.aim.target.is_some() {
                self.aim.reset();
            }

            self.keys.release_gun(game, self.game_id);
            self.return_to_gun(game);
            return;
        };
        let visible = contact.visible;
        // у видимой цели — истинная позиция, у невидимой — контакт
        let target_pos = if visible {
            game.tank_position_rounded(contact.id)
                .unwrap_or(contact.pos)
        } else {
            contact.pos
        };
        let to = Vector::new(target_pos[0], target_pos[1]) - me.pos;
        let distance = to.length().max(1.0);
        let dir = to / distance;
        let target_angle = angle_of([to.x, to.y]);
        let gun_angle = game.gun_world_angle(me.id);
        let target_vel = if visible {
            let v = game.tank_linvel(contact.id);

            Vector::new(v[0], v[1])
        } else {
            Vector::ZERO
        };
        // поперечная скорость цели: из неё и ошибка захвата, и угловая скорость
        let lateral_speed = target_vel.perp_dot(dir).abs();

        if self.aim.target != Some(contact.id)
            || (visible && self.aim.unseen_for(self.clock, REACQUIRE_TIME))
        {
            let pre_aimed = normalize_angle(gun_angle - target_angle).abs() < PRE_AIMED_ANGLE;

            self.aim.retarget(
                contact.id,
                self.clock,
                &self.profile,
                game.rng,
                lateral_speed,
                pre_aimed,
            );
            self.switch_presses = 0;
        }

        self.aim
            .note_sight(visible, self.clock, &self.profile, game.rng);

        let max_speed = game.max_forward_speed(me.id);
        let error = self.aim.error(
            self.clock,
            &self.profile,
            me.forward_speed / max_speed.max(1.0),
            lateral_speed / distance,
        );
        let rel = normalize_angle(target_angle + error - me.heading);
        let gun_rotation = game.tanks.get(&me.id).map_or(0.0, |tank| tank.gun_rotation);
        let turret = self
            .aim
            .turret(rel, gun_rotation, game.max_gun_angle(me.id), self.clock);

        self.set_key_state(game, HeldKey::GunLeft, turret.left);
        self.set_key_state(game, HeldKey::GunRight, turret.right);

        // бомба вплотную
        if visible && self.wants_bomb(game, me, &contact, distance) {
            if let Some(bomb) = bomb_weapon(game)
                && self.select_weapon(game, bomb.index)
            {
                self.press_fire(game);
                self.evade_until = self.clock + BOMB_EVADE_TIME;
                self.bomb_pos = Some(me.pos_array());
                self.bomb_dropped_at = Some(self.clock);
            }

            return;
        }

        let Some(w1) = game.weapon_index("w1") else {
            return;
        };

        if !self.select_weapon(game, w1)
            || game.ammo(me.id, w1) < 1.0
            || !self.aim.ready(self.clock)
        {
            return;
        }

        let (target_half_length, _) = game.tank_half_extents(contact.id);
        let tol = fire_tolerance(target_half_length, distance, &self.profile);
        let off = normalize_angle(gun_angle - target_angle).abs();
        // в атаке дальше дистанции боя не стреляет: подъезжает, ствол уже
        // наведён; в обороне и по свежему обидчику — на любой дистанции
        let in_range = matches!(self.mode, BotMode::Hold | BotMode::Retreat)
            || distance <= engage_range(self.profile.preferred_range)
            || self.perception.recent_attacker(self.clock, RETALIATE_TIME) == Some(contact.id);
        let aimed = in_range && visible && line == Some(FireLine::Clear) && off < tol;
        // «в молоко»: цель только что скрылась за стеной, ствол смотрит туда
        let panic = in_range
            && !visible
            && line == Some(FireLine::Wall)
            && self.aim.panic_pending(self.clock)
            && off < 2.0 * tol;

        if aimed || panic {
            self.press_fire(game);
            self.aim.on_shot(self.clock, &self.profile, game.rng);
        }
    }

    /// Бомба под себя: цель на своём уровне ближе `0.8 · radius` или (на
    /// отходе) преследователь позади ближе `RETREAT_BOMB_DISTANCE`; бомбы
    /// есть, прошлая уже позади, и своя бомба не ранит (или «драчун» с
    /// запасом здоровья при огне по своим).
    fn wants_bomb(
        &self,
        game: &BotView<'_>,
        me: &SelfState,
        contact: &Contact,
        distance: f32,
    ) -> bool {
        let Some(bomb) = bomb_weapon(game) else {
            return false;
        };

        let close_fight = distance < BOMB_RANGE_SHARE * bomb.radius;
        let chaser = self.mode == BotMode::Retreat
            && distance < RETREAT_BOMB_DISTANCE
            && chasing_from_behind(game, me, contact);

        if self.clock < self.evade_until
            || contact.level != me.level
            || !(close_fight || chaser)
            || game.ammo(me.id, bomb.index) < 1.0
        {
            return false;
        }

        if game.friendly_fire && ally_in_blast(game, me, &bomb) {
            return false;
        }

        !game.friendly_fire
            || (self.profile.aggression > BOMB_FF_AGGRESSION
                && game.tank_health(me.id) > bomb.damage + 10.0)
    }

    /// Вне боя — вернуть пушку, если в руках бомба.
    fn return_to_gun(&mut self, game: &mut BotView<'_>) {
        if let Some(w1) = game.weapon_index("w1") {
            self.select_weapon(game, w1);
        }
    }

    /// Смена оружия на `index` клавишей `next_weapon`: не чаще раза в
    /// `WEAPON_SWITCH_DELAY` и не больше `weapons.len()` нажатий подряд
    /// (после паузы — снова). Возвращает, в руках ли уже нужное оружие.
    fn select_weapon(&mut self, game: &mut BotView<'_>, index: usize) -> bool {
        let current = game
            .tanks
            .get(&self.game_id)
            .map(|tank| tank.current_weapon);

        if current == Some(index) {
            self.switch_presses = 0;
            return true;
        }

        if self.clock < self.weapon_switch_at {
            return false;
        }

        if usize::from(self.switch_presses) >= game.weapons.len() {
            if self.clock < self.weapon_switch_at + 2.0 {
                return false;
            }

            self.switch_presses = 0;
        }

        let bit = game.key_bits.next_weapon;

        self.press_one_shot(game, bit);
        self.weapon_switch_at = self.clock + WEAPON_SWITCH_DELAY;
        self.switch_presses += 1;

        false
    }
}

/// Враг позади по ходу бота и едет на него.
fn chasing_from_behind(game: &BotView<'_>, me: &SelfState, contact: &Contact) -> bool {
    let v = game.tank_linvel(me.id);
    let motion = Vector::new(v[0], v[1]);
    let motion = if motion.length() > 1.0 {
        motion
    } else {
        me.forward()
    };
    let rel = Vector::new(contact.pos[0], contact.pos[1]) - me.pos;
    let closing = Vector::new(contact.vel[0], contact.vel[1]).dot(-rel) > 0.0;

    rel.dot(motion) < 0.0 && closing
}

/// Цена падения на один уровень: урон падения сверх безопасной высоты.
fn fall_cost(game: &BotView<'_>) -> f64 {
    let rules = game.level_rules;

    (rules.fall_damage * f64::from((1.0 - rules.fall_damage_free_height).max(0.0)))
        .min(rules.max_fall_damage)
}

/// Точку `p` не видит ни одна угроза: стена между ними и на сетке уровня
/// угрозы, и на сетке уровня бота.
fn hidden_from(nav: &NavigationSystem, my_level: u8, threats: &[Contact], p: [f32; 2]) -> bool {
    threats.iter().all(|threat| {
        nav.has_obstacle_between_on(threat.level, threat.pos, p)
            && nav.has_obstacle_between_on(my_level, threat.pos, p)
    })
}

/// Штрафные зоны угроз для маршрута отхода.
fn threat_zones(threats: &[Contact]) -> Vec<PenaltyZone> {
    threats
        .iter()
        .map(|threat| PenaltyZone {
            level: threat.level,
            center: threat.pos,
            radius: THREAT_ZONE_RADIUS,
            cost_per_unit: THREAT_ZONE_COST,
        })
        .collect()
}

/// Эвристика точки отхода `p` для бота в `pos`: ближе к боту, дальше от
/// ближайшей угрозы (меньше — лучше, бывает отрицательной).
fn retreat_heuristic(pos: [f32; 2], threats: &[Contact], p: [f32; 2]) -> f32 {
    let nearest = threats
        .iter()
        .map(|threat| dist(threat.pos, p))
        .fold(None, |acc: Option<f32>, d| {
            Some(acc.map_or(d, |a| a.min(d)))
        })
        .unwrap_or(0.0);

    dist(pos, p) - 1.5 * nearest
}

/// Кандидаты отхода по эвристике «ближе к боту, дальше от угроз» (устойчиво:
/// при равенстве — порядок сбора), не больше `RETREAT_ROUTED`.
fn rank_retreat_candidates(
    pos: [f32; 2],
    threats: &[Contact],
    mut candidates: Vec<PathPoint>,
) -> Vec<PathPoint> {
    // устойчивая сортировка: при равенстве — порядок сбора
    candidates.sort_by(|a, b| {
        retreat_heuristic(pos, threats, a.pos).total_cmp(&retreat_heuristic(pos, threats, b.pos))
    });
    candidates.truncate(RETREAT_ROUTED);
    candidates
}

/// Бомба `w2` по конфигу оружия.
#[derive(Clone, Copy)]
struct BombWeapon {
    index: usize,
    /// Радиус взрыва, ед.
    radius: f32,
    /// Урон в эпицентре.
    damage: f64,
    /// Задержка взрыва после закладки, с (`time` оружия — в мс).
    fuse: f32,
}

fn bomb_weapon(game: &BotView<'_>) -> Option<BombWeapon> {
    let index = game.weapon_index("w2")?;
    let (_, weapon) = game.weapons.get_index(index)?;

    Some(BombWeapon {
        index,
        radius: weapon.radius,
        damage: weapon.damage,
        fuse: weapon.time / 1000.0,
    })
}

/// Союзник своего уровня успеет попасть под взрыв: он ближе радиуса взрыва
/// плюс путь на своей полной скорости за время до взрыва. Своя бомба при огне
/// по своим ранила бы его. Плита моста взрыв экранирует — чужой уровень не в
/// счёт.
fn ally_in_blast(game: &BotView<'_>, me: &SelfState, bomb: &BombWeapon) -> bool {
    let Some(team) = game.tank_team(me.id) else {
        return false;
    };

    game.tanks.iter().any(|(&id, tank)| {
        let reach = bomb.radius + game.max_forward_speed(id) * bomb.fuse;

        id != me.id
            && tank.team_id == team
            && tank.is_alive()
            && game.tank_level(id) == me.level
            && game
                .tank_position_rounded(id)
                .is_some_and(|pos| dist_sq(pos, me.pos_array()) < reach * reach)
    })
}

/// Расступиться с союзником своего уровня ближе 25 ед.
fn ally_push(game: &BotView<'_>, me: &SelfState) -> Vector {
    const RADIUS: f32 = 25.0;

    let Some(team) = game.tank_team(me.id) else {
        return Vector::ZERO;
    };
    let mut push = Vector::ZERO;

    for ally in game.spatial.query_nearby(me.pos.x, me.pos.y) {
        if ally.game_id == me.id
            || ally.team_id != team
            || game.tank_level(ally.game_id) != me.level
        {
            continue;
        }

        let away = me.pos - Vector::new(ally.x, ally.y);
        let d = away.length();

        if d > 1e-3 && d < RADIUS {
            push += away / d * (0.8 * (1.0 - d / RADIUS));
        }
    }

    push
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::bots::navigator::NavParams;
    use crate::bots::profile::BotProfile;
    use crate::bots::test_support::*;
    use crate::level::Transit;

    /// Линия огня бота по его цели.
    fn line_of(fixture: &mut Fixture, brain: &BotBrain) -> FireLine {
        let view = fixture.view();

        fire_line(&view, brain.game_id, brain.my_level, brain.target.unwrap())
    }

    /// Тик решений через 0.1 с с немедленным выбором цели.
    fn think(fixture: &mut Fixture, brain: &mut BotBrain) {
        let mut view = fixture.view();
        let me = SelfState::read(&view, brain.game_id).unwrap();

        brain.clock += 0.1;
        brain.target_timer = 0.0;
        brain.think(&mut view, &me);
    }

    #[test]
    fn bot_path_crosses_the_ramp() {
        let mut fixture = Fixture::new();

        fixture.add_tank(1, 1, 112.0, 112.0, 0);

        let mut brain = brain_at(1, [112.0, 112.0], 0);
        let mut view = fixture.view();
        let me = PathPoint {
            pos: [112.0, 112.0],
            level: 0,
        };
        let params = NavParams {
            hull_width: 9.0,
            hull_half_length: 6.0,
            tile: TILE,
            ledge_cost_scale: 1.0,
        };
        let mut crossed = false;

        // цель патрулирования случайна: ждём первую, что лежит на мосту
        for _ in 0..500 {
            brain.nav.clear();
            brain.set_roam_goal(&mut view, params.hull_width);

            if brain.nav.goal().is_some_and(|point| point.level == 1) {
                let status = brain.nav.plan(&mut view, me, &params, &[], &mut brain.stats);

                assert_eq!(status, NavStatus::Moving, "путь к мосту построен");
                assert!(
                    brain.nav.legs().iter().any(|leg| leg.point.level == 1),
                    "путь на мост обязан содержать точку уровня 1: {:?}",
                    brain.nav.legs()
                );

                crossed = true;
                break;
            }
        }

        assert!(crossed, "мост ни разу не выпал целью патрулирования");
    }

    #[test]
    fn bot_prefers_the_enemy_on_its_level() {
        let mut fixture = Fixture::new();

        fixture.add_tank(1, 1, 112.0, 112.0, 0);
        // ближний враг — на мосту, дальний — на земле
        fixture.add_tank(2, 2, 368.0, 208.0, 1);
        fixture.add_tank(3, 2, 112.0, 432.0, 0);

        let mut brain = brain_at(1, [112.0, 112.0], 0);

        think(&mut fixture, &mut brain);

        assert_eq!(brain.target, Some(3));
    }

    #[test]
    fn bot_holds_fire_through_the_slab() {
        let mut fixture = Fixture::new();

        // бот на мосту, цель — под плитой, на земле
        fixture.add_tank(1, 1, 368.0, 208.0, 1);
        fixture.add_tank(2, 2, 368.0, 432.0, 0);

        let mut brain = brain_at(1, [368.0, 208.0], 1);

        brain.mode = BotMode::Engage;
        brain.target = Some(2);
        fixture.tanks[&1].gun_rotation = std::f32::consts::FRAC_PI_2;

        assert_eq!(line_of(&mut fixture, &brain), FireLine::OutOfReach);
        assert!(
            !fires_within(&mut fixture, &mut brain, 100),
            "плита моста экранирует цель — выстрела быть не должно"
        );
    }

    #[test]
    fn bot_holds_fire_at_the_enemy_on_the_open_edge() {
        let mut fixture = Fixture::new();

        // бот на земле западнее моста, цель — на кромке без перил
        fixture.add_tank(1, 1, 200.0, 208.0, 0);
        fixture.add_tank(2, 2, 336.0, 208.0, 1);

        let mut brain = brain_at(1, [200.0, 208.0], 0);

        brain.mode = BotMode::Engage;
        brain.target = Some(2);

        assert_eq!(line_of(&mut fixture, &brain), FireLine::OutOfReach);
        assert!(
            !fires_within(&mut fixture, &mut brain, 100),
            "пуля с земли идёт под плитой — танк на кромке недосягаем"
        );
    }

    #[test]
    fn bot_fires_at_a_ground_enemy_under_the_edge() {
        let mut fixture = Fixture::new();

        // оба на земле, враг под кромкой плиты — пуля идёт под плитой и
        // достаёт его
        fixture.add_tank(1, 1, 200.0, 208.0, 0);
        fixture.add_tank(2, 2, 336.0, 208.0, 0);

        let mut brain = brain_at(1, [200.0, 208.0], 0);

        brain.mode = BotMode::Engage;
        brain.target = Some(2);

        assert_eq!(line_of(&mut fixture, &brain), FireLine::Clear);
        assert!(
            fires_within(&mut fixture, &mut brain, 100),
            "наземная цель под кромкой должна обстреливаться"
        );
    }

    #[test]
    fn attack_fire_waits_for_the_combat_distance() {
        // цель в 136 ед. с чистой линией огня, дистанция боя — 80 · 1.3 = 104
        let setup = |mode| {
            let mut fixture = Fixture::new();

            fixture.add_tank(1, 1, 200.0, 208.0, 0);
            fixture.add_tank(2, 2, 336.0, 208.0, 0);

            let mut brain = brain_at(1, [200.0, 208.0], 0);

            brain.mode = mode;
            brain.target = Some(2);
            brain.profile.preferred_range = [40.0, 80.0];

            (fixture, brain)
        };

        for mode in [BotMode::Hunt, BotMode::Engage] {
            let (mut fixture, mut brain) = setup(mode);

            assert_eq!(line_of(&mut fixture, &brain), FireLine::Clear);
            assert!(
                !fires_within(&mut fixture, &mut brain, 100),
                "{mode:?}: дальше дистанции боя атакующий не стреляет"
            );
        }

        for mode in [BotMode::Hold, BotMode::Retreat] {
            let (mut fixture, mut brain) = setup(mode);

            assert!(
                fires_within(&mut fixture, &mut brain, 100),
                "{mode:?}: в обороне бот отстреливается на любой дистанции"
            );
        }

        // свежему обидчику атакующий отвечает и за дистанцией боя, давнему — нет
        for (attacked_ago, expected) in [(0.0, true), (RETALIATE_TIME + 1.0, false)] {
            let (mut fixture, mut brain) = setup(BotMode::Engage);

            brain.perception.last_attacker = Some(2);
            brain.perception.last_attacked_at = Some(brain.clock - attacked_ago);

            assert_eq!(
                fires_within(&mut fixture, &mut brain, 100),
                expected,
                "обидчик ранил бота {attacked_ago} с назад"
            );
        }
    }

    #[test]
    fn bot_holds_fire_at_a_tank_high_on_the_ramp() {
        let mut fixture = Fixture::new();

        // бот на земле западнее рампы (строка 9, x 192..320), цель — высоко
        // на ней: склон дорастает до пули (0.075) на x = 201.6
        fixture.add_tank(1, 1, 100.0, 304.0, 0);
        fixture.add_tank(2, 2, 282.0, 304.0, 0);

        let mut brain = brain_at(1, [100.0, 304.0], 0);

        brain.mode = BotMode::Engage;
        brain.target = Some(2);

        assert_eq!(line_of(&mut fixture, &brain), FireLine::Embankment);
        assert!(
            !fires_within(&mut fixture, &mut brain, 100),
            "насыпь рампы закрывает цель — выстрела быть не должно"
        );
    }

    #[test]
    fn bot_on_the_slope_holds_fire_at_a_ground_tank_below_its_bullet() {
        let mut fixture = Fixture::new();

        // бот на склоне рампы (на x = 230.4 склон ровно 0.3) стреляет вбок:
        // пуля 0.375 выше верха наземной цели 0.094
        fixture.add_tank(1, 1, 230.4, 304.0, 0);
        fixture.tanks[&1].level_state.z = 0.3;
        fixture.tanks[&1].gun_rotation = std::f32::consts::FRAC_PI_2;
        fixture.add_tank(2, 2, 230.4, 400.0, 0);

        let mut brain = brain_at(1, [230.4, 304.0], 0);

        brain.mode = BotMode::Engage;
        brain.target = Some(2);

        assert_eq!(line_of(&mut fixture, &brain), FireLine::OutOfReach);
        assert!(
            !fires_within(&mut fixture, &mut brain, 100),
            "пуля со склона проходит над наземной целью — выстрела быть не должно"
        );
    }

    #[test]
    fn bot_fires_at_a_tank_at_the_foot_of_the_ramp() {
        let mut fixture = Fixture::new();

        // дальше радиуса бомбы, иначе бот берёт её
        fixture.add_tank(1, 1, 90.0, 304.0, 0);
        fixture.add_tank(2, 2, 196.0, 304.0, 0);

        let mut brain = brain_at(1, [90.0, 304.0], 0);

        brain.mode = BotMode::Engage;
        brain.target = Some(2);

        assert_eq!(line_of(&mut fixture, &brain), FireLine::Clear);
        assert!(
            fires_within(&mut fixture, &mut brain, 100),
            "у подножия насыпь ниже пули — цель достижима"
        );
    }

    #[test]
    fn falling_bot_releases_keys_and_does_not_get_stuck() {
        let mut fixture = Fixture::new();

        fixture.add_tank(1, 1, 368.0, 208.0, 1);

        let mut brain = brain_at(1, [368.0, 208.0], 1);

        brain.keys.states = [true; 6];
        brain.keys.synced = true;
        brain.stuck.low_speed_time = 0.5;
        fixture.tanks[&1].level_state.transit = Transit::Airborne {
            vz: 0.0,
            from: 1,
            to: 0,
            peak: 1.0,
        };

        let mut view = fixture.view();

        brain.update(&mut view, 0.2);

        assert_eq!(brain.keys.states, [false; 6], "все клавиши отпущены");
        assert_eq!(
            brain.stuck.low_speed_time, 0.0,
            "падение не считается застреванием"
        );
        assert_eq!(brain.mode, BotMode::Roam);
    }

    #[test]
    fn death_resets_the_stuck_state() {
        let mut fixture = Fixture::new();
        // танка с id 1 в мире нет — бот мёртв
        let mut brain = brain_at(1, [112.0, 112.0], 0);

        brain.stuck.register_attempt(0.0);
        brain.stuck.register_attempt(0.1);
        brain.resolve_from = Some([112.0, 112.0]);
        brain.ramp_lock = true;

        let mut view = fixture.view();

        brain.update(&mut view, 0.1);

        assert_eq!(brain.mode, BotMode::Dead);
        assert_eq!(
            brain.stuck.register_attempt(0.2),
            1,
            "после смерти эскалация начинается заново"
        );
        assert!(brain.resolve_from.is_none());
        assert!(!brain.ramp_lock);
    }

    #[test]
    fn strafe_point_respects_edges() {
        let mut fixture = Fixture::new();

        // бот посреди плиты моста без перил, цель — на север вдоль моста:
        // точки «змейки» по обе стороны лежат за краем плиты
        fixture.add_tank(1, 1, 368.0, 320.0, 1);

        let mut brain = brain_at(1, [368.0, 320.0], 1);
        let nav = fixture.nav.clone().unwrap();
        let north = Vector::new(0.0, -1.0);

        for (edge_risk, drops_expected) in [(0.0, false), (1.0, true)] {
            let mut picked = 0;
            let mut dropped = 0;

            brain.profile.edge_risk = edge_risk;

            for i in 0..60 {
                let mut view = fixture.view();
                let me = SelfState::read(&view, 1).unwrap();

                brain.weave_side = if i % 2 == 0 { 1.0 } else { -1.0 };

                if let Some(point) = brain.pick_weave_point(&mut view, &me, north) {
                    picked += 1;

                    if !nav.is_walkable_on(1, point[0], point[1]) {
                        dropped += 1;
                    }
                }
            }

            assert!(picked > 0, "edge_risk {edge_risk}: ни одной точки");

            if drops_expected {
                assert!(dropped > 0, "в азарте бот обязан иногда съезжать с края");
            } else {
                assert_eq!(dropped, 0, "без риска точка за краем не выбирается");
            }
        }
    }

    /// Бой с целью `target` без выдержки режима.
    fn engage(brain: &mut BotBrain, target: u32) {
        brain.mode = BotMode::Engage;
        brain.mode_since = -10.0;
        brain.target = Some(target);
        brain.target_since = -10.0;
        brain.profile.preferred_range = [150.0, 400.0];
    }

    /// Тики мозга (и, если `physics`, шаги танков) на `seconds` с; `check`
    /// смотрит на бота и мир после каждого тика мозга.
    fn run(
        fixture: &mut Fixture,
        brain: &mut BotBrain,
        seconds: f32,
        physics: bool,
        mut check: impl FnMut(&BotBrain, &Fixture),
    ) {
        const DT: f32 = 1.0 / 120.0;

        for _ in 0..(seconds / DT) as usize {
            let mut view = fixture.view();

            brain.update(&mut view, DT);
            check(brain, fixture);

            if physics {
                fixture.step(DT);
            }
        }
    }

    #[test]
    fn no_turret_before_reaction() {
        let mut fixture = Fixture::new();

        // цель на юге: башню надо повернуть
        fixture.add_tank(1, 1, 112.0, 112.0, 0);
        fixture.add_tank(2, 2, 112.0, 300.0, 0);

        let mut brain = brain_at(1, [112.0, 112.0], 0);
        let mut turned_after = false;

        engage(&mut brain, 2);
        run(&mut fixture, &mut brain, 1.5, false, |brain, _| {
            let gun = brain.keys.is_down(HeldKey::GunLeft) || brain.keys.is_down(HeldKey::GunRight);

            if brain.clock < brain.aim.react_until {
                assert!(!gun, "башня крутится до реакции: {}", brain.clock);
            } else if gun {
                turned_after = true;
            }
        });

        assert!(brain.aim.react_until > 0.0);
        assert!(turned_after, "после реакции башня обязана повернуться");
    }

    #[test]
    fn turret_limit_requests_hull_turn() {
        let mut fixture = Fixture::new();

        // корпус на восток, цель под 2.0 рад от его оси — за лимитом башни
        let angle: f32 = 2.0;

        fixture.add_tank(1, 1, 560.0, 112.0, 0);
        fixture.add_tank(
            2,
            2,
            560.0 + 200.0 * angle.cos(),
            112.0 + 200.0 * angle.sin(),
            0,
        );

        let mut brain = brain_at(1, [560.0, 112.0], 0);
        let mut requested = false;

        engage(&mut brain, 2);
        run(&mut fixture, &mut brain, 2.0, true, |brain, _| {
            requested |= brain.aim.hull_request.is_some();
        });

        let view = fixture.view();
        let me = SelfState::read(&view, 1).unwrap();
        let target = view.tank_position_rounded(2).unwrap();
        let rel =
            normalize_angle(angle_of([target[0] - me.pos.x, target[1] - me.pos.y]) - me.heading);

        assert!(requested, "цель за лимитом башни — корпус надо довернуть");
        assert!(
            rel.abs() < view.max_gun_angle(1),
            "корпус не довернулся: {rel}"
        );
    }

    #[test]
    fn fires_only_inside_tolerance() {
        let mut fixture = Fixture::new();

        fixture.add_tank(1, 1, 112.0, 112.0, 0);
        fixture.add_tank(2, 2, 412.0, 112.0, 0);

        let mut brain = brain_at(1, [112.0, 112.0], 0);
        let (half_length, _) = fixture.tanks[&2].half_extents();

        engage(&mut brain, 2);
        brain.profile.fire_tolerance = 1.0;

        let tol = fire_tolerance(half_length, 300.0, &brain.profile);

        fixture.tanks[&1].gun_rotation = 3.0 * tol;
        assert!(
            !fires_within(&mut fixture, &mut brain, 100),
            "ствол мимо цели — выстрела быть не должно"
        );

        fixture.tanks[&1].gun_rotation = 0.0;
        assert!(
            fires_within(&mut fixture, &mut brain, 100),
            "ствол в цели — огонь"
        );
    }

    #[test]
    fn bursts_have_pauses() {
        let mut fixture = Fixture::new();

        fixture.add_tank(1, 1, 112.0, 112.0, 0);
        fixture.add_tank(2, 2, 412.0, 112.0, 0);

        let mut brain = brain_at(1, [112.0, 112.0], 0);

        brain.profile = BotProfile::default();
        engage(&mut brain, 2);

        let profile = brain.profile;
        let mut shots: Vec<f32> = Vec::new();

        for _ in 0..200 {
            let before = brain.stats.shots_fired;

            fires_within(&mut fixture, &mut brain, 1);

            if brain.stats.shots_fired > before {
                shots.push(brain.clock);
            }
        }

        let n = shots.len() as f32;

        assert!(
            n >= 10.0 / (profile.shot_interval + profile.burst_pause[1])
                && n <= 10.0 / profile.shot_interval,
            "выстрелов за 10 с: {n}"
        );
        assert!(
            shots
                .windows(2)
                .any(|pair| pair[1] - pair[0] >= profile.burst_pause[0]),
            "нет пауз между очередями: {shots:?}"
        );
    }

    /// Положил ли бот бомбу за 1 с (огонь при `w2` в руках).
    fn drops_bomb(fixture: &mut Fixture, brain: &mut BotBrain) -> bool {
        let w2 = fixture.weapons.get_index_of("w2").unwrap();
        let mut dropped = false;
        let mut shots = brain.stats.shots_fired;

        engage(brain, 2);
        run(fixture, brain, 1.0, true, |brain, fixture| {
            if brain.stats.shots_fired > shots && fixture.tanks[&1].current_weapon == w2 {
                dropped = true;
            }

            shots = brain.stats.shots_fired;
        });

        dropped
    }

    #[test]
    fn bomb_only_at_close_range() {
        for (distance, friendly_fire, expected) in [
            (30.0, false, true),
            (100.0, false, false),
            (30.0, true, false),
        ] {
            let mut fixture = Fixture::new();

            fixture.friendly_fire = friendly_fire;
            fixture.add_tank(1, 1, 112.0, 112.0, 0);
            fixture.add_tank(2, 2, 112.0 + distance, 112.0, 0);

            let mut brain = brain_at(1, [112.0, 112.0], 0);

            brain.profile.aggression = 0.5;

            assert_eq!(
                drops_bomb(&mut fixture, &mut brain),
                expected,
                "враг в {distance} ед., friendly_fire {friendly_fire}"
            );
        }
    }

    #[test]
    fn bomb_spares_an_ally_with_friendly_fire() {
        // союзник успевает под взрыв ближе 50 + 260 · 0.3 = 128 ед. (радиус
        // `w2` плюс его путь на полной скорости до взрыва)
        for (ally, expected) in [
            (None, true),
            (Some(25.0), false),
            (Some(100.0), false),
            (Some(160.0), true),
        ] {
            let mut fixture = Fixture::new();

            // иначе «драчуну» не хватит здоровья на свою бомбу
            assert!(fixture.weapons["w2"].damage <= 89.0);

            fixture.friendly_fire = true;
            fixture.add_tank(1, 1, 112.0, 112.0, 0);
            fixture.add_tank(2, 2, 112.0 + 30.0, 112.0, 0);

            if let Some(distance) = ally {
                fixture.add_tank(3, 1, 112.0, 112.0 + distance, 0);
            }

            let mut brain = brain_at(1, [112.0, 112.0], 0);

            brain.profile.aggression = 0.9;

            assert_eq!(
                drops_bomb(&mut fixture, &mut brain),
                expected,
                "союзник в {ally:?} ед."
            );
        }
    }

    #[test]
    fn target_prefers_the_attacker() {
        let mut fixture = Fixture::new();

        fixture.add_tank(1, 1, 112.0, 112.0, 0);
        // ближний враг на юге, дальний на востоке целится в бота
        fixture.add_tank(2, 2, 112.0, 250.0, 0);
        fixture.add_tank(3, 2, 300.0, 112.0, 0);
        fixture.tanks[&3].gun_rotation = std::f32::consts::PI;

        let mut brain = brain_at(1, [112.0, 112.0], 0);

        think(&mut fixture, &mut brain);

        assert!(brain.perception.contact(3).unwrap().aiming_at_me);
        assert_eq!(brain.target, Some(3));
    }

    #[test]
    fn target_prefers_visible_over_closer_hidden() {
        let mut fixture = Fixture::new();

        fixture.add_tank(1, 1, 560.0, 112.0, 0);
        // ближний — за стеной периметра, дальний — в прямой видимости
        fixture.add_tank(2, 2, 700.0, 112.0, 0);
        fixture.add_tank(3, 2, 560.0, 300.0, 0);

        let mut brain = brain_at(1, [560.0, 112.0], 0);

        think(&mut fixture, &mut brain);

        assert!(!brain.perception.contact(2).unwrap().visible);
        assert!(brain.perception.contact(3).unwrap().visible);
        assert_eq!(brain.target, Some(3));
    }

    #[test]
    fn target_hysteresis_keeps_current() {
        let mut fixture = Fixture::new();

        fixture.add_tank(1, 1, 112.0, 112.0, 0);
        fixture.add_tank(2, 2, 292.0, 112.0, 0);
        fixture.add_tank(3, 2, 112.0, 312.0, 0);

        let mut brain = brain_at(1, [112.0, 112.0], 0);

        think(&mut fixture, &mut brain);
        assert_eq!(brain.target, Some(2), "без гистерезиса ближний лучше");

        // чуть более дальняя текущая цель, выдержка давно прошла
        brain.clock = 10.0;
        brain.target = Some(3);
        brain.target_since = 0.0;
        think(&mut fixture, &mut brain);

        assert_eq!(brain.target, Some(3));
    }

    #[test]
    fn damage_sets_last_attacker() {
        let mut fixture = Fixture::new();

        fixture.add_tank(1, 1, 112.0, 112.0, 0);
        fixture.add_tank(2, 2, 300.0, 112.0, 0);
        fixture.add_tank(3, 2, 112.0, 250.0, 0);
        fixture.tanks[&2].gun_rotation = std::f32::consts::PI;

        let mut brain = brain_at(1, [112.0, 112.0], 0);

        think(&mut fixture, &mut brain);
        assert_eq!(brain.perception.last_attacker, None);

        fixture.tanks[&1].health = 60.0;
        think(&mut fixture, &mut brain);

        assert_eq!(brain.perception.last_attacker, Some(2));
        assert_eq!(brain.perception.last_damage_at, Some(brain.clock));
        assert!(brain.perception.damage_recent > 30.0);
    }

    #[test]
    fn landing_damage_blames_no_one() {
        let mut fixture = Fixture::new();

        fixture.add_tank(1, 1, 112.0, 112.0, 0);
        fixture.add_tank(2, 2, 300.0, 112.0, 0);
        fixture.tanks[&2].gun_rotation = std::f32::consts::PI;

        let mut brain = brain_at(1, [112.0, 112.0], 0);

        think(&mut fixture, &mut brain);

        // приземлился на прошлом тике и получил урон от падения
        brain.fell_at = Some(brain.clock);
        fixture.tanks[&1].health = 60.0;
        think(&mut fixture, &mut brain);

        assert_eq!(brain.perception.last_attacker, None);
        assert_eq!(brain.perception.last_damage_at, Some(brain.clock));
        assert_ne!(
            brain.mode,
            BotMode::Engage,
            "оборона при атаке без обидчика"
        );
    }

    #[test]
    fn self_inflicted_damage_windows() {
        let mut fixture = Fixture::new();

        fixture.add_tank(1, 1, 112.0, 112.0, 0);

        let mut brain = brain_at(1, [112.0, 112.0], 0);
        let fuse = fixture.weapons["w2"].time / 1000.0;

        brain.clock = 10.0;

        // падение: окно `SELF_DAMAGE_WINDOW` после последнего тика в полёте
        brain.fell_at = Some(10.0 - 0.5 * SELF_DAMAGE_WINDOW);
        assert!(brain.self_inflicted_damage(&fixture.view()));

        brain.fell_at = Some(10.0 - 2.0 * SELF_DAMAGE_WINDOW);
        assert!(!brain.self_inflicted_damage(&fixture.view()));

        // своя бомба: только при огне по своим и только сразу после взрыва
        brain.bomb_dropped_at = Some(10.0 - fuse - 0.5 * SELF_DAMAGE_WINDOW);
        assert!(
            !brain.self_inflicted_damage(&fixture.view()),
            "огонь по своим выключен"
        );

        fixture.friendly_fire = true;
        assert!(brain.self_inflicted_damage(&fixture.view()));

        brain.bomb_dropped_at = Some(10.0 - fuse - 2.0 * SELF_DAMAGE_WINDOW);
        assert!(
            !brain.self_inflicted_damage(&fixture.view()),
            "взрыв давно позади"
        );
    }

    #[test]
    fn fire_line_reports_ally() {
        let mut fixture = Fixture::new();

        // бот, союзник и враг на одной прямой и одном уровне
        fixture.add_tank(1, 1, 100.0, 112.0, 0);
        fixture.add_tank(3, 1, 200.0, 112.0, 0);
        fixture.add_tank(2, 2, 300.0, 112.0, 0);
        fixture.sync_queries();

        let mut brain = brain_at(1, [100.0, 112.0], 0);

        brain.mode = BotMode::Engage;
        brain.target = Some(2);

        assert_eq!(line_of(&mut fixture, &brain), FireLine::Ally(3));
        assert!(
            !fires_within(&mut fixture, &mut brain, 60),
            "союзник на линии огня — выстрела быть не должно"
        );
    }

    fn inputs(mode: BotMode) -> ModeInputs {
        ModeInputs {
            mode,
            mode_age: 5.0,
            alive: true,
            has_contacts: true,
            health: 100.0,
            retreat_hp: 35.0,
            retreat_advantage: 0.5,
            advantage: 2.0,
            damage_age: None,
            threat_visible_near: false,
            target_visible: false,
            target_fire_clear: false,
            target_dist: 1000.0,
            preferred_range: [170.0, 420.0],
            lost_sight_for: 0.0,
            unclear_for: 0.0,
            out_of_ammo: false,
            retreat_arrived: false,
            safe_for: 0.0,
            ally_near: false,
            hold_expired: false,
            allies_pushing: false,
            leading_alone: false,
            regroup_done: false,
            enemy_close: false,
        }
    }

    /// Цель видна, линия огня чиста, дистанция боя.
    fn engage_ready(mode: BotMode) -> ModeInputs {
        ModeInputs {
            target_visible: true,
            target_fire_clear: true,
            target_dist: 300.0,
            ..inputs(mode)
        }
    }

    #[test]
    fn next_mode_follows_the_rule_table() {
        use BotMode::{Dead, Engage, Hold, Hunt, Regroup, Retreat, Roam};

        let cases = [
            (
                "1: гибель",
                ModeInputs {
                    alive: false,
                    ..inputs(Engage)
                },
                Dead,
            ),
            ("2: респаун", inputs(Dead), Roam),
            (
                "3: нет контактов",
                ModeInputs {
                    has_contacts: false,
                    ..inputs(Hunt)
                },
                Roam,
            ),
            (
                "4: мало здоровья под огнём",
                ModeInputs {
                    health: 30.0,
                    damage_age: Some(1.0),
                    ..inputs(Engage)
                },
                Retreat,
            ),
            (
                "4: мало здоровья, враг рядом",
                ModeInputs {
                    health: 30.0,
                    threat_visible_near: true,
                    ..inputs(Hunt)
                },
                Retreat,
            ),
            (
                "4: мало здоровья, но давно и без угрозы",
                ModeInputs {
                    health: 30.0,
                    damage_age: Some(5.0),
                    ..inputs(Hunt)
                },
                Hunt,
            ),
            (
                "4: перевес врага",
                ModeInputs {
                    health: 60.0,
                    advantage: 0.3,
                    ..inputs(Hunt)
                },
                Retreat,
            ),
            (
                "4: нечем воевать",
                ModeInputs {
                    out_of_ammo: true,
                    ..inputs(Regroup)
                },
                Retreat,
            ),
            (
                "5: пришёл",
                ModeInputs {
                    retreat_arrived: true,
                    ..inputs(Retreat)
                },
                Hold,
            ),
            (
                "5: тихо и свои рядом",
                ModeInputs {
                    safe_for: 3.0,
                    ally_near: true,
                    ..inputs(Retreat)
                },
                Hold,
            ),
            (
                "5: ещё в пути",
                ModeInputs {
                    safe_for: 3.0,
                    ..inputs(Retreat)
                },
                Retreat,
            ),
            (
                "6: добивают в засаде",
                ModeInputs {
                    health: 15.0,
                    threat_visible_near: true,
                    ..inputs(Hold)
                },
                Retreat,
            ),
            (
                "7: враг вплотную",
                ModeInputs {
                    enemy_close: true,
                    ..inputs(Hold)
                },
                Engage,
            ),
            (
                "7: враг вплотную, но здоровья мало",
                ModeInputs {
                    enemy_close: true,
                    health: 30.0,
                    ..inputs(Hold)
                },
                Hold,
            ),
            (
                "8: засада кончилась, силы равны",
                ModeInputs {
                    hold_expired: true,
                    advantage: 1.0,
                    ..inputs(Hold)
                },
                Hunt,
            ),
            (
                "8: засада кончилась, перевеса нет",
                ModeInputs {
                    hold_expired: true,
                    advantage: 0.8,
                    ..inputs(Hold)
                },
                Hold,
            ),
            (
                "8: свои пошли",
                ModeInputs {
                    allies_pushing: true,
                    ..inputs(Hold)
                },
                Hunt,
            ),
            (
                "9: оторвался",
                ModeInputs {
                    leading_alone: true,
                    ..inputs(Hunt)
                },
                Regroup,
            ),
            (
                "10: собрались",
                ModeInputs {
                    regroup_done: true,
                    ..inputs(Regroup)
                },
                Hunt,
            ),
            ("11: из погони", engage_ready(Hunt), Engage),
            ("11: из сбора", engage_ready(Regroup), Engage),
            ("11: с катания — через погоню", engage_ready(Roam), Hunt),
            (
                "11: далеко",
                ModeInputs {
                    target_dist: 600.0,
                    ..engage_ready(Hunt)
                },
                Hunt,
            ),
            (
                "12: потерял из виду",
                ModeInputs {
                    lost_sight_for: 1.5,
                    ..inputs(Engage)
                },
                Hunt,
            ),
            (
                "12: линия не чиста",
                ModeInputs {
                    unclear_for: 2.0,
                    ..inputs(Engage)
                },
                Hunt,
            ),
            ("13: контакт", inputs(Roam), Hunt),
            ("иначе без изменений", inputs(Hunt), Hunt),
        ];

        for (name, input, expected) in cases {
            assert_eq!(next_mode(&input), expected, "{name}");
        }
    }

    #[test]
    fn next_mode_holds_the_mode_but_retreats_at_once() {
        use BotMode::{Dead, Engage, Hunt, Retreat, Roam};

        let young = |input: ModeInputs| ModeInputs {
            mode_age: 0.2,
            ..input
        };

        // выдержка 0.5 с
        assert_eq!(
            next_mode(&young(ModeInputs {
                leading_alone: true,
                ..inputs(Hunt)
            })),
            Hunt
        );
        assert_eq!(
            next_mode(&young(ModeInputs {
                has_contacts: false,
                ..inputs(Hunt)
            })),
            Hunt
        );
        assert_eq!(
            next_mode(&young(ModeInputs {
                retreat_arrived: true,
                ..inputs(Retreat)
            })),
            Retreat
        );
        assert_eq!(next_mode(&young(engage_ready(Hunt))), Hunt);

        // гибель, респаун и отступление — без выдержки
        assert_eq!(
            next_mode(&young(ModeInputs {
                alive: false,
                ..inputs(Hunt)
            })),
            Dead
        );
        assert_eq!(next_mode(&young(inputs(Dead))), Roam);
        assert_eq!(
            next_mode(&young(ModeInputs {
                out_of_ammo: true,
                ..inputs(Engage)
            })),
            Retreat
        );

        // отступление важнее боя
        let wounded = ModeInputs {
            health: 30.0,
            threat_visible_near: true,
            ..engage_ready(Hunt)
        };

        assert_eq!(next_mode(&wounded), Retreat);
        assert_eq!(
            next_mode(&ModeInputs {
                mode: Engage,
                ..wounded
            }),
            Retreat
        );
    }

    fn member(id: u32, pos: [f32; 2], is_bot: bool) -> crate::bots::team::Member {
        crate::bots::team::Member {
            id,
            pos,
            level: 0,
            strength: 1.0,
            is_bot,
            mode: is_bot.then_some(BotMode::Hunt),
            target: None,
        }
    }

    #[test]
    fn advantage_counts_humans() {
        let mut fixture = Fixture::new();

        fixture.add_tank(1, 1, 100.0, 100.0, 0);
        fixture.add_tank(2, 2, 300.0, 100.0, 0);
        fixture.sync_queries();

        let mut brain = brain_at(1, [100.0, 100.0], 0);

        think(&mut fixture, &mut brain);
        assert!(
            brain
                .perception
                .contact(2)
                .is_some_and(|contact| contact.visible)
        );

        let alone = brain.advantage(&fixture.view(), [100.0, 100.0], 100.0);
        let mut board = crate::bots::team::TeamBoard::default();

        // союзник-человек рядом
        board.update(
            1,
            vec![
                member(1, [100.0, 100.0], true),
                member(3, [150.0, 100.0], false),
            ],
            &[],
            &[],
            0.0,
        );
        fixture.team = Some(board);

        let with_human = brain.advantage(&fixture.view(), [100.0, 100.0], 100.0);

        assert!((alone - 1.0).abs() < 1e-3, "{alone}");
        assert!((with_human - 2.0).abs() < 1e-3, "{with_human}");
    }

    /// Карта 20×20 со стенкой (колонка 10, строки 8..=12), бот на виду у
    /// угрозы, угроза — по ту сторону стены. Возвращает фикстуру, мозг бота
    /// после тика решений и угрозу.
    fn retreat_setup() -> (Fixture, BotBrain, Contact) {
        let mut grid = vec![vec![0; 20]; 20];

        for (y, row) in grid.iter_mut().enumerate() {
            row[0] = 1;
            row[19] = 1;

            if (8..=12).contains(&y) {
                row[10] = 1;
            }
        }

        grid[0] = vec![1; 20];
        grid[19] = vec![1; 20];

        let mut fixture = Fixture::new();

        fixture.nav = Some(NavigationSystem::generate(&grid, &[1], TILE));
        fixture.add_tank(1, 1, 7.5 * TILE, 3.5 * TILE, 0);
        fixture.add_tank(2, 2, 13.5 * TILE, 10.5 * TILE, 0);
        fixture.sync_queries();

        let mut brain = brain_at(1, [7.5 * TILE, 3.5 * TILE], 0);

        think(&mut fixture, &mut brain);

        let threat = *brain.perception.contact(2).unwrap();

        assert!(threat.visible, "бот стоит на виду");

        (fixture, brain, threat)
    }

    #[test]
    fn retreat_pick_waits_for_the_route_budget() {
        let (mut fixture, mut brain, threat) = retreat_setup();

        fixture.route_budget = 0;
        brain.retreat_picked_at = -5.0;

        let mut view = fixture.view();
        let me = SelfState::read(&view, 1).unwrap();
        let threats = brain.perception.retreat_threats(me.pos_array(), THREAT_RADIUS);
        let fallback = brain.fallback_retreat_point(&view, &me, &threats);

        brain.pick_retreat_point(&mut view, &me);

        assert_eq!(brain.retreat_picked_at, -5.0, "выбор не отложен");
        assert_eq!(brain.retreat_point, fallback, "без бюджета — запасная точка");

        fixture.route_budget = u32::MAX;

        let mut view = fixture.view();

        brain.pick_retreat_point(&mut view, &me);

        assert_eq!(brain.retreat_picked_at, brain.clock);

        let point = brain.retreat_point.expect("точка отхода");
        let nav = fixture.nav.as_ref().unwrap();

        assert!(
            nav.has_obstacle_between_on(0, threat.pos, point.pos),
            "угроза видит точку отхода {point:?}"
        );
    }

    #[test]
    fn retreat_pick_compares_only_routed_candidates() {
        let (mut fixture, mut brain, _) = retreat_setup();

        fixture.route_budget = 1;

        let mut view = fixture.view();
        let me = SelfState::read(&view, 1).unwrap();
        let pos = me.pos_array();
        let threats = brain.perception.retreat_threats(pos, THREAT_RADIUS);
        let ranked =
            rank_retreat_candidates(pos, &threats, brain.retreat_candidates(&view, &me, &threats));

        assert!(ranked.len() > 1, "нужны неоценённые кандидаты: {ranked:?}");

        brain.pick_retreat_point(&mut view, &me);

        assert_eq!(brain.retreat_point, Some(ranked[0]));
        assert_eq!(fixture.route_budget, 0);
    }

    #[test]
    fn retreat_pick_does_not_hog_the_route_budget() {
        // бот заперт в «кармане» (стены в строках и колонках 5 и 11): все
        // укрытия снаружи, маршрута к ним нет
        let mut grid = vec![vec![0; 20]; 20];

        for (y, row) in grid.iter_mut().enumerate() {
            row[0] = 1;
            row[19] = 1;

            if (5..=11).contains(&y) {
                row[5] = 1;
                row[11] = 1;
            }
        }

        grid[0] = vec![1; 20];
        grid[19] = vec![1; 20];

        for x in 5..=11 {
            grid[5][x] = 1;
            grid[11][x] = 1;
        }

        let mut fixture = Fixture::new();

        fixture.nav = Some(NavigationSystem::generate(&grid, &[1], TILE));
        fixture.add_tank(1, 1, 8.5 * TILE, 8.5 * TILE, 0);
        fixture.sync_queries();

        let mut brain = brain_at(1, [8.5 * TILE, 8.5 * TILE], 0);
        let me = SelfState::read(&fixture.view(), 1).unwrap();

        {
            let view = fixture.view();
            let ranked = rank_retreat_candidates(
                me.pos_array(),
                &[],
                brain.retreat_candidates(&view, &me, &[]),
            );

            assert!(
                ranked.len() > 2,
                "бюджета тика не хватит на всех: {ranked:?}"
            );
        }

        // тики ИИ по 2 поиска маршрута; вход в отход — выбор сразу
        brain.retreat_picked_at = brain.clock - RETREAT_REPICK;

        let mut spent = 0;

        for _ in 0..10 {
            fixture.route_budget = 2;
            brain.clock += 1.0 / 120.0;

            if brain.retreat_pick_due() {
                brain.pick_retreat_point(&mut fixture.view(), &me);
            }

            spent += 2 - fixture.route_budget;
        }

        assert_eq!(spent, 2, "недостижимые кандидаты оцениваются каждый тик");
        assert_eq!(
            brain.retreat_point, None,
            "запасной точки нет: ни дома, ни угроз"
        );
    }

    #[test]
    fn cover_point_is_hidden_from_threat() {
        let (mut fixture, mut brain, threat) = retreat_setup();
        let mut view = fixture.view();
        let me = SelfState::read(&view, 1).unwrap();

        brain.pick_retreat_point(&mut view, &me);

        let point = brain.retreat_point.expect("точка отхода");
        let nav = fixture.nav.as_ref().unwrap();

        assert!(
            nav.has_obstacle_between_on(0, threat.pos, point.pos),
            "угроза видит точку отхода {point:?}"
        );
    }
}
