import { timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildBankServer } from '../bank/tools.js';
import { Bank } from '../bank/world.js';
import { Sandbox } from './sandbox.js';
import { ALL_TOOLS, buildServer } from './tools.js';

function requireKey(expected: string | undefined) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!expected) return next();
    const header = req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? req.header('x-api-key') ?? '';
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    if (a.length === b.length && timingSafeEqual(a, b)) return next();
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' }, id: null });
  };
}

export function createApp(sandbox: Sandbox = new Sandbox(), apiKey: string | undefined = process.env.MCP_API_KEY, bank: Bank = new Bank()) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  const auth = requireKey(apiKey);

  app.get('/health', (_req, res) => {
    res.json({ ok: true, server: 'infra-mcp', tools: ALL_TOOLS.length });
  });

  // Stateless Streamable HTTP: a fresh server + transport per request, all sharing one world.
  const notAllowed = (_req: Request, res: Response) => {
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'method not allowed' }, id: null });
  };
  const mount = (path: string, build: () => McpServer) => {
    app.post(path, auth, async (req, res) => {
      if (process.env.MCP_DEBUG) console.log(`[mcp] ${path} ua=${req.header('user-agent')} body=${JSON.stringify(req.body).slice(0, 600)}`);
      // ArmorIQ's proxy adds an `_iam_context` field beside the JSON-RPC ones, saying who the call is for
      // and what policy allowed. The MCP transport validates strictly and rejects unknown fields, so it is
      // taken off here. It is informational: this server still does not make permission decisions.
      if (req.body && typeof req.body === 'object' && '_iam_context' in req.body) delete (req.body as Record<string, unknown>)._iam_context;
      const server = build();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        console.error('mcp request failed', err);
        if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null });
      }
    });
    app.get(path, notAllowed);
    app.delete(path, notAllowed);
  };
  mount('/mcp', () => buildServer(sandbox));
  mount('/bank/mcp', () => buildBankServer(bank));

  app.get('/bank/state', auth, (_req, res) => {
    res.json(bank.snapshot());
  });
  app.post('/bank/reset', auth, (_req, res) => {
    bank.reset();
    res.json({ reset: true });
  });

  // Demo helpers: inspect what actually changed, and put the incident back.
  app.get('/state', auth, (_req, res) => {
    res.json(sandbox.snapshot());
  });
  app.post('/reset', auth, (_req, res) => {
    sandbox.reset();
    res.json({ reset: true });
  });

  return app;
}
