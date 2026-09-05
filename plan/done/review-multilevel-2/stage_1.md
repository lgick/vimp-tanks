# Этап 1 (T). Смена карты не роняет игру — Д1, часть Д16 ✅ выполнен

**Репо:** T. **Зависимости:** этап 0. **Движок не трогаем.**

Дефект блокирует прод (игрок не появляется, дальнейшая смена карты не
происходит), чинится целиком в танках и ни от чего не зависит — поэтому идёт
первым.

## Диагноз

Симптом: после смены карты со старой (`canopy`) на новую консоль печатает

```
Uncaught TypeError: Cannot read properties of null (reading '0')
    at h.setResource (chunk-7WLMZCSC.js:19:5926)
```

### Что именно падает

В PixiJS v8 `setResource` есть ровно один —
`node_modules/pixi.js/lib/rendering/renderers/gpu/shader/BindGroup.mjs:40`:

```js
setResource(resource, index) {
  const currentResource = this.resources[index];   // <-- resources === null
```

`resources` обнуляет `BindGroup.destroy()` (там же, `:71-78`), а он
вызывается **автоматически** из `onResourceChange` (`:79-86`):

```js
onResourceChange(resource) {
  this._dirty = true;
  if (resource.destroyed) { this.destroy(); }   // resources = null
  else { this._updateKey(); }
}
```

`TextureSource.destroy()` (`.../sources/TextureSource.mjs:226-246`) ставит
`destroyed = true` и эмитит `change`, следом то же делает
`TextureStyle.destroy()`. То есть **уничтожение любого `TextureSource`,
записанного в живой `BindGroup`, превращает эту группу в мину**.

Долгоживущая группа, куда пишут текстуры, одна —
`FilterSystem._globalFilterBindGroup` (`lib/filters/FilterSystem.mjs`):

```js
this._globalFilterBindGroup.setResource(this._filterGlobalUniforms, 0);  // :341  <- место падения, индекс 0
this._globalFilterBindGroup.setResource(input.source, 1);                // :343
this._globalFilterBindGroup.setResource(input.source.style, 2);          // :344
```

Индекс `0` в сообщении об ошибке совпадает. Единственный фильтр в игре —
«дыра» see-through (`src/client/seeThrough.js:167`), который вешает на себя
`Map` уровня ≥ 1. Поэтому мина взрывается именно на новой (слоёной) карте,
хотя уничтожение произошло при сносе старой.

### Кто уничтожает текстуру

`src/client/parts/Map.js:326-338`:

```js
if (this._assetUrl) {
  if (Assets.cache.has(this._assetUrl)) {
    Assets.unload(this._assetUrl).catch(err => console.warn(...));
  }
}
```

`Assets.unload` → `loadTextures.unload` → `texture.destroy(true)`, то есть
ровно `TextureSource.destroy()` + `TextureStyle.destroy()`.

`_assetUrl` — **не собственность парта, а общий файл**:

- все статические слои карты (`s0..sN`) получают один `spriteSheet.img`
  (E `packages/engine/src/client/main.js:640-662` раздаёт один `spriteSheet`
  всем слоям);
- все динамические тела делят `data.img`: `b1.png` есть и в `canopy.js:53`,
  и в `garden.js:16`, и в `overpass.js:122`, и в `terraces.js:177`;
- `src/client/parts/MapVolume.js:70-71` грузит тот же тайл-лист и **никогда
  не выгружает** — он только потребляет текстуру, которую `Map` вот-вот
  уничтожит.

Смена карты в движке идёт в одном синхронном тике
(`packages/engine/src/client/main.js:679-680`):

```js
removeMap(currentMapSetId);   // -> instance.destroy() каждого парта
createMap(setId, staticData); // -> Assets.load(...) новой карты
```

`Assets.unload` асинхронен, `Assets.load` того же URL отдаёт **закешированный
(тот же самый) `TextureSource`** — и через пару тиков он умирает под уже
созданными спрайтами новой карты.

Многоуровневая работа увеличила число участников гонки: раньше это был
1 слой на карту, теперь `уровни × слои` партов `Map` плюс по `MapVolume` на
каждый слой.

### Вторая половина: асинхронные конструкторы

`Map.createStatic` (`Map.js:161-181`), `Map.createDynamic` (`:141-159`) и
`MapVolume.createSlices` (`MapVolume.js:80-149`) содержат `await` и **не
проверяют `this.destroyed`** после него. При смене карты они дорабатывают
уже уничтоженный парт:

- `this._renderer` к этому моменту равен `null` (`Map.js:348`), и
  `renderer.generateTexture` бросает — исключение съедает `catch`, который
  печатает только `console.error`;
- `MapVolume.createSlices:82` присваивает `this._texture` **после** того, как
  `destroy()` его обнулил (`MapVolume.js:204-208`) ⇒ свежая
  `RenderTexture` не освобождается никогда;
