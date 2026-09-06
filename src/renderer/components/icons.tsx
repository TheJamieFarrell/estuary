/**
 * Inline SVG icon set. No icon library. All icons use `currentColor` and default to 16px.
 * Owned by the renderer-core agent; safe for any renderer feature to import.
 */
import type { ReactElement, ReactNode, SVGProps } from 'react'

export interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number
}

function Svg({ size = 16, children, ...rest }: IconProps & { children: ReactNode }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

export const Inbox = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M3 13h4l1.5 2.5h7L17 13h4" />
    <path d="M4.5 5.5h15L21 13v5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18v-5z" />
  </Svg>
)

export const Send = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M21.5 3.5 11 14" />
    <path d="M21.5 3.5 15 21l-4-7-7-4z" />
  </Svg>
)

export const Draft = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
    <path d="m16.5 3.5 4 4L14 14h-4v-4z" />
  </Svg>
)

export const Trash = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M4 7h16" />
    <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    <path d="M6 7v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7" />
    <path d="M10 11v6M14 11v6" />
  </Svg>
)

export const Spam = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5v5.5M12 16.2v.3" />
  </Svg>
)

export const Archive = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="4" rx="1" />
    <path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" />
    <path d="M10 12h4" />
  </Svg>
)

export const Star = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="m12 3.8 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 10l5.9-.9z" />
  </Svg>
)

export const StarFilled = (p: IconProps): ReactElement => (
  <Svg {...p} fill="currentColor">
    <path d="m12 3.8 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 10l5.9-.9z" />
  </Svg>
)

export const Reply = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M9 7 4 12l5 5" />
    <path d="M4 12h9a7 7 0 0 1 7 7v1" />
  </Svg>
)

export const ReplyAll = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M8 7 3 12l5 5" />
    <path d="M13 7l-5 5 5 5" />
    <path d="M8 12h6a7 7 0 0 1 7 7v1" />
  </Svg>
)

export const Forward = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="m15 7 5 5-5 5" />
    <path d="M20 12h-9a7 7 0 0 0-7 7v1" />
  </Svg>
)

export const Search = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </Svg>
)

export const Settings = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.3a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-2.8-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.5 14H3a2 2 0 1 1 0-4h.2a1.6 1.6 0 0 0 1.1-2.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 10 3.5V3a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.4a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.4 1z" />
  </Svg>
)

export const Plus = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)

export const Refresh = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M20 11a8 8 0 0 0-13.7-5.3L4 8" />
    <path d="M4 4v4h4" />
    <path d="M4 13a8 8 0 0 0 13.7 5.3L20 16" />
    <path d="M20 20v-4h-4" />
  </Svg>
)

export const Attachment = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M20 11.5 12.3 19a4.6 4.6 0 0 1-6.5-6.5l7.9-7.9a3 3 0 0 1 4.3 4.3l-7.9 7.9a1.5 1.5 0 0 1-2.1-2.1l7.2-7.2" />
  </Svg>
)

export const ChevronDown = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
)

export const ChevronRight = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="m9 6 6 6-6 6" />
  </Svg>
)

export const ChevronLeft = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="m15 6-6 6 6 6" />
  </Svg>
)

export const Close = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
)

export const More = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
  </Svg>
)

export const Check = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
)

export const Mail = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="m3.5 7 8.5 6 8.5-6" />
  </Svg>
)

export const MailOpen = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M3 10.5 12 4l9 6.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <path d="m3 10.5 9 6 9-6" />
  </Svg>
)

export const Folder = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Svg>
)

export const Warning = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M10.3 3.9 2.6 17.4A2 2 0 0 0 4.3 20.4h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    <path d="M12 9v4.5M12 17v.3" />
  </Svg>
)

export const Bell = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M18 8a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7" />
    <path d="M13.7 20a2 2 0 0 1-3.4 0" />
  </Svg>
)

export const Moon = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M20.5 14.3A8.5 8.5 0 1 1 9.7 3.5a7 7 0 0 0 10.8 10.8z" />
  </Svg>
)

export const Sun = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19" />
  </Svg>
)

export const Compose = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" />
    <path d="m17.5 2.5 4 4L13 15H9v-4z" />
  </Svg>
)

export const Filter = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M4 5h16l-6.5 7.6V20l-3-2v-5.4z" />
  </Svg>
)

export const Download = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M12 3.5v11" />
    <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
    <path d="M4 18.5v.5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-.5" />
  </Svg>
)

export const ExternalLink = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M14 4h6v6" />
    <path d="M20 4 11 13" />
    <path d="M18 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" />
  </Svg>
)

export const User = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <circle cx="12" cy="8" r="3.6" />
    <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
  </Svg>
)

export const Menu = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Svg>
)

export const Offline = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M3 3l18 18" />
    <path d="M5 12.5a10 10 0 0 1 3.5-2.3M2.5 9a14 14 0 0 1 4-2.6M17.5 10.4A10 10 0 0 1 19 12.5M21.5 9a14 14 0 0 0-9.6-3.4" />
    <path d="M9 16a4 4 0 0 1 5.5-.4" />
    <path d="M12 20h.01" />
  </Svg>
)

export const Move = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <path d="M11 13h5M14 10.5 16.5 13 14 15.5" />
  </Svg>
)

export const Code = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="m9 8-5 4 5 4M15 8l5 4-5 4" />
  </Svg>
)

export const Image = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <rect x="3" y="4.5" width="18" height="15" rx="2" />
    <circle cx="8.5" cy="9.5" r="1.5" />
    <path d="m4 17 5-4.5 4 3.5 3-2.5 4 3.5" />
  </Svg>
)
