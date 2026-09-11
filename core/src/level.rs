//! Правила 2.5D-уровней: рампы, обрывы, падение. Чистые функции над
//! `MapLevels` (геометрия слоёв, крейт движка) — авторитетный путь
//! (`TanksSim::update_levels`) и клиентская реплика (`client::predictor`)
//! обязаны звать ровно их, иначе предсказание уровня разъедется с
//! авторитетным молча.

use rapier2d::prelude::Group;
use serde::{Deserialize, Serialize};
use vimp_engine_core::map::{level_group, FallModel, MapLevels, RampSample, STATIC_LEVEL_GROUP};
use vimp_engine_core::physics::lerp;

use crate::config::LevelRules;

/// Состояние перехода между уровнями.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Transit {
    /// Стоит на своём уровне.
    Grounded,
    /// Центр корпуса на клетке рампы: коллизии ВСЕХ уровней прогона.
    /// `climbing` — прошёл ли танк гейт входа (иначе прогон работает для
    /// него как плоская клетка его уровня, см. `entry_is_legal`);
    /// `low`/`high` — границы прогона: они нужны и маске, и снапу уровня;
    /// `run` — номер прогона, по которому вердикт гейта отличается от
    /// вердикта соседнего прогона.
    Ramp {
        climbing: bool,
        low: u8,
        high: u8,
        #[serde(default)]
        run: u16,
    },
    /// Свободное падение с обрыва: остаются только стены, ввод заблокирован.
    /// `from` — уровень срыва, `to` — уровень приземления (он выбран в
    /// момент срыва: под танком может быть не земля, а нижняя плита).
    Falling { elapsed: f32, from: u8, to: u8 },
}

/// Уровень танка/тела и его визуальная высота.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct LevelState {
    pub level: u8,
    /// 0.0 — земля, 1.0 — плита первого уровня; дробные значения —
    /// рампа/падение.
    pub z: f32,
    pub transit: Transit,
    /// Клетка центра корпуса на прошлом шаге; `(-1, -1)` — неизвестна
    /// (спавн, первый шаг, точка вне карты). Ею гейт рампы отличает заход
    /// с торца прогона от заезда в него сбоку.
    pub prev_cell: (i32, i32),
    /// Вектор уклона: БЕЗРАЗМЕРНЫЙ тангенс подъёма по осям мира
    /// (`rise * levelHeight / span`, см. `RampSample::slope` в движке),
    /// `(0, 0)` вне рампы. Единица важна: до введения `levelHeight` уклон
    /// мерился «уровнями на пиксель» и все константы подъёма промахивались
    /// на два порядка. Заполняется из `RampSample { dir, slope }` и только
    /// при `climbing`.
    pub slope_vec: [f32; 2],
}

impl Default for LevelState {
    fn default() -> Self {
        Self {
            level: 0,
            z: 0.0,
            transit: Transit::Grounded,
            prev_cell: (-1, -1),
            slope_vec: [0.0, 0.0],
        }
    }
}

/// Что случилось на этом шаге.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LevelEvent {
    None,
    /// Танк только что коснулся опоры после падения; `height` — высота
    /// падения в уровнях (по ней считается урон).
    Landed { height: u8 },
}

impl LevelState {
    /// Игнорирует ли ввод (падение).
    pub fn input_locked(&self) -> bool {
        matches!(self.transit, Transit::Falling { .. })
    }

    /// Битовая маска уровней, которые тело сейчас видит физически.
    /// `Falling` — только группа статики: падающий пролетает за время
    /// падения около семи тайлов, и без стен он проходил бы сквозь здание и
    /// приземлялся внутри него; при этом ни танки, ни ящики, ни лучи, ни
    /// взрывы его не достают — они живут в группах уровней.
    pub fn collision_mask(&self) -> Group {
        match self.transit {
            Transit::Falling { .. } => STATIC_LEVEL_GROUP,
            Transit::Ramp {
                climbing,
                low,
                high,
                ..
            } => {
                if climbing {
                    // на прогоне тело видит геометрию всех уровней, которые
                    // прогон соединяет: иначе на рампе 0 → 2 танк
                    // провалился бы сквозь промежуточную плиту или упёрся в
                    // невидимую стену
                    (low..=high).fold(Group::empty(), |acc, level| acc | level_group(level))
                } else {
                    // заехавшему сбоку прогон работает как плоская клетка
                    // ЕГО уровня — и физика обязана видеть ровно этот
                    // уровень, иначе танк под прогоном 1 → 2 проезжает
                    // сквозь наземные стены своего уровня
                    level_group(self.level)
                }
            }
            Transit::Grounded => level_group(self.level),
        }
    }

    /// Законно ли тело едет по прогону рампы. Только такому телу движок
    /// открывает стражей прогона (`map::body_filter`): борта и верхний
    /// торец обязаны держать всех, кроме поднимающегося.
    pub fn on_ramp(&self) -> bool {
        matches!(self.transit, Transit::Ramp { climbing: true, .. })
    }

    /// Продольный уклон под курсом `(heading_x, heading_y)`: положительный
    /// — в горку. Вне рампы всегда 0, поэтому одноуровневая карта считает
    /// движение прежними формулами бит-в-бит.
    pub fn grade(&self, heading_x: f32, heading_y: f32) -> f32 {
        self.slope_vec[0] * heading_x + self.slope_vec[1] * heading_y
    }
}

/// Модель падения по правилам игры — одна траектория на танки и на тела
/// карты (её же зовёт движок в `step_body_level`).
pub fn fall_model(rules: &LevelRules) -> FallModel {
    FallModel {
        time_per_level: rules.fall_time,
    }
}

/// Сколько времени прошло с начала падения с уровня `from` на уровень `to`
/// до высоты `z` — обратная к `FallModel::z_at`. Нужна клиентской реплике:
/// кадр везёт авторитетные `z`/`level`, но не фазу падения, а восстанавливать
/// её обнулением нельзя — высота своего танка тогда зависела бы от длины
/// реплея, а не от времени падения.
pub fn fall_elapsed(z: f32, from: u8, to: u8, rules: &LevelRules) -> f32 {
    let fall = fall_model(rules);

    if from <= to {
        return fall.duration((from as f32 - to as f32).abs());
    }

    fall.elapsed_at(from as f32, to as f32, z)
}

/// Опора корпуса: прямоугольник тела в мировых единицах. Срыв с обрыва
/// судит ГАБАРИТ, а не точку центра — иначе танк, у которого за кромкой
/// оказался только центр, а половина корпуса ещё лежит на плите, уже
/// необратимо падает, и реверс у самой кромки не спасает.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Footprint {
    /// Курс корпуса в радианах.
    pub angle: f32,
    /// Половина длины корпуса (вдоль курса).
    pub half_w: f32,
    /// Половина ширины корпуса (поперёк курса).
    pub half_h: f32,
}

