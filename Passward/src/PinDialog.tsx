import { useState, useEffect, type FormEvent } from "react";
import { CircleNotch } from "@phosphor-icons/react";
import { Dialog, SecretInput, type Translate } from "./ui";
import type { EntryView, PinInfo } from "./api";
export interface PinTask {
  kind: "setup" | "remove" | "item";
  id?: string;
  title?: string;
}
interface Props {
  task: PinTask;
  pin: PinInfo;
  t: Translate;
  busy: boolean;
  error: string;
  run: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  onBusy: (b: boolean) => void;
  onError: (e: unknown) => void;
  onClose: () => void;
  onDone: (view?: EntryView) => void | Promise<void>;
}
export default function PinDialog({
  task,
  pin,
  t,
  busy,
  error,
  run,
  onBusy,
  onError,
  onClose,
  onDone,
}: Props) {
  const [master, setMaster] = useState("");
  const [secret, setSecret] = useState("");
  const [confirm, setConfirm] = useState("");
  const [method, setMethod] = useState<"master" | "pin">(
    pin.available && !pin.blocked ? "pin" : "master",
  );
  useEffect(() => {
    if (pin.blocked || !pin.available) {
      setMethod("master");
      setSecret("");
    }
  }, [pin.blocked, pin.available]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (task.kind === "setup" && secret !== confirm) {
      onError("mismatch");
      return;
    }
    onBusy(true);
    try {
      if (task.kind === "setup") {
        await run("configure_pin", { master, pin: secret });
        await onDone();
      } else if (task.kind === "remove") {
        await run("remove_pin", { master });
        await onDone();
      } else {
        const view = await run<EntryView>("authorize_entry", {
          id: task.id,
          secret,
          method,
        });
        await onDone(view);
      }
    } catch (cause) {
      onError(cause);
    } finally {
      onBusy(false);
    }
  }
  return (
    <Dialog
      title={t(
        task.kind === "setup"
          ? pin.enabled
            ? "changePin"
            : "setupPin"
          : task.kind === "remove"
            ? "removePin"
            : "unlockItem",
      )}
      busy={busy}
      onClose={onClose}
    >
      <form className="dialog-form" onSubmit={submit}>
        {task.kind === "item" ? (
          <>
            <div className="confirmation-object" dir="auto">
              {task.title}
            </div>
            <p>{t("itemPinHint")}</p>
            <div
              className="auth-method"
              role="group"
              aria-label={t("unlockItem")}
            >
              <button
                type="button"
                aria-pressed={method === "pin"}
                disabled={!pin.available || pin.blocked || busy}
                onClick={() => {
                  setMethod("pin");
                  setSecret("");
                }}
              >
                {t("pin")}
              </button>
              <button
                type="button"
                aria-pressed={method === "master"}
                disabled={busy}
                onClick={() => {
                  setMethod("master");
                  setSecret("");
                }}
              >
                {t("useMaster")}
              </button>
            </div>
            <SecretInput
              id="item-secret"
              label={t(method === "pin" ? "pin" : "master")}
              value={secret}
              onChange={setSecret}
              t={t}
              pin={method === "pin"}
              autoFocus
            />
          </>
        ) : (
          <>
            <p>{t(task.kind === "remove" ? "pinRemoveHint" : "pinHelp")}</p>
            <SecretInput
              id="pin-master"
              label={t("currentMaster")}
              value={master}
              onChange={setMaster}
              t={t}
              autoFocus
            />
            {task.kind === "setup" && (
              <>
                <SecretInput
                  id="new-device-pin"
                  label={t("pin")}
                  value={secret}
                  onChange={setSecret}
                  t={t}
                  pin
                />
                <SecretInput
                  id="confirm-device-pin"
                  label={t("confirmPin")}
                  value={confirm}
                  onChange={setConfirm}
                  t={t}
                  pin
                />
              </>
            )}
          </>
        )}
        {task.kind !== "remove" && (
          <p className="field-help">{t("pinPolicy")}</p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-footer">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={onClose}
          >
            {t("cancel")}
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy && <CircleNotch className="spin" />}
            {t(
              task.kind === "setup"
                ? "savePin"
                : task.kind === "remove"
                  ? "removePin"
                  : "unlockItem",
            )}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
