import { GlProgram, Shader, UniformGroup } from 'pixi.js';

// Шейдер модели танка: текстура атласа × яркость грани (`aShade`, считает
// `faceShade` на CPU раз в кадр) × тинт уровня и альфа (`uColor` меша,
// премультиплицированы — как у меша PixiJS, см. src/client/tankLight.js).

const VERTEX = `#version 300 es
in vec2 aPosition;
in vec2 aUv;
in float aShade;

out vec2 vUV;
out float vShade;
out vec4 vColor;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform vec4 uWorldColorAlpha;
uniform vec2 uResolution;

uniform mat3 uTransformMatrix;
uniform vec4 uColor;
uniform float uRound;

uniform mat3 uTextureMatrix;

void main(void) {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;

  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);

  if (uRound == 1.0) {
    gl_Position.xy =
      (floor(((gl_Position.xy * 0.5 + 0.5) * uResolution) + 0.5) /
        uResolution) * 2.0 - 1.0;
  }

  vUV = (uTextureMatrix * vec3(aUv, 1.0)).xy;
  vShade = aShade;
  vColor = uColor * uWorldColorAlpha;
}
`;

const FRAGMENT = `#version 300 es
in vec2 vUV;
in float vShade;
in vec4 vColor;

out vec4 finalColor;

uniform sampler2D uTexture;

void main(void) {
  vec4 color = texture(uTexture, vUV);

  finalColor = vec4(color.rgb * vShade, color.a) * vColor;
}
`;

let program = null;

/**
 * @param {import('pixi.js').Texture} texture  атлас модели
 * @returns {Shader}
 */
export function createTankModelShader(texture) {
  program ||= GlProgram.from({
    vertex: VERTEX,
    fragment: FRAGMENT,
    name: 'tank-model',
  });

  return new Shader({
    glProgram: program,
    resources: {
      uTexture: texture.source,
      textureUniforms: new UniformGroup({
        uTextureMatrix: {
          value: texture.textureMatrix.mapCoord,
          type: 'mat3x3<f32>',
        },
      }),
    },
  });
}

// смена атласа (команда) без пересоздания шейдера
export function setTankModelTexture(shader, texture) {
  shader.resources.uTexture = texture.source;
  shader.resources.textureUniforms.uniforms.uTextureMatrix =
    texture.textureMatrix.mapCoord;
}
