import { useCallback, useEffect, useState } from 'react';
import { isStandalone } from './platform';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * Chrome fires `beforeinstallprompt` when the app qualifies, which is the only
 * way to show an install button of our own instead of hoping the user finds the
 * browser menu. Safari never fires it - iOS installs from the Share sheet.
 */
export function useInstallPrompt() {
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(() => isStandalone());

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setPromptEvent(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setPromptEvent(null);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);

    const media = window.matchMedia?.('(display-mode: standalone)');
    const onChange = () => setInstalled(isStandalone());
    media?.addEventListener?.('change', onChange);

    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
      media?.removeEventListener?.('change', onChange);
    };
  }, []);

  const install = useCallback(async () => {
    if (!promptEvent) return false;
    await promptEvent.prompt();
    const choice = await promptEvent.userChoice.catch(() => null);
    setPromptEvent(null);
    if (choice?.outcome === 'accepted') setInstalled(true);
    return choice?.outcome === 'accepted';
  }, [promptEvent]);

  return { canPrompt: Boolean(promptEvent), installed, install };
}
