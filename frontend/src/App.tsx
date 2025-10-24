import { useState, useEffect } from 'react';
import { useMissions, createMission, fetchMission } from './api';
import { Mission } from './types';
import { useOrchestratorFeed } from './useOrchestratorFeed';

type FeedEvent = {
  type: string;
  payload: any;
  receivedAt: number;
};

export default function App() {
  const { missions, isLoading, isError, mutate } = useMissions();
  const [selectedMissionId, setSelectedMissionId] = useState<string | null>(null);
  const [selectedMission, setSelectedMission] = useState<Mission | null>(null);
  const [goal, setGoal] = useState('');
  const [context, setContext] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedEvents, setFeedEvents] = useState<FeedEvent[]>([]);

  useEffect(() => {
    if (!selectedMissionId) {
      setSelectedMission(null);
      return;
    }
    fetchMission(selectedMissionId)
      .then(({ mission }) => setSelectedMission(mission))
      .catch((err) => setError(err.message));
  }, [selectedMissionId]);

  useOrchestratorFeed((event) => {
    try {
      const message = JSON.parse(event.data);
      const enriched = { ...message, receivedAt: Date.now() } as FeedEvent;
      setFeedEvents((prev) => [enriched, ...prev].slice(0, 100));

      if (message.payload?.missionId || message.payload?.mission?.id) {
        const missionId = message.payload.missionId || message.payload?.mission?.id;
        if (missionId === selectedMissionId) {
          fetchMission(missionId)
            .then(({ mission }) => setSelectedMission(mission))
            .catch(() => {});
        }
        mutate();
      }
    } catch {
      // ignore malformed events
    }
  });

  const handleCreateMission = async (evt: React.FormEvent) => {
    evt.preventDefault();
    if (!goal.trim()) {
      setError('Please provide a mission goal.');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const { mission } = await createMission(goal.trim(), context.trim() || undefined);
      await mutate();
      setGoal('');
      setContext('');
      setSelectedMissionId(mission.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-primary">Codex Orchestrator</h1>
            <p className="text-sm text-slate-400">
              Autonomous sub-agent generation powered by Codex & your local llama server.
            </p>
          </div>
          <div className="text-xs text-slate-500">
            Default CLI: <code>--profile gpt-oss-20b-lms</code> ·{' '}
            <code>--dangerously-bypass-approvals-and-sandbox</code>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-6xl mx-auto w-full px-6 py-6 grid grid-cols-12 gap-6">
        <section className="col-span-12 md:col-span-4 space-y-6">
          <form
            onSubmit={handleCreateMission}
            className="bg-slate-900/40 border border-slate-800 rounded-xl p-4 space-y-3 shadow-lg"
          >
            <h2 className="text-lg font-semibold text-slate-100">Launch a Mission</h2>
            <label className="block text-sm text-slate-300">
              Goal
              <textarea
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="Design and implement a resilient job queue for data pipelines..."
                className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                rows={3}
                required
              />
            </label>
            <label className="block text-sm text-slate-300">
              Context (optional)
              <textarea
                value={context}
                onChange={(e) => setContext(e.target.value)}
                placeholder="Constraints, repositories, credentials..."
                className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                rows={2}
              />
            </label>
            {error && <p className="text-sm text-rose-400">{error}</p>}
            <button
              type="submit"
              disabled={creating}
              className="w-full bg-primary hover:bg-blue-600 transition text-white rounded-lg py-2 font-medium disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {creating ? 'Launching...' : 'Launch Mission'}
            </button>
          </form>

          <div className="bg-slate-900/40 border border-slate-800 rounded-xl overflow-hidden shadow-lg">
            <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-100">Missions</h2>
              {isLoading && <span className="text-xs text-slate-500">loading...</span>}
              {isError && <span className="text-xs text-rose-400">error</span>}
            </div>
            <div className="divide-y divide-slate-800 max-h-[420px] overflow-y-auto">
              {missions.map((mission) => (
                <button
                  key={mission.id}
                  onClick={() => setSelectedMissionId(mission.id)}
                  className={`w-full text-left px-4 py-3 transition hover:bg-slate-800/60 ${
                    mission.id === selectedMissionId ? 'bg-slate-800/80 border-l-2 border-primary' : ''
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-slate-100">{mission.goal.slice(0, 60)}...</span>
                    <span
                      className={`text-xs uppercase tracking-wide ${
                        mission.status === 'completed'
                          ? 'text-emerald-400'
                          : mission.status === 'failed'
                          ? 'text-rose-400'
                          : 'text-amber-300'
                      }`}
                    >
                      {mission.status}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 mt-1">
                    {new Date(mission.updatedAt).toLocaleTimeString()} · {mission.agentCount} agents
                  </p>
                </button>
              ))}
              {!missions.length && (
                <p className="text-center text-sm text-slate-500 py-8">No missions yet. Launch one above.</p>
              )}
            </div>
          </div>
        </section>

        <section className="col-span-12 md:col-span-8 space-y-6">
          {selectedMission ? (
            <MissionDetail mission={selectedMission} feedEvents={feedEvents} />
          ) : (
            <div className="h-full flex items-center justify-center text-slate-500 border border-dashed border-slate-800 rounded-xl">
              <p>Select a mission to inspect its orchestrated sub-agents and outputs.</p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function MissionDetail({ mission, feedEvents }: { mission: Mission; feedEvents: FeedEvent[] }) {
  const relevantEvents = feedEvents.filter((event) => {
    const missionId = event.payload?.missionId || event.payload?.mission?.id;
    if (missionId) {
      return missionId === mission.id;
    }
    return !missionId;
  });

  return (
    <div className="bg-slate-900/40 border border-slate-800 rounded-xl shadow-lg overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-800">
        <h2 className="text-xl font-semibold text-slate-100">Mission Overview</h2>
        <p className="text-sm text-slate-400 mt-2 whitespace-pre-line">{mission.goal}</p>
        {mission.summary && (
          <p className="text-sm text-slate-300 mt-3">
            <span className="font-semibold text-slate-200">Summary:</span> {mission.summary}
          </p>
        )}
        {mission.error && <p className="text-sm text-rose-400 mt-3">Error: {mission.error}</p>}
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-4 divide-y xl:divide-y-0 xl:divide-x divide-slate-800">
        <div className="xl:col-span-1 max-h-[320px] overflow-y-auto">
          <FeedPanel events={relevantEvents} />
        </div>
        <div className="xl:col-span-3 divide-y divide-slate-800">
          {mission.agents.map((agent) => (
            <article key={agent.id} className="p-6 hover:bg-slate-900/60 transition">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-lg font-semibold text-accent">{agent.name}</h3>
                  <p className="text-sm text-slate-400">{agent.role}</p>
                </div>
                <span
                  className={`px-3 py-1 rounded-full text-xs font-semibold ${
                    agent.status === 'completed'
                      ? 'bg-emerald-500/20 text-emerald-300'
                      : agent.status === 'failed'
                      ? 'bg-rose-500/20 text-rose-300'
                      : 'bg-amber-500/20 text-amber-200'
                  }`}
                >
                  {agent.status}
                </span>
              </div>
              <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm text-slate-400">
                <div>
                  <span className="uppercase text-xs text-slate-500 block">Expertise</span>
                  <p className="font-medium text-slate-200 whitespace-pre-line">{agent.expertise}</p>
                </div>
                <div>
                  <span className="uppercase text-xs text-slate-500 block">Objective</span>
                  <p className="text-slate-200">{agent.objective}</p>
                </div>
              </div>
              <div className="mt-4 text-sm text-slate-300">
                <span className="uppercase text-xs text-slate-500 block mb-1">Instructions</span>
                <pre className="bg-slate-900/80 border border-slate-800 rounded-lg p-3 whitespace-pre-wrap text-slate-200">
                  {agent.instructions}
                </pre>
              </div>
              {agent.result?.summary && (
                <div className="mt-4 text-sm text-slate-200">
                  <span className="uppercase text-xs text-slate-500 block mb-1">Result</span>
                  <div className="bg-slate-900/80 border border-slate-800 rounded-lg p-3 whitespace-pre-wrap">
                    {agent.result.summary}
                  </div>
                </div>
              )}
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}

function FeedPanel({ events }: { events: FeedEvent[] }) {
  if (!events.length) {
    return (
      <div className="p-4 text-sm text-slate-500">
        Waiting for orchestration events...
      </div>
    );
  }

  return (
    <ol className="divide-y divide-slate-800 text-sm">
      {events.slice(0, 50).map((event) => {
        const missionId = event.payload?.missionId || event.payload?.mission?.id;
        const label = event.type.replace(/[:_]/g, ' ');
        return (
          <li key={`${event.type}-${event.receivedAt}-${missionId || 'global'}`} className="p-3">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-slate-200">{label}</span>
              <span className="text-xs text-slate-500">
                {new Date(event.receivedAt).toLocaleTimeString()}
              </span>
            </div>
            {missionId && (
              <p className="text-xs text-slate-500">mission: {missionId.slice(0, 8)}…</p>
            )}
            {event.payload?.agent && (
              <p className="text-xs text-slate-500">agent: {event.payload.agent.name}</p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
