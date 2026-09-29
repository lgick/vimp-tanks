//! Навигатор бота: маршрут `find_route` движка, перестроение, сглаживание,
//! метки «здесь застревали».

use serde::{Deserialize, Serialize};
use vimp_engine_core::nav::navigation::{LegKind, PathPoint, PathQuery, PenaltyZone, RouteLeg};

use super::brain::BotStats;
use super::geom::{dist, dist_sq};
use crate::tanks::BotView;

/// Стоимость штрафной зоны метки застревания за единицу длины ребра.
const AVOID_COST: f32 = 6.0;
/// Маршрут к движущейся цели перестраивается не реже, с.
const MOVING_GOAL_REPLAN: f32 = 2.0;
/// Дистанция до точки не улучшалась хотя бы на `STALL_PROGRESS` ед.
/// дольше `STALL_TIME` с — бот не продвигается.
const STALL_TIME: f32 = 1.5;
const STALL_PROGRESS: f32 = 4.0;
/// Пауза перед повтором после неудачного поиска, с.
const RETRY_DELAY: f32 = 1.0;
/// Период сглаживания маршрута (срезание лишних узлов), с.
const LOOKAHEAD_INTERVAL: f32 = 0.2;
/// Сколько участков вперёд пробует срезать сглаживание.
const LOOKAHEAD_LEGS: usize = 4;
/// «Бесконечная» лучшая дистанция: `f32::INFINITY` не пережил бы JSON-дамп.
const FAR: f32 = f32::MAX;

/// Временная метка «здесь застревали»: штрафная зона в запросах маршрута
/// этого бота, пока не истечёт `ttl`.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub(crate) struct AvoidMark {
    pub level: u8,
    pub center: [f32; 2],
    pub radius: f32,
    pub ttl: f32,
}

/// Результат шага навигатора.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NavStatus {
    Idle,
    Moving,
    #[allow(dead_code)] // статус есть в контракте навигатора, мозг проверяет `arrived()`
    Arrived,
    Waiting,
    Unreachable,
}

/// Параметры маршрута, которые мозг передаёт навигатору каждый тик.
pub(crate) struct NavParams {
    /// Ширина корпуса: `2 · half_extents.1`.
    pub hull_width: f32,
    /// Половина длины корпуса: `half_extents.0`.
    pub hull_half_length: f32,
    /// Размер тайла карты (`BotView::tile_size`).
    pub tile: f32,
    /// Множитель цены прыжка с обрыва.
    pub ledge_cost_scale: f32,
}

/// Текущая точка маршрута для вождения.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Waypoint {
    pub pos: [f32; 2],
    #[allow(dead_code)] // уровень точки — для отладки и этапов 4–6
    pub level: u8,
    pub kind: LegKind,
    /// Точка, откуда бот въезжает в этот участок (для рамп).
    pub from: [f32; 2],
    pub is_last: bool,
    /// Следующий участок маршрута (подножие рампы узнаётся по нему).
    pub next: Option<RouteLeg>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub(crate) struct Navigator {
    goal: Option<PathPoint>,
    /// Цель — движущийся танк: маршрут перестраивается по времени.
    moving_goal: bool,
    legs: Vec<RouteLeg>,
    index: usize,
    route_age: f32,
    /// Лучшая (минимальная) дистанция до текущей точки и сколько она не улучшалась.
    best_dist: f32,
    stall_time: f32,
    lookahead_timer: f32,
    failures: u8,
    retry_timer: f32,
    pending: bool,
    avoid: Vec<AvoidMark>,
    /// Позиция и уровень бота на момент построения маршрута («предыдущая
    /// точка» первого участка).
    #[serde(default)]
    origin: [f32; 2],
    #[serde(default)]
    origin_level: u8,
    /// Начало отрезка, по которому бот едет к текущей точке (для проверки
    /// отклонения): пройденная точка, место старта или место, откуда
    /// сглаживание срезало узлы.
    #[serde(default)]
    segment_start: [f32; 2],
    /// Шаг цепочки попыток поиска (а–г): бюджет кончился посреди цепочки —
    /// следующий тик продолжает с этого шага.
    #[serde(default)]
    attempt: u8,
}

