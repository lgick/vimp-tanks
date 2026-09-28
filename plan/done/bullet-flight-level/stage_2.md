# Этап 2. Данные: высота танка, высоты стен `game.wallHeights`, проброс в предиктор ✅ выполнен

Контекст — `plan/bullet-flight-level/README.md`, раздел «Модель». Этап только добавляет данные и их чтение.
Поведение выстрела не меняется: данные начнут использоваться на этапе 4.

## 2.1. Высота танка — `turretTop`

Ядро знает высоту ствола (`barrelHeight`), но не высоту танка. Рендер держит её в `tankModel.turretTop`
(`src/config/render.js` ≈ 221, пиксели при базовом size 10): 10 px · size 3 / 10 = 3.0 мировой единицы. Имя
`height` занять нельзя: у `Tank` уже есть поле `height` — размер корпуса в плане (`size · 3`,
`motion::body_size`). Поэтому величина называется `turretTop` / `turret_top`, парой к `tankModel.turretTop`, как
`barrelHeight` — к `tankModel.barrelHeight`.

1. `src/data/models.js`, модель `m1`, сразу после `barrelHeight`:
   ```js
   // высота танка над полом (верх башни), мировые единицы: пуля поражает
   // танк, только если он дорастает до неё (core/src/shot_height.rs,
   // `tank_reaches`). = tankModel.turretTop 10 px · size 3 / 10
   // (src/config/render.js)
   turretTop: 3.0,
   ```
2. `core/src/config.rs`, `ModelConfig`, сразу после `barrel_height` (≈ 52), в том же стиле:
   ```rust
   /// Высота танка над полом (верх башни), мировые единицы (`turretTop`):
   /// пуля поражает танк, только если он дорастает до неё
   /// (`shot_height::tank_reaches`). Нет в конфиге — 0; тогда танк считается
   /// высотой в свой ствол (`Tank::turret_top`).
   #[serde(default)]
   pub turret_top: f32,
   ```
3. `core/src/tank.rs`: приватное поле `turret_top: f32` сразу после `barrel_height` (≈ 120). Заполнить в
   `Tank::new` рядом с `barrel_height: model.barrel_height` (≈ 250): `turret_top: model.turret_top`. Атрибуты — как у
   соседнего `barrel_height` (сейчас их нет). Геттер рядом с `barrel_height()` (≈ 275):
   ```rust
   /// Высота танка над полом, мировые единицы (`ModelConfig::turret_top`),
   /// но не ниже ствола: танк без объявленной высоты достаётся пулей своего
   /// уровня, как прежде.
   pub fn turret_top(&self) -> f32 {
       self.turret_top.max(self.barrel_height)
   }
   ```
4. Фикстуры моделей в Rust-тестах (`grep -rn '"barrelHeight"' core`):
   - `core/tests/sim.rs` ≈ 31 (`"barrelHeight": 2.4`) → добавить `"turretTop": 3.0`;
   - `core/src/bots/controller.rs`, `model()` ≈ 898 (size 2, `"barrelHeight": 2.4`) → `"turretTop": 3.0`. Высота
     задаётся не по `size`: танк не может быть ниже своего ствола;
   - `core/src/client/shot.rs`, `models()` ≈ 898 (size 2, `"barrelHeight": 1.0`) → `"turretTop": 1.25` (то же
     отношение, что 3.0 / 2.4).
5. Страховочный тест — `tests/config/tracer.test.js`, в блок `describe('models.m1.barrelHeight ↔ рендер')`:
   ```js
   it('models.m1.turretTop = tankModel.turretTop · size / 10', () => {
     expect(models.m1.turretTop).toBe((tankModel.turretTop * models.m1.size) / 10);
   });

   it('танк выше своего ствола', () => {
     expect(models.m1.turretTop).toBeGreaterThan(models.m1.barrelHeight);
   });
   ```
   Импорты `models` и `tankModel` в файле уже есть. Комментарий над блоком дополнить: «…и высоту танка
   (`turretTop`) — по ней пуля решает, дорастает ли танк до неё».

## 2.2. Высоты стен — поле карты `game.wallHeights`

