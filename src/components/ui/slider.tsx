"use client";

import { Slider as SliderPrimitive } from "radix-ui";
import * as React from "react";

import { cn } from "@/lib/core/utils";

function Slider({
	className,
	defaultValue,
	value,
	min = 0,
	max = 100,
	...props
}: React.ComponentProps<typeof SliderPrimitive.Root>) {
	const thumbKeys = React.useMemo(() => {
		const values = Array.isArray(value)
			? value
			: Array.isArray(defaultValue)
				? defaultValue
				: [min, max];
		return Array.from({ length: values.length }, (_, i) => `thumb-${i}`);
	}, [value, defaultValue, min, max]);

	return (
		<SliderPrimitive.Root
			data-slot="slider"
			defaultValue={defaultValue}
			value={value}
			min={min}
			max={max}
			className={cn(
				"relative flex w-full touch-none select-none items-center data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-44 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col data-[disabled]:opacity-50",
				className,
			)}
			{...props}
		>
			<SliderPrimitive.Track
				data-slot="slider-track"
				className="relative grow overflow-hidden rounded-full bg-muted data-[orientation=horizontal]:h-1.5 data-[orientation=vertical]:h-full data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-1.5"
			>
				<SliderPrimitive.Range
					data-slot="slider-range"
					className="absolute bg-primary data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full"
				/>
			</SliderPrimitive.Track>
			{thumbKeys.map((thumbKey) => (
				<SliderPrimitive.Thumb
					data-slot="slider-thumb"
					key={thumbKey}
					className="relative block size-4 shrink-0 rounded-full border border-primary/50 bg-background shadow-sm ring-ring/50 transition-[color,box-shadow] after:absolute after:-inset-2 hover:ring-3 focus-visible:outline-hidden focus-visible:ring-3 disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none"
				/>
			))}
		</SliderPrimitive.Root>
	);
}

export { Slider };
