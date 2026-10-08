import type { Overview, Thread, Person } from './types.ts';

type Dependencies = {
  call: <T>(method: string) => Promise<T>;
  switchProfile: (mode: string, folder?: string) => Promise<Overview>;
  publish: (status: Overview, threads: Thread[], people: Person[]) => void;
  changed: () => void;
  clearError: () => void;
  onError: (message: string) => void;
};

// A profile switch invalidates requests issued against the previous runtime.
export function createProfileSession(deps: Dependencies) {
  let generation = 0;
  let switching = false;
  let pending: { generation: number; promise: Promise<void> } | undefined;
  function refresh(): Promise<void> {
    if (switching) return Promise.resolve();
    if (pending?.generation === generation) return pending.promise;
    const current = generation;
    const promise = Promise.all([
      deps.call<Overview>('overview'), deps.call<Thread[]>('threads'), deps.call<Person[]>('people'),
    ]).then(([status, threads, people]) => {
      if (current === generation) deps.publish(status, threads, people);
    }).catch(error => {
      if (current === generation) deps.onError(String(error));
    }).finally(() => {
      if (pending?.promise === promise) pending = undefined;
    });
    pending = { generation: current, promise };
    return promise;
  }
  async function switchProfile(mode: string, folder?: string) {
    if (switching) return;
    switching = true;
    generation++;
    try {
      const status = await deps.switchProfile(mode, folder?.trim());
      deps.clearError();
      deps.changed();
      deps.publish(status, [], []);
    } finally {
      switching = false;
    }
    await refresh();
  }
  return { refresh, switchProfile };
}
