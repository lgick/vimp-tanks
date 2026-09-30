# Этап 3. Отладочные сценарии: зелёный `npm run sim:scenarios` (С1–С5) ✅ выполнен

**Предусловие: этап 2 выполнен** (в `README.md` он отмечен «✅ выполнен»). Правка `boost_dv` меняет траектории на
`downtown`, единственной карте с плитами-бустерами. Это задевает `bots_downtown.json`, `downtown_bridge.json`,
`downtown_props.json` и `downtown_surfaces.json`. Если этап 2 не выполнен — остановиться и сообщить.

**Файлы:** `tests/scenarios/bots_downtown.json`, `tests/scenarios/round.json`, `tests/scenarios/downtown_props.json`,
`tests/scenarios/selfblast.json`; при необходимости `tests/scenarios/downtown_surfaces.json`, а если меняются
заявленные в docs факты — `docs/en/getting-started.md` и `docs/ru/getting-started.md` (раздел
«Debug scenarios» / «Отладочные сценарии»). `CHANGELOG.md` не трогать: это тестовые правки.

## Проблема (проверено на HEAD `d34e278`, до этапа 2)

`npm run sim:scenarios` (`scripts/run-scenarios.js`) гоняет каждый `tests/scenarios/*.json` на движковом
headless-раннере поверх собранного плагина (`dist/`, `dist/core-node/`). Сейчас падают три сценария:

```
=== bots_downtown.json ===  ❌ snapshotKeysUsed: 'w2', 'w2e' never produced a row
=== downtown_props.json === ❌ snapshotKeysUsed: 'w2e' never produced a row
=== round.json ===          ❌ snapshotKeysUsed: 'w1' never produced a row
```

Прогон стоит в CI (`.github/workflows/test.yml`: `npm run sim:scenarios -- --determinism`) и в релизе движка
(`../vimp/scripts/release/steps.js`).

Контракт `snapshotKeysUsed` (`node_modules/vimp-engine/src/devtools/invariants.js`) проверяет в **обе** стороны.
Ключ без строк, не объявленный в `unusedSnapshotKeys`, — нарушение. Ключ, объявленный там, но давший строки, —
тоже нарушение («declared unused but did produce rows»). Поэтому список выставляется только по факту прогона.

По `CLAUDE.md` debug-сценарии правил игры не проверяют, это делает `core/tests/sim.rs`. Но у каждого сценария
есть заявленная цель: таблица в `docs/en/getting-started.md`, раздел «Debug scenarios». Правка не должна молча
её выхолащивать. Разбор по сценариям:

- **С1 `bots_downtown.json`** — цель: «a player plus `/bot 7` (4 vs 4) for 60 s — no bot stuck at a prop, none
  falls out of the map». Бот кладёт бомбу только вплотную (`core/src/bots/brain.rs → wants_bomb`:
  `distance < BOMB_RANGE_SHARE (0.8) * bomb.radius (50)`, то есть ближе 40 ед.). Медленные танки за 60 с не
  сходятся так близко, поэтому нет ни `w2`, ни `w2e`. Цели сценария это не касается, ключи можно объявить.
  Покрытие `w2`/`w2e` остаётся в `combat.json`, `round.json`, `bots_bridge.json`, `bots_terraces.json`,
  `selfblast.json`.
- **С2 `downtown_props.json`** — цель: «a fence broken by a shot, another one rammed, a shot into the barrel group
  sets off the chain reaction». Хореография (удержания клавиш по тикам) рассчитана на старые `maxForwardSpeed` 260
  и `baseTurnTorqueFactor` 215. Состояние в конце прогона (900 тиков):
  - забор выстрелом ломается: p2 ломает `d14` (state 2);
  - таран не удаётся: p3 стоит в (1003.6, 138.5) с курсом −2.33 рад, ряд заборов `d15…d19` цел;
  - бочки не взрываются: p1 стоит в (183.6, 249.9) с курсом −0.04 рад, стреляет на восток вдоль y ≈ 250 мимо
    группы бочек, `d6…d9` целы, `w2e` нет. `w2e` здесь дают только взрывы бочек: бомб в сценарии нет, `w2` уже
    объявлен.

  Объявлять `w2e` неиспользуемым **нельзя**: сценарий потеряет две из трёх целей. Нужна перекалибровка.

