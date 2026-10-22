export function resolveChatCompletionsUrl(base: string): string
export const SALE_TOOL_ACCEPTANCE_SCHEMA: { name: string; description: string; parameters: Record<string, unknown> }
export function isLiveAcceptanceEndpoint(base: string, apiKey: string, models?: string[]): boolean
export function isMockAcceptanceEndpoint(base: string, models?: string[]): boolean
export function assertSafeAcceptanceCredentialTarget(base: string, apiKey: string, models?: string[]): void
export function evaluateExpectedSaleCall(calls: Array<{ name?: string; args?: Record<string, unknown> }>): { passed: boolean; detail: string }
