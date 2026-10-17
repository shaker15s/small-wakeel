/// <reference types="bun-types" />
// Pulls in Bun's ambient + module declarations (bun:test, Bun.serve, …) for the
// test suite and the standalone scripts WITHOUT narrowing the app's global types
// (adding "types": ["bun-types"] to tsconfig would drop @types/node's globals).
