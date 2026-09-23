// Шина «танк выстрелил»: эффект выстрела (`ShotEffectController`) сообщает
// id стрелка, танк с этим id играет отдачу, а пока летит трассер — отдаёт
// текущую точку своего дула: эффект живёт в мире, а танк за 45–80 мс
// пролёта проезжает длину корпуса, и без привязки хвост трассера и вспышка
// отрывались бы от ствола. Экземпляр на ядро, как `levelView`: в
// headless-раннере в одном процессе живёт несколько клиентов
export function createShotEvents() {
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
  };
}
