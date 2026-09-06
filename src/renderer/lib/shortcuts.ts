/**
 * Global keyboard shortcuts. Events originating in inputs / textareas / contenteditable
 * are ignored (except Escape and the Ctrl/Cmd combos).
 */
import { useEffect, useRef } from 'react'
import { useEvent } from './hooks'

export interface ShortcutActions {
  next: () => void
  prev: () => void
  open: () => void
  archive: () => void
  trash: () => void
  reply: () => void
  replyAll: () => void
  forward: () => void
  star: () => void
  markUnread: () => void
  markRead: () => void
  toggleSelect: () => void
  compose: () => void
  focusSearch: () => void
  escape: () => void
  gotoInbox: () => void
  gotoStarred: () => void
  gotoSent: () => void
  gotoDrafts: () => void
  help: () => void
  refresh: () => void
}

export interface ShortcutDef {
  keys: string
  label: string
  group: 'Navigation' | 'Actions' | 'Application'
}

/** Rendered in the "?" help modal. Keep in sync with the handler below. */
export const SHORTCUTS: ShortcutDef[] = [
  { keys: 'j / ↓', label: 'Next conversation', group: 'Navigation' },
  { keys: 'k / ↑', label: 'Previous conversation', group: 'Navigation' },
  { keys: 'Enter', label: 'Open conversation', group: 'Navigation' },
  { keys: 'g i', label: 'Go to Inbox', group: 'Navigation' },
  { keys: 'g s', label: 'Go to Starred', group: 'Navigation' },
  { keys: 'g t', label: 'Go to Sent', group: 'Navigation' },
  { keys: 'g d', label: 'Go to Drafts', group: 'Navigation' },
  { keys: '/', label: 'Search', group: 'Navigation' },
  { keys: 'Esc', label: 'Close / clear', group: 'Navigation' },
  { keys: 'e', label: 'Archive', group: 'Actions' },
  { keys: '# / Del', label: 'Move to Trash', group: 'Actions' },
  { keys: 'r', label: 'Reply', group: 'Actions' },
  { keys: 'a', label: 'Reply all', group: 'Actions' },
  { keys: 'f', label: 'Forward', group: 'Actions' },
  { keys: 's', label: 'Star / unstar', group: 'Actions' },
  { keys: 'u', label: 'Mark unread', group: 'Actions' },
  { keys: 'I', label: 'Mark read', group: 'Actions' },
  { keys: 'x', label: 'Select conversation', group: 'Actions' },
  { keys: 'c / Ctrl+N', label: 'Compose', group: 'Application' },
  { keys: 'F5 / Ctrl+R', label: 'Refresh', group: 'Application' },
  { keys: '?', label: 'Keyboard shortcuts', group: 'Application' }
]

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.tagName) return false
  const tag = el.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  if (el.isContentEditable) return true
  return false
}

/**
 * Install the global handler. `enabled` lets the caller suspend it (e.g. while a modal is open
 * that owns the keyboard).
 */
export function useGlobalShortcuts(actions: ShortcutActions, enabled = true): void {
  const run = useEvent((name: keyof ShortcutActions) => actions[name]())
  const pending = useRef<{ key: string; at: number } | null>(null)

  useEffect(() => {
    if (!enabled) return

    function onKeyDown(e: KeyboardEvent): void {
      const typing = isTypingTarget(e.target)
      const mod = e.ctrlKey || e.metaKey

      if (e.key === 'Escape') {
        if (typing) (e.target as HTMLElement).blur()
        run('escape')
        return
      }

      if (mod && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault()
        run('compose')
        return
      }
      if ((mod && (e.key === 'r' || e.key === 'R')) || e.key === 'F5') {
        e.preventDefault()
        run('refresh')
        return
      }
      if (typing || e.altKey || mod) return

      // two-key 'g' sequences
      const now = Date.now()
      if (pending.current && now - pending.current.at < 1200 && pending.current.key === 'g') {
        pending.current = null
        switch (e.key.toLowerCase()) {
          case 'i':
            e.preventDefault()
            run('gotoInbox')
            return
          case 's':
            e.preventDefault()
            run('gotoStarred')
            return
          case 't':
            e.preventDefault()
            run('gotoSent')
            return
          case 'd':
            e.preventDefault()
            run('gotoDrafts')
            return
          default:
            return
        }
      }
      if (e.key === 'g') {
        pending.current = { key: 'g', at: now }
        return
      }

      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          e.preventDefault()
          run('next')
          break
        case 'k':
        case 'ArrowUp':
          e.preventDefault()
          run('prev')
          break
        case 'Enter':
          run('open')
          break
        case 'e':
          e.preventDefault()
          run('archive')
          break
        case '#':
        case 'Delete':
          e.preventDefault()
          run('trash')
          break
        case 'r':
          e.preventDefault()
          run('reply')
          break
        case 'a':
          e.preventDefault()
          run('replyAll')
          break
        case 'f':
          e.preventDefault()
          run('forward')
          break
        case 's':
          e.preventDefault()
          run('star')
          break
        case 'u':
          e.preventDefault()
          run('markUnread')
          break
        case 'I':
          e.preventDefault()
          run('markRead')
          break
        case 'x':
          e.preventDefault()
          run('toggleSelect')
          break
        case 'c':
          e.preventDefault()
          run('compose')
          break
        case '/':
          e.preventDefault()
          run('focusSearch')
          break
        case '?':
          e.preventDefault()
          run('help')
          break
        default:
          break
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled, run])
}
