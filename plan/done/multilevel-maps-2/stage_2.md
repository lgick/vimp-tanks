# Этап 2. E, JS: контекст парта, контракт, capability, релиз

> Статус: код готов и зелёный; открыт только §2.5 — релиз выпускает
> пользователь через `npm run release`.

**Репозиторий:** E. **Зависит от:** 1. **Блокирует:** 3.

**Файлы:** `packages/engine/src/client/main.js` (`applyMapData`,
строки ~573-681), `packages/engine/src/lib/coreConfig.js`,
`packages/engine/src/lib/capabilities.js`,
`packages/engine/src/devtools/contract/rules/e4-map-layers.js`,
`packages/engine/src/devtools/contract/rules/e5-map-radar-walls.js`,
`packages/engine/contract/surface.json`,
`packages/engine/CHANGELOG.md`, `packages/engine/package.json`,
`packages/engine/core/Cargo.toml`, `packages/engine/core/CHANGELOG.md`.

## Цель

Довести данные этапа 1 до клиента, синхронизировать статический
контрактный чекер с рантайм-валидатором и выпустить движок — без этого
танки не собираются.

## 2.1 Высота слоя в контексте парта

`applyMapData` строит контексты рендер-слоёв так (`main.js:~633-673`):

```js
const pushLayers = (levelLayers, levelMap, level, solid, floor) => {
  for (const [layer, tiles] of Object.entries(levelLayers || {})) {
    staticData[`s${staticIndex}`] = {
      type: 'static', spriteSheet, map: levelMap, step, layer, tiles,
      level, solid, floor, physicsStatic, scale,
    };
    staticIndex += 1;
  }
};

pushLayers(layers, map, 0, physicsStatic, []);
for (const [key, levelData] of Object.entries(data.levels || {})) {
  pushLayers(levelData.layers, levelData.map, Number(key),
             levelData.walls || [], levelData.floor || []);
}
```

Добавить шестой аргумент `volumes` и поле в контекст:

```js
const pushLayers = (levelLayers, levelMap, level, solid, floor, volumes) => {
  // ...
  volume: Number(volumes?.[layer]) || 0,
};

pushLayers(layers, map, 0, physicsStatic, [], data.volumes);
// ...
pushLayers(..., levelData.volumes);
```

`scaleMapData` (`host/meta/core/RoundManager.js:4-31`) править **не
нужно**: он возвращает `{ ...mapData, step, physicsDynamic, respawns,
scale }`, поэтому неизвестные поля (в т.ч. `volumes`) доезжают до
`MAP_DATA` как есть. Сегодня это нигде не проверено — закрепить тестом
(`tests/host/...`: карта с произвольным полем сохраняет его в
`scaleMapData`).

Ядру `volumes` не нужен: `main.js` собирает JSON для `clientCore.set_map`
явным списком полей (`map, step, scale, setId, physicsStatic,
physicsDynamic, levels, ramps`) — его не трогаем.

## 2.2 Строка динамики и конфиг падения

* `EngineSim::build_snapshot_blocks` (`core/src/game.rs:307-322`) уже
  спрашивает схему на предмет `optional_from`; научить его так же
  вычислять `with_levels` и передавать флаг в `dynamic_map_data`
  (контракт описан в этапе 1.5).
* Валидатор схемы (`core/src/config.rs`, проверка `optionalFrom` и ширин)
  обязан принять новую форму.
* `packages/engine/src/lib/coreConfig.js` — движковая половина конфига
  получает `mapFallTime` (по умолчанию 0.35). Помнить правило файла:
  известные движковые ключи ставятся **после** `coreParams`, чтобы игра
  не могла подменить движковую часть контракта; `mapFallTime` — движковый
  ключ, а не `coreParams`.
* Проверить симметрию `coreConfig.js` ↔ `clientCoreConfig.js` (кодревью
  7.7 привело их к общему `flat.coreParams` — не разъехаться снова).

## 2.3 Правила контракта E4/E5

`e4-map-layers.js` сегодня проверяет: номера уровней (целые ≥ 1, без
дыр), совпадение размерностей гридов, `walls ⊆ floor`, наличие тайла
рампы в гриде `from`, `dir ∈ north|south|west|east`, форму респаунов и
диапазон их уровня, диапазон `physicsDynamic[].level`, наличие тайлов
слоёв в `spriteSheet.frames`, «рампа приезжает на проходимую поверхность
уровня `to`», «открытый край плиты только над проходимой землёй», рампу
в себя и вне диапазона.

Чего в нём нет и что добавить:

1. **потолок уровней** — E4 никогда не проверял `MAX_LEVELS` (он живёт
   только в Rust). Добавить, иначе стороны разойдутся именно там, где мы
   меняем константу;
2. **промежуточная плита над прогоном рампы** (правило 1.2);
3. **открытый край над нижней плитой** — смягчить нынешнюю проверку по
   правилу 1.3 (`landing_level`, а не только земля);
4. **`volumes`** — ключ есть в `layers` того же уровня, высота в
   `(0, MAX_LEVELS]`.

Тексты сообщений совпадают с Rust по фрагменту `expect` из общего корпуса
фикстур; на каждую новую проверку — по фикстуре (см. этап 1).

`e5-map-radar-walls.js` (стены названы рендер-слоем) смысловых правок не
требует, но обязано пройти по всем уровням `1..N`.

## 2.4 Capability `map.levelsN`

`map.layers` заморожена в реестре (`capabilities.js`, append-only) и в
`surface.json`. Многоуровневость объявляется отдельной возможностью:

```js
// уровней больше двух, многоуровневые рампы, уровень у тел карты, volumes
{ value: 'map.levelsN', since: '0.31.0' },
```

