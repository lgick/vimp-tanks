//! Каркас предсказанного мира — порт `src/client/PredictedSet.js`
//! (срез tank-battle 2026-08). Множество тел, каждое из которых живёт либо
//! в режиме `Follow` (трансформ ведёт интерполяция), либо в `Predicted`
//! (телом владеет та же симуляция, что и своим танком).
//!
//! Зачем режимы: свой танк рисуется «сейчас», всё остальное — с задержкой
//! интерполяции. Пока тела не соприкасаются, разницы не видно; в контакте
//! она вылезает сразу — нарисованное тело отстаёт от авторитетного, и танк
//! законно оказывается внутри него. Поэтому связанные со своим танком тела
//! считаются в ТОЙ ЖЕ симуляции и в том же времени.
//!
//! Наследование JS ложится на композицию: общая механика (реконсиляция,
//! шаг, ошибка, возврат в интерполяцию) — в [`PredictedSet`], своё каждой
//! подсистемы — в трейте [`PredictedBodies`]:
//!   `update`          — как тела читаются из игровых данных;
//!   `snapshot_bodies` — как они читаются из сырого кадра (реконсиляция);
//!   `capture`         — правило захвата в предсказание;
//!   `render_data`     — формат блока для рендера.
//! Всё остальное общее, иначе две подсистемы (динамика карты, чужие танки)
//! разъедутся по поведению при первой же правке.
//!
//! Часов симуляции у подсистемы нет: шагает её [`crate::client::predictor`]
//! (`integrate_predicted`, `decay_error`), поэтому контакт со своим танком
//! разрешается в одном шаге, а replay реконсиляции переигрывает и её тела.

use indexmap::IndexMap;

use vimp_engine_core::client::game::PredictedRow;
use vimp_engine_core::client::interpolator::InterpolatedGame;
use vimp_engine_core::client::raycast::Box2;
use vimp_engine_core::client::rigid_body::{Body, MAP_SURFACE, Surface, integrate};
use vimp_engine_core::client::unpack::DecodedSnapshot;
use vimp_engine_core::physics::normalize_angle;

/// Насколько раздувается OBB своего танка при проверке захвата: контакт
/// лучше предсказать чуть раньше касания, чем опоздать — опоздание видно,
/// ранний захват нет. Экспортируется: тем же запасом подсистема динамики
/// карты замыкает захват по соседям.
pub const CAPTURE_MARGIN: f32 = 2.0;

// сколько тело держится предсказанным после последнего контакта (мс)
const PREDICTION_HOLD_MS: f64 = 300.0;

// скорость затухания ошибки предсказания (доля в секунду, как у своего танка)
const ERROR_DECAY_RATE: f64 = 10.0;

// порог расхождения (юнитов), выше которого ошибка снапится
const ERROR_SNAP_DISTANCE: f32 = 24.0;

// насколько предсказание должно сойтись с интерполяцией для возврата в follow
const DEMOTE_POSITION_EPSILON: f32 = 1.0;
const DEMOTE_ANGLE_EPSILON: f32 = 0.02;

/// Режим тела: трансформ ведёт интерполяция либо симуляция предиктора.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Follow,
    Predicted,
}

/// Трансформ тела (эталон интерполяции и сглаживающая ошибка).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Transform {
    pub x: f32,
    pub y: f32,
    pub angle: f32,
}

/// Авторитетное состояние тела из кадра.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ServerState {
    pub x: f32,
    pub y: f32,
    pub angle: f32,
    pub vx: f32,
    pub vy: f32,
    pub angvel: f32,
}

/// Тело множества: симуляционное состояние (`body` — ЦЕНТР бокса, как того
/// требует `client::rigid_body`), геометрия, материал и обвязка режимов.
#[derive(Clone, Debug, PartialEq)]
pub struct PredictedBody {
    pub body: Body,
    pub half_w: f32,
    pub half_h: f32,
    pub surface: Surface,
    pub mode: Mode,
    /// сглаживающая ошибка предсказания (гасится `decay_error`)
    pub error: Transform,
    pub last_contact_time: f64,
    /// последний интерполированный трансформ — то, как тело нарисовали бы
    /// в режиме `Follow`; по нему решается возврат из предсказания
    pub follow: Transform,
    /// приходил ли авторитетный кадр (`begin_reconcile`). До первого кадра
    /// `last_server` — это стартовый трансформ, ему верить нельзя
    pub has_server: bool,
    pub last_server: ServerState,
}