- **С3 `round.json`** (`pool mini`, `/bot 1 team2`, игрок с 200-го тика бросает бомбы) — цель: «bots, friendly
  fire, death → round end → respawn». В тексте раздела: «the bot hunts the player by radar and hits him». Раунд
  по-прежнему кончается самоподрывом игрока (инвариант 10 проходит), но бот за 1800 тиков не выходит на
  дистанцию огня: в тике 1800 он в (422.7, 173.3), игрок в (78, 312). Проверено на копии сценария: при
  `ticks: 2400` проходят все 10 проверок, `w1` есть.
- **С4 `downtown_surfaces.json`** — цель: «…then the boost plate in front of the car-park ramp — the boosted jump
  lands on the roof». Сценарий проходит, но цель потеряна. p3 (третий `join` в `team1`) стартует с
  `spawn(9, 35)` = (121.6, 454.4), и из-за бага этапа 2 импульса не получает: в конце он в (244.7, 454.4) на
  уровне 0. После этапа 2 это надо перепроверить.
- **С5 `selfblast.json`** — цель: «…drops a bomb under himself — the blast throws him ~50 units». Бомба ставится в
  тике 1040. Дамп 1075 был подобран под старый запал 0.3 с (36 тиков): взрыв приходился на 1076. Теперь запал
  1 с (120 тиков), взрыв около тика 1160, и дампа прямо перед ним нет. Бросок измерен: между дампами 1075 и 1400
  p1 сместился с (82, 417) на (82, 388), то есть ≈29 ед., а не «~50».

Остальные сценарии на HEAD проверены, свои цели выполняют: `jump` (z 0 → 2), `terraces_climb` (0 → 2 → 0),
`overpass_jump` (на плите моста), `bridge` (0 → 1 → 0), `movement`, `combat`, `round_respawn` и другие проходят.
Этап 2 меняет только сценарии на `downtown`.

## Инструменты

**Сборка** (перед каждой серией прогонов, если менялись `core/` или `src/`):

```bash
npm run core:build     # pkg-web + pkg-node; build копирует core/pkg-node в dist/core-node
npm run build          # dist/ + manifest.json
```

Если `npm run build` падает на звуках (`copy-game-sounds.js` требует `build/sounds/`), сначала
`npm run audio:process` (нужен `ffmpeg`).

**Прогоны:**

```bash
npm run sim:scenarios 2>&1 | grep -E "^===|❌|  - |passed"                  # все, коротко
npm run sim -- --scenario tests/scenarios/round.json --no-write | sed -n '/## Invariants/,/## World/p'
npm run sim -- --scenario tests/scenarios/downtown_props.json --out <временный каталог>   # с дампами
```

С `--out <каталог>` раннер пишет `<каталог>/run-<время>/report.json` и `scene-<tick>.json` для каждого тика из
`dumpTicks`. Без `--out` отчёт пишется в `.debug/`: каталог в `.gitignore`, после работы его можно удалить.

**Сводка прогона.** Скрипт класть во временный каталог сессии, не в репозиторий. Запуск:
`node summary.mjs <каталог run-…>`.

```js
import { readFileSync } from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const read = name => JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
const report = read('report.json');
const who = Object.fromEntries(report.participants.map(p => [p.gameId, p.id]));
const f = v => (+v).toFixed(1);

for (const tick of report.sceneTicks) {
  const scene = read(`scene-${tick}.json`);
  const client = Array.isArray(scene.clients) ? scene.clients[0] : Object.values(scene.clients)[0];
  const tanks = Object.entries(client?.entities?.m1 ?? {}).map(
    ([id, r]) =>
      `${who[id] ?? id} x=${f(r[0])} y=${f(r[1])} a=${(+r[2]).toFixed(2)} ` +
      `v=${f(Math.hypot(r[4], r[5]))} z=${(+r[11]).toFixed(2)} l=${r[12]}`,
  );

  console.log(`tick ${tick}: ${tanks.join(' | ')}`);
}

const c1 = report.clients[0].entities.c1 ?? {};
const broken = Object.entries(c1)
  .filter(([, r]) => r[5])
  .map(([id, r]) => `${id}=state${r[5]}`);

console.log('props not intact at the end:', broken.join(', ') || 'none');
```

