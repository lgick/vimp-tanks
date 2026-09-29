# План: исправления по код-ревью задачи `wreck-fire` (коммит eee8752)

План самодостаточен: исполнителю не нужен контекст переписки. Перед началом прочитать `CLAUDE.md` в корне
репозитория: там правила кода, тестов, документации en/ru и CHANGELOG. Коммитов не делать, все правки остаются в
рабочем дереве. Выполненный этап пометить «✅ выполнен» в его заголовке. Когда все обязательные этапы выполнены,
перенести файл в `plan/done/` (`git mv`, без коммита).

## Контекст

Ревью охватывает задачу `plan/done/wreck-fire/` (README + этапы 1–8), коммит eee8752. Её суть: новый клиентский парт
`src/client/parts/WreckFire.js` в `gameSets.m1`. Он ловит в ряду танка переход `condition: >0 → 0` и показывает
взрыв (вспышка, огненный шар, искры, облако дыма, звук `tankExplosion`, ночная вспышка, толчок через шину `blasts`),
потом пожар около 9 с, стихание к 14 с и дым к ≈30 с. Ночью горит мерцающий свет, на земле остаётся копоть до
респауна. Помощники:
- `src/client/parts/ParticleChannel.js` — `ParticleContainer`, массив симуляции, пул и потолок;
- `src/client/wreckTimeline.js` — таймлайн (`fireIntensity`, `fireEnd`, `smokeRate`, `emissionEnd`, `smokeAlpha`);
- `src/client/colorRamp.js` — `lerpColor`, `colorRamp`.

Конфиг лежит в `src/config/render.js → wreckFx`, `lighting.flash.wreck`, `lighting.wreckFire`. `Smoke.js` больше не
дымит у остова.

**Базовая линия** (HEAD `eee8752`, проверено при ревью): целевые тесты задачи
(`WreckFire`, `ParticleChannel`, `wreckTimeline`, `colorRamp`, `wreckFx`, `client`, `Smoke`) — 66/66 зелёные;
`npx eslint` по новым файлам — чисто. По отчёту исполнителя полный `npm test` — 1095/1095, `npm run build` и
`npm run sim` (combat.json) — без ошибок.

**Итог ревью.** Задача сделана качественно. Жизненный цикл парта соответствует PixiJS 8.19, это сверено по
исходникам:
- `onRender`-аксессор, `RenderGroup.addChild`/`runOnRender` вызывает колбэк и у невидимых контейнеров;
- `Container.destroy` защищён от повторного вызова;
- `ParticleContainer.removeParticles()` без аргументов снимает все частицы.

Контракт пула соблюдён (сначала `removeParticle`, потом `release`), бюджет частиц закреплён тестом, одноразовый звук
снимается движком сам. Падений, утечек тикеров или света и порчи чужого состояния не найдено.

Найдена одна видимая ошибка (Н1): если танк погиб в полёте, копоть висит в воздухе до конца раунда. Остальное —
пробелы в тестах, дублирование и «магические числа» в спавнерах частиц, устаревшие комментарии и мелкие неточности в
документации.

### Сводка находок

