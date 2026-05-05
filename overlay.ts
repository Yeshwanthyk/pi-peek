import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { copyToClipboard, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import type { Component, TUI, Theme } from "@mariozechner/pi-tui";
import { Key, Markdown, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { formatEntry, type RenderBlock, stripAnsi } from "./format.js";
import { editAssistantBlockInNvim, viewBlockInNvim } from "./nvim.js";
import { findMatches, highlightLine, type Match, nearestMatchAfter, nearestMatchBefore } from "./search.js";

type RenderLine = {
	text: string;
	plain: string;
	blockIndex: number;
	railable?: boolean;
};

const MAX_COPY_CHARS = 500_000;

// Background-color escapes used for search match highlights. Foreground stays
// intact so role colors and markdown styling survive underneath.
const MATCH_BG = "\x1b[48;5;238m";        // dim grey  — every match
const MATCH_BG_CURRENT = "\x1b[48;5;220m\x1b[30m"; // bright yellow + black fg — current
const BG_RESET = "\x1b[49m\x1b[39m";

export class PeekOverlay implements Component {
	private readonly blocks: RenderBlock[];
	private scrollOffset = 0;
	private selectedMessageIdx = 0;
	private initialized = false;
	private showTools = true;
	private cachedWidth = 0;
	private cachedContentRows = 0;
	private cachedLines: RenderLine[] = [];
	private cachedMessageStarts: number[] = [];
	private cachedMessageBlocks: RenderBlock[] = [];

	// Search state.
	private searchMode = false;
	private searchQuery = "";
	private searchMatches: Match[] = [];
	private currentMatchIdx = -1;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly ctx: ExtensionContext,
		private readonly pi: ExtensionAPI,
		private readonly done: () => void,
	) {
		this.blocks = ctx.sessionManager
			.getBranch()
			.flatMap((entry) => formatEntry(entry, theme, ctx.sessionManager.getLabel(entry.id)));
	}

	handleInput(data: string): void {
		if (this.searchMode) {
			this.handleSearchInput(data);
			return;
		}

		const page = Math.max(1, this.cachedContentRows - 1);

		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") {
			this.done();
			return;
		}

		if (data === "g") {
			this.scrollToTop();
		} else if (data === "G" || matchesKey(data, Key.shift("g"))) {
			this.scrollToBottom();
		} else if (data === "j" || matchesKey(data, Key.down)) {
			this.scrollBy(1);
		} else if (data === "k" || matchesKey(data, Key.up)) {
			this.scrollBy(-1);
		} else if (data === "J" || matchesKey(data, Key.shift("j"))) {
			this.jumpToMessage(1);
		} else if (data === "K" || matchesKey(data, Key.shift("k"))) {
			this.jumpToMessage(-1);
		} else if (data === "M") {
			void this.copyCurrentMessage();
		} else if (data === "o") {
			void this.viewCurrentInNvim();
		} else if (data === "O") {
			void this.editCurrentInNvim();
		} else if (data === "/") {
			this.enterSearch();
		} else if (data === "n") {
			this.gotoMatch(1);
		} else if (data === "N") {
			this.gotoMatch(-1);
		} else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) {
			this.scrollBy(-page);
		} else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) {
			this.scrollBy(page);
		} else if (data === "t") {
			this.showTools = !this.showTools;
			this.invalidate();
			this.tui.requestRender();
		}
	}

	private handleSearchInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.cancelSearch();
			return;
		}
		if (matchesKey(data, Key.enter) || data === "\r" || data === "\n") {
			this.commitSearch();
			return;
		}
		if (matchesKey(data, Key.backspace) || data === "\x7f" || data === "\b") {
			this.searchQuery = this.searchQuery.slice(0, -1);
			this.recomputeMatches();
			this.tui.requestRender();
			return;
		}
		// Accept printable single chars (ignore other escape sequences).
		if (data.length === 1 && data >= " " && data !== "\x7f") {
			this.searchQuery += data;
			this.recomputeMatches();
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		const maxRows = Math.max(8, Math.floor(this.tui.terminal.rows * 0.86));
		const contentRows = Math.max(1, maxRows - 4);
		const innerW = Math.max(1, width - 2);
		const content = this.renderContent(innerW);
		const maxOffset = Math.max(0, content.length - contentRows);

		if (!this.initialized) {
			this.scrollOffset = maxOffset;
			this.selectedMessageIdx = Math.max(0, this.cachedMessageStarts.length - 1);
			this.initialized = true;
		} else {
			this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
		}

		this.cachedWidth = width;
		this.cachedContentRows = contentRows;
		this.cachedLines = content;

		const visible = content.slice(this.scrollOffset, this.scrollOffset + contentRows);
		const lines: string[] = [];
		const border = (s: string) => this.theme.fg("border", s);
		const pad = (s: string) => truncateToWidth(s, innerW, "", true);

		// Title row: " Peek " left, " msg N/M " + optional match count right.
		const msgTotal = this.cachedMessageStarts.length;
		const msgIdx = this.currentMessageIndex();
		const matchCountText =
			this.searchMatches.length > 0
				? ` ${this.currentMatchIdx >= 0 ? this.currentMatchIdx + 1 : 0}/${this.searchMatches.length} matches `
				: "";
		const leftLabel = ` Peek `;
		const rightLabel = (msgTotal > 0 ? ` msg ${msgIdx + 1}/${msgTotal} ` : "") + matchCountText;
		const leftStyled = this.theme.fg("text", leftLabel);
		const rightStyled = this.theme.fg("dim", rightLabel);
		const fill = Math.max(0, innerW - visibleWidth(leftLabel) - visibleWidth(rightLabel));
		lines.push(border("╭") + leftStyled + border("─".repeat(fill)) + rightStyled + border("╮"));

		// Status row: search prompt when in search mode, else distilled keys + position %.
		if (this.searchMode) {
			const prompt = ` /${this.searchQuery}█`;
			const countText =
				this.searchQuery.length === 0
					? " type to search, Enter to confirm, Esc to cancel "
					: this.searchMatches.length > 0
						? ` ${this.searchMatches.length} match${this.searchMatches.length === 1 ? "" : "es"} `
						: " no match ";
			const promptStyled = this.theme.fg("accent", prompt);
			const countStyled = this.theme.fg("dim", countText);
			const gap = Math.max(1, innerW - visibleWidth(prompt) - visibleWidth(countText));
			lines.push(border("│") + promptStyled + " ".repeat(gap) + countStyled + border("│"));
		} else {
			const pct = content.length > 0 ? Math.round(((this.scrollOffset + contentRows) / content.length) * 100) : 100;
			const pctText = ` ${Math.min(100, Math.max(0, pct))}% `;
			const hint = ` j/k · J/K · g/G   t   M o O   /n N   q`;
			const hintStyled = this.theme.fg("dim", hint);
			const pctStyled = this.theme.fg("dim", pctText);
			const statusFill = Math.max(0, innerW - visibleWidth(hint) - visibleWidth(pctText));
			lines.push(border("│") + hintStyled + " ".repeat(statusFill) + pctStyled + border("│"));
		}

		const currentBlockIdx = this.currentBlockGlobalIndex();

		// Sticky header: when the active message's header has scrolled above the
		// viewport, replace the first visible row with a pinned copy of the header.
		const headerLine = this.activeHeaderLine();
		const showSticky = headerLine >= 0 && headerLine < this.scrollOffset && visible.length > 0;
		const displayed = visible.slice();
		if (showSticky) {
			const block = this.cachedMessageBlocks[this.currentMessageIndex()];
			if (block) {
				displayed[0] = {
					text: ` ${block.header}`,
					plain: stripAnsi(block.header),
					blockIndex: currentBlockIdx,
					railable: true,
				};
			}
		}

		displayed.forEach((line, i) => {
			const absIdx = this.scrollOffset + i;
			let text = line.text;

			// Search match highlight (skip on sticky line so the pin doesn't get sprayed).
			if (this.searchMatches.length > 0 && !(showSticky && i === 0)) {
				const hits = this.matchesForLine(absIdx);
				if (hits.length > 0) {
					text = highlightLine(text, hits, MATCH_BG, MATCH_BG_CURRENT, BG_RESET);
				}
			}

			if (line.railable && line.blockIndex === currentBlockIdx) {
				if (text.startsWith(" ")) {
					text = this.theme.fg("accent", "▎") + text.slice(1);
				} else {
					text = this.theme.fg("accent", "▎") + text;
				}
			}
			lines.push(border("│") + pad(text) + border("│"));
		});

		for (let i = displayed.length; i < contentRows; i++) lines.push(border("│") + pad("") + border("│"));
		lines.push(border("╰" + "─".repeat(innerW) + "╯"));
		return lines;
	}

	private matchesForLine(absLineIdx: number): Array<{ col: number; len: number; current?: boolean }> {
		const hits: Array<{ col: number; len: number; current?: boolean }> = [];
		for (let i = 0; i < this.searchMatches.length; i++) {
			const m = this.searchMatches[i];
			if (m.lineIdx === absLineIdx) {
				hits.push({ col: m.col, len: m.len, current: i === this.currentMatchIdx });
			}
		}
		return hits;
	}

	invalidate(): void {
		this.cachedWidth = 0;
		this.cachedContentRows = 0;
		this.cachedLines = [];
	}

	private renderContent(width: number): RenderLine[] {
		if (this.cachedWidth > 0 && this.cachedWidth - 2 === width && this.cachedLines.length > 0) return this.cachedLines;
		const visibleBlocks = this.blocks.filter((block) => this.showTools || block.kind !== "tool");
		if (visibleBlocks.length === 0) {
			this.cachedMessageStarts = [];
			this.cachedMessageBlocks = [];
			return [{ text: this.theme.fg("dim", "No session messages yet."), plain: "No session messages yet.", blockIndex: -1 }];
		}

		const lines: RenderLine[] = [];
		const messageStarts: number[] = [];
		const messageBlocks: RenderBlock[] = [];
		visibleBlocks.forEach((block) => {
			const blockIndex = this.blocks.indexOf(block);
			if (block.kind === "tool") {
				const raw = (block.toolLine ?? block.copyText).replace(/^· /, "");
				const line = this.theme.fg("dim", `   └─ ${raw}`);
				lines.push({ text: line, plain: stripAnsi(line).trimEnd(), blockIndex });
				return;
			}

			messageStarts.push(lines.length);
			messageBlocks.push(block);

			// Separator above each message after the first: thin dim rule, not railable.
			if (lines.length > 0) {
				const rule = this.theme.fg("border", `   ${"─ ".repeat(Math.max(1, Math.floor((width - 6) / 2)))}`.trimEnd());
				lines.push({ text: rule, plain: stripAnsi(rule).trimEnd(), blockIndex });
			}

			// Header — railable, leading space at col 0 for rail substitution.
			lines.push({ text: ` ${block.header}`, plain: stripAnsi(block.header), blockIndex, railable: true });

			const md = new Markdown(block.markdown || "∅", 2, 0, getMarkdownTheme(), {
				color: (text) => this.theme.fg(block.kind === "meta" ? "muted" : "text", text),
			});
			for (const rendered of md.render(Math.max(1, width))) {
				lines.push({ text: rendered, plain: stripAnsi(rendered), blockIndex, railable: true });
			}
		});
		this.cachedMessageStarts = messageStarts;
		this.cachedMessageBlocks = messageBlocks;
		return lines;
	}

	private currentBlockGlobalIndex(): number {
		const block = this.cachedMessageBlocks[this.currentMessageIndex()];
		return block ? this.blocks.indexOf(block) : -1;
	}

	private activeHeaderLine(): number {
		const idx = this.currentMessageIndex();
		const start = this.cachedMessageStarts[idx];
		if (start === undefined) return -1;
		// First block: header is at line 0. Subsequent blocks: separator at start, header at start+1.
		return start === 0 ? 0 : start + 1;
	}

	private enterSearch(): void {
		this.searchMode = true;
		this.searchQuery = "";
		this.searchMatches = [];
		this.currentMatchIdx = -1;
		this.tui.requestRender();
	}

	private cancelSearch(): void {
		this.searchMode = false;
		this.searchQuery = "";
		this.searchMatches = [];
		this.currentMatchIdx = -1;
		this.tui.requestRender();
	}

	private commitSearch(): void {
		this.searchMode = false;
		if (this.searchMatches.length === 0) {
			this.tui.requestRender();
			return;
		}
		const nearest = nearestMatchAfter(this.searchMatches, this.scrollOffset);
		this.currentMatchIdx = nearest >= 0 ? nearest : 0;
		this.scrollToMatch(this.currentMatchIdx);
		this.tui.requestRender();
	}

	private recomputeMatches(): void {
		this.searchMatches = findMatches(this.cachedLines, this.searchQuery);
		this.currentMatchIdx = this.searchMatches.length > 0 ? 0 : -1;
	}

	private gotoMatch(dir: 1 | -1): void {
		if (this.searchMatches.length === 0) return;
		if (this.currentMatchIdx < 0) {
			this.currentMatchIdx = dir === 1 ? nearestMatchAfter(this.searchMatches, this.scrollOffset) : nearestMatchBefore(this.searchMatches, this.scrollOffset);
			if (this.currentMatchIdx < 0) this.currentMatchIdx = 0;
		} else {
			this.currentMatchIdx = (this.currentMatchIdx + dir + this.searchMatches.length) % this.searchMatches.length;
		}
		this.scrollToMatch(this.currentMatchIdx);
		this.tui.requestRender();
	}

	private scrollToMatch(idx: number): void {
		const m = this.searchMatches[idx];
		if (!m) return;
		const maxOffset = Math.max(0, this.cachedLines.length - this.cachedContentRows);
		// Center the match in the viewport when there's room; otherwise pin to top.
		const centered = m.lineIdx - Math.floor(this.cachedContentRows / 2);
		this.scrollOffset = Math.max(0, Math.min(maxOffset, centered));
		this.selectedMessageIdx = this.messageIndexForOffset(this.scrollOffset);
	}

	private currentMessageIndex(): number {
		if (this.cachedMessageStarts.length === 0) return 0;
		return Math.max(0, Math.min(this.selectedMessageIdx, this.cachedMessageStarts.length - 1));
	}

	private messageIndexForOffset(offset: number): number {
		const starts = this.cachedMessageStarts;
		if (starts.length === 0) return 0;
		let idx = 0;
		for (let i = 0; i < starts.length; i++) {
			if (starts[i] <= offset) idx = i;
			else break;
		}
		return idx;
	}

	private currentBlock(): RenderBlock | undefined {
		return this.cachedMessageBlocks[this.currentMessageIndex()];
	}

	private async copyCurrentMessage(): Promise<void> {
		const block = this.currentBlock();
		if (!block) return;
		await this.copyText(`${stripAnsi(block.header)}\n${block.copyText}`.trimEnd(), "current message");
	}

	private async viewCurrentInNvim(): Promise<void> {
		const block = this.currentBlock();
		if (!block) return;
		await viewBlockInNvim(this.tui, this.ctx, block);
		this.invalidate();
		this.tui.requestRender(true);
	}

	private async editCurrentInNvim(): Promise<void> {
		const block = this.currentBlock();
		if (!block) return;
		const sent = await editAssistantBlockInNvim(this.pi, this.tui, this.ctx, block);
		if (sent) {
			this.done();
		} else {
			this.invalidate();
			this.tui.requestRender(true);
		}
	}

	private jumpToMessage(dir: 1 | -1): void {
		const starts = this.cachedMessageStarts;
		if (starts.length === 0) return;
		const maxOffset = Math.max(0, this.cachedLines.length - this.cachedContentRows);
		const target = this.currentMessageIndex() + dir;
		if (target < 0 || target >= starts.length) return;
		this.selectedMessageIdx = target;
		this.scrollOffset = Math.min(starts[target], maxOffset);
		this.tui.requestRender();
	}

	private scrollBy(delta: number): void {
		const maxOffset = Math.max(0, this.cachedLines.length - this.cachedContentRows);
		this.scrollOffset = Math.max(0, Math.min(maxOffset, this.scrollOffset + delta));
		this.selectedMessageIdx = this.messageIndexForOffset(this.scrollOffset);
		this.tui.requestRender();
	}

	private scrollToTop(): void {
		this.scrollOffset = 0;
		this.selectedMessageIdx = 0;
		this.tui.requestRender();
	}

	private scrollToBottom(): void {
		this.scrollOffset = Math.max(0, this.cachedLines.length - this.cachedContentRows);
		this.selectedMessageIdx = Math.max(0, this.cachedMessageStarts.length - 1);
		this.tui.requestRender();
	}

	private async copyText(text: string, label: string): Promise<void> {
		const clipped = text.length > MAX_COPY_CHARS ? `${text.slice(0, MAX_COPY_CHARS)}\n… [truncated by peek copy]` : text;
		try {
			await copyToClipboard(clipped);
			this.ctx.ui.notify(`Copied ${label} (${clipped.length} chars)`, "info");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.ctx.ui.notify(`Copy failed: ${message}`, "error");
		}
	}
}
