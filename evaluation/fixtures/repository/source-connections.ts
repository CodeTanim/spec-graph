export const sourceProviders = ["github", "confluence"] as const;

export function sourceConnectionPresentation() {
  return { action: "Add source", presentation: "provider dialog" };
}
