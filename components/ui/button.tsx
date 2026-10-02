import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-semibold outline-none transition duration-200 focus-visible:ring-2 focus-visible:ring-violet-400 disabled:pointer-events-none disabled:opacity-40",
  {
    variants: {
      variant: {
        default: "bg-violet-600 text-white shadow-[0_0_24px_rgba(124,58,237,.2)] hover:bg-violet-500",
        subtle: "border border-white/10 bg-white/[0.055] text-white/85 hover:border-white/20 hover:bg-white/10",
        ghost: "text-white/65 hover:bg-white/[0.07] hover:text-white",
        outline: "border border-white/15 bg-transparent text-white hover:bg-white/[0.07]",
      },
      size: {
        default: "h-10 px-4",
        sm: "h-8 rounded-lg px-3 text-xs",
        icon: "size-10 rounded-full p-0",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { buttonVariants };
