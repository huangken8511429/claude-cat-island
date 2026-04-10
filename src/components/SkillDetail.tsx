import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import { SkillDetail as SkillDetailData } from "../types";

interface Props {
  skillName: string;
  onBack: () => void;
}

export default function SkillDetail({ skillName, onBack }: Props) {
  const [data, setData] = useState<SkillDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    invoke<SkillDetailData>("get_skill_detail", { name: skillName })
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [skillName]);

  return (
    <div className="skill-detail">
      <div className="detail-header-compact">
        <button className="back-btn-compact" onClick={onBack} aria-label="Back to skill list">
          ← BACK
        </button>
        <div className="detail-project-compact">/{skillName}</div>
      </div>

      {error && (
        <div className="error-banner" role="alert">
          <span>! {error}</span>
        </div>
      )}

      {!data && !error && (
        <div className="empty-state">
          <div className="skeleton skeleton-row" style={{ width: "100%" }} />
          <div className="skeleton skeleton-row" style={{ width: "80%" }} />
          <div className="skeleton skeleton-row" style={{ width: "90%" }} />
        </div>
      )}

      {data && (
        <div className="skill-detail-body">
          {data.frontmatter.length > 0 && (
            <dl className="skill-frontmatter">
              {data.frontmatter.map(([k, v]) => (
                <div className="skill-fm-row" key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          )}
          <div className="skill-markdown">
            <ReactMarkdown>{data.body}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}
