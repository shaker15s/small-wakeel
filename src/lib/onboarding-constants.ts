// R75 / PR-007 — consent catalog shared by the UI and the server.
// Client-safe: no db/prisma imports (the UI and the guard must agree on the
// SAME list, so it lives in one place both sides can import).
export const PROFILE_CONSENTS = [
  { key: 'importFromFiles', label: 'أسمح باستيراد ملفات (Excel/CSV) بعدي وأراجع النتيجة قبل اعتمادها' },
  { key: 'importFromPhotos', label: 'أسمح بمحاولة قراءة صور فواتير/دفاتر بعدي' },
] as const
export type ProfileConsentKey = (typeof PROFILE_CONSENTS)[number]['key']
