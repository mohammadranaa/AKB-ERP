import { useEffect, useState } from 'react';
import { api } from './api';

/** Public facts about this installation (e.g. whether it is a practice system). Fetched once. */
export interface Info { trial: boolean }
let cached: Promise<Info> | null = null;
const load = () => (cached ??= api.get<Info>('/api/info').catch(() => ({ trial: false })));

export function useInfo(): Info | null {
  const [info, setInfo] = useState<Info | null>(null);
  useEffect(() => { void load().then(setInfo); }, []);
  return info;
}

export const TRIAL_TEXT = "Trial system with practice data. Don't enter real customers, amounts or bank details.";
