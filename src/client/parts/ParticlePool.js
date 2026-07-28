import { Particle } from 'pixi.js';

const pool = [];

export default {
  get(texture) {
    if (pool.length > 0) {
      const particle = pool.pop();
      particle.texture = texture;
      // Сброс базовых параметров, чтобы не наследовать состояние с прошлой жизни
      particle.alpha = 1;
      particle.scaleX = 1;
      particle.scaleY = 1;
      particle.rotation = 0;
      particle.tint = 0xffffff;
      particle.anchorX = 0.5;
      particle.anchorY = 0.5;
      return particle;
    }
    return new Particle({ texture, anchorX: 0.5, anchorY: 0.5 });
  },

  // вызывающий обязан сам удалить частицу из ParticleContainer
  // (container.removeParticle) перед возвратом в пул, если она ещё жива в сцене
  release(particle) {
    if (!particle) {
      return;
    }

    pool.push(particle);
  },
};
