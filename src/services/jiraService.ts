import axios from 'axios'
import { extractErrorMessage } from './errorUtils'

export interface JiraIssue {
  key: string
  summary: string
  description: string
  priority: string
  status: string
  created: string
  updated: string
}

// Atlassian Document Format (ADF) node types
interface ADFNode {
  type: string
  text?: string
  content?: ADFNode[]
  attrs?: Record<string, any>
}

const API_BASE = (import.meta as any).env?.VITE_API_URL || (typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') ? 'http://localhost:3001/api' : '/api')

class JiraService {
  private email: string = ''
  private token: string = ''
  private baseUrl: string = ''

  initialize(email: string, token: string, baseUrl: string) {
    this.email = email
    this.token = token
    // A trailing slash produces //rest/api/3/… which Atlassian 404s.
    this.baseUrl = baseUrl.trim().replace(/\/+$/, '')
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      const response = await axios.post(
        `${API_BASE}/jira/test`,
        { email: this.email, token: this.token, baseUrl: this.baseUrl },
        { timeout: 15000 }
      )
      const name = response.data.user?.displayName
      return { success: true, message: name ? `Connected as ${name}` : 'Connected' }
    } catch (error: any) {
      return { success: false, message: extractErrorMessage(error, 'Jira connection failed') }
    }
  }

  async fetchIssue(issueKey: string): Promise<JiraIssue> {
    if (!this.email || !this.token || !this.baseUrl) {
      throw new Error('Jira service not initialized. Please configure settings.')
    }

    try {
      const response = await axios.post(`${API_BASE}/jira/issue`, {
        email: this.email,
        token: this.token,
        baseUrl: this.baseUrl,
        issueKey
      })

      const data = response.data.issue.fields

      return {
        key: response.data.issue.key,
        summary: data.summary || '',
        // Jira API v3 returns description as ADF object (or null) — convert to plain text
        description: this.sanitizeDescription(this.adfToText(data.description)),
        priority: data.priority?.name || 'Medium',
        status: data.status?.name || 'Open',
        created: data.created || new Date().toISOString(),
        updated: data.updated || new Date().toISOString()
      }
    } catch (error: any) {
      if (error.response?.status === 401) {
        throw new Error('Jira authentication failed. Check your credentials.')
      }
      if (error.response?.status === 404) {
        throw new Error(`Issue ${issueKey} not found.`)
      }
      throw new Error(`Failed to fetch Jira issue: ${extractErrorMessage(error)}`)
    }
  }

  /**
   * Converts Jira Atlassian Document Format (ADF) to plain text.
   * Handles: null, plain strings (legacy), and ADF objects (Jira Cloud v3).
   */
  private adfToText(description: any): string {
    // null / undefined
    if (!description) return ''

    // Already a plain string (Jira Server / old format)
    if (typeof description === 'string') return description

    // ADF object — recursively extract text nodes
    if (typeof description === 'object') {
      return this.extractTextFromADF(description).trim()
    }

    return ''
  }

  private extractTextFromADF(node: ADFNode): string {
    if (!node) return ''

    // Leaf text node
    if (node.type === 'text' && node.text) {
      return node.text
    }

    // Inline nodes that produce readable output
    if (node.type === 'hardBreak') return '\n'
    if (node.type === 'rule') return '\n---\n'

    // Recurse into content array
    const childText = (node.content || [])
      .map(child => this.extractTextFromADF(child))
      .join('')

    // Add spacing for block-level nodes
    switch (node.type) {
      case 'paragraph':
        return childText + '\n'
      case 'heading':
        return childText + '\n'
      case 'listItem':
        return '• ' + childText
      case 'bulletList':
      case 'orderedList':
        return childText + '\n'
      case 'blockquote':
        return '> ' + childText
      case 'codeBlock':
        return '```\n' + childText + '\n```\n'
      case 'inlineCard':
      case 'blockCard':
        return node.attrs?.url || ''
      default:
        return childText
    }
  }

  private sanitizeDescription(description: string): string {
    if (!description) return ''

    // Remove email addresses, phone numbers, and other PII
    return description
      .replace(/[\w.-]+@[\w.-]+\.\w+/g, '[EMAIL_REDACTED]')
      .replace(/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, '[PHONE_REDACTED]')
  }
}

export default new JiraService()
