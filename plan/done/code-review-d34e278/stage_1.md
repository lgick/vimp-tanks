# Этап 1. Клуб дыма разрыва не работает в игре (Д1) ✅ выполнен

**Файлы:** `src/config/client.js`, `tests/config/client.test.js`, `docs/en/configuration.md`,
`docs/ru/configuration.md`, `docs/en/extending.md`, `docs/ru/extending.md`.

## Проблема (проверено)

- `ShotEffectController._burst` (`src/client/parts/effects/shot/ShotEffectController.js`, ~стр. 721–760) создаёт
  дым, только если есть текстура:

  ```js
  if (this._assets?.smokeTexture && impactSmokeConfig.count > 0) {
    this._burstPending += 1;
    this.hitSmoke = new PuffEffect(x, y, dirX, dirY, partDone, this._assets);
  ```

  `PuffEffect` (`src/client/parts/effects/shot/PuffEffect.js`) читает `assets.smokeTexture` и ждёт объект
  `{ texture, contentSize }`.

- Движок раздаёт запечённые ассеты **по полю `component`** записи. В `vimp-engine/src/client/providers/BakingProvider.js`
  (`bakeAll`) это `this._collection.get(componentName)[assetName] = bakedAsset`. Part получает коллекцию по имени
  своего класса: `vimp-engine/src/client/components/model/Game.js`, `this._assets.get(constructor)`.
- В `src/config/client.js → parts.bakedAssets.vimp` запись `smokeTexture` одна, с `component: 'Smoke'`.
  `ShotEffect` получает только `impactParticleTexture`. Поэтому в игре `this._assets.smokeTexture === undefined`,
  и `PuffEffect` не создаётся ни разу.
- Тесты этого не ловят: `tests/client/parts/effects/ShotEffectController.test.js` подкладывает текстуру вручную
  (набор `withSmoke`, ~стр. 335). Контракт движка C8 (`vimp-engine/src/devtools/contract/rules/c8-baked-assets.js`)
  проверяет только то, что имя записи есть среди бейкеров, а не то, кому она назначена.
- При этом `CHANGELOG.md` (`[Unreleased] → Added`: «…a puff of smoke (`impactSmoke`, …PuffEffect.js)…») и docs
  описывают дым как работающий.
- Остальные части проверены: по `assets.<name>` в `src/client/parts` все прочие потребители получают свои ассеты.
  Несовпадение только у `ShotEffect`/`PuffEffect`.

Имя записи должно остаться `smokeTexture`. Движок берёт бейкер по имени (`this._bakers[assetName]`), в
`src/client/bakers/index.js` есть `smokeTexture: blurredCircleTexture`, а `PuffEffect` читает именно
`assets.smokeTexture`. Текстура запечётся дважды, по разу на компонент: круг радиуса 3, цена ничтожна.
`PuffEffect` наследует `BaseEffect.destroy`, а тот уничтожает детей с `texture: false, textureSource: false`,
поэтому общая текстура не освобождается.

## Решение

### 1.1. Общие параметры текстуры дыма

В `src/config/client.js` между блоком `import … from './render.js';` и комментарием
`// Игровая половина клиентского CONFIG_DATA…` вставить (с пустой строкой до и после):

```js
// белый размытый круг дыма: один рецепт для дыма танка (`Smoke`) и клуба
// разрыва снаряда (`ShotEffect` → PuffEffect)
const smokeTextureParams = {
  radius: 3, // базовый радиус частицы дыма
  blur: 1, // размытие для мягкости
  quality: 40, // проходов размытия
  color: 0xffffff, // цвет для последующего tint'а
};
```

### 1.2. Запись для `Smoke`

Сейчас запись выглядит так (~стр. 84–93):

```js
        {
          name: 'smokeTexture',
          component: 'Smoke',
          params: {
            radius: 3, // базовый радиус частицы дыма
            blur: 1, // размытие для мягкости
            quality: 40, // проходов размытия
            color: 0xffffff, // цвет для последующего tint'а
          },
        },
```

Литерал `params` заменить на `params: smokeTextureParams,`. Комментарии к полям переехали в константу.

### 1.3. Запись для `ShotEffect`

