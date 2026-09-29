# План: исправления по код-ревью задачи `night-city-fixes-review-2` (коммит f9ba65d)

План самодостаточен: исполнителю не нужен контекст переписки. Перед началом прочитать `CLAUDE.md` в корне
репозитория: там правила кода, тестов, документации en/ru и CHANGELOG. Коммитов не делать, все правки остаются в
рабочем дереве.

## Контекст

Ревью охватывает задачу `plan/done/night-city-fixes-review-2.md` (этапы 1–8), коммит f9ba65d. Её суть:
- `LevelLightMap` получил общие хелперы `growMeshPool`/`showLight`/`projectVertices`;
- высоты засветки `wallWash` стали абсолютными;
- мелкие дубли вынесены: `hasLevelMap`, `holeCenterAlpha`, `map.cellW/cellH`, `laneBounds`/`laneHeightAt`;
- реестр `tops` освещения заменён сервисом `volumes` (`levels()`, `version`);
- появился тест короткого пути окклюзии;
- из комментариев убраны ссылки на этапы;
- свет на клиньях вынесен в `src/client/lighting/rampLights.js`, геометрия — в
  `src/client/lighting/lightGeometry.js`.

**Базовая линия** (HEAD `f9ba65d`, проверено при ревью): `npx eslint .` — чисто; `npx vitest run` — 1048/1048
зелёные (79 файлов). Ядро (`core/`) задача не трогала.

Критических ошибок нет: падений, порчи данных, рассинхрона хоста и реплики, регрессий поведения не найдено. Перенос
кода в `lightGeometry.js` и `rampLights.js` сверен построчно: тела функций не менялись, кроме правок этапа 3.4.
Замечания касаются тестов (главное — не закреплён тестом главный инвариант этапа 4), читаемости и структуры.

### Сводка находок

| # | Важность | Критерий | Суть | Этап |
| --- | --- | --- | --- | --- |
| T1 | низкая (выше прочих) | тестируемость, поддерживаемость | Инвариант этапа 4 «свет и выстрел видят одни и те же стены» держится на одной строке `src/client/index.js`: `createLighting(undefined, { levelView, volumes })` и `volumes,` в объекте сервисов — один экземпляр. Тестом это не закреплено. Если кто-то вернёт `volumes: createVolumes()` или забудет передать `volumes` в `createLighting`, фары молча начнут светить сквозь стены: без `deps.volumes` сервис освещения стен не видит. Ни один тест не упадёт | 1 |
| T2 | низкая | тестируемость | Новый модуль `src/client/lighting/rampLights.js` (два кеша: `quads` по источнику и `rampMeshes` по вееру, плюс `targets()`) не имеет своего теста. Прошлое ревью за то же самое отметило `occlusion.js` (L4). Тесты `createLighting.test.js` проверяют результат раскладки, но не то, что стоящий источник не пересобирает меши клина | 2 |
| T3 | низкая | тестируемость, надёжность | Новый тест «wallWash: `level` прибавляется к высотам вершин» (`tests/client/lighting/lightGeometry.test.js`) сравнивает высоты `Float32Array` через `toBe(plain.heights[v] + 1)`. Проходит он по совпадению: при `height: 0.6` сумма точно представима во float32. При объёме стены 0.35 или высоте 0.7 тот же код даёт `false`, это проверено в Node: `f32(1.35) = 1.350000023841858`, а `f32(0.35) + 1 = 1.3499999940395355`. Любая безобидная правка данных теста уронит его | 3 |
| R1 | низкая | DRY, читаемость | Условие «реестр `volumes` правили после последней сборки» записано дважды и по-разному: в `syncLevels` — `volumes && volumes.version !== volumesVersion`, в раннем выходе `render()` — `volumesVersion === (volumes ? volumes.version : null)`. Правка одного без другого даст либо лишнюю пересборку каждый кадр, либо задержку на тик | 4 |
| R2 | низкая | читаемость | `occlusion.sync`: в цикле по `tops` переменная по-прежнему называется `byOwner`, и по ней зовётся `.values()`. После этапа 4 это массив вкладов, а не `Map(owner → …)`. Имя вводит в заблуждение, а `.values()` у массива работает случайно | 4 |
| R3 | низкая | читаемость | Имя `rampLights` теперь значит две разные вещи рядом. Это контейнер `LevelLightMap.rampLights` и экземпляр модуля `createRampLights` в `createLighting.js`. Комментарий «…кладёт его источники в `rampLights`» стоит прямо над `rampLights.targets()` и читается как ссылка на модуль. Та же фраза есть в `rampLights.js` у `targets` | 4 |
| S1 | низкая | структура, поддерживаемость | `frameOf` (раскладка текстуры источника, чистая функция) лежит в `occlusion.js`, и из-за неё `rampLights.js` зависит от модуля окклюзии. Все потребители её результата `frame` (`coneUv`, `fanUvs`, `rampLight`) — в `lightGeometry.js`. Своего теста у `frameOf` нет | 5 |
| S2 | незначительная | простота | У `growMeshPool` параметр-фабрика `indices` ничего не делает. Все три вызывающих (`layoutFans`, `layoutWashes`, `layoutRampLights`) при первой раскладке нового меша заменяют все его буферы, потому что `mesh.shape`/`mesh.wash`/`mesh.ramp` у нового меша `undefined`. Начальные индексы ни разу не рисуются | 5 |
| D1 | незначительная | стандартизация | В трёх абзацах `docs/` новая вставка не перенесена по ширине соседних строк (~80): в строке 110–137 символов. На рендер Markdown это не влияет, но диффы и чтение в редакторе хуже | 6 |

