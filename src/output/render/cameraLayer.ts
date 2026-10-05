import { BufferImageSource, Mesh, MeshGeometry, Shader, type TextureSource, UniformGroup } from 'pixi.js'
import type { Grade } from '../effects/grade'

/**
 * The camera, drawn by our own shader so the colour grade costs no extra render pass. The same
 * program draws two quads: the background camera, and the person layer (the camera again, with
 * the segmentation mask as alpha). The mask arrives small (e.g. 256×144); linear filtering
 * upscales it on the GPU, a 3×3 blur at the mask's scale softens the stair steps, and a
 * smoothstep turns the confidence into a feathered edge.
 */

const VERTEX = /* glsl */ `
in vec2 aPosition;
in vec2 aUV;
out vec2 vUV;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
void main() {
  mat3 m = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((m * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vUV = aUV;
}
`

const FRAGMENT = /* glsl */ `
in vec2 vUV;
out vec4 finalColor;
uniform sampler2D uCamera;
uniform sampler2D uMask;
uniform float uSaturation;
uniform float uTintAmount;
uniform vec3 uTint;
uniform float uUseMask;
/** x, y: smoothstep edges on the blurred confidence; z, w: one mask texel in UV × blur spread. */
uniform vec4 uMaskEdge;

void main() {
  vec3 rgb = texture(uCamera, vUV).rgb;
  float l = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  rgb = mix(vec3(l), rgb, uSaturation);
  // Luminance-preserving colourize toward the tint (warm/gold), mixed in by amount.
  float tl = max(dot(uTint, vec3(0.2126, 0.7152, 0.0722)), 0.001);
  rgb = mix(rgb, clamp(l * uTint / tl, 0.0, 1.0), uTintAmount);

  float a = 1.0;
  if (uUseMask > 0.5) {
    vec2 d = uMaskEdge.zw;
    float m = 4.0 * texture(uMask, vUV).r
      + 2.0 * (texture(uMask, vUV + vec2(d.x, 0.0)).r + texture(uMask, vUV - vec2(d.x, 0.0)).r
             + texture(uMask, vUV + vec2(0.0, d.y)).r + texture(uMask, vUV - vec2(0.0, d.y)).r)
      + texture(uMask, vUV + d).r + texture(uMask, vUV - d).r
      + texture(uMask, vUV + vec2(d.x, -d.y)).r + texture(uMask, vUV + vec2(-d.x, d.y)).r;
    a = smoothstep(uMaskEdge.x, uMaskEdge.y, m / 16.0);
  }
  finalColor = vec4(rgb * a, a);
}
`

/** The mask itself as a soft tinted overlay (web demo's "What the AI sees"), same blur and edge as the person layer. */
const MASK_TINT_FRAGMENT = /* glsl */ `
in vec2 vUV;
out vec4 finalColor;
uniform sampler2D uMask;
uniform vec4 uMaskEdge;
uniform vec4 uTintColor;
void main() {
  vec2 d = uMaskEdge.zw;
  float m = 4.0 * texture(uMask, vUV).r
    + 2.0 * (texture(uMask, vUV + vec2(d.x, 0.0)).r + texture(uMask, vUV - vec2(d.x, 0.0)).r
           + texture(uMask, vUV + vec2(0.0, d.y)).r + texture(uMask, vUV - vec2(0.0, d.y)).r)
    + texture(uMask, vUV + d).r + texture(uMask, vUV - d).r
    + texture(uMask, vUV + vec2(d.x, -d.y)).r + texture(uMask, vUV + vec2(-d.x, d.y)).r;
  float a = smoothstep(uMaskEdge.x * 0.6, uMaskEdge.y, m / 16.0) * uTintColor.a;
  finalColor = vec4(uTintColor.rgb * a, a);
}
`

/** Feathering: blurred confidence below LOW is background, above HIGH is person. */
const MASK_EDGE = { low: 0.35, high: 0.75, spreadTexels: 1.25 }

export interface CameraLayers {
  background: Mesh<MeshGeometry, Shader>
  person: Mesh<MeshGeometry, Shader>
  /** The mask as a tinted overlay; not on the stage unless someone adds it (web overlays). Hidden by default. */
  maskTint: Mesh<MeshGeometry, Shader>
  setGrade(grade: Grade): void
  /** Uploads a new mask (bytes, raw camera orientation). */
  setMask(data: Uint8Array, width: number, height: number): void
}

function quad(width: number, height: number, mirror: boolean): MeshGeometry {
  const [u0, u1] = mirror ? [1, 0] : [0, 1]
  return new MeshGeometry({
    positions: new Float32Array([0, 0, width, 0, width, height, 0, height]),
    uvs: new Float32Array([u0, 0, u1, 0, u1, 1, u0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3])
  })
}

