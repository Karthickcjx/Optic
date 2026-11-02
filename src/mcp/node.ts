// Plain Node.js entry (out/main/mcp.js) for development and tests: `node out/main/mcp.js [--list ...]`.
// The packaged app exposes the same server as `optic --mcp`.
import { runMcp } from './server';

runMcp(process.argv.slice(2)).then(code => process.exit(code), error => { process.stderr.write(`Optic MCP server failed: ${error instanceof Error ? error.message : 'unknown error'}\n`); process.exit(1); });
