# План: объём танка

После исправления наклона на рампе (этап 9 `night-city-fixes`) стало заметно, что танк плоский. Причины:

- текстура корпуса (`src/client/bakers/tankTexture.js`) — вложенные серые прямоугольники, светотени нет;
- тень рисуется только в полёте (`Tank._updateShadow`): на земле танк ни от чего не отделён;
- собственную экструзию корпуса убрали намеренно (`docs/ru/configuration.md`, «Рендер 2.5D»): боковая грань
  сдвигалась на `толщина · shear · расстояние до центра экрана`, распадалась на ступени и всегда указывала на камеру;
- объём даёт только `tilt.shading` (`tiltShade`). Это скаляр на весь корпус: он работает только на наклоне.

Решение пользователя: применить все четыре приёма — постоянную тень, свет по карте нормалей, новую текстуру и
башню выше корпуса. Все правки только в `vimp-tanks`, формат кадра не меняется, ядро не трогаем.

## Статус этапов

| # | Этап | Статус |
| --- | --- | --- |
| 1 | Постоянная контактная тень | ✅ выполнен |
| 2 | Новая текстура корпуса и башни + запечённые карты нормалей | ✅ выполнен |
| 3 | Шейдер: свет по карте нормалей | ✅ выполнен |
| 4 | Башня выше корпуса (сдвиг с ограничением) | ⛔ заменён планом `plan/tank-3d/` |
| 5 | Танк ×1.5 (`size: 3`): расхождение предсказания у стены рампы | ✅ выполнен |
| 6 | Визуальная отдача при выстреле hitscan | ✅ выполнен |
| 7 | Трассер hitscan: от дула, светящийся след, вспышка у дула | ✅ выполнен |
| 8 | Визуальная реакция танка на взрыв | ✅ выполнен |

Порядок: 1 и 4 независимы. 3 зависит от 2 (нужны карты нормалей). На каждом этапе действуют правила из
`plan/night-city-fixes.md` → «Правила на каждом этапе»: нет коммитов, парные `docs/en|ru`, CHANGELOG, тихие проверки,
обязательная ручная проверка в `npm run dev`.

Общие правила рендера:

- свет один на всю сцену — `tilt.lightDir` (северо-запад, в осях экрана), как у боковых граней зданий;
- все сдвиги «по свету» считаются в осях ЭКРАНА, а не корпуса: контейнер `Tank` повёрнут на курс. Перевод
  «экранный вектор → локальные оси» — поворот на `−rotation`, как `screenUp` в `tilt.js`.

---

## Этап 1. Постоянная контактная тень ✅ выполнен

Сейчас тени на земле нет специально: без смещения она ложилась ровно под корпусом и читалась серым ореолом. Со
смещением от света ореола не будет — тень выглядывает с одной стороны (юго-восток), как у зданий.

### Шаги

1. `src/config/render.js → shadow`: добавить `groundOffset` (сдвиг тени от света на опоре, мировые единицы, ≈3) и
   `groundAlpha` (≈0.3); `0` в `groundOffset` возвращает прежнее поведение (тень только в полёте).
2. `Tank._updateShadow`: условие видимости — живой танк (`condition !== 0`) на земле тоже. Позиция — прежняя
   проекция опоры плюс `−normalize(lightDir) · groundOffset` (сдвиг по экрану, не поворачивается с танком). В полёте —
   та же формула с прежними масштабом/прозрачностью; на земле прозрачность `groundAlpha`. zIndex не меняется.
3. Тесты `tests/client/parts/Tank.test.js`: тень видна у стоящего танка и смещена против `lightDir` при курсах 0 и π;
   при `groundOffset = 0` на земле скрыта; тень остова не рисуется; в полёте — прежние проверки.
4. Документация: `configuration.md` (en/ru), таблица `shadow` — фраза «тень рисуется ТОЛЬКО в полёте» меняется.
   CHANGELOG `### Changed`: «Tanks cast a soft ground shadow away from the light, not only in flight».
5. Ручная проверка: тень на плите 0 и 1, на рампе, в прыжке; ночью (`downtown`) под оверлеем освещения.

### Ход выполнения

- `render.js → shadow`: `groundOffset: 3`, `groundAlpha: 0.3`. `Tank._updateShadow`: тень видна у живого танка и на
  земле (при `groundOffset > 0`), сдвиг — экспортируемая `shadowOffset()` (`−lightDir · groundOffset`, оси экрана), в
  полёте прежние масштаб/прозрачность.
- Тесты `Tank.test.js`: прежние проверки позиции тени считают точку опоры без сдвига (`shadowX/shadowY`); тест «у
  стоящего танка тени нет» заменён проверками сдвига при курсах 0 и π, `groundOffset = 0`, остова и приземления.
- Документация: `configuration.md`, `architecture.md`, `gameplay.md` (en/ru); CHANGELOG `### Changed`.
- `npx eslint .`, `npm test` (618), `npx vimp-contract` — зелёные.
- Ручная проверка — пользователь перешёл к этапу 2.

## Этап 2. Новая текстура + карты нормалей ✅ выполнен

### Шаги

1. `tankTexture.js`: переработать корпус (40×30, нос `+x`): две гусеницы по бортам `±y` (тёмные полосы с поперечными
   траками), палуба между ними, кормовая решётка, лёгкое симметричное затенение по краям. Эта светотень не зависит от
   направления, поэтому не ломается при повороте. Башня: восьмигранник с фаской, люк, ствол с дульным тормозом. Цвет
   команды — там же, где сейчас (башня). Остов (`destroyed`) — только добавить карту нормалей, рисунок не менять.
2. Для каждой текстуры (`body`, `gun`, `destroyed`) запечь парную **карту нормалей** из той же геометрии: плоский верх
   `(128,128,255)`, фаски — цвет нормали своей стороны, ствол — два ската цилиндра. Карта нормалей рисуется той же
   `Graphics`-геометрией, чтобы кадр (`frame`) и якорь совпадали пиксель в пиксель. Отдаётся как
   `textures.liveTeamId1.bodyNormal` и т.п.
