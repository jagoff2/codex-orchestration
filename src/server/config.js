import path from 'node:path';

const DEFAULT_CODEX_BIN = process.env.CODEX_BIN || 'codex';
const DEFAULT_WORKDIR = process.env.CODEX_WORKDIR || process.cwd();

const profileArg = process.env.CODEX_PROFILE || 'gpt-oss-20b-lms';
const globalCliArgs = [
  '--profile',
  profileArg,
  '--dangerously-bypass-approvals-and-sandbox',
];

const execCliArgs = [
  '--json',
  '--skip-git-repo-check',
];

const debugFlag = process.env.CODEX_DEBUG ?? process.env.DEBUG;
const debugEnabled = debugFlag ? debugFlag !== '0' : true;

export const config = {
  codexBin: DEFAULT_CODEX_BIN,
  workingDirectory: path.resolve(DEFAULT_WORKDIR),
  globalArgs: globalCliArgs,
  execArgs: execCliArgs,
  debug: debugEnabled,
  orchestrator: {
    planningPrompt: process.env.CODEX_ORCHESTRATOR_PLANNING_PROMPT
      ?? 'You are Codex Mission Control. Return a JSON plan with keys "mission_summary" and "agents". Do not output any other text. NEVER output code.',
  },
  server: {
    port: Number(process.env.PORT || 4300),
    host: process.env.HOST || '0.0.0.0',
  },
};

export function debugLog(...args) {
  if (config.debug) {
    // eslint-disable-next-line no-console
    console.log('[codex-orchestrator]', ...args);
  }
}
