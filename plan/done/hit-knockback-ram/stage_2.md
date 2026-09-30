# Этап 2. `npm run dev` стартует на карте по умолчанию ✅ выполнен

## Цель

`npm run dev` запускает карту по умолчанию игры (`currentMap` из `src/config/game.js`, сейчас `downtown`), а не
захардкоженную `pool mini`. Карта задаётся в одном месте — `game.js`.

## Факты (проверено по коду)

- `src/standalone.js`: `room: { map: import.meta.env.VITE_MAP || 'pool mini' }`, над строкой комментарий «карта по
  умолчанию — `pool mini`…».
- Движок (`vimp-engine`, `src/lib/applyRoomOverrides.js`; в связанной копии — `../vimp/packages/engine/src/lib/`):
  `if (room.map && game.maps[room.map]) { game.currentMap = room.map; }` — пустой `room.map` оставляет `currentMap`
  игры. Неизвестное имя в `VITE_MAP` молча игнорируется (как и раньше).

## Шаги

1. **`src/standalone.js`**: `room: { map: import.meta.env.VITE_MAP }`. Комментарий над строкой:
   ```js
   // карта по умолчанию — `currentMap` игры (src/config/game.js); другую
   // запускать через переменную окружения Vite, не правкой файла:
   // `VITE_MAP='overpass' npm run dev`
   ```
2. **Docs `getting-started.md`** (en ~стр. 128, ru ~стр. 129; искать `pool mini`): «The map is `pool mini` by
   default» → карта по умолчанию игры (`currentMap` в `src/config/game.js`, сейчас `downtown`). В блок `bash` ниже
   добавить строку `VITE_MAP='pool mini' npm run dev    # the small arena` (ru — `# маленькая арена`).
3. `grep -rn "pool mini" README.md docs/ src/standalone.js index.html` — других утверждений «dev по умолчанию —
   `pool mini`» быть не должно (упоминания самой карты не трогать).
4. **`CHANGELOG.md → [Unreleased] → ### Changed`**:
   ```
   - `npm run dev` starts on the game's default map (`currentMap`, now
     `downtown`) instead of a hard-coded `pool mini`; `VITE_MAP` still picks
     another one (`src/standalone.js`).
   ```
5. **Проверки**: `npx eslint . --quiet`, `npx vitest run --reporter=dot`. Ручная проверка — за пользователем
   (`npm run dev` → `downtown`).
6. Отметить этап «✅ выполнен» в этом файле и в `README.md`.