impl PredictedBody {
    /// Новое тело в режиме `Follow`. Геометрию и массу доопределяет
    /// подсистема — она одна знает габариты своей сущности.
    pub fn new(transform: Transform) -> Self {
        Self {
            body: Body {
                x: transform.x,
                y: transform.y,
                angle: transform.angle,
                ..Body::default()
            },
            half_w: 0.0,
            half_h: 0.0,
            surface: MAP_SURFACE,
            mode: Mode::Follow,
            error: Transform::default(),
            last_contact_time: f64::NEG_INFINITY,
            follow: transform,
            has_server: false,
            last_server: ServerState {
                x: transform.x,
                y: transform.y,
                angle: transform.angle,
                ..ServerState::default()
            },
        }
    }

    pub fn is_predicted(&self) -> bool {
        self.mode == Mode::Predicted
    }

    /// OBB тела по его симуляционному состоянию (решателю ошибка не нужна).
    pub fn obb(&self, margin: f32) -> Box2 {
        Box2 {
            x: self.body.x,
            y: self.body.y,
            angle: self.body.angle,
            half_w: self.half_w + margin,
            half_h: self.half_h + margin,
        }
    }

    /// Трансформ для рендера: симуляция плюс сглаживающая ошибка.
    pub fn render_transform(&self) -> Transform {
        Transform {
            x: self.body.x + self.error.x,
            y: self.body.y + self.error.y,
            angle: self.body.angle + self.error.angle,
        }
    }

    /// Отмечает контакт — продлевает удержание тела в предсказании
    /// (порт `PredictedSet.noteContacts`, у которого своего состояния нет).
    pub fn note_contact(&mut self, local_now: f64) {
        self.last_contact_time = local_now;
    }

    /// Перевод в предсказание: состояние засевается авторитетным кадром
    /// (до первого такого кадра — интерполированным, иначе тело
    /// телепортнётся в стартовый трансформ).
    pub fn promote(&mut self, local_now: f64) {
        let server = if self.has_server {
            self.last_server
        } else {
            ServerState {
                x: self.follow.x,
                y: self.follow.y,
                angle: self.follow.angle,
                ..ServerState::default()
            }
        };

        // едущее тело нарисовано интерполяцией, то есть отстаёт от
        // авторитетного на interpolation.delay: подмена состояния без
        // компенсации дёрнула бы спрайт на delay×v (для корпуса длиной
        // 8 юнитов это заметно). Разница уходит в ошибку и затухает, как
        // всякое другое расхождение подсистемы
        let render = self.render_transform();

        self.mode = Mode::Predicted;
        self.body.x = server.x;
        self.body.y = server.y;
        self.body.angle = server.angle;
        self.body.vx = server.vx;
        self.body.vy = server.vy;
        self.body.angvel = server.angvel;
        self.last_contact_time = local_now;
        self.error = Transform {
            x: render.x - self.body.x,
            y: render.y - self.body.y,
            angle: normalize_angle(render.angle - self.body.angle),
        };

        self.snap_huge_error();
    }

    /// Возврат в интерполяцию: ошибку обнуляем — дальше телом владеет
    /// интерполяция, и ненулевая ошибка развела бы спрайт с боксом трассера.
    pub fn demote(&mut self) {
        self.mode = Mode::Follow;
        self.body.x = self.follow.x;
        self.body.y = self.follow.y;
        self.body.angle = self.follow.angle;
        self.body.vx = 0.0;
        self.body.vy = 0.0;
        self.body.angvel = 0.0;
        self.error = Transform::default();
    }

    // расхождение больше порога проще снапнуть, чем протаскивать сглаживанием
    fn snap_huge_error(&mut self) {
        if self.error.x.hypot(self.error.y) > ERROR_SNAP_DISTANCE {
            self.error = Transform::default();
        }
    }
}

