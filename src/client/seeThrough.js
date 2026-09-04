import {
  Filter,
  GlProgram,
  GpuProgram,
  UniformGroup,
  defaultFilterVert,
} from 'pixi.js';

// See-through уровней НАД игроком: единственная формула прозрачности на все
// парты. Два режима (решение 8 мастер-плана, plan/multilevel-maps-2):
//
//   'hole'  — радиальная дыра вокруг игрока: гаснет только то, что рядом,
//             остальная плита остаётся непрозрачной (GTA 2);
//   'layer' — гаснет весь слой целиком (прежнее поведение, путь отхода).
//
// Точечные сущности (ящик, чужой танк, дым, бомба, эффект) считают свою alpha
// через `seeThroughAlpha`, сплошная плита `Map` — фильтром `createHoleFilter`:
// внутри одного слоя нужна не одна alpha, а поле по пикселям.

// внутренний радиус дыры: до него прозрачность максимальная
const innerRadius = cfg => cfg.radius * (1 - cfg.softness);

// сглаженная ступенька (та же кривая, что и в шейдере)
const smoothStep = (edge0, edge1, x) => {
  if (edge1 <= edge0) {
    return x < edge1 ? 0 : 1;
  }

  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));

  return t * t * (3 - 2 * t);
};

// alpha точечной сущности уровня `level` в мировой точке (x, y) при игроке
// уровня `viewLevel` в точке (viewX, viewY)
export function seeThroughAlpha({
  viewLevel,
  viewX,
  viewY,
  level,
  x,
  y,
  cfg,
}) {
  // всё, что не выше игрока, видно как есть: ниже — не мешает, вровень —
  // это и есть его собственный уровень
  if ((level || 0) <= (viewLevel || 0)) {
    return 1;
  }

  if (cfg.mode === 'layer') {
    return cfg.layerAlpha;
  }

  const dx = x - viewX;
  const dy = y - viewY;
  const distance = Math.sqrt(dx * dx + dy * dy);
  const t = smoothStep(innerRadius(cfg), cfg.radius, distance);

  return cfg.minAlpha + (1 - cfg.minAlpha) * t;
}

// tint сущности уровня `level`: уровни НИЖЕ игрока затемняются — это
// единственный признак уровня, работающий на периферии экрана (задача 3)
export function seeThroughTint(viewLevel, level, cfg) {
  return (level || 0) < (viewLevel || 0) ? cfg.lowerTint : 0xffffff;
}

// GLSL ES 3.0: `uOutputFrame.xy + vTextureCoord * uInputSize.xy` — позиция
// пикселя в кадре фильтра (та же арифметика, что в defaultFilter.vert,
// только в обратную сторону), поэтому центр дыры приходит в тех же
// экранных пикселях
// precision highp float — обязательна: Pixi объявляет uInputSize/uOutputFrame
// в defaultFilter.vert с точностью highp, а во фрагментном шейдере точность
// float по умолчанию mediump, и программа не линкуется («Precisions of
// uniform 'uInputSize' differ between VERTEX and FRAGMENT shaders»)
const fragment = `
precision highp float;

in vec2 vTextureCoord;

out vec4 finalColor;

uniform sampler2D uTexture;
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;

uniform vec2 uHoleCenter;
// x - внешний радиус, y - внутренний, z - alpha в центре дыры
uniform vec3 uHoleParams;

void main(void)
{
    vec4 color = texture(uTexture, vTextureCoord);
    vec2 pixel = uOutputFrame.xy + vTextureCoord * uInputSize.xy;
    float d = distance(pixel, uHoleCenter);
    float t = smoothstep(uHoleParams.y, uHoleParams.x, d);

    finalColor = color * mix(uHoleParams.z, 1.0, t);
}
`;

const wgsl = `
struct GlobalFilterUniforms {
  uInputSize:vec4<f32>,
  uInputPixel:vec4<f32>,
  uInputClamp:vec4<f32>,
  uOutputFrame:vec4<f32>,
  uGlobalFrame:vec4<f32>,
  uOutputTexture:vec4<f32>,
};

struct HoleUniforms {
  uHoleCenter:vec2<f32>,
  uHoleParams:vec3<f32>,
};

@group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler : sampler;

@group(1) @binding(0) var<uniform> holeUniforms : HoleUniforms;

struct VSOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv : vec2<f32>
};

fn filterVertexPosition(aPosition:vec2<f32>) -> vec4<f32>
{
  var position = aPosition * gfu.uOutputFrame.zw + gfu.uOutputFrame.xy;

  position.x = position.x * (2.0 / gfu.uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0*gfu.uOutputTexture.z / gfu.uOutputTexture.y)
    - gfu.uOutputTexture.z;

  return vec4(position, 0.0, 1.0);
}

fn filterTextureCoord( aPosition:vec2<f32> ) -> vec2<f32>
{
  return aPosition * (gfu.uOutputFrame.zw * gfu.uInputSize.zw);
}

@vertex
fn mainVertex(@location(0) aPosition : vec2<f32>) -> VSOutput {
  return VSOutput(
    filterVertexPosition(aPosition),
    filterTextureCoord(aPosition)
  );
}

@fragment
fn mainFragment(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  var color = textureSample(uTexture, uSampler, uv);
  var pixel = gfu.uOutputFrame.xy + uv * gfu.uInputSize.xy;
  var d = distance(pixel, holeUniforms.uHoleCenter);
  var t = smoothstep(holeUniforms.uHoleParams.y, holeUniforms.uHoleParams.x, d);

  return color * mix(holeUniforms.uHoleParams.z, 1.0, t);
}
`;

// Фильтр «дыры» для сплошной плиты слоя. Обе ветки (WebGL и WebGPU) обязаны
// быть, иначе на второй из них слой просто исчезнет без ошибки. Uniform'ы —
// в пикселях кадра фильтра, их каждый кадр двигает Map._updateSeeThrough
export function createHoleFilter(cfg) {
  const holeUniforms = new UniformGroup({
    uHoleCenter: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
    uHoleParams: {
      value: new Float32Array([cfg.radius, innerRadius(cfg), cfg.minAlpha]),
      type: 'vec3<f32>',
    },
  });

  return new Filter({
    glProgram: GlProgram.from({
      vertex: defaultFilterVert,
      fragment,
      name: 'see-through-hole-filter',
    }),
    gpuProgram: GpuProgram.from({
      vertex: { source: wgsl, entryPoint: 'mainVertex' },
      fragment: { source: wgsl, entryPoint: 'mainFragment' },
    }),
    resources: { holeUniforms },
  });
}

// центр и размеры дыры в пикселях кадра фильтра. Радиус приходит в мировых
// единицах, поэтому масштабируется трансформом сцены и разрешением рендера
export function setHoleUniforms(
  filter,
  { centerX, centerY, radius, softness, minAlpha },
) {
  const uniforms = filter.resources.holeUniforms.uniforms;

  uniforms.uHoleCenter[0] = centerX;
  uniforms.uHoleCenter[1] = centerY;
  uniforms.uHoleParams[0] = radius;
  uniforms.uHoleParams[1] = radius * (1 - softness);
  uniforms.uHoleParams[2] = minAlpha;
}
