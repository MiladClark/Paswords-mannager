import { useEffect, useState } from "react";
import { Minus, Square, CopySimple, X } from "@phosphor-icons/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { native } from "./api";
import type { Translate } from "./ui";
export default function WindowControls({
  t,
  onClose,
  onError,
}: {
  t: Translate;
  onClose: () => void;
  onError: (e: unknown) => void;
}) {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!native) return;
    let active = true;
    const win = getCurrentWindow();
    const update = () => {
      void win
        .isMaximized()
        .then((value) => {
          if (active) setMaximized(value);
        })
        .catch(onError);
    };
    update();
    const off = win.onResized(update);
    return () => {
      active = false;
      void off.then((fn) => fn());
    };
  }, []);
  return (
    <div className="window-controls" dir="ltr">
      <button
        type="button"
        aria-label={t("minimize")}
        title={t("minimize")}
        onClick={() => {
          if (native) void getCurrentWindow().minimize().catch(onError);
        }}
      >
        <Minus size={15} />
      </button>
      <button
        type="button"
        aria-label={t(maximized ? "restoreWindow" : "maximize")}
        title={t(maximized ? "restoreWindow" : "maximize")}
        onClick={() => {
          if (native) void getCurrentWindow().toggleMaximize().catch(onError);
        }}
      >
        {maximized ? <CopySimple size={14} /> : <Square size={13} />}
      </button>
      <button
        type="button"
        className="window-close"
        aria-label={t("closeWindow")}
        title={t("closeWindow")}
        onClick={onClose}
      >
        <X size={16} />
      </button>
    </div>
  );
}
