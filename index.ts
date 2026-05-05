import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { PeekOverlay } from "./overlay.js";

const OPEN_SHORTCUT = Key.ctrlShift("j");

async function openPeek(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;

	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => new PeekOverlay(tui, theme, ctx, pi, done),
		{
			overlay: true,
			overlayOptions: {
				width: "92%",
				minWidth: 50,
				maxHeight: "90%",
				anchor: "center",
				margin: 1,
			},
		},
	);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("peek", {
		description: "Peek back through the current session: scroll, jump messages, copy, view/edit in nvim",
		handler: async (_args, ctx) => openPeek(pi, ctx),
	});

	pi.registerShortcut(OPEN_SHORTCUT, {
		description: "Open peek (chat scrollback)",
		handler: (ctx) => openPeek(pi, ctx),
	});
}
