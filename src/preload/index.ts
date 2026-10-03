import { contextBridge } from 'electron'

// Phase 0: nothing to expose yet beyond a marker. IPC lands with the Control window (Phase 2).
contextBridge.exposeInMainWorld('skillcam', { platform: process.platform })
