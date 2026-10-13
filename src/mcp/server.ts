import { timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
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

export function createApp(sandbox: Sandbox = new Sandbox(), apiKey: string | undefined = process.env.MCP_API_KEY) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  const auth = requireKey(apiKey);

  app.get('/health', (_req, res) => {
    res.json({ ok: true, server: 'infra-mcp', tools: ALL_TOOLS.length });
  });

  // Stateless Streamable HTTP: a fresh server + transport per request, all sharing one sandbox.
  app.post('/mcp', auth, async (req, res) => {
    const server = buildServer(sandbox);
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
  const notAllowed = (_req: Request, res: Response) => {
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'method not allowed' }, id: null });
  };
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);

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