impl Footprint {
    /// Тело без габаритов: опору судит одна точка центра. Нужно там, где
    /// модель ещё не известна (реплика до `set_model`) — правило тогда
    /// ровно прежнее.
    pub fn point() -> Self {
        Self {
            angle: 0.0,
            half_w: 0.0,
            half_h: 0.0,
        }
    }
}

/// Есть ли под телом плита уровня `level`: опорой считается центр ИЛИ
/// любой угол корпуса. Пока хоть один угол на плите, тело стоит — оно
/// свисает над пустотой, но не падает, и ввод ему не запирают.
///
/// Одна функция на хост (`TanksSim::update_levels`) и на реплику
/// (`client::predictor`, и шаг, и разбор кадра): вторая копия правила
/// разъехалась бы молча — кадр у самой кромки читался бы как «танк в
/// воздухе».
pub fn has_support(
    levels: &MapLevels,
    level: u8,
    x: f32,
    y: f32,
    footprint: &Footprint,
) -> bool {
    if levels.has_floor(level, x, y) {
        return true;
    }

    let (sin, cos) = footprint.angle.sin_cos();
    let (hw, hh) = (footprint.half_w, footprint.half_h);

    [(hw, hh), (hw, -hh), (-hw, hh), (-hw, -hh)]
        .iter()
        .any(|(dx, dy)| {
            levels.has_floor(level, x + dx * cos - dy * sin, y + dx * sin + dy * cos)
        })
}

/// Уровень, на который ложится сброшенная бомба. Одно правило на хост
/// (`TanksSim::create_weapon_action`) и на клиентскую реплику
/// (`client::shot`): вторая копия разъехалась бы молча, и локальный взрыв
/// рисовался бы этажом ниже урона.
///
/// Бомба, сброшенная в воздухе (`input_locked` — танк падает) или над
/// разрывом плиты, ложится на ближайшую опору СНИЗУ, а не сразу на землю.
/// `None` в `levels` — карта без геометрии уровней: судить не по чему,
/// бомба идёт на землю.
pub fn bomb_level(
    levels: Option<&MapLevels>,
    level: u8,
    x: f32,
    y: f32,
    input_locked: bool,
) -> u8 {
    if level < 1 {
        return level;
    }

    match levels {
        Some(levels) if input_locked || !levels.has_floor(level, x, y) => {
            levels.landing_level(level, x, y)
        }
        Some(_) => level,
        None => 0,
    }
}

/// Шаг правил уровня для точки `(x, y)`. Вызывается ДО применения ввода и
/// ДО шага физики — так маска коллизий уже верна для наступающего шага.
pub fn step_level(
    state: &mut LevelState,
    x: f32,
    y: f32,
    footprint: &Footprint,
    levels: &MapLevels,
    rules: &LevelRules,
    dt: f32,
) -> LevelEvent {
    // одноуровневая карта: уровня как понятия нет
    if !levels.is_layered() {
        *state = LevelState::default();

        return LevelEvent::None;
    }

    let cell = cell_of(levels, x, y);
    let event = step_layered(state, x, y, cell, footprint, levels, rules, dt);

    // клетка пишется ВСЕГДА, а не только на рампе: иначе после проезда по
    // плите значение протухло бы, и гейт судил бы вход по древней клетке
    state.prev_cell = cell;

    event
}

// шаг на многоуровневой карте; `prev_cell` обновляет вызывающий
#[allow(clippy::too_many_arguments)]
fn step_layered(
    state: &mut LevelState,
    x: f32,
    y: f32,
    cell: (i32, i32),
    footprint: &Footprint,
    levels: &MapLevels,
    rules: &LevelRules,
    dt: f32,
) -> LevelEvent {
    if let Transit::Falling { elapsed, from, to } = state.transit {
        let fall = fall_model(rules);
        let elapsed = elapsed + dt;

        state.slope_vec = [0.0, 0.0];
        state.z = fall.z_at(from as f32, to as f32, elapsed);

        if elapsed >= fall.duration(from as f32 - to as f32) {
            // цель падения выбрана в момент срыва, а тело всё это время
            // летело горизонтально: на длинном сносе плиты `to` под ним уже
            // может не быть. Приземление судит КЛЕТКА КАСАНИЯ, сохранённое
            // `to` остаётся только траекторией
            debug_assert!(from > to, "падение обязано идти вниз: {from} → {to}");

            let landed = if levels.has_floor(to, x, y) {
                to
            } else {
                levels.landing_level(to, x, y)
            };

            state.level = landed;
            state.z = landed as f32;
            state.transit = Transit::Grounded;

            return LevelEvent::Landed {
                height: from.saturating_sub(landed),
            };
        }

        state.transit = Transit::Falling { elapsed, from, to };

        return LevelEvent::None;
    }

    if let Some(ramp) = levels.ramp_at(x, y) {
        let (low, high) = if ramp.from < ramp.to {
            (ramp.from, ramp.to)
        } else {
            (ramp.to, ramp.from)
        };

        // гейт решается ОДИН раз, при входе на прогон: уровень танка по
        // дороге меняется, и пересчёт на каждом шаге отменял бы подъём на
        // его середине
        // вердикт наследуется только внутри СВОЕГО прогона: переезд в
        // смежный прогон — это новый вход, и судить его обязан новый гейт
        let climbing = match state.transit {
            Transit::Ramp { climbing, run, .. } if run == ramp.run => climbing,
            // перестроение между ПОЛОСАМИ одной широкой горки. Движок режет
            // блок тайлов рампы на параллельные прогоны по строкам/колонкам
            // (`MapLevels::build_runs`), поэтому широкая горка — это N
            // прогонов, и без этого правила каждая межполосная граница
            // судилась бы как новый вход и обрывала бы подъём на середине
            Transit::Ramp { climbing, .. }
                if is_lane_change(levels, state.prev_cell, cell, &ramp) =>
            {
                climbing
            }
            _ => entry_is_legal(state, &ramp, cell, levels),
        };

        state.transit = Transit::Ramp {
            climbing,
            low,
            high,
            run: ramp.run,
        };

        // заехавшему сбоку прогон работает как обычная плоская клетка его
        // уровня — до тех пор, пока он с прогона не сойдёт
        if !climbing {
            state.slope_vec = [0.0, 0.0];
            state.z = state.level as f32;

            return LevelEvent::None;
        }

        state.slope_vec = [ramp.dir[0] * ramp.slope, ramp.dir[1] * ramp.slope];
        state.z = lerp(ramp.from as f32, ramp.to as f32, ramp.progress);
        // уровень щёлкает по ближайшему целому, а не по порогу «выше
        // половины»: на прогоне 0 → 2 порог отдал бы уровень 2 уже на первой
        // трети. Коллизии на рампе всё равно всех уровней прогона, поэтому
        // щелчок не создаёт ни проваливания, ни толчка
        state.level = state.z.round().clamp(low as f32, high as f32) as u8;

        return LevelEvent::None;
    }

    state.transit = Transit::Grounded;
    state.slope_vec = [0.0, 0.0];

    // срыв судит габарит корпуса: пока под телом есть опора хоть одним
    // углом, оно свисает над пустотой, но стоит — и ввод у него не заперт,
    // так что реверс у самой кромки возвращает танк на плиту
    if state.level >= 1 && !has_support(levels, state.level, x, y, footprint) {
        state.transit = Transit::Falling {
            elapsed: 0.0,
            from: state.level,
            // приземление — не всегда земля: под обрывом может лежать плита
            // нижнего уровня
            to: levels.landing_level(state.level, x, y),
        };
        state.z = state.level as f32;

        return LevelEvent::None;
    }

    state.z = state.level as f32;

    LevelEvent::None
}

