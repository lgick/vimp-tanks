# План: исправления по код-ревью задачи `night-city-fixes-review` (коммиты 14decad, a0a2e1e)

План самодостаточен: исполнителю не нужен контекст переписки. Перед началом прочитать `CLAUDE.md` в корне
репозитория: там правила кода, тестов, документации en/ru и CHANGELOG. Коммитов не делать, все правки остаются в
рабочем дереве.

## Контекст

Ревью охватывает задачу `plan/done/night-city-fixes-review.md` (этапы 1–14 и 14.5). Код — коммит 14decad,
релиз — a0a2e1e. Смотрелось текущее состояние файлов на HEAD `bd678c5`, то есть уже с задачей
`plan/done/ramp-debris-parallax.md`, сделанной после.

По задаче `ramp-debris-parallax` уже есть отдельный план ревью `plan/ramp-debris-review.md`. Его находки здесь
**не повторяются**:
- `wallFace.raisedPoint` дублирует `parallax.reproject` (там M1);
- модель высоты пули, коды попадания `W1_HIT_*`, грань насыпи рамп в `ShotEffectController._wallAt` (там H1–N2);
- константа `tracer.height = 0.19`, посчитанная для `downtown` (там «За рамками»).

Этот план и `plan/ramp-debris-review.md` независимы. Общий файл у них один — `src/client/index.js` (функция
`services(core)`): там этап 4 этого плана меняет создание `volumes`/`lighting`, а этап 4 того плана добавляет
методы сервиса `rampRuns`. Правки не пересекаются по строкам, место искать по фрагменту кода.

**Базовая линия на момент ревью** (HEAD `bd678c5`): `npx eslint .` — чисто; `npx vitest run` — 992/992 зелёные;
`cargo test --workspace` — 397 + 88 зелёные.

Критических ошибок (падений, порчи данных, рассинхрона хоста и реплики) не найдено. Найдено одно расхождение
документации с кодом средней важности и набор мелких замечаний: DRY, читаемость, тесты, структура модулей.

### Сводка находок

| # | Важность | Критерий | Суть | Этап |
| --- | --- | --- | --- | --- |
| M1 | средняя | документированность | `volume.faceTilesPerLevel` в `src/config/render.js` равен `3`. Комментарий рядом с ним и таблицы `docs/en|ru/configuration.md` пишут «по умолчанию `2`, ≈ 116 мировых единиц». Тот, кто настраивает пропорции кирпича по документации, получит не то, что прочитал | 1 |
| L2 | низкая | DRY, читаемость | `LevelLightMap`: пул мешей-добавок написан трижды (`layoutFans`, `layoutWashes`, `layoutRampLights`), проекция вершин — дважды. У `wallWash().heights` и `rampLight().heights` одно имя, но разная точка отсчёта: высота над полом стены и абсолютная. Поэтому два почти одинаковых цикла проецируют по-разному (`item.level + h` и `h`) | 2 |
| L3 | низкая | DRY | Мелкие дубли. Проверка `hasLevelMap` вписана копией в `shafts.js`. Формула alpha центра дыры повторена в `MapLayer._roofAlpha` и `holeOverlay.apply`. Размер клетки `map.step * map.scale.x/y` считается 7 раз в `occlusion.js`/`createLighting.js`. Границы полосы рампы и интерполяция её высоты повторены в `rampHeight`, `rampLight`, `rampWedgePolygon` | 3 |
| L1 | низкая | DRY, поддерживаемость, документированность | Высоты объёмов лежат в двух реестрах: сервис `volumes` (выстрел) и `tops` освещения (сетка препятствий фар, вершины объёмов). `MapLayer` кладёт в оба одни и те же данные и дважды считает `cellsOfTiles`. Комментарий в `volumes.js` обещает объединить их при разделении `createLighting.js`, но этап 12 этого не сделал | 4 |
| L4 | низкая | тестируемость | Короткий путь окклюзии фар (этап 10: «рядом нет стен и рамп — лучи не пускаются») не доказан ни одним тестом, исполнитель сам об этом написал. У модуля `occlusion.js` нет собственного теста | 5 |
| L5 | низкая | читаемость, документированность | В комментариях `src/` стоят ссылки на этапы планов: `lightMath.js` — «(этап 10)», «(этап 11)», «(этап 12)», «(этап 14.5)», номера из двух разных планов; `createLighting.js` — «(7.3)». Без плана они не читаются, а заголовок раздела «свет верхнего уровня на рампах» уже неточен | 6 |
| L6 | низкая | поддерживаемость | Цель этапа 12 (`createLighting.js` ≤ ~900 строк) не достигнута: файл занимает 1302 строки, исполнитель ждёт решения. `lightMath.js` вырос до 969 строк разнородного кода: проекция, мерцание, профили, сетки, окклюзия, засветка, свет на клиньях | 7 (необязательный) |

### Ответы на вопросы исполнителя из отчёта

- **Этап 5, порядок умножений в ветке конуса `lightStrength`.** Оставить как есть. Разница — в последнем ulp.
  Засвет считается только на клиенте, в ядро и паритет не попадает, тесты сравнивают через `toBeCloseTo`.
- **Этап 14.5, свет всех источников уровня подножия на клине и учёт `maxLights` по факту попадания.** Принять.
  Без этого инверсная маска сняла бы с клина свет фонарей. Абзац про рампы в `docs/*/architecture.md` это уже
  описывает.
- **Этап 14, камера в `ShotEffectController` запрашивается только для стены.** Принять.
- **Этап 12, цель по размеру.** См. этап 7 этого плана (необязательный, по решению пользователя).

## Статус этапов

| # | Этап | Находки | Статус |
| --- | --- | --- | --- |
| 1 | `faceTilesPerLevel`: документация и комментарий по значению в коде | M1 | — |
| 2 | `LevelLightMap`: общий пул мешей и проекция, абсолютные высоты засветки | L2 | — |
| 3 | Мелкие дубли: `hasLevelMap`, alpha центра дыры, размер клетки, геометрия полосы рампы | L3 | — |
| 4 | Один реестр высот объёмов: освещение читает `volumes` | L1 | — |
| 5 | Тест короткого пути окклюзии (`occlusion.test.js`) | L4 | — |
| 6 | Ссылки на этапы в комментариях `src/` | L5 | — |
| 7 | (необязательный) Структура модулей освещения | L6 | — |
| 8 | Итоговая проверка | — | — |

Выполненный этап отметить «✅ выполнен» в заголовке и в таблице. Этап 7 выполняется только по решению
пользователя. Если пользователь от него отказался, отметить его «— отменён (решение пользователя)». Когда все
обязательные этапы выполнены, перенести файл в `plan/done/` (`git mv plan/night-city-fixes-review-2.md
plan/done/`, без коммита).