Строка `m1`: `[0] x, [1] y, [2] angle (рад, 0 — восток, ось y вниз), [3] gunRotation, [4] vx, [5] vy,
[6] engineLoad, [7] condition, [8] size, [9] team, [10] angvel, [11] z, [12] level, [13] vz, [14] pitch, [15] roll`.
Строка `c1` (тело карты `dN`, N — индекс в `physicsDynamic`): `[0] x, [1] y, [2] angle, [3] z, [4] level,
[5] state (0 цело, 1 повреждено, 2 разрушено), [6] vx, [7] vy, [8] angvel`. Участники: p1 → gameId `0`, p2 → `1`,
p3 → `2` (по порядку `join`).

## Решение

### 3.1. Сборка и исходная картина после этапа 2

`npm run core:build && npm run build`, затем `npm run sim:scenarios 2>&1 | grep -E "^===|❌|  - |passed"`.
Записать, какие сценарии падают и на каких ключах. Дальше идти по пунктам только для реально падающих, плюс 3.5 и
3.6: они проверяют цель, а не падение.

### 3.2. `bots_downtown.json` (С1)

Если сценарий по-прежнему падает на `w2`/`w2e`, заменить

```json
  "unusedSnapshotKeys": ["c2"],
```

на

```json
  "unusedSnapshotKeys": ["c2", "w2", "w2e"],
```

Объявлять ровно те ключи, что перечислены в нарушении: если после этапа 2 бомба появилась, объявлять её нельзя. Если
в прогоне появились другие нарушения (боты застряли, актёр утёк), это уже не С1. Остановиться и сообщить.

### 3.3. `round.json` (С3)

Заменить `"ticks": 1800` на `"ticks": 2400`, а `"dumpTicks": [600, 1800]` — на `"dumpTicks": [600, 1800, 2400]`
(последний дамп — в конце прогона). Перепроверить:
`npm run sim -- --scenario tests/scenarios/round.json --no-write`: 10 passed, `w1` есть. Если `w1` всё ещё нет,
пробовать 3000, затем 3600 и взять наименьшее проходящее. `unusedSnapshotKeys` (`["c1", "c2"]`) не менять. Docs
длительность `round.json` не называют, их не трогать.

### 3.4. `downtown_props.json` (С2) — перекалибровка хореографии

Цель — вернуть все три события, **не объявляя `w2e`**. Меняются только тики в `timeline` и, если надо, `ticks` и
`dumpTicks`. `seed`, `map`, участники и `unusedSnapshotKeys` (`["w2", "c2"]`) остаются.

Факты для расчёта (мир = координаты карты × `scale` 0.4; `downtown.js → physicsDynamic`, `respawns`):

- **p1** стартует с `team1[0]` = (121.6, 313.6), курс 0 (восток). Группа бочек `d6…d9` — углы в (360, 168),
  (372.8, 168), (360, 180.8), (372.8, 180.8), центр группы ≈ (372, 180). Направление от спавна на группу ≈ −0.5
  рад (на северо-восток), расстояние ≈ 280 ед. при дальности `w1` 1500. Бочка (hp 40) ломается одним попаданием
  `w1` (урон 40, `bulletFactor` 1). Взрыв бочки даёт `w2e`, соседние бочки детонируют через 0.15 с. Сейчас p1
  поворачивает `left` на тиках 20–80 (60 тиков), едет `forward` на 80–157, поворачивает `right` на 260–317 и
  стреляет на 400 и 460. В итоге курс ≈ 0 — поворотов не хватает.
- **p2** стартует с `team2[0]` = (1107.2, 313.6), курс π (запад). Забор выстрелом он ломает (`d14`) и после этапа
  2 должен ломать дальше: его тайминги трогать, только если `d14` перестал ломаться.
- **p3** стартует с `team2[1]` = (1171.2, 313.6), курс π. Ряд заборов `d15…d19` — углы в (1049.6…1152, 144.8),
  это ≈170 ед. к северу. Таран: урон `(v_n − 60) · 0.5` при hp 30 (`game.js → coreParams.props.fence`), то есть
  нужна скорость **по нормали ≥ 120** при потолке танка ≈130. Удар должен быть почти лобовым, на полном ходу.
  `right` поворачивает по часовой на экране (курс растёт): с курса π на север (3π/2 ≈ 4.71, в строке это −1.57)
  нужно ≈ +1.57 рад. Сейчас 60 тиков `right` дают ≈ +0.81 рад (итоговый курс −2.33).
- Поворот нелинейный: разгон, демпфирование `angular` 100. Поэтому длительности подбираются по дампам, а не
  пропорцией. `fire` — одиночное нажатие (`playerKeys.fire.type: 1`): одно нажатие даёт один выстрел, кулдаун
  0.3 с (36 тиков).