// клетка точки; `(-1, -1)` вне карты
fn cell_of(levels: &MapLevels, x: f32, y: f32) -> (i32, i32) {
    levels
        .cell_at(x, y)
        .map_or((-1, -1), |(cx, cy)| (cx as i32, cy as i32))
}

// индекс прогона рампы в клетке (по центру клетки), None — не рампа
fn run_at_cell(levels: &MapLevels, cell: (i32, i32)) -> Option<u16> {
    if cell.0 < 0 || cell.1 < 0 {
        return None;
    }

    let size = levels.tile_size();
    let x = (cell.0 as f32 + 0.5) * size;
    let y = (cell.1 as f32 + 0.5) * size;

    levels.ramp_at(x, y).map(|sample| sample.run)
}

// Полосы ОДНОЙ широкой горки: движок режет блок тайлов рампы на
// параллельные прогоны и нумерует их блоками (`RampRun::block`), поэтому
// признак один на всю экосистему — по нему же физика огораживает блок
// целиком. Шаг обязан быть ровно на одну клетку ПОПЕРЁК оси: вход с торца
// по-прежнему судит гейт.
//
// Полосы разной ДЛИНЫ (ступенчатый блок) остаются разными горками — у них
// разные `block`, и переезд между ними судит гейт.
fn is_lane_change(
    levels: &MapLevels,
    prev: (i32, i32),
    cell: (i32, i32),
    ramp: &RampSample,
) -> bool {
    let Some(prev_run) = run_at_cell(levels, prev) else {
        return false;
    };

    let runs = levels.runs();
    let (Some(a), Some(b)) = (runs.get(prev_run as usize), runs.get(ramp.run as usize)) else {
        return false;
    };

    let (dx, dy) = (cell.0 - prev.0, cell.1 - prev.1);
    let (along, across) = if ramp.axis == 0 { (dx, dy) } else { (dy, dx) };

    along == 0 && across.abs() == 1 && a.block == b.block
}

// Насколько высота прогона в точке входа может отстоять от высоты тела при
// заходе сбоку или наискось (в уровнях). Заход в лоб начинается у самого
// торца, а вход поперёк оси попадает в любую точку клетки — без потолка
// крутая горка подкидывала бы танк на целый уровень.
const MAX_SIDE_ENTRY_RISE: f32 = 0.5;

// Законен ли заход на прогон: бок и торцы прогона открыты (в клетку у
// вершины на `overpass` можно въехать прямо с земли), и без гейта это
// бесплатный подъём мимо самой рампы.
//
// Судит гейт КЛЕТКУ входа, а не направление въезда: крайние клетки прогона
// — подножие и вершина — пускают тех, чей уровень им отвечает, с ЛЮБОЙ
// стороны, включая бок и диагональ. Середина прогона не пускает никого:
// вход туда означал бы прыжок по высоте на пол-уровня, и её же держат
// борта-стражи движка (`map::ramp_guards`, борт начинается на клетку дальше
// подножия). Правило по направлению («сосед строго вдоль оси») отменено: с
// ним танк, подъехавший к подножию наискось, оставался на своём уровне и
// ехал по горке как по плоской клетке.
fn entry_is_legal(
    state: &LevelState,
    ramp: &RampSample,
    cell: (i32, i32),
    levels: &MapLevels,
) -> bool {
    let prev = state.prev_cell;

    let (low, high) = if ramp.from < ramp.to {
        (ramp.from, ramp.to)
    } else {
        (ramp.to, ramp.from)
    };

    // клетка неизвестна (спавн прямо на прогоне, первый шаг): судить не по
    // чему, поэтому работает правило первой итерации — половина прогона
    if prev.0 < 0 || prev.1 < 0 {
        return (ramp.progress >= 0.5) == (state.level == high);
    }

    // прошлая клетка внутри того же прогона — это не вход
    if run_at_cell(levels, prev) == Some(ramp.run) {
        return false;
    }

    let Some((foot, top)) = run_end_cells(levels, ramp) else {
        return false;
    };

    let (dx, dy) = (cell.0 - prev.0, cell.1 - prev.1);
    let (along, across, uphill, index) = if ramp.axis == 0 {
        (dx, dy, ramp.dir[0], cell.0)
    } else {
        (dy, dx, ramp.dir[1], cell.1)
    };

    // заход НЕ строго по оси (бок, диагональ) высоту не перепрыгивает:
    // тело обязано стоять на высоте своего уровня (иначе застрявший на
    // середине чужого прогона танк перешагивал бы сбоку на соседнюю горку),
    // а высота прогона в точке входа — отличаться от неё не больше чем на
    // пол-уровня. Прямой заход с торца этим не связан: там высота торца и
    // есть высота уровня
    if across != 0 {
        let entry_z = lerp(ramp.from as f32, ramp.to as f32, ramp.progress);

        if (state.z - state.level as f32).abs() > 1e-3
            || (entry_z - state.z).abs() > MAX_SIDE_ENTRY_RISE
        {
            return false;
        }
    }

    // через какой ТОРЕЦ зашли: знак шага вдоль оси против направления
    // подъёма. Диагональ считается тем же торцом, что и прямой заход, —
    // именно она и была запрещена прежним правилом
    let expected = if along as f32 * uphill > 0.0 {
        (foot, low)
    } else if (along as f32) * uphill < 0.0 {
        (top, high)
    } else if index == foot {
        // чистый заход сбоку: торец выбирает сама клетка входа
        (foot, low)
    } else if index == top {
        (top, high)
    } else {
        // бок СЕРЕДИНЫ прогона: вход туда означал бы прыжок по высоте
        return false;
    };

    // клетка входа обязана быть тем самым торцом, а не серединой
    index == expected.0 && state.level == expected.1
}

