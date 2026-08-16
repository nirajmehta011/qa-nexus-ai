import type { CSSProperties } from 'react'

// Inline 16px stroke icons — no icon dependency, no network request, and they
// inherit currentColor so chips and buttons stay consistent.

type IconProps = { size?: number; className?: string; style?: CSSProperties }

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const
})

export const IconSpark = ({ size = 16, className, style }: IconProps) => (
  <svg {...base(size)} className={className} style={style} aria-hidden="true">
    <path d="M8 1.5l1.6 4.1L13.8 7 9.6 8.6 8 12.7 6.4 8.6 2.2 7l4.2-1.4L8 1.5z" />
    <path d="M12.8 11.4l.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6 1.5-.6.6-1.5z" />
  </svg>
)

export const IconLayers = ({ size = 16, className, style }: IconProps) => (
  <svg {...base(size)} className={className} style={style} aria-hidden="true">
    <path d="M8 1.7l6 3.1-6 3.1-6-3.1 6-3.1z" />
    <path d="M2 8.6l6 3.1 6-3.1" />
    <path d="M2 11.8l6 3.1 6-3.1" />
  </svg>
)

export const IconLink = ({ size = 16, className, style }: IconProps) => (
  <svg {...base(size)} className={className} style={style} aria-hidden="true">
    <path d="M6.6 9.4a3 3 0 004.3 0l2.1-2.1a3 3 0 00-4.3-4.3l-1.2 1.2" />
    <path d="M9.4 6.6a3 3 0 00-4.3 0L3 8.7a3 3 0 004.3 4.3l1.2-1.2" />
  </svg>
)

export const IconDoc = ({ size = 16, className, style }: IconProps) => (
  <svg {...base(size)} className={className} style={style} aria-hidden="true">
    <path d="M9.3 1.5H4.2a1 1 0 00-1 1v11a1 1 0 001 1h7.6a1 1 0 001-1V5.2L9.3 1.5z" />
    <path d="M9.2 1.6v3.6h3.5" />
    <path d="M5.8 8.6h4.4M5.8 11.1h4.4" />
  </svg>
)

export const IconJira = ({ size = 16, className, style }: IconProps) => (
  <svg {...base(size)} className={className} style={style} aria-hidden="true">
    <path d="M8 1.6l5.3 5.3a1 1 0 010 1.4L8 13.6 2.7 8.3a1 1 0 010-1.4L8 1.6z" />
    <path d="M8 5.4l2.2 2.2L8 9.8 5.8 7.6 8 5.4z" />
  </svg>
)

export const IconFolder = ({ size = 16, className, style }: IconProps) => (
  <svg {...base(size)} className={className} style={style} aria-hidden="true">
    <path d="M1.8 4.3a1 1 0 011-1h3l1.5 1.8h5.9a1 1 0 011 1v6.6a1 1 0 01-1 1H2.8a1 1 0 01-1-1V4.3z" />
  </svg>
)

export const IconZip = ({ size = 16, className, style }: IconProps) => (
  <svg {...base(size)} className={className} style={style} aria-hidden="true">
    <path d="M2.6 3a1 1 0 011-1h8.8a1 1 0 011 1v10a1 1 0 01-1 1H3.6a1 1 0 01-1-1V3z" />
    <path d="M7 2v2M9 4v2M7 6v2M9 8v2M7 10v1.6h2V10" />
  </svg>
)

export const IconDownload = ({ size = 16, className, style }: IconProps) => (
  <svg {...base(size)} className={className} style={style} aria-hidden="true">
    <path d="M8 2v8" />
    <path d="M4.8 7.2L8 10.4l3.2-3.2" />
    <path d="M2.6 13.2h10.8" />
  </svg>
)

export const IconSettings = ({ size = 16, className, style }: IconProps) => (
  <svg {...base(size)} className={className} style={style} aria-hidden="true">
    <circle cx="8" cy="8" r="2.2" />
    <path d="M12.9 9.8a1.1 1.1 0 00.22 1.22l.04.04a1.34 1.34 0 11-1.9 1.9l-.04-.04a1.11 1.11 0 00-1.88.79v.11a1.34 1.34 0 11-2.68 0v-.06a1.11 1.11 0 00-1.94-.73l-.04.04a1.34 1.34 0 11-1.9-1.9l.04-.04a1.11 1.11 0 00-.79-1.88h-.11a1.34 1.34 0 110-2.68h.06a1.11 1.11 0 00.73-1.94l-.04-.04a1.34 1.34 0 111.9-1.9l.04.04a1.1 1.1 0 001.22.22h.05a1.1 1.1 0 00.67-1v-.11a1.34 1.34 0 112.68 0v.06a1.11 1.11 0 001.88.79l.04-.04a1.34 1.34 0 111.9 1.9l-.04.04a1.1 1.1 0 00-.22 1.22v.05a1.1 1.1 0 001 .67h.11a1.34 1.34 0 110 2.68h-.06a1.1 1.1 0 00-1 .67z" />
  </svg>
)

export const IconCheck = ({ size = 16, className, style }: IconProps) => (
  <svg {...base(size)} className={className} style={style} aria-hidden="true">
    <path d="M3 8.4l3.2 3.2L13 4.8" />
  </svg>
)

export const IconAlert = ({ size = 16, className, style }: IconProps) => (
  <svg {...base(size)} className={className} style={style} aria-hidden="true">
    <path d="M8 2.4l6 10.4H2L8 2.4z" />
    <path d="M8 6.6v3M8 11.4h.01" />
  </svg>
)

export const IconChevron = ({ size = 16, className, style }: IconProps) => (
  <svg {...base(size)} className={className} style={style} aria-hidden="true">
    <path d="M5.6 3.6L10 8l-4.4 4.4" />
  </svg>
)

export const IconClose = ({ size = 16, className, style }: IconProps) => (
  <svg {...base(size)} className={className} style={style} aria-hidden="true">
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
)

export const IconPlus = ({ size = 16, className, style }: IconProps) => (
  <svg {...base(size)} className={className} style={style} aria-hidden="true">
    <path d="M8 3v10M3 8h10" />
  </svg>
)

export const IconTrash = ({ size = 16, className, style }: IconProps) => (
  <svg {...base(size)} className={className} style={style} aria-hidden="true">
    <path d="M2.8 4.2h10.4M6.4 4.2V2.9h3.2v1.3M4.4 4.2l.6 8.6a1 1 0 001 .9h4a1 1 0 001-.9l.6-8.6" />
  </svg>
)

export const IconCode = ({ size = 16, className, style }: IconProps) => (
  <svg {...base(size)} className={className} style={style} aria-hidden="true">
    <path d="M5.4 4.6L2 8l3.4 3.4M10.6 4.6L14 8l-3.4 3.4" />
  </svg>
)