`since` — фактическая версия релиза этого этапа (в прошлой итерации
`map.layers` объявили `0.25.0`, а вышла она в 0.29.0; не повторять).

Танки добавят её в `requires` **всех трёх** мест (манифест + обе
половины плагина) — иначе правило `B2` красное. Пересобрать
`surface.json` (`npm run surface:update`): добавление поверхности
совместимость не ломает, тест `tests/devtools/surface.test.js` пропускает
добавления и валит удаления/изменения формы.

## 2.5 Релиз движка

1. `packages/engine/core/Cargo.toml` → **0.12.0** (ломающее: `RampSample`,
   значение `MAX_LEVELS`, сигнатура `dynamic_map_data`, форма строки
   динамики; правило `core/CHANGELOG.md` — «in `0.x`, a breaking change
   bumps the minor version»).
2. `packages/engine/core/CHANGELOG.md`: `## [Unreleased]` →
   `## [0.12.0] - YYYY-MM-DD`, открыть пустой `## [Unreleased]`.
3. `cargo publish` крейта.
4. `packages/engine/package.json` → **0.31.0**,
   `packages/engine/CHANGELOG.md` так же, публикация npm по
   `docs/en/publishing.md`.
5. Проверить `tests/scaffold/versions.test.js` — снимок
   `versions.generated.json` держит версию крейта и краснел на этом в
   прошлой итерации.
6. Документация движка (можно вместе с этапом 8, но не позже релиза):
   `docs/en|ru/plugin-api.md` (capability, новая строка динамики),
   `configuration.md` (`volumes`, `mapFallTime`), `core.md`
   (`FallModel`, `step_body_level`, `landing_level`), `debugging.md`
   (что появилось в `debug_json`).

## Проверка

```bash
cd /Users/dmitry/Sites/my/vimp \
  && cargo test --workspace --quiet && npx eslint . && npx vitest run \
  && npm run surface:update && git diff --stat packages/engine/contract/surface.json
```

После публикации: в танках `core/Cargo.toml` → `vimp-engine-core = "0.12.0"`,
`cargo update -p vimp-engine-core`, `npm i vimp-engine@0.31.0` (или
`npm link` для локальной работы) — и заработают `npm run core:build`,
`npm run build`, `npm run sim:scenarios`.

## Отклонения

1. **`mapFallTime` заведён и в `gameConfigView.js`** (`FIELDS`, дефолт
   0.35): в `coreConfig.js` значение брать было неоткуда — движковая
   половина собирается из view, а не из сырого `gameConfig`. Путь попал в
   `surface.json` (`gameConfigFields`) — добавление, совместимость не
   ломает. Схема ровно как у `mapScale`: умолчание и в JS, и в Rust.
2. **`applyMapData` тестом не закреплён**: `client/main.js` — модуль с
   сокетами и глобалями, тестов у него в репозитории нет вовсе. Проверено
   тестом ровно то, что план и требовал закрепить, — сохранность
   незнакомых полей карты в `scaleMapData`
   (`tests/host/RoundManager.test.js`).
3. **`### Migration` в журнале крейта** дописан здесь: этап 1 оставил
   `### ⚠️ Breaking` без него, и `tests/scripts/release/changelog.test.js`
   краснел. Раздел описывает переезд игры на новые сигнатуры.
4. **`e5-map-radar-walls.js` не правился**: правило и так обходит
   `levels` целиком (`Object.entries(map.levels)`). Добавлен тест на
   уровень 3, чтобы обход не сузили молча.
5. **`docs/*/debugging.md`**: в `debug_json` нового поля не появилось —
   `map.dynamicLevels` был и раньше. Дописано, что теперь он меняется по
   ходу матча (тела падают).
6. **Релиз (§2.5) не выполнен**: по решению пользователя версии,
   датирование журналов, `versions.generated.json` и публикацию делает
   `npm run release` (он же коммитит и тегает). Файлы версий оставлены
   нетронутыми: `core/Cargo.toml` 0.11.0, `packages/engine/package.json`
   0.30.1. Этап закрывается после его прогона; до этого этап 3 стартовать
   не может.

## Сделано

* `client/main.js`: `pushLayers` получил шестой аргумент `volumes`, парт
  статического слоя — поле `volume` (высота слоя в уровнях, 0 — плоский).
* `lib/gameConfigView.js` + `lib/coreConfig.js`: `mapFallTime` в
  движковой половине конфига ядра (`engine.mapFallTime`).
* `contract/rules/e4-map-layers.js`: потолок `MAX_LEVELS = 8`, рампа
  сквозь плиту промежуточного уровня, высоты `volumes` (уровень 0 и
  каждый уровень), край плиты сверяется с `landing_level`, а не с землёй.
  Все 19 фикстур общего корпуса зелёные с обеих сторон.
* `lib/capabilities.js`: `map.levelsN` (`since: '0.31.0'`);
  `contract/surface.json` пересобран (две добавленные записи).
* Тесты: высоты и незнакомые поля карты в `scaleMapData`, открытый край
  над нижней плитой (E4), обход всех уровней (E5), `mapFallTime` как
  движковый ключ (`coreConfig`). `npx eslint .` чист, `npx vitest run` —
  2318 зелёных, `cargo test --workspace` — 159 зелёных.
* Журналы: `packages/engine/CHANGELOG.md` (`[Unreleased]`),
  `packages/engine/core/CHANGELOG.md` (`### Migration`).
* Документация: `docs/en|ru/plugin-api.md` (capability, `volumes`,
  `volume` в парте, N уровней), `configuration.md` (`mapFallTime`,
  `volumes`), `debugging.md` (`dynamicLevels`).
