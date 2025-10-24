import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crossSpawn from 'cross-spawn';
import { sanitizePrompt } from './promptUtils.js';

const PACKAGE_JSON = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const SERVER_NAME = 'codex-cli-mcp-server';
const LOGGER_NAME = 'codex-mcp-server';
const DEFAULT_SUBCOMMAND = 'exec';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEBUG_ENABLED = process.env.CODEX_MCP_DEBUG === '1';

function debugLog(...args) {
  if (DEBUG_ENABLED) {
    console.error('[codex-mcp-server]', ...args);
  }
}

const MAX_JSON_EVENT_SUMMARIES = 200;
const COMPLETION_EVENT_TYPES = new Set([
  'turn.completed',
  'thread.completed',
  'thread.failed',
  'thread.errored',
  'thread.aborted',
]);

function summarizeJsonEvent(event) {
  const summary = { type: event?.type ?? 'unknown' };
  switch (event?.type) {
    case 'thread.started':
    case 'thread.completed':
    case 'thread.failed':
    case 'thread.errored':
    case 'thread.aborted': {
      summary.thread_id = event.thread_id ?? event.threadId ?? null;
      break;
    }
    case 'turn.started': {
      summary.turn_id = event.turn_id ?? event.turnId ?? null;
      break;
    }
    case 'turn.completed': {
      summary.turn_id = event.turn_id ?? event.turnId ?? null;
      if (event.usage) {
        summary.usage = event.usage;
      }
      break;
    }
    case 'item.completed':
    case 'item.started':
    case 'item.updated': {
      summary.item = {
        id: event.item?.id ?? null,
        type: event.item?.type ?? null,
        role: event.item?.role ?? null,
      };
      if (event.item?.type === 'agent_message' && typeof event.item?.text === 'string') {
        summary.item.textPreview = event.item.text.slice(0, 200);
      }
      break;
    }
    case 'error': {
      summary.error = event.error ?? event.message ?? null;
      break;
    }
    default:
      break;
  }
  return summary;
}

const defaultOptions = {
  codexBin: 'codex',
  workingDirectory: process.cwd(),
  defaultCodexArgs: [],
  defaultJson: true,
  defaultSkipGitCheck: true,
};

function printHelp() {
  const lines = [
    'Usage: codex-mcp-server [options] [-- <codex options>]',
    '',
    'Options:',
    '  --codex-bin <path>            Path to the Codex CLI binary (default: codex)',
    '  --working-directory <path>    Default working directory for spawned Codex processes',
    '  --no-default-json             Do not inject --json into Codex invocations automatically',
    '  --default-json                Force injection of --json into Codex invocations (default)',
    '  --no-default-skip-git-check   Do not inject --skip-git-repo-check automatically',
    '  --default-skip-git-check      Force injection of --skip-git-repo-check (default)',
    '  --stdio                       Ignored; provided for compatibility with MCP launchers',
    '  -h, --help                    Show this help and exit',
    '  -V, --version                 Print version information and exit',
    '',
    'Any additional arguments are forwarded to each Codex invocation as default options.',
    '',
    'Example:',
    '  codex-mcp-server --profile gpt-oss-20b-lms --dangerously-bypass-approvals-and-sandbox',
  ];
  console.log(lines.join('\n'));
}

function formatValueError(flag) {
  return new Error(`Missing value for ${flag}`);
}

export function parseCliArguments(argv, cwd = process.cwd()) {
  let codexBin = defaultOptions.codexBin;
  let workingDirectory = defaultOptions.workingDirectory;
  let defaultJson = defaultOptions.defaultJson;
  let defaultSkipGitCheck = defaultOptions.defaultSkipGitCheck;
  const codexDefaultArgs = [];
  let showHelp = false;
  let showVersion = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--stdio') {
      continue;
    }

    if (arg === '-h' || arg === '--help') {
      showHelp = true;
      continue;
    }

    if (arg === '-V' || arg === '--version') {
      showVersion = true;
      continue;
    }

    if (arg === '--codex-bin' || arg === '--codex-path') {
      i += 1;
      const value = argv[i];
      if (!value) {
        throw formatValueError(arg);
      }
      codexBin = value;
      continue;
    }

    if (arg.startsWith('--codex-bin=')) {
      codexBin = arg.slice('--codex-bin='.length);
      continue;
    }

    if (arg === '--working-directory' || arg === '-C') {
      i += 1;
      const value = argv[i];
      if (!value) {
        throw formatValueError(arg);
      }
      workingDirectory = path.resolve(cwd, value);
      continue;
    }

    if (arg.startsWith('--working-directory=')) {
      const value = arg.slice('--working-directory='.length);
      workingDirectory = path.resolve(cwd, value);
      continue;
    }

    if (arg === '--no-default-json') {
      defaultJson = false;
      continue;
    }

    if (arg === '--default-json') {
      defaultJson = true;
      continue;
    }

    if (arg === '--no-default-skip-git-check') {
      defaultSkipGitCheck = false;
      continue;
    }

    if (arg === '--default-skip-git-check') {
      defaultSkipGitCheck = true;
      continue;
    }

    codexDefaultArgs.push(arg);
  }

  return {
    codexBin,
    workingDirectory,
    defaultJson,
    defaultSkipGitCheck,
    codexDefaultArgs,
    showHelp,
    showVersion,
  };
}