Сразу после записи `impactParticleTexture` (`component: 'ShotEffect'`, ~стр. 58–67) добавить:

```js
        {
          // клуб дыма разрыва (`PuffEffect`): ассеты раздаются по компоненту,
          // поэтому ShotEffect получает свою запись той же текстуры
          name: 'smokeTexture',
          component: 'ShotEffect',
          params: smokeTextureParams,
        },
```

### 1.4. Тест регистрации

В `tests/config/client.test.js` сразу после теста
`'WreckFire зарегистрирован и получает свои сервисы и ассеты'` (тот же `describe`) добавить:

```js
// клуб дыма разрыва: ассеты раздаются по компоненту — без своей записи
// ShotEffect молча остаётся без дыма, и ошибок при этом нет
it('ShotEffect получает текстуру дыма разрыва', () => {
  const names = clientConfig.parts.bakedAssets.vimp
    .filter(asset => asset.component === 'ShotEffect')
    .map(asset => asset.name);

  expect(names).toContain('impactParticleTexture');
  expect(names).toContain('smokeTexture');
  names.forEach(name => expect(bakers[name]).toBeTypeOf('function'));
});
```

`bakers` и `clientConfig` в файле уже импортированы (стр. 2 и 4).

### 1.5. Документация (en + ru)

1. `docs/en/configuration.md`, пункт **`bakedAssets`** (~стр. 179–195). После предложения
   «Each entry: `name` (texture id), `component` (who owns it), `params` (generation parameters).» вставить:

   > Assets are handed out per `component`: a part receives only the entries of its own component, so a texture
   > two parts need is declared twice — `smokeTexture` has one entry for `Smoke` and one for `ShotEffect` (the hit
   > puff, `PuffEffect`), both with the same `params` (`smokeTextureParams`).

   `docs/ru/configuration.md`, тот же пункт (~стр. 180–196), после «Каждая запись: `name` (id текстуры),
   `component` (кому назначена), `params` (параметры генерации).»:

   > Ассеты раздаются по `component`: часть получает только записи своего компонента, поэтому текстура, нужная
   > двум частям, объявляется двумя записями — у `smokeTexture` одна запись для `Smoke` и одна для `ShotEffect`
   > (клуб разрыва, `PuffEffect`), обе с одними `params` (`smokeTextureParams`).

2. `docs/en/extending.md`, шаг 3 списка «new client entity» (~стр. 424–442). В конец шага, после предложения
   «A shape of its own gets a baker of its own — that is what `tankShadowTexture` (the hull silhouette) is.»,
   добавить:

   > The entry's `component` decides who gets the texture: assets are handed out per component, so a texture
   > another part already bakes still needs an entry of your own (the same `name`, your `component`). Without it
   > the part silently gets `undefined` — the engine's `bakedAssets` contract checks only that the name has a
   > baker.

   `docs/ru/extending.md`, шаг 3 (~стр. 417–437), после «У своей фигуры — свой baker: таков `tankShadowTexture`
   (силуэт корпуса).»:

   > Кому достанется текстура, решает `component` записи: ассеты раздаются по компонентам, поэтому для текстуры,
   > которую уже печёт другая часть, всё равно нужна своя запись (то же `name`, свой `component`). Без неё часть
   > молча получит `undefined` — контракт движка `bakedAssets` проверяет только, что у имени есть baker.

Перенос строк в docs — как у соседнего текста (~80 символов). Markdown prettier'ом не форматировать.

### 1.6. CHANGELOG

Не трогать: запись о дыме уже есть в `[Unreleased] → Added`, а функция ещё не выпускалась.

## Проверка

```bash
npx vitest run tests/config/client.test.js tests/client/parts/effects --reporter=dot
npx eslint . --quiet
npx vitest run --reporter=dot
```

Ручная проверка — **для пользователя**, исполнитель dev-сервер не запускает. Команда `npm run dev`, выстрел в
стену: у точки попадания видны пять серых клубов, они разлетаются к стрелку и тают примерно за секунду.

## Критерий готовности

- Новый тест зелёный. Если временно убрать запись из 1.3, он красный.
- `npx eslint . --quiet` и весь `vitest` зелёные.
- Обе пары docs (`configuration.md`, `extending.md`) обновлены в en и ru.
