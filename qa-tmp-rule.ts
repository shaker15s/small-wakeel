import { normalizeAr } from './src/lib/agent/arabic'
const s = normalizeAr('ايه اللي قرب تخلص صلاحيته؟')
console.log('norm:', JSON.stringify(s), 'len:', s.length)
console.log('greeting+short:', /(السلام|اهلا|هلا|صباح|مساء|ازيك|عامل ايه|شكرا)/.test(s) && s.length < 25)
console.log('cash:', /(وضع|رصيد|حاله) الخزنه|الخزنه|كاش/.test(s))
console.log('lowstock:', /(مخزون|ناقص|استوك)/.test(s) && !/(بعت|بيع|شرا|اشتري)/.test(s))
console.log('expiry:', /(صلاحيه|منتهيه|قربت)/.test(s))
