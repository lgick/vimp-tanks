import { describe, it, expect } from 'vitest';
import { lighting } from '../../src/config/render.js';
import clientConfig from '../../src/config/client.js';
import bakers from '../../src/client/bakers/index.js';

// Засветы и лучи фонарей (`lighting.glints`, `lighting.shafts`): значения
// по умолчанию и ассеты, которые их кормят
describe('config: lighting.glints / lighting.shafts', () => {
  it('засвет включён по умолчанию, сила и размер положительны', () => {
    expect(lighting.glints).toEqual({
      enabled: true,
      intensity: expect.any(Number),
      size: expect.any(Number),
    });
    expect(lighting.glints.intensity).toBeGreaterThan(0);
    expect(lighting.glints.size).toBeGreaterThan(0);
  });

  it('лучи включены по умолчанию, с тенями и лимитом теней', () => {
    expect(lighting.shafts.enabled).toBe(true);
    expect(lighting.shafts.shadows).toBe(true);
    expect(lighting.shafts.rays).toBeGreaterThan(0);
    expect(lighting.shafts.length).toBeGreaterThan(0);
    expect(lighting.shafts.intensity).toBeGreaterThan(0);
    expect(lighting.shafts.maxShadowCasters).toBeGreaterThan(0);
  });

  it('текстуры засвета и лучей пекутся для Map, число лучей — из конфига', () => {
    const entries = Object.values(clientConfig.parts.bakedAssets)
      .flat()
      .filter(entry =>
        ['glintTexture', 'lightShaftTexture'].includes(entry.name),
      );

    expect(entries.map(entry => entry.component)).toEqual(['Map', 'Map']);
    expect(entries[1].params.rays).toBe(lighting.shafts.rays);
    expect(typeof bakers.glintTexture).toBe('function');
    expect(typeof bakers.lightShaftTexture).toBe('function');
  });
});

// Фары и стены (`lighting.headlights.occlusion`, `.bounce`)
describe('config: lighting.headlights.occlusion / bounce', () => {
  it('окклюзия включена по умолчанию, лучей веера не меньше двух', () => {
    expect(lighting.headlights.occlusion.enabled).toBe(true);
    expect(lighting.headlights.occlusion.rays).toBeGreaterThanOrEqual(2);
  });

  it('отсвет: сила, радиус и дальность положительны, дальность не длиннее фары', () => {
    const { bounce, length } = lighting.headlights;

    expect(bounce.intensity).toBeGreaterThan(0);
    expect(bounce.radius).toBeGreaterThan(0);
    expect(bounce.maxDistance).toBeGreaterThan(0);
    expect(bounce.maxDistance).toBeLessThanOrEqual(length);
  });
});
