import { contextBridge, ipcRenderer } from 'electron'
import type { AppStatus, MediaChange, SkillcamApi } from '../shared/api'
import type { ConfigResult } from '../shared/config'

const api: SkillcamApi = {
  platform: process.platform,
  getConfig: (): Promise<ConfigResult> => ipcRenderer.invoke('config:get'),
  onConfig: (callback: (result: ConfigResult) => void): void => {
    ipcRenderer.on('config:changed', (_event, result: ConfigResult) => callback(result))
  },
  resolveMedia: (entries: string[]): Promise<Record<string, string[]>> => ipcRenderer.invoke('media:resolve', entries),
  getStatus: (): Promise<AppStatus> => ipcRenderer.invoke('status:get'),
  showFolder: (): Promise<string> => ipcRenderer.invoke('folder:show'),
  onStatus: (callback: (status: AppStatus) => void): void => {
    ipcRenderer.on('status:changed', (_event, status: AppStatus) => callback(status))
  },
  onToggleArmed: (callback: () => void): void => {
    ipcRenderer.on('armed:toggle', () => callback())
  },
  onMediaChanged: (callback: (change: MediaChange) => void): void => {
    ipcRenderer.on('media:changed', (_event, change: MediaChange) => callback(change))
  }
}

contextBridge.exposeInMainWorld('skillcam', api)
