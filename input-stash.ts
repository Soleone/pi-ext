/**
 * Input Stash Extension
 *
 * Ctrl+X to stash current input, Ctrl+X again (on blank input) to restore.
 * Useful for temporarily clearing the editor to type something else.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let stash: string | null = null;

  pi.registerShortcut("ctrl+,", {
    description: "Toggle stash: stash input when not blank, restore when blank",
    handler: async (ctx) => {
      const text = ctx.ui.getEditorText();
      const inputIsBlank = !text || text.trim() === "";

      if (!inputIsBlank) {
        if (stash !== null) {
          ctx.ui.notify("Can't stash: clear input first to restore existing stash", "warning");
        } else {
          stash = text;
          ctx.ui.setEditorText("");
          ctx.ui.notify("Input stashed", "success");
        }
      } else {
        if (stash !== null) {
          ctx.ui.setEditorText(stash);
          stash = null;
          ctx.ui.notify("Stash restored", "success");
        } else {
          ctx.ui.notify("Nothing in stash", "info");
        }
      }
    },
  });
}
