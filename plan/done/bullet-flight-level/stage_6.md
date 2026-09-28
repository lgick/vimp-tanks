# Этап 6. Документация en/ru, CHANGELOG, итоговая проверка, ручная проверка, архив ✅ выполнен

Контекст — `plan/bullet-flight-level/README.md`. Этап требует этапов 1–5.

Правило `CLAUDE.md`: парные страницы `docs/en/` (канон) и `docs/ru/` правятся одной правкой и сохраняют одинаковую
структуру. Ниже дан английский текст, русский — тот же смысл в парном абзаце `docs/ru/` (места в ru найдены по
`grep`, номера строк указаны примерно). CHANGELOG пишется на английском в `## [Unreleased]`. Тесты, рефакторинг и
`docs/` в него не попадают.

## 6.1. `docs/en/gameplay.md` / `docs/ru/gameplay.md` — «Shooting across levels» / «Стрельба между уровнями»

1. Вводную фразу («A ray always travels at the shooter's level and changes it only by these rules:» / «Луч
   всегда идёт на уровне стрелка и меняет его только по этим правилам:») заменить:
   - en: «A bullet flies at the shooter's gun height, as in GTA 2, and hits only what reaches that height:»
   - ru: «Пуля летит на высоте ствола стрелка, как в GTA 2, и поражает только то, что до этой высоты дорастает:»
2. Строки таблицы:
   - **Slab to slab / По своему уровню** — в конец добавить: en «A shot over another slab of the same level (a
     second bridge) travels on it just the same.» / ru «Над другой плитой того же уровня (вторым мостом) пуля летит
     точно так же.»
   - **Downwards / Вниз** — заменить целиком:
     - en: «**Off a slab** | The bullet does not drop to the level below. Over a cell without a floor of its level
       it flies on at gun height: it passes over tanks, crates and walls lower than itself and hits only what
       reaches it — a wall taller than the bullet or a tank at the very top of a ramp. The tracer stays at the
       height of the level it was fired from.»
     - ru: «**С плиты** | Пуля не падает на уровень ниже. Над клеткой без плиты своего уровня она летит дальше на
       высоте ствола: перелетает танки, ящики и стены ниже себя и поражает только то, что до неё дорастает, —
       стену выше пули или танк у самой верхней кромки рампы. Трассер остаётся на высоте уровня, с которого
       выстрелили.»
   - **Ground to ground / По земле** — без изменений.
   - **Upwards / Вверх** — заменить целиком:
     - en: «**Upwards** | A bullet from below never reaches a tank on a slab above, not even on its very edge: it
       flies under the slab. Only a ramp leads up.»
     - ru: «**Вверх** | Пуля снизу не достаёт танк на плите выше, даже у самой кромки: она летит под плитой.
       Подняться можно только по рампе.»
   - **Tank on a ramp / Танк на рампе** — en «Visible to bullets of every level the run connects, if the bullet
     reaches it over the embankment and does not pass above it.» / ru «Виден пулям всех уровней, которые соединяет
     прогон, если пуля дошла до него над насыпью и не пролетает выше него.»
   - **Ramp embankment / Насыпь рампы** — «A ramp's slope, sides and upper end stop it» → «A ramp's slope and
     sides stop it» / «Склон, борта и верхний торец рампы останавливают её» → «Склон и борта рампы останавливают
     её». Последнее предложение («A shot from the slab goes on down the ramp.» / «Выстрел с плиты идёт вниз по
     рампе дальше.») заменить: en «A shot fired up the slope flies on over the slab the ramp leads to.» / ru
     «Выстрел вверх со склона летит дальше над плитой, на которую ведёт рампа.»
   - новая строка после «Ramp embankment» / «Насыпь рампы»:
     - en: «**Tank on a slope** | Its bullet flies at its own gun height above the slope, so shooting sideways it
       passes over tanks standing on the ground below — the mirror of the embankment rule.»
     - ru: «**Танк на склоне** | Его пуля летит на высоте его ствола над склоном, поэтому, стреляя вбок, он
       перелетает танки, стоящие внизу на земле, — зеркало правила насыпи.»
3. Абзац под таблицей («On a miss the tracer is drawn at the level in force at the **end** of the ray…» / «При
   промахе трассер рисуется на уровне, действующем в **конце** луча…») заменить:
   - en: «On a miss the tracer's end is drawn at the height the bullet flies at the **end** of the ray: a shot
     from a bridge over the ground ends at bridge height, not on the ground.»
   - ru: «При промахе конец трассера рисуется на высоте, на которой пуля летит в **конце** луча: выстрел с моста
     над землёй заканчивается на высоте моста, а не на земле.»
