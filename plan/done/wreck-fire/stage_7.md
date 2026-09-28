# Этап 7. Документация и журнал изменений ✅ выполнен

Каждая правка — в `docs/en/*` и зеркально в `docs/ru/*` (одинаковая структура).

- `gameplay.md` → «Weapons and the tank», абзац «Health is 100…»: уничтоженный танк взрывается
  (вспышка, огненный шар, искры, клуб чёрного дыма, свой звук; остов подпрыгивает, соседние
  танки качает — только визуально), горит ~9 с, пламя стихает к ~14 с, светлеющий дым
  рассеивается к ~30 с; ночью пожар мерцающе освещает округу; копоть на земле до конца раунда.
  Ссылка на `configuration.md` (`wreckFx`).
- `configuration.md`:
  - сниппет `gameSets` (m1 + `WreckFire`) и фраза «plus smoke, tank tracks and dust» → «…, dust
    and the wreck fire»;
  - абзац `bakedAssets`: `wreckFireTexture` (`lightRadialTexture`), `wreckSmokeTexture`
    (`blurredCircleTexture`), `wreckScorchTexture` (`scorchTexture`) — компонент `WreckFire`;
  - список `componentDependencies` (`renderer`, `soundManager`, `levelView`, `lighting`, `blasts`);
  - новый подраздел `### Wreck fire: wreckFx` (после таблиц 2.5D-рендера, рядом с `blastJolt`) —
    таблица ключей: `enabled`, `referenceSize`, `maxFire`/`maxSmoke`, `wind`, `joltRadius`,
    `sound`, `flash`, `fireball`, `sparks`, `fire` (включая `points`, `spread`, `ramp`), `glow`,
    `smoke` (включая `burst`, `tail`, `burning`/`cooling`), `scorch`; плюс таймлайн по
    умолчанию и бюджет частиц;
  - таблица `blastJolt`, строка `enabled`: реакция и на гибель танка (`wreckFx.joltRadius`);
  - таблица `lighting`: `flash.explosion`, `flash.shot`, `flash.wreck`; новая строка
    `wreckFire` (`radius`, `intensity`, `color`, `flicker`); вводный абзац раздела — «…the
    flashes of `ExplosionEffect`, `ShotEffect` and `WreckFire`»;
  - раздел `sounds.js`: абзац про `tankExplosion` (регистрирует парт `WreckFire`, файл
    `explosion`, тише взрыва бомбы).
- `architecture.md`:
  - абзац о шине `blasts`: её будит и `WreckFire` при гибели танка;
  - «Draw order across levels»: базовые значения + «`WreckFire` 4 (its scorch 2)»;
  - «Lighting (night)» → «Sources»: мерцающий свет пожара и вспышка гибели от `WreckFire`;
  - «Particle systems»: `WreckFire` — два `ParticleChannel` (`parts/ParticleChannel.js`:
    аддитивное пламя и обычный дым), своя высота частицы `h` через `reproject`.
- `extending.md` → «New client entity (part)», абзац о частицах: паттерн
  `Smoke`/`SmokeEffect`/`WreckFire`, для нескольких каналов — `ParticleChannel`.
- `CHANGELOG.md` → `## [Unreleased]` (английский, без тестов/доков/рефакторинга):

  ```md
  ### Added

  - A destroyed tank now explodes: a flash, a fireball, sparks and a burst of
    black smoke, with its own explosion sound; the wreck is tossed up and nearby
    tanks rock. The wreck then burns, the fire dies down after about 14 seconds,
    and the thinning smoke clears about 15 seconds later. At night the fire lights
    its surroundings with a flickering glow. A scorch mark stays on the ground
    until the next round.

  ### Changed

  - A wreck no longer smokes endlessly: its smoke comes from the fire and clears
    on its own.
  ```

- Проектный `CLAUDE.md` не меняется (ни команд, ни зависимостей не добавилось).

> Общий контекст, факты из кода и решение — в [README.md](README.md).
