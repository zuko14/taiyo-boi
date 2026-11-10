/** Per-request wall clock for server components (kept out of render-purity lint). */
export const nowMs = () => Date.now();
