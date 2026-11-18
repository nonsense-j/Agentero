"use client";

import { Copy, Download } from "lucide-react";
import {
	type ComponentPropsWithoutRef,
	isValidElement,
	type ReactNode,
	useCallback,
	useMemo,
} from "react";
import { useTranslation } from "react-i18next";
import type { BundledLanguage } from "shiki";
import { CodeBlockContent } from "@/components/agent/rendering/code-block";
import { Button } from "@/components/ui/button";
import {
	CodeBlock,
	CodeBlockActions,
	CodeBlockHeader,
	CodeBlockTitle,
} from "@/components/ui/code-block";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { copyTextToClipboard } from "@/lib/core/clipboard";
import { cn } from "@/lib/core/utils";

export function downloadText(filename: string, text: string) {
	const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}

export function extractText(node: ReactNode): string {
	if (node == null || typeof node === "boolean") return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(extractText).join("");
	if (isValidElement(node)) {
		const props = node.props as { children?: ReactNode };
		return extractText(props.children);
	}
	return "";
}

export function extractLanguage(className?: string): string {
	const match = className?.match(/language-([^\s]+)/);
	return match?.[1] ?? "";
}

const LANGUAGE_EXTENSIONS: Record<string, string> = {
	typescript: "ts",
	javascript: "js",
	tsx: "tsx",
	jsx: "jsx",
	python: "py",
	json: "json",
	rust: "rs",
	go: "go",
	markdown: "md",
	md: "md",
	html: "html",
	css: "css",
	scss: "scss",
	shell: "sh",
	bash: "sh",
	sh: "sh",
	zsh: "sh",
	yaml: "yml",
	yml: "yml",
	toml: "toml",
	sql: "sql",
	text: "txt",
	plaintext: "txt",
	txt: "txt",
};

function extensionFor(language: string): string {
	if (!language) return "txt";
	const mapped = LANGUAGE_EXTENSIONS[language.toLowerCase()];
	if (mapped) return mapped;
	return /^[a-z0-9.+_-]+$/i.test(language) ? language : "txt";
}

type PlainCodeBlockProps = ComponentPropsWithoutRef<"code"> & {
	node?: unknown;
};

/**
 * Streamdown fenced-code renderer aligned with {@link PlainTable}:
 * hover copy / download, no outer card chrome, no fullscreen.
 */
export function PlainCodeBlock({
	children,
	className,
	node: _node,
	...props
}: PlainCodeBlockProps) {
	const isInline = !("data-block" in props);
	if (isInline) {
		return (
			<code
				className={cn(
					"rounded-[5px] border border-border/55 bg-muted/65 px-[0.36em] py-[0.12em] font-mono text-[0.86em] text-foreground/90",
					className,
				)}
				data-streamdown="inline-code"
				{...props}
			>
				{children}
			</code>
		);
	}

	const language = extractLanguage(className);
	const code = extractText(children).replace(/\n$/, "");

	return <PlainCodeBlockView code={code} language={language} />;
}

export function PlainCodeBlockView({
	code,
	language,
}: {
	code: string;
	language: string;
}) {
	const { t } = useTranslation("aiElements");
	const lang = (language || "text") as BundledLanguage;

	const filename = useMemo(() => `code.${extensionFor(language)}`, [language]);

	const handleCopy = useCallback(() => {
		void copyTextToClipboard(code, {
			successMessage: t("code.copy"),
		});
	}, [code, t]);

	const handleDownload = useCallback(() => {
		downloadText(filename, code);
	}, [code, filename]);

	const iconButtonClass =
		"size-6 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:opacity-100";
	const label = (language || "text").toLowerCase();

	return (
		<CodeBlock className="group/code my-3.5 rounded-xl border-border/65 bg-muted/20 shadow-[inset_0_1px_0_var(--magpie-edge)] dark:bg-muted/15">
			<CodeBlockHeader className="h-8 justify-between border-b border-border/50 bg-muted/45 px-3 pt-0">
				<CodeBlockTitle
					className="font-mono text-[0.6875rem] font-medium lowercase leading-none tracking-wide text-muted-foreground"
					title={label}
				>
					{label}
				</CodeBlockTitle>
				<CodeBlockActions
					className={cn(
						"my-0 mr-0 gap-0.5",
						"opacity-0 transition-opacity duration-150 group-hover/code:opacity-100",
						"focus-within:opacity-100 pointer-coarse:opacity-100",
					)}
				>
					<TooltipProvider>
						{[
							{
								key: "copy",
								label: t("code.copy"),
								Icon: Copy,
								onClick: handleCopy,
							},
							{
								key: "download",
								label: t("code.download"),
								Icon: Download,
								onClick: handleDownload,
							},
						].map(({ key, label: actionLabel, Icon, onClick }) => (
							<Tooltip key={key}>
								<TooltipTrigger asChild>
									<Button
										type="button"
										variant="ghost"
										size="icon"
										className={iconButtonClass}
										aria-label={actionLabel}
										onClick={onClick}
									>
										<Icon className="size-3.5" />
									</Button>
								</TooltipTrigger>
								<TooltipContent>
									<p>{actionLabel}</p>
								</TooltipContent>
							</Tooltip>
						))}
					</TooltipProvider>
				</CodeBlockActions>
			</CodeBlockHeader>
			<CodeBlockContent
				code={code}
				language={lang}
				showLineNumbers={false}
				className="px-3.5 py-3 text-[0.8125rem] leading-[1.6]"
			/>
		</CodeBlock>
	);
}
