// Shared safe configuration vocabulary. No arbitrary CSS/HTML/JS or code edits.
import { z } from 'zod'
export const WORKSPACE_GOALS = {
  cash: { label: 'الخزنة والسيولة', prompt: 'ايه وضع الخزنة؟' },
  stock: { label: 'النواقص والمخزون', prompt: 'ايه الناقص في المخزون؟' },
  debts: { label: 'حسابات العملاء والموردين', prompt: 'مين عليها فلوس؟' },
  margin: { label: 'الربحية والمصروفات', prompt: 'تحليل الربحية والهوامش' },
  expiry: { label: 'الصلاحيات والتشغيلات', prompt: 'الأصناف اللي صلاحيتها قربت تخلص' },
  members: { label: 'تجديد الاشتراكات', prompt: 'الاشتراكات اللي هتنتهي' },
} as const
export const ACCENTS = { amber: '#b45309', teal: '#0f766e', indigo: '#4f46e5', rose: '#be123c' } as const
export const preferencePatchSchema = z.object({
  accent: z.enum(['amber', 'teal', 'indigo', 'rose']).optional(),
  density: z.enum(['comfortable', 'compact']).optional(),
  responseMode: z.enum(['fast', 'deep']).optional(),
  goals: z.array(z.enum(['cash', 'stock', 'debts', 'margin', 'expiry', 'members'])).max(4).optional(),
  onboardingComplete: z.boolean().optional(),
}).strict()
export type WorkspacePatch = z.infer<typeof preferencePatchSchema>
export interface WorkspacePreferences {
  accent: keyof typeof ACCENTS
  density: 'comfortable' | 'compact'
  responseMode: 'fast' | 'deep'
  goals: (keyof typeof WORKSPACE_GOALS)[]
  onboardingComplete: boolean
}
export const DEFAULT_WORKSPACE: WorkspacePreferences = { accent: 'amber', density: 'comfortable', responseMode: 'fast', goals: [], onboardingComplete: false }
