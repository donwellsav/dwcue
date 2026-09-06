import type { AudioItem, GroupItem, Project } from '../types/project';
import type {
  OneShotMutableFields,
  OneShotMutationIdentity,
  OneShotMutationRequest,
  OneShotMutationResult,
} from '../types/oneShotMutation';
import { sameOneShotMutationIdentity } from '../types/oneShotMutation';
import { MAX_ONE_SHOT_SLOTS, getOneShotEndMode, getOneShotPlaybackMode, setOneShotEndMode, setOneShotPlaybackMode } from './oneShots';

export interface OneShotMutationDocument {
  project: Project;
  cartOnlyItems: Map<string, AudioItem>;
}

const fieldNames: Record<keyof OneShotMutableFields, true> = {
  displayName: true, color: true, volume: true, playFade: true, stopFade: true, duckLevel: true,
  duckFadeIn: true, duckFadeOut: true, deviceOverride: true, retrigger: true, autoDisarm: true,
  hotkey: true, playbackMode: true, endMode: true,
};
const finiteBetween = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const plainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const validHotkey = (value: unknown): boolean => value === null || (plainObject(value)
  && typeof value.key === 'string'
  && value.key.length > 0
  && ['ctrl', 'shift', 'alt', 'meta'].every(key => value[key] === undefined || typeof value[key] === 'boolean'));
const validSlot = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < MAX_ONE_SHOT_SLOTS;
const validIndex = (value: unknown): value is number[] => Array.isArray(value)
  && value.every(part => typeof part === 'number' && Number.isSafeInteger(part) && part >= 0);
const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every(key => keys.includes(key));

const validEndBehavior = (value: unknown): boolean => {
  if (!plainObject(value) || typeof value.action !== 'string') return false;
  if (value.action === 'goto-item') {
    return hasOnlyKeys(value, ['action', 'targetUuid'])
      && typeof value.targetUuid === 'string' && value.targetUuid.trim().length > 0;
  }
  if (value.action === 'goto-index') {
    return hasOnlyKeys(value, ['action', 'targetIndex']) && validIndex(value.targetIndex);
  }
  return ['nothing', 'next', 'loop'].includes(value.action) && hasOnlyKeys(value, ['action']);
};

const validStartBehavior = (value: unknown): boolean => {
  if (!plainObject(value) || typeof value.action !== 'string') return false;
  if (value.action === 'play-item') {
    return hasOnlyKeys(value, ['action', 'targetUuid'])
      && typeof value.targetUuid === 'string' && value.targetUuid.trim().length > 0;
  }
  if (value.action === 'play-index') {
    return hasOnlyKeys(value, ['action', 'targetIndex']) && validIndex(value.targetIndex);
  }
  return ['nothing', 'play-next'].includes(value.action) && hasOnlyKeys(value, ['action']);
};

const validCustomActionType = (value: unknown): boolean => {
  if (!plainObject(value) || typeof value.type !== 'string') return false;
  if (value.type === 'play-item') {
    return hasOnlyKeys(value, ['type', 'uuid'])
      && typeof value.uuid === 'string' && value.uuid.trim().length > 0;
  }
  if (value.type === 'play-index') {
    return hasOnlyKeys(value, ['type', 'index']) && validIndex(value.index);
  }
  if (value.type === 'stop-all') return hasOnlyKeys(value, ['type']);
  if (value.type !== 'http-request' || !hasOnlyKeys(value, ['type', 'request']) || !plainObject(value.request)) {
    return false;
  }
  const request = value.request;
  return hasOnlyKeys(request, ['method', 'url', 'contentType', 'body'])
    && ['GET', 'POST', 'PUT', 'DELETE'].includes(String(request.method))
    && typeof request.url === 'string' && request.url.trim().length > 0
    && (request.contentType === 'form' || request.contentType === 'json')
    && (request.body === undefined || plainObject(request.body));
};