3. Тест `tests/client/bakers/tankTexture.test.js` (по образцу `tankShadowTexture.test.js`): размеры и якорь карты
   нормалей совпадают с цветной текстурой; якорь пушки не изменился.
4. CHANGELOG `### Changed`: «New tank art: tracks, deck and turret details». Документация — `extending.md`, если там
   описана текстура танка (проверить `grep`).

### Ход выполнения

- `tankTexture.js`: корпус 40×30 — гусеницы с траками, палуба с рамкой фаски (`bevelFrame`, лобовой лист у `+x`
  пологий), решётка в корме; башня — восьмигранник с кольцом фаски (`bevelRing`), люк, ствол, дульный тормоз. Светотень
  цветной текстуры симметрична. Карты нормалей `bodyNormal`, `gunNormal`, `destroyedNormal` (у остова плоская)
  запекаются в кадр цветной текстуры; экспорт `normalColor`, `FLAT_NORMAL`. Кромка обводки в карте нормалей — плоская
  подложка той же обводкой.
- Для этапа 3: на антиалиасинговой кромке альфа карты нормалей частичная — шейдер должен брать альфу из цветной
  текстуры и делить нормаль на свою альфу (премультипликация) либо падать в плоскую нормаль при малой альфе.
- Тест `tests/client/bakers/tankTexture.test.js` (моки Pixi): габарит корпуса, общие кадры, якорь пушки, плоский
  остов, направления фасок, кодирование `normalColor`.
- Документация: `tankTexture` в `docs/` не описан — не тронута. CHANGELOG `### Changed`.
- `npx eslint .`, `npm test` (625), `npm run build` — зелёные.
- Ручная проверка нового рисунка — пройдена.

## Этап 3. Свет по карте нормалей ✅ выполнен

### Модель

Цвет пикселя = `texel · (ambient + diffuse · dot(n, L)) / (ambient + diffuse · L.z)`, где `L = normalize(lightDir.x,
lightDir.y, lightZ)`. Нормировка делает плоский ровный верх ровно прежним (множитель 1): карта, на которой танк стоит
ровно, выглядит как раньше, а фаски к свету светлеют, от света темнеют. Нормаль `n` из карты:

1. наклоняется по `pitch`/`roll` в локальных осях корпуса: нос `+u` вверх — нормаль к `−u`, борт `+v` вверх — к `−v`
   (те же оси, что `tiltCorners`/`tiltShade` после этапа 9);
2. поворачивается на курс (`rotation`, у пушки ещё и `gunRotation`) в оси экрана.

Этим шейдер заменяет `tiltShade` для корпуса. `tiltShade` остаётся запасным путём при выключенном шейдере.

### Шаги

1. Разведка (загрузить skill `pixijs-custom-rendering`): как в Pixi 8 своему `Shader` на `Mesh`/`PerspectiveMesh`
   получить `localUniforms` (`uTransformMatrix`, `uColor` — тинт уровня и `alpha`) и глобальные uniforms; какой рендерер
   создаёт движок (нужен ли WGSL рядом с GLSL). Результат записать сюда до начала кода.
2. `src/client/tankLight.js`: фабрика шейдера (GLSL, при необходимости WGSL) с uniforms `uNormal` (текстура),
   `uHeading`, `uPitch`, `uRoll`, `uLightDir`, `uAmbient`, `uDiffuse`; чистая функция `tankLightUniforms(...)`,
   считающая значения uniforms без PixiJS, — её и тестировать.
3. `Tank`: у трёх мешей — свой шейдер (свой набор uniforms на меш), обновление uniforms в `_updateView` раз за
   кадр. Меши становятся небатчеными (3 draw call на танк) — это приемлемо. Тинт уровня и `alpha` приходят через
   `uColor` как раньше; при включённом шейдере `scaleTint(tiltShade)` не применяется.
   Риск из `extrusion.js` (`GlMeshAdaptor` ломается на уничтожении текстуры) нас не касается: шейдер свой, но
   `destroy` танка уничтожает только шейдер, не текстуры.
4. Конфиг `src/config/render.js`: `tankLight = { enabled, ambient, diffuse, lightZ }`, `lightDir` берётся из `tilt`.
   `enabled: false` — прежний батченый меш и `tiltShade`.
5. Тесты: `tests/client/tankLight.test.js` — ровный танк даёт множитель 1 на плоском пикселе; фаска к свету > 1, от
   света < 1; поворот на π меняет их местами; знаки `pitch`/`roll` сходятся с `tiltShade`. В `Tank.test.js` —
   шейдер создаётся при `enabled`, иначе прежний путь.
6. Документация `configuration.md` (en/ru, «Рендер 2.5D»: новая таблица `tankLight`, абзац «Объём танку даёт только
   `shading`» переписать); `architecture.md`, если там описан рендер `Tank`. CHANGELOG `### Added`.
7. Ручная проверка: курсы 0/90/180/270 — освещённая сторона всегда северо-запад; рампа; ночь; see-through (альфа);
   FPS при 10+ танках.

### Ход выполнения

- П. 1 (разведка): движок создаёт `Application` без `preference` → WebGL, достаточно GLSL. `GlMeshAdaptor` для меша со
  своим шейдером ставит `groups[100]` (глобальные: `uProjectionMatrix`, `uWorldTransformMatrix`, `uWorldColorAlpha`,
  `uResolution`) и `groups[101]` (`uTransformMatrix`, `uColor` — тинт и альфа, премультиплицированы, `uRound`).
  Нестатичные `UniformGroup` синхронизируются при каждой привязке. `Mesh.destroy` свой шейдер не уничтожает.
- `src/client/tankLight.js`: GLSL ES 3.0, `tankLightUniforms`, JS-зеркало `tankLightFactor`, `createTankLightShader`,
  `setTankLightTextures`, `applyTankLight`. Нормаль премультиплицирована — делится на альфу, пустота плоская.
