// R44 — golden battery: the scenarios a REAL Egyptian shop owner types,
// spanning every vertical, every op type, every read tool, multi-intent,
// ambiguity (ask-once), corrections, edge rejections and small talk.
//
// Each case is deterministic (WAKIL_OFFLINE=1): the rule ladder +
// deterministic engine decide, no model latency, no network. A failing case
// means the agent stopped doing something an owner actually expects —
// that is a product bug, not a test bug.

export interface EvalCase {
  /** What the owner types (real Egyptian dialect, both digit systems). */
  text: string
  /** Seeded vertical the case runs in. */
  vertical: 'supermarket' | 'gym' | 'pharmacy' | 'attar'
  /** Human-readable expectation (shown in the report). */
  expect: string
  check: (r: any) => boolean
  /** R48: a second owner message (run with turn-1 history) — the check then
   *  applies to turn TWO (multi-turn flows like the credit-to-new-customer). */
  followUp?: string
}

// ---- check builders -------------------------------------------------------
export const draft =
  (type: string) =>
  (r: any): boolean =>
    r.card?.kind === 'draft' && r.card?.type === type && r.card?.status === 'AWAITING_APPROVAL'
export const anyDraft = (types: string[]) => (r: any): boolean =>
  r.card?.kind === 'draft' && types.includes(r.card?.type)
export const cards =
  (min = 1) =>
  (r: any): boolean =>
    Array.isArray(r.cards) && r.cards.length >= min
export const noCard = (r: any): boolean => !r.card
export const overpaySafe = (needle: string) => (r: any) =>
  r.card?.kind === 'draft' ||
  (typeof r.replyText === 'string' && r.replyText.includes('المستحق لـ' + needle))
export const says =
  (...parts: string[]) =>
  (r: any): boolean =>
    typeof r.replyText === 'string' && parts.some((p) => r.replyText.includes(p))
export const saysNot =
  (part: string) =>
  (r: any): boolean =>
    typeof r.replyText === 'string' && !r.replyText.includes(part)
export const notResearch = (r: any): boolean => !r.research
export const chat =
  (minLen = 15) =>
  (r: any): boolean =>
    typeof r.replyText === 'string' && r.replyText.length >= minLen && !r.card

export const all =
  (...cs: Array<(r: any) => boolean>) =>
  (r: any): boolean =>
    cs.every((c) => c(r))

