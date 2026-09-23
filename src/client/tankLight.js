import { GlProgram, Shader, UniformGroup } from 'pixi.js';

// Свет корпуса по карте нормалей (`src/client/bakers/tankTexture.js`).
// Свет один на всю сцену и задан в осях ЭКРАНА (`tilt.lightDir`, как у
// боковых граней зданий), поэтому нормаль текстуры проходит тот же путь,
// что и углы квада в `tiltCorners`:
//
//   оси текстуры → собственный поворот (пушка) → наклон pitch/roll в осях
//   корпуса → курс → оси экрана
//
// Множитель яркости нормирован так, что ровный плоский верх даёт ровно 1:
// ровно стоящий танк по яркости тот же, что без шейдера, а фаски к свету
// светлеют и от света темнеют. Математика продублирована в JS
// (`tankLightFactor`) — шейдер не проверить без GPU, а зеркало проверяется
// тестами; правка формулы меняет ОБЕ стороны.

const VERTEX = `#version 300 es
in vec2 aPosition;
in vec2 aUV;

out vec2 vUV;
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

  vUV = (uTextureMatrix * vec3(aUV, 1.0)).xy;
  // тинт уровня и прозрачность (премультиплицированы, как у меша PixiJS)
  vColor = uColor * uWorldColorAlpha;
}
`;

const FRAGMENT = `#version 300 es
in vec2 vUV;
in vec4 vColor;

out vec4 finalColor;

uniform sampler2D uTexture;
uniform sampler2D uNormal;

uniform vec2 uSpin;
uniform vec2 uPitch;
uniform vec2 uRoll;
uniform vec2 uHeading;
uniform vec3 uLight;
uniform float uAmbient;
uniform float uDiffuse;
uniform float uNorm;

vec2 turn(vec2 v, vec2 cs) {
  return vec2(v.x * cs.x - v.y * cs.y, v.x * cs.y + v.y * cs.x);
}

void main(void) {
  vec4 color = texture(uTexture, vUV);
  vec4 encoded = texture(uNormal, vUV);
  vec3 n = vec3(0.0, 0.0, 1.0);

  // запечённая текстура премультиплицирована: на кромке антиалиасинга
  // нормаль делится на свою альфу, а пустота считается плоской
  if (encoded.a > 0.01) {
    n = normalize(encoded.rgb / encoded.a * 2.0 - 1.0);
  }

  n.xy = turn(n.xy, uSpin);
  // тангаж: нос +u вверх — нормаль к корме
  n = vec3(n.x * uPitch.x - n.z * uPitch.y, n.y, n.x * uPitch.y + n.z * uPitch.x);
  // крен: борт +v вверх — нормаль к борту −v
  n = vec3(n.x, n.y * uRoll.x - n.z * uRoll.y, n.y * uRoll.y + n.z * uRoll.x);
  n.xy = turn(n.xy, uHeading);

  float light = (uAmbient + uDiffuse * max(dot(n, uLight), 0.0)) * uNorm;

  finalColor = vec4(color.rgb * light, color.a) * vColor;
}
`;

const pair = angle => [Math.cos(angle), Math.sin(angle)];

/**
 * Значения uniforms света для одного меша. Чистая функция: PixiJS не нужен.
 *
 * @param {object} p
 * @param {number} p.heading   курс корпуса, рад
 * @param {number} p.rotation  собственный поворот меша (пушка), рад
 * @param {number} p.pitch     тангаж, рад (> 0 — нос `+u` поднят)
 * @param {number} p.roll      крен, рад (> 0 — поднят борт `+v`)
 * @param {number[]} [p.lightDir]  направление НА свет в осях экрана
 * @param {number} p.lightZ    высота света над плоскостью карты
 * @param {number} p.ambient   рассеянная доля
 * @param {number} p.diffuse   направленная доля
 * @returns {object} uniforms `uSpin`, `uPitch`, `uRoll`, `uHeading`,
 *   `uLight`, `uAmbient`, `uDiffuse`, `uNorm`
 */
