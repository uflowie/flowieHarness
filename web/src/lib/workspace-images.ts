// Markdown images that name a file (`![chart](out/chart.png)`, `C:\out\chart.png`, `file:///…`) point at the daemon,
// which serves the worktree's images: the file is on the daemon's machine, not where the page loaded from. A rehype
// plugin, so it runs before Streamdown's link check, which blocks any URL it cannot resolve.
import { createContext } from "react";
import type { StreamdownProps } from "streamdown";

type Pluggable = NonNullable<StreamdownProps["rehypePlugins"]>[number];

type HastNode = { type: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] };

/** The workspace whose files Markdown images name; set by the chat. */
export const CurrentWorkspace = createContext<string | undefined>(undefined);

/** The plugin for `workspace`'s Markdown. */
export function workspaceImages(workspace: string): Pluggable {
	return () => (tree: HastNode) => rewrite(tree, workspace);
}

function rewrite(node: HastNode, workspace: string): void {
	if (node.type === "element" && node.tagName === "img" && typeof node.properties?.src === "string") {
		const path = filePath(node.properties.src);
		if (path !== undefined)
			node.properties.src = `${location.origin}/api/workspaces/${encodeURIComponent(workspace)}/file?path=${encodeURIComponent(path)}`;
	}
	for (const child of node.children ?? []) rewrite(child, workspace);
}

/** The file path `src` names, or undefined for a web URL (`https:`, `data:`, `//host`) that loads as it is. */
function filePath(src: string): string | undefined {
	if (src.startsWith("file://")) return decodeURIComponent(new URL(src).pathname).replace(/^\/([a-zA-Z]:)/, "$1");
	// A Windows drive path, which would otherwise read as a URL scheme.
	if (/^[a-zA-Z]:[\\/]/.test(src)) return src;
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src) || src.startsWith("//")) return undefined;
	return decodeURIComponent(src);
}
