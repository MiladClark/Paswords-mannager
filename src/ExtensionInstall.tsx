import MotionPresence from "./MotionPresence";
import { useEffect, useRef, useState } from "react";
import { Copy, FolderOpen, Globe } from "@phosphor-icons/react";
import { call } from "./api";
import { en } from "./i18n";
import { Dialog, type Translate } from "./ui";

type Browser = "chrome" | "edge" | "brave";
type Prepared = {
  directory: string;
  browserInstalled: boolean;
  preview: boolean;
};

export default function ExtensionInstall({ t }: { t: Translate }) {
  const [browser, setBrowser] = useState<Browser | null>(null);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const name =
    browser === "chrome" ? "Chrome" : browser === "edge" ? "Edge" : "Brave";
  const page =
    browser === "chrome"
      ? "chrome://extensions"
      : browser === "edge"
        ? "edge://extensions"
        : "brave://extensions";
  function fail(cause: unknown) {
    const key = String(cause);
    setError(t(key in en ? (key as keyof typeof en) : "browserUnavailable"));
  }
  async function prepare(value: Browser) {
    const ticket = ++generation.current;
    setBrowser(value);
    setPrepared(null);
    setWorking(true);
    setError("");
    setCopied("");
    try {
      const result = await call<Prepared>("prepare_browser_extension", {
        browser: value,
      });
      if (ticket === generation.current) setPrepared(result);
    } catch (cause) {
      if (ticket === generation.current) fail(cause);
    } finally {
      if (ticket === generation.current) setWorking(false);
    }
  }
  async function action(command: string, which?: "page" | "directory") {
    const ticket = generation.current;
    setError("");
    try {
      await call(command, { browser, which });
      if (ticket === generation.current && which) setCopied(which);
    } catch (cause) {
      if (ticket === generation.current) fail(cause);
    }
  }
  return (
    <section className="extension-install" aria-label={t("installExtension")}>
      <span>{t("installExtension")}</span>
      <div className="extension-install-buttons">
        {(["chrome", "edge", "brave"] as const).map((value) => (
          <button
            key={value}
            type="button"
            className="secondary"
            onClick={() => void prepare(value)}
          >
            <Globe size={15} />
            {value === "chrome"
              ? "Chrome"
              : value === "edge"
                ? "Edge"
                : "Brave"}
          </button>
        ))}
      </div>
      <MotionPresence>
        {browser && (
          <Dialog
            title={`${t("installExtension")} · ${name}`}
            onClose={() => {
              generation.current++;
              setBrowser(null);
            }}
          >
            <div className="dialog-form extension-setup">
              {working && <p role="status">{t("extensionPreparing")}</p>}
              {prepared && (
                <>
                  <p>
                    {t(
                      prepared.preview
                        ? "extensionPreview"
                        : "extensionPrepared",
                    )}
                  </p>
                  {!prepared.browserInstalled && (
                    <p className="form-error">{t("extensionBrowserMissing")}</p>
                  )}
                  <p>{t("extensionManualConsent")}</p>
                  <ol className="extension-setup-steps">
                    <li>
                      <p>{t("extensionOpenPage")}</p>
                      <div className="extension-path">
                        <code dir="ltr">{page}</code>
                        <button
                          type="button"
                          className="secondary"
                          disabled={prepared.preview}
                          onClick={() =>
                            void action("copy_extension_setup_value", "page")
                          }
                        >
                          <Copy size={14} />
                          {t("copy")}
                        </button>
                      </div>
                    </li>
                    <li>{t("extensionLoadFolder")}</li>
                  </ol>
                  {prepared.directory && (
                    <div className="extension-path">
                      <code dir="ltr">{prepared.directory}</code>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() =>
                          void action("copy_extension_setup_value", "directory")
                        }
                      >
                        <Copy size={14} />
                        {t("copy")}
                      </button>
                    </div>
                  )}
                  <p className="field-help">{t("extensionPairNext")}</p>
                  {copied && <p role="status">{t("copied")}</p>}
                </>
              )}
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
              <div className="dialog-footer">
                {error && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={working}
                    onClick={() => void prepare(browser)}
                  >
                    {t("extensionRetry")}
                  </button>
                )}
                {prepared && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={prepared.preview}
                    onClick={() => void action("open_extension_folder")}
                  >
                    <FolderOpen size={16} />
                    {t("extensionOpenFolder")}
                  </button>
                )}
                <button
                  type="button"
                  className="primary"
                  onClick={() => {
                    generation.current++;
                    setBrowser(null);
                  }}
                >
                  {t("close")}
                </button>
              </div>
            </div>
          </Dialog>
        )}
      </MotionPresence>
    </section>
  );
}