export function tankLightUniforms({
  heading,
  rotation,
  pitch,
  roll,
  lightDir,
  lightZ,
  ambient,
  diffuse,
}) {
  // без направления свет падает отвесно: плоский верх остаётся 1, фаски
  // равномерно темнее
  const [lx, ly] = lightDir || [0, 0];
  const len = Math.hypot(lx, ly, lightZ) || 1;
  const light = [lx / len, ly / len, lightZ / len];
  const flat = ambient + diffuse * Math.max(light[2], 0);

  return {
    uSpin: pair(rotation),
    uPitch: pair(pitch),
    uRoll: pair(roll),
    uHeading: pair(heading),
    uLight: light,
    uAmbient: ambient,
    uDiffuse: diffuse,
    uNorm: flat ? 1 / flat : 1,
  };
}

const turn = ([x, y], [c, s]) => [x * c - y * s, x * s + y * c];

/**
 * JS-зеркало фрагментного шейдера: множитель яркости пикселя с нормалью
 * `normal` (оси текстуры, нормировать не обязательно).
 *
 * @param {number[]} normal  [x, y, z]
 * @param {object} u  результат `tankLightUniforms`
 * @returns {number}
 */
export function tankLightFactor(normal, u) {
  const len = Math.hypot(normal[0], normal[1], normal[2]) || 1;
  let [x, y] = turn([normal[0] / len, normal[1] / len], u.uSpin);
  let z = normal[2] / len;

  [x, z] = [
    x * u.uPitch[0] - z * u.uPitch[1],
    x * u.uPitch[1] + z * u.uPitch[0],
  ];
  [y, z] = [y * u.uRoll[0] - z * u.uRoll[1], y * u.uRoll[1] + z * u.uRoll[0]];
  [x, y] = turn([x, y], u.uHeading);

  const dot = x * u.uLight[0] + y * u.uLight[1] + z * u.uLight[2];

  return (u.uAmbient + u.uDiffuse * Math.max(dot, 0)) * u.uNorm;
}

let program = null;

/**
 * Шейдер меша с парой текстур. Свой на каждый меш: uniforms у мешей
 * разные (курс, поворот пушки), а меш со своим шейдером не батчится.
 *
 * @param {import('pixi.js').Texture} texture  цветная текстура
 * @param {import('pixi.js').Texture} normal   её карта нормалей
 * @returns {Shader}
 */
export function createTankLightShader(texture, normal) {
  program ||= GlProgram.from({
    vertex: VERTEX,
    fragment: FRAGMENT,
    name: 'tank-light',
  });

  return new Shader({
    glProgram: program,
    resources: {
      uTexture: texture.source,
      uNormal: normal.source,
      textureUniforms: new UniformGroup({
        uTextureMatrix: {
          value: texture.textureMatrix.mapCoord,
          type: 'mat3x3<f32>',
        },
      }),
      tankLight: new UniformGroup({
        uSpin: { value: new Float32Array([1, 0]), type: 'vec2<f32>' },
        uPitch: { value: new Float32Array([1, 0]), type: 'vec2<f32>' },
        uRoll: { value: new Float32Array([1, 0]), type: 'vec2<f32>' },
        uHeading: { value: new Float32Array([1, 0]), type: 'vec2<f32>' },
        uLight: { value: new Float32Array([0, 0, 1]), type: 'vec3<f32>' },
        uAmbient: { value: 1, type: 'f32' },
        uDiffuse: { value: 0, type: 'f32' },
        uNorm: { value: 1, type: 'f32' },
      }),
    },
  });
}

// смена текстур (команда, остов) без пересоздания шейдера
export function setTankLightTextures(shader, texture, normal) {
  shader.resources.uTexture = texture.source;
  shader.resources.uNormal = normal.source;
  shader.resources.textureUniforms.uniforms.uTextureMatrix =
    texture.textureMatrix.mapCoord;
}

// раскладка значений `tankLightUniforms` в uniforms шейдера
export function applyTankLight(shader, values) {
  const target = shader.resources.tankLight.uniforms;

  for (const key of ['uSpin', 'uPitch', 'uRoll', 'uHeading', 'uLight']) {
    target[key].set(values[key]);
  }

  target.uAmbient = values.uAmbient;
  target.uDiffuse = values.uDiffuse;
  target.uNorm = values.uNorm;
}
