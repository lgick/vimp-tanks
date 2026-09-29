# Этап 1 (E). Нав-граф движка: место под корпус, A* на куче, `find_route` ✅ выполнен

**Репо:** `/Users/dmitry/Sites/my/vimp` (движок). **Файлы:**

- `packages/engine/core/src/nav/pathfinder.rs` — A*;
- `packages/engine/core/src/nav/navigation.rs` — `NavigationSystem`;
- `docs/en/core.md`, `docs/ru/core.md` — раздел «Layered maps (2.5D)», абзац про навигацию (≈стр. 314–330);
- `packages/engine/core/CHANGELOG.md` — `## [Unreleased]`.

**Цель.** Дать игре маршрут, по которому **корпус танка реально проходит**, с типами участков (пешком / рампа /
обрыв), стоимостью, штрафными зонами и управляемой ценой прыжка. Поиск должен быть быстрым и не отказывать на
ровном месте. Старое API (`find_path`, `find_path_on`, `random_point`, `is_walkable_on`,
`has_obstacle_between_on`, `random_node`) остаётся и работает как раньше, кроме двух исправленных багов.

**Кто пользуется.** Из игр — только `vimp-tanks` (`vimp-snakes` навигацию не использует). Внутри движка —
`game.rs` (генерация при `load_map`/`deserialize`) и `debug.rs` (счётчики узлов и рёбер). Нав-граф в дамп
состояния **не едет**: после `deserialize` он генерируется заново (`game.rs:528`). Но `NavigationSystem` имеет
`Serialize/Deserialize`, поэтому все новые поля помечаются `#[serde(default)]`.

**Нельзя менять построение графа.** Расстановку узлов, рёбра внутри уровня, `connect_ramps`, `connect_ledges`,
`closest_visible_node_on` (ими пользуется построение) не трогать. Новое только **добавляется** рядом: сетки
свободного места, метаданные рёбер, новый поиск. Так существующие тесты графа гарантированно остаются
зелёными.

---

## 1.1. A* на двоичной куче (`pathfinder.rs`)

Сейчас `find_path` держит `open_set: Vec<usize>` и ищет минимум линейно (O(n²)), а `g/f` лежат в `HashMap`.

1. Добавить функцию с настраиваемой стоимостью ребра:
   ```rust
   /// A* с настраиваемой стоимостью ребра: `cost(from, edge_index, edge)` —
   /// `Some(стоимость ≥ 0)` или `None` (ребро запрещено). Эвристика — евклидова
   /// дистанция, поэтому стоимость ребра обязана быть не меньше его длины,
   /// иначе путь перестаёт быть кратчайшим.
   /// Возвращает индексы узлов пути и его полную стоимость.
   pub fn find_path_with<F>(
       start_node: usize,
       end_node: usize,
       nodes: &[[f32; 2]],
       edges: &[Vec<Edge>],
       mut cost: F,
   ) -> Option<(Vec<usize>, f32)>
   where
       F: FnMut(usize, usize, &Edge) -> Option<f32>,
   ```
2. Реализация:
   - `g: Vec<f32>` (все `f32::INFINITY`), `came_from: Vec<usize>` (`usize::MAX`), `closed: Vec<bool>`, все длины
     `nodes.len()`;
   - `BinaryHeap<Open>`, `struct Open { f: f32, node: usize }`. `Ord` вручную: **меньший `f` — выше**
     (`other.f.total_cmp(&self.f)`), при равенстве **меньший `node` — выше** (`other.node.cmp(&self.node)`). Это
     даёт детерминированный разрыв ничьих;
   - ленивое удаление: вынутый узел пропускается, если он уже в `closed`;
   - `start == end` → `Some((vec![start], 0.0))`;
   - `debug_assert!(c >= 0.0)` на стоимость ребра.
3. Старую `find_path(start, end, nodes, edges)` оставить с той же сигнатурой как обёртку:
   `find_path_with(start, end, nodes, edges, |_, _, e| Some(e.weight)).map(|(path, _)| path)`. Функция
   `reconstruct_path` переписывается на `Vec`.
