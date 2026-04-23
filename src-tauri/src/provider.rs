use serde::{Deserialize, Serialize};

// ── Provider Kind ──

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    Claude,
    Codex,
}

// ── Unified Session ──

#[derive(Debug, Serialize, Clone)]
pub struct UnifiedSession {
    pub pid: u32,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub cwd: String,
    #[serde(rename = "startedAt")]
    pub started_at: u64,
    pub kind: String,
    pub entrypoint: String,
    #[serde(rename = "isAlive")]
    pub is_alive: bool,
    pub provider: ProviderKind,
}

// ── Unified Transcript Message ──

#[derive(Debug, Serialize, Clone)]
pub struct UnifiedTranscriptMessage {
    pub role: String,
    pub text: String,
    #[serde(rename = "toolName")]
    pub tool_name: Option<String>,
    #[serde(rename = "toolInput")]
    pub tool_input: Option<String>,
    pub timestamp: Option<String>,
}

// ── Unified Activity Info ──

#[derive(Debug, Serialize, Clone)]
pub struct UnifiedActivityInfo {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub activity: String,
    #[serde(rename = "toolName")]
    pub tool_name: Option<String>,
}

// ── Session Provider Trait ──

pub trait SessionProvider: Send + Sync {
    fn kind(&self) -> ProviderKind;

    fn discover_sessions(&self) -> Result<Vec<UnifiedSession>, Box<dyn std::error::Error>>;

    fn read_transcript(
        &self,
        session_id: &str,
        cwd: &str,
    ) -> Result<Vec<UnifiedTranscriptMessage>, Box<dyn std::error::Error>>;

    fn read_last_message(
        &self,
        session_id: &str,
        cwd: &str,
    ) -> Result<Option<UnifiedTranscriptMessage>, Box<dyn std::error::Error>>;

    fn read_activity(
        &self,
        session_id: &str,
        cwd: &str,
    ) -> Result<UnifiedActivityInfo, Box<dyn std::error::Error>>;

    fn supports_hooks(&self) -> bool;
    fn supports_approval(&self) -> bool;
    fn supports_jump(&self) -> bool;
}

// ── Provider Registry ──

pub struct ProviderRegistry {
    providers: Vec<Box<dyn SessionProvider>>,
}

impl ProviderRegistry {
    pub fn new() -> Self {
        Self {
            providers: Vec::new(),
        }
    }

    pub fn register(&mut self, provider: Box<dyn SessionProvider>) {
        self.providers.push(provider);
    }

    pub fn discover_all_sessions(&self) -> Result<Vec<UnifiedSession>, Box<dyn std::error::Error>> {
        let mut all = Vec::new();
        for provider in &self.providers {
            match provider.discover_sessions() {
                Ok(sessions) => all.extend(sessions),
                Err(e) => {
                    eprintln!(
                        "[registry] provider {:?} discover_sessions failed: {}",
                        provider.kind(),
                        e
                    );
                }
            }
        }
        // Sort by startedAt descending (newest first)
        all.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        Ok(all)
    }

    pub fn find_provider(&self, kind: &ProviderKind) -> Option<&dyn SessionProvider> {
        self.providers
            .iter()
            .find(|p| p.kind() == *kind)
            .map(|p| p.as_ref())
    }
}
