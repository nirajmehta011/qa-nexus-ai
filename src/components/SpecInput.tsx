import { useRef, useState } from 'react'
import { useSettings } from '../context/SettingsContext'
import jiraService from '../services/jiraService'
import { fetchSpecFromUrl, parseSpecFile, SUPPORTED_SPEC_EXTENSIONS } from '../services/documentParser'
import { extractErrorMessage } from '../services/errorUtils'
import type { MediaFileData, SpecInput as Spec } from '../services/aiService'
import { IconDoc, IconJira, IconLink, IconAlert, IconCheck, IconTrash } from './Icons'

// Three ways in, one normalised SpecInput out: a live URL, an uploaded
// requirements document, or a Jira issue key.

type Mode = 'url' | 'document' | 'jira'

const MODES: { id: Mode; label: string; icon: typeof IconLink }[] = [
  { id: 'url', label: 'URL', icon: IconLink },
  { id: 'document', label: 'Document', icon: IconDoc },
  { id: 'jira', label: 'Jira ID', icon: IconJira }
]

/** Spec text beyond this is trimmed — providers reject over-long prompts. */
const MAX_SPEC_CHARS = 24000

// Providers reject oversized inline payloads outright, and a rejected request
// costs the user a full round-trip — so cap before sending, not after.
const MAX_MEDIA_BYTES = 12 * 1024 * 1024
const MAX_MEDIA_FILES = 6