4. Тесты в `pathfinder.rs`:
   - существующие `finds_shortest_path_in_simple_graph` и `returns_none_when_unreachable` проходят без правок;
   - `astar_ties_are_deterministic`: решётка 4×4 с одинаковыми весами, два прогона дают одинаковый путь, путь
     кратчайший;
   - `astar_matches_dijkstra_on_random_graphs`: 20 случайных графов (`crate::rng::Rng` с фиксированным seed,
     30 узлов, случайные рёбра с весом ≥ евклидовой длины). Стоимость пути A* совпадает с эталонным Дейкстрой,
     который пишется прямо в тесте простым O(n²);
   - `forbidden_edge_is_skipped`: `cost` возвращает `None` для прямого ребра, и путь идёт в обход.

## 1.2. Сетки свободного места (`navigation.rs`)

Сейчас есть только проходимость клетки (`0` — свободно, `1` — стена/нет плиты, `2` — прогон рампы). Нужны две
производные сетки **на каждый уровень** (индекс = уровень, 0 — земля):

```rust
/// Размер (в клетках) наибольшего свободного квадрата, содержащего клетку;
/// 0 — клетка непроходима. Корпус шириной `w` проходит по клетке, только если
/// `fit ≥ ceil(w / grid_step)`. Параллельна сеткам уровней, насыщается на 15.
#[serde(default)]
fit: Vec<Vec<Vec<u8>>>,
/// Чебышёвское расстояние (в клетках) от клетки до ближайшей непроходимой
/// клетки или края карты; 0 — клетка непроходима, 1 — стоит вплотную к стене.
#[serde(default)]
clear: Vec<Vec<Vec<u8>>>,
```

«Свободна» — ровно `cell == 0` (как у `is_walkable_on`). Край карты считается непроходимым.

1. `fn build_clearance(&mut self)` — вызвать **в конце** `generate` и `generate_layered` (после
   `block_ramp_runs` и после рёбер; от этих сеток построение не зависит). Для каждого уровня
   `0..self.level_count()` взять `self.grid_of(level)`.
2. `clear`: два прохода chamfer-преобразования с метрикой Чебышёва.
   - Инициализация: непроходимая клетка — `0`, свободная — `u8::MAX`.
   - Прямой проход (y сверху вниз, x слева направо): `d = min(d, 1 + min(left, up, up-left, up-right))`.
   - Обратный проход (снизу вверх, справа налево): `right, down, down-right, down-left`.
   - Соседи за краем карты дают `0`, поэтому клетка у края получает `1`. Сложение насыщающее.
3. `fit`: классическое ДП «наибольший квадрат из свободных клеток с нижним правым углом в (x, y)»:
   `s[y][x] = 0`, если клетка непроходима, иначе `1 + min(s[y-1][x], s[y][x-1], s[y-1][x-1])`. Затем каждая клетка
   получает максимум `s` по всем квадратам, которые её **содержат**: для каждой `(x, y)` с `k = s[y][x]` (cap 15)
   записать `fit[yy][xx] = max(fit[yy][xx], k)` для `yy ∈ y-k+1..=y`, `xx ∈ x-k+1..=x`. Это O(N·k²), при cap 15 и
   картах до 100×100 дёшево.
4. Публичные запросы:
   ```rust
   /// Свободное место вокруг точки: расстояние от центра её клетки до
   /// ближайшей непроходимой клетки, мировые единицы; 0 — клетка непроходима.
   pub fn clearance_on(&self, level: u8, x: f32, y: f32) -> f32  // (clear − 0.5) · grid_step, 0 при clear = 0
   /// Проходит ли по клетке точки корпус ширины `width` (мировые единицы).
   pub fn fits_on(&self, level: u8, x: f32, y: f32, width: f32) -> bool // fit ≥ cells_for(width)
   ```
   `fn cells_for(&self, width: f32) -> u8` = `ceil(width / grid_step)`, минимум 1, насыщение 15. При
   `width ≤ 0` проверка вырождается в проходимость клетки.
