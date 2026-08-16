import { useRef, useState } from 'react'
import {
  analyzeFramework,
  readDirectory,
  readZip,
  type FrameworkProfile
} from '../services/frameworkAnalyzer'
import { extractErrorMessage } from '../services/errorUtils'
import { IconAlert, IconFolder, IconTrash, IconZip, IconChevron } from './Icons'

// The differentiator. Everything here runs in the browser: the user's source
// never leaves their machine, only the distilled signature (class names, method
// signatures, conventions) is sent with the generation prompt.

export default function FrameworkUploader({
  profile,
  onProfile,
  disabled
}: {
  profile: FrameworkProfile | null
  onProfile: (profile: FrameworkProfile | null) => void
  disabled: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [dragging, setDragging] = useState(false)
  const zipRef = useRef<HTMLInputElement>(null)
  const dirRef = useRef<HTMLInputElement>(null)

  const ingest = async (load: () => Promise<{ files: Awaited<ReturnType<typeof readZip>>; name: string }>) => {
    setBusy(true)
    setError('')
    try {
      const { files, name } = await load()
      const analyzed = analyzeFramework(files, name)
      onProfile(analyzed)
      setExpanded(true)
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not read that framework.'))
      onProfile(null)
    } finally {
      setBusy(false)
    }
  }

  const handleZip = (file: File) =>
    ingest(async () => ({ files: await readZip(file), name: file.name.replace(/\.zip$/i, '') }))

  const handleDirectory = (fileList: FileList) =>
    ingest(async () => {
      const first = fileList[0] as any
      const rootName = (first?.webkitRelativePath || '').split('/')[0] || 'framework'
      return { files: await readDirectory(fileList), name: rootName }
    })

  return (
    <>
      {!profile && (
        <>
          <input
            ref={zipRef}
            type="file"
            accept=".zip"
            className="hidden"
            onChange={e => {
              const file = e.target.files?.[0]
              if (file) handleZip(file)
              e.target.value = ''
            }}
          />
          <input
            ref={dirRef}
            type="file"
            className="hidden"
            // Non-standard but supported in every Chromium/WebKit browser; the
            // ZIP path is the fallback where it isn't.
            {...({ webkitdirectory: '', directory: '' } as any)}
            multiple
            onChange={e => {
              if (e.target.files?.length) handleDirectory(e.target.files)
              e.target.value = ''
            }}
          />

          <div
            className={`dropzone ${dragging ? 'dropzone-active' : ''}`}
            onDragOver={e => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={e => {
              e.preventDefault()
              setDragging(false)
              const file = e.dataTransfer.files?.[0]
              if (file?.name.toLowerCase().endsWith('.zip')) handleZip(file)
              else setError('Drop a .zip of your framework, or use the folder picker.')
            }}
          >
            <div className="flex flex-col items-center gap-2">
              {busy ? <span className="spinner" /> : <IconZip size={20} className="opacity-60" />}
              <span className="text-[13px]">{busy ? 'Analysing framework…' : 'Drop a .zip of your framework'}</span>
              <div className="mt-1 flex gap-2">
                <button
                  className="btn btn-sm"
                  onClick={() => zipRef.current?.click()}
                  disabled={disabled || busy}
                >
                  <IconZip size={13} /> Choose .zip
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => dirRef.current?.click()}
                  disabled={disabled || busy}
                >
                  <IconFolder size={13} /> Choose folder
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {error && (
        <p className="mt-3 flex items-start gap-1.5 text-xs" style={{ color: 'var(--err)' }}>
          <IconAlert size={13} className="mt-0.5 shrink-0" />
          {error}
        </p>
      )}

      {profile && <FrameworkSummary profile={profile} expanded={expanded} onToggle={() => setExpanded(v => !v)} onClear={() => onProfile(null)} />}
    </>
  )
}

function FrameworkSummary({
  profile,
  expanded,
  onToggle,
  onClear
}: {
  profile: FrameworkProfile
  expanded: boolean
  onToggle: () => void
  onClear: () => void
}) {
  const c = profile.conventions
  return (
    <div className="rise">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium" style={{ color: 'var(--mint)' }}>
            {profile.projectName}
          </p>
          <p className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
            {profile.fileCount} files · {profile.pages.length} page objects · {profile.fixtures.length} fixtures
          </p>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onClear} aria-label="Remove framework">
          <IconTrash size={13} />
        </button>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <span className="chip chip-mint">{c.pageFileNaming}</span>
        <span className="chip chip-mint">{c.specFileNaming}</span>
        <span className="chip">{c.indentation}</span>
        <span className="chip">{c.quoteStyle} quotes</span>
        {profile.baseUrl && <span className="chip">baseURL set</span>}
      </div>

      <button
        className="mt-3 flex w-full items-center gap-1 text-[11px]"
        style={{ color: 'var(--text-faint)' }}
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <IconChevron size={12} className={expanded ? 'rotate-90 transition-transform' : 'transition-transform'} />
        What we extracted
      </button>

      {expanded && (
        <div className="mt-2 space-y-3 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
          <div>
            <p className="eyebrow mb-1">Locator strategy</p>
            <p className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
              {c.locatorStrategy}
            </p>
          </div>

          {profile.fixtures.length > 0 && (
            <div>
              <p className="eyebrow mb-1">Fixtures</p>
              <p className="mono text-[11px]" style={{ color: 'var(--text-dim)' }}>
                {profile.fixtures.map(f => f.name).join(', ')}
              </p>
            </div>
          )}

          {profile.pages.length > 0 ? (
            <div>
              <p className="eyebrow mb-1.5">Page objects the generator will reuse</p>
              <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
                {profile.pages.map(page => (
                  <div key={`${page.filePath}:${page.className}`} className="panel-raised p-2.5">
                    <p className="mono text-[12px] font-semibold" style={{ color: 'var(--mint)' }}>
                      {page.className}
                    </p>
                    <p className="mono truncate text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
                      {page.filePath}
                    </p>
                    {page.methods.length > 0 && (
                      <p className="mono mt-1.5 text-[11px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                        {page.methods.slice(0, 8).map(m => `${m.name}()`).join('  ')}
                        {page.methods.length > 8 ? `  +${page.methods.length - 8}` : ''}
                      </p>
                    )}
                    {page.locators.length > 0 && (
                      <p className="mt-1 text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
                        {page.locators.length} locator{page.locators.length === 1 ? '' : 's'}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {profile.warnings.map(w => (
            <p key={w} className="flex items-start gap-1.5 text-[11px]" style={{ color: 'var(--warn)' }}>
              <IconAlert size={12} className="mt-0.5 shrink-0" />
              {w}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}
