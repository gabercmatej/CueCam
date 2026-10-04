import { defaultFilterVert, Filter, GlProgram, UniformGroup } from 'pixi.js'
import { hexToRgb } from '../effects/grade'

/**
 * Chroma key for green-screen clips (OBS-style). Works in BT.709 YCbCr: a pixel's distance from
 * the key colour is measured on chroma only, so shadows and highlights on the screen key out
 * alike. `similarity` is the distance that becomes fully transparent, `smoothness` the soft band
 * above it. Spill suppression removes the key's chroma direction from pixels close to the
 * key (green fringes on hair and edges), keeping their brightness.
 */
const FRAGMENT = /* glsl */ `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform vec3 uKeyColor;
uniform float uSimilarity;
uniform float uSmoothness;
uniform float uSpill;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
vec2 chroma(vec3 c) {
  return vec2(dot(c, vec3(-0.1146, -0.3854, 0.5)), dot(c, vec3(0.5, -0.4542, -0.0458)));
}

void main() {
  vec4 px = texture(uTexture, vTextureCoord);
  if (px.a <= 0.0) { finalColor = vec4(0.0); return; }
  vec3 rgb = px.rgb / px.a;

  vec2 c = chroma(rgb);
  vec2 key = chroma(uKeyColor);
  float base = distance(c, key) - uSimilarity;
  float alpha = pow(clamp(base / max(uSmoothness, 0.0001), 0.0, 1.0), 1.5);

  // Spill: take out the part of the pixel's chroma that points toward the key, only for pixels
  // near the key (fringes, reflections), so distinct colours like a fire's yellow stay put.
  vec2 dir = key / max(length(key), 0.0001);
  float along = max(dot(c, dir), 0.0);
  c -= dir * along * uSpill * (1.0 - smoothstep(0.0, 0.2, base));
  float y = dot(rgb, LUMA);
  rgb = clamp(vec3(y + 1.5748 * c.y, y - 0.1873 * c.x - 0.4681 * c.y, y + 1.8556 * c.x), 0.0, 1.0);

  float a = alpha * px.a;
  finalColor = vec4(rgb * a, a);
}
`

export interface ChromaKeySettings {
  keyColor: string
  similarity: number
  smoothness: number
  spill: number
}

export function createChromaKey(s: ChromaKeySettings): Filter {
  return new Filter({
    glProgram: GlProgram.from({
      vertex: defaultFilterVert,
      fragment: FRAGMENT,
      name: 'chroma-key'
    }),
    resources: {
      key: new UniformGroup({
        uKeyColor: { value: new Float32Array(hexToRgb(s.keyColor)), type: 'vec3<f32>' },
        uSimilarity: { value: s.similarity, type: 'f32' },
        uSmoothness: { value: s.smoothness, type: 'f32' },
        uSpill: { value: s.spill, type: 'f32' }
      })
    },
    // Filter at the output resolution, so keyed clips stay as sharp as unkeyed ones.
    resolution: 'inherit'
  })
}