### Ответы на отступления исполнителя из отчёта

- **Этап 2, перенос вызовов `growMeshPool` по строкам.** Принять. После S2 (этап 5) вызовы снова помещаются в
  строку.
- **Этап 3, случайный прогон prettier и откат.** Принять. Дифф f9ba65d проверен: постороннего форматирования в нём
  нет.
- **Этап 6, перенос строки над `TEXTURE_KEYS`.** Принять.
- **Этап 7, префикс `lightGeometry:` в `describe` и порядок функций как в `lightMath.js`.** Принять оба.

## Статус этапов

| # | Этап | Находки | Статус |
| --- | --- | --- | --- |
| 1 | Тест связки сервисов: освещение и части карты делят один `volumes` | T1 | ✅ выполнен |
| 2 | Свой тест модуля `rampLights.js` | T2 | ✅ выполнен |
| 3 | Тест `wallWash` с `level`: сравнение float32 с допуском | T3 | ✅ выполнен |
| 4 | Читаемость: предикат правки `volumes`, имя вкладов в `occlusion.sync`, `rampLights` в комментариях | R1, R2, R3 | ✅ выполнен |
| 5 | Структура: `frameOf` → `lightGeometry.js`, `growMeshPool` без фабрики индексов | S1, S2 | ✅ выполнен |
| 6 | Переносы строк в `docs/` | D1 | ✅ выполнен |
| 7 | Итоговая проверка | — | ✅ выполнен |

Выполненный этап отметить «✅ выполнен» в заголовке и в таблице. Когда выполнены все этапы, перенести файл в
`plan/done/` (`git mv plan/night-city-fixes-review-3.md plan/done/`, без коммита; если файл ещё не в git —
обычный `mv`).

**Порядок.** 1 → 2 → 3 → 4 → 5 → 6 → 7. Этапы независимы по файлам, кроме двух мест:
- этапы 2 и 5 оба касаются `rampLights.js`. Тест этапа 2 мокает `lightGeometry.js` частично (`...actual`), поэтому
  переезд `frameOf` в `lightGeometry.js` на этапе 5 его не ломает;
- этапы 4 и 5 оба правят `rampLights.js`: этап 4 — комментарий у `targets`, этап 5 — импорты.

Номера строк ниже даны по HEAD `f9ba65d`. После правок они сдвигаются, поэтому место искать по фрагменту кода
(`grep -n`).

## Общие правила для исполнителя

1. **Никаких `git commit`.** Изменения остаются в рабочем дереве.
2. **Код**: ES-модули, `===`, только `let`/`const`, фигурные скобки обязательны, без двух заглавных подряд в
   именах. Комментарии в коде — на русском, в стиле окружающего кода (объясняют «почему»). Ширина новых строк
   `src/` — до 80 символов, как у соседних. Своего конфига prettier в репозитории нет, поэтому **prettier по
   файлам целиком не запускать**: он переформатирует посторонний код.
3. **Тесты**: Vitest, файлы в `tests/client/…`, импорты `../../../src/…` (проверять по соседним тестам).
   Частичный мок модуля — `vi.mock(path, async importOriginal => { const actual = await importOriginal();
   return { ...actual, fn: vi.fn(actual.fn) }; })` на верхнем уровне файла, как в
   `tests/client/lighting/occlusion.test.js`.
4. **CHANGELOG.md**: записей **нет** ни у одного этапа. Это тесты, рефакторинг и документация, поведение игры не
   меняется.
5. **Документация**: меняется только на этапе 6 (переносы). Остальные этапы публичного поведения и описанных в
   `docs/` имён не трогают. `frameOf` в `docs/` не упоминается: `grep -rn frameOf docs` пусто.
6. **Проверки в конце каждого этапа** (тихие флаги):
   ```bash
   npx eslint .
   npm test -- --silent
   npm run build      # этапы 4 и 5 (правят src/)
   ```
   Ядро (`core/`) план не трогает: `npm run core:test` и `npm run sim:scenarios` не нужны.

---

## Этап 1. Тест связки сервисов: освещение и части карты делят один `volumes` (T1) ✅ выполнен

### Проблема

`src/client/index.js`, `services(core)` (≈ стр. 88–135):

```js
      const levelView = createLevelView();
      // высоты объёмов карты: пишут слои Map, читают эффект выстрела и
      // освещение (src/client/volumes.js)
      const volumes = createVolumes();
      // ночь и освещение: камеру и прозрачность над игроком берёт у
      // levelView, стены — у volumes
      const lighting = createLighting(undefined, { levelView, volumes });
      …
      return {
        …
        volumes,
        …
      };
```

Части карты (`Map`, `ShotEffect`) получают `services.volumes` из пула зависимостей движка, а освещение —
`deps.volumes`. Это обязан быть один объект. Иначе `MapLayer` пишет стены в реестр, которого освещение не читает.
Тогда `createLighting` видит `volumes === null` или пустой реестр: сетки препятствий фар нет, вершины объёмов не
закрыты. Это видно только глазами ночью.

`tests/client/tanksClientPlugin.test.js` проверяет в `describe('ClientPlugin.hooks.services')` только `levelView`.

### Решение

