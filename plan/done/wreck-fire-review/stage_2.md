# Этап 2. Пробелы в тестах `WreckFire` (Т1, Т2) ✅ выполнен

**Файл:** `tests/client/parts/WreckFire.test.js`. Код парта не меняется. Хелперы `ignited`, `onStage`, `run`,
`makeDeps`, `row` (с `vz` после этапа 1) и `scorchesOf` уже есть в файле.

## 2.1. Т2 — пустая проверка

В тесте «без ассета копоти по окончании onRender снят» (стр. 177–189) заменить
`const { wreckScorchTexture, ...noScorch } = assets;` на
`const noScorch = { ...assets, wreckScorchTexture: undefined };` и удалить строку
`expect(wreckScorchTexture).toBeDefined();`.

## 2.2. Новые тесты

Каждый — отдельный `it` в подходящем `describe`.

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

Числа брать из конфига (`wreckFx`, `lighting`), не хардкодить. Сигнатуры хелперов (`ignited(fields, deps)`,
`makeDeps()`) сверить по файлу перед написанием.

## Проверка этапа

`npx eslint . --quiet`, `npm test -- --silent`: зелёные, тестов +6. Документация и CHANGELOG не меняются.

> Общий контекст, находки и правила — в [README.md](README.md).
