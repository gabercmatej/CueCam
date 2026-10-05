/// <reference types="vite/client" />

interface Window {
  skillcam: import('./shared/api').SkillcamApi & {
    /** Web demo only: elements the stage canvas and the Control panel mount into, instead of the window and a popup. */
    mount?: { stage: HTMLElement; panel: HTMLElement }
  }
}