5. Тесты:
   - `clearance_grows_away_from_walls`: `walled_grid()`. У клетки вплотную к стене `clearance_on` =
     0.5·step, через одну клетку — 1.5·step, у клетки стены — 0;
   - `fit_distinguishes_one_and_two_cell_corridors`: сетка 10×10, коридоры шириной 1 и 2 клетки. В узком
     `fits_on(width = 1.5·step)` = false, в широком true;
   - `upper_level_edges_count_as_blocked`: `layered(false)`. На краю плиты (соседняя клетка без пола)
     `clearance_on(1, …)` = 0.5·step.

## 1.3. Метаданные рёбер (`navigation.rs`)

Публичную структуру `Edge { node, weight }` **не менять**: добавление публичных полей ломало бы литералы у
внешних пользователей. Вместо этого завести приватный параллельный массив:

```rust
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
enum EdgeKind {
    Walk,
    /// Ребро подножие → вершина прогона. `axis`/`sign` — как у `RampRun`.
    Ramp { axis: u8, sign: i8 },
    /// Спрыгнуть с обрыва: `height` — сколько уровней падать.
    Ledge { height: u8 },
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
struct EdgeInfo {
    /// Минимум `fit` по клеткам ребра (линия Брезенхэма между узлами).
    fit: u8,
    /// Минимум `clear` по тем же клеткам.
    clear: u8,
    kind: EdgeKind,
}

/// Параллелен `edges`: `edge_info[i][k]` описывает `edges[i][k]`.
#[serde(default)]
edge_info: Vec<Vec<EdgeInfo>>,
```

1. Метаданные считаются **после** построения графа и сеток, отдельным проходом, так что код построения не
   меняется. В конце `build_clearance` (или отдельным `fn annotate_edges(&mut self, levels: Option<&MapLevels>)`,
   который зовётся после неё) для каждого ребра `edges[i][k]`:
   - уровни узлов `i` и `j = edge.node` совпадают → `Walk`. `fit`/`clear` — минимумы по клеткам линии
     Брезенхэма `nodes[i] → nodes[j]` на этом уровне. Обход клеток взять из `has_obstacle_between_on`, вынеся его
     в `fn walk_line_cells(&self, start, end, mut f: impl FnMut(i64, i64) -> bool)`: сам
     `has_obstacle_between_on` остаётся прежним по поведению. Клетка за картой даёт `0`;
   - уровни разные → это ребро рампы или обрыва (других межуровневых рёбер нет). **Рампа** — если найдётся прогон
     `run` из `levels.runs()`, у которого `{run.from, run.to} == {level(i), level(j)}`, а сами точки узлов
     совпадают (допуск 0.5 ед.) с его точками подножия и вершины. Эти точки пересчитать **той же формулой**, что в
     `connect_ramps`: `half = tile_size/2`, `cross = (cross_min + cross_max)/2`, при `sign > 0`
     `(bottom_along, top_along) = (min − half, max + half)`, иначе `(max + half, min − half)`, а точка —
     `[along, cross]` при `axis == 0` и `[cross, along]` при `axis == 1`. Тогда `kind = Ramp { axis, sign }`,
     `fit = max(1, floor((cross_max − cross_min) / grid_step))`, `clear = max(1, fit / 2)`. Рёбра рампы
     двусторонние (`link`): обратное ребро (вершина → подножие) — тоже `Ramp` того же прогона;
   - иначе это **обрыв** (ребро всегда сверху вниз): `Ledge { height: level(i) − level(j) }`, `fit` и `clear`
     берутся из клетки верхнего узла `i`.
   - на плоской карте (`generate`) все рёбра `Walk`, `levels = None`.
2. Отдать тип ребра наружу через тип участка маршрута (1.4). Сам `EdgeKind` остаётся приватным.
3. Тест `edge_info_is_parallel_to_edges`: у `layered(true)` и у `stacked(…)` для каждого `i` длины `edges[i]`
   и `edge_info[i]` совпадают. Рёбер `Ramp` всего ровно `ramp_edge_count()`: счётчик в коде уже учитывает оба
   направления. Рёбер `Ledge` — `ledge_edge_count()`.