- `Tank`: `_setTexture` (шейдер при наличии карты нормалей и `enabled`), `_applyLight` раз за кадр, `tiltShade` не
  кладётся при свете, `destroy` уничтожает шейдеры. Конфиг `tankLight = { enabled, ambient 0.55, diffuse 0.6, lightZ 1 }`.
- Тесты: `tests/client/tankLight.test.js` (9), блок «свет по карте нормалей» в `Tank.test.js` (6).
- Документация: `configuration.md` (таблица `tankLight`, абзац об объёме), `architecture.md` (батчинг); CHANGELOG
  `### Added`.
- `npx eslint .`, `npm test` (640), `npm run build` — зелёные.
- П. 7 — ручная проверка пройдена пользователем.

## Этап 4. Башня выше корпуса — ⛔ заменён 3D-моделью (`plan/tank-3d/`)

### Модель

Башня (меш `gun`) поднята на `turret.height` уровней над корпусом, и сдвиг считается той же проекцией:
`offsetPoint(..., (z + height)·shear) − offsetPoint(..., z·shear)`. Длина сдвига ограничена `turret.maxOffsetPx`
экранными пикселями. Именно поэтому башня не повторяет судьбу старой экструзии корпуса: она не отъезжает на краю
экрана, и ступеней нет — это одна плоскость, а не срезы. Масштаб башни — `1 + height·shear`.

### Шаги

1. `src/config/render.js`: `turret = { height, maxOffsetPx }` (`height: 0` — выключено).
2. `Tank`: в `_updateView` посчитать экранный сдвиг, ограничить длину, перевести в локальные оси (поворот на
   `−rotation`, учесть `size`) и выставить `gun.position`; масштаб башни добавить в `_setCorners` для `gun`.
   Остов не трогать (у него башня нарисована в текстуре).
3. Тесты `Tank.test.js`: в центре экрана сдвига нет; на краю сдвиг направлен от камеры и не длиннее `maxOffsetPx`;
   при курсе π направление на экране то же; `height: 0` — `gun.position` нулевая.
4. Документация `configuration.md` (en/ru): таблица `turret` и уточнение абзаца об отказе от экструзии корпуса.
   CHANGELOG `### Added`.
5. Ручная проверка: чужие танки на краю экрана — сдвиг башни небольшой и без ступеней; наклон на рампе вместе с
   поднятой башней.

## Этап 5. Танк ×1.5 и расхождение предсказания (ядро) ✅ выполнен

Пользователь попросил танк крупнее. `m1.size` 2 → 3 (`src/data/models.js`, поле `u8` в кадре, поэтому только целые:
3 = ×1.5). Уже сделано: смена размера, интеграционные тесты `tests/core/core.test.js`/`clientCore.test.js` берут
размер из `models.js`, `configuration.md` (размер модели), CHANGELOG `### Changed`. `core:test`, `npm test`,
`vimp-contract` — зелёные.

### Проблема

`npm run sim:scenarios` → `terraces_backside.json` падает на `predictionDrift` (с `size: 2` — проходит):

```
sock-p1: serverTime …1400, source 'state': #4 Δ157.9 > 25 (predicted 145.0, authoritative -12.9), replayed 0 input(s)
sock-p2: serverTime …3200, source 'state': #3 Δ82.4 > 25 (predicted 73.4, authoritative -9.1), replayed 0 input(s)
```

Танк въезжает в верхний торец `rampSide` (подняться нельзя, `team2`-спавны `terraces`). Хост гасит скорость (удар), реплика
(`Predictor`, `core/src/client/predictor.rs`) едет дальше. В игре это рывок при каждом таком ударе.

### Гипотезы (проверить по порядку, записать сюда фактическую причину до правки)

- **H1.** Разный набор статических препятствий: хост сталкивает корпус с коллайдером, которого нет в сетке стен реплики
  (`resolve_world` ≈1320, `wall_grid`/`clear_walls`), а малый корпус до него не доставал.
- **H2.** Разный габарит: реплика берёт размер из `motion::body_size(model)` (`set_model`), но где-то (`footprint` ≈1285,
  `LevelState`, края уровня в `core/src/level.rs`) остался габарит, не зависящий от `size`, или константа под `size: 2`.
- **H3.** Разный порядок/условие блокировки торца `rampSide` у хоста (`Tank::update`, `core/src/tank.rs`) и реплики
  (`step_inner`): у крупного корпуса другой момент касания края прогона.

### Фактическая причина (шаг 1)

Ни одна из H1–H3. Воспроизведено в `mod parity` (терраса, спавн `team2[0]` с уровнем 0, газ): хост и реплика
идут бит в бит до шага удара в страж верхнего торца `(313.6, 396.8)`, дальше:

| шаг | хост `vy`, `vx`, `ω` | реплика `vy`, `vx`, `ω` |
| --- | --- | --- |
| удар, `size: 3` | −7.24, 0, 0 | 27.25, 2.54, 0.226 |
| удар, `size: 2` | 34.11, 0, 0 | 120.79, 0.96, 0.107 |
| лобовой удар в обычную стену (`long_wall_map`, `size: 2`) | −6.28, 0, 0 | 43.31, −1.57, −0.219 |

- Ошибка общая для любого лобового удара и не зависит от размера: с `size: 2` сценарий проходил только из-за фазы
  снапшотов (30 Гц против шага 120 Гц). Боковые стражи ни при чём — без них у реплики результат тот же.
- Хост (Rapier): скорости решаются со спекулятивной добавкой «зазор/шаг», позиция интегрируется, затем проход
  без добавки ставит итоговую скорость = отскок `−e·v` (e = 0.05, 0.05 · 144.6 = 7.23).