impl Navigator {
    /// Новая цель. Малый сдвиг той же цели маршрут не ломает: подтягивается
    /// только последняя точка.
    pub(crate) fn set_goal(&mut self, goal: PathPoint, moving: bool, tile: f32) {
        self.moving_goal = moving;

        let replan = self
            .goal
            .is_none_or(|old| old.level != goal.level || dist(old.pos, goal.pos) > 3.0 * tile);

        self.goal = Some(goal);

        if replan {
            self.pending = true;
            self.attempt = 0;
            self.failures = 0;
            return;
        }

        if let Some(last) = self.legs.last_mut() {
            if last.point.level == goal.level {
                last.point.pos = goal.pos;
            }
        }
    }

    /// Сброс всего, кроме меток `avoid`.
    pub(crate) fn clear(&mut self) {
        let avoid = std::mem::take(&mut self.avoid);

        *self = Self {
            avoid,
            ..Self::default()
        };
    }

    /// Забыть цель и маршрут (мозг выберет новую).
    pub(crate) fn fail_goal(&mut self) {
        self.clear();
    }

    /// Требует перестроения на ближайшем тике.
    pub(crate) fn request_replan(&mut self) {
        if self.goal.is_some() {
            self.pending = true;
            self.attempt = 0;
        }
    }

    pub(crate) fn add_avoid(&mut self, mark: AvoidMark) {
        self.avoid.push(mark);
    }

    pub(crate) fn goal(&self) -> Option<PathPoint> {
        self.goal
    }

    #[cfg(test)]
    pub(crate) fn legs(&self) -> &[RouteLeg] {
        &self.legs
    }

    pub(crate) fn route_len(&self) -> usize {
        self.legs.len()
    }

    /// Маршрут пройден до конца.
    pub(crate) fn arrived(&self) -> bool {
        self.goal.is_some()
            && !self.pending
            && !self.legs.is_empty()
            && self.index >= self.legs.len()
    }

    /// Текущая точка маршрута (если он есть и не пройден).
    pub(crate) fn current_point(&self) -> Option<PathPoint> {
        self.legs.get(self.index).map(|leg| leg.point)
    }

    pub(crate) fn tick(&mut self, dt: f32) {
        self.route_age += dt;
        self.retry_timer -= dt;
        self.lookahead_timer -= dt;

        for mark in &mut self.avoid {
            mark.ttl -= dt;
        }

        self.avoid.retain(|mark| mark.ttl > 0.0);
    }

    /// Нужно ли перестроить маршрут. Застревание у точки (дистанция не
    /// улучшалась `STALL_TIME`) ставит метку `avoid` на эту точку.
    pub(crate) fn needs_replan(
        &mut self,
        me: PathPoint,
        grounded: bool,
        params: &NavParams,
    ) -> bool {
        if self.goal.is_none() {
            return false;
        }

        if self.pending {
            return true;
        }

        if self.retry_timer > 0.0 {
            return false;
        }

        // прошлый поиск не удался: повтор после паузы
        if self.legs.is_empty() {
            return true;
        }

        if self.moving_goal && self.route_age > MOVING_GOAL_REPLAN {
            return true;
        }

        let Some(current) = self.current_point() else {
            return false;
        };
        let (_, prev_level) = self.previous_point();

        // упал или заехал не туда: уровень не тот, что у маршрута
        if grounded && me.level != current.level && me.level != prev_level {
            return true;
        }

        if point_segment_distance(me.pos, self.segment_start, current.pos) > 3.0 * params.tile {
            return true;
        }

        if self.stall_time > STALL_TIME {
            self.stall_time = 0.0;
            self.avoid.push(AvoidMark {
                level: current.level,
                center: current.pos,
                radius: 1.5 * params.tile,
                ttl: 8.0,
            });

            return true;
        }

        false
    }

