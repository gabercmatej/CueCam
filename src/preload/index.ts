import { contextBridge, ipcRenderer } from 'electron'
import type { SkillcamApi } from '../shared/api'
import type { ConfigResult } from '../shared/config'

const api: SkillcamApi = {
  platform: process.platform,
  getConfig: (): Promise<ConfigResult> => ipcRenderer.invoke('config:get'),
  onConfig: (callback: (result: ConfigResult) => void): void => {
    ipcRenderer.on('config:changed', (_event, result: ConfigResult) => callback(result))
  },
  resolveMedia: (entries: string[]): Promise<Record<string, string[]>> => ipcRenderer.invoke('media:resolve', entries)
}

contextBridge.exposeInMainWorld('skillcam', api)
