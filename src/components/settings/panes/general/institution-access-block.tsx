import { ChevronDown, KeyRound } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ProbeDot } from "@/components/settings/provider-card";
import {
	SettingsGroup,
	SettingsRow,
} from "@/components/settings/settings-layout";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@/components/ui/input-group";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import {
	commands,
	type InstitutionAccessDetectResult,
} from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { callApi, callResult } from "@/lib/core/ipc";
import { notifyError } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import {
	type AppSettings,
	ensureSettingsLoaded,
	loadSettings,
	saveSettingsAsync,
} from "@/lib/settings";
import {
	INSTITUTION_PROXY_PRESETS,
	type InstitutionProxyKind,
	type InstitutionProxyPreset,
} from "@/lib/settings/defaults";
import type { ProbeStatus } from "@/lib/ui/probe-status";

const CARSI_HOSTS = [
	"dl.acm.org",
	"ieeexplore.ieee.org",
	"link.springer.com",
	"www.sciencedirect.com",
	"www.nature.com",
	"onlinelibrary.wiley.com",
	"carsi.edu.cn",
];

function isCarsiPublisherUrl(raw: string): boolean {
	const lower = raw.trim().toLowerCase();
	if (!lower) return false;
	return CARSI_HOSTS.some((host) => lower.includes(host));
}

function deriveEffectiveMode(settings: AppSettings): InstitutionProxyKind {
	const rawType = settings.institutionProxyType.trim().toLowerCase();
	if (rawType === "direct" || rawType === "none") return "direct";
	if (rawType === "carsi") return "carsi";
	if (rawType === "wengine") return "wengine";
	if (
		!settings.institutionProxyPrefix.trim() &&
		!settings.institutionProxyCookie.trim()
	) {
		return "direct";
	}
	return "ezproxy";
}

function parseSavedCarsiHosts(cookieRaw: string): Set<string> {
	const trimmed = cookieRaw.trim();
	if (!trimmed.startsWith("{")) return new Set();
	try {
		const parsed = JSON.parse(trimmed) as Record<string, unknown>;
		const hosts = new Set<string>();
		for (const [host, val] of Object.entries(parsed)) {
			if (typeof val === "string" && val.trim().length > 0) {
				hosts.add(host.toLowerCase());
			}
		}
		return hosts;
	} catch {
		return new Set();
	}
}

