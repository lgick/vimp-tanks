# Этап 6. Сценарии, документация, CHANGELOG ✅ выполнен

Требует этапы 1–5.

## 6.1. Отладочные сценарии

`tests/scenarios/*.json` — фикстуры безголового прогона
(`npm run sim:scenarios` → `scripts/run-scenarios.js` → бинарь движка
`vimp-sim.js`). Правила проекта: **сценарии не проверяют игровых правил**,
они ловят молчаливые расхождения предсказания и падения ядра. Утверждения
о правилах живут в `core/tests/sim.rs`.

Существующие, которые обязаны продолжать проходить без правки:
`fall.json`, `bridge.json`, `crosslevel.json`, `terraces_climb.json`,
`terraces_backside.json`, `terraces_crate.json`, `bots_bridge.json`.

> Если после этапа 1 они начнут падать по `divergence`, причина почти
> наверняка в разном порядке интегрирования вертикали у хоста и реплики
> (этап 1, п. 1.5а — полушаговая схема обязана быть одинаковой). Пороги в
> `divergence.thresholds` (8 чисел по `PLAYER_STATE_LEN`) поднимать
> **нельзя** — это маскировка бага.

Новый `tests/scenarios/jump.json` — по образцу `terraces_climb.json`:

```json
{
  "version": 1,
  "seed": 5511,
  "map": "terraces",
  "participants": [{ "id": "p1", "name": "P1", "model": "m1" }],
  "timeline": [
    { "tick": 0, "op": "join", "who": "p1", "team": "team1" },
    { "tick": 20, "op": "key", "who": "p1", "action": "down", "name": "forward" },
    { "tick": 400, "op": "key", "who": "p1", "action": "up", "name": "forward" }
  ],
  "unusedSnapshotKeys": ["w1", "w2", "w2e", "c2"],
  "divergence": { "thresholds": [3, 3, 0.06, 25, 25, 1.5, 0.15, 0.06] },
  "ticks": 700,
  "dumpTicks": [120, 240, 400, 700]
}
```

Первый респаун `team1` на `terraces` — подножие крутого прогона `0 → 2`
носом на запад (`src/data/maps/terraces.js`, `respawns.team1`), то есть
полный газ вперёд даёт разгон, подъём и вылет с верхнего торца. Сценарий
проверяет только отсутствие расхождения и паники — этого достаточно.

## 6.2. Документация (обязательна, en + ru в одном изменении)

Правило репозитория: любое функциональное изменение правит парные страницы
`docs/en/` и `docs/ru/` в том же изменении (`CLAUDE.md`).

### `docs/*/gameplay.md` — раздел «Мосты и уровни (2.5D)» / «Bridges and levels (2.5D)»

Три пункта переписываются полностью:

- **«Подъём и спуск видно» / «A climb is visible»**
  (`docs/ru/gameplay.md:136`, `docs/en/gameplay.md:139`). Сейчас там прямо
  сказано: *«Корпус больше не наклоняется, и пыль из-под гусениц не идёт:
  уклон, восстановленный из высоты между кадрами, замирал у стоящего
  танка»*. Это утверждение становится **неверным** и обязано быть
  заменено: наклон вернулся, но считает его хост из `slope_vec` и везёт в
  кадре (`pitch`/`roll`), поэтому у стоящего на рампе танка он не замирает,
  а у чужих танков он есть наравне со своим. Историю («была схема по
  разнице высот, она сломалась») стоит сохранить одной фразой — она
  объясняет, почему поле в кадре, а не вычисление на клиенте.
- **«Падение с обрыва» / «Off the ledge»** (`docs/ru/gameplay.md:165`,
  `docs/en/gameplay.md:171`). Обновить: падение стало параболическим,
  время с одного уровня прежнее (`fallTime`), с двух — быстрее, чем
  вдвое; урон считается от **вершины дуги**; в воздухе не работает только
  движение, **башня и стрельба работают**; выше уровня отрыва танк не
  видит стен и перелетает препятствия, ниже — снова упирается в них (и
  поэтому не приземляется внутри здания).
- **Новый пункт «Прыжок с рампы» / «Off the ramp»**. Вылет с верхнего
  торца прогона на скорости бросает танк в полёт; вертикальная скорость —
  это уклон, умноженный на скорость вдоль него, и настраивается
  `rampLaunchFactor`/`minLaunchVz`. Приземление на свой же уровень урона не
  даёт. Как посмотреть: `VITE_MAP='terraces' npm run dev`, `team1`,
  первый респаун, держать `W`.

Также в разделе про стрельбу (`### Стрельба между уровнями` /
`### Shooting across levels`) отметить, что падающий танк по-прежнему
неуязвим для попаданий, но сам стрелять теперь может.

Раздел про управление/HUD — добавить строку о том, что газ теперь виден
дымом, а упор в стену — пылью из-под гусениц.

### `docs/*/configuration.md`