    /// Поиск маршрута цепочкой попыток: (а) полный запрос; (б) без
    /// ограничения ширины; (в) цель прижата к проходимой клетке; (г) прижат
    /// и старт. Каждая попытка стоит единицу общего бюджета тика.
    pub(crate) fn plan(
        &mut self,
        game: &mut BotView<'_>,
        me: PathPoint,
        params: &NavParams,
        extra: &[PenaltyZone],
        stats: &mut BotStats,
    ) -> NavStatus {
        let Some(goal) = self.goal else {
            return NavStatus::Idle;
        };
        let Some(nav) = game.nav.as_ref() else {
            return self.fail(stats);
        };

        let me = on_ramp_end(game, me);
        let zones = self.zones(extra);
        let query = PathQuery {
            min_width: params.hull_width,
            comfort_clearance: params.hull_half_length + 0.5 * params.tile,
            narrow_cost: 1.5,
            ledge_cost_scale: params.ledge_cost_scale,
            penalties: &zones,
        };
        let snap_radius = 4.0 * params.tile;
        let snapped_goal = |nav: &vimp_engine_core::nav::navigation::NavigationSystem| {
            nav.nearest_walkable_on(goal.level, goal.pos, params.hull_width, snap_radius)
                .map(|pos| PathPoint {
                    pos,
                    level: goal.level,
                })
        };

        loop {
            if *game.route_budget == 0 {
                self.pending = true;
                return NavStatus::Waiting;
            }

            *game.route_budget -= 1;

            let route = match self.attempt {
                0 => nav.find_route(me, goal, &query),
                1 => nav.find_route(
                    me,
                    goal,
                    &PathQuery {
                        min_width: 0.0,
                        ..query
                    },
                ),
                2 => snapped_goal(nav).and_then(|end| nav.find_route(me, end, &query)),
                _ => nav
                    .nearest_walkable_on(me.level, me.pos, params.hull_width, snap_radius)
                    .and_then(|pos| {
                        let start = PathPoint {
                            pos,
                            level: me.level,
                        };
                        let end = snapped_goal(nav).unwrap_or(goal);

                        nav.find_route(start, end, &query).map(|mut route| {
                            route.legs.insert(
                                0,
                                RouteLeg {
                                    point: start,
                                    kind: LegKind::Walk,
                                },
                            );
                            route
                        })
                    }),
            };

            if let Some(route) = route {
                self.legs = route.legs;
                self.index = 0;
                self.route_age = 0.0;
                self.failures = 0;
                self.pending = false;
                self.attempt = 0;
                self.origin = me.pos;
                self.origin_level = me.level;
                self.segment_start = me.pos;
                self.best_dist = FAR;
                self.stall_time = 0.0;
                self.lookahead_timer = 0.0;
                stats.replans += 1;

                return NavStatus::Moving;
            }

            if self.attempt >= 3 {
                return self.fail(stats);
            }

            self.attempt += 1;
        }
    }

    /// Штрафные зоны запроса: метки `avoid` и добавочные.
    fn zones(&self, extra: &[PenaltyZone]) -> Vec<PenaltyZone> {
        self.avoid
            .iter()
            .map(|mark| PenaltyZone {
                level: mark.level,
                center: mark.center,
                radius: mark.radius,
                cost_per_unit: AVOID_COST,
            })
            .chain(extra.iter().copied())
            .collect()
    }

    /// Стоимость маршрута до точки тем же запросом, что у `plan` (для выбора
    /// цели и точки отхода), с добавочными зонами `extra`. Стоит единицу
    /// общего бюджета тика; `None` — бюджета нет, `Some(None)` — маршрута нет.
    pub(crate) fn route_cost(
        &self,
        game: &mut BotView<'_>,
        start: PathPoint,
        end: PathPoint,
        params: &NavParams,
        extra: &[PenaltyZone],
    ) -> Option<Option<f32>> {
        if *game.route_budget == 0 {
            return None;
        }

        *game.route_budget -= 1;

        let start = on_ramp_end(game, start);
        let nav = game.nav.as_ref()?;
        let zones = self.zones(extra);
        let query = PathQuery {
            min_width: params.hull_width,
            comfort_clearance: params.hull_half_length + 0.5 * params.tile,
            narrow_cost: 1.5,
            ledge_cost_scale: params.ledge_cost_scale,
            penalties: &zones,
        };

        Some(nav.find_route(start, end, &query).map(|route| route.cost))
    }

    /// Поиск не удался: маршрут к прежней цели сбрасывается, иначе бот ехал
    /// бы по нему (и «приезжал» в его конец), а повтор не запускался бы.
    fn fail(&mut self, stats: &mut BotStats) -> NavStatus {
        self.legs.clear();
        self.index = 0;
        self.failures = self.failures.saturating_add(1);
        self.retry_timer = RETRY_DELAY;
        self.pending = false;
        self.attempt = 0;
        stats.route_failures += 1;

        NavStatus::Unreachable
    }

    /// Предыдущая точка текущего участка: прошлый участок или место старта.
    fn previous_point(&self) -> ([f32; 2], u8) {
        match self.index.checked_sub(1).and_then(|i| self.legs.get(i)) {
            Some(leg) => (leg.point.pos, leg.point.level),
            None => (self.origin, self.origin_level),
        }
    }

