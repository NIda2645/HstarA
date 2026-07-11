import "./styles/index.css";
import { useEffect, useState } from "react";
import { RotateCcw, X } from "lucide-react";
import { DirectorDeskShell } from "./app/layout/DirectorDeskShell";
import { DirectorCanvas } from "./editor/canvas/DirectorCanvas";
import { initDirectorDeskHostBridge, postDirectorDeskClose, postDirectorDeskReady } from "./editor/io/hostBridge";
import { useDirectorStore } from "./editor/store/directorStore";

function isEditableShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;

  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export default function App() {
  const [isResetDialogOpen, setIsResetDialogOpen] = useState(false);
  const viewMode = useDirectorStore((state) => state.viewMode);
  const setViewMode = useDirectorStore((state) => state.setViewMode);
  const resetCurrentScene = useDirectorStore((state) => state.resetCurrentScene);

  useEffect(() => {
    initDirectorDeskHostBridge();
    postDirectorDeskReady();
  }, []);

  function handleClose() {
    postDirectorDeskClose();
  }

  function handleConfirmReset() {
    resetCurrentScene();
    setIsResetDialogOpen(false);
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || isEditableShortcutTarget(event.target)) return;
      if (!event.metaKey && !event.ctrlKey) return;

      const key = event.key.toLowerCase();
      if (key === "c") {
        event.preventDefault();
        useDirectorStore.getState().copySelectedObjects();
        return;
      }

      if (key === "v") {
        event.preventDefault();
        useDirectorStore.getState().pasteClipboardObjects();
        return;
      }

      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        useDirectorStore.getState().undo();
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div className="top-bar-left">
          <div className="top-bar-title-wrap">
            <h1 className="top-bar-title">3D导演台</h1>
            <button
              className="top-bar-reset-button"
              type="button"
              aria-label="复位3D导演台"
              title="复位3D导演台"
              onClick={() => setIsResetDialogOpen(true)}
            >
              <RotateCcw aria-hidden="true" size={15} strokeWidth={1.9} />
            </button>
          </div>
        </div>
        <div className="top-bar-center">
          <div className="mode-toggle ui-segmented" role="group" aria-label="视角切换">
            <button
              className={`mode-toggle-button ui-segmented-item ${viewMode === "director" ? "ui-segmented-item-active" : ""}`}
              aria-pressed={viewMode === "director"}
              type="button"
              onClick={() => setViewMode("director")}
            >
              导演视角
            </button>
            <button
              className={`mode-toggle-button ui-segmented-item ${viewMode === "camera" ? "ui-segmented-item-active" : ""}`}
              aria-pressed={viewMode === "camera"}
              type="button"
              onClick={() => setViewMode("camera")}
            >
              机位视角
            </button>
          </div>
        </div>
        <div className="top-bar-actions">
          <button
            className="top-bar-action-button"
            type="button"
            aria-label="关闭"
            title="关闭"
            onClick={handleClose}
          >
            <X aria-hidden="true" size={16} strokeWidth={1.8} />
          </button>
        </div>
      </header>
      <DirectorDeskShell>
        <DirectorCanvas />
      </DirectorDeskShell>
      {isResetDialogOpen ? (
        <div className="director-reset-dialog-backdrop" role="presentation">
          <section
            className="director-reset-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="director-reset-dialog-title"
          >
            <h2 id="director-reset-dialog-title">复位3D导演台</h2>
            <p>是否确认重置3D导演台？</p>
            <div className="director-reset-dialog-actions">
              <button
                className="director-reset-dialog-button"
                type="button"
                onClick={() => setIsResetDialogOpen(false)}
              >
                取消
              </button>
              <button
                className="director-reset-dialog-button director-reset-dialog-confirm"
                type="button"
                onClick={handleConfirmReset}
              >
                确认
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
