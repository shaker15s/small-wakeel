// Conservative, high-confidence credential guard, not a comprehensive DLP system.
export function containsMemorySecret(text: string): boolean {
  return /password|passphrase|api[ _-]?key|باسورد|كلم[ةه]\s*(السر|المرور)|(?:رمز|كود)\s*(الدخول|التحقق|الاسترداد)|(?:^|\s)(?:OTP|TOTP|MFA)(?:\s|:|$)|Bearer\s+[\w.-]+|\bsk-[\w-]{12,}|\bAIza[\w-]{20,}/i.test(text)
}
export function mayLearnImplicitly(text: string): boolean {
  return text.length >= 10 && text.length <= 280 && !containsMemorySecret(text) &&
    !/[؟?«»“”"\n]|(^|\s)(لو|افترض|مثال|مثلا|مش|قال|بيقول|تخيل)(\s|$)/.test(text)
}
