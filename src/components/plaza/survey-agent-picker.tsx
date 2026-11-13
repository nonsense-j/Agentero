/**
 * Agent + model pickers for Paper Survey (same interaction as Deep Search).
 */

import { Bot, Check, ChevronDown } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/core/utils";
import {
	setSurveyAgent,
	setSurveyModel,
	usePaperSurveyStore,
} from "@/lib/plaza/survey-store";

const ITEM_CLASS =
	"flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted/70";

export function SurveyAgentPicker() {
	const { t } = useTranslation("sidebar");
	const agents = usePaperSurveyStore((s) => s.agents);
	const selectedAgentId = usePaperSurveyStore((s) => s.selectedAgentId);
	const selectedModelId = usePaperSurveyStore((s) => s.selectedModelId);
	const modelsByAgent = usePaperSurveyStore((s) => s.modelsByAgent);
	const [agentOpen, setAgentOpen] = useState(false);
	const [modelOpen, setModelOpen] = useState(false);

	const currentAgent = agents.find((a) => a.id === selectedAgentId) ?? null;
	const models = selectedAgentId ? (modelsByAgent[selectedAgentId] ?? []) : [];
	const currentModel = models.find((m) => m.id === selectedModelId) ?? null;

	return (
		<div className="flex items-center gap-1.5">
			<Popover open={agentOpen} onOpenChange={setAgentOpen}>
				<PopoverTrigger asChild>
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={agents.length === 0}
						className="h-7 gap-1.5 px-2.5 text-xs"
					>
						<Bot className="size-3.5 text-muted-foreground" />
						<span className="max-w-28 truncate">
							{currentAgent?.name ?? t("plaza.discover.selectAgent")}
						</span>
						<ChevronDown className="size-3 text-muted-foreground" />
					</Button>
				</PopoverTrigger>
				<PopoverContent align="end" className="w-52 p-1.5">
					{agents.map((agent) => (
						<button
							key={agent.id}
							type="button"
							onClick={() => {
								setSurveyAgent(agent.id);
								setAgentOpen(false);
							}}
							className={cn(
								ITEM_CLASS,
								agent.id === selectedAgentId &&
									"bg-brand/10 font-medium text-brand",
							)}
						>
							<span className="truncate">{agent.name}</span>
							{agent.id === selectedAgentId ? (
								<Check className="size-3.5 shrink-0" />
							) : null}
						</button>
					))}
				</PopoverContent>
			</Popover>

			{models.length > 0 ? (
				<Popover open={modelOpen} onOpenChange={setModelOpen}>
					<PopoverTrigger asChild>
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="h-7 max-w-44 gap-1 px-2.5 text-xs"
						>
							<span className="truncate">
								{currentModel?.name ??
									selectedModelId ??
									t("plaza.discover.selectModel")}
							</span>
							<ChevronDown className="size-3 shrink-0 text-muted-foreground" />
						</Button>
					</PopoverTrigger>
					<PopoverContent align="end" className="w-60 p-1.5">
						<div className="agentero-scroll max-h-60 space-y-0.5 overflow-y-auto">
							{models.map((model) => (
								<button
									key={model.id}
									type="button"
									onClick={() => {
										setSurveyModel(model.id);
										setModelOpen(false);
									}}
									className={cn(
										ITEM_CLASS,
										model.id === selectedModelId &&
											"bg-brand/10 font-medium text-brand",
									)}
								>
									<span className="truncate">{model.name}</span>
									{model.id === selectedModelId ? (
										<Check className="size-3.5 shrink-0" />
									) : null}
								</button>
							))}
						</div>
					</PopoverContent>
				</Popover>
			) : null}
		</div>
	);
}