**Порядок.** 1 → 2 → 3 → 4 → 5 → 6 → (7) → 8. Этап 3 правит `occlusion.js` и `lightMath.js` раньше этапов 4, 5
и 7, которые трогают те же файлы. Этап 5 создаёт тест с `vi.mock` пути `lightMath.js`; если потом выполняется
этап 7, путь в моке меняется (см. этап 7). Номера строк ниже даны по HEAD `bd678c5` и после правок сдвигаются,
поэтому место искать по фрагменту кода (`grep -n`).

## Общие правила для исполнителя

1. **Никаких `git commit`.** Изменения остаются в рабочем дереве.
2. **Код**: ES-модули, `===`, только `let`/`const`, фигурные скобки обязательны, без двух заглавных подряд в
   именах. Комментарии в коде — на русском, в стиле окружающего кода (объясняют «почему»).
3. **PixiJS**: `onRender` назначается свойством, регистрация тестируется через `part._onRender`. Меши-добавки
   света — `Mesh` + `MeshGeometry`; присваивание того же массива в `geometry.positions` только помечает буфер к
   заливке.
4. **Документация**: функциональная правка обновляет парные `docs/en/` и `docs/ru/`. Раздел ищется по заголовку
   (`grep -n "^#" docs/en/<page>.md`).
5. **CHANGELOG.md**: у всех этапов этого плана записи **нет**. Это правка документации, рефакторинг или тесты,
   поведение игры не меняется.
6. **Проверки в конце каждого этапа** (тихие флаги):
   ```bash
   npx eslint .
   npm test -- --silent
   npm run build      # этапы 2, 3, 4, 7 (рендер освещения и сервисы)
   ```
   Ядро (`core/`) план не трогает: `npm run core:test` и `npm run sim:scenarios` не нужны.

---

## Этап 1. `faceTilesPerLevel`: документация и комментарий по значению в коде (M1)

### Проблема

`src/config/render.js` (≈ стр. 78–84):

```js
  // копий картинки тайла на уровень высоты боковой грани. Текстура привязана
  // ...
  // расстоянии `faceTilesPerLevel · клетка / shear` от центра камеры (при 2
  // на downtown ≈ 116 мировых единиц, ~0.6 полуэкрана)
  faceTilesPerLevel: 3,
```

Значение `3` пришло в том же коммите 14decad, а отчёт исполнителя и документация пишут `2`:
- `docs/en/configuration.md`, строка таблицы `faceTilesPerLevel`: «(default `2`)», «(≈ 116 world units on
  `downtown` at `2`, ~0.6 of the half-screen)»;
- `docs/ru/configuration.md`, та же строка: «(по умолчанию `2`)», «(≈ 116 мировых единиц на `downtown` при `2`,
  ~0.6 полуэкрана)».

### Решение

Источник истины — значение в коде (`3`), оно закоммичено. Расчёт для `3`: `3 · 12.8 / 0.22 ≈ 174.5` мировых
единиц. Из прежней пары «116 ≈ 0.6 полуэкрана» полуэкран ≈ 193 единицы, значит `174.5 / 193 ≈ 0.9`.

