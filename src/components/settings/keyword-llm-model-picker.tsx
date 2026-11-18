import { Check, ChevronsUpDown, RefreshCw } from "lucide-react";
import { useState } from "react";
import { PROVIDER_INPUT_CLASS } from "@/components/settings/provider-card";
import { Button } from "@/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/core/utils";

type KeywordLlmModelPickerProps = {
	id?: string;
	value: string;
	placeholder: string;
	ariaLabel?: string;
	options: string[];
	refreshing: boolean;
	canRefresh: boolean;
	chooseLabel: string;
	searchPlaceholder: string;
	emptyLabel: string;
	refreshLabel: string;
	compact?: boolean;
	onChange: (value: string) => void;
	onSelectOption?: (value: string) => void;
	onBlur?: () => void;
	onSubmit?: () => void;
	onRefreshModels: () => void | Promise<void>;
};

export function KeywordLlmModelPicker({
	id,
	value,
	placeholder,
	ariaLabel,
	options,
	refreshing,
	canRefresh,
	chooseLabel,
	searchPlaceholder,
	emptyLabel,
	refreshLabel,
	compact = false,
	onChange,
	onSelectOption,
	onBlur,
	onSubmit,
	onRefreshModels,
}: KeywordLlmModelPickerProps) {
	const [open, setOpen] = useState(false);

	const handleOpenChange = (nextOpen: boolean) => {
		setOpen(nextOpen);
		if (nextOpen && options.length <= 1 && canRefresh && !refreshing) {
			void onRefreshModels();
		}
	};

	const activeValue = value.trim();

	return (
		<div className="flex min-w-0 flex-1 items-center gap-1.5">
			<Input
				id={id}
				autoComplete="off"
				placeholder={placeholder}
				aria-label={ariaLabel}
				className={
					compact
						? "h-8 min-w-0 flex-1 font-mono text-xs"
						: PROVIDER_INPUT_CLASS
				}
				value={value}
				onChange={(e) => onChange(e.currentTarget.value)}
				onBlur={onBlur}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						onSubmit?.();
					}
				}}
			/>
			<Popover modal open={open} onOpenChange={handleOpenChange}>
				<PopoverTrigger asChild>
					<Button
						type="button"
						variant="outline"
						size="icon-xs"
						className="size-8 shrink-0"
						aria-label={chooseLabel}
						title={chooseLabel}
					>
						<ChevronsUpDown className="size-3.5 opacity-60" />
					</Button>
				</PopoverTrigger>
				<PopoverContent className="w-72 p-0" align="end">
					<Command>
						<CommandInput placeholder={searchPlaceholder} className="text-xs" />
						<CommandList className="max-h-60">
							<CommandEmpty>{emptyLabel}</CommandEmpty>
							<CommandGroup>
								{options.map((modelId) => {
									const selected = activeValue === modelId;
									return (
										<CommandItem
											key={modelId}
											value={modelId}
											className="font-mono text-xs"
											onSelect={() => {
												if (onSelectOption) {
													onSelectOption(modelId);
												} else {
													onChange(modelId);
												}
												setOpen(false);
											}}
										>
											<span className="truncate">{modelId}</span>
											<Check
												className={cn(
													"ml-auto size-3.5 shrink-0",
													selected ? "opacity-100" : "opacity-0",
												)}
											/>
										</CommandItem>
									);
								})}
							</CommandGroup>
						</CommandList>
					</Command>
				</PopoverContent>
			</Popover>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						type="button"
						variant={compact ? "ghost" : "outline"}
						size="icon-xs"
						className="size-8 shrink-0"
						disabled={refreshing || !canRefresh}
						aria-label={refreshLabel}
						onClick={() => void onRefreshModels()}
					>
						<RefreshCw
							className={cn("size-3.5", refreshing && "animate-spin")}
						/>
					</Button>
				</TooltipTrigger>
				<TooltipContent>{refreshLabel}</TooltipContent>
			</Tooltip>
		</div>
	);
}