const validDuckingBehavior = (value: unknown): boolean => plainObject(value)
  && ['stop-all', 'no-ducking', 'duck-others'].includes(String(value.mode))
  && (value.duckLevel === undefined || finiteBetween(value.duckLevel, 0, 1))
  && (value.duckFadeIn === undefined || finiteBetween(value.duckFadeIn, 0, 10))
  && (value.duckFadeOut === undefined || finiteBetween(value.duckFadeOut, 0, 10));

const validOneShotSettings = (value: unknown, slot: number): boolean => plainObject(value)
  && value.order === slot
  && (value.retrigger === 'restart' || value.retrigger === 'ignore')
  && (value.hotkey === undefined || validHotkey(value.hotkey))
  && (value.sourceUuid === undefined || (typeof value.sourceUuid === 'string' && value.sourceUuid.trim().length > 0))
  && (value.armed === undefined || typeof value.armed === 'boolean')
  && (value.autoDisarm === undefined || typeof value.autoDisarm === 'boolean');

const validAudioReplacement = (value: unknown, slot: number): value is AudioItem => {
  if (!plainObject(value) || value.type !== 'audio') return false;
  return typeof value.uuid === 'string' && value.uuid.trim().length > 0
    && validIndex(value.index)
    && typeof value.mediaFileName === 'string'
    && typeof value.mediaPath === 'string'
    && (value.mediaServerPath === undefined || typeof value.mediaServerPath === 'string')
    && [value.mediaPath, value.mediaServerPath].some(path => typeof path === 'string' && path.trim().length > 0)
    && typeof value.waveformPath === 'string'
    && finiteBetween(value.duration, 0, Number.MAX_SAFE_INTEGER)
    && finiteBetween(value.inPoint, 0, Number.MAX_SAFE_INTEGER)
    && finiteBetween(value.outPoint, 0, Number.MAX_SAFE_INTEGER)
    && finiteBetween(value.fadeOutDuration, 0, 30)
    && finiteBetween(value.playFade, 0, 30)
    && finiteBetween(value.stopFade, 0, 30)
    && finiteBetween(value.crossFade, 0, 30)
    && validateFields({ displayName: value.displayName, color: value.color, volume: value.volume })
    && validEndBehavior(value.endBehavior)
    && validStartBehavior(value.startBehavior)
    && Array.isArray(value.customActions)
    && value.customActions.every(customAction => plainObject(customAction)
      && hasOnlyKeys(customAction, ['timePoint', 'action'])
      && finiteBetween(customAction.timePoint, 0, Number.MAX_SAFE_INTEGER)
      && validCustomActionType(customAction.action))
    && validDuckingBehavior(value.duckingBehavior)
    && validOneShotSettings(value.oneShot, slot);
};

const validateFields = (value: unknown): value is OneShotMutableFields => {
  if (!plainObject(value) || Object.keys(value).some(key => !(key in fieldNames))) return false;
  return Object.entries(value).every(([key, field]) => {
    switch (key as keyof OneShotMutableFields) {
      case 'displayName': return typeof field === 'string' && field.trim().length > 0 && field.length <= 512;
      case 'color': return typeof field === 'string' && /^#[0-9a-f]{6}$/i.test(field);
      case 'volume': return finiteBetween(field, 0, 4);
      case 'playFade': case 'stopFade': return finiteBetween(field, 0, 30);
      case 'duckLevel': return finiteBetween(field, 0, 1);
      case 'duckFadeIn': case 'duckFadeOut': return finiteBetween(field, 0, 10);
      case 'deviceOverride': return field === null || (typeof field === 'string' && field.length <= 512);
      case 'retrigger': return field === 'restart' || field === 'ignore';
      case 'autoDisarm': return typeof field === 'boolean';
      case 'hotkey': return validHotkey(field);
      case 'playbackMode': return field === 'overlay' || field === 'duck' || field === 'replace';
      case 'endMode': return field === 'stop' || field === 'loop';
    }
  });
};

const findItem = (items: readonly (AudioItem | GroupItem)[], uuid: string): AudioItem | GroupItem | null => {
  for (const item of items) {
    if (item.uuid === uuid) return item;
    if (item.type === 'group') {
      const nested = findItem(item.children, uuid);
      if (nested) return nested;
    }
  }
  return null;
};

