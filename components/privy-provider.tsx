"use client";

/**
 * Authentication is intentionally paused while the product integration is
 * being finalized. Keep this wrapper so auth can be restored in one place.
 */
export function PrivyAppProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
