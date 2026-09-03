# Этап 7 — боты на мостах

**Репозиторий:** `T` = `/Users/dmitry/Sites/my/vimp-tanks`
**Файлы:** `core/src/bots/controller.rs`, `core/src/tanks.rs` (`BotView`)

Цель: бот знает свой уровень, строит путь через рампы, при необходимости
спрыгивает с обрыва, не считает падение «застреванием», выбирает цель и
стреляет по правилам уровней.

Предусловие: этапы 1–5 зелёные (этап 6 не блокирует — боты живут в ядре).

## 7.1 `core/src/tanks.rs` — доступ к уровню из `BotView`

```rust
impl BotView<'_> {
    /// Уровень танка (2.5D-карты); 0 у одноуровневой карты.
    pub fn tank_level(&self, game_id: u32) -> u8 {
        self.tanks.get(&game_id).map(|t| t.level_state.level).unwrap_or(0)
    }

    /// Заблокирован ли ввод (танк в падении).
    pub fn tank_input_locked(&self, game_id: u32) -> bool {
        self.tanks.get(&game_id).is_some_and(|t| t.level_state.input_locked())
    }
}
```

`BotView` дополнить полем со слоями карты — они нужны и для проверки
достижимости выстрела:

```rust
pub(crate) struct BotView<'a> {
    ...
    /// Слоистая геометрия карты; `None` — одноуровневая карта.
    pub levels: Option<&'a MapLevels>,
}
```

Заполнять в `on_ai_tick` из `self.levels.as_ref()`.

## 7.2 `core/src/shot_levels.rs` — предикат достижимости

Боту нужен дешёвый ответ «достанет ли мой выстрел цель на её уровне».
Добавить рядом с `ray_segments`:

```rust
/// Уровень луча на дистанции `t` от старта: по нему решается, поразит ли
/// выстрел цель, стоящую на своём уровне. Боты спрашивают это перед
/// стрельбой, чтобы не палить в плиту моста.
pub fn level_at_distance(segments: &[RaySegment], t: f32) -> Option<u8> {
    segments
        .iter()
        .filter(|seg| t >= seg.t0 && t <= seg.t1)
        // сегментов на `t` может быть два (проба уровня 1 лежит внутри
        // сегмента уровня 0) — берём ВЕРХНИЙ: именно он описывает
        // возможность попасть по мосту с земли
        .map(|seg| seg.level)
        .max()
}
```

## 7.3 `core/src/bots/controller.rs`

### Тип пути

```rust
-    path: Option<Vec<[f32; 2]>>,
+    path: Option<Vec<PathPoint>>,
     path_index: usize,
...
-    patrol_target: Option<[f32; 2]>,
+    patrol_target: Option<PathPoint>,
```

`PathPoint` — из `vimp_engine_core::nav::navigation`. Оба поля идут в
`serde`-дамп (`BotBrain` — `Serialize`/`Deserialize`), значит форма дампа
эстафеты Worker'ов меняется. Это внутренний дамп ядра, версий у него нет —
но проверить `tanks.rs::deserialize` на устойчивость к старому дампу
(сегодня он падает целиком при несовпадении — оставить как есть,
зафиксировать в CHANGELOG строкой `### Changed`).

### Кэш кадра

```rust
    #[serde(skip)]
    my_position: Option<[f32; 2]>,
    #[serde(skip)]
    my_level: u8,
```

Заполнять там же, где `my_position` (метод обновления кэша в начале
`update`): `self.my_level = game.tank_level(self.game_id);`.

Вспомогательное:

```rust
    fn my_point(&self) -> Option<PathPoint> {
        Some(PathPoint { pos: self.my_position?, level: self.my_level })
    }
```

### Гейт падения — первым делом в `update`

```rust
        // танк в падении не управляется: любые клавиши всё равно
        // игнорируются ядром, а таймер застревания за 0.35 c успел бы
        // сорвать бота в ClearingObstacle на ровном месте
        if game.tank_input_locked(self.game_id) {
            self.release_all_keys(game);
            self.stuck_timer = 0.0;
            self.last_position = self.my_position;

            return;
        }
```

Ставить сразу после обновления кэша и после проверки `Dead`.

### `set_new_patrol_target`

```rust
        let random = nav.random_point(&mut game.rng);

        if let (Some(node), Some(my)) = (random, self.my_point()) {
            self.patrol_target = Some(node);
            self.path = nav.find_path_on(my, node);
            self.path_index = 0;
        }
```

### `move_to` / `follow_path`

`follow_path` берёт `path[self.path_index].pos`. Дополнительно:

```rust
        // смена уровня между точками пути — это рампа или обрыв. Порог
        // «дошёл до точки» на переходе делаем шире: на рампе танк
        // физически не может встать точно в узел уровня, к которому едет
        let reach = if next.level != self.my_level {
            MIN_TARGET_DISTANCE * 2.0
        } else {
            MIN_TARGET_DISTANCE
        };
```

и продвигать `path_index`, если `dist_sq(my, next.pos) < reach * reach`
**или** `self.my_level == next.level && dist_sq < MIN_TARGET_DISTANCE²`.

`move_to` менять не нужно — он оперирует точкой.

### `avoid_obstacles`

Функция (в конце файла) пускает лучи Rapier для объезда. Дополнить
фильтром групп по уровню бота:

