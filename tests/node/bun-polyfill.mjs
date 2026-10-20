/**
 * وكيل — minimal Bun-global polyfill for the sandbox node fallback (no bun
 * binary available). Provides exactly what the tests use:
 *   Bun.sleep(ms)
 *   Bun.spawn(args, { stdout, stderr }) → { exited, stdout, stderr, kill }
 * where `bun <file.ts> [args…]` is remapped to `node --register <hooks> <file>`.
 * Streams are Web ReadableStreams (the tests feed them to `new Response(...)`).
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { Readable } from 'node:stream'

if (typeof globalThis.Bun === 'undefined') {
  const registerPath = new URL('./register.mjs', import.meta.url).pathname

  const bun = {
    sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms))
    },
    spawn(args, _opts) {
      // remap `bun <ts> …` → node with the TS/alias loader
      const cmd =
        args[0] === 'bun'
          ? [process.execPath, '--import', registerPath, ...args.slice(1)]
          : args
      const child = nodeSpawn(cmd[0], cmd.slice(1), {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0' },
      })
      const exited = new Promise((resolve) => child.on('close', (code) => resolve(code ?? 0)))
      child.on('error', () => {})
      return {
        pid: child.pid,
        exited,
        stdout: Readable.toWeb(child.stdout),
        stderr: Readable.toWeb(child.stderr),
        kill() {
          child.kill('SIGKILL')
        },
      }
    },
  }

  Object.defineProperty(globalThis, 'Bun', { value: bun, configurable: true, writable: true })
}
