import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CircleNotch,
  DownloadSimple,
  Key,
  ShieldCheck,
  Shuffle,
  UploadSimple,
} from "@phosphor-icons/react";
import type { Entry, PinInfo } from "./api";
import type { Key as TextKey, Language } from "./i18n";
import { Dialog, IconButton, SecretInput, type Translate } from "./ui";
import BrowserSettings from "./BrowserSettings";
export type Modal =
  "settings" | "master" | "import" | "generator" | "delete" | "discard";
interface Props {
  modal: Modal;
  t: Translate;
  language: Language;
  busy: boolean;
  error: string;
  entry: Entry | null;
  run: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  onBusy: (value: boolean) => void;
  onError: (cause: unknown) => void;
  onClose: () => void;
  onModal: (value: Modal) => void;
  onMessage: (key: TextKey, suffix?: string) => void;
  onImported: () => void;
  onPassword: (value: string) => void;
  onDelete: () => void;
  onDiscard: () => void;
  pin: PinInfo;
  onPin: (mode: "setup" | "remove") => void;
}
export default function VaultDialogs({
  modal,
  t,
  language,
  busy,
  error,
  entry,
  run,
  onBusy,
  onError,
  onClose,
  onModal,
  onMessage,
  onImported,
  onPassword,
  onDelete,
  onDiscard,
  pin,
  onPin,
}: Props) {
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [generated, setGenerated] = useState("");
  const [length, setLength] = useState(24);
  const [symbols, setSymbols] = useState(true);
  const generation = useRef(0);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      generation.current++;
    };
  }, []);
  async function regenerate(size = length, useSymbols = symbols) {
    const request = ++generation.current;
    try {
      const value = await run<string>("generate_password", {
        length: size,
        symbols: useSymbols,
      });
      if (active.current && request === generation.current) setGenerated(value);
    } catch (cause) {
      if (active.current) onError(cause);
    }
  }
  useEffect(() => {
    if (modal === "generator") void regenerate();
  }, []); // The dialog is keyed by modal and remounted per opening.
  async function exportBackup() {
    onBusy(true);
    try {
      if (await run<boolean>("export_backup", { language }))
        onMessage("backupSaved");
    } catch (cause) {
      onError(cause);
    } finally {
      onBusy(false);
    }
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (modal === "master" && password !== confirm) {
      onError("mismatch");
      return;
    }
    onBusy(true);
    try {
      if (modal === "master") {
        await run("change_master", { current, password });
        onImported();
        onMessage("changed");
      } else {
        const count = await run<number | null>("import_backup", {
          password,
          language,
        });
        if (count === null) return;
        onImported();
        onMessage("imported", ` · ${count} ${t("items")}`);
      }
      // Parent close is allowed here even while its pending state is true.
      onModalClose();
    } catch (cause) {
      onError(cause);
    } finally {
      onBusy(false);
    }
  }
  function onModalClose() {
    onBusy(false);
    onClose();
  }
  const title: TextKey =
    modal === "settings"
      ? "settingsTitle"
      : modal === "master"
        ? "changeMaster"
        : modal === "import"
          ? "importTitle"
          : modal === "generator"
            ? "generator"
            : modal === "delete"
              ? "deleteTitle"
              : "unsavedTitle";
  const errorContent = error && (
    <p className="form-error" role="alert">
      {error}
    </p>
  );
  return (
    <Dialog title={t(title)} onClose={onClose} busy={busy}>
      {modal === "settings" && (
        <div className="settings-content">
          <section>
            <h3>
              <ShieldCheck size={17} />
              {t("privacyTitle")}
            </h3>
            <p>{t("privacyBody")}</p>
            <dl className="settings-facts">
              <div>
                <dt>{t("autoLock")}</dt>
                <dd>{t("autoLockValue")}</dd>
              </div>
              <div>
                <dt>{t("clipboard")}</dt>
                <dd>{t("clipboardValue")}</dd>
              </div>
            </dl>
            <p className="field-help">{t("lockHidden")}</p>
          </section>
          <section>
            <h3>
              <Key size={17} />
              {t("devicePin")}
            </h3>
            <p>{t("pinHelp")}</p>
            <div className="settings-buttons">
              <button
                type="button"
                className="secondary"
                onClick={() => onPin("setup")}
              >
                {t(pin.enabled ? "changePin" : "setupPin")}
              </button>
              {pin.enabled && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => onPin("remove")}
                >
                  {t("removePin")}
                </button>
              )}
            </div>
          </section>
          <BrowserSettings t={t} run={run} onError={onError} />
          <section>
            <h3>{t("backups")}</h3>
            <p>{t("backupBody")}</p>
            <div className="settings-buttons">
              <button
                type="button"
                className="secondary"
                onClick={() => void exportBackup()}
                disabled={busy}
              >
                <DownloadSimple size={16} />
                {t("export")}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => onModal("import")}
                disabled={busy}
              >
                <UploadSimple size={16} />
                {t("import")}
              </button>
            </div>
            <p className="field-help">{t("restoreHint")}</p>
          </section>
          <button
            type="button"
            className="settings-link"
            onClick={() => onModal("master")}
            disabled={busy}
          >
            <Key size={17} />
            <span>{t("changeMaster")}</span>
            {language === "fa" ? (
              <ArrowLeft size={15} />
            ) : (
              <ArrowRight size={15} />
            )}
          </button>
          <details className="shortcut-details">
            <summary>{t("shortcuts")}</summary>
            {(
              [
                ["Ctrl N", "shortcutNew"],
                ["Ctrl K", "shortcutSearch"],
                ["Ctrl S", "shortcutSave"],
                ["Ctrl Shift L", "shortcutLock"],
              ] as const
            ).map(([keys, label]) => (
              <div key={keys}>
                <span>{t(label)}</span>
                <kbd>{keys}</kbd>
              </div>
            ))}
          </details>
          {errorContent}
          <p className="early-note">{t("securityNote")}</p>
        </div>
      )}
      {(modal === "master" || modal === "import") && (
        <form onSubmit={submit} className="dialog-form">
          {modal === "master" ? (
            <>
              <SecretInput
                id="current-master"
                label={t("currentMaster")}
                value={current}
                onChange={setCurrent}
                t={t}
                autoFocus
              />
              <SecretInput
                id="new-master"
                label={t("newMaster")}
                value={password}
                onChange={setPassword}
                minLength={12}
                t={t}
              />
              <p className="field-help">{t("masterHint")}</p>
              <SecretInput
                id="confirm-new-master"
                label={t("confirm")}
                value={confirm}
                onChange={setConfirm}
                minLength={12}
                t={t}
              />
            </>
          ) : (
            <>
              <p>{t("importBody")}</p>
              <SecretInput
                id="backup-password"
                label={t("backupPassword")}
                value={password}
                onChange={setPassword}
                t={t}
                autoFocus
              />
            </>
          )}
          {errorContent}
          <div className="dialog-footer">
            <button
              type="button"
              className="secondary"
              onClick={onClose}
              disabled={busy}
            >
              {t("cancel")}
            </button>
            <button type="submit" className="primary" disabled={busy}>
              {busy && <CircleNotch className="spin" />}
              {t(
                busy
                  ? "working"
                  : modal === "master"
                    ? "changeMaster"
                    : "importAction",
              )}
            </button>
          </div>
        </form>
      )}
      {modal === "generator" && (
        <div className="generator-content">
          <div className="generated-password" dir="ltr">
            <code>{generated || "…"}</code>
            <IconButton
              label={t("regenerate")}
              onClick={() => void regenerate()}
            >
              <Shuffle />
            </IconButton>
          </div>
          <label className="range-label" htmlFor="password-length">
            <span>{t("length")}</span>
            <output>{length}</output>
          </label>
          <input
            id="password-length"
            name="length"
            type="range"
            min={12}
            max={64}
            value={length}
            onChange={(e) => {
              const value = Number(e.target.value);
              setLength(value);
              void regenerate(value);
            }}
          />
          <label className="checkbox-label">
            <input
              name="symbols"
              type="checkbox"
              checked={symbols}
              onChange={(e) => {
                setSymbols(e.target.checked);
                void regenerate(length, e.target.checked);
              }}
            />
            {t("symbols")}
          </label>
          <p className="field-help">{t("generateHint")}</p>
          {errorContent}
          <div className="dialog-footer">
            <button type="button" className="secondary" onClick={onClose}>
              {t("cancel")}
            </button>
            <button
              type="button"
              className="primary"
              disabled={!generated}
              onClick={() => {
                onPassword(generated);
                onClose();
              }}
            >
              {t("usePassword")}
            </button>
          </div>
        </div>
      )}
      {modal === "delete" && (
        <div className="dialog-form">
          <p>{t("deleteBody")}</p>
          {entry && (
            <div className="confirmation-object" dir="auto">
              {entry.title}
            </div>
          )}
          {errorContent}
          <div className="dialog-footer">
            <button
              type="button"
              className="secondary"
              onClick={onClose}
              disabled={busy}
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              className="primary danger-fill"
              onClick={onDelete}
              disabled={busy}
            >
              {t("deleteForever")}
            </button>
          </div>
        </div>
      )}
      {modal === "discard" && (
        <div className="dialog-form">
          <p>{t("unsavedBody")}</p>
          <div className="dialog-footer">
            <button type="button" className="secondary" onClick={onClose}>
              {t("cancel")}
            </button>
            <button type="button" className="primary" onClick={onDiscard}>
              {t("discard")}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
