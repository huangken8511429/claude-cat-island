import { useState } from "react";
import { SkillInfo } from "../types";
import SkillDetail from "./SkillDetail";

interface Props {
  skills: SkillInfo[];
  onDetailChange?: (inDetail: boolean) => void;
}

function getCategoryColor(name: string): string {
  if (name.startsWith("aibdd")) return "#ffcc40";
  if (name.startsWith("clarify")) return "#55bbff";
  if (name.startsWith("ora")) return "#ff77aa";
  if (name.startsWith("learned")) return "#5ae05a";
  return "#bb88ff";
}

export default function SkillPanel({ skills, onDetailChange }: Props) {
  const [selected, setSelected] = useState<string | null>(null);

  if (selected) {
    return (
      <SkillDetail
        skillName={selected}
        onBack={() => { setSelected(null); onDetailChange?.(false); }}
      />
    );
  }

  const openSkill = (name: string) => {
    setSelected(name);
    onDetailChange?.(true);
  };

  return (
    <div className="panel skill-panel">
      <h2 className="panel-title">
        SKILLS <span className="badge">{skills.length}</span>
      </h2>
      <div className="skill-list">
        {skills.length === 0 && (
          <div className="empty-state">
            <div className="skeleton skeleton-row" style={{ width: "100%" }} />
            <div className="skeleton skeleton-row" style={{ width: "100%" }} />
            <div className="skeleton skeleton-row" style={{ width: "100%" }} />
          </div>
        )}
        {skills.map((skill) => (
          <div
            key={skill.name}
            className="skill-item"
            role="button"
            tabIndex={0}
            onClick={() => openSkill(skill.name)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openSkill(skill.name);
              }
            }}
          >
            <span className="skill-dot" style={{ background: getCategoryColor(skill.name) }} aria-hidden="true" />
            <div className="skill-info">
              <div
                className="skill-name"
                style={{ borderLeftColor: getCategoryColor(skill.name) }}
              >
                /{skill.name}
              </div>
              {skill.description && (
                <div className="skill-desc">{skill.description}</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
