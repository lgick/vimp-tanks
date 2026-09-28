# Этап 3. Канал частиц `src/client/parts/ParticleChannel.js` (новый) ✅ выполнен

```js
import { ParticleContainer, Rectangle } from 'pixi.js';
import ParticlePool from './ParticlePool.js';

// Канал частиц одного вида: ParticleContainer (одна текстура и один режим
// смешивания на контейнер), параллельный массив симуляции (у Particle нет
// customData) и общий пул. `max` — бюджет: при упоре spawn возвращает null
export default class ParticleChannel {
  constructor({ texture, max, blendMode = 'normal', padding }) {
    this.texture = texture;
    this.max = max;
    this.items = [];
    this._padding = padding;
    this.container = new ParticleContainer({
      texture,
      boundsArea: new Rectangle(-padding, -padding, padding * 2, padding * 2),
      dynamicProperties: { position: true, vertex: true, rotation: true, color: true },
    });
    this.container.blendMode = blendMode;
  }

  get size() { return this.items.length; }

  // область частиц едет за эмиттером (как boundsArea в Smoke.update)
  follow(x, y) { /* boundsArea.x = x - padding; boundsArea.y = y - padding */ }

  // sim — состояние частицы; view берётся из пула и добавляется в контейнер
  spawn(sim) {
    if (this.items.length >= this.max) { return null; }
    const view = ParticlePool.get(this.texture);
    sim.view = view;
    this.container.addParticle(view);
    this.items.push(sim);
    return sim;
  }

  // сначала из контейнера, потом в пул — контракт ParticlePool
  removeAt(index) { /* splice(index, 1); container.removeParticle(view); ParticlePool.release(view) */ }

  // всё в пул; контейнер остаётся пригодным для нового пожара
  clear() { /* container.removeParticles(); release каждой view; items.length = 0 */ }
}
```

Тест `tests/client/parts/ParticleChannel.test.js` (`Texture.EMPTY`): потолок `max` (spawn сверх —
`null`, `container.particleChildren.length === size`); `removeAt` убирает ровно одну и из
контейнера; `clear` обнуляет и контейнер, и `items`; `blendMode` применяется; `follow` двигает
`boundsArea`.

> Общий контекст, факты из кода и решение — в [README.md](README.md).
