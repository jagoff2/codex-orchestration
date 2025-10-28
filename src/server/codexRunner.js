import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import crossSpawn from 'cross-spawn';
import { v4 as uuidv4 } from 'uuid';
import { config, debugLog } from './config.js';
import { sanitizePrompt } from '../promptUtils.js';

const COMPLETION_EVENTS = new Set([
  'turn.completed',
  'thread.completed',
  'thread.failed',
  'thread.aborted',
  'thread.errored',
]);

export class CodexRunner extends EventEmitter {
  constructor(options = {}) {
    super();
    this.codexBin = options.codexBin ?? config.codexBin;
    this.workingDirectory = options.workingDirectory ?? config.workingDirectory;
    this.globalArgs = Array.isArray(options.globalArgs)
      ? [...options.globalArgs]
      : [...config.globalArgs];
    this.execArgs = Array.isArray(options.execArgs)
      ? [...options.execArgs]
      : [...config.execArgs];
    this.activeChild = null;
  }

  async ensureInactive() {
    const child = this.activeChild;
    if (!child) {
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      if (this.activeChild === child) {
        this.activeChild = null;
      }
      return;
    }
    await new Promise((resolve) => {
      let resolved = false;
      const cleanup = () => {
        if (resolved) return;
        resolved = true;
        if (this.activeChild === child) {
          this.activeChild = null;
        }
        resolve();
      };
      child.once('exit', cleanup);
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
      }, 200).unref();
      setTimeout(cleanup, 1000).unref();
    });
  }

  async runOnce({
    prompt,
    command,
    extraArgs = [],
    sessionId,
    resumeLast = false,
    timeoutMs = 5 * 60_000,
    env = {},
  }) {
    const invocationId = uuidv4();
    const args = ['exec'];
    // Flags must come before "resume"
    const flags = [...this.execArgs, ...this.globalArgs];
    if (Array.isArray(extraArgs) && extraArgs.length) {
      flags.push(...extraArgs);
    }
    args.push(...flags);

    if (sessionId) {
      args.push('resume', sessionId);
    } else if (resumeLast) {
      args.push('resume', '--last');
    }

    let promptPayload = null;
    if (prompt) {
      const sanitizedPrompt = sanitizePrompt(prompt);
      debugLog('Runner prompt length', sanitizedPrompt.length);
      promptPayload = sanitizedPrompt;
      args.push('-');
    }
    if (command) {
      args.push(command);
    }

    this.emit('spawn', { invocationId, args, sessionId });
    debugLog('Codex spawn', { invocationId, args, sessionId, cwd: this.workingDirectory });
    const child = crossSpawn(this.codexBin, args, {
      cwd: this.workingDirectory,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.activeChild = child;

    const rl = createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    if (promptPayload !== null && child.stdin) {
      child.stdin.write(promptPayload);
      child.stdin.end();
    } else if (child.stdin && !child.stdin.closed) {
      child.stdin.end();
    }

    const result = {
      invocationId,
      sessionId,
      events: [],
      stdout: '',
      stderr: '',
      exitCode: null,
      signal: null,
      threadId: null,
      turnId: null,
      completion: null,
      lastAgentMessage: null,
      usage: null,
      command: [this.codexBin, ...args],
    };

    let completionTimer = null;
    let completionStopRequested = false;
    const scheduleCompletionStop = (reason) => {
      if (completionTimer || child.killed) {
        return;
      }
      completionStopRequested = true;
      debugLog('Codex completion detected, scheduling stop', { invocationId, reason });
      completionTimer = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        setTimeout(() => {
          if (child.exitCode === null && !child.killed) {
            try {
              child.kill('SIGKILL');
            } catch {
              /* ignore */
            }
          }
        }, 1000).unref();
      }, 200);
      completionTimer.unref();
    };

    rl.on('line', (line) => {
      result.stdout += `${line}\n`;
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const event = JSON.parse(trimmed);
        result.events.push(event);
        this.emit('event', { invocationId, event });
        debugLog('Codex event', { invocationId, type: event.type });
        if (event.thread_id && !result.threadId) {
          result.threadId = event.thread_id;
        }
        if (event.turn_id) {
          result.turnId = event.turn_id;
        }
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
          if (typeof event.item?.text === 'string') {
            result.lastAgentMessage = event.item.text;
          }
        }
        if (event.type === 'turn.completed' && event.usage) {
          result.usage = event.usage;
        }
        if (COMPLETION_EVENTS.has(event.type)) {
          result.completion = event.type;
          scheduleCompletionStop(event.type);
        }
      } catch (err) {
        this.emit('parse:error', { invocationId, error: err, line: trimmed });
      }
    });

    const stderrChunks = [];
    child.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderrChunks.push(chunk);
      this.emit('stderr', { invocationId, chunk });
      debugLog('Codex stderr', { invocationId, chunk: chunk.slice(0, 200) });
    });

    const timer =
      timeoutMs &&
      setTimeout(() => {
        this.emit('timeout', { invocationId, timeoutMs });
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        setTimeout(() => {
          if (child.exitCode === null) {
            try {
              child.kill('SIGKILL');
            } catch {
              /* ignore */
            }
          }
        }, 1500).unref();
      }, timeoutMs).unref();

    const [code, signal] = await once(child, 'exit');
    if (this.activeChild === child) {
      this.activeChild = null;
    }

    if (timer) {
      clearTimeout(timer);
    }
    if (completionTimer) {
      clearTimeout(completionTimer);
    }

    rl.close();
    const coercedExitCode =
      code ?? (completionStopRequested && result.completion ? 0 : null);
    result.exitCode = coercedExitCode;
    result.signal = signal ?? null;
    result.stderr = stderrChunks.join('');

    if (!result.threadId) {
      const candidate = result.events.find((evt) => evt.thread_id);
      if (candidate?.thread_id) {
        result.threadId = candidate.thread_id;
      }
    }

    if (!sessionId && result.threadId) {
      result.sessionId = result.threadId;
    }

    this.emit('exit', result);
    debugLog('Codex exit', {
      invocationId,
      exitCode: result.exitCode,
      sessionId: result.sessionId,
      completion: result.completion,
      stdoutPreview: result.stdout.slice(0, 200),
      stderrPreview: result.stderr.slice(0, 200),
    });
    return result;
  }
}
