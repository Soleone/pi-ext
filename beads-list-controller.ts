import { Key, matchesKey } from "@mariozechner/pi-tui"

export type ListIntent =
  | { type: "cancel" }
  | { type: "searchStart" }
  | { type: "searchApply" }
  | { type: "searchBackspace" }
  | { type: "searchAppend"; value: string }
  | { type: "moveSelection"; delta: number }
  | { type: "work" }
  | { type: "edit" }
  | { type: "toggleStatus" }
  | { type: "setPriority"; priority: number }
  | { type: "scrollDescription"; delta: number }
  | { type: "delegate" }

export interface ListControllerState {
  searching: boolean
  allowSearch: boolean
  allowPriority: boolean
  ctrlQ: string
  ctrlF: string
}

function parsePriorityKey(data: string): number | null {
  if (data.length !== 1) return null
  const num = parseInt(data, 10)
  return !isNaN(num) && num >= 0 && num <= 4 ? num : null
}

function isPrintable(data: string): boolean {
  return data.length === 1 && data.charCodeAt(0) >= 32 && data.charCodeAt(0) < 127
}

export function resolveListIntent(data: string, state: ListControllerState): ListIntent {
  if (data === state.ctrlQ || matchesKey(data, Key.escape)) {
    return { type: "cancel" }
  }

  if (state.searching) {
    if (matchesKey(data, Key.enter)) return { type: "searchApply" }
    if (matchesKey(data, Key.backspace)) return { type: "searchBackspace" }
    if (isPrintable(data)) return { type: "searchAppend", value: data }
    return { type: "delegate" }
  }

  if (state.allowSearch && data === state.ctrlF) {
    return { type: "searchStart" }
  }

  if (data === "w" || data === "W") return { type: "moveSelection", delta: -1 }
  if (data === "s" || data === "S") return { type: "moveSelection", delta: 1 }

  if (matchesKey(data, Key.enter)) return { type: "work" }
  if (data === "e" || data === "E") return { type: "edit" }

  if (data === " ") return { type: "toggleStatus" }

  if (state.allowPriority) {
    const priority = parsePriorityKey(data)
    if (priority !== null) return { type: "setPriority", priority }
  }

  if (data === "j" || data === "k") {
    return { type: "scrollDescription", delta: data === "j" ? 1 : -1 }
  }

  return { type: "delegate" }
}