| # | Важность | Критерий | Суть | Этап |
| --- | --- | --- | --- | --- |
| Н1 | **средняя** | работоспособность | Танк погиб в полёте: прыжок с рампы или срыв с моста, в ряду `vz !== 0`, `z` дробный. `_addScorch` (`WreckFire.js:290–320`) кладёт копоть сразу, в точке и на высоте гибели (`_scorchZ = this._z`). Копоть рисуется проекцией высоты `offsetPoint(..., k = z·shear)`: при `z = 0.5` пятно смещено от центра камеры на 11 % расстояния (≈30 ед. на краю экрана, 2–3 длины корпуса), «плавает» при движении камеры и живёт до респауна. Остов тем временем падает и лежит в другом месте | 1 |
| Н2 | низкая | работоспособность, стандартизация | Свет пожара получает `lightLevels(this._physLevel, this._z, false)` (`WreckFire.js:688`): флаг полёта жёстко `false`. У падающего остова дробный `z` читается как клин рампы, и свет уходит сразу в два уровня. `Tank._updateLights` (`Tank.js:704`) передаёт `this._vz !== 0`. `WreckFire` не читает `M1_VZ` | 1 |
| Т1 | низкая | тестируемость | Нет тестов на поведение, которое уже есть в коде: смена `zIndex` при смене уровня остова (`update`, стр. 122–125); точка, уровень и сила света пожара в `updateLight`; масштаб по `size` (радиус толчка, радиус света, размер копоти); `lighting.enabled === false`; погасание вспышки через `flash.duration`; проявление копоти (`fadeIn`) и умножение на `levelView.alphaFor` | 2 |
| Т2 | косметика | читаемость | `WreckFire.test.js:186` — `expect(wreckScorchTexture).toBeDefined()`: пустая проверка ради деструктуризации. `no-unused-vars` в `eslint.config.js` выключен, она не нужна | 2 |
| Д1 | низкая | DRY, поддерживаемость | `_spawnFlame`, `_spawnFireball` и `_spawnSpark` (стр. 334–445) строят литерал из 20 полей, 12–14 из них одинаковые (`age: 0`, `h: 0`, `scaleX: 0`, `scaleY: 0`, `tint: 0xffffff`, …). У искры есть поле `width`, которого нет у других видов: у объектов одного канала разная форма (для JIT) | 3 |
| Д2 | низкая | читаемость, поддерживаемость | «Магические» числа настройки прямо в спавнерах: `0.6 + 0.4 * intensity`, `wind.x * 0.5`, `randomRange(0.8, 1.2)`, `randomRange(-1, 1)`, `_hullPoint([[0, 0]], 0.8)`, `burst ? 0.8 : 1`, `burst ? 1.3 : 1`, `randomRange(0.7, 1.3)`, `randomRange(-0.3, 0.3)`, `1 - 0.5 * t` | 3 |
| Д3 | низкая | читаемость | Булев флаг `_spawnSmoke(heat, burst)`: вызов `this._spawnSmoke(1, true)` не читается без заглядывания в тело | 3 |
| Д4 | низкая | читаемость, производительность | Мёртвые поля симуляции: `tint` не читается нигде; у искры не читаются `alpha`, `grow`, `aspectX/Y`, `spin`. `_writeView` (стр. 573–580) на каждом шаге пишет в вид непроецированные `x/y/scaleX/scaleY`, и `_render` тут же их перезаписывает. Комментарий «без камеры (например, в тестах) вид остаётся мировым» вводит в заблуждение: `_render` без камеры сам пишет мировые координаты (`reproject` отдаёт `scale: 1`) | 3 |
| С1 | низкая (по желанию) | поддерживаемость, тестируемость | У копоти свой жизненный цикл (до респауна, дольше пожара), но она размазана по `WreckFire`: 8 полей `_scorch*`, `_addScorch`, `_stepScorch`, половина `_render`, особый случай в `_finish`. После этапа 1 добавятся ещё `_scorchPending` и `_scorchSettled`. Кандидат на отдельный класс | 4 |
| К1 | низкая | документированность | Устаревшие комментарии. `src/client/blastEvents.js:1–3`: шину будит только `ExplosionEffectController`, хотя теперь её будит и `WreckFire`. `src/config/render.js:241`: `blastJolt` описан как «реакция на взрыв бомбы или бочки», без гибели танка | 5 |
| К2 | низкая | документированность | В `docs/en/architecture.md:223` и `docs/ru/architecture.md:216` радиус толчка записан как `radius: wreckFx.joltRadius`, а в коде `joltRadius × size / referenceSize`, `level` — физический уровень. Строки `docs/en/architecture.md:239–240` и `docs/ru/architecture.md:239` длиннее 100 символов, хотя остальной текст перенесён на ~80 | 5 |
| К3 | косметика | документированность | `CHANGELOG.md`: фразу «the fire dies down after about 14 seconds» можно прочесть как «начинает стихать через 14 с», а на деле огонь гаснет **к** 14 с (стихание с 9 до 14 с) | 5 |
| К4 | низкая | документированность | `_render` проецирует контейнер по ТЕКУЩЕЙ высоте остова (`kHost = this._z · shear`), поэтому весь столб дыма (частицы живут до 4.2 с) скачет вместе с остовом, если того столкнут с моста. `Smoke.js` честно пишет о таком же упрощении, а `WreckFire` — нет | 5 |

### Проверено — правок не требует

- **PixiJS 8.19.** Поля `_heading`/`_sizeScale` выбраны верно. Остальные приватные поля парта (`_x`, `_width`,
  `_level`, `_renderer` …) с внутренними полями `Container` не пересекаются: сверено grep'ом по
  `node_modules/pixi.js/lib/scene/container`. `destroy` ставит `children: true` после `...options`: так поступает и
  `Smoke`, это верно.
