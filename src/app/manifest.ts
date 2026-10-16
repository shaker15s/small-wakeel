// وكيل — PWA manifest (add-to-home-screen).
//
// The primary device is a shop owner's phone in his pocket, so the app must be
// installable, launch standalone (no browser chrome eating the composer), and
// carry the brand colour in the status bar. Next generates this at
// /manifest.webmanifest from the object below.
import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'وكيل — مساعد شغلك اليومي',
    short_name: 'وكيل',
    description:
      'مساعد ذكي لصحاب المحلات والجيمات والصيدليات والعطارات — سجّل بع وصرف بثقة، وكل عملية موثقة ومتحققة.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    dir: 'rtl',
    lang: 'ar-EG',
    background_color: '#faf7f1',
    theme_color: '#0f1a2b',
    categories: ['business', 'productivity', 'finance'],
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
  }
}