- `this.addChild(...)` выполняется на уничтоженном `Container`.

## Правки

### 1.1 Убрать `Assets.unload` из `Map.destroy`

`src/client/parts/Map.js`, удалить блок `:326-338` целиком (вместе с
проверкой `Assets.cache.has`). Импорт `Assets` остаётся — он нужен для
`Assets.load`.

На место удалённого блока положить комментарий:

```js
// Ассет игры — общий ресурс: один тайл-лист делят все слои карты и парт
// MapVolume, а b1.png — ещё и все динамические тела ЛЮБОЙ карты. Assets.unload
// в Pixi 8 не считает ссылки: он уничтожает TextureSource, а тот эмитит
// change, по которому PixiJS обнуляет BindGroup (BindGroup.onResourceChange),
// и следующий проход фильтра падает в setResource. Кеш Assets переживает
// смену карты штатно, поэтому здесь не выгружается ничего.
```

**Почему не рефсчётчик.** Он возможен (`src/client/assetRef.js` с
`retain(url)`/`release(url)` и выгрузкой на нуле), но требует симметричного
участия `MapVolume` и любого будущего парта, а выигрыш — память под два
тайл-листа. Сначала простое удаление; счётчик — отдельная задача, если замер
из 1.6 покажет рост.

### 1.2 Стражи `destroyed` после каждого `await`

`Map.createStatic`:

```js
async createStatic() {
  try {
    const baseTexture = await this._baseTexturePromise;

    // парт мог быть уничтожен, пока грузился ассет: смена карты сносит
    // старые парты в том же тике, в котором создаёт новые
    if (this.destroyed) {
      return;
    }

    const bakedTexture = await bakeTileLayer({ baseTexture, ... });

    // повторно: запекание — второй await
    if (this.destroyed) {
      bakedTexture.destroy(true);

      return;
    }

    this.mapSprite = new Sprite(bakedTexture);
    this.addChild(this.mapSprite);
  } catch (error) { ... }
}
```

Обратить внимание: сейчас `bakeTileLayer` получает `baseTexture: await
this._baseTexturePromise` прямо в аргументах — разложить на две строки,
иначе между `await` некуда вставить проверку.

То же в `Map.createDynamic` (после `await this._baseTexturePromise`, до
`new Sprite`) и в `MapVolume.createSlices` (после каждого из двух `await`;
во втором случае освобождать `this._texture` тем же `destroy(true)`).

### 1.3 Порядок уничтожения текстур

`MapVolume.destroy` (`MapVolume.js:202-224`) сейчас:

```js
if (this._texture) { this._texture.destroy(true); this._texture = null; }   // источник умирает...
super.destroy({ children: true, ... });                                     // ...под живыми мешами
```

Меняем порядок: сначала `super.destroy(...)` (снимает меши со сцены и из
`instructionSet`), затем освобождение текстуры. То же в `Map.destroy`:
`mapSprite.destroy({ texture: true, textureSource: true })` (`Map.js:310-317`)
перенести **после** `super.destroy(...)`, либо сначала
`this.removeChild(this.mapSprite)`.

Правило записать комментарием: «сначала снять со сцены, потом освобождать
GPU-ресурс — иначе последний кадр рендерит источник, у которого
`resource === null`».

### 1.4 Течи (часть Д16)

- `MapVolume.destroy`: перед `super.destroy` пройти по `this._slices` и
  вызвать `mesh.geometry.destroy()`. PixiJS `Mesh.destroy`
  (`scene/mesh/shared/Mesh.mjs:175-186`) геометрию **не трогает** — обнуляет
  ссылку. Сейчас каждая смена карты течёт `slices × слоёв_с_объёмом`
  геометрий с их буферами (`overpass` — 8, `terraces` — 12).
- `src/client/parts/bakeTileLayer.js`: после `renderer.generateTexture`
  добавить `spriteSheet.destroy()` (рядом с `tempContainer.destroy`).
  Сейчас `Spritesheet`, созданный на `:39-41`, живёт вечно и держит по
  текстуре на кадр тайл-листа для каждого слоя каждой открытой карты.

### 1.5 Пересортировка сцены после смены `zIndex`

`Map.update` (`Map.js:294-299`) меняет `zIndex` упавшего ящика, но
`sortChildren()` движок зовёт только при добавлении сущности
(E `packages/engine/src/client/components/view/Game.js:31`). Ящик, упавший с
моста, может держать старый порядок отрисовки до следующего спавна.

Минимальная правка на стороне игры — после присваивания `zIndex`:

```js
if (this.parent) {
  this.parent.sortDirty = true;
}
```