- Реплика: `apply_contact_impulse` из `vimp-engine-core` 0.21.0 (`client/rigid_body.rs`) делает только проход с
  добавкой: скорость остаётся ≈ «зазор/шаг», отскок считается от остатка. Две точки манифольда решаются по очереди,
  4 итерации не сходятся — отсюда ложные `vx` и `ω`.
- Решатель живёт в движке, а не в этом репозитории.

**Прототип (откачен, в дереве ничего не осталось).** В `resolve_world`: в каждой итерации сначала нормали всех точек,
потом трение, как у Rapier. После прохода с добавкой — проход без неё, только для контактов, получивших импульс;
позиция едет со скоростью первого прохода, итоговая скорость — из второго.
- Лобовой удар (`long_wall_map`): скорость совпала с хостом бит в бит (−6.28, −6.11, −5.95), `ω` = 0, остаток
  `vx` 0.30, позиция −0.05. `terraces_backside` — зелёный, `cargo test` — зелёный.
- Но сломались `jump` и `downtown_bridge`: реплика встаёт на полном ходу в проёме стены (терраса, x ≈ 192). Причина
  вторая: `obb_manifold` (`client/collision.rs`) для РАЗВЕДЁННОЙ пары, чьи грани не перекрываются по касательной
  (угол к углу), подставляет «смешанную» точку `obb_vs_obb_within` — ложный контакт с нормалью по x и точкой в
  середине лба. У хоста (parry клипует грани и при пустом пересечении контакта не даёт) его нет. Раньше он лишь
  срезал скорость на шаг (−1 юнит/с), с проходом отскока он даёт полную остановку.

### Исправление в движке ✅ выполнено (vimp-engine-core 0.22.0 + 0.22.1, опубликованы)

План движка: `~/Sites/my/vimp/plan/done/replica-contact-parity/` (README, `stage_1.md`, `stage_2.md`).

- `obb_manifold`: разведённая пара без перекрытия граней (угол к углу) контакта не даёт, как parry (`### Fixed`).
- `rigid_body::step_bodies` — порт TGS-решателя Rapier: 4 подшага, проход без смещения, блок 2×2 пары точек одного
  манифольда, память контактов между шагами (`ContactCache`: warmstart, `is_new`), одно демпфирование на `dt`.
  Строки — только через `ContactRow::from_manifold` (берёт `Manifold::solver_points()` — середины между
  поверхностями, ключ точки — номер вершины падающей грани). `ContactKey` — из устойчивых имён тел пары.
  Старые `apply_contact_impulse` / `separate_bodies` / `integrate` не менялись.
- Приёмка в движке: 7 режимов зазора и косой удар совпадают с Rapier. Временная проверка на игре (откачена):
  `core:test` зелёный, 18/18 сценариев зелёные, включая `terraces_backside`, `jump`, `downtown_bridge`; время
  прогона прежнее.

### Шаги (переход игры на новый решатель)

1. **Версия движка.** `core/Cargo.toml`: `vimp-engine-core = "0.22.1"`, `cargo update -p vimp-engine-core`
   (Cargo.lock). Без `[patch.crates-io]`. `npm run core:test` — зелёный на старом пути (новое API ещё не вызвано).
2. **Тесты паритета до правки** (`mod parity`, `predictor.rs`) — падают на текущем решателе:
   - лобовой удар в `long_wall_map` (поза `x 345.6, y 389.0, angle π/2, vy 140`) — `expect_scenario_thresholds` на
     шагах 1…6;
   - терраса `size: 3`, спавн `team2[0]` на уровне 0 (шаг, шаг, `set_actor_level(1, 0)`, шаг, шаг), газ — у стража
     торца рампы `(313.6, 396.8)`; реплика сеется `adopt_level`;
   - проём западной стены террасы (спавн `team1[0]`, газ, x ≈ 192) — реплика не встаёт.
   Для конфига с `size: 3` — помощник в `mod tests` рядом с `config_json` (сейчас в нём `size: 2`, как в
   `core/tests/sim.rs`).
3. **`Predictor::resolve_world` → `step_bodies`.**
   - Контакты стен, стражей и тел — через `ContactRow::from_manifold` (две точки манифольда подряд). Ключи:
     свой танк — фиксированное имя; блок стены — уровень + индекс в `levels.static_blocks(level)` (найти по центру
     блока из `BlockContact`); страж рампы — индекс в `self.guards` со своим префиксом; предсказанные тела подсистем —
     устойчивый строковый id тела (хэш в `u32`), НЕ порядковый номер в шаге (он сдвигается, когда тело входит или
     выходит из предсказания).
   - `separate_bodies` и цикл `SOLVER_ITERATIONS` × `apply_contact_impulse` убираются; `step_bodies` сам интегрирует
     позиции и демпфирует. `Predictor::integrate` для своего танка не зовётся, и ОДНА ветка на всех шагах: без
     контактов — `step_bodies` с пустыми строками (иначе скачок линеаризации поворота на границе). Тела подсистем —
     их итог берётся из `step_bodies`, если `integrate_predicted` равен `rigid_body::integrate`; если нет —
     остановиться и спросить.
   - `ContactCache` — поле предиктора; снимок кэша на каждый шаг хранится отдельной очередью рядом с историей
     уровня (`push_level_snapshot` / `rewind_level_state`, тип старой очереди не менять — на него есть литерал в
     тестах). Реплей начинается с кэша на момент авторитетного кадра; `reset`, респаун, смена карты — `clear()`.
   - Справка: дифф временной проверки из сессии движка — `vimp-tanks-step-bodies-check.diff` (259 строк), если он
     сохранился в её scratchpad.
4. **Звук:** `src/config/sounds.js` `innerRadius: 5` → `7.5` (полудиагональ корпуса 12 × 9), оба абзаца
   `docs/en|ru/configuration.md` (раздел звука).
5. **Документация и журнал:** `docs/en|ru/core.md` — реплика решает контакты `step_bodies` (кэш в истории реплея,
   ключи тел); CHANGELOG `### Fixed` — рывок предсказания при лобовом ударе в стену/страж рампы, `### Changed` —
   движок 0.22.1.
