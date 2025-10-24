import useSWR from 'swr';
import { Mission } from './types';

const fetcher = (url: string) => fetch(url).then((res) => {
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status}`);
  }
  return res.json();
});

export function useMissions() {
  const { data, error, mutate } = useSWR<{ missions: Mission[] }>('/api/missions', fetcher, {
    refreshInterval: 10_000,
  });
  return {
    missions: data?.missions ?? [],
    isLoading: !error && !data,
    isError: error,
    mutate,
  };
}

export async function createMission(goal: string, context?: string) {
  const res = await fetch('/api/missions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ goal, context }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? 'Failed to create mission');
  }
  return res.json() as Promise<{ mission: Mission }>;
}

export async function fetchMission(id: string) {
  const res = await fetch(`/api/missions/${id}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? 'Failed to load mission');
  }
  return res.json() as Promise<{ mission: Mission }>;
}
