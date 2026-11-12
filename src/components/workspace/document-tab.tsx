import { X } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/core/utils";

type DocumentTabProps = Omit<ComponentProps<"div">, "title"> & {
	title: ReactNode;
	closeLabel?: string;
	/** Omit to render the tab without a close action. */
	onClose?: () => void;
	/** Extra actions shown before the close button. */
	trailing?: ReactNode;
};

/**
 * Inner tab chrome for the Dockview workspace tabs. Styling comes from
 * Dockview's `dv-default-tab*` rules.
 */
export function DocumentTab({
	title,
	closeLabel,
	onClose,
	trailing,
	className,
	...rest
}: DocumentTabProps) {
	return (
		<div {...rest} className={cn("dv-default-tab group", className)}>
			<span className="dv-default-tab-content">{title}</span>
			{trailing}
			{onClose ? (
				<button
					type="button"
					className="dv-default-tab-action"
					aria-label={closeLabel}
					onPointerDown={(event) => event.preventDefault()}
					onClick={(event) => {
						event.stopPropagation();
						onClose();
					}}
				>
					<X className="size-3.5" />
				</button>
			) : null}
		</div>
	);
}