Порядок работы:

1. Прогнать с `--out` и сводкой, посмотреть позы в дампах.
2. **p1**: проще всего убрать участок `forward` и второй поворот. Держать `left`, пока курс не станет ≈ −0.5
   (проверять дампом на тике отпускания), потом стрелять. Если по дороге стена (выстрел упирается раньше, бочки
   целы), вернуть подъезд и подобрать его длину. Выстрелов оставить два, с интервалом больше 36 тиков.
3. **p3**: держать `right`, пока курс не станет ≈ −1.57, затем `forward` до удара. Проверять, что в конце хотя бы
   один из `d15…d19` имеет state 2, и что это таран, а не выстрел: p3 не стреляет.
4. `dumpTicks` поставить вокруг ключевых событий: конец поворота p1, выстрелы, удар p3, конец. `ticks` увеличить,
   если события сдвинулись позже 900.
5. Готово, когда: сценарий проходит (`w2e` есть, значит, бочки взорвались); в конце ≥1 бочки `d6…d9` и ≥1 забор
   `d15…d19` имеют state 2, `d14` (или другой забор ряда `d10…d14`) — тоже.

Если за разумное число итераций (≈10) таран или выстрел не выходит, **остановиться и сообщить** пользователю с
картиной дампов. Не объявлять `w2e` и не менять цель сценария молча: это решение пользователя, и тогда придётся
править таблицу в `getting-started.md`.

### 3.5. `downtown_surfaces.json` (С4) — прыжок на крышу после этапа 2

Прогнать с `--out` и сводкой. Нужно: **p3** (gameId `2`) в конце на уровне 1 (`l=1`), x в пределах плиты парковки
[307.2, 460.8) — это колонки 24..36 × 12.8. Импульс бустера виден по скорости `v` в дампе после плиты (x ≥ 256):
она заметно выше потолка 130, удержание держит до 468.

- Выполнено — ничего не менять.
- p3 не долетает — удлинить его `forward` (сейчас тики 600–760): отпускание на 800, 840… Взять наименьшее, при
  котором он приземляется на плиту. Дрейф предсказания (`divergence` с порогами) должен оставаться зелёным. Если
  дрейф срывается на прыжке, остановиться и сообщить: пороги не ослаблять (правило `getting-started.md`).

### 3.6. `selfblast.json` (С5) — дампы вокруг взрыва и бросок

1. Найти тик взрыва бомбы, поставленной в 1040. Ожидается ≈1160 (запал `w2.time` 1000 мс = 120 тиков). В
   `dumpTicks` (`[700, 940, 1075, 1400]`) заменить `1075` на тик за 1–2 шага до взрыва (≈1158) и добавить тик
   после броска, когда p1 остановился (≈1300). Проверить сводкой: в первом дампе p1 ещё на месте, дальше
   смещён.
2. Измерить бросок: расстояние между позицией p1 в дампе до взрыва и в конечном. Если оно заметно отличается от
   «~50 units» (на HEAD ≈29), исправить число в таблице `docs/en/getting-started.md` (строка `selfblast.json`:
   «the blast throws him ~50 units») и в той же строке `docs/ru/getting-started.md`.
3. `crosslevel.json` — тот же прогон без последней бомбы, его не трогать.

### 3.7. Документация

Править `docs/*/getting-started.md` (en и ru вместе) только если изменился заявленный факт: число в 3.6 или цель в
3.4 (с согласия пользователя). Смена тиков и `unusedSnapshotKeys` в docs не описывается.

## Проверка

```bash
npm run sim:scenarios 2>&1 | grep -E "^===|❌|  - |passed"    # все сценарии: 0 failed
npm run sim:scenarios -- --determinism 2>&1 | grep -E "❌|failed" # как в CI: нарушений нет
npx eslint . --quiet
npx vitest run --reporter=dot
```

Релиз движка не запускать. В итоговом отчёте сообщить пользователю, что `sim:scenarios` зелёный и
`npm run release` в `../vimp` можно повторить.

## Критерий готовности

- `npm run sim:scenarios` и `--determinism`: во всех сценариях 0 failed.
- `downtown_props.json` снова выполняет три заявленных события; `downtown_surfaces.json` — прыжок p3 на крышу.
- `round.json`: бот стреляет (`w1` есть), раунд кончается и перезапускается.
- `unusedSnapshotKeys` совпадает с фактом прогона. Docs исправлены только там, где изменился заявленный факт.