4. Обрыв может лечь на ту же пару узлов, что и рампа. Ребро с доплатой обрыва (`weight − длина ≥
LEDGE_PENALTY / 2`) рампой не считается (так сделано при выполнении).

## 1.4. Запрос маршрута `find_route` (`navigation.rs`)

Публичные типы (рядом с `PathPoint`, все `Serialize/Deserialize`, кроме `PathQuery`/`PenaltyZone`):

```rust
/// Штрафная зона запроса: рёбра, середина которых внутри круга на этом
/// уровне, дороже на `cost_per_unit · (1 − d/radius)` за единицу длины.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PenaltyZone { pub level: u8, pub center: [f32; 2], pub radius: f32, pub cost_per_unit: f32 }

/// Параметры поиска маршрута. `Default` — поведение `find_path_on`.
#[derive(Clone, Copy, Debug)]
pub struct PathQuery<'a> {
    /// Ширина корпуса, мировые единицы: ребро запрещено, если где-то на нём
    /// `fit < ceil(min_width / grid_step)`. 0 — без ограничения.
    pub min_width: f32,
    /// Желательный запас от стен, мировые единицы: ребро с `clearance`
    /// меньше него дороже (см. `narrow_cost`). 0 — без предпочтения.
    pub comfort_clearance: f32,
    /// Доля длины ребра, добавляемая при нулевом запасе (линейно до 0 при запасе ≥ comfort).
    pub narrow_cost: f32,
    /// Множитель штрафа обрыва `LEDGE_PENALTY · height`: 1 — как в графе,
    /// 0 — прыжок стоит только длину, `f32::INFINITY` — обрывы запрещены.
    pub ledge_cost_scale: f32,
    pub penalties: &'a [PenaltyZone],
}

/// Как бот ПРИХОДИТ в точку участка из предыдущей точки.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub enum LegKind { Walk, Ramp { axis: u8, sign: i8 }, Ledge { height: u8 } }

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct RouteLeg { pub point: PathPoint, pub kind: LegKind }

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Route { pub legs: Vec<RouteLeg>, pub cost: f32 }
```

`impl Default for PathQuery<'_>`: `min_width 0, comfort_clearance 0, narrow_cost 0, ledge_cost_scale 1,
penalties &[]`.

```rust
pub fn find_route(&self, start: PathPoint, end: PathPoint, query: &PathQuery) -> Option<Route>
```

Алгоритм:

1. Пустой граф → `None`.
2. **Прямой участок.** Если `start.level == end.level` и коридор свободен, вернуть
   `Route { legs: [RouteLeg { point: end, kind: Walk }], cost: dist(start, end) }`. «Свободен» означает
   `has_clear_corridor_on(level, start, end, query.min_width / 2)` при `min_width > 0` и прежнее
   `!has_obstacle_between_on` при `min_width = 0` (так `find_path_on` остаётся прежним).
3. **Узлы старта и финиша:** `fn nearest_node_on(&self, level, pos, cells: u8) -> Option<usize>`, новая функция
   (старую `closest_visible_node_on` не трогать):
   - кольца `r = 1..=4` вокруг ячейки `node_grid` точки (кольцо `r` — все ячейки с `max(|dx|,|dy|) ≤ r`,
     уже просмотренные не повторять);
   - в каждом кольце среди узлов **этого уровня** с прямой видимостью (`!has_obstacle_between_on`) взять
     ближайший, у которого `fit` клетки узла ≥ `cells`. Если такого нет — ближайший видимый с любым `fit`;
   - нашёлся в кольце — вернуть, иначе следующее кольцо;
   - за 4 кольца видимого узла нет → `None`. Узел за стеной **не** брать: последний отрезок маршрута прошёл бы
     сквозь стену (решение по ревью, 1.9 п. 3). Запасные ходы — на стороне игры (этап 3).
