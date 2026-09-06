/**
 * Desktop notifications for new mail.
 *
 * Rules:
 *  - at most 3 individual notifications per batch, then one summary
 *  - clicking focuses the main window and navigates to the thread
 *  - nothing at all while an account added in this session is still doing its first sync
 */
import { Notification } from 'electron'
import log from 'electron-log/main'
import type { AppSettings, MessageSummary, SyncStatus } from '@shared/types'
import type { WindowManager } from '@main/windows'

const scope = log.scope('notify')

const MAX_INDIVIDUAL = 3

export interface Notifier {
  notifyNewMail(accountId: string, messages: MessageSummary[]): void
  /** Called for every account added during this run so its initial sync stays quiet. */
  markAccountAdded(accountId: string): void
  /** Feed engine status through here; the first `listening` un-mutes the account. */
  noteStatus(status: SyncStatus): void
  markAccountRemoved(accountId: string): void
}

function senderLabel(message: MessageSummary): string {
  const from = message.from[0]
  if (!from) return 'Unknown sender'
  return from.name?.trim() || from.address
}

function bodyFor(message: MessageSummary): string {
  const subject = message.subject?.trim() || '(no subject)'
  const snippet = message.snippet?.trim()
  const body = snippet ? `${subject}\n${snippet}` : subject
  return body.length > 220 ? `${body.slice(0, 217)}...` : body
}

export function createNotifier(deps: {
  windows: WindowManager
  getSettings(): AppSettings
}): Notifier {
  /** Accounts added this session that have not reported `listening` yet. */
  const silentAccounts = new Set<string>()

  function settings(): AppSettings | null {
    try {
      return deps.getSettings()
    } catch {
      return null
    }
  }

  function show(title: string, body: string, onClick: () => void): void {
    const s = settings()
    if (!s?.notificationsEnabled) return
    if (!Notification.isSupported()) return
    try {
      const notification = new Notification({ title, body, silent: !s.notificationSound })
      notification.on('click', onClick)
      notification.show()
    } catch (err) {
      scope.warn('notification failed', err)
    }
  }

  function goTo(accountId: string, threadId?: string): void {
    deps.windows.showMainWindow()
    deps.windows.sendToMain('nav:goto', threadId ? { view: 'thread', threadId, accountId } : { view: 'inbox', accountId })
  }

  return {
    markAccountAdded(accountId) {
      silentAccounts.add(accountId)
    },

    markAccountRemoved(accountId) {
      silentAccounts.delete(accountId)
    },

    noteStatus(status) {
      // The initial backfill is over once the account settles into IDLE.
      if (status.state === 'listening' && silentAccounts.has(status.accountId)) {
        silentAccounts.delete(status.accountId)
        scope.info(`initial sync finished for ${status.accountId}; notifications enabled`)
      }
    },

    notifyNewMail(accountId, messages) {
      if (!messages.length) return
      if (silentAccounts.has(accountId)) return
      const s = settings()
      if (!s?.notificationsEnabled) return

      // Never announce our own sent mail or drafts that land back via sync.
      const fresh = messages.filter((m) => !m.flags.seen && !m.flags.draft)
      if (!fresh.length) return

      if (fresh.length > MAX_INDIVIDUAL) {
        // A big batch (initial catch-up, a busy list) gets one line instead of a stack of toasts.
        show('UniMail', `${fresh.length} new messages`, () => goTo(accountId))
        return
      }

      for (const message of fresh) {
        show(senderLabel(message), bodyFor(message), () => goTo(accountId, message.threadId))
      }
    }
  }
}
