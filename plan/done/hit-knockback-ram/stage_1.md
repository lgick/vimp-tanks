# Этап 1. Таран пропов под потолок скорости 130 ✅ выполнен

## Цель

Вернуть таран пропов к поведению времён потолка 260: пороги вдвое ниже, урон за единицу скорости вдвое выше.

## Факты (проверено по коду)

- `TanksSim::process_rams` (`core/src/tanks.rs`): `impact = (v_tank − v_prop)·normal` (не меньше 0), при
  `impact > ramThreshold` урон `(impact − ramThreshold) · ramDamagePerSpeed`. Формула линейная: при пороге /2 и
  уроне ×2 урон на скорости `v/2` равен прежнему урону на `v`.
- Итог на полном ходу 130 (лобовой удар):

| Тип | hp | Было: порог / урон | Станет | Урон на 130 | Итог |
| --- | --- | --- | --- | --- | --- |
| `fence` | 30 | 60 / 0.5 | 30 / 1.0 | 100 | ломается |
| `crate` | 120 | 140 / 0.6 | 70 / 1.2 | 72 | «повреждён» (`damagedAt` 0.5), ломается вторым тараном |
| `barrel` | 40 | 150 / 1.0 | 75 / 2.0 | 110 | взрывается (с ~95 ед/с) |

## Шаги

1. **`src/config/game.js → coreParams.props`**:
   - `fence`: `ramThreshold` 60 → 30, `ramDamagePerSpeed` 0.5 → 1.0;
   - `crate`: 140 → 70, 0.6 → 1.2;
   - `barrel`: 150 → 75, 1.0 → 2.0.

   Комментарий над `props` уже говорит «максимальная скорость танка 130» — к фразе про `ramThreshold` дописать
   «пороги — под потолок 130».
2. **Фикстуры Rust не трогать** (`core/src/config.rs`, `core/src/props.rs`, `core/tests/sim.rs`) — это тестовые
   данные, не игровые.
3. **Docs `configuration.md`** (en и ru): строка таблицы `coreParams.props` — новые числа (`ramThreshold 30,
   ramDamagePerSpeed 1.0` у fence, `70`/`1.2` у crate, `75`/`2.0` у barrel). Искать `ramThreshold 60`.
4. **Docs `gameplay.md`** (en и ru), раздел «Destructible objects» / «Разрушаемые объекты»:
   - к пункту **Crate** дописать: таран на полном ходу повреждает ящик, второй — ломает;
   - к пункту **Barrel** дописать: таран на полном ходу её взрывает — взрыв задевает и таранившего.

   Абзац «Ramming counts only the impact speed…» не менять.
5. **`CHANGELOG.md → [Unreleased] → ### Changed`**:
   ```
   - Prop ramming is retuned for the slower tank: `ramThreshold` is halved and
     `ramDamagePerSpeed` doubled, so a ram at the same share of top speed deals
     the same damage as before — a barrel rammed at full speed explodes again and
     a crate breaks on the second ram (`coreParams.props`, `src/config/game.js`).
   ```
6. **Проверки**: `npx eslint . --quiet`, `npx vitest run --reporter=dot`.
7. **Сценарии** (правило 7 README). Ожидаемые риски:
   - **`bots_downtown.json`**: боты таранят бочки на ходу и взрывают их → появляются строки `w2e`, а он объявлен в
     `unusedSnapshotKeys` → падает контракт `snapshotKeysUsed`. Проверить по отчёту, что строки `w2e` — от бочек
     (бомб `w2` нет). Если так — убрать `"w2e"` из `unusedSnapshotKeys` (`"w2"` оставить, пока бомб нет). Цель
     сценария (боты не застревают, не падают с карты) это не ослабляет.
   - **`downtown_props.json`**: три события должны остаться. Проверка по дампу (`--out <каталог>`): на тике 400 у
     строк `c1` для `d14`, `d19`, `d6`–`d9` поле с индексом 5 (состояние) равно 2:
     ```bash
     jq -c '.clients[0].entities.c1 | {d6,d7,d8,d9,d14,d19} | map_values(.[5])' <каталог>/run-*/scene-400.json
     ```
   - Любое другое падение — разобрать; ослаблять цель нельзя.
8. Отметить этап «✅ выполнен» в этом файле и в `README.md`.