4. **Старт и финиш на одном узле** (баг `find_path_on`, который сейчас отдаёт `None`) → `legs = [узел (Walk),
end (Walk)]`, `cost` = сумма двух отрезков.
5. **A\*:** `pathfinder::find_path_with(start_node, end_node, …, cost)`, где `cost(from, k, edge)`:
   - `info = edge_info[from][k]`; `info.fit < cells_for(min_width)` → `None` (при `min_width = 0` не
     проверять);
   - `base` = евклидова длина ребра;
   - `Ledge { height }`: `ledge_cost_scale` бесконечен → `None`, иначе
     `base += LEDGE_PENALTY · height · ledge_cost_scale`;
   - `narrow`: при `comfort_clearance > 0` и `clear_world = (info.clear − 0.5) · grid_step < comfort` добавить
     `base_len · narrow_cost · (comfort − clear_world) / comfort`;
   - зоны: для каждой зоны с `zone.level == level(from)` или `level(edge.node)`, если середина ребра ближе
     `radius`, добавить `base_len · cost_per_unit · (1 − d / radius)`;
   - вернуть `Some(сумма)`. Так как всё ≥ длины, эвристика остаётся допустимой.
6. **Участки:** первый узел пути — `Walk`. Для каждой следующей пары `(a, b)` найти индекс ребра `a → b` в
   `edges[a]` (линейный поиск по `node`) и перевести `EdgeKind` в `LegKind`. В конец добавить
   `RouteLeg { point: end, kind: Walk }`, как и `find_path_on`. `cost` — стоимость от A* плюс длины отрезков
   `start → первый узел` и `последний узел → end`.
7. **Старые функции поверх нового поиска.**
   `find_path_on(start, end)` = `find_route(start, end, &PathQuery::default())` → точки участков.
   `find_path(start, end)` — то же на уровне 0 (плоская карта) → `Vec<[f32; 2]>`. Проверить, что у плоского
   `generate` `edge_info` тоже заполнен (иначе индексация упадёт).

Вспомогательные публичные функции:

```rust
/// «Толстая» прямая видимость для езды: центральная линия и параллельные ей
/// линии со смещениями k·half_width/n (k = 1..=n, n = ceil(half_width / grid_step),
/// в обе стороны) проходят только по свободным клеткам (`cell == 0`). Шаг
/// смещения не больше клетки, так что колонну между линиями не пропустить.
/// Клетки самих концов проверяются только на центральной линии.
pub fn has_clear_corridor_on(&self, level: u8, start: [f32; 2], end: [f32; 2], half_width: f32) -> bool

/// Ближайший к точке центр свободной клетки уровня с `fits_on(width)` в
/// радиусе `max_radius`; порядок обхода детерминирован (дистанция, затем y, x).
/// Обход ограничен размерами сетки: `max_radius = f32::INFINITY` допустим, NaN → None.
pub fn nearest_walkable_on(&self, level: u8, pos: [f32; 2], width: f32, max_radius: f32) -> Option<[f32; 2]>

/// Случайный узел нужного уровня (или любого при `None`), у которого `fit`
/// не меньше, чем нужно корпусу ширины `width`: до 16 попыток, потом `random_point`.
pub fn random_point_where(&self, rng: &mut Rng, level: Option<u8>, width: f32) -> Option<PathPoint>
```

## 1.5. Тесты `navigation.rs` (к существующим; все старые обязаны пройти)

Хелперы уже есть: `walled_grid()`, `layered(with_ramp)`, `stacked(l1, l2)`, `ledge_penalties`.

