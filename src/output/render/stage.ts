import { Application, Container, Sprite, Texture, VideoSource } from 'pixi.js'
import { FRAME_HEIGHT, FRAME_WIDTH } from '../camera'

export interface Stage {
  app: Application
  /** Debug drawings (Phase 0 only; moves to the Control window in Phase 2). */
  debug: Container
}

export async function createStage(video: HTMLVideoElement): Promise<Stage> {
  const app = new Application()
  await app.init({
    width: FRAME_WIDTH,
    height: FRAME_HEIGHT,
    background: '#000000',
    preference: 'webgl',
    antialias: false,
    autoDensity: false,
    resolution: 1
  })
  document.body.appendChild(app.canvas)

  // updateFPS 0 = upload the latest camera frame every render.
  const source = new VideoSource({ resource: video, autoPlay: true, updateFPS: 0 })
  const camera = new Sprite(new Texture({ source }))
  camera.width = FRAME_WIDTH
  camera.height = FRAME_HEIGHT

  const debug = new Container()
  app.stage.addChild(camera, debug)
  return { app, debug }
}