const findOneShot = (document: OneShotMutationDocument, uuid: string): AudioItem | null => {
  const item = document.cartOnlyItems.get(uuid) ?? findItem(document.project.items, uuid);
  return item?.type === 'audio' && item.oneShot ? item : null;
};

const findOneShotByOrder = (document: OneShotMutationDocument, order: number): AudioItem | null => {
  for (const item of document.cartOnlyItems.values()) {
    if (item.oneShot?.order === order) return item;
  }
  const visit = (items: readonly (AudioItem | GroupItem)[]): AudioItem | null => {
    for (const item of items) {
      if (item.type === 'audio' && item.oneShot?.order === order) return item;
      if (item.type === 'group') {
        const nested = visit(item.children);
        if (nested) return nested;
      }
    }
    return null;
  };
  return visit(document.project.items);
};

const applyFields = (item: AudioItem, fields: OneShotMutableFields): void => {
  if ('displayName' in fields) item.displayName = fields.displayName!;
  if ('color' in fields) item.color = fields.color!;
  if ('volume' in fields) item.volume = fields.volume!;
  if ('playFade' in fields) item.playFade = fields.playFade!;
  if ('stopFade' in fields) item.stopFade = fields.stopFade!;
  if ('duckLevel' in fields) item.duckingBehavior.duckLevel = fields.duckLevel!;
  if ('duckFadeIn' in fields) item.duckingBehavior.duckFadeIn = fields.duckFadeIn!;
  if ('duckFadeOut' in fields) item.duckingBehavior.duckFadeOut = fields.duckFadeOut!;
  if ('deviceOverride' in fields) {
    const routedItem = item as AudioItem & { deviceOverride?: string };
    if (fields.deviceOverride) routedItem.deviceOverride = fields.deviceOverride;
    else delete routedItem.deviceOverride;
  }
  if ('retrigger' in fields) item.oneShot!.retrigger = fields.retrigger!;
  if ('autoDisarm' in fields) {
    if (fields.autoDisarm) delete item.oneShot!.autoDisarm;
    else item.oneShot!.autoDisarm = false;
  }
  if ('hotkey' in fields) {
    if (fields.hotkey) item.oneShot!.hotkey = structuredClone(fields.hotkey);
    else delete item.oneShot!.hotkey;
  }
  if ('playbackMode' in fields && fields.playbackMode !== getOneShotPlaybackMode(item)) {
    setOneShotPlaybackMode(item, fields.playbackMode!);
  }
  if ('endMode' in fields && fields.endMode !== getOneShotEndMode(item)) {
    setOneShotEndMode(item, fields.endMode!);
  }
};