```rust
    let filter = QueryFilter::new()
        .exclude_rigid_body(my_body_handle)
        .exclude_sensors()
        // объезжаем препятствия СВОЕГО уровня: перила моста над головой
        // бота на земле — не препятствие
        .groups(level_interaction(my_level));
```

Передать `my_level` параметром. Для одноуровневой карты фильтр по группам
не ставить вовсе (сохранить прежний путь бит-в-бит) — передать
`layered: bool`.

### `find_closest_enemy`

```rust
    /// Ближайший живой враг. Цель своего уровня всегда предпочтительнее:
    /// по чужому уровню бот чаще всего не может стрелять, и без этого
    /// предпочтения он застревал бы в Attacking, глядя в плиту моста.
    fn find_closest_enemy(&self, game: &BotView<'_>) -> Option<u32> {
        ...
        let mut same_level: Option<(u32, f32)> = None;
        let mut other_level: Option<(u32, f32)> = None;

        for candidate in candidates {
            ...
            let level = game.tank_level(candidate.game_id);
            let slot = if level == self.my_level { &mut same_level } else { &mut other_level };

            if slot.is_none_or(|(_, best)| distance_sq < best) {
                *slot = Some((candidate.game_id, distance_sq));
            }
        }

        same_level.or(other_level).map(|(id, _)| id)
    }
```

### `execute_aim_and_shoot`

Две правки.

1. Линия видимости — по СВОЕЙ сетке уровня:

```rust
        let visible = game.nav.as_ref().is_some_and(|nav| {
            !nav.has_obstacle_between_on(self.my_level, [my_position.x, my_position.y], target_pos)
        });
```

2. Достижимость по уровням: перед стрельбой проверить, что луч на дистанции
   до цели находится на уровне цели.

```rust
        let target_level = game.tank_level(target);

        if let Some(levels) = game.levels {
            let dir = direction.normalize_or_zero();
            let range = /* weapon.range текущего оружия; взять из game.weapons */;
            let segments = crate::shot_levels::ray_segments(
                levels, [my_position.x, my_position.y], [dir.x, dir.y], range, self.my_level,
            );

            if crate::shot_levels::level_at_distance(&segments, direction.length()) != Some(target_level) {
                // цель на чужом уровне и плита её закрывает: не стреляем,
                // а идём искать рампу
                return;
            }
        }
```

При `return` состояние остаётся `Attacking`, а `execute_movement` уже ведёт
бота к цели — путь пойдёт через рампу, потому что `find_path_on` знает
уровни.

### `calculate_new_combat_position`

Точка боевого перепозиционирования обязана лежать на СВОЁМ уровне:

```rust
            // кандидат годится, только если он проходим на моём уровне:
            // иначе бот на мосту побежит в точку, которой на мосту нет
            if nav.is_walkable_on(self.my_level, candidate[0], candidate[1]) { ... }
```

### `handle_clearing_obstacle`

Правок не требует, но проверить: если бот застрял на рампе, задний ход
уводит его вниз — это допустимо и самовосстанавливается.

## 7.4 Тесты

Фикстура — слоёная карта из `tests/core/fixtures/layered.json` (этап 3), с
рампой и мостом.

| Файл | Тест | Что проверяет |
| --- | --- | --- |
| `bots/controller.rs` | `bot_path_crosses_the_ramp` | Бот на земле, цель на мосту → путь содержит точку уровня 1 |
| `bots/controller.rs` | `bot_prefers_the_enemy_on_its_level` | Два врага, ближний — на чужом уровне → выбран дальний свой |
| `bots/controller.rs` | `bot_holds_fire_through_the_slab` | Цель под мостом, бот на мосту не в кромке → выстрела нет |
| `bots/controller.rs` | `bot_fires_at_the_enemy_on_the_open_edge` | Бот на земле, цель уровня 1 в кромке без перил → стреляет |
| `bots/controller.rs` | `falling_bot_releases_keys_and_does_not_get_stuck` | В `Falling` все клавиши отпущены, `stuck_timer` не растёт |
| `bots/controller.rs` | `combat_reposition_stays_on_the_level` | Точка перепозиционирования проходима на уровне бота |
| `shot_levels.rs` | `level_at_distance_prefers_the_upper_segment` | В зоне перекрытия сегментов возвращается уровень 1 |

Плюс сценарий `tests/scenarios/bots_bridge.json` (создаётся в этапе 8).

## 7.5 Changelog и документация

* `CHANGELOG.md` → `### Added`: боты пользуются рампами и мостами,
  выбирают цель и стреляют по правилам уровней.
  `### Changed`: форма внутреннего дампа `BotBrain` (путь стал списком
  точек с уровнем).
* `docs/en|ru/gameplay.md`: раздел про ботов — что они умеют на
  многоуровневых картах и чего не умеют (не прыгают ради сокращения пути,
  если здоровья меньше урона от падения — если такое правило внедрено).
* `docs/en|ru/core.md`: `BotView.levels`, `level_at_distance`.

## Критерии готовности этапа

```bash
cd /Users/dmitry/Sites/my/vimp-tanks
npm run core:build && npm run core:test && npx eslint . && npm test -- --silent
npm run build && npm run sim:scenarios
```

Отметить `✅ выполнен` здесь и в `plan/README.md`.
