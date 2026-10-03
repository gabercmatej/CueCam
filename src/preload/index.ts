import { contextBridge, ipcRenderer } from 'electron'
import type { SkillcamApi } from '../shared/api'
import type { ConfigResult } from '../shared/config'

const api: SkillcamApi = {
  platform: process.platform,
  getConfig: (): Promise<ConfigResult> => ipcRenderer.invoke('config:get'),
  onConfig: (callback: (result: ConfigResult) => void): void => {
    ipcRenderer.on('config:changed', (_event, result: ConfigResult) => callback(result))
  }
}

contextBridge.exposeInMainWorld('skillcam', api)
