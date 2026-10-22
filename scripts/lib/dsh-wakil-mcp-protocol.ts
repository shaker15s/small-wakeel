import { plainObject, WAKIL_MCP_INSTRUCTIONS, WAKIL_MCP_TOOLS } from './dsh-wakil-mcp-contract';

export const MCP_PROTOCOL_VERSIONS = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;

type RpcId = string | number | null;
export type ToolCallHandler = (name: string, args: Record<string, unknown>, requestId: RpcId) => Promise<unknown>;

function response(id: RpcId, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}
function rpcError(id: RpcId, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export function createMcpDispatcher(callTool: ToolCallHandler) {
  let initialized = false;
  return async function dispatch(input: unknown): Promise<Record<string, unknown> | null> {
    if (!plainObject(input) || input.jsonrpc !== '2.0' || typeof input.method !== 'string') {
      return rpcError(null, -32600, 'Invalid JSON-RPC request.');
    }
    const request = input as Record<string, unknown>;
    const method = String(request.method);
    const id: RpcId = typeof request.id === 'string' || typeof request.id === 'number' || request.id === null
      ? request.id as RpcId : null;

    if (method.startsWith('notifications/')) {
      if (method === 'notifications/initialized') initialized = true;
      return null;
    }
    if (!Object.hasOwn(request, 'id')) return null;

    if (method === 'initialize') {
      const params = plainObject(request.params) ? request.params : {};
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const versions = MCP_PROTOCOL_VERSIONS as readonly string[];
      const protocolVersion = versions.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0];
      initialized = false;
      return response(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'wakil-local-business', version: '0.1.0' },
        instructions: WAKIL_MCP_INSTRUCTIONS,
      });
    }
    if (method === 'ping') return response(id, {});
    if (!initialized) return rpcError(id, -32002, 'Server not initialized.');
    if (method === 'tools/list') return response(id, { tools: WAKIL_MCP_TOOLS });
    if (method === 'tools/call') {
      if (!plainObject(request.params)) return rpcError(id, -32602, 'Invalid tools/call params.');
      const name = request.params.name;
      const args = request.params.arguments === undefined ? {} : request.params.arguments;
      if (typeof name !== 'string' || !plainObject(args)) return rpcError(id, -32602, 'Tool name and object arguments are required.');
      try {
        const result = await callTool(name, args, id);
        return response(id, { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }], isError: false });
      } catch (error) {
        const raw = error instanceof Error ? error.message : '';
        const safe = raw.length > 0 && raw.length <= 800 &&
          !/\\b(?:Error:|at \\w|SQLITE|Prisma|DATABASE_URL|\\.db\\b|node_modules|[A-Z]:\\\\|\\/home\\/|\\/Users\\/)/i.test(raw)
          ? raw : 'فشلت الأداة محليًا. لم يتم تنفيذ اعتماد أو تغيير مالي نهائي.';
        return response(id, { content: [{ type: 'text', text: safe }], isError: true });
      }
    }
    return rpcError(id, -32601, 'Method not found: ' + method);
  };
}
