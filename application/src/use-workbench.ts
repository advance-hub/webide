import { useCallback, useEffect, useRef, useState } from 'react';

import {
  APIError,
  type Catalog,
  type Config,
  type MachineOverview,
  type Project,
  type User,
  type Workspace,
  busyStates,
  request,
} from './domain';

export function useRoute() {
  const read = () => new URL(window.location.hash.slice(1) || '/dashboard', window.location.origin);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const update = () => setRoute(read());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  const navigate = (to: string, replace = false) => {
    if (replace) {
      window.history.replaceState(null, '', `#${to}`);
      setRoute(read());
    } else {
      window.location.hash = to;
    }
  };
  const filter = (key: string, value: string) => {
    const next = new URL(route);
    if (value) {
      next.searchParams.set(key, value);
    } else {
      next.searchParams.delete(key);
    }
    navigate(next.pathname + next.search, true);
  };
  return { route, navigate, filter };
}

export function useWorkbench() {
  const [config, setConfig] = useState<Config>();
  const [catalog, setCatalog] = useState<Catalog>();
  const [user, setUser] = useState<User>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [machine, setMachine] = useState<MachineOverview>();
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [checked, setChecked] = useState<{ status: 'connected' | 'failed'; at: string }>();
  const locked = useRef(false);
  const inFlight = useRef<Promise<void>>();
  const accountGeneration = useRef(0);

  const refresh = useCallback(() => {
    if (inFlight.current) {
      return inFlight.current;
    }
    const generation = accountGeneration.current;
    const promise = Promise.all([
      request<Project[]>('/projects'),
      request<Workspace[]>('/workspaces'),
      request<MachineOverview>('/machine'),
    ])
      .then(([p, w, m]) => {
        if (generation !== accountGeneration.current) {
          return;
        }
        setProjects(p.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
        setWorkspaces(w.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
        setMachine(m);
      })
      .finally(() => {
        if (inFlight.current === promise) {
          inFlight.current = undefined;
        }
      });
    inFlight.current = promise;
    return promise;
  }, []);
  const boot = useCallback(async () => {
    accountGeneration.current += 1;
    inFlight.current = undefined;
    setLoading(true);
    setError('');
    setProjects([]);
    setWorkspaces([]);
    setMachine(undefined);
    setCatalog(undefined);
    setUser(undefined);
    try {
      setConfig(await request<Config>('/config'));
      const me = await request<User>('/me');
      setUser(me);
      await Promise.all([refresh(), request<Catalog>('/catalog').then(setCatalog)]);
      return true;
    } catch (e) {
      if (e instanceof APIError && e.status === 401) {
        setUser(undefined);
      } else {
        setError((e as Error).message);
      }
      return false;
    } finally {
      setLoading(false);
    }
  }, [refresh]);
  useEffect(() => {
    void boot();
  }, [boot]);
  const act = async (key: string, fn: () => Promise<void>) => {
    if (locked.current) {
      return false;
    }
    locked.current = true;
    setPending(key);
    setError('');
    setNotice('');
    try {
      await fn();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      locked.current = false;
      setPending('');
    }
  };
  const preparing =
    machine?.job?.status === 'running' ||
    projects.some((p) => busyStates.has(p.status) || busyStates.has(p.baselineStatus || '')) ||
    workspaces.some(
      (w) => busyStates.has(w.status) || ['queued', 'running', 'cancelling'].includes(w.mavenJob?.status || ''),
    );
  useEffect(() => {
    if (!user || !preparing) {
      return;
    }
    let active = true;
    let polling = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (document.hidden || !active || polling) {
        return;
      }
      polling = true;
      try {
        await refresh();
      } catch (e) {
        if (active) {
          setError((e as Error).message);
        }
      }
      polling = false;
      if (active && !document.hidden) {
        timer = setTimeout(poll, 2500);
      }
    };
    const visibility = () => {
      clearTimeout(timer);
      if (!document.hidden) {
        void poll();
      }
    };
    timer = setTimeout(poll, 2500);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      active = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [user, preparing, refresh]);
  const probe = () =>
    act('probe', async () => {
      try {
        await request('/runtime');
        setChecked({ status: 'connected', at: new Date().toISOString() });
      } catch (e) {
        setChecked({ status: 'failed', at: new Date().toISOString() });
        throw e;
      }
    });
  const enter = (w: Workspace, target: 'enter' | 'preview' = 'enter', port?: number) => {
    if (locked.current) {
      return Promise.resolve(false);
    }
    // Reserve the tab during the click, before the asynchronous ticket request.
    const tab = window.open('about:blank', '_blank');
    if (!tab) {
      setError('浏览器拦截了新标签页，请允许此站点打开弹出窗口后重试。');
      return Promise.resolve(false);
    }
    tab.opener = null;
    tab.document.title = '正在连接 OpenSumi';
    tab.document.body.textContent = '正在连接个人工作区，请稍候…';
    tab.document.body.style.cssText = 'font:14px "PingFang SC",sans-serif;padding:32px;color:#646a73';
    return act(w.id, async () => {
      try {
        const result = await request<{ url: string }>(`/workspaces/${w.id}/${target}`, port ? { port } : {});
        const url = new URL(result.url);
        if (!['http:', 'https:'].includes(url.protocol)) {
          throw new Error('IDE 入口地址无效');
        }
        if (tab.closed) {
          throw new Error('IDE 标签页已关闭，请重新进入。');
        }
        tab.location.replace(url.href);
      } catch (e) {
        tab.close();
        await refresh();
        throw e;
      }
    });
  };
  return {
    config,
    catalog,
    user,
    projects,
    workspaces,
    machine,
    loading,
    pending,
    error,
    notice,
    checked,
    act,
    boot,
    refresh,
    probe,
    enter,
    reloadConfig: async () => setConfig(await request<Config>('/config')),
    setError,
    setNotice,
  };
}
export type Workbench = ReturnType<typeof useWorkbench>;
export type Navigation = (to: string, replace?: boolean) => void;