| Тест                                    | Что проверяет                                                                                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `route_respects_min_width`              | стена с двумя проёмами: 1 клетка (короткий путь) и 3 клетки (длинный). При `min_width = 1.5·step` маршрут идёт через широкий, при `0` — через узкий |
| `narrow_cost_prefers_the_middle`        | широкий зал с колонной. При `comfort = 2·step, narrow_cost = 2` маршрут не жмётся к колонне (минимум `clearance_on` по точкам ≥ 1.5·step)           |
| `penalty_zone_causes_detour`            | зона на прямом пути — маршрут её обходит, `cost` выше, чем без зоны                                                                                 |
| `ledge_cost_scale_controls_jumps`       | `stacked`: `INFINITY` — ни одного участка `Ledge`, `0.0` — прыжок берётся, если он короче                                                           |
| `route_marks_ramp_and_ledge_legs`       | `layered(true)`: с земли на плиту есть участок `Ramp { axis, sign }` с параметрами прогона; спуск с плиты без рампы — `Ledge { height: 1 }`         |
| `route_when_start_and_end_share_a_node` | точки у одного узла, но за углом друг от друга — `Some`, а не `None` (фикс)                                                                         |
| `nearest_node_looks_beyond_3x3`         | точка в кармане, где ближайший видимый узел в кольце 2 — маршрут находится                                                                          |
| `find_path_on_keeps_legacy_results`     | для 3–4 пар точек из существующих фикстур точки `find_path_on` совпадают с записанными до правки (снять ожидания **до** изменения кода)             |
| `route_is_deterministic`                | два одинаковых запроса дают равные `Route`                                                                                                          |
| `nearest_walkable_respects_width`       | в узком коридоре точка сдвигается в широкий зал                                                                                                     |
| `corridor_check_catches_corners`        | линия вплотную к углу стены: тонкая видимость true, `has_clear_corridor_on(half_width = 0.4·step)` false                                            |

## 1.6. Документация и журнал

1. `docs/en/core.md`, раздел «Layered maps (2.5D)», после абзаца про `find_path_on` — подраздел
   **«Navigation queries»**: сетки `fit`/`clear` и что они значат; `find_route` и `PathQuery` (поля, единицы,
   умолчания = старое поведение); `LegKind`/`RouteLeg`/`Route`; `nearest_walkable_on`,
   `has_clear_corridor_on`, `random_point_where`, `clearance_on`, `fits_on`; A* на куче с детерминированным
   разрывом ничьих. Короткий пример запроса (5–8 строк Rust). `docs/ru/core.md` — зеркально.
2. В таблице тестов `core.md` (раздел «Tests», строка Rust unit) дописать «clearance grids, `find_route`».
3. `docs/ai/` — `grep -rn "find_path\|NavigationSystem" docs/ai`. Если там описана навигация, дописать
   `find_route` одной строкой, иначе не трогать.
4. `packages/engine/core/CHANGELOG.md`, `## [Unreleased]`:
   - `### Added` — `NavigationSystem::find_route` with `PathQuery` (body width, comfort clearance, ledge cost
     scale, penalty zones) returning a `Route` of typed legs (`LegKind::Walk/Ramp/Ledge`) and its cost;
     `clearance_on`, `fits_on`, `has_clear_corridor_on`, `nearest_walkable_on`, `random_point_where`;
     `pathfinder::find_path_with`.
   - `### Fixed` — `find_path_on` returned `None` when start and end snapped to the same node; the nearest-node
     search looked at 3×3 cells only and failed next to walls.
   - `### Changed` — A* runs on a binary heap (same paths, deterministic tie-breaking, much faster on large maps).
     `Added` задаёт минорный бамп: `0.22.x → 0.23.0`.

## 1.7. Проверка

```bash
cd /Users/dmitry/Sites/my/vimp
cargo test --workspace -q
npx eslint . --quiet && npm test -- --silent       # JS не менялся, но так положено по CLAUDE.md движка
# игра против локального движка (tracked-файлы игры не меняются):
cd /Users/dmitry/Sites/my/vimp-tanks
cargo test --workspace -q --config 'patch."crates-io".vimp-engine-core.path="../vimp/packages/engine/core"'
git checkout Cargo.lock   # если cargo переписал lock-файл игры
```

Все тесты игры, включая ботовые в `core/src/bots/controller.rs` и `core/tests/sim.rs`, обязаны остаться
зелёными: `find_path_on` изменился только в двух исправленных случаях.

## 1.9. Исправления по код-ревью (после первой реализации)

Ревью незакоммиченного кода этапа нашло четыре проблемы. Исправить **все четыре**, затем повторить 1.7 и
только после этого отметить этап «✅ выполнен».

