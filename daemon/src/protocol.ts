// The daemon's wire protocol: request bodies the HTTP API accepts, and the WebSocket messages both ways. Bodies and
// client messages are checked here, at the trust boundary; everything past it is typed.
import type { Op } from "@earendil-works/chord/delta";
import { ModelThinkingLevelSchema } from "@earendil-works/pi-ai/providers/model-schema";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ConversationView, ModelRef, RunFailureReason, UsageState } from "@earendil-works/pi-durable";
import { arr, compile, int, lit, nullable, obj, oneOf, opt, type Static, str, union } from "@earendil-works/pi-schema";

/** What the sidebar shows for a workspace. */
export type WorkspaceStatus =
	| { readonly kind: "closed" }
	| { readonly kind: "opening" }
	| { readonly kind: "idle"; readonly runFailure?: RunFailureReason }
	| { readonly kind: "busy" }
	| { readonly kind: "failed"; readonly error: string };

/** A worktree as the API lists it. */
export type WorkspaceListing = {
	readonly id: string;
	readonly projectId: string;
	readonly path: string;
	readonly head?: string;
	readonly branch?: string;
	readonly main: boolean;
	readonly prunable: boolean;
	readonly status: WorkspaceStatus;
};

/** `GET /api/projects` (as `projects`), `POST /api/projects`. `error` when git could not list its worktrees. */
export type ProjectListing = {
	readonly id: string;
	readonly name: string;
	readonly path: string;
	readonly workspaces: readonly WorkspaceListing[];
	readonly error?: string;
};

/** `GET /api/directories?path=`: one folder on the daemon's machine, for browsing to a repository. */
export type DirectoryListing = {
	/** The folder listed, absolute. */
	readonly path: string;
	/** Absent at a root. */
	readonly parent?: string;
	/** Whether the folder itself is a git repository. */
	readonly repo: boolean;
	readonly entries: readonly { readonly name: string; readonly path: string; readonly repo: boolean }[];
	/** Why the folder could not be read; `entries` is then empty. */
	readonly error?: string;
	/** Shortcuts: the home folder, the folders holding registered projects, the file system roots. */
	readonly home: string;
	readonly places: readonly string[];
	readonly roots: readonly string[];
};

/** `GET /api/models`. */
export type ModelListing = {
	readonly defaults: { readonly model?: ModelRef; readonly thinkingLevel?: ModelThinkingLevel };
	readonly models: readonly {
		readonly provider: string;
		readonly id: string;
		readonly name: string;
		readonly reasoning: boolean;
		readonly input: readonly string[];
		readonly contextWindow: number;
	}[];
};

/** `GET /api/workspaces/:id`. */
export type WorkspaceDetail = WorkspaceListing & {
	readonly agent: { readonly model?: ModelRef; readonly thinkingLevel: ModelThinkingLevel; readonly cwd?: string };
	readonly usage: UsageState;
};

/** `GET /api/instructions`, `PUT /api/instructions`: the global instruction file every agent's prompt includes. */
export type GlobalInstructions = {
	readonly path: string;
	/** False until the first save creates it. */
	readonly exists: boolean;
	readonly content: string;
};

/** `PUT /api/instructions`. */
export const SaveInstructions = compile(obj({ content: str() }));

const Text = obj({ type: lit("text"), text: str() });
const Image = obj({ type: lit("image"), data: str({ minLength: 1 }), mimeType: str({ minLength: 1 }) });

/** `POST /api/projects`: register the git repository containing `path`. */
export const AddProject = compile(obj({ path: str({ minLength: 1 }) }));

/**
 * `POST /api/projects/:id/worktrees`: a new worktree on branch `name` (default: a random unused name, such as
 * "brave-otter"), from `base` (default: the main checkout).
 */
export const CreateWorktree = compile(
	obj({ name: opt(str({ minLength: 1, maxLength: 200 })), base: opt(str({ minLength: 1 })) }),
);

/** `POST /api/workspaces/:id/submit`: user input for the workspace's agent, text or text and images. */
const SubmitSchema = obj({
	content: union([str({ minLength: 1 }), arr(union([Text, Image]), { minItems: 1 })]),
	/** While the agent works: `followUp` (default) queues it for after the run, `steer` joins the running work. */
	whenBusy: opt(oneOf(["steer", "followUp", "reject"])),
	/** A retried request with the same ID finds the first submission instead of submitting twice. */
	requestId: opt(str({ minLength: 1, maxLength: 200 })),
});
export const Submit = compile(SubmitSchema);
export type Submit = Static<typeof SubmitSchema>;

/** `POST /api/workspaces/:id/agent`: change the model or thinking level; `null` goes back to the default. */
export const Configure = compile(
	obj({
		model: opt(nullable(obj({ provider: str({ minLength: 1 }), modelId: str({ minLength: 1 }) }))),
		thinkingLevel: opt(nullable(ModelThinkingLevelSchema)),
	}),
);

/** `POST /api/workspaces/:id/compact`. */
export const Compact = compile(obj({ instructions: opt(str()) }));

/** `POST /api/workspaces/:id/reset`: a fresh context, optionally starting from a handoff note. */
export const Reset = compile(obj({ handoff: opt(str()) }));

/**
 * Client to daemon over the WebSocket. `watch` follows a conversation of a workspace (default: its agent, the root
 * conversation); `sub` names the subscription in the replies. `from` resumes the window after a reconnect.
 */
const ClientMessageSchema = union([
	obj({
		type: lit("watch"),
		sub: str({ minLength: 1, maxLength: 100 }),
		workspace: str({ minLength: 1 }),
		/** Durable IDs are integers. */
		conversation: opt(int({ minimum: 0 })),
		from: opt(int({ minimum: 0 })),
		min: opt(int({ minimum: 1, maximum: 1000 })),
	}),
	obj({ type: lit("unwatch"), sub: str({ minLength: 1, maxLength: 100 }) }),
]);
export const ClientMessage = compile(ClientMessageSchema);
export type ClientMessage = Static<typeof ClientMessageSchema>;

/**
 * Daemon to client. A watch sends `value` once, then `ops` that turn the previous value into the next (apply them with
 * `applyImmutable` from `@earendil-works/chord/delta`), until `end`. Status messages go to every client.
 */
export type ServerMessage =
	| { readonly type: "statuses"; readonly statuses: Readonly<Record<string, WorkspaceStatus>> }
	| { readonly type: "status"; readonly workspace: string; readonly status: WorkspaceStatus }
	| { readonly type: "value"; readonly sub: string; readonly value: ConversationView }
	| { readonly type: "ops"; readonly sub: string; readonly ops: readonly Op[] }
	| { readonly type: "end"; readonly sub: string; readonly reason: string }
	| { readonly type: "error"; readonly sub?: string; readonly message: string };