export function InstitutionAccessBlock({
	settings,
}: {
	settings: AppSettings;
}) {
	const { t } = useTranslation("settings");
	const [mode, setMode] = useState<InstitutionProxyKind>(() =>
		deriveEffectiveMode(settings),
	);
	const [prefixDraft, setPrefixDraft] = useState(
		settings.institutionProxyPrefix,
	);
	const [cookieDraft, setCookieDraft] = useState(
		settings.institutionProxyCookie,
	);
	const cookieDirtyRef = useRef(false);
	const [showManualCookie, setShowManualCookie] = useState(false);

	const [detecting, setDetecting] = useState(false);
	const [detectResult, setDetectResult] =
		useState<InstitutionAccessDetectResult | null>(null);

	const [gatewayTesting, setGatewayTesting] = useState(false);
	const [gatewayProbeResult, setGatewayProbeResult] = useState<
		{ status: "ok" | "fail"; message: string } | undefined
	>(undefined);

	const [carsiTestingId, setCarsiTestingId] = useState<string | null>(null);
	const [carsiLoggingInId, setCarsiLoggingInId] = useState<string | null>(null);
	const [carsiResults, setCarsiResults] = useState<
		Record<string, { status: "ok" | "fail"; message: string } | undefined>
	>({});

	useEffect(() => {
		setPrefixDraft(settings.institutionProxyPrefix);
		setCookieDraft(settings.institutionProxyCookie);
	}, [settings.institutionProxyPrefix, settings.institutionProxyCookie]);

	useEffect(() => {
		const rawType = settings.institutionProxyType.trim().toLowerCase();
		if (
			rawType === "direct" ||
			rawType === "carsi" ||
			rawType === "wengine" ||
			(rawType === "ezproxy" && settings.institutionProxyPrefix.trim() !== "")
		) {
			setMode(rawType as InstitutionProxyKind);
		}
	}, [settings.institutionProxyType, settings.institutionProxyPrefix]);

	const carsiPresets = useMemo(
		() =>
			INSTITUTION_PROXY_PRESETS.filter((p) => p.kind === "carsi").map((p) => ({
				...p,
				label: t(`general.institutionProxy.presets.${p.id}`),
			})),
		[t],
	);

	const wenginePresets = useMemo(
		() =>
			INSTITUTION_PROXY_PRESETS.filter((p) => p.kind === "wengine").map(
				(p) => ({
					...p,
					label: t(`general.institutionProxy.presets.${p.id}`),
				}),
			),
		[t],
	);

	const savedCarsiHosts = useMemo(
		() => parseSavedCarsiHosts(settings.institutionProxyCookie),
		[settings.institutionProxyCookie],
	);

	const flushSettingsAsync = useCallback(
		async (overrides?: Partial<AppSettings>) => {
			const latest = loadSettings();
			const nextPrefix = (
				overrides?.institutionProxyPrefix ?? prefixDraft
			).trim();
			const nextCookie = cookieDirtyRef.current
				? cookieDraft.trim()
				: (overrides?.institutionProxyCookie ?? latest.institutionProxyCookie);
			cookieDirtyRef.current = false;
			await saveSettingsAsync({
				...latest,
				institutionProxyPrefix: nextPrefix,
				institutionProxyCookie: nextCookie,
				institutionProxyType: overrides?.institutionProxyType ?? mode,
			});
		},
		[cookieDraft, mode, prefixDraft],
	);

	const handleModeChange = useCallback(
		(nextValue: string) => {
			const nextMode = nextValue as InstitutionProxyKind;
			setMode(nextMode);
			setGatewayProbeResult(undefined);
			setShowManualCookie(false);

			let nextPrefix = prefixDraft.trim();
			if (nextMode === "carsi") {
				if (!isCarsiPublisherUrl(nextPrefix)) {
					nextPrefix =
						carsiPresets[0]?.prefix ?? "https://dl.acm.org/action/ssostart";
					setPrefixDraft(nextPrefix);
				}
			} else if (nextMode === "wengine") {
				if (
					isCarsiPublisherUrl(nextPrefix) ||
					nextPrefix.includes("login?url=")
				) {
					nextPrefix = "";
					setPrefixDraft("");
				}
			} else if (nextMode === "ezproxy") {
				if (isCarsiPublisherUrl(nextPrefix)) {
					nextPrefix = "";
					setPrefixDraft("");
				}
			}

			void flushSettingsAsync({
				institutionProxyType: nextMode,
				institutionProxyPrefix: nextPrefix,
			});
		},
		[carsiPresets, flushSettingsAsync, prefixDraft],
	);

	const runDirectDetect = useCallback(async () => {
		if (!isTauri() || detecting) return;
		setDetecting(true);
		try {
			const res = await callApi(() => commands.institutionAccessDetect());
			setDetectResult(res);
		} catch (err) {
			notifyError(errorText(err));
		} finally {
			setDetecting(false);
		}
	}, [detecting]);

	const probeGateway = useCallback(
		async (skipFlush = false) => {
			setGatewayTesting(true);
			setGatewayProbeResult(undefined);
			try {
				if (!skipFlush) {
					await flushSettingsAsync();
				}
				const result = await commands.institutionProxyProbe(
					prefixDraft.trim() || null,
				);
				setGatewayProbeResult(
					result.ok
						? { status: "ok", message: result.data ?? "" }
						: { status: "fail", message: result.error?.message ?? "failed" },
				);
				if (result.error?.code === "institution_proxy_auth_required") {
					notifyError(t("general.institutionProxy.cookieExpired"));
				}
			} catch (error) {
				setGatewayProbeResult({
					status: "fail",
					message: error instanceof Error ? error.message : "failed",
				});
			} finally {
				setGatewayTesting(false);
			}
		},
		[flushSettingsAsync, prefixDraft, t],
	);

	const openGatewayLogin = useCallback(async () => {
		const trimmedPrefix = prefixDraft.trim();
		if (!trimmedPrefix) return;
		try {
			await flushSettingsAsync({
				institutionProxyType: mode,
				institutionProxyPrefix: trimmedPrefix,
			});
			const captured = await callResult(() =>
				commands.institutionProxyLoginOpen(trimmedPrefix),
			);
			await ensureSettingsLoaded();
			if (captured) void probeGateway(true);
		} catch (error) {
			notifyError(t("general.institutionProxy.loginFailed"), {
				description: errorText(error),
			});
		}
	}, [flushSettingsAsync, mode, prefixDraft, probeGateway, t]);

	const probeCarsiPublisher = useCallback(
		async (preset: InstitutionProxyPreset) => {
			setCarsiTestingId(preset.id);
			try {
				const result = await commands.institutionProxyProbe(preset.prefix);
				setCarsiResults((prev) => ({
					...prev,
					[preset.id]: result.ok
						? { status: "ok", message: result.data ?? "" }
						: { status: "fail", message: result.error?.message ?? "failed" },
				}));
				if (result.error?.code === "institution_proxy_auth_required") {
					notifyError(t("general.institutionProxy.cookieExpired"));
				}
			} catch (error) {
				setCarsiResults((prev) => ({
					...prev,
					[preset.id]: {
						status: "fail",
						message: error instanceof Error ? error.message : "failed",
					},
				}));
			} finally {
				setCarsiTestingId(null);
			}
		},
		[t],
	);

	const openCarsiPublisherLogin = useCallback(
		async (preset: InstitutionProxyPreset) => {
			setCarsiLoggingInId(preset.id);
			try {
				setPrefixDraft(preset.prefix);
				await flushSettingsAsync({
					institutionProxyType: "carsi",
					institutionProxyPrefix: preset.prefix,
				});
				const captured = await callResult(() =>
					commands.institutionProxyLoginOpen(preset.prefix),
				);
				await ensureSettingsLoaded();
				if (captured) {
					await probeCarsiPublisher(preset);
				}
			} catch (error) {
				notifyError(t("general.institutionProxy.loginFailed"), {
					description: errorText(error),
				});
			} finally {
				setCarsiLoggingInId(null);
			}
		},
		[flushSettingsAsync, probeCarsiPublisher, t],
	);

	const ieeeStatus: ProbeStatus = detecting
		? "probing"
		: detectResult
			? detectResult.ieee.directOk
				? "ok"
				: "fail"
			: "idle";
	const acmStatus: ProbeStatus = detecting
		? "probing"
		: detectResult
			? detectResult.acm.directOk
				? "ok"
				: "fail"
			: "idle";

	const detectSummary = useMemo(() => {
		if (!detectResult) return undefined;
		if (detectResult.ieee.directOk && detectResult.acm.directOk) {
			return t("general.institutionProxy.detectOkBoth");
		}
		if (detectResult.ieee.directOk && !detectResult.acm.directOk) {
			return t("general.institutionProxy.detectNeedAcm");
		}
		if (!detectResult.ieee.directOk && detectResult.acm.directOk) {
			return t("general.institutionProxy.detectNeedIeee");
		}
		return t("general.institutionProxy.detectNeedBoth");
	}, [detectResult, t]);

	const gatewayProbeStatus: ProbeStatus = gatewayTesting
		? "probing"
		: (gatewayProbeResult?.status ?? "idle");
	const gatewayProbeLabel = t(
		gatewayProbeStatus === "probing"
			? "general.institutionProxy.probeProbing"
			: gatewayProbeStatus === "ok"
				? "general.institutionProxy.probeOk"
				: gatewayProbeStatus === "fail"
					? "general.institutionProxy.probeFail"
					: "general.institutionProxy.probeIdle",
	);

	const renderProbeBadge = (
		name: string,
		status: ProbeStatus,
		detail?: string,
	) => {
		const statusText = t(
			status === "probing"
				? "general.institutionProxy.probeProbing"
				: status === "ok"
					? "general.institutionProxy.probeOk"
					: status === "fail"
						? "general.institutionProxy.probeFail"
						: "general.institutionProxy.probeIdle",
		);
		return (
			<Tooltip>
				<TooltipTrigger asChild>
					<span className="inline-flex h-6 items-center gap-1.5 rounded-md border border-border/60 bg-muted/30 px-2 font-medium text-[11px] text-foreground/90">
						<ProbeDot
							status={status}
							configured={status !== "idle"}
							label={`${name}: ${statusText}`}
						/>
						{name}
					</span>
				</TooltipTrigger>
				<TooltipContent>
					{detail
						? `${name} · ${statusText} (${detail})`
						: `${name} · ${statusText}`}
				</TooltipContent>
			</Tooltip>
		);
	};

	return (
		<SettingsGroup>
			<SettingsRow
				label={t("general.institutionProxy.detectLabel")}
				description={detectSummary}
			>
				<div className="flex items-center gap-1.5">
					{renderProbeBadge("IEEE", ieeeStatus, detectResult?.ieee.detail)}
					{renderProbeBadge("ACM", acmStatus, detectResult?.acm.detail)}
					<Button
						type="button"
						variant="outline"
						size="xs"
						disabled={!isTauri() || detecting}
						onClick={() => void runDirectDetect()}
					>
						{detecting
							? t("general.institutionProxy.detecting")
							: t("general.institutionProxy.detectAction")}
					</Button>
				</div>
			</SettingsRow>

			<SettingsRow
				label={t("general.institutionProxy.typeLabel")}
				htmlFor="institution-proxy-type"
			>
				<Select
					value={mode}
					onValueChange={handleModeChange}
					disabled={!isTauri()}
				>
					<SelectTrigger
						id="institution-proxy-type"
						size="sm"
						className="h-8 w-52 text-xs"
						disabled={!isTauri()}
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="direct" className="text-xs">
							{t("general.institutionProxy.typeDirect")}
						</SelectItem>
						<SelectItem value="carsi" className="text-xs">
							{t("general.institutionProxy.typeCarsi")}
						</SelectItem>
						<SelectItem value="wengine" className="text-xs">
							{t("general.institutionProxy.typeWengine")}
						</SelectItem>
						<SelectItem value="ezproxy" className="text-xs">
							{t("general.institutionProxy.typeEzproxy")}
						</SelectItem>
					</SelectContent>
				</Select>
			</SettingsRow>

			{mode === "carsi"
				? carsiPresets.map((preset) => {
						const entryResult = carsiResults[preset.id];
						const isProbing = carsiTestingId === preset.id;
						const isLoggingIn = carsiLoggingInId === preset.id;
						const status: ProbeStatus = isProbing
							? "probing"
							: (entryResult?.status ?? "idle");
						const hasSavedCookie = preset.host
							? savedCarsiHosts.has(preset.host)
							: false;
						const statusLabel = t(
							status === "probing"
								? "general.institutionProxy.probeProbing"
								: status === "ok"
									? "general.institutionProxy.probeOk"
									: status === "fail"
										? "general.institutionProxy.probeFail"
										: "general.institutionProxy.probeIdle",
						);
						return (
							<SettingsRow
								key={preset.id}
								label={
									<span className="inline-flex items-center gap-1.5">
										{preset.label}
										<Tooltip>
											<TooltipTrigger asChild>
												<ProbeDot
													status={status}
													configured={hasSavedCookie || status !== "idle"}
													label={statusLabel}
												/>
											</TooltipTrigger>
											<TooltipContent>
												{entryResult?.message
													? `${statusLabel} · ${entryResult.message}`
													: statusLabel}
											</TooltipContent>
										</Tooltip>
									</span>
								}
							>
								<div className="flex items-center gap-1.5">
									<Button
										type="button"
										variant="outline"
										size="xs"
										disabled={!isTauri() || isLoggingIn || isProbing}
										onClick={() => void openCarsiPublisherLogin(preset)}
									>
										{t("general.institutionProxy.login")}
									</Button>
									<Button
										type="button"
										variant="outline"
										size="xs"
										disabled={!isTauri() || isProbing || isLoggingIn}
										onClick={() => void probeCarsiPublisher(preset)}
									>
										{isProbing
											? t("general.institutionProxy.testing")
											: t("general.institutionProxy.test")}
									</Button>
								</div>
							</SettingsRow>
						);
					})
				: null}

			{mode === "wengine" ? (
				<SettingsRow
					htmlFor="institution-proxy-prefix"
					label={
						<span className="inline-flex items-center gap-1.5">
							{t("general.institutionProxy.wengineUrlLabel")}
							<Tooltip>
								<TooltipTrigger asChild>
									<ProbeDot
										status={gatewayProbeStatus}
										configured={Boolean(prefixDraft.trim())}
										label={gatewayProbeLabel}
									/>
								</TooltipTrigger>
								<TooltipContent>
									{gatewayProbeResult?.message
										? `${gatewayProbeLabel} · ${gatewayProbeResult.message}`
										: gatewayProbeLabel}
								</TooltipContent>
							</Tooltip>
						</span>
					}
				>
					<div className="flex items-center gap-1.5">
						<InputGroup className="h-8 w-56 max-w-[16rem]">
							<InputGroupInput
								id="institution-proxy-prefix"
								value={prefixDraft}
								onChange={(e) => setPrefixDraft(e.target.value)}
								onBlur={() => void flushSettingsAsync()}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										e.currentTarget.blur();
									}
								}}
								placeholder="https://webvpn.example.edu.cn"
								spellCheck={false}
								autoComplete="off"
								disabled={!isTauri()}
								className="font-mono text-xs"
							/>
							<InputGroupAddon align="inline-end">
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<InputGroupButton
											size="icon-xs"
											disabled={!isTauri()}
											title={t("general.institutionProxy.presetsLabel")}
											aria-label={t("general.institutionProxy.presetsLabel")}
										>
											<ChevronDown />
										</InputGroupButton>
									</DropdownMenuTrigger>
									<DropdownMenuContent
										align="end"
										className="max-h-72 w-64 overflow-y-auto"
									>
										<DropdownMenuLabel className="text-xs text-muted-foreground">
											{t("general.institutionProxy.presetsLabel")}
										</DropdownMenuLabel>
										{wenginePresets.map((preset) => (
											<DropdownMenuItem
												key={preset.id}
												className="flex flex-col items-start gap-0.5"
												onSelect={() => {
													setPrefixDraft(preset.prefix);
													void flushSettingsAsync({
														institutionProxyType: "wengine",
														institutionProxyPrefix: preset.prefix,
													});
												}}
											>
												<span className="text-xs">{preset.label}</span>
												<span className="font-mono text-[10px] text-muted-foreground">
													{preset.prefix}
												</span>
											</DropdownMenuItem>
										))}
									</DropdownMenuContent>
								</DropdownMenu>
							</InputGroupAddon>
						</InputGroup>
						<Button
							type="button"
							variant="outline"
							size="xs"
							disabled={!isTauri() || !prefixDraft.trim()}
							onClick={() => void openGatewayLogin()}
						>
							{t("general.institutionProxy.login")}
						</Button>
						<Button
							type="button"
							variant="outline"
							size="xs"
							disabled={!isTauri() || gatewayTesting || !prefixDraft.trim()}
							onClick={() => void probeGateway()}
						>
							{gatewayTesting
								? t("general.institutionProxy.testing")
								: t("general.institutionProxy.test")}
						</Button>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant={showManualCookie ? "secondary" : "ghost"}
									size="icon-xs"
									disabled={!isTauri()}
									aria-label={t("general.institutionProxy.cookieLabel")}
									onClick={() => setShowManualCookie((v) => !v)}
								>
									<KeyRound className="size-3.5" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								{t("general.institutionProxy.cookieLabel")}
							</TooltipContent>
						</Tooltip>
					</div>
				</SettingsRow>
			) : null}

			{mode === "ezproxy" ? (
				<SettingsRow
					htmlFor="institution-proxy-prefix"
					label={
						<span className="inline-flex items-center gap-1.5">
							{t("general.institutionProxy.ezproxyUrlLabel")}
							<Tooltip>
								<TooltipTrigger asChild>
									<ProbeDot
										status={gatewayProbeStatus}
										configured={Boolean(prefixDraft.trim())}
										label={gatewayProbeLabel}
									/>
								</TooltipTrigger>
								<TooltipContent>
									{gatewayProbeResult?.message
										? `${gatewayProbeLabel} · ${gatewayProbeResult.message}`
										: gatewayProbeLabel}
								</TooltipContent>
							</Tooltip>
						</span>
					}
				>
					<div className="flex items-center gap-1.5">
						<Input
							id="institution-proxy-prefix"
							value={prefixDraft}
							onChange={(e) => setPrefixDraft(e.target.value)}
							onBlur={() => void flushSettingsAsync()}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.currentTarget.blur();
								}
							}}
							placeholder="https://ezproxy.example.edu/login?url="
							spellCheck={false}
							autoComplete="off"
							disabled={!isTauri()}
							className="h-8 w-56 max-w-[16rem] font-mono text-xs"
						/>
						<Button
							type="button"
							variant="outline"
							size="xs"
							disabled={!isTauri() || !prefixDraft.trim()}
							onClick={() => void openGatewayLogin()}
						>
							{t("general.institutionProxy.login")}
						</Button>
						<Button
							type="button"
							variant="outline"
							size="xs"
							disabled={!isTauri() || gatewayTesting || !prefixDraft.trim()}
							onClick={() => void probeGateway()}
						>
							{gatewayTesting
								? t("general.institutionProxy.testing")
								: t("general.institutionProxy.test")}
						</Button>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant={showManualCookie ? "secondary" : "ghost"}
									size="icon-xs"
									disabled={!isTauri()}
									aria-label={t("general.institutionProxy.cookieLabel")}
									onClick={() => setShowManualCookie((v) => !v)}
								>
									<KeyRound className="size-3.5" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								{t("general.institutionProxy.cookieLabel")}
							</TooltipContent>
						</Tooltip>
					</div>
				</SettingsRow>
			) : null}

			{(mode === "wengine" || mode === "ezproxy") && showManualCookie ? (
				<SettingsRow
					label={t("general.institutionProxy.cookieLabel")}
					htmlFor="institution-proxy-cookie"
				>
					<Input
						id="institution-proxy-cookie"
						value={cookieDraft}
						onChange={(e) => {
							cookieDirtyRef.current = true;
							setCookieDraft(e.target.value);
						}}
						onBlur={() => void flushSettingsAsync()}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.currentTarget.blur();
							}
						}}
						placeholder={t("general.institutionProxy.cookiePlaceholder")}
						spellCheck={false}
						autoComplete="off"
						type="password"
						disabled={!isTauri()}
						className="h-8 w-64 max-w-[18rem] font-mono text-xs"
					/>
				</SettingsRow>
			) : null}
		</SettingsGroup>
	);
}
