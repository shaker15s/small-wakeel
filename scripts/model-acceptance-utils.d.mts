export type AcceptanceToolCall = { name?: string; args?: Record<string, unknown> };
export type AcceptanceCheck = { id: string; pass: boolean };
export type AcceptanceModelResult = { checks: AcceptanceCheck[] };
export function buildChatCompletionsUrl(base: string): string;
export function classifyEndpoint(base: string, models?: string[]): 'unconfigured' | 'mock' | 'live';
export function extractToolCalls(parsed: unknown): AcceptanceToolCall[];
export function matchesExpectedSaleCall(call: AcceptanceToolCall | undefined): boolean;
export function matchesExpectedSaleCalls(calls: AcceptanceToolCall[]): boolean;
export function allAcceptanceChecksPass(results: AcceptanceModelResult[]): boolean;
