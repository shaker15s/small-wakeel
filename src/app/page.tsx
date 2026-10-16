'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { AppShell } from '@/components/app/AppShell'
import { CommandPalette } from '@/components/app/CommandPalette'

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
      <AppShell />
      {/* One search box for the whole app — available in chat and every view. */}
      <CommandPalette />
    </QueryClientProvider>
  )
}