    /// Радиус «дошёл до точки» участка `index`; `None` — участок `Ledge`
    /// (пройден по уровню, а не по дистанции).
    fn reach_radius(&self, index: usize, tile: f32) -> Option<f32> {
        let leg = self.legs[index];
        let next = self.legs.get(index + 1);

        match leg.kind {
            LegKind::Ledge { .. } => None,
            LegKind::Ramp { .. } => Some(1.0 * tile),
            LegKind::Walk if next.is_some_and(|n| matches!(n.kind, LegKind::Ramp { .. })) => {
                Some(0.5 * tile)
            }
            LegKind::Walk if next.is_none() => Some((0.8 * tile).max(12.0)),
            LegKind::Walk => Some((0.6 * tile).max(10.0)),
        }
    }

    /// Шаг по маршруту: прогресс, «дошёл», сглаживание. `None` — маршрута
    /// нет или он пройден (`arrived()`).
    pub(crate) fn follow(
        &mut self,
        game: &BotView<'_>,
        me: PathPoint,
        params: &NavParams,
        dt: f32,
    ) -> Option<Waypoint> {
        if self.pending && self.legs.is_empty() {
            return None;
        }

        while self.index < self.legs.len() {
            let point = self.legs[self.index].point;
            let d = dist(me.pos, point.pos);

            let reached = match self.reach_radius(self.index, params.tile) {
                // обрыв пройден, когда бот приземлился на уровень точки
                None => me.level == point.level,
                // точка пешего участка засчитывается только на её уровне:
                // проезд под мостом не проходит точку на мосту
                Some(radius) if matches!(self.legs[self.index].kind, LegKind::Walk) => {
                    d <= radius && me.level == point.level
                }
                Some(radius) => d <= radius,
            };

            if !reached {
                if d < self.best_dist - STALL_PROGRESS {
                    self.best_dist = d;
                    self.stall_time = 0.0;
                } else {
                    self.stall_time += dt;
                }

                break;
            }

            self.index += 1;
            self.segment_start = point.pos;
            self.best_dist = FAR;
            self.stall_time = 0.0;
        }

        if self.index >= self.legs.len() {
            return None;
        }

        if self.lookahead_timer <= 0.0 {
            self.lookahead_timer = LOOKAHEAD_INTERVAL;
            self.smooth(game, me, params);
        }

        let leg = self.legs[self.index];

        Some(Waypoint {
            pos: leg.point.pos,
            level: leg.point.level,
            kind: leg.kind,
            from: self.previous_point().0,
            is_last: self.index + 1 == self.legs.len(),
            next: self.legs.get(self.index + 1).copied(),
        })
    }

    /// Срезает лишние узлы: едет сразу к самой дальней (до
    /// `LOOKAHEAD_LEGS` вперёд) точке, до которой по своему уровню есть
    /// коридор шириной корпуса. Участки `Ramp`/`Ledge` и точку перед `Ramp`
    /// не пропускает никогда.
    fn smooth(&mut self, game: &BotView<'_>, me: PathPoint, params: &NavParams) {
        let Some(nav) = game.nav.as_ref() else {
            return;
        };

        let last = (self.index + LOOKAHEAD_LEGS).min(self.legs.len() - 1);

        for j in (self.index + 1..=last).rev() {
            // точки index..=j — пешие и на уровне бота; пропускаются только
            // index..j, и за каждой из них идёт пеший участок — подножие
            // рампы (точка перед Ramp) пропущено быть не может
            let walkable = self.legs[self.index..=j]
                .iter()
                .all(|leg| matches!(leg.kind, LegKind::Walk) && leg.point.level == me.level);

            if walkable
                && nav.has_clear_corridor_on(
                    me.level,
                    me.pos,
                    self.legs[j].point.pos,
                    params.hull_width / 2.0 + 1.0,
                )
            {
                self.index = j;
                self.segment_start = me.pos;
                self.best_dist = FAR;
                self.stall_time = 0.0;
                return;
            }
        }
    }
}

/// Зона фланга: круг на середине отрезка «центр группы → фокус» радиусом
/// `0.35` его длины. Маршрут через неё дорог, и фланкер обходит прямую линию
/// группы на цель.
pub(crate) fn flank_zone(level: u8, centroid: [f32; 2], focus: [f32; 2]) -> PenaltyZone {
    PenaltyZone {
        level,
        center: [
            0.5 * (centroid[0] + focus[0]),
            0.5 * (centroid[1] + focus[1]),
        ],
        radius: 0.35 * dist(centroid, focus),
        cost_per_unit: 3.0,
    }
}