export interface AttachedMedia extends MediaFileData {
  name: string
  size: number
  /** Object URL for the thumbnail; revoked when the attachment is removed. */
  previewUrl: string
  isVideo: boolean
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      const comma = result.indexOf(',')
      if (comma === -1) reject(new Error(`Could not read ${file.name}.`))
      else resolve(result.slice(comma + 1))
    }
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`))
    reader.readAsDataURL(file)
  })
}

function deriveKey(mode: Mode, value: string): string {
  if (mode === 'jira') return value.toUpperCase()
  if (mode === 'url') {
    try {
      return new URL(value).hostname.replace(/^www\./, '')
    } catch {
      return 'spec'
    }
  }
  return value.replace(/\.[^.]+$/, '').slice(0, 40) || 'spec'
}

export default function SpecInput({
  spec,
  onSpec,
  media,
  onMedia,
  disabled
}: {
  spec: Spec | null
  onSpec: (spec: Spec | null) => void
  media: AttachedMedia[]
  onMedia: (media: AttachedMedia[]) => void
  disabled: boolean
}) {
  const { settings } = useSettings()
  const [mode, setMode] = useState<Mode>('url')
  const [url, setUrl] = useState('')
  const [jiraId, setJiraId] = useState('')
  const [pasted, setPasted] = useState('')
  const [fileName, setFileName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const mediaRef = useRef<HTMLInputElement>(null)

  const attachMedia = async (files: FileList) => {
    setError('')
    const room = MAX_MEDIA_FILES - media.length
    if (room <= 0) return setError(`At most ${MAX_MEDIA_FILES} attachments.`)

    const picked = Array.from(files).slice(0, room)
    const used = media.reduce((sum, m) => sum + m.size, 0)
    const attached: AttachedMedia[] = []
    let budget = MAX_MEDIA_BYTES - used

    for (const file of picked) {
      if (file.size > budget) {
        setError(
          `"${file.name}" does not fit — attachments are capped at ${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)}MB in total. Trim the clip or attach fewer files.`
        )
        break
      }
      try {
        attached.push({
          name: file.name,
          size: file.size,
          mimeType: file.type || 'application/octet-stream',
          base64: await readAsBase64(file),
          previewUrl: URL.createObjectURL(file),
          isVideo: file.type.startsWith('video/')
        })
        budget -= file.size
      } catch (err) {
        setError(extractErrorMessage(err, `Could not read ${file.name}.`))
      }
    }
    if (attached.length > 0) onMedia([...media, ...attached])
  }

  const removeMedia = (name: string) => {
    const target = media.find(m => m.name === name)
    if (target) URL.revokeObjectURL(target.previewUrl)
    onMedia(media.filter(m => m.name !== name))
  }

  const apply = (next: Spec) => {
    setError('')
    onSpec({ ...next, description: next.description.slice(0, MAX_SPEC_CHARS) })
  }

  const loadUrl = async () => {
    const trimmed = url.trim()
    if (!trimmed) return setError('Enter a URL first.')
    setBusy(true)
    setError('')
    try {
      const { text } = await fetchSpecFromUrl(trimmed)
      apply({
        key: deriveKey('url', trimmed),
        summary: `Application under test: ${trimmed}`,
        description: text,
        priority: 'High',
        source: trimmed
      })
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not read that URL.'))
      onSpec(null)
    } finally {
      setBusy(false)
    }
  }

  const loadFile = async (file: File) => {
    setBusy(true)
    setError('')
    setFileName(file.name)
    try {
      const text = await parseSpecFile(file)
      if (!text.trim()) throw new Error('That file contained no readable text.')
      apply({
        key: deriveKey('document', file.name),
        summary: `Requirements document: ${file.name}`,
        description: text,
        priority: 'High',
        source: file.name
      })
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not read that file.'))
      onSpec(null)
    } finally {
      setBusy(false)
    }
  }

  const loadJira = async () => {
    const key = jiraId.trim().toUpperCase()
    if (!key) return setError('Enter a Jira issue key, e.g. PROJ-123.')
    const { email, token, baseUrl } = settings.jira
    if (!email || !token || !baseUrl) {
      return setError('Add your Jira credentials in Settings first.')
    }
    setBusy(true)
    setError('')
    try {
      jiraService.initialize(email, token, baseUrl)
      const issue = await jiraService.fetchIssue(key)
      apply({
        key: issue.key,
        summary: issue.summary,
        description: issue.description || issue.summary,
        priority: issue.priority,
        source: `Jira ${issue.key}`
      })
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not fetch that issue.'))
      onSpec(null)
    } finally {
      setBusy(false)
    }
  }

  const usePasted = () => {
    const text = pasted.trim()
    if (text.length < 30) return setError('Paste at least a short paragraph of requirements.')
    apply({
      key: 'PASTED',
      summary: text.split('\n')[0].slice(0, 90) || 'Pasted requirement',
      description: text,
      priority: 'High',
      source: 'Pasted text'
    })
  }

  return (
    <>
      <div className="segmented mb-3">
        {MODES.map(m => (
          <button
            key={m.id}
            aria-pressed={mode === m.id}
            onClick={() => setMode(m.id)}
            disabled={disabled}
            className="flex items-center justify-center gap-1.5"
          >
            <m.icon size={12} />
            {m.label}
          </button>
        ))}
      </div>

      {mode === 'url' && (
        <div className="flex gap-2">
          <input
            className="field"
            type="url"
            placeholder="https://app.example.com/login"
            value={url}
            disabled={disabled || busy}
            onChange={e => setUrl(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && loadUrl()}
          />
          <button className="btn btn-sm" onClick={loadUrl} disabled={disabled || busy}>
            {busy ? <span className="spinner" /> : null}
            Fetch
          </button>
        </div>
      )}

      {mode === 'document' && (
        <div>
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            accept={SUPPORTED_SPEC_EXTENSIONS}
            onChange={e => {
              const file = e.target.files?.[0]
              if (file) loadFile(file)
              e.target.value = ''
            }}
          />
          <button
            className="dropzone w-full"
            onClick={() => fileRef.current?.click()}
            disabled={disabled || busy}
            onDragOver={e => e.preventDefault()}
            onDrop={e => {
              e.preventDefault()
              const file = e.dataTransfer.files?.[0]
              if (file) loadFile(file)
            }}
          >
            <div className="flex flex-col items-center gap-1.5">
              {busy ? <span className="spinner" /> : <IconDoc size={20} className="opacity-60" />}
              <span className="text-[13px]">{fileName || 'Drop a spec, or click to browse'}</span>
              <span className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
                PDF · DOCX · Markdown · TXT · HTML
              </span>
            </div>
          </button>
        </div>
      )}

      {mode === 'jira' && (
        <div className="flex gap-2">
          <input
            className="field mono uppercase"
            placeholder="PROJ-123"
            value={jiraId}
            disabled={disabled || busy}
            onChange={e => setJiraId(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && loadJira()}
          />
          <button className="btn btn-sm" onClick={loadJira} disabled={disabled || busy}>
            {busy ? <span className="spinner" /> : null}
            Fetch
          </button>
        </div>
      )}

      <details className="mt-3">
        <summary
          className="cursor-pointer list-none text-[11px] hover:underline"
          style={{ color: 'var(--text-faint)' }}
        >
          …or paste the requirement text directly
        </summary>
        <div className="mt-2 space-y-2">
          <textarea
            className="field"
            rows={5}
            placeholder="As a user, I want to log in so that…"
            value={pasted}
            disabled={disabled}
            onChange={e => setPasted(e.target.value)}
          />
          <button className="btn btn-sm" onClick={usePasted} disabled={disabled}>
            Use this text
          </button>
        </div>
      </details>

      <div className="mt-3 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
        <div className="flex items-center gap-2">
          <span className="eyebrow">Screens &amp; recordings</span>
          <input
            ref={mediaRef}
            type="file"
            className="hidden"
            accept="image/*,video/*"
            multiple
            onChange={e => {
              if (e.target.files?.length) attachMedia(e.target.files)
              e.target.value = ''
            }}
          />
          <button
            className="btn btn-sm ml-auto"
            onClick={() => mediaRef.current?.click()}
            disabled={disabled || media.length >= MAX_MEDIA_FILES}
          >
            Attach
          </button>
        </div>
        <p className="mt-1 text-[11px]" style={{ color: 'var(--text-faint)' }}>
          Wireframes, screenshots or a screen recording. The model reads them alongside the text — often the
          richest source when the written spec is thin. Needs a vision-capable model (Gemini, GPT-4o).
        </p>

        {media.length > 0 && (
          <ul className="mt-2 space-y-1.5">
            {media.map(file => (
              <li key={file.name} className="panel-raised flex items-center gap-2 p-1.5">
                {file.isVideo ? (
                  <video src={file.previewUrl} className="h-9 w-9 shrink-0 rounded object-cover" muted />
                ) : (
                  <img src={file.previewUrl} alt="" className="h-9 w-9 shrink-0 rounded object-cover" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11.5px]">{file.name}</span>
                  <span className="block text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
                    {(file.size / 1024 / 1024).toFixed(1)} MB
                  </span>
                </span>
                <button
                  className="btn btn-ghost btn-sm shrink-0"
                  onClick={() => removeMedia(file.name)}
                  disabled={disabled}
                  aria-label={`Remove ${file.name}`}
                >
                  <IconTrash size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && (
        <p className="mt-3 flex items-start gap-1.5 text-xs" style={{ color: 'var(--err)' }}>
          <IconAlert size={13} className="mt-0.5 shrink-0" />
          {error}
        </p>
      )}

      {spec && !error && (
        <div className="mt-3 rounded-md border p-2.5" style={{ borderColor: 'var(--mint-line)', background: 'var(--mint-dim)' }}>
          <p className="flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--mint)' }}>
            <IconCheck size={13} />
            {spec.source}
          </p>
          <p className="mt-1 line-clamp-2 text-[11px]" style={{ color: 'var(--text-dim)' }}>
            {spec.summary}
          </p>
          <p className="mt-1 text-[11px]" style={{ color: 'var(--text-faint)' }}>
            {spec.description.length.toLocaleString()} characters of requirement text loaded
          </p>
        </div>
      )}
    </>
  )
}
