// Шина «танк выстрелил»: эффект выстрела (`ShotEffectController`) сообщает
// id стрелка, танк с этим id играет отдачу, а пока летит трассер — отдаёт
// текущую точку своего дула: эффект живёт в мире, а танк за 45–80 мс
// пролёта проезжает длину корпуса, и без привязки хвост трассера и вспышка
// отрывались бы от ствола. Экземпляр на ядро, как `levelView`: в
// headless-раннере в одном процессе живёт несколько клиентов.
//
// `segments(x, y, dx, dy, range, level)` — сегменты луча по уровням из ядра
// (`core.shot_segments`, плоский `[t0, t1, level, …]`); без него `path`
// отдаёт null, и трассер рисуется целиком на уровне конца
export function createShotEvents({ segments = null } = {}) {
  const handlers = new Map();

  return {
    // подписка танка по его id: `{ fired(), muzzle() }`, где `muzzle`
    // отдаёт мировую точку дула `{ x, y }` или null. Возвращает отписку
    subscribe(rawId, handler) {
      // id из контекста парта и из строки трассера могут прийти разных
      // типов (строка/число) — ключ всегда строка
      const id = String(rawId);

      if (!handlers.has(id)) {
        handlers.set(id, new Set());
      }

      handlers.get(id).add(handler);

      return () => {
        const set = handlers.get(id);

        if (set) {
          set.delete(handler);

          if (set.size === 0) {
            handlers.delete(id);
          }
        }
      };
    },

    fired(id) {
      const set = handlers.get(String(id));

      if (set) {
        for (const handler of set) {
          handler.fired?.();
        }
      }
    },

    // текущая точка дула стрелка; null — танка нет (уничтожен, вне кадра)
    muzzle(id) {
      const set = handlers.get(String(id));

      if (set) {
        for (const handler of set) {
          const point = handler.muzzle?.();

          if (point) {
            return point;
          }
        }
      }

      return null;
    },

    // сегменты луча от (x0, y0) до (x1, y1), выпущенного с уровня `level`:
    // `[{ t0, t1, level }]` в мировых единицах вдоль луча; null — ядра нет
    // или луч нулевой длины
    path(x0, y0, x1, y1, level) {
      const range = Math.hypot(x1 - x0, y1 - y0);

      if (!segments || !(range > 1e-3)) {
        return null;
      }

      const flat = segments(
        x0,
        y0,
        (x1 - x0) / range,
        (y1 - y0) / range,
        range,
        level || 0,
      );
      const list = [];

      for (let i = 0; i + 2 < (flat?.length ?? 0); i += 3) {
        list.push({ t0: flat[i], t1: flat[i + 1], level: flat[i + 2] });
      }

      return list.length ? list : null;
    },
  };
}
