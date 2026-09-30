# Этап 4. Калибровка отброса на игровых значениях ✅ выполнен

## Цель

Подобрать `weapons.w1.impulseMagnitude` и `models.m1.hitResponse` так, чтобы на игровых значениях сдвиг был ~5 ед.
у стоящего и едущего танка, в лоб/корму и в борт, а доворот от попадания в угол — не больше 1°. Сначала красные
тесты, потом числа.

## 4.1 Красные тесты в JS-харнессе (`tests/core/core.test.js`)

Новый `describe('w1: отброс танка (hitResponse)', …)` внутри `describe.skipIf(!coreAvailable)('GameCore
(nodejs-таргет)', …)`. Хелперы (импорты `makeCore`, `stepTicks`, `frameBuffer` и функция `decode` в файле уже есть):

```js
// строка m1 танка из свежего кадра: [x, y, angle, …]
const tankRow = (core, id) => {
  core.pack_body();
  core.pack_frame(0, 1, false, 0, 0, false, undefined, -1);

  return decode(frameBuffer(core)).snapshot.m1[String(id)];
};

// разница углов, градусы, в (−180, 180]
const turnDeg = (after, before) =>
  (Math.atan2(Math.sin(after - before), Math.cos(after - before)) * 180) /
  Math.PI;

// стоящая цель (команда 2) на (x, y) с курсом angle; стрелок в (0, 0), курс 0
const standingHit = (x, y, angle) => {
  const core = makeCore();

  core.spawn_actor(1, 'm1', 1, 0, 0, 0);
  core.spawn_actor(2, 'm1', 2, x, y, angle);
  stepTicks(core, 2);

  const before = tankRow(core, 2);

  core.apply_input(1, 1, 'down', 'fire');
  stepTicks(core, 1);
  core.apply_input(1, 2, 'up', 'fire');
  stepTicks(core, 180);

  const after = tankRow(core, 2);

  return {
    shift: Math.hypot(after[0] - before[0], after[1] - before[1]),
    turn: turnDeg(after[2], before[2]),
  };
};

// едущая цель: тот же заезд с выстрелом и без; выстрел — в первом тике,
// где shouldFire(строка цели, тик) истинно
const drive = (withShot, x, y, angle, shouldFire) => {
  const core = makeCore();
  let fired = -1;

  core.spawn_actor(1, 'm1', 1, 0, 0, 0);
  core.spawn_actor(2, 'm1', 2, x, y, angle);
  stepTicks(core, 2);
  core.apply_input(2, 1, 'down', 'forward');

  for (let tick = 0; tick < 600; tick += 1) {
    if (fired < 0 && shouldFire(tankRow(core, 2), tick)) {
      fired = tick;

      if (withShot) {
        core.apply_input(1, 1, 'down', 'fire');
      }
    }

    if (withShot && fired >= 0 && tick === fired + 1) {
      core.apply_input(1, 2, 'up', 'fire');
    }

    if (fired >= 0 && tick >= fired + 180) {
      break;
    }

    stepTicks(core, 1);
  }

  return tankRow(core, 2);
};

const drivingHit = (x, y, angle, shouldFire) => {
  const free = drive(false, x, y, angle, shouldFire);
  const hit = drive(true, x, y, angle, shouldFire);

  return {
    knock: Math.hypot(hit[0] - free[0], hit[1] - free[1]),
    turn: turnDeg(hit[2], free[2]),
  };
};
```

Тесты (в скобках — исходные значения из README):

| # | Случай | Вызов | Ожидание |
| --- | --- | --- | --- |
| 1 | стоит, в лоб через центр | `standingHit(60, 0, 180)` | `shift` в [3.5, 6.5], `\|turn\|` < 0.1 (21.4) |
| 2 | стоит, в борт через центр | `standingHit(60, 0, 90)` | `shift` в [3.5, 6.5], `\|turn\|` < 0.1 (2.6) |
| 3 | стоит, в борт у кормы (плечо 5.5) | `standingHit(60, 5.5, 90)` | `\|turn\|` ≤ 1, `shift` в [3, 7] (21.2°) |
| 4 | едет к стрелку, в лоб | `drivingHit(400, 0, 180, (r, t) => t === 150)` | `knock` в [3.5, 6.5] (3.1) |
| 5 | едет от стрелка, в корму | `drivingHit(60, 0, 0, (r, t) => t === 150)` | `knock` в [3.5, 6.5] (4.4) |
| 6 | едет поперёк, в борт через центр | `drivingHit(150, -160, 90, r => r[1] >= -0.5)` | `knock` в [3, 8] (0.7) |
| 7 | едет поперёк, в борт у кормы (плечо ~4) | `drivingHit(150, -164, 90, r => r[1] >= -4.5)` | `knock` ≤ 10 (51.8) |

Комментарий над `describe`: что меряется, почему едущая цель сравнивается с заездом без выстрела, откуда допуски
(«~5 ед.» ± 1.5; у едущего в борт — плюс уход пути от доворота ≤ 1°). Прогнать (`npm run core:build`, затем
`npx vitest run tests/core/core.test.js -t 'отброс'`) — тесты 1, 2, 3, 6, 7 красные.