6. **Проверки:** `npm run core:test`, `npm run core:build`, `npx eslint .`, `npm test -- --silent`, `npm run build`,
   `npx vimp-contract`, `npm run sim:scenarios` — все 18 сценариев зелёные.
7. **Ручная проверка** (`npm run dev`): удары о стены и торцы рамп на `terraces` и `downtown` без рывка; проезд
   проёмов и узких проездов танком 12 × 9; толкание ящиков; столкновение с чужим танком.

### Ход выполнения

- П. 1: `vimp-engine-core = "0.22.1"`, `Cargo.lock` (корень workspace); `core:test` зелёный на старом пути.
- П. 2: в `mod parity` — `head_on_wall_hit_matches_the_host`, `ramp_end_guard_hit_matches_the_host` (`size` 2 и 3),
  `a_doorway_is_passed_without_a_phantom_contact`; помощники `sized_config`, `terraces_drive`, `scenario_drift`.
  До правки два первых падали (`vy` 43.3 против −6.3; 120.8 против 34.1), третий — страж правки движка.
- П. 3: `resolve_world` → `step_bodies` (строки `ContactRow::from_manifold`, имена `NAME_TANK` / `block_name` /
  `NAME_GUARD` / `body_name` — FNV от подсистемы и id тела). Одна ветка на все шаги (заморозка и шаг без карты —
  тоже `step_bodies`). `Predictor::integrate`, `push_manifold`, `pair_mut`, `SOLVER_ITERATIONS` удалены. Подсистемам —
  `PredictedBodies::after_solved_step` (у `MapDynamics` — падение с плиты) и `predicted_named_mut`.
  `ContactCache` + `contact_history` (`push_contact_snapshot` / `rewind_contacts`), чистятся в `reset` и `set_map`.
  Тесты `contact_memory_rewinds_with_the_frame`, `reset_forgets_contact_memory`.
- П. 4: `innerRadius` 7.5, `configuration.md` (en/ru).
- П. 5: `core.md` (en/ru) — шаг тел и память контактов; CHANGELOG `### Fixed`, запись о размере танка, Migration
  → `vimp-engine-core 0.22.1`.
- П. 6: `core:test` (393 + 88), `core:build`, `eslint`, `npm test` (749), `build`, `vimp-contract` — зелёные;
  `sim:scenarios` — 18 из 18 зелёные, включая `terraces_backside`.
- П. 7 — ручная проверка пройдена пользователем.

## Этап 6. Визуальная отдача при выстреле hitscan ✅ выполнен

### Контекст

После выстрела `w1` (hitscan) танк никак не реагирует — видны только трассер, вспышка и тряска камеры. Нужна отдача.
Решение пользователя: **только визуальная** — физика, ядро и предсказание не меняются, формат кадра тот же.

Что уже есть:
- у каждой строки трассера есть id стрелка `W1_SHOOTER_ID` (`src/client/snapshotFields.js`);
- свой выстрел клиент предсказывает сразу (`core/src/client/shot.rs`, `try_fire`), а дубль от сервера отфильтровывает
  (`filter_frame_game`) → на каждый выстрел ровно один `ShotEffectController`
  (`src/client/parts/effects/shot/ShotEffectController.js`);
- `Tank` знает свой id (`context.id`, `src/client/parts/Tank.js`); анимация по времени — как у просадки приземления
  (`_landTimer`, `Ticker.shared.deltaMS` в `_updateView`);
- игровые сервисы раздаёт `hooks.services(core)` в `src/client/index.js` (+ `serviceNames`), парты получают их через
  `componentDependencies` в `src/config/client.js`.

### Модель

- **Событие.** Новый сервис `shots` — шина «танк `id` выстрелил» (экземпляр на ядро, как `levelView`):
  `subscribe(id, cb) → unsubscribe`, `fired(id)`. `ShotEffectController` в конструкторе зовёт
  `shots?.fired(data[W1_SHOOTER_ID])`; `Tank` подписывается по своему `context.id` и отписывается в `destroy`.
- **Кривая.** Чистая функция `recoilAmount(elapsed, duration, attack)` в `src/client/recoil.js`: быстрый рост до 1 за
  долю `attack`, плавный возврат к 0 (квадратичный спад). Повторный выстрел перезапускает таймер, пока анимация
  идёт (`fireRate` мал, амплитуда не накапливается).
- **Что двигается** (всё в осях корпуса, амплитуда × `recoilAmount`):
  1. башня со стволом откатывается назад вдоль ствола на `gunKick` (локальный сдвиг
     `(−cos g, −sin g)`, `g` — `_gunRotation`) — через позицию меша `gun`;
  2. корпус отъезжает назад вдоль ствола на `bodyKick`;
  3. корпус качается: сторона ствола приподнимается — к `pitch` добавляется `rock·cos g`, к `roll` — `rock·sin g`
     (знаки — как в `tiltCorners`: `pitch > 0` поднимает нос `+u`, `roll > 0` — борт `+v`). Эта добавка идёт и в
     `tiltCorners`, и в `tankLightUniforms`, поэтому свет на фасках качается вместе с корпусом.
  Остов отдачи не получает.
- **Конфиг** `src/config/render.js`: `recoil = { enabled, duration: 250, attack: 0.15, gunKick: 3, bodyKick: 1,
  rock: 0.08 }` (мировые единицы и радианы; `enabled: false` — как сейчас).

Сдвиг башни складывается с будущим подъёмом башни (этап 4): позиция `gun` = подъём + откат.

### Шаги

1. `src/client/recoil.js`: `recoilAmount`, `recoilOffsets({ amount, gunRotation, config })` → `{ gun: {x, y},
   body: {x, y}, pitch, roll }`.
2. Сервис `shots` в `src/client/index.js` (`createShotEvents`, модуль `src/client/shotEvents.js`), имя в
   `serviceNames`; `componentDependencies` для `Tank` и `ShotEffect` в `src/config/client.js`.