1. **`tests/client/tanksClientPlugin.test.js`**. Сразу после строки `import { describe, it, expect, vi } from
   'vitest';` и **до** `import clientPlugin from '../../src/client/index.js';` вставить:
   ```js
   // шпион на фабрику освещения: тест связки сервисов смотрит, ЧТО ей
   // передал hooks.services. Поведение фабрики — настоящее
   vi.mock('../../src/client/lighting/createLighting.js', async importOriginal => {
     const actual = await importOriginal();

     return { ...actual, createLighting: vi.fn(actual.createLighting) };
   });
   ```
   После `import clientPlugin …` добавить:
   ```js
   import { createLighting } from '../../src/client/lighting/createLighting.js';
   ```
   `vi.mock` Vitest поднимает над импортами сам. Путь `../../src/client/lighting/createLighting.js` из
   `tests/client/` указывает на тот же файл, что `./lighting/createLighting.js` из `src/client/index.js`, поэтому
   `index.js` получит шпион.

2. Там же, в `describe('ClientPlugin.hooks.services', …)` после теста «отдаёт levelView — …» добавить:
   ```js
   it('освещение получает те же levelView и volumes, что и части', () => {
     const services = clientPlugin.hooks.services(makeCore());
     const [, deps] = createLighting.mock.calls.at(-1);

     // один реестр на свет и выстрел: иначе фары светят сквозь стены,
     // в которые попадает выстрел (src/client/volumes.js)
     expect(deps.volumes).toBe(services.volumes);
     expect(deps.levelView).toBe(services.levelView);
     expect(createLighting.mock.results.at(-1).value).toBe(services.lighting);
   });
   ```
   `makeCore` в файле уже есть (4 метода ядра): `services(core)` с ним работает, это видно по соседнему тесту.

3. **`src/client/lighting/createLighting.js`**, шапка сервиса (≈ стр. 74–75):
   ```js
   // Вершины объёмов и сетку препятствий фар сервис берёт из реестра `volumes`
   // (`deps.volumes`, src/client/volumes.js).
   ```
   заменить на:
   ```js
   // Вершины объёмов и сетку препятствий фар сервис берёт из реестра `volumes`
   // (`deps.volumes`, src/client/volumes.js). Без реестра стен у освещения
   // нет: фары не упираются, вершины объёмов не закрыты. В игре реестр
   // передаёт `hooks.services` (src/client/index.js) — тот же, что у частей.
   ```

### Контрольная проверка

Временно заменить в `src/client/index.js` в возвращаемом объекте `volumes,` на `volumes: createVolumes(),`. Новый
тест обязан упасть на `deps.volumes`. Правку вернуть: `git diff src/client/index.js` должен быть пуст.

### Документация

Не нужна (тест и комментарий).

---

## Этап 2. Свой тест модуля `rampLights.js` (T2) ✅ выполнен

### Проблема

`src/client/lighting/rampLights.js` (132 строки) держит два кеша:
- `quads: WeakMap(light → { key, texture, fan })` — прямоугольник текстуры источника. Пересчитывается, когда
  меняется ключ `kind,x,y,rotation,radius,spread` или текстура;
- `rampMeshes: WeakMap(fan.points → Map(lane → меш | null))` — меши `rampLight`. Промах (`null`) тоже кешируется.

Ещё в модуле есть `targets()`: уровень вершины → уровни подножия. Ни одно из этих свойств не проверено напрямую.
Если сломать кеш (например, ключ `quadFanOf` станет новым на каждом кадре), тесты `createLighting` останутся
зелёными: результат раскладки тот же, просто каждый кадр пересобираются меши.

### Решение — новый файл `tests/client/lighting/rampLights.test.js`

Данные ниже сверены при ревью прогоном настоящего модуля в Node: попадание, промах, кеш, сдвиг, `rampFan`,
`targets()` дают ожидаемое.

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

// шпион на сборку меша клина: кеш `rampMeshes` не зовёт её повторно
vi.mock('../../../src/client/lighting/lightGeometry.js', async importOriginal => {
  const actual = await importOriginal();

  return { ...actual, rampLight: vi.fn(actual.rampLight) };
});

import { rampLight } from '../../../src/client/lighting/lightGeometry.js';
import { createRampLights } from '../../../src/client/lighting/rampLights.js';

const CELL = 10;
// полоса x 20..60, y 0..30, подъём по +x (как в lightGeometry.test.js)
const lane = { axis: 0, sign: 1, from: 0, to: 1, col0: 2, col1: 6, row0: 0, row1: 3 };
// та же полоса далеко: x 500..540 — свет её не задевает
const far = { ...lane, col0: 50, col1: 54 };

// текстуры сервиса: `frameOf` берёт размер текстуры и раскладку пятна
const makeTextures = () => ({
  radial: { texture: { width: 68, height: 68 }, contentSize: 64 },
  cone: {
    texture: { width: 136, height: 136 },
    length: 128,
    halfWidth: 64,
    margin: 4,
  },
});
// фонарь в (40, 15) радиусом 30: прямоугольник текстуры ≈ x 8..72,
// y −17..47 — накрывает полосу `lane` целиком
const lamp = () => ({ kind: 'radial', x: 40, y: 15, radius: 30, rotation: 0 });
const item = (extra = {}) => ({ texture: 'tex', color: 0xffcc88, ...extra });