## 4.2 Подбор значений

Стартовые значения (оценка по физике README; Δv = J / 21600):
- `impulseMagnitude` **1750000** (Δv ≈ 81): у едущего сдвиг растёт ~квадратично — лоб ≈ 3.1·(1.75/1.5)² ≈ 4.2,
  корма ≈ 6.0;
- `idleFactor` **0.2**: стоящий в лоб ≈ 21.4·(1.75/1.5)·0.2 ≈ 5.0;
- `lateralFactor` **1.65**: стоящий в борт ≈ 2.6·(1.75/1.5)·1.65 ≈ 5.0;
- `spinFactor` **0.035**: угол ≈ 21.2°·(1.75/1.5)·0.035 ≈ 0.87°.

Порядок: сначала `impulseMagnitude` (тесты 4–5, оба в допуске), затем `idleFactor` (1), `lateralFactor` (2, 6),
`spinFactor` (3, 7). Последние три влияют линейно. Точность: множители — две значащие цифры, импульс — кратно 50000.
Для печати чисел удобен временный node-скрипт **вне репозитория** с теми же хелперами
(`import … from '<репо>/tests/core/helpers.js'`, `node --input-type=module -e …`).

## 4.3 Значения в данные

1. **`src/data/models.js`** — рядом с `lateralGrip`, с комментариями по-русски:
   ```js
   // реакция корпуса на попадание hitscan (core/src/motion.rs, hit_impulse):
   // импульс в осях корпуса, чтобы танк сдвигался ~5 ед. стоя и на ходу,
   // в лоб и в борт, и не крутился от попадания в угол
   hitResponse: {
     // боковая часть на асфальте: вбок корпус держит сцепление — без
     // множителя он почти не сдвигается (на масле и в полёте множитель
     // ослабляется сам, по сопротивлению вбок)
     lateralFactor: <число>,
     // продольная часть без клавиш хода: торможение простоя слабое, и
     // стоящий танк отлетал бы в разы дальше едущего
     idleFactor: <число>,
     // доворот от плеча точки попадания: у едущего танка доворот уводит путь
     spinFactor: <число>,
   },
   ```
2. **`src/data/weapons.js`**, `w1.impulseMagnitude` — новое значение; комментарий без истории изменений: «сила
   импульса (кг·м/с); не масштабируется дальностью (TanksSim::process_hitscan). Попадание по танку раскладывается по
   осям корпуса (models.js → hitResponse), тела карты толкаются в точке попадания».

## 4.4 Docs и журнал

- **`docs/*/configuration.md`**: `### models.js` — числа блока `hitResponse` и одна фраза, что они дают (~5 ед.,
  ≤ 1°); `### weapons.js` — в таблице «hit impulse `1500000`» → новое значение; `grep -rn 1500000 docs/` — других
  упоминаний не оставить.
- **`docs/*/gameplay.md`**, «Weapons and the tank» / «Оружие и танк», строка `w1`: фразу «A hit on a dynamic map
  body applies an impulse of `1500000`…» заменить: попадание сдвигает танк примерно на 5 ед. — стоящий или едущий, в
  лоб или в борт — и доворачивает не больше чем на градус; тело карты получает импульс `<J>` в точке попадания;
  импульс не зависит от дальности оружия.
- **`CHANGELOG.md → [Unreleased] → ### Changed`**:
  ```
  - A `w1` hit now shoves a tank about 5 units whether it stands or drives and
    whichever side it is hit on, and turns it by at most about a degree instead
    of knocking a driving tank off its course (`impulseMagnitude` <J>,
    `hitResponse` in `src/data/models.js`).
  ```

## 4.5 Проверки и сценарии

1. `npm run core:build`, `npx eslint . --quiet`, `npx vitest run --reporter=dot` (новые тесты зелёные, ничего не
   пропущено), `cargo test --workspace -q` (фикстуры не менялись — должно быть зелёным).
2. Сценарии (правило 7 README) с `--determinism`. Ожидаемо меняются траектории в `round.json`, `bots_*`,
   `downtown_props.json` (у пропов другой импульс, урон тот же).
3. **Детектор дрейфа**: `combat.json`, `crosslevel.json`, `round_respawn.json` стреляют `w1` при включённом
   `predictionDrift`. Если какой-то упал по дрейфу — по отчёту (`--out`) проверить, попал ли выстрел в танк около
   этого тика. Если да — **остановиться и спросить пользователя** (варианты: перенаправить выстрел в стену или проп,
   если цель сценария не требует попадания в танк; или разделить сценарий, как `crosslevel`/`selfblast`). Пороги не
   ослаблять.
4. Факты о сценариях в `docs/*/getting-started.md` (`round.json` — «бот попадает в игрока» и др.) сверить с дампами.
5. Ручная проверка — за пользователем: `npm run dev`, выстрел в лоб, в борт и в угол стоящего и едущего танка бота;
   прыжок с бустера на крышу парковки под огнём.

Отметить этап «✅ выполнен» в этом файле и в `README.md`.
