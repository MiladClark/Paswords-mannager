import { createContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import "./startup.css";

export const StartupReadyContext = createContext(true);

/** A short brand introduction, independent of loading progress. */
export function StartupShell({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(false), 1250);
    return () => clearTimeout(timer);
  }, []);
  return (
    <>
      <div
        className={visible ? "devtune-app devtune-entering" : "devtune-app"}
        inert={visible || undefined}
      >
        <StartupReadyContext value={!visible}>{children}</StartupReadyContext>
      </div>
      {visible && (
        <div className="devtune-splash" aria-hidden="true">
          <div className="devtune-signature">
            <img
              src="/branding/devtune-linear.svg"
              width="100"
              height="59"
              alt=""
            />
            <span>Crafted by Devtune Ltd</span>
          </div>
        </div>
      )}
    </>
  );
}
