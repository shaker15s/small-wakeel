'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { IdentityBoundary } from '@/components/app/IdentityBoundary'
import { AppShell } from '@/components/app/AppShell'

export default function Home() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      }),
  )

  return (
    <QueryClientProvider client={queryClient}>
      <IdentityBoundary><AppShell /></IdentityBoundary>
    </QueryClientProvider>
  )
}
