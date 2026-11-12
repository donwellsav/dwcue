import { canReplaceHeaderWarning, headerWarningDuration, type HeaderWarning, type HeaderWarningSeverity } from '../utils/headerWarnings';
import { useUiMode } from './useUiMode';

let expiration: ReturnType<typeof setTimeout> | undefined;

export function useHeaderWarnings() {
  const warning = useState<HeaderWarning | null>('headerWarning', () => null);
  const silenceRemaining = useState<number | null>('headerWarning.silenceRemaining', () => null);
  const { headerWarningTiming } = useUiMode();

  function showHeaderWarning(message: string, severity: HeaderWarningSeverity = 'advisory') {
    if (!import.meta.client || !message.trim()) return;
    const next = { message, severity };
    if (!canReplaceHeaderWarning(warning.value, next)) return;
    warning.value = next;
    clearTimeout(expiration);
    const seconds = headerWarningDuration(headerWarningTiming.value, silenceRemaining.value);
    expiration = setTimeout(() => { warning.value = null; }, seconds * 1000);
  }

  return { warning, silenceRemaining, showHeaderWarning };
}
