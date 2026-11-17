const KEY = 'recent-commands';
const MAX = 12;

/** 최근에 실행한 커맨드. 앞이 가장 최근이다. */
export async function loadRecentCommands(): Promise<string[]> {
  const got = await browser.storage.local.get(KEY);
  const list = got[KEY];
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
}

export async function rememberCommand(command: string): Promise<string[]> {
  const cur = await loadRecentCommands();
  const next = [command, ...cur.filter((item) => item !== command)].slice(0, MAX);
  await browser.storage.local.set({ [KEY]: next });
  return next;
}
