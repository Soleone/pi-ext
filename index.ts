import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"

import inputStash from "./input-stash.ts"
import piNotify from "./pi-notify.ts"
import piOpen from "./pi-open.ts"
import piAsk from "./pi-ask.ts"
import safety from "./safety.ts"
import veniceProvider from "./venice-provider.ts"

export default function (pi: ExtensionAPI) {
  inputStash(pi)
  piNotify(pi)
  piOpen(pi)
  piAsk(pi)
  safety(pi)
  veniceProvider(pi)
}
