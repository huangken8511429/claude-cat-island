import { useState } from "react";
import { PermissionConfig } from "../types";
import ConfirmDialog from "./ConfirmDialog";

interface Props {
  permissions: PermissionConfig | null;
  onToggleSkipDangerous: (enabled: boolean) => void;
  onToggleAutoApprove: (enabled: boolean) => void;
}

export default function PermissionPanel({
  permissions,
  onToggleSkipDangerous,
  onToggleAutoApprove,
}: Props) {
  const [showConfirm, setShowConfirm] = useState(false);
  if (!permissions) {
    return (
      <div className="panel permission-panel">
        <h2 className="panel-title">PERMISSIONS</h2>
        <p className="empty-state">Loading...</p>
      </div>
    );
  }

  return (
    <div className="panel permission-panel">
      <h2 className="panel-title">PERMISSIONS</h2>

      <div className="permission-toggles">
        <div className="permission-row">
          <div className="permission-info">
            <div className="permission-name">Skip Dangerous Mode</div>
            <div className="permission-desc">
              跳過危險模式確認提示
            </div>
          </div>
          <label className="pixel-toggle">
            <input
              type="checkbox"
              checked={permissions.skipDangerousMode}
              onChange={(e) => onToggleSkipDangerous(e.target.checked)}
            />
            <span className="toggle-track">
              <span className="toggle-thumb" />
            </span>
          </label>
        </div>

        <div className="permission-row">
          <div className="permission-info">
            <div className="permission-name">Auto Approve All</div>
            <div className="permission-desc">
              自動批准所有工具請求（bypass permission）
            </div>
          </div>
          <label className="pixel-toggle">
            <input
              type="checkbox"
              checked={permissions.autoApproveAll}
              onChange={(e) => onToggleAutoApprove(e.target.checked)}
            />
            <span className="toggle-track">
              <span className="toggle-thumb" />
            </span>
          </label>
        </div>
      </div>

      <div className="hooks-section">
        <h3 className="sub-title">ACTIVE HOOKS</h3>
        <div className="hook-tags">
          {permissions.currentHooks.map((hook) => (
            <span key={hook} className="hook-tag">
              {hook}
            </span>
          ))}
        </div>
      </div>

      <div className="permission-presets">
        <h3 className="sub-title">PRESETS</h3>
        <div className="preset-buttons">
          <button
            className="pixel-btn preset-trust"
            onClick={() => setShowConfirm(true)}
          >
            FULL TRUST
          </button>
          <button
            className="pixel-btn preset-careful"
            onClick={() => {
              onToggleSkipDangerous(false);
              onToggleAutoApprove(false);
            }}
          >
            CAREFUL
          </button>
        </div>
      </div>

      {showConfirm && (
        <ConfirmDialog
          title="ENABLE FULL TRUST?"
          message="This will skip dangerous mode confirmation and auto-approve all tool requests. Claude will have unrestricted access."
          confirmLabel="ENABLE"
          cancelLabel="CANCEL"
          onConfirm={() => {
            onToggleSkipDangerous(true);
            onToggleAutoApprove(true);
            setShowConfirm(false);
          }}
          onCancel={() => setShowConfirm(false)}
        />
      )}
    </div>
  );
}
