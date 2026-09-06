/**
 * Rich-text body editor built on TipTap 3.
 *
 * The toolbar is hidden behind the "Aa" button in the footer; the parent owns that state.
 * Inline images are a tiny local node (StarterKit has no image node and we do not want another
 * dependency): they render from a data: URL and are rewritten to `cid:` on send.
 */
import { useCallback, useEffect, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import type { Editor } from '@tiptap/react'
import { Node, mergeAttributes } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import Underline from '@tiptap/extension-underline'
import Placeholder from '@tiptap/extension-placeholder'
import { IconButton, Button, Input, Modal } from '@renderer/features/common-local/ui'

/** Minimal inline image node: `<img src alt>` round-trips through the schema. */
const InlineImage = Node.create({
  name: 'inlineImage',
  group: 'inline',
  inline: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
      'data-cid': { default: null }
    }
  },
  parseHTML() {
    return [{ tag: 'img[src]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['img', mergeAttributes(HTMLAttributes)]
  }
})

export interface ComposeEditorProps {
  /** Initial HTML. Changing it resets the document (used when a draft loads). */
  initialHtml: string
  onChange: (html: string) => void
  onEditorReady?: (editor: Editor | null) => void
  /** Called for each image on the clipboard; resolves to the data URL to insert. */
  onPasteImage?: (file: File) => Promise<string | null>
  showToolbar: boolean
  placeholder?: string
  /** Ctrl+Enter inside the editor should still send. */
  onSendShortcut?: () => void
}

export function ComposeEditor({
  initialHtml,
  onChange,
  onEditorReady,
  onPasteImage,
  showToolbar,
  placeholder = 'Write your message…',
  onSendShortcut
}: ComposeEditorProps): React.JSX.Element {
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')
  // TipTap 3 does not re-render on every transaction; bump this from the transaction handler
  // so the toolbar's active states stay in sync.
  const [, setTick] = useState(0)

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // StarterKit 3 bundles link + underline; use the standalone configured versions instead.
        link: false,
        underline: false
      }),
      Underline,
      Link.configure({ openOnClick: false, autolink: true, linkOnPaste: true }),
      Placeholder.configure({ placeholder }),
      InlineImage
    ],
    content: initialHtml || '',
    editorProps: {
      attributes: { class: 'cw-prose' },
      handleKeyDown: (_view, event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
          event.preventDefault()
          onSendShortcut?.()
          return true
        }
        return false
      },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []).filter((f) =>
          f.type.startsWith('image/')
        )
        if (!files.length || !onPasteImage) return false
        event.preventDefault()
        void (async () => {
          for (const file of files) {
            const dataUrl = await onPasteImage(file)
            if (dataUrl) {
              editorRef.current
                ?.chain()
                .focus()
                .insertContent({ type: 'inlineImage', attrs: { src: dataUrl, alt: file.name } })
                .run()
            }
          }
        })()
        return true
      }
    },
    onUpdate: ({ editor: e }) => onChange(e.getHTML()),
    onTransaction: () => setTick((t) => (t + 1) % 1000)
  })

  // Keep a ref for the paste handler, which is created before `editor` exists.
  const editorRef = useEditorRef(editor)

  useEffect(() => {
    onEditorReady?.(editor ?? null)
  }, [editor, onEditorReady])

  // `content` is only read when the editor is created, so push later changes in explicitly.
  // This is what makes the signature swap on a From change show up in the document.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    if (initialHtml === editor.getHTML()) return
    const wasFocused = editor.isFocused
    editor.commands.setContent(initialHtml, { emitUpdate: false })
    if (wasFocused) editor.commands.focus('end')
  }, [editor, initialHtml])

  const openLinkModal = useCallback(() => {
    if (!editor) return
    setLinkUrl(editor.getAttributes('link').href ?? '')
    setLinkOpen(true)
  }, [editor])

  const applyLink = useCallback(() => {
    if (!editor) return
    const url = linkUrl.trim()
    const chain = editor.chain().focus().extendMarkRange('link')
    if (!url) chain.unsetLink().run()
    else chain.setLink({ href: /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}` }).run()
    setLinkOpen(false)
  }, [editor, linkUrl])

  const can = (fn: () => boolean): boolean => {
    try {
      return fn()
    } catch {
      return false
    }
  }

  return (
    <div className="cw-editor-wrap">
      {showToolbar && editor && (
        <div className="cw-toolbar" role="toolbar" aria-label="Formatting">
          <IconButton
            title="Bold (Ctrl+B)"
            active={editor.isActive('bold')}
            onClick={() => editor.chain().focus().toggleBold().run()}
          >
            <strong>B</strong>
          </IconButton>
          <IconButton
            title="Italic (Ctrl+I)"
            active={editor.isActive('italic')}
            onClick={() => editor.chain().focus().toggleItalic().run()}
          >
            <em>I</em>
          </IconButton>
          <IconButton
            title="Underline (Ctrl+U)"
            active={editor.isActive('underline')}
            onClick={() => editor.chain().focus().toggleUnderline().run()}
          >
            <span style={{ textDecoration: 'underline' }}>U</span>
          </IconButton>
          <IconButton
            title="Strikethrough"
            active={editor.isActive('strike')}
            onClick={() => editor.chain().focus().toggleStrike().run()}
          >
            <span style={{ textDecoration: 'line-through' }}>S</span>
          </IconButton>
          <span className="cw-toolbar-sep" />
          <IconButton
            title="Bulleted list"
            active={editor.isActive('bulletList')}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
          >
            ••
          </IconButton>
          <IconButton
            title="Numbered list"
            active={editor.isActive('orderedList')}
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
          >
            1.
          </IconButton>
          <IconButton
            title="Quote"
            active={editor.isActive('blockquote')}
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
          >
            ❝
          </IconButton>
          <span className="cw-toolbar-sep" />
          <IconButton title="Link (Ctrl+K)" active={editor.isActive('link')} onClick={openLinkModal}>
            🔗
          </IconButton>
          <IconButton
            title="Clear formatting"
            onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}
          >
            ⌫
          </IconButton>
          <span className="cw-toolbar-sep" />
          <IconButton
            title="Undo (Ctrl+Z)"
            disabled={!can(() => editor.can().undo())}
            onClick={() => editor.chain().focus().undo().run()}
          >
            ↶
          </IconButton>
          <IconButton
            title="Redo (Ctrl+Y)"
            disabled={!can(() => editor.can().redo())}
            onClick={() => editor.chain().focus().redo().run()}
          >
            ↷
          </IconButton>
        </div>
      )}

      <EditorContent className="cw-editor" editor={editor} />

      <Modal
        open={linkOpen}
        title="Add link"
        onClose={() => setLinkOpen(false)}
        footer={
          <>
            <Button onClick={() => setLinkOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={applyLink}>
              {linkUrl.trim() ? 'Apply' : 'Remove link'}
            </Button>
          </>
        }
      >
        <Input
          autoFocus
          placeholder="https://example.com"
          value={linkUrl}
          onChange={(e) => setLinkUrl(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              applyLink()
            }
          }}
        />
      </Modal>
    </div>
  )
}

/** Small helper so callbacks created during `useEditor` can reach the editor instance. */
function useEditorRef(editor: Editor | null): { current: Editor | null } {
  const [ref] = useState<{ current: Editor | null }>(() => ({ current: null }))
  ref.current = editor
  return ref
}

export default ComposeEditor
