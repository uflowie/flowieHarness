// A conversation as the UI renders it: the daemon's live view, merged into pi-durable's ConversationTranscript so the
// client keeps every entry it has seen (the view itself is a window of the newest), with gaps after a reconnect.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { applyImmutable } from "@earendil-works/chord/delta";
import type { ConversationView, Cursor, EntryRecord, Page } from "@earendil-works/pi-durable";
import { ConversationTranscript, type TranscriptItem, type TranscriptView } from "pi-durable-transcript";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { daemon } from "@/lib/socket";

export type Gap = Extract<TranscriptItem, { kind: "gap" }>;

export type ConversationState = {
	readonly view: TranscriptView | undefined;
	/** Why the watch ended or failed; it is retried on the next reconnect. */
	readonly problem: string | undefined;
	loadEarlier(): void;
	fillGap(gap: Gap): void;
};

let watches = 0;

export function useConversation(workspace: string, conversation?: number): ConversationState {
	const [view, setView] = useState<TranscriptView>();
	const [problem, setProblem] = useState<string>();
	const transcriptRef = useRef<ConversationTranscript>(undefined);

	useEffect(() => {
		setView(undefined);
		setProblem(undefined);
		const transcript = new ConversationTranscript(async (query, limit): Promise<Page<EntryRecord, Cursor>> => {
			const page = await api.entries(workspace, {
				limit,
				...(query.minEntryId === undefined ? {} : { min: query.minEntryId }),
				...(query.maxEntryId === undefined ? {} : { max: query.maxEntryId }),
				...(query.order === undefined ? {} : { order: query.order }),
				...(conversation === undefined ? {} : { conversation }),
			});
			return { items: page.items };
		});
		transcriptRef.current = transcript;
		let raw: ConversationView | undefined;
		const stop = daemon.watch(
			// A name of its own per watch, so a stray message of an earlier watch (StrictMode mounts twice) is ignored.
			`${workspace}/${conversation ?? "root"}/${++watches}`,
			() => {
				const from = transcript.resume?.from;
				return {
					workspace,
					...(conversation === undefined ? {} : { conversation }),
					...(from === undefined ? {} : { from }),
				};
			},
			{
				value: (value) => {
					raw = value;
					setProblem(undefined);
					setView(transcript.merge(value));
				},
				ops: (ops) => {
					raw = applyImmutable(raw, ops);
					setView(transcript.merge(raw));
				},
				end: (reason) => setProblem(reason === "stopped" ? undefined : `Watch ended: ${reason}`),
				error: (message) => setProblem(message),
			},
		);
		return () => {
			stop();
			transcriptRef.current = undefined;
		};
	}, [workspace, conversation]);

	const loadEarlier = useCallback(() => {
		const transcript = transcriptRef.current;
		transcript?.loadEarlier(BACKGROUND_CONTEXT).then(
			(next) => transcriptRef.current === transcript && setView(next),
			(error: unknown) => setProblem(String(error)),
		);
	}, []);

	const fillGap = useCallback((gap: Gap) => {
		const transcript = transcriptRef.current;
		transcript?.fillGap(gap, BACKGROUND_CONTEXT).then(
			(next) => transcriptRef.current === transcript && setView(next),
			(error: unknown) => setProblem(String(error)),
		);
	}, []);

	return { view, problem, loadEarlier, fillGap };
}
