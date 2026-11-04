import {
  createContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

export const ExitingContext = createContext(false);

// Sensitive overlays belong inside the unlocked phase so a lock discards them immediately.
export default function MotionPresence({ children }: { children: ReactNode }) {
  const last = useRef(children);
  const [finished, setFinished] = useState(!children);
  const present = Boolean(children);
  useLayoutEffect(() => {
    if (present) {
      last.current = children;
      setFinished(false);
      return;
    }
    const finish = () => {
      last.current = null;
      setFinished(true);
    };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      finish();
      return;
    }
    const timer = window.setTimeout(finish, 140);
    return () => window.clearTimeout(timer);
  }, [children, present]);
  if (!present && finished) return null;
  return (
    <ExitingContext.Provider value={!present}>
      <div
        className="motion-presence"
        data-exiting={!present || undefined}
        inert={!present}
      >
        {present ? children : last.current}
      </div>
    </ExitingContext.Provider>
  );
}
