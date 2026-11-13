import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { NetworkProxyRow } from "@/components/settings/agent-common-rows";
import {
	PageTitle,
	SettingsGroup,
	SettingsRow,
	SettingsSectionLabel,
} from "@/components/settings/settings-layout";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { commands } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { callApi } from "@/lib/core/ipc";
import { notifyError, notifySuccess } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import {
	PAPER_TREE_LABEL_MODES,
	PAPER_TREE_SORT_MODES,
	type PaperTreeLabelMode,
	type PaperTreeSortMode,
} from "@/lib/paper";
import {
	type AppSettings,
	AUTO_UPDATE_INTERNAL_LINKS,
	type AutoUpdateInternalLinks,
	PAPER_NOTE_MODES,
	type PaperNoteMode,
	PDF_SCROLL_STRATEGIES,
	PDF_SPREAD_MODES,
	type PdfScrollStrategy,
	type PdfSpreadMode,
	saveSettingsAsync,
} from "@/lib/settings";
import { DEFAULT_NETWORK_PROXY_URL } from "@/lib/settings/defaults";
import { notesTemplateSeed } from "@/lib/vault/note-template";
import { ConnectorSettingsBlock } from "./general/connector-settings-block";
import { EasyScholarSettingsBlock } from "./general/easy-scholar-settings-block";
import { FinderIntegrationRow } from "./general/finder-integration-row";
import { InstitutionAccessBlock } from "./general/institution-access-block";
import { KeywordLlmSettingsBlock } from "./general/keyword-llm-settings-block";
import { McpSettingsBlock } from "./general/mcp-settings-block";
import { OpenAlexSettingsBlock } from "./general/open-alex-settings-block";
import { PrivacySettingsBlock } from "./general/privacy-settings-block";
import { TerminalAppRow } from "./general/terminal-app-row";

