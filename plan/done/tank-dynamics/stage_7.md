# Этап 7. Тряска камеры на приземлении (ядро + хост) ✅ выполнен

Вынесен из пункта 5.5 этапа 5. Там тряску предполагалось дёрнуть с клиента,
и этап 5 честно её пропустил: клиентского пути нет.

## Почему отдельный этап

Тряска в этом проекте **авторитетна** и целиком идёт с хоста:

```
CoreEvent::Shake { id, intensity, duration }   core/src/tanks.rs:1261
      ↓  (per-user мета кадра)
поле `shake` в CameraData                       vimp-engine-core/src/snapshot.rs
      ↓
CanvasManager.updateCoords([x, y, reset, shake])   движок, client/components
      ↓
CanvasManager._calculateShakeOffset                движок, model/CanvasManager
```

Партам движок раздаёт только сервисы (`renderer`, `levelView`,
`soundManager`, `localPlayer`, `mapDynamics`, `rampRuns` —
`src/config/client.js`, `serviceNames` в `src/client/index.js`); вызова
«тряхнуть камеру» среди них нет. Значит, приземление обязано стать вторым
источником `CoreEvent::Shake` рядом с `weapon.camera_shake` — это правка
ядра и конфига игры, а не клиентского парта.

Данные для этого уже есть: `LevelEvent::Landed { height, impact }`
(`core/src/level.rs:95`, `impact == |vz|` на касании) собирается в
`TanksSim::update_levels` в вектор `landed` (`core/src/tanks.rs:890`), и по
нему уже раздаётся урон падения (`apply_fall_damage`).

Этап независим от этапа 6 и может идти после него.

## 7.1. Правило — в конфиг, не в константу

`src/config/game.js`, блок `coreParams.levels` (там же, где `fallDamage` и
`jumpClearance`):

```js
// тряска камеры на приземлении: у оружия она задаётся так же
// (`cameraShake` в src/data/weapons.js). Отсутствие блока = тряски нет
landingShake: {
  intensity: 6,      // при полном ударе (те же единицы, что у оружия)
  duration: 300,     // мс
  minImpact: 1.5,    // ниже — мягкое касание, тряски нет
  fullImpact: 6,     // уровней/с, дающие полную интенсивность
},
```

`minImpact`/`fullImpact` численно повторяют `landing` из
`src/config/render.js` (порог просадки, пыли и звука на клиенте). Это
осознанное дублирование, а не недосмотр: `render.js` — клиентский модуль
рендера, `coreParams` едут в WASM, и общего источника у них нет. В
комментариях ОБОИХ блоков обязана стоять перекрёстная ссылка: разъехавшись,
они дадут камеру, которая трясётся без пыли, или пыль без камеры.

## 7.2. Ядро: новое правило уровней

`core/src/config.rs`:

```rust
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LandingShake {
    pub intensity: f64,
    pub duration: f64,
    pub min_impact: f32,
    pub full_impact: f32,
}
```

и поле в `LevelRules`:

```rust
#[serde(default)]
pub landing_shake: Option<LandingShake>,
```

`Option` + `#[serde(default)]` — то же решение, что у `weapon.camera_shake`:
карта или сборка без блока ведёт себя ровно как сегодня (инвариант 4
мастер-плана — одноуровневая карта не должна заметить изменений).

## 7.3. Ядро: второй источник события

`core/src/tanks.rs`, цикл разбора `landed` (рядом с `apply_fall_damage`):

```rust
for (id, height, impact) in landed {
    self.push_landing_shake(ctx, id, impact);
    self.apply_fall_damage(ctx, id, height, impact);
}
```

`push_landing_shake` — чистая по форме функция рядом с `apply_fall_damage`:

- нет `landing_shake` в правилах → выход;
- `k = ((impact - min_impact) / (full_impact - min_impact)).clamp(0, 1)`;
  `k == 0` (мягкое касание) → события нет — тот же порог, по которому
  клиент не даёт ни просадки, ни пыли, ни звука;
- иначе `ctx.events.push(CoreEvent::Shake { id, intensity: intensity * k,
  duration })`.

Важно: событие рождается только на ХОСТЕ. `Predictor::step_inner`
(`core/src/client/predictor.rs`) зовёт уровневые формулы сам, но `SimCtx`
реплики события не собирает — перед правкой это надо перепроверить, иначе
своя камера тряхнётся дважды (кадром и предсказанием). Если реплика события
всё-таки копит — тряску пушить только в ветке хоста, а паритет
`replay_matches_continuous_simulation` обязан остаться зелёным.

## 7.4. Тесты

`core/src/tanks.rs` (unit, рядом с тестами урона падения):

1. `жёсткое приземление даёт Shake ровно один раз` — падение с уровня 1 при
   заданном `landingShake` кладёт в `ctx.events` одно событие `Shake` с
   `id` упавшего танка.
2. `мягкое касание тряски не даёт` — `impact < minImpact` → событий нет.
3. `интенсивность растёт с ударом и зажата сверху` — `impact` вдвое больше
   `fullImpact` даёт ровно `intensity`, не больше.
4. `без блока в конфиге событий нет вовсе` — `landing_shake: None` →
   поведение бит-в-бит прежнее.

`npm run core:test` — обязателен: правка трогает `tanks.rs` и `config.rs`.

## 7.5. Документация и CHANGELOG

- `docs/en/configuration.md` и `docs/ru/configuration.md` — новое поле
  `levels.landingShake` в таблице `coreParams`, с оговоркой про
  дублирование порогов с `render.js` (`landing`).
- `docs/en/gameplay.md` и `docs/ru/gameplay.md` — правило: жёсткое
  приземление трясёт камеру ТОМУ, кто приземлился; мягкое — нет.
- `CHANGELOG.md`, `## [Unreleased]` → `### Added`.

## 7.6. Проверка

```bash
npm run core:test
npm run core:build
npx eslint .
npm test
npm run build && npm run sim:scenarios
```

Ручная проверка: `VITE_MAP='terraces' npm run dev`, разогнаться по крутой
рампе `0 → 2` и вылететь с верхнего торца — на касании камера должна
дёрнуться один раз, вместе с просадкой корпуса, пылью и звуком; съезд с
края шагом камеру трясти не должен.

## Готовность этапа

- [x] `npm run core:test`, `npx eslint .`, `npm test` зелёные
- [x] одноуровневая карта без блока `landingShake` ведёт себя как раньше
- [x] `docs/en` и `docs/ru` обновлены парой, запись в `CHANGELOG.md` есть
