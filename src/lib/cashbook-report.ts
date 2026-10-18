/** Shared projection: drawer variance, loans, capital and drawings are NOT sales. */
export function reportedType(type: string, payload: Record<string, unknown>): string {
  if (type !== 'cashbook') return type
  return ({ credit_sale: 'sale', credit_purchase: 'purchase', cash_purchase: 'purchase', expense: 'expense', receive: 'collection', pay: 'payment' } as Record<string, string>)[String(payload.kind)] ?? 'cashbook'
}
