import type { ReactElement } from 'react'
import { Kbd, Modal } from '@renderer/components/ui'
import { SHORTCUTS } from '@renderer/lib/shortcuts'
import type { ShortcutDef } from '@renderer/lib/shortcuts'

const GROUPS: ShortcutDef['group'][] = ['Navigation', 'Actions', 'Application']

export function ShortcutsHelp({ open, onClose }: { open: boolean; onClose: () => void }): ReactElement {
  return (
    <Modal open={open} onClose={onClose} title="Keyboard shortcuts" size="lg">
      <div className="shortcuts-grid">
        {GROUPS.map((group) => (
          <div key={group} className="shortcuts-group">
            <div className="shortcuts-group__title">{group}</div>
            {SHORTCUTS.filter((s) => s.group === group).map((s) => (
              <div key={s.keys} className="shortcuts-row">
                <span className="shortcuts-row__label">{s.label}</span>
                <Kbd>{s.keys}</Kbd>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Modal>
  )
}
