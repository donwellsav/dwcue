const pendingActions = new Map<string, Promise<boolean>>();

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