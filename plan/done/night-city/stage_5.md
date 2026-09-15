# Этап 5. Разрушаемые объекты: ядро ✅ выполнен

**Репозиторий:** `vimp-tanks`. **Зависит от:** этапов 0–1 (этап 3 не обязателен, но проверки «разрушено → сил нет»
согласовать, если он уже сделан).
**Перед началом:** `plan/night-city/README.md` → «Общий контекст»; `docs/en/core.md` → «Shooting and explosions across levels»;
`docs/en/gameplay.md` → «Weapons and the tank».

## Цель

Три типа пропов на основе динамических тел карты:

| Проп | Поведение |
| --- | --- |
| `fence` | мало HP; ломается выстрелом или тараном на скорости; обломки не мешают проезду |
| `crate` | много HP, стадия «повреждён»; при разрушении — обломки, проезд свободен |
| `barrel` | мало HP; при разрушении взрывается (урон и импульс по площади), вызывает цепную реакцию с задержкой, оставляет копоть |

Разрушенный объект не удаляется из мира: тело **отключается** (`RigidBody::set_enabled(false)`), байт состояния = `2`.
Смерть от взрыва бочки — **самоубийство** (`Death { victim, killer: victim }`). В начале раунда всё восстанавливается
(движок перезагружает карту → `on_map_loaded`).

## 5.1 Конфигурация

1. `src/config/game.js` → `coreParams.props` (стартовые значения, мир в единицах после `mapScale`; максимальная
   скорость танка 260):
   ```js
   props: {
     fence:  { hp: 30,  damagedAt: 0,   bulletFactor: 1.0, blastFactor: 1.0, ramThreshold: 60,  ramDamagePerSpeed: 0.5 },
     crate:  { hp: 120, damagedAt: 0.5, bulletFactor: 0.5, blastFactor: 1.5, ramThreshold: 140, ramDamagePerSpeed: 0.6 },
     barrel: { hp: 40,  damagedAt: 0,   bulletFactor: 1.0, blastFactor: 1.0, ramThreshold: 150, ramDamagePerSpeed: 1.0,
               chainDelay: 0.15,
               blast: { radius: 70, damage: 80, impulse: 2500000, cameraShake: { intensity: 30, duration: 400 } } },
   },
   ```
   `damagedAt` — доля HP, ниже которой состояние `1` (`0` — стадии нет); `bulletFactor`/`blastFactor` — множители урона
   выстрела и взрыва; `ramThreshold` — скорость удара вдоль нормали, ниже которой урона нет; `ramDamagePerSpeed` —
   урон за единицу превышения; `chainDelay` — задержка детонации от чужого взрыва, секунды.
2. `core/src/config.rs`: `PropRules { types: BTreeMap<String, PropType> }`, `BlastSpec`; поле в `TanksConfig`
   (клиенту не нужно). `validate()`: `hp > 0`, `damagedAt ∈ [0, 1)`, множители `≥ 0`, `ramThreshold ≥ 0`,
   `chainDelay > 0`, у `blast` — `radius > 0`. Сравнить `chainDelay` с `timeStep` в `validate(&self)` нельзя:
   шаг живёт в конфиге движка. Число шагов считается при создании `TanksSim` как
   `max(1, ceil(chainDelay / timeStep))`, поэтому детонация никогда не попадает в тот же шаг.
3. Поле карты: `physicsDynamic[i].game = { prop: 'crate' }` (разбирается в `PropGame`, этап 1). Тела без `prop` —
   обычные неразрушаемые ящики, как сейчас. Неизвестное имя пропа → `Err` из `on_map_loaded`.

## 5.2 Модуль `core/src/props.rs`

```rust
#[derive(Serialize, Deserialize, Clone)]
pub struct Prop { pub kind: usize, pub hp: f32, pub pending_steps: Option<u32> }

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Props { pub entries: Vec<Option<Prop>> } // индекс = индекс physicsDynamic
```

