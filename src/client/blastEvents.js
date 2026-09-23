// Шина «взрыв»: эффект взрыва (`ExplosionEffectController` — бомба и
// бочка) сообщает точку, радиус и уровень, а каждый танк сам решает, задел
// ли его взрыв (`src/client/blastJolt.js`). Экземпляр на ядро, как `shots`
export function createBlastEvents() {
  const listeners = new Set();

  return {
    // возвращает отписку
    subscribe(callback) {
      listeners.add(callback);

      return () => {
        listeners.delete(callback);
      };
    },

    exploded(blast) {
      for (const callback of listeners) {
        callback(blast);
      }
    },
  };
}
