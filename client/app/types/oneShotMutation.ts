import type { AudioItem, CartSlotKeyBinding } from './project';

export interface OneShotMutationIdentity {
  projectPath: string;
  projectEpoch: number;
  ownerSessionId: string;
}

export type OneShotMutableFields = {
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
  autoDisarm?: boolean;
  hotkey?: CartSlotKeyBinding | null;
  playbackMode?: 'overlay' | 'duck' | 'replace';
  endMode?: 'stop' | 'loop';
};

interface MutationBase {
  requestId: string;
  identity: OneShotMutationIdentity;
}

export type OneShotMutationRequest = MutationBase & (
  | { kind: 'set-fields'; itemUuid: string; payload: { fields: OneShotMutableFields } }
  | { kind: 'set-armed'; itemUuid: string; payload: { armed: boolean } }
  | { kind: 'disarm-all'; payload: Record<string, never> }
  | { kind: 'move-slot'; itemUuid: string; payload: { sourceSlot: number; targetSlot: number } }
  | { kind: 'remove-slot'; itemUuid: string; payload: Record<string, never> }
  | { kind: 'replace-slot'; itemUuid?: string; payload: { slot: number; item: AudioItem } }
);

export interface OneShotMutationResult {
  requestId: string;
  identity: OneShotMutationIdentity;
  accepted: boolean;
  persisted: boolean;
  error?: string;
}

export interface OneShotProjectEnvelope {
  project: import('./project').Project | null;
  identity: OneShotMutationIdentity | null;
}

export const sameOneShotMutationIdentity = (
  left: OneShotMutationIdentity | null | undefined,
  right: OneShotMutationIdentity | null | undefined,
): boolean => !!left && !!right
  && left.projectPath === right.projectPath
  && left.projectEpoch === right.projectEpoch
  && left.ownerSessionId === right.ownerSessionId;
