// وكيل — App Skills Registry (CLI-Anything SKILL.md pattern merged into Wakil)
// ---------------------------------------------------------------------------
// CLI-Anything (HKUDS, Apache-2.0) makes every piece of software agent-native:
// each app gets a SKILL.md — an agent-readable spec: command groups, argument
// shapes, JSON output contract, session behavior. The agent reads the spec and
// drives the software without docs.
//
// Wakil merges the same contract: every bridgeable app (Excel, دفتارة, الأمين,
// إيزي ستور, المتصفح…) carries a compact AppSkill spec. The brain receives the
// spec in its system prompt (so it KNOWS how to drive each app) and executes
// through `cli_control_app` — the local engine runs the real command when the
// server is co-located with the merchant's machine (self-host/dev), and stays
// fail-closed with an honest status in cloud production.
import { normalizeAr } from '@/lib/agent/arabic'

export interface SkillCommand {
  name: string
  desc: string
  args?: string
}
export interface SkillGroup {
  group: string
  commands: SkillCommand[]
}
export interface AppSkill {
  /** stable id — also the `app` argument value for cli_control_app */
  id: string
  /** display name (Arabic, how the owner says it) */
  name: string
  category: 'spreadsheet' | 'accounting' | 'pos' | 'browser' | 'productivity' | 'general'
  /** process names that identify a running instance */
  processNames: string[]
  /** Arabic + English alias words the owner may use */
  aliases: string[]
  /** the agent-readable command surface (SKILL.md command groups) */
  commandGroups: SkillGroup[]
  /** 'native' = a real engine executes here; 'adapter' = inspected, not yet drivable */
  status: 'native' | 'adapter'
  notes?: string
}

export const APP_SKILLS: AppSkill[] = [
  {
    id: 'excel',
    name: 'إكسل / جداول (Excel / CSV)',
    category: 'spreadsheet',
    processNames: ['excel', 'soffice', 'libreoffice', 'wps'],
    aliases: ['اكسيل', 'اكسل', 'excel', 'جداول', 'شيت', 'csv', 'كول', 'كسل'],
    status: 'native',
    commandGroups: [
      {
        group: 'ملفات (files)',
        commands: [
          { name: 'list-recent', desc: 'أحدث ملفات الجداول على الجهاز (اسم/مسار/حجم/تاريخ)' },
        ],
      },
      {
        group: 'قراءة (read — read-only، لا يغير الملف)',
        commands: [
          { name: 'summary', desc: 'الشيتات وأبعادها والترويسة', args: 'file, sheet?' },
          { name: 'read', desc: 'صفوف الشيت كـ JSON (ترويسة + حتى 500 صف)', args: 'file, sheet?, maxRows?(50)' },
        ],
      },
      {
        group: 'كتابة (write — بيحفظ)',
        commands: [
          { name: 'write', desc: 'يكتب قيمة في خلية ويحفظ (رقم أو نص)', args: 'file, range(مثال A2), value, sheet?' },
        ],
      },
    ],
    notes: 'XLSX على ويندوز عبر Excel COM — CSV يشتغل على أي جهاز. القراءة دايمًا read-only.',
  },
  {
    id: 'daftra',
    name: 'دفترة للحسابات (Daftra)',
    category: 'accounting',
    processNames: ['daftra', 'دفترة'],
    aliases: ['دفتره', 'دفترة', 'daftra'],
    status: 'adapter',
    commandGroups: [
      {
        group: 'فحص (inspect)',
        commands: [
          { name: 'inspect', desc: 'هل دفتارة شغالة؟ وين ملفات/مجلدات بياناته' },
        ],
      },
    ],
    notes: 'موصولة للفحص فقط — المزامنة المالية تحتاج موصل موثّق بالبيانات الخارجية.',
  },
  {
    id: 'ameen',
    name: 'الأمين للمحاسبة (Al-Ameen ERP)',
    category: 'accounting',
    processNames: ['ameen', 'الأمين', 'الامين'],
    aliases: ['امين', 'الامين', 'ameen'],
    status: 'adapter',
    commandGroups: [
      {
        group: 'فحص (inspect)',
        commands: [
          { name: 'inspect', desc: 'هل الأمين شغال؟ تحديد قاعدة بياناته المحلية' },
        ],
      },
    ],
    notes: 'موصول للفحص — المطابقة (مخزون/فواتير) تتم عبر ملفات البيانات الموثقة.',
  },
  {
    id: 'easystore',
    name: 'إيزي ستور (EasyStore POS)',
    category: 'pos',
    processNames: ['easystore', 'إيزي', 'ezy'],
    aliases: ['ايزي', 'ايزي ستور', 'easystore'],
    status: 'adapter',
    commandGroups: [
      {
        group: 'فحص (inspect)',
        commands: [
          { name: 'inspect', desc: 'حالة الكاشير ومجلد بياناته' },
        ],
      },
    ],
  },
  {
    id: 'quickbooks',
    name: 'كويك بوكس (QuickBooks)',
    category: 'accounting',
    processNames: ['qbw', 'quickbooks'],
    aliases: ['كويك', 'كويك بوكس', 'quickbooks'],
    status: 'adapter',
    commandGroups: [
      {
        group: 'فحص (inspect)',
        commands: [{ name: 'inspect', desc: 'حالة QuickBooks Desktop وقاعدة البيانات' }],
      },
    ],
  },
  {
    id: 'browser',
    name: 'المتصفح / الأنظمة السحابية (Chrome / Odoo / بوابة ويب)',
    category: 'browser',
    processNames: ['chrome', 'msedge', 'firefox', 'brave'],
    aliases: ['متصفح', 'كروم', 'يدج', 'chrome', 'odoo', 'أودو'],
    status: 'adapter',
    commandGroups: [
      {
        group: 'فحص (inspect)',
        commands: [{ name: 'inspect', desc: 'النافذة/التبويب المفتوح دلوقتي وعنوانه' }],
      },
    ],
  },
]