- **Производительность.** Свои аллокации на кадр: объект `reproject` на частицу (≤144 на горящий остов), массив
  `[this._fire, this._smoke]`, два замыкания в `_tick`. Это молодое поколение сборщика, V8 справляется. Формулу
  проекции держит только `parallax.js`, и инлайнить её ради экономии нельзя — это нарушило бы правило модуля.
  `MAX_TICK_MS` дублирует встроенный потолок `Ticker` (`maxElapsedMS = 100`) и безвреден.
- **Масштабируемость.** На один остов потолок `maxFire + maxSmoke = 144` частиц, ≈4 draw call и один свет.
  Стоимость растёт линейно с числом остовов, живой танк не стоит ничего. Общий потолок горящих остовов для
  командного дезматча не нужен.
- **Безопасность.** Внешнего ввода нет: всё приходит из конфига и снапшота ядра, а `condition` — дискретный `u8`
  от сервера. Предиктор (`core/src/client/mod.rs`) `condition` не предсказывает, он берёт его из меты сервера.
- **Звук.** `releaseSound` для одноразового сэмпла даёт ему доиграть, движок сам снимает регистрацию по `'end'`
  (`vimp-engine/src/client/SoundManager.js`). Повторный вызов — no-op.
- **Копоть на воде.** Копоть кладётся и на воду. Воронка бомбы (`FunnelEffect`) ведёт себя так же, поведение
  согласовано. Если нужно иначе — это отдельная задача: сервис `surfaces` придётся выдать и `WreckFire`.
- **Вкладка в фоне.** Пока вкладка скрыта, таймлайн стоит, потому что `Ticker.shared` останавливается. Так же
  ведут себя все эффекты на тикере, это осознанно.
- **Размеры корпуса.** `size * 4` / `size * 3` повторяются в `Tank`, `Smoke`, `Dust`, `Tracks`, `tankTexture`
  и `WreckFire`. Дублирование старое, `WreckFire` лишь следует соглашению. Выносить его — отдельная задача, не
  эта.
- **CHANGELOG.** Н1/Н2 — ошибки ещё не выпущенной функции (`## [Unreleased] → Added`). **Отдельную запись
  `Fixed` не добавлять.** Тесты, рефакторинг и `docs/` в журнал не попадают (правило `CLAUDE.md`).

---

## Этап 1. Копоть и свет остова, погибшего в полёте (Н1, Н2)

**Файл:** `src/client/parts/WreckFire.js`.

**Идея.** В ряду `m1` есть `vz` (индекс `M1_VZ = 13`, `src/client/snapshotFields.js`). На земле и на склоне рампы
он ровно `0`, в полёте не `0`: так же его читают `Tank.js:704` и `Dust.js:118`. Если в момент гибели остов в
полёте, копоть откладывается и кладётся в первом ряду с `vz === 0`, то есть в точке и на высоте приземления. Свет
получает честный флаг полёта.

1.1. Импорт: добавить `M1_VZ` в список импорта из `'../snapshotFields.js'` (стр. 20–28).

1.2. `_readRow(data)` (стр. 101–114): после строки `this._physLevel = …` добавить

```js
    // полёт: 0 на земле и на склоне рампы (как Tank/Dust)
    this._vz = data[M1_VZ] || 0;
```

1.3. Конструктор: рядом с `this._scorch = null;` (стр. 85) добавить `this._scorchPending = false;` с комментарием
`// копоть ждёт приземления остова (погиб в полёте)`. Там же объявить остальные поля копоти, которые сейчас
появляются только в `_addScorch`: `_scorchX`, `_scorchY`, `_scorchZ`, `_scorchLevel` = `0`, `_scorchScale` = `1`,
`_scorchAge` и `_scorchAlpha` = `0`. Тогда у объекта одна форма, и видно, какие поля у него есть (так же
конструктор уже объявляет остальные поля).

1.4. `_addScorch()` (стр. 290–320): сразу после существующего раннего выхода
`if (!wreckFx.scorch.enabled || !asset || !this.parent) { return; }` вставить

```js
    // в полёте земли под остовом ещё нет: копоть ляжет там, где он
    // приземлится (update), а не повиснет в воздухе на высоте гибели
    if (this._vz !== 0) {
      this._scorchPending = true;
      return;
    }

    this._scorchPending = false;
```

Остальное тело не менять: оно берёт текущие `_x/_y/_z/_level`, то есть уже точку приземления. Комментарий над
методом дополнить: «копоть — сиблинг на сцене в точке гибели (погиб в полёте — в точке приземления)…».

