import type { OneShotMutationIdentity, OneShotMutationResult } from '~/types/oneShotMutation';
import type { DetachedOneShotMutationClient, OneShotMutationDraft } from '~/utils/oneShotMutation';
import { createDetachedOneShotMutationClient } from '../utils/oneShotMutation';

let client: DetachedOneShotMutationClient | null = null;

export const useDetachedOneShotMutation = () => {
  const identity = useState<OneShotMutationIdentity | null>('oneShots.detachedProjectIdentity', () => null);
  const disarmFences = useState<Set<string>>('oneShots.detachedDisarmFences', () => new Set());
  const error = useState<string>('oneShots.detachedMutationError', () => '');
  const isDetached = import.meta.client
    && new URLSearchParams(window.location.search).get('cartWindow') === '1';

  if (isDetached && !client) {
    client = createDetachedOneShotMutationClient(window.electronAPI, () => identity.value);
  }

  const mutate = async (
    request: OneShotMutationDraft,
  ): Promise<OneShotMutationResult | null> => {
    if (!isDetached || !client) return null;
    let result: OneShotMutationResult;
    try {
      result = await client(request);
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
      return {
        requestId: '',
        identity: identity.value ?? { projectPath: '', projectEpoch: -1, ownerSessionId: '' },
        accepted: false,
        persisted: false,
        error: error.value,
      };
    }
    error.value = result.error ?? '';
    return result;
  };

  return {
    isDetached, identity, error, mutate,
    fenceDisarmed(uuid: string) { disarmFences.value.add(uuid); },
    releaseDisarmFence(uuid: string) { disarmFences.value.delete(uuid); },
  };
};
