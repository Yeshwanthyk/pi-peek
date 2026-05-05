/**
 * Plain-substring search over rendered lines. Smartcase: query in all lowercase
 * matches case-insensitively, otherwise case-sensitive.
 */

export type Match = {
	lineIdx: number;
	col: number;
	len: number;
};

type LineLike = { plain: string };

function isSmartcaseInsensitive(query: string): boolean {
	return query === query.toLowerCase();
}

export function findMatches(lines: LineLike[], query: string): Match[] {
	if (!query) return [];
	const matches: Match[] = [];
	const ci = isSmartcaseInsensitive(query);
	const needle = ci ? query.toLowerCase() : query;

	for (let i = 0; i < lines.length; i++) {
		const haystack = ci ? lines[i].plain.toLowerCase() : lines[i].plain;
		let pos = 0;
		while (true) {
			const found = haystack.indexOf(needle, pos);
			if (found === -1) break;
			matches.push({ lineIdx: i, col: found, len: query.length });
			pos = found + Math.max(1, query.length);
		}
	}
	return matches;
}

const ANSI_ESCAPE_RE = /^\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]))/;

/**
 * Inject background-color escape sequences around match positions in an
 * already-styled (ANSI-containing) string. Foreground colors are preserved.
 */
export function highlightLine(
	text: string,
	matches: Array<{ col: number; len: number; current?: boolean }>,
	openMatch: string,
	openCurrent: string,
	close: string,
): string {
	if (matches.length === 0) return text;
	const sorted = [...matches].sort((a, b) => a.col - b.col);

	let result = "";
	let plainCol = 0;
	let i = 0;
	let active: { col: number; len: number; current?: boolean } | null = null;
	let nextIdx = 0;

	while (i < text.length) {
		if (text[i] === "\x1b") {
			const m = text.slice(i).match(ANSI_ESCAPE_RE);
			if (m) {
				result += m[0];
				i += m[0].length;
				continue;
			}
		}

		if (!active && nextIdx < sorted.length && plainCol >= sorted[nextIdx].col) {
			active = sorted[nextIdx];
			result += active.current ? openCurrent : openMatch;
		}

		result += text[i];
		plainCol++;
		i++;

		if (active && plainCol >= active.col + active.len) {
			result += close;
			active = null;
			nextIdx++;
		}
	}

	if (active) result += close;
	return result;
}

/** Find nearest match index at-or-after `lineIdx`. -1 if no matches. */
export function nearestMatchAfter(matches: Match[], lineIdx: number): number {
	if (matches.length === 0) return -1;
	for (let i = 0; i < matches.length; i++) {
		if (matches[i].lineIdx >= lineIdx) return i;
	}
	return 0; // wrap to first
}

/** Find nearest match index at-or-before `lineIdx`. -1 if no matches. */
export function nearestMatchBefore(matches: Match[], lineIdx: number): number {
	if (matches.length === 0) return -1;
	for (let i = matches.length - 1; i >= 0; i--) {
		if (matches[i].lineIdx <= lineIdx) return i;
	}
	return matches.length - 1; // wrap to last
}
