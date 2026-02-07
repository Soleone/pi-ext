import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent"
import { DynamicBorder } from "@mariozechner/pi-coding-agent"
import { Container, SelectList, Text, matchesKey, Key, truncateToWidth, CURSOR_MARKER } from "@mariozechner/pi-tui"

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

interface IssueListConfig {
  title: string
  issues: BdIssue[]
  allowPriority?: boolean
  allowSearch?: boolean
  filterTerm?: string
}

const MAX_LIST_RESULTS = 200
const CTRL_F = "\x06"
const CTRL_Q = "\x11"

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

function formatPriority(priority: number | undefined): string {
  if (priority === undefined || priority === null) return "P?"
  const color = PRIORITY_COLORS[priority] ?? ""
  return `${color}P${priority}\x1b[0m`
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

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "")
}

function formatIssueLabel(issue: BdIssue, maxLabelWidth?: number): string {
  const label = `${formatPriority(issue.priority)} ${stripIdPrefix(issue.id)} ${issue.title}`
  if (maxLabelWidth !== undefined) {
    const visibleWidth = stripAnsi(label).length
    if (visibleWidth < maxLabelWidth) {
      return label + " ".repeat(maxLabelWidth - visibleWidth)
    }
  }
  return label
}

function formatIssueDescription(issue: BdIssue): string {
  const extra = firstLine(issue.description)
  const type = (issue.issue_type || "issue").slice(0, 4).padEnd(4)
  const status = issue.status.slice(0, 4).padEnd(4)
  if (extra) return `${status} • ${type} • ${extra}`
  return `${status} • ${type}`
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

const CYCLE_STATUSES: IssueStatus[] = ["open", "in_progress", "closed"]

function cycleStatus(current: IssueStatus): IssueStatus {
  const idx = CYCLE_STATUSES.indexOf(current)
  if (idx === -1) return "open"
  return CYCLE_STATUSES[(idx + 1) % CYCLE_STATUSES.length]
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

  // Issue list with description preview and priority hotkeys.
  async function showIssueList(ctx: ExtensionCommandContext, config: IssueListConfig): Promise<void> {
    const { title, issues, allowPriority = true, allowSearch = true } = config

    if (issues.length === 0) {
      ctx.ui.notify("No issues found", "info")
      return
    }

    // Mutable copy for local updates
    const displayIssues = [...issues]
    let filterTerm = config.filterTerm || ""

    while (true) {
      const visible = filterTerm
        ? displayIssues.filter(i => matchesFilter(i, filterTerm))
        : displayIssues

      if (visible.length === 0) {
        ctx.ui.notify(`No matches for "${filterTerm}"`, "warning")
        filterTerm = ""
        continue
      }

      const maxLabelWidth = Math.max(...displayIssues.map(i =>
        stripAnsi(`${formatPriority(i.priority)} ${(i.issue_type || "issue").slice(0, 4).toUpperCase()} ${stripIdPrefix(i.id)} ${i.title}`).length
      ))

      let selectedId: string | undefined
      const result = await ctx.ui.custom<"cancel" | "select">((tui: any, theme: any, _kb: any, done: any) => {
        const container = new Container()
        let searching = false
        let searchBuffer = ""
        let descScroll = 0

        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)))

        const titleText = new Text("", 1, 0)
        container.addChild(titleText)

        const getItems = () => {
          const filtered = filterTerm
            ? displayIssues.filter(i => matchesFilter(i, filterTerm))
            : displayIssues
          return filtered.map((issue) => ({
            value: issue.id,
            label: formatIssueLabel(issue, maxLabelWidth),
            description: formatIssueDescription(issue),
          }))
        }

        let items = getItems()
        let selectList = new SelectList(items, Math.min(items.length, 10), {
          selectedPrefix: (t: string) => theme.fg("accent", t),
          selectedText: (t: string) => theme.fg("accent", t),
          description: (t: string) => theme.fg("muted", t),
          scrollInfo: (t: string) => theme.fg("dim", t),
          noMatch: (t: string) => theme.fg("warning", t),
        })

        selectList.onSelectionChange = () => {
          updateDescPreview()
          tui.requestRender()
        }
        selectList.onSelect = () => {
          const sel = selectList.getSelectedItem()
          if (sel) selectedId = sel.value
          done("select")
        }
        selectList.onCancel = () => {
          if (filterTerm) {
            filterTerm = ""
            items = getItems()
            selectList = new SelectList(items, Math.min(items.length, 10), selectList.theme)
            selectList.onSelectionChange = selectList.onSelectionChange
            selectList.onSelect = selectList.onSelect
            selectList.onCancel = selectList.onCancel
            container.invalidate()
            tui.requestRender()
          } else {
            done("cancel")
          }
        }
        container.addChild(selectList)

        const wrapText = (text: string, width: number, maxLines: number): string[] => {
          const lines: string[] = []
          const safeWidth = Math.max(1, width)

          if (text.length === 0) return [""]

          const words = text.split(" ")
          let currentLine = ""

          const flushLine = () => {
            if (lines.length < maxLines) lines.push(currentLine)
            currentLine = ""
          }

          for (const word of words) {
            const candidate = currentLine ? `${currentLine} ${word}` : word

            if (stripAnsi(candidate).length <= safeWidth) {
              currentLine = candidate
              continue
            }

            if (currentLine) {
              flushLine()
              if (lines.length >= maxLines) break
            }

            let remaining = word
            while (stripAnsi(remaining).length > safeWidth) {
              const chunk = remaining.slice(0, safeWidth)
              if (lines.length < maxLines) lines.push(chunk)
              if (lines.length >= maxLines) break
              remaining = remaining.slice(safeWidth)
            }
            if (lines.length >= maxLines) break
            currentLine = remaining
          }

          if (currentLine && lines.length < maxLines) lines.push(currentLine)
          return lines.slice(0, maxLines)
        }

        // Build description preview with word wrapping, capped at 7 visual lines
        const buildDescText = (descLines: string[], width: number): string => {
          const wrappedLines: string[] = []
          for (const line of descLines) {
            const wrapped = wrapText(line, width, 7 - wrappedLines.length)
            wrappedLines.push(...wrapped)
            if (wrappedLines.length >= 7) break
          }
          while (wrappedLines.length < 7) wrappedLines.push("")
          return wrappedLines.join("\n")
        }

        const descTextComponent = new Text(buildDescText([], 80), 0, 0)
        container.addChild(new Text("", 1, 0)) // Empty line
        container.addChild(descTextComponent)

        let lastWidth = 80

        const updateDescPreview = () => {
          const selected = selectList.getSelectedItem()
          if (selected) {
            descScroll = 0
            const issue = displayIssues.find(i => i.id === selected.value)
            if (issue) {
              const descLines = truncateDescription(issue.description, 100)
              descTextComponent.setText(buildDescText(descLines, lastWidth))
            }
          }
        }
        if (items[0]) updateDescPreview()

        container.addChild(new DynamicBorder((s: string) => theme.fg("muted", s)))

        const helpText = new Text("", 1, 0)
        container.addChild(helpText)

        const shortcutsText = new Text(theme.fg("dim", "0-4 priority • space status • j/k scroll"), 1, 0)
        container.addChild(shortcutsText)

        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)))

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
          }) + " • j/k scroll"))
        }
        refreshDisplay()

        // Re-render helper - rebuild entire container to maintain component order
        const rebuildAndRender = () => {
          items = getItems()
          const prevSelected = selectList.getSelectedItem()

          // Clear and rebuild container
          while (container.children && container.children.length > 0) {
            container.removeChild(container.children[0])
          }

          // Recreate SelectList
          selectList = new SelectList(items, Math.min(items.length, 10), {
            selectedPrefix: (t: string) => theme.fg("accent", t),
            selectedText: (t: string) => theme.fg("accent", t),
            description: (t: string) => theme.fg("muted", t),
            scrollInfo: (t: string) => theme.fg("dim", t),
            noMatch: (t: string) => theme.fg("warning", t),
          })

          selectList.onSelectionChange = () => {
            updateDescPreview()
            tui.requestRender()
          }
          selectList.onSelect = () => {
            const sel = selectList.getSelectedItem()
            if (sel) selectedId = sel.value
            done("select")
          }
          selectList.onCancel = () => {
            if (filterTerm) {
              filterTerm = ""
              rebuildAndRender()
            } else {
              done("cancel")
            }
          }

          // Rebuild container in exact same order
          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)))
          container.addChild(titleText)
          container.addChild(selectList)
          container.addChild(new Text("", 1, 0)) // Empty line
          container.addChild(descTextComponent)
          container.addChild(new DynamicBorder((s: string) => theme.fg("muted", s)))
          container.addChild(helpText)
          container.addChild(shortcutsText)
          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)))

          // Restore selection
          if (prevSelected) {
            const newIdx = items.findIndex(i => i.value === prevSelected.value)
            if (newIdx >= 0) selectList.setSelectedIndex(newIdx)
          }

          refreshDisplay()
          updateDescPreview()
          container.invalidate()
          tui.requestRender()
        }

        return {
          render: (w: number) => {
            lastWidth = w
            return container.render(w).map((l: string) => truncateToWidth(l, w))
          },
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            // Ctrl+q or esc cancels
            if (data === CTRL_Q || matchesKey(data, Key.escape)) {
              done("cancel")
              return
            }

            if (searching) {
              if (matchesKey(data, Key.escape)) {
                searching = false
                searchBuffer = ""
                refreshDisplay()
                container.invalidate()
                tui.requestRender()
                return
              }
              if (matchesKey(data, Key.enter)) {
                filterTerm = searchBuffer.trim()
                searching = false
                rebuildAndRender()
                refreshDisplay()
                return
              }
              if (matchesKey(data, Key.backspace)) {
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
              return
            }

            if (allowSearch && data === CTRL_F) {
              searching = true
              searchBuffer = ""
              refreshDisplay()
              container.invalidate()
              tui.requestRender()
              return
            }

            // Toggle status with space
            if (data === " ") {
              const selected = selectList.getSelectedItem()
              if (selected) {
                const issue = displayIssues.find(i => i.id === selected.value)
                if (issue) {
                  const newStatus = cycleStatus(issue.status)
                  issue.status = newStatus
                  updateIssue(issue.id, ["--status", newStatus])
                  rebuildAndRender()
                }
              }
              return
            }

            if (allowPriority) {
              const p = parsePriorityKey(data)
              if (p !== null) {
                const selected = selectList.getSelectedItem()
                if (selected) {
                  const issue = displayIssues.find(i => i.id === selected.value)
                  if (issue && issue.priority !== p) {
                    issue.priority = p
                    updateIssue(issue.id, ["--priority", String(p)])
                    rebuildAndRender()
                  }
                }
                return
              }
            }

            // Description scrolling with j/k
            if (data === "j" || data === "k") {
              const selected = selectList.getSelectedItem()
              if (selected) {
                const issue = displayIssues.find(i => i.id === selected.value)
                if (issue) {
                  const descLines = truncateDescription(issue.description, 100)
                  // Calculate total wrapped lines
                  const allWrapped: string[] = []
                  for (const line of descLines) {
                    const wrapped = wrapText(line, lastWidth, 100)
                    allWrapped.push(...wrapped)
                  }
                  const maxScroll = Math.max(0, allWrapped.length - 7)
                  if (data === "j" && descScroll < maxScroll) {
                    descScroll++
                  } else if (data === "k" && descScroll > 0) {
                    descScroll--
                  }
                  // Show 7 lines starting from scroll position
                  const visible = allWrapped.slice(descScroll, descScroll + 7)
                  while (visible.length < 7) visible.push("")
                  descTextComponent.setText(visible.join("\n"))
                  container.invalidate()
                  tui.requestRender()
                }
              }
              return
            }

            selectList.handleInput(data)
            tui.requestRender()
          },
        }
      })

      if (result === "cancel") return
      if (result === "select" && selectedId) {
        const updated = await editIssue(ctx, selectedId)
        if (updated) {
          const idx = displayIssues.findIndex(i => i.id === selectedId)
          if (idx !== -1) {
            displayIssues[idx] = updated
          }
        }
        continue
      }
    }
  }

  // Issue form editor with inline editable fields
  async function editIssue(ctx: ExtensionCommandContext, id: string): Promise<BdIssue | null> {
    let issue = await showIssue(id)

    while (true) {
      let titleValue = issue.title
      let descValue = issue.description ?? ""
      let statusValue = issue.status
      let priorityValue = issue.priority
      let focused: "nav" | "title" | "desc" = "nav"
      let titleCursor = issue.title.length
      let descCursor = (issue.description ?? "").length

      const result = await ctx.ui.custom<boolean>((tui: any, theme: any, _kb: any, done: any) => {
        return {
          render: (w: number) => {
            const lines: string[] = []
            lines.push("─".repeat(Math.min(50, w)))
            const shortId = stripIdPrefix(issue.id)
            const headerText = `${formatPriority(priorityValue)} ${shortId} [${statusValue}]`
            lines.push(truncateToWidth(headerText, w))
            lines.push("")
            lines.push(focused === "title" ? "▸ Title:" : "  Title:")
            if (focused === "title") {
              const before = titleValue.slice(0, titleCursor)
              const after = titleValue.slice(titleCursor)
              lines.push(truncateToWidth(`   ${before}${CURSOR_MARKER}${after}`, w))
            } else {
              lines.push(truncateToWidth(`   ${titleValue}`, w))
            }
            lines.push("")
            lines.push(focused === "desc" ? "▸ Description:" : "  Description:")
            const descLines = descValue.split("\n")
            let cursorLineIdx = 0
            let cursorCol = 0
            let charsConsumed = 0
            for (let i = 0; i < descLines.length; i++) {
              if (charsConsumed + descLines[i].length >= descCursor) {
                cursorLineIdx = i
                cursorCol = descCursor - charsConsumed
                break
              }
              charsConsumed += descLines[i].length + 1
            }
            const startLine = Math.max(0, cursorLineIdx - 2)
            const endLine = Math.min(descLines.length, startLine + 5)
            for (let i = startLine; i < endLine; i++) {
              const line = descLines[i]
              if (focused === "desc" && i === cursorLineIdx) {
                const before = line.slice(0, cursorCol)
                const after = line.slice(cursorCol)
                lines.push(truncateToWidth(`   ${before}${CURSOR_MARKER}${after}`, w))
              } else {
                lines.push(truncateToWidth(`   ${line}`, w))
              }
            }
            lines.push("")
            let help: string
            if (focused === "title") {
              help = "type | backspace | enter save | tab desc | esc cancel"
            } else if (focused === "desc") {
              help = "type | backspace | arrows | enter save | tab nav | esc cancel"
            } else {
              help = "tab nav | space status | 1-5 priority | esc/ctrl+c back"
            }
            lines.push(truncateToWidth(help, w))
            lines.push("─".repeat(Math.min(50, w)))
            return lines
          },
          invalidate: () => {},
          handleInput: (data: string) => {
            if (matchesKey(data, Key.tab)) {
              focused = focused === "nav" ? "title" : focused === "title" ? "desc" : "nav"
              tui.requestRender()
              return
            }
            if (matchesKey(data, Key.escape)) {
              if (focused !== "nav") {
                if (focused === "title") {
                  titleValue = issue.title
                  titleCursor = issue.title.length
                } else {
                  descValue = issue.description ?? ""
                  descCursor = (issue.description ?? "").length
                }
                focused = "nav"
              } else {
                done(false)
                return
              }
              tui.requestRender()
              return
            }
            if (matchesKey(data, Key.ctrl("c"))) {
              done(false)
              return
            }
            if (matchesKey(data, Key.enter)) {
              if (focused !== "nav") {
                focused = "nav"
                done(true)
                return
              }
              tui.requestRender()
              return
            }
            if (focused === "nav") {
              if (matchesKey(data, Key.space)) {
                statusValue = cycleStatus(statusValue)
                tui.requestRender()
                return
              }
              const p = parsePriorityKey(data)
              if (p !== null) {
                priorityValue = p
                tui.requestRender()
                return
              }
              return
            }
            if (focused === "title") {
              if (matchesKey(data, Key.backspace) && titleCursor > 0) {
                titleValue = titleValue.slice(0, titleCursor - 1) + titleValue.slice(titleCursor)
                titleCursor--
                tui.requestRender()
                return
              }
              if (matchesKey(data, Key.left) && titleCursor > 0) {
                titleCursor--
                tui.requestRender()
                return
              }
              if (matchesKey(data, Key.right) && titleCursor < titleValue.length) {
                titleCursor++
                tui.requestRender()
                return
              }
              if (isPrintable(data)) {
                titleValue = titleValue.slice(0, titleCursor) + data + titleValue.slice(titleCursor)
                titleCursor++
                tui.requestRender()
                return
              }
              return
            }
            if (focused === "desc") {
              if (matchesKey(data, Key.backspace) && descCursor > 0) {
                descValue = descValue.slice(0, descCursor - 1) + descValue.slice(descCursor)
                descCursor--
                tui.requestRender()
                return
              }
              if (matchesKey(data, Key.left) && descCursor > 0) {
                descCursor--
                tui.requestRender()
                return
              }
              if (matchesKey(data, Key.right) && descCursor < descValue.length) {
                descCursor++
                tui.requestRender()
                return
              }
              if (matchesKey(data, Key.up)) {
                let lineStart = descCursor
                while (lineStart > 0 && descValue[lineStart - 1] !== "\n") lineStart--
                if (lineStart > 0) {
                  let prevLineStart = lineStart - 1
                  while (prevLineStart > 0 && descValue[prevLineStart - 1] !== "\n") prevLineStart--
                  const colInLine = descCursor - lineStart
                  const prevLineLen = lineStart - 1 - prevLineStart
                  descCursor = prevLineStart + Math.min(colInLine, prevLineLen)
                }
                tui.requestRender()
                return
              }
              if (matchesKey(data, Key.down)) {
                let lineStart = descCursor
                while (lineStart > 0 && descValue[lineStart - 1] !== "\n") lineStart--
                const colInLine = descCursor - lineStart
                let nextLineStart = lineStart
                while (nextLineStart < descValue.length && descValue[nextLineStart] !== "\n") nextLineStart++
                nextLineStart++
                if (nextLineStart < descValue.length) {
                  let nextLineEnd = nextLineStart
                  while (nextLineEnd < descValue.length && descValue[nextLineEnd] !== "\n") nextLineEnd++
                  const nextLineLen = nextLineEnd - nextLineStart
                  descCursor = nextLineStart + Math.min(colInLine, nextLineLen)
                }
                tui.requestRender()
                return
              }
              if (matchesKey(data, Key.enter)) {
                descValue = descValue.slice(0, descCursor) + "\n" + descValue.slice(descCursor)
                descCursor++
                tui.requestRender()
                return
              }
              if (isPrintable(data)) {
                descValue = descValue.slice(0, descCursor) + data + descValue.slice(descCursor)
                descCursor++
                tui.requestRender()
                return
              }
            }
          },
        }
      })

      if (!result) return null

      if (titleValue.trim() !== issue.title.trim()) {
        await updateIssue(id, ["--title", titleValue.trim()])
        ctx.ui.notify("Title updated", "success")
        issue.title = titleValue.trim()
      }
      if (descValue !== (issue.description ?? "")) {
        await updateIssue(id, ["--description", descValue])
        ctx.ui.notify("Description updated", "success")
        issue.description = descValue
      }
      if (statusValue !== issue.status) {
        await updateIssue(id, ["--status", statusValue])
        ctx.ui.notify(`Status: ${statusValue}`, "success")
        issue.status = statusValue
      }
      if (priorityValue !== issue.priority) {
        await updateIssue(id, ["--priority", String(priorityValue)])
        ctx.ui.notify(`Priority: P${priorityValue}`, "success")
        issue.priority = priorityValue
      }

      return issue
    }
  }

  async function browseIssues(ctx: ExtensionCommandContext, mode: ListMode): Promise<void> {
    const modeTitle = mode === "ready" ? "Beads — Ready" : mode === "open" ? "Beads — Open" : "Beads — All"

    try {
      ctx.ui.setStatus("beads", "Loading…")
      const issues = await listIssues(mode)
      ctx.ui.setStatus("beads", undefined)
      await showIssueList(ctx, { title: modeTitle, issues })
    } catch (e) {
      ctx.ui.setStatus("beads", undefined)
      ctx.ui.notify(e instanceof Error ? e.message : String(e), "error")
    }
  }

  pi.registerCommand("beads", {
    description: "Browse and edit Beads issues",
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
      const mode = args === "open" ? "open" : args === "all" ? "all" : "ready"
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