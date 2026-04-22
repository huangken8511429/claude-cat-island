import { useState, useCallback } from "react";
import { PermissionConfig, ApprovalRule, RuleMatchResult } from "../types";
import ConfirmDialog from "./ConfirmDialog";

const TOOL_OPTIONS = ["Read", "Write", "Edit", "Bash", "Grep", "Glob", "WebFetch", "WebSearch", "*"] as const;
const PATH_TOOLS = new Set(["Read", "Write", "Edit", "Grep", "Glob"]);

type PresetKey = "safe_defaults" | "permissive" | "strict";

interface Props {
  permissions: PermissionConfig | null;
  approvalRules: ApprovalRule[];
  onToggleSkipDangerous: (enabled: boolean) => void;
  onToggleAutoApprove: (enabled: boolean) => void;
  onToggleRule: (id: string, enabled: boolean) => void;
  onDeleteRule: (id: string) => void;
  onRefreshRules: () => void;
  onAddRule: (name: string, toolName: string, pathPattern: string | null, commandPattern: string | null, action: string) => Promise<void>;
  onReorderRules: (ids: string[]) => Promise<void>;
  onCheckRuleMatch: (toolName: string, toolInput: string, cwd: string | null) => Promise<RuleMatchResult>;
  onImportPreset: (preset: string) => Promise<void>;
}

/** Build a human-readable summary of the rule conditions */
function conditionSummary(rule: ApprovalRule): string {
  const parts: string[] = [];
  if (rule.conditions.path_pattern) {
    parts.push(`path: ${rule.conditions.path_pattern}`);
  }
  if (rule.conditions.command_pattern) {
    parts.push(`cmd: "${rule.conditions.command_pattern}"`);
  }
  if (parts.length === 0) {
    return "any";
  }
  return parts.join(" · ");
}

/** Auto-generate a rule name from form values */
function autoName(toolName: string, action: string, pathPattern: string, commandPattern: string): string {
  const verb = action === "allow" ? "Allow" : "Deny";
  const tool = toolName === "*" ? "All Tools" : toolName;
  if (toolName === "Bash" && commandPattern) {
    return `${verb} ${tool} ${commandPattern}`.slice(0, 60);
  }
  if (pathPattern && PATH_TOOLS.has(toolName)) {
    return `${verb} ${tool} ${pathPattern}`.slice(0, 60);
  }
  return `${verb} ${tool}`;
}

