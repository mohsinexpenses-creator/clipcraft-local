"use client"

import * as React from "react"
import { Slider as SliderPrimitive } from "@base-ui/react/slider"
import { cn } from "cn"

function Slider({
  className,
  value,
  defaultValue,
  min = 0,
  max = 100,
  step = 1,
  onValueChange,
  ...props
}: Omit<SliderPrimitive.Root.Props, "value" | "defaultValue" | "onValueChange"> & {
  value?: number
  defaultValue?: number
  onValueChange?: (value: number) => void
}) {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      value={value}
      defaultValue={defaultValue}
      min={min}
      max={max}
      step={step}
      onValueChange={
        onValueChange
          ? (v: number | number[]) =>
              onValueChange(Array.isArray(v) ? v[0] : v)
          : undefined
      }
      className={cn(
        "relative flex w-full touch-none items-center select-none data-disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SliderPrimitive.Control className="flex w-full items-center py-1">
        <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-muted">
          <SliderPrimitive.Indicator className="absolute bg-primary" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb
          className="block size-4 shrink-0 rounded-full border border-primary/50 bg-background shadow-sm transition-[box-shadow] outline-none focus-visible:ring-2 focus-visible:ring-ring/40 data-dragging:ring-2 data-dragging:ring-ring/30"
          aria-label="Value"
        />
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  )
}

export { Slider }
