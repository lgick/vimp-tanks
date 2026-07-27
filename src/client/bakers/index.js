import explosionTexture from './explosionTexture.js';
import funnelTexture from './funnelTexture.js';
import smokeTexture from './smokeTexture.js';
import tankTexture from './tankTexture.js';
import tankRadarTexture from './tankRadarTexture.js';
import bombTexture from './bombTexture.js';
import trackMarkTexture from './trackMarkTexture.js';
import impactParticleTexture from './impactParticleTexture.js';
import warmUpRenderer from './warmUpRenderer.js';

const bakers = {
  explosionTexture,
  funnelTexture,
  smokeTexture,
  tankTexture,
  tankRadarTexture,
  bombTexture,
  trackMarkTexture,
  impactParticleTexture,
};

// Прогрев рендерера централизован здесь, а не в отдельных baker'ах: так
// авторы новых baker'ов не могут забыть вызов (см. warmUpRenderer.js и
// docs/en/extending.md). warmUpRenderer сам по себе идемпотентен
// (WeakSet), поэтому оборачивать все baker'ы, а не только использующие
// Filter, безопасно и дешевле, чем следить за списком вручную.
export default Object.fromEntries(
  Object.entries(bakers).map(([name, bakerFn]) => [
    name,
    (params, renderer) => {
      warmUpRenderer(renderer);

      return bakerFn(params, renderer);
    },
  ]),
);
