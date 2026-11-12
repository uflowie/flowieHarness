// Messages the user sent that the transcript does not show yet (p2's outbox): shown at once, so sending feels instant,
// and dropped as soon as the daemon's view has them, queued in the inbox or placed as a user entry.
import type { UserMessage } from "@earendil-works/pi-ai";
import type { InboxState } from "@earendil-works/pi-durable";
import type { Submit } from "@flowie/daemon/protocol";
import type { TranscriptView } from "pi-durable-transcript";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

export type Pending = {
	readonly key: string;
	readonly content: UserMessage["content"];
	/** The newest entry when it was sent: its user entry comes after. */
	readonly after: number;
	/** The submission's ID, once the daemon admitted it. */
	readonly submission?: number;
};

export type Outbox = {
	/** Sent messages not in the view yet, oldest first. */
	readonly pending: readonly Pending[];
	/** Shows `draft` at once and submits it; rejects (and stops showing it) when the daemon refuses it. */
	send(draft: Submit): Promise<void>;
};

export function useOutbox(workspace: string, view: TranscriptView | undefined): Outbox {
	const [outbox, setOutbox] = useState<readonly Pending[]>([]);
	const latest = useRef(view);
	latest.current = view;
	const pending = view === undefined ? outbox : outbox.filter((each) => !arrived(each, view));

	// Forget arrived messages, so they cannot match a later entry with the same text.
	useEffect(() => {
		if (pending.length !== outbox.length) setOutbox(pending);
	}, [pending, outbox.length]);

	const send = useCallback(
		async (draft: Submit) => {
			// The request ID doubles as the message's key: a retry would find the same submission.
			const key = draft.requestId ?? crypto.randomUUID();
			setOutbox((current) => [...current, { key, content: draft.content, after: newestEntry(latest.current) }]);
			try {
				const { submission } = await api.submit(workspace, { ...draft, requestId: key });
				setOutbox((current) => current.map((each) => (each.key === key ? { ...each, submission } : each)));
			} catch (error) {
				setOutbox((current) => current.filter((each) => each.key !== key));
				throw error;
			}
		},
		[workspace],
	);

	return { pending, send };
}

function arrived(pending: Pending, view: TranscriptView): boolean {
	const inbox = view.docs["pi.inbox"] as InboxState | undefined;
	if (pending.submission !== undefined && inbox?.items.some((item) => item.id === pending.submission)) return true;
	const content = JSON.stringify(pending.content);
	return view.items.some(
		(item) =>
			item.kind === "entry" &&
			item.entry.id > pending.after &&
			item.entry.model?.[0]?.role === "user" &&
			JSON.stringify(item.entry.model[0].content) === content,
	);
}

function newestEntry(view: TranscriptView | undefined): number {
	let newest = -1;
	for (const item of view?.items ?? []) if (item.kind === "entry" && item.entry.id > newest) newest = item.entry.id;
	return newest;
}