const setup = (levels = new Map()) => {
  const map = { cellW: CELL, cellH: CELL, levels };
  const textures = makeTextures();
  const rampLights = createRampLights({ getMap: () => map, textures });

  return { rampLights, textures };
};

beforeEach(() => {
  rampLight.mockClear();
});
```

Тесты (`describe('rampLights: свет на клиньях рамп', …)`):

1. **Без полос — ничего.** `setup()`; `target = new Map()`.
   `rampLights.push(target, 0, undefined, lamp(), item(), 1)` и `rampLights.push(target, 0, [], lamp(), item(),
   1)` оба возвращают `false`. `target.size === 0`, `rampLight` не вызван.
2. **Свет задел клин — элемент в карту подножия.** `rampLights.push(target, 0, [lane], lamp(), item(), 0.5)` →
   `true`. `target.get(0)` длины 1. Элемент `toMatchObject({ texture: 'tex', color: 0xffcc88, alpha: 0.5 })`, его
   `ramp` не `null`. `rampLight` вызван 1 раз, а `rampLight.mock.calls[0][0]` —
   `toMatchObject({ lane, cellW: CELL, cellH: CELL, closed: true })`: прямоугольник текстуры замкнут.
3. **Кеш: стоящий источник не пересобирает меш, сдвиг — пересобирает.** Один объект `source = lamp()`. Два
   `push` в разные `Map` (`first`, `second`) с `[lane]`: `rampLight` вызван 1 раз,
   `second.get(0)[0].ramp` `toBe` `first.get(0)[0].ramp`. Затем `source.x += 5` и `push` в `moved`: `rampLight`
   вызван 2 раза, `moved.get(0)[0].ramp` `not.toBe` `first.get(0)[0].ramp`.
4. **Смена текстуры — новый прямоугольник.** `const { rampLights, textures } = setup();`, `source = lamp()`.
   `push(new Map(), 0, [lane], source, item(), 1)`, затем
   `textures.radial = { ...textures.radial, texture: { width: 68, height: 68 } };` (тот же размер, новый объект
   текстуры) и снова `push(…)`. `rampLight` вызван 2 раза. Объект `textures` живой: сервис
   освещения мутирует его в `registerTextures`, модуль держит ссылку.
5. **Мимо клина — `false`, и промах кешируется.** Два `push(target, 0, [far], source, item(), 1)` с одним
   `source`: оба `false`, `target.size === 0`, `rampLight` вызван ровно 1 раз (второй раз `null` берётся из кеша).
6. **Веер окклюзии фары важнее прямоугольника.**
   ```js
   const fan = {
     points: new Float32Array([0, 15, 100, -85, 100, -5, 100, 35, 100, 115]),
     closed: false,
     frame: { x: 0, y: 15, rotation: 0, sx: 1, sy: 1, margin: 4, width: 136, height: 136 },
   };
   const cone = { kind: 'cone', x: 0, y: 15, radius: 100, rotation: 0 };
   ```
   `push(target, 0, [lane], cone, item({ rampFan: fan }), 1)` → `true`. У `rampLight.mock.calls[0][0]` поле
   `points` `toBe(fan.points)`, `frame` `toBe(fan.frame)`, `closed === false`.
7. **`targets()`: уровень вершины → уровни подножия.**
   ```js
   const levelMap = (level, tops) => ({ level, rampLevels: () => new Set(tops) });
   const { rampLights } = setup(
     new Map([
       [0, levelMap(0, [1, 2])],
       [1, levelMap(1, [2])],
       [2, levelMap(2, [])],
     ]),
   );

   expect(rampLights.targets()).toEqual(
     new Map([
       [1, [0]],
       [2, [0, 1]],
     ]),
   );
   ```
   `LevelLightMap.rampLevels()` в коде возвращает `Set` уровней `lane.to`, заглушка повторяет это.

### Контрольная проверка

Временно в `rampLights.js` в `quadFanOf` заменить `if (cached && cached.key === key && …)` на `if (false)`.
Тест 3 обязан упасть: `rampLight` вызовется дважды на стоящем источнике. Правку вернуть: `git diff
src/client/lighting/rampLights.js` должен быть пуст (или содержать только правки этапов 4–5, если они уже сделаны).

### Документация

Не нужна (тесты).

---

## Этап 3. Тест `wallWash` с `level`: сравнение float32 с допуском (T3) ✅ выполнен

### Проблема

`tests/client/lighting/lightGeometry.test.js`, тест «wallWash: `level` прибавляется к высотам вершин» (≈ стр.
483–506), в `describe('lightGeometry: coneFan (reaches/forward) / wallWash')`:

```js
    for (let v = 0; v < plain.heights.length; v += 1) {
      expect(withLevel.heights[v]).toBe(plain.heights[v] + 1);
    }
