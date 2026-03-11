/**
 * Sends completion notifications through the best available channel(s):
 * - zellij-attention for background-tab markers
 * - macOS desktop notifications via osascript
 * - OSC 777 as a fallback when neither specialized path is available
 *
 * Also restores ask_user waiting support by sending the zellij waiting marker
 * while pi-ask is waiting on the user.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"

type AttentionState = "waiting" | "completed"

type AskUserResult = {
  freeformRequested?: boolean
}

const TITLE = "Pi"
const COMPLETED_BODY = "Ready for input"
const ZELLIJ_PIPE_TIMEOUT_MS = 2000
const OSASCRIPT_TIMEOUT_MS = 3000

function getPaneId(): string | null {
  const paneId = process.env.ZELLIJ_PANE_ID?.trim()
  return paneId ? paneId : null
}

function escapeAppleScript(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
}

function notifyOSC777(title: string, body: string): void {
  process.stdout.write(`\x1b]777;notify;${title};${body}\x07`)
}

function isAskUserWaiting(details: unknown): boolean {
  if (!details || typeof details !== "object") return false
  return Boolean((details as AskUserResult).freeformRequested)
}

async function notifyZellij(pi: ExtensionAPI, state: AttentionState): Promise<boolean> {
  const paneId = getPaneId()
  if (!paneId) return false

  try {
    const result = await pi.exec(
      "zellij",
      ["pipe", "--name", `zellij-attention::${state}::${paneId}`],
      { timeout: ZELLIJ_PIPE_TIMEOUT_MS },
    )

    return result.code === 0
  } catch {
    return false
  }
}

async function notifyMacOS(pi: ExtensionAPI, title: string, body: string): Promise<boolean> {
  if (process.platform !== "darwin") return false

  const script = `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(title)}"`

  try {
    const result = await pi.exec("osascript", ["-e", script], { timeout: OSASCRIPT_TIMEOUT_MS })
    return result.code === 0
  } catch {
    return false
  }
}

export default function piNotify(pi: ExtensionAPI) {
  let waitingForUserInput = false

  function resetState() {
    waitingForUserInput = false
  }

  pi.on("session_start", async () => {
    resetState()
  })

  pi.on("session_switch", async () => {
    resetState()
  })

  pi.on("input", async (event) => {
    if (event.source !== "extension") {
      waitingForUserInput = false
    }
  })

  pi.on("tool_execution_start", async (event) => {
    if (event.toolName !== "ask_user") return

    waitingForUserInput = true
    await notifyZellij(pi, "waiting")
  })

  pi.on("tool_result", async (event) => {
    if (event.toolName !== "ask_user") return

    waitingForUserInput = isAskUserWaiting(event.details)

    if (waitingForUserInput) {
      await notifyZellij(pi, "waiting")
    }
  })

  pi.on("agent_end", async () => {
    if (waitingForUserInput) {
      await notifyZellij(pi, "waiting")
      return
    }

    let delivered = false

    delivered = await notifyZellij(pi, "completed") || delivered
    delivered = await notifyMacOS(pi, TITLE, COMPLETED_BODY) || delivered

    if (!delivered) {
      notifyOSC777(TITLE, COMPLETED_BODY)
    }
  })
}
