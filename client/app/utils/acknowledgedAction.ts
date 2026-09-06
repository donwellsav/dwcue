const pendingActions = new Map<string, Promise<boolean>>();
const exclusivePendingActions = new Map<string, {
  intent: string;
  promise: Promise<boolean>;
}>();

export const runPendingAction = (
  key: string,
  command: () => Promise<boolean>,
): Promise<boolean> => {
  const pending = pendingActions.get(key);
  if (pending) return pending;

  let guarded: Promise<boolean>;
  guarded = Promise.resolve()
    .then(command)
    .finally(() => {
      if (pendingActions.get(key) === guarded) pendingActions.delete(key);
    });
  pendingActions.set(key, guarded);
  return guarded;
};

/**
 * Runs one acknowledged intent at a time for a control family. Repeated input
 * for the same intent shares the in-flight acknowledgement; a different intent
 * is rejected until the first command settles instead of racing it.
 */
export const runExclusivePendingAction = (
  family: string,
  intent: string,
  command: () => Promise<boolean>,
): Promise<boolean> => {
  const pending = exclusivePendingActions.get(family);
  if (pending) {
    return pending.intent === intent ? pending.promise : Promise.resolve(false);
  }

  let guarded: Promise<boolean>;
  guarded = Promise.resolve()
    .then(command)
    .finally(() => {
      if (exclusivePendingActions.get(family)?.promise === guarded) {
        exclusivePendingActions.delete(family);
      }
    });
  exclusivePendingActions.set(family, { intent, promise: guarded });
  return guarded;
};

export const oneShotFireActionKey = (itemUuid: string): string =>
  `one-shot-fire:${itemUuid}`;

export const runAcknowledgedAction = (
  key: string,
  command: () => Promise<boolean>,
  onSuccess: () => void,
): Promise<boolean> => runPendingAction(key, async () => {
  const accepted = await command();
  if (accepted) onSuccess();
  return accepted;
});