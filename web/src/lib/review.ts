// Review comments on a worktree's changes: questions and change requests on lines of the diff, kept per workspace in
// the browser until they are sent to the agent as one message.
import type { FileDiffMetadata } from "@pierre/diffs";

export type CommentKind = "question" | "change";
export type Side = "additions" | "deletions";

export type ReviewComment = {
	readonly id: string;
	/** The file's path (its new path after a rename). */
	readonly path: string;
	/** Which version the line numbers are in: the new file, or the old one for removed lines. */
	readonly side: Side;
	readonly start: number;
	readonly end: number;
	readonly kind: CommentKind;
	readonly text: string;
	/** The commented lines as they were when written; the message quotes them, and their change makes it outdated. */
	readonly code: string;
};

/** The text of lines `start`–`end` on one side of a diff, or undefined when a line is not in it (not loaded). */
export function linesOf(diff: FileDiffMetadata, side: Side, start: number, end: number): string | undefined {
	const lines: string[] = [];
	for (let number = start; number <= end; number++) {
		const line = lineAt(diff, side, number);
		if (line === undefined) return undefined;
		lines.push(line.replace(/\r?\n$/, ""));
	}
	return lines.join("\n");
}

function lineAt(diff: FileDiffMetadata, side: Side, number: number): string | undefined {
	const lines = side === "additions" ? diff.additionLines : diff.deletionLines;
	if (!diff.isPartial) return lines[number - 1];
	// A diff from a patch holds only its hunks' lines: find the hunk with the line.
	for (const hunk of diff.hunks) {
		let first = side === "additions" ? hunk.additionStart : hunk.deletionStart;
		for (const content of hunk.hunkContent) {
			const count =
				content.type === "context" ? content.lines : side === "additions" ? content.additions : content.deletions;
			const index = side === "additions" ? content.additionLineIndex : content.deletionLineIndex;
			if (number >= first && number < first + count) return lines[index + number - first];
			first += count;
		}
	}
	return undefined;
}

/** The message that sends the comments to the agent: each with where it is, the lines it is about, and the text. */
export function reviewMessage(comments: readonly ReviewComment[]): string {
	const questions = comments.some((comment) => comment.kind === "question");
	const changes = comments.some((comment) => comment.kind === "change");
	const ask =
		questions && changes
			? "Answer the questions and make the requested changes."
			: questions
				? "Answer the questions; don't change code unless a question asks for it."
				: "Make the requested changes.";
	const items = comments.map((comment, index) => {
		const lines = comment.start === comment.end ? `line ${comment.start}` : `lines ${comment.start}–${comment.end}`;
		const where = `\`${comment.path}\` ${lines}${comment.side === "deletions" ? " of the old version (removed)" : ""}`;
		const label = comment.kind === "question" ? "Question" : "Change request";
		return `${index + 1}. ${label} on ${where}:\n\n${fence(comment.code, comment.path)}\n\n${comment.text.trim()}`;
	});
	return `Review comments on your changes. ${ask}\n\n${items.join("\n\n")}`;
}

/** A fenced code block that its own backticks cannot close. */
function fence(code: string, path: string): string {
	const longest = Math.max(2, ...[...code.matchAll(/`+/g)].map((match) => match[0].length));
	const marker = "`".repeat(longest + 1);
	const language = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "";
	return `${marker}${language}\n${code}\n${marker}`;
}

const storageKey = (workspace: string) => `flowie.review.${workspace}`;

export function loadComments(workspace: string): ReviewComment[] {
	try {
		const parsed: unknown = JSON.parse(localStorage.getItem(storageKey(workspace)) ?? "[]");
		// Browser storage: kept by an older version, or edited by hand.
		return Array.isArray(parsed)
			? parsed.filter(
					(each): each is ReviewComment =>
						typeof each?.id === "string" &&
						typeof each?.path === "string" &&
						(each?.side === "additions" || each?.side === "deletions") &&
						Number.isInteger(each?.start) &&
						Number.isInteger(each?.end) &&
						(each?.kind === "question" || each?.kind === "change") &&
						typeof each?.text === "string" &&
						typeof each?.code === "string",
				)
			: [];
	} catch {
		return [];
	}
}

export function saveComments(workspace: string, comments: readonly ReviewComment[]): void {
	try {
		if (comments.length > 0) localStorage.setItem(storageKey(workspace), JSON.stringify(comments));
		else localStorage.removeItem(storageKey(workspace));
	} catch {
		// Kept in memory only.
	}
}
