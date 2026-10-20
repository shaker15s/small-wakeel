import "./bun-polyfill.mjs"
import { register } from "node:module"
register("./hooks.mjs", import.meta.url)
