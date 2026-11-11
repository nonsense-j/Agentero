import { Plus } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { TreeRowActionButton } from "@/components/sidebar/tree-row-action-button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";

const NewProjectForm = lazy(() =>
	import("./new-project-form").then((m) => ({ default: m.NewProjectForm })),
);

export function NewProjectButton({ vaultPath }: { vaultPath: string }) {
	const { t } = useTranslation("sidebar");
	const [open, setOpen] = useState(false);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<TreeRowActionButton
				label={t("writing.newProject")}
				trigger={(button) => <PopoverTrigger asChild>{button}</PopoverTrigger>}
			>
				<Plus className="size-3.5" aria-hidden />
			</TreeRowActionButton>
			{open && (
				<PopoverContent align="start" className="w-72">
					<Suspense fallback={null}>
						<NewProjectForm
							vaultPath={vaultPath}
							startOpen
							onCreated={() => setOpen(false)}
						/>
					</Suspense>
				</PopoverContent>
			)}
		</Popover>
	);
}
