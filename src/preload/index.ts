/**
 * Preload: the only bridge between the renderer and the main process.
 * `contextIsolation` is on, so everything the renderer can reach is what we expose here.
 */
import { contextBridge, ipcRenderer } from 'electron'
import type {
  IpcChannel,
  IpcEvent,
  IpcEventPayload,
  IpcReq,
  IpcRes,
  RendererApi
} from '../shared/ipc'

/** main.ts and compose.tsx share one preload; the window tells us which it is via argv. */
function readWindowKind(): RendererApi['windowKind'] {
  const flag = process.argv.find((a) => a.startsWith('--window-kind='))
  return flag?.slice('--window-kind='.length) === 'compose' ? 'compose' : 'main'
}

const api: RendererApi = {
  invoke<C extends IpcChannel>(channel: C, req: IpcReq<C>): Promise<IpcRes<C>> {
    return ipcRenderer.invoke(channel, req) as Promise<IpcRes<C>>
  },

  on<E extends IpcEvent>(event: E, handler: (payload: IpcEventPayload<E>) => void): () => void {
    const listener = (_e: Electron.IpcRendererEvent, payload: IpcEventPayload<E>): void => handler(payload)
    ipcRenderer.on(event, listener)
    return () => {
      ipcRenderer.removeListener(event, listener)
    }
  },

  windowKind: readWindowKind(),
  platform: process.platform
}

contextBridge.exposeInMainWorld('api', api)
