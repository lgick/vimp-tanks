# Этап 6 (T). Команда, отступление, оборона ✅ выполнен

**Репо:** `/Users/dmitry/Sites/my/vimp-tanks` (локальный движок — README).

**Цель.**

- Боты играют командой: знают, где союзники (и боты, и люди), бьют в одну цель, не рвутся вперёд в одиночку,
  один заходит с фланга.
- Раненый или оказавшийся в меньшинстве бот отступает к союзникам или в укрытие, отстреливается, может
  спрыгнуть с моста, чтобы оторваться.
- Дойдя до укрытия, бот держит позицию (засада) и возвращается в бой, когда подошли свои.

**Файлы:** `core/src/bots/team.rs` (новый), `core/src/bots/brain.rs`, `core/src/bots/perception.rs`
(хелперы угроз), `core/src/bots/mod.rs` (`pub mod team;`), `core/src/tanks.rs` (`TanksSim.team_boards`,
`BotView.team`, отладочные методы), `core/tests/sim.rs`, `docs/{en,ru}/gameplay.md`, `docs/{en,ru}/core.md`,
`docs/{en,ru}/configuration.md`, `CHANGELOG.md`.

---

## 6.1. Доска команды (`team.rs`)

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum Role { Assault, Flanker, Support }

#[derive(Clone, Copy, Debug)]
pub struct Member {
    pub id: u32,
    pub pos: [f32; 2],
    pub level: u8,
    /// Доля «силы» по видимому состоянию корпуса: condition 3 → 1.0, 2 → 0.6, 1 → 0.3.
    /// Здоровья союзника игрок не видит, видит только корпус.
    pub strength: f32,
    pub is_bot: bool,
    /// Режим и цель бота (у людей `None`).
    pub mode: Option<BotMode>,
    pub target: Option<u32>,
}

/// Общие сведения команды на текущий тик ИИ. Производная структура: в дамп не
/// едет, пересобирается `TanksSim::rebuild_team_boards` раз в 0.1 с.
#[derive(Clone, Debug, Default)]
pub struct TeamBoard {
    pub team: u8,
    pub members: Vec<Member>,            // по возрастанию id
    pub centroid: Option<[f32; 2]>,
    pub focus: Option<u32>,
    focus_score: f32,
    focus_since: f32,
    pub roles: Vec<(u32, Role)>,         // только боты, по возрастанию id
    roles_at: f32,
    /// Враги, которых сейчас видит хотя бы один бот команды: (id, сколько видят).
    pub sightings: Vec<(u32, u8)>,
}
```

**Сборка** — `TanksSim`:

- поля `team_boards: IndexMap<u8, TeamBoard>`, `ai_clock: f32` и `team_timer: f32` (все не сериализуются; после
  `deserialize` начинаются с нуля, это допустимо);
- в `on_ai_tick` **до** цикла по ботам: `ai_clock += dt; team_timer -= dt`. На `team_timer ≤ 0` — `team_timer =
0.1` и `rebuild_team_boards()`;
- `rebuild_team_boards(&mut self)`: для каждой команды живых танков (`team_id`, по возрастанию):
  1. `members` — все живые танки команды с телом. `strength` — по `condition`; `mode`/`target` — из
     `self.bots.get(id)` (у людей `None`);
  2. `centroid` — среднее позиций членов (`None`, если их нет);
  3. `sightings` — по всем ботам команды: видимые контакты (`perception.contacts`, `visible`), подсчёт по id;
  4. **фокус.** Кандидаты — живые враги (танки других команд). Очки:
     `Σ_members 1/(1 + dist/300) + 0.5 · (кол-во видящих ботов) + 0.3 · (3 − condition)`. Лучший; при равенстве —
     меньший id. **Гистерезис:** прежний фокус жив, держится меньше 3 с или новый лучше меньше чем в 1.3 раза →
     оставить прежний. Иначе сменить (`focus_since = ai_clock`);
  5. **роли** раз в 2 с (`roles_at`). Боты команды по возрастанию id. `Support` — бот со своим здоровьем
     `< 50` (своё здоровье бот знает). Если ботов ≥ 3 — среди остальных с наибольшей `profile.aggression`
     (при равенстве меньший id) `Flanker`. Остальные `Assault`.
- `BotView` получает поле `pub team: Option<&'a TeamBoard>` — доска своей команды. В цикле `on_ai_tick`
  заимствовать `&self.team_boards` рядом с `&mut self.tanks`: это разные поля, конфликта нет. Для этого
  `team_id` бота прочитать заранее.
