import type { SessionEntry, Theme, ThemeColor } from "@mariozechner/pi-coding-agent";

export type Role = "user" | "assistant" | "tool" | "custom" | "meta";

export type RenderBlock = {
	id: string;
	kind: "text" | "tool" | "meta";
	role: Role;
	header: string;
	markdown: string;
	copyText: string;
	fullText: string;
	toolLine?: string;
};

export const MAX_ENTRY_CHARS = 16_000;

export function stripAnsi(text: string): string {
	return text
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function normalizeText(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function compactWhitespace(text: string): string {
	return normalizeText(stripAnsi(text)).replace(/\s+/g, " ").trim();
}

function summarizeText(text: string, max = 180): string {
	const summary = compactWhitespace(text);
	return summary.length > max ? `${summary.slice(0, max - 1)}…` : summary;
}

function clampText(text: string): string {
	const normalized = normalizeText(text);
	if (normalized.length <= MAX_ENTRY_CHARS) return normalized;
	return `${normalized.slice(0, MAX_ENTRY_CHARS)}\n… [truncated in peek overlay]`;
}

function compactJson(value: unknown, max = 240): string {
	let json: string;
	try {
		json = JSON.stringify(value ?? {});
	} catch {
		json = String(value ?? "");
	}
	return json.length > max ? `${json.slice(0, max - 1)}…` : json;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object";
}

function textParts(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return String(content ?? "");

	return content
		.map((part) => {
			if (!isRecord(part)) return "";
			if (part.type === "text") return String(part.text ?? "");
			if (part.type === "image") return "[image]";
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function fullContentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return String(content ?? "");

	return content
		.map((part) => {
			if (!isRecord(part)) return "";
			if (part.type === "text") return String(part.text ?? "");
			if (part.type === "thinking") return "[thinking]";
			if (part.type === "image") return "[image]";
			if (part.type === "toolCall") return `[tool call: ${String(part.name ?? "tool")}] ${compactJson(part.arguments, 2_000)}`;
			return JSON.stringify(part);
		})
		.filter(Boolean)
		.join("\n");
}

function summarizeToolCall(name: string, args: unknown): string {
	const input = isRecord(args) ? args : {};
	if (name === "read") return String(input.path ?? compactJson(args));
	if (name === "edit" || name === "write") return String(input.path ?? compactJson(args));
	if (name === "bash") return summarizeText(String(input.command ?? ""), 220);
	if (name === "subagent") return summarizeText(String(input.name ?? input.task ?? compactJson(args)), 220);
	if (name === "TaskUpdate") return compactJson(input, 180);
	return compactJson(args);
}

function toolCalls(content: unknown): Array<{ name: string; args: unknown }> {
	if (!Array.isArray(content)) return [];
	return content
		.filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "toolCall")
		.map((part) => ({ name: String(part.name ?? "tool"), args: part.arguments }));
}

function compactToolResult(message: Record<string, unknown>): { line: string; full: string } {
	const toolName = String(message.toolName ?? "tool");
	const failed = Boolean(message.isError);
	const full = normalizeText(fullContentText(message.content));
	const nonEmptyLines = full.split("\n").filter((line) => line.trim().length > 0);
	const firstLine = summarizeText(nonEmptyLines[0] ?? "", failed ? 220 : 140);
	const size = `${nonEmptyLines.length || 1}L/${full.length}c`;
	const status = failed ? "✗" : "✓";
	const detail = firstLine || "done";
	return { line: `· ${toolName} ${status} ${detail} ${size}`, full: `[${toolName} ${failed ? "error" : "ok"}]\n${full}` };
}

function makeHeader(role: string, theme: Theme, label?: string, id?: string): string {
	const roleColor: ThemeColor = role === "USER" ? "userMessageText" : role === "ASSISTANT" ? "accent" : role === "TOOL" ? "toolTitle" : "customMessageLabel";
	const labelText = label ? theme.fg("accent", ` #${label}`) : "";
	const idText = id ? theme.fg("dim", ` ${id.slice(0, 8)}`) : "";
	return `${theme.fg(roleColor, role)}${labelText}${idText}`;
}

export function formatEntry(entry: SessionEntry, theme: Theme, label?: string): RenderBlock[] {
	const blocks: RenderBlock[] = [];

	if (entry.type === "message") {
		const message = entry.message as unknown as Record<string, unknown>;
		const role = String(message.role ?? "message");

		if (role === "user") {
			const text = clampText(textParts(message.content));
			if (text.trim()) {
				blocks.push({
					id: entry.id,
					kind: "text",
					role: "user",
					header: makeHeader("USER", theme, label, entry.id),
					markdown: text,
					copyText: text,
					fullText: text,
				});
			}
			return blocks;
		}

		if (role === "assistant") {
			const text = clampText(textParts(message.content));
			if (text.trim()) {
				blocks.push({
					id: entry.id,
					kind: "text",
					role: "assistant",
					header: makeHeader("ASSISTANT", theme, label, entry.id),
					markdown: text,
					copyText: text,
					fullText: clampText(fullContentText(message.content)),
				});
			}

			for (const call of toolCalls(message.content)) {
				const line = `· ${call.name} → ${summarizeToolCall(call.name, call.args)}`;
				blocks.push({
					id: entry.id,
					kind: "tool",
					role: "tool",
					header: "",
					markdown: "",
					copyText: line,
					fullText: `[tool call: ${call.name}]\n${compactJson(call.args, 8_000)}`,
					toolLine: line,
				});
			}
			return blocks;
		}

		if (role === "toolResult") {
			const compact = compactToolResult(message);
			blocks.push({
				id: entry.id,
				kind: "tool",
				role: "tool",
				header: "",
				markdown: "",
				copyText: compact.line,
				fullText: clampText(compact.full),
				toolLine: compact.line,
			});
			return blocks;
		}

		if (role === "bashExecution") {
			const command = String(message.command ?? "");
			const output = String(message.output ?? "");
			const line = `· ! ${summarizeText(command, 180)} → ${summarizeText(output || "done", 120)}`;
			blocks.push({
				id: entry.id,
				kind: "tool",
				role: "tool",
				header: "",
				markdown: "",
				copyText: line,
				fullText: clampText(`! ${command}\n${output}`),
				toolLine: line,
			});
			return blocks;
		}

		if (role === "custom") {
			const text = clampText(fullContentText(message.content));
			if (text.trim()) {
				blocks.push({
					id: entry.id,
					kind: "text",
					role: "custom",
					header: makeHeader(`CUSTOM ${String(message.customType ?? "")}`.trim(), theme, label, entry.id),
					markdown: text,
					copyText: text,
					fullText: text,
				});
			}
			return blocks;
		}

		if (role === "branchSummary" || role === "compactionSummary") {
			const text = clampText(String(message.summary ?? ""));
			blocks.push({ id: entry.id, kind: "meta", role: "meta", header: makeHeader(role.toUpperCase(), theme, label, entry.id), markdown: text, copyText: text, fullText: text });
		}

		return blocks;
	}

	if (entry.type === "compaction" || entry.type === "branch_summary") {
		const text = clampText(entry.summary);
		const title = entry.type === "compaction" ? "COMPACTION" : "BRANCH SUMMARY";
		blocks.push({ id: entry.id, kind: "meta", role: "meta", header: makeHeader(title, theme, label, entry.id), markdown: text, copyText: text, fullText: text });
		return blocks;
	}

	if (entry.type === "custom_message" && entry.display) {
		const text = clampText(fullContentText(entry.content));
		blocks.push({ id: entry.id, kind: "text", role: "custom", header: makeHeader(`CUSTOM ${entry.customType}`, theme, label, entry.id), markdown: text, copyText: text, fullText: text });
	}

	return blocks;
}
