import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, Trash } from "@phosphor-icons/react";
import type { Translate } from "./ui";
import ExtensionInstall from "./ExtensionInstall";
type Connection = { id: string; name: string; createdAt: number };
type Status = {
  installed: boolean;
  available: boolean;
  connections: Connection[];
};
type Run = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
export default function BrowserSettings({
  t,
  run,
  onError,
  disabled = false,
}: {
  t: Translate;
  run: Run;
  onError: (e: unknown) => void;
  disabled?: boolean;
}) {
  const [status, setStatus] = useState<Status>();
  const [pairing, setPairing] = useState<{ code: string; expiresAt: number }>();
  const [working, setWorking] = useState(false);
  const [now, setNow] = useState(Date.now());
  const codeRef = useRef<HTMLDivElement>(null);
  const pairedBefore = useRef(0);
  useLayoutEffect(() => {
    if (pairing) codeRef.current?.scrollIntoView({ block: "nearest" });
  }, [pairing?.code]);
  useEffect(() => {
    if (pairing && (status?.connections.length || 0) > pairedBefore.current)
      setPairing(undefined);
  }, [status?.connections.length, pairing?.code]);
  useEffect(() => {
    let active = true;
    const refresh = () =>
      void run<Status>("browser_connections")
        .then((s) => {
          if (active) setStatus(s);
        })
        .catch((cause) => { if (active) onError(cause); });
    refresh();
    const timer = setInterval(() => {
      setNow(Date.now());
      refresh();
    }, 4000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  async function action(command: string, args?: Record<string, unknown>) {
    setWorking(true);
    try {
      if (command === "begin_browser_pairing") {
        pairedBefore.current = status?.connections.length || 0;
        setPairing(await run(command));
      } else {
        await run(command, args);
        setPairing(undefined);
      }
      setStatus(await run("browser_connections"));
    } catch (error) {
      onError(error);
    } finally {
      setWorking(false);
    }
  }
  return (
    <section className="settings-browser">
      <ExtensionInstall t={t} />
      {!status?.available && status && (
        <p className="form-error">{t("browserUnavailable")}</p>
      )}
      <div className="settings-group">
        <h3>{t("settingsBrowserConnection")}</h3>
        <p className="field-help">{t("browserHelp")}</p>
        <div className="settings-buttons">
          <button
            type="button"
            className="secondary"
            disabled={disabled || working}
            onClick={() => void action("install_browser_bridge")}
          >
            <Link size={16} />
            {t(status?.installed ? "repairBrowserBridge" : "enableBrowserBridge")}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={disabled || working || !status?.installed || !status.available}
            onClick={() => void action("begin_browser_pairing")}
          >
            {t("pairBrowser")}
          </button>
        </div>
      </div>
      {pairing && (
        <div className="browser-pair-code" ref={codeRef} aria-live="polite">
          {pairing.expiresAt * 1000 > now ? (
            <>
              <span>{t("browserEnterCode")}</span>
              <strong dir="ltr">{pairing.code}</strong>
              <small>{t("browserCodeExpiry")}</small>
            </>
          ) : (
            <span>{t("browserPairExpired")}</span>
          )}
        </div>
      )}
      {!!status?.connections.length && (
        <ul className="browser-connections">
          {status.connections.map((c) => (
            <li key={c.id}>
              <span>{c.name}</span>
              <button
                type="button"
                className="text-button"
                disabled={disabled || working}
                onClick={() => void action("revoke_browser", { id: c.id })}
              >
                <Trash size={15} />
                {t("disconnectBrowser")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