function createNotification(extra, level, data) {
  if (!extra?.sendNotification) {
    return Promise.resolve();
  }
  return extra.sendNotification({
    method: 'notifications/message',
    params: {
      level,
      logger: LOGGER_NAME,
      data,
    },
  });
}

function ensureFlag(args, flag) {
  if (!args.includes(flag)) {
    args.push(flag);
  }
}

function removeFlag(args, flag) {
  let index = args.indexOf(flag);
  while (index !== -1) {
    args.splice(index, 1);
    index = args.indexOf(flag);
  }
}

function shouldEnableFlag(value, defaultValue) {
  if (value === true) return true;
  if (value === false) return false;
  return defaultValue === true;
}

function buildExecArguments({
  prompt,
  command,
  additionalArgs,
  json,
  skipGit,
  defaultArgs,
  defaultJson,
  defaultSkipGit,
}) {
  const args = [...defaultArgs, DEFAULT_SUBCOMMAND];
  const flagArgs = [];

  debugLog('buildExecArguments input', {
    prompt,
    command,
    additionalArgs,
    json,
    skipGit,
    defaultArgs,
    defaultJson,
    defaultSkipGit,
  });

  if (shouldEnableFlag(json, defaultJson)) {
    ensureFlag(flagArgs, '--json');
  }

  if (shouldEnableFlag(skipGit, defaultSkipGit)) {
    ensureFlag(flagArgs, '--skip-git-repo-check');
  }

  args.push(...flagArgs);

  if (prompt !== undefined) {
    const sanitizedPrompt = sanitizePrompt(prompt);
    debugLog('codex.exec prompt length', sanitizedPrompt.length);
    args.push(sanitizedPrompt);
  }

  if (command !== undefined) {
    args.push(command);
  }

  if (Array.isArray(additionalArgs) && additionalArgs.length > 0) {
    args.push(...additionalArgs);
  }

  debugLog('buildExecArguments output', args);
  return args;
}

function buildExecResumeArguments({
  sessionId,
  prompt,
  command,
  additionalArgs,
  json,
  skipGit,
  defaultArgs,
  defaultJson,
  defaultSkipGit,
  resumeLast = false,
}) {
  const args = [...defaultArgs, DEFAULT_SUBCOMMAND];
  const flagArgs = [];

  debugLog('buildExecResumeArguments input', {
    sessionId,
    prompt,
    command,
    additionalArgs,
    json,
    skipGit,
    defaultArgs,
    defaultJson,
    defaultSkipGit,
    resumeLast,
  });

  if (shouldEnableFlag(json, defaultJson)) {
    ensureFlag(flagArgs, '--json');
  }

  if (shouldEnableFlag(skipGit, defaultSkipGit)) {
    ensureFlag(flagArgs, '--skip-git-repo-check');
  }

  args.push(...flagArgs);
  args.push('resume');

  if (resumeLast) {
    ensureFlag(args, '--last');
  } else if (sessionId) {
    args.push(sessionId);
  }

  if (prompt !== undefined) {
    const sanitizedPrompt = sanitizePrompt(prompt);
    debugLog('codex.exec resume prompt length', sanitizedPrompt.length);
    args.push(sanitizedPrompt);
  }

  if (command !== undefined) {
    args.push(command);
  }

  if (Array.isArray(additionalArgs) && additionalArgs.length > 0) {
    args.push(...additionalArgs);
  }

  debugLog('buildExecResumeArguments output', args);
  return args;
}