- Отладка (для тестов): `pub fn team_focus(&self, team: u8) -> Option<u32>`,
  `pub fn team_role(&self, id: u32) -> Option<Role>`.

Методы `TeamBoard`: `role(id) -> Role` (по умолчанию `Assault`),
`allies_near(pos, radius, exclude) -> impl Iterator<Item = &Member>`, `strength_near(pos, radius) -> f32`.

## 6.2. Перевес сил (в мозге, раз в тик решений)

```
allies  = своя сила (health / 100) + Σ strength союзников ближе 350
enemies = Σ strength(condition) контактов ближе 350, видимых или обновлённых радаром < 2 с назад
advantage = allies / enemies        (enemies == 0 → 10.0)
```

## 6.3. Новые режимы и чистая функция переходов

`BotMode` дополнить: `Retreat`, `Hold`, `Regroup`.

Вынести **все** переходы режимов (включая этап 4) в чистую функцию: её можно тестировать таблицей, без мира.

```rust
pub(crate) struct ModeInputs {
    pub mode: BotMode,
    pub mode_age: f32,
    pub alive: bool,
    pub has_contacts: bool,
    pub health: f32,
    pub retreat_hp: f32,            // profile.retreat_health, у aggression > 0.8 — ×0.6 («поздний отход»)
    pub retreat_advantage: f32,
    pub advantage: f32,
    pub damage_age: Option<f32>,    // с последнего урона
    pub threat_visible_near: bool,  // видимый враг ближе 450
    pub target_visible: bool,
    pub target_fire_clear: bool,
    pub target_dist: f32,
    pub preferred_range: [f32; 2],
    pub lost_sight_for: f32,
    pub unclear_for: f32,
    pub out_of_ammo: bool,          // w1 < 1 и (w2 < 1 или нет врага в радиусе бомбы)
    pub retreat_arrived: bool,
    pub safe_for: f32,              // сколько секунд нет видимых угроз
    pub ally_near: bool,            // союзник ближе 250
    pub hold_expired: bool,
    pub allies_pushing: bool,       // ≥ 2 союзников ближе 300 в Hunt/Engage
    pub leading_alone: bool,        // условие Regroup (6.6)
    pub regroup_done: bool,
    pub enemy_close: bool,          // видимый враг ближе preferred_range[0]
}

pub(crate) fn next_mode(i: &ModeInputs) -> BotMode
```

Правила, **по приоритету** (первое сработавшее побеждает):

| #   | Условие                                                                                                                                                                           | Режим                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 1   | `!alive`                                                                                                                                                                          | `Dead`                                     |
| 2   | `mode == Dead` (и жив)                                                                                                                                                            | `Roam`                                     |
| 3   | `!has_contacts`                                                                                                                                                                   | `Roam`                                     |
| 4   | `mode ∈ {Hunt, Engage, Regroup}` и (`health ≤ retreat_hp` и (`damage_age < 4` или `threat_visible_near`)) или (`advantage < retreat_advantage` и `health < 70`) или `out_of_ammo` | `Retreat`                                  |
| 5   | `mode == Retreat` и (`retreat_arrived` или (`safe_for > 2` и `ally_near`))                                                                                                        | `Hold`                                     |
| 6   | `mode == Hold` и `health < 20` и `threat_visible_near` и `mode_age > 1`                                                                                                           | `Retreat` (новая точка, текущую исключить) |
| 7   | `mode == Hold` и `enemy_close` и `health > retreat_hp`                                                                                                                            | `Engage`                                   |
| 8   | `mode == Hold` и ((`hold_expired` и `advantage ≥ 1`) или `allies_pushing`)                                                                                                        | `Hunt`                                     |
| 9   | `mode == Hunt` и `leading_alone`                                                                                                                                                  | `Regroup`                                  |
| 10  | `mode == Regroup` и `regroup_done`                                                                                                                                                | `Hunt`                                     |
| 11  | `mode ∈ {Roam, Hunt, Regroup}` и `target_visible && target_fire_clear && target_dist ≤ pmax·1.3`                                                                                  | `Engage`                                   |
| 12  | `mode == Engage` и (`lost_sight_for > 1.0` или `unclear_for > 1.5`)                                                                                                               | `Hunt`                                     |
| 13  | `mode == Roam` и `has_contacts`                                                                                                                                                   | `Hunt`                                     |
| —   | иначе                                                                                                                                                                             | `mode` без изменений                       |

