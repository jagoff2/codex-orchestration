import { useEffect, useRef } from 'react';

type Handler = (event: MessageEvent<string>) => void;

export function useOrchestratorFeed(handler: Handler | null) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!handlerRef.current) return undefined;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/ws`;
    const socket = new WebSocket(url);

    const onMessage = (event: MessageEvent<string>) => {
      handlerRef.current?.(event);
    };
    socket.addEventListener('message', onMessage);

    return () => {
      socket.removeEventListener('message', onMessage);
      socket.close();
    };
  }, [handlerRef]);
}
