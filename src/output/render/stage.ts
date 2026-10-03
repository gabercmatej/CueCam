import { Application, Container, Sprite, Texture, VideoSource } from 'pixi.js'
import type { View } from '../view'

/**
 * Render layers, bottom to top (BUILD_PLAN §3). Camera moves transform the whole scene.
 * "back" sits just above the opaque camera (under front FX) until Phase 3's person cutout
 * goes between back and front FX. The Output stage has no debug layer: UI lives in Control.
 */
export interface Stage {
  app: Application
  /** back FX + camera + front FX; shake/zoom apply here so effects stay glued to the video. */
  scene: Container
  back: Container
  front: Container
  overlay: Container
}

export async function createStage(video: HTMLVideoElement, view: View): Promise<Stage> {
  const app = new Application()
  await app.init({
    width: view.width,
    height: view.height,
    background: '#000000',
    preference: 'webgl',
    antialias: false,
    autoDensity: false,
    resolution: 1
  })
  document.body.appendChild(app.canvas)

  // updateFPS 0: Pixi uploads each new camera frame (it uses requestVideoFrameCallback).
  const source = new VideoSource({ resource: video, autoPlay: true, updateFPS: 0 })
  const camera = new Sprite(new Texture({ source }))
  camera.width = view.width
  camera.height = view.height
  if (view.mirror) {
    // Flip the picture only; effect coordinates are mirrored in view.toScreen.
    camera.scale.x *= -1
    camera.x = view.width
  }

  const scene = new Container()
  const back = new Container()
  const front = new Container()
  scene.addChild(camera, back, front)
  const overlay = new Container()
  app.stage.addChild(scene, overlay)
  return { app, scene, back, front, overlay }
}
