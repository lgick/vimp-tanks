# Этап 5. Танки: разбор `Map.js` на модули ✅ выполнен

> Часть плана `plan/review-multilevel-3/` — см. индекс
> [README.md](README.md) (контекст, таблица пунктов, принятые решения,
> критерии приёмки). Этот файл самодостаточен для исполнения этапа.
>
> **E** = `/Users/dmitry/Sites/my/vimp` (крейт `vimp-engine-core` + npm
> `vimp-engine`), **T** = `/Users/dmitry/Sites/my/vimp-tanks` (npm
> `@vimp-games/tanks`).
> Коммитов не делать. Любая функциональная правка обновляет `docs/en/` И
> `docs/ru/` и `CHANGELOG.md` под `## [Unreleased]` в том же изменении.
> Пороги `divergence.thresholds` в `tests/scenarios/*.json` не трогать.

Файлы: `src/client/parts/Map.js` → `src/client/parts/map/*`,
`src/client/parts/index.js`, тесты.

## 5.1 Д15 — что не так

`src/client/parts/Map.js` — 1008 строк и пять зон ответственности в одном
классе:

1. **статический слой**: загрузка тайл-листа, запекание
   (`createStatic:233`), параллакс слоя;
2. **динамическое тело карты** (ящик): свой спрайт, свой `update`, своя
   прозрачность (`createDynamic:207`, `_updateDynamicSeeThrough:835`,
   `update:880`);
3. **экструзия объёма**: срезы запечённой текстуры и контейнер-перекрыватель
   со своим `zIndex` и своей жизнью на сцене (`_createExtrusion:288`,
   `_attachOccluder:643`);
4. **клин рампы**: построение мешей, юбка, пересчёт вершин
   (`_createRampMeshes:372`, `_createRampSkirt:511`, `_updateRampMesh:656`);
5. **see-through**: два режима, два экземпляра фильтра «дыры», обратная
   проекция «накрывает ли объём игрока» (`_updateSeeThrough:676` …
   `_applyHole:788`).

Два режима (`data.type === 'static'` / `'dynamic'`) делят один класс, и в
каждом половина полей мертва: у динамики нет `_map`, `_tiles`, `_slices`,
`_occluder`, `_hole`; у статики нет `_x`, `_y`, `_width`, `_height`,
`_rotation`. `destroy` (`Map.js:908-1007`) обслуживает оба сразу и потому
самая хрупкая часть файла — именно в ней жил дефект Д1 прошлой итерации
(падение `BindGroup.setResource` на смене карты).

## 5.2 Ограничение, определяющее форму разбора

**Разделить на два зарегистрированных парта нельзя без правки движка.**
`packages/engine/src/client/main.js:614-632` (`createMap`) отдаёт И
статические данные (`s0..sN`), И динамические (`d0..dN`) в ОДИН и тот же
список имён `gameSets[setId]` — для танков это `c1: ['Map','MapRadar']`,
`c2: ['Map']` (`src/config/client.js:13-14`). Имя парта одно на оба вида
данных.

Поэтому (решение 5): **имя парта `Map` остаётся, внутри — две стратегии.**
`entitiesOnCanvas`, `componentDependencies`, `gameSets` не меняются.

## 5.3 Целевая структура

```
src/client/parts/Map.js            — парт-диспетчер (~80 строк)
src/client/parts/map/MapLayer.js   — стратегия статического слоя
src/client/parts/map/MapObject.js  — стратегия динамического тела
src/client/parts/map/extrusion.js  — геометрия объёма и клина рампы
src/client/parts/map/holeOverlay.js— фильтр «дыры»: состояние и применение
```

**`Map.js` (диспетчер).** Остаётся `extends Container` — движок создаёт
парт как `new Part(data, assets, dependencies, context)` и кладёт результат
на сцену, поэтому подменять экземпляр из конструктора нельзя. Диспетчер:

```js
export default class Map extends Container {
  constructor(data, assets, dependencies) {
    super();

    // база ассетов — единственная проверка, общая обоим режимам
    if (typeof dependencies.assetsBase !== 'string') {
      console.error(/* существующий текст, Map.js:108-112 */);

      return;
    }

    const imageBase = `${dependencies.assetsBase}img/`;

    // стратегия рисует В ЭТОТ контейнер: ей нужны и дети, и zIndex, и
    // alpha, и filters самого парта
    this._mode =
      data.type === 'dynamic'
        ? new MapObject(this, data, dependencies, imageBase)
        : new MapLayer(this, data, dependencies, imageBase);

    // `onRender` у Container — АКСЕССОР, а не метод: назначается только
    // свойством. Метод с этим именем на прототипе подкласса затенил бы
    // сеттер, PixiJS не позвал бы ничего и фича умерла бы молча
    if (this._mode.needsRender) {
      this.onRender = () => this._mode.render();
    }
  }

  update(data) {
    this._mode?.update(data);
  }

  destroy(options) {
    this._mode?.destroy();
    this._mode = null;

    super.destroy({
      children: true,
      texture: false,
      textureSource: false,
      ...options,
    });
  }
}
```

**`MapLayer`** получает `container` (сам парт) и делает всё, что сейчас
делают `createStatic`, `_updateStatic`, `_attachOccluder`,
`_updateSeeThrough`, `_updateLayerSeeThrough`, `_updateOccluderSeeThrough`,
`_volumeHidesPlayer`, `_hasTileAt`, плюс свою часть `destroy`
(перекрыватель, срезы, `mapSprite`, `_rampTexture`).

**`MapObject`** — `createDynamic`, `_updateDynamicSeeThrough`, `update`.

**`extrusion.js`** — чистая геометрия, без обращений к парту:
`buildVolumeSlices({ bakedTexture, level, volume, shear, count, sideTint })`,
`buildRampMeshes({ runs, texture, step, level, shear, baseScale, segments })`,
`buildRampSkirt(surface)`, `updateRampMesh(slice, camera)`. Возвращают
массивы `{ target, k, base, heights, occluder }` — тот же формат, что
сейчас у `_slices`.

**`holeOverlay.js`** — состояние `{ strength, filter, attached }` и
функции `advance(hole, wanted, rate)` + `apply(target, hole, cfg, view,
stage, renderer)` + `dispose(hole, target)`. Сейчас это `_hole`,
`_occluderHole` и `_applyHole` (`Map.js:60-61, 788-829, 908-937`).

## 5.4 Порядок работ (по одному шагу за раз, тесты после каждого)

1. Вынести `extrusion.js` — механический перенос четырёх методов в чистые
   функции. Проверка: `npm test`, `npm run dev` — картинка не изменилась.
2. Вынести `holeOverlay.js`. Проверка та же.
3. Вынести `MapObject.js` (меньшая и полностью независимая половина).
4. Вынести `MapLayer.js`.
5. Свести `Map.js` к диспетчеру.

**Порядок отрисовки трогать нельзя.** Инварианты, которые обязаны
сохраниться дословно:

- `OCCLUDER_BASE_Z = 5` и `zIndex` перекрывателя
  `levelZ(Math.max(layer, OCCLUDER_BASE_Z), level)` (`Map.js:36, 295-298`);
- срезы сортируются по высоте `k` перед добавлением (`Map.js:350`);
- срезы ОБЪЁМА уходят в перекрыватель (сиблинг парта на сцене), клин рампы
  остаётся ребёнком парта (`Map.js:359`);
- юбка клина рисуется раньше его поверхности (её `k` — базовая плоскость);
- порядок освобождения в `destroy`: снять фильтры → снять перекрыватель со
  сцены → обнулить текстуры уцелевших срезов на `Texture.EMPTY` → убрать
  `mapSprite` из детей → `super.destroy` → отдать `rampTexture` и
  `mapSprite` (`Map.js:908-1007`). **`Assets.unload` не звать** — это и
  был дефект Д1 прошлой итерации, комментарий `Map.js:988-994` обязан
  переехать вместе с кодом.

## 5.5 Тесты

`tests/client/parts/Map.test.js` (654 строки прироста в прошлой итерации)
разделяется по новым модулям: `map/MapLayer.test.js`, `map/MapObject.test.js`,
`map/extrusion.test.js`, `map/holeOverlay.test.js`. Ни один существующий
сценарий не удаляется — только переезжает.

