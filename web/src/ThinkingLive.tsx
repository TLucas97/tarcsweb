import { useEffect, useState } from 'react';

export default function ThinkingClock({ since }: { since: number }) {
  const elapsed = () => Math.max(0, Math.floor((Date.now() - since) / 1000));
  const [seconds, setSeconds] = useState(elapsed);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      clearTimeout(timer);
      if (document.hidden) return;
      const ms = Math.max(0, Date.now() - since);
      setSeconds(Math.floor(ms / 1000));
      timer = setTimeout(tick, 1000 - ms % 1000);
    };
    tick();
    document.addEventListener('visibilitychange', tick);
    return () => {
      document.removeEventListener('visibilitychange', tick);
      clearTimeout(timer);
    };
  }, [since]);
  return <>{seconds}s</>;
}
