// A promise-based confirmation dialog: `await confirm({ title })` instead of the browser's `confirm()`.
import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from "react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export type ConfirmOptions = {
	readonly title: string;
	readonly description?: string;
	/** The confirming button's label (default "Confirm"). */
	readonly action?: string;
	readonly destructive?: boolean;
};

type Confirm = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<Confirm>(() => Promise.resolve(false));

/** Asks the user to confirm; resolves false when they cancel. */
export const useConfirm = (): Confirm => useContext(ConfirmContext);

export function ConfirmProvider({ children }: { children: ReactNode }) {
	const [open, setOpen] = useState(false);
	// Kept after closing, so the dialog keeps its text while it animates out.
	const [options, setOptions] = useState<ConfirmOptions>({ title: "" });
	const resolver = useRef<(value: boolean) => void>(undefined);

	const confirm = useCallback<Confirm>((next) => {
		resolver.current?.(false);
		setOptions(next);
		setOpen(true);
		return new Promise((resolve) => {
			resolver.current = resolve;
		});
	}, []);

	const settle = (value: boolean) => {
		resolver.current?.(value);
		resolver.current = undefined;
		setOpen(false);
	};

	return (
		<ConfirmContext.Provider value={confirm}>
			{children}
			<AlertDialog open={open} onOpenChange={(next) => !next && settle(false)}>
				<AlertDialogContent size="sm">
					<AlertDialogHeader>
						<AlertDialogTitle>{options.title}</AlertDialogTitle>
						{options.description && (
							<AlertDialogDescription className="whitespace-pre-wrap">{options.description}</AlertDialogDescription>
						)}
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction variant={options.destructive ? "destructive" : "default"} onClick={() => settle(true)}>
							{options.action ?? "Confirm"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</ConfirmContext.Provider>
	);
}