function buildCliArguments({
  rawArgs,
  json,
  skipGit,
  defaultArgs,
  defaultJson,
  defaultSkipGit,
}) {
  const args = [...defaultArgs];

  const shouldEnableJson = json === true || (json === undefined && defaultJson === true);
  const shouldDisableJson = json === false;
  if (shouldEnableJson) {
    ensureFlag(args, '--json');
  } else if (shouldDisableJson) {
    removeFlag(args, '--json');
  }

  const shouldEnableSkipGit =
    skipGit === true || (skipGit === undefined && defaultSkipGit === true);
  const shouldDisableSkipGit = skipGit === false;
  if (shouldEnableSkipGit) {
    ensureFlag(args, '--skip-git-repo-check');
  } else if (shouldDisableSkipGit) {
    removeFlag(args, '--skip-git-repo-check');
  }

  return [...args, ...rawArgs];
}

function resolveExecutable(binary, cwd) {
  const isAbsolute = path.isAbsolute(binary);
  const hasDirectoryComponent = binary.includes('/') || binary.includes('\\');

  if (isAbsolute) {
    return binary;
  }

  if (hasDirectoryComponent) {
    return path.resolve(cwd, binary);
  }

  const searchPaths = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);

  if (process.platform === 'win32') {
    const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .filter(Boolean);
    const hasExt = path.extname(binary) !== '';

    for (const dir of searchPaths) {
      if (!dir) continue;
      if (hasExt) {
        const candidate = path.join(dir, binary);
        if (existsSync(candidate)) {
          return candidate;
        }
        continue;
      }
      for (const ext of exts) {
        const candidate = path.join(dir, `${binary}${ext.toLowerCase()}`);
        if (existsSync(candidate)) {
          return candidate;
        }
        const candidateUpper = path.join(dir, `${binary}${ext}`);
        if (existsSync(candidateUpper)) {
          return candidateUpper;
        }
      }
    }
  } else {
    for (const dir of searchPaths) {
      if (!dir) continue;
      const candidate = path.join(dir, binary);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return binary;
}

async function runCodexProcess({
  codexBin,
  args,
  cwd,
  stdin,
  timeoutMs,
  extra,
  env,
}) {
  const start = Date.now();
  const resolvedBinary = resolveExecutable(codexBin, cwd);
  const commandPreview = [resolvedBinary, ...args];
  await createNotification(extra, 'info', {
    event: 'spawn',
    command: commandPreview,
    cwd,
  });

  const mergedEnv = { ...process.env, ...env };

  const child = crossSpawn(resolvedBinary, args, {
    cwd,
    env: mergedEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let aborted = false;
  let terminatedAfterCompletion = false;
  const isJsonStream = args.includes('--json');
  let jsonBuffer = '';
  const jsonSummaries = [];
  let lastAgentMessage = null;
  let usageMetrics = null;
  let completionDetected = false;
  let completionKillTimer = null;
  let parsedJsonEventCount = 0;
  let threadIdFromEvents = null;
  let lastTurnId = null;
  let lastCompletionType = null;
  let lastItemId = null;

  const requestCompletionTermination = (reason) => {
    if (completionDetected) {
      return;
    }
    completionDetected = true;
    terminatedAfterCompletion = true;
    debugLog('Requesting termination after completion event', { reason, command: commandPreview });
    createNotification(extra, 'info', {
      event: 'auto-terminate',
      reason,
      command: commandPreview,
    }).catch(() => {});
    const scheduleKill = () => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            try {
              child.kill('SIGKILL');
            } catch {
              /* ignore */
            }
          }
        }, 1200).unref();
      }
    };
    completionKillTimer = setTimeout(scheduleKill, 250);
    completionKillTimer.unref();
  };

  if (stdin !== undefined && child.stdin) {
    child.stdin.write(stdin);
    child.stdin.end();
  } else if (child.stdin && !child.stdin.closed) {
    child.stdin.end();
  }

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');

  child.stdout?.on('data', (chunk) => {
    stdout += chunk;
    if (!isJsonStream) {
      return;
    }
    jsonBuffer += chunk;
    let newlineIndex = jsonBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = jsonBuffer.slice(0, newlineIndex).trim();
      jsonBuffer = jsonBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        try {
          const event = JSON.parse(line);
          parsedJsonEventCount += 1;
          if (jsonSummaries.length < MAX_JSON_EVENT_SUMMARIES) {
            jsonSummaries.push(summarizeJsonEvent(event));
          }
          if (event?.thread_id) {
            threadIdFromEvents = event.thread_id;
          }
          if (event?.turn_id) {
            lastTurnId = event.turn_id;
          }
          if (event?.type === 'item.completed' && event?.item?.type === 'agent_message') {
            if (typeof event.item?.text === 'string') {
              lastAgentMessage = event.item.text;
            }
            if (event.item?.id) {
              lastItemId = event.item.id;
            }
          }
          if (event?.type === 'turn.completed' && event?.usage) {
            usageMetrics = event.usage;
          }
          if (COMPLETION_EVENT_TYPES.has(event?.type)) {
            lastCompletionType = event.type;
            requestCompletionTermination(event.type);
          }
        } catch (parseError) {
          debugLog('Failed to parse Codex JSON line', { line, error: parseError?.message });
        }
      }
      newlineIndex = jsonBuffer.indexOf('\n');
    }
  });

  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });

  const { signal } = extra ?? {};
  const abortHandler = () => {
    if (child.exitCode === null && child.signalCode === null) {
      aborted = true;
      createNotification(extra, 'warning', {
        event: 'abort',
        command: commandPreview,
      }).catch(() => {});
      child.kill('SIGTERM');
    }
  };

  if (signal) {
    if (signal.aborted) {
      abortHandler();
    } else {
      signal.addEventListener('abort', abortHandler);
    }
  }

  let timeoutId = null;
  if (timeoutMs && Number.isFinite(timeoutMs)) {
    timeoutId = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        timedOut = true;
        createNotification(extra, 'warning', {
          event: 'timeout',
          timeoutMs,
          command: commandPreview,
        }).catch(() => {});
        child.kill('SIGTERM');
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
          }
        }, 1000).unref();
      }
    }, timeoutMs).unref();
  }

  const exitResult = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signalCode) => {
      resolve({ code, signalCode });
    });
  }).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (completionKillTimer) {
      clearTimeout(completionKillTimer);
    }
    if (signal) {
      signal.removeEventListener('abort', abortHandler);
    }
  });

  const durationMs = Date.now() - start;

  if (isJsonStream && jsonBuffer.trim().length > 0) {
    try {
      const event = JSON.parse(jsonBuffer.trim());
      parsedJsonEventCount += 1;
      if (jsonSummaries.length < MAX_JSON_EVENT_SUMMARIES) {
        jsonSummaries.push(summarizeJsonEvent(event));
      }
      if (event?.thread_id) {
        threadIdFromEvents = event.thread_id;
      }
      if (event?.turn_id) {
        lastTurnId = event.turn_id;
      }
      if (event?.type === 'item.completed' && event?.item?.type === 'agent_message') {
        if (typeof event.item?.text === 'string') {
          lastAgentMessage = event.item.text;
        }
        if (event.item?.id) {
          lastItemId = event.item.id;
        }
      }
      if (event?.type === 'turn.completed' && event?.usage) {
        usageMetrics = event.usage;
      }
      if (COMPLETION_EVENT_TYPES.has(event?.type)) {
        lastCompletionType = event.type;
        requestCompletionTermination(event.type);
      }
    } catch {
      /* ignore trailing partial JSON line */
    }
  }

  await createNotification(extra, 'info', {
    event: 'exit',
    command: commandPreview,
    exitCode: exitResult.code,
    signal: exitResult.signalCode,
    durationMs,
    timedOut,
    aborted,
    terminatedAfterCompletion,
  });

  const effectiveExitCode =
    exitResult.code ?? (terminatedAfterCompletion && !timedOut ? 0 : exitResult.code);

  return {
    exitCode: effectiveExitCode,
    signal: exitResult.signalCode,
    stdout,
    stderr,
    durationMs,
    timedOut,
    aborted,
    terminatedAfterCompletion,
    parsedJsonEventCount,
    completionType: lastCompletionType,
    threadId: threadIdFromEvents,
    turnId: lastTurnId,
    lastItemId,
    jsonSummary:
      isJsonStream && (jsonSummaries.length > 0 || lastAgentMessage !== null || usageMetrics !== null)
        ? {
            events: jsonSummaries,
            lastAgentMessage,
            usage: usageMetrics,
            completionDetected,
            threadId: threadIdFromEvents,
            turnId: lastTurnId,
            lastItemId,
            completionType: lastCompletionType,
          }
        : null,
  };
}