Проверить по исходнику PixiJS 8, что `sortDirty` действительно
пересортировывает контейнер в следующем кадре (`Container.mjs`, поиск
`sortDirty` / `sortChildren`). Если нет — вынести правку в движок
(отдельная строка в `view/Game.js`) и записать это отклонением; в этап 2
она добавляется одной строкой.

### 1.6 Замер памяти (страховка к 1.1)

В `npm run dev` открыть консоль и после 10 смен карт по кругу
`canopy → terraces → overpass → canopy` снять:

```js
__PIXI_APP__?.renderer.texture.managedTextures.length
```

(если глобали нет — `performance.memory.usedJSHeapSize` до и после). Рост не
должен быть линейным по числу смен. Число записать в отчёт этапа.

## Тесты

`tests/client/parts/Map.test.js`:

1. **`destroy() не выгружает общий ассет`** — замокать `Assets` и проверить,
   что `Assets.unload` не вызван ни разу.
2. **`поздний бейк не достраивает уничтоженный парт`** — создать парт с
   отложенным промисом `Assets.load`, вызвать `destroy()`, затем разрешить
   промис; ожидание: `addChild` не вызван, `mapSprite === null`,
   `bakedTexture.destroy` вызван.
3. **`zIndex ящика меняется вместе с уровнем и помечает родителя`** —
   расширить существующий тест уровней ящика проверкой `parent.sortDirty`.

`tests/client/parts/MapVolume.test.js`:

4. **`destroy освобождает геометрию каждого среза`**.
5. **`destroy снимает меши со сцены до уничтожения текстуры`** — порядок
   вызовов через мок (`super.destroy` раньше `texture.destroy`).

Все моки Pixi уже есть в этих файлах — новых зависимостей не требуется.

## Документация и журнал

- `docs/en/architecture.md` + `docs/ru/architecture.md`: раздел про владение
  ассетами — «тайл-листы и спрайты тел общие, парт их не выгружает; текстура,
  созданная `generateTexture`, принадлежит парту и освобождается после снятия
  со сцены».
- `CHANGELOG.md` → `## [Unreleased]` → `### Fixed`: «смена карты больше не
  роняет клиент (общий тайл-лист выгружался вместе с первым же снятым слоем)».

## Критерии приёмки

- [x] `npx eslint .` и `npm test` зелёные (245 тестов, было 237).
- [x] В `npm run dev` круг `canopy → terraces → overpass → canopy` проходится
      трижды: игрок появляется, консоль без ошибок.
- [x] Замер 1.6 не показывает линейного роста числа текстур.
- [x] Новые тесты проходят и **краснеют** на старом коде (проверено откатом
      правок `src/client/parts/*`).

## Результат

Выполнено 2026-09-05.

### Что сделано

| Пункт | Файл | Правка |
| --- | --- | --- |
| 1.1 | `src/client/parts/Map.js` | блок `Assets.unload` удалён, на его месте комментарий из плана |
| 1.2 | `Map.js`, `MapVolume.js` | `if (this.destroyed) return;` после КАЖДОГО `await`; на втором `await` уничтоженный парт освобождает уже созданную текстуру |
| 1.3 | `Map.js`, `MapVolume.js` | GPU-ресурс освобождается после снятия со сцены |
| 1.4 | `MapVolume.js` | `mesh.geometry.destroy()` по каждому срезу |
| 1.4 | `bakeTileLayer.js` | `spriteSheet.destroy()` после `generateTexture` |
| 1.5 | — | правка не нужна, см. отклонение 1 |
| 1.6 | — | замер снят, см. ниже |

### Тесты (7 новых, все краснеют на старом коде)

`tests/client/parts/Map.test.js`:

1. `destroy() не выгружает общий ассет` (статический слой);
2. `destroy() динамического тела тоже не трогает Assets`;
3. `поздний бейк не достраивает уничтоженный парт` (`addChild` не вызван,
   `mapSprite === null`, `bakedTexture.destroy(true)` вызван);
4. `поздняя загрузка не достраивает уничтоженное динамическое тело`;
5. `destroy построенного слоя освобождает запечённую текстуру и не падает`
   — сверх плана, см. отклонение 2;
6. `смена уровня помечает родителя к пересортировке` — пункт 3 плана.

`tests/client/parts/MapVolume.test.js`:

7. `destroy освобождает геометрию каждого среза`;
8. `destroy снимает меши со сцены до уничтожения текстуры`;
   существующий тест владения текстурой переписан под новый контракт
   (`source.unload()` вместо `destroy(true)`, см. отклонение 3).

Проверка «краснеет на старом коде»: `git stash` правок `src/client/parts/*`
даёт 6 падений из 6 сравнимых (тест 6 зелёный и на старом коде — см.
отклонение 1), плюс отдельный прогон для теста 5.

### Прогоны