export function GeneralPane({
	settings,
	patch,
	vaultPath = null,
}: {
	settings: AppSettings;
	patch: (p: Partial<AppSettings>) => void;
	vaultPath?: string | null;
}) {
	const { t } = useTranslation("settings");
	const [proxyUrlDraft, setProxyUrlDraft] = useState(settings.networkProxyUrl);
	const [easyScholarKeyDraft, setEasyScholarKeyDraft] = useState(
		settings.easyScholarKey,
	);
	const [openAlexKeyDraft, setOpenAlexKeyDraft] = useState(
		settings.openAlexKey,
	);
	// OS system proxy detected by the Host (Windows "Internet Settings"); used
	// automatically while the app proxy is off — surface it for transparency.
	const [systemProxy, setSystemProxy] = useState<string | null>(null);
	const [seedingTemplate, setSeedingTemplate] = useState(false);

	// Custom note mode seeds `.agentero/templates/NOTES.md` in the active vault.
	const canSeedTemplate = Boolean(vaultPath);

	const seedTemplate = async () => {
		if (!vaultPath || !canSeedTemplate) return;
		setSeedingTemplate(true);
		try {
			const res = await notesTemplateSeed(vaultPath);
			notifySuccess(
				t(
					res.created
						? "general.paperNoteMode.seedCreated"
						: "general.paperNoteMode.seedExists",
				),
			);
		} catch (e) {
			notifyError(errorText(e));
		} finally {
			setSeedingTemplate(false);
		}
	};

	useEffect(() => {
		setProxyUrlDraft(settings.networkProxyUrl);
	}, [settings.networkProxyUrl]);

	useEffect(() => {
		setEasyScholarKeyDraft(settings.easyScholarKey);
	}, [settings.easyScholarKey]);

	useEffect(() => {
		setOpenAlexKeyDraft(settings.openAlexKey);
	}, [settings.openAlexKey]);

	useEffect(() => {
		if (!isTauri()) return;
		let cancelled = false;
		void callApi(() => commands.networkSystemProxy())
			.then((p) => {
				if (!cancelled) setSystemProxy(p ?? null);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, []);

	return (
		<>
			<PageTitle title={t("general.title")} />
			<SettingsSectionLabel>
				{t("general.sections.papers")}
			</SettingsSectionLabel>
			<SettingsGroup>
				<SettingsRow label={t("general.paperTreeLabelMode.label")}>
					<Select
						value={settings.paperTreeLabelMode}
						onValueChange={(v) =>
							patch({ paperTreeLabelMode: v as PaperTreeLabelMode })
						}
					>
						<SelectTrigger size="sm" className="min-w-[180px] max-w-[240px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{PAPER_TREE_LABEL_MODES.map((mode) => (
								<SelectItem key={mode} value={mode}>
									{t(`general.paperTreeLabelMode.${mode}`)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingsRow>
				<SettingsRow label={t("general.paperTreeSortMode.label")}>
					<Select
						value={settings.paperTreeSortMode}
						onValueChange={(v) =>
							patch({ paperTreeSortMode: v as PaperTreeSortMode })
						}
					>
						<SelectTrigger size="sm" className="min-w-[180px] max-w-[240px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{PAPER_TREE_SORT_MODES.map((mode) => (
								<SelectItem key={mode} value={mode}>
									{t(`general.paperTreeSortMode.${mode}`)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingsRow>
				<SettingsRow label={t("general.paperNoteMode.label")}>
					<Select
						value={settings.paperNoteMode}
						onValueChange={(v) => patch({ paperNoteMode: v as PaperNoteMode })}
					>
						<SelectTrigger size="sm" className="min-w-[180px] max-w-[240px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{PAPER_NOTE_MODES.map((mode) => (
								<SelectItem key={mode} value={mode}>
									{t(`general.paperNoteMode.${mode}`)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingsRow>
				{settings.paperNoteMode === "custom" ? (
					<SettingsRow
						label={
							<code className="font-mono text-muted-foreground text-xs">
								.agentero/templates/NOTES.md
							</code>
						}
					>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={seedingTemplate || !canSeedTemplate}
									aria-label={t("general.paperNoteMode.seed")}
									onClick={() => void seedTemplate()}
								>
									{t("general.paperNoteMode.seed")}
								</Button>
							</TooltipTrigger>
							<TooltipContent>{t("general.paperNoteMode.seed")}</TooltipContent>
						</Tooltip>
					</SettingsRow>
				) : null}
				<SettingsRow
					label={t("general.autoOpenPaperNotes.label")}
					htmlFor="auto-open-paper-notes"
				>
					<Switch
						id="auto-open-paper-notes"
						checked={settings.autoOpenPaperNotes}
						onCheckedChange={(v) => patch({ autoOpenPaperNotes: v })}
					/>
				</SettingsRow>
				<SettingsRow
					label={t("general.autoIngest.label")}
					htmlFor="auto-ingest"
				>
					<Switch
						id="auto-ingest"
						checked={settings.autoIngest}
						onCheckedChange={(v) => patch({ autoIngest: v })}
					/>
				</SettingsRow>
				<SettingsRow
					label={t("general.replaceCurrentTabOnOpenPaper.label")}
					htmlFor="replace-current-tab-on-open-paper"
				>
					<Switch
						id="replace-current-tab-on-open-paper"
						checked={settings.replaceCurrentTabOnOpenPaper}
						onCheckedChange={(v) => patch({ replaceCurrentTabOnOpenPaper: v })}
					/>
				</SettingsRow>
				<SettingsRow label={t("general.autoUpdateInternalLinks.label")}>
					<Select
						value={settings.autoUpdateInternalLinks}
						onValueChange={(value) =>
							patch({
								autoUpdateInternalLinks: value as AutoUpdateInternalLinks,
							})
						}
					>
						<SelectTrigger size="sm" className="min-w-[180px] max-w-[240px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{AUTO_UPDATE_INTERNAL_LINKS.map((mode) => (
								<SelectItem key={mode} value={mode}>
									{t(`general.autoUpdateInternalLinks.${mode}`)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingsRow>
				<SettingsRow label={t("general.batchImportConcurrency.label")}>
					<Select
						value={String(settings.batchImportConcurrency)}
						onValueChange={(value) =>
							patch({ batchImportConcurrency: Number(value) })
						}
					>
						<SelectTrigger size="sm" className="min-w-[180px] max-w-[240px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{Array.from({ length: 10 }, (_, index) => index + 1).map(
								(value) => (
									<SelectItem key={value} value={String(value)}>
										{t("general.batchImportConcurrency.value", { value })}
									</SelectItem>
								),
							)}
						</SelectContent>
					</Select>
				</SettingsRow>
			</SettingsGroup>

			<SettingsSectionLabel className="mt-4">
				{t("general.sections.pdf")}
			</SettingsSectionLabel>
			<SettingsGroup>
				<SettingsRow label={t("general.pdfScrollStrategy.label")}>
					<Select
						value={settings.pdfScrollStrategy}
						onValueChange={(value) =>
							patch({ pdfScrollStrategy: value as PdfScrollStrategy })
						}
					>
						<SelectTrigger size="sm" className="min-w-[180px] max-w-[240px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{PDF_SCROLL_STRATEGIES.map((strategy) => (
								<SelectItem key={strategy} value={strategy}>
									{t(`general.pdfScrollStrategy.${strategy}`)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingsRow>
				<SettingsRow label={t("general.pdfSpreadMode.label")}>
					<Select
						disabled={settings.pdfScrollStrategy === "paginated"}
						value={
							settings.pdfScrollStrategy === "paginated"
								? "none"
								: settings.pdfSpreadMode
						}
						onValueChange={(value) =>
							patch({ pdfSpreadMode: value as PdfSpreadMode })
						}
					>
						<SelectTrigger size="sm" className="min-w-[180px] max-w-[240px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{PDF_SPREAD_MODES.map((mode) => (
								<SelectItem key={mode} value={mode}>
									{t(`general.pdfSpreadMode.${mode}`)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingsRow>
			</SettingsGroup>

			<SettingsSectionLabel className="mt-4">
				{t("general.sections.plaza")}
			</SettingsSectionLabel>
			<SettingsGroup>
				<SettingsRow label={t("general.plaza.label")} htmlFor="plaza-enabled">
					<Switch
						id="plaza-enabled"
						checked={settings.plazaEnabled}
						onCheckedChange={(v) => patch({ plazaEnabled: v })}
					/>
				</SettingsRow>
			</SettingsGroup>

			<SettingsSectionLabel className="mt-4">
				{t("general.sections.system")}
			</SettingsSectionLabel>
			<SettingsGroup>
				<TerminalAppRow
					value={settings.terminalApp}
					onChange={(terminalApp) => patch({ terminalApp })}
				/>
				<FinderIntegrationRow />
			</SettingsGroup>

			<SettingsSectionLabel className="mt-4">
				{t("general.sections.network")}
			</SettingsSectionLabel>
			<SettingsGroup>
				<NetworkProxyRow
					htmlFor="network-proxy-enabled"
					label={t("general.networkProxy.label")}
					description={
						!settings.networkProxyEnabled && systemProxy
							? t("general.networkProxy.systemDetected", {
									url: systemProxy,
								})
							: undefined
					}
					proxyUrl={proxyUrlDraft}
					proxyEnabled={settings.networkProxyEnabled}
					onProxyUrlChange={setProxyUrlDraft}
					onCommitProxyUrl={() =>
						patch({
							networkProxyUrl:
								proxyUrlDraft.trim() || DEFAULT_NETWORK_PROXY_URL,
						})
					}
					onToggleProxy={(networkProxyEnabled) =>
						patch({ networkProxyEnabled })
					}
				/>
			</SettingsGroup>
			<InstitutionAccessBlock settings={settings} />
			<SettingsSectionLabel className="mt-4">
				{t("general.sections.integrations")}
			</SettingsSectionLabel>
			<ConnectorSettingsBlock settings={settings} patch={patch} />
			<EasyScholarSettingsBlock
				savedKey={settings.easyScholarKey}
				keyDraft={easyScholarKeyDraft}
				onKeyDraftChange={setEasyScholarKeyDraft}
				onCommitKey={async (value) => {
					const trimmed = value.trim();
					const next = await saveSettingsAsync({
						...settings,
						easyScholarKey: trimmed,
					});
					setEasyScholarKeyDraft(next.easyScholarKey);
				}}
			/>
			<OpenAlexSettingsBlock
				savedKey={settings.openAlexKey}
				keyDraft={openAlexKeyDraft}
				onKeyDraftChange={setOpenAlexKeyDraft}
				onCommitKey={async (value) => {
					const trimmed = value.trim();
					const next = await saveSettingsAsync({
						...settings,
						openAlexKey: trimmed,
					});
					setOpenAlexKeyDraft(next.openAlexKey);
				}}
			/>
			<KeywordLlmSettingsBlock settings={settings} patch={patch} />
			<SettingsSectionLabel>{t("general.sections.mcp")}</SettingsSectionLabel>
			<McpSettingsBlock settings={settings} patch={patch} />
			<PrivacySettingsBlock />
		</>
	);
}
