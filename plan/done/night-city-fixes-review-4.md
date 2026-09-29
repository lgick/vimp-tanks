# План: исправления по код-ревью задачи `night-city-fixes-review-3` (коммит 32e229f)

После одобрения план сохраняется в `plan/night-city-fixes-review-4.md`. План самодостаточен. Перед началом
прочитать `CLAUDE.md` в корне репозитория. Коммитов не делать.

## Контекст

Ревью охватывает задачу `plan/done/night-city-fixes-review-3.md` (этапы 1–7), коммит 32e229f.

**Базовая линия** (HEAD `32e229f`, проверено при ревью): `npx eslint .` чисто; `npx vitest run` — 1105/1105
(85 файлов). Ядро (`core/`) задача не трогала.

**Итог.** Критических и значимых ошибок нет. Все семь этапов сделаны строго по плану, это сверено построчно:
- тела `frameOf` и `growMeshPool` совпадают с планом;
- `volumesChanged` эквивалентна обоим прежним условиям: `volumes = deps.volumes || null`, `clear()` сбрасывает
  `volumesVersion`;
- `fanIndices` возвращает `Uint32Array`, тот же тип, что у заглушки пула;
- все три вызывающих `growMeshPool` заменяют буферы нового меша до первой отрисовки;
- в `docs/` word-diff пуст.

Новые тесты действительно ловят поломки, ради которых писались: разбор мутаций ниже, в «Проверено». Осталось три
замечания, все низкой важности или мельче.

### Сводка находок

| # | Важность | Критерий | Суть | Этап |
| --- | --- | --- | --- | --- |
| R1 | низкая | DRY, тестируемость | Раскладку текстуры источника знают два места: `frameOf` (`lightGeometry.js`, мировые единицы; веер фары, засветка грани, свет на клине) и спрайт `itemOf` (`createLighting.js` ≈ 486–531, та же формула в масштабе проекции: `anchorX`, `scaleX/Y`, `spread ?? 0.5`, `rotation \|\| 0`). Связаны они только комментарием «Та же, что у спрайта `itemOf`». Раскладку спрайта не проверяет ни один тест: `scaleX`/`anchorX` в `tests/client/lighting` не встречаются. Разойдутся формулы — фара будет «прыгать» по размеру, подъезжая к стене (спрайт → веер), а свет фонаря на клине не совпадёт с его пятном. Долг старый, но этап 5 прошлой задачи переносил `frameOf` в чистый модуль ровно ради переиспользования, а второй потребитель так и остался копией | 1 |
| F1 | незначительная | стандартизация | В новом `tests/client/lighting/rampLights.test.js` семь строк длиннее 80 символов (81–92), `printWidth: 80` в `~/.prettierrc.mjs`. Причина — фрагменты прошлого плана, исполнитель перенёс их дословно и сам об этом написал. Строку `vi.mock(…)` (82) не трогать: она дословно повторяет `occlusion.test.js` | 2 |
| D1 | незначительная | стандартизация | Минимальный перенос этапа 6 оставил в `configuration.md` рваный хвост абзаца. В ru фраза «цветом `ambient`» разорвана по строкам. В en короткая строка стоит перед следующей фразой | 3 |

### Ответы на отступления исполнителя из отчёта

- **Устаревшая базовая линия (1048 → 1095).** Принять: между f9ba65d и 32e229f вошли `eee8752 wreck-fire` и
  релиз 0.22.11.
- **Строки теста > 80 символов, «взяты из плана дословно».** Принять. Это недочёт прошлого плана, правится на
  этапе 2.
- **`frameOf` в импорте `lightGeometry.test.js` не по алфавиту** (список и раньше был не по алфавиту). Принять.
- **Сборка не запускалась на этапе 2.** Принять, так было по плану.

## Статус этапов

| # | Этап | Находки | Статус |
| --- | --- | --- | --- |
| 1 | Спрайт источника берёт раскладку из `frameOf` | R1 | ✅ выполнен |
| 2 | Переносы длинных строк в `rampLights.test.js` | F1 | ✅ выполнен |
| 3 | Хвосты абзацев в `configuration.md` | D1 | ✅ выполнен |
| 4 | Итоговая проверка | — | ✅ выполнен |

Выполненный этап отметить «✅ выполнен» в заголовке и в таблице. Когда выполнены все этапы, перенести файл в
`plan/done/` (`git mv`, без коммита; если файл ещё не в git — обычный `mv`).

## Общие правила для исполнителя

