import { describe, expect, test } from 'bun:test';
import { checkedLineTotal, READ_REPORT_ALLOWLIST, requireInteger, WAKIL_MCP_TOOLS } from '../../scripts/lib/dsh-wakil-mcp-contract';
import { createMcpDispatcher } from '../../scripts/lib/dsh-wakil-mcp-protocol';

describe('WAKIL DSH MCP contract', () => {
  test('no approval, execution, deletion, reversal or commit tool is exposed', () => {
    const names = WAKIL_MCP_TOOLS.map((tool) => tool.name);
    expect(names.some((name) => /approve|execute|commit|delete|reverse/i.test(name))).toBe(false);
    expect(names).toContain('prepare_sale_draft');
    expect(names).toContain('prepare_purchase_draft');
    expect(names).toContain('prepare_expense_draft');
  });
  test('report names are a local allowlist with no web/CLI tool', () => {
    expect((READ_REPORT_ALLOWLIST as readonly string[]).includes('search_web')).toBe(false);
    expect((READ_REPORT_ALLOWLIST as readonly string[]).includes('business_advice')).toBe(false);
    expect(READ_REPORT_ALLOWLIST.some((name) => name.startsWith('cli_'))).toBe(false);
  });
  test('money is integer piastres and multiplication overflow is refused', () => {
    expect(requireInteger(250, 'amount')).toBe(250);
    expect(() => requireInteger(-1, 'amount')).toThrow();
    expect(() => requireInteger(1.5, 'amount')).toThrow();
    expect(() => requireInteger(Number.NaN, 'amount')).toThrow();
    expect(checkedLineTotal(3, 25500)).toBe(76500);
    expect(() => checkedLineTotal(2147483647, 100)).toThrow();
  });
});

describe('WAKIL MCP JSON-RPC', () => {
  test('initializes, returns tools and routes a tool call', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown>; id: string | number | null }> = [];
    const dispatch = createMcpDispatcher(async (name, args, id) => {
      calls.push({ name, args, id });
      return { ok: true };
    });
    const init = await dispatch({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'unit-test', version: '1' } },
    });
    expect(init?.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } } });
    expect(await dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    const listed = await dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect((listed?.result as { tools: unknown[] }).tools.length).toBe(WAKIL_MCP_TOOLS.length);
    const called = await dispatch({ jsonrpc: '2.0', id: 'call-1', method: 'tools/call', params: { name: 'business_context', arguments: {} } });
    expect(called?.result).toMatchObject({ isError: false });
    expect(calls).toEqual([{ name: 'business_context', args: {}, id: 'call-1' }]);
  });
  test('unknown methods return standard JSON-RPC errors; handler exceptions remain tool errors', async () => {
    const dispatch = createMcpDispatcher(async () => { throw new Error('لا يوجد رصيد افتتاحي مسجل.'); });
    await dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28' } });
    await dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect((await dispatch({ jsonrpc: '2.0', id: 2, method: 'desktop/control' }))?.error).toMatchObject({ code: -32601 });
    expect((await dispatch({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_report', arguments: {} } }))?.result).toMatchObject({ isError: true });
  });
});