1.5. `update(data)` (стр. 116–148): после блока `if (this._active) { … follow … }` и ДО чтения `condition` с ранним
`return` вставить

```js
    // погиб в полёте: копоть — в первом ряду на земле
    if (this._scorchPending && this._vz === 0) {
      this._addScorch();
    }
```

Если в том же ряду пришёл респаун, `_reset()` ниже снимет только что положенную копоть, это безвредно.

1.6. Тикер не должен сниматься, пока копоть не легла и не проявилась: иначе `_stepScorch` (он зовётся только из
`_tick`) не доведёт `fadeIn`. Добавить метод рядом с `_stepScorch`:

```js
  // копоть легла и проявилась (или её не будет): после _finish тикер снят,
  // и _stepScorch больше не зовётся
  _scorchSettled() {
    if (this._scorchPending) {
      return false;
    }

    return !this._scorch || this._scorchAge >= wreckFx.scorch.fadeIn;
  }
```

В условие завершения в `_tick` (стр. 532–539) добавить последним `&& this._scorchSettled()`. На практике оно истинно
задолго до ≈33 с: полёт длится доли секунды, `fadeIn` — 400 мс. Условие страхует только от вырожденного случая.

1.7. `_reset()` (стр. 787–814): рядом с блоком снятия `_scorch` добавить `this._scorchPending = false;`. Без этого
остов, погибший в полёте и сразу воскрешённый новым раундом, положил бы копоть при первом касании земли уже
живым танком.

1.8. `_stepLight(intensity)` (стр. 671–694): заменить `lightLevels(this._physLevel, this._z, false)` на
`lightLevels(this._physLevel, this._z, this._vz !== 0)` и добавить над вызовом комментарий, как в
`Tank._updateLights`: `// на рампе (vz 0) свет идёт в оба соседних уровня, в полёте — в уровень отрисовки`.

1.9. Тесты: `tests/client/parts/WreckFire.test.js`.
- Хелпер `row` (стр. 22–29): добавить параметр `vz = 0` и поставить его на индекс 13:
  `[x, y, 0, 0, 0, 0, 0, condition, size, 1, 0, z, level, vz, 0, 0]`. Существующие тесты не меняются, по
  умолчанию `vz = 0`.
- Новый `describe('WreckFire: гибель в полёте', …)`:
  1. «копоть ждёт приземления и ложится в точке касания»:
     - `const { part, stage } = ignited({ z: 0.6, vz: -2 })`;
     - ожидать `scorchesOf(stage, part)` длины 0 и `part._scorchPending === true`;
     - `part.update(row({ condition: 0, x: 130, z: 0, vz: 0 }))`;
     - ожидать одну копоть, `part._scorchPending === false`, `part._scorchX === 130`, `part._scorchZ === 0`,
       `scorchesOf(stage, part)[0].zIndex === levelZ(2, 0)`.
  2. «тикер ждёт копоть»:
     - `ignited({ z: 0.6, vz: -2 })`;
     - `run(part, emissionEnd(wreckFx.fire, wreckFx.smoke) + wreckFx.smoke.lifetime.max)`;
     - ожидать `part._tickListener !== null`;
     - `part.update(row({ condition: 0, vz: 0 }))`, затем `run(part, wreckFx.scorch.fadeIn + 100)`;
     - ожидать `part._tickListener === null`, `typeof part._onRender === 'function'` и
       `part._scorchAlpha` ≈ `wreckFx.scorch.alpha`.
  3. «респаун до приземления — копоти нет»:
     - `ignited({ z: 0.6, vz: -2 })`;
     - `part.update(row({ condition: 3, vz: 0 }))`;
     - ожидать `part._scorchPending === false` и копоти на сцене нет.
  4. «свет в полёте — только уровень отрисовки, на рампе — два уровня»:
     - `ignited({ z: 0.5, vz: -1 })`, `part._tick(100)`;
     - последний вызов `deps.lighting.updateLight` получает патч с `levels: [0]`;
     - затем `part.update(row({ condition: 0, z: 0.5, vz: 0 }))`, `part._tick(100)`;
     - ожидать `levels: [0, 1]`. Для справки: `lightLevels(0, 0.5, true) → [renderLevel(0, 0.5)] = [0]`,
       `lightLevels(0, 0.5, false) → [0, 1]`, `src/client/lighting/lightMath.js:130`.

1.10. Документация, en и ru в одном изменении. В таблице `wreckFx`, строка `scorch`:
- `docs/en/configuration.md`: «The mark on the ground at the point of death, lasting until the respawn» →
  «The mark on the ground at the point of death (a tank killed in flight — where the wreck lands), lasting until
  the respawn»;
