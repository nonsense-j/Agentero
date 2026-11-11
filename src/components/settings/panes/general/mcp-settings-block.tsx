import { Copy } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	SettingsGroup,
	SettingsRow,
} from "@/components/settings/settings-layout";
import { StatusDot } from "@/components/settings/status-dot";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useTauriEvent } from "@/hooks/use-tauri-event";
import { events } from "@/lib/core/bindings";
import { copyTextToClipboard } from "@/lib/core/clipboard";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import {
	type McpStatus,
	mcpGetStatus,
	mcpSetEnabled,
	mcpSetPort,
} from "@/lib/mcp/status";
import type { AppSettings } from "@/lib/settings";

export function McpSettingsBlock({
	settings,
	patch,
	disabled = false,
}: {
	settings: AppSettings;
	patch: (p: Partial<AppSettings>) => void;
	disabled?: boolean;
}) {
	const { t } = useTranslation(["settings", "common"]);
	const [status, setStatus] = useState<McpStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const [copied, setCopied] = useState(false);

	const refresh = useCallback(async () => {
		if (!isTauri()) return;
		try {
			setStatus(await mcpGetStatus());
		} catch {
			// ignore probe failures in settings
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	useTauriEvent(events.mcpStatus, (payload) => {
		setStatus(payload);
	});

	const onToggle = async (enabled: boolean) => {
		patch({ mcpEnabled: enabled });
		if (!isTauri()) return;
		setBusy(true);
		try {
			const next = await mcpSetEnabled(enabled);
			setStatus(next);
			if (enabled && next.lastError) {
				notifyError(next.lastError);
			}
		} catch (e) {
			notifyError(errorText(e));
			patch({ mcpEnabled: false });
		} finally {
			setBusy(false);
		}
	};

	const onPortBlur = async (value: string) => {
		const port = Number.parseInt(value, 10);
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			notifyError(t("general.mcp.invalidPort"));
			return;
		}
		patch({ mcpPort: port });
		if (!isTauri()) return;
		try {
			setStatus(await mcpSetPort(port));
		} catch (e) {
			notifyError(errorText(e));
		}
	};

	const url = status?.url ?? null;

	return (
		<SettingsGroup>
			<SettingsRow label={t("general.mcp.label")} htmlFor="mcp-enabled">
				<Switch
					id="mcp-enabled"
					checked={settings.mcpEnabled}
					disabled={busy || disabled}
					onCheckedChange={(v) => void onToggle(v)}
				/>
			</SettingsRow>
			<SettingsRow
				label={t("general.mcp.exposeText.label")}
				htmlFor="mcp-expose-paper-text"
			>
				<Switch
					id="mcp-expose-paper-text"
					checked={settings.mcpExposePaperText}
					disabled={disabled}
					onCheckedChange={(mcpExposePaperText) =>
						patch({ mcpExposePaperText })
					}
				/>
			</SettingsRow>
			<SettingsRow
				label={
					<>
						{t("general.mcp.portLabel")}
						{status?.listening ? (
							<span className="ml-1.5">
								<StatusDot tone="ok" label={t("common:listening")} />
							</span>
						) : null}
					</>
				}
				htmlFor="mcp-port"
			>
				<div className="flex items-center gap-2">
					<Input
						id="mcp-port"
						type="number"
						min={1}
						max={65535}
						className="h-8 w-28"
						defaultValue={settings.mcpPort}
						onBlur={(e) => void onPortBlur(e.currentTarget.value)}
						disabled={busy || disabled}
					/>
					{url ? (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="size-8"
									aria-label={t("general.mcp.copyUrl")}
									onClick={() => {
										void copyTextToClipboard(url).then((ok) => {
											if (!ok) return;
											setCopied(true);
											window.setTimeout(() => setCopied(false), 1500);
										});
									}}
								>
									<Copy className="size-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								{copied ? t("general.mcp.copied") : t("general.mcp.copyUrl")}
							</TooltipContent>
						</Tooltip>
					) : null}
				</div>
			</SettingsRow>
		</SettingsGroup>
	);
}
