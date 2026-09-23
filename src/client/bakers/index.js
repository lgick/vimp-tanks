import blurredCircleTexture from './blurredCircleTexture.js';
import funnelTexture from './funnelTexture.js';
import tankTexture from './tankTexture.js';
import tankModelTexture from './tankModelTexture.js';
import tankRadarTexture from './tankRadarTexture.js';
import bombTexture from './bombTexture.js';
import trackMarkTexture from './trackMarkTexture.js';
import tankShadowTexture from './tankShadowTexture.js';
import scorchTexture from './scorchTexture.js';
import debrisTexture from './debrisTexture.js';
import lightRadialTexture from './lightRadialTexture.js';
import headlightConeTexture from './headlightConeTexture.js';
import lampHeadTexture from './lampHeadTexture.js';

export default {
  // четыре ассета - один и тот же размытый круг, различаются параметрами
  explosionTexture: blurredCircleTexture,
  smokeTexture: blurredCircleTexture,
  impactParticleTexture: blurredCircleTexture,
  dustTexture: blurredCircleTexture,
  tankShadowTexture,
  funnelTexture,
  tankTexture,
  // атлас граней 3D-модели танка (plan/tank-3d/)
  tankModelTexture,
  tankRadarTexture,
  bombTexture,
  trackMarkTexture,
  scorchTexture,
  debrisTexture,
  lightRadialTexture,
  headlightConeTexture,
  lampHeadTexture,
};