1. **Никаких `git commit`.**
2. **Код**: стиль окружающего кода. Комментарии — на русском. Новые строки — до 80 символов. Prettier по
   существующим файлам целиком не запускать: своего конфига в репозитории нет, он переформатирует посторонний
   код.
3. **CHANGELOG.md**: записей нет. Это рефакторинг, тесты и переносы в документации, поведение игры не меняется.
4. **Документация**: функционально не меняется, `itemOf`/`frameOf` в `docs/` не упоминаются (`grep -rn` пусто).
5. **Проверки в конце каждого этапа**: `npx eslint .` и `npm test -- --silent`, на этапе 1 ещё `npm run build`.

---

## Этап 1. Спрайт источника берёт раскладку из `frameOf` (R1) ✅ выполнен

### 1.1. Сначала — тест, закрепляющий нынешнее поведение

`tests/client/lighting/createLighting.test.js`:
- после `import LevelLightMap from '../../../src/client/lighting/LevelLightMap.js';` добавить
  `import { frameOf } from '../../../src/client/lighting/lightGeometry.js';`;
- в `describe('lighting: фары и стены', …)` сразу после теста «конус упёрся в стену — веер, в чистом поле — прежний
  спрайт» добавить:

```js
  // спрайт в чистом поле кладёт текстуру так же, как веер фары у стены и
  // свет на клине: раскладка одна — `frameOf` (у спрайта — в масштабе
  // проекции)
  it('спрайты конуса и пятна: раскладка текстуры — frameOf', () => {
    const { service, cone } = scene({ walls: [[15, 15]] });
    const lamp = service.addLight({
      kind: 'radial',
      x: 200,
      y: 200,
      radius: 40,
    });
    const layout = spyLayout();

    frame(service);

    const items = lastItems(layout, 0);

    for (const [light, name] of [[cone, 'cone'], [lamp, 'radial']]) {
      const asset = service.texture(name);
      const item = items.find(entry => entry.texture === asset.texture);
      const expected = frameOf(light, asset);

      expect(item.anchorX).toBe(expected.margin / expected.width);
      expect(item.scaleX).toBe(expected.sx * item.view.scale);
      expect(item.scaleY).toBe(expected.sy * item.view.scale);
      expect(item.rotation).toBe(expected.rotation);
    }
  });
```

Почему данные такие:
- `scene()` возвращает `cone`: это запись `addLight`, то есть тот же объект, что получает `itemOf`;
- стена `[[15, 15]]` далеко, поэтому у конуса спрайт, а не веер;
- фонарь в (200, 200) на экране: камера в начале координат, сцена сдвинута на полэкрана;
- `z` у обоих 0, значит `view.scale = 1`, и `toBe` точен и до рефакторинга, и после;
- отсвета нет (нет упора), поэтому `radial` в кадре уровня 0 — только фонарь.

Тест обязан пройти **до** правки 1.2, потому что он закрепляет нынешнее поведение.

### 1.2. `itemOf` через `frameOf`

`src/client/lighting/createLighting.js`:
1. После `import LevelLightMap, { hasLevelMap } from './LevelLightMap.js';` добавить
   `import { frameOf } from './lightGeometry.js';`.
2. `itemOf` (≈ стр. 484–531, после `// --- раскладка источников ---`) заменить целиком:

```js
  // спрайт источника: проекция, охват на экране и раскладка текстуры
  const itemOf = (light, camera, factor) => {
    const asset = light.kind === 'cone' ? textures.cone : textures.radial;

    if (!asset || !(light.intensity * factor > 0)) {
      return null;
    }

    const view = projectLight(light.x, light.y, light.z ?? light.level, camera, stage, shear);
    // раскладка текстуры — та же, что у вееров фар и света на клиньях
    // (`frameOf`), в масштабе проекции источника
    const frame = frameOf(light, asset);
    const item = {
      reach: light.radius * view.scale * stage.scale.x,
      view,
      texture: asset.texture,
      anchorX: frame.margin / frame.width,
      anchorY: 0.5,
      scaleX: frame.sx * view.scale,
      scaleY: frame.sy * view.scale,
      rotation: frame.rotation,
      color: light.color,
      alpha: light.intensity * factor,
    };

    if (light.kind === 'cone') {
      // веер и упор оси — `occludeItem`, уже после отсечения по экрану
      item.fan = null;
      item.hit = null;
    }

    return item;
  };
```

Строку `projectLight(…)` оставить как есть: она прежняя.

