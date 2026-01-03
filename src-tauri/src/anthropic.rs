use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::error::Error;
use std::time::Duration;

const ANTHROPIC_API_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const REQUEST_TIMEOUT_SECS: u64 = 60; // 60 second timeout for API requests

// Model constants
pub const CLAUDE_HAIKU: &str = "claude-3-5-haiku-20241022";
pub const CLAUDE_SONNET: &str = "claude-sonnet-4-20250514";
pub const CLAUDE_OPUS: &str = "claude-opus-4-20250514";

/// Thinking budget levels for extended thinking
#[derive(Debug, Clone, Copy)]
pub enum ThinkingBudget {
    None,           // No thinking
    Medium,         // ~4096 tokens  
    High,           // ~10000 tokens
}

impl ThinkingBudget {
    fn to_tokens(&self) -> Option<u32> {
        match self {
            ThinkingBudget::None => None,
            ThinkingBudget::Medium => Some(4096),
            ThinkingBudget::High => Some(10000),
        }
    }
}

#[derive(Debug, Serialize, Clone)]
pub struct AnthropicMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
struct ThinkingConfig {
    #[serde(rename = "type")]
    thinking_type: String,
    budget_tokens: u32,
}

#[derive(Debug, Serialize)]
struct MessagesRequest {
    model: String,
    max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<String>,
    messages: Vec<AnthropicMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking: Option<ThinkingConfig>,
}

#[derive(Debug, Deserialize)]
struct MessagesResponse {
    content: Vec<ContentBlock>,
}

#[derive(Debug, Deserialize)]
struct ContentBlock {
    #[serde(rename = "type")]
    content_type: String,
    text: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AnthropicError {
    error: ErrorDetails,
}

#[derive(Debug, Deserialize)]
struct ErrorDetails {
    message: String,
    #[serde(rename = "type")]
    error_type: String,
}

pub struct AnthropicClient {
    client: Client,
    api_key: String,
}

impl AnthropicClient {
    pub fn new(api_key: &str) -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .expect("Failed to build HTTP client");
        
        Self {
            client,
            api_key: api_key.to_string(),
        }
    }
    
    /// Send a chat completion with full control over model and thinking
    pub async fn chat_completion_advanced(
        &self,
        model: &str,
        system_prompt: Option<&str>,
        messages: Vec<AnthropicMessage>,
        temperature: f32,
        max_tokens: Option<u32>,
        thinking: ThinkingBudget,
    ) -> Result<String, Box<dyn Error + Send + Sync>> {
        let thinking_config = thinking.to_tokens().map(|budget| ThinkingConfig {
            thinking_type: "enabled".to_string(),
            budget_tokens: budget,
        });
        
        // When using extended thinking, temperature must be 1 (or omitted)
        let temp = if thinking_config.is_some() {
            None // Omit temperature for thinking mode
        } else {
            Some(temperature)
        };
        
        // When using thinking, we need more max_tokens to account for thinking output
        let tokens = if thinking_config.is_some() {
            max_tokens.unwrap_or(2048) + thinking.to_tokens().unwrap_or(0)
        } else {
            max_tokens.unwrap_or(2048)
        };
        
        let request = MessagesRequest {
            model: model.to_string(),
            max_tokens: tokens,
            system: system_prompt.map(|s| s.to_string()),
            messages,
            temperature: temp,
            thinking: thinking_config,
        };
        
        let response = self.client
            .post(ANTHROPIC_API_URL)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("Content-Type", "application/json")
            .json(&request)
            .send()
            .await?;
        
        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await?;
            
            // Try to parse structured error
            if let Ok(parsed_error) = serde_json::from_str::<AnthropicError>(&error_text) {
                return Err(format!(
                    "Anthropic API error ({}): {} - {}",
                    status, parsed_error.error.error_type, parsed_error.error.message
                ).into());
            }
            
            return Err(format!("Anthropic API error ({}): {}", status, error_text).into());
        }
        
        let completion: MessagesResponse = response.json().await?;
        
        // Extract text from content blocks (skip thinking blocks, get final text)
        completion.content
            .iter()
            .filter(|c| c.content_type == "text")
            .last() // Get the last text block (after thinking)
            .and_then(|c| c.text.clone())
            .ok_or_else(|| "No text response from Claude".into())
    }
}
