import { EventEmitter } from 'node:events';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { CodexRunner } from './codexRunner.js';
import { config, debugLog } from './config.js';
import { sanitizePrompt } from '../promptUtils.js';

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

function buildMissionPlanPrompt(goal, context, { emphasis = 'standard' } = {}) {
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
    '3. Provide 2-4 highly specialized agents tailored to the mission.',
    '4. Agents must be complementary and cover the full delivery loop (planning/design, implementation, testing/QA, validation/documentation) unless the mission explicitly omits a phase.',
    '5. Do not assign multiple agents to the same task; instead, create sequential hand-offs that mirror a real engineering team.',
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

function buildAgentPrompt(mission, agent) {
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

${timeoutBlock}Deliver a comprehensive result in Markdown. Include reasoning, key decisions, and final outputs.

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
    const initialPrompt = buildMissionPlanPrompt(mission.goal, mission.context, { emphasis: 'standard' });
    let attempt = await this.#attemptPlan(mission, initialPrompt, 'initial');

    if (!attempt.plan) {
      const retryPrompt = buildMissionPlanPrompt(mission.goal, mission.context, { emphasis: 'retry' });
      attempt = await this.#attemptPlan(mission, retryPrompt, 'retry');
      if (!attempt.plan) {
        throw new Error(
          `Failed to parse mission plan after two attempts. Snippet: ${attempt.preview ?? '[none]'}`,
        );
      }
    }

    this.#applyPlanResult(mission, attempt.plan, attempt.planResult);
    this.emit('mission:planned', { missionId: mission.id, mission });
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
      agent.startedAt = new Date().toISOString();
      this.emit('agent:started', { missionId: mission.id, agent });

      const agentPrompt = buildAgentPrompt(mission, agent);
      const result = await this.runner.runOnce({
        prompt: agentPrompt,
        extraArgs: [],
      });

      agent.logs.push({
        type: 'interaction',
        at: new Date().toISOString(),
        data: result,
      });
      agent.status = result.exitCode === 0 ? 'completed' : 'failed';
      agent.completedAt = new Date().toISOString();
      agent.sessionId = result.sessionId ?? result.threadId ?? null;
      agent.result = {
        summary: result.lastAgentMessage ?? null,
        usage: result.usage ?? null,
        completion: result.completion,
        command: result.command ?? null,
      };

      mission.results.push({
        agentId: agent.id,
        output: agent.result,
      });

      mission.updatedAt = new Date().toISOString();
      this.emit('agent:finished', { missionId: mission.id, agent });

      if (agent.status === 'failed') {
        mission.status = 'failed';
        mission.error = `Agent ${agent.name} failed`;
        this.emit('mission:failed', { mission, error: new Error(mission.error) });
        return;
      }

      const directiveSource =
        agent.result?.summary ?? result.lastAgentMessage ?? result.stdout ?? '';
      const controlDirective = this.#extractControlDirective(directiveSource);
      if (controlDirective) {
        const inserted = this.#handleControlDirective(mission, agent, controlDirective, idx);
        if (inserted > 0) {
          continue;
        }
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

  #handleControlDirective(mission, requestingAgent, directive, insertIndex) {
    if (!directive || typeof directive !== 'object') {
      return 0;
    }
    const action = `${directive.action ?? directive.status ?? ''}`.toLowerCase();
    if (action === 'request_iteration') {
      return this.#enqueueIterationAgents(mission, requestingAgent, directive, insertIndex);
    }
    return 0;
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
