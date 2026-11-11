import { FolderOpen, FolderPlus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SiZotero } from "react-icons/si";
import { Button } from "@/components/ui/button";
import { displayPath } from "@/lib/core/path";
import { cn } from "@/lib/core/utils";
import { vaultDisplayName } from "@/lib/vault";

function RecentRow({
	title,
	subtitle,
	disabled,
	onOpen,
	onRemove,
	removeAria,
}: {
	title: string;
	subtitle: string;
	disabled?: boolean;
	onOpen: () => void;
	onRemove: () => void;
	removeAria: string;
}) {
	return (
		<li className="group flex items-stretch">
			<button
				type="button"
				disabled={disabled}
				onClick={onOpen}
				className="flex min-w-0 flex-1 flex-col items-start gap-0.5 px-3 py-2.5 text-left transition-colors hover:bg-muted/60 disabled:opacity-50"
			>
				<span className="flex w-full items-center gap-1.5 truncate font-medium text-sm">
					<span className="truncate">{title}</span>
				</span>
				<span
					className="w-full truncate text-caption text-muted-foreground"
					title={subtitle}
				>
					{subtitle}
				</span>
			</button>
			<button
				type="button"
				disabled={disabled}
				aria-label={removeAria}
				title={removeAria}
				onClick={(e) => {
					e.stopPropagation();
					onRemove();
				}}
				className="flex shrink-0 items-center px-2.5 text-muted-foreground opacity-0 transition-opacity hover:bg-muted/60 hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100 disabled:opacity-50"
			>
				<Trash2 className="size-3.5" />
			</button>
		</li>
	);
}

export function VaultWelcome({
	recentVaults,
	busy,
	onOpenVault,
	onCreateVault,
	onMigrateZotero,
	onOpenRecent,
	onRemoveRecent,
	className,
}: {
	recentVaults: string[];
	busy?: boolean;
	onOpenVault: () => void;
	onCreateVault: () => void;
	onMigrateZotero: () => void;
	onOpenRecent: (path: string) => void;
	onRemoveRecent: (path: string) => void;
	className?: string;
}) {
	const { t } = useTranslation(["app", "sidebar"]);

	return (
		<div
			className={cn(
				"agentero-scroll flex min-h-0 flex-1 select-none flex-col items-center justify-center bg-muted/20 p-8",
				className,
			)}
		>
			<div className="flex w-full max-w-lg flex-col gap-6">
				<div className="mx-auto flex size-12 items-center justify-center rounded-xl border bg-background shadow-raised">
					<FolderOpen className="size-6 text-muted-foreground" />
				</div>

				<div className="flex flex-wrap items-center justify-center gap-2">
					<Button
						type="button"
						variant="default"
						size="sm"
						disabled={busy}
						onClick={onCreateVault}
					>
						<FolderPlus className="size-3.5" />
						{t("app:vault.createVaultButton")}
					</Button>
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={busy}
						onClick={onOpenVault}
					>
						<FolderOpen className="size-3.5" />
						{t("app:vault.openVaultButton")}
					</Button>
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={busy}
						onClick={onMigrateZotero}
					>
						<SiZotero className="size-3.5 text-[#CC2936]" />
						{t("sidebar:zoteroMigrate.button")}
					</Button>
				</div>

				{recentVaults.length > 0 ? (
					<div className="overflow-hidden rounded-lg border bg-background shadow-raised">
						<div className="border-b px-3 py-2">
							<p className="font-medium text-muted-foreground text-xs">
								{t("vault.recentTitle")}
							</p>
						</div>
						<ul className="max-h-56 divide-y overflow-y-auto">
							{recentVaults.map((path) => {
								const name = vaultDisplayName(path);
								return (
									<RecentRow
										key={path}
										disabled={busy}
										title={name}
										subtitle={displayPath(path)}
										onOpen={() => onOpenRecent(path)}
										onRemove={() => onRemoveRecent(path)}
										removeAria={t("vault.removeRecent", { name })}
									/>
								);
							})}
						</ul>
					</div>
				) : (
					<p className="text-center text-muted-foreground text-sm">
						{t("vault.recentEmpty")}
					</p>
				)}
			</div>
		</div>
	);
}
