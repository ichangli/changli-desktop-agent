import { contextBridge, ipcRenderer } from 'electron'
import type { Api, Snapshot } from '../shared/types'
const api: Api = {
  workspace: () => ipcRenderer.invoke('changli:workspace'),
  saveMemory: value => ipcRenderer.invoke('changli:memory-save', value),
  deleteMemory: id => ipcRenderer.invoke('changli:memory-delete', id),
  configureApp: () => ipcRenderer.invoke('changli:app-configure'),
  renameApp: value => ipcRenderer.invoke('changli:app-rename', value),
  grantApp: value => ipcRenderer.invoke('changli:app-grant', value),
  runTool: value => ipcRenderer.invoke('changli:tool-run', value),
  snapshot: () => ipcRenderer.invoke('changli:snapshot'),
  create: () => ipcRenderer.invoke('changli:create'),
  select: id => ipcRenderer.invoke('changli:select', id),
  send: text => ipcRenderer.invoke('changli:send', text),
  retry: id => ipcRenderer.invoke('changli:retry', id),
  stop: () => ipcRenderer.invoke('changli:stop'),
  saveSettings: value => ipcRenderer.invoke('changli:settings', value),
  testConnection: () => ipcRenderer.invoke('changli:test'),
  onChange: callback => { const listener = (_event: unknown, value: Snapshot) => callback(value); ipcRenderer.on('changli:change', listener); return () => ipcRenderer.removeListener('changli:change', listener) }
}
contextBridge.exposeInMainWorld('changli', api)