/// Общая механика подсистемы предсказанных тел.
pub struct PredictedSet {
    // потолок предсказанного множества: тела считаются на каждом шаге
    // симуляции, включая replay реконсиляции
    max_predicted: usize,
    bodies: IndexMap<String, PredictedBody>,
    // предсказание до replay (begin_reconcile)
    reconcile_snapshots: Option<IndexMap<String, Transform>>,
}

impl PredictedSet {
    pub fn new(max_predicted: usize) -> Self {
        Self {
            max_predicted,
            bodies: IndexMap::new(),
            reconcile_snapshots: None,
        }
    }

    pub fn max_predicted(&self) -> usize {
        self.max_predicted
    }

    pub fn bodies(&self) -> &IndexMap<String, PredictedBody> {
        &self.bodies
    }

    pub fn bodies_mut(&mut self) -> &mut IndexMap<String, PredictedBody> {
        &mut self.bodies
    }

    /// Сколько тел уже предсказывается (для потолка множества).
    pub fn count_predicted(&self) -> usize {
        self.bodies.values().filter(|b| b.is_predicted()).count()
    }

    /// Живые (мутируемые) предсказанные тела для решателя.
    pub fn predicted_bodies_mut(&mut self) -> Vec<&mut PredictedBody> {
        self.bodies
            .values_mut()
            .filter(|body| body.is_predicted())
            .collect()
    }

    /// Принимает авторитетное состояние тел кадра перед replay предиктора
    /// (`snapshot_bodies` подсистемы): запоминает серверное состояние, а
    /// предсказанным подменяет состояние авторитетным, сохранив копию для
    /// [`Self::finish_reconcile`].
    pub fn begin_reconcile(&mut self, entries: &[(String, ServerState)]) {
        let mut saved = IndexMap::new();

        self.reconcile_snapshots = None;

        for (key, server) in entries {
            let Some(body) = self.bodies.get_mut(key) else {
                continue;
            };

            body.has_server = true;
            body.last_server = *server;

            if !body.is_predicted() {
                continue;
            }

            saved.insert(
                key.clone(),
                Transform {
                    x: body.body.x,
                    y: body.body.y,
                    angle: body.body.angle,
                },
            );

            body.body.x = server.x;
            body.body.y = server.y;
            body.body.angle = server.angle;
            body.body.vx = server.vx;
            body.body.vy = server.vy;
            body.body.angvel = server.angvel;
        }

        self.reconcile_snapshots = Some(saved);
    }

    /// После replay: расхождение старого предсказания с новым — в ошибку.
    pub fn finish_reconcile(&mut self) {
        let Some(saved) = self.reconcile_snapshots.take() else {
            return;
        };

        for (key, old) in &saved {
            let Some(body) = self.bodies.get_mut(key) else {
                continue;
            };

            if !body.is_predicted() {
                continue;
            }

            body.error.x += old.x - body.body.x;
            body.error.y += old.y - body.body.y;
            body.error.angle += normalize_angle(old.angle - body.body.angle);

            body.snap_huge_error();
        }
    }

    /// Шаг интеграции предсказанных тел (часы — у предиктора).
    pub fn integrate_predicted(&mut self, dt: f32) {
        for body in self.bodies.values_mut() {
            if body.is_predicted() {
                integrate(&mut body.body, dt);
            }
        }
    }

    /// Экспоненциальное затухание ошибки (в точности как visual_error танка).
    pub fn decay_error(&mut self, elapsed: f64) {
        let decay = (1.0 - (elapsed / 1000.0) * ERROR_DECAY_RATE).max(0.0) as f32;

        for body in self.bodies.values_mut() {
            if body.is_predicted() {
                body.error.x *= decay;
                body.error.y *= decay;
                body.error.angle *= decay;
            }
        }
    }

    /// Возвращает в `Follow` тела, которые давно не контактировали И чьё
    /// предсказание сошлось с интерполяцией: схождение и есть гарантия того,
    /// что возврат не даст скачка.
    pub fn demote_idle(&mut self, local_now: f64) {
        for body in self.bodies.values_mut() {
            if !body.is_predicted() || local_now - body.last_contact_time <= PREDICTION_HOLD_MS {
                continue;
            }

            let follow = body.follow;
            let converged = (body.body.x - follow.x).hypot(body.body.y - follow.y)
                < DEMOTE_POSITION_EPSILON
                && normalize_angle(body.body.angle - follow.angle).abs() < DEMOTE_ANGLE_EPSILON;

            if converged {
                body.demote();
            }
        }
    }