```

`heights` — `Float32Array`. `wallWash` пишет `heights[v] = level + h`: сумма в double, округлённая во float32
целиком. Тест сравнивает её с `f32(h) + 1` в double. Равенство выполняется только при удачных `h`:
0.6 и 0.25 проходят, а 0.35 и 0.7 нет. Сейчас тест берёт `height: 0.6`, `wallAt: () => 1`, поэтому `h` = 0.6, и
он зелёный по совпадению.

### Решение

Тело теста заменить целиком (аргументы прежние, кроме `wallAt`, который теперь перебирается):

```js
  it('wallWash: `level` прибавляется к высотам вершин', () => {
    const args = {
      x: 0,
      y: 0,
      points: new Float32Array([0, 0, 10, -5, 10, 5, 5, 10]),
      reaches: new Float32Array([100, 100, 100]),
      forward: 3,
      uvOf,
      cellW: CELL,
      cellH: CELL,
      height: 0.6,
    };

    // объём 1 — верх засветки на `height`, объём 0.35 (перила) — на объёме
    for (const wallAt of [() => 1, () => 0.35]) {
      const plain = wallWash({ ...args, wallAt });
      const withLevel = wallWash({ ...args, wallAt, level: 1 });

      for (let v = 0; v < plain.heights.length; v += 1) {
        // высоты во Float32Array: `level + h` округляется целиком и с
        // `plain.heights[v] + 1` совпадает не при всех `h` (0.35 — нет)
        expect(withLevel.heights[v]).toBeCloseTo(plain.heights[v] + 1, 6);
      }

      expect([...withLevel.base]).toEqual([...plain.base]);
      expect([...withLevel.uvs]).toEqual([...plain.uvs]);
      expect([...withLevel.indices]).toEqual([...plain.indices]);
    }
  });
