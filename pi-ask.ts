import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { CURSOR_MARKER, Key, Text, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui"
import { Type } from "@sinclair/typebox"

type Choice = {
  label: string
  value: string
  description?: string
}

type AskResult = {
  question: string
  selectedLabel: string | null
  selectedValue: string | null
  selectedIndex: number | null
  additionalText: string | null
  answer: string | null
  cancelled: boolean
  freeformRequested: boolean
  freeformChoices?: { label: string; description?: string }[]
}

type PendingManualAnswer = {
  question: string
  choices: { label: string; description?: string }[]
  resolve: (value: {
    content: { type: "text"; text: string }[]
    details: AskResult
  }) => void
}

const FREEFORM_LABEL = "Write a custom response"
let pendingManualAnswer: PendingManualAnswer | null = null

const ChoiceObjectSchema = Type.Object({
  label: Type.String({ description: "Visible option label" }),
  value: Type.Optional(Type.String({ description: "Optional machine value (defaults to label)" })),
  description: Type.Optional(Type.String({ description: "Optional helper text shown below option" })),
})

const AskUserParams = Type.Object({
  question: Type.String({ description: "Question shown to the user" }),
  choices: Type.Array(
    Type.Union([Type.String(), ChoiceObjectSchema]),
    { description: "List of choices. Can be strings or {label,value,description}." },
  ),
  allowAdditionalText: Type.Optional(
    Type.Boolean({ description: "If true, Tab enables inline free-text details on the selected choice." }),
  ),
  additionalTextLabel: Type.Optional(
    Type.String({ description: "Label used in inline detail help text." }),
  ),
  canCancel: Type.Optional(Type.Boolean({ description: "If true (default), Escape cancels." })),
})

function normalizeChoices(rawChoices: Array<string | { label: string; value?: string; description?: string }>): Choice[] {
  return rawChoices
    .map((choice) => {
      if (typeof choice === "string") {
        const label = choice.trim()
        if (!label) return null
        return { label, value: label }
      }

      const label = choice.label?.trim()
      if (!label) return null

      return {
        label,
        value: choice.value?.trim() || label,
        description: choice.description?.trim() || undefined,
      }
    })
    .filter((choice): choice is Choice => choice !== null)
}

function buildSystemPrompt(basePrompt: string): string {
  return `${basePrompt}\n\n[pi-ask extension]\nRule: if you are about to ask the user to pick from 2+ choices, you MUST call ask_user instead of writing the choices in plain assistant text.\nThis includes "what should we do next?", tradeoff menus, option A/B/C prompts, and clarification checklists.\nKeep choices concise (3-6 options), and default allowAdditionalText=true so the user can press Tab on a selected option to add nuance.\nFor each choice: label = the action/path (short, scannable), description = tradeoffs, pros/cons, or key context (optional, one line).\nSelf-check before sending: if your draft contains a numbered/bulleted choice list for the user, replace it with ask_user.`
}

function renderInlineCursor(text: string, cursor: number, focused: boolean): string {
  const clampedCursor = Math.max(0, Math.min(cursor, text.length))
  const before = text.slice(0, clampedCursor)
  const atCursor = clampedCursor < text.length ? text[clampedCursor] : " "
  const after = clampedCursor < text.length ? text.slice(clampedCursor + 1) : ""
  const marker = focused ? CURSOR_MARKER : ""
  return `${before}${marker}\x1b[7m${atCursor}\x1b[27m${after}`
}

/**
 * Render a selected choice with its detail editing area.
 * Detail text starts inline on the same line as the label.
 * Overflow wraps with a hanging indent aligned to where the detail text began.
 * Falls back to a separate line below the label if inline space is too narrow.
 */
function renderDetailBlock(
  base: string,
  separator: string,
  text: string,
  cursor: number,
  focused: boolean,
  fallbackIndent: string,
  width: number,
): string[] {
  const cursorText = renderInlineCursor(text, cursor, focused)
  const inlinePrefix = base + separator
  const inlineAvail = width - visibleWidth(inlinePrefix)

  // Try inline: detail starts on same line as label
  if (inlineAvail >= 15) {
    const wrapped = wrapTextWithAnsi(cursorText, inlineAvail)
    if (wrapped.length === 0) {
      return [inlinePrefix + renderInlineCursor("", 0, focused)]
    }
    const hangingIndent = " ".repeat(visibleWidth(inlinePrefix))
    return wrapped.map((line, i) => (i === 0 ? inlinePrefix : hangingIndent) + line)
  }

  // Fallback: detail on separate line(s) below label
  const fallbackAvail = width - visibleWidth(fallbackIndent)
  if (fallbackAvail <= 5) {
    return [truncateToWidth(base, width), fallbackIndent + renderInlineCursor(text, cursor, focused)]
  }
  const wrapped = wrapTextWithAnsi(cursorText, fallbackAvail)
  if (wrapped.length === 0) {
    return [truncateToWidth(base, width), fallbackIndent + renderInlineCursor("", 0, focused)]
  }
  return [truncateToWidth(base, width), ...wrapped.map(line => fallbackIndent + line)]
}

function wrapPrefixedText(text: string, prefix: string, width: number): string[] {
  const availableWidth = Math.max(1, width - visibleWidth(prefix))

  return text.split(/\r?\n/).flatMap((line) => {
    const wrapped = wrapTextWithAnsi(line, availableWidth)
    const segments = wrapped.length > 0 ? wrapped : [""]
    return segments.map(segment => prefix + segment)
  })
}

function makeResult(question: string, overrides: Partial<AskResult> = {}): AskResult {
  return {
    question,
    selectedLabel: null,
    selectedValue: null,
    selectedIndex: null,
    additionalText: null,
    answer: null,
    cancelled: false,
    freeformRequested: false,
    ...overrides,
  }
}

function renderManualAnswerPrompt(theme: any, details: AskResult) {
  return {
    invalidate() {},
    render(width: number): string[] {
      const lines: string[] = [""]
      const choices = details.freeformChoices || []
      const addWrapped = (text: string, prefix = "") => {
        lines.push(...wrapPrefixedText(text, prefix, width))
      }

      addWrapped(theme.fg("muted", details.question))
      lines.push("")
      addWrapped(theme.fg("dim", "Options:"))

      for (let i = 0; i < choices.length; i++) {
        const choice = choices[i]
        addWrapped(theme.fg("text", `${i + 1}. ${choice.label}`))
        if (choice.description) {
          addWrapped(theme.fg("dim", choice.description), "   ")
        }
      }

      lines.push("")
      addWrapped(theme.fg("muted", "Type your custom response below and press Enter."))
      return lines
    },
  }
}

function registerAskTool(pi: ExtensionAPI, name: string, label: string) {
  pi.registerTool({
    name,
    label,
    description:
      "Ask the user a multiple-choice question in an interactive selector. Tab enables inline typing to add extra free text to the selected option.",
    parameters: AskUserParams,

    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const choices = normalizeChoices(params.choices)
      const allowAdditionalText = params.allowAdditionalText !== false
      const canCancel = params.canCancel !== false
      const additionalTextLabel = params.additionalTextLabel?.trim() || "additional details"

      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: "Error: ask_user requires interactive UI mode." }],
          details: makeResult(params.question, { cancelled: true }),
        }
      }

      if (choices.length === 0) {
        return {
          content: [{ type: "text", text: "Error: ask_user requires at least one choice." }],
          details: makeResult(params.question, { cancelled: true }),
        }
      }

      const freeformIndex = choices.length
      const totalItems = choices.length + 1

      const result = await ctx.ui.custom<AskResult>((tui, theme, _kb, done) => {
        let selectedIndex = 0
        let mode: "select" | "detail" = "select"
        let detailCursor = 0
        let focused = false
        let cachedLines: string[] | undefined
        const additionalByIndex = new Map<number, string>()

        const isFreeform = () => selectedIndex === freeformIndex

        function getAdditional(index = selectedIndex): string {
          return additionalByIndex.get(index) || ""
        }

        function setAdditional(value: string, index = selectedIndex) {
          if (!value) additionalByIndex.delete(index)
          else additionalByIndex.set(index, value)
        }

        function refresh() {
          cachedLines = undefined
          tui.requestRender()
        }

        function enterDetailMode() {
          mode = "detail"
          detailCursor = getAdditional().length
          refresh()
        }

        function submitChoice(additionalText: string | null) {
          const selected = choices[selectedIndex]
          const normalizedAdditional = additionalText?.trim() || null
          const answer = normalizedAdditional ? `${selected.label}: ${normalizedAdditional}` : selected.label

          done(makeResult(params.question, {
            selectedLabel: selected.label,
            selectedValue: selected.value,
            selectedIndex: selectedIndex + 1,
            additionalText: normalizedAdditional,
            answer,
          }))
        }

        function submitFreeformRequest() {
          done(makeResult(params.question, { freeformRequested: true }))
        }

        function handleDetailInput(data: string) {
          const current = getAdditional()

          // Shift+Enter / Alt+Enter → insert newline
          if (matchesKey(data, Key.shift("enter")) || matchesKey(data, Key.alt("enter"))) {
            const next = current.slice(0, detailCursor) + "\n" + current.slice(detailCursor)
            setAdditional(next)
            detailCursor += 1
            refresh()
            return
          }

          // Plain Enter → submit
          if (matchesKey(data, Key.enter)) {
            submitChoice(current)
            return
          }

          if (matchesKey(data, Key.escape) || matchesKey(data, Key.tab)) {
            mode = "select"
            refresh()
            return
          }

          if (matchesKey(data, Key.left)) {
            detailCursor = Math.max(0, detailCursor - 1)
            refresh()
            return
          }

          if (matchesKey(data, Key.right)) {
            detailCursor = Math.min(current.length, detailCursor + 1)
            refresh()
            return
          }

          if (matchesKey(data, Key.home)) {
            detailCursor = 0
            refresh()
            return
          }

          if (matchesKey(data, Key.end)) {
            detailCursor = current.length
            refresh()
            return
          }

          if (matchesKey(data, Key.backspace)) {
            if (detailCursor > 0) {
              const next = current.slice(0, detailCursor - 1) + current.slice(detailCursor)
              setAdditional(next)
              detailCursor -= 1
              refresh()
            }
            return
          }

          if (matchesKey(data, Key.delete)) {
            if (detailCursor < current.length) {
              const next = current.slice(0, detailCursor) + current.slice(detailCursor + 1)
              setAdditional(next)
              refresh()
            }
            return
          }

          if (data.length === 1 && data.charCodeAt(0) >= 32) {
            const next = current.slice(0, detailCursor) + data + current.slice(detailCursor)
            setAdditional(next)
            detailCursor += data.length
            refresh()
          }
        }

        function handleInput(data: string) {
          if (mode === "detail") {
            handleDetailInput(data)
            return
          }

          if (matchesKey(data, Key.up)) {
            selectedIndex = Math.max(0, selectedIndex - 1)
            refresh()
            return
          }

          if (matchesKey(data, Key.down)) {
            selectedIndex = Math.min(totalItems - 1, selectedIndex + 1)
            refresh()
            return
          }

          if (matchesKey(data, Key.tab)) {
            if (isFreeform()) {
              submitFreeformRequest()
            } else if (allowAdditionalText) {
              enterDetailMode()
            }
            return
          }

          if (matchesKey(data, Key.enter)) {
            if (isFreeform()) {
              submitFreeformRequest()
            } else {
              submitChoice(getAdditional())
            }
            return
          }

          if (matchesKey(data, Key.escape)) {
            submitFreeformRequest()
            return
          }

          // Number keys 1-9: quick-select and immediately submit a choice
          if (data >= "1" && data <= "9") {
            const index = parseInt(data) - 1
            if (index < choices.length) {
              selectedIndex = index
              submitChoice(getAdditional(index))
            }
            return
          }

          // 0: freeform — close ask UI, return to native editor
          if (data === "0") {
            submitFreeformRequest()
          }
        }

        function render(width: number): string[] {
          if (cachedLines) return cachedLines

          const lines: string[] = []
          const add = (line: string) => lines.push(truncateToWidth(line, width))
          const detailIndent = "     "

          add(theme.fg("accent", "─".repeat(width)))
          lines.push(...wrapPrefixedText(theme.fg("text", params.question), " ", width))
          lines.push("")

          // Render choices
          for (let i = 0; i < choices.length; i++) {
            const choice = choices[i]
            const isSelected = i === selectedIndex
            const prefix = isSelected ? theme.fg("accent", "> ") : "  "
            const color = isSelected ? "accent" : "text"
            const base = `${prefix}${theme.fg(color, `${i + 1}. ${choice.label}`)}`
            const additional = getAdditional(i)

            if (isSelected && mode === "detail") {
              const separator = theme.fg("muted", " — ")
              for (const dl of renderDetailBlock(base, separator, additional, detailCursor, focused, detailIndent, width)) {
                lines.push(dl)
              }
            } else if (additional) {
              add(`${base}${theme.fg("muted", ` — ${additional}`)}`)
            } else {
              add(base)
            }

            if (choice.description) {
              lines.push(...wrapPrefixedText(theme.fg("muted", choice.description), detailIndent, width))
            }
          }

          // Freeform option (always last)
          lines.push("")
          const freeformSelected = isFreeform()
          const freeformPrefix = freeformSelected ? theme.fg("accent", "> ") : "  "
          const freeformColor = freeformSelected ? "accent" : "muted"
          add(`${freeformPrefix}${theme.fg(freeformColor, `0. ${FREEFORM_LABEL}`)}`)

          // Help text
          lines.push("")
          const k = (key: string) => theme.fg("muted", key)
          const d = (desc: string) => theme.fg("dim", desc)
          if (mode === "detail") {
            add(` ${d("type")} ${k(additionalTextLabel)} ${d("•")} ${k("Shift+Enter")} ${d("newline •")} ${k("Enter")} ${d("submit •")} ${k("Tab/Esc")} ${d("back")}`)
          } else if (allowAdditionalText) {
            add(` ${k("↑↓ 1-9")} ${d("select •")} ${k("Tab")} ${d("add " + additionalTextLabel + " •")} ${k("0/Esc")} ${d("custom")}`)
          } else {
            add(` ${k("↑↓ 1-9")} ${d("select •")} ${k("0/Esc")} ${d("custom")}`)
          }

          add(theme.fg("accent", "─".repeat(width)))

          cachedLines = lines
          return lines
        }

        return {
          get focused() {
            return focused
          },
          set focused(value: boolean) {
            focused = value
          },
          render,
          handleInput,
          invalidate: () => {
            cachedLines = undefined
          },
        }
      })

      if (result.cancelled) {
        return {
          content: [{ type: "text", text: "User cancelled question" }],
          details: result,
        }
      }

      // Freeform/manual answer: hand control back to the editor and wait for the next typed message.
      if (result.freeformRequested) {
        if (pendingManualAnswer) {
          return {
            content: [{
              type: "text",
              text: "A manual response is already pending. Wait for the user's next message.",
            }],
            details: result,
          }
        }

        const freeformChoices = choices.map(choice => ({ label: choice.label, description: choice.description }))
        const pendingDetails = makeResult(params.question, {
          freeformRequested: true,
          freeformChoices,
        })

        onUpdate?.({
          content: [{ type: "text", text: "Manual response pending" }],
          details: pendingDetails,
        })

        ctx.ui.setStatus("pi-ask", "Manual response pending")
        ctx.ui.setWorkingMessage("Manual response pending — type below and press Enter")

        return await new Promise((resolve) => {
          pendingManualAnswer = {
            question: params.question,
            choices: freeformChoices,
            resolve,
          }
        })
      }

      const detailText = result.additionalText ? ` + details: ${result.additionalText}` : ""
      return {
        content: [{ type: "text", text: `User selected ${result.selectedIndex}. ${result.selectedLabel}${detailText}` }],
        details: result,
      }
    },

    renderCall(args, theme) {
      const count = Array.isArray(args.choices) ? args.choices.length : 0
      const text = `${theme.fg("toolTitle", theme.bold(`${name} `))}${theme.fg("muted", args.question)}${theme.fg("dim", ` (${count} choices)`)}`
      return new Text(text, 0, 0)
    },

    renderResult(result, _options, theme) {
      const details = result.details as AskResult | undefined

      if (!details) {
        const first = result.content[0]
        return new Text(first?.type === "text" ? first.text : "", 0, 0)
      }

      if (details.cancelled) {
        return new Text(theme.fg("warning", "Cancelled"), 0, 0)
      }

      if (details.selectedIndex == null && details.answer) {
        return new Text(`${theme.fg("success", "✓ ")}${theme.fg("accent", "Custom response")}\n${theme.fg("text", details.answer)}`, 0, 0)
      }

      if (details.freeformRequested) {
        return renderManualAnswerPrompt(theme, details)
      }

      const choice = `${details.selectedIndex}. ${details.selectedLabel}`
      const base = `${theme.fg("success", "✓ ")}${theme.fg("accent", choice)}`
      if (!details.additionalText) return new Text(base, 0, 0)

      return new Text(`${base}\n${theme.fg("muted", `details: ${details.additionalText}`)}`, 0, 0)
    },
  })
}