- `docs/ru/configuration.md`: то же по-русски («…в точке гибели (погиб в полёте — там, где остов приземлился)…»).

CHANGELOG не трогать (см. «Проверено»).

## Этап 2. Пробелы в тестах `WreckFire` (Т1, Т2)

**Файл:** `tests/client/parts/WreckFire.test.js`. Код парта не меняется. Хелперы `ignited`, `onStage`, `run`,
`makeDeps`, `row` и `scorchesOf` уже есть в файле.

2.1. Т2: в тесте «без ассета копоти по окончании onRender снят» (стр. 177–189) заменить
`const { wreckScorchTexture, ...noScorch } = assets;` на
`const noScorch = { ...assets, wreckScorchTexture: undefined };` и удалить строку
`expect(wreckScorchTexture).toBeDefined();`.

2.2. Новые тесты. Каждый — отдельный `it` в подходящем `describe`.
1. «остов сменил уровень — эффект едет на его слой» (`describe('WreckFire: проекция 2.5D')`):
   - `ignited()`, затем `part.update(row({ condition: 0, z: 1, level: 1 }))`;
   - ожидать `part.zIndex === levelZ(4, 1)`.
2. «свет пожара едет за остовом, сила в пределах мерцания» (`describe('WreckFire: таймлайн')`):
   - `ignited()`, `part.update(row({ condition: 0, x: 150 }))`, `part._tick(100)`;
   - взять последний вызов `deps.lighting.updateLight`, `[handle, patch]`;
   - `expect(patch).toMatchObject({ x: 150, y: 100, z: 0, level: 0, levels: [0] })`;
   - `patch.intensity` ≥ `lighting.wreckFire.intensity * (1 - lighting.wreckFire.flicker)` и ≤
     `lighting.wreckFire.intensity`. Импортировать `lighting` из `'../../../src/config/render.js'`.
3. «размер корпуса масштабирует толчок, свет и копоть» (`describe('WreckFire: взрыв')`):
   - `ignited({ size: 6 })`, то есть `_sizeScale = 2` при `referenceSize = 3`;
   - `deps.blasts.exploded` вызван с `radius: wreckFx.joltRadius * 2`;
   - `deps.lighting.addLight` вызван с `expect.objectContaining({ radius: lighting.wreckFire.radius * 2 })`;
   - `part._scorchScale` ≈ `(wreckFx.scorch.size * 2) / 40`, где 40 — `contentSize` копоти в тестовых `assets`.
4. «ночи нет — ни вспышки, ни света» (`describe('WreckFire: выключатели')`):
   - `const deps = makeDeps(); deps.lighting.enabled = false;`, `ignited({}, deps)`, `run(part, 500)`;
   - `flash`, `addLight` и `updateLight` не вызваны;
   - `part._light === null`.
5. «вспышка гаснет через flash.duration» (`describe('WreckFire: взрыв')`):
   - сразу после `ignited()` ожидать `part._flash.visible === true`;
   - `run(part, wreckFx.flash.duration + 100)`;
   - ожидать `false`.
6. «копоть проявляется за fadeIn и видна через levelView» (`describe('WreckFire: таймлайн')`):
   - `const deps = makeDeps(); deps.levelView.alphaFor = () => 0.5;`, `ignited({}, deps)`;
   - `part._scorchAlpha === 0`;
   - `run(part, wreckFx.scorch.fadeIn)`;
   - `part._scorchAlpha` ≈ `wreckFx.scorch.alpha`;
   - `part.onRender()`;
   - `part._scorch.alpha` ≈ `wreckFx.scorch.alpha * 0.5`.

Числа брать из конфига (`wreckFx`, `lighting`), не хардкодить.

## Этап 3. Спавнеры частиц: DRY, имена для чисел, мёртвые поля (Д1–Д4)

**Файл:** `src/client/parts/WreckFire.js`. Поведение не меняется: те же распределения и формулы. Защита —
существующие тесты и тесты этапов 1–2.

3.1. Именованные константы модуля, в шапке рядом с `MAX_TICK_MS`/`TAU`, каждая с комментарием по-русски:

```js
// разброс формы клуба: растяжение по осям (доли) и скорость вращения, рад/с
const FIRE_ASPECT = { min: 0.8, max: 1.2 };
const FIRE_SPIN = 1;
const SMOKE_ASPECT = { min: 0.7, max: 1.3 };
const SMOKE_SPIN = 0.3;
// стихающий пожар мельчит языки: размер на нулевой силе — доля полного
const FLAME_MIN_SCALE = 0.6;
// языки сносит ветром вполсилы: живут меньше секунды
const FLAME_WIND_SHARE = 0.5;
// огненный шар рождается у центра корпуса с этим разбросом (доли корпуса)
const FIREBALL_SPREAD = 0.8;
// клубы облака взрыва живут короче и крупнее обычных
const BURST_LIFE_SCALE = 0.8;
const BURST_SIZE_SCALE = 1.3;
// искра к концу жизни укорачивается на эту долю
const SPARK_SHRINK = 0.5;
```

Заменить литералы:
- `0.6 + 0.4 * intensity` → `lerp(FLAME_MIN_SCALE, 1, intensity)`. Значение то же;
- `wind.x * 0.5` / `wind.y * 0.5` → `* FLAME_WIND_SHARE`;
- `randomRange(0.8, 1.2)` → `pick(FIRE_ASPECT)`;
- `randomRange(-1, 1)` → `randomRange(-FIRE_SPIN, FIRE_SPIN)`;
- `_hullPoint([[0, 0]], 0.8)` → `_hullPoint(CENTER, FIREBALL_SPREAD)`. Объявить `const CENTER = [[0, 0]];` в шапке,
  чтобы не создавать массив на каждый клуб;
- `burst ? 0.8 : 1` и `burst ? 1.3 : 1` → см. 3.3;
- `randomRange(0.7, 1.3)` → `pick(SMOKE_ASPECT)`;
- `randomRange(-0.3, 0.3)` → `randomRange(-SMOKE_SPIN, SMOKE_SPIN)`;
- в `_applyFire`, ветка искры: `1 - 0.5 * t` → `1 - SPARK_SHRINK * t`.

3.2. Общий каркас состояния частицы, функция модуля под константами:

```js
// состояние частицы: у всех видов один набор полей — одна форма объекта
// для JIT; поля, которых у вида нет, нейтральные
const particleSim = fields => ({
  kind: 'flame',
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  windX: 0,
  windY: 0,
  drag: 0,
  h: 0,
  rise: 0,
  age: 0,
  life: 1,
  size0: 0,
  width: 0,
  grow: 1,
  aspectX: 1,
  aspectY: 1,
  spin: 0,
  alpha: 1,
  scaleX: 0,
  scaleY: 0,
  ...fields,
});
```

`ParticleChannel.spawn` дописывает `view`, одинаково для всех. В `_spawnFlame`, `_spawnFireball` и `_spawnSpark`
передавать в `this._fire.spawn(particleSim({ … }))` только поля, отличные от нейтральных:
- пламя: `kind`, `x`, `y`, `vx`, `vy`, `windX`, `windY`, `rise`, `life`, `size0`, `grow`, `aspectX`, `aspectY`,
  `spin`, `alpha`;
- огненный шар: то же плюс `drag`;
- искра: `kind`, `x`, `y`, `vx`, `vy`, `drag`, `life`, `size0`, `width`.

Поле `tint` удалить отовсюду: оно нигде не читается, цвет пишется прямо в `view.tint`.

3.3. Дым, Д3: `_spawnSmoke(heat, burst)` разделить на два тонких метода над общим `_emitSmoke`:
- `_emitSmoke({ heat, speed, lifeScale, sizeScale, alpha })`. Перенести сюда тело нынешнего `_spawnSmoke`, заменив
  ветвления по `burst` на параметры:
  - `speed` — сырая скорость из конфига, на `this._sizeScale` она умножается внутри `_emitSmoke`, как сейчас;
  - `life: pick(smoke.lifetime) * lifeScale`;
  - `size0: pick(smoke.size) * this._sizeScale * sizeScale * this._smokeUnit`;
  - `alpha` — как передан.

  Состояние собирать через `particleSim({ kind: 'smoke', … })`, без поля `tint`. Локальная `tint` остаётся и
  пишется в `p.view.tint`, как сейчас;
- `_spawnSmoke(heat)` → `this._emitSmoke({ heat, speed: randomRange(0, smoke.speed),
  lifeScale: 1, sizeScale: 1, alpha: lerp(smoke.tailAlpha, smoke.alpha, heat) })`;
- `_spawnBurstSmoke()` → `this._emitSmoke({ heat: 1, speed: pick(smoke.burst.speed),
  lifeScale: BURST_LIFE_SCALE, sizeScale: BURST_SIZE_SCALE, alpha: smoke.burst.alpha })`;
