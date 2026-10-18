// All BYO-provider requests use a guarded transport, including stored URLs.
// Validation happens in the socket lookup: no validate-then-resolve DNS race.
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { Agent, fetch, type FormData } from 'undici'
import ipaddr from 'ipaddr.js'

export function publicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.process(address) // unwrap IPv4-mapped IPv6
    return parsed.range() === 'unicast'
  } catch { return false }
}

function publicUrl(raw: string, allowQuery = false): URL {
  const url = new URL(raw)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (!allowQuery && url.search)) {
    throw new Error('Provider URL must be HTTPS, without credentials, query or fragment')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) && !publicAddress(host)) throw new Error('Non-public provider address')
  if (!host.includes('.') && !isIP(host)) throw new Error('Non-public provider hostname')
  return url
}

export function providerUrl(raw: string): URL {
  return publicUrl(raw)
}

type Address = { address: string; family: number }
type Resolver = (host: string) => Promise<Address[]>

/** Reject mixed public/private answers, not just the first DNS record. */
export async function publicAddresses(host: string, resolve: Resolver = (name) => lookup(name, { all: true })): Promise<Address[]> {
  const addresses = await resolve(host)
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address))) {
    throw new Error('Non-public provider DNS answer')
  }
  return addresses
}

const transport = new Agent({
  connect: {
    timeout: 8_000,
    lookup(hostname, options, callback) {
      publicAddresses(hostname).then((addresses) => {
        const family = Number(options.family)
        const eligible = family ? addresses.filter((a) => a.family === family) : addresses
        if (!eligible.length) return callback(new Error('No public address in requested family'), '', 0)
        // Undici/node may request all addresses for autoSelectFamily.
        if (options.all) callback(null, eligible)
        else callback(null, eligible[0].address, eligible[0].family)
      }).catch(() => callback(new Error('Provider DNS is unavailable or not public'), '', 0))
    },
  },
})

type FetchOptions = {
  method?: string
  headers?: Record<string, string>
  body?: string | FormData
  signal?: AbortSignal
}

export function publicFetch(url: string, init: FetchOptions = {}) {
  return fetch(publicUrl(url, true), {
    ...init,
    dispatcher: transport,
    // Never forward Authorization to a redirect target, private or public.
    redirect: 'error',
    signal: init.signal ?? AbortSignal.timeout(20_000),
  })
}

export function providerFetch(url: string, init: FetchOptions = {}) {
  providerUrl(url) // providers have no query strings or embedded credentials
  return publicFetch(url, init)
}
