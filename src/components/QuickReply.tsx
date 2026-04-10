import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Props {
  pid: number;
  onSent?: () => void;
}

export default function QuickReply({ pid, onSent }: Props) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;

    setSending(true);
    try {
      const result = await invoke<string>("copy_and_jump", { pid, text: trimmed });
      setText("");
      if (result === "clipboard_only") {
        setHint("Copied! Cmd+V Enter in terminal");
        setTimeout(() => setHint(null), 3000);
      }
      onSent?.();
    } catch (err) {
      console.error("QuickReply failed:", err);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="quick-reply" onClick={(e) => e.stopPropagation()}>
      <input
        ref={inputRef}
        className="quick-reply-input"
        type="text"
        placeholder="Reply to Claude..."
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            handleSend();
          }
          e.stopPropagation();
        }}
        disabled={sending}
      />
      <button
        className="quick-reply-btn"
        onClick={handleSend}
        disabled={!text.trim() || sending}
      >
        {sending ? "..." : "SEND"}
      </button>
      {hint && <span className="quick-reply-hint">{hint}</span>}
    </div>
  );
}