1. `src/config/render.js`: в комментарии над `faceTilesPerLevel` заменить «(при 2\n  // на downtown ≈ 116 мировых
   единиц, ~0.6 полуэкрана)» на «(при 3\n  // на downtown ≈ 175 мировых единиц, ~0.9 полуэкрана)».
2. `docs/en/configuration.md` (`grep -n "faceTilesPerLevel" docs/en/configuration.md`, строка таблицы
   `| \`faceTilesPerLevel\` |`): «(default `2`)» → «(default `3`)»; «(≈ 116 world units on `downtown` at `2`, ~0.6
   of the half-screen)» → «(≈ 175 world units on `downtown` at `3`, ~0.9 of the half-screen)».
3. `docs/ru/configuration.md`, та же строка: «(по умолчанию `2`)» → «(по умолчанию `3`)»; «(≈ 116 мировых единиц
   на `downtown` при `2`, ~0.6 полуэкрана)» → «(≈ 175 мировых единиц на `downtown` при `3`, ~0.9 полуэкрана)».

Если пользователь скажет, что задумано `2`, менять только значение в `render.js` на `2`, а документацию оставить
как была.

### Проверка

`grep -rn "116\|faceTilesPerLevel" src/config docs` — все упоминания согласованы с `3`. Тесты не меняются
(`MapLayer.test.js` читает значение из конфига).

---

## Этап 2. `LevelLightMap`: общий пул мешей и проекция, абсолютные высоты засветки (L2)

### Проблема

`src/client/lighting/LevelLightMap.js`:
- Цикл «пул мешей растёт до числа элементов» повторён в `layoutFans` (функция модуля внизу файла),
  `layoutWashes` и `layoutRampLights`. Каждый раз это `MeshGeometry` + `Mesh` с `Texture.EMPTY`, `blendMode =
  'add'`, `pool.push`, `container.addChild`. Хвост «`visible = true`, `texture`, `tint`, `alpha`» тоже повторён
  трижды.
- Проекция вершин повторена в `layoutWashes` и `layoutRampLights`, но с разной высотой:
  `k = (item.level + heights[v]) * shear` и `k = heights[v] * shear`. Причина в
  `src/client/lighting/lightMath.js`: `wallWash` отдаёт `heights` над полом стены, а `rampLight` — абсолютные.
  Одно имя с двумя смыслами — ловушка. Кто перепутает, получит свет на стене уровня ≥ 1 не на той высоте.
- У срезов `src/client/parts/map/extrusion.js` поле `heights` означает третье: уже готовые коэффициенты `k`
  (умножены на `shear`). Шапка модуля этого не говорит.

### Решение

1. **`lightMath.js`, `wallWash`**: новый параметр `level = 0` в деструктуризации аргументов (после `height`).
   Высота вершины пишется абсолютной: в цикле `vertices.forEach(...)` заменить `heights[v] = h;` на
   `heights[v] = level + h;`. В комментарии над функцией фразу «heights — высота вершины в уровнях над полом
   стены» заменить на «heights — абсолютная высота вершины в уровнях (`level` пола стены + высота над ним), как у
   `rampLight`: обе проецирует один хелпер `LevelLightMap`». В описание параметров добавить «`level` — уровень
   пола стены (уровень фары)».
2. **`occlusion.js`**, вызов `wallWash({ … })` в `occlusionOf`: добавить аргумент `level,` (локальная
   `const level = light.level ?? 0` там уже есть).
3. **`createLighting.js`**, `layoutLights` → `push`: в объекте для `perWash` удалить поле `level: washLevel`.
   Переменная `washLevel` остаётся: по ней выбирается карта.
4. **`LevelLightMap.js`**, внизу модуля рядом с `layoutPool`/`layoutFans` добавить три хелпера:
   ```js
   // Пул мешей-добавок света в `container`: растёт до `count`. Меш — режим
   // `add`, пустая текстура; `indices()` — индексы новой геометрии (у
   // каждого меша свой массив). Лишние меши прячет вызывающий
   function growMeshPool(pool, container, count, indices) {
     while (pool.length < count) {
       const geometry = new MeshGeometry({
         positions: new Float32Array(6),
         uvs: new Float32Array(6),
         indices: indices(),
       });
       const mesh = new Mesh({ geometry, texture: Texture.EMPTY });

       mesh.blendMode = 'add';
       pool.push(mesh);
       container.addChild(mesh);
     }
   }

   // меш-добавка кадра: видим, с текстурой, цветом и силой источника
   function showLight(mesh, item) {
     mesh.visible = true;
     mesh.texture = item.texture;
     mesh.tint = item.color;
     mesh.alpha = item.alpha;
   }

   // Вершины меша с повершинной высотой в мировом оверлее: точка `p` с
   // абсолютной высотой `z` (уровни) ложится в `p + (p − cam)·z·shear` — та
   // же формула, что у `offsetPoint` (src/client/parallax.js). Без камеры —
   // мировая точка. Не для срезов extrusion.js: там `heights` — уже `k`
   function projectVertices(positions, base, heights, camera, shear) {
     for (let v = 0; v < heights.length; v += 1) {
       const x = base[v * 2];
       const y = base[v * 2 + 1];
       const k = camera ? heights[v] * shear : 0;

       positions[v * 2] = camera ? x + (x - camera.x) * k : x;
       positions[v * 2 + 1] = camera ? y + (y - camera.y) * k : y;
     }
   }
   ```
5. **`layoutFans`**: цикл `while (pool.length < items.length) { … }` заменить на
   `growMeshPool(pool, container, items.length, () => fanIndices(2));`. Строки `mesh.shape = null;
   mesh.topology = null;` уходят: у нового меша эти поля `undefined`, и сравнения `mesh.shape !== shape` и
   `mesh.topology !== topology` дают `true`, как раньше. Хвост `mesh.visible = true; mesh.texture = …;
   mesh.tint = …; mesh.alpha = …;` заменить на `showLight(mesh, item);`, а `mesh.position.set(...)` и
   `mesh.scale.set(...)` оставить.
6. **`layoutWashes(items, camera, shear)`**:
   - `while (this.washPool.length < items.length) { … }` →
     `growMeshPool(this.washPool, this.lights, items.length, () => new Uint32Array(6));` (поля `mesh.wash`/
     `mesh.facing` у нового меша `undefined`, ветка `mesh.wash !== wash` их заведёт);
   - цикл проекции (от `const positions = geometry.positions;` до `geometry.positions = positions;`) →
     ```js
     const positions = geometry.positions;

     projectVertices(positions, wash.base, wash.heights, camera, shear);
     // тот же массив: сеттер буфера только отмечает обновление
     geometry.positions = positions;
     ```
     Дальше код берёт `normals`, `mids` из `wash`: деструктуризацию `const { base, heights, normals, mids } =
     wash;` сократить до `const { normals, mids } = wash;`;
   - хвост `mesh.visible = true; … mesh.alpha = item.alpha;` → `showLight(mesh, item);`;
   - комментарий метода: «`items` — `{ wash, level, texture, color, alpha }`» → «`items` — `{ wash, texture,
     color, alpha }`», а «`k = (level + высота вершины)·shear`» → «`k = высота вершины·shear` (высоты
     абсолютные, `wallWash`)».
7. **`layoutRampLights(items, camera, shear)`**: то же. `growMeshPool(this.rampLightPool, this.rampLights,
   items.length, () => new Uint32Array(3));`, проекция через `projectVertices(positions, ramp.base,
   ramp.heights, camera, shear)`, хвост через `showLight`.
8. **`extrusion.js`**, шапка модуля (первый комментарий, где перечислен формат `{ target, k, base, heights,
   occluder, walls }`): дописать «`heights` — коэффициенты проекции `k` вершин, уже умноженные на `shear` (у
   мешей освещения `heights` — высоты в уровнях)».

Поведение не меняется. У всех существующих тестов засветки уровень фары 0, поэтому высоты совпадают.

### Тесты

- `tests/client/lighting/lightMath.test.js`: новый тест «wallWash: `level` прибавляется к высотам вершин». Взять
  аргументы любого существующего вызова `wallWash({ … })` (`grep -n "wallWash({" tests/client/lighting/lightMath.test.js`),
  вызвать дважды — без `level` и с `level: 1` — и проверить поэлементно:
  `withLevel.heights[v] === plain.heights[v] + 1`, а `base`, `uvs` и `indices` совпадают.
- `tests/client/lighting/createLighting.test.js`, рядом с `describe`, где тест «layoutRampLights переиспользует
  пул и проецирует высотой вершины» (`grep -n "layoutRampLights переиспользует"`). Новый тест «layoutWashes
  проецирует абсолютной высотой и прячет отвёрнутый квад» на той же фабрике `make()`:
  ```js
  const wash = {
    // верх a, верх b, низ a, низ b — стена уровня 1, засветка на 0.5
    base: new Float32Array([10, 10, 20, 10, 10, 10, 20, 10]),
    heights: new Float32Array([1.5, 1.5, 1, 1]),
    uvs: new Float32Array(8),
    indices: new Uint32Array([0, 1, 3, 0, 3, 2]),
    normals: new Float32Array([0, 1]),
    mids: new Float32Array([15, 10]),
  };
  const item = { wash, texture: Texture.WHITE, color: 0xffffff, alpha: 1 };
  ```
  `map.layoutWashes([item], { x: 15, y: 100 }, 0.2)` — грань смотрит на камеру. Ожидания:
  `positions[0..1] ≈ [8.5, −17]` (`k = 1.5 · 0.2`), `positions[4..5] ≈ [9, −8]` (`k = 0.2`); `indices` равны
  `wash.indices`. Затем `map.layoutWashes([item], { x: 15, y: −100 }, 0.2)` — грань отвёрнута, все 6 индексов
  равны `0`. Пул не вырос (`washPool` длины 1). В конце `map.destroy()`.
- Остальные тесты `LevelLightMap` (веера, клинья, destroy) проходят без правок.

### Документация

Не нужна: рефакторинг, формат описан в комментариях кода.

---

## Этап 3. Мелкие дубли (L3)

### 3.1. `hasLevelMap` — одна функция

Сейчас `createLighting.js` (≈ стр. 321–323) держит замыкание
`const hasLevelMap = level => map.levels.has(level) || map.roofLevels.has(level);`, а `shafts.js`
(`layoutShafts`, ≈ стр. 77–80) повторяет его строкой `!(map.levels.has(lamp.level) ||
map.roofLevels.has(lamp.level))`.

1. `src/client/lighting/LevelLightMap.js`, экспорт рядом с классом (после него, перед `layoutPool`):
   ```js
   // Есть ли у уровня карта освещённости — обычная или крыш (`map` —
   // состояние карты сервиса `lighting`): уровень может состоять из одних
   // крыш, и его свет обязан дойти до них
   export function hasLevelMap(map, level) {
     return map.levels.has(level) || map.roofLevels.has(level);
   }
   ```
2. `createLighting.js`: импорт `import LevelLightMap, { hasLevelMap } from './LevelLightMap.js';`. Замыкание
   `hasLevelMap` и его комментарий удалить. Вызовы (`grep -n "hasLevelMap" src/client/lighting/createLighting.js`)
   перевести на `hasLevelMap(map, level)`: в `push` это `own.filter(level => hasLevelMap(map, level))`.
3. `shafts.js`: `import { hasLevelMap } from './LevelLightMap.js';`, условие —
   `if (!lamp.head || !hasLevelMap(map, lamp.level)) { continue; }`. Комментарий над условием оставить.

### 3.2. Alpha центра дыры — одна формула

`holeOverlay.apply` (`minAlpha: 1 + (cfg.minAlpha - 1) * hole.strength`) и `MapLayer._roofAlpha`
(`return 1 + (this._levelView.cfg.minAlpha - 1) * this._hole.strength;`) считают одно и то же.

1. `src/client/parts/map/holeOverlay.js`, после `advance`:
   ```js
   // alpha слоя в центре дыры силы `hole.strength`: `minAlpha` у открытой
   // дыры, 1 — без неё. Её получает шейдер дыры (`apply`) и вывески крыши
   // (`MapLayer._roofAlpha`) — вывеска гаснет вместе с центром дыры
   export function holeCenterAlpha(hole, cfg) {
     return 1 + (cfg.minAlpha - 1) * hole.strength;
   }
   ```
   В `apply`: `minAlpha: holeCenterAlpha(hole, cfg),`. Комментарий над этим полем оставить.
2. `src/client/parts/map/MapLayer.js`: в импорт из `./holeOverlay.js` (`grep -n "holeOverlay" MapLayer.js`)
   добавить `holeCenterAlpha`; в `_roofAlpha` последняя строка — `return holeCenterAlpha(this._hole,
   this._levelView.cfg);`.
3. Тест `tests/client/parts/map/holeOverlay.test.js`: `holeCenterAlpha({ strength: 0 }, { minAlpha: 0.2 }) === 1`,
   при `strength: 1` → `0.2`, при `0.5` → `0.6` (`toBeCloseTo`).

### 3.3. Размер клетки — поле состояния карты

`map.step * map.scale.x` / `map.step * map.scale.y` считается в `occlusion.js` (в `obstaclesFor`,
`obstaclesNear`, `volumeAt`, `rampHeightAt`, `occlusionOf`, `reachesPoint`) и в `createLighting.js`
(`pushRampLights`, аргументы `cellW`/`cellH` для `rampLight`).

1. `createLighting.js`, `initMap`, в объект `map` после `scale: mapScale,`:
   ```js
      // размер клетки в мировых единицах: сетки препятствий фар, веера и
      // свет на клиньях
      cellW: step * mapScale.x,
      cellH: step * mapScale.y,
   ```
2. Все места из списка выше (`grep -n "step \* map.scale" src/client/lighting/*.js`) перевести на `map.cellW` /
   `map.cellH`. В `volumeAt` — `Math.floor(x / map.cellW)`, в `reachesPoint` — последние два аргумента
   `castRay(…, map.cellW, map.cellH)`. Где сейчас заводятся локальные `const cellW = …; const cellH = …;`,
   написать `const { cellW, cellH } = map;`.
3. `lightArea` и `LevelLightMap.setMask`/`setTops` не трогать: они получают `step`/`scale` параметрами и работают
   до `initMap`.

### 3.4. Геометрия полосы рампы — два хелпера

`lightMath.js`: `rampHeight` и `rampLight` одинаково считают `a0/a1` (вдоль оси) и `b0/b1` (поперёк) из полосы.
`rampWedgePolygon` и `rampHeight` одинаково интерполируют высоту
`lane.from + (lane.to - lane.from) * progress` с `progress = lane.sign > 0 ? t : 1 - t`.

1. В `lightMath.js` перед `rampWedgePolygon`:
   ```js
   // Полоса рампы `lane` (`buildRampLanes`, клетки) в мировых осях: `alongX`
   // — ось прогона x, `[a0, a1]` — вдоль оси, `[b0, b1]` — поперёк
   export function laneBounds(lane, cellW, cellH) {
     const alongX = lane.axis === 0;

     return {
       alongX,
       a0: alongX ? lane.col0 * cellW : lane.row0 * cellH,
       a1: alongX ? lane.col1 * cellW : lane.row1 * cellH,
       b0: alongX ? lane.row0 * cellH : lane.col0 * cellW,
       b1: alongX ? lane.row1 * cellH : lane.col1 * cellW,
     };
   }

   // высота полосы на доле пути `t ∈ [0, 1]` вдоль оси (от `a0` к `a1`), в
   // уровнях: `lerp(from, to, progress)`, прогресс — от подножия. Та же
   // формула, что у вершин меша клина (`buildRampMeshes`)
   export function laneHeightAt(lane, t) {
     const progress = lane.sign > 0 ? t : 1 - t;

     return lane.from + (lane.to - lane.from) * progress;
   }
   ```
2. `rampHeight`: `const { alongX, a0, a1 } = laneBounds(lane, cellW, cellH);`, `t` — как сейчас (обрезка по
   `[0, 1]`, `span = a1 - a0 || 1`), `return laneHeightAt(lane, t);`.
3. `rampLight`: шесть строк `alongX`/`a0`/`a1`/`b0`/`b1` заменить на
   `const { alongX, a0, a1, b0, b1 } = laneBounds(lane, cellW, cellH);`.
4. `rampWedgePolygon`:
   ```js
   const { alongX, a0, a1, b0, b1 } = laneBounds(lane, step * scale.x, step * scale.y);
   // точка в мировых осях из осей полосы
   const point = (a, b) => (alongX ? [a, b] : [b, a]);
   ```
   В цикле: `const k = laneHeightAt(lane, t) * shear; const a = a0 + (a1 - a0) * t;`,
   `sideA.push(project(...point(a, b0), k)); sideB.push(project(...point(a, b1), k));`. Ветка `if (alongX)` и
   переменные `x0..y1` уходят. Порядок точек прежний: при оси x сторона A — `y0`, при оси y — `x0`.
5. Формулу `rampSurface.js` (мировые прогоны ядра, свой формат) сюда **не** объединять: её причёсывает этап 4
   плана `plan/ramp-debris-review.md` (`runHeight`).
6. Тесты `tests/client/lighting/lightMath.test.js`:
   - `laneBounds` для `{ axis: 0, col0: 2, col1: 5, row0: 1, row1: 2 }` при `cellW = 10, cellH = 20` →
     `{ alongX: true, a0: 20, a1: 50, b0: 20, b1: 40 }`, для той же полосы с `axis: 1` →
     `{ alongX: false, a0: 20, a1: 40, b0: 20, b1: 50 }`;
   - `laneHeightAt({ sign: 1, from: 0, to: 1 }, 0.25) === 0.25`,
     `laneHeightAt({ sign: -1, from: 0, to: 1 }, 0.25) === 0.75`;
   - существующие тесты `rampHeight`, `rampLight`, `rampWedgePolygon` проходят без правок: формулы совпадают
     бит в бит.

### Документация

Не нужна (рефакторинг).

---

## Этап 4. Один реестр высот объёмов: освещение читает `volumes` (L1)

### Проблема

`src/client/parts/map/MapLayer.js` (≈ стр. 209–235) дважды считает `cellsOfTiles(this._map, this._tiles)` и
кладёт одни и те же данные в два сервиса:
- `this._lighting.setVolumeTops(level, cells, volume, this)` → `tops` в `createLighting.js`. Из них собираются
  сетка препятствий фар (`occlusion.sync(tops, ramps)`) и вершины объёмов в картах освещённости
  (`topGroupsOf`);
- `this._volumes?.setLayerVolume(level, cells, volume, this, { step, scale })` → `src/client/volumes.js`, откуда
  эффект выстрела узнаёт, что попал в стену.

Шапка `volumes.js` прямо называет это дублем и обещает объединить реестры при разделении `createLighting.js` на
модули. Этап 12 разделение сделал, а реестры не объединил. Выстрел и свет обязаны видеть одни и те же стены, а
держится это только на том, что `MapLayer` пишет в оба реестра одинаково.

### Решение

Единственный реестр — `volumes`. Освещение получает его в `deps` и перечитывает, когда меняется номер правки.

1. **`src/client/volumes.js`**:
   - рядом с `grids` добавить
     ```js
     // level -> [{ cells, volume }] — вклады слоёв по уровням (освещение);
     // пересобирается лениво, как `grids`
     let byLevel = null;
     // номер правки реестра: по нему освещение видит, что вклады сменились
     let version = 0;

     const changed = () => {
       grids = null;
       byLevel = null;
       version += 1;
     };
     ```
   - в `setLayerVolume` строку `grids = null;` заменить на `changed();`; в `release` —
     `if (owners.delete(owner)) { changed(); }`;
   - в возвращаемый объект добавить
     ```js
     // номер правки: растёт на каждом вкладе и снятии слоя
     get version() {
       return version;
     },

     // вклады по уровням: level -> [{ cells, volume }]. Сетка препятствий
     // фар и вершины объёмов карты освещённости (createLighting.js)
     levels() {
       if (!byLevel) {
         byLevel = new Map();

         for (const { level, cells, volume } of owners.values()) {
           if (!byLevel.has(level)) {
             byLevel.set(level, []);
           }

           byLevel.get(level).push({ cells, volume });
         }
       }

       return byLevel;
     },
     ```
   - абзац шапки «Сервис освещения держит те же данные в своих `tops` … кандидат разделения `createLighting.js`
     на модули» заменить на: «Тот же реестр читает сервис освещения (`levels()`, `version`): по нему строятся
     сетка препятствий фар и вершины объёмов в картах освещённости. Один реестр на оба потребителя — свет и
     выстрел видят одни и те же стены.». В первом абзаце «читают эффекты, которым нужно знать…» дополнить: «…и
     освещение».
2. **`src/client/index.js`**, `services(core)`: создать реестр до освещения и передать его:
   ```js
      const levelView = createLevelView();
      // высоты объёмов карты: пишут слои Map, читают эффект выстрела и
      // освещение (src/client/volumes.js)
      const volumes = createVolumes();
      // ночь и освещение: камеру и прозрачность над игроком берёт у
      // levelView, стены — у volumes
      const lighting = createLighting(undefined, { levelView, volumes });
   ```
   В возвращаемом объекте `volumes: createVolumes(),` → `volumes,`.
3. **`src/client/lighting/createLighting.js`**:
   - после `const levelView = deps.levelView || null;`: `const volumes = deps.volumes || null;`;
   - удалить `const tops = new Map();` и комментарий над ним («level -> Map(owner -> { cells, volume }) —
     вершины объёмов»). На его месте:
     ```js
     // вершины объёмов и сетка препятствий фар — из сервиса `volumes`
     // (src/client/volumes.js); номер его правки, по которому они собраны
     let volumesVersion = null;
     ```
   - хелпер рядом с `allLevelMaps`:
     ```js
     // вклады объёмов по уровням: level -> [{ cells, volume }]
     const volumeTops = () => volumes?.levels() ?? new Map();
     ```
   - `topGroupsOf(level)`: `for (const { cells, volume } of volumeTops().get(level) || [])`;
   - `syncLevels`, самой первой строкой (до `const dirty = masksDirty;`):
     ```js
     // вклады объёмов сменились (слой карты пришёл или ушёл) — вершины и
     // сетка препятствий пересобираются, как при правке масок
     if (volumes && volumes.version !== volumesVersion) {
       volumesVersion = volumes.version;
       masksDirty = true;
     }
     ```
     и `occlusion.sync(tops, ramps)` → `occlusion.sync(volumeTops(), ramps)`. У `occlusion.sync` правок нет:
     цикл `for (const { cells, volume } of byOwner.values())` работает и с массивом;
   - `render()`, условие раннего выхода (`key !== null && key.tick === tick && … && !masksDirty`): добавить
     `&& volumesVersion === (volumes ? volumes.version : null)`. Без него новый слой той же отрисовки
     подхватится только в следующем тике;
   - `releaseMap`: список `[masks, roofMasks, tops, ramps]` → `[masks, roofMasks, ramps]`;
   - `clear()`: удалить `tops.clear();`, добавить `volumesVersion = null;` — следующая карта соберётся заново;
   - удалить метод `setVolumeTops` вместе с комментарием;
   - описание сервиса над `createLighting`: в «состояние КАРТЫ — … вершины объёмов и клинья рамп (`tops`,
     `ramps`)» заменить на «… клинья рамп (`ramps`)», и дописать отдельной строкой: «Вершины объёмов и сетку
     препятствий фар сервис берёт из реестра `volumes` (`deps.volumes`, src/client/volumes.js)».
4. **`src/client/parts/map/MapLayer.js`**:
   - удалить блок `if (this._volume > 0) { this._lighting.setVolumeTops(…); }` вместе с его комментарием
     («вершины объёмов: карта освещённости уровня закрывает их полумраком…»);
   - в блоке `volumes` комментарий «по ним выстрел в стену кончается на её видимой грани. Днём тоже —
     освещение тут ни при чём» заменить на «по ним выстрел в стену кончается на её видимой грани, а ночью
     освещение строит сетку препятствий фар и закрывает вершины объёмов полумраком. Регистрируется всегда: выстрелу
     он нужен и днём». `cellsOfTiles(this._map, this._tiles)` теперь считается один раз.
5. **`src/config/client.js`**, комментарий у `volumes: ['Map', 'ShotEffect']`: «пишут слои Map, читает эффект
   выстрела…» дополнить «…; сервис освещения получает его в `services()` напрямую». Сам массив не меняется:
   освещение — сервис, а не компонент.

### Тесты

- `tests/client/volumes.test.js`: `version` растёт на `setLayerVolume` и на `release` известного владельца и не
  меняется на `release` чужого. `levels()` группирует вклады по уровням (два слоя уровня 0 и один уровня 1 дают
  `Map` с ключами `0` и `1`, у `0` два элемента). После `release` владелец из `levels()` пропадает.
- `tests/client/lighting/createLighting.test.js`:
  - хелпер `setup` (≈ стр. 56): `const volumes = createVolumes();`,
    `createLighting(cfg, { levelView, volumes })`, вернуть `volumes` в объекте. Импорт `createVolumes` из
    `../../../src/client/volumes.js`;
  - все вызовы `service.setVolumeTops(level, cells, volume, owner)` (`grep -n "setVolumeTops"`, их 3 в коде
    тестов и 1 в комментарии) → `volumes.setLayerVolume(level, cells, volume, owner, { step: STEP, scale: 1 })`
    (в `scene()` — `context.volumes.…`). Комментарий «стены — вершины объёмов уровня (`setVolumeTops`)» →
    «(`volumes.setLayerVolume`)»;
  - тест «setVolumeTops рисует вершины, releaseMap снимает их вместе с владельцем» переименовать в «вершины
    объёмов берутся из volumes, release снимает их». Вместо `service.releaseMap('k', walls)` —
    `volumes.release(walls)`, ожидания прежние;
  - новый тест «слой объёма после первой отрисовки подхватывается без смены камеры». `frame(service)` с пустым
    `volumes`, затем `volumes.setLayerVolume(0, [[0, 0]], 1, {}, { step: STEP, scale: 1 })` и `service.render()`
    **без** сдвига тика. `topGroups` карты уровня 0 уже содержит группу — это проверка раннего выхода в
    `render()`.
- `tests/client/parts/map/MapLayer.test.js`: если где-то проверяется вызов `setVolumeTops` у заглушки
  освещения, убрать эту проверку (сейчас таких нет, проверить `grep -n "setVolumeTops"`).

### Документация

- `docs/en/architecture.md`, абзац про сервис `volumes` (`grep -n "\`volumes\` service" docs/en/architecture.md`):
  после «…filled by the `Map` layers that have `data.volume`.» вставить «The lighting service reads the same
  registry (`levels()`, `version`) for its headlight obstacle grid and the volume tops of its light maps, so light
  and shots see the same walls.». В абзаце «Headlights and walls» «what `setVolumeTops` hands over» → «what the
  `volumes` service holds».
- `docs/ru/architecture.md`: абзац про сервис `volumes` — «Тот же реестр читает сервис освещения (`levels()`,
  `version`): сетка препятствий фар и вершины объёмов в картах освещённости, поэтому свет и выстрел видят одни и
  те же стены.»; «то, что отдаёт `setVolumeTops`» → «то, что держит сервис `volumes`».
- `docs/en/configuration.md` и `docs/ru/configuration.md`: в перечне методов сервиса `lighting`
  (`grep -n "setVolumeTops" docs/*/configuration.md`) убрать `setVolumeTops`. Рядом, где описаны вершины объёмов
  (en: «map also covers the tops of its volumes», ru — парная фраза), указать, что их клетки приходят из сервиса
  `volumes`.

CHANGELOG — нет: поведение не меняется.

---

## Этап 5. Тест короткого пути окклюзии (L4)

### Проблема

Этап 10 прошлой задачи добавил в `occlusion.occlusionOf` короткий путь: если в AABB прямоугольника текстуры
конуса нет клетки стены или рампы (`obstaclesNear`), лучи `coneFan` не пускаются. Тест
«конус вдали от стен и рамп — без веера и отсвета» (`createLighting.test.js`) проверяет только результат
(`item.fan === null`). Тот же результат даёт и полный путь без упора, поэтому тест пройдёт, даже если короткий
путь сломается. Своего теста у `occlusion.js` нет.

### Решение — новый файл `tests/client/lighting/occlusion.test.js`

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

// шпион на обход лучей: короткий путь его не зовёт
vi.mock('../../../src/client/lighting/lightMath.js', async importOriginal => {
  const actual = await importOriginal();

  return { ...actual, coneFan: vi.fn(actual.coneFan) };
});

import { coneFan } from '../../../src/client/lighting/lightMath.js';
import { createOcclusion } from '../../../src/client/lighting/occlusion.js';

const STEP = 32;
const cfg = {
  headlights: {
    occlusion: { enabled: true, rays: 16 },
    wash: { height: 0.6, intensity: 1 },
  },
};
// раскладка текстуры конуса для `frameOf`: длина 100, полуширина 25, отступ 20
const asset = {
  texture: { width: 140, height: 60 },
  length: 100,
  halfWidth: 25,
  margin: 20,
};
const light = () => ({
  kind: 'cone',
  level: 0,
  x: 40,
  y: 48,
  z: 0,
  radius: 90,
  spread: 0.5,
  rotation: 0,
});
// столбец клеток `col` — стена уровня 0
const column = col => Array.from({ length: 20 }, (_, row) => [col, row]);

const setup = ({ walls = [], lanes = [] } = {}) => {
  const map = {
    step: STEP,
    scale: { x: 1, y: 1 },
    cellW: STEP,
    cellH: STEP,
    cols: 20,
    rows: 20,
    blockers: new Map(),
    rampCells: new Map(),
  };
  const occlusion = createOcclusion({ getMap: () => map, cfg });

  occlusion.sync(
    new Map([[0, new Map([['walls', { cells: walls, volume: 1 }]])]]),
    new Map(lanes.length ? [[0, new Map([['ramps', lanes]])]] : []),
  );

  return occlusion;
};

beforeEach(() => {
  coneFan.mockClear();
});
```

Поля `cellW`/`cellH` в `map` нужны после этапа 3.3. `sync` принимает и `Map(owner → …)`, и массивы (этап 4),
поэтому тест от порядка этапов 4 и 5 не зависит.

Тесты (`describe('occlusion: короткий путь без препятствий рядом')`):
1. **Стена далеко — лучей нет.** `setup({ walls: column(15) })`. Стена в x 480..512, а AABB прямоугольника
   конуса с запасом — колонки −1..5. `occlusionOf(light(), asset)`: `coneFan` не вызван; результат —
   `{ shape: null, hit: null, wash: null, fan: null }` (проверить через `toMatchObject`).
2. **Стена рядом — лучи есть.** `setup({ walls: column(3) })` (x 96..128). `coneFan` вызван ровно один раз;
   `result.fan` не `null` (`points`, `closed`, `frame`); `result.hit.x ≈ 96`, `result.hit.y ≈ 48`.
3. **Рампа рядом без стен — лучи есть.** `setup({ lanes: [{ axis: 0, sign: 1, from: 0, to: 1, col0: 3, col1: 6,
   row0: 1, row1: 2 }] })`: `coneFan` вызван.
4. **Кеш.** В случае 2 второй вызов `occlusionOf` с тем же объектом света и тем же `asset` → `coneFan` не вызван
   повторно, результат тот же объект (`toBe`). После сдвига `light.x += 1` — вызван снова.
5. **Кеш короткого пути.** В случае 1 второй вызов отдаёт тот же объект, `coneFan` так и не вызван.

Импортный путь `../../../src/…` проверить по соседнему `createLighting.test.js`. Если `vi.mock` с
`importOriginal` в проекте `tanks` не срабатывает (шпион не вызывается и во 2-м тесте), убедиться, что мок стоит
до импортов: `vi.mock` поднимается автоматически, но только на верхнем уровне файла.

**Контрольная проверка.** Временно заменить в `occlusion.js` условие `if (!obstaclesNear(…))` на `if (false)`:
тест 1 обязан упасть (`coneFan` вызван). Правку вернуть.

### Документация

Не нужна (тесты).

---

## Этап 6. Ссылки на этапы в комментариях `src/` (L5)

Номера этапов в коде ссылаются на планы из `plan/done/` (разные планы, номера пересекаются) и без плана не
читаются. Правка только в комментариях:

1. `src/client/lighting/lightMath.js`:
   - `// --- засветы и лучи (этап 10) ---` → `// --- засветы и лучи ---`;
   - `// --- свет верхнего уровня на рампах (этап 11) ---` → `// --- клин рампы в проекции ---` (под ним только
     `rampWedgePolygon`: контур клина для стенсил-масок);
   - `// --- фары и стены (этап 12) ---` → `// --- фары: препятствия, веер, засветка грани, свет на клине ---`;
   - комментарий `rampLight`: «Свет источника на склоне рампы — в проекции клина (этап 14.5). Карта…» →
     «Свет источника на склоне рампы — в проекции клина. Карта…».
2. `src/client/lighting/createLighting.js`, над `TEXTURE_KEYS`: «ключи текстур, которые принимает сервис (7.3);»
   → «ключи текстур, которые принимает сервис (`registerTextures`);».
3. Остальные ссылки на этапы в `src/` (`grep -rn "этап" src`: `systemMessages.js`, `config/client.js`,
   `tanks.css`, `tank3d/model.js`, `rampLanes.js`) относятся к другим задачам. Их **не** трогать.

Проверка: `grep -n "этап\|(7.3)" src/client/lighting/*.js` — пусто.

---

## Этап 7 (необязательный). Структура модулей освещения (L6)

Выполнять только по решению пользователя, отдельным заходом, после зелёной проверки этапов 1–6.

### Проблема

- `src/client/lighting/createLighting.js` — 1302 строки. Цель этапа 12 прошлой задачи (≤ ~900) не достигнута:
  этап 14.5 добавил в раскладку свет на клиньях рамп (`quads`, `rampMeshes`, `quadFanOf`, `pushRampLights`,
  `rampTargets` в `layoutLights`).
- `src/client/lighting/lightMath.js` — 969 строк. Половина файла (от `castRay` до конца) — геометрия лучей,
  вееров, засветки и света на клиньях. Остальное — проекция, мерцание, профили, сетки.

Цель по числу строк снимается. Смысл этапа — вынести то, что добавил этап 14.5, по образцу уже вынесенных
`occlusion.js`/`glints.js`/`shafts.js`, и отделить геометрию от «математики света». Публичный API сервиса
`lighting` не меняется.

### 7.1. `src/client/lighting/rampLights.js` (новый)

```js
// Свет на клиньях рамп сервиса `lighting`: меши `rampLight` на источник и
// полосу (кеш по вееру) и уровни подножия, чьи карты получают свет уровня
// вершины. `getMap()` — текущее состояние карты сервиса, `textures` —
// зарегистрированные текстуры сервиса (живой объект)
export function createRampLights({ getMap, textures }) {
  // … сюда переезжают `quads`, `rampMeshes`, `quadFanOf`, `pushRampLights`
  //   из createLighting.js без изменений, `map` → `getMap()` …

  // уровень вершины -> уровни подножия: их карты кладут источники вершины
  // в `rampLights` (сборка — бывший блок `rampTargets` из `layoutLights`)
  const targets = () => { … };

  return { push: pushRampLights, targets };
}
```

В `createLighting.js`:
- `const rampLights = createRampLights({ getMap: () => map, textures });` рядом с `occlusion`/`glints`;
- в `layoutLights` блок сборки `rampTargets` заменить на `const rampTargets = rampLights.targets();`, а вызовы
  `pushRampLights(…)` — на `rampLights.push(…)`;
- импорты `rampLight`, `frameOf`, `volume as volumeConfig` уходят в `rampLights.js` (`volumeConfig` в
  `createLighting.js` ещё нужен `syncLevels` для `rampSegments`, проверить `grep`).

### 7.2. `src/client/lighting/lightGeometry.js` (новый)

Перенести из `lightMath.js` без изменений тел: `castRay`, `RAMP_CLEARANCE`, `laneBounds`, `laneHeightAt`,
`rampHeight`, `rampBlocks`, `anyCellIn`, `firstHit`, `coneFan`, `coneUv`, `fanUvs`, `WASH_QUAD`, `wallWash`,
`fanIndices`, `clipPolygon`, `rampLight`, `rampWedgePolygon`. Вместе с ними переносятся их импорты (`edgeFace` из
`../wallFace.js`). Шапка нового файла: «Геометрия света фар и рамп: обход сетки лучом, веер видимости,
засветка грани, свет на клине и его контур. Чистые функции, мировые единицы».

Обновить импорты (`grep -rn "from './lightMath.js'\|lighting/lightMath.js" src tests`):
`occlusion.js`, `rampLights.js`, `LevelLightMap.js` (`fanIndices`, `rampWedgePolygon`), тесты. Блоки `describe`
перенесённых функций переложить из `tests/client/lighting/lightMath.test.js` в новый
`tests/client/lighting/lightGeometry.test.js`. В `tests/client/lighting/occlusion.test.js` (этап 5) путь
`vi.mock` и импорта `coneFan` сменить на `lightGeometry.js`.

Документация: `grep -rn "lightMath\.\(castRay\|coneFan\|wallWash\|rampLight\|rampBlocks\|rampHeight\|fanUvs\|coneUv\|firstHit\|anyCellIn\|fanIndices\|rampWedgePolygon\)" docs src`
→ заменить `lightMath.` на `lightGeometry.` в `docs/en|ru/architecture.md` и в комментариях `src/`.

### Проверка этапа

`wc -l src/client/lighting/*.js`: `lightMath.js` — около 400 строк, `createLighting.js` — меньше на
~110 строк. `npx eslint .`, `npm test -- --silent`, `npm run build` — зелёные; число тестов не меньше прежнего.

---

## Этап 8. Итоговая проверка

```bash
npx eslint .
npm test -- --silent
npm run build
```

Ядро не менялось: `npm run core:test`, `npm run core:build`, `npm run sim:scenarios` не нужны.

**Вручную** (`npm run dev`, карта `downtown`, ночь), потому что композитинг PixiJS юнит-тесты не ловят:
1. Фары у стен: веер обрывается на стене, её видимая грань засвечена от подножия вверх, при камере за стеной
   засветки нет (этапы 2, 4).
2. Фары и фонари у рамп: свет на клине в его проекции, мягкий край у бортов, борт насыпи засвечен (этапы 2, 3).
3. Мост и крыши: дыра над игроком открывается плавно, вывески на крыше гаснут вместе с ней (этап 3.2).
4. Днём выстрел в стену: конец трассера и искры на грани (реестр `volumes`, этап 4).
5. Смена карты туда и обратно: стены новой карты сразу загораживают фары, ошибок в консоли нет (этап 4).

Затем перенести этот файл в `plan/done/` (`git mv`, без коммита).

---

## Проверено — замечаний нет

- **Ядро (этап 9).** `decay_slick` в полёте равен прежнему `apply_slick(…, NEUTRAL)`. `input_locked()` сейчас —
  ровно `airborne()`, а в полёте `apply_slick` делал только `decay_slick`. Без карты поверхностей остатка не
  бывает. Защита индекса `slick_type` корректна: ноль отсечён выше, переполнения нет. Порядок вызовов хоста и
  предиктора прежний. `cargo test --workspace`: 397 + 88 зелёные.
- **Этап 1.** `syncFilters` верно переключает цепочку при открытии и закрытии дыры. `destroy` освобождает и
  фильтр дыры, и проходной.
- **Этап 2.** Прозрачность вывесок пишет только `NeonSign`. `_roofAlpha` считается после `updateSeeThrough`,
  поэтому отставания на кадр нет. Режим `'layer'` берёт alpha слоя.
- **Этап 4.** `bakeBlurred` освобождает фигуру и фильтр, параметры выпечки у всех баркеров прежние.
- **Этап 6.** Тень регистрируется один раз и днём снимается. Засвет идёт через общий модуль, список своих фар
  заводится при включении фар.
- **Этап 7.** `tickRate` даёт один шаг на тик для каждой дыры, повторные отрисовки тика получают 0.
- **Этап 10.** Кеш вершин по камере корректен: база и высоты среза неизменны, а нахлёст зависит от масштаба и
  входит в ключ. AABB короткого пути покрывает все клетки, куда могут войти лучи: лучи ограничены
  прямоугольником текстуры, ось упирается не дальше `radius ≤ alongMax`, запас — одна клетка.
- **Этап 13.** UV задаются при сборке. Число копий полосы (`wallStripCopies`) и низ грани `vBottom` согласованы
  между выпечкой и мешем, float-допуск есть.
- **Этап 14 / 14.5.** Грань определяется через `edgeFace` с допуском 1e-3 на точках `Float32Array` веера, этого
  хватает при размерах карт до ~2000 единиц. Отвёрнутые квады засветки получают вырожденные индексы и
  переписываются только при смене стороны.
- **Осознанный компромисс.** При попадании в лицевую грань контроллер выстрела целиком поднимается над
  перекрывателем (`WALL_HIT_BASE_Z`). Трассер и вспышка у дула на 45–80 мс рисуются поверх всех стен уровня, а
  не только задетой. Ночью трассер и так эмиссив над картой. Исправлять можно только разнесением кусков по слоям
  (это уже делает `_layerFor`), а цена этого выше пользы.
- **Безопасность.** Новых сетевых входов нет. `volumes.heightAt` на NaN даёт 0 (ключ `NaN,NaN`), ядро больше не
  паникует на чужом `slick_type` из дампа.
- **Производительность и масштабируемость.** Веера фар и меши света на клиньях кешируются по источнику.
  Движущаяся фара пересчитывает их раз на тик, фар в кадре единицы. Сетки препятствий — типизированные массивы
  `cols × rows` на уровень.
- **Форматирование.** Своего конфига prettier в репозитории нет, в CI форматирование не проверяется. По
  домашнему `~/.prettierrc.mjs` расходятся уже 20 файлов `src/`, в том числе новые модули освещения. В план это
  не входит: решение о форматтере проекта — отдельная задача.

## Риски

1. **Этап 2.** Высоты засветки теперь абсолютные. Если где-то останется `item.level + heights[v]`, свет на стене
   уровня ≥ 1 поднимется дважды. Это ловит тест `wallWash` с `level: 1` и тест `layoutWashes` на уровне 1.
2. **Этап 4.** Без проверки `volumesVersion` в раннем выходе `render()` новый слой подхватится с задержкой в тик.
   Это безвредно, но его ловит отдельный тест. При смене карты старые слои держат свои вклады до `release`, как
   раньше держали `tops` до `releaseMap`: клетки вне новой сетки отсекает `inside()` в `occlusion.sync`.
3. **Этап 5.** `vi.mock` частичного модуля. Если соседний модуль импортирует `coneFan` не из `lightMath.js`
   (после этапа 7 — из `lightGeometry.js`), шпион молчит. Путь мока обязан совпадать с модулем, из которого
   импортирует `occlusion.js`.
4. **Этап 7.** Крупный механический перенос. Делать только отдельным заходом и только после зелёной проверки
   этапов 1–6.

## За рамками

- Находки задачи `ramp-debris-parallax` — в `plan/ramp-debris-review.md`: `raisedPoint` ↔ `reproject`, модель
  высоты пули и коды попадания, грань насыпи рампы как стена, `tracer.height` на картах с другой высотой уровня.
- Засветка граней на уровне из одних крыш не строится: в `push` стоит `map.levels.has(washLevel)`, а
  `layoutWashes` зовётся только для обычных карт. Танк на крыше сейчас невозможен (крыши — верх зданий), поэтому
  это не ошибка. Если появятся проезжие крыши со стенами выше, проверку перевести на `hasLevelMap(map, level)`.
