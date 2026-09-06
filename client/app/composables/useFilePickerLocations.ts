import { computed, ref, toValue, type MaybeRefOrGetter } from 'vue';

const STORAGE_PREFIX = 'liveplay.filePickerLocations.v1:';

export interface FilePickerLocationState {
  favorites: string[];
  lastFolders: Record<string, string>;
}

export interface FilePickerLocationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function normalizeServerEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, '');
  if (!trimmed) return 'http://127.0.0.1:4480';
  try {
    const url = new URL(trimmed);
    return url.origin + url.pathname.replace(/\/+$/, '');
  } catch {
    return trimmed.replace(/[?#].*$/u, '');
  }
}

export function normalizePickerPath(value: string): string {
  if (!value) return '';
  if (/^\/+$/u.test(value)) return '/';
  if (/^[A-Za-z]:[\\/]*$/u.test(value)) {
    return value.slice(0, 2) + (value.includes('\\') ? '\\' : '/');
  }
  return value.replace(/[\\/]+$/u, '');
}

export function pickerParentPath(value: string): string {
  const normalized = normalizePickerPath(value);
  if (!normalized || normalized === '/' || /^[A-Za-z]:[\\/]$/u.test(normalized)) {
    return normalized;
  }
  const separatorIndex = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  if (separatorIndex < 0) return '';
  if (separatorIndex === 0) return '/';
  if (separatorIndex === 2 && /^[A-Za-z]:/u.test(normalized)) {
    return normalized.slice(0, 3);
  }
  return normalized.slice(0, separatorIndex);
}

export function pickerLocationContext(mode: 'file' | 'directory', filter: string): string {
  const normalizedFilter = filter
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join(',');
  return `${mode}:${normalizedFilter || 'all'}`;
}

export function resolvePickerStartPath(
  explicitPath: string | undefined,
  rememberedPath: string | undefined,
  fallbackPath = '',
): string {
  if (explicitPath !== undefined) return explicitPath;
  if (rememberedPath !== undefined) return rememberedPath;
  return fallbackPath;
}

function storageKey(endpoint: string): string {
  return STORAGE_PREFIX + encodeURIComponent(normalizeServerEndpoint(endpoint));
}

function emptyState(): FilePickerLocationState {
  return { favorites: [], lastFolders: {} };
}

function decodeState(raw: string | null): FilePickerLocationState {
  if (!raw) return emptyState();
  try {
    const parsed = JSON.parse(raw) as Partial<FilePickerLocationState>;
    const favorites: string[] = [];
    if (Array.isArray(parsed.favorites)) {
      for (const value of parsed.favorites) {
        if (typeof value !== 'string') continue;
        const path = normalizePickerPath(value);
        if (path && !favorites.includes(path)) favorites.push(path);
      }
    }

    const lastFolders: Record<string, string> = {};
    if (parsed.lastFolders && typeof parsed.lastFolders === 'object' && !Array.isArray(parsed.lastFolders)) {
      for (const [context, value] of Object.entries(parsed.lastFolders)) {
        if (typeof value === 'string') lastFolders[context] = normalizePickerPath(value);
      }
    }
    return { favorites, lastFolders };
  } catch {
    return emptyState();
  }
}

export function createFilePickerLocationStore(storage: FilePickerLocationStorage | null) {
  const read = (endpoint: string): FilePickerLocationState => {
    if (!storage) return emptyState();
    try {
      return decodeState(storage.getItem(storageKey(endpoint)));
    } catch {
      return emptyState();
    }
  };

  const write = (endpoint: string, state: FilePickerLocationState): void => {
    if (!storage) return;
    try {
      storage.setItem(storageKey(endpoint), JSON.stringify(state));
    } catch {
      // localStorage can be unavailable or full. Picking must still work.
    }
  };

  return {
    read,
    rememberFolder(endpoint: string, context: string, folder: string): void {
      const state = read(endpoint);
      state.lastFolders[context] = normalizePickerPath(folder);
      write(endpoint, state);
    },
    addFavorite(endpoint: string, folder: string): void {
      const path = normalizePickerPath(folder);
      if (!path) return;
      const state = read(endpoint);
      if (!state.favorites.includes(path)) {
        state.favorites.push(path);
        write(endpoint, state);
      }
    },
    removeFavorite(endpoint: string, folder: string): void {
      const path = normalizePickerPath(folder);
      const state = read(endpoint);
      const favorites = state.favorites.filter(value => value !== path);
      if (favorites.length !== state.favorites.length) {
        write(endpoint, { ...state, favorites });
      }
    },
  };
}

const persistenceRevision = ref(0);

function browserStorage(): FilePickerLocationStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function useFilePickerLocations(
  endpoint: MaybeRefOrGetter<string>,
  context: MaybeRefOrGetter<string>,
) {
  const store = createFilePickerLocationStore(browserStorage());
  const endpointValue = computed(() => normalizeServerEndpoint(toValue(endpoint)));
  const contextValue = computed(() => toValue(context));
  const state = computed(() => {
    persistenceRevision.value;
    return store.read(endpointValue.value);
  });

  const favorites = computed(() => state.value.favorites);
  const lastFolder = computed(() => {
    const folders = state.value.lastFolders;
    return Object.prototype.hasOwnProperty.call(folders, contextValue.value)
      ? folders[contextValue.value]
      : undefined;
  });

  const refresh = () => { persistenceRevision.value++; };

  return {
    favorites,
    lastFolder,
    rememberFolder(folder: string) {
      store.rememberFolder(endpointValue.value, contextValue.value, folder);
      refresh();
    },
    addFavorite(folder: string) {
      store.addFavorite(endpointValue.value, folder);
      refresh();
    },
    removeFavorite(folder: string) {
      store.removeFavorite(endpointValue.value, folder);
      refresh();
    },
  };
}
