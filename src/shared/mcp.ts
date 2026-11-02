export interface McpAccess {
  approved: boolean; stale: boolean; approvedAt?: string;
  // How the context authenticates; command/args are what the MCP server runs to obtain credentials.
  auth: { type: string; command?: string; args?: string[] };
  // How an MCP client should start this build of Optic in MCP mode.
  launch: { command: string; args: string[] };
}
