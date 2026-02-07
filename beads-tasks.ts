import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent"
import { DynamicBorder } from "@mariozechner/pi-coding-agent"
import { Container, SelectList, Text, matchesKey, Key, truncateToWidth, CURSOR_MARKER } from "@mariozechner/pi-tui"
import {
  DESCRIPTION_PART_SEPARATOR,
  EDIT_HELP_TEXT,
  buildIssueEditHeader,
  buildIssueListRowModel,
  buildWorkPrompt,
  decodeIssueDescription,
  stripAnsi,
  type BdIssue,
  type EditFocus,
  type IssueStatus,
} from "./beads-task-view-model.ts"
import { resolveListIntent } from "./beads-list-controller.ts"

type ListMode = "ready" | "open" | "all"

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

function truncateDescription(desc: string | undefined, maxLines: number): string[] {
  if (!desc || !desc.trim()) return ["(no description)"]
  const allLines = desc.split(/\r?\n/)
  const lines = allLines.slice(0, maxLines)
  if (allLines.length > maxLines) lines.push("...")
  return lines
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
  const parts = ["↑↓/w/s navigate", "enter work", "e edit"]
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
    let rememberedSelectedId: string | undefined

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
        stripAnsi(buildIssueListRowModel(i).label).length
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

        const accentMarker = "__ACCENT_MARKER__"
        const accentedMarker = theme.fg("accent", accentMarker)
        const markerIndex = accentedMarker.indexOf(accentMarker)
        const accentPrefix = markerIndex >= 0 ? accentedMarker.slice(0, markerIndex) : ""
        const accentSuffix = markerIndex >= 0 ? accentedMarker.slice(markerIndex + accentMarker.length) : "\x1b[0m"
        const applyAccentWithAnsi = (text: string) => {
          const normalized = text.replaceAll(DESCRIPTION_PART_SEPARATOR, " • ")
          if (!accentPrefix) return theme.fg("accent", normalized)
          return `${accentPrefix}${normalized.replace(/\x1b\[0m/g, `\x1b[0m${accentPrefix}`)}${accentSuffix}`
        }

        const styleDescription = (text: string) => {
          const { meta, summary } = decodeIssueDescription(text)
          if (!summary) return theme.fg("muted", meta)
          return `${theme.fg("muted", meta)} • ${summary}`
        }

        const getItems = () => {
          const filtered = filterTerm
            ? displayIssues.filter(i => matchesFilter(i, filterTerm))
            : displayIssues
          return filtered.map((issue) => {
            const row = buildIssueListRowModel(issue, maxLabelWidth)
            return {
              value: row.id,
              label: row.label,
              description: row.description,
            }
          })
        }

        let items = getItems()
        let selectList = new SelectList(items, Math.min(items.length, 10), {
          selectedPrefix: (t: string) => theme.fg("accent", t),
          selectedText: (t: string) => applyAccentWithAnsi(t),
          description: (t: string) => styleDescription(t),
          scrollInfo: (t: string) => theme.fg("dim", t),
          noMatch: (t: string) => theme.fg("warning", t),
        })

        if (rememberedSelectedId) {
          const rememberedIndex = items.findIndex(i => i.value === rememberedSelectedId)
          if (rememberedIndex >= 0) selectList.setSelectedIndex(rememberedIndex)
        }

        selectList.onSelectionChange = () => {
          const selected = selectList.getSelectedItem()
          if (selected) rememberedSelectedId = selected.value
          updateDescPreview()
          tui.requestRender()
        }
        selectList.onSelect = () => {
          const sel = selectList.getSelectedItem()
          if (sel) {
            selectedId = sel.value
            rememberedSelectedId = sel.value
          }
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

        const shortcutsText = new Text(theme.fg("dim", "enter work • e edit • w/s nav • 0-4 priority • space status • j/k scroll"), 1, 0)
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

        const moveSelection = (delta: number) => {
          if (items.length === 0) return
          const selected = selectList.getSelectedItem()
          const currentIndex = selected ? items.findIndex(i => i.value === selected.value) : 0
          const normalizedIndex = currentIndex >= 0 ? currentIndex : 0
          const nextIndex = (normalizedIndex + delta + items.length) % items.length
          selectList.setSelectedIndex(nextIndex)
          updateDescPreview()
          container.invalidate()
          tui.requestRender()
        }

        const getSelectedIssue = (): BdIssue | undefined => {
          const selected = selectList.getSelectedItem()
          if (!selected) return undefined
          rememberedSelectedId = selected.value
          return displayIssues.find(i => i.id === selected.value)
        }

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
            selectedText: (t: string) => applyAccentWithAnsi(t),
            description: (t: string) => styleDescription(t),
            scrollInfo: (t: string) => theme.fg("dim", t),
            noMatch: (t: string) => theme.fg("warning", t),
          })

          selectList.onSelectionChange = () => {
            const selected = selectList.getSelectedItem()
            if (selected) rememberedSelectedId = selected.value
            updateDescPreview()
            tui.requestRender()
          }
          selectList.onSelect = () => {
            const sel = selectList.getSelectedItem()
            if (sel) {
              selectedId = sel.value
              rememberedSelectedId = sel.value
            }
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
            const intent = resolveListIntent(data, {
              searching,
              allowSearch,
              allowPriority,
              ctrlQ: CTRL_Q,
              ctrlF: CTRL_F,
            })

            switch (intent.type) {
              case "cancel":
                done("cancel")
                return

              case "searchStart":
                searching = true
                searchBuffer = ""
                refreshDisplay()
                container.invalidate()
                tui.requestRender()
                return

              case "searchApply":
                filterTerm = searchBuffer.trim()
                searching = false
                rebuildAndRender()
                refreshDisplay()
                return

              case "searchBackspace":
                searchBuffer = searchBuffer.slice(0, -1)
                refreshDisplay()
                container.invalidate()
                tui.requestRender()
                return

              case "searchAppend":
                searchBuffer += intent.value
                refreshDisplay()
                container.invalidate()
                tui.requestRender()
                return

              case "moveSelection":
                moveSelection(intent.delta)
                return

              case "work": {
                const issue = getSelectedIssue()
                if (issue) {
                  done("cancel")
                  pi.sendUserMessage(buildWorkPrompt(issue))
                }
                return
              }

              case "edit": {
                const issue = getSelectedIssue()
                if (issue) {
                  selectedId = issue.id
                  done("select")
                }
                return
              }

              case "toggleStatus": {
                const issue = getSelectedIssue()
                if (issue) {
                  const newStatus = cycleStatus(issue.status)
                  issue.status = newStatus
                  updateIssue(issue.id, ["--status", newStatus])
                  rebuildAndRender()
                }
                return
              }

              case "setPriority": {
                const issue = getSelectedIssue()
                if (issue && issue.priority !== intent.priority) {
                  issue.priority = intent.priority
                  updateIssue(issue.id, ["--priority", String(intent.priority)])
                  rebuildAndRender()
                }
                return
              }

              case "scrollDescription": {
                const issue = getSelectedIssue()
                if (issue) {
                  const descLines = truncateDescription(issue.description, 100)
                  const allWrapped: string[] = []
                  for (const line of descLines) {
                    const wrapped = wrapText(line, lastWidth, 100)
                    allWrapped.push(...wrapped)
                  }
                  const maxScroll = Math.max(0, allWrapped.length - 7)
                  if (intent.delta > 0 && descScroll < maxScroll) {
                    descScroll++
                  } else if (intent.delta < 0 && descScroll > 0) {
                    descScroll--
                  }
                  const visible = allWrapped.slice(descScroll, descScroll + 7)
                  while (visible.length < 7) visible.push("")
                  descTextComponent.setText(visible.join("\n"))
                  container.invalidate()
                  tui.requestRender()
                }
                return
              }

              case "delegate":
                selectList.handleInput(data)
                tui.requestRender()
                return
            }
          },
        }
      })

      if (result === "cancel") return
      if (result === "select" && selectedId) {
        rememberedSelectedId = selectedId
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
      let focused: EditFocus = "nav"
      let titleCursor = issue.title.length
      let descCursor = (issue.description ?? "").length

      const result = await ctx.ui.custom<boolean>((tui: any, theme: any, _kb: any, done: any) => {
        return {
          render: (w: number) => {
            const lines: string[] = []
            lines.push("─".repeat(Math.min(50, w)))
            const headerText = buildIssueEditHeader(issue.id, priorityValue, statusValue)
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
            lines.push(truncateToWidth(EDIT_HELP_TEXT[focused], w))
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
            if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
              done(false)
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