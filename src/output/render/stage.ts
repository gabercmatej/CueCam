import { Application, Container, VideoSource } from 'pixi.js'
import { type Grade, NEUTRAL_GRADE } from '../effects/grade'
import type { View } from '../view'
import { type CameraLayers, createCameraLayers, createVignette } from './cameraLayer'
import { createGradeFilter } from './gradeFilter'

/**
 * Render layers, bottom to top (BUILD_PLAN §3). Camera moves transform the whole scene.
 *   scene:   camera background → back FX → person (camera masked by segmentation) → front FX
 *   overlay: vignette, banners (screen-fixed, not moved by shake/zoom)
 * The person layer only draws while there are back FX to hide and a fresh mask; otherwise
 * back FX simply sit over the camera (the pre-segmentation behaviour).
 * The Output stage has no debug layer: UI lives in Control.
 */
export interface Stage {
  app: Application
  /** Everything camera-attached; shake/zoom apply here so effects stay glued to the video. */
  scene: Container
  back: Container
  front: Container
  overlay: Container
  camera: CameraLayers
  setGrade(grade: Grade): void
}

/**
 * The stage keeps the view's logical size (1280×720 units, which all effects are tuned in) and
 * renders at `pixels.height / view.height` resolution, so the canvas backing store has exactly
 * the output's real pixels (1920×1080): camera pixels map 1:1 and OBS captures them unscaled.
 */
export async function createStage(video: HTMLVideoElement, view: View, pixels: { width: number; height: number }, parent?: HTMLElement): Promise<Stage> {
  const app = new Application()
  await app.init({
    width: view.width,
    height: view.height,
    resolution: pixels.height / view.height,
    background: '#000000',
    preference: 'webgl',
    antialias: false,
    autoDensity: false,
    // The canvas is presented as is: no alpha compositing with the page behind it.
    backgroundAlpha: 1,
    powerPreference: 'high-performance'
  })
  // The backing store is the real pixel size; CSS stretches it over the window, which is sized
  // in points to hold exactly those pixels (main/index.ts), so nothing is resampled.
  // The web demo mounts it into its page instead, scaled to the box it is given.
  app.canvas.style.width = parent ? '100%' : '100vw'
  app.canvas.style.height = parent ? '100%' : '100vh'
  ;(parent ?? document.body).appendChild(app.canvas)
  console.log(`[output] canvas ${app.canvas.width}×${app.canvas.height} px · window ${innerWidth}×${innerHeight} pt × devicePixelRatio ${devicePixelRatio}`)

  // updateFPS 0: Pixi uploads each new camera frame (it uses requestVideoFrameCallback).
  // Linear filtering is exact at 1:1 and only blends while zoomed or shaken; no mipmaps.
  const source = new VideoSource({ resource: video, autoPlay: true, updateFPS: 0, scaleMode: 'linear', autoGenerateMipmaps: false })
  const camera = createCameraLayers(source, view.width, view.height, view.mirror)
  const vignette = createVignette(view.width, view.height)

  const scene = new Container()
  const back = new Container()
  const front = new Container()
  scene.addChild(camera.background, back, camera.person, front)
  const overlay = new Container()
  overlay.addChild(vignette.mesh)
  app.stage.addChild(scene, overlay)
  // Grade scope "all": the whole frame through one filter pass, attached only while needed.
  const gradeAll = createGradeFilter()
  const gradeFilters = [gradeAll.filter]
  app.stage.filterArea = app.screen
  let filtered = false
  return {
    app,
    scene,
    back,
    front,
    overlay,
    camera,
    setGrade(grade) {
      if (grade.all) {
        gradeAll.set(grade)
        camera.setGrade(NEUTRAL_GRADE)
      } else {
        camera.setGrade(grade)
      }
      if (grade.all !== filtered) {
        filtered = grade.all
        app.stage.filters = filtered ? gradeFilters : null
      }
      vignette.set(grade.vignette)
    }
  }
}
