import type { QuickPlayMutationIdentity, QuickPlayMutationResult } from '~/types/quickPlayMutation';
import type { DetachedQuickPlayMutationClient, QuickPlayMutationDraft } from '~/utils/quickPlayMutation';
import { createDetachedQuickPlayMutationClient } from '../utils/quickPlayMutation';

let client: DetachedQuickPlayMutationClient | null = null;

export const useDetachedQuickPlayMutation = () => {
  const identity = useState<QuickPlayMutationIdentity | null>('quickPlays.detachedProjectIdentity', () => null);
  const error = useState<string>('quickPlays.detachedMutationError', () => '');
  const isDetached = import.meta.client
    && new URLSearchParams(window.location.search).get('quickPlayWindow') === '1';

  if (isDetached && !client) {
    client = createDetachedQuickPlayMutationClient(window.electronAPI, () => identity.value);
  }

  const mutate = async (
    request: QuickPlayMutationDraft,
  ): Promise<QuickPlayMutationResult | null> => {
    if (!isDetached || !client) return null;
    let result: QuickPlayMutationResult;
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

  return { isDetached, identity, error, mutate };
};
