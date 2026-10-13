import 'dotenv/config';
import { createApp } from './server.js';

const port = Number(process.env.PORT ?? 8787);
createApp().listen(port, () => {
  console.log(`infra-mcp listening on :${port} (POST /mcp)${process.env.MCP_API_KEY ? '' : ' — MCP_API_KEY unset, auth disabled'}`);
});
