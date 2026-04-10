import { useEffect, useRef } from "react";

interface Props {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  title,
  message,
  confirmLabel = "CONFIRM",
  cancelLabel = "CANCEL",
  onConfirm,
  onCancel,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onCancel]);

  return (
    <div
      className="confirm-overlay"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      aria-describedby="confirm-body"
      onClick={onCancel}
    >
      <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
        <div id="confirm-title" className="confirm-title">{title}</div>
        <div id="confirm-body" className="confirm-body">{message}</div>
        <div className="confirm-actions">
          <button
            ref={cancelRef}
            className="pixel-btn"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            className="pixel-btn preset-trust"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
