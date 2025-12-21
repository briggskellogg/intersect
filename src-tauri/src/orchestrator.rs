use crate::db::{self, Message};
use crate::knowledge::{INTERSECT_KNOWLEDGE, is_self_referential_query};
use crate::memory::{GroundingLevel, UserProfileSummary, MemoryExtractor};
use crate::openai::{ChatMessage, OpenAIClient};
use serde::{Deserialize, Serialize};
use std::error::Error;

// ============ Grounding Decision ============

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GroundingDecision {
    pub grounding_level: String,          // "light", "moderate", "deep"
    pub relevant_facts: Vec<String>,      // Keys of relevant facts
    pub relevant_patterns: Vec<String>,   // Pattern types to include
    pub include_past_context: bool,       // Whether to reference past conversations
}

impl Default for GroundingDecision {
    fn default() -> Self {
        Self {
            grounding_level: "moderate".to_string(),
            relevant_facts: Vec::new(),
            relevant_patterns: Vec::new(),
            include_past_context: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Agent {
    Instinct,
    Logic,
    Psyche,
}

impl Agent {
    pub fn as_str(&self) -> &'static str {
        match self {
            Agent::Instinct => "instinct",
            Agent::Logic => "logic",
            Agent::Psyche => "psyche",
        }
    }
    
    pub fn from_str(s: &str) -> Option<Agent> {
        match s.to_lowercase().as_str() {
            "instinct" => Some(Agent::Instinct),
            "logic" => Some(Agent::Logic),
            "psyche" => Some(Agent::Psyche),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ResponseType {
    Primary,
    Addition,
    Rebuttal,
    Debate,
}

impl ResponseType {
    pub fn as_str(&self) -> &'static str {
        match self {
            ResponseType::Primary => "primary",
            ResponseType::Addition => "addition",
            ResponseType::Rebuttal => "rebuttal",
            ResponseType::Debate => "debate",
        }
    }
    
    pub fn from_str(s: &str) -> Option<ResponseType> {
        match s.to_lowercase().as_str() {
            "primary" => Some(ResponseType::Primary),
            "addition" => Some(ResponseType::Addition),
            "rebuttal" => Some(ResponseType::Rebuttal),
            "debate" => Some(ResponseType::Debate),
            _ => None,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OrchestratorDecision {
    #[serde(alias = "primary")]
    pub primary_agent: String,
    pub add_secondary: bool,
    #[serde(alias = "secondary")]
    pub secondary_agent: Option<String>,
    #[serde(alias = "type")]
    pub secondary_type: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentResponse {
    pub agent: String,
    pub content: String,
    pub response_type: String,
    pub references_message_id: Option<String>,
}

pub struct Orchestrator {
    client: OpenAIClient,
}

impl Orchestrator {
    pub fn new(api_key: &str) -> Self {
        Self {
            client: OpenAIClient::new(api_key),
        }
    }
    
    /// Decide which agent(s) should respond to a user message
    pub async fn decide_response(
        &self,
        user_message: &str,
        conversation_history: &[Message],
        weights: (f64, f64, f64),
        active_agents: &[String],
    ) -> Result<OrchestratorDecision, Box<dyn Error + Send + Sync>> {
        self.decide_response_with_patterns(user_message, conversation_history, weights, active_agents, None).await
    }
    
    /// Decide which agent(s) should respond, with pattern awareness
    pub async fn decide_response_with_patterns(
        &self,
        user_message: &str,
        conversation_history: &[Message],
        weights: (f64, f64, f64),
        active_agents: &[String],
        user_profile: Option<&UserProfileSummary>,
    ) -> Result<OrchestratorDecision, Box<dyn Error + Send + Sync>> {
        // If only one agent is active, use them as primary
        if active_agents.len() == 1 {
            return Ok(OrchestratorDecision {
                primary_agent: active_agents[0].clone(),
                add_secondary: false,
                secondary_agent: None,
                secondary_type: None,
            });
        }
        
        let (instinct_w, logic_w, psyche_w) = weights;
        
        // Build context from recent messages
        let history_context: String = conversation_history
            .iter()
            .rev()
            .take(10)
            .rev()
            .map(|m| format!("{}: {}", m.role.to_uppercase(), m.content))
            .collect::<Vec<_>>()
            .join("\n");
        
        let active_list = active_agents.join(", ");
        
        // Build user patterns context if available
        let patterns_context = if let Some(profile) = user_profile {
            let mut parts = Vec::new();
            if let Some(style) = &profile.communication_style {
                parts.push(format!("- Communication style: {}", style));
            }
            if let Some(thinking) = &profile.thinking_preference {
                parts.push(format!("- Thinking preference: {}", thinking));
            }
            if let Some(emotional) = &profile.emotional_tendency {
                parts.push(format!("- Emotional tendency: {}", emotional));
            }
            if !profile.recurring_themes.is_empty() {
                parts.push(format!("- Often discusses: {}", profile.recurring_themes.iter().take(5).cloned().collect::<Vec<_>>().join(", ")));
            }
            if parts.is_empty() {
                String::new()
            } else {
                format!("\n\nUSER PATTERNS (consider when routing):\n{}", parts.join("\n"))
            }
        } else {
            String::new()
        };
        
        let system_prompt = format!(r#"You are the Intersect Governor/orchestrator. Given a user message and conversation context, decide which agent(s) should respond.

AGENTS (only use these if they are active: {active_list}):
- Instinct (Snap): Gut feelings, quick pattern recognition, emotional intelligence. Current weight: {:.0}%
- Logic (Dot): Analytical thinking, structured reasoning, evidence-based. Current weight: {:.0}%  
- Psyche (Puff): Self-awareness, motivations, emotional depth, "why" behind "what". Current weight: {:.0}%

DECISION CRITERIA:
1. PRIMARY_AGENT: Who should respond first? Consider:
   - Message topic and nature
   - Agent weights (higher weight = more affinity with this user)
   - User's communication patterns (if available)
   - Which perspective is most relevant

2. ADD_SECONDARY: Should another agent add/challenge? 
   - true: Topic has multiple angles, or primary might miss something important
   - false: Straightforward topic, one perspective suffices (prefer this for casual exchanges)

3. SECONDARY_TYPE (if adding):
   - "addition": Adds a caveat or different angle (mild, collaborative)
   - "rebuttal": Challenges or disagrees (moderate tension)
   - "debate": Strong disagreement, may trigger back-and-forth (rare, only for big disagreements)
{patterns_context}

CONVERSATION HISTORY:
{history_context}

Respond with ONLY valid JSON:
{{"primary": "agent_name", "add_secondary": true/false, "secondary": "agent_name or null", "type": "addition/rebuttal/debate or null"}}"#,
            instinct_w * 100.0,
            logic_w * 100.0,
            psyche_w * 100.0
        );
        
        let messages = vec![
            ChatMessage {
                role: "system".to_string(),
                content: system_prompt,
            },
            ChatMessage {
                role: "user".to_string(),
                content: format!("USER MESSAGE: {}", user_message),
            },
        ];
        
        let response = self.client.chat_completion(messages, 0.3, Some(150)).await?;
        
        // Parse JSON response
        let cleaned = response.trim().trim_start_matches("```json").trim_end_matches("```").trim();
        
        let decision: OrchestratorDecision = serde_json::from_str(cleaned).map_err(|e| {
            format!("Failed to parse orchestrator response: {}. Response was: {}", e, cleaned)
        })?;
        
        println!("[TURN-TAKING] Decision: primary={}, add_secondary={}, secondary={:?}, type={:?}",
            decision.primary_agent, decision.add_secondary, decision.secondary_agent, decision.secondary_type);
        
        // Validate that chosen agents are active
        let primary = if active_agents.contains(&decision.primary_agent) {
            decision.primary_agent
        } else {
            active_agents[0].clone()
        };
        
        let secondary = decision.secondary_agent.and_then(|s| {
            if active_agents.contains(&s) && s != primary {
                Some(s)
            } else {
                None
            }
        });
        
        Ok(OrchestratorDecision {
            primary_agent: primary,
            add_secondary: secondary.is_some(),
            secondary_agent: secondary,
            secondary_type: decision.secondary_type,
        })
    }
    
    /// Decide what grounding/context agents need for this message
    pub async fn decide_grounding(
        &self,
        user_message: &str,
        user_profile: &UserProfileSummary,
        conversation_context: Option<&str>,
    ) -> Result<GroundingDecision, Box<dyn Error + Send + Sync>> {
        // Build a condensed profile summary
        let profile_summary = format_profile_condensed(user_profile);
        
        let system_prompt = r#"You are the Governor in Intersect, deciding how much user context agents need for this response.

GROUNDING LEVELS:
- "light": Casual/quick exchanges, no personal context needed. Just answer the question.
- "moderate": Relevant personal context would help. Include facts that relate to the topic.
- "deep": Personal/sensitive topic. Full profile awareness for thoughtful, grounded response.

Based on the user's message, decide:
1. GROUNDING_LEVEL: How much context do agents need?
2. RELEVANT_FACTS: Which fact categories matter? (personal, work, preferences, relationships, values, interests)
3. RELEVANT_PATTERNS: Which behavioral patterns matter? (communication_style, thinking_mode, emotional_tendency)
4. INCLUDE_PAST_CONTEXT: Should we reference past conversations?

Respond with ONLY valid JSON:
{"grounding_level": "light/moderate/deep", "relevant_facts": ["category1"], "relevant_patterns": ["type1"], "include_past_context": true/false}"#;

        let user_prompt = format!(
            "USER PROFILE SUMMARY:\n{}\n\nCONVERSATION CONTEXT:\n{}\n\nUSER MESSAGE:\n{}\n\nDecide grounding level:",
            profile_summary,
            conversation_context.unwrap_or("New conversation"),
            user_message
        );

        let messages = vec![
            ChatMessage {
                role: "system".to_string(),
                content: system_prompt.to_string(),
            },
            ChatMessage {
                role: "user".to_string(),
                content: user_prompt,
            },
        ];

        let response = self.client.chat_completion(messages, 0.2, Some(200)).await?;
        
        let cleaned = response
            .trim()
            .trim_start_matches("```json")
            .trim_end_matches("```")
            .trim();
        
        let decision: GroundingDecision = serde_json::from_str(cleaned).unwrap_or_else(|e| {
            println!("[GROUNDING] Failed to parse: {}. Using default.", e);
            GroundingDecision::default()
        });
        
        println!("[GROUNDING] Decision: level={}, facts={:?}, patterns={:?}", 
            decision.grounding_level, decision.relevant_facts, decision.relevant_patterns);
        
        Ok(decision)
    }
    
    /// Get a response from a specific agent with grounded context
    pub async fn get_agent_response(
        &self,
        agent: Agent,
        user_message: &str,
        conversation_history: &[Message],
        response_type: ResponseType,
        primary_response: Option<&str>,
        primary_agent: Option<&str>,
    ) -> Result<String, Box<dyn Error + Send + Sync>> {
        // Use default grounding for backward compatibility
        self.get_agent_response_with_grounding(
            agent,
            user_message,
            conversation_history,
            response_type,
            primary_response,
            primary_agent,
            None,
            None,
        ).await
    }
    
    /// Get a response from a specific agent with explicit grounding and self-knowledge
    pub async fn get_agent_response_with_grounding(
        &self,
        agent: Agent,
        user_message: &str,
        conversation_history: &[Message],
        response_type: ResponseType,
        primary_response: Option<&str>,
        primary_agent: Option<&str>,
        grounding: Option<&GroundingDecision>,
        user_profile: Option<&UserProfileSummary>,
    ) -> Result<String, Box<dyn Error + Send + Sync>> {
        // Use knowledge-aware prompt that injects self-knowledge when relevant
        let system_prompt = get_agent_system_prompt_with_knowledge(
            agent, 
            response_type, 
            primary_response, 
            primary_agent,
            grounding,
            user_profile,
            user_message,
        );
        
        // Build conversation context
        let mut messages: Vec<ChatMessage> = vec![
            ChatMessage {
                role: "system".to_string(),
                content: system_prompt,
            },
        ];
        
        // Add recent conversation history (without meta tags that LLM might mimic)
        for msg in conversation_history.iter().rev().take(15).rev() {
            let role = if msg.role == "user" {
                "user".to_string()
            } else {
                "assistant".to_string()
            };
            messages.push(ChatMessage {
                role,
                content: msg.content.clone(),
            });
        }
        
        // Add the current user message
        messages.push(ChatMessage {
            role: "user".to_string(),
            content: user_message.to_string(),
        });
        
        // If this is a secondary response, add context about the primary
        if let Some(primary) = primary_response {
            let agent_name = match primary_agent {
                Some("instinct") => "Snap (Instinct)",
                Some("logic") => "Dot (Logic)",
                Some("psyche") => "Puff (Psyche)",
                _ => "another agent",
            };
            messages.push(ChatMessage {
                role: "assistant".to_string(),
                content: primary.to_string(),
            });
            messages.push(ChatMessage {
                role: "user".to_string(),
                content: format!("{} just responded. Now it's your turn - acknowledge what they said if relevant, then add your perspective.", agent_name),
            });
        }
        
        let temperature = match agent {
            Agent::Instinct => 0.8,  // More intuitive, spontaneous
            Agent::Logic => 0.4,     // More precise, structured
            Agent::Psyche => 0.6,    // Balanced, introspective
        };
        
        self.client.chat_completion(messages, temperature, Some(1024)).await
    }
    
    /// Generate an agent's opening greeting for a new conversation
    pub async fn generate_conversation_opener(
        &self,
        recent_conversations: &[db::Conversation],
        agent: &str,
    ) -> Result<String, Box<dyn Error + Send + Sync>> {
        let context = if recent_conversations.is_empty() {
            "This is the user's first conversation.".to_string()
        } else {
            let recent: Vec<String> = recent_conversations
                .iter()
                .take(3)
                .filter_map(|c| c.title.as_ref())
                .map(|t| format!("- {}", t))
                .collect();
            if recent.is_empty() {
                "The user has had some conversations but no specific topics recorded.".to_string()
            } else {
                format!("Recent conversation topics:\n{}", recent.join("\n"))
            }
        };
        
        let (name, personality) = match agent {
            "instinct" => ("Snap", "You're intuitive, direct, and trust your gut. You cut through the noise and speak from feel."),
            "psyche" => ("Puff", "You're reflective, empathetic, and attuned to deeper meaning. You sense what's beneath the surface."),
            _ => ("Dot", "You're methodical, precise, and grounded in reason. You approach things with clarity and structure."),
        };
        
        let system_prompt = format!(r#"You are {} ({}), one of three AI agents in Intersect. Open the conversation with a brief, casual greeting.

Guidelines:
- Keep it SHORT - just 1-2 sentences max
- Don't ask leading or specific questions
- Simple: "Hey", "What's on your mind?", "Back again", etc.
- If they've been chatting recently, acknowledge casually but don't interrogate
- Never be robotic, sycophantic, or overly formal
- You're a familiar presence, not a customer service bot
- {}

Just say hi and let them lead."#, name, agent.to_uppercase(), personality);

        let messages = vec![
            ChatMessage {
                role: "system".to_string(),
                content: system_prompt,
            },
            ChatMessage {
                role: "user".to_string(),
                content: context,
            },
        ];
        
        self.client.chat_completion(messages, 0.8, Some(100)).await
    }
}

/// Get the system prompt for an agent based on response type
fn get_agent_system_prompt(agent: Agent, response_type: ResponseType, primary_response: Option<&str>, primary_agent: Option<&str>) -> String {
    let base_prompt = match agent {
        Agent::Instinct => r#"You are Snap (INSTINCT), one of three agents in Intersect. You represent:
- Gut feelings and intuition
- Quick pattern recognition
- Emotional intelligence
- First impressions and instinctive reads

Your voice is: Direct, confident, cuts through the noise. You trust your read and aren't afraid to say what you sense. You speak in a visceral, immediate way."#,
        
        Agent::Logic => r#"You are Dot (LOGIC), one of three agents in Intersect. You represent:
- Analytical thinking
- Structured reasoning
- Evidence-based conclusions
- Systematic problem-solving

Your voice is: Precise, methodical, clear. You break things down, examine the pieces, and build toward conclusions. You appreciate nuance but value clarity."#,
        
        Agent::Psyche => r#"You are Puff (PSYCHE), one of three agents in Intersect. You represent:
- Self-awareness and introspection
- Understanding motivations
- Emotional depth
- The "why" behind the "what"

Your voice is: Thoughtful, probing, empathetic. You look beneath the surface. You're interested in what drives people, including the user."#,
    };
    
    let primary_name = match primary_agent {
        Some("instinct") => "Snap",
        Some("logic") => "Dot",
        Some("psyche") => "Puff",
        _ => "another agent",
    };
    
    let response_context = match response_type {
        ResponseType::Primary => {
            "You are responding first to the user. Give your perspective directly.".to_string()
        }
        ResponseType::Addition => {
            format!(
                "{} just responded: \"{}\"\n\nYou want to ADD something {} might have missed or offer a complementary angle. Briefly acknowledge their point if relevant, then add your distinct perspective.",
                primary_name, primary_response.unwrap_or(""), primary_name
            )
        }
        ResponseType::Rebuttal => {
            format!(
                "{} responded: \"{}\"\n\nYou DISAGREE with {}'s take or see a significant flaw. Acknowledge what they said, then challenge their perspective respectfully but firmly.",
                primary_name, primary_response.unwrap_or(""), primary_name
            )
        }
        ResponseType::Debate => {
            format!(
                "{} responded: \"{}\"\n\nYou STRONGLY DISAGREE with {}. This is a debate. Reference their argument, then make your counter-argument forcefully. The user will see both perspectives.",
                primary_name, primary_response.unwrap_or(""), primary_name
            )
        }
    };
    
    format!("{}\n\n{}\n\nIMPORTANT: Never prefix your response with your name, labels, or tags like [INSTINCT]: or similar. Just respond directly. Be concise but substantive. Don't use emojis. Don't be sycophantic. Be genuine.", base_prompt, response_context)
}

/// Get the system prompt for an agent with grounding context and optional self-knowledge
fn get_agent_system_prompt_with_grounding(
    agent: Agent, 
    response_type: ResponseType, 
    primary_response: Option<&str>, 
    primary_agent: Option<&str>,
    grounding: Option<&GroundingDecision>,
    user_profile: Option<&UserProfileSummary>,
) -> String {
    let base_prompt = get_agent_system_prompt(agent, response_type, primary_response, primary_agent);
    
    let mut full_prompt = base_prompt;
    
    // Add grounding context if available
    if let (Some(grounding), Some(profile)) = (grounding, user_profile) {
        let level = GroundingLevel::from_str(&grounding.grounding_level)
            .unwrap_or(GroundingLevel::Light);
        
        let grounding_context = MemoryExtractor::format_profile_for_prompt(profile, level);
        
        if !grounding_context.is_empty() {
            let grounding_section = match level {
                GroundingLevel::Light => format!("\n\n--- Context ---\n{}\n---", grounding_context),
                GroundingLevel::Moderate => format!("\n\n--- About This User ---\n{}\n---\nUse this context naturally if relevant. Don't force it into the conversation.", grounding_context),
                GroundingLevel::Deep => format!("\n\n--- User Profile (Use Thoughtfully) ---\n{}\n---\nThis is a personal topic. Draw on what you know about this user to provide a grounded, relevant response.", grounding_context),
            };
            full_prompt = format!("{}{}", full_prompt, grounding_section);
        }
    }
    
    full_prompt
}

/// Get the system prompt with self-knowledge injected for self-referential queries
fn get_agent_system_prompt_with_knowledge(
    agent: Agent, 
    response_type: ResponseType, 
    primary_response: Option<&str>, 
    primary_agent: Option<&str>,
    grounding: Option<&GroundingDecision>,
    user_profile: Option<&UserProfileSummary>,
    user_message: &str,
) -> String {
    let base_prompt = get_agent_system_prompt_with_grounding(
        agent, response_type, primary_response, primary_agent, grounding, user_profile
    );
    
    // Check if the user is asking about Intersect itself
    if is_self_referential_query(user_message) {
        format!("{}\n\n{}", base_prompt, INTERSECT_KNOWLEDGE)
    } else {
        base_prompt
    }
}

/// Format a condensed profile summary for grounding decisions
fn format_profile_condensed(profile: &UserProfileSummary) -> String {
    let mut parts = Vec::new();
    
    // Add fact counts by category
    for (category, facts) in &profile.facts_by_category {
        if !facts.is_empty() {
            let high_conf = facts.iter().filter(|f| f.confidence >= 0.7).count();
            parts.push(format!("{}: {} facts ({} high-confidence)", category, facts.len(), high_conf));
        }
    }
    
    // Add patterns
    if let Some(style) = &profile.communication_style {
        parts.push(format!("Communication: {}", style));
    }
    if let Some(thinking) = &profile.thinking_preference {
        parts.push(format!("Thinking: {}", thinking));
    }
    
    // Add themes
    if !profile.recurring_themes.is_empty() {
        parts.push(format!("Recurring themes: {}", profile.recurring_themes.join(", ")));
    }
    
    if parts.is_empty() {
        "New user, no profile built yet.".to_string()
    } else {
        parts.join("\n")
    }
}

// ============ Weight Evolution ============

#[derive(Debug, Clone, Copy)]
pub enum InteractionType {
    ChosenAsPrimary,
    ChosenAsSecondary,
    UserEngaged,
    UserIgnored,
}

/// Calculate variability based on message count
/// Highly variable early (first 100 messages), exponentially rigid over time
/// At 10k+ messages, changes are nearly frozen but still possible
pub fn calculate_variability(total_messages: i64) -> f64 {
    // De-exponential curve: 1 / (1 + (messages/100)^1.5)
    // 0 messages: 1.0 (100% variability)
    // 100 messages: ~0.41 (41% variability)
    // 500 messages: ~0.08 (8% variability)
    // 2000 messages: ~0.018 (1.8% variability)
    // 10000 messages: ~0.003 (0.3% variability)
    1.0 / (1.0 + (total_messages as f64 / 100.0).powf(1.5))
}

/// Update agent weights based on interaction (legacy - used for primary/secondary selection)
pub fn evolve_weights(
    current_weights: (f64, f64, f64),
    agent: Agent,
    interaction: InteractionType,
    total_messages: i64,
) -> (f64, f64, f64) {
    let base_boost = match interaction {
        InteractionType::ChosenAsPrimary => 0.02,
        InteractionType::ChosenAsSecondary => 0.015,
        InteractionType::UserEngaged => 0.03,
        InteractionType::UserIgnored => -0.01,
    };
    
    // Apply de-exponential variability
    let variability = calculate_variability(total_messages);
    let adjusted_boost = base_boost * variability;
    
    let (mut instinct, mut logic, mut psyche) = current_weights;
    
    match agent {
        Agent::Instinct => instinct += adjusted_boost,
        Agent::Logic => logic += adjusted_boost,
        Agent::Psyche => psyche += adjusted_boost,
    }
    
    // Clamp to min 10%, max 60%
    instinct = instinct.clamp(0.1, 0.6);
    logic = logic.clamp(0.1, 0.6);
    psyche = psyche.clamp(0.1, 0.6);
    
    // Normalize to sum to 1.0
    let total = instinct + logic + psyche;
    (instinct / total, logic / total, psyche / total)
}

// ============ Engagement Analysis ============

/// Result of analyzing user engagement with agent responses
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EngagementAnalysis {
    pub logic_score: f64,      // -1.0 to 1.0 (disagreed to strongly engaged)
    pub instinct_score: f64,   // -1.0 to 1.0
    pub psyche_score: f64,     // -1.0 to 1.0
    pub reasoning: String,     // Brief explanation for logging
}

impl Default for EngagementAnalysis {
    fn default() -> Self {
        Self {
            logic_score: 0.0,
            instinct_score: 0.0,
            psyche_score: 0.0,
            reasoning: "No engagement detected".to_string(),
        }
    }
}

/// Analyzes user messages to detect engagement patterns with agents
pub struct EngagementAnalyzer {
    client: OpenAIClient,
}

impl EngagementAnalyzer {
    pub fn new(api_key: &str) -> Self {
        Self {
            client: OpenAIClient::new(api_key),
        }
    }
    
    /// Analyze user's response to determine which agent(s) they engaged with
    pub async fn analyze_engagement(
        &self,
        user_message: &str,
        previous_agent_responses: &[(Agent, String)],
    ) -> Result<EngagementAnalysis, Box<dyn Error + Send + Sync>> {
        if previous_agent_responses.is_empty() {
            return Ok(EngagementAnalysis::default());
        }
        
        // Build context of previous agent responses
        let agent_context: String = previous_agent_responses
            .iter()
            .map(|(agent, response)| {
                let name = match agent {
                    Agent::Logic => "Dot (Logic)",
                    Agent::Instinct => "Snap (Instinct)",
                    Agent::Psyche => "Puff (Psyche)",
                };
                format!("[{}]: {}", name, response)
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        
        let system_prompt = r#"You are an engagement analyzer for Intersect. Analyze how the user's response engages with the previous agent responses.

For each agent, assign a score from -1.0 to 1.0:
- 1.0: Strong agreement, follow-up questions, adopting their framing
- 0.5: Moderate engagement, building on their point
- 0.0: Neutral, no clear engagement
- -0.5: Mild disagreement or dismissal
- -1.0: Strong disagreement or rejection

Look for signals like:
- Explicit agreement/disagreement ("Good point", "I don't think so")
- Follow-up questions to a specific agent's point
- Adopting an agent's language or suggested approach
- Acting on an agent's suggestion
- Emotional resonance with an agent's perspective
- Asking for elaboration from a specific perspective

Respond in this exact JSON format:
{
  "logic_score": 0.0,
  "instinct_score": 0.0,
  "psyche_score": 0.0,
  "reasoning": "Brief explanation of engagement patterns detected"
}

Be nuanced - most responses will have subtle engagement patterns, not extreme scores. If the user is simply continuing the conversation without clear preference, keep scores near 0."#;

        let user_prompt = format!(
            "PREVIOUS AGENT RESPONSES:\n{}\n\nUSER'S RESPONSE:\n{}\n\nAnalyze engagement:",
            agent_context, user_message
        );
        
        let messages = vec![
            ChatMessage {
                role: "system".to_string(),
                content: system_prompt.to_string(),
            },
            ChatMessage {
                role: "user".to_string(),
                content: user_prompt,
            },
        ];
        
        let response = self.client.chat_completion(messages, 0.3, None).await?;
        
        // Parse JSON response
        let analysis: EngagementAnalysis = serde_json::from_str(&response)
            .unwrap_or_else(|_| EngagementAnalysis::default());
        
        Ok(analysis)
    }
}

/// Apply engagement analysis to update weights with de-exponential rigidity
pub fn apply_engagement_weights(
    current_weights: (f64, f64, f64),
    analysis: &EngagementAnalysis,
    total_messages: i64,
) -> (f64, f64, f64) {
    let variability = calculate_variability(total_messages);
    let base_boost = 0.03; // Maximum possible shift per interaction
    
    let (mut instinct, mut logic, mut psyche) = current_weights;
    
    // Apply engagement scores with variability dampening
    logic += analysis.logic_score * base_boost * variability;
    instinct += analysis.instinct_score * base_boost * variability;
    psyche += analysis.psyche_score * base_boost * variability;
    
    // Clamp to min 10%, max 60%
    instinct = instinct.clamp(0.1, 0.6);
    logic = logic.clamp(0.1, 0.6);
    psyche = psyche.clamp(0.1, 0.6);
    
    // Normalize to sum to 1.0
    let total = instinct + logic + psyche;
    (instinct / total, logic / total, psyche / total)
}

