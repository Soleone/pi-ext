export type IssueStatus = "open" | "in_progress" | "blocked" | "deferred" | "closed"
export type EditFocus = "nav" | "title" | "desc"

export interface BdIssue {
  id: string
  title: string
  description?: string
  status: IssueStatus
  priority?: number
  issue_type?: string
  owner?: string
  created_at?: string
  updated_at?: string
  dependency_count?: number
  dependent_count?: number
  comment_count?: number
}

interface IssueListElements {
  priority: string
  id: string
  title: string
  status: string
  type: string
  summary?: string
}

export interface IssueListRowModel {
  id: string
  label: string
  description: string
}

// ANSI 256-color codes for priority
const PRIORITY_COLORS: Record<number, string> = {
  0: "\x1b[38;5;196m", // red
  1: "\x1b[38;5;208m", // orange
  2: "\x1b[38;5;34m",  // green
  3: "\x1b[38;5;33m",  // blue
  4: "\x1b[38;5;245m", // gray
}

const MUTED_TEXT = "\x1b[38;5;245m"
const ANSI_RESET = "\x1b[0m"
export const DESCRIPTION_PART_SEPARATOR = "\u241F"

export const EDIT_HELP_TEXT: Record<EditFocus, string> = {
  title: "type | backspace | enter save | tab desc | esc/q back",
  desc: "type | backspace | arrows | enter save | tab nav | esc/q back",
  nav: "tab nav | space status | 1-5 priority | esc/q/ctrl+c back",
}

function formatPriority(priority: number | undefined): string {
  if (priority === undefined || priority === null) return "P?"
  const color = PRIORITY_COLORS[priority] ?? ""
  return `${color}P${priority}${ANSI_RESET}`
}

function stripIdPrefix(id: string): string {
  const idx = id.indexOf("-")
  return idx >= 0 ? id.slice(idx + 1) : id
}

function firstLine(text: string | undefined): string | undefined {
  if (!text) return undefined
  const line = text.split(/\r?\n/)[0]?.trim()
  return line && line.length > 0 ? line : undefined
}

export function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "")
}

function buildIssueListElements(issue: BdIssue): IssueListElements {
  return {
    priority: formatPriority(issue.priority),
    id: stripIdPrefix(issue.id),
    title: issue.title,
    status: issue.status.slice(0, 4).padEnd(4),
    type: (issue.issue_type || "issue").slice(0, 4).padEnd(4),
    summary: firstLine(issue.description),
  }
}

function encodeIssueDescription(meta: string, summary?: string): string {
  return summary ? `${meta}${DESCRIPTION_PART_SEPARATOR}${summary}` : meta
}

export function decodeIssueDescription(text: string): { meta: string; summary?: string } {
  const [meta, summary] = text.split(DESCRIPTION_PART_SEPARATOR)
  return { meta: meta || "", summary }
}

export function buildIssueListRowModel(issue: BdIssue, maxLabelWidth?: number): IssueListRowModel {
  const elements = buildIssueListElements(issue)
  const mutedId = `${MUTED_TEXT}${elements.id}${ANSI_RESET}`
  const baseLabel = `${elements.priority} ${mutedId} ${elements.title}`
  const visibleWidth = stripAnsi(baseLabel).length
  const label = maxLabelWidth !== undefined && visibleWidth < maxLabelWidth
    ? baseLabel + " ".repeat(maxLabelWidth - visibleWidth)
    : baseLabel

  const meta = `${elements.status} • ${elements.type}`
  return {
    id: issue.id,
    label,
    description: encodeIssueDescription(meta, elements.summary),
  }
}

export function buildIssueEditHeader(issueId: string, priority: number | undefined, status: IssueStatus): string {
  return `${formatPriority(priority)} ${stripIdPrefix(issueId)} [${status}]`
}

export function buildWorkPrompt(issue: BdIssue): string {
  const lines = [
    `Work on Beads task ${issue.id}: ${issue.title}`,
    "",
    `Status: ${issue.status}`,
    `Priority: ${issue.priority ?? "unknown"}`,
  ]

  if (issue.description && issue.description.trim()) {
    lines.push("", "Context:", issue.description.trim())
  }

  return lines.join("\n")
}