Хост получает карту от движка как `GameMap` (`vimp-engine-core` 0.22.6, `src/map.rs` ≈ 1480). `layers` и
`volumes` там **не хранятся**, есть только сырое поле `game` (`GameMap::game_data()`). Игра разбирает `game` сама:
`MapGame` (`core/src/map_game.rs`) на хосте (`TanksSim::rebuild_map_derived`, `core/src/tanks.rs` ≈ 933) и на
клиенте (`ClientMapConfig.game`, `core/src/client/mod.rs` ≈ 68). Поэтому высоты стен едут в `game.wallHeights`.
Их выводит JS из тех же `layers`/`volumes`, по которым клиент рисует объёмы, — второго источника правды нет.
Масштаб карты (`scaleMapData` движка) поле `game` не трогает, а высоты заданы в уровнях и от масштаба не зависят.

Формат: `game.wallHeights = { "<уровень>": { "<тайл>": <высота в уровнях> } }`.
Пример `downtown`: `{ "0": { "<T.WALL>": 1, "<T.CANAL_WALL>": 0.25 }, "1": { "<T.RAILING>": 0.35 } }`.

### JS

1. Новый модуль `src/data/maps/wallHeights.js`:
   ```js
   // Высоты стен карты для ядра: уровень → тайл → высота объёма в уровнях.
   // Выводятся из тех же рендер-слоёв (`layers`: слой → тайлы) и их объёмов
   // (`volumes`: слой → высота), по которым клиент рисует объёмы
   // (src/client/volumes.js), — у уровня 0 и у каждого `levels[N]`. Движок
   // `layers`/`volumes` хосту не передаёт (`GameMap` их не хранит), поэтому
   // высоты едут в игровом поле карты `game.wallHeights`
   // (core/src/map_game.rs). Тайл в нескольких слоях — самый высокий объём,
   // как у `volumes.js`
   export function wallHeightsOf(map) {
     const out = {};
     const add = (level, layers = {}, volumes = {}) => {
       for (const [layer, height] of Object.entries(volumes)) {
         for (const tile of layers[layer] || []) {
           const heights = (out[level] ??= {});

           heights[tile] = Math.max(heights[tile] ?? 0, height);
         }
       }
     };

     add('0', map.layers, map.volumes);

     for (const [level, config] of Object.entries(map.levels || {})) {
       add(String(level), config.layers, config.volumes);
     }

     return out;
   }

   // Карта с `game.wallHeights`; прочие поля `game` сохраняются. Карта без
   // объёмов остаётся как есть: стена без высоты для пули бесконечно
   // высокая (`MapGame::wall_height`)
   export function withWallHeights(map) {
     const wallHeights = wallHeightsOf(map);

     if (Object.keys(wallHeights).length === 0) {
       return map;
     }

     return { ...map, game: { ...map.game, wallHeights } };
   }
   ```
   Если ESLint ругается на `??=` — переписать без него, смысл тот же.
2. `src/data/maps/index.js`: каждую карту обернуть `withWallHeights`, экспорт остаётся объектом имя → карта:
   ```js
   import { withWallHeights } from './wallHeights.js';
   // …прежние импорты карт…

   // `game.wallHeights` — высоты стен для пули (./wallHeights.js)
   export default Object.fromEntries(
     Object.entries({
       canopy,
       downtown,
       garden,
       overpass,
       'pool mini': poolMini,
       terraces,
     }).map(([name, map]) => [name, withWallHeights(map)]),
   );
   ```
   Этот модуль читают `src/config/game.js` (карты хоста и `npm run dev`) и `scripts/export-maps.js`
   (`dist/maps/*.json`), поэтому поле попадает и в сборку, и в standalone.
3. **Фикстуры карт.** `tests/core/fixtures.test.js` требует, чтобы `tests/core/fixtures/{overpass,terraces}.json`
   совпадали с `gameConfig.maps[name]`. Перегенерировать их тем же сериализатором:
   ```bash
   node --input-type=module -e "import { writeFileSync } from 'node:fs'; import maps from './src/data/maps/index.js'; for (const name of ['overpass', 'terraces']) { writeFileSync('tests/core/fixtures/' + name + '.json', JSON.stringify(maps[name])); }"
   ```
   `tests/core/fixtures/layered.json` не трогать: объёмов у него нет, стены бесконечно высокие.
4. Тест `tests/config/wallHeights.test.js`:
   - синтетическая карта: `layers: { 2: [5, 6], 4: [6] }`, `volumes: { 2: 1, 4: 0.25 }`,
     `levels: { 1: { layers: { 4: [9] }, volumes: { 4: 0.35 } } }` → `wallHeightsOf` даёт
     `{ 0: { 5: 1, 6: 1 }, 1: { 9: 0.35 } }` (тайл 6 — максимум из 1 и 0.25);
   - `withWallHeights` сохраняет прежние поля `game` (например, `{ surfaces: {…} }`);
   - карта без `volumes` возвращается тем же объектом (`toBe`);
   - в `src/data/maps/index.js` у `downtown`, `overpass`, `terraces` есть `game.wallHeights`, и у `downtown`
     `wallHeights['0']` содержит значения `1` и `0.25`, а `wallHeights['1']` — `0.35` (проверять по
     `Object.values`, чтобы не импортировать номера тайлов).