// Крайние клетки прогона по его оси: `(подножие, вершина)`. `None` — прогон
// неизвестен. У прогона длиной в одну клетку обе совпадают, и торец такого
// прогона выбирает направление входа.
fn run_end_cells(levels: &MapLevels, ramp: &RampSample) -> Option<(i32, i32)> {
    let run = levels.runs().get(ramp.run as usize)?;
    let size = levels.tile_size();

    if size <= 0.0 {
        return None;
    }

    // границы прогона приходят в МИРОВЫХ единицах — тех же, в которых
    // считается клетка (`cell_of`)
    let first = (run.min / size).round() as i32;
    let last = (run.max / size).round() as i32 - 1;

    // подножие — тот конец, от которого идёт подъём
    if run.sign > 0 {
        Some((first, last))
    } else {
        Some((last, first))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use indexmap::IndexMap;
    use vimp_engine_core::map::{MapLevelConfig, RampConfig, RampDir};

    const TILE: f32 = 10.0;
    const DT: f32 = 1.0 / 120.0;

    /// Карта 4×4: колонка x=2 — плита моста (тайл 2), клетка (1, 1) —
    /// рампа (тайл 3) уровня 0, поднимающая на восток.
    fn layered() -> MapLevels {
        let mut grid0 = vec![vec![0, 0, 0, 0]; 4];
        let mut grid1 = vec![vec![0, 0, 0, 0]; 4];

        for row in grid1.iter_mut() {
            row[2] = 2;
        }

        grid0[1][1] = 3;

        let mut levels: IndexMap<String, MapLevelConfig> = IndexMap::new();

        levels.insert(
            "1".to_string(),
            MapLevelConfig {
                map: grid1,
                floor: vec![2],
                walls: Vec::new(),
                layers: IndexMap::new(),
                volumes: IndexMap::new(),
            },
        );

        let ramps = vec![RampConfig {
            tile: 3,
            dir: RampDir::East,
            from: 0,
            to: 1,
        }];

        MapLevels::build(&grid0, &[], &levels, &ramps, TILE, None)
    }

    /// Карта 6×6 с тремя уровнями: рампа (тайл 3) занимает клетки (1, 1) и
    /// (2, 1) и поднимает СРАЗУ с 0 на 2; колонка x=3 — плита уровня 2,
    /// колонка x=4 — плита только уровня 1 (под ней падают с 2 на 1).
    fn tall() -> MapLevels {
        let mut grid0 = vec![vec![0; 6]; 6];
        let mut grid1 = vec![vec![0; 6]; 6];
        let mut grid2 = vec![vec![0; 6]; 6];

        grid0[1][1] = 3;
        grid0[1][2] = 3;

        for row in grid1.iter_mut() {
            row[3] = 2;
            row[4] = 2;
        }

        for row in grid2.iter_mut() {
            row[3] = 2;
        }

        let mut levels: IndexMap<String, MapLevelConfig> = IndexMap::new();

        for (key, map) in [("1", grid1), ("2", grid2)] {
            levels.insert(
                key.to_string(),
                MapLevelConfig {
                    map,
                    floor: vec![2],
                    walls: Vec::new(),
                    layers: IndexMap::new(),
                    volumes: IndexMap::new(),
                },
            );
        }

        let ramps = vec![RampConfig {
            tile: 3,
            dir: RampDir::East,
            from: 0,
            to: 2,
        }];

        MapLevels::build(&grid0, &[], &levels, &ramps, TILE, None)
    }

    /// Карта 6×6, где прогон лежит в гриде УРОВНЯ 1 (`from: 1, to: 2`), а
    /// под ним — проезжая земля уровня 0. Ею проверяется маска танка,
    /// заехавшего ПОД прогон: он обязан видеть свой уровень, а не уровни
    /// прогона.
    fn overhead() -> MapLevels {
        let grid0 = vec![vec![0; 6]; 6];
        let mut grid1 = vec![vec![0; 6]; 6];
        let mut grid2 = vec![vec![0; 6]; 6];

        // плита уровня 1 — колонки 1..3 строки 1, из них (2, 1) — рампа
        for x in 1..4 {
            grid1[1][x] = 2;
        }

        grid1[1][2] = 3;

        // плита уровня 2 — колонка 3: вершина прогона
        grid2[1][3] = 2;

        let mut levels: IndexMap<String, MapLevelConfig> = IndexMap::new();

        for (key, map) in [("1", grid1), ("2", grid2)] {
            levels.insert(
                key.to_string(),
                MapLevelConfig {
                    map,
                    floor: vec![2, 3],
                    walls: Vec::new(),
                    layers: IndexMap::new(),
                    volumes: IndexMap::new(),
                },
            );
        }

        let ramps = vec![RampConfig {
            tile: 3,
            dir: RampDir::East,
            from: 1,
            to: 2,
        }];

        MapLevels::build(&grid0, &[], &levels, &ramps, TILE, None)
    }

    /// Карта 8×4: два СМЕЖНЫХ прогона подряд в строке 1, оба поднимают на
    /// восток с 0 на 1 (тайлы 3 и 4). Второй прогон обязан судить вход
    /// собственным гейтом: танк подходит к нему уже уровнем 1, а его
    /// нижний торец ждёт уровень 0.
    fn two_runs() -> MapLevels {
        let mut grid0 = vec![vec![0; 8]; 4];
        let mut grid1 = vec![vec![0; 8]; 4];

        grid0[1][1] = 3;
        grid0[1][2] = 3;
        grid0[1][3] = 4;
        grid0[1][4] = 4;

        // плита уровня 1 — за вторым прогоном
        grid1[1][5] = 2;

        let mut levels: IndexMap<String, MapLevelConfig> = IndexMap::new();

        levels.insert(
            "1".to_string(),
            MapLevelConfig {
                map: grid1,
                floor: vec![2],
                walls: Vec::new(),
                layers: IndexMap::new(),
                volumes: IndexMap::new(),
            },
        );

        let ramps = vec![
            RampConfig {
                tile: 3,
                dir: RampDir::East,
                from: 0,
                to: 1,
            },
            RampConfig {
                tile: 4,
                dir: RampDir::East,
                from: 0,
                to: 1,
            },
        ];

        MapLevels::build(&grid0, &[], &levels, &ramps, TILE, None)
    }

    /// Карта 6×6 с ШИРОКОЙ горкой: тайл рампы (3) занимает блок из трёх
    /// строк (y = 1..3) по три клетки (x = 1..3), поднимающий с 0 на 1.
    /// Движок режет такой блок на три параллельных прогона (по прогону на
    /// строку), поэтому ею проверяется перестроение между полосами.
    /// `narrow_lane` укорачивает СРЕДНЮЮ полосу на клетку — тогда полосы
    /// перестают быть одной горкой.
    fn wide(narrow_lane: bool) -> MapLevels {
        let mut grid0 = vec![vec![0; 6]; 6];
        let mut grid1 = vec![vec![0; 6]; 6];

        for y in 1..4 {
            let last = if narrow_lane && y == 2 { 3 } else { 4 };

            for x in 1..last {
                grid0[y][x] = 3;
            }

            // плита уровня 1 у вершины прогона
            grid1[y][4] = 2;
        }

        let mut levels: IndexMap<String, MapLevelConfig> = IndexMap::new();

        levels.insert(
            "1".to_string(),
            MapLevelConfig {
                map: grid1,
                floor: vec![2],
                walls: Vec::new(),
                layers: IndexMap::new(),
                volumes: IndexMap::new(),
            },
        );

        let ramps = vec![RampConfig {
            tile: 3,
            dir: RampDir::East,
            from: 0,
            to: 1,
        }];

        MapLevels::build(&grid0, &[], &levels, &ramps, TILE, None)
    }

    fn flat() -> MapLevels {
        MapLevels::build(
            &vec![vec![0, 0, 0, 0]; 4],
            &[],
            &IndexMap::new(),
            &[],
            TILE,
            None,
        )
    }

    fn rules() -> LevelRules {
        LevelRules {
            fall_time: 0.35,
            fall_damage: 15.0,
            max_fall_damage: 100.0,
            climb_gravity: 500.0,
            climb_max_speed_factor: 0.5,
        }
    }

    fn grounded(level: u8) -> LevelState {
        LevelState {
            level,
            z: level as f32,
            ..LevelState::default()
        }
    }

    #[test]
    fn flat_map_keeps_level_zero() {
        let mut state = LevelState {
            level: 1,
            z: 1.0,
            transit: Transit::Ramp {
                climbing: true,
                low: 0,
                high: 1,
                run: 0,
            },
            prev_cell: (1, 1),
            slope_vec: [0.1, 0.0],
        };

        let event = step_level(&mut state, 15.0, 15.0, &Footprint::point(), &flat(), &rules(), DT);

        assert_eq!(event, LevelEvent::None);
        assert_eq!(state, LevelState::default());
    }

    #[test]
    fn ramp_raises_z_and_snaps_level_at_half() {
        let levels = layered();
        let mut state = LevelState::default();

        // подъезд к подножию прогона: клетка (0, 1), уровень 0
        step_level(&mut state, 5.0, 15.0, &Footprint::point(), &levels, &rules(), DT);

        // клетка рампы — x от 10 до 20, подъём на восток
        step_level(&mut state, 12.0, 15.0, &Footprint::point(), &levels, &rules(), DT);

        assert!(
            matches!(
                state.transit,
                Transit::Ramp {
                    climbing: true,
                    low: 0,
                    high: 1,
                    ..
                }
            ),
            "{:?}",
            state.transit
        );
        assert!((state.z - 0.2).abs() < 1e-5, "z = {}", state.z);
        assert_eq!(state.level, 0);

        step_level(&mut state, 17.0, 15.0, &Footprint::point(), &levels, &rules(), DT);

        assert!((state.z - 0.7).abs() < 1e-5, "z = {}", state.z);
        assert_eq!(state.level, 1);
    }

    #[test]
    fn ramp_entered_from_the_side_does_not_lift() {
        let levels = layered();
        let mut state = LevelState::default();

        // клетка рампы у вершины (progress 0.7) достижима с земли сбоку
        step_level(&mut state, 17.0, 15.0, &Footprint::point(), &levels, &rules(), DT);

        assert_eq!(state.level, 0);
        assert_eq!(state.z, 0.0);

        // гейт держится и когда танк доехал по прогону до его подножия
        step_level(&mut state, 12.0, 15.0, &Footprint::point(), &levels, &rules(), DT);

        assert_eq!(state.level, 0);
        assert_eq!(state.z, 0.0);

        // сойдя с рампы, танк снова может зайти на неё снизу
        step_level(&mut state, 5.0, 15.0, &Footprint::point(), &levels, &rules(), DT);
        step_level(&mut state, 12.0, 15.0, &Footprint::point(), &levels, &rules(), DT);

        assert!((state.z - 0.2).abs() < 1e-5, "z = {}", state.z);
    }

    #[test]
    fn foot_cell_is_entered_from_the_side() {
        let levels = layered();
        let mut state = LevelState::default();

        // клетка (1, 0) — соседняя ПОПЕРЁК оси прогона. Клетка (1, 1) —
        // подножие: заход в неё сбоку законен, высоту он не перепрыгивает
        step_level(&mut state, 12.0, 5.0, &Footprint::point(), &levels, &rules(), DT);
        step_level(&mut state, 12.0, 15.0, &Footprint::point(), &levels, &rules(), DT);

        assert!(
            matches!(state.transit, Transit::Ramp { climbing: true, .. }),
            "{:?}",
            state.transit
        );
        assert_eq!(state.level, 0);
        assert!((state.z - 0.2).abs() < 1e-5, "z = {}", state.z);
    }

    #[test]
    fn side_entry_does_not_lift_a_body_by_a_whole_level() {
        let levels = layered();
        let mut state = LevelState::default();

        // заход сбоку в дальний край клетки подножия: прогон там уже на
        // 0.8 уровня выше танка — это подкидывание, а не заезд
        step_level(&mut state, 18.0, 5.0, &Footprint::point(), &levels, &rules(), DT);
        step_level(&mut state, 18.0, 15.0, &Footprint::point(), &levels, &rules(), DT);

        assert!(
            matches!(state.transit, Transit::Ramp { climbing: false, .. }),
            "{:?}",
            state.transit
        );
        assert_eq!(state.z, 0.0);
    }

    #[test]
    fn ramp_is_not_entered_from_under_the_bridge() {
        let levels = layered();
        let mut state = LevelState::default();

        // клетка (2, 1) — проезд уровня 0 ПОД плитой, упирающийся в верхний
        // торец прогона
        step_level(&mut state, 25.0, 15.0, &Footprint::point(), &levels, &rules(), DT);
        step_level(&mut state, 17.0, 15.0, &Footprint::point(), &levels, &rules(), DT);

        assert!(
            matches!(state.transit, Transit::Ramp { climbing: false, .. }),
            "{:?}",
            state.transit
        );
        assert_eq!(state.level, 0);
        assert_eq!(state.z, 0.0);
    }

    #[test]
    fn mask_under_a_high_ramp_stays_on_the_ground_level() {
        let levels = overhead();
        let mut state = LevelState::default();

        // танк уровня 0 катится под прогоном 1 → 2: клетка (1, 1) → (2, 1)
        step_level(&mut state, 15.0, 15.0, &Footprint::point(), &levels, &rules(), DT);
        step_level(&mut state, 25.0, 15.0, &Footprint::point(), &levels, &rules(), DT);

        assert!(
            matches!(state.transit, Transit::Ramp { climbing: false, .. }),
            "{:?}",
            state.transit
        );
        assert_eq!(state.level, 0);
        // маска обязана остаться земной: иначе танк проезжает сквозь стены
        // своего уровня и не ловится наземными выстрелами
        assert_eq!(state.collision_mask(), level_group(0));
        assert!(!state.on_ramp());
    }

    #[test]
    fn mask_on_a_ramp_covers_the_whole_run() {
        let levels = overhead();
        let mut state = LevelState {
            level: 1,
            z: 1.0,
            ..LevelState::default()
        };

        // законный вход с нижнего торца прогона: клетка (1, 1) → (2, 1)
        step_level(&mut state, 15.0, 15.0, &Footprint::point(), &levels, &rules(), DT);
        step_level(&mut state, 25.0, 15.0, &Footprint::point(), &levels, &rules(), DT);

        assert!(
            matches!(state.transit, Transit::Ramp { climbing: true, .. }),
            "{:?}",
            state.transit
        );
        assert_eq!(state.collision_mask(), level_group(1) | level_group(2));
        assert!(state.on_ramp());
    }

    #[test]
    fn lane_change_on_a_wide_ramp_keeps_climbing() {
        let levels = wide(false);
        let mut state = LevelState::default();

        // законный вход с подножия в полосу y = 1: клетка (0, 1) → (1, 1)
        step_level(&mut state, 5.0, 15.0, &Footprint::point(), &levels, &rules(), DT);
        step_level(&mut state, 15.0, 15.0, &Footprint::point(), &levels, &rules(), DT);

        assert!(
            matches!(state.transit, Transit::Ramp { climbing: true, .. }),
            "{:?}",
            state.transit
        );

        let entry_z = state.z;

        // перестроение ПОПЕРЁК оси в полосу y = 2 и дальше вверх по ней
        step_level(&mut state, 15.0, 25.0, &Footprint::point(), &levels, &rules(), DT);

        assert!(
            matches!(state.transit, Transit::Ramp { climbing: true, .. }),
            "{:?}",
            state.transit
        );

        step_level(&mut state, 25.0, 25.0, &Footprint::point(), &levels, &rules(), DT);

        assert!(
            matches!(state.transit, Transit::Ramp { climbing: true, .. }),
            "{:?}",
            state.transit
        );
        assert!(state.on_ramp());
        assert!(state.z > entry_z, "z = {}, вход = {entry_z}", state.z);
    }

    #[test]
    fn lane_change_between_runs_of_different_length_is_a_new_entry() {
        let levels = wide(true);
        let mut state = LevelState::default();

        step_level(&mut state, 5.0, 15.0, &Footprint::point(), &levels, &rules(), DT);
        step_level(&mut state, 15.0, 15.0, &Footprint::point(), &levels, &rules(), DT);

        assert!(
            matches!(state.transit, Transit::Ramp { climbing: true, .. }),
            "{:?}",
            state.transit
        );

        // средняя полоса короче — это уже другая горка, вход судит гейт
        step_level(&mut state, 15.0, 25.0, &Footprint::point(), &levels, &rules(), DT);

        assert!(
            matches!(state.transit, Transit::Ramp { climbing: false, .. }),
            "{:?}",
            state.transit
        );
    }

    #[test]
    fn side_entry_is_still_refused() {
        let levels = wide(false);
        let mut state = LevelState::default();

        // с земли ВБОК на полосу: клетка (2, 0) → (2, 1)
        step_level(&mut state, 25.0, 5.0, &Footprint::point(), &levels, &rules(), DT);
        step_level(&mut state, 25.0, 15.0, &Footprint::point(), &levels, &rules(), DT);

        assert!(
            matches!(state.transit, Transit::Ramp { climbing: false, .. }),
            "{:?}",
            state.transit
        );
        assert_eq!(state.level, 0);
        assert_eq!(state.z, 0.0);
    }

    #[test]
    fn drift_during_a_fall_moves_the_landing_level() {
        let levels = tall();
        let mut state = LevelState {
            level: 2,
            z: 2.0,
            ..LevelState::default()
        };

        // срыв с плиты уровня 2 над колонкой x=4: под ней плита уровня 1
        step_level(&mut state, 45.0, 15.0, &Footprint::point(), &levels, &rules(), DT);

        assert!(
            matches!(state.transit, Transit::Falling { to: 1, .. }),
            "{:?}",
            state.transit
        );

        // но летит тело на колонку x=5, где плиты нет вовсе
        let mut event = LevelEvent::None;

        for _ in 0..200 {
            event = step_level(&mut state, 55.0, 15.0, &Footprint::point(), &levels, &rules(), DT);

            if event != LevelEvent::None {
                break;
            }
        }

        assert_eq!(state.level, 0, "снос за плиту обязан ронять на землю");
        assert_eq!(state.z, 0.0);
        assert_eq!(event, LevelEvent::Landed { height: 2 });
    }

    #[test]
    fn bomb_falls_to_the_nearest_support_below() {
        let levels = tall();

        // колонка x=3 несёт плиты обоих уровней: бомба остаётся на своём
        assert_eq!(bomb_level(Some(&levels), 2, 35.0, 15.0, false), 2);
        // колонка x=4 — плита только уровня 1: разрыв над ней роняет бомбу
        // на неё, а не на землю
        assert_eq!(bomb_level(Some(&levels), 2, 45.0, 15.0, false), 1);
        // падающий роняет бомбу вниз даже над своей плитой
        assert_eq!(bomb_level(Some(&levels), 2, 35.0, 15.0, true), 1);
        // земля и карта без геометрии уровней
        assert_eq!(bomb_level(Some(&levels), 0, 45.0, 15.0, true), 0);
        assert_eq!(bomb_level(None, 2, 45.0, 15.0, false), 0);
    }

    #[test]
    fn gate_verdict_does_not_leak_into_the_next_run() {
        let levels = two_runs();
        let mut state = LevelState::default();

        // законный вход в первый прогон: клетка (0, 1) → (1, 1)
        step_level(&mut state, 5.0, 15.0, &Footprint::point(), &levels, &rules(), DT);
        step_level(&mut state, 15.0, 15.0, &Footprint::point(), &levels, &rules(), DT);

        assert!(
            matches!(state.transit, Transit::Ramp { climbing: true, .. }),
            "{:?}",
            state.transit
        );

        // проезд первого прогона до конца: наверху уровень 1
        step_level(&mut state, 25.0, 15.0, &Footprint::point(), &levels, &rules(), DT);

        assert_eq!(state.level, 1);

        // въезд во ВТОРОЙ прогон: его нижний торец ждёт уровень 0, поэтому
        // подъём обязан быть отказан. До правки вердикт наследовался от
        // первого прогона, и подъём продолжался бесплатно
        step_level(&mut state, 35.0, 15.0, &Footprint::point(), &levels, &rules(), DT);

        assert!(
            matches!(state.transit, Transit::Ramp { climbing: false, .. }),
            "{:?}",
            state.transit
        );
        assert_eq!(state.level, 1);
        assert_eq!(state.z, 1.0);
    }

    #[test]
    fn foot_cell_is_entered_diagonally() {
        let levels = layered();
        let mut state = LevelState::default();

        // клетка (0, 0) — диагональный сосед подножия: заезд под углом
        // поднимает так же, как заезд в лоб
        step_level(&mut state, 5.0, 5.0, &Footprint::point(), &levels, &rules(), DT);
        step_level(&mut state, 12.0, 15.0, &Footprint::point(), &levels, &rules(), DT);

        assert!(
            matches!(state.transit, Transit::Ramp { climbing: true, .. }),
            "{:?}",
            state.transit
        );
        assert_eq!(state.level, 0);
        assert!((state.z - 0.2).abs() < 1e-5, "z = {}", state.z);
    }

    #[test]
    fn ramp_entered_from_the_top_lowers_the_tank() {
        let levels = layered();
        let mut state = grounded(1);

        // спуск: танк уровня 1 приезжает по плите и заходит на прогон с его
        // верхнего торца
        step_level(&mut state, 25.0, 15.0, &Footprint::point(), &levels, &rules(), DT);
        step_level(&mut state, 17.0, 15.0, &Footprint::point(), &levels, &rules(), DT);

        assert_eq!(state.level, 1);
        assert!((state.z - 0.7).abs() < 1e-5, "z = {}", state.z);

        step_level(&mut state, 12.0, 15.0, &Footprint::point(), &levels, &rules(), DT);

        assert_eq!(state.level, 0);
        assert!((state.z - 0.2).abs() < 1e-5, "z = {}", state.z);
    }

    #[test]
    fn ramp_sets_both_level_masks() {
        let levels = layered();
        let mut state = LevelState::default();

        step_level(&mut state, 5.0, 15.0, &Footprint::point(), &levels, &rules(), DT);
        step_level(&mut state, 12.0, 15.0, &Footprint::point(), &levels, &rules(), DT);

        let mask = state.collision_mask();

        assert!(mask.contains(level_group(0)));
        assert!(mask.contains(level_group(1)));
    }

    #[test]
    fn tall_ramp_climbs_two_levels_at_once() {
        let levels = tall();
        let mut state = LevelState::default();

        // подножие прогона — клетка (1, 1), вершина — (2, 1)
        step_level(&mut state, 5.0, 15.0, &Footprint::point(), &levels, &rules(), DT);
        step_level(&mut state, 12.0, 15.0, &Footprint::point(), &levels, &rules(), DT);

        assert!((state.z - 0.2).abs() < 1e-5, "z = {}", state.z);
        assert_eq!(state.level, 0);

        // уклон безразмерный: два уровня по TILE на 20 мировых единиц = 1.0
        assert!((state.slope_vec[0] - 1.0).abs() < 1e-6, "{:?}", state.slope_vec);
        assert_eq!(state.slope_vec[1], 0.0);

        // маска прогона 0 → 2 обязана нести все три уровня
        let mask = state.collision_mask();

        assert!(mask.contains(level_group(0)));
        assert!(mask.contains(level_group(1)));
        assert!(mask.contains(level_group(2)));

        step_level(&mut state, 22.0, 15.0, &Footprint::point(), &levels, &rules(), DT);

        assert!((state.z - 1.2).abs() < 1e-5, "z = {}", state.z);
        assert_eq!(state.level, 1);

        step_level(&mut state, 29.0, 15.0, &Footprint::point(), &levels, &rules(), DT);

        assert!((state.z - 1.9).abs() < 1e-5, "z = {}", state.z);
        assert_eq!(state.level, 2);
    }

    #[test]
    fn falling_lands_on_the_slab_below() {
        let levels = tall();
        let rules = rules();
        let mut state = grounded(2);

        // колонка x=4 несёт пол только уровня 1
        step_level(&mut state, 45.0, 15.0, &Footprint::point(), &levels, &rules, DT);

        assert!(
            matches!(state.transit, Transit::Falling { from: 2, to: 1, .. }),
            "{:?}",
            state.transit
        );

        let mut event = LevelEvent::None;

        for _ in 0..1000 {
            event = step_level(&mut state, 45.0, 15.0, &Footprint::point(), &levels, &rules, DT);

            if event != LevelEvent::None {
                break;
            }
        }

        assert_eq!(event, LevelEvent::Landed { height: 1 });
        assert_eq!(state.level, 1);
        assert_eq!(state.z, 1.0);
        assert_eq!(state.transit, Transit::Grounded);
    }

    #[test]
    fn fall_duration_grows_with_height() {
        let levels = tall();
        let rules = rules();

        // с уровня 2 на землю (колонка x=5 без плит) и с уровня 1 на землю
        let mut deep = grounded(2);
        let mut shallow = grounded(1);

        step_level(&mut deep, 55.0, 15.0, &Footprint::point(), &levels, &rules, DT);
        step_level(&mut shallow, 55.0, 15.0, &Footprint::point(), &levels, &rules, DT);

        let steps = |state: &mut LevelState| {
            let mut count = 0;

            while step_level(state, 55.0, 15.0, &Footprint::point(), &levels, &rules, DT) == LevelEvent::None {
                count += 1;

                assert!(count < 1000, "падение обязано завершиться");
            }

            count
        };

        let shallow_steps = steps(&mut shallow);
        let deep_steps = steps(&mut deep);

        assert!(
            deep_steps > shallow_steps,
            "падение с 2 ({deep_steps}) обязано быть дольше падения с 1 ({shallow_steps})"
        );
        assert_eq!(deep.level, 0);
        assert_eq!(shallow.level, 0);
    }

    #[test]
    fn landed_carries_the_fall_height() {
        let levels = tall();
        let rules = rules();
        let mut state = grounded(2);

        step_level(&mut state, 55.0, 15.0, &Footprint::point(), &levels, &rules, DT);

        let mut event = LevelEvent::None;

        for _ in 0..1000 {
            event = step_level(&mut state, 55.0, 15.0, &Footprint::point(), &levels, &rules, DT);

            if event != LevelEvent::None {
                break;
            }
        }

        assert_eq!(event, LevelEvent::Landed { height: 2 });
    }

    #[test]
    fn slab_keeps_the_tank_grounded() {
        let levels = layered();
        let mut state = grounded(1);

        // колонка x=2 — плита
        let event = step_level(&mut state, 25.0, 25.0, &Footprint::point(), &levels, &rules(), DT);

        assert_eq!(event, LevelEvent::None);
        assert_eq!(state.transit, Transit::Grounded);
        assert_eq!(state.level, 1);
        assert_eq!(state.z, 1.0);
    }

    #[test]
    fn leaving_slab_starts_falling() {
        let levels = layered();
        let mut state = grounded(1);

        // колонка x=3 — плиты нет
        step_level(&mut state, 35.0, 25.0, &Footprint::point(), &levels, &rules(), DT);

        assert!(matches!(
            state.transit,
            Transit::Falling { from: 1, to: 0, .. }
        ));
        // стены остаются, тела — нет
        let mask = state.collision_mask();

        assert_eq!(mask, STATIC_LEVEL_GROUP);
        assert!(!mask.intersects(level_group(0)));
        assert!(!mask.intersects(level_group(1)));
        assert!(state.input_locked());
    }

    #[test]
    fn fall_elapsed_is_the_inverse_of_the_falling_lerp() {
        let rules = rules();

        assert_eq!(fall_elapsed(1.0, 1, 0, &rules), 0.0);
        assert!((fall_elapsed(0.5, 1, 0, &rules) - rules.fall_time * 0.5).abs() < 1e-6);
        assert_eq!(fall_elapsed(0.0, 1, 0, &rules), rules.fall_time);
        // высота вне диапазона (кадр старой карты) не даёт отрицательной фазы
        assert_eq!(fall_elapsed(2.0, 1, 0, &rules), 0.0);
        assert_eq!(fall_elapsed(0.5, 0, 0, &rules), 0.0);
        // падение на нижнюю плиту короче падения до земли
        assert!((fall_elapsed(1.5, 2, 1, &rules) - rules.fall_time * 0.5).abs() < 1e-6);
        assert!((fall_elapsed(1.0, 2, 0, &rules) - rules.fall_time).abs() < 1e-6);
    }

    #[test]
    fn falling_lands_after_fall_time() {
        let levels = layered();
        let rules = rules();
        let mut state = grounded(1);

        step_level(&mut state, 35.0, 25.0, &Footprint::point(), &levels, &rules, DT);

        let mut landed = false;

        for _ in 0..1000 {
            if step_level(&mut state, 35.0, 25.0, &Footprint::point(), &levels, &rules, DT)
                == (LevelEvent::Landed { height: 1 })
            {
                landed = true;
                break;
            }

            assert!(state.input_locked());
        }

        assert!(landed, "танк обязан приземлиться за fallTime");
        assert_eq!(state.level, 0);
        assert_eq!(state.z, 0.0);
        assert_eq!(state.transit, Transit::Grounded);
    }

    #[test]
    fn prev_cell_is_written_every_step() {
        let levels = layered();
        let mut state = LevelState::default();

        step_level(&mut state, 25.0, 25.0, &Footprint::point(), &levels, &rules(), DT);

        assert_eq!(state.prev_cell, (2, 2));

        // точка вне карты снова делает клетку неизвестной
        step_level(&mut state, -5.0, 25.0, &Footprint::point(), &levels, &rules(), DT);

        assert_eq!(state.prev_cell, (-1, -1));
    }

    #[test]
    fn grade_is_zero_off_the_ramp() {
        let levels = layered();
        let mut state = LevelState::default();

        step_level(&mut state, 25.0, 25.0, &Footprint::point(), &levels, &rules(), DT);

        assert_eq!(state.grade(1.0, 0.0), 0.0);
    }

    #[test]
    fn grade_follows_the_heading() {
        let levels = layered();
        let mut state = LevelState::default();

        step_level(&mut state, 5.0, 15.0, &Footprint::point(), &levels, &rules(), DT);
        step_level(&mut state, 12.0, 15.0, &Footprint::point(), &levels, &rules(), DT);

        // курс в горку — уклон положительный, назад — отрицательный
        assert!(state.grade(1.0, 0.0) > 0.0);
        assert!(state.grade(-1.0, 0.0) < 0.0);
        // поперёк прогона уклона нет
        assert_eq!(state.grade(0.0, 1.0), 0.0);
    }

    // корпус танка m1 в тестовом масштабе: 8 × 6 при тайле 10, то есть
    // свес за кромку до половины длины корпуса
    fn hull(angle: f32) -> Footprint {
        Footprint {
            angle,
            half_w: 4.0,
            half_h: 3.0,
        }
    }

    #[test]
    fn hull_hanging_over_the_edge_keeps_the_tank_grounded() {
        let levels = layered();
        let mut state = grounded(1);

        // плита уровня 1 — колонка x=2, то есть кромка на x=30. Центр уже
        // за ней, но задние углы корпуса (x=27) ещё на плите
        step_level(&mut state, 31.0, 25.0, &hull(0.0), &levels, &rules(), DT);

        assert_eq!(state.transit, Transit::Grounded);
        assert_eq!(state.level, 1);
        assert_eq!(state.z, 1.0);
        // ввод жив — реверс у самой кромки обязан спасать
        assert!(!state.input_locked());
        assert_eq!(state.collision_mask(), level_group(1));
    }

    #[test]
    fn hull_fully_past_the_edge_starts_falling() {
        let levels = layered();
        let mut state = grounded(1);

        // задний угол корпуса (x=31) тоже сошёл с плиты
        step_level(&mut state, 35.0, 25.0, &hull(0.0), &levels, &rules(), DT);

        assert!(matches!(
            state.transit,
            Transit::Falling { from: 1, to: 0, .. }
        ));
        assert!(state.input_locked());
    }

    #[test]
    fn reverse_from_the_brink_returns_to_the_slab() {
        let levels = layered();
        let mut state = grounded(1);

        step_level(&mut state, 31.0, 25.0, &hull(0.0), &levels, &rules(), DT);
        // дал назад: центр вернулся на плиту
        step_level(&mut state, 28.0, 25.0, &hull(0.0), &levels, &rules(), DT);

        assert_eq!(state.transit, Transit::Grounded);
        assert_eq!(state.level, 1);
        assert_eq!(state.z, 1.0);
    }

    #[test]
    fn support_follows_the_hull_heading() {
        let levels = layered();

        // одна и та же точка: вдоль кромки корпус достаёт до плиты длиной
        // (полудлина 4), поперёк — только шириной (полуширина 3)
        assert!(has_support(&levels, 1, 33.5, 25.0, &hull(0.0)));
        assert!(!has_support(
            &levels,
            1,
            33.5,
            25.0,
            &hull(std::f32::consts::FRAC_PI_2)
        ));
    }

    #[test]
    fn a_started_fall_ignores_regained_support() {
        let levels = layered();
        let mut state = grounded(1);

        step_level(&mut state, 35.0, 25.0, &hull(0.0), &levels, &rules(), DT);
        assert!(state.input_locked());

        // снос обратно под плиту падение не отменяет: сорвался — летишь
        step_level(&mut state, 25.0, 25.0, &hull(0.0), &levels, &rules(), DT);

        assert!(matches!(state.transit, Transit::Falling { from: 1, .. }));
        assert!(state.input_locked());
    }
}
