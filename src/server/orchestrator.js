import { EventEmitter } from 'node:events';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { CodexRunner } from './codexRunner.js';
import { config, debugLog } from './config.js';
import { sanitizePrompt } from '../promptUtils.js';

const MAX_PLAN_ATTEMPTS = Number(process.env.CODEX_ORCHESTRATOR_MAX_PLAN_ATTEMPTS ?? 4);
const MAX_AGENT_ATTEMPTS = Number(process.env.CODEX_ORCHESTRATOR_MAX_AGENT_ATTEMPTS ?? 3);

function safeJsonParse(payload) {
  if (!payload || typeof payload !== 'string') return null;
  const trimmed = payload.trim();
  if (!trimmed) return null;
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) {
      const slice = candidate.slice(start, end + 1);
      try {
        return JSON.parse(slice);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function buildMissionPlanPrompt(goal, context, { emphasis = 'standard', failureReason = null } = {}) {
  const header = config.orchestrator.planningPrompt;
  const lines = [
    header,
    '',
    'Mission:',
    goal,
  ];
  if (context) {
    lines.push('', 'Additional context:', typeof context === 'string' ? context : JSON.stringify(context, null, 2));
  }
  if (failureReason) {
    lines.push(
      '',
      'Previous attempt failed because:',
      typeof failureReason === 'string' ? failureReason : JSON.stringify(failureReason, null, 2),
      'Correct the issue explicitly before returning the plan.',
    );
  }
  // Platform hint for planner – tells LLM which shell syntax to use.
  const platform = process.platform;
  const osHint = platform === 'win32' ? 'Windows (use PowerShell commands)' : `${platform} (use Bash commands)`;
  lines.push('', `Host OS: ${osHint}. Emit shell commands using the native syntax.`);
  lines.push(
    '',
    'Agent schema (must include every field):',
    '- name: snake_case identifier',
    '- role: one sentence description',
    '- expertise: short bullet-style string list',
    '- objective: concrete outcome for this agent',
    '- instructions: detailed step-by-step guidance',
    '',
    'Directives:',
    '1. Mission details are complete. DO NOT ask clarifying questions.',
    '2. Output STRICT JSON only (no prose, no code fences).',
    '3. Provide 2-6 highly specialized agents tailored to the mission.',
    '4. Agents must be complementary and cover the full delivery loop (planning/design, implementation, testing/QA, validation/documentation) unless the mission explicitly omits a phase.',
    '5. Do not assign multiple agents to the same task; instead, create sequential hand-offs that mirror a real engineering team.',
    '6. Every agent must describe only actions they genuinely perform (commands run, files touched, tests executed). Fabricated or purely hypothetical work is forbidden—agents must verify artifacts before reporting success.',
    '7. The planner MUST NOT write code, shell commands, or pseudo-implementations. Its sole responsibility is to emit JSON that describes the mission summary and agent plan—no Markdown, code blocks, or instructions beyond the schema.',
    '',
    'JSON schema sample:',
    '{"mission_summary":"...","agents":[{"name":"...","role":"...","expertise":"...","objective":"...","instructions":"..."}]}',
  );
  if (emphasis === 'retry') {
    lines.push(
      '',
      'IMPORTANT: Your previous response violated the format. Return ONLY JSON matching the schema above. Do not apologize or ask questions.',
    );
  }
  lines.push('', 'Return ONLY JSON. DO NOT include explanations, natural-language responses, or Markdown.');
  const rawPrompt = lines.join('\n');
  const sanitizedPrompt = sanitizePrompt(rawPrompt);
  debugLog('Plan prompt length', sanitizedPrompt.length);
  return sanitizedPrompt;
}

function needsTimeoutDirective(agent) {
  const fields = [
    agent?.role ?? '',
    agent?.objective ?? '',
    agent?.instructions ?? '',
    agent?.name ?? '',
  ]
    .join(' ')
    .toLowerCase();
  return /\b(test|qa|quality assurance|verification|validate|validator|compliance|review)\b/.test(
    fields,
  );
}

function buildAgentPrompt(mission, agent, { attempt = 0, failureReason = null } = {}) {
  const retryBlock =
    failureReason && `${failureReason}`.trim().length
      ? `Attempt ${attempt + 1} corrective directives:
- Previous attempt failed because: ${failureReason}
- Resolve this issue explicitly before proceeding.
- Show evidence (command outputs, file diffs, test logs) proving the fix.

`
      : '';
  const realityBlock = `Reality-check requirement:
- Only describe actions you actually performed during this turn (commands executed, files created/edited, tests run). Do NOT speculate or invent results.
- After each modification, cite the exact command used (e.g., \`ls\`, \`cat file\`, \`npm test --timeout 60\`) and summarize the observed output, or explicitly state why the action could not be performed.
- If a requested artifact does not exist or you lack permissions/resources, declare the blocker and request an iteration instead of fabricating work.

`;
  const timeoutBlock = needsTimeoutDirective(agent)
    ? `Testing safety requirement:
- Every command, script, or test you run MUST include an explicit, realistic timeout. Choose a duration appropriate for the workload (typically 30-180 seconds). If the tool lacks a timeout flag, wrap it with a timeout utility (e.g., PowerShell Start-Process with -Wait -Timeout, bash "timeout" command, or equivalent).
- Never run commands without timeouts; if a tool cannot be wrapped, describe the limitation and request guidance before proceeding.

`
    : '';
  const rawPrompt = `You are ${agent.name}, ${agent.role}.
Mission summary: ${mission.summary}
Your objective: ${agent.objective}
Core expertise: ${agent.expertise}

Instructions:
${agent.instructions}

${retryBlock}${realityBlock}${timeoutBlock}Deliver a comprehensive result in Markdown. Include reasoning, key decisions, and final outputs.

Iteration protocol:
- If additional work is required before the mission can proceed (e.g., tests failed, missing docs), end your response with a single line exactly like:
  CONTROL_JSON: {"action":"request_iteration","target_agent":"AGENT_TO_REPEAT","instructions":"SUCCINCT_FIXES_NEEDED","next_agent":"AGENT_WHO_SHOULD_FOLLOW_UP"}
- If everything is complete and the mission should continue, end with:
  CONTROL_JSON: {"action":"continue"}
- The CONTROL_JSON line must be the final line of your response with no surrounding Markdown or prose.`;
  const sanitizedPrompt = sanitizePrompt(rawPrompt);
  debugLog('Agent prompt length', sanitizedPrompt.length);
  return sanitizedPrompt;
}

export class Orchestrator extends EventEmitter {
  constructor(options = {}) {
    super();
    this.runner = new CodexRunner(options);
    this.missions = new Map();
  }

  listMissions() {
    return Array.from(this.missions.values()).map((mission) => ({
      id: mission.id,
      goal: mission.goal,
      status: mission.status,
      createdAt: mission.createdAt,
      updatedAt: mission.updatedAt,
      agentCount: mission.agents?.length ?? 0,
      summary: mission.summary ?? null,
    }));
  }

  getMission(id) {
    return this.missions.get(id) ?? null;
  }

  async createMission({ goal, context }) {
    if (!goal || typeof goal !== 'string') {
      throw new Error('Goal is required');
    }

    const missionId = uuidv4();
    const mission = {
      id: missionId,
      goal,
      context: context ?? null,
      status: 'planning',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      logs: [],
      agents: [],
      summary: null,
      results: [],
      agentBlueprints: Object.create(null),
    };

    this.missions.set(missionId, mission);
    this.emit('mission:created', mission);

    try {
      await this.#planMission(mission);
      await this.#executeMission(mission);
      mission.status = 'completed';
      mission.updatedAt = new Date().toISOString();
      this.emit('mission:completed', mission);
    } catch (error) {
      mission.status = 'failed';
      mission.error = error.message;
      mission.updatedAt = new Date().toISOString();
      this.emit('mission:failed', { mission, error });
    }

    return mission;
  }

  async #planMission(mission) {
    this.emit('mission:planning', { missionId: mission.id });
    let failureReason = null;
    let lastAttempt = null;

    for (let attemptIndex = 0; attemptIndex < MAX_PLAN_ATTEMPTS; attemptIndex += 1) {
      const emphasis = attemptIndex === 0 ? 'standard' : 'retry';
      if (attemptIndex > 0) {
        await this.runner.ensureInactive();
      }
      const prompt = buildMissionPlanPrompt(mission.goal, mission.context, {
        emphasis,
        failureReason,
      });
      const label = attemptIndex === 0 ? 'initial' : `retry-${attemptIndex}`;
      try {
        lastAttempt = await this.#attemptPlan(mission, prompt, label);
      } catch (error) {
        failureReason = `Codex planner error: ${error.message}`;
        mission.logs.push({
          type: `plan:${label}:failure`,
          at: new Date().toISOString(),
          reason: failureReason,
        });
        debugLog('Plan attempt threw error', { label, failureReason });
        continue;
      }
      if (lastAttempt.plan) {
        this.#applyPlanResult(mission, lastAttempt.plan, lastAttempt.planResult);
        this.emit('mission:planned', { missionId: mission.id, mission });
        return;
      }
      failureReason = this.#describePlanFailure(lastAttempt);
      mission.logs.push({
        type: `plan:${label}:failure`,
        at: new Date().toISOString(),
        reason: failureReason,
      });
      debugLog('Plan attempt failed', { label, failureReason });
    }

    const summary =
      failureReason ?? 'Unknown planner failure (no candidates produced after retries).';
    throw new Error(
      `Failed to obtain mission plan after ${MAX_PLAN_ATTEMPTS} attempts. Last issue: ${summary}`,
    );
  }

  async #attemptPlan(mission, prompt, label) {
    mission.logs.push({ type: `plan:${label}:prompt`, at: new Date().toISOString(), prompt });
    debugLog(`Plan prompt (${label})`, { prompt: prompt.slice(0, 400) });

    const planResult = await this.runner.runOnce({ prompt, extraArgs: [] });

    mission.logs.push({
      type: `plan:${label}:raw`,
      at: new Date().toISOString(),
      data: planResult,
    });
    debugLog(`Plan raw result (${label})`, {
      planSessionId: planResult.sessionId ?? planResult.threadId,
      exitCode: planResult.exitCode,
      completion: planResult.completion,
      stdoutPreview: planResult.stdout?.slice(0, 400),
    });

    const { plan, preview } = this.#parsePlanCandidates(mission, planResult, label);
    return { plan, preview, planResult };
  }

  #parsePlanCandidates(mission, planResult, label) {
    const candidates = [];
    const addCandidate = (value) => {
      if (typeof value === 'string' && value.trim()) {
        candidates.push(value.trim());
      }
    };

    addCandidate(planResult.lastAgentMessage);
    if (Array.isArray(planResult.events)) {
      for (const event of planResult.events) {
        if (event?.type === 'item.completed' && event.item?.type === 'agent_message') {
          if (typeof event.item?.text === 'string') {
            addCandidate(event.item.text);
          }
          if (Array.isArray(event.item?.content)) {
            const textBlocks = event.item.content
              .filter((block) => block?.type === 'text' && typeof block.text === 'string')
              .map((block) => block.text);
            if (textBlocks.length) {
              addCandidate(textBlocks.join('\n'));
            }
          }
        }
      }
    }
    addCandidate(planResult.stdout);

    candidates.forEach((candidate, idx) => {
      const preview = candidate.length > 400 ? `${candidate.slice(0, 400)}…` : candidate;
      mission.logs.push({
        type: `plan:${label}:candidate`,
        index: idx,
        at: new Date().toISOString(),
        preview,
      });
      debugLog('Plan candidate', { attempt: label, index: idx, preview });
    });

    for (const candidate of candidates) {
      const parsed = safeJsonParse(candidate);
      if (parsed && Array.isArray(parsed.agents)) {
        return { plan: parsed, preview: candidate.slice(0, 400) };
      }
    }

    debugLog('Plan parse failed', { attempt: label, candidateCount: candidates.length });
    return { plan: null, preview: candidates[0]?.slice(0, 400) };
  }

  #describePlanFailure(attempt) {
    if (!attempt?.planResult) {
      return 'Planner invocation returned no result.';
    }
    const { planResult, preview } = attempt;
    if (planResult.exitCode !== null && planResult.exitCode !== 0) {
      return this.#composeFailureReason(
        `Codex exited with code ${planResult.exitCode}`,
        planResult,
      );
    }
    if (!preview) {
      const stdoutSnippet = planResult.stdout
        ? planResult.stdout.slice(0, 200)
        : '[no stdout]';
      return `Planner response lacked valid JSON. Stdout snippet: ${stdoutSnippet}`;
    }
    return `Planner response was not valid JSON. Preview: ${preview.slice(0, 200)}`;
  }

  #applyPlanResult(mission, parsed, planResult) {
    mission.summary = parsed.mission_summary ?? parsed.summary ?? null;
    mission.agentBlueprints = mission.agentBlueprints ?? Object.create(null);
    mission.agents = parsed.agents.map((agent, index) => {
      const baseName = agent.name ?? `agent_${index + 1}`;
      const blueprint = {
        name: baseName,
        role: agent.role ?? 'Specialist',
        expertise: agent.expertise ?? '',
        objective: agent.objective ?? '',
        instructions: agent.instructions ?? '',
      };
      mission.agentBlueprints[baseName] = blueprint;
      return {
        id: `${baseName}__iter0`,
        name: baseName,
        baseName,
        iteration: 0,
        role: blueprint.role,
        expertise: blueprint.expertise,
        objective: blueprint.objective,
        instructions: blueprint.instructions,
        status: 'pending',
        result: null,
        sessionId: null,
        logs: [],
      };
    });
    mission.planSessionId = planResult.sessionId ?? planResult.threadId ?? null;
    mission.updatedAt = new Date().toISOString();
  }

  async #executeMission(mission) {
    mission.status = 'executing';
    mission.updatedAt = new Date().toISOString();
    this.emit('mission:executing', { missionId: mission.id });

    for (let idx = 0; idx < mission.agents.length; idx += 1) {
      const agent = mission.agents[idx];
      if (agent.status === 'completed') {
        continue;
      }

      agent.status = 'running';
      if (!agent.startedAt) {
        agent.startedAt = new Date().toISOString();
      }
      this.emit('agent:started', { missionId: mission.id, agent });

      let attemptIndex = 0;
      let failureReason = null;
      let insertedAgents = 0;
      let success = false;
      let lastResult = null;

      while (attemptIndex < MAX_AGENT_ATTEMPTS) {
        if (attemptIndex > 0) {
          await this.runner.ensureInactive();
        }
        const agentPrompt = buildAgentPrompt(mission, agent, {
          attempt: attemptIndex,
          failureReason,
        });
        let result;
        try {
          result = await this.runner.runOnce({
            prompt: agentPrompt,
            extraArgs: [],
          });
        } catch (error) {
          failureReason = `Codex runner error: ${error.message}`;
          agent.logs.push({
            type: 'interaction:error',
            at: new Date().toISOString(),
            data: { error: error.message },
          });
          attemptIndex += 1;
          continue;
        }
        lastResult = result;

        agent.logs.push({
          type: 'interaction',
          at: new Date().toISOString(),
          data: result,
        });

        if (result.exitCode !== 0) {
          failureReason = this.#composeFailureReason(
            `Codex exited with code ${result.exitCode}`,
            result,
          );
          attemptIndex += 1;
          continue;
        }

        const directiveSource =
          result.lastAgentMessage ?? agent.result?.summary ?? result.stdout ?? '';
        const controlDirective = this.#extractControlDirective(directiveSource);
        if (!controlDirective) {
          failureReason = 'CONTROL_JSON directive missing or invalid';
          attemptIndex += 1;
          continue;
        }

        const hadExecutionErrors = this.#resultHasExecutionErrors(result);
        const directiveOutcome = this.#handleControlDirective(
          mission,
          agent,
          controlDirective,
          idx,
          { hadExecutionErrors },
        );
        if (!directiveOutcome.ok) {
          failureReason = directiveOutcome.reason;
          attemptIndex += 1;
          continue;
        }

        agent.completedAt = new Date().toISOString();
        agent.sessionId = result.sessionId ?? result.threadId ?? null;
        agent.result = {
          summary: result.lastAgentMessage ?? null,
          usage: result.usage ?? null,
          completion: result.completion,
          command: result.command ?? null,
        };
        agent.status = 'completed';
        mission.results.push({
          agentId: agent.id,
          output: agent.result,
        });
        mission.updatedAt = new Date().toISOString();
        this.emit('agent:finished', { missionId: mission.id, agent });

        insertedAgents = directiveOutcome.inserted ?? 0;
        success = true;
        break;
      }

      if (!success) {
        const finalReason = failureReason ?? 'Unknown agent failure';
        agent.status = 'failed';
        agent.completedAt = new Date().toISOString();
        if (!agent.result && lastResult) {
          agent.result = {
            summary: lastResult.lastAgentMessage ?? null,
            usage: lastResult.usage ?? null,
            completion: lastResult.completion,
            command: lastResult.command ?? null,
          };
        }
        mission.status = 'failed';
        mission.error = `Agent ${agent.name} exhausted retries: ${finalReason}`;
        mission.updatedAt = new Date().toISOString();
        mission.logs.push({
          type: 'agent:failure',
          at: new Date().toISOString(),
          agent: agent.name,
          reason: finalReason,
        });
        this.emit('mission:failed', { mission, error: new Error(mission.error) });
        return;
      }

      if (insertedAgents > 0) {
        continue;
      }
    }
  }

  #extractControlDirective(message) {
    if (!message || typeof message !== 'string') {
      return null;
    }
    const marker = 'CONTROL_JSON:';
    const markerIndex = message.lastIndexOf(marker);
    if (markerIndex === -1) {
      return null;
    }
    const jsonCandidate = message.slice(markerIndex + marker.length).trim();
    if (!jsonCandidate) {
      return null;
    }
    const parsed = safeJsonParse(jsonCandidate);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
    debugLog('Failed to parse CONTROL_JSON directive', { snippet: jsonCandidate.slice(0, 120) });
    return null;
  }

  #handleControlDirective(mission, requestingAgent, directive, insertIndex, options = {}) {
    const { hadExecutionErrors = false } = options;
    if (!directive || typeof directive !== 'object') {
      return { ok: false, inserted: 0, reason: 'Malformed CONTROL_JSON directive' };
    }
    const action = `${directive.action ?? directive.status ?? ''}`.toLowerCase();
    if (!action) {
      return { ok: false, inserted: 0, reason: 'CONTROL_JSON missing action' };
    }
    if (action === 'continue') {
      if (hadExecutionErrors) {
        return { ok: false, inserted: 0, reason: 'Execution errors detected; cannot continue' };
      }
      return { ok: true, inserted: 0 };
    }
    if (action === 'request_iteration') {
      const inserted = this.#enqueueIterationAgents(mission, requestingAgent, directive, insertIndex);
      if (inserted === 0) {
        return { ok: false, inserted: 0, reason: 'Iteration request could not be fulfilled' };
      }
      return { ok: true, inserted };
    }
    return { ok: false, inserted: 0, reason: `Unsupported CONTROL_JSON action: ${action}` };
  }

  #enqueueIterationAgents(mission, requestingAgent, directive, insertIndex) {
    const targetName =
      directive.target_agent
      ?? directive.targetAgent
      ?? directive.target
      ?? requestingAgent.baseName
      ?? requestingAgent.name;
    const targetBlueprint = this.#getAgentBlueprint(mission, targetName);
    if (!targetBlueprint) {
      debugLog('Iteration request ignored: unknown target agent', { targetName, directive });
      return 0;
    }

    const overrideInstructions =
      directive.instructions
      ?? directive.updated_instructions
      ?? directive.details
      ?? directive.fix
      ?? null;
    const reason = directive.reason ?? directive.summary ?? null;

    const newAgents = [];
    const iterationAgent = this.#cloneAgentForIteration(targetBlueprint, mission, {
      overrideInstructions,
      triggeredBy: requestingAgent.name,
      reason,
    });
    if (iterationAgent) {
      newAgents.push(iterationAgent);
    }

    const followUpName =
      directive.next_agent
      ?? directive.follow_up_agent
      ?? requestingAgent.baseName
      ?? requestingAgent.name;
    const shouldAddFollowUp = followUpName && followUpName !== targetBlueprint.name;
    if (shouldAddFollowUp) {
      const followUpBlueprint = this.#getAgentBlueprint(mission, followUpName);
      if (followUpBlueprint) {
        const followUpOverride =
          directive.next_agent_instructions
          ?? directive.follow_up_instructions
          ?? null;
        const followUpAgent = this.#cloneAgentForIteration(followUpBlueprint, mission, {
          overrideInstructions: followUpOverride,
          triggeredBy: requestingAgent.name,
          reason: 'follow_up_verification',
        });
        if (followUpAgent) {
          newAgents.push(followUpAgent);
        }
      } else {
        debugLog('Iteration request follow-up agent missing blueprint', {
          followUpName,
          directive,
        });
      }
    }

    if (newAgents.length) {
      mission.agents.splice(insertIndex + 1, 0, ...newAgents);
      mission.logs.push({
        type: 'iteration:queued',
        at: new Date().toISOString(),
        requestedBy: requestingAgent.name,
        directive,
        insertedAgents: newAgents.map((a) => ({
          id: a.id,
          name: a.name,
          baseName: a.baseName,
          iteration: a.iteration,
        })),
      });
      debugLog('Iteration agents enqueued', {
        requestedBy: requestingAgent.name,
        directive,
        insertedAgents: newAgents.map((a) => a.id),
      });
    }
    return newAgents.length;
  }

  #composeFailureReason(reason, result) {
    if (!result) {
      return reason;
    }
    const stderrSnippet = result.stderr
      ? result.stderr.replace(/\s+/g, ' ').trim().slice(0, 200)
      : null;
    if (stderrSnippet) {
      return `${reason}. stderr: ${stderrSnippet}`;
    }
    if (Array.isArray(result.events)) {
      const errorEvent = result.events.find(
        (event) =>
          event?.type === 'error'
          || event?.type === 'exception'
          || event?.error
          || event?.item?.error,
      );
      if (errorEvent) {
        return `${reason}. Event error: ${JSON.stringify(errorEvent).slice(0, 200)}`;
      }
    }
    const stdoutSnippet = result.stdout
      ? result.stdout.replace(/\s+/g, ' ').trim().slice(0, 200)
      : null;
    return stdoutSnippet ? `${reason}. stdout: ${stdoutSnippet}` : reason;
  }

  #resultHasExecutionErrors(result) {
    if (!result) {
      return false;
    }
    if (Array.isArray(result.events)) {
      for (const event of result.events) {
        if (event?.type === 'error' || event?.type === 'exception') {
          return true;
        }
        if (event?.type === 'item.completed') {
          if (
            (event.status && event.status !== 'success')
            || (event.item?.status && event.item.status !== 'success')
            || event.error
            || event.item?.error
          ) {
            return true;
          }
        }
      }
    }
    const stderr = `${result.stderr ?? ''}`.toLowerCase();
    if (!stderr) {
      return false;
    }
    return (
      stderr.includes('error: enoent')
      || stderr.includes('error: eacces')
      || stderr.includes('permission denied')
      || stderr.includes('error catch error')
    );
  }

  #getAgentBlueprint(mission, baseName) {
    if (!mission.agentBlueprints) {
      return null;
    }
    if (mission.agentBlueprints[baseName]) {
      return mission.agentBlueprints[baseName];
    }
    return mission.agentBlueprints[baseName?.replace(/__iter\d+$/, '')] ?? null;
  }

  #cloneAgentForIteration(blueprint, mission, { overrideInstructions, triggeredBy, reason } = {}) {
    if (!blueprint || !mission?.agents) {
      return null;
    }
    const existingCount = mission.agents.filter((agent) => agent.baseName === blueprint.name).length;
    const iterationIndex = existingCount;
    const combinedInstructions =
      overrideInstructions && `${overrideInstructions}`.trim()
        ? `${overrideInstructions}`.trim().concat(
            '\n\n---\nReference instructions:\n',
            blueprint.instructions,
          )
        : blueprint.instructions;
    return {
      id: `${blueprint.name}__iter${iterationIndex}`,
      name: blueprint.name,
      baseName: blueprint.name,
      iteration: iterationIndex,
      role: blueprint.role,
      expertise: blueprint.expertise,
      objective: blueprint.objective,
      instructions: combinedInstructions,
      status: 'pending',
      result: null,
      sessionId: null,
      logs: [],
      triggeredBy: triggeredBy ?? null,
      iterationReason: reason ?? null,
    };
  }
}
