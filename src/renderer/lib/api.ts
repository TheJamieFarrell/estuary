/**
 * Typed access to the preload bridge. In a plain browser (no Electron) it falls back to the
 * in-memory mock in ./mock.ts so the UI can be developed with `vite` alone.
 * Owned by the renderer-core agent; other renderer code must import `api` from here.
 */
import type { IpcChannel, IpcEvent, IpcEventPayload, IpcReq, IpcRes, RendererApi } from '@shared/ipc'

let impl: RendererApi | undefined = typeof window !== 'undefined' ? window.api : undefined

export function setApiImplementation(api: RendererApi): void {
  impl = api
}

export function hasElectronApi(): boolean {
  return typeof window !== 'undefined' && !!window.api
}

async function getImpl(): Promise<RendererApi> {
  if (impl) return impl
  const mod = await import('./mock')
  impl = mod.createMockApi()
  return impl
}

export const api = {
  async invoke<C extends IpcChannel>(channel: C, req: IpcReq<C>): Promise<IpcRes<C>> {
    const a = await getImpl()
    return a.invoke(channel, req)
  },
  on<E extends IpcEvent>(event: E, handler: (payload: IpcEventPayload<E>) => void): () => void {
    let off: (() => void) | undefined
    let cancelled = false
    void getImpl().then((a) => {
      if (!cancelled) off = a.on(event, handler)
    })
    return () => {
      cancelled = true
      off?.()
    }
  },
  get windowKind(): 'main' | 'compose' {
    return impl?.windowKind ?? (location.pathname.includes('compose') ? 'compose' : 'main')
  }
}
