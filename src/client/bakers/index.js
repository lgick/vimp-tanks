import blurredCircleTexture from './blurredCircleTexture.js';
import funnelTexture from './funnelTexture.js';
import tankTexture from './tankTexture.js';
import tankRadarTexture from './tankRadarTexture.js';
import bombTexture from './bombTexture.js';
import trackMarkTexture from './trackMarkTexture.js';
import tankShadowTexture from './tankShadowTexture.js';

export default {
  // четыре ассета - один и тот же размытый круг, различаются параметрами
  explosionTexture: blurredCircleTexture,
  smokeTexture: blurredCircleTexture,
  impactParticleTexture: blurredCircleTexture,
  dustTexture: blurredCircleTexture,
  tankShadowTexture,
  funnelTexture,
  tankTexture,
  tankRadarTexture,
  bombTexture,
  trackMarkTexture,
};
