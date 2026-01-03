use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::error::Error;
use std::time::Duration;

const OPENAI_API_URL: &str = "https://api.openai.com/v1/chat/completions";
const REQUEST_TIMEOUT_SECS: u64 = 60; // 60 second timeout for API requests

#[derive(Debug, Serialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
struct ChatCompletionRequest {
    model: String,
    messages: Vec<ChatMessage>,
    temperature: f32,
    max_tokens: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionResponse {
    choices: Vec<Choice>,
}

#[derive(Debug, Deserialize)]
struct Choice {
    message: ResponseMessage,
}

#[derive(Debug, Deserialize)]
struct ResponseMessage {
    content: String,
}

pub struct OpenAIClient {
    client: Client,
    api_key: String,
}

impl OpenAIClient {
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
    
    pub async fn chat_completion(
        &self,
        messages: Vec<ChatMessage>,
        temperature: f32,
        max_tokens: Option<u32>,
    ) -> Result<String, Box<dyn Error + Send + Sync>> {
        let request = ChatCompletionRequest {
            model: "gpt-4o".to_string(),
            messages,
            temperature,
            max_tokens: max_tokens.or(Some(2048)),
        };
        
        let response = self.client
            .post(OPENAI_API_URL)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Content-Type", "application/json")
            .json(&request)
            .send()
            .await?;
        
        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await?;
            return Err(format!("OpenAI API error ({}): {}", status, error_text).into());
        }
        
        let completion: ChatCompletionResponse = response.json().await?;
        
        completion.choices
            .first()
            .map(|c| c.message.content.clone())
            .ok_or_else(|| "No response from OpenAI".into())
    }
    
    pub async fn validate_api_key(&self) -> Result<bool, Box<dyn Error + Send + Sync>> {
        let messages = vec![ChatMessage {
            role: "user".to_string(),
            content: "Say 'ok'".to_string(),
        }];
        
        let request = ChatCompletionRequest {
            model: "gpt-4o".to_string(),
            messages,
            temperature: 0.0,
            max_tokens: Some(5),
        };
        
        let response = self.client
            .post(OPENAI_API_URL)
            .header("Authorization", format!("Bearer {}", self.api_key))
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
                return Err("Invalid API key".into());
            } else if status.as_u16() == 429 {
                return Err("Rate limited - too many requests".into());
            }
            
            Err(format!("API error ({}): {}", status, error_text).into())
        }
    }
}

