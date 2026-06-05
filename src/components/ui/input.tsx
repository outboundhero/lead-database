import * as React from "react"

import { cn } from "@/lib/utils"

// iOS-style input: taller, generous radius, subtle filled bg (not bordered)
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-11 w-full min-w-0 rounded-xl border border-transparent bg-muted px-4 py-2 text-[15px] transition-[color,background-color,box-shadow,border-color] outline-none selection:bg-primary/20 selection:text-foreground file:inline-flex file:h-8 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "focus-visible:bg-card focus-visible:border-primary/50 focus-visible:ring-[3px] focus-visible:ring-ring/40",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }
