// One completion budget spans retries, candidates and fallback. No new network
// attempt may start after expiry. SDKs without cancellation may finish their
// read-only request, but cannot keep the HTTP turn waiting indefinitely.
export interface ModelBudget { signal: AbortSignal; remainingMs(): number }
export async function withModelBudget<T>(ms: number, run: (budget: ModelBudget) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const end = Date.now() + ms
  const budget: ModelBudget = {
    signal: controller.signal,
    remainingMs() {
      if (controller.signal.aborted || Date.now() >= end) throw new DOMException('Model completion deadline exceeded', 'TimeoutError')
      return Math.max(1, end - Date.now())
    },
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(() => run(budget)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new DOMException('Model completion deadline exceeded', 'TimeoutError')
          controller.abort(error); reject(error)
        }, ms)
      }),
    ])
  } finally { if (timer) clearTimeout(timer) }
}

/** Stream lifetime includes first byte AND all subsequent chunks. */
export async function* withStreamBudget<T>(ms: number, create: (budget: ModelBudget) => AsyncGenerator<T>): AsyncGenerator<T> {
  const controller = new AbortController()
  const end = Date.now() + ms
  const budget: ModelBudget = { signal: controller.signal, remainingMs() {
    if (controller.signal.aborted || Date.now() >= end) throw new DOMException('Model stream deadline exceeded', 'TimeoutError')
    return Math.max(1, end - Date.now())
  } }
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { const error = new DOMException('Model stream deadline exceeded', 'TimeoutError'); controller.abort(error); reject(error) }, ms)
  })
  const gen = create(budget)
  try {
    for (;;) {
      budget.remainingMs()
      const next = await Promise.race([gen.next(), deadline])
      if (next.done) return
      budget.remainingMs()
      yield next.value
    }
  } finally {
    if (timer) clearTimeout(timer)
    controller.abort()
    // A non-cooperative SDK must not hang teardown of the response.
    void gen.return(undefined).catch(() => {})
  }
}