Эквивалентность:
- `reach` вычисляется в том же порядке операций, что и раньше, для обоих видов;
- `anchorX` конуса: `asset.margin / asset.texture.width` = `frame.margin / frame.width`;
- `anchorX` пятна: `(w / 2) / w` = 0.5, и это точно во float;
- `rotation`: `light.rotation || 0` у конуса и 0 у пятна, как в `frameOf`;
- `scaleX/Y`: `(r·s)/L` → `(r/L)·s`, разница только в последнем ulp при `s ≠ 1`. Глазом её не увидеть, тесты на
  точные значения при `z ≠ 0` не завязаны;
- `fan`/`hit` у пятна по-прежнему `undefined`. Читают их по истинности: фильтр `item.fan` в `layout`,
  `item.hit ?` в `bounceOf`.

Производительность: на источник за кадр добавляется один маленький объект `frame`. `itemOf` и так создаёт
объект на каждый вызов, так что это пренебрежимо.

### 1.3. Комментарии `lightGeometry.js`

- Над `frameOf` фразу «Та же, что у спрайта `itemOf` (createLighting.js): у пятна `margin` — полширины, поворота
  нет» заменить на «Её же берёт спрайт `itemOf` (createLighting.js), в масштабе проекции. У пятна `margin` —
  полширины, поворота нет». Строки держать до 80 символов.
- Над `coneUv` «та же раскладка, что у спрайта (`itemOf`)» заменить на «раскладка `frameOf`».

### Контрольная проверка

После 1.2 временно заменить в `itemOf` `anchorX: frame.margin / frame.width` на `anchorX: 0.5`. Новый тест
обязан упасть на конусе. Правку вернуть.

---

## Этап 2. Переносы длинных строк в `rampLights.test.js` (F1) ✅ выполнен

Только переносы и одна перестановка в тесте 1, смысл проверок не меняется. Строку `vi.mock(…)` (стр. 4) не
трогать.

1. `const lane = { axis: 0, … row1: 3 };` → объект по полю на строку (`axis`, `sign`, `from`, `to`, `col0`,
   `col1`, `row0`, `row1`), с запятой после последнего.
2. Тест «без полос — ничего»: две строки `expect(rampLights.push(target, 0, undefined | [], …)).toBe(false);`
   заменить на
   ```js
       // полос нет вовсе или список пуст
       for (const lanes of [undefined, []]) {
         expect(rampLights.push(target, 0, lanes, lamp(), item(), 1)).toBe(false);
       }
   ```
3. `expect(entry).toMatchObject({ texture: 'tex', color: 0xffcc88, alpha: 0.5 });` → объект в три строки.
4. `textures.radial = { ...textures.radial, texture: { width: 68, height: 68 } };` →
   ```js
       textures.radial = {
         ...textures.radial,
         texture: { width: 68, height: 68 },
       };
   ```
5. `frame: { x: 0, … height: 136 },` у `fan` → объект по полю на строку.
6. `expect(rampLights.push(target, 0, [lane], cone, item({ rampFan: fan }), 1)).toBe(true);` →
   ```js
       const occluded = item({ rampFan: fan });

       expect(rampLights.push(target, 0, [lane], cone, occluded, 1)).toBe(true);
   ```
7. `const levelMap = (level, tops) => ({ level, rampLevels: () => new Set(tops) });` →
   ```js
       const levelMap = (level, tops) => ({
         level,
         rampLevels: () => new Set(tops),
       });
   ```

Проверка ширины: скрипт ниже должен напечатать только строку 4 (`vi.mock`).

```bash
node -e 'require("fs").readFileSync("tests/client/lighting/rampLights.test.js","utf8").split("\n").forEach((l,i)=>[...l].length>80&&console.log(i+1,[...l].length))'
```

Тестов по-прежнему 7.

---

## Этап 3. Хвосты абзацев в `configuration.md` (D1) ✅ выполнен

Только переносы, текст не меняется. Дальше конца абзаца правка не уходит.

1. `docs/en/configuration.md` (`grep -n "projection \`(L + volume)" docs/en/configuration.md`), три строки
   ```
   projection `(L + volume) · shear` in `ambient`.
   Headlights of a tank on the ground still light the side walls, but not the
   top of a building.
   ```
   →
   ```
   projection `(L + volume) · shear` in `ambient`. Headlights of a tank on the
   ground still light the side walls, but not the top of a building.
   ```
2. `docs/ru/configuration.md` (`grep -n "проекции \`(L + volume)" docs/ru/configuration.md`), три строки
   ```
   проекции `(L + volume) · shear` цветом
   `ambient`. Фары танка на земле по-прежнему освещают боковые стены, но не верх
   здания.
   ```
   →
   ```
   проекции `(L + volume) · shear` цветом `ambient`. Фары танка на земле
   по-прежнему освещают боковые стены, но не верх здания.
   ```