Выдержка 0.5 с (`mode_age < 0.5` → без смены) действует для всех правил, кроме 1, 2 и 4. В отступление
уходят сразу.

## 6.4. Отступление (`Retreat`)

**Выбор точки** (при входе и раз в 1 с, пока в режиме). Угрозы `T` — видимые контакты ближе 600 плюс
`last_attacker`.

1. **Кандидаты**, максимум 12:
   - союзник: ближайший член команды (не сам бот), который дальше от угроз, чем бот. Точка —
     `nearest_walkable_on(его уровень, его позиция − 1.5·tile · направление_на_бота, hull_width, 2·tile)`;
   - дом: `home` (точка респауна, этап 4);
   - укрытия: 8 направлений (`k·π/4`) × радиусы {5, 8}·tile от бота, каждая точка прижата
     `nearest_walkable_on(my_level, q, hull_width, 2·tile)`. Оставить только те, где **для каждой** угрозы
     `nav.has_obstacle_between_on(T.level, T.pos, p)` и `…_on(my_level, …)` — обе true: угроза точку не видит;
   - спрыгнуть: если `my_level > 0` и `health > fall_cost(1) + 10` (`fall_cost` — этап 3). До 2 точек: клетки
     в радиусе 5·tile без пола своего уровня (`levels.has_floor(my_level, x, y) == false`), у которых
     `levels.landing_level(my_level, x, y) < my_level`. Точка — `nearest_walkable_on(landing, …)`.
2. **Предотбор** 4 лучших по `h = dist(me, p) − 1.5 · min_T dist(T, p)`.
3. **Оценка** каждого из 4: `find_route(me → p, PathQuery { min_width: hull_width, penalties: зоны угроз
(радиус 220, cost 4), ledge_cost_scale: 0.3, .. })` — по 1 единице `route_budget`. Нет бюджета — вместо
   стоимости `h`. `score = cost − 200 · (союзников ближе 250 к p) + 300 · (p видна хоть одной угрозе)`.
   Минимум — цель.
4. Ничего не нашлось → `home`. Нет и его → точка `me − dir_to_nearest_threat · 6·tile`, прижатая к проходимой.

**Движение:**

- цель навигатора — выбранная точка (`moving = false`), дополнительные зоны — зоны угроз (`extra` в
  `Navigator::plan`);
- угроза видна и направление на цель отхода отличается от направления на угрозу больше чем на 2.0 рад —
  **задний ход** лицом к угрозе: `allow_reverse = true`, `reverse_distance = 8·tile`;
- башня держит ближайшую видимую угрозу. **Ответный огонь** разрешён при `fire_line == Clear`, но ошибка
  прицела ×1.3 (поле `aim_penalty` в `Aim`, множитель к `error`);
- бомба по правилу (б) этапа 5: враг позади ближе 60 и приближается;
- прыжок вниз из списка кандидатов — это обычный участок `Ledge` маршрута, отдельной логики нет.

**`retreat_arrived`** — бот ближе `1.5·tile` к точке отхода.

## 6.5. Удержание (`Hold`)

- При входе: `hold_until = clock + rng.range(4, 8) · (1.5 − aggression)`, `hold_expired = clock > hold_until`.
- Газ не жать. Корпус развернуть на месте так, чтобы направление на последнюю известную угрозу (контакт
  `last_attacker`, иначе ближайший контакт) было в пределах `±(lim − 0.3)`.