3. `ShotEffectController`: вызов `fired` в конструкторе (без сервиса — no-op).
4. `Tank`: подписка/отписка, `_recoilTimer`, в `_updateView` — шаг таймера по `Ticker.shared.deltaMS`, смещения
   мешей `body`/`gun` (позиции внутри контейнера), добавка `pitch`/`roll` в `_setCorners` и `_applyLight`. На
   `condition 0` таймер сбрасывается.
5. Тесты:
   - `tests/client/recoil.test.js`: 0 до и после, пик 1 на `attack`, монотонный спад, откат против ствола при
     `g = 0` и `g = π/2`, знаки качания;
   - `tests/client/shotEvents.test.js`: подписка, отписка, чужой id не срабатывает;
   - `Tank.test.js`: `fired(id)` сдвигает `gun` назад и гаснет за `duration`; у остова отдачи нет;
     `recoil.enabled = false` — ничего не двигается;
   - `ShotEffectController`: зовёт `shots.fired` с id стрелка.
6. Документация: `configuration.md` (en/ru, «Рендер 2.5D» — таблица `recoil`), `architecture.md` (сервис `shots`),
   CHANGELOG `#### Added`.
7. Проверки: `npx eslint .`, `npm test -- --silent`, `npm run build`, `npx vimp-contract` (C4 — имя сервиса),
   `npm run sim:scenarios` (`terraces_backside` уже падает из-за этапа 5 — остальные должны быть зелёными).
8. Ручная проверка `npm run dev`: свой и чужой выстрел (бот), башня повёрнута вбок — откат вдоль ствола и крен,
   зажатый огонь — без «дрожи», ночь (свет фасок качается), остов не дёргается.

### Критичные файлы

- `src/client/recoil.js`, `src/client/shotEvents.js` (новые)
- `src/client/parts/Tank.js`, `src/client/parts/effects/shot/ShotEffectController.js`
- `src/client/index.js`, `src/config/client.js`, `src/config/render.js`

### Ход выполнения

- `src/client/recoil.js` (`recoilAmount`, `recoilOffsets`), `src/client/shotEvents.js` (ключ id — строка: контекст
  парта и строка трассера бывают разных типов); сервис `shots` в `index.js` + `serviceNames`, зависимости `ShotEffect`
  и `Tank` в `client.js`; конфиг `recoil`.
- Уточнение модели: повторный выстрел на спаде возвращает отдачу на пик (`min(elapsed, attack·duration)`), а не в ноль —
  иначе при зажатом огне перезапуски гасили бы отдачу.
- `Tank`: подписка по `context.id`, `_onFired`/`_stepRecoil`/`_resetRecoil`, добавка к `pitch`/`roll` в `_setCorners` и
  `_applyLight`, отписка в `destroy`; остов сбрасывает отдачу.
- Тесты: `recoil.test.js`, `shotEvents.test.js`, блок отдачи в `Tank.test.js`, `ShotEffectController.test.js`.
- Документация: `configuration.md` (таблица `recoil`), `architecture.md` (сервис `shots`, список `serviceNames`);
  CHANGELOG `### Added`.
- `npx eslint .`, `npm test` (659), `npm run build`, `npx vimp-contract` — зелёные; `sim:scenarios` — падает только
  `terraces_backside` (этап 5).
- П. 8 — ручная проверка пройдена, параметры отрегулированы пользователем.

## Этап 7. Трассер hitscan: от дула, светящийся след, вспышка у дула ✅ выполнен

### Контекст

Выстрел `w1` выглядит нереалистично (`src/client/parts/effects/shot/TracerEffect.js`):
- `trailStartOffset: 30` — линия появляется в 30 мировых единицах от дула, при танке длиной 12;
- линия — пунктир из 12 кружков радиусом 1 с мерцанием альфы;
- вспышки у дула днём нет — только световая `lighting.flash.shot` ночью.

Точка вылета в ядре (`Tank::muzzle_position`, 0.55 длины корпуса) почти совпадает с кончиком нового ствола — её не
трогаем. Решение пользователя: линия от дула, светящийся след, вспышка у дула (без дымного следа).

### Модель

- **Конфиг** `src/config/render.js`: `tracer` (скорость, длительности, длина хвоста, цвет, ширина ядра и свечения,
  альфа свечения) и `muzzleFlash` (длительность, длина конуса и боковых выбросов, ширина, цвета, разброс длины) —
  параметры переезжают из конструктора `TracerEffect` в конфиг.
- **Трассер.** Чистая функция `tracerSpan({ progress, totalDist, trailLength })` → расстояния хвоста и головы от
  дула: хвост = `max(0, голова − длина)`, к концу пути хвост укорачивается (как сейчас). Отступа от дула нет. Рисунок —
  цельная линия: широкое мягкое свечение + тонкое яркое ядро, хвост затухает к дулу (несколько подотрезков с растущей
  альфой). Смешивание `add`. Мерцание убирается.
- **Вспышка у дула** — новый `MuzzleFlashEffect` (наследник `BaseEffect`): конус вдоль выстрела, два коротких боковых
  выброса (дульный тормоз), яркое ядро. За `duration` сжимается и гаснет; длина конуса слегка случайна (`rng`
  параметром, по умолчанию `Math.random`). Чистая `muzzleFlashShape(...)` отдаёт полигоны — её и тестировать.
- **Уровни.** Контроллер рисуется в проекции уровня КОНЦА луча. Если уровень начала другой, вспышку сдвигаем и
  масштабируем в `onRender`, чтобы она легла на ствол: `q = cam + (p − cam)·(1 + k_s)/(1 + k_e)`.
- **Жизненный цикл.** Контроллер ждёт и вспышку: уничтожается, когда закончены трассер/попадание, вспышка и звук.

### Шаги

