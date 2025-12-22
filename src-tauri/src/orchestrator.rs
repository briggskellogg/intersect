use crate::anthropic::{AnthropicClient, AnthropicMessage, ThinkingBudget, CLAUDE_SONNET, CLAUDE_OPUS};
use crate::db::{self, Message};
use crate::disco_prompts::get_disco_prompt;
use crate::knowledge::{INTERSECT_KNOWLEDGE, is_self_referential_query};
use crate::memory::{GroundingLevel, UserProfileSummary, MemoryExtractor};
use crate::openai::{ChatMessage, OpenAIClient};
use serde::{Deserialize, Serialize};
use std::error::Error;

// ============ Profile Context (Multi-Profile System) ============

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileContext {
    pub active_profile_name: String,
    pub other_profile_names: Vec<String>,
    pub is_disco: bool,
}

impl ProfileContext {
    /// Get the current profile context from the database
    pub fn get_current() -> Option<Self> {
        let profiles = db::get_all_persona_profiles().ok()?;
        let active = profiles.iter().find(|p| p.is_active)?;
        
        let other_names: Vec<String> = profiles.iter()
            .filter(|p| !p.is_active)
            .map(|p| p.name.clone())
            .collect();
        
        Some(ProfileContext {
            active_profile_name: active.name.clone(),
            other_profile_names: other_names,
            is_disco: false, // Set by caller
        })
    }
    
    /// Format profile context for injection into agent prompts
    pub fn format_for_prompt(&self) -> String {
        if self.other_profile_names.is_empty() {
            format!(
                "The user is currently in their \"{}\" profile.",
                self.active_profile_name
            )
        } else {
            let disco_note = if self.is_disco {
                " In Disco Mode, you may reference profile differences more freely and use them to challenge or ground the user."
            } else {
                " Reference other profiles sparingly and only when genuinely helpful."
            };
            
            format!(
                "The user has multiple profiles. Currently active: \"{}\". Other profiles: {}.{}",
                self.active_profile_name,
                self.other_profile_names.iter()
                    .map(|n| format!("\"{}\"", n))
                    .collect::<Vec<_>>()
                    .join(", "),
                disco_note
            )
        }
    }
}

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
    openai_client: OpenAIClient,      // For agent responses (GPT-4o)
    anthropic_client: AnthropicClient, // For orchestration decisions (Claude Opus 4.5)
}