- Башня заранее смотрит на эту угрозу («пре-эйм»). Если враг появится там, реакция укоротится (×0.6, этап 5).
- Стрельба по видимым целям при `fire_line == Clear` — как в `Engage`, но без «змейки».
- Раз в `rng.range(2, 3)` с — небольшой сдвиг: точка в ±1·tile поперёк линии на угрозу. Сдвиг только если
  точка проходима, помещает корпус и тоже скрыта от угроз (как укрытие в 6.4); иначе стоять.
- Для сторожа (этап 3) `Hold` — намеренная остановка.

## 6.6. Командные приёмы

1. **Фокус.** В `choose_target` (этап 4) множитель 0.75 для `team.focus`.
2. **Сбор** (`leading_alone` для 6.3) — все условия сразу:
   - роль не `Flanker`;
   - в команде ≥ 2 членов (люди тоже считаются);
   - `advantage < 1.0`;
   - есть цель, и `dist(me, цель) + 350 < dist(centroid, цель)`: бот оторвался вперёд.

   В `Regroup` цель навигатора — `centroid`, прижатый к проходимой клетке на уровне ближайшего к центру члена
   команды (`moving = true`). `regroup_done` — ближе 180 к центру или режим длится больше 4 с. Стрелять по
   видимой цели можно.

3. **Фланг.** `Flanker` в `Hunt` добавляет в запрос маршрута зону `PenaltyZone { level: my_level, center:
середина(centroid, позиция фокуса), radius: 0.35 · dist(centroid, фокус), cost_per_unit: 3.0 }`. Маршрут
   огибает прямую линию «группа → цель» и выводит сбоку. Ближе `1.3 · pmax` к цели бот воюет как обычно.
4. **Поддержка.** `Support` в `Hunt` не лезет вперёд. Цель навигатора — точка в 200 ед. позади ближайшего
   `Assault`-союзника на линии «союзник → цель», прижатая к проходимой. В бой (`Engage`) идёт по видимой цели,
   как все.
5. **Не мешать своим.** Уже есть: `Ally` на линии огня меняет сторону манёвра (этап 5), бот расступается с
   союзником (этап 3). Дополнительно в `Engage` сторона «змейки» выбирается от ближайшего союзника (`side`
   такой, чтобы `m` уводил от него), если он ближе 120.
6. **Оборона при атаке.** В `Roam`/`Hunt`/`Regroup` новый урон при видимом `last_attacker` → немедленный
   `choose_target` (этап 4 уже переключит на атакующего) и `Engage` в обход выдержки 0.5 с. Плюс
   `evade_until = clock + 1.5`: «змейка» сразу меняет сторону.

## 6.7. Тесты

**Юнит:**

- `next_mode` — табличный тест: по строке на каждое правило 6.3 плюс проверка выдержки (0.5 с) и приоритета
  отступления над боем;
- `team_board_focus_and_hysteresis` — синтетические `members`/контакты: фокус выбирается по формуле и не
  меняется при улучшении кандидата меньше чем в 1.3 раза;
- `roles_assign_one_flanker` — 3 бота с разной `aggression`: один `Flanker`, раненый (`health 40`) —
  `Support`;
- `advantage_counts_humans` — союзник-человек рядом повышает `advantage`;
- `cover_point_is_hidden_from_threat` — `Fixture` с `levels()`: угроза и бот по разные стороны стены.
  Выбранная точка отхода не видна угрозе (`has_obstacle_between_on == true`);
- `flanker_route_avoids_the_direct_line` (в `navigator.rs`) — плоский граф
  `NavigationSystem::generate(&grid, &[1], 32.0)`: сетка 30×20, периметр и стена в колонке 15 с двумя
  проходами, строки 3..=5 и 14..=17. Группа и цель на строке 4 по разные стороны стены. Без зоны маршрут
  идёт через верхний проход, с зоной фланга (центр — середина отрезка «группа → цель», радиус
  `0.35 · дистанция`) — через нижний.

**Интеграционные** (`core/tests/sim.rs`):

- `wounded_bot_retreats_and_fires_back`: `map_json()`, бот 1 (team 1) в `(150, 200)`, бот 2 (team 2, `hard`
  через `debug_set_bot_skill`) в `(450, 200)`. Боту 1 сразу `debug_set_health(1, 25)`. Режимы снимать каждые
  0.1 с (`bot_debug(1).mode`). За 2 с бот 1 побывал в `"Retreat"`, за 4 с отъехал от стартовой позиции бота 2
  (расстояние выросло больше чем на 40 ед.), а `stats.shots_fired` за время отступления вырос: отстреливался.