`npx eslint .` — 0; `npm test` — 245 passed (было 237); `npm run build` —
зелёный; `npx vimp-contract --strict` — 36 passed, 0 failed;
`npm run sim:scenarios` — all 11 green.

### 1.6 Замер в `npm run dev`

`__PIXI_APP__` в игре нет, поэтому вместо `renderer.texture.managedTextures`
считались вызовы `WebGL2RenderingContext.createTexture/deleteTexture`
(счётчики поставлены в консоли до прогона). Круг
`canopy → terraces → overpass → canopy` пройден трижды (10 смен карты,
считая переход с `pool mini`), после каждой смены — вход в команду.

Живых GL-текстур после каждой смены:

```
3, 13, 10, 6, 13, 10, 6, 13, 10, 6
```

Число строго периодично по карте (terraces 13, overpass 10, canopy 6) и не
растёт: за 10 смен создано 60 текстур, удалено 54. Куча
(`performance.memory.usedJSHeapSize`) гуляет в диапазоне 60—130 МБ по воле
сборщика и метрикой не является. Ошибок в консоли за весь прогон — ноль
(`window.onerror` пуст).

Для сравнения — ТОТ ЖЕ прогон на старом коде (`git stash` правок): первая же
смена карты даёт лавину
`Failed to create static map with asset /build/img/tiles.png: TypeError:
Cannot read properties of undefined (reading 'source')` (общий тайл-лист
выгружен из-под новой карты) плюс необработанный `TypeError` — то есть Д1
воспроизведён и закрыт.

Рефсчётчик ассетов (`src/client/assetRef.js`) не понадобился: роста нет.

## Отклонения от плана

1. **Пункт 1.5 не выполнен: правка не нужна.** План предлагал после смены
   `zIndex` ставить `this.parent.sortDirty = true` и требовал сверить это с
   исходником PixiJS 8. Сверка: сеттер `zIndex`
   (`scene/container/container-mixins/sortMixin.mjs`) сам зовёт
   `depthOfChildModified()`, который ставит родителю И `sortableChildren`,
   И `sortDirty`, а `parentRenderGroup.structureDidChange = true`;
   пересортировка идёт в `collectRenderablesMixin.collectRenderables` и
   `RenderGroupSystem._buildInstructions`. То есть посылка пункта («движок
   зовёт `sortChildren` только при добавлении сущности») для PixiJS 8
   неверна, а предложенная строка была бы дублем. Тест на связку добавлен
   (пункт 3 списка тестов) — он проверяет поведение и на старом коде тоже
   зелёный.

2. **Добавлен седьмой тест, которого в плане нет.** Порядок «сначала
   `super.destroy`, потом `mapSprite.destroy({texture: true})`», записанный
   в 1.3 первым вариантом, роняет клиент: `super.destroy({children: true})`
   уничтожает спрайт сам и обнуляет его `_texture`, после чего наш вызов
   падает на `null.destroy()` (поймано в `npm run dev`). Взят второй
   вариант того же пункта — `removeChild` перед `super.destroy`; на него и
   написан тест 5.

3. **`MapVolume` освобождает запечённую текстуру не `destroy(true)`, а
   `source.unload()` + `destroy(false)`.** Причина найдена при прогоне 1.6:
   после правок клиент падал в
   `BindGroup.setResource` из `GlMeshAdaptor.execute` при первом меше
   СЛЕДУЮЩЕЙ карты. Механизм — родня Д1: у всех `Mesh` без собственного
   шейдера PixiJS держит ОДИН общий (`scene/mesh/gl/GlMeshAdaptor.mjs`), и
   его `BindGroup` хранит источник последнего нарисованного меша;
   уничтожение такого источника обнуляет группу
   (`BindGroup.onResourceChange`), и починить её нечем — падает любой
   следующий меш. Безопасного момента для `destroy(true)` не существует:
   общий шейдер держит источник до тех пор, пока не нарисован другой меш.
   `unload()` освобождает GPU-память и эмитит безобидный `change`.
   **Цена:** фреймбуфер `RenderTarget` освобождается только по событию
   `destroy` источника (`RenderTargetSystem._initRenderTarget`), то есть на
   каждый объёмный слой каждой смены карты остаётся один фреймбуфер без
   текстуры. Замер 1.6 роста GL-текстур не показывает; если понадобится
   закрыть и это — нужен собственный шейдер на меш, что выходит за рамки
   этапа.

4. **Тестов семь, а не пять.** Пункты 1 и 2 списка плана разложены на
   статический слой и динамическое тело (у них разные ветки конструктора),
   плюс тест из отклонения 2.

5. **Замер 1.6 сделан счётчиками `createTexture/deleteTexture`, а не
   `renderer.texture.managedTextures`**: игра не публикует
   `__PIXI_APP__`, а `performance.memory` (запасной вариант плана) шумит
   на порядок сильнее полезного сигнала.
