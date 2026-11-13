/**
 * Plaza — `Paper Survey` shared types.
 *
 * A survey run turns user-selected Library papers + a topic into either one
 * Related Work subsection (`paragraph`) or a standalone illustrated HTML
 * report (`report`). The ACP Agent searches the local `Paper Collection`
 * (`agentero-collection` MCP) for related work; citation metadata is resolved
 * by the frontend from the Library / Collection, never trusted from the model.
 */

export type SurveyFormat = "paragraph" | "report";

export type SurveyRunStatus = "running" | "completed" | "failed" | "cancelled";

/** Coarse progress for the live view, derived from stream / tool events. */
export type SurveyPhase =
	| "preparing"
	| "researching"
	| "writing"
	| "finalizing";

export type SurveyCitationSource = "library" | "collection" | "external";

export type SurveyCitation = {
	/** Final BibTeX key, unique within the run; `\cite{key}` in `.tex` uses it verbatim. */
	key: string;
	/** 1-based display number in first-citation order (`[n]` markers, report anchors). */
	index: number;
	source: SurveyCitationSource;
	/** Library catalog id or Collection id (`arxiv:…`, `doi:…`, `venue:…`). */
	paperId?: string;
	/** Vault-relative paper folder for Library papers (open in workspace). */
	libraryPath?: string;
	title: string;
	authors: string[];
	year?: number;
	venue?: string;
	doi?: string;
	arxivId?: string;
	url?: string;
	abstract?: string;
	/** Complete BibTeX entry whose key equals `key`. */
	bibtex: string;
};

/** One sentence of the Related Work paragraph; `cites` holds citation keys. */
export type SurveySentence = { text: string; cites: string[] };

export type SurveyParagraphResult = {
	kind: "paragraph";
	/** Related Work subsection title. */
	title: string;
	/** Paragraphs, each a list of sentences. */
	paragraphs: SurveySentence[][];
	citations: SurveyCitation[];
};

export type SurveyReportResult = {
	kind: "report";
	title: string;
	/** One- or two-sentence abstract for the long card header. */
	summary?: string;
	/** Absolute path of the canonical self-contained HTML file. */
	htmlPath: string;
	citations: SurveyCitation[];
};

export type SurveyResult = SurveyParagraphResult | SurveyReportResult;

export type SurveyToolCall = {
	id: string;
	title: string;
	kind: string;
	status: string;
	/** Short human-readable input digest (e.g. the search query). */
	detail?: string;
};

/** Library paper chosen as a seed (snapshot at start time). */
export type SurveySeedPaper = {
	/** Vault-relative paper folder path (Library primary key). */
	path: string;
	id: string;
	title: string;
	authors: string[];
	year?: number | null;
};

export type SurveyRun = {
	id: string;
	topic: string;
	format: SurveyFormat;
	seeds: SurveySeedPaper[];
	vaultPath: string | null;
	agentId: string | null;
	modelId: string | null;
	status: SurveyRunStatus;
	phase: SurveyPhase;
	createdAt: string;
	updatedAt: string;
	/** Streamed reasoning (capped). */
	reasoning: string;
	/** Streamed assistant text; dropped once the result parses. */
	content: string;
	toolCalls: SurveyToolCall[];
	error?: string;
	result?: SurveyResult;
};

export type SurveyStartInput = {
	topic: string;
	format: SurveyFormat;
	/** Library paper folder paths (`PaperLibraryRow.path`). */
	paperPaths: string[];
	/** Defaults to the store's selected agent / model. */
	agentId?: string | null;
	modelId?: string | null;
};
