import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { dirname, extname, isAbsolute, resolve } from "node:path"
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent"
import { Key } from "@mariozechner/pi-tui"

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"])
const SETTINGS_PATH = resolve(homedir(), ".pi/agent/pi-open.json")
const DEFAULT_SETTINGS = {
  markdownCommand: "glow",
  defaultCommand: "micro",
  editCommand: "nvim",
} as const
const QUERY_STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "this",
  "that",
  "these",
  "those",
  "in",
  "on",
  "at",
  "for",
  "to",
  "with",
  "from",
  "of",
  "by",
  "please",
  "open",
  "file",
  "files",
  "last",
  "mentioned",
  "agent",
])
const MAX_MENTIONS = 50

type OpenContext = Pick<ExtensionContext, "cwd" | "hasUI" | "ui">
type FileMention = { path: string; context: string }
type OpenSettings = {
  markdownCommand: string
  defaultCommand: string
  editCommand: string
}

function loadSettingsFromDisk(): OpenSettings {
  const fallback: OpenSettings = { ...DEFAULT_SETTINGS }
  if (!existsSync(SETTINGS_PATH)) return fallback

  try {
    const raw = readFileSync(SETTINGS_PATH, "utf8")
    const parsed = JSON.parse(raw) as Partial<OpenSettings>

    return {
      markdownCommand: parsed.markdownCommand?.trim() || fallback.markdownCommand,
      defaultCommand: parsed.defaultCommand?.trim() || fallback.defaultCommand,
      editCommand: parsed.editCommand?.trim() || fallback.editCommand,
    }
  } catch {
    return fallback
  }
}

function saveSettingsToDisk(settings: OpenSettings): void {
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true })
  writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, "utf8")
}

function normalizePathToken(token: string): string {
  return token
    .trim()
    .replace(/^[`'"([{<]+/, "")
    .replace(/[`'"\])}>.,:;!?]+$/, "")
    .replace(/^@/, "")
}

function looksLikePath(token: string): boolean {
  if (!token || /\s/.test(token)) return false
  if (token.startsWith("http://") || token.startsWith("https://")) return false

  return token.includes("/") || /\.[a-zA-Z0-9]{1,10}$/.test(token)
}

function extractExplicitTargetPath(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  const atMatch = trimmed.match(/@(?:"([^"]+)"|'([^']+)'|(\S+))/)
  if (atMatch) return atMatch[1] ?? atMatch[2] ?? atMatch[3] ?? null

  const quoted = trimmed.match(/^"([^"]+)"|^'([^']+)'/)
  const quotedPath = quoted ? (quoted[1] ?? quoted[2] ?? null) : null
  if (quotedPath && looksLikePath(normalizePathToken(quotedPath))) return quotedPath

  const firstToken = normalizePathToken(trimmed.split(/\s+/)[0] ?? "")
  return looksLikePath(firstToken) ? firstToken : null
}

function extractBangOpenPath(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  const match = trimmed.match(/^@(?:"([^"]+)"|'([^']+)'|([^\s!]+))\s*!$/)
  return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null
}

function extractAssistantTextContent(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return []
      const item = part as { type?: unknown; text?: unknown }
      return item.type === "text" && typeof item.text === "string" ? [item.text] : []
    })
    .join("\n")
}

