/**
 * Safety Extension
 *
 * Comprehensive protection against destructive actions:
 * - Dangerous bash commands require confirmation
 * - Protected paths block writes/edits
 * - Network-altering commands require confirmation
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
    // Dangerous bash patterns that require confirmation
    const dangerousPatterns: Array<{ pattern: RegExp; reason: string }> = [
        { pattern: /\brm\s+(-[rRf]+|--recursive|--force)/, reason: "recursive/force delete" },
        { pattern: /\bsudo\b/, reason: "elevated privileges" },
        { pattern: /\b(chmod|chown)\b.*777/, reason: "world-writable permissions" },
        { pattern: /\bmkfs\b/, reason: "filesystem format" },
        { pattern: /\bdd\b.*\bof=/, reason: "disk write" },
        { pattern: />\s*\/dev\/(?!null)/, reason: "device write" },
        { pattern: /\brm\s+.*\/\s*$/, reason: "delete root-like path" },
        { pattern: /\bgit\s+(push|reset\s+--hard|clean\s+-[fd])/, reason: "destructive git operation" },
        { pattern: /\bgt\s+s(ubmit)?\b/, reason: "graphite submit" },
        { pattern: /\bnpm\s+publish\b/, reason: "package publish" },
        { pattern: /\bcurl\b.*\|\s*(ba)?sh/, reason: "pipe to shell" },
        { pattern: /\bwget\b.*\|\s*(ba)?sh/, reason: "pipe to shell" },
        { pattern: /:(){ :|:& };:/, reason: "fork bomb" },
    ];

    // Paths that block writes/edits entirely
    const blockedPaths: string[] = [
        ".env",
        ".env.local",
        ".env.production",
        "secrets/",
        ".git/",
        "node_modules/",
        "id_rsa",
        "id_ed25519",
        ".ssh/",
        ".aws/credentials",
        ".npmrc",
    ];

    // Paths that require confirmation before write/edit
    const sensitivePathPatterns: Array<{ pattern: RegExp; reason: string }> = [
        { pattern: /package-lock\.json$/, reason: "lockfile" },
        { pattern: /\.lock$/, reason: "lockfile" },
        { pattern: /Dockerfile$/, reason: "container config" },
        { pattern: /docker-compose\.ya?ml$/, reason: "container orchestration" },
        { pattern: /\.github\/workflows\//, reason: "CI/CD workflow" },
    ];

    pi.on("tool_call", async (event, ctx) => {
        // Handle bash commands
        if (event.toolName === "bash") {
            const command = event.input.command as string;

            for (const { pattern, reason } of dangerousPatterns) {
                if (pattern.test(command)) {
                    if (!ctx.hasUI) {
                        return { block: true, reason: `Dangerous command blocked (${reason}) - no UI for confirmation` };
                    }

                    const choice = await ctx.ui.select(
                        `⚠️ Dangerous command (${reason}):\n\n  ${command}\n\nAllow?`,
                        ["No, block", "Yes, execute"],
                    );

                    if (choice !== "Yes, execute") {
                        return { block: true, reason: `Blocked by user: ${reason}` };
                    }
                    break;
                }
            }
        }

        // Handle write/edit operations
        if (event.toolName === "write" || event.toolName === "edit") {
            const path = event.input.path as string;

            // Check blocked paths (no override)
            for (const blocked of blockedPaths) {
                if (path.includes(blocked)) {
                    if (ctx.hasUI) {
                        ctx.ui.notify(`Blocked: ${path} (protected path)`, "warning");
                    }
                    return { block: true, reason: `Path "${path}" is protected (contains ${blocked})` };
                }
            }

            // Check sensitive paths (confirmation required)
            for (const { pattern, reason } of sensitivePathPatterns) {
                if (pattern.test(path)) {
                    if (!ctx.hasUI) {
                        return { block: true, reason: `Sensitive path blocked (${reason}) - no UI for confirmation` };
                    }

                    const choice = await ctx.ui.select(
                        `⚠️ Modifying ${reason}:\n\n  ${path}\n\nAllow?`,
                        ["No, block", "Yes, allow"],
                    );

                    if (choice !== "Yes, allow") {
                        return { block: true, reason: `Blocked by user: ${reason}` };
                    }
                    break;
                }
            }
        }

        return undefined;
        });

    pi.on("session_start", (_event, ctx) => {
        if (ctx.hasUI) {
            ctx.ui.notify("Safety extension loaded", "info");
        }
    });
}