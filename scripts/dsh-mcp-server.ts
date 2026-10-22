#!/usr/bin/env bun
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { existsSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  checkedLineTotal,
  plainObject,
  READ_REPORT_ALLOWLIST,
  requireInteger,
  requireString,
} from './lib/dsh-wakil-mcp-contract';
import { createMcpDispatcher } from './lib/dsh-wakil-mcp-protocol';

interface RuntimeConfig {
  home: string;
  databaseUrl: string;
  businessId: string;
  userId: string;
}
function refused(message: string): never { throw new Error(message); }
function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}
function runtimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  if (env.WAKIL_DSH_MCP_ENABLE !== '1') {
    return refused('WAKIL DSH bridge is disabled. Set WAKIL_DSH_MCP_ENABLE=1 only for an explicit local profile.');
  }
  const rawHome = env.WAKIL_HOME?.trim();
  if (!rawHome || !isAbsolute(rawHome)) return refused('WAKIL_HOME must be an absolute path to the WAKIL checkout.');
  const home = resolve(rawHome);
  const cwd = resolve(process.cwd());
  const pathKey = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  if (pathKey(home) !== pathKey(cwd)) return refused('The MCP child working directory must equal WAKIL_HOME.');

  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl || !/^file:/i.test(databaseUrl) || databaseUrl.includes('?') || databaseUrl.includes('#')) {
    return refused('DATABASE_URL must be an explicit local file: SQLite URL. Remote DBs and implicit defaults are disabled.');
  }
  let databasePath: string;
  try {
    const parsed = new URL(databaseUrl);
    if (parsed.protocol !== 'file:' || parsed.host) return refused('DATABASE_URL must name a local SQLite file.');
    databasePath = resolve(fileURLToPath(parsed));
  } catch {
    return refused('DATABASE_URL is not a valid absolute file: SQLite URL.');
  }
  if (!isAbsolute(databasePath)) return refused('The SQLite path must be absolute.');
  if (inside(home, databasePath)) {
    return refused('The WAKIL data DB must live outside the source checkout. Do not point DSH at db/custom.db or any DB inside Git.');
  }
  if (!existsSync(databasePath)) return refused('The configured WAKIL DB file does not exist. Initialize a separate local database first.');
  try {
    const stat = lstatSync(databasePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return refused('The configured WAKIL DB must be a regular file, not a symlink.');
  } catch {
    return refused('The configured WAKIL DB cannot be inspected.');
  }

  return {
    home,
    databaseUrl,
    businessId: requireString(env.WAKIL_DSH_BUSINESS_ID, 'WAKIL_DSH_BUSINESS_ID', 5, 100),
    userId: requireString(env.WAKIL_DSH_USER_ID, 'WAKIL_DSH_USER_ID', 5, 100),
  };
}
function moneyPiasters(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
  return (value / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' EGP';
}
function folded(value: string): string {
  return value.normalize('NFKD').replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}
function keyFor(id: string | number | null, name: string, args: Record<string, unknown>, nonce: string): string {
  return 'dsh-' + createHash('sha256').update(JSON.stringify({ nonce, id, name, args })).digest('hex');
}
function exactArgs(args: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(args).filter((key) => !allowed.includes(key));
  if (extra.length) throw new Error('حقول غير مسموحة للأداة: ' + extra.join(', '));
}

async function main(): Promise<void> {
  const config = runtimeConfig(process.env);
  // Set the only DB URL before loading Prisma; do not allow a default DB fallback.
  process.env.DATABASE_URL = config.databaseUrl;
  process.env.WAKIL_STRICT_APPROVALS = '1';
  // Keep stdout exclusively for MCP JSON-RPC frames.
  console.log = (...parts: unknown[]) => process.stderr.write(parts.map(String).join(' ') + '\n');
  console.info = (...parts: unknown[]) => process.stderr.write(parts.map(String).join(' ') + '\n');

  const { db } = await import('../src/lib/db');
  const { requireBusinessReader, requireBusinessUser } = await import('../src/lib/security/permissions');
  const { createDraft } = await import('../src/lib/domain/executors');
  const { runReadTool } = await import('../src/lib/agent/tools');
  const { normalizeAr } = await import('../src/lib/agent/arabic');
  const nonce = randomUUID();

  async function assertOwner(): Promise<void> {
    const actor = await requireBusinessReader(config.businessId, config.userId);
    if (actor.role !== 'owner') throw new Error('جسر DSH في النسخة الأولى يسمح بمالك النشاط فقط.');
    const business = await db.business.findUnique({ where: { id: config.businessId }, select: { id: true } });
    if (!business) throw new Error('النشاط المحدد غير موجود في قاعدة WAKIL.');
  }
  async function itemById(itemId: string): Promise<Record<string, unknown>> {
    const rows = await db.item.findMany({ where: { id: itemId, businessId: config.businessId }, take: 1 });
    if (!rows.length) throw new Error('الصنف غير موجود في هذا النشاط. استخدم find_items وحدد الصنف المقصود.');
    return rows[0] as unknown as Record<string, unknown>;
  }
  async function partyById(kind: 'customer' | 'supplier', id: string): Promise<Record<string, unknown>> {
    const rows = kind === 'customer'
      ? await db.customer.findMany({ where: { id, businessId: config.businessId }, take: 1 })
      : await db.supplier.findMany({ where: { id, businessId: config.businessId }, take: 1 });
    if (!rows.length) throw new Error((kind === 'customer' ? 'العميل' : 'المورد') + ' غير موجود في هذا النشاط.');
    return rows[0] as unknown as Record<string, unknown>;
  }
  async function draftOnly(
    rpcId: string | number | null, toolName: string, args: Record<string, unknown>,
    type: 'sale' | 'purchase' | 'expense' | 'collection' | 'payment' | 'stock_adjustment' | 'price_change',
    summary: string, payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await assertOwner();
    await requireBusinessUser(config.businessId, config.userId);
    const op = await createDraft({
      businessId: config.businessId, userId: config.userId, type, summary, payload,
      idempotencyKey: keyFor(rpcId, toolName, args, nonce),
    });
    return {
      reference: op.ref, operationId: op.id, status: op.status, summary: op.summary,
      draftOnly: true, requiresOwnerApproval: true, executed: false,
      nextStep: 'راجع المسودة واعتمدها بنفسك من واجهة WAKIL. هذا الجسر لا يملك أداة اعتماد أو تنفيذ نهائي.',
    };
  }

  async function callTool(name: string, args: Record<string, unknown>, rpcId: string | number | null): Promise<unknown> {
    await assertOwner();
    switch (name) {
      case 'business_context': {
        exactArgs(args, []);
        const business = await db.business.findUnique({ where: { id: config.businessId } });
        if (!business) throw new Error('النشاط المحدد غير موجود في قاعدة WAKIL.');
        return {
          sourceOfTruth: 'WAKIL local business database',
          business: { id: business.id, name: business.name, type: business.type, workflowMode: business.workflowMode },
          currentActorRole: 'owner',
          financialWrites: 'draft-only; owner approval inside WAKIL',
        };
      }

      case 'find_items': {
        exactArgs(args, ['query']);
        const query = requireString(args.query, 'اسم الصنف', 1, 100);
        const q = normalizeAr(folded(query));
        const items = await db.item.findMany({
          where: { businessId: config.businessId },
          select: { id: true, name: true, unit: true, stockQty: true, lowStockThreshold: true, sellPrice: true, costPrice: true },
          orderBy: { name: 'asc' }, take: 2500,
        });
        const matches = items.map((item) => ({ item, folded: normalizeAr(folded(item.name)) }))
          .filter((row) => row.folded.includes(q))
          .sort((a, b) => Number(a.folded !== q) - Number(b.folded !== q) || a.item.name.localeCompare(b.item.name, 'ar'))
          .slice(0, 10).map(({ item }) => ({
            id: item.id, name: item.name, unit: item.unit, stockQty: item.stockQty,
            lowStockThreshold: item.lowStockThreshold,
            sellPricePiasters: item.sellPrice, sellPriceEgp: moneyPiasters(item.sellPrice),
            costPricePiasters: item.costPrice, costPriceEgp: moneyPiasters(item.costPrice),
          }));
        return { query, matches, sourceOfTruth: 'WAKIL catalog' };
      }

      case 'find_customers':
      case 'find_suppliers': {
        exactArgs(args, ['query']);
        const query = requireString(args.query, 'اسم الطرف', 1, 100);
        const q = normalizeAr(folded(query));
        const parties = name === 'find_customers'
          ? await db.customer.findMany({ where: { businessId: config.businessId }, select: { id: true, name: true, balance: true }, orderBy: { name: 'asc' }, take: 2500 })
          : await db.supplier.findMany({ where: { businessId: config.businessId }, select: { id: true, name: true, balance: true }, orderBy: { name: 'asc' }, take: 2500 });
        const matches = parties.filter((p) => normalizeAr(folded(p.name)).includes(q))
          .sort((a, b) => Number(normalizeAr(folded(a.name)) !== q) - Number(normalizeAr(folded(b.name)) !== q) || a.name.localeCompare(b.name, 'ar'))
          .slice(0, 10).map((p) => ({ id: p.id, name: p.name, balancePiasters: p.balance, balanceEgp: moneyPiasters(p.balance) }));
        return { query, matches, sourceOfTruth: 'WAKIL party register' };
      }

      case 'read_report': {
        exactArgs(args, ['report', 'args']);
        const report = requireString(args.report, 'اسم التقرير', 1, 80);
        if (!(READ_REPORT_ALLOWLIST as readonly string[]).includes(report)) throw new Error('التقرير غير مسموح عبر جسر DSH المحلي.');
        const reportArgs = args.args === undefined ? {} : args.args;
        if (!plainObject(reportArgs)) throw new Error('معاملات التقرير يجب أن تكون كائنًا.');
        exactArgs(reportArgs, ['days','limit','name','query','period','type','metric','yesterday','ref']);
        const cards = await runReadTool(report as never, config.businessId, reportArgs);
        const json = JSON.stringify(cards);
        if (json.length > 24000) throw new Error('نتيجة التقرير طويلة جدًا؛ ضيّق الفترة أو استخدم بحثًا محددًا.');
        return { report, sourceOfTruth: 'WAKIL local ledger', cards, note: 'تقرير قراءة فقط، وليس تنفيذًا لحركة جديدة.' };
      }

      case 'prepare_sale_draft':
      case 'prepare_purchase_draft': {
        const sale = name === 'prepare_sale_draft';
        exactArgs(args, ['itemId','qty', sale ? 'unitPricePiasters' : 'unitCostPiasters','paidPiasters',sale ? 'customerId' : 'supplierId']);
        const itemId = requireString(args.itemId, 'معرّف الصنف', 1, 100);
        const qty = requireInteger(args.qty, 'الكمية', 1);
        const item = await itemById(itemId);
        const priceInput = args[sale ? 'unitPricePiasters' : 'unitCostPiasters'];
        const price = priceInput === undefined ? item[sale ? 'sellPrice' : 'costPrice'] : priceInput;
        if (price === null || price === undefined) throw new Error(sale ? 'سعر بيع الصنف غير مسجل؛ اسأل المالك قبل تجهيز المسودة.' : 'تكلفة الصنف غير مسجلة؛ اسأل المالك قبل تجهيز المسودة.');
        const unitPrice = requireInteger(price, sale ? 'سعر الوحدة بالقرش' : 'تكلفة الوحدة بالقرش', 1);
        const total = checkedLineTotal(qty, unitPrice);
        const paid = args.paidPiasters === undefined ? total : requireInteger(args.paidPiasters, 'المدفوع بالقرش', 0);
        if (paid > total) throw new Error('المدفوع أكبر من إجمالي المسودة.');
        const partyKey = sale ? 'customerId' : 'supplierId';
        const partyId = args[partyKey] === undefined ? undefined : requireString(args[partyKey], partyKey, 1, 100);
        if (paid < total && !partyId) throw new Error(sale ? 'البيع الآجل يحتاج عميلًا موجودًا محددًا. استخدم find_customers.' : 'الشراء الآجل يحتاج موردًا موجودًا محددًا. استخدم find_suppliers.');
        const party = partyId ? await partyById(sale ? 'customer' : 'supplier', partyId) : undefined;
        const payload: Record<string, unknown> = {
          itemId, qty, total, paid, lines: [{ itemId, qty, unitPrice, total }],
          ...(sale && partyId ? { customerId: partyId, customerName: String(party?.name ?? '') } : {}),
          ...(!sale && partyId ? { supplierId: partyId, supplierName: String(party?.name ?? '') } : {}),
        };
        return draftOnly(rpcId, name, args, sale ? 'sale' : 'purchase',
          (sale ? 'بيع ' : 'شراء ') + String(item.name) + ' — كمية ' + qty, payload);
      }

      case 'prepare_expense_draft': {
        exactArgs(args, ['amountPiasters','category','note']);
        const amount = requireInteger(args.amountPiasters, 'قيمة المصروف بالقرش', 1);
        const category = requireString(args.category, 'فئة المصروف', 1, 80);
        const note = args.note === undefined ? '' : requireString(args.note, 'ملاحظة المصروف', 0, 300);
        return draftOnly(rpcId, name, args, 'expense', 'مصروف — ' + category, { total: amount, amount, category, note });
      }

      case 'prepare_collection_draft':
      case 'prepare_payment_draft': {
        const collection = name === 'prepare_collection_draft';
        const partyKey = collection ? 'customerId' : 'supplierId';
        exactArgs(args, [partyKey,'amountPiasters','note']);
        const partyId = requireString(args[partyKey], partyKey, 1, 100);
        const amount = requireInteger(args.amountPiasters, 'المبلغ بالقرش', 1);
        const note = args.note === undefined ? '' : requireString(args.note, 'الملاحظة', 0, 300);
        const party = await partyById(collection ? 'customer' : 'supplier', partyId);
        const payload = collection
          ? { customerId: partyId, customerName: String(party.name), amount, note }
          : { supplierId: partyId, supplierName: String(party.name), amount, note };
        return draftOnly(rpcId, name, args, collection ? 'collection' : 'payment',
          (collection ? 'تحصيل من ' : 'سداد إلى ') + String(party.name), payload);
      }

      case 'prepare_stock_adjustment_draft': {
        exactArgs(args, ['itemId','newQty','reason']);
        const itemId = requireString(args.itemId, 'معرّف الصنف', 1, 100);
        const newQty = requireInteger(args.newQty, 'الكمية الفعلية', 0);
        const reason = requireString(args.reason, 'سبب الجرد', 3, 300);
        const item = await itemById(itemId);
        return draftOnly(rpcId, name, args, 'stock_adjustment', 'تسوية جرد ' + String(item.name), { itemId, newQty, reason });
      }

      case 'prepare_price_change_draft': {
        exactArgs(args, ['itemId','newPricePiasters']);
        const itemId = requireString(args.itemId, 'معرّف الصنف', 1, 100);
        const newPrice = requireInteger(args.newPricePiasters, 'السعر الجديد بالقرش', 1);
        const item = await itemById(itemId);
        return draftOnly(rpcId, name, args, 'price_change', 'تغيير سعر ' + String(item.name), { itemId, newPrice });
      }

      default:
        throw new Error('اسم أداة غير معروف في جسر WAKIL المحلي.');
    }
  }

  const dispatch = createMcpDispatcher(callTool);
  process.stderr.write('[wakil-mcp] local bridge ready; no approval or final-execution tool is exported.\n');
  const readline = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of readline) {
    if (!line.trim()) continue;
    let request: unknown;
    try {
      request = JSON.parse(line);
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } }) + '\n');
      continue;
    }
    try {
      const result = await dispatch(request);
      if (result !== null) process.stdout.write(JSON.stringify(result) + '\n');
    } catch (error) {
      process.stderr.write('[wakil-mcp] dispatcher failure: ' + String(error) + '\n');
      const rpcId = plainObject(request) && (typeof request.id === 'string' || typeof request.id === 'number') ? request.id : null;
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: rpcId, error: { code: -32603, message: 'Internal local bridge error.' } }) + '\n');
    }
  }
}
main().catch((error) => {
  process.stderr.write('[wakil-mcp] startup refused: ' + (error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
});
