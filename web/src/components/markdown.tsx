// Model text as Markdown with Streamdown (it copes with half-written Markdown while an answer streams), fenced code
// routed to a highlighted Code Block, as in shadcn's Code Block "Markdown" example.
import { memo } from "react";
import { type ExtraProps, Streamdown, useIsCodeFenceIncomplete } from "streamdown";
import {
	CodeBlock,
	CodeBlockActions,
	CodeBlockContent,
	CodeBlockCopyButton,
	CodeBlockHeader,
	CodeBlockLine,
	CodeBlockTitle,
} from "@/components/ui/code-block";
import { useHighlightedCode } from "@/hooks/use-highlighted-code";

export const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
	return (
		<Streamdown controls={false} components={components} isAnimating={streaming === true}>
			{text}
		</Streamdown>
	);
});

const components = { code: MarkdownCode };

function MarkdownCode({ node: _node, className, children, ...props }: React.ComponentProps<"code"> & ExtraProps) {
	// Streamdown marks fenced code with data-block; everything else is inline.
	if (!("data-block" in props))
		return (
			<code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[0.9em]" {...props}>
				{children}
			</code>
		);
	return (
		<MarkdownCodeBlock
			code={typeof children === "string" ? children : ""}
			language={/language-(\S+)/.exec(className ?? "")?.[1] ?? ""}
		/>
	);
}

function MarkdownCodeBlock({ code, language }: { code: string; language: string }) {
	// True until the closing fence arrives.
	const incomplete = useIsCodeFenceIncomplete();
	const lines = useHighlightedCode(code, language);
	return (
		<CodeBlock className="my-3">
			<CodeBlockHeader>
				<CodeBlockTitle>{language || "text"}</CodeBlockTitle>
				<CodeBlockActions>
					<CodeBlockCopyButton value={code} disabled={incomplete} />
				</CodeBlockActions>
			</CodeBlockHeader>
			<CodeBlockContent>
				{lines.map((line, index) => (
					<CodeBlockLine key={index}>{line}</CodeBlockLine>
				))}
			</CodeBlockContent>
		</CodeBlock>
	);
}
