// "Global instructions": edits the AGENTS.md in pi's agent directory, which every workspace's agent reads. The prompt
// re-reads it before each request, so a save reaches running agents on their next turn.
import type { GlobalInstructions } from "@flowie/daemon/protocol";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";

type Props = {
	readonly open: boolean;
	onOpenChange(open: boolean): void;
};

export function InstructionsDialog({ open, onOpenChange }: Props) {
	const [file, setFile] = useState<GlobalInstructions>();
	const [draft, setDraft] = useState("");
	const [error, setError] = useState<string>();
	const [saving, setSaving] = useState(false);

	// Loaded on every open, so an edit made outside flowie in between is not overwritten with a stale copy.
	useEffect(() => {
		if (!open) return;
		setFile(undefined);
		setError(undefined);
		api.instructions().then(
			(loaded) => {
				setFile(loaded);
				setDraft(loaded.content);
			},
			(caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)),
		);
	}, [open]);

	const save = async () => {
		if (saving) return;
		setSaving(true);
		try {
			await api.saveInstructions(draft);
			toast.success("Instructions saved");
			onOpenChange(false);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex max-h-[90svh] flex-col sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>Global instructions</DialogTitle>
					<DialogDescription>
						Every agent reads these, in all repositories.{" "}
						{file && (
							<span className="font-mono break-all">
								{file.path}
								{!file.exists && " (created on save)"}
							</span>
						)}
					</DialogDescription>
				</DialogHeader>
				<Textarea
					autoFocus
					value={draft}
					disabled={file === undefined}
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
							event.preventDefault();
							void save();
						}
					}}
					placeholder="Markdown instructions, e.g. preferred tools, code style, how to commit"
					aria-label="Global instructions"
					className="field-sizing-fixed h-[60svh] resize-none font-mono"
				/>
				{error && <p className="text-sm text-destructive">{error}</p>}
				<DialogFooter>
					<DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
					<Button
						onClick={() => void save()}
						disabled={file === undefined || saving || (file.exists && draft === file.content)}
					>
						Save
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
