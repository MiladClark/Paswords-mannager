import { useState, type FormEvent } from "react";
import { CircleNotch } from "@phosphor-icons/react";
import type { Entry } from "./api";
import type { Key as TextKey, Language } from "./i18n";
import { Dialog, SecretInput, type Translate } from "./ui";
import DeleteDialog from "./DeleteDialog";
export type Modal = "master" | "import" | "delete" | "discard";
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
  onMessage: (key: TextKey, suffix?: string) => void;
  onImported: () => void;
  onDelete: (
    confirmation: string,
    confirmationRepeat: string,
    master: string,
  ) => Promise<void>;
  onDiscard: () => void;
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
  onMessage,
  onImported,
  onDelete,
  onDiscard,
}: Props) {
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
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
  if (modal === "delete" && entry)
    return (
      <DeleteDialog
        entry={entry}
        t={t}
        busy={busy}
        error={error}
        onBusy={onBusy}
        onError={onError}
        onClose={onClose}
        onDelete={onDelete}
      />
    );
  const title: TextKey =
    modal === "master"
      ? "changeMaster"
      : modal === "import"
        ? "importTitle"
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