1. Конфиг `tracer`/`muzzleFlash` в `render.js`.
2. `TracerEffect`: `tracerSpan`, новый рисунок, чтение конфига.
3. `MuzzleFlashEffect.js` + `muzzleFlashShape`; запуск в `ShotEffectController.run()` рядом с ночной вспышкой света,
   коррекция уровня в `onRender`, условие уничтожения.
4. Тесты: `tests/client/parts/effects/TracerEffect.test.js` (`tracerSpan`: хвост от дула с первого кадра, длина
   не больше `trailLength`, к концу → 0), `MuzzleFlashEffect.test.js` (конус смотрит по направлению, к концу
   гаснет), `ShotEffectController.test.js` (вспышка в точке старта, контроллер ждёт её завершения).
5. Документация `configuration.md` (en/ru, «Рендер 2.5D» — таблицы `tracer`, `muzzleFlash`), CHANGELOG `### Changed`.
6. Проверки: `npx eslint .`, `npm test -- --silent`, `npm run build`.
7. Ручная проверка `npm run dev`: свой и чужой выстрел, днём и ночью, выстрел с моста вниз (вспышка на стволе),
   зажатый огонь.

### Ход выполнения

- Конфиг `tracer`, `muzzleFlash` в `render.js`; `TracerEffect` читает конфиг (последний аргумент конструктора — для тестов).
- `tracerSpan`: хвост от дула без отступа; рисунок — свечение + ядро по `fadeSteps` подотрезкам, `blendMode 'add'`,
  мерцание убрано.
- `MuzzleFlashEffect` + `muzzleFlashShape` (конус, два боковых выброса, ядро; `rng` параметром).
- `ShotEffectController`: вспышка в `run()`, `_placeFlash` в `onRender` (перенос в проекцию уровня дула),
  уничтожение ждёт и вспышку.
- Тесты: `TracerEffect.test.js`, `MuzzleFlashEffect.test.js`, блок вспышки в `ShotEffectController.test.js`.
- Документация `configuration.md` (таблицы `tracer`, `muzzleFlash`), CHANGELOG `### Changed`.
- `npx eslint .`, `npm test` (672), `npm run build` — зелёные.
- По ходу ручной проверки: при движении и стрельбе вбок трассер отрывался от дула (эффект в мире, танк за пролёт
  проезжает длину корпуса; чужой ещё и с задержкой интерполяции). Шина `shots` получила `muzzle(id)` (подписчик —
  `{ fired, muzzle }`), `Tank._muzzleWorld` (формула `muzzle_position`), `TracerEffect.setStart` (позже `shiftTo`), в `onRender`
  контроллера — `_followMuzzle`. Точка удара остаётся на месте. Тесты — в тех же файлах; `architecture.md`, CHANGELOG.
- Следом: у стены (дуло уже в стене, луч ≈ 0) перестройка луча к неподвижной цели растягивала его назад при езде вдоль
  стены. `setStart` заменён на `TracerEffect.shiftTo` — луч переносится целиком, направление и длина прежние;
  осколки попадания — в исходной точке удара.
- Следом: дальний выстрел не виден — пролёт упирается в `maxDuration` (≈5 кадров), голова проходит ~300 единиц за
  кадр, хвост 55 висел далеко от ствола. `tracer.trailShare: 0.4` — хвост не короче доли луча (`tracerSpan`).
- П. 7 — ручная проверка пройдена.
- После проверки, по просьбе «реалистичнее, как в кино»: тоньше и сдержаннее — ядро 0.3, свечение 1.2 при альфе 0.2,
  цвета фосфора (`0xff9a4a`/`0xfff4e0`), затухание хвоста по квадрату, `fadeSteps: 8`.
- Вспышка у дула в том же духе: 35 мс, неровные языки пламени (`spikes`, `spread`, `jitter`; `rollMuzzleFlash` раз
  на выстрел), мягкий край слоями (`layers`), гаснет по квадрату и сжимается лишь на `shrink`, цвета трассера.

## Этап 8. Визуальная реакция танка на взрыв ✅ выполнен

### Контекст

На взрыв бомбы (и бочки) танк реагирует только физическим толчком ядра (`TanksSim::explode`, `core/src/tanks.rs`):
импульс идёт от бомбы к центру танка и при расстоянии ≈ 0 не применяется (`target.distance > 0.0`, направление
вырождено), а рядом — танк после `size: 3` в 2,25 раза тяжелее, и боковое сцепление гасит толчок: «просто отъезжает».
Решение пользователя: **только визуальная** реакция, физика и ядро не меняются, формат кадра тот же.

Что уже есть:
- строка взрыва `w2e` = `[x, y, radius, level]` (`W2E_*` в `src/client/snapshotFields.js`) → парт
  `ExplosionEffectController` (`src/client/parts/effects/explosion/`), создаётся раз на взрыв (бомба и бочка);
- приём «эффект оповещает танк через сервис» — `shots` из этапа 6 (`src/client/shotEvents.js`, `hooks.services` в
  `src/client/index.js`, `serviceNames`, `componentDependencies` в `src/config/client.js`);
- в `Tank` уже есть: добавка к наклону (`_recoilTilt` → `_setCorners`/`_applyLight`), смещения мешей (отдача),
  просадка приземления (`_landTimer`/`_landImpact`, `landing`), проекция высоты по `_z` (`offsetPoint`, масштаб
  `1 + z·shear`).

### Модель

- **Событие.** Сервис `blasts` (`src/client/blastEvents.js`, экземпляр на ядро): `subscribe(cb) → unsubscribe`,
  `exploded({ x, y, radius, level })`. `ExplosionEffectController` зовёт его в конструкторе; каждый `Tank`
  подписан и сам решает, задел ли его взрыв.
- **Кто задет.** Тот же уровень (`level` взрыва = уровень танка — как маски ядра) и расстояние до центра < `radius`.
  Сила `s = 1 − d/radius` (та же спадающая, что у урона в ядре).