export default function PermissionPanel({
  permissions,
  approvalRules,
  onToggleSkipDangerous,
  onToggleAutoApprove,
  onToggleRule,
  onDeleteRule,
  onRefreshRules,
  onAddRule,
  onReorderRules,
  onCheckRuleMatch,
  onImportPreset,
}: Props) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ApprovalRule | null>(null);
  const [clearAllConfirm, setClearAllConfirm] = useState(false);

  // Add Rule Form state
  const [showAddForm, setShowAddForm] = useState(false);
  const [formName, setFormName] = useState("");
  const [formTool, setFormTool] = useState<string>("");
  const [formPath, setFormPath] = useState("");
  const [formCommand, setFormCommand] = useState("");
  const [formAction, setFormAction] = useState<"allow" | "deny">("allow");
  const [formSubmitting, setFormSubmitting] = useState(false);

  // Preset dropdown
  const [showPresetMenu, setShowPresetMenu] = useState(false);

  // Test Rules state
  const [showTestRules, setShowTestRules] = useState(false);
  const [testTool, setTestTool] = useState("Read");
  const [testPath, setTestPath] = useState("");
  const [testCommand, setTestCommand] = useState("");
  const [testCwd, setTestCwd] = useState("");
  const [testResult, setTestResult] = useState<RuleMatchResult | null>(null);
  const [testTesting, setTestTesting] = useState(false);

  // Reorder in-progress
  const [reordering, setReordering] = useState(false);

  const resetForm = () => {
    setFormName("");
    setFormTool("");
    setFormPath("");
    setFormCommand("");
    setFormAction("allow");
    setShowAddForm(false);
  };

  const handleAddSubmit = useCallback(async () => {
    if (!formTool) return;
    setFormSubmitting(true);
    try {
      const name = formName.trim() || autoName(formTool, formAction, formPath, formCommand);
      const pathPattern = PATH_TOOLS.has(formTool) && formPath.trim() ? formPath.trim() : null;
      const commandPattern = formTool === "Bash" && formCommand.trim() ? formCommand.trim() : null;
      await onAddRule(name, formTool, pathPattern, commandPattern, formAction);
      resetForm();
    } finally {
      setFormSubmitting(false);
    }
  }, [formName, formTool, formPath, formCommand, formAction, onAddRule]);

  const handleDeleteClick = (rule: ApprovalRule) => {
    setDeleteTarget(rule);
  };

  const handleDeleteConfirm = () => {
    if (deleteTarget) {
      onDeleteRule(deleteTarget.id);
      setDeleteTarget(null);
    }
  };

  const handleDeleteCancel = () => {
    setDeleteTarget(null);
  };

  const handleMoveUp = useCallback(async (index: number) => {
    if (index <= 0 || reordering) return;
    setReordering(true);
    try {
      const ids = approvalRules.map((r) => r.id);
      [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]];
      await onReorderRules(ids);
    } finally {
      setReordering(false);
    }
  }, [approvalRules, reordering, onReorderRules]);

  const handleMoveDown = useCallback(async (index: number) => {
    if (index >= approvalRules.length - 1 || reordering) return;
    setReordering(true);
    try {
      const ids = approvalRules.map((r) => r.id);
      [ids[index], ids[index + 1]] = [ids[index + 1], ids[index]];
      await onReorderRules(ids);
    } finally {
      setReordering(false);
    }
  }, [approvalRules, reordering, onReorderRules]);

  const handlePresetSelect = useCallback(async (preset: PresetKey) => {
    setShowPresetMenu(false);
    await onImportPreset(preset);
  }, [onImportPreset]);

  const handleClearAllRules = useCallback(async () => {
    setClearAllConfirm(false);
    // Delete all rules one by one
    for (const rule of approvalRules) {
      await onDeleteRule(rule.id);
    }
    onRefreshRules();
  }, [approvalRules, onDeleteRule, onRefreshRules]);

  const handleTestSubmit = useCallback(async () => {
    setTestTesting(true);
    setTestResult(null);
    try {
      // Build tool_input JSON based on tool
      let toolInputJson: string;
      if (testTool === "Bash") {
        toolInputJson = JSON.stringify({ command: testCommand });
      } else if (PATH_TOOLS.has(testTool)) {
        const key = (testTool === "Grep" || testTool === "Glob") ? "path" : "file_path";
        toolInputJson = JSON.stringify({ [key]: testPath });
      } else {
        toolInputJson = "{}";
      }
      const result = await onCheckRuleMatch(testTool, toolInputJson, testCwd.trim() || null);
      setTestResult(result);
    } catch {
      setTestResult({ matched: false, rule_id: null, rule_name: null, action: null });
    } finally {
      setTestTesting(false);
    }
  }, [testTool, testPath, testCommand, testCwd, onCheckRuleMatch]);

  if (!permissions) {
    return (
      <div className="panel permission-panel">
        <h2 className="panel-title">PERMISSIONS</h2>
        <p className="empty-state">Loading...</p>
      </div>
    );
  }

  const showPathField = PATH_TOOLS.has(formTool) || formTool === "*";
  const showCommandField = formTool === "Bash" || formTool === "*";
  const testShowPath = PATH_TOOLS.has(testTool);
  const testShowCommand = testTool === "Bash";

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

      {/* Auto Approve All warning banner */}
      {permissions.autoApproveAll && (
        <div className="rules-warning">
          <span className="rules-warning-icon">!</span>
          <span>Auto Approve All 已啟用，所有規則被繞過</span>
        </div>
      )}

      {/* Approval Rules section */}
      <div className="rules-section">
        <div className="rules-header">
          <h3 className="sub-title">APPROVAL RULES</h3>
          <div className="rules-actions">
            <button
              className="pixel-btn-sm rules-add-btn"
              onClick={() => setShowAddForm(!showAddForm)}
            >
              {showAddForm ? "CANCEL" : "+ NEW RULE"}
            </button>
            <div className="preset-dropdown-wrap">
              <button
                className="pixel-btn-sm rules-preset-btn"
                onClick={() => setShowPresetMenu(!showPresetMenu)}
              >
                PRESETS
              </button>
              {showPresetMenu && (
                <div className="preset-dropdown">
                  <button className="preset-dropdown-item" onClick={() => handlePresetSelect("safe_defaults")}>
                    Safe Defaults
                    <span className="preset-rec">recommended</span>
                  </button>
                  <button className="preset-dropdown-item" onClick={() => handlePresetSelect("permissive")}>
                    Permissive
                  </button>
                  <button className="preset-dropdown-item" onClick={() => handlePresetSelect("strict")}>
                    Strict
                  </button>
                  <div className="preset-dropdown-sep" />
                  <button
                    className="preset-dropdown-item preset-dropdown-danger"
                    onClick={() => { setShowPresetMenu(false); setClearAllConfirm(true); }}
                  >
                    Clear All Rules
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Add Rule Form */}
        {showAddForm && (
          <div className="rule-form">
            <div className="rule-form-title">New Approval Rule</div>

            <div className="rule-form-field">
              <label className="rule-form-label">Name</label>
              <input
                className="rule-form-input"
                type="text"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="Auto-generated if empty"
                maxLength={100}
              />
            </div>

            <div className="rule-form-field">
              <label className="rule-form-label">Tool <span className="rule-form-req">*</span></label>
              <select
                className="rule-form-select"
                value={formTool}
                onChange={(e) => setFormTool(e.target.value)}
              >
                <option value="" disabled>Select tool...</option>
                {TOOL_OPTIONS.map((t) => (
                  <option key={t} value={t}>{t === "*" ? "* (Any Tool)" : t}</option>
                ))}
              </select>
            </div>

            {showPathField && (
              <div className="rule-form-field">
                <label className="rule-form-label">Path Pattern</label>
                <input
                  className="rule-form-input"
                  type="text"
                  value={formPath}
                  onChange={(e) => setFormPath(e.target.value)}
                  placeholder="e.g. src/**"
                />
                <div className="rule-form-hint">Glob pattern for file path matching</div>
              </div>
            )}

            {showCommandField && (
              <div className="rule-form-field">
                <label className="rule-form-label">Command Pattern</label>
                <input
                  className="rule-form-input"
                  type="text"
                  value={formCommand}
                  onChange={(e) => setFormCommand(e.target.value)}
                  placeholder="e.g. npm test"
                />
                <div className="rule-form-hint">Substring match for Bash commands</div>
              </div>
            )}

            <div className="rule-form-field">
              <label className="rule-form-label">Action</label>
              <div className="rule-form-radios">
                <label className="rule-form-radio">
                  <input
                    type="radio"
                    name="rule-action"
                    value="allow"
                    checked={formAction === "allow"}
                    onChange={() => setFormAction("allow")}
                  />
                  <span className="radio-mark" />
                  <span className="radio-label-allow">Allow</span>
                </label>
                <label className="rule-form-radio">
                  <input
                    type="radio"
                    name="rule-action"
                    value="deny"
                    checked={formAction === "deny"}
                    onChange={() => setFormAction("deny")}
                  />
                  <span className="radio-mark" />
                  <span className="radio-label-deny">Deny</span>
                </label>
              </div>
            </div>

            <div className="rule-form-buttons">
              <button className="pixel-btn-sm" onClick={resetForm}>CANCEL</button>
              <button
                className="pixel-btn-sm rule-form-save"
                onClick={handleAddSubmit}
                disabled={!formTool || formSubmitting}
              >
                {formSubmitting ? "SAVING..." : "ADD RULE"}
              </button>
            </div>
          </div>
        )}

        {approvalRules.length === 0 ? (
          <div className="rules-empty">
            No rules yet. Add rules or import a preset to auto-approve or deny specific tools.
          </div>
        ) : (
          <div className="rules-list">
            {approvalRules.map((rule, index) => (
              <div
                key={rule.id}
                className={`rule-card ${!rule.enabled ? "rule-disabled" : ""}`}
              >
                <div className="rule-card-top">
                  <div className="rule-reorder-btns">
                    <button
                      className="rule-reorder-btn"
                      onClick={() => handleMoveUp(index)}
                      disabled={index === 0 || reordering}
                      title="Move up"
                      aria-label="Move rule up"
                      style={{ visibility: index === 0 ? "hidden" : "visible" }}
                    >
                      ▲
                    </button>
                    <button
                      className="rule-reorder-btn"
                      onClick={() => handleMoveDown(index)}
                      disabled={index === approvalRules.length - 1 || reordering}
                      title="Move down"
                      aria-label="Move rule down"
                      style={{ visibility: index === approvalRules.length - 1 ? "hidden" : "visible" }}
                    >
                      ▼
                    </button>
                  </div>
                  <label className="pixel-toggle rule-toggle">
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={() => onToggleRule(rule.id, !rule.enabled)}
                    />
                    <span className="toggle-track toggle-track-sm">
                      <span className="toggle-thumb toggle-thumb-sm" />
                    </span>
                  </label>
                  <div className="rule-info">
                    <span className="rule-name">{rule.name}</span>
                  </div>
                  <span
                    className={`rule-action-badge ${
                      rule.action === "allow"
                        ? "rule-action-allow"
                        : "rule-action-deny"
                    }`}
                  >
                    {rule.action}
                  </span>
                  <button
                    className="rule-delete-btn"
                    onClick={() => handleDeleteClick(rule)}
                    title="Delete rule"
                    aria-label={`Delete rule ${rule.name}`}
                  >
                    x
                  </button>
                </div>
                <div className="rule-card-bottom">
                  <span className="rule-tool-badge">{rule.conditions.tool_name}</span>
                  <span className="rule-conditions">{conditionSummary(rule)}</span>
                </div>
              </div>
            ))}
            <div className="rules-fallback">
              Rules not matched → Manual Review
            </div>
          </div>
        )}
      </div>

      {/* Test Rules section */}
      <div className="test-rules-section">
        <button
          className="test-rules-toggle"
          onClick={() => setShowTestRules(!showTestRules)}
        >
          <span className="test-rules-arrow">{showTestRules ? "▾" : "▸"}</span>
          TEST RULES
        </button>
        {showTestRules && (
          <div className="test-rules-body">
            <div className="rule-form-field">
              <label className="rule-form-label">Tool</label>
              <select
                className="rule-form-select"
                value={testTool}
                onChange={(e) => { setTestTool(e.target.value); setTestResult(null); }}
              >
                {TOOL_OPTIONS.filter(t => t !== "*").map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>

            {testShowPath && (
              <div className="rule-form-field">
                <label className="rule-form-label">
                  {testTool === "Grep" || testTool === "Glob" ? "Path" : "File Path"}
                </label>
                <input
                  className="rule-form-input"
                  type="text"
                  value={testPath}
                  onChange={(e) => setTestPath(e.target.value)}
                  placeholder="e.g. /Users/me/project/src/App.tsx"
                />
              </div>
            )}

            {testShowCommand && (
              <div className="rule-form-field">
                <label className="rule-form-label">Command</label>
                <input
                  className="rule-form-input"
                  type="text"
                  value={testCommand}
                  onChange={(e) => setTestCommand(e.target.value)}
                  placeholder="e.g. npm test"
                />
              </div>
            )}

            <div className="rule-form-field">
              <label className="rule-form-label">CWD (optional)</label>
              <input
                className="rule-form-input"
                type="text"
                value={testCwd}
                onChange={(e) => setTestCwd(e.target.value)}
                placeholder="e.g. /Users/me/project"
              />
            </div>

            <button
              className="pixel-btn-sm rule-form-save test-btn"
              onClick={handleTestSubmit}
              disabled={testTesting}
            >
              {testTesting ? "TESTING..." : "TEST"}
            </button>

            {testResult && (
              <div className={`test-result ${testResult.matched ? (testResult.action === "allow" ? "test-result-allow" : "test-result-deny") : "test-result-none"}`}>
                {testResult.matched ? (
                  <>
                    <span className="test-result-icon">{testResult.action === "allow" ? "✓" : "✗"}</span>
                    <span>
                      Matched "<strong>{testResult.rule_name}</strong>"
                      <span className={`test-result-action ${testResult.action === "allow" ? "action-allow" : "action-deny"}`}>
                        → {testResult.action}
                      </span>
                    </span>
                  </>
                ) : (
                  <>
                    <span className="test-result-icon">?</span>
                    <span>No rule matched → Manual Review</span>
                  </>
                )}
              </div>
            )}
          </div>
        )}
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

      {deleteTarget && (
        <ConfirmDialog
          title="DELETE RULE?"
          message={`Delete rule "${deleteTarget.name}"? This cannot be undone.`}
          confirmLabel="DELETE"
          cancelLabel="CANCEL"
          onConfirm={handleDeleteConfirm}
          onCancel={handleDeleteCancel}
        />
      )}

      {clearAllConfirm && (
        <ConfirmDialog
          title="CLEAR ALL RULES?"
          message="This will delete all approval rules. This cannot be undone."
          confirmLabel="CLEAR ALL"
          cancelLabel="CANCEL"
          onConfirm={handleClearAllRules}
          onCancel={() => setClearAllConfirm(false)}
        />
      )}
    </div>
  );
}