export function createCodexServer(options) {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: PACKAGE_JSON.version ?? '0.0.0',
    },
    {
      instructions:
        'Use the codex.exec tool to run nested Codex CLI sessions. Provide a prompt and optional shell command arguments. For arbitrary Codex invocations, use codex.cli.',
    },
  );

  const sessions = new Map();

  const execInputSchema = {
    prompt: z
      .string()
      .describe('Prompt to pass to `codex exec`. If omitted, Codex will start with no initial instructions.'),
    command: z
      .string()
      .optional()
      .describe('Optional shell command to execute immediately after the prompt.'),
    args: z
    .array(z.string())
    .optional()
    .describe('Additional arguments to forward after the prompt/command.'),
  sessionId: z
    .string()
    .optional()
    .describe('Existing Codex session/thread identifier to resume.'),
  resumeLast: z
    .boolean()
    .optional()
    .describe('Resume the most recent recorded Codex session (ignored if sessionId is provided).'),
  cliArgs: z
    .array(z.string())
    .optional()
    .describe('Extra Codex CLI arguments (e.g., ["--profile", "gpt-oss-20b-lms"]).'),
    json: z
      .boolean()
      .optional()
      .describe('Whether to force --json (overrides defaults).'),
    skipGitRepoCheck: z
      .boolean()
      .optional()
      .describe('Whether to force --skip-git-repo-check (overrides defaults).'),
    workingDirectory: z
      .string()
      .optional()
      .describe('Working directory for this invocation. Defaults to the server working directory.'),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Optional timeout in milliseconds.'),
    stdin: z
      .string()
      .optional()
      .describe('Optional stdin payload to write to the Codex process.'),
    env: z
      .record(z.string())
      .optional()
      .describe('Additional environment variables to merge into the Codex process.'),
  };

  const outputSchema = {
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    stdout: z.string(),
    stderr: z.string(),
    durationMs: z.number().int(),
    timedOut: z.boolean(),
    aborted: z.boolean(),
    terminatedAfterCompletion: z.boolean().optional(),
    parsedJsonEventCount: z.number().int().optional(),
    command: z.array(z.string()),
    defaultArgs: z.array(z.string()),
    workingDirectory: z.string(),
    sessionId: z.string().nullable().optional(),
    threadId: z.string().nullable().optional(),
    turnId: z.string().nullable().optional(),
    completionType: z.string().nullable().optional(),
    jsonSummary: z.any().optional(),
    lastItemId: z.string().nullable().optional(),
    resumeHint: z
      .object({
        tool: z.string(),
        sessionId: z.string(),
      })
      .nullable()
      .optional(),
  };

  const summarizeSession = (record) => ({
    sessionId: record.sessionId,
    defaultArgs: record.defaultArgs,
    workingDirectory: record.workingDirectory,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastMessage: record.lastMessage,
    lastCommand: record.lastCommand,
    lastUsage: record.lastUsage,
    turnId: record.turnId ?? null,
    completionType: record.lastCompletionType ?? null,
  });

  server.registerTool(
    'codex.exec',
    {
      title: 'Codex Exec',
      description: 'Run `codex exec` with optional session tracking for follow-up turns.',
      inputSchema: execInputSchema,
      outputSchema,
    },
    async (args, extra) => {
      const {
        prompt,
        command,
        args: additionalArgs = [],
        sessionId,
        resumeLast,
        cliArgs = [],
        json,
        skipGitRepoCheck,
        workingDirectory,
        timeoutMs,
        stdin,
        env,
      } = args;

      const normalizedAdditionalArgs = Array.isArray(additionalArgs) ? additionalArgs : [];
      const normalizedCliArgs = Array.isArray(cliArgs) ? cliArgs : [];

      const existingSession = sessionId ? sessions.get(sessionId) : null;
      if (sessionId && !existingSession) {
        throw new Error(`Unknown Codex session: ${sessionId}`);
      }

      const baseDefaultArgs = existingSession
        ? [...existingSession.defaultArgs]
        : [...options.codexDefaultArgs, ...normalizedCliArgs];

      if (existingSession && normalizedCliArgs.length > 0) {
        normalizedCliArgs.forEach((arg) => {
          if (!baseDefaultArgs.includes(arg)) {
            baseDefaultArgs.push(arg);
          }
        });
      }

      const invocationCwd =
        workingDirectory ?? existingSession?.workingDirectory ?? options.workingDirectory;
      const resolvedBinary = resolveExecutable(options.codexBin, invocationCwd);

      const invocationArgs = existingSession || resumeLast
        ? buildExecResumeArguments({
            sessionId: existingSession?.sessionId ?? sessionId,
            resumeLast: Boolean(resumeLast && !sessionId),
            prompt,
            command,
            additionalArgs: normalizedAdditionalArgs,
            json,
            skipGit: skipGitRepoCheck,
            defaultArgs: baseDefaultArgs,
            defaultJson: options.defaultJson,
            defaultSkipGit: options.defaultSkipGitCheck,
          })
        : buildExecArguments({
            prompt,
            command,
            additionalArgs: normalizedAdditionalArgs,
            json,
            skipGit: skipGitRepoCheck,
            defaultArgs: baseDefaultArgs,
            defaultJson: options.defaultJson,
            defaultSkipGit: options.defaultSkipGitCheck,
          });

      debugLog('codex.exec invocationArgs', invocationArgs);

      const runResult = await runCodexProcess({
        codexBin: options.codexBin,
        args: invocationArgs,
        cwd: invocationCwd,
        stdin,
        timeoutMs,
        extra,
        env,
      });

      const primaryMessage = runResult.jsonSummary?.lastAgentMessage?.trim() ?? null;
      let effectiveSessionId =
        runResult.threadId ??
        runResult.jsonSummary?.threadId ??
        existingSession?.sessionId ??
        sessionId ??
        null;

      const shouldPersistSession = runResult.exitCode === 0;
      if (!effectiveSessionId && shouldPersistSession) {
        effectiveSessionId = randomUUID();
      }

      let sessionRecord = effectiveSessionId ? sessions.get(effectiveSessionId) : null;
      const nowIso = new Date().toISOString();

      if (shouldPersistSession && effectiveSessionId) {
        if (!sessionRecord) {
          sessionRecord = {
            sessionId: effectiveSessionId,
            defaultArgs: [...baseDefaultArgs],
            workingDirectory: invocationCwd,
            createdAt: nowIso,
          };
        }
        sessionRecord.defaultArgs = Array.from(
          new Set([...(sessionRecord.defaultArgs ?? []), ...baseDefaultArgs]),
        );
        sessionRecord.workingDirectory = invocationCwd;
        sessionRecord.updatedAt = nowIso;
        sessionRecord.lastMessage = primaryMessage;
        sessionRecord.lastCommand = [resolvedBinary, ...invocationArgs];
        sessionRecord.lastUsage = runResult.jsonSummary?.usage ?? null;
        sessionRecord.turnId = runResult.turnId ?? null;
        sessionRecord.lastCompletionType = runResult.completionType ?? null;
        sessions.set(effectiveSessionId, sessionRecord);
      }

      const structuredContent = {
        sessionId: effectiveSessionId,
        threadId: runResult.threadId ?? effectiveSessionId ?? null,
        turnId: runResult.turnId ?? null,
        command: [resolvedBinary, ...invocationArgs],
        defaultArgs: sessionRecord?.defaultArgs ?? baseDefaultArgs,
        workingDirectory: invocationCwd,
        completionType: runResult.completionType ?? null,
        resumeHint: effectiveSessionId
          ? {
              tool: 'codex.exec',
              sessionId: effectiveSessionId,
            }
          : null,
        ...runResult,
      };

      const contentBlocks = [];
      if (primaryMessage && primaryMessage.length > 0) {
        contentBlocks.push({
          type: 'text',
          text: primaryMessage,
        });
      }
      if (structuredContent.sessionId) {
        const metaLines = [
          `Session: ${structuredContent.sessionId}`,
          `Turn: ${structuredContent.turnId ?? 'n/a'}`,
          `Exit Code: ${runResult.exitCode ?? 'n/a'}`,
        ];
        if (structuredContent.completionType) {
          metaLines.push(`Completion: ${structuredContent.completionType}`);
        }
        if (runResult.jsonSummary?.usage) {
          metaLines.push(`Usage: ${JSON.stringify(runResult.jsonSummary.usage)}`);
        }
        contentBlocks.push({
          type: 'text',
          text: metaLines.join('\n'),
        });
      }
      contentBlocks.push({
        type: 'text',
        text: JSON.stringify(structuredContent, null, 2),
      });

      return {
        content: contentBlocks,
        structuredContent,
      };
    },
  );

  const listSessionsOutputSchema = {
    sessions: z
      .array(
        z.object({
          sessionId: z.string(),
          defaultArgs: z.array(z.string()),
          workingDirectory: z.string(),
          createdAt: z.string(),
          updatedAt: z.string(),
          lastMessage: z.string().nullable(),
          lastCommand: z.array(z.string()).nullable(),
          lastUsage: z.any().optional(),
          turnId: z.string().nullable(),
          completionType: z.string().nullable(),
        }),
      )
      .default([]),
  };

  server.registerTool(
    'codex.sessions.list',
    {
      title: 'List Codex Sessions',
      description: 'Return metadata about cached Codex CLI sessions tracked by this server.',
      inputSchema: {},
      outputSchema: listSessionsOutputSchema,
    },
    async () => {
      const sessionList = Array.from(sessions.values()).map(summarizeSession);
      const structuredContent = { sessions: sessionList };
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(structuredContent, null, 2),
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    'codex.cli',
    {
      title: 'Codex CLI',
      description: 'Invoke arbitrary Codex CLI subcommands.',
      inputSchema: {
        args: z
          .array(z.string())
          .nonempty()
          .describe('Arguments to pass to the Codex CLI (e.g., ["mcp-server", "--help"]).'),
        json: z
          .boolean()
          .optional()
          .describe('Whether to force --json (overrides defaults).'),
        skipGitRepoCheck: z
          .boolean()
          .optional()
          .describe('Whether to force --skip-git-repo-check (overrides defaults).'),
        workingDirectory: z
          .string()
          .optional()
          .describe('Working directory for this invocation. Defaults to the server working directory.'),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Optional timeout in milliseconds.'),
        stdin: z
          .string()
          .optional()
          .describe('Optional stdin payload to write to the Codex process.'),
        env: z
          .record(z.string())
          .optional()
          .describe('Additional environment variables to merge into the Codex process.'),
      },
      outputSchema,
    },
    async (args, extra) => {
      const {
        args: rawArgs,
        json,
        skipGitRepoCheck,
        workingDirectory,
        timeoutMs,
        stdin,
        env,
      } = args;

      const invocationCwd = workingDirectory ?? options.workingDirectory;
      const resolvedBinary = resolveExecutable(options.codexBin, invocationCwd);

      const invocationArgs = buildCliArguments({
        rawArgs,
        json,
        skipGit: skipGitRepoCheck,
        defaultArgs: options.codexDefaultArgs,
        defaultJson: options.defaultJson,
        defaultSkipGit: options.defaultSkipGitCheck,
      });

      debugLog('codex.cli invocationArgs', invocationArgs);

      const runResult = await runCodexProcess({
        codexBin: options.codexBin,
        args: invocationArgs,
        cwd: invocationCwd,
        stdin,
        timeoutMs,
        extra,
        env,
      });

      const structuredContent = {
        command: [resolvedBinary, ...invocationArgs],
        ...runResult,
      };
      const primaryMessage = runResult.jsonSummary?.lastAgentMessage?.trim();
      const contentBlocks = [];
      if (primaryMessage && primaryMessage.length > 0) {
        contentBlocks.push({
          type: 'text',
          text: primaryMessage,
        });
      }
      contentBlocks.push({
        type: 'text',
        text: JSON.stringify(structuredContent, null, 2),
      });

      return {
        content: contentBlocks,
        structuredContent,
      };
    },
  );

  return server;
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseCliArguments(argv, process.cwd());

  if (parsed.showVersion) {
    console.log(`${SERVER_NAME} ${PACKAGE_JSON.version ?? '0.0.0'}`);
    return;
  }

  if (parsed.showHelp) {
    printHelp();
    return;
  }

  const server = createCodexServer({
    codexBin: parsed.codexBin,
    workingDirectory: parsed.workingDirectory,
    codexDefaultArgs: parsed.codexDefaultArgs,
    defaultJson: parsed.defaultJson,
    defaultSkipGitCheck: parsed.defaultSkipGitCheck,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (invokedDirectly) {
  main().catch((error) => {
    console.error('Fatal error starting Codex MCP server:', error);
    process.exitCode = 1;
  });
}