- вызовы: в `_explode` — `this._spawnBurstSmoke()`, в `_tick` — `this._spawnSmoke(intensity)`.

3.4. Д4, `_writeView`. Удалить метод `_writeView` (стр. 571–580) и его вызовы в конце `_applyFire` и
`_applySmoke`. Единственный писатель `view.x/y/scaleX/scaleY` — `_render`. Он зовётся как `onRender` перед каждым
кадром, пока `_active`: `onRender` назначается в `_ignite`, снимается только в `_finish`/`_reset`. Без камеры он
пишет мировые координаты, потому что `reproject` без камеры отдаёт `{ x, y, scale: 1 }`. `view.rotation`, `tint`
и `alpha` по-прежнему пишутся в `_applyFire`/`_applySmoke`: от проекции они не зависят. Над циклом по частицам в
`_render` добавить комментарий: «единственное место, где пишутся позиция и масштаб вида частицы».

**Проверить** до и после: тест «частица на высоте уезжает от центра камеры» вызывает `onRender`, значит не
сломается. `grep -n "p.view.x\|view.scaleX" tests/client/parts/WreckFire.test.js`: ни один тест не должен читать
позицию вида без `onRender()`. Если такой найдётся, добавить `part.onRender()` перед проверкой.

## Этап 4 (по желанию, рекомендуется). Копоть — отдельный класс `WreckScorch` (С1)

Делать после этапов 1–3. Если этап откладывается, план считается выполненным без него, отметить это в заголовке.

4.1. Новый файл `src/client/parts/WreckScorch.js`. Это не парт: в `parts/index.js` его не регистрировать, как и
`ParticleChannel`/`ParticlePool`. Класс владеет спрайтом копоти, его проекцией, проявлением и уничтожением:

```js
import { Sprite } from 'pixi.js';
import { clamp } from 'vimp-engine/lib/math.js';
import { levelZ } from '../levelZ.js';
import { offsetPoint } from '../parallax.js';
import { parallax as parallaxConfig, wreckFx } from '../../config/render.js';

// как воронка (FunnelEffect): над следами (1), под танком (3)
const SCORCH_BASE_Z = 2;
const TAU = Math.PI * 2;

// Копоть остова: спрайт-сиблинг на сцене (мимо GameView.add, как
// ExplosionEffectController.run) в точке гибели; живёт до респауна.
// Владелец — WreckFire: шагает (step), проецирует (render), снимает (destroy)
export default class WreckScorch {
  constructor(stage, asset, { x, y, z, level, sizeScale }) { … }
  // проявилась полностью
  get settled() { … }
  step(dt) { … }            // бывший WreckFire._stepScorch
  render(camera, levelView) { … } // бывшая «копоть»-часть WreckFire._render
  destroy() { … }           // sprite.destroy({ texture: false, textureSource: false })
}
```

Тела перенести из `WreckFire` без изменения формул:
- конструктор = бывший `_addScorch` после проверок. Случайная текстура, поворот, `alpha = 0`, `zIndex`,
  `scale = size·sizeScale / contentSize`, `stage.addChild(sprite)`, `stage.sortChildren()`;
- `render` = блок `if (this._scorch) { … }` из `_render`.

4.2. `WreckFire`:
- поле `_scorch` теперь `WreckScorch | null`, поля `_scorchX … _scorchAlpha` и константа `SCORCH_BASE_Z` удаляются;
- `_addScorch` оставляет проверки (`enabled`, ассет, `parent`, отложенность в полёте из этапа 1) и создаёт
  `new WreckScorch(this.parent, asset, { x: this._x, y: this._y, z: this._z, level: this._level,
  sizeScale: this._sizeScale })`;
- `_stepScorch(dt)` → `this._scorch?.step(dt)`;
- в `_render` → `this._scorch?.render(camera, this._levelView)`;
- `_scorchSettled()` → `!this._scorchPending && (!this._scorch || this._scorch.settled)`;
- `_reset` → `this._scorch?.destroy(); this._scorch = null;`.

4.3. Тесты:
- новый `tests/client/parts/WreckScorch.test.js`: проявление за `fadeIn`; проекция `offsetPoint` при `z > 0`
  (сцена без трансформа — центр камеры `(400, 300)` при `renderer.screen 800×600`, как в `WreckFire.test.js`);
  `alpha`/`tint` через `levelView`; `destroy` снимает спрайт со сцены и не уничтожает текстуру;