export const applyOneShotMutation = (
  document: OneShotMutationDocument,
  request: OneShotMutationRequest,
): { accepted: boolean; error?: string } => {
  if (!plainObject(request.payload)) return { accepted: false, error: 'Invalid mutation payload.' };
  if (request.kind === 'disarm-all') {
    if (Object.keys(request.payload).length !== 0) return { accepted: false, error: 'Invalid disarm payload.' };
    for (const item of [...document.project.items, ...document.cartOnlyItems.values()]) {
      const visit = (candidate: AudioItem | GroupItem) => {
        if (candidate.type === 'group') candidate.children.forEach(visit);
        else if (candidate.oneShot?.armed) delete candidate.oneShot.armed;
      };
      visit(item);
    }
    return { accepted: true };
  }

  if (request.kind === 'replace-slot') {
    const { slot, item: replacement } = request.payload;
    if (Object.keys(request.payload).some(key => key !== 'slot' && key !== 'item')
      || !validSlot(slot) || !validAudioReplacement(replacement, slot)) {
      return { accepted: false, error: 'Invalid replacement payload.' };
    }
    if (document.cartOnlyItems.has(replacement.uuid) || findItem(document.project.items, replacement.uuid)) {
      return { accepted: false, error: 'Replacement cue already exists.' };
    }
    const copy = structuredClone(replacement);
    const prior = findOneShotByOrder(document, slot);
    if (prior && document.cartOnlyItems.has(prior.uuid)) document.cartOnlyItems.delete(prior.uuid);
    else if (prior) delete prior.oneShot;
    document.cartOnlyItems.set(copy.uuid, copy);
    return { accepted: true };
  }

  const item = request.itemUuid ? findOneShot(document, request.itemUuid) : null;
  if (!item) return { accepted: false, error: 'One Shot no longer exists.' };

  switch (request.kind) {
    case 'set-fields':
      if (Object.keys(request.payload).some(key => key !== 'fields') || !validateFields(request.payload.fields)) {
        return { accepted: false, error: 'Invalid One Shot fields.' };
      }
      applyFields(item, request.payload.fields);
      return { accepted: true };
    case 'set-armed':
      if (Object.keys(request.payload).some(key => key !== 'armed') || typeof request.payload.armed !== 'boolean') {
        return { accepted: false, error: 'Invalid arm payload.' };
      }
      if (request.payload.armed) item.oneShot!.armed = true;
      else delete item.oneShot!.armed;
      return { accepted: true };
    case 'move-slot': {
      const { sourceSlot, targetSlot } = request.payload;
      if (Object.keys(request.payload).some(key => key !== 'sourceSlot' && key !== 'targetSlot')
        || !validSlot(sourceSlot) || !validSlot(targetSlot)
        || item.oneShot!.order !== sourceSlot) return { accepted: false, error: 'Invalid slot move.' };
      const target = findOneShotByOrder(document, targetSlot);
      item.oneShot!.order = targetSlot;
      if (target?.oneShot) target.oneShot.order = sourceSlot;
      return { accepted: true };
    }
    case 'remove-slot':
      if (Object.keys(request.payload).length !== 0) return { accepted: false, error: 'Invalid remove payload.' };
      if (document.cartOnlyItems.has(item.uuid)) document.cartOnlyItems.delete(item.uuid);
      else delete item.oneShot;
      return { accepted: true };
  }
};

export const enforceOneShotDisarmFences = (
  project: Project,
  cartOnlyItems: Iterable<AudioItem>,
  fences: ReadonlySet<string>,
): void => {
  const visit = (item: AudioItem | GroupItem): void => {
    if (item.type === 'group') {
      item.children.forEach(visit);
    } else if (fences.has(item.uuid) && item.oneShot?.armed) {
      delete item.oneShot.armed;
    }
  };
  project.items.forEach(visit);
  for (const item of cartOnlyItems) visit(item);
};

export interface DetachedMutationBridge {
  requestOneShotMutation(request: OneShotMutationRequest): Promise<OneShotMutationResult>;
}

type WithoutMutationIdentity<Request> = Request extends unknown
  ? Omit<Request, 'requestId' | 'identity'>
  : never;
export type OneShotMutationDraft = WithoutMutationIdentity<OneShotMutationRequest>;
export type DetachedOneShotMutationClient = (
  request: OneShotMutationDraft,
) => Promise<OneShotMutationResult>;
const toIpcDto = <Value>(value: Value): Value => JSON.parse(JSON.stringify(value)) as Value;

export const createDetachedOneShotMutationClient = (
  bridge: DetachedMutationBridge,
  getIdentity: () => OneShotMutationIdentity | null,
): DetachedOneShotMutationClient => {
  let tail = Promise.resolve<unknown>(undefined);
  return (request): Promise<OneShotMutationResult> => {
    const identity = getIdentity();
    const requestId = crypto.randomUUID();
    if (!identity) return Promise.resolve({
      requestId,
      identity: { projectPath: '', projectEpoch: -1, ownerSessionId: '' },
      accepted: false,
      persisted: false,
      error: 'The main project window is unavailable.',
    });
    const complete = async () => {
      const mutation = toIpcDto({ ...request, requestId, identity } as OneShotMutationRequest);
      const result = await bridge.requestOneShotMutation(mutation);
      if (result.requestId !== requestId || !sameOneShotMutationIdentity(result.identity, identity)) {
        return { requestId, identity, accepted: false, persisted: false, error: 'Stale mutation response.' };
      }
      return result;
    };
    const result = tail.then(complete, complete);
    tail = result;
    return result;
  };
};
