use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::error::Error;

const ANTHROPIC_API_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";

// Model constants
pub const CLAUDE_HAIKU: &str = "claude-3-5-haiku-20241022";
pub const CLAUDE_SONNET: &str = "claude-sonnet-4-20250514";
pub const CLAUDE_OPUS: &str = "claude-opus-4-20250514";

/// Thinking budget levels for extended thinking
#[derive(Debug, Clone, Copy)]
pub enum ThinkingBudget {
    None,           // No thinking
    Low,            // ~1024 tokens
    Medium,         // ~4096 tokens  
    High,           // ~10000 tokens
}

impl ThinkingBudget {
    fn to_tokens(&self) -> Option<u32> {
        match self {
            ThinkingBudget::None => None,
            ThinkingBudget::Low => Some(1024),
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
        Self {
            client: Client::new(),
            api_key: api_key.to_string(),
        }
    }
    
    /// Send a chat completion request to Claude (default: Sonnet, no thinking)
    pub async fn chat_completion(
        &self,
        system_prompt: Option<&str>,
        messages: Vec<AnthropicMessage>,
        temperature: f32,
        max_tokens: Option<u32>,
    ) -> Result<String, Box<dyn Error + Send + Sync>> {
        self.chat_completion_advanced(
            CLAUDE_SONNET,
            system_prompt,
            messages,
            temperature,
            max_tokens,
            ThinkingBudget::None,
        ).await
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
    
    /// Validate the Anthropic API key
    pub async fn validate_api_key(&self) -> Result<bool, Box<dyn Error + Send + Sync>> {
        let messages = vec![AnthropicMessage {
            role: "user".to_string(),
            content: "Say 'ok'".to_string(),
        }];
        
        let request = MessagesRequest {
            model: CLAUDE_SONNET.to_string(),
            max_tokens: 10,
            system: None,
            messages,
            temperature: Some(0.0),
            thinking: None,
        };
        
        let response = self.client
            .post(ANTHROPIC_API_URL)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("Content-Type", "application/json")
            .json(&request)
            .send()
            .await?;
        
        if response.status().is_success() {
            Ok(true)
        } else {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            
            if status.as_u16() == 401 {
                return Err("Invalid Anthropic API key".into());
            } else if status.as_u16() == 429 {
                return Err("Rate limited - too many requests".into());
            }
            
            // Try to parse structured error for better messaging
            if let Ok(parsed_error) = serde_json::from_str::<AnthropicError>(&error_text) {
                return Err(format!("{}: {}", parsed_error.error.error_type, parsed_error.error.message).into());
            }
            
            Err(format!("Anthropic API error ({}): {}", status, error_text).into())
        }
    }
}

/// Helper to convert OpenAI-style messages to Anthropic format
/// Extracts system message and returns (system_prompt, messages)
pub fn convert_messages(messages: Vec<crate::openai::ChatMessage>) -> (Option<String>, Vec<AnthropicMessage>) {
    let mut system_prompt = None;
    let mut anthropic_messages = Vec::new();
    
    for msg in messages {
        if msg.role == "system" {
            // Accumulate system messages
            if let Some(existing) = system_prompt {
                system_prompt = Some(format!("{}\n\n{}", existing, msg.content));
            } else {
                system_prompt = Some(msg.content);
            }
        } else {
            anthropic_messages.push(AnthropicMessage {
                role: msg.role,
                content: msg.content,
            });
        }
    }
    
    (system_prompt, anthropic_messages)
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_convert_messages() {
        let messages = vec![
            crate::openai::ChatMessage {
                role: "system".to_string(),
                content: "You are helpful.".to_string(),
            },
            crate::openai::ChatMessage {
                role: "user".to_string(),
                content: "Hello".to_string(),
            },
        ];
        
        let (system, msgs) = convert_messages(messages);
        
        assert_eq!(system, Some("You are helpful.".to_string()));
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].content, "Hello");
    }
}
