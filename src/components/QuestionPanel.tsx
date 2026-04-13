import { useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PendingQuestion } from "../types";

interface Props {
  question: PendingQuestion;
  onAnswered?: () => void;
}

export default function QuestionPanel({ question, onAnswered }: Props) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [sending, setSending] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [showFreeText, setShowFreeText] = useState(false);
  const [freeText, setFreeText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSelect = async (index: number) => {
    console.log("[QuestionPanel] handleSelect called, index=", index, "sending=", sending, "multiSelect=", question.multiSelect);
    if (sending) return;

    if (question.multiSelect) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(index)) next.delete(index);
        else next.add(index);
        return next;
      });
    } else {
      await sendArrowSelect(index);
    }
  };

  const handleConfirmMulti = async () => {
    if (selected.size === 0 || sending) return;
    const sortedIndices = Array.from(selected).sort((a, b) => a - b);
    await sendMultiSelect(sortedIndices, question.options.length);
  };

  const sendMultiSelect = async (selectedIndices: number[], totalOptions: number) => {
    setSending(true);
    try {
      const result = await invoke<string>("select_multi_option", {
        pid: question.pid,
        selectedIndices,
        totalOptions,
      });
      console.log("[QuestionPanel] select_multi_option result=", result);
      if (result === "clipboard_only") {
        setHint("Please confirm in terminal");
        setTimeout(() => setHint(null), 3000);
      }
      onAnswered?.();
    } catch (err) {
      console.error("select_multi_option failed:", err);
      setHint("Failed to send selection");
      setTimeout(() => setHint(null), 3000);
    } finally {
      setSending(false);
    }
  };

  const sendArrowSelect = async (optionIndex: number) => {
    console.log("[QuestionPanel] sendArrowSelect called, optionIndex=", optionIndex, "pid=", question.pid);
    setSending(true);
    try {
      const result = await invoke<string>("select_question_option", {
        pid: question.pid,
        downPresses: optionIndex,
      });
      console.log("[QuestionPanel] select_question_option result=", result);
      if (result === "clipboard_only") {
        setHint("Please select in terminal");
        setTimeout(() => setHint(null), 3000);
      }
      onAnswered?.();
    } catch (err) {
      console.error("select_question_option failed:", err);
      setHint("Failed to send selection");
      setTimeout(() => setHint(null), 3000);
    } finally {
      setSending(false);
    }
  };

  const sendTextAnswer = async (text: string) => {
    if (!text.trim() || sending) return;
    setSending(true);
    try {
      const result = await invoke<string>("answer_question", {
        pid: question.pid,
        answer: text.trim(),
      });
      if (result === "clipboard_only") {
        setHint("Copied! Cmd+V Enter in terminal");
        setTimeout(() => setHint(null), 3000);
      }
      setFreeText("");
      setShowFreeText(false);
      onAnswered?.();
    } catch (err) {
      console.error("answer_question failed:", err);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="question-panel" onClick={(e) => e.stopPropagation()}>
      {question.header && (
        <div className="question-header">{question.header}</div>
      )}
      <div className="question-text">{question.question}</div>
      <div className="question-options">
        {question.options.map((opt, i) => (
          <button
            key={i}
            className={`question-option ${selected.has(i) ? "selected" : ""}`}
            onClick={() => handleSelect(i)}
            disabled={sending}
          >
            <span className="question-option-index">{i + 1}</span>
            <div className="question-option-body">
              <span className="question-option-label">{opt.label}</span>
              {opt.description && (
                <span className="question-option-desc">{opt.description}</span>
              )}
            </div>
          </button>
        ))}
      </div>
      {question.multiSelect && selected.size > 0 && (
        <button
          className="question-confirm"
          onClick={handleConfirmMulti}
          disabled={sending}
        >
          {sending ? "SENDING..." : `CONFIRM (${selected.size})`}
        </button>
      )}
      <div className="question-footer">
        {!showFreeText ? (
          <button
            className="question-freetext-toggle"
            onClick={() => { setShowFreeText(true); setTimeout(() => inputRef.current?.focus(), 50); }}
          >
            TYPE CUSTOM ANSWER
          </button>
        ) : (
          <div className="question-freetext">
            <input
              ref={inputRef}
              className="question-freetext-input"
              type="text"
              placeholder="Type your answer..."
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  sendTextAnswer(freeText);
                }
                if (e.key === "Escape") {
                  setShowFreeText(false);
                  setFreeText("");
                }
                e.stopPropagation();
              }}
              disabled={sending}
            />
            <button
              className="question-freetext-send"
              onClick={() => sendTextAnswer(freeText)}
              disabled={!freeText.trim() || sending}
            >
              {sending ? "..." : "SEND"}
            </button>
          </div>
        )}
      </div>
      {hint && <span className="question-hint">{hint}</span>}
    </div>
  );
}