    /// Безусловный возврат всех тел в `Follow`.
    /// Шагает предсказанные тела предиктор, и когда он перестал (спектатор,
    /// уничтоженный свой танк, ожидание первого authoritative-кадра), вернуть
    /// их было бы некому: `demote_idle` зовётся только из шага симуляции, а
    /// `render_data` перекрывает интерполяцию каждый кадр — тело застыло бы
    /// на экране навсегда. Схождение здесь не проверяется: ждать его не от кого.
    pub fn release_predicted(&mut self) {
        for body in self.bodies.values_mut() {
            if body.is_predicted() {
                body.demote();
            }
        }
    }
}

/// OBB своего танка с запасом захвата (см. [`CAPTURE_MARGIN`]).
pub fn inflate_tank(tank: &Box2) -> Box2 {
    Box2 {
        x: tank.x,
        y: tank.y,
        angle: tank.angle,
        half_w: tank.half_w + CAPTURE_MARGIN,
        half_h: tank.half_h + CAPTURE_MARGIN,
    }
}

/// Подсистема предсказанного мира: своё каждой подсистемы плюс общие
/// обёртки над [`PredictedSet`]. Предиктор держит подсистемы за этим
/// трейтом — контракт для него один, как утиный контракт в JS.
pub trait PredictedBodies {
    /// Общая механика подсистемы.
    fn set(&self) -> &PredictedSet;
    fn set_mut(&mut self) -> &mut PredictedSet;

    /// Как тела читаются из интерполированных игровых данных.
    fn update(&mut self, game: &InterpolatedGame);

    /// Как тела читаются из сырого кадра (реконсиляция). Возвращает
    /// авторитетное состояние ТОЛЬКО известных подсистеме тел.
    fn snapshot_bodies(&self, snapshot: &DecodedSnapshot) -> Vec<(String, ServerState)>;

    /// Правило захвата тел в предсказание по OBB своего танка.
    fn capture(&mut self, tank: &Box2, local_now: f64);

    /// Строки предсказанных тел для рендер-тика: движок дописывает их в
    /// hot-буфер после predicted-хвоста своего танка, и они перекрывают
    /// интерполированные строки тех же сущностей.
    fn render_data(&self) -> Vec<PredictedRow>;

    // — общие обёртки: тело у них одно на все подсистемы —

    fn begin_reconcile(&mut self, snapshot: &DecodedSnapshot) {
        let entries = self.snapshot_bodies(snapshot);

        self.set_mut().begin_reconcile(&entries);
    }

    fn finish_reconcile(&mut self) {
        self.set_mut().finish_reconcile();
    }

    fn integrate_predicted(&mut self, dt: f32) {
        self.set_mut().integrate_predicted(dt);
    }

    fn decay_error(&mut self, elapsed: f64) {
        self.set_mut().decay_error(elapsed);
    }

    fn demote_idle(&mut self, local_now: f64) {
        self.set_mut().demote_idle(local_now);
    }

    fn release_predicted(&mut self) {
        self.set_mut().release_predicted();
    }

