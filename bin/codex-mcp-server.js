#!/usr/bin/env node
import { main } from '../src/index.js';

main(process.argv.slice(2)).catch((error) => {
  console.error('Codex MCP server failed:', error);
  process.exitCode = 1;
});
