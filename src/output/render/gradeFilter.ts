import { defaultFilterVert, Filter, GlProgram, UniformGroup } from 'pixi.js'
import type { Grade } from '../effects/grade'

/**
 * The colour grade as a full-frame filter, for gradeScope "all" (camera and effects). Same maths
 * as the camera shader's grade, so switching scope doesn't change the look. It costs one
 * full-frame pass, so it is attached only while such a grade is active.
 */
const FRAGMENT = /* glsl */ `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform float uSaturation;
uniform float uTintAmount;
uniform vec3 uTint;

void main() {
  vec4 px = texture(uTexture, vTextureCoord);
  vec3 rgb = px.a > 0.0 ? px.rgb / px.a : vec3(0.0);
  float l = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  rgb = mix(vec3(l), rgb, uSaturation);
  float tl = max(dot(uTint, vec3(0.2126, 0.7152, 0.0722)), 0.001);
  rgb = mix(rgb, clamp(l * uTint / tl, 0.0, 1.0), uTintAmount);
  finalColor = vec4(clamp(rgb, 0.0, 1.0) * px.a, px.a);
}
`

export interface GradeFilter {
  filter: Filter
  set(grade: Grade): void
}

export function createGradeFilter(): GradeFilter {
  const uniforms = new UniformGroup({
    uSaturation: { value: 1, type: 'f32' },
    uTintAmount: { value: 0, type: 'f32' },
    uTint: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' }
  })
  const filter = new Filter({
    glProgram: GlProgram.from({ vertex: defaultFilterVert, fragment: FRAGMENT, name: 'grade' }),
    resources: { grade: uniforms },
    resolution: 'inherit'
  })
  return {
    filter,
    set(g) {
      const u = uniforms.uniforms as { uSaturation: number; uTintAmount: number; uTint: Float32Array }
      u.uSaturation = g.saturation
      u.uTintAmount = g.tintAmount
      u.uTint[0] = g.tint[0]
      u.uTint[1] = g.tint[1]
      u.uTint[2] = g.tint[2]
      uniforms.update()
    }
  }
}