4. Раздел «Bots» / «Боты», пункт «it prefers a target on its own level…» / «предпочитает цель своего уровня…»:
   вторую фразу заменить:
   - en: «A target its bullet does reach is shot at; one the bullet would pass over or under — a ground tank for
     a bot on a bridge or high on a ramp, a tank on a bridge for a bot on the ground — is not.»
   - ru: «По цели, до которой пуля доходит, он стреляет; по той, над которой или под которой пуля пролетела бы, —
     наземному танку для бота на мосту или высоко на рампе, танку на мосту для бота на земле — нет.»

## 6.2. `docs/en/core.md` / `docs/ru/core.md`

1. Схема модулей (≈ 41): строку `shot_levels.rs  # 2.5D shot ray split into single-level segments` → «# 2.5D shot
   ray split into segments by the bullet's height (floor + flight level)» / ru «# луч выстрела по сегментам по
   высоте пули (пол + уровень полёта)». Строку `shot_height.rs` дополнить: «bullet height, ramp embankments, what
   the bullet reaches» / ru по смыслу.
2. Таблица ABI ClientCore (≈ 223): строку `shot_segments(...)` поправить: «…fired from `level` (the bullet flat at
   the shooter's level: the renderer does not know the barrel's tilt), flat `[t0, t1, fly, …]` — the third number
   is the segment's **flight** level, the projection the tracer piece is drawn in…». Новая строка после неё:
   «| `floor_level(level, x, y)` | the floor under a world point for a bullet flying at `level`: `level` itself
   over its own slab, otherwise the landing level (`shot_levels::floor_under`, the rule of the ray segments). The
   shot effect finds a wall or embankment face below a bridge shot by it and drops that shot's debris onto it. No
   map — `level` |». ru — те же две строки по-русски.
3. Раздел «### Shooting and explosions across levels (`core/src/shot_levels.rs`)» / его ru-пара (≈ ru 890).
   Первые три пункта списка (падение, проба, перекрытие сегментов) заменить:
   - en:
     > - The bullet's height along the ray comes from `shot_height::bullet_line` (below). In every cell the
     >   **flight level** `fly` is the highest map level not above the bullet, and the **floor** under it is
     >   `floor_under(fly, cell centre)`: `fly` itself over a slab of that level (the ground is everywhere),
     >   otherwise `landing_level`. A segment `RaySegment { t0, t1, level, fly }` ends where that pair changes;
     >   `fly > level` is an **air segment** — the bullet above a floor below its own level.
     > - So a shot from a bridge does not drop: past the edge it flies on as an air segment and returns to an
     >   ordinary one over another slab of its level. A ground shot passes under the slab — there is no ledge
     >   window any more. A bullet fired up a slope (the barrel tilted with the hull) climbs over the slab the
     >   ramp leads to; one fired down it comes down to the level below. Without a bullet (the renderer's
     >   `shot_segments`) the flight level is the shooter's level.
     > - `level_at_distance()` returns `fly` — the end of a miss is drawn in the flight projection;
     >   `covers_level()` asks about the floor. Each segment is filtered with
     >   `levels_interaction_on_ramp(level_group(segment.level))` — the floor as a body on a ramp run, without
     >   the ramp guards. On a flat map no group filter is set at all and the shooting path stays exactly as it
     >   was.
   - ru — тот же смысл.
4. Подраздел «#### Bullet height and ramp embankments (`core/src/shot_height.rs`)» / ru-пара:
   - пункт `embankment_hit()`: оставить два правила (грань — луч вошёл в прогон снаружи в пределах сегмента;
     склон). Фразу про верхний торец заменить: «The upper end does not stop the bullet: above it is the slab, and
     `ray_segments` lifts the ray onto it.» `EmbankmentHit::level` — `fly` сегмента;
   - новый пункт после него:
     > - What the bullet reaches. A tank is hit in any segment only if it reaches the bullet:
     >   `tank_reaches(z, turret_top, level_height, h)` — the hull top `z + turretTop / level_height` is not
     >   below the bullet at the tank centre's projection onto the ray (`turretTop` of the model,
     >   `src/data/models.js`). In an air segment walls are judged by height — `first_tall_wall()`: the walls of
     >   the levels from the floor up to `fly`, whose top `k + wall_height(k, tile)` is not below the bullet
     >   (`MapGame::wall_height`, `game.wallHeights` of the map; a tile with no height is infinitely tall) — and
     >   props are flown over. In an ordinary segment walls and props stop the bullet as before. The host applies
     >   the tank rule as a Rapier `QueryFilter::predicate`; the tracer's `endLevel` is the segment's `fly`.
   - пункт про `ShotPredictor` и ботов: «…the same model (`turret_top` of a remote tank = own model's ratio to
     `size` times its `size`); a bot does not fire when its bullet would miss the target's floor, pass over or
     under it, or meet the embankment first.»