### Rust

1. `core/src/map_game.rs`, `struct MapGame`, новое поле (атрибуты `#[serde(rename_all = "camelCase", default)]`
   уже стоят, имя в JSON — `wallHeights`):
   ```rust
   /// Высоты стен для пули: уровень ("0", "1", …) → тайл ("12") → высота
   /// объёма в уровнях. Выводит JS из `layers`/`volumes` карты
   /// (src/data/maps/wallHeights.js): движок их хосту не передаёт.
   pub wall_heights: BTreeMap<String, BTreeMap<String, f32>>,
   ```
2. Метод в `impl MapGame`:
   ```rust
   /// Высота стены тайла `tile` уровня `level`, в уровнях. Тайл без
   /// объявленной высоты — бесконечно высокий: на карте без объёмов (и в
   /// тестовых фикстурах) пулю останавливает любая стена, как прежде.
   /// Зовётся только в воздушном сегменте луча (`shot_height::first_tall_wall`),
   /// по клеткам одного луча — разбор ключей на лету дешёвый.
   pub fn wall_height(&self, level: u8, tile: i32) -> f32 {
       self.wall_heights
           .get(&level.to_string())
           .and_then(|tiles| tiles.get(&tile.to_string()))
           .copied()
           .unwrap_or(f32::INFINITY)
   }
   ```
3. Шапку модуля (`//! … Ядро разбирает только то, что влияет на симуляцию…`) не менять: `wallHeights` влияет на
   симуляцию.
4. Юнит-тесты в `mod tests`:
   - `wall_heights_parse_and_answer`: `{ "wallHeights": { "0": { "1": 1.0, "4": 0.25 }, "1": { "9": 0.35 } } }` →
     `wall_height(0, 1) == 1.0`, `wall_height(0, 4) == 0.25`, `wall_height(1, 9) == 0.35`;
   - `unknown_wall_is_infinitely_tall`: тот же объект → `wall_height(0, 7)` и `wall_height(2, 1)` —
     `f32::INFINITY`; у `MapGame::default()` — тоже `INFINITY`;
   - `broken_game_is_an_error` дополнить: `{ "wallHeights": { "0": { "1": "high" } } }` → `is_err()`.

### Проброс в предиктор выстрела

Предиктор (`ShotPredictor`, `core/src/client/shot.rs`) на этапе 4 спросит высоты стен.

1. `ShotPredictor`: поле `map_game: MapGame` (импорт `crate::map_game::MapGame`) рядом с `levels` (≈ 131) с
   комментарием «игровые данные карты: высоты стен для пули (`MapGame::wall_height`)». В `new` —
   `map_game: MapGame::default()`.
2. `set_map` (≈ 182) → `pub(crate) fn set_map(&mut self, levels: Rc<MapLevels>, map_game: MapGame)`, сохраняет
   оба. Doc-комментарий дополнить: «…и игровые данные карты (высоты стен)».
3. `core/src/client/mod.rs`, `set_map` ≈ 547: `self.shot.set_map(levels);` →
   `self.shot.set_map(levels, cfg.game.clone());`. Строка `self.map_game = cfg.game;` (≈ 550) идёт ниже и
   забирает значение уже после клона — порядок менять не нужно.
4. Тестовый хелпер `apply_map` в `shot.rs` (≈ 1039):
   ```rust
   let mut cfg: ClientMapConfig = serde_json::from_str(json).unwrap();
   let levels = Rc::new(cfg.take_levels());

   shot.set_map(levels, cfg.game.clone());
   ```
   Другие вызовы `ShotPredictor::set_map` найти через `grep -rn "shot.set_map\|\.set_map(Rc" core/src` и обновить
   так же.

Команды: `npm run core:test`, `npx vitest run tests/config tests/core/fixtures.test.js`, `npx eslint .`.

## Критерий готовности

- Поведение игры не изменилось: `npm test -- --silent` и `npm run core:test` зелёные.
- `node --input-type=module -e "import m from './src/data/maps/index.js'; console.log(JSON.stringify(m.downtown.game.wallHeights))"`
  печатает высоты уровней 0 и 1.
- Этап отмечен «✅ выполнен» здесь и в `README.md`.
