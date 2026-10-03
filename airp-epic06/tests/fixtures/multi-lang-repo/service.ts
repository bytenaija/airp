export function processOrder(orderId: string): boolean {
  console.log(`Processing order ${orderId}`);
  return true;
}

export class OrderManager {
  private orders: string[] = [];

  public addOrder(id: string): void {
    this.orders.push(id);
  }
}
