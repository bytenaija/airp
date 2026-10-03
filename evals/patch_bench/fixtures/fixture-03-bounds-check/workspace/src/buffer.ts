export function getBufferItem(items: string[], index: number): string | null {
  // Buggy: returns items[index] directly without validating array bounds
  return items[index];
}
