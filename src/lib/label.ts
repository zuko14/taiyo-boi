/** Label template settings (event.settings.label). Defaults until the real label stock is known. */
export function labelSettings(settings: Record<string, unknown>) {
  const l = (settings.label ?? {}) as { width_mm?: number; height_mm?: number; show_age?: boolean };
  return { w: Number(l.width_mm) || 90, h: Number(l.height_mm) || 55, showAge: l.show_age !== false };
}
