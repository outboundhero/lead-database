import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

// iOS-style buttons: pill rounding, filled/tinted/plain variants, soft press
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-full text-[15px] font-semibold whitespace-nowrap transition-all outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40 active:scale-[0.97] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // Filled iOS Blue
        default: "bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm",
        // Tinted iOS (light blue on white)
        tinted: "bg-primary/12 text-primary hover:bg-primary/18",
        // Destructive iOS Red
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/25 shadow-sm",
        // Success iOS Green
        success: "bg-[var(--success)] text-white hover:opacity-90 shadow-sm",
        // Outline = subtle hairline
        outline:
          "border border-border bg-card hover:bg-muted text-foreground",
        // Secondary = systemGray fill (iOS secondary button)
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        // Ghost = plain text button (iOS-style)
        ghost:
          "text-foreground hover:bg-muted",
        // Link = iOS link blue, no underline by default
        link: "text-primary font-medium hover:opacity-80",
      },
      size: {
        default: "h-11 px-5 py-2 has-[>svg]:px-4",
        xs: "h-7 gap-1 rounded-full px-3 text-xs has-[>svg]:px-2.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-9 gap-1.5 rounded-full px-4 text-[13px] has-[>svg]:px-3",
        lg: "h-12 rounded-full px-7 text-base has-[>svg]:px-5",
        icon: "size-11 rounded-full",
        "icon-xs": "size-7 rounded-full [&_svg:not([class*='size-'])]:size-3.5",
        "icon-sm": "size-9 rounded-full",
        "icon-lg": "size-12 rounded-full",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