/// Старт маршрута на прогоне через уровень (`0 → 2`): посередине уровень
/// танка щёлкает на промежуточный (`level::update`), а у нав-графа там
/// уровней только два — концы прогона. Такой старт приводится к ближайшему
/// концу, иначе из середины рампы не строится ни один маршрут.
fn on_ramp_end(game: &BotView<'_>, me: PathPoint) -> PathPoint {
    let Some(ramp) = game.levels.and_then(|levels| levels.ramp_at(me.pos[0], me.pos[1])) else {
        return me;
    };

    if me.level == ramp.from || me.level == ramp.to {
        return me;
    }

    PathPoint {
        level: if ramp.progress < 0.5 { ramp.from } else { ramp.to },
        ..me
    }
}

/// Расстояние от точки до отрезка.
fn point_segment_distance(p: [f32; 2], a: [f32; 2], b: [f32; 2]) -> f32 {
    let ab = [b[0] - a[0], b[1] - a[1]];
    let len_sq = dist_sq(a, b);

    if len_sq <= f32::EPSILON {
        return dist(p, a);
    }

    let t = (((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / len_sq).clamp(0.0, 1.0);

    dist(p, [a[0] + ab[0] * t, a[1] + ab[1] * t])
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::bots::test_support::*;

    fn params() -> NavParams {
        NavParams {
            hull_width: 9.0,
            hull_half_length: 6.0,
            tile: TILE,
            ledge_cost_scale: 1.0,
        }
    }

    fn point(x: f32, y: f32, level: u8) -> PathPoint {
        PathPoint { pos: [x, y], level }
    }

    #[test]
    fn small_goal_shift_does_not_replan() {
        let mut nav = Navigator::default();

        nav.set_goal(point(100.0, 100.0, 0), true, TILE);
        assert!(nav.pending);

        nav.pending = false;
        nav.set_goal(point(100.0 + 2.0 * TILE, 100.0, 0), true, TILE);
        assert!(!nav.pending, "сдвиг меньше 3 тайлов маршрут не ломает");

        nav.set_goal(point(100.0 + 6.0 * TILE, 100.0, 0), true, TILE);
        assert!(nav.pending, "сдвиг больше 3 тайлов требует перестроения");

        nav.pending = false;
        nav.set_goal(point(100.0 + 6.0 * TILE, 100.0, 1), true, TILE);
        assert!(nav.pending, "смена уровня цели требует перестроения");
    }

    #[test]
    fn empty_budget_waits_and_keeps_the_route() {
        let mut fixture = Fixture::new();
        let mut nav = Navigator::default();
        let mut stats = BotStats::default();
        let me = point(112.0, 112.0, 0);

        nav.set_goal(point(112.0, 432.0, 0), false, TILE);

        let mut view = fixture.view();

        assert_eq!(
            nav.plan(&mut view, me, &params(), &[], &mut stats),
            NavStatus::Moving
        );

        let legs = nav.legs.clone();

        nav.set_goal(point(432.0, 432.0, 0), false, TILE);
        *view.route_budget = 0;

        assert_eq!(
            nav.plan(&mut view, me, &params(), &[], &mut stats),
            NavStatus::Waiting
        );
        assert_eq!(nav.legs, legs, "без бюджета маршрут не меняется");
        assert!(nav.pending, "поиск отложен до следующего тика");
    }

    #[test]
    fn failed_replan_drops_the_old_route() {
        let mut fixture = Fixture::new();
        let mut nav = Navigator::default();
        let mut stats = BotStats::default();
        let me = point(112.0, 112.0, 0);

        nav.set_goal(point(112.0, 432.0, 0), false, TILE);

        let mut view = fixture.view();

        assert_eq!(
            nav.plan(&mut view, me, &params(), &[], &mut stats),
            NavStatus::Moving
        );

        // новая цель за пределами карты: ни одна попытка её не найдёт
        nav.set_goal(point(-5000.0, -5000.0, 0), false, TILE);

        assert_eq!(
            nav.plan(&mut view, me, &params(), &[], &mut stats),
            NavStatus::Unreachable
        );
        assert!(nav.legs.is_empty(), "маршрут к старой цели сброшен");
        assert!(nav.follow(&view, me, &params(), 0.01).is_none());
        assert!(!nav.arrived(), "конец старого маршрута — не прибытие");

        nav.tick(1.1);
        assert!(
            nav.needs_replan(me, true, &params()),
            "после паузы поиск повторяется"
        );
    }

    #[test]
    fn stall_marks_the_point_and_requires_replan() {
        let mut nav = Navigator::default();

        nav.goal = Some(point(300.0, 112.0, 0));
        nav.legs = vec![RouteLeg {
            point: point(300.0, 112.0, 0),
            kind: LegKind::Walk,
        }];
        nav.origin = [112.0, 112.0];
        nav.segment_start = [112.0, 112.0];
        nav.stall_time = 1.6;

        assert!(nav.needs_replan(point(150.0, 112.0, 0), true, &params()));
        assert_eq!(nav.avoid.len(), 1);
        assert_eq!(nav.avoid[0].center, [300.0, 112.0]);

        nav.tick(7.9);
        assert_eq!(nav.avoid.len(), 1);
        nav.tick(0.2);
        assert!(nav.avoid.is_empty(), "метка истекает по ttl");
    }

    #[test]
    fn smoothing_never_skips_the_ramp() {
        let mut fixture = Fixture::new();
        let mut nav = Navigator::default();
        let mut stats = BotStats::default();
        // земля западнее рампы (строка 9, колонки 6..9) → плита моста
        let me = point(112.0, 304.0, 0);

        nav.set_goal(point(368.0, 272.0, 1), false, TILE);

        let mut view = fixture.view();

        assert_eq!(
            nav.plan(&mut view, me, &params(), &[], &mut stats),
            NavStatus::Moving
        );

        let ramp = nav
            .legs
            .iter()
            .position(|leg| matches!(leg.kind, LegKind::Ramp { .. }))
            .expect("маршрут на мост идёт через рампу");

        // сглаживание из каждой точки до рампы останавливается не дальше подножия
        for start in 0..ramp {
            nav.index = start;
            nav.lookahead_timer = 0.0;

            let from = if start == 0 {
                me
            } else {
                nav.legs[start - 1].point
            };

            nav.smooth(&view, from, &params());

            assert!(
                nav.index < ramp,
                "сглаживание перепрыгнуло рампу: {} ≥ {ramp}",
                nav.index
            );
        }
    }

    #[test]
    fn smoothing_jump_is_not_a_deviation() {
        let mut nav = Navigator::default();
        let walk = |x: f32, y: f32| RouteLeg {
            point: point(x, y, 0),
            kind: LegKind::Walk,
        };

        // узлы идут вдоль стены, бот срезал их и едет к третьему напрямую
        nav.goal = Some(point(400.0, 400.0, 0));
        nav.legs = vec![walk(112.0, 400.0), walk(400.0, 400.0), walk(400.0, 112.0)];
        nav.index = 2;
        nav.segment_start = [112.0, 112.0];

        assert!(
            !nav.needs_replan(point(150.0, 112.0, 0), true, &params()),
            "отклонение меряется от начала срезанного отрезка"
        );
    }

    #[test]
    fn flanker_route_avoids_the_direct_line() {
        use vimp_engine_core::nav::navigation::NavigationSystem;

        // 30×20, периметр и стена в колонке 15 с проходами в строках 3..=5 и 14..=17
        let mut grid = vec![vec![0; 30]; 20];

        for (y, row) in grid.iter_mut().enumerate() {
            row[0] = 1;
            row[29] = 1;

            if !(3..=5).contains(&y) && !(14..=17).contains(&y) {
                row[15] = 1;
            }
        }

        grid[0] = vec![1; 30];
        grid[19] = vec![1; 30];

        let nav = NavigationSystem::generate(&grid, &[1], 32.0);
        let group = point(3.5 * 32.0, 4.5 * 32.0, 0);
        let target = point(26.5 * 32.0, 4.5 * 32.0, 0);
        let lowest = |zones: &[PenaltyZone]| {
            let query = PathQuery {
                min_width: 9.0,
                penalties: zones,
                ..PathQuery::default()
            };
            let route = nav.find_route(group, target, &query).expect("маршрут есть");

            route
                .legs
                .iter()
                .map(|leg| leg.point.pos[1])
                .fold(0.0f32, f32::max)
        };

        assert!(lowest(&[]) < 7.0 * 32.0, "без зоны — через верхний проход");

        let zone = flank_zone(0, group.pos, target.pos);

        assert!(
            lowest(&[zone]) > 13.0 * 32.0,
            "с зоной фланга — через нижний проход"
        );
    }

    #[test]
    fn point_segment_distance_clamps_to_the_ends() {
        assert_eq!(
            point_segment_distance([5.0, 3.0], [0.0, 0.0], [10.0, 0.0]),
            3.0
        );
        assert_eq!(
            point_segment_distance([-4.0, 3.0], [0.0, 0.0], [10.0, 0.0]),
            5.0
        );
    }
}