5. Абзац «`ShotPredictor` cuts its ray with the same `ray_segments()` the host uses…» (≈ en 901, ru 870):
   «…each segment sees only the walls, the boxes and the hulls of its own level» → «…of its floor; a tank only if
   it reaches the bullet, and in an air segment walls by height (`first_tall_wall`, the map's `game.wallHeights`
   via `ShotPredictor::set_map`) and no boxes». «The resulting `startLevel`/`endLevel`…» — `endLevel` is the
   flight level at the end.
6. Раздел «### Bots on the levels» / ru-пара, пункт про `level_at_distance()` заменить:
   - en: «The shot check runs `ray_segments()` with the bot's own bullet: a bot holds fire unless the floor under
     the bullet at the target's distance is one of the levels the target touches (both neighbours for a tank on
     a ramp) and the target reaches the bullet (`tank_reaches`), and keeps driving to it instead.»
   - ru — тот же смысл.
7. Таблица «Tests» (≈ en 1281, строка `core/tests/sim.rs`): «cross-level shots and explosions» → «cross-level shots
   (a bridge shot over the ground, no ledge window) and explosions». ru — так же.

## 6.3. `docs/en/architecture.md` / `docs/ru/architecture.md`

1. Абзац про шину и куски трассера (≈ en 148–156, ru 145–152): «`tracerPieces` turns them into non-overlapping
   pieces: in the edge window the earlier segment wins…» → «`tracerPieces` turns them into non-overlapping pieces
   (a segment's level is its flight level; where segments overlap the earlier one wins), and the last piece takes
   the row's end level.» Предложение «A shot from a bridge runs above the slab and drops beyond the edge…» → «A
   shot from a bridge runs above the slab and on at its height beyond the edge (an air segment); before, the whole
   line was drawn at the end level, under the slab.»
2. Абзац про выстрел в стену (≈ en 158–180, ru 155–173):
   - «…and the cell beyond it is a volume of the end level.» → «…and the cell beyond it is a volume of the floor
     under the bullet (`rampRuns.floorAt` over `ClientCore.floor_level`: a bridge shot's wall stands on the ground
     below).» В описании отвёрнутой грани — силуэт считается от этого пола (`base + volume`);
   - последние два предложения («The impact sparks of a wall hit live in their own `shot-impact` layer…») заменить:
     > The debris of a wall hit is born at the bullet's height on the face (`ImpactEffect`'s `startK`) and falls
     > to the surface under it within `fallDuration` (250 ms). While it falls in front of a visible face the
     > controller stays over the occluder; lying on the floor or behind a face turned away it goes back under it —
     > the side is re-picked every frame (`_placeImpactZ`).
3. Абзац про осколки на поверхности (≈ en 182–190, ru 175–183) дополнить в конце: «The floor under a piece is
   `rampRuns.floorAt(endLevel, x, y)`: the debris of a bridge shot that hit above a lower level (a tank at the top
   of a ramp) is born at the flight level and falls onto the slope or the ground below.»
4. Абзац про выстрел в насыпь (≈ en 192–203, ru 185–194): «`_wallAt` takes that face from `rampRuns.faceAt`» →
   «…from `rampRuns.faceAt` on the floor under the bullet»; «sparks in `shot-impact`» → «debris falling from gun
   height».
5. «Key invariants» (≈ en 725, ru 701), пункт про `ray_segments()`: дополнить «— and `floor_under()`, shared with
   `ClientCore.floor_level`».

## 6.4. `docs/en/configuration.md` / `docs/ru/configuration.md`

1. `### models.js`, после абзаца про `barrelHeight`:
   - en: «`turretTop: 3.0` is the tank's height above the floor (the turret top) in world units: a bullet hits the
     tank only if the tank reaches it (`core/src/shot_height.rs`, `tank_reaches`) — so a bullet from a bridge
     passes over a tank on the ground. It is kept in a pair with the renderer's `tankModel.turretTop` and must stay
     above `barrelHeight` (a guard test checks both).»
   - ru — то же.
2. Абзац о сервисе `rampRuns` (≈ en 183, ru 181): после описания `faceAt` добавить «`floorAt(level, x, y)` — the
   floor under a world point for a bullet flying at `level` (`ClientCore.floor_level`)».
3. Абзац «The 2.5D level travels with the shot blocks as well…» (≈ en 610, ru 603): «…the level the ray started at
   and the one it ended at (they differ where the ray drops off a ledge)» → «…the shooter's level and the level the
   bullet flies at the end of the ray (they differ, for example, for a shot fired up a slope onto a slab)».
4. Таблица 2.5D-полей карты, строка `volumes` / `levels[n].volumes` (≈ en 709, ru 701): «Optional, **visual
   only**…» → «Optional: `zIndex of the render layer` → its height in levels. A layer with a height is extruded by
   `Map` itself… The same heights are the walls' heights for bullets: `src/data/maps/index.js` derives
   `game.wallHeights` from them (below).» ru — то же.
