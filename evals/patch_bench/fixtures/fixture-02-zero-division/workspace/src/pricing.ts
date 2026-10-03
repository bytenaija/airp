export function calculateDiscount(total: number, count: number): number {
  if (total <= 0) return 0;
  return (total * 0.1) / count;
}
