import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

// iTerm2 marks: jump between agent responses.
//   Cmd+Shift+Up   — previous mark
//   Cmd+Shift+Down — next mark
//
// Direct iTerm2: mark at response start (precise).
// tmux: mark at each turn start (requires: set -g allow-passthrough on).

const IN_TMUX = !!process.env.TMUX;
const MARK_DIRECT = "\x1b]1337;SetMark\x07";
const MARK_TMUX = "\x1bPtmux;\x1b\x1b]1337;SetMark\x07\x1b\\";

export default function (pi: ExtensionAPI) {
	if (IN_TMUX) {
		pi.on("turn_start", async () => {
			process.stdout.write(MARK_TMUX);
		});
	} else {
		pi.on("before_agent_start", async () => {
			return {
				message: {
					customType: "iterm2-mark",
					content: "",
					display: true,
				},
			};
		});

		pi.registerMessageRenderer("iterm2-mark", () => {
			return new Text(MARK_DIRECT, 0, 0);
		});

		pi.on("context", async (event) => {
			return {
				messages: event.messages.filter(
					(m) => !(m.role === "custom" && "customType" in m && m.customType === "iterm2-mark"),
				),
			};
		});
	}
}
