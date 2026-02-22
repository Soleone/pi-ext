import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { CURSOR_MARKER, Key, Text, matchesKey, truncateToWidth } from "@mariozechner/pi-tui"
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
}

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
  return `${basePrompt}\n\n[pi-ask extension]\nRule: if you are about to ask the user to pick from 2+ choices, you MUST call ask_user instead of writing the choices in plain assistant text.\nThis includes "what should we do next?", tradeoff menus, option A/B/C prompts, and clarification checklists.\nKeep choices concise (3-6 options), and default allowAdditionalText=true so the user can press Tab on a selected option to add nuance.\nSelf-check before sending: if your draft contains a numbered/bulleted choice list for the user, replace it with ask_user.`
}

function renderInlineCursor(text: string, cursor: number, focused: boolean): string {
  const clampedCursor = Math.max(0, Math.min(cursor, text.length))
  const before = text.slice(0, clampedCursor)
  const atCursor = clampedCursor < text.length ? text[clampedCursor] : " "
  const after = clampedCursor < text.length ? text.slice(clampedCursor + 1) : ""
  const marker = focused ? CURSOR_MARKER : ""
  return `${before}${marker}\x1b[7m${atCursor}\x1b[27m${after}`
}

function registerAskTool(pi: ExtensionAPI, name: string, label: string) {
  pi.registerTool({
    name,
    label,
    description:
      "Ask the user a multiple-choice question in an interactive selector. Tab enables inline typing to add extra free text to the selected option.",
    parameters: AskUserParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const choices = normalizeChoices(params.choices)
      const allowAdditionalText = params.allowAdditionalText !== false
      const canCancel = params.canCancel !== false
      const additionalTextLabel = params.additionalTextLabel?.trim() || "additional details"

      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: "Error: ask_user requires interactive UI mode." }],
          details: {
            question: params.question,
            selectedLabel: null,
            selectedValue: null,
            selectedIndex: null,
            additionalText: null,
            answer: null,
            cancelled: true,
          } satisfies AskResult,
        }
      }

      if (choices.length === 0) {
        return {
          content: [{ type: "text", text: "Error: ask_user requires at least one choice." }],
          details: {
            question: params.question,
            selectedLabel: null,
            selectedValue: null,
            selectedIndex: null,
            additionalText: null,
            answer: null,
            cancelled: true,
          } satisfies AskResult,
        }
      }

      const result = await ctx.ui.custom<AskResult>((tui, theme, _kb, done) => {
        let selectedIndex = 0
        let mode: "select" | "detail" = "select"
        let detailCursor = 0
        let focused = false
        let cachedLines: string[] | undefined
        const additionalByIndex = new Map<number, string>()

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

        function submitWithSelection(additionalText: string | null) {
          const selected = choices[selectedIndex]
          const normalizedAdditional = additionalText?.trim() || null
          const answer = normalizedAdditional ? `${selected.label}: ${normalizedAdditional}` : selected.label

          done({
            question: params.question,
            selectedLabel: selected.label,
            selectedValue: selected.value,
            selectedIndex: selectedIndex + 1,
            additionalText: normalizedAdditional,
            answer,
            cancelled: false,
          })
        }

        function submitCancelled() {
          done({
            question: params.question,
            selectedLabel: null,
            selectedValue: null,
            selectedIndex: null,
            additionalText: null,
            answer: null,
            cancelled: true,
          })
        }

        function handleDetailInput(data: string) {
          const current = getAdditional()

          if (matchesKey(data, Key.enter)) {
            submitWithSelection(current)
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
            selectedIndex = Math.min(choices.length - 1, selectedIndex + 1)
            refresh()
            return
          }

          if (allowAdditionalText && matchesKey(data, Key.tab)) {
            mode = "detail"
            detailCursor = getAdditional().length
            refresh()
            return
          }

          if (matchesKey(data, Key.enter)) {
            submitWithSelection(getAdditional())
            return
          }

          if (canCancel && matchesKey(data, Key.escape)) {
            submitCancelled()
          }
        }

        function render(width: number): string[] {
          if (cachedLines) return cachedLines

          const lines: string[] = []
          const add = (line: string) => lines.push(truncateToWidth(line, width))

          add(theme.fg("accent", "─".repeat(width)))
          add(theme.fg("text", ` ${params.question}`))
          lines.push("")

          for (let i = 0; i < choices.length; i++) {
            const choice = choices[i]
            const isSelected = i === selectedIndex
            const prefix = isSelected ? theme.fg("accent", "> ") : "  "
            const color = isSelected ? "accent" : "text"
            const base = `${prefix}${theme.fg(color, `${i + 1}. ${choice.label}`)}`
            const additional = getAdditional(i)

            if (isSelected && mode === "detail") {
              const inline = renderInlineCursor(additional, detailCursor, focused)
              add(`${base}${theme.fg("muted", " — ")}${inline}`)
            } else if (additional) {
              add(`${base}${theme.fg("muted", ` — ${additional}`)}`)
            } else {
              add(base)
            }

            if (choice.description) {
              add(`     ${theme.fg("muted", choice.description)}`)
            }
          }

          lines.push("")
          if (mode === "detail") {
            add(theme.fg("dim", ` Type inline ${additionalTextLabel} • Enter submit • Tab/Esc back`))
          } else if (allowAdditionalText) {
            add(theme.fg("dim", ` ↑↓ move • Enter select • Tab add inline ${additionalTextLabel}`))
          } else {
            add(theme.fg("dim", " ↑↓ move • Enter select"))
          }

          if (canCancel && mode === "select") {
            add(theme.fg("dim", " Esc cancel"))
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