`docs/ru/architecture.md` не трогать. Разрыв там приходится на границу перед скобкой, а сдвиг потянул бы
перенос всего абзаца, где и до этой задачи были строки по 100 символов.

Проверка: `git diff --word-diff docs/` — ни одного изменённого слова.

---

## Этап 4. Итоговая проверка ✅ выполнен

```bash
npx eslint .
npm test -- --silent
npm run build
```

Ожидается:
- eslint чисто;
- 1106 тестов в 85 файлах (+1 на этапе 1);
- сборка без ошибок и предупреждений;
- ядро не менялось, поэтому `core:test` и `sim:scenarios` не нужны.

**Вручную** (`npm run dev`, `downtown`, ночь), потому что этап 1 правит путь рендера:
1. Фара в открытом поле — прежнего размера и формы.
2. При подъезде к стене конус не «прыгает»: спрайт сменяется веером без скачка.
3. Фонари, в том числе свет на клиньях рамп, — как раньше.
4. Консоль без ошибок.

Затем отметить этапы «✅ выполнен» и перенести план в `plan/done/`.

---

## Проверено — замечаний нет

- **Этап 1 (T1).** Мутации «`volumes: createVolumes()` в объекте сервисов» и «`createLighting` без `volumes`»
  тест ловит. Третья проверка (`results.at(-1).value` против `services.lighting`) не даёт устаревшему вызову из
  другого теста пройти впустую. Путь мока совпадает с импортом `src/client/index.js`.
- **Этап 2 (T2).**
  - Тест 3 ловит поломку любого из двух кешей: новый `points` у `quads` означает промах `rampMeshes`.
  - Тест 4 ловит потерю проверки `cached.texture === asset.texture`.
  - Тест 5 закрепляет кеш промаха `null`.
  - `beforeEach(mockClear)` и `setup()` на каждый тест изолируют состояние.
  - Комментарий о живом `textures` верен: `registerTextures` заменяет `textures[key]`.
- **Этап 3 (T3).** `toBeCloseTo(…, 6)` — допуск 5e-7, ошибка float32 у 1.35 ≈ 6e-8. Пропущенный `level`
  (разница 1) тест по-прежнему ловит.
- **Этап 4.** `volumesChanged` равна обоим прежним условиям, и с реестром, и без. Цикл по `ramps` с настоящим
  `Map(owner → lanes)` не тронут. Комментарии про `LevelLightMap.rampLights` однозначны.
- **Этап 5.**
  - `frameOf` перенесён без изменения тела.
  - Через бочку `lighting/index.js` (`export *`) `frameOf` теперь публичен, конфликта имён нет.
  - Заглушка `Uint32Array(3)` того же типа, что `fanIndices`/`ramp.indices`/засветка.
  - Новый меш в том же вызове либо раскладывается, либо прячется, поэтому заглушку никто не рисует.
- **Этап 6.** Word-diff пуст.
- **Безопасность.** Новых входов нет.
- **Производительность и масштабируемость.** `volumesChanged()` — O(1) на кадр. Пул мешей не изменился по
  поведению.

## Риски

1. **Этап 1.** Если в кадре уровня 0 окажется второй элемент с текстурой `radial` (например, отсвет), `find`
   возьмёт не тот. В `scene({ walls: [[15, 15]] })` упора нет, отсвета тоже. Если тест упадёт на `radial`,
   сначала проверить это, а не ослаблять проверку.
2. **Этап 1.** Разница в последнем ulp у `scaleX/Y` при `z ≠ 0`. Если какой-то тест сравнивает масштаб спрайта
   через `toBe` при ненулевой высоте (при ревью таких не найдено), перейти на `toBeCloseTo` в этом тесте, а не
   откатывать рефакторинг.

## За рамками

- **`plan/wreck-fire-review.md`** попал в коммит 32e229f вместе с этой задачей. Это план другой задачи, здесь
  его не ревьюим.
- **Длинные строки** вне новых файлов (`createLighting.js`, строка `projectLight(…)` и др., `docs/**`). Это
  старое, решение о форматтере проекта — отдельная задача.
- **Значения по умолчанию `frameOf`** (`rotation || 0`, `spread ?? 0.5`) отдельным тестом не закреплены. Фары
  всегда передают `spread` из конфига, а после этапа 1 значение по умолчанию живёт в одном месте.
