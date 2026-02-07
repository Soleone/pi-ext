import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent"
import { DynamicBorder } from "@mariozechner/pi-coding-agent"
import { Container, SelectList, Text, truncateToWidth, type SelectItem } from "@mariozechner/pi-tui"

type IssueStatus = "open" | "in_progress" | "blocked" | "deferred" | "closed"

type ListMode = "ready" | "open" | "all"

interface BdIssue {
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

// Result from list/edit views — either a navigation action or a priority change
type ViewResult =
  | { action: "select"; id: string }
  | { action: "priority"; id: string; priority: number }
  | { action: "cancel" }

// Internal actions for the issue list component (extends ViewResult with filter control)
type ListAction =
  | ViewResult
  | { action: "applyFilter"; term: string }
  | { action: "clearFilter" }

interface IssueListConfig {
  title: string
  issues: BdIssue[]
  allowPriority?: boolean
  allowSearch?: boolean
}

const MAX_LIST_RESULTS = 200
const HELP_EDIT = "↑↓ navigate • enter select • 0-4 priority • esc back"
const CTRL_F = "\x06"

function isLikelyIssueId(value: string): boolean {
  return /^[a-z0-9]+-[a-z0-9]+$/i.test(value)
}

// ANSI 256-color codes for priority
const PRIORITY_COLORS: Record<number, string> = {
  0: "\x1b[38;5;196m", // red
  1: "\x1b[38;5;208m", // orange
  2: "\x1b[38;5;34m",  // green
  3: "\x1b[38;5;33m",  // blue
  4: "\x1b[38;5;245m", // gray
}
const RESET = "\x1b[0m"

function formatPriority(priority: number | undefined): string {
  if (priority === undefined || priority === null) return "P?"
  const color = PRIORITY_COLORS[priority] ?? ""
  return `${color}P${priority}${RESET}`
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

function truncateDescription(desc: string | undefined, maxLines: number): string[] {
  if (!desc || !desc.trim()) return ["(no description)"]
  const allLines = desc.split(/\r?\n/)
  const lines = allLines.slice(0, maxLines)
  if (allLines.length > maxLines) lines.push("...")
  return lines
}

function formatIssueLabel(issue: BdIssue): string {
  return `${formatPriority(issue.priority)} ${stripIdPrefix(issue.id)} ${issue.title}`
}

function formatIssueDescription(issue: BdIssue): string {
  const extra = firstLine(issue.description)
  const type = issue.issue_type ? `${issue.issue_type}` : "issue"
  if (extra) return `${issue.status} • ${type} • ${extra}`
  return `${issue.status} • ${type}`
}

function parseJsonArray<T>(stdout: string, context: string): T[] {
  try {
    const parsed = JSON.parse(stdout)
    if (!Array.isArray(parsed)) throw new Error("expected JSON array")
    return parsed as T[]
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`Failed to parse bd output (${context}): ${msg}`)
  }
}

function safeRender(container: Container, w: number): string[] {
  return container.render(w).map((line) => truncateToWidth(line, w))
}

function parsePriorityKey(data: string): number | null {
  if (data.length !== 1) return null
  const num = parseInt(data, 10)
  return !isNaN(num) && num >= 0 && num <= 4 ? num : null
}

function matchesFilter(issue: BdIssue, term: string): boolean {
  const lower = term.toLowerCase()
  return (
    issue.title.toLowerCase().includes(lower) ||
    (issue.description ?? "").toLowerCase().includes(lower) ||
    issue.id.toLowerCase().includes(lower) ||
    issue.status.toLowerCase().includes(lower)
  )
}

function isPrintable(data: string): boolean {
  return data.length === 1 && data.charCodeAt(0) >= 32 && data.charCodeAt(0) < 127
}

function listHelpText(opts: { searching: boolean; filtered: boolean; allowPriority: boolean; allowSearch: boolean }): string {
  if (opts.searching) return "type to search • enter apply • esc cancel"
  const parts = ["↑↓ navigate", "enter select"]
  if (opts.allowPriority) parts.push("0-4 priority")
  if (opts.allowSearch) parts.push("ctrl+f search")
  parts.push(opts.filtered ? "esc clear filter" : "esc cancel")
  return parts.join(" • ")
}

export default function beadsTasks(pi: ExtensionAPI) {
  async function execBd(args: string[], timeout = 30_000): Promise<string> {
    const result = await pi.exec("bd", args, { timeout })
    if (result.code !== 0) {
      const details = (result.stderr || result.stdout || "").trim()
      throw new Error(details.length > 0 ? details : `bd ${args.join(" ")} failed (code ${result.code})`)
    }
    return result.stdout
  }

  async function listIssues(mode: ListMode): Promise<BdIssue[]> {
    if (mode === "ready") {
      const out = await execBd(["ready", "--limit", String(MAX_LIST_RESULTS), "--sort", "priority", "--json"])
      return parseJsonArray<BdIssue>(out, "ready")
    }
    if (mode === "open") {
      const out = await execBd(["list", "--sort", "priority", "--limit", String(MAX_LIST_RESULTS), "--json"])
      return parseJsonArray<BdIssue>(out, "list")
    }
    const out = await execBd(["list", "--all", "--sort", "priority", "--limit", String(MAX_LIST_RESULTS), "--json"])
    return parseJsonArray<BdIssue>(out, "list all")
  }

  async function showIssue(id: string): Promise<BdIssue> {
    const out = await execBd(["show", id, "--json"])
    const issues = parseJsonArray<BdIssue>(out, `show ${id}`)
    const issue = issues[0]
    if (!issue) throw new Error(`Issue not found: ${id}`)
    return issue
  }

  async function updateIssue(id: string, args: string[]): Promise<void> {
    await execBd(["update", id, ...args])
  }

  // Reusable issue list with Ctrl+F search, priority hotkeys, and description preview.
  // Manages filter state internally — callers get a clean ViewResult back.
  async function showIssueList(ctx: ExtensionCommandContext, config: IssueListConfig): Promise<ViewResult> {
    const { title, issues, allowPriority = true, allowSearch = true } = config

    if (issues.length === 0) {
      ctx.ui.notify("No issues found", "info")
      return { action: "cancel" }
    }

    let filterTerm = ""

    while (true) {
      const visible = filterTerm
        ? issues.filter((i) => matchesFilter(i, filterTerm))
        : issues

      if (visible.length === 0) {
        ctx.ui.notify(`No matches for "${filterTerm}"`, "warning")
        filterTerm = ""
        continue
      }

      const issueMap = new Map(visible.map((i) => [i.id, i]))
      const items: SelectItem[] = visible.map((issue) => ({
        value: issue.id,
        label: formatIssueLabel(issue),
        description: formatIssueDescription(issue),
      }))

      const result = await ctx.ui.custom<ListAction>((tui: any, theme: any, _kb: any, done: any) => {
        const container = new Container()
        let searching = false
        let searchBuffer = ""

        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)))

        const titleText = new Text("", 1, 0)
        container.addChild(titleText)

        const selectList = new SelectList(items, Math.min(items.length, 10), {
          selectedPrefix: (t: string) => theme.fg("accent", t),
          selectedText: (t: string) => theme.fg("accent", t),
          description: (t: string) => theme.fg("muted", t),
          scrollInfo: (t: string) => theme.fg("dim", t),
          noMatch: (t: string) => theme.fg("warning", t),
        })

        const descPreview = new Text("", 1, 0)
        const updateDescPreview = (issueId: string) => {
          const issue = issueMap.get(issueId)
          const lines = truncateDescription(issue?.description, 5)
          descPreview.setText(lines.map((l) => theme.fg("dim", l)).join("\n"))
        }

        if (items[0]) updateDescPreview(items[0].value)

        selectList.onSelectionChange = (item: SelectItem) => {
          updateDescPreview(item.value)
          tui.requestRender()
        }
        selectList.onSelect = (item: SelectItem) => done({ action: "select", id: item.value })
        selectList.onCancel = () => {
          if (filterTerm) {
            done({ action: "clearFilter" })
          } else {
            done({ action: "cancel" })
          }
        }
        container.addChild(selectList)

        container.addChild(new DynamicBorder((s: string) => theme.fg("muted", s)))
        container.addChild(descPreview)

        const helpText = new Text("", 1, 0)
        container.addChild(helpText)
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)))

        // Update title and help text based on current state
        const refreshDisplay = () => {
          if (searching) {
            titleText.setText(theme.fg("accent", theme.bold(`Search: ${searchBuffer}_`)))
          } else if (filterTerm) {
            titleText.setText(theme.fg("accent", theme.bold(`${title} [filter: ${filterTerm}]`)))
          } else {
            titleText.setText(theme.fg("accent", theme.bold(title)))
          }
          helpText.setText(theme.fg("dim", listHelpText({
            searching,
            filtered: !!filterTerm,
            allowPriority,
            allowSearch,
          })))
        }
        refreshDisplay()

        return {
          render: (w: number) => safeRender(container, w),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            if (searching) {
              if (data === "\x1b") {
                // Esc: cancel search, keep existing filter
                searching = false
                searchBuffer = ""
                refreshDisplay()
                container.invalidate()
                tui.requestRender()
                return
              }
              if (data === "\r") {
                // Enter: apply filter
                const term = searchBuffer.trim()
                done({ action: "applyFilter", term })
                return
              }
              if (data === "\x7f" || data === "\b") {
                // Backspace
                searchBuffer = searchBuffer.slice(0, -1)
                refreshDisplay()
                container.invalidate()
                tui.requestRender()
                return
              }
              if (isPrintable(data)) {
                searchBuffer += data
                refreshDisplay()
                container.invalidate()
                tui.requestRender()
                return
              }
              return // ignore other keys in search mode
            }

            // Normal mode
            if (allowSearch && data === CTRL_F) {
              searching = true
              searchBuffer = ""
              refreshDisplay()
              container.invalidate()
              tui.requestRender()
              return
            }

            if (allowPriority) {
              const p = parsePriorityKey(data)
              if (p !== null) {
                const selected = selectList.getSelectedItem()
                if (selected) {
                  done({ action: "priority", id: selected.value, priority: p })
                  return
                }
              }
            }

            selectList.handleInput?.(data)
            tui.requestRender()
          },
        }
      })

      // Handle internal filter actions before returning to caller
      if (result.action === "applyFilter") {
        filterTerm = result.term
        continue
      }
      if (result.action === "clearFilter") {
        filterTerm = ""
        continue
      }

      return result as ViewResult
    }
  }

  async function viewIssueDetails(ctx: ExtensionCommandContext, issue: BdIssue): Promise<void> {
    const text = [
      `# ${issue.id}: ${issue.title}`,
      "",
      `- status: ${issue.status}`,
      `- priority: P${issue.priority ?? "?"}`,
      `- type: ${issue.issue_type ?? "(unknown)"}`,
      issue.owner ? `- owner: ${issue.owner}` : undefined,
      issue.updated_at ? `- updated: ${issue.updated_at}` : undefined,
      "",
      "## Description",
      "",
      issue.description?.trim() ? issue.description : "(empty)",
    ]
      .filter((l): l is string => l !== undefined)
      .join("\n")

    await ctx.ui.editor("Issue details (Esc to close)", text)
  }

  async function editIssue(ctx: ExtensionCommandContext, id: string): Promise<void> {
    let issue = await showIssue(id)

    const menuItems: SelectItem[] = [
      { value: "view", label: "View details" },
      { value: "title", label: "Edit title" },
      { value: "description", label: "Edit description" },
      { value: "status", label: "Set status" },
      { value: "back", label: "Back" },
    ]

    while (true) {
      const result = await ctx.ui.custom<ViewResult>((tui: any, theme: any, _kb: any, done: any) => {
        const container = new Container()

        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)))

        const header = `${formatPriority(issue.priority)} ${issue.id}: ${issue.title}`
        container.addChild(new Text(theme.fg("accent", theme.bold(header)), 1, 0))

        const statusLine = `${issue.status} • ${issue.issue_type ?? "issue"}`
        container.addChild(new Text(theme.fg("muted", statusLine), 1, 0))

        const selectList = new SelectList(menuItems, menuItems.length, {
          selectedPrefix: (t: string) => theme.fg("accent", t),
          selectedText: (t: string) => theme.fg("accent", t),
          description: (t: string) => theme.fg("muted", t),
          scrollInfo: (t: string) => theme.fg("dim", t),
          noMatch: (t: string) => theme.fg("warning", t),
        })

        selectList.onSelect = (item: SelectItem) => done({ action: "select", id: item.value })
        selectList.onCancel = () => done({ action: "cancel" })
        container.addChild(selectList)

        container.addChild(new DynamicBorder((s: string) => theme.fg("muted", s)))
        const descLines = truncateDescription(issue.description, 5)
        container.addChild(new Text(descLines.map((l) => theme.fg("dim", l)).join("\n"), 1, 0))

        container.addChild(new Text(theme.fg("dim", HELP_EDIT), 1, 0))
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)))

        return {
          render: (w: number) => safeRender(container, w),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            const p = parsePriorityKey(data)
            if (p !== null) {
              done({ action: "priority", id: issue.id, priority: p })
              return
            }
            selectList.handleInput?.(data)
            tui.requestRender()
          },
        }
      })

      if (result.action === "cancel" || (result.action === "select" && result.id === "back")) return

      if (result.action === "priority") {
        await updateIssue(id, ["--priority", String(result.priority)])
        issue = await showIssue(id)
        ctx.ui.notify(`Priority set to P${result.priority}`, "success")
        continue
      }

      if (result.action === "select") {
        if (result.id === "view") {
          await viewIssueDetails(ctx, issue)
          continue
        }

        if (result.id === "title") {
          const next = await ctx.ui.editor("Title:", issue.title)
          if (next === undefined) continue
          const trimmed = next.trim().split(/\r?\n/)[0] ?? ""
          if (trimmed.length === 0) {
            ctx.ui.notify("Title cannot be empty", "warning")
            continue
          }
          await updateIssue(id, ["--title", trimmed])
          issue = await showIssue(id)
          ctx.ui.notify("Title updated", "success")
          continue
        }

        if (result.id === "description") {
          const next = await ctx.ui.editor("Description:", issue.description ?? "")
          if (next === undefined) continue
          await updateIssue(id, ["--description", next])
          issue = await showIssue(id)
          ctx.ui.notify("Description updated", "success")
          continue
        }

        if (result.id === "status") {
          const next = await ctx.ui.select("Status:", ["open", "in_progress", "blocked", "deferred", "closed"])
          if (!next) continue
          await updateIssue(id, ["--status", next])
          issue = await showIssue(id)
          ctx.ui.notify("Status updated", "success")
          continue
        }
      }
    }
  }

  async function browseIssues(ctx: ExtensionCommandContext, mode: ListMode): Promise<void> {
    const modeTitle = mode === "ready" ? "Beads — Ready" : mode === "open" ? "Beads — Open" : "Beads — All"

    while (true) {
      try {
        ctx.ui.setStatus("beads", "Loading…")
        const issues = await listIssues(mode)
        ctx.ui.setStatus("beads", undefined)

        const result = await showIssueList(ctx, { title: modeTitle, issues })

        if (result.action === "cancel") return

        if (result.action === "priority") {
          await updateIssue(result.id, ["--priority", String(result.priority)])
          ctx.ui.notify(`Priority set to P${result.priority}`, "success")
          continue
        }

        if (result.action === "select") {
          await editIssue(ctx, result.id)
          continue
        }
      } catch (e) {
        ctx.ui.setStatus("beads", undefined)
        ctx.ui.notify(e instanceof Error ? e.message : String(e), "error")
        return
      }
    }
  }

  pi.registerCommand("beads", {
    description: "Browse and edit Beads issues (list + edit fields)",
    handler: async (rawArgs, ctx) => {
      if (!ctx.hasUI) return

      const args = (rawArgs || "").trim()

      if (args.length > 0 && isLikelyIssueId(args)) {
        try {
          await editIssue(ctx, args)
        } catch (e) {
          ctx.ui.notify(e instanceof Error ? e.message : String(e), "error")
        }
        return
      }

      const mode = ((): ListMode => {
        if (args === "open") return "open"
        if (args === "all") return "all"
        return "ready"
      })()

      await browseIssues(ctx, mode)
    },
  })

  pi.registerShortcut("ctrl+q", {
    description: "Open Beads task list",
    handler: async (ctx) => {
      if (!ctx.hasUI) return
      await browseIssues(ctx as ExtensionCommandContext, "ready")
    },
  })
}