- `### Параметры ядра` / `### Core parameters` (`:20`) — таблица
  `coreParams.levels` пополняется семью строками:
  `rampLaunchFactor`, `minLaunchVz`, `jumpClearance`, `tiltGain`,
  `tiltAirGain`, `tiltResponse`, `tiltMax`. У каждой — единицы, дефолт,
  что происходит на нуле.
- `## src/config/snapshot.js` (`:318`) — ряд `m1` вырос до 16 полей;
  дописать `vz`, `pitch`, `roll` с типами и `interp`.
- `## src/config/sounds.js` (`:278`) — новая запись `tankLanding`.
- Раздел про `render.js` — новые объекты `tilt` и `landing`.

### `docs/*/core.md`

- `## 2.5D-уровни (core/src/level.rs)` (`:474`) — таблица `Transit`:
  `Falling` заменён на `Airborne { vz, from, to, peak }`; описать вывод
  гравитации из `fallTime`, правило маски коллизий (`jumpClearance`),
  условие вылета с рампы и то, что `step_level` теперь принимает скорость
  тела.
- `### Реплика уровня на клиенте (core/src/client/predictor.rs)` (`:590`)
  — фаза полёта больше не восстанавливается обратной функцией по высоте
  (`fall_elapsed` удалена), она приезжает полем `vz`; объяснить почему
  (одной высоте отвечают две фазы дуги).
- `## Танковое тело` (`:455`) — новые поля `pitch`/`roll` и новое место
  расчёта наклона в `Tank::update` (до раннего выхода по вводу).
- `## Тесты` (`:761`) — перечислить новые тесты.

### `docs/*/extending.md`

- `### Верхние уровни (2.5D)` (`:33`) — что автору карты нужно знать про
  прыжок: пологая рампа прыжка не даёт (порог `minLaunchVz`), крутая
  даёт; площадка за верхним торцом должна быть длиннее, иначе танк
  перелетит её.
- `## Новый звук` (`:225`) — упомянуть `tankLanding` как пример звука,
  который дёргает часть напрямую (`registerSound`), а не через
  `soundCues`.
- `## Новая клиентская сущность (part)` (`:247`) — `Dust` как свежий
  пример части, добавленной во все четыре места конфига.

### `docs/*/getting-started.md`

`## Отладочные сценарии` — добавить `jump.json` в список.

## 6.3. CHANGELOG

`CHANGELOG.md`, под `## [Unreleased]` (формат Keep a Changelog, английский):

```md
## [Unreleased]

### ⚠️ Breaking

- The `m1` snapshot row grew from 13 to 16 fields (`vz`, `pitch`, `roll`).
  A host and a client on different versions of the plugin no longer read
  the same frame.
- `LevelRules` gained seven parameters under `coreParams.levels`; a config
  written for the previous version still loads (all of them have
  defaults), but a tank now jumps off ramps where it used to roll off.
- Falling is ballistic instead of linear: a drop from two levels is now
  faster than twice a one-level drop.

### Migration

- Rebuild the core (`npm run core:build`) and republish host and client
  together — the frame layout changed.
- To restore the previous, jump-free behaviour set
  `coreParams.levels.rampLaunchFactor` to `0`; to restore the flat hull,
  set `render.js`'s `tilt.enabled` to `false`.

### Added

- Ramp jumps: leaving a ramp's top end at speed throws the tank into a
  ballistic arc; landing back on the same level deals no damage.
- Hull tilt on slopes and in flight (`pitch`/`roll`), computed by the host
  and carried in the frame.
- Landing squash, landing dust and a `tankLanding` sound.
- Exhaust smoke scaled by throttle and wheel-spin dust when the tank
  strains against a wall — both proportional to the tank's size.
- `Dust` client part.

### Changed

- The turret and firing now work while airborne; only driving is locked.
- Fall damage is measured from the arc's peak instead of the take-off
  level.

### Fixed

- Hull tilt no longer freezes under a parked tank: it is no longer
  recovered from the height delta between frames.
```

Релиз в этом репозитории ручной: если изменение выпускается, тот же
коммит переименовывает `## [Unreleased]` в `## [X.Y.Z] - YYYY-MM-DD` и
заводит пустой `## [Unreleased]` выше. Версия — минорная (`0.20.0`) при
ломающемся кадре в пределах нулевого мажора.

## 6.4. Финальная проверка

```bash
npm run core:test
npm run core:build
npx eslint .
npm test
npm run build
npm run sim:scenarios
```

Ручной прогон: `VITE_MAP='terraces' npm run dev` —

1. подъём по пологой рампе: нос задран, прыжка нет;
2. разгон по крутому прогону `0 → 2`: вылет, полёт, просадка и пыль при
   касании;
3. съезд с обрыва пешком: время и урон как раньше;
4. упор в стену на полном газу: пыль из-под гусениц, густой выхлоп,
   повышенный тон двигателя;
5. `VITE_MAP='overpass' npm run dev` — прыжок с эстакады на землю не
   заканчивается внутри стены.

## Готовность плана

Когда все шесть этапов помечены «✅ выполнен», перенести каталог
`plan/tank-dynamics/` целиком в `plan/done/tank-dynamics/` (`git mv`), не
коммитя перенос.