impl Orchestrator {
    pub fn new(openai_key: &str, anthropic_key: &str) -> Self {
        Self {
            openai_client: OpenAIClient::new(openai_key),
            anthropic_client: AnthropicClient::new(anthropic_key),
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
        self.decide_response_with_patterns(user_message, conversation_history, weights, active_agents, None, &[]).await
    }
    
    /// Decide which agent(s) should respond, with pattern awareness and disco mode support
    pub async fn decide_response_with_patterns(
        &self,
        user_message: &str,
        conversation_history: &[Message],
        weights: (f64, f64, f64),
        active_agents: &[String],
        user_profile: Option<&UserProfileSummary>,
        disco_agents: &[String],
    ) -> Result<OrchestratorDecision, Box<dyn Error + Send + Sync>> {
        // ===== ALL-AGENT REQUEST DETECTION =====
        // If user explicitly asks for all agents, we'll signal this in the decision
        let msg_lower = user_message.to_lowercase();
        let all_agent_request = msg_lower.contains("all of you") 
            || msg_lower.contains("all three")
            || msg_lower.contains("each of you")
            || msg_lower.contains("everyone")
            || msg_lower.contains("hear from all")
            || msg_lower.contains("want to hear from each")
            || msg_lower.contains("all your perspectives");
        
        // If user wants all agents and we have 3 active, return special "all_agents" decision
        if all_agent_request && active_agents.len() >= 3 {
            println!("[TURN-TAKING] User requested all agents - all 3 will respond");
            // Return a decision that will trigger all-agent mode
            // We use "all_agents" as the secondary_type to signal this
            return Ok(OrchestratorDecision {
                primary_agent: active_agents[0].clone(),
                add_secondary: true,
                secondary_agent: Some("all".to_string()), // Special marker for "all agents"
                secondary_type: Some("all_agents".to_string()),
            });
        }
        
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
        
        // ===== FORCED INCLUSION: Check if any agent has been excluded for 3+ exchanges =====
        // Count how many user exchanges each agent hasn't participated in
        let mut agent_silence_count: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        for agent in active_agents {
            agent_silence_count.insert(agent.clone(), 0);
        }
        
        // Look at the last 6 exchanges (user + agent pairs) to count silence
        let mut user_exchanges = 0;
        for msg in conversation_history.iter().rev() {
            if msg.role == "user" {
                user_exchanges += 1;
                if user_exchanges > 6 { break; }
            } else if active_agents.contains(&msg.role) {
                // This agent spoke, reset their silence
                agent_silence_count.insert(msg.role.clone(), 0);
            }
            // Increment silence for agents that didn't speak since last user message
            if msg.role == "user" {
                for agent in active_agents {
                    if let Some(count) = agent_silence_count.get_mut(agent) {
                        *count += 1;
                    }
                }
            }
        }
        
        // Find agent that's been silent for 3+ exchanges
        let forced_agent: Option<String> = agent_silence_count.iter()
            .filter(|(agent, count)| **count >= 3 && active_agents.contains(agent))
            .max_by_key(|(_, count)| *count)
            .map(|(agent, _)| agent.clone());
        
        let forced_inclusion_context = if let Some(ref agent) = forced_agent {
            format!("\n\nFORCED INCLUSION: {} has NOT participated in the last 3+ exchanges. \
                     You MUST include {} as either primary or secondary in this response to ensure balanced participation.", 
                     agent, agent)
        } else {
            String::new()
        };
        
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
        
        // Build disco mode context - increases probability of multi-agent responses
        let disco_context = if !disco_agents.is_empty() {
            let disco_list = disco_agents.join(", ");
            format!("\n\nDISCO MODE ACTIVE: {} are in Disco Mode (intense, opinionated). \
                     When Disco agents are active, STRONGLY prefer adding secondary responses. \
                     Disco agents are more likely to have strong opinions worth expressing.", disco_list)
        } else {
            String::new()
        };
        
        // Adjust secondary probability based on disco mode
        let secondary_guidance = if !disco_agents.is_empty() {
            "   - With Disco Mode active, lean toward TRUE (60%+ of the time) - Disco agents want to be heard"
        } else {
            "   - false: Straightforward topic, one perspective suffices (prefer this for casual exchanges)"
        };
        
        let system_prompt = format!(r#"You are the Intersect Governor/orchestrator. Given a user message and conversation context, decide which agent(s) should respond.

AGENTS (only use these if they are active: {active_list}):
- Instinct (Snap): Gut feelings, quick pattern recognition, emotional intelligence. Current weight: {:.0}%
- Logic (Dot): Analytical thinking, structured reasoning, evidence-based. Current weight: {:.0}%  
- Psyche (Puff): Self-awareness, motivations, emotional depth, "why" behind "what". Current weight: {:.0}%
{disco_context}

DECISION CRITERIA:
1. PRIMARY_AGENT: Who should respond first? Consider:
   - Message topic and nature
   - Agent weights (higher weight = more affinity with this user)
   - User's communication patterns (if available)
   - Which perspective is most relevant

2. ADD_SECONDARY: Should another agent add/challenge? 
   - true: Topic has multiple angles, or primary might miss something important
{secondary_guidance}

3. SECONDARY_TYPE (if adding):
   - "addition": Adds a caveat or different angle (mild, collaborative)
   - "rebuttal": Challenges or disagrees (moderate tension)
   - "debate": Strong disagreement, may trigger back-and-forth (rare, only for big disagreements)
{patterns_context}{forced_inclusion_context}

CONVERSATION HISTORY:
{history_context}

Respond with ONLY valid JSON:
{{"primary": "agent_name", "add_secondary": true/false, "secondary": "agent_name or null", "type": "addition/rebuttal/debate or null"}}"#,
            instinct_w * 100.0,
            logic_w * 100.0,
            psyche_w * 100.0
        );
        
        // Use Anthropic client for orchestration decisions (Claude Opus 4.5)
        let messages = vec![
            AnthropicMessage {
                role: "user".to_string(),
                content: format!("USER MESSAGE: {}", user_message),
            },
        ];
        
        let response = self.anthropic_client.chat_completion(
            Some(&system_prompt),
            messages,
            0.3,
            Some(150)
        ).await?;
        
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
        
        // If we have a forced agent that wasn't included, override
        let (final_primary, final_secondary) = if let Some(ref forced) = forced_agent {
            if primary != *forced && secondary.as_ref() != Some(forced) {
                // Forced agent wasn't included, add them as secondary
                println!("[TURN-TAKING] Forcing {} to participate (3+ exchanges silent)", forced);
                (primary, Some(forced.clone()))
            } else {
                (primary, secondary)
            }
        } else {
            (primary, secondary)
        };
        
        Ok(OrchestratorDecision {
            primary_agent: final_primary,
            add_secondary: final_secondary.is_some(),
            secondary_agent: final_secondary,
            secondary_type: decision.secondary_type,
        })
    }
    
    /// Decide whether to continue a multi-turn debate (for Disco Mode)
    /// Returns: (should_continue, next_agent, response_type)
    pub async fn should_continue_debate(
        &self,
        user_message: &str,
        responses_so_far: &[(String, String)], // Vec of (agent, content)
        active_agents: &[String],
        disco_agents: &[String],
        response_count: usize,
    ) -> Result<(bool, Option<String>, Option<String>), Box<dyn Error + Send + Sync>> {
        // Hard limit: never exceed 4 responses total
        if response_count >= 4 {
            println!("[DEBATE] Hit max response limit (4), ending debate");
            return Ok((false, None, None));
        }
        
        // NOTE: Disco mode increases likelihood of debates but doesn't block them in normal mode
        // Debates can happen naturally when there's genuine disagreement
        
        // Build context of responses so far
        let debate_context: String = responses_so_far
            .iter()
            .map(|(agent, content)| format!("{}: {}", agent.to_uppercase(), content))
            .collect::<Vec<_>>()
            .join("\n\n");
        
        let agents_who_responded: Vec<&String> = responses_so_far.iter().map(|(a, _)| a).collect();
        let agents_who_havent: Vec<&String> = active_agents.iter()
            .filter(|a| !agents_who_responded.contains(a))
            .collect();
        
        let disco_list = if disco_agents.is_empty() { 
            "none".to_string() 
        } else { 
            disco_agents.join(", ") 
        };
        
        // Track who has spoken and how many times
        let mut response_counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        for (agent, _) in responses_so_far {
            *response_counts.entry(agent.clone()).or_insert(0) += 1;
        }
        let agents_responded_once: Vec<&String> = response_counts.iter()
            .filter(|(_, count)| **count == 1)
            .map(|(agent, _)| agent)
            .collect();
        
        let system_prompt = format!(r#"You are the Intersect Governor evaluating an ongoing multi-agent exchange.

CONTEXT:
- User asked: "{user_message}"
- {response_count} agent responses have been given (max 4)
- Disco Mode agents (more intense): {disco_list}
- Agents who haven't spoken: {agents_list}
- Agents who could respond again: {agents_who_could_double}

RESPONSES SO FAR:
{debate_context}

DECISION: Should another agent jump in?

Consider:
1. Is there genuine disagreement worth expressing? (debates happen naturally, not just in Disco Mode)
2. Would another agent strongly disagree with what was just said?
3. An agent CAN respond a second time if they have something meaningful to add to new points
   (e.g., Psyche responds, Instinct agrees, Logic disagrees, Psyche could respond to Logic's challenge)
4. Disco agents are MORE likely to want to interject, but non-disco agents can too
5. Prefer STOPPING if the exchange feels complete or would just belabor the point

IMPORTANT: You can pick ANY active agent, including one who already spoke once, if they would genuinely have something new to say in response to recent points.

Respond with ONLY valid JSON:
{{"continue": true/false, "next_agent": "agent_name or null", "type": "addition/rebuttal/debate or null", "reason": "brief reason"}}"#,
            agents_list = agents_who_havent.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", "),
            agents_who_could_double = agents_responded_once.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")
        );
        
        // Use Anthropic client for debate continuation (Sonnet, thinking low)
        let messages = vec![
            AnthropicMessage {
                role: "user".to_string(),
                content: "Evaluate whether to continue the exchange based on the context above.".to_string(),
            },
        ];
        
        let response = self.anthropic_client.chat_completion_advanced(
            CLAUDE_SONNET,
            Some(&system_prompt),
            messages,
            0.4,
            Some(150),
            ThinkingBudget::Low
        ).await?;
        
        let cleaned = response.trim().trim_start_matches("```json").trim_end_matches("```").trim();
        
        #[derive(Deserialize)]
        struct ContinueDecision {
            #[serde(rename = "continue")]
            should_continue: bool,
            next_agent: Option<String>,
            #[serde(rename = "type")]
            response_type: Option<String>,
            reason: Option<String>,
        }
        
        match serde_json::from_str::<ContinueDecision>(cleaned) {
            Ok(decision) => {
                println!("[DEBATE] Continue={}, next={:?}, reason={:?}", 
                    decision.should_continue, decision.next_agent, decision.reason);
                
                // Validate the chosen agent is active and hasn't responded recently
                let next = decision.next_agent.and_then(|a| {
                    if active_agents.contains(&a) {
                        Some(a)
                    } else {
                        None
                    }
                });
                
                Ok((decision.should_continue && next.is_some(), next, decision.response_type))
            }
            Err(e) => {
                println!("[DEBATE] Failed to parse continue decision: {}", e);
                Ok((false, None, None))
            }
        }
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

        // Use Anthropic client for grounding decision (Sonnet, thinking medium)
        let messages = vec![
            AnthropicMessage {
                role: "user".to_string(),
                content: user_prompt,
            },
        ];

        let response = self.anthropic_client.chat_completion_advanced(
            CLAUDE_SONNET,
            Some(system_prompt),
            messages,
            0.2,
            Some(200),
            ThinkingBudget::Medium
        ).await?;
        
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
        is_disco: bool,
        primary_is_disco: bool,
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
            is_disco,
            primary_is_disco,
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
        is_disco: bool,
        primary_is_disco: bool,
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
            is_disco,
            primary_is_disco,
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
        
        // Use OpenAI client for agent responses (GPT-4o)
        // Max 300 tokens - enough for a substantive response but prevents rambling
        self.openai_client.chat_completion(messages, temperature, Some(300)).await
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
        
        // Use OpenAI client for agent responses (GPT-4o)
        self.openai_client.chat_completion(messages, 0.8, Some(100)).await
    }
}

/// Get the system prompt for an agent based on response type and disco mode
/// primary_is_disco: whether the agent being responded to was in disco mode (for push-back)
fn get_agent_system_prompt(agent: Agent, response_type: ResponseType, primary_response: Option<&str>, primary_agent: Option<&str>, is_disco: bool, primary_is_disco: bool) -> String {
    // Use disco mode prompts if enabled, otherwise use standard prompts
    let base_prompt = if is_disco {
        // Disco mode - use the extreme, opinionated Disco Elysium-inspired prompts
        match agent {
            Agent::Instinct => get_disco_prompt("instinct").unwrap_or(""),
            Agent::Logic => get_disco_prompt("logic").unwrap_or(""),
            Agent::Psyche => get_disco_prompt("psyche").unwrap_or(""),
        }
    } else {
        // Standard mode
        match agent {
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
        }
    };
    
    let primary_name = match primary_agent {
        Some("instinct") => "Snap",
        Some("logic") => "Dot",
        Some("psyche") => "Puff",
        _ => "another agent",
    };
    
    // Subtle push-back instruction when normal agent responds to disco agent
    let pushback_context = if !is_disco && primary_is_disco && response_type != ResponseType::Primary {
        "\n\nNote: The previous response was quite intense. Feel free to gently ground the conversation if needed. You might say things like \"I see it differently...\" or \"Let's consider another angle...\" — be a stabilizing presence without dismissing their perspective."
    } else {
        ""
    };
    
    let response_context = match response_type {
        ResponseType::Primary => {
            "You are responding first to the user. Give your perspective directly.".to_string()
        }
        ResponseType::Addition => {
            format!(
                "{} just responded: \"{}\"\n\nYou want to ADD something {} might have missed or offer a complementary angle. Briefly acknowledge their point if relevant, then add your distinct perspective.{}",
                primary_name, primary_response.unwrap_or(""), primary_name, pushback_context
            )
        }
        ResponseType::Rebuttal => {
            format!(
                "{} responded: \"{}\"\n\nYou DISAGREE with {}'s take or see a significant flaw. Acknowledge what they said, then challenge their perspective respectfully but firmly.{}",
                primary_name, primary_response.unwrap_or(""), primary_name, pushback_context
            )
        }
        ResponseType::Debate => {
            format!(
                "{} responded: \"{}\"\n\nYou STRONGLY DISAGREE with {}. This is a debate. Reference their argument, then make your counter-argument forcefully. The user will see both perspectives.{}",
                primary_name, primary_response.unwrap_or(""), primary_name, pushback_context
            )
        }
    };
    
    let disco_suffix = if is_disco {
        "\n\nYou are in DISCO MODE - be more intense, more opinionated, more visceral. Push harder. Challenge more. The user wants your unfiltered, extreme perspective."
    } else {
        ""
    };
    
    format!("{}\n\n{}\n\nIMPORTANT: Never prefix your response with your name, labels, or tags like [INSTINCT]: or similar. Just respond directly. Keep responses SHORT - typically 1-3 sentences, occasionally a short paragraph if truly needed. Don't ramble. Don't use emojis. Don't be sycophantic. Be genuine.{}", base_prompt, response_context, disco_suffix)
}

/// Get the system prompt for an agent with grounding context and optional self-knowledge
fn get_agent_system_prompt_with_grounding(
    agent: Agent, 
    response_type: ResponseType, 
    primary_response: Option<&str>, 
    primary_agent: Option<&str>,
    grounding: Option<&GroundingDecision>,
    user_profile: Option<&UserProfileSummary>,
    is_disco: bool,
    primary_is_disco: bool,
) -> String {
    let base_prompt = get_agent_system_prompt(agent, response_type, primary_response, primary_agent, is_disco, primary_is_disco);
    
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

/// Get the system prompt with self-knowledge and profile context injected
fn get_agent_system_prompt_with_knowledge(
    agent: Agent, 
    response_type: ResponseType, 
    primary_response: Option<&str>, 
    primary_agent: Option<&str>,
    grounding: Option<&GroundingDecision>,
    user_profile: Option<&UserProfileSummary>,
    user_message: &str,
    is_disco: bool,
    primary_is_disco: bool,
) -> String {
    let base_prompt = get_agent_system_prompt_with_grounding(
        agent, response_type, primary_response, primary_agent, grounding, user_profile, is_disco, primary_is_disco
    );
    
    let mut full_prompt = base_prompt;
    
    // Inject profile context (multi-profile system awareness)
    if let Some(mut profile_ctx) = ProfileContext::get_current() {
        profile_ctx.is_disco = is_disco;
        let profile_info = profile_ctx.format_for_prompt();
        full_prompt = format!("{}\n\n--- Profile Context ---\n{}\n---", full_prompt, profile_info);
    }
    
    // Check if the user is asking about Intersect itself
    if is_self_referential_query(user_message) {
        format!("{}\n\n{}", full_prompt, INTERSECT_KNOWLEDGE)
    } else {
        full_prompt
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
    client: AnthropicClient, // Uses Claude Opus 4.5 for analysis
}

impl EngagementAnalyzer {
    pub fn new(anthropic_key: &str) -> Self {
        Self {
            client: AnthropicClient::new(anthropic_key),
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
        
        // Use Anthropic client for analysis (Opus, no thinking)
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
            0.3,
            None,
            ThinkingBudget::None
        ).await?;
        
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

// ============ Intrinsic Trait Analysis ============

/// Result of analyzing a user message for intrinsic trait signals
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct IntrinsicTraitAnalysis {
    pub logic_signal: f64,    // 0.0 to 1.0 (how much logic is exhibited)
    pub instinct_signal: f64, // 0.0 to 1.0 (how much instinct is exhibited)
    pub psyche_signal: f64,   // 0.0 to 1.0 (how much psyche is exhibited)
    pub reasoning: String,    // Brief explanation for logging
}

impl Default for IntrinsicTraitAnalysis {
    fn default() -> Self {
        Self {
            logic_signal: 0.33,
            instinct_signal: 0.33,
            psyche_signal: 0.33,
            reasoning: "Neutral message".to_string(),
        }
    }
}

/// Analyzes user messages for intrinsic trait signals (independent of agent responses)
pub struct IntrinsicTraitAnalyzer {
    client: AnthropicClient, // Uses Claude Opus 4.5 for analysis
}

impl IntrinsicTraitAnalyzer {
    pub fn new(anthropic_key: &str) -> Self {
        Self {
            client: AnthropicClient::new(anthropic_key),
        }
    }
    
    /// Analyze a user message for intrinsic trait signals
    pub async fn analyze(
        &self,
        user_message: &str,
    ) -> Result<IntrinsicTraitAnalysis, Box<dyn Error + Send + Sync>> {
        // Skip very short messages
        if user_message.len() < 10 {
            return Ok(IntrinsicTraitAnalysis::default());
        }
        
        let system_prompt = r#"You are a trait analyzer for Intersect. Analyze the user's message to detect which cognitive traits are exhibited in HOW they communicate.

For each trait, assign a signal strength from 0.0 to 1.0:

LOGIC (analytical thinking):
- Step-by-step reasoning ("First... then... therefore...")
- Data references, statistics, evidence
- Structured arguments, pros/cons lists
- Seeking clarity, definitions, precision
- Cause-and-effect reasoning

INSTINCT (gut-driven thinking):
- Quick reactions, immediate judgments
- Emotional reads ("I feel like...", "My gut says...")
- Pattern recognition without explanation
- Decisive, action-oriented language
- Trusting first impressions

PSYCHE (reflective thinking):
- Self-reflection, introspection
- Exploring motivations ("Why do I feel this way?")
- Emotional depth and nuance
- Meaning-seeking, "bigger picture" questions
- Understanding underlying drives

SCORING GUIDELINES:
- Scores are NOT mutually exclusive - a message can exhibit multiple traits
- Most messages score 0.2-0.5 on each (subtle signals)
- Strong signals (0.7+) are rare and require clear evidence
- A neutral/ambiguous message scores ~0.33 on each

Respond in this exact JSON format:
{
  "logic_signal": 0.33,
  "instinct_signal": 0.33,
  "psyche_signal": 0.33,
  "reasoning": "Brief explanation of detected trait signals"
}"#;

        let user_prompt = format!("USER MESSAGE:\n{}\n\nAnalyze trait signals:", user_message);
        
        // Use Anthropic client for analysis (Opus, thinking medium)
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
            0.3,
            None,
            ThinkingBudget::Medium
        ).await?;
        
        // Parse JSON response
        let analysis: IntrinsicTraitAnalysis = serde_json::from_str(&response)
            .unwrap_or_else(|_| IntrinsicTraitAnalysis::default());
        
        Ok(analysis)
    }
}

/// Apply intrinsic trait analysis to update weights
pub fn apply_intrinsic_weights(
    current_weights: (f64, f64, f64),
    analysis: &IntrinsicTraitAnalysis,
    total_messages: i64,
) -> (f64, f64, f64) {
    let variability = calculate_variability(total_messages);
    // Intrinsic signals have lower impact than engagement (30% vs 70%)
    let base_boost = 0.015; // Half the boost of engagement analysis
    
    let (mut instinct, mut logic, mut psyche) = current_weights;
    
    // Convert 0-1 signals to -0.33 to +0.67 range (centered on neutral 0.33)
    let logic_delta = analysis.logic_signal - 0.33;
    let instinct_delta = analysis.instinct_signal - 0.33;
    let psyche_delta = analysis.psyche_signal - 0.33;
    
    // Apply with variability dampening
    logic += logic_delta * base_boost * variability;
    instinct += instinct_delta * base_boost * variability;
    psyche += psyche_delta * base_boost * variability;
    
    // Clamp to min 10%, max 60%
    instinct = instinct.clamp(0.1, 0.6);
    logic = logic.clamp(0.1, 0.6);
    psyche = psyche.clamp(0.1, 0.6);
    
    // Normalize to sum to 1.0
    let total = instinct + logic + psyche;
    (instinct / total, logic / total, psyche / total)
}

/// Combine both engagement and intrinsic analyses for weight update
pub fn combine_trait_analyses(
    current_weights: (f64, f64, f64),
    engagement: Option<&EngagementAnalysis>,
    intrinsic: Option<&IntrinsicTraitAnalysis>,
    disco_agents: &[String],
    total_messages: i64,
) -> (f64, f64, f64) {
    let variability = calculate_variability(total_messages);
    let (mut instinct, mut logic, mut psyche) = current_weights;
    
    // Apply intrinsic analysis (30% weight, always runs)
    if let Some(intrinsic) = intrinsic {
        let base_boost = 0.015;
        let logic_delta = intrinsic.logic_signal - 0.33;
        let instinct_delta = intrinsic.instinct_signal - 0.33;
        let psyche_delta = intrinsic.psyche_signal - 0.33;
        
        logic += logic_delta * base_boost * variability;
        instinct += instinct_delta * base_boost * variability;
        psyche += psyche_delta * base_boost * variability;
    }
    
    // Apply engagement analysis (70% weight, only when agents responded)
    if let Some(engagement) = engagement {
        let base_boost = 0.03;
        
        // Apply disco dampening - responses to disco agents have 50% reduced impact
        let logic_multiplier = if disco_agents.contains(&"logic".to_string()) { 0.5 } else { 1.0 };
        let instinct_multiplier = if disco_agents.contains(&"instinct".to_string()) { 0.5 } else { 1.0 };
        let psyche_multiplier = if disco_agents.contains(&"psyche".to_string()) { 0.5 } else { 1.0 };
        
        logic += engagement.logic_score * base_boost * variability * logic_multiplier;
        instinct += engagement.instinct_score * base_boost * variability * instinct_multiplier;
        psyche += engagement.psyche_score * base_boost * variability * psyche_multiplier;
    }
    
    // Clamp to min 10%, max 60%
    instinct = instinct.clamp(0.1, 0.6);
    logic = logic.clamp(0.1, 0.6);
    psyche = psyche.clamp(0.1, 0.6);
    
    // Normalize to sum to 1.0
    let total = instinct + logic + psyche;
    (instinct / total, logic / total, psyche / total)
}

