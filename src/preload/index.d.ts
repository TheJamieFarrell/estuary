/**
 * `window.api` is already declared globally by `src/shared/ipc.ts` (which both tsconfigs
 * include), so there is nothing to re-declare here. This file exists so the renderer's
 * tsconfig has a stable anchor for the preload surface.
 *
 * @see ../shared/ipc.ts - RendererApi
 */
export {}
