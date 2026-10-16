"use client"

import { useSyncExternalStore } from "react"

const MOBILE_BREAKPOINT = 768
const QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

// Subscribing to the media query through useSyncExternalStore (instead of a
// useEffect + setState) keeps this hook free of cascading renders and makes the
// first client paint already correct — no "desktop layout flashes for one
// frame on a phone" bug.
function subscribe(onChange: () => void) {
  if (typeof window === "undefined") return () => {}
  const mql = window.matchMedia(QUERY)
  mql.addEventListener("change", onChange)
  return () => mql.removeEventListener("change", onChange)
}

function getSnapshot(): boolean {
  if (typeof window === "undefined") return false
  return window.matchMedia(QUERY).matches
}

/** Server snapshot: assume desktop (the RTL shell is usable at any width). */
function getServerSnapshot(): boolean {
  return false
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
