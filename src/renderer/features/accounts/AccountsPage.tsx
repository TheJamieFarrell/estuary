/**
 * Accounts screen: the list of configured accounts plus the add/edit wizard.
 *
 * Account data, sync statuses and auth errors come from the shared store (which already
 * subscribes to `accounts:changed` / `sync:status` / `account:authError`); mutations go
 * straight to IPC and then refresh the store.
 */
import { useCallback, useEffect, useState } from 'react'
import type { Account, SyncStatus } from '@shared/types'
import { api } from '@renderer/lib/api'
import { useStore } from '@renderer/lib/store'
import {
  Button,
  ConfirmDialog,
  EmptyState,
  Section,
  useToast
} from '@renderer/features/common-local/ui'
import AccountCard from './AccountCard'
import AccountWizard from './AccountWizard'
import './accounts.css'

export function AccountsPage(): React.JSX.Element {
  const accounts = useStore((s) => s.accounts)
  const settings = useStore((s) => s.settings)
  const storeStatuses = useStore((s) => s.syncStatuses)
  const authErrors = useStore((s) => s.authErrors)
  const reloadAccounts = useStore((s) => s.reloadAccounts)
  const goToUnifiedInbox = useStore((s) => s.goToUnifiedInbox)

  const toast = useToast()

  const [statuses, setStatuses] = useState<Record<string, SyncStatus>>({})
  const [wizardOpen, setWizardOpen] = useState(false)
  const [editing, setEditing] = useState<Account | undefined>(undefined)
  const [removing, setRemoving] = useState<Account | undefined>(undefined)
  const [removeBusy, setRemoveBusy] = useState(false)
  const [syncingIds, setSyncingIds] = useState<string[]>([])

  // One-shot snapshot on mount; live updates arrive through the store's own subscription.
  useEffect(() => {
    void api
      .invoke('sync:status', undefined)
      .then((list) => {
        setStatuses(Object.fromEntries(list.map((s) => [s.accountId, s])))
      })
      .catch(() => undefined)
  }, [])

  const statusFor = useCallback(
    (id: string): SyncStatus | undefined => storeStatuses?.[id] ?? statuses[id],
    [storeStatuses, statuses]
  )

  const openAdd = useCallback(() => {
    setEditing(undefined)
    setWizardOpen(true)
  }, [])

  const openEdit = useCallback((account: Account) => {
    setEditing(account)
    setWizardOpen(true)
  }, [])

  const onSaved = useCallback(
    (saved: Account) => {
      const wasEditing = editing != null
      setWizardOpen(false)
      setEditing(undefined)
      void reloadAccounts()
      void api.invoke('sync:now', { accountId: saved.id }).catch(() => undefined)
      // After adding a brand new account, drop the user back into the unified inbox.
      if (!wasEditing) goToUnifiedInbox()
    },
    [editing, reloadAccounts, goToUnifiedInbox]
  )

  const syncNow = useCallback(
    async (account: Account) => {
      setSyncingIds((ids) => [...ids, account.id])
      try {
        await api.invoke('sync:now', { accountId: account.id })
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not start a sync')
      } finally {
        setSyncingIds((ids) => ids.filter((i) => i !== account.id))
      }
    },
    [toast]
  )

  const reconnect = useCallback(
    async (account: Account) => {
      try {
        const res = await api.invoke('accounts:reauth', { id: account.id })
        if (res.ok) {
          toast.success(`${account.email} reconnected`)
          void reloadAccounts()
        } else {
          toast.error(res.error || 'Could not reconnect that account')
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not reconnect that account')
      }
    },
    [toast, reloadAccounts]
  )

  const confirmRemove = useCallback(async () => {
    if (!removing) return
    setRemoveBusy(true)
    try {
      await api.invoke('accounts:remove', { id: removing.id })
      toast.success(`${removing.email} removed`)
      setRemoving(undefined)
      void reloadAccounts()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not remove that account')
    } finally {
      setRemoveBusy(false)
    }
  }, [removing, toast, reloadAccounts])

  return (
    <div className="ac-page">
      <div className="ac-inner">
        <div className="ac-header">
          <h1 className="ac-heading">Accounts</h1>
          <Button variant="primary" onClick={openAdd}>
            Add account
          </Button>
        </div>

        {accounts.length === 0 ? (
          <EmptyState
            title="No accounts yet"
            description="Add a Gmail, Outlook, Spacemail or IMAP account to start reading mail."
            action={
              <Button variant="primary" onClick={openAdd}>
                Add account
              </Button>
            }
          />
        ) : (
          <Section title={`${accounts.length} account${accounts.length === 1 ? '' : 's'}`}>
            <ul className="ac-list">
              {accounts.map((a) => (
                <AccountCard
                  key={a.id}
                  account={a}
                  status={statusFor(a.id)}
                  authError={authErrors?.[a.id]}
                  syncing={syncingIds.includes(a.id)}
                  onEdit={() => openEdit(a)}
                  onReconnect={() => void reconnect(a)}
                  onSyncNow={() => void syncNow(a)}
                  onRemove={() => setRemoving(a)}
                />
              ))}
            </ul>
          </Section>
        )}
      </div>

      <AccountWizard
        open={wizardOpen}
        account={editing}
        usedColors={accounts.map((a) => a.color)}
        settings={settings}
        onClose={() => {
          setWizardOpen(false)
          setEditing(undefined)
        }}
        onSaved={onSaved}
      />

      <ConfirmDialog
        open={removing != null}
        title={`Remove ${removing?.email ?? 'this account'}?`}
        message="Its cached messages are deleted from this computer. Nothing is deleted on the mail server."
        confirmLabel="Remove account"
        danger
        busy={removeBusy}
        onConfirm={() => void confirmRemove()}
        onCancel={() => setRemoving(undefined)}
      />
    </div>
  )
}

export default AccountsPage
