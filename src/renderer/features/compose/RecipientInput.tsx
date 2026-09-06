/**
 * Chip-style recipient field with contact autocomplete.
 * Commit a chip with Enter, Tab, comma, semicolon or blur; paste splits a whole list;
 * Backspace on an empty input pulls the last chip back into the text box for editing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ClipboardEvent, KeyboardEvent } from 'react'
import type { EmailAddress } from '@shared/types'
import { api } from '@renderer/lib/api'
import { dedupeAddresses, formatAddress, isValidAddress, parseAddressList } from './util'

interface Suggestion {
  name?: string
  address: string
  count: number
}

export interface RecipientInputProps {
  id?: string
  label: string
  value: EmailAddress[]
  onChange: (next: EmailAddress[]) => void
  placeholder?: string
  autoFocus?: boolean
  /** Rendered at the right of the row (the Cc / Bcc toggles on the To line). */
  trailing?: React.ReactNode
}

export function RecipientInput({
  id,
  label,
  value,
  onChange,
  placeholder,
  autoFocus,
  trailing
}: RecipientInputProps): React.JSX.Element {
  const [text, setText] = useState('')
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [highlight, setHighlight] = useState(0)
  const [open, setOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const blurTimer = useRef<number | undefined>(undefined)

  const chosen = useMemo(() => new Set(value.map((v) => v.address.toLowerCase())), [value])

  // Debounced contact lookup.
  useEffect(() => {
    const q = text.trim()
    if (q.length < 1) {
      setSuggestions([])
      setOpen(false)
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      void api
        .invoke('contacts:suggest', { q, limit: 8 })
        .then((res) => {
          if (cancelled) return
          const filtered = res.filter((r) => !chosen.has(r.address.toLowerCase()))
          setSuggestions(filtered)
          setHighlight(0)
          setOpen(filtered.length > 0)
        })
        .catch(() => {
          if (!cancelled) setSuggestions([])
        })
    }, 180)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [text, chosen])

  useEffect(
    () => () => {
      if (blurTimer.current) window.clearTimeout(blurTimer.current)
    },
    []
  )

  const commit = useCallback(
    (raw: string): boolean => {
      const parsed = parseAddressList(raw)
      if (!parsed.length) return false
      onChange(dedupeAddresses([...value, ...parsed]))
      setText('')
      setSuggestions([])
      setOpen(false)
      return true
    },
    [onChange, value]
  )

  const acceptSuggestion = useCallback(
    (s: Suggestion) => {
      onChange(dedupeAddresses([...value, { name: s.name, address: s.address }]))
      setText('')
      setSuggestions([])
      setOpen(false)
      inputRef.current?.focus()
    },
    [onChange, value]
  )

  const removeAt = useCallback(
    (index: number) => {
      onChange(value.filter((_, i) => i !== index))
    },
    [onChange, value]
  )

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (open && suggestions.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlight((h) => (h + 1) % suggestions.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        acceptSuggestion(suggestions[highlight])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setOpen(false)
        return
      }
    }

    if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
      if (text.trim()) {
        e.preventDefault()
        commit(text)
      } else if (e.key !== 'Enter') {
        e.preventDefault()
      }
      return
    }
    if (e.key === 'Tab' && text.trim()) {
      // Let Tab still move focus, but keep what was typed.
      commit(text)
      return
    }
    if (e.key === 'Backspace' && text === '' && value.length) {
      e.preventDefault()
      const last = value[value.length - 1]
      onChange(value.slice(0, -1))
      setText(formatAddress(last))
    }
  }

  function onPaste(e: ClipboardEvent<HTMLInputElement>): void {
    const pasted = e.clipboardData.getData('text')
    if (!pasted) return
    const parsed = parseAddressList(pasted)
    if (parsed.length <= 1 && !/[,;\n]/.test(pasted)) return
    e.preventDefault()
    onChange(dedupeAddresses([...value, ...parsed]))
    setText('')
  }

  function onBlur(): void {
    blurTimer.current = window.setTimeout(() => {
      setOpen(false)
      if (text.trim()) commit(text)
    }, 140)
  }

  return (
    <div className="cw-recipients">
      <label className="cw-field-label" htmlFor={id}>
        {label}
      </label>
      <div className="cw-chipbox" onClick={() => inputRef.current?.focus()}>
        {value.map((a, i) => {
          const valid = isValidAddress(a.address)
          return (
            <span
              key={`${a.address}-${i}`}
              className={`cw-chip ${valid ? '' : 'is-invalid'}`}
              title={valid ? formatAddress(a) : `${a.address} is not a valid address`}
            >
              <span className="cw-chip-text">{a.name || a.address}</span>
              <button
                type="button"
                className="cw-chip-x"
                aria-label={`Remove ${a.address}`}
                onClick={(e) => {
                  e.stopPropagation()
                  removeAt(i)
                }}
              >
                ×
              </button>
            </span>
          )
        })}
        <input
          id={id}
          ref={inputRef}
          className="cw-chipinput"
          value={text}
          autoFocus={autoFocus}
          placeholder={value.length ? '' : placeholder}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={onBlur}
          onFocus={() => {
            if (blurTimer.current) window.clearTimeout(blurTimer.current)
          }}
        />
        {open && suggestions.length > 0 && (
          <ul className="cw-suggest" role="listbox">
            {suggestions.map((s, i) => (
              <li
                key={s.address}
                role="option"
                aria-selected={i === highlight}
                className={`cw-suggest-item ${i === highlight ? 'is-active' : ''}`}
                onMouseEnter={() => setHighlight(i)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  acceptSuggestion(s)
                }}
              >
                <span className="cw-suggest-name">{s.name || s.address}</span>
                {s.name && <span className="cw-suggest-addr">{s.address}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      {trailing != null && <div className="cw-recipients-trailing">{trailing}</div>}
    </div>
  )
}

export default RecipientInput