5. Новый подраздел после «#### The 2.5D fields» (перед «#### Surfaces»):
   - en:
     > #### Wall heights for bullets (`game.wallHeights`)
     >
     > `{ "<level>": { "<tile>": <height in levels> } }` — derived, never written by hand:
     > `src/data/maps/wallHeights.js` builds it from `layers`/`volumes` of level 0 and of every `levels[N]`
     > (a tile in several layers takes the tallest), and `src/data/maps/index.js` wraps every map with it. The
     > engine does not hand `layers`/`volumes` to the host core, so the heights travel in `game`. A bullet flying
     > above a lower floor passes over a wall lower than itself; a wall tile without a height is infinitely tall
     > (a map with no volumes stops every shot at every wall, as before).
   - ru — то же.

## 6.5. `docs/en/extending.md` / `docs/ru/extending.md`

1. Пункт **Height for a layer (`volumes`, optional)** (≈ en 51–58, ru 51–58): «Visual only: the core knows
   nothing about the height, and…» → «The height also counts for bullets: a shot flying above a lower floor passes
   over a wall lower than itself (`game.wallHeights` is derived automatically, see
   [configuration.md](configuration.md)). `parts.volume.enabled = false` switches off only the picture.»
2. Пункт **Railings must be part of the slab** (≈ en 93): «otherwise the railing hangs in the air and a shot from
   below does not see it» → «otherwise the railing hangs in the air».

## 6.6. `CHANGELOG.md`, `## [Unreleased]`

Сейчас в разделе (не выпущено): `### Changed` — «Bullets fly at the shooter's gun height…», `### Fixed` — три
пункта про рампу.

1. `### Changed` — добавить после существующего пункта:
   ```markdown
   - A shot fired from a bridge no longer drops to the level below: it flies
     on at gun height, passes over tanks, crates and walls beneath it and
     hits only what reaches it, such as a tank at the very top of a ramp.
   - A tank on a bridge can no longer be hit from the ground, not even on the
     very edge of the slab.
   - A tank high on a ramp shooting sideways passes over tanks on the ground
     below; a shot fired up a ramp flies on over the bridge instead of
     stopping at the ramp's top edge.
   ```
2. `### Fixed`:
   - пункт «A tank on a bridge can shoot down the ramp that leads onto it; the shot used to stop at the bridge
     edge.» удалить: он описывал падение пули, которого больше нет;
   - в пункте «A shot into a ramp ends on the slope or on the embankment face at gun height, with its debris or
     sparks there…» слова «with its debris or sparks there» → «with its debris there»;
   - добавить:
     ```markdown
     - Debris of a wall or embankment hit falls to the ground instead of
       hanging at gun height, where a tank could drive under it.
     ```

## 6.7. Итоговая проверка

Все команды должны быть зелёными:
```bash
npm run core:test
npm run core:build
npx eslint .
npm test -- --silent
npm run build
npm run sim:scenarios
```
Если что-то красное из-за правок этого плана — починить в его рамках. Иначе остановиться и сообщить.

`grep -rn "shot-impact\|probe window\|окно кромки\|ledge window\|drops off a ledge\|падает за кромкой" src core docs tests`
— пусто (кроме переименованных тестов `tracerPieces` про перекрытие сегментов, если в них осталось слово
«перекрытие»).

## 6.8. Ручная проверка (делает пользователь)

`npm run dev`, карта `downtown`, днём и ночью, с ботами (`/bot 4`):
- с моста за кромку и вниз по рампе: трассер на высоте моста, танки и ящики внизу целы, стены земли пуля
  перелетает. Оценить трассер, улетающий за край карты (см. README, «Следствия»);
- танк у самой верхней кромки рампы поражается с моста, пониже — нет;
- с земли танк на мосту не поражается даже у кромки;
- танк на склоне, стреляющий вбок, наземных танков не задевает; выстрел со склона вверх уходит над мостом;
- попадание в стену с земли: осколки падают с высоты ствола к подножию и лежат на полу, танк под ними не проезжает;
  с камерой за стеной лежащие осколки скрыты под крышей;
- попадание в борт насыпи — то же;
- стрельба по земле, по ящикам, по танкам на одном уровне — как раньше; свой и чужой трассеры совпадают;
- карта `terraces`: с уровня 2 пуля перелетает террасу уровня 1 и её перила.

Исполнитель ручную проверку не выполняет — он сообщает пользователю, что её нужно сделать.

## 6.9. Архив

После того как пользователь подтвердит ручную проверку:
1. Отметить этот этап «✅ выполнен» здесь и в `README.md`.
2. `git mv plan/bullet-flight-level plan/done/bullet-flight-level` (без коммита). Если каталог не отслеживается
   git, использовать `mv`.
