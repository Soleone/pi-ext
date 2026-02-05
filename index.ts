import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"

import inputStash from "./input-stash.ts"
import permissionGate from "./permission-gate.ts"

export default function (pi: ExtensionAPI) {
  inputStash(pi)
  permissionGate(pi)
}
