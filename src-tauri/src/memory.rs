//! Memory extraction and conversation summarization module
//! 
//! This module handles:
//! - Extracting explicit facts from user messages
//! - Inferring behavioral patterns over time
//! - Generating conversation summaries for token efficiency
//! - Building a comprehensive user profile

use crate::db::{self, UserFact, UserPattern, ConversationSummary, Message};
use crate::anthropic::{AnthropicClient, AnthropicMessage, ThinkingBudget, CLAUDE_OPUS};
use crate::logging;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::error::Error;

// ============ Extraction Results ============

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExtractionResult {
    pub new_facts: Vec<ExtractedFact>,
    pub updated_facts: Vec<FactUpdate>,
    pub new_patterns: Vec<ExtractedPattern>,
    pub themes: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExtractedFact {
    pub category: String,
    pub key: String,
    pub value: String,
    pub confidence: f64,
    pub source_type: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FactUpdate {
    pub category: String,
    pub key: String,
    pub new_value: Option<String>,
    pub confirmed: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExtractedPattern {
    pub pattern_type: String,
    pub description: String,
    pub confidence: f64,
    pub evidence: String,
}

// ============ User Profile Summary ============

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct UserProfileSummary {
    pub facts_by_category: std::collections::HashMap<String, Vec<FactSummary>>,
    pub top_patterns: Vec<PatternSummary>,
    pub recurring_themes: Vec<String>,
    pub communication_style: Option<String>,
    pub thinking_preference: Option<String>,
    pub emotional_tendency: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FactSummary {
    pub key: String,
    pub value: String,
    pub confidence: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PatternSummary {
    pub pattern_type: String,
    pub description: String,
    pub confidence: f64,
}

// ============ Memory Extractor ============

pub struct MemoryExtractor {
    client: AnthropicClient,
}

impl MemoryExtractor {
    pub fn new(api_key: &str) -> Self {
        Self {
            client: AnthropicClient::new(api_key),
        }
    }
    
    /// Extract facts and patterns from a conversation exchange
    pub async fn extract_from_exchange(
        &self,
        user_message: &str,
        agent_responses: &[(String, String)], // (agent_name, content)
        existing_facts: &[UserFact],
        conversation_id: &str,
    ) -> Result<ExtractionResult, Box<dyn Error + Send + Sync>> {
        logging::log_memory(Some(conversation_id), &format!(
            "Starting extraction. User message: {}", &user_message[..user_message.len().min(100)]
        ));
        // Build context of existing facts for the LLM
        let existing_facts_context = if existing_facts.is_empty() {
            "No existing facts about the user.".to_string()
        } else {
            existing_facts
                .iter()
                .take(20) // Limit to avoid token bloat
                .map(|f| format!("- {}/{}: {} (confidence: {:.0}%)", f.category, f.key, f.value, f.confidence * 100.0))
                .collect::<Vec<_>>()
                .join("\n")
        };
        
        // Format agent responses
        let responses_text = agent_responses
            .iter()
            .map(|(agent, content)| format!("{}: {}", agent.to_uppercase(), content))
            .collect::<Vec<_>>()
            .join("\n");
        
        let system_prompt = r#"You are a memory extraction system for Intersect, a multi-agent AI assistant. Your job is to extract learnable information from conversations.

EXTRACT TWO TYPES OF INFORMATION:

1. FACTS (explicit statements by the user about themselves):
   Categories: "personal", "preferences", "work", "relationships", "values", "interests", "background"
   - Only extract what the USER explicitly states
   - High confidence (0.8-1.0) for direct statements
   - Lower confidence (0.5-0.7) for implied information

2. PATTERNS (behavioral observations):
   Types: "communication_style", "emotional_tendency", "thinking_mode", "decision_making", "values_expression"
   - Infer from HOW the user communicates, not what they say
   - Lower confidence (0.3-0.6) as these are inferences
   - Include specific evidence from the conversation

3. THEMES (topics the user brings up):
   - Extract 1-3 main themes/topics from this exchange
   - These help track what the user cares about over time

IMPORTANT:
- Be conservative - only extract clear, meaningful information
- Don't repeat existing facts unless you're confirming/updating them
- Patterns should be behavioral observations, not content summaries

Respond with ONLY valid JSON in this exact format:
{
  "new_facts": [{"category": "...", "key": "...", "value": "...", "confidence": 0.9, "source_type": "explicit"}],
  "updated_facts": [{"category": "...", "key": "...", "new_value": "..." or null, "confirmed": true}],
  "new_patterns": [{"pattern_type": "...", "description": "...", "confidence": 0.5, "evidence": "..."}],
  "themes": ["theme1", "theme2"]
}"#;

        let user_prompt = format!(
            "EXISTING FACTS ABOUT USER:\n{}\n\nCONVERSATION EXCHANGE:\nUSER: {}\n{}\n\nExtract any new learnable information:",
            existing_facts_context,
            user_message,
            responses_text
        );

        // Use Anthropic client for memory extraction (Opus, thinking high)
        let messages = vec![
            AnthropicMessage {
                role: "user".to_string(),
                content: user_prompt,
            },
        ];

        let response = self.client.chat_completion_advanced(
            CLAUDE_OPUS,
            Some(system_prompt),
            messages,
            0.2,
            Some(800),
            ThinkingBudget::High
        ).await?;
        
        logging::log_memory(Some(conversation_id), &format!(
            "Got extraction response, length: {}", response.len()
        ));
        
        // Parse JSON response
        let cleaned = response
            .trim()
            .trim_start_matches("```json")
            .trim_end_matches("```")
            .trim();
        
        let result: ExtractionResult = match serde_json::from_str(cleaned) {
            Ok(r) => r,
            Err(e) => {
                logging::log_error(Some(conversation_id), &format!(
                    "Failed to parse extraction JSON: {}. Response: {}", e, &cleaned[..cleaned.len().min(200)]
                ));
                ExtractionResult {
                    new_facts: Vec::new(),
                    updated_facts: Vec::new(),
                    new_patterns: Vec::new(),
                    themes: Vec::new(),
                }
            }
        };
        
        logging::log_memory(Some(conversation_id), &format!(
            "Extracted {} facts, {} patterns, {} themes",
            result.new_facts.len(), result.new_patterns.len(), result.themes.len()
        ));
        
        // Save extracted data to database
        self.save_extraction_result(&result, conversation_id)?;
        logging::log_memory(Some(conversation_id), "Saved extraction result to database");
        
        Ok(result)
    }
    
    /// Save extraction results to the database
    fn save_extraction_result(&self, result: &ExtractionResult, conversation_id: &str) -> Result<(), Box<dyn Error + Send + Sync>> {
        let now = Utc::now().to_rfc3339();
        
        // Save new facts
        for fact in &result.new_facts {
            let user_fact = UserFact {
                id: 0, // Will be assigned by DB
                category: fact.category.clone(),
                key: fact.key.clone(),
                value: fact.value.clone(),
                confidence: fact.confidence,
                source_type: fact.source_type.clone(),
                source_conversation_id: Some(conversation_id.to_string()),
                first_mentioned: now.clone(),
                last_confirmed: now.clone(),
                mention_count: 1,
            };
            let _ = db::save_user_fact(&user_fact);
        }
        
        // Save new patterns
        for pattern in &result.new_patterns {
            let user_pattern = UserPattern {
                id: 0,
                pattern_type: pattern.pattern_type.clone(),
                description: pattern.description.clone(),
                confidence: pattern.confidence,
                evidence: pattern.evidence.clone(),
                first_observed: now.clone(),
                last_updated: now.clone(),
                observation_count: 1,
            };
            let _ = db::save_user_pattern(&user_pattern);
        }
        
        // Save themes
        for theme in &result.themes {
            let _ = db::save_recurring_theme(theme, conversation_id);
        }
        
        Ok(())
    }
    
    /// Build a consolidated user profile summary for agent grounding
    pub fn build_profile_summary() -> Result<UserProfileSummary, Box<dyn Error + Send + Sync>> {
        let facts = db::get_all_user_facts().unwrap_or_default();
        let patterns = db::get_all_user_patterns().unwrap_or_default();
        let themes = db::get_top_themes(10).unwrap_or_default();
        
        // Group facts by category
        let mut facts_by_category: std::collections::HashMap<String, Vec<FactSummary>> = std::collections::HashMap::new();
        for fact in facts {
            let entry = facts_by_category.entry(fact.category.clone()).or_default();
            entry.push(FactSummary {
                key: fact.key,
                value: fact.value,
                confidence: fact.confidence,
            });
        }
        
        // Extract specific pattern types for quick access
        let mut communication_style = None;
        let mut thinking_preference = None;
        let mut emotional_tendency = None;
        
        let mut top_patterns = Vec::new();
        for pattern in patterns.iter().take(10) {
            match pattern.pattern_type.as_str() {
                "communication_style" if communication_style.is_none() => {
                    communication_style = Some(pattern.description.clone());
                }
                "thinking_mode" if thinking_preference.is_none() => {
                    thinking_preference = Some(pattern.description.clone());
                }
                "emotional_tendency" if emotional_tendency.is_none() => {
                    emotional_tendency = Some(pattern.description.clone());
                }
                _ => {}
            }
            top_patterns.push(PatternSummary {
                pattern_type: pattern.pattern_type.clone(),
                description: pattern.description.clone(),
                confidence: pattern.confidence,
            });
        }
        
        Ok(UserProfileSummary {
            facts_by_category,
            top_patterns,
            recurring_themes: themes.into_iter().map(|t| t.theme).collect(),
            communication_style,
            thinking_preference,
            emotional_tendency,
        })
    }
    
    /// Format user profile for inclusion in prompts
    pub fn format_profile_for_prompt(profile: &UserProfileSummary, level: GroundingLevel) -> String {
        match level {
            GroundingLevel::Light => {
                // Just themes and communication style
                let mut parts = Vec::new();
                if let Some(style) = &profile.communication_style {
                    parts.push(format!("Communication style: {}", style));
                }
                if !profile.recurring_themes.is_empty() {
                    parts.push(format!("Often discusses: {}", profile.recurring_themes.join(", ")));
                }
                parts.join("\n")
            }
            GroundingLevel::Moderate => {
                // High-confidence facts + patterns
                let mut parts = Vec::new();
                
                for (category, facts) in &profile.facts_by_category {
                    let high_conf: Vec<_> = facts.iter().filter(|f| f.confidence >= 0.7).collect();
                    if !high_conf.is_empty() {
                        let items: Vec<String> = high_conf.iter().map(|f| format!("{}: {}", f.key, f.value)).collect();
                        parts.push(format!("{}:\n  {}", category.to_uppercase(), items.join("\n  ")));
                    }
                }
                
                if let Some(style) = &profile.communication_style {
                    parts.push(format!("Communication: {}", style));
                }
                if let Some(thinking) = &profile.thinking_preference {
                    parts.push(format!("Thinking: {}", thinking));
                }
                
                parts.join("\n")
            }
            GroundingLevel::Deep => {
                // Full profile
                let mut parts = Vec::new();
                
                for (category, facts) in &profile.facts_by_category {
                    if !facts.is_empty() {
                        let items: Vec<String> = facts.iter().map(|f| {
                            format!("{}: {} ({:.0}%)", f.key, f.value, f.confidence * 100.0)
                        }).collect();
                        parts.push(format!("{}:\n  {}", category.to_uppercase(), items.join("\n  ")));
                    }
                }
                
                if !profile.top_patterns.is_empty() {
                    parts.push("BEHAVIORAL PATTERNS:".to_string());
                    for p in &profile.top_patterns {
                        parts.push(format!("  - {}: {}", p.pattern_type, p.description));
                    }
                }
                
                if !profile.recurring_themes.is_empty() {
                    parts.push(format!("RECURRING THEMES: {}", profile.recurring_themes.join(", ")));
                }
                
                parts.join("\n")
            }
        }
    }
}

// ============ Conversation Summarizer ============

pub struct ConversationSummarizer {
    client: AnthropicClient,
}

impl ConversationSummarizer {
    pub fn new(api_key: &str) -> Self {
        Self {
            client: AnthropicClient::new(api_key),
        }
    }
    
    /// Generate a summary for a conversation
    pub async fn summarize(
        &self,
        messages: &[Message],
        existing_summary: Option<&str>,
    ) -> Result<SummaryResult, Box<dyn Error + Send + Sync>> {
        if messages.is_empty() {
            return Ok(SummaryResult {
                summary: String::new(),
                key_topics: Vec::new(),
                emotional_tone: None,
                user_state: None,
            });
        }
        
        // Format messages for summarization
        let messages_text: String = messages
            .iter()
            .map(|m| format!("{}: {}", m.role.to_uppercase(), m.content))
            .collect::<Vec<_>>()
            .join("\n");
        
        let context = if let Some(prev) = existing_summary {
            format!("PREVIOUS SUMMARY:\n{}\n\nNEW MESSAGES TO INCORPORATE:\n{}", prev, messages_text)
        } else {
            format!("CONVERSATION TO SUMMARIZE:\n{}", messages_text)
        };
        
        let system_prompt = r#"You are a conversation summarizer for Intersect. Create a concise summary that captures:

1. SUMMARY: A 2-3 sentence summary of the conversation's content and direction
2. KEY_TOPICS: 2-5 main topics discussed
3. EMOTIONAL_TONE: The overall emotional quality (e.g., "positive", "neutral", "tense", "exploratory", "reflective")
4. USER_STATE: Inferred user mood/state if discernible (e.g., "curious", "stressed", "enthusiastic", "uncertain")

Focus on what matters for future context. Be concise but capture the essence.

Respond with ONLY valid JSON:
{
  "summary": "...",
  "key_topics": ["topic1", "topic2"],
  "emotional_tone": "...",
  "user_state": "..." or null
}"#;

        // Use Anthropic client for summarization (Opus, thinking high)
        let api_messages = vec![
            AnthropicMessage {
                role: "user".to_string(),
                content: context,
            },
        ];

        let response = self.client.chat_completion_advanced(
            CLAUDE_OPUS,
            Some(system_prompt),
            api_messages,
            0.3,
            Some(400),
            ThinkingBudget::High
        ).await?;
        
        let cleaned = response
            .trim()
            .trim_start_matches("```json")
            .trim_end_matches("```")
            .trim();
        
        let result: SummaryResult = serde_json::from_str(cleaned).unwrap_or_else(|_| {
            SummaryResult {
                summary: "Conversation in progress.".to_string(),
                key_topics: Vec::new(),
                emotional_tone: None,
                user_state: None,
            }
        });
        
        Ok(result)
    }
    
    /// Save a conversation summary to the database
    pub fn save_summary(
        conversation_id: &str,
        result: &SummaryResult,
        message_count: i64,
        agents: &[String],
    ) -> Result<(), Box<dyn Error + Send + Sync>> {
        let summary = ConversationSummary {
            id: 0,
            conversation_id: conversation_id.to_string(),
            summary: result.summary.clone(),
            key_topics: serde_json::to_string(&result.key_topics).unwrap_or_default(),
            emotional_tone: result.emotional_tone.clone(),
            user_state: result.user_state.clone(),
            agents_involved: serde_json::to_string(agents).unwrap_or_default(),
            message_count,
            created_at: Utc::now().to_rfc3339(),
        };
        
        db::save_conversation_summary(&summary)?;
        Ok(())
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SummaryResult {
    pub summary: String,
    pub key_topics: Vec<String>,
    pub emotional_tone: Option<String>,
    pub user_state: Option<String>,
}

// ============ Grounding Level ============

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GroundingLevel {
    Light,      // Just recent context, minimal profile
    Moderate,   // Relevant facts + recent context  
    Deep,       // Full profile awareness for personal topics
}

impl GroundingLevel {
    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "light" => Some(Self::Light),
            "moderate" => Some(Self::Moderate),
            "deep" => Some(Self::Deep),
            _ => None,
        }
    }
}

