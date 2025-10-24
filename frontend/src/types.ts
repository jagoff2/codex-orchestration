export type AgentResult = {
  summary: string | null;
  usage?: unknown;
  completion?: string | null;
  command?: string[] | null;
};

export type Agent = {
  id: string;
  name: string;
  role: string;
  expertise: string;
  objective: string;
  instructions: string;
  status: string;
  result: AgentResult | null;
  sessionId: string | null;
  logs?: unknown[];
  startedAt?: string;
  completedAt?: string;
};

export type Mission = {
  id: string;
  goal: string;
  context?: unknown;
  status: string;
  createdAt: string;
  updatedAt: string;
  summary?: string | null;
  agents: Agent[];
  logs: unknown[];
  results: { agentId: string; output: AgentResult | null }[];
  error?: string;
};
