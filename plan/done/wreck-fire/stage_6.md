# Этап 6. `src/client/parts/Smoke.js` — остов больше не дымит ✅ выполнен

- `SMOKE_CONFIG`: убрать ключи `0` из `particleStartSizeFactor`, `particleEndSizeFactor`,
  `particleSpawnRate` и строки комментариев про «0 (уничтожен) — тление».
- `_updateParticles`: убрать ветку `condition === 0` (остаётся `numStreams = 0`), комментарий:
  «уничтожен: дым остова ведёт WreckFire (src/client/parts/WreckFire.js)».
- `_triggerSmokeBurst`: убрать ветку `condition === 0`.
- `update`: облако только на переходе в повреждённое состояние —
  `if (this._condition !== prevCondition && (this._condition === 1 || this._condition === 2))`.
- `tests/client/parts/Smoke.test.js`: случай «уничтоженный танк выхлопа не даёт» →
  «уничтоженный танк не дымит вовсе: дым остова ведёт WreckFire» (`kinds.length === 0`);
  новый случай: переход `3 → 0` в `update` не рождает облака (`_particles.length === 0`).

> Общий контекст, факты из кода и решение — в [README.md](README.md).