function extractExistingPathMentions(text: string, cwd: string): FileMention[] {
  const rawTokens = text.match(/`[^`]+`|"[^"]+"|'[^']+'|\S+/g) ?? []
  const mentions: FileMention[] = []
  const seen = new Set<string>()

  for (const token of rawTokens) {
    const normalized = normalizePathToken(token)
    if (!looksLikePath(normalized)) continue

    const absolutePath = isAbsolute(normalized) ? normalized : resolve(cwd, normalized)
    if (!existsSync(absolutePath)) continue

    const stats = statSync(absolutePath)
    if (!stats.isFile()) continue
    if (seen.has(absolutePath)) continue

    seen.add(absolutePath)
    mentions.push({ path: normalized, context: text })
  }

  return mentions
}

function mergeMentions(existing: FileMention[], additions: FileMention[], cwd: string): FileMention[] {
  const byPath = new Map<string, FileMention>()

  for (const mention of [...additions, ...existing]) {
    const absolutePath = isAbsolute(mention.path) ? mention.path : resolve(cwd, mention.path)
    if (!byPath.has(absolutePath)) byPath.set(absolutePath, mention)
  }

  return Array.from(byPath.values()).slice(0, MAX_MENTIONS)
}

function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9._/-]+/)
    .map((part) => part.trim())
    .filter((part) => part && !QUERY_STOP_WORDS.has(part))
}

function scoreMention(mention: FileMention, tokens: string[]): number {
  if (!tokens.length) return 1

  const pathLower = mention.path.toLowerCase()
  const contextLower = mention.context.toLowerCase()
  const extension = extname(mention.path).toLowerCase()

  return tokens.reduce((score, token) => {
    const normalizedToken = token.startsWith(".") ? token : `.${token}`

    if (extension && extension === normalizedToken) return score + 100
    if (pathLower.includes(token)) return score + 10
    if (contextLower.includes(token)) return score + 1

    return score
  }, 0)
}

function findMentionForQuery(mentions: FileMention[], query: string): FileMention | null {
  if (!mentions.length) return null

  const tokens = tokenizeQuery(query)
  if (!tokens.length) return mentions[0] ?? null

  const ranked = mentions
    .map((mention) => ({ mention, score: scoreMention(mention, tokens) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)

  return ranked[0]?.mention ?? null
}

function resolveOpenTarget(input: string, mentions: FileMention[]): string | null {
  const explicitTarget = extractExplicitTargetPath(input)
  if (explicitTarget) return explicitTarget

  return findMentionForQuery(mentions, input)?.path ?? null
}

function pickCommand(filePath: string, settings: OpenSettings): string {
  return MARKDOWN_EXTENSIONS.has(extname(filePath).toLowerCase())
    ? settings.markdownCommand
    : settings.defaultCommand
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function getCommandArgs(command: string, filePath: string): string[] {
  return command === "glow" ? ["--pager", filePath] : [filePath]
}

function isTmuxAlive(): boolean {
  const result = spawnSync("tmux", ["list-sessions"], { env: process.env, timeout: 2000 })
  return result.status === 0
}

function runInTmuxPopup(commandName: string, filePath: string, cwd: string): number {
  const args = getCommandArgs(commandName, filePath).map(shellQuote).join(" ")
  const command = `${commandName} ${args}`

  const result = spawnSync(
    "tmux",
    ["display-popup", "-E", "-d", cwd, "-w", "85%", "-h", "85%", command],
    { cwd, env: process.env },
  )

  if (result.error && "code" in result.error && result.error.code === "ENOENT") return 127
  return result.status ?? 1
}

async function runFullscreen(ctx: OpenContext, commandName: string, filePath: string): Promise<number> {
  const exitCode = await ctx.ui.custom<number>((tui, _theme, _kb, done) => {
    tui.stop()
    process.stdout.write("\x1b[2J\x1b[H")

    const result = spawnSync(commandName, getCommandArgs(commandName, filePath), {
      stdio: "inherit",
      env: process.env,
      cwd: ctx.cwd,
    })

    tui.start()
    tui.requestRender(true)

    if (result.error && "code" in result.error && result.error.code === "ENOENT") done(127)
    else done(result.status ?? 1)

    return { render: () => [], invalidate: () => {} }
  })

  return exitCode ?? 1
}

async function openTarget(
  target: string,
  ctx: OpenContext,
  settings: OpenSettings,
  commandOverride?: string,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Open requires interactive mode", "warning")
    return
  }

  const withoutAt = target.startsWith("@") ? target.slice(1) : target
  const absolutePath = isAbsolute(withoutAt) ? withoutAt : resolve(ctx.cwd, withoutAt)

  if (!existsSync(absolutePath)) {
    ctx.ui.notify(`File not found: ${withoutAt}`, "error")
    return
  }

  const stats = statSync(absolutePath)
  if (!stats.isFile()) {
    ctx.ui.notify(`Not a file: ${withoutAt}`, "error")
    return
  }

  const commandName = commandOverride ?? pickCommand(absolutePath, settings)
  const useTmux = !!process.env.TMUX && isTmuxAlive()
  const exitCode = useTmux
    ? runInTmuxPopup(commandName, absolutePath, ctx.cwd)
    : await runFullscreen(ctx, commandName, absolutePath)

  if (exitCode === 127) {
    ctx.ui.notify(`${commandName} is not installed`, "error")
  } else if (exitCode !== 0) {
    ctx.ui.notify(`${commandName} exited with code ${exitCode}`, "warning")
  }
}

export default function (pi: ExtensionAPI) {
  let recentMentions: FileMention[] = []
  let settings: OpenSettings = loadSettingsFromDisk()

  const openSettingsPage = async (ctx: ExtensionContext) => {
    while (true) {
      const choice = await ctx.ui.select(`Open settings (${SETTINGS_PATH})`, [
        `.md/.markdown command: ${settings.markdownCommand}`,
        `.* default command: ${settings.defaultCommand}`,
        `Alt+E edit command: ${settings.editCommand}`,
        "Done",
      ])

      if (!choice || choice === "Done") return

      if (choice.startsWith(".md/.markdown")) {
        const value = await ctx.ui.input("Command for .md/.markdown files", settings.markdownCommand)
        if (value === undefined) continue

        const next = value.trim()
        if (!next) {
          ctx.ui.notify("Command cannot be empty", "warning")
          continue
        }

        settings = { ...settings, markdownCommand: next }
        saveSettingsToDisk(settings)
        ctx.ui.notify(`Saved .md command: ${next}`, "success")
        continue
      }

      if (choice.startsWith(".* default")) {
        const value = await ctx.ui.input("Default command for other files (.*)", settings.defaultCommand)
        if (value === undefined) continue

        const next = value.trim()
        if (!next) {
          ctx.ui.notify("Command cannot be empty", "warning")
          continue
        }

        settings = { ...settings, defaultCommand: next }
        saveSettingsToDisk(settings)
        ctx.ui.notify(`Saved default command: ${next}`, "success")
        continue
      }

      const value = await ctx.ui.input("Command used by Alt+E edit shortcut", settings.editCommand)
      if (value === undefined) continue

      const next = value.trim()
      if (!next) {
        ctx.ui.notify("Command cannot be empty", "warning")
        continue
      }

      settings = { ...settings, editCommand: next }
      saveSettingsToDisk(settings)
      ctx.ui.notify(`Saved edit command: ${next}`, "success")
    }
  }

  pi.on("session_start", async () => {
    settings = loadSettingsFromDisk()
  })

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return

    const text = extractAssistantTextContent((event.message as { content?: unknown }).content)
    if (!text) return

    const mentions = extractExistingPathMentions(text, ctx.cwd)
    if (!mentions.length) return

    recentMentions = mergeMentions(recentMentions, mentions, ctx.cwd)
  })

  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive") return { action: "continue" } as const

    const bangTarget = extractBangOpenPath(event.text)
    if (!bangTarget) return { action: "continue" } as const

    await openTarget(bangTarget, ctx, settings)
    return { action: "handled" } as const
  })

  pi.registerCommand("open", {
    description: "Open @file/query, or run /open settings to configure editor commands",
    handler: async (args, ctx) => {
      if (args.trim() === "settings") {
        await openSettingsPage(ctx)
        return
      }

      const target = resolveOpenTarget(args, recentMentions)
      if (!target) {
        ctx.ui.notify("Usage: /open @path/to/file, /open <query>, or /open settings", "warning")
        return
      }

      await openTarget(target, ctx, settings)
    },
  })

  const openFromEditorInput = async (ctx: ExtensionContext) => {
    const input = ctx.ui.getEditorText()
    const target = resolveOpenTarget(input, recentMentions)
    if (!target) {
      ctx.ui.notify("No open target in input. Use @path, query text, or /open", "warning")
      return
    }

    await openTarget(target, ctx, settings)
  }

  const editFromEditorInput = async (ctx: ExtensionContext) => {
    const input = ctx.ui.getEditorText()
    const target = resolveOpenTarget(input, recentMentions)
    if (!target) {
      ctx.ui.notify("No edit target in input. Use @path, query text, or /open", "warning")
      return
    }

    await openTarget(target, ctx, settings, settings.editCommand)
  }

  pi.registerShortcut(Key.altShift("s"), {
    description: "Show/open from current input (@path or free-form query)",
    handler: openFromEditorInput,
  })

  pi.registerShortcut(Key.alt("s"), {
    description: "Show/open from current input (@path or free-form query)",
    handler: openFromEditorInput,
  })

  pi.registerShortcut(Key.altShift("e"), {
    description: "Edit from current input using configured edit command",
    handler: editFromEditorInput,
  })

  pi.registerShortcut(Key.alt("e"), {
    description: "Edit from current input using configured edit command",
    handler: editFromEditorInput,
  })
}
