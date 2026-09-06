/**
 * Entry point for the compose BrowserWindow (compose.html).
 * Applies the app theme/density to this window, then mounts <ComposeApp/>.
 */
import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import type { AppSettings } from '@shared/types'
import { api } from '@renderer/lib/api'
import { ToastProvider } from '@renderer/components/ui'
import ComposeApp from '@renderer/features/compose/ComposeApp'
import './styles/tokens.css'
import './styles/global.css'

function applyTheme(settings: Pick<AppSettings, 'theme' | 'density'>): void {
  const root = document.documentElement
  const dark =
    settings.theme === 'dark' ||
    (settings.theme === 'system' &&
      window.matchMedia?.('(prefers-color-scheme: dark)').matches === true)
  root.dataset.theme = dark ? 'dark' : 'light'
  root.dataset.density = settings.density ?? 'comfortable'
}

function Root(): React.JSX.Element {
  useEffect(() => {
    let current: Pick<AppSettings, 'theme' | 'density'> = { theme: 'system', density: 'comfortable' }
    void api
      .invoke('settings:get', undefined)
      .then((s) => {
        current = s
        applyTheme(s)
      })
      .catch(() => applyTheme(current))

    const offSettings = api.on('settings:changed', (s) => {
      current = s
      applyTheme(s)
    })

    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    const onScheme = (): void => applyTheme(current)
    mq?.addEventListener?.('change', onScheme)

    return () => {
      offSettings()
      mq?.removeEventListener?.('change', onScheme)
    }
  }, [])

  return (
    <ToastProvider>
      <ComposeApp />
    </ToastProvider>
  )
}

const container = document.getElementById('root')
if (container) {
  createRoot(container).render(
    <StrictMode>
      <Root />
    </StrictMode>
  )
}
