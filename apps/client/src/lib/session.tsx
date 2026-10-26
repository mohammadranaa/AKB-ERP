import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, hasToken, onAuthLost, setToken } from './api';

export interface Me {
  id: number;
  username: string;
  fullName: string;
  role: string;
  branchIds: number[] | null;
  permissions: string[];
  scope: 'full' | 'limited';
  setupRequired: { changePassword: boolean; enableTotp: boolean } | null;
  businessDate: string;
}

interface SessionValue {
  me: Me | null;
  ready: boolean;
  can: (...perms: string[]) => boolean;
  refresh: () => Promise<void>;
  signIn: (token: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    if (!hasToken()) {
      setMe(null);
      setReady(true);
      return;
    }
    try {
      setMe(await api.get<Me>('/api/auth/me'));
    } catch {
      setMe(null);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return onAuthLost(() => setMe(null));
  }, [refresh]);

  const value: SessionValue = {
    me,
    ready,
    can: (...perms) => !!me && me.scope === 'full' && perms.some((p) => me.permissions.includes(p)),
    refresh,
    signIn: async (token) => {
      setToken(token);
      await refresh();
    },
    signOut: async () => {
      try {
        await api.post('/api/auth/logout');
      } catch {
        /* already signed out */
      }
      setToken(null);
      setMe(null);
    }
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}
