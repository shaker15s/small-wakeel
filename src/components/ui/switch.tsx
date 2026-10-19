"use client"

import * as React from "react"
import * as SwitchPrimitive from "@radix-ui/react-switch"

import { cn } from "@/lib/utils"

function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer h-[1.3rem] w-[2.35rem] shrink-0 items-center rounded-full border border-border/60 bg-input shadow-[inset_0_1px_3px_rgb(0_0_0/0.12)] transition-all duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)] outline-none focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-transparent data-[state=checked]:[background:linear-gradient(135deg,var(--primary),color-mix(in_oklab,var(--primary)_60%,var(--wakil-amber)))] data-[state=unchecked]:bg-muted dark:data-[state=unchecked]:bg-muted/70",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "bg-background dark:data-[state=unchecked]:bg-foreground dark:data-[state=checked]:bg-primary-foreground pointer-events-none block size-4 rounded-full shadow-sm ring-0 transition-transform duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)] data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0 dir-rtl:data-[state=checked]:-translate-x-[calc(100%-2px)] dir-rtl:data-[state=unchecked]:translate-x-0"
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
