import type { AudioItem, QuickPlaySlotKeyBinding } from './project';

export interface QuickPlayMutationIdentity {
  projectPath: string;
  projectEpoch: number;
  ownerSessionId: string;
}

export type QuickPlayMutableFields = {
  displayName?: string;
  color?: string;
  volume?: number;
  playFade?: number;
  stopFade?: number;
  duckLevel?: number;
  duckFadeIn?: number;
  duckFadeOut?: number;
  deviceOverride?: string | null;
  retrigger?: 'restart' | 'ignore';
  hotkey?: QuickPlaySlotKeyBinding | null;
  playbackMode?: 'overlay' | 'duck' | 'replace';
  endMode?: 'stop' | 'loop' | 'next';
};

interface MutationBase {
  requestId: string;
  identity: QuickPlayMutationIdentity;
}

export type QuickPlayMutationRequest = MutationBase & (
  | { kind: 'set-fields'; itemUuid: string; payload: { fields: QuickPlayMutableFields } }
  | { kind: 'move-slot'; itemUuid: string; payload: { sourceSlot: number; targetSlot: number } }
  | { kind: 'remove-slot'; itemUuid: string; payload: Record<string, never> }
  | { kind: 'replace-slot'; itemUuid?: string; payload: { slot: number; item: AudioItem } }
);

export interface QuickPlayMutationResult {
  requestId: string;
  identity: QuickPlayMutationIdentity;
  accepted: boolean;
  persisted: boolean;
  error?: string;
}

export interface QuickPlayProjectEnvelope {
  project: import('./project').Project | null;
  identity: QuickPlayMutationIdentity | null;
  projectSessionId: string | null;
}

export const sameQuickPlayMutationIdentity = (
  left: QuickPlayMutationIdentity | null | undefined,
  right: QuickPlayMutationIdentity | null | undefined,
): boolean => !!left && !!right
  && left.projectPath === right.projectPath
  && left.projectEpoch === right.projectEpoch
  && left.ownerSessionId === right.ownerSessionId;

export const isNewerQuickPlayProject = (
  incoming: QuickPlayMutationIdentity,
  previous: QuickPlayMutationIdentity | null,
): boolean => !previous || incoming.ownerSessionId !== previous.ownerSessionId
  || incoming.projectEpoch > previous.projectEpoch;
