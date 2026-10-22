export function resolveChatCompletionsUrl(base: string): string
export function isLiveAcceptanceEndpoint(base: string, apiKey: string, models?: string[]): boolean
export function assertSafeAcceptanceCredentialTarget(base: string, apiKey: string, models?: string[]): void
export function evaluateExpectedSaleCall(calls: Array<{ name?: string; args?: Record<string, unknown> }>): { passed: boolean; detail: string }