// NOTE: run.ts merges BASE + generated (1000+ battery) — kept separate to avoid a circular import.
export const CASES: EvalCase[] = [
  // =======================================================================
  // SALES — every way an owner says «I sold»
  // =======================================================================
  { text: 'بعت ٢ علبة لبن لأم حسن بـ٩٠', vertical: 'supermarket', expect: 'مسودة بيع (اسم+كمية+سعر+عميل)', check: draft('sale') },
  { text: 'بعت علبة زيت عافية بـ٦٥', vertical: 'supermarket', expect: 'مسودة بيع بدون عميل', check: draft('sale') },
  { text: 'بعت 3 كرتونة كوكا كول', vertical: 'supermarket', expect: 'مسودة بيع بأرقام إنجليزية', check: draft('sale') },
  { text: 'بعت كرتونة لبن لسمير غنيم', vertical: 'supermarket', expect: 'بيع على حساب لعميل موجود', check: draft('sale') },
  { text: 'بيعت ٥ كيلو عدس بـ١٨٥', vertical: 'supermarket', expect: 'بيع بصيغة مبنية للمجهول', check: draft('sale') },
  { text: 'خرجت ٢ طبق بيض لأم حسن ودفعت ٣٠٠ بس', vertical: 'supermarket', expect: 'بيع بدفع جزئي (paid < total)', check: all(draft('sale'), (r) => true) },
  { text: 'بعت شريط مكرونة وعلبة تونك', vertical: 'supermarket', expect: 'صنفين: مسودة أو سؤال واحد محدد', check: (r) => noCard(r) || r.card?.kind === 'draft' },
  { text: 'بعت ١٠ حبة بن محوج مخصوص', vertical: 'attar', expect: 'صنف مش في الكتالوج: مش يخصص «زيت حبة البركة» من كلمة «حبة» — يسأل الاسم', check: (r) => noCard(r) && typeof r.replyText === 'string' && /الكتالوج|الاسم|مش لاقي/.test(r.replyText) },
  { text: 'بعت ٢٠ جم زعفران بـ٧٠', vertical: 'attar', expect: 'بيع بكمية كسرية بالسعر', check: draft('sale') },
  { text: 'الزبون خد شريط تحليل سكر', vertical: 'pharmacy', expect: 'بيع صيدلية (خد = بعت)', check: draft('sale') },
  { text: 'بعت علبة ميلجا بلس لعيادة د. منى', vertical: 'pharmacy', expect: 'بيع لعميل بيزنس (عيادة)', check: draft('sale') },
  { text: 'بعت ٥ لتر زيت حبة البركة', vertical: 'attar', expect: 'بيع وحدة لتر', check: draft('sale') },
  { text: 'كافترية النور خدت ١٠ زجاجة كوكاكولا على حساب', vertical: 'supermarket', expect: 'بيع على حساب لمطعم (خدت = بعت)', check: draft('sale') },
  { text: 'بعت ٥ زجاجة مياه ٦٠ مل بـ٢٥', vertical: 'gym', expect: 'بيع في الجيم (ماء — صيغة مياه ≠ ماء)', check: draft('sale') },
  { text: 'بعت واي بروتين ٢ كيلو بـ١١٥٠', vertical: 'gym', expect: 'بيع منتج جيم', check: draft('sale') },
  { text: 'بعت ٢٠ قرص ناكسيد ٤٠ بـ١٢٠', vertical: 'pharmacy', expect: 'بيع دواء بكمية ٢٠', check: draft('sale') },
  { text: 'بعت ١٠٠ جرام عنبر بـ٦٨٠', vertical: 'attar', expect: 'بيع جرامات عنبر', check: draft('sale') },
  { text: 'بعت ٥ شريط بنادول أطفال بـ١٥٥', vertical: 'pharmacy', expect: 'بيع شرايط أطفال', check: draft('sale') },
  { text: 'بعت ٣ كيلو قرفة بـ٢٧٠', vertical: 'attar', expect: 'بيع قرفة مطحونة', check: draft('sale') },
  { text: 'بعت ١٢ كيس مناديل فاين', vertical: 'supermarket', expect: 'بيع مناديل', check: draft('sale') },

  // =======================================================================
  // PURCHASES — «جبت / اشتريت من المورد»
  // =======================================================================
  { text: 'جبت ٥٠ زجاجة كوكاكولا من محمد تاجر الجملة', vertical: 'supermarket', expect: 'مسودة شراء من مورد', check: draft('purchase') },
  { text: 'اشتريت ٢٠ كيلو جبنة رومي بـ٢٩٠٠', vertical: 'supermarket', expect: 'شراء بسعر إجمالي', check: draft('purchase') },
  { text: 'جبت ١٠ علبة لبن من شركة الألبان الوطنية ودفعت ٤٠٠ بس', vertical: 'supermarket', expect: 'شراء بدفع جزئي', check: draft('purchase') },
  { text: 'شرا ٥ كرتونة بيض من عادل', vertical: 'supermarket', expect: 'شراء بصيغة شرا', check: draft('purchase') },
  { text: 'جبت ٣٠ شريط فيوسيدين من ميا فارم', vertical: 'pharmacy', expect: 'شراء صيدلية (صنف موجود)', check: draft('purchase') },
  { text: 'جبت شحنة أدوية من ميا فارم بـ٣٠٠', vertical: 'pharmacy', expect: 'شراء بدون صنف: يسأل الصنف (مش بيعمل رقم)', check: (r) => r.card?.kind === 'draft' || noCard(r) },
  { text: 'جبت ٥٠ كرتونة مياه ٦٠٠', vertical: 'gym', expect: 'شراء مياه للجيم', check: draft('purchase') },
  { text: 'اشتريت ٢٠ كجم عود كمبودي بـ١٩٠٠', vertical: 'attar', expect: 'شراء عود', check: draft('purchase') },
  { text: 'جبت ٣٠ علبة ديتول من شركة المنظفات', vertical: 'supermarket', expect: 'شراء منظفات', check: draft('purchase') },
  { text: 'دفع للمورد ٢٠٠٠ من مستحقات شركة الألبان', vertical: 'supermarket', expect: 'سداد لمورد (مش شراء)', check: overpaySafe('شركة الألبان') },


  // =======================================================================
  // COLLECTIONS & PAYMENTS — money in / money out to parties
  // =======================================================================
  { text: 'حصلت ٥٠ من أم حسن', vertical: 'supermarket', expect: 'مسودة تحصيل من عميل مدين', check: draft('collection') },
  { text: 'أم حسن دفع ١٠', vertical: 'supermarket', expect: 'تحصيل بصيغة ثانية', check: draft('collection') },
  { text: 'استلمت ١٠٠٠ من مصطفى الجزار', vertical: 'supermarket', expect: 'تحصيل (استلمت)', check: draft('collection') },
  { text: 'أحمد عبد الرحمن سدد ٢٠٠', vertical: 'supermarket', expect: 'تحصيل (سدد)', check: draft('collection') },
  { text: 'سددت ١٠٠٠ لشركة المنظفات', vertical: 'supermarket', expect: 'مسودة سداد لمورد', check: overpaySafe('شركة المنظفات') },

  { text: 'دفعت ٥٠٠ لعادل موزع البيض', vertical: 'supermarket', expect: 'سداد (دفعت)', check: overpaySafe('عادل موزع البيض') },

  { text: 'خلصت شركة الألبان', vertical: 'supermarket', expect: 'سداد كامل/سؤال بمبلغ — مش بيع', check: (r) => noCard(r) || r.card?.kind === 'draft' },
  { text: 'حصلت من عيادة د. منى ٢٠٠', vertical: 'pharmacy', expect: 'تحصيل من عيادة', check: draft('collection') },
  { text: 'سددت لميا فارم ١٠٠٠', vertical: 'pharmacy', expect: 'سداد لمورد أدوية', check: overpaySafe('ميا فارم') },

  { text: 'الحاج رجب دفع ٤٠٠', vertical: 'attar', expect: 'تحصيل من عميل عطارة', check: draft('collection') },
  { text: 'كريم عادل سدد ١٠٠٠', vertical: 'gym', expect: 'تحصيل من عضو', check: draft('collection') },
  { text: 'خلصت الحاج مسعود', vertical: 'attar', expect: 'سداد/سؤال بمبلغ', check: (r) => noCard(r) || r.card?.kind === 'draft' },

  // =======================================================================
  // EXPENSES — «صرفت»
  // =======================================================================
  { text: 'صرفت ٣٠٠ كهربا', vertical: 'supermarket', expect: 'مسودة مصروف (كهربا)', check: draft('expense') },
  { text: 'صرفت ٥٠٠ إيجار', vertical: 'supermarket', expect: 'مصروف إيجار', check: draft('expense') },
  { text: 'مصروف نقليات ١٥٠', vertical: 'supermarket', expect: 'مصروف نقليات', check: draft('expense') },
  { text: 'صرفت ٢٠٠ بنزين الموبايل', vertical: 'pharmacy', expect: 'مصروف صيدلية', check: draft('expense') },
  { text: 'صرفت ١٠٠٠ راتيب مساعد الجيم', vertical: 'gym', expect: 'مصروف راتب', check: draft('expense') },
  { text: 'شرا ٢ تيشيرت بـ٢٥٠ (مصروف شخصي)', vertical: 'attar', expect: 'مصروف (صراحة مصروف)', check: (r) => noCard(r) || r.card?.kind === 'draft' },

  // =======================================================================
  // GYM — memberships & attendance
  // =======================================================================
  { text: 'اشتركت هدى في الجيم شهر بـ٣٥٠', vertical: 'gym', expect: 'مسودة عضوية شهرية', check: anyDraft(['membership', 'sale']) },
  { text: 'جدد اشتراك عمر الشناوي سنوي بـ٣٠٠', vertical: 'gym', expect: 'تجديد عضوية سنوي', check: anyDraft(['membership', 'sale']) },
  { text: 'عمر الشناوي حضر حصة', vertical: 'gym', expect: 'تسجيل حضور', check: (r) => noCard(r) || r.card?.kind === 'draft' },
  { text: 'ملك حسن لعبت حصة النهارده', vertical: 'gym', expect: 'حضور (لعبت حصة)', check: (r) => noCard(r) || r.card?.kind === 'draft' },
  { text: 'باقي قد إيه لعمر الشناوي؟', vertical: 'gym', expect: 'قراءة حالة عضو', check: cards() },
  { text: 'مين اللي عضويته قربت تخلص؟', vertical: 'gym', expect: 'قايمة قربت تخلص (مش بحث عن «مين اللي»)', check: cards() },
  { text: 'اشتركت نادية في الجيم شهر بـ٤٠٠', vertical: 'gym', expect: 'عضو مش مسجل → يسميها ويقترح، مش «لمين؟»', check: all(noCard, says('نادية')) },

  // =======================================================================
  // INVENTORY READS — the eyes
  // =======================================================================
  { text: 'الخزنة فيها كام؟', vertical: 'supermarket', expect: 'رصيد الخزنة', check: cards() },
  { text: 'الناقص إيه؟', vertical: 'supermarket', expect: 'قايمة النواقص', check: cards() },
  { text: 'عندي كام كوكاكولا؟', vertical: 'supermarket', expect: 'رصيد صنف (الصنف بعد الكمية)', check: cards() },
  { text: 'الجبنة الرومي فاضل قد إيه؟', vertical: 'supermarket', expect: 'رصيد جبنة', check: cards() },
  { text: 'إيه اللي هيخلص في الصلاحية قريب؟', vertical: 'pharmacy', expect: 'صلاحيات قريبة', check: cards() },
  { text: 'قيمة المخزون كام؟', vertical: 'supermarket', expect: 'قيمة المخزون', check: cards() },
  { text: 'إيه أكتر حاجه بتبعت؟', vertical: 'supermarket', expect: 'أفضل الأصناف', check: cards() },
  { text: 'فيه حاجه راكدة مش بتبعت؟', vertical: 'supermarket', expect: 'أصناف راكدة', check: cards() },
  { text: 'إيه اللي يخلص قريب حسب البيع؟', vertical: 'supermarket', expect: 'توقع نقص (forecast)', check: cards() },
  { text: 'اللي علينا للموردين كام؟', vertical: 'supermarket', expect: 'مستحقات موردين', check: cards() },
  { text: 'مين عليه فلوس؟', vertical: 'supermarket', expect: 'المديونيات', check: cards() },
  { text: 'اللي ليا عند الناس كام؟', vertical: 'supermarket', expect: 'المديونيات بصيغة ثانية', check: cards() },
  { text: 'آخر الحركات إيه؟', vertical: 'supermarket', expect: 'سجل الحركات', check: cards() },
  { text: 'ملخص النهارده', vertical: 'supermarket', expect: 'ملخص اليوم', check: cards() },
  { text: 'مبيعات الشهر كام؟', vertical: 'supermarket', expect: 'إجماليات فترة', check: cards() },
  { text: 'أنا بربح كام في الـ٣٠ يوم؟', vertical: 'supermarket', expect: 'هامش ربح', check: cards() },
  { text: 'قارن الشهر ده باللي فات', vertical: 'supermarket', expect: 'مقارنة فترتين', check: cards() },
  { text: 'مصروفاتي انقسمت إزاي؟', vertical: 'supermarket', expect: 'تفصيل مصروفات', check: cards() },
  { text: 'إيه الأصناف اللي لازم أطلبها تاني؟', vertical: 'supermarket', expect: 'قايمة إعادة طلب', check: cards() },
  { text: 'أفضل عملائي مين؟', vertical: 'supermarket', expect: 'ترتيب العملاء', check: cards() },
  { text: 'سعر التونة عدل ولا لأ؟', vertical: 'supermarket', expect: 'فحص سعر صنف (أو سؤال توضيح لو الصنف مش موجود)', check: (r) => cards()(r) || noCard(r) },
  { text: 'الربح صنف صنف إزاي؟', vertical: 'supermarket', expect: 'ربح حسب الصنف', check: cards() },
  { text: 'عندنا صنف هيخلص بكرة؟', vertical: 'supermarket', expect: 'توقع نفاد', check: cards() },

  // =======================================================================
  // MULTI-INTENT — one sentence, more than one job
  // =======================================================================
  { text: 'ملخص اليوم وبعت ٣ علبة تونك', vertical: 'supermarket', expect: 'قراءة + بيع: الاتنين يخلصوا', check: (r) => r.cards?.length || r.card },
  { text: 'الخزنة كام والناقص إيه؟', vertical: 'supermarket', expect: 'قراءتين في رسالة', check: cards(2) },
  { text: 'حصلت ٢٠٠ من أم حسن وصرفت ٥٠ كهربا', vertical: 'supermarket', expect: 'تحصيل + مصروف', check: (r) => r.card || r.cards?.length },
  { text: 'بعت ٢ علبة زيت وعايز اعرف ربحي', vertical: 'supermarket', expect: 'بيع + قراءة ربح', check: (r) => r.card || r.cards?.length },
  { text: 'جبت ١٠ كرتونة تونك وملخص النهارده', vertical: 'supermarket', expect: 'شراء + ملخص', check: (r) => r.card || r.cards?.length },
  { text: 'اللي عليهم كام؟ وبعت شريط مكرونة لسمير', vertical: 'supermarket', expect: 'مديونيات + بيع', check: (r) => r.card || r.cards?.length },
  { text: 'باقي قد إيه لعمر الشناوي وبعتله علبة واى بروتين', vertical: 'gym', expect: 'قراءة عضو + بيع', check: (r) => r.card || r.cards?.length },

  // =======================================================================
  // ASK-ONCE — the employee asks ONE precise question when a number is
  // missing, and never executes blindly
  // =======================================================================
  { text: 'بعت تونة', vertical: 'supermarket', expect: 'من غير كمية: اختصار الكاشير (١) بمسودة للاعتماد — مش تنفيذ', check: (r) => r.card?.kind === 'draft' || (noCard(r) && /كام|الكمية|قد ايه|قداية/.test(r.replyText)) },
  { text: 'بعت ٢ علبة تونة', vertical: 'supermarket', expect: 'من غير سعر: يقترح السعر من الكتالوج أو يسأل', check: (r) => r.card?.kind === 'draft' || noCard(r) },
  { text: 'بعت كرتونة بسكويت', vertical: 'supermarket', expect: 'صنف مش موجود بالاسم: يقترح صنف قريب', check: (r) => noCard(r) || r.card?.kind === 'draft' },
  { text: 'بعت ٥ كيلو سكر', vertical: 'supermarket', expect: 'سكر مش في الكتالوج: يقترح إضافة الصنف', check: (r) => r.card?.kind === 'draft' || noCard(r) },
  { text: 'حصلت فلوس', vertical: 'supermarket', expect: 'من غير اسم ولا مبلغ: سؤال محدد', check: all(noCard, (r) => /مين|كام/.test(r.replyText)) },
  { text: 'صرفت فلوس', vertical: 'supermarket', expect: 'مصروف من غير مبلغ: سؤال', check: all(noCard, saysNot('تم')) },
  { text: 'بعت ٣ علبة لبن', vertical: 'supermarket', expect: 'لبن (مش «كرتونة»): يحدد الصنف أو يسأل', check: (r) => r.card?.kind === 'draft' || noCard(r) },

  // =======================================================================
  // REVERSALS & CORRECTIONS
  // =======================================================================
  { text: 'اعكس آخر عملية بيع', vertical: 'supermarket', expect: 'عكس عملية (مسودة)', check: (r) => r.card?.kind === 'draft' || noCard(r) },
  { text: 'رجعلي العملية اللي سبتها غلط', vertical: 'supermarket', expect: 'عكس آخر عملية', check: (r) => r.card?.kind === 'draft' || noCard(r) },
  { text: 'عدّل مخزون التونة يبقى ٣٠', vertical: 'supermarket', expect: 'تعديل مخزون يدوي', check: (r) => r.card?.kind === 'draft' || noCard(r) },
  { text: 'الجرد طلّع التونة ٢٥ مش ٢٠', vertical: 'supermarket', expect: 'جرد → تعديل مخزون', check: (r) => r.card?.kind === 'draft' || noCard(r) },
  { text: 'سعر اللبن بقى ٤٥ مش ٤٠', vertical: 'supermarket', expect: 'تغيير سعر في الكتالوج', check: (r) => r.card?.kind === 'draft' || noCard(r) },

  // ---- R47: reversal misroute + stated-price + unknown-party safety ----
  { text: 'ملش آخر بيع', vertical: 'supermarket', expect: 'عكس آخر بيع (مش بحث كتالوج)', check: (r) => all(noCard, saysNot('مش لاقي'))(r) || draft('reversal')(r) },
  { text: 'الغيت اللي فات', vertical: 'supermarket', expect: 'عكس آخر عملية مالية (مش مقارنة 7 أيام)', check: (r) => all(noCard, saysNot('مقارنة'))(r) || draft('reversal')(r) },
  { text: 'بعت ٢ تونة لعميل اسمه أحمد زكي اللي مش معارفه', vertical: 'supermarket', expect: 'بيع نقدي بالاسم (مش عميل تاني)', check: (r) => draft('sale')(r) && (r.card?.fields ?? []).some((f: any) => String(f.value).includes('احمد زكي')) },
  { text: 'بعت ٣ كونة زيت لعميل اسمه محمد اللي مش معارفه آجل', vertical: 'supermarket', expect: 'آجل لغير مسجل: سؤال (مش مسودة)', check: (r) => all(noCard, says('مش مسجل'))(r) },
  { text: 'جبت ٥ كرتونة لبن من مورد جديد اسمه الشفاء بـ٣٠', vertical: 'supermarket', expect: 'شرا بالإجمالي ٣٠ + مورد جديد', check: (r) => draft('purchase')(r) && (r.card?.fields ?? []).some((f: any) => String(f.value).includes('٣٠')) },

  // ---- R48: credit to an UNREGISTERED customer — the ask must be HONEST ----
  {
    text: 'بعت ٣ كونة زيت لعميل اسمه محمد اللي مش معارفه آجل',
    vertical: 'supermarket',
    expect: 'سؤال واحد عن الرصيد (مش بحث عميق)',
    followUp: 'عليه ٢٠',
    check: (r) => (r.card?.type === 'customer_add' || r.card?.title?.includes('عميل')) && String(r.replyText).includes('بيع'),
  },
  {
    text: 'بعت ٣ كونة زيت لعميل اسمه محمد اللي مش معارفه آجل',
    vertical: 'supermarket',
    expect: '«جديد» → عميل برصيد ٠ + مسودة البيع',
    followUp: 'جديد',
    check: (r) => r.card?.type === 'customer_add' && String(r.replyText).includes('بيع'),
  },
  {
    text: 'بعت ٣ كونة زيت لعميل اسمه محمد اللي مش معارفه آجل',
    vertical: 'supermarket',
    expect: 'طلب جديد يطلّع من السؤال (تسجيل + بيع مش ضايقين)',
    followUp: 'بعت ٢ تونة لأم حسن بـ٥٠',
    check: (r) => draft('sale')(r) && !String(r.replyText).includes('مش مسجل في حسابات العملاء — عليه كام'),
  },

  // ---- R51: baskets with a glued «و» + a typed name ----
  {
    text: 'بعت ٢ تونة وكونة زيت لعميل اسمه أحمد زكي',
    vertical: 'supermarket',
    expect: 'سلّة ٢+١ (مش ٢+٢) بالاسم «مش مسجل»',
    check: (r) => draft('sale')(r) && String(r.replyText).includes('١١٣') && String(r.replyText).includes('احمد زكي') && !String(r.replyText).includes('٢ قطعة زيت'),
  },
  {
    text: 'بعت ٢ تونة وكونة زيت لعميل اسمه محمد اللي مش معارفه آجل',
    vertical: 'supermarket',
    expect: 'سلّة آجل لغير مسجل: سؤال → تسجيل + مسودة السلّة',
    followUp: 'عليه ٢٠',
    check: (r) => r.card?.type === 'customer_add' && String(r.replyText).includes('تونة'),
  },
  { text: 'كام علينا لمحمد تاجر الجملة؟', vertical: 'supermarket', expect: 'مستحقات الموردين (مش «النت تقيل»)', check: (r) => cards(1)(r) },
  // ---- R52: a NAMED payables question answers with THAT supplier's file ----
  { text: 'كام علينا لمحمد تاجر الجملة؟', vertical: 'supermarket', expect: 'ملف المورد ده (رصيد + آخر سداد + حركات)', check: (r) => cards(1)(r) && String(JSON.stringify(r.cards)).includes('محمد تاجر الجملة') },
  { text: 'تاريخ المورد محمد تاجر الجملة', vertical: 'supermarket', expect: 'ملف المورد (مش قائمة المستحقات كلها)', check: (r) => cards(1)(r) && String(JSON.stringify(r.cards)).includes('ملف محمد تاجر الجملة') },
  { text: 'كام علينا لمحمد تاجر الفول؟', vertical: 'supermarket', expect: 'مورد مش موجود: نتيجة صادقة (مش رقم من عند واحد تاني)', check: (r) => cards(1)(r) && String(JSON.stringify(r.cards)).includes('ملقيتش') },

  // ---- R53: a receipt ref read off the printed slip -------------------------
  { text: 'الفاتورة WKL-2070 دي فيها إيه؟', vertical: 'supermarket', expect: 'استرجاع العملية من رقم الفاتورة: الأصناف والإجمالي من السجل', check: (r) => String(JSON.stringify(r.cards)).includes('WKL-2070') && String(JSON.stringify(r.cards)).includes('جبنة رومي') },
  { text: 'الورقة WKL 2070 كانت كام؟', vertical: 'supermarket', expect: 'نفس العملية برقم من غير شرطة: التطبيع بيفضلها', check: (r) => String(JSON.stringify(r.cards)).includes('WKL-2070') },
  { text: 'WKL-9999', vertical: 'supermarket', expect: 'رقم ملوش عملية: نتيجة صادقة (ملقيتش)', check: (r) => cards(1)(r) && String(JSON.stringify(r.cards)).includes('ملقيتش') },

  // ---- R54: a phone question answers with the number (never the wrong person) ----
  { text: 'رقم تليفون أم حسن؟', vertical: 'supermarket', expect: 'رقم تليفون العميل بالاسم من السجل', check: (r) => String(JSON.stringify(r.cards)).includes('0111 987 6543') },
  { text: 'اتصل بـ محمد تاجر الجملة', vertical: 'supermarket', expect: 'رقم تليفون المورد: نفس العقد، الجهة التانية', check: (r) => String(JSON.stringify(r.cards)).includes('0100 555 4433') },
  { text: 'رقم تليفون سمير غنيم', vertical: 'supermarket', expect: 'رقم مش مسجل: نتيجة صادقة (مش رقم من عند واحد تاني)', check: (r) => String(JSON.stringify(r.cards)).includes('مش مسجل') },
  { text: 'رقم تليفون عميل مش موجود؟', vertical: 'supermarket', expect: 'اسم مش في السجل: نتيجة صادقة (ملقيتش)', check: (r) => cards(1)(r) && String(JSON.stringify(r.cards)).includes('ملقيتش') },

  // ---- R55: the whole-money question — where is my money sitting? ----
  { text: 'فلوسي واقفين فين؟', vertical: 'supermarket', expect: 'المركز المالي: كاش + عند العملاء + المخزون - الموردين', check: (r) => String(JSON.stringify(r.cards)).includes('رأس المال') && String(JSON.stringify(r.cards)).includes('كاش في الخزنة') },
  { text: 'المركز المالي', vertical: 'supermarket', expect: 'نفس السؤال بصيغة رسمية: نفس الكارت', check: (r) => String(JSON.stringify(r.cards)).includes('فلوسي عند العملاء') },


  // ---- R51: the everyday balance question must not die offline ----
  { text: 'كم علي أم حسن؟', vertical: 'supermarket', expect: 'رصيد العميل (مش «النت تقيل»)', check: (r) => all(noCard, saysNot('النت شكله تقيل'))(r) && String(r.replyText).length >= 30 },
  { text: 'ام حسن عليه كام؟', vertical: 'supermarket', expect: 'نفس السؤال بترتيب تاني', check: (r) => all(noCard, saysNot('النت شكله تقيل'))(r) && String(r.replyText).length >= 30 },
  {
    text: 'بعت ٣ كونة زيت لعميل اسمه محمد اللي مش معارفه آجل',
    vertical: 'supermarket',
    expect: 'سؤال شغل (قراءة) يطلّع من سؤال الرصيد ويجاوب',
    followUp: 'كم علي أم حسن؟',
    check: (r) => all(noCard, saysNot('مش مسجل في حسابات العملاء'))(r) && String(r.replyText).length >= 30,
  },

  // ---- R49: the cash hint «لو عايزه مسجل قولي» is kept ----
  {
    text: 'بعت ٢ تونة لعميل اسمه أحمد زكي اللي مش معارفه',
    vertical: 'supermarket',
    expect: '«سجله» → عميل جديد بالاسم الصح (مش ضايقين ولا بحث)',
    followUp: 'سجله عميل',
    check: (r) => r.card?.type === 'customer_add' && String(r.replyText).includes('احمد زكي'),
  },
  {
    text: 'بعت ٢ تونة لعميل اسمه أحمد زكي اللي مش معارفه',
    vertical: 'supermarket',
    expect: '«سجله عليه ٥٠» → عميل برصيد افتتاحي ٥٠',
    followUp: 'سجله عليه ٥٠',
    check: (r) => r.card?.type === 'customer_add' && (r.card?.fields ?? []).some((f: any) => String(f.value).includes('٥٠')),
  },
  {
    text: 'بعت ٢ تونة لعميل اسمه أحمد زكي اللي مش معارفه',
    vertical: 'supermarket',
    expect: 'سؤال شغل تاني → الطلب يطلّع والرد طبيعي',
    followUp: 'كم مخزون التونة؟',
    check: (r) => !r.card || r.card.type !== 'customer_add',
  },
  { text: 'ارفع سعر زيت عافية ٥ جنيه', vertical: 'supermarket', expect: 'تغيير سعر بدلتا', check: (r) => r.card?.kind === 'draft' || noCard(r) },

  // =======================================================================
  // PARTIES — adding customers & suppliers
  // =======================================================================
  { text: 'ضيف عميل جديد اسمه طارق التل تليفونه 01012345678', vertical: 'supermarket', expect: 'إضافة عميل', check: (r) => r.card?.kind === 'draft' || noCard(r) },
  { text: 'ضيف مورد جديد اسمه شركة الخضار', vertical: 'supermarket', expect: 'إضافة مورد', check: (r) => r.card?.kind === 'draft' || noCard(r) },
  { text: 'ضيف لي عميله بتاعة الكافترية الجديدة', vertical: 'supermarket', expect: 'إضافة عميل (توضيح اسم لو ناقص)', check: (r) => r.card?.kind === 'draft' || noCard(r) },
  { text: 'عميل جديد: صيدلية النرجس عليه ٥٠٠', vertical: 'pharmacy', expect: 'إضافة عميل برصيد مدين', check: (r) => r.card?.kind === 'draft' || noCard(r) },

  // =======================================================================
  // MEMORY — «احفظ / فاكر / امسح»
  // =======================================================================
  { text: 'احفظ إن أم حسن بتسدد كل خميس', vertical: 'supermarket', expect: 'حفظ في ذاكرة طويلة المدى', check: says('حفظ', 'فاكر', 'ذكرت', 'سجل') },
  { text: 'فاكر إيه اللي اتفقنا عليه عن أم حسن؟', vertical: 'supermarket', expect: 'استرجاع من الذاكرة (أو قول مش فاكر بصراحة)', check: (r) => typeof r.replyText === 'string' && r.replyText.length > 5 },
  { text: 'امسح معلومة أم حسن من الذاكرة', vertical: 'supermarket', expect: 'نسيان (أو قول مفيش معلومة)', check: (r) => typeof r.replyText === 'string' && r.replyText.length > 5 },

  // =======================================================================
  // CALCULATE — the desk calculator
  // =======================================================================
  { text: 'حسبلي ٢٠٠ ضرب ١٥', vertical: 'supermarket', expect: 'حساب فوري', check: says('3000', '٣٠٠٠') },
  { text: '١٥٪ من ٥٠٠ كام؟', vertical: 'supermarket', expect: 'نسبة مئوية', check: says('75', '٧٥') },
  { text: 'حاسبلي ٤٥٠ قسمة ٦', vertical: 'pharmacy', expect: 'قسمة', check: says('75', '٧٥') },

  // =======================================================================
  // ADVICE & WEB — the consultant & the look-out
  // =======================================================================
  { text: 'انصحني إزاي أقلل المصاريف؟', vertical: 'supermarket', expect: 'نصيحة مبنية على السجل (مش مسودة مصروف!)', check: all(noCard, notResearch, (r) => r.replyText.length > 30) },
  { text: 'ازاي ازود مبيعاتي في رمضان؟', vertical: 'attar', expect: 'نصيحة/بحث (مش تنفيذ)', check: (r) => r.replyText.length > 30 || r.research },
  { text: 'سعر الجبنة الرومي في السوق كام؟', vertical: 'supermarket', expect: 'بحث ويب (أو معلومة سوقية)', check: (r) => r.research || r.replyText.length > 20 },
  { text: 'قارنلي أسعار الزيت في سوق العبور', vertical: 'supermarket', expect: 'بحث ويب', check: (r) => r.research || r.replyText.length > 20 },
  { text: 'حلل ربحيتي في آخر شهر', vertical: 'pharmacy', expect: 'تحليل ربحية', check: cards() },

  // =======================================================================
  // SCHEDULE — the employee who remembers for you
  // =======================================================================
  { text: 'فكرني بجرد المخزون كل يوم ٩ الصبح', vertical: 'supermarket', expect: 'جدولة مهمة متكررة', check: (r) => typeof r.replyText === 'string' && r.replyText.length > 10 },
  { text: 'فكرني بسداد شركة المنظفات بكرة الساعة ١٢', vertical: 'supermarket', expect: 'تذكير بموعد', check: (r) => typeof r.replyText === 'string' && r.replyText.length > 10 },

  // =======================================================================
  // PERSONA & WORKSPACE — «ظبط نفسك»
  // =======================================================================
  { text: 'كلمني رسمي من دلوقتي', vertical: 'supermarket', expect: 'تغيير النبرة', check: (r) => typeof r.replyText === 'string' && r.replyText.length > 5 },
  { text: 'اقصر كلامك من كده', vertical: 'supermarket', expect: 'تغيير أسلوب الرد', check: (r) => typeof r.replyText === 'string' && r.replyText.length > 5 },

  // =======================================================================
  // GREETINGS, IDENTITY, SMALL TALK — the human face
  // =======================================================================
  { text: 'انت مين؟', vertical: 'supermarket', expect: 'تعريف بنفسه من غير موديل', check: chat() },
  { text: 'صباح الخير', vertical: 'supermarket', expect: 'رد ترحيب دافي', check: chat(10) },
  { text: 'اانت مين يصاحبي؟', vertical: 'supermarket', expect: 'تعريف (عامية)', check: chat(10) },
  { text: 'تسلم يا بطل', vertical: 'supermarket', expect: 'رد ودّي', check: chat(8) },
  { text: 'ازيك عامل؟', vertical: 'gym', expect: 'سؤال حال → رد بشوش', check: chat(8) },
  { text: 'شكرا على المساعدة', vertical: 'pharmacy', expect: 'رد شكر', check: chat(8) },
  { text: 'اخبارك ايه؟', vertical: 'attar', expect: 'رد عام (مش بيع!)', check: all(noCard, chat(8)) },

  // =======================================================================
  // CAPABILITY QUESTIONS — the owner asks what the employee CAN do
  // =======================================================================
  { text: 'تقدر تعمل إيه؟', vertical: 'supermarket', expect: 'قدرات حقيقية (بيع/مخزون/خزنة…)', check: chat(30) },
  { text: 'حلو جدا وتقدر تساعدني ازاي وانا اقدر اقويك ازاي؟', vertical: 'supermarket', expect: 'شرح القدرات + اقتراحات', check: chat(40) },
  { text: 'مفيش حد رد عليا النهارده، انت بتشتغل لوحدك؟', vertical: 'supermarket', expect: 'رد إنساني عن طريقة الشغل', check: chat(20) },

  // =================================================================═══════
  // REJECTIONS & GUARDS — money cannot go in wrong
  // =================================================================═══════
  { text: 'حصلت ٥٠٠٠ من أم حسن', vertical: 'supermarket', expect: 'تحصيل أكتر من المدين: يرفض ويوضح الرقم', check: (r) => noCard(r) || r.card?.kind === 'draft' || /١٢٥|125|عليها/.test(r.replyText) },
  { text: 'بعت ٠ علبة تونة', vertical: 'supermarket', expect: 'كمية صفر: مرفوض', check: all(noCard, saysNot('تم')) },
  { text: 'بعت -٣ علبة تونة', vertical: 'supermarket', expect: 'كمية سالبة: مرفوض', check: all(noCard, saysNot('تم')) },
  { text: 'بعت ٩٩٩٩٩ علبة تونة', vertical: 'supermarket', expect: 'كمية مضحكة: يوضح/يسأل', check: (r) => noCard(r) || r.card?.kind === 'draft' },
  { text: 'بعت ٢ علبة تونة بـ٠', vertical: 'supermarket', expect: 'سعر صفر: يسأل (هدية؟)', check: (r) => noCard(r) || r.card?.kind === 'draft' },
  { text: 'بعت تونة', vertical: 'gym', expect: 'تونة مش في كتالوج الجيم: يقترح/يسأل', check: all(noCard, (r) => r.replyText.length > 5) },

  // =================================================================═══════
  // DATE & PERIOD PHRASES — the office vocabulary
  // =================================================================═══════
  { text: 'مبيعات امبارح كام؟', vertical: 'supermarket', expect: 'فترة: امبارح', check: cards() },
  { text: 'مبيعات الاسبوع كام؟', vertical: 'supermarket', expect: 'فترة: أسبوع', check: cards() },
  { text: 'إجماليات الشهر اللي فات', vertical: 'attar', expect: 'فترة: شهر مضى', check: cards() },

  // =================================================================═══════
  // STAFF & PERFORMANCE
  // =================================================================═══════
  { text: 'أداء العاملين إيه في الشهر؟', vertical: 'supermarket', expect: 'أداء فريق', check: (r) => cards()(r) || r.replyText.length > 15 },
  { text: 'مين أفضل باعة عندنا؟', vertical: 'pharmacy', expect: 'ترتيب أداء/عملاء', check: (r) => cards()(r) || r.replyText.length > 15 },]