- в `WreckFire.test.js` обновить обращения: `part._scorchX` → `part._scorch.x` (или как назван геттер),
  `part._scorch.position.x` → `part._scorch.sprite.position.x`, `part._scorchAlpha` / `part._scorchScale` → поля
  `WreckScorch`. Проверки «копоть — сиблинг на сцене» (`scorchesOf`) не меняются: на сцене по-прежнему `Sprite`.

4.4. Документация: в `docs/en/architecture.md` и `docs/ru/architecture.md`, в абзаце про системы частиц рядом с
`ParticleChannel`, одной фразой упомянуть `WreckScorch`: «копоть — `parts/WreckScorch.js`, сиблинг на сцене».

## Этап 5. Комментарии и документация (К1–К4)

5.1. `src/client/blastEvents.js:1–3`. Шапку переписать: шину будят эффект взрыва (`ExplosionEffectController` —
бомба и бочка) и гибель танка (`WreckFire` — толчок в точке остова); каждый танк сам решает, задел ли его взрыв.

5.2. `src/config/render.js:241–243`, комментарий над `blastJolt`:
- «визуальная реакция танка на взрыв бомбы или бочки» → «визуальная реакция танка на взрыв бомбы или бочки и на
  гибель танка (`WreckFire`, радиус `wreckFx.joltRadius`)».

5.3. `docs/en/architecture.md:222–225` и `docs/ru/architecture.md:215–218`. Сейчас там
`{ x, y, radius: wreckFx.joltRadius, level }`.
- en: `{ x, y, radius, level }` at the wreck, where `radius` is `wreckFx.joltRadius` scaled by `size / referenceSize`
  and `level` is the wreck's physical level;
- ru: `{ x, y, radius, level }` в точке остова, где `radius` — `wreckFx.joltRadius`, масштабированный на
  `size / referenceSize`, а `level` — физический уровень остова.

5.4. Длинные строки перенести на ~80 символов, как соседний текст, смысл не менять:
- `docs/en/architecture.md:239–240` («`WreckFire` 4 (its scorch 2), map layers from `data.layer`), so a map without
  upper levels draws exactly as before.»);
- `docs/ru/architecture.md:239`.

5.5. `CHANGELOG.md`, раздел `## [Unreleased] → ### Added`, запись про взрыв танка: «the fire dies down after about
14 seconds» → «the fire dies down and is out by about 14 seconds». Остальной текст записи не трогать.

5.6. К4: `src/client/parts/WreckFire.js`, в `_render` над `const kHost = this._z * shear;` дописать к
существующему комментарию известное упрощение, по образцу `Smoke.js`:

```js
      // Известное упрощение: контейнер стоит в проекции ТЕКУЩЕЙ высоты
      // остова, поэтому уже выпущенный столб дыма едет вместе с ним — если
      // остов столкнут с моста, столб опустится на новый слой целиком.
      // Остов меняет высоту редко, а дым тогда и так тонет под плитой
```

**Markdown prettier'ом не форматировать.** Документация в репозитории им не форматируется, прогон переписал бы
таблицы целиком: это уже проверено в задаче `wreck-fire`, этап 8.

## Этап 6. Проверка

Команды — в тихом режиме (глобальные правила, раздел 3).

1. Форматирование JS: `npx prettier --write` по изменённым `.js` файлам. Список: `src/client/parts/WreckFire.js`,
   `tests/client/parts/WreckFire.test.js`, `src/client/blastEvents.js`, `src/config/render.js`; при этапе 4 ещё
   `src/client/parts/WreckScorch.js` и `tests/client/parts/WreckScorch.test.js`. Правила — `~/.prettierrc.mjs` и
   `~/.config/nvim/lua/plugins/conform.lua`.
2. `npx eslint . --quiet` — чисто.
3. `npm test -- --silent` — всё зелёное. Число тестов должно вырасти: этап 1 — +4, этап 2 — +6, этап 4 — +N.
4. `npm run build` — сборка без ошибок и предупреждений.
5. Ручная проверка в `npm run dev`:
   - (а) обычная гибель: взрыв, пожар, дым и копоть, как раньше;
   - (б) танк, убитый в прыжке с рампы или при падении с моста: копоть появляется там, где остов лёг на землю,
     а не висит в воздухе, и при движении камеры не «плывёт» относительно остова;
   - (в) ночная карта: свет пожара у падающего остова не засвечивает сразу два уровня.
6. Отметить этапы «✅ выполнен». Когда выполнены этапы 1–3, 5, 6 (и 4, если его делали), перенести файл в
   `plan/done/` через `git mv`. Коммит не делать.