1. **Диагональная щель — `walk_edge_info`.** Сейчас ширина ребра — минимум `fit`/`clear` по клеткам линии
   Брезенхэма. Там, где два блока стен касаются углами, диагональный шаг проходит между ними, и ребро получает
   `fit = 2` при щели нулевой ширины. Исправление:
   - в замыкании запоминать предыдущую клетку `(px, py)`;
   - если шаг диагональный (`x != px && y != py`), для шага взять `fit = min(fit(x, y), max(fit(x, py),
fit(px, y)))`, для `clear` так же;
   - смысл: хотя бы одна боковая клетка должна быть открыта, и берётся лучшая из двух. Обе закрыты → `0`,
     ребро запрещено при любом `min_width > 0`. Одинокий угол сбоку ребро не запрещает (его объедут лучи
     бота), но ширину ограничивает.

   `has_obstacle_between_on` и построение графа не трогать. При `min_width = 0` поведение прежнее, поэтому
   `find_path_on_keeps_legacy_results` обязан остаться зелёным. Тест `diagonal_corner_gap_is_impassable`: два
   блока стен касаются углами, единственное короткое ребро идёт через точку касания. При `min_width =
0.5·step` маршрут обходит блоки (или `None`, если обхода нет), при `0` — прежний путь.

2. **Колонна между линиями — `has_clear_corridor_on`.** При `half_width > grid_step` колонна между центральной
   и боковой линией не видна. Проверять линии со смещениями `k · half_width / n`, `k = 1..=n`,
   `n = max(1, ceil(half_width / grid_step))`, в обе стороны. Исключение клеток концов — как сейчас. Тест
   `corridor_check_sees_a_pillar_between_lines`: колонна в 1 клетку на расстоянии `1.5·step` от оси,
   `half_width = 2.5·step` → false. При `half_width = 1.0·step` колонна вне коридора → true.
3. **Узел за стеной — `nearest_node_on`.** Убрать запасной выбор `any_node` без проверки видимости: за 4 кольца
   видимого узла нет → `None`. Именно `None`, а не маршрут с пометкой:
   - игре пометку пришлось бы разбирать, а маршрут сквозь стену бесполезен;
   - у игры уже есть цепочка запасных попыток (этап 3, `Navigator::plan`), куда добавлен шаг «прижать старт».

   Тест `route_is_none_without_a_visible_node`: точка в замкнутом кармане стен → `find_route` возвращает
   `None`. Поправить текст «Navigation queries» в `docs/{en,ru}/core.md`, если там описан запасной узел.

4. **Большой радиус — `nearest_walkable_on`.** Ограничить обход размерами сетки: `max_cells = max(rows, cols)
   - 1`, `reach = min(ceil(max_radius / grid_step) + 1, max_cells)`. При `max_radius = f32::INFINITY`—`max_cells`, при `NaN`—`None`. Приведение `f32 → i64`делать только после этого ограничения. Тест`nearest_walkable_accepts_infinite_radius`: `INFINITY`и`1e30` возвращают тот же результат, что и радиус
     во всю карту, и не зависают.

**Отступления, принятые при выполнении** (в тексте выше уже учтены, повторно не переделывать):

- ребро с доплатой обрыва рампой не считается (1.3 п. 4);
- `ramp_edge_count()` — оба направления (1.3 п. 3);
- `ledge_cost_scale_controls_jumps` дополнительно проверяет `layered(true)`: на `stacked` без рамп при
  запрете обрывов маршрута нет вовсе;
- удалена приватная `closest_visible_node`, добавлен тест `random_point_where_honours_level_and_width`.

Журнал крейта: пункты 1–4 правят ещё не выпущенный код. Отдельные записи не нужны, достаточно, чтобы
существующие `Added`/`Fixed` оставались верными.

## 1.8. Отчёт о релизе (обязателен по `CLAUDE.md` движка)

Затронут артефакт — крейт `vimp-engine-core`. Бамп минорный (`### Added`) → `0.23.0`. Игра может перейти на
него, но не обязана. Версию не править и ничего не публиковать: пользователь выпускает крейт сам
(`npm run release` в движке, см. `docs/en/publishing.md`). В отчёте попросить пользователя выпустить крейт до
этапа 7. Этапы 2–6 идут на локальном patch (README, раздел «Работа с локальным движком»).