export default function piAsk(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    return { systemPrompt: buildSystemPrompt(event.systemPrompt) }
  })

  pi.on("session_start", (_event, ctx) => {
    pendingManualAnswer = null
    ctx.ui.setStatus("pi-ask", undefined)
    ctx.ui.setWorkingMessage()
  })

  pi.on("session_switch", (_event, ctx) => {
    pendingManualAnswer = null
    ctx.ui.setStatus("pi-ask", undefined)
    ctx.ui.setWorkingMessage()
  })

  pi.on("input", async (event, ctx) => {
    if (!pendingManualAnswer || event.source === "extension") {
      return { action: "continue" as const }
    }

    const answer = event.text.trim()
    if (!answer) {
      ctx.ui.notify("Type a response to answer manually", "warning")
      return { action: "handled" as const }
    }

    const pending = pendingManualAnswer
    pendingManualAnswer = null
    ctx.ui.setStatus("pi-ask", undefined)
    ctx.ui.setWorkingMessage()

    pending.resolve({
      content: [{ type: "text", text: `User wrote a custom response: ${answer}` }],
      details: makeResult(pending.question, {
        selectedLabel: FREEFORM_LABEL,
        selectedValue: answer,
        answer,
        freeformChoices: pending.choices,
      }),
    })

    return { action: "handled" as const }
  })

  pi.registerCommand("ask", {
    description: "Force a multiple-choice ask flow for a free-form prompt",
    handler: async (args, ctx) => {
      const prompt = (args || "").trim()
      if (!prompt) {
        ctx.ui.notify("Usage: /ask <what you want options about>", "warning")
        return
      }

      const forcedAskMessage = [
        {
          type: "text" as const,
          text:
            `Use the ask_user tool now. Do not answer in plain text. ` +
            `Create one concise multiple-choice question based on: "${prompt}". ` +
            `Provide 3-6 options and set allowAdditionalText=true.`,
        },
      ]

      if (ctx.isIdle()) {
        pi.sendUserMessage(forcedAskMessage)
        ctx.ui.notify("Triggered /ask", "info")
      } else {
        pi.sendUserMessage(forcedAskMessage, { deliverAs: "followUp" })
        ctx.ui.notify("Queued /ask prompt as follow-up", "info")
      }
    },
  })

  registerAskTool(pi, "ask_user", "Ask User")
}
