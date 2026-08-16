import axios from 'axios'
import { extractErrorMessage } from './errorUtils'

// Turns whatever the user drops in — a URL, a PDF/DOCX/Markdown spec — into the
// plain text the generation prompt consumes. PDF/DOCX parsers are loaded from a
// CDN on first use so they never enter the app bundle.

const API_BASE =
  (import.meta as any).env?.VITE_API_URL ||
  (typeof window !== 'undefined' &&
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ? 'http://localhost:3001/api'
    : '/api')

const loaded = new Map<string, Promise<void>>()

export function loadCdnScript(src: string): Promise<void> {
  const existing = loaded.get(src)
  if (existing) return existing

  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.onload = () => resolve()
    script.onerror = () => {
      loaded.delete(src)
      reject(new Error(`Failed to load parser from ${src}. Check your network connection.`))
    }
    document.head.appendChild(script)
  })
  loaded.set(src, promise)
  return promise
}

export function cleanHTMLToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('script, style, nav, header, footer, noscript, iframe, svg, form').forEach(el => el.remove())
  const bodyText = doc.body?.textContent || ''
  return bodyText.replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim()
}

export async function parsePDFToText(file: File): Promise<string> {
  await loadCdnScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js')
  const pdfjsLib = (window as any).pdfjsLib
  if (!pdfjsLib) throw new Error('PDF parser failed to initialise.')
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'

  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise
  const pages: string[] = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    pages.push(content.items.map((item: any) => item.str).join(' '))
  }
  return pages.join('\n')
}

export async function parseDocxToText(file: File): Promise<string> {
  await loadCdnScript('https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js')
  const mammoth = (window as any).mammoth
  if (!mammoth) throw new Error('DOCX parser failed to initialise.')
  const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })
  return result.value
}

export const SUPPORTED_SPEC_EXTENSIONS = '.pdf,.docx,.txt,.md,.markdown,.json,.csv,.html'

export async function parseSpecFile(file: File): Promise<string> {
  const name = file.name.toLowerCase()
  if (name.endsWith('.pdf')) return parsePDFToText(file)
  if (name.endsWith('.docx')) return parseDocxToText(file)
  if (name.endsWith('.doc')) {
    throw new Error('Legacy .doc files are not supported — save as .docx or paste the text instead.')
  }
  if (name.endsWith('.html') || name.endsWith('.htm')) return cleanHTMLToText(await file.text())
  return file.text()
}

/** Fetches a spec URL through the server proxy (browsers block cross-origin reads). */
export async function fetchSpecFromUrl(url: string): Promise<{ title: string; text: string }> {
  try {
    const response = await axios.post(`${API_BASE}/fetch-url`, { url }, { timeout: 45000 })
    const html: string = response.data.content || response.data.html || ''
    if (!html) throw new Error('The page returned no readable content.')
    const text = /<[a-z][\s\S]*>/i.test(html) ? cleanHTMLToText(html) : html.trim()
    if (!text) throw new Error('The page returned no readable text after stripping markup.')
    return { title: response.data.title || url, text }
  } catch (error: any) {
    throw new Error(extractErrorMessage(error, `Could not fetch ${url}`))
  }
}
