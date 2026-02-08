import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"

import inputStash from "./input-stash.ts"
import permissionGate from "./permission-gate.ts"
import veniceProvider from "./venice-provider.ts"

export default function (pi: ExtensionAPI) {
  inputStash(pi)
  permissionGate(pi)
  veniceProvider(pi)
}
