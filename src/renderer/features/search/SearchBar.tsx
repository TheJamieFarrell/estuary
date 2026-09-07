import type { ReactElement } from 'react'
import { useEffect, useRef, useState } from 'react'
import { IconButton } from '@renderer/components/ui'
import * as Icons from '@renderer/components/icons'
import { useDebounced } from '@renderer/lib/hooks'
import { selectAccount, useStore } from '@renderer/lib/store'
import './search.css'

/** id used by the '/' shortcut to focus the field. */
export const SEARCH_INPUT_ID = 'estuary-search-input'

interface Hint {
  op: string
  desc: string
}

const HINTS: Hint[] = [
  { op: 'from:', desc: 'Sender name or address' },
  { op: 'to:', desc: 'Recipient' },
  { op: 'subject:', desc: 'Words in the subject' },
  { op: 'has:attachment', desc: 'Only messages with files' },
  { op: 'is:unread', desc: 'Only unread' },
  { op: 'is:starred', desc: 'Only starred' },
  { op: 'before:', desc: 'Before a date, e.g. before:2026-01-31' },
  { op: 'after:', desc: 'After a date, e.g. after:2026-01-01' }
]

export function SearchBar(): ReactElement {
  const storedQuery = useStore((s) => s.searchQuery)
  const searchActive = useStore((s) => s.searchActive)
  const mailView = useStore((s) => s.mailView)
  const account = useStore((s) => selectAccount(s, mailView.accountId))
  const runSearch = useStore((s) => s.runSearch)
  const clearSearch = useStore((s) => s.clearSearch)
  const setSearchQuery = useStore((s) => s.setSearchQuery)

  const [value, setValue] = useState(storedQuery)
  const [focused, setFocused] = useState(false)
  const [hintIndex, setHintIndex] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounced = useDebounced(value, 300)
  const lastRun = useRef<string>(storedQuery)

  // keep in sync when the store clears the search elsewhere
  useEffect(() => {
    if (!searchActive && storedQuery === '') {
      setValue('')
      lastRun.current = ''
    }
  }, [searchActive, storedQuery])

  useEffect(() => {
    const trimmed = debounced.trim()
    if (trimmed === lastRun.current) return
    lastRun.current = trimmed
    setSearchQuery(trimmed)
    if (trimmed.length === 0) clearSearch()
    else if (trimmed.length >= 2) void runSearch(trimmed)
  }, [debounced, runSearch, clearSearch, setSearchQuery])

  const lastToken = value.split(/\s+/).pop() ?? ''
  const suggestions = HINTS.filter(
    (h) => lastToken.length === 0 || h.op.toLowerCase().startsWith(lastToken.toLowerCase())
  )
  const showHints = focused && suggestions.length > 0 && (value.length === 0 || lastToken.length > 0)

  function applyHint(hint: Hint): void {
    const parts = value.split(/\s+/)
    parts[parts.length - 1] = hint.op
    const next = parts.join(' ')
    setValue(hint.op.endsWith(':') ? next : `${next} `)
    inputRef.current?.focus()
  }

  const scopeLabel = mailView.kind === 'account' && account ? account.email : 'All accounts'

  return (
    <div className="sb">
      <div className="sb__field">
        <span className="sb__icon">
          <Icons.Search size={14} />
        </span>
        <input
          id={SEARCH_INPUT_ID}
          ref={inputRef}
          className="sb__input"
          type="search"
          role="searchbox"
          placeholder="Search mail — try from:, is:unread, has:attachment"
          aria-label="Search mail"
          value={value}
          onFocus={() => setFocused(true)}
          onBlur={() => window.setTimeout(() => setFocused(false), 120)}
          onChange={(e) => setValue(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setValue('')
              clearSearch()
              e.currentTarget.blur()
              return
            }
            if (showHints && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault()
              setHintIndex((i) => {
                const next = e.key === 'ArrowDown' ? i + 1 : i - 1
                return (next + suggestions.length) % suggestions.length
              })
              return
            }
            if (e.key === 'Enter') {
              if (showHints && hintIndex >= 0) {
                e.preventDefault()
                applyHint(suggestions[hintIndex])
                setHintIndex(-1)
                return
              }
              lastRun.current = value.trim()
              setSearchQuery(value.trim())
              void runSearch(value.trim())
            }
          }}
        />
        <span className="sb__scope" title={`Searching ${scopeLabel}`}>
          {scopeLabel}
        </span>
        {value ? (
          <IconButton
            title="Clear search"
            size="sm"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setValue('')
              clearSearch()
            }}
          >
            <Icons.Close size={13} />
          </IconButton>
        ) : null}
      </div>

      {showHints ? (
        <div className="sb__hints" role="listbox" aria-label="Search operators">
          {suggestions.map((h, i) => (
            <button
              key={h.op}
              type="button"
              className="sb__hint"
              data-active={i === hintIndex}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => applyHint(h)}
            >
              <span className="sb__hint-op">{h.op}</span>
              <span className="sb__hint-desc">{h.desc}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export default SearchBar