    fn predicted_bodies_mut(&mut self) -> Vec<&mut PredictedBody> {
        self.set_mut().predicted_bodies_mut()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // подсистема-двойник: тела заводятся вручную, захват — по пересечению
    // раздутого OBB танка, как у настоящих наследников
    struct TestSet {
        set: PredictedSet,
    }

    impl TestSet {
        fn new() -> Self {
            Self {
                set: PredictedSet::new(4),
            }
        }

        fn add(&mut self, key: &str, x: f32, y: f32) {
            let mut body = PredictedBody::new(Transform { x, y, angle: 0.0 });

            body.half_w = 10.0;
            body.half_h = 10.0;
            body.body.inv_mass = 1.0 / 100.0;
            body.body.inv_inertia = 1.0 / 1000.0;

            self.set.bodies_mut().insert(key.to_string(), body);
        }

        fn body(&self, key: &str) -> &PredictedBody {
            &self.set.bodies()[key]
        }
    }

    impl PredictedBodies for TestSet {
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

        fn capture(&mut self, tank: &Box2, local_now: f64) {
            let inflated = inflate_tank(tank);
            let max = self.set.max_predicted();
            let mut count = self.set.count_predicted();

            for body in self.set.bodies_mut().values_mut() {
                if body.is_predicted() || count >= max {
                    continue;
                }

                let obb = body.obb(0.0);
                let close = (obb.x - inflated.x).abs() < obb.half_w + inflated.half_w
                    && (obb.y - inflated.y).abs() < obb.half_h + inflated.half_h;

                if close {
                    body.promote(local_now);
                    count += 1;
                }
            }
        }

        fn render_data(&self) -> Vec<PredictedRow> {
            self.set
                .bodies()
                .values()
                .filter(|body| body.is_predicted())
                .enumerate()
                .map(|(index, body)| {
                    let render = body.render_transform();

                    PredictedRow {
                        key_id: 1,
                        id: index as u32,
                        fields: vec![render.x, render.y, render.angle],
                    }
                })
                .collect()
        }
    }

    fn tank_obb(x: f32) -> Box2 {
        Box2 {
            x,
            y: 0.0,
            angle: 0.0,
            half_w: 4.0,
            half_h: 3.0,
        }
    }

    #[test]
    fn capture_promotes_only_touching_bodies() {
        let mut sets = TestSet::new();

        sets.add("near", 20.0, 0.0);
        sets.add("far", 400.0, 0.0);
        sets.capture(&tank_obb(6.0), 1000.0);

        assert_eq!(sets.body("near").mode, Mode::Predicted);
        assert_eq!(sets.body("far").mode, Mode::Follow);
        assert_eq!(sets.set().count_predicted(), 1);
    }

    #[test]
    fn capture_margin_promotes_before_actual_touch() {
        let mut sets = TestSet::new();

        // зазор 1.5 юнита: касания нет, но CAPTURE_MARGIN (2) его перекрывает
        sets.add("box", 25.5, 0.0);
        sets.capture(&tank_obb(10.0), 1000.0);

        assert_eq!(sets.body("box").mode, Mode::Predicted);
    }

    #[test]
    fn promote_keeps_rendered_transform_in_error() {
        let mut sets = TestSet::new();

        sets.add("box", 20.0, 0.0);

        let body = sets.set.bodies_mut().get_mut("box").unwrap();

        body.has_server = true;
        body.last_server = ServerState {
            x: 26.0,
            y: 0.0,
            angle: 0.0,
            vx: 40.0,
            vy: 0.0,
            angvel: 0.0,
        };

        sets.capture(&tank_obb(6.0), 1000.0);

        let body = sets.body("box");

        // тело село на авторитетное состояние, а отставание интерполяции
        // (6 юнитов) ушло в сглаживающую ошибку
        assert_eq!(body.body.x, 26.0);
        assert_eq!(body.body.vx, 40.0);
        assert_eq!(body.error.x, -6.0);
    }

    #[test]
    fn promote_snaps_error_above_threshold() {
        let mut sets = TestSet::new();

        sets.add("box", 20.0, 0.0);

        let body = sets.set.bodies_mut().get_mut("box").unwrap();

        body.has_server = true;
        body.last_server = ServerState {
            x: 200.0,
            ..ServerState::default()
        };

        sets.capture(&tank_obb(6.0), 1000.0);

        assert_eq!(sets.body("box").error, Transform::default());
    }

    #[test]
    fn integrate_predicted_moves_only_predicted_bodies() {
        let mut sets = TestSet::new();

        sets.add("near", 20.0, 0.0);
        sets.add("far", 400.0, 0.0);
        sets.capture(&tank_obb(6.0), 1000.0);

        for body in sets.set.predicted_bodies_mut() {
            body.body.vx = 100.0;
        }

        sets.integrate_predicted(0.1);

        assert_eq!(sets.body("near").body.x, 30.0);
        assert_eq!(sets.body("far").body.x, 400.0);
    }

    #[test]
    fn decay_error_matches_tank_visual_error() {
        let mut sets = TestSet::new();

        sets.add("box", 20.0, 0.0);
        sets.capture(&tank_obb(6.0), 1000.0);
        sets.set.bodies_mut()["box"].error = Transform {
            x: 8.0,
            y: -4.0,
            angle: 0.4,
        };

        // множитель 1 − 0.05·10 = 0.5
        sets.decay_error(50.0);

        let error = sets.body("box").error;

        assert!((error.x - 4.0).abs() < 1e-6);
        assert!((error.y + 2.0).abs() < 1e-6);
        assert!((error.angle - 0.2).abs() < 1e-6);
    }

    #[test]
    fn demote_idle_waits_for_hold_and_convergence() {
        let mut sets = TestSet::new();

        sets.add("box", 20.0, 0.0);
        sets.capture(&tank_obb(6.0), 1000.0);

        // 200 мс < PREDICTION_HOLD_MS
        sets.demote_idle(1200.0);
        assert_eq!(sets.body("box").mode, Mode::Predicted);

        // удержание вышло, но предсказание разошлось с интерполяцией
        sets.set.bodies_mut()["box"].body.x = 60.0;
        sets.demote_idle(1400.0);
        assert_eq!(sets.body("box").mode, Mode::Predicted);

        // сошлось — тело возвращается в интерполяцию без скачка
        sets.set.bodies_mut()["box"].body.x = 20.0;
        sets.demote_idle(1400.0);
        assert_eq!(sets.body("box").mode, Mode::Follow);
    }

    #[test]
    fn note_contact_extends_prediction_hold() {
        let mut sets = TestSet::new();

        sets.add("box", 20.0, 0.0);
        sets.capture(&tank_obb(6.0), 1000.0);

        for body in sets.predicted_bodies_mut() {
            body.note_contact(1400.0);
        }

        sets.demote_idle(1500.0);

        assert_eq!(sets.body("box").mode, Mode::Predicted);
    }

    #[test]
    fn release_predicted_returns_bodies_without_convergence() {
        let mut sets = TestSet::new();

        sets.add("box", 20.0, 0.0);
        sets.capture(&tank_obb(6.0), 1000.0);
        sets.set.bodies_mut()["box"].body.x = 900.0;
        sets.release_predicted();

        let body = sets.body("box");

        assert_eq!(body.mode, Mode::Follow);
        assert_eq!(body.body.x, 20.0);
        assert_eq!(body.error, Transform::default());
    }

    #[test]
    fn reconcile_replaces_state_and_keeps_divergence_in_error() {
        let mut sets = TestSet::new();

        sets.add("box", 20.0, 0.0);
        sets.capture(&tank_obb(6.0), 1000.0);

        let entries = vec![(
            "box".to_string(),
            ServerState {
                x: 30.0,
                vx: 50.0,
                ..ServerState::default()
            },
        )];

        sets.set.begin_reconcile(&entries);

        // состояние подменено авторитетным, предсказание сохранено
        assert_eq!(sets.body("box").body.x, 30.0);
        assert_eq!(sets.body("box").body.vx, 50.0);

        // replay довёл тело до 28 — расхождение со старым предсказанием (20)
        sets.set.bodies_mut()["box"].body.x = 28.0;
        sets.set.finish_reconcile();

        assert_eq!(sets.body("box").error.x, -8.0);
    }

    #[test]
    fn reconcile_ignores_follow_bodies_but_remembers_server_state() {
        let mut sets = TestSet::new();

        sets.add("box", 20.0, 0.0);

        let entries = vec![(
            "box".to_string(),
            ServerState {
                x: 30.0,
                ..ServerState::default()
            },
        )];

        sets.set.begin_reconcile(&entries);
        sets.set.finish_reconcile();

        let body = sets.body("box");

        assert_eq!(body.body.x, 20.0);
        assert!(body.has_server);
        assert_eq!(body.last_server.x, 30.0);
    }

    #[test]
    fn finish_reconcile_without_begin_is_noop() {
        let mut sets = TestSet::new();

        sets.add("box", 20.0, 0.0);
        sets.capture(&tank_obb(6.0), 1000.0);
        sets.set.finish_reconcile();

        assert_eq!(sets.body("box").error, Transform::default());
    }
}