- **Реакция** (чистые функции в `src/client/blastJolt.js`, время — по `Ticker.shared.deltaMS`):
  1. **Крен от взрыва**: сторона к бомбе подлетает. Направление на бомбу в осях корпуса `(û, v̂)` → добавка
     `pitch = A·û`, `roll = A·v̂` (знаки как в `tiltCorners`), `A = rock·s`, затухающее колебание
     `e^(−t/τ)·cos(2π·wobbleHz·t)` — корпус «качается» на подвеске и успокаивается.
  2. **Подброс, если бомба под танком** (`d < underShare · длина корпуса`): визуальная высота `lift = hop·s·sin(πt)`
     за `hopDuration` добавляется к `_z` в проекции и масштабе (танк «подлетает» над своей тенью), крен — в
     случайную сторону (`rng`); на конце подброса — просадка приземления через `_landTimer` с силой `s`.
  3. **Встряска**: короткий случайный сдвиг корпуса и башни, затухающий за `shakeDuration`.
  Новый взрыв заменяет текущую реакцию, если он сильнее её остатка.
- **Сложение с отдачей.** Смещения мешей и добавки к наклону собираются в одном месте за кадр: отдача + взрыв.
- **Конфиг** `src/config/render.js`: `blastJolt = { enabled, rock: 0.22, wobbleHz: 5, decay: 180, duration: 700,
  hop: 0.3, hopDuration: 420, underShare: 0.5, shake: 1.2, shakeDuration: 220 }` (рад, Гц, мс, уровни, мировые
  единицы). Остов реагирует так же (он тоже тело на поле).

### Шаги

1. `src/client/blastJolt.js`: `blastStrength`, `blastKick({ tank, heading, blast, config, rng })` (сила, направление
   в осях корпуса, подброс да/нет), `blastJoltState({ elapsed, kick, config, rng })` → `{ lift, pitch, roll, shakeX,
   shakeY, done }`.
2. `src/client/blastEvents.js` + сервис `blasts` в `index.js`/`serviceNames`; `componentDependencies` для
   `ExplosionEffect` и `Tank`.
3. `ExplosionEffectController`: вызов `blasts?.exploded(...)` в конструкторе.
4. `Tank`: подписка/отписка; `_stepBlast` в `_updateView`; видимая высота `_z + lift` в проекции (`_updateView`) и
   масштабе (`_applyTilt`), тень остаётся на опоре; единая сборка смещений мешей (отдача + встряска) и добавок к
   наклону; просадка на конце подброса.
5. Тесты: `tests/client/blastJolt.test.js` (сила и радиус, другой уровень не задет, сторона к бомбе поднимается при
   курсах 0 и π/2, подброс только «под танком», колебание затухает, `done` к концу), `blastEvents.test.js`,
   `Tank.test.js` (взрыв рядом — крен, под танком — корпус выше тени и крупнее, после — просадка, всё к нулю;
   `enabled: false`; отписка в `destroy`), `ExplosionEffectController.test.js` (оповещение с `x, y, radius, level`).
6. Документация: `configuration.md` (en/ru, «Рендер 2.5D» — таблица `blastJolt`), `architecture.md` (сервис `blasts`),
   CHANGELOG `#### Added`.
7. Проверки: `npx eslint .`, `npm test -- --silent`, `npm run build`, `npx vimp-contract`.
8. Ручная проверка `npm run dev`: бомба сбоку/спереди/сзади (кренится от взрыва), под танком (подброс и просадка),
   взрыв бочки, взрыв на другом уровне (моста) — не задевает, серия взрывов, отдача во время реакции.

### Критичные файлы

- `src/client/blastJolt.js`, `src/client/blastEvents.js` (новые)
- `src/client/parts/Tank.js`, `src/client/parts/effects/explosion/ExplosionEffectController.js`
- `src/client/index.js`, `src/config/client.js`, `src/config/render.js`

### Ход выполнения

- `src/client/blastJolt.js` (`blastStrength`, `blastKick`, `blastJoltState`), `src/client/blastEvents.js`, сервис
  `blasts` (`index.js`, `serviceNames`, `componentDependencies` для `ExplosionEffect` и `Tank`), конфиг `blastJolt`.
- `ExplosionEffectController` сообщает `{ x, y, radius, level }` в конструкторе.
- `Tank`: `_onBlast` (новый толчок заменяет текущий, только если сильнее его остатка), `_stepBlast` до проекции,
  `_viewZ()` = `_z` + подброс — в проекции и масштабе (тень на опоре), `_applyMeshOffsets` собирает отдачу и
  встряску (остов тоже трясётся), добавка к наклону в `_setCorners`/`_applyLight`, просадка на конце подброса,
  отписка в `destroy`. Отдача больше не ставит позиции мешей сама — только считает смещения.
- Тесты: `blastJolt.test.js`, `blastEvents.test.js`, блок реакции в `Tank.test.js`, оповещение в
  `ExplosionEffectController.test.js`.
- Документация: `configuration.md` (таблица `blastJolt`), `architecture.md` (сервис `blasts`); CHANGELOG `### Added`.
- `npx eslint .`, `npm test` (702), `npm run build`, `npx vimp-contract` — зелёные.
- П. 8 — ручная проверка пройдена пользователем.

---

## Проверки (каждый этап)

```bash
npx eslint .
npm test -- --silent
npm run build              # этапы 2–3 (текстуры, шейдер в бандле)
```

## Риски

1. **Шейдер и тинт уровня** (этап 3): если `uColor` недоступен своему шейдеру, тинт/альфу передавать uniforms'ами.
   Выяснить в шаге 3.1 до кода.
2. **Небатченые меши** (этап 3): +3 draw call на танк. При просадке FPS — оставить шейдер только корпусу и башне,
   остову вернуть батчер.
3. **Ореол тени** (этап 1): если со смещением тень всё равно читается как ореол — уменьшить `groundAlpha` или
   `sizeFactor` на земле.