- `Props::build(map: &GameMap, rules: &PropRules) -> Result<Props, String>` — из `dynamic_game_data(i)`.
- `enum DamageCause { Bullet, Ram, Blast }`.
- `fn damage(&mut self, index, amount, cause: DamageCause, rules, chain_steps) -> PropTransition`
  (`None | Damaged | Destroyed | Primed`); уже разрушенный и уже взведённый (`pending_steps.is_some()`) урона не
  получают. Правило 5.3.2 живёт **внутри** `damage`, а не у вызывающего: бочка, у которой HP дошёл до нуля от
  `DamageCause::Blast`, получает `pending_steps = chain_steps` и возвращает `Primed`; от `Bullet`/`Ram` — `Destroyed`.
  Множитель выбирает `damage` по причине: `Bullet` → `bulletFactor`, `Blast` → `blastFactor`, `Ram` → `1`
  (масштаб тарана уже в `ramDamagePerSpeed`). Вызывающий код передаёт урон **без** множителя.
  Для `fence`/`crate` причина влияет только на множитель: переход определяется остатком HP и от причины не зависит
  (`Damaged` — ниже `damagedAt`, `Destroyed` — HP до нуля), `Primed` у них не бывает.
  Unit-тест: одинаковый сырой урон по ящику от трёх причин даёт три ожидаемых остатка HP.
- Отдельного `schedule_detonation` нет: взведение делает `damage`. `fn tick_detonations(&mut self) -> Vec<usize>` —
  уменьшает счётчики и возвращает индексы дошедших до нуля по возрастанию.
- Unit-тесты: переходы состояний, пороги `damagedAt`, повторный урон по разрушенному и по взведённому, `Primed`
  только для бочки и только от `Blast`, порядок `tick_detonations`.

## 5.3 Интеграция в `TanksSim` (`core/src/tanks.rs`)

1. Поле `props: Props`; строится заново в `reset_round_state()` (этап 1.4.2), то есть только из `on_map_loaded` —
   это и есть восстановление в начале раунда. `ctx.map_body_state` движок уже обнулил. В дамп (`TanksDump`) — да;
   после `deserialize` пропы берутся из дампа и **не** пересобираются (`rebuild_map_derived` их не трогает).
2. `fn destroy_prop(&mut self, ctx, index)`:
   `ctx.map_body_state[index] = 2`, тело: `set_linvel(0)`, `set_angvel(0)`, `set_enabled(false)` (сверить имя API с версией
   Rapier в корневом `Cargo.lock`, сейчас `rapier2d 0.34`). Для `barrel` — `explode` (5.4) в том же вызове.
   `Damaged` → `ctx.map_body_state[index] = 1`.
   **Порядок для бочки** — единое правило по причине урона:
   - выстрел, таран, отложенная детонация → `destroy_prop` сразу: `state = 2`, тело отключено, взрыв в этом же шаге;
   - чужой взрыв (бомба или другая бочка) → `destroy_prop` **не** вызывается: HP обнуляется, ставится
     `pending_steps`, а тело остаётся целым и включённым (`state` не меняется, бочка видна до самого взрыва).
     Когда `pending_steps` доходит до нуля, вызывается `destroy_prop` → `state = 2` и `explode`.
   Бочка с `pending_steps` урона больше не получает и повторно не взводится (`damage` возвращает `None`);
   выстрел в неё детонацию не ускоряет. Вызывающий код реагирует только на результат `damage`:
   `Damaged` → `state = 1`, `Destroyed` → `destroy_prop`, `Primed` → ничего.
3. Отложенные детонации: в `on_fixed_step` (в конце, после `process_shots_expired_by_time`) вызвать
   `props.tick_detonations()` и для каждого индекса — `destroy_prop` (детерминизм: по возрастанию индекса).

## 5.4 Взрыв: рефакторинг `detonate` и исправление бага центра

1. `detonate(ctx, &bomb, weapon_index)` (≈1186) разделить:
   ```rust
   struct Blast { x: f32, y: f32, level: u8, radius: f32, damage: f32, impulse: f32,
                  owner: Option<(u32 /*game_id*/, u8 /*team*/, usize /*weapon*/)>, shake: Option<CameraShake> }
   fn explode(&mut self, ctx: &mut SimCtx, blast: &Blast) -> ExplosionRow
   ```
   Бомба собирает `Blast` из своего оружия и вызывает `explode`; строка `w2e` пишется как раньше
   (`weapon_effects["w2e"]`, ≈1173).
2. `apply_damage` (≈1285) разделить на `apply_damage_raw(ctx, victim, killer, amount, shake)` и тонкую обёртку
   для оружия. Бочка: `killer = victim`, `shake = blast.shake`, проверка дружественного огня не применяется.