```

`uvOf` и `CELL` уже объявлены в этом `describe` (`const CELL = 10;`, `const uvOf = (x, y) => [x, y];`). При ревью
проверено в Node, что при `wallAt: () => 0.35` засветка не `null`: высоты `[0.35, 0.35, 0, 0]`.

### Контрольная проверка

Временно вернуть `toBe(plain.heights[v] + 1)`: тест обязан упасть на варианте 0.35. Затем вернуть `toBeCloseTo`.

### Документация

Не нужна (тесты).

---

## Этап 4. Читаемость: предикат правки `volumes`, имя вкладов в `occlusion.sync`, `rampLights` в комментариях (R1, R2, R3) ✅ выполнен

### 4.1. Одно условие «реестр `volumes` правили» (R1)

`src/client/lighting/createLighting.js`:
- `syncLevels` (≈ стр. 395–400):
  ```js
      if (volumes && volumes.version !== volumesVersion) {
        volumesVersion = volumes.version;
        masksDirty = true;
      }
  ```
- ранний выход `render()` (≈ стр. 1156–1157):
  ```js
          !masksDirty &&
          volumesVersion === (volumes ? volumes.version : null)
  ```

Решение:
1. Сразу после `const volumeTops = () => volumes?.levels() ?? new Map();` (≈ стр. 325) добавить:
   ```js

   // реестр `volumes` правили после последней сборки вершин объёмов и
   // сетки препятствий фар (без реестра — никогда)
   const volumesChanged = () =>
     volumes !== null && volumes.version !== volumesVersion;
   ```
   `volumes` объявлен как `deps.volumes || null`, поэтому сравнение с `null` точное.
2. В `syncLevels` условие `if (volumes && volumes.version !== volumesVersion) {` заменить на
   `if (volumesChanged()) {`. Тело и комментарий над ним не менять.
3. В `render()` строку `volumesVersion === (volumes ? volumes.version : null)` заменить на `!volumesChanged()`:
   ```js
          !masksDirty &&
          !volumesChanged()
   ```

Эквивалентность:
- без реестра `volumesVersion` всегда `null` (его пишет только ветка `syncLevels` при `volumes !== null` и
  `clear()`), старое условие даёт `null === null`, новое — `!false`;
- с реестром оба условия равны `volumes.version === volumesVersion`.

Тест «слой объёма после первой отрисовки подхватывается без смены камеры» (`createLighting.test.js`) это
покрывает.

### 4.2. Имя вкладов объёмов в `occlusion.sync` (R2)

`src/client/lighting/occlusion.js`, `sync` (≈ стр. 82–85):

```js
    for (const [level, byOwner] of tops) {
      let grid = null;

      for (const { cells, volume } of byOwner.values()) {
```

заменить на

```js
    for (const [level, contributions] of tops) {
      let grid = null;

      for (const { cells, volume } of contributions) {
```

Единственный вызов — `occlusion.sync(volumeTops(), ramps)` в `createLighting.js`. Он передаёт `volumes.levels()`,
то есть `Map(level → [{ cells, volume }])`. `tests/client/lighting/occlusion.test.js` тоже передаёт массивы.
Цикл по `ramps` ниже **не трогать**: там `byOwner` — действительно `Map(owner → lanes)`. Комментарий над `sync`
уже описывает оба формата верно.

### 4.3. `rampLights`: контейнер или модуль (R3)

1. `src/client/lighting/createLighting.js`, `layoutLights` (≈ стр. 565–567):
   ```js
       // клинья рамп: уровень вершины -> уровни подножия, чья карта кладёт
       // его источники в `rampLights`
       const rampTargets = rampLights.targets();
   ```
   комментарий заменить на
   ```js
       // клинья рамп: уровень вершины -> уровни подножия, чья карта кладёт
       // его источники в свой контейнер `LevelLightMap.rampLights`
   ```
2. `src/client/lighting/rampLights.js`, над `const targets = () => {` (≈ стр. 113–114):
   ```js
     // уровень вершины -> уровни подножия: их карты кладут источники вершины
     // в `rampLights`
   ```
   заменить на
   ```js
     // уровень вершины -> уровни подножия: их карты кладут источники вершины
     // в контейнер `LevelLightMap.rampLights`
   ```
3. Имена переменной `rampLights` в `createLighting.js` и поля `LevelLightMap.rampLights` **не менять**: это
   лишний churn. Комментария хватает. Комментарий `LevelLightMap.js` (≈ стр. 234, «источники этих уровней идут в
   `rampLights`») стоит в самом классе и неоднозначности не создаёт, его не трогать.

### Документация

Не нужна (рефакторинг, комментарии).

---

## Этап 5. Структура: `frameOf` → `lightGeometry.js`, `growMeshPool` без фабрики индексов (S1, S2) ✅ выполнен

### 5.1. `frameOf` — к потребителям `frame` (S1)

Сейчас `src/client/lighting/occlusion.js` (≈ стр. 16–50) экспортирует `frameOf` — раскладку текстуры источника
(`{ x, y, rotation, sx, sy, margin, width, height }`). Её используют:
- `occlusion.js`: `occlusionOf`;
- `rampLights.js`: `quadFanOf`, импорт `import { frameOf } from './occlusion.js';`.

Результат `frame` читают `coneUv`, `fanUvs`, `rampLight`, и все они в `lightGeometry.js`. Чистая функция лежит в
модуле с состоянием (кеш вееров, сетки препятствий), и `rampLights.js` из-за неё зависит от окклюзии.

1. **Перенести** из `occlusion.js` в `src/client/lighting/lightGeometry.js` комментарий
   «// Раскладка текстуры источника в мировых единицах — `coneUv`: …» и функцию `export function frameOf(light,
   asset) { … }` целиком, без изменений тела. Вставить **перед** комментарием `coneUv`
   («// UV мировой точки `(px, py)` в текстуре конуса — …», ≈ стр. 291 `lightGeometry.js`), с пустой строкой
   после функции. В `occlusion.js` не должно остаться ни определения, ни пустых строк подряд на его месте.
2. **`occlusion.js`**: в импорт из `./lightGeometry.js` добавить `frameOf`, сохранив алфавитный порядок:
   ```js
   import {
     anyCellIn,
     castRay,
     coneFan,
     coneUv,
     fanUvs,
     firstHit,
     frameOf,
     rampBlocks,
     rampHeight,
     wallWash,
   } from './lightGeometry.js';
   ```
3. **`rampLights.js`**: строки
   ```js
   import { rampLight } from './lightGeometry.js';
   import { frameOf } from './occlusion.js';
   ```
   заменить на
   ```js
   import { frameOf, rampLight } from './lightGeometry.js';
   ```
4. Проверить, что `frameOf` больше никто не импортирует из `occlusion.js`:
   `grep -rn "frameOf" src tests`. Ожидается: `lightGeometry.js` (определение), `occlusion.js` и `rampLights.js`
   (импорт и вызовы), комментарий в `tests/client/lighting/occlusion.test.js` («раскладка текстуры конуса для
   `frameOf`» остаётся верным) и новые тесты ниже. Бочка `src/client/lighting/index.js` уже реэкспортирует
   `lightGeometry.js`, поэтому `frameOf` станет доступен и через неё. Конфликта имён нет: `occlusion.js` бочка не
   реэкспортирует, а в `lightMath.js` `frameOf` нет.
5. Шапку `lightGeometry.js` («Геометрия света фар и рамп: обход сетки лучом, веер видимости, засветка грани, свет
   на клине и его контур. Чистые функции, мировые единицы») дополнить: «…засветка грани, свет на клине и его
   контур, раскладка текстуры источника (`frameOf`). …». Строки держать до 80 символов.
6. **Тесты** — `tests/client/lighting/lightGeometry.test.js`: в список импорта добавить `frameOf` и новый блок
   после `describe('lightGeometry: coneFan / fanUvs / fanIndices', …)`:
   ```js
   describe('lightGeometry: frameOf', () => {
     it('конус: вершина — фара, масштабы по длине и полуширине', () => {
       const asset = {
         texture: { width: 140, height: 60 },
         length: 100,
         halfWidth: 25,
         margin: 20,
       };
       const light = {
         kind: 'cone',
         x: 40,
         y: 48,
         radius: 100,
         spread: 0.5,
         rotation: 0.3,
       };

       expect(frameOf(light, asset)).toEqual({
         x: 40,
         y: 48,
         rotation: 0.3,
         sx: 1,
         sy: 2,
         margin: 20,
         width: 140,
         height: 60,
       });
     });

     it('пятно: без поворота, масштаб по contentSize, вершина в центре', () => {
       const asset = { texture: { width: 68, height: 68 }, contentSize: 64 };
       const light = { kind: 'radial', x: 1, y: 2, radius: 32, rotation: 1 };

       expect(frameOf(light, asset)).toEqual({
         x: 1,
         y: 2,
         rotation: 0,
         sx: 1,
         sy: 1,
         margin: 34,
         width: 68,
         height: 68,
       });
     });
   });
   ```
   Расчёт: у конуса `sx = radius / length = 1`, `sy = radius · spread / halfWidth = 50 / 25 = 2`. У пятна
   `size = 2 · radius / contentSize = 1`, `margin = width / 2 = 34`, поворот всегда 0.
7. `tests/client/lighting/occlusion.test.js` и `rampLights.test.js` (этап 2) мокают `lightGeometry.js` частично
   (`...actual`), поэтому `frameOf` в них настоящий и правок не нужно.

### 5.2. `growMeshPool` без фабрики индексов (S2)

`src/client/lighting/LevelLightMap.js` (≈ стр. 535–551):

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
```

Почему фабрика не нужна: при первой раскладке нового меша каждый вызывающий заменяет все три буфера.
- `layoutFans`: `mesh.shape !== shape` (у нового `undefined`) → `positions`/`uvs`; `mesh.topology !== topology` →
  `indices = fanIndices(rays, closed)`.
- `layoutWashes`: `mesh.wash !== wash` → все три буфера новые.
- `layoutRampLights`: `mesh.ramp !== ramp` → все три.

Начальные индексы (`fanIndices(2)`, `Uint32Array(6)`, `Uint32Array(3)`) ни разу не рисуются. Невидимым меш тоже не
остаётся: цикл раскладки в том же вызове либо настраивает его, либо ставит `visible = false`.

1. Функцию заменить на:
   ```js
   // Пул мешей-добавок света в `container`: растёт до `count`. Меш — режим
   // `add`, пустая текстура, геометрия-заглушка: все её буферы вызывающий
   // заменяет при первой раскладке меша (новый меш не совпадает ни с одним
   // веером, засветкой или клином). Лишние меши прячет вызывающий
   function growMeshPool(pool, container, count) {
     while (pool.length < count) {
       const geometry = new MeshGeometry({
         positions: new Float32Array(6),
         uvs: new Float32Array(6),
         indices: new Uint32Array(3),
       });
       const mesh = new Mesh({ geometry, texture: Texture.EMPTY });

       mesh.blendMode = 'add';
       pool.push(mesh);
       container.addChild(mesh);
     }
   }
   ```
2. Вызовы:
   - `layoutWashes` (≈ стр. 305–310): многострочный `growMeshPool(this.washPool, this.lights, items.length, () =>
     new Uint32Array(6));` → `growMeshPool(this.washPool, this.lights, items.length);`
   - `layoutRampLights` (≈ стр. 378–383) → `growMeshPool(this.rampLightPool, this.rampLights, items.length);`
   - `layoutFans` (≈ стр. 612) → `growMeshPool(pool, container, items.length);`
3. `fanIndices` из импорта `LevelLightMap.js` **не убирать**: он нужен `layoutFans`
   (`geometry.indices = fanIndices(rays, shape.closed)`).
4. Тесты не меняются. Покрытие дают «layoutRampLights переиспользует пул и проецирует высотой вершины»,
   «layoutWashes проецирует абсолютной высотой и прячет отвёрнутый квад», тесты вееров фар у стен
   (`createLighting.test.js`) и «destroy уничтожает геометрию мешей клина».

### Документация

Не нужна (рефакторинг).

---

## Этап 6. Переносы строк в `docs/` (D1) ✅ выполнен

Только перенос по ширине: текст не менять. Ширина соседних строк — до ~80 символов. Правка минимальная: длинная
строка режется на две, следующие строки абзаца не трогаются.

1. `docs/en/configuration.md` (≈ стр. 385; `grep -n "service): over the sources" docs/en/configuration.md`):
   ```
   service): over the sources it draws the cells of every volume tile in the projection `(L + volume) · shear` in `ambient`.
   ```
   →
   ```
   service): over the sources it draws the cells of every volume tile in the
   projection `(L + volume) · shear` in `ambient`.
   ```
2. `docs/ru/configuration.md` (≈ стр. 377; `grep -n "из сервиса \`volumes\`): поверх" docs/ru/configuration.md`):
   ```
   из сервиса `volumes`): поверх источников рисует клетки объёмных тайлов в проекции `(L + volume) · shear` цветом
   ```
   →
   ```
   из сервиса `volumes`): поверх источников рисует клетки объёмных тайлов в
   проекции `(L + volume) · shear` цветом
   ```
3. `docs/ru/architecture.md` (≈ стр. 163; `grep -n "поэтому свет и выстрел видят" docs/ru/architecture.md`):
   ```
   поэтому свет и выстрел видят одни и те же стены. `ShotEffect` распознаёт попадание в стену по геометрии
   ```
   →
   ```
   поэтому свет и выстрел видят одни и те же стены. `ShotEffect` распознаёт
   попадание в стену по геометрии
   ```

Проверка: `git diff --word-diff docs/` — ни одного изменённого слова, только переносы.

---

## Этап 7. Итоговая проверка ✅ выполнен

```bash
npx eslint .
npm test -- --silent
npm run build
```

Ожидается: eslint чисто. Тестов больше 1048: этап 1 добавляет 1, этап 2 — 7, этап 5 — 2, этап 3 меняет
существующий. Файлов 80 (+`rampLights.test.js`). Сборка без ошибок и предупреждений. Ядро не менялось:
`npm run core:test` и `npm run sim:scenarios` не нужны.

**Вручную** (коротко, `npm run dev`, карта `downtown`, ночь), потому что этапы 4–5 правят код рендера:
1. Фары у стен: веер обрывается на стене, грань засвечена (4.1, 4.2, 5.2).
2. Фонари и фары у рамп: свет на клине в его проекции (4.3, 5.1).
3. Консоль без ошибок.

Затем отметить этапы «✅ выполнен» и перенести этот файл в `plan/done/` (`git mv`, без коммита).

---

## Проверено — замечаний нет

- **Этап 1 (M1).** `3 · 12.8 / 0.22 ≈ 174.5`, полуэкран ≈ 193: значения «≈ 175, ~0.9» согласованы в
  `render.js` и обеих `configuration.md`.
- **Этап 2 (L2).**
  - `projectVertices` бит в бит повторяет прежние циклы.
  - `washLevel` в `createLighting.push` и `level` в `occlusion.occlusionOf` считаются одинаково:
    `light.level ?? 0`.
  - Уровень входит в ключ кеша вееров (`…,${level},…`), поэтому засветка с «запечённым» уровнем не устаревает при
    смене уровня фары.
  - Новые меши пула начинают с 6 чисел в `positions`, а не с 8, но заменяются до первой отрисовки.
  - Порядок присваиваний в `showLight` на результат не влияет.
- **Этап 3 (L3).**
  - `hasLevelMap` и `holeCenterAlpha` — те же формулы.
  - `map.cellW/cellH` считаются в `initMap` до первого чтения.
  - `laneBounds`/`laneHeightAt` в `rampHeight`/`rampLight` совпадают бит в бит, в `rampWedgePolygon` разница не
    больше последнего ulp.
  - Место `hasLevelMap` (экспорт `LevelLightMap.js`) выбрано прошлым планом. Чистый предикат мог бы жить и в
    `lightMath.js`, но переносить его ради этого не стоит.
- **Этап 4 (L1).**
  - Смена карты: движок уничтожает все части старой карты до создания новых (так и гоняет
    `createLighting.test.js`). `MapLayer.destroy` зовёт `releaseMap`, затем `volumes.release` → `version += 1`.
  - `clear()` сбрасывает `volumesVersion`. Переключение ключа в `acquireMap` → `initMap` ставит
    `masksDirty = true`. Пересборка вершин и сетки идёт только по смене `version`, то есть при загрузке карты, как
    раньше по `setVolumeTops`.
  - Прежний `setVolumeTops` отбрасывал пустые вклады (`cells.length > 0 && volume > 0`). `MapLayer` регистрирует
    объём только при `volume > 0`. Слой объёма без единого тайла дал бы пустую группу вершин без прогонов — это
    безвредно.
  - Сервис `volumes` создаётся на ядро: в headless-раннере у каждого `VirtualClient` свой.
- **Этап 5 (L4).** Контрольная проверка короткого пути сделана (оба теста падают при `if (false)`). Путь мока
  совпадает с модулем, из которого `occlusion.js` импортирует `coneFan`.
- **Этап 6 (L5).** `grep -rn "этап\|(7.3)" src/client/lighting tests/client/lighting` пусто.
- **Этап 7 (L6).**
  - Перенос в `lightGeometry.js` сверен диффом удалённого и добавленного: отличаются только правки 3.4 и
    заголовки разделов.
  - Имена экспортов `lightMath.js` и `lightGeometry.js` не пересекаются, `export *` в бочке безопасен.
  - Ссылок `lightMath.<перенесённая функция>` в `src/` и `docs/` не осталось.
  - `textures` в `createLighting` — один мутируемый объект (`const textures = {}`), поэтому ссылка на него в
    `createRampLights` не устаревает.
- **Безопасность.** Новых входов (сеть, пользовательские данные) нет.
- **Производительность и масштабируемость.**
  - Ранний выход `render()` читает геттер `version` — O(1).
  - `volumes.levels()` пересобирается лениво, только после правки.
  - Кеши вееров и мешей клина — `WeakMap` по источнику и по массиву точек веера, утечек нет: ключи умирают вместе
    с источником.

## Риски

1. **Этап 1.** `vi.mock` работает, только если путь мока ведёт к тому же файлу, что импорт в `src/client/index.js`.
   Если шпион не сработал, `createLighting.mock` будет `undefined` и тест упадёт на деструктуризации. Тогда
   сверить путь, но не ослаблять проверку.
2. **Этап 2.** Мок `lightGeometry.js` частичный. Если `rampLights.js` станет брать `rampLight` из другого модуля,
   шпион замолчит, и тесты кеша начнут проходить впустую. Контрольная проверка этапа это ловит.
3. **Этап 5.1.** Если вне `src/`/`tests/` что-то импортирует `frameOf` из `occlusion.js` (сейчас нет:
   `grep -rn frameOf` по репозиторию, кроме `plan/`), такой импорт сломается. Сборка (`npm run build`) это покажет.
4. **Этап 5.2.** Поведение PixiJS при начальных индексах `Uint32Array(3)` уже проверено: так до этапа 2 прошлой
   задачи создавался пул клиньев.

## За рамками

- **Форматирование.** Своего конфига prettier в репозитории нет, в CI форматирование не проверяется (как и в
  прошлом плане). Новая строка `createLighting.js` ≈ 660 (`rampLights.push(perRamp, level, lanes, light, item,
  item.alpha * spill)`) — 81 символ. Строка `laneBounds(...)` в `rampWedgePolygon` (`lightGeometry.js` ≈ 40) — 86
  символов, но вся эта функция и до правки шире 80. Решение о форматтере проекта — отдельная задача.
- **Размер клетки через `step · scale`** в `LevelLightMap.setMask/setTops/setRamps`, `lightArea` и
  `rampWedgePolygon`. Прошлый план оставил их сознательно: они работают до `initMap` и получают `step`/`scale`
  параметрами.
- **Засветка граней на уровне из одних крыш** (`map.levels.has(washLevel)` в `push`) — как в прошлом плане: танк
  на крыше сейчас невозможен.
