// Checkout pricing for the shop.
// Amounts are in Japanese yen.

export type LineItem = {
  name?: string;
  price: number; // unit price in yen
  qty: number;
};

export type CheckoutOptions = {
  promoCode?: string;
  isVip?: boolean;
};

export function subtotal(items: LineItem[]): number {
  return items.reduce((sum, item) => sum + item.price * item.qty, 0);
}

// TODO: promo codes are not supported yet.
export function calculateTotal(items: LineItem[], options: CheckoutOptions = {}): number {
  const sub = subtotal(items);
  const discountRate = options.isVip ? 0.1 : 0;
  return Math.floor(sub * (1 - discountRate));
}