/** Resolve an app skill from any user spelling (Arabic dialect-tolerant). */
export function skillForApp(name: string): AppSkill | null {
  const s = normalizeAr(String(name || '').trim())
  if (!s) return null
  for (const sk of APP_SKILLS) {
    if (s === sk.id || sk.processNames.some((p) => s.includes(p)) || sk.aliases.some((a) => s.includes(a) || a.includes(s))) {
      return sk
    }
  }
  return null
}

/**
 * The agent-readable spec block injected into the system prompt
 * (SKILL.md → compact prompt form: command groups + JSON contract).
 */
export function appSkillsPromptBlock(): string {
  const lines: string[] = [
    '## مواصفات تشغيل التطبيقات (APP_SKILLS — نمط CLI-Anything: كل برنامج له سطح أوامر JSON)',
  ]
  for (const sk of APP_SKILLS) {
    const groups = sk.commandGroups
      .map((g) => `${g.group}: ${g.commands.map((c) => `${c.name}(${c.args ?? ''})`).join('، ')}`)
      .join(' · ')
    lines.push(`- ${sk.name} [id=${sk.id}, ${sk.status === 'native' ? 'محرك حقيقي' : 'فحص فقط'}] — ${groups}`)
  }
  lines.push(
    'التنفيذ: `cli_control_app({app, command, args})` — الناتج JSON موثّق (ok/summary/data). «إكسل» شغال فعلًا: اقرأ ملفاتك وخذ تجميعات من الشيتات وكبها في السجل. القراءة read-only؛ الكتابة تطلب تأكيدًا من صاحبه أولًا. في بيئة السحابة (مش جهازه) فالأمر بيرجع حالة واضحة — مش بيانات مخيونصة.',
  )
  return lines.join('\n')
}