Обязателен тест РЕГИСТРАЦИИ колбэка (правило из `CLAUDE.md`): парт,
которому нужен рендер-колбэк, имеет `part._onRender` — проверять
регистрацию, а не только вызов тела.

## 5.6 Проверка этапа 5

```bash
npx eslint . && npm test && npm run build && npx vimp-contract --strict
npm run sim:scenarios
npm run dev     # приёмка: картинка не изменилась ни в чём
```

В `CHANGELOG.md` этап НЕ попадает: рефакторинг без изменения поведения.
Если поведение всё-таки изменилось — значит перенос неточный, а не «стало
лучше».

## 5.7 Результат и отклонения от плана

Сделано по шагам 5.4 (по одному за раз, `eslint` + `npm test` после
каждого):

| Файл | Строк | Что внутри |
| --- | --- | --- |
| `src/client/parts/Map.js` | 81 | диспетчер: проверка `assetsBase`, выбор стратегии, `onRender`, `update`, `destroy` |
| `src/client/parts/map/MapLayer.js` | 576 | статический слой: запёк, параллакс, экструзия, перекрыватель, see-through |
| `src/client/parts/map/MapObject.js` | 154 | динамическое тело (ящик) |
| `src/client/parts/map/extrusion.js` | 309 | чистая геометрия: срезы объёма, клин рампы, юбка, сдвиг вершин |
| `src/client/parts/map/holeOverlay.js` | 80 | «дыра»: состояние, `advance`/`apply`/`dispose` |

Инварианты 5.4 сохранены дословно: `OCCLUDER_BASE_Z = 5` и `zIndex`
перекрывателя, сортировка срезов по `k`, срезы объёма — в перекрыватель, а
клин рампы — в парт, юбка раньше поверхности, порядок освобождения в
`destroy` и комментарий про `Assets.unload`.

Отклонения (с причинами):

1. **Подписи функций отличаются от 5.3.** `buildRampMeshes` не берёт
   `level` (уровень прогона приходит в самом прогоне — `run.from`/`run.to`)
   и берёт `sideTint`/`segments` параметрами: модуль обязан быть чистым, а
   `config/render.js` читает только стратегия. `holeOverlay.apply` получает
   `camera`, а не `renderer` — рендерер в формуле центра дыры не участвует,
   участвует трансформ сцены и центр камеры; добавлен `createHole()`, чтобы
   форма состояния тоже жила в одном месте.
2. **`MapLayer.destroy()` возвращает колбэк.** Инвариант 5.4 требует
   отдавать `rampTexture` и `mapSprite` ПОСЛЕ `super.destroy()` парта, а
   диспетчер зовёт стратегию до него. Всё, что обязано пережить
   `super.destroy`, уходит в возвращаемую функцию — диспетчер зовёт её
   последней.
3. **Разделение тестов.** `tests/client/parts/Map.test.js` (40 сценариев)
   разложен без потерь: 32 → `map/MapLayer.test.js`, 7 →
   `map/MapObject.test.js`, 1 (промах `assetsBase`) остался в
   `Map.test.js` вместе с тремя новыми диспетчерными. Сценарии рампы и
   объёма остались ИНТЕГРАЦИОННЫМИ (через парт): они проверяют слой
   целиком, и переписывание их под прямой вызов чистых функций было бы не
   переездом, а новой проверкой. `map/extrusion.test.js` (7) и
   `map/holeOverlay.test.js` (5) добавлены сверху как юнит-тесты самих
   модулей. Итого 313 → 328 тестов, ни один сценарий не удалён.
   Регистрация `onRender` проверяется по `part._onRender` у обеих стратегий
   (`MapLayer.test.js`, `MapObject.test.js`).
4. **Документация обновлена** (`docs/en|ru/architecture.md`): абзац про
   диспетчер и стратегии, ссылки `Map._volumeHidesPlayer` и `mapSprite`
   переведены на `parts/map/MapLayer.js`. В `CHANGELOG.md` этап не попал —
   поведение не изменилось.

Проверки: `npx eslint .` — чисто; `npm test` — 34 файла, 328 тестов
зелёные; `npm run build` + `npx vimp-contract --strict` — зелёные;
`npm run sim:scenarios` — 12 из 12, `divergence.thresholds` не тронуты.
`npm run dev` (приёмка глазами) остаётся за пользователем.