- `team_focuses_one_target`: 3 бота team 1 слева; 2 неподвижных врага (`spawn_actor`) справа в прямой
  видимости, на 300 и 340 ед. Через 5 с не меньше 2 из 3 ботов имеют `target == team_focus(1)`.
- `leading_bot_waits_for_the_team`: `walled_arena` (или `downtown_map_json()`), 3 бота team 1, один на 500 ед.
  впереди двух других; 2 неподвижных врага в конце. За 10 с лидер хотя бы раз был в `"Regroup"`, и в какой-то
  момент все три бота ближе 400 к центру команды.
- `bots_do_not_stall_on_downtown` (этап 3) — `"Hold"` тоже прерывает окно.

## 6.8. Документация и журнал

- `docs/en/gameplay.md` (+ ru), «Bots» → подпункты:
  - **Teamwork** — знают, где свои (включая людей); общий фокус; один `Flanker` на троих; раненые — `Support`;
    не рвутся вперёд без перевеса (`Regroup`); не стреляют сквозь своих и расступаются;
  - **Retreat and defence** — когда отступают (`retreatHealth`, `retreatAdvantage`, пустой боезапас; дерзкие
    — позже); куда (к своим, в укрытие, домой, вниз с моста); задний ход с ответным огнём; бомба
    преследователю; удержание позиции с заранее наведённой башней и возвращение в бой, когда подошли свои.
  - Абзац «What it does not do» переписать: что осталось вне поведения. Например: не учитывает поверхности
    (масло, лёд), не знает о разрушениях для графа, не пользуется чатом.
- `docs/en/configuration.md` (+ ru): смысл `aggression`, `retreatHealth`, `retreatAdvantage` по факту
  реализации.
- `docs/en/core.md` (+ ru): `team.rs` (`TeamBoard`, сборка раз в 0.1 с, не в дампе), `next_mode` с таблицей.
- `CHANGELOG.md`, `## [Unreleased]` → `### Added`:
  - «Bots play as a team: they know where their teammates (humans included) are, focus the same enemy, one of
    three flanks, the wounded hang back, and a bot that has run ahead waits for the team.»
  - «Bots retreat when badly damaged, outnumbered or out of ammo — to teammates, into cover or down from a
    bridge — backing away while firing back, then hold the position until the team pushes again.»

## 6.9. Проверка

```bash
cargo test --workspace -q
npx eslint . --quiet
npm run core:build:node && npm test -- --silent
npm run build && npm run sim:scenarios
```

## Отклонения при выполнении (согласованы с пользователем)

- **Правило 11:** `Roam` из него убран — `Roam` идёт в `Engage` через `Hunt` (правило 13), как раньше. С
  прямым `Roam → Engage` тест `bot_accuracy_is_human_like` выходил за границу 0.9.
- **Движок (E):** `find_route` не срезает прямой отрезок через штрафную зону своего уровня (иначе зона фланга
  и зоны угроз не работали в прямой видимости). Правка в `packages/engine/core/src/nav/navigation.rs`, тест
  `penalty_zone_on_the_direct_line_is_not_cut`, доки `core.md`, журнал крейта `### Fixed`. Игра собирается
  против локального движка через `.cargo/config.toml` (README, «Работа с локальным движком»); этап 7 снимает
  patch и бампает крейт.
- **`wounded_bot_retreats_and_fires_back`:** враг неподвижный (`spawn_actor`), а не `hard`-бот: с 25 HP бот
  погибал от первого же выстрела.
- **`leading_bot_waits_for_the_team`:** своя арена 60×20, лидер в 800 ед. впереди: при 500 условие сбора
  (`dist + 350 < dist(centroid)`) недостижимо геометрически.
- **Точки отхода** ближе 1.5 тайла к боту (в том числе `home`, если бот на точке респауна) отбрасываются: там он
  уже стоит.
- **Оборона при атаке (6.6.6):** «змейка» меняет сторону через `weave_switch_at = clock`; `evade_until` —
  отъезд от своей бомбы, его не трогаем.
