import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";
import type { RenderBlock } from "./format.js";

const DEFAULT_EDITOR = "nvim";

function vimStringLiteral(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function safeFilename(role: string, id: string): string {
	const safeRole = role.replace(/[^a-z0-9]/gi, "") || "msg";
	const safeId = id.slice(0, 8).replace(/[^a-z0-9]/gi, "") || "x";
	return `${safeRole}-${safeId}.md`;
}

/**
 * Suspend the TUI, run a command fullscreen, then restart the TUI.
 * Returns the process exit status (or null if it failed to spawn).
 */
function runFullscreen(tui: TUI, ctx: ExtensionContext, command: string, args: string[]): number | null {
	tui.stop();
	process.stdout.write("\x1b[2J\x1b[H");

	const result = spawnSync(command, args, {
		cwd: ctx.cwd,
		env: process.env,
		stdio: "inherit",
	});

	tui.start();
	tui.requestRender(true);

	if (result.error) {
		const message = result.error instanceof Error ? result.error.message : String(result.error);
		ctx.ui.notify(`${command} failed: ${message}`, "error");
		return null;
	}

	return result.status;
}

/** Open the message text in nvim, read-only-friendly. No save-back. */
export async function viewBlockInNvim(tui: TUI, ctx: ExtensionContext, block: RenderBlock): Promise<void> {
	const dir = await mkdtemp(path.join(tmpdir(), "pi-peek-view-"));
	const filePath = path.join(dir, safeFilename(block.role, block.id));
	const editor = process.env.VISUAL || process.env.EDITOR || DEFAULT_EDITOR;

	try {
		await writeFile(filePath, `${block.fullText}\n`, "utf8");
		// `-R` opens read-only by default; user can still `:w` to a different path if they want.
		runFullscreen(tui, ctx, editor, ["-R", filePath]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/**
 * Edit an assistant message in nvim. On `:w`+`:qa` the new contents are sent
 * back to the agent as a user message (same handoff pattern as /nvim-last).
 * Returns true if a message was sent.
 */
export async function editAssistantBlockInNvim(
	pi: ExtensionAPI,
	tui: TUI,
	ctx: ExtensionContext,
	block: RenderBlock,
): Promise<boolean> {
	if (block.role !== "assistant") {
		ctx.ui.notify("Only assistant messages can be edited & sent back", "warning");
		return false;
	}

	const dir = await mkdtemp(path.join(tmpdir(), "pi-peek-edit-"));
	const filePath = path.join(dir, safeFilename(block.role, block.id));
	const savedFlagPath = path.join(dir, "saved");
	const editor = process.env.VISUAL || process.env.EDITOR || DEFAULT_EDITOR;

	try {
		await writeFile(filePath, `${block.fullText}\n`, "utf8");
		const autocmd = `autocmd BufWritePost <buffer> call writefile(['1'], ${vimStringLiteral(savedFlagPath)}) | qall`;
		const code = runFullscreen(tui, ctx, editor, ["-c", autocmd, filePath]);

		if (code !== 0) {
			ctx.ui.notify(`${editor} exited with code ${code ?? "unknown"}`, "warning");
			return false;
		}
		if (!existsSync(savedFlagPath)) {
			ctx.ui.notify("No save detected; nothing sent", "info");
			return false;
		}

		const edited = (await readFile(filePath, "utf8")).trimEnd();
		if (!edited.trim()) {
			ctx.ui.notify("Saved text is empty; nothing sent", "warning");
			return false;
		}

		pi.sendUserMessage(`I edited an earlier assistant response in Neovim. Treat this as my correction / direction:\n\n${edited}`);
		return true;
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
