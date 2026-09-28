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
      dynamicProperties: {
        position: true,
        vertex: true,
        rotation: true,
        color: true,
      },
    });
    this.container.blendMode = blendMode;
  }

  get size() {
    return this.items.length;
  }

  // область частиц едет за эмиттером (как boundsArea в Smoke.update)
  follow(x, y) {
    this.container.boundsArea.x = x - this._padding;
    this.container.boundsArea.y = y - this._padding;
  }

  // sim — состояние частицы; view берётся из пула и добавляется в контейнер
  spawn(sim) {
    if (this.items.length >= this.max) {
      return null;
    }

    const view = ParticlePool.get(this.texture);

    sim.view = view;
    this.container.addParticle(view);
    this.items.push(sim);

    return sim;
  }

  // сначала из контейнера, потом в пул — контракт ParticlePool
  removeAt(index) {
    const [sim] = this.items.splice(index, 1);

    if (!sim) {
      return;
    }

    this.container.removeParticle(sim.view);
    ParticlePool.release(sim.view);
  }

  // всё в пул; контейнер остаётся пригодным для нового пожара
  clear() {
    this.container.removeParticles();

    for (let i = 0; i < this.items.length; i += 1) {
      ParticlePool.release(this.items[i].view);
    }

    this.items.length = 0;
  }
}