3. **Баг центра**: для тел карты расстояние и точка импульса берутся от центра коллайдера (`collider.position()` /
   центр масс тела), а не от `body.translation()` (угол тела). Бомбы после исправления толкают ящики иначе
   (без паразитного закручивания) — это `### Fixed` в журнале; обновить затронутые ожидания в тестах.
4. В цикле целей `explode`: тело карты с пропом → `damage(index, dmg, DamageCause::Blast, rules, chain_steps)`
   (множитель `blastFactor` применяет сама `damage`); результат обрабатывается по правилу 5.3.2 — бочка вернёт
   `Primed`, `fence`/`crate` — `Destroyed`/`Damaged`. `chain_steps` посчитан в `TanksSim::new` (5.1.2). Уровневый фильтр
   (≈1215–1219) не меняется: отключённые тела запросом не находятся.

## 5.5 Попадания выстрелом

`process_hitscan` (≈1066–1085): если у родительского тела `is_map_object(user_data)` →
`index = map_object_index(user_data)`; если это проп — `damage(index, weapon.damage, DamageCause::Bullet, rules, chain_steps)`.
Множитель `bulletFactor` применяет сама `damage` (5.2) — снаружи не умножать, иначе он применится дважды.
Импульс остаётся.
Отключённый коллайдер луч уже не видит.

## 5.6 Таран

1. Скорость до шага: **последним действием** `on_fixed_step` — после `tank.update`, отложенных детонаций (5.3.3)
   и сил поверхностей (этап 3), до `world.step` — записать `pre_step_vel` для каждого танка и каждого тела-пропа.
   Все импульсы шага уже применены, контакт ещё не решён. Запись раньше детонаций потеряла бы толчок взрыва.
2. `on_contacts` (≈504): пары «танк ↔ тело карты с пропом» (`CollisionEvent::Started`). Нормаль — из
   `ctx.world.narrow_phase.contact_pair(c1, c2)` (первый манифолд, нормаль в мировых координатах);
   если манифолда нет — вектор между центрами.
   `impact = max(0, (v_tank − v_prop) · n)` по `pre_step_vel`, направление `n` — от танка к пропу.
   `impact > ramThreshold` → `damage(index, (impact − ramThreshold) · ramDamagePerSpeed, DamageCause::Ram, rules, chain_steps)`.
   Для тарана множитель равен `1`: весь масштаб урона уже задан `ramDamagePerSpeed`. Танк урона не получает.
3. Длительное толкание урона не наносит: `Started` приходит один раз на контакт.

## 5.7 Боты и уровни

- Отключённые тела не видны лучам обхода препятствий и поиску цели — правок не требуется, но это нужно проверить тестом.
- Граф навигации статичен: сломанный забор не открывает ботам путь. Записать в `gameplay.md` как осознанное ограничение.
- Цепная реакция и урон учитывают уровень бочки (`dynamic_level(i)`).

## 5.8 Тесты

`core/tests/sim.rs` (фикстура карты с тремя пропами на уровне 0 и бочкой на уровне 1):
- N выстрелов ломают забор; ящик проходит стадию `1`, затем `2`; байт `state` в кадре меняется;
- таран на полной скорости ломает забор, медленное толкание — нет;
- выстрел в бочку → строка `w2e`, урон танку в радиусе, `Death { killer: victim }` при смертельном уроне;
- две бочки рядом: вторая взрывается через `chainDelay`, а не в тот же шаг; до взрыва её `state = 0` и тело включено;
- бочка на уровне 1 не повреждает танк на уровне 0;
- разрушенное тело: луч проходит насквозь, танк проезжает, бомба не толкает;
- повторный `load_map` восстанавливает пропы, `state = 0`, тела включены;
- `state_dump_restores_identical_simulation` с отложенной детонацией;
- бомба рядом с ящиком толкает его от центра (регрессия бага).

## 5.9 Документация и журнал

- `docs/en|ru/core.md`: модуль `props.rs`, `explode`/`Blast`, таран по скорости до шага, отключение тел, дамп.
- `docs/en|ru/gameplay.md`: разрушаемые объекты, цепные реакции, самоубийство от бочки, восстановление в начале раунда,
  ограничения ботов.
- `docs/en|ru/configuration.md`: `coreParams.props`, `physicsDynamic[].game.prop`, смысл `state`.
- `CHANGELOG.md` → `### Added` (пропы); `### Fixed` (центр взрыва для тел карты).

## Критерии готовности

Проверки из README зелёные; существующие сценарии `combat`/`selfblast` проходят.