function maskSource(width: number, height: number, data: Uint8Array = new Uint8Array(width * height)): BufferImageSource {
  return new BufferImageSource({
    resource: data,
    width,
    height,
    format: 'r8unorm',
    alphaMode: 'no-premultiply-alpha',
    scaleMode: 'linear',
    addressMode: 'clamp-to-edge'
  })
}

export function createCameraLayers(camera: TextureSource, width: number, height: number, mirror: boolean): CameraLayers {
  const geometry = quad(width, height, mirror)
  // Grade uniforms are shared by both quads, so the person matches the background.
  const grade = new UniformGroup({
    uSaturation: { value: 1, type: 'f32' },
    uTintAmount: { value: 0, type: 'f32' },
    uTint: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' }
  })
  // The background never samples its mask; it keeps a permanent dummy so the person's mask can be replaced freely.
  const unusedMask = maskSource(4, 4)
  let mask = maskSource(4, 4)
  const make = (useMask: boolean, edge: Float32Array) =>
    Shader.from({
      gl: { vertex: VERTEX, fragment: FRAGMENT, name: useMask ? 'camera-person' : 'camera' },
      resources: {
        uCamera: camera,
        uMask: useMask ? mask : unusedMask,
        grade,
        layer: new UniformGroup({
          uUseMask: { value: useMask ? 1 : 0, type: 'f32' },
          uMaskEdge: { value: edge, type: 'vec4<f32>' }
        })
      }
    })
  const edge = new Float32Array([MASK_EDGE.low, MASK_EDGE.high, 0, 0])
  const background = new Mesh({ geometry, shader: make(false, new Float32Array(4)) })
  const personShader = make(true, edge)
  const person = new Mesh({ geometry, shader: personShader })
  person.visible = false
  const tintShader = Shader.from({
    gl: { vertex: VERTEX, fragment: MASK_TINT_FRAGMENT, name: 'mask-tint' },
    resources: {
      uMask: mask,
      tint: new UniformGroup({ uMaskEdge: { value: edge, type: 'vec4<f32>' }, uTintColor: { value: new Float32Array([0.62, 0.36, 1, 0.42]), type: 'vec4<f32>' } })
    }
  })
  const maskTint = new Mesh({ geometry, shader: tintShader })
  maskTint.visible = false

  return {
    background,
    person,
    maskTint,
    setGrade(g) {
      const u = grade.uniforms as { uSaturation: number; uTintAmount: number; uTint: Float32Array }
      if (u.uSaturation === g.saturation && u.uTintAmount === g.tintAmount && u.uTint[0] === g.tint[0] && u.uTint[1] === g.tint[1] && u.uTint[2] === g.tint[2]) return
      u.uSaturation = g.saturation
      u.uTintAmount = g.tintAmount
      u.uTint[0] = g.tint[0]
      u.uTint[1] = g.tint[1]
      u.uTint[2] = g.tint[2]
      grade.update()
    },
    setMask(data, w, h) {
      if (w !== mask.pixelWidth || h !== mask.pixelHeight) {
        // New mask size (adaptive quality): a new texture of the right size.
        const old = mask
        mask = maskSource(w, h, data)
        personShader.resources.uMask = mask
        tintShader.resources.uMask = mask
        old.destroy()
        edge[2] = MASK_EDGE.spreadTexels / w
        edge[3] = MASK_EDGE.spreadTexels / h
        ;(personShader.resources.layer as UniformGroup).update()
        ;(tintShader.resources.tint as UniformGroup).update()
      } else {
        mask.resource = data
        mask.update()
      }
    }
  }
}

const VIGNETTE_FRAGMENT = /* glsl */ `
in vec2 vUV;
out vec4 finalColor;
uniform float uStrength;
uniform float uAspect;
void main() {
  vec2 p = (vUV - 0.5) * vec2(uAspect, 1.0);
  float d = length(p) / length(vec2(uAspect, 1.0) * 0.5);
  float a = uStrength * smoothstep(0.35, 1.0, d) * (0.6 + 0.4 * d);
  finalColor = vec4(0.0, 0.0, 0.0, a);
}
`

/** A screen-fixed vignette: one alpha-blended quad in the overlay, hidden at strength 0. */
export function createVignette(width: number, height: number): { mesh: Mesh<MeshGeometry, Shader>; set(strength: number): void } {
  const uniforms = new UniformGroup({
    uStrength: { value: 0, type: 'f32' },
    uAspect: { value: width / height, type: 'f32' }
  })
  const mesh = new Mesh({
    geometry: quad(width, height, false),
    shader: Shader.from({ gl: { vertex: VERTEX, fragment: VIGNETTE_FRAGMENT, name: 'vignette' }, resources: { uniforms } })
  })
  mesh.visible = false
  return {
    mesh,
    set(strength) {
      mesh.visible = strength > 0.001
      const u = uniforms.uniforms as { uStrength: number }
      if (u.uStrength === strength) return
      u.uStrength = strength
      uniforms.update()
    }
  }
}
