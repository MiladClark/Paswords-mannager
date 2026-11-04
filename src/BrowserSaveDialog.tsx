import { useState, type FormEvent } from "react";
import { Dialog, SecretInput, type Translate } from "./ui";

export interface BrowserSave {
  id: string;
  origin: string;
  title: string;
  username: string;
  kind: "save" | "update";
  accounts: { id: string; title: string; username: string }[];
  expiresAt: number;
}
export default function BrowserSaveDialog({
  request,
  t,
  busy,
  error,
  onDecide,
}: {
  request: BrowserSave;
  t: Translate;
  busy: boolean;
  error: string;
  onDecide: (
    allow: boolean,
    secret: string,
    target: string,
    username: string,
    title: string,
  ) => Promise<void>;
}) {
  const [secret, setSecret] = useState("");
  const [username, setUsername] = useState(request.username);
  const [title, setTitle] = useState(request.title);
  const [target, setTarget] = useState(
    request.accounts.length === 1 ? request.accounts[0].id : "",
  );
  const updating = request.kind === "update";
  const cancel = () => void onDecide(false, "", "", "", "");
  async function submit(event: FormEvent) {
    event.preventDefault();
    await onDecide(true, secret, target, username, title);
    setSecret("");
  }
  return (
    <Dialog
      title={t(updating ? "browserUpdateTitle" : "browserSaveTitle")}
      busy={busy}
      onClose={cancel}
    >
      <form className="dialog-form" onSubmit={(event) => void submit(event)}>
        <div className="browser-fill-target">
          <strong dir="ltr">{request.origin}</strong>
        </div>
        <p>{t(updating ? "browserUpdateHint" : "browserSaveHint")}</p>
        {updating ? (
          <>
            <div className="form-field">
              <label htmlFor="browser-update-account">
                {t("browserUpdateAccount")}
              </label>
              <select
                id="browser-update-account"
                value={target}
                required
                disabled={busy}
                onChange={(event) => setTarget(event.target.value)}
              >
                {request.accounts.length > 1 && (
                  <option value="">{t("browserChooseAccount")}</option>
                )}
                {request.accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.title} · {account.username}
                  </option>
                ))}
              </select>
            </div>
          </>
        ) : (
          <>
            <div className="form-field">
              <label htmlFor="browser-save-title">{t("title")}</label>
              <input
                id="browser-save-title"
                value={title}
                required
                maxLength={512}
                disabled={busy}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
            <div className="form-field">
              <label htmlFor="browser-save-username">{t("username")}</label>
              <input
                id="browser-save-username"
                value={username}
                required
                maxLength={2048}
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setUsername(event.target.value)}
              />
            </div>
          </>
        )}
        <SecretInput
          id="browser-save-master"
          label={t("master")}
          value={secret}
          onChange={setSecret}
          t={t}
          autoFocus
        />
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
            onClick={cancel}
          >
            {t("cancel")}
          </button>
          <button
            type="submit"
            className="primary"
            disabled={busy || (updating && !target)}
          >
            {t(updating ? "browserUpdateAction" : "browserSaveAction")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
