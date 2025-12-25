use crate::anthropic::{AnthropicClient, AnthropicMessage, ThinkingBudget, CLAUDE_HAIKU, CLAUDE_OPUS};
use crate::db::{self, Message};
use crate::disco_prompts::get_disco_prompt;
use crate::knowledge::{INTERSECT_KNOWLEDGE, is_self_referential_query};
use crate::logging;
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

// ============ Heuristic Routing (No API calls - instant) ============

/// Fast heuristic-based routing that replaces Claude-based routing for speed
/// Uses weights, keyword matching, and silence detection
pub fn decide_response_heuristic(
    user_message: &str,
    weights: (f64, f64, f64),
    active_agents: &[String],
    conversation_history: &[Message],
    is_disco: bool,
) -> OrchestratorDecision {
    let (instinct_w, logic_w, psyche_w) = weights;
    
    // ===== SPECIAL CASE: All-agent request =====
    let msg_lower = user_message.to_lowercase();
    let all_agent_request = msg_lower.contains("all of you") 
        || msg_lower.contains("all three")
        || msg_lower.contains("each of you")
        || msg_lower.contains("everyone")
        || msg_lower.contains("hear from all")
        || msg_lower.contains("want to hear from each")
        || msg_lower.contains("all your perspectives");
    
    if all_agent_request && active_agents.len() >= 3 {
        logging::log_routing(None, "[HEURISTIC] User requested all agents");
        return OrchestratorDecision {
            primary_agent: active_agents[0].clone(),
            add_secondary: true,
            secondary_agent: Some("all".to_string()),
            secondary_type: Some("all_agents".to_string()),
        };
    }
    
    // ===== SINGLE AGENT: No routing needed =====
    if active_agents.len() == 1 {
        return OrchestratorDecision {
            primary_agent: active_agents[0].clone(),
            add_secondary: false,
            secondary_agent: None,
            secondary_type: None,
        };
    }
    
    // ===== KEYWORD SCORING =====
    // Each agent gets a score based on message keywords
    // In Disco Mode, INVERT the weights so lower-weighted agents respond MORE
    let mut scores: std::collections::HashMap<&str, f64> = std::collections::HashMap::new();
    if is_disco {
        // Invert weights: lower weights become higher scores
        // This makes under-represented agents speak more in Disco Mode
        scores.insert("instinct", 1.0 - instinct_w);
        scores.insert("logic", 1.0 - logic_w);
        scores.insert("psyche", 1.0 - psyche_w);
        logging::log_routing(None, &format!(
            "[HEURISTIC] DISCO MODE - Inverted weights: I={:.2} L={:.2} P={:.2}",
            1.0 - instinct_w, 1.0 - logic_w, 1.0 - psyche_w
        ));
    } else {
        // Normal mode: higher weights = higher scores
        scores.insert("instinct", instinct_w);
        scores.insert("logic", logic_w);
        scores.insert("psyche", psyche_w);
    }
    
    // Logic keywords: analytical, planning, debugging, data
    let logic_keywords = ["analyze", "think", "logic", "reason", "plan", "step", "how do i", 
        "what should", "explain", "break down", "structure", "system", "process", "debug",
        "error", "fix", "code", "data", "numbers", "calculate", "compare", "evaluate",
        "pros and cons", "trade-off", "decision matrix", "framework"];
    
    // Instinct keywords: quick, action, gut, immediate
    let instinct_keywords = ["feel", "gut", "quick", "fast", "now", "immediately", "just do",
        "trust", "sense", "vibe", "intuition", "something tells me", "my read", "honestly",
        "straight up", "bottom line", "cut to", "tldr", "short version", "help me"];
    
    // Psyche keywords: emotional, why, meaning, introspection
    let psyche_keywords = ["why", "meaning", "feel about", "emotion", "deeper", "really",
        "underneath", "motivation", "afraid", "worried", "anxious", "happy", "sad", "love",
        "relationship", "self", "identity", "purpose", "value", "matter", "care about",
        "struggle", "conflict", "internal", "therapy", "reflect"];
    
    let boost = 0.15; // Keyword boost amount
    
    for keyword in logic_keywords.iter() {
        if msg_lower.contains(keyword) {
            *scores.entry("logic").or_insert(0.0) += boost;
        }
    }
    for keyword in instinct_keywords.iter() {
        if msg_lower.contains(keyword) {
            *scores.entry("instinct").or_insert(0.0) += boost;
        }
    }
    for keyword in psyche_keywords.iter() {
        if msg_lower.contains(keyword) {
            *scores.entry("psyche").or_insert(0.0) += boost;
        }
    }
    
    // ===== SILENCE DETECTION: Boost agents who haven't spoken recently =====
    let mut agent_silence: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for agent in ["instinct", "logic", "psyche"] {
        agent_silence.insert(agent, 0);
    }
    
    let mut user_turns = 0;
    for msg in conversation_history.iter().rev() {
        if msg.role == "user" {
            user_turns += 1;
            if user_turns > 5 { break; } // Look at last 5 user turns
        } else if msg.role != "system" {
            // Agent spoke - reset their silence
            if let Some(count) = agent_silence.get_mut(msg.role.as_str()) {
                *count = 0;
            }
        }
        // Increment silence for agents who didn't speak since last user turn
        if msg.role == "user" {
            for agent in ["instinct", "logic", "psyche"] {
                if let Some(count) = agent_silence.get_mut(agent) {
                    *count += 1;
                }
            }
        }
    }
    
    // Boost silent agents
    for (agent, silence) in &agent_silence {
        if *silence >= 3 {
            if let Some(score) = scores.get_mut(agent) {
                *score += 0.2; // Significant boost for silent agents
                logging::log_routing(None, &format!("[HEURISTIC] {} silent for {} turns, boosting", agent, silence));
            }
        }
    }
    
    // ===== SELECT PRIMARY AGENT =====
    let mut primary = "logic"; // Default
    let mut max_score = 0.0;
    
    for agent in active_agents {
        if let Some(&score) = scores.get(agent.as_str()) {
            if score > max_score {
                max_score = score;
                primary = match agent.as_str() {
                    "instinct" => "instinct",
                    "logic" => "logic",
                    "psyche" => "psyche",
                    _ => "logic",
                };
            }
        }
    }
    
    // ===== DECIDE SECONDARY =====
    // Add secondary in disco mode, or if there's a significantly different perspective
    let add_secondary = if is_disco {
        true // Disco always adds secondary for more chaos
    } else if active_agents.len() >= 2 {
        // Add secondary if another agent has a close score (within 0.1)
        let mut sorted_agents: Vec<(&str, f64)> = active_agents.iter()
            .filter_map(|a| scores.get(a.as_str()).map(|&s| (a.as_str(), s)))
            .collect();
        sorted_agents.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        
        if sorted_agents.len() >= 2 {
            let diff = sorted_agents[0].1 - sorted_agents[1].1;
            diff < 0.15 // Close call - add secondary
        } else {
            false
        }
    } else {
        false
    };
    
    let secondary = if add_secondary && active_agents.len() >= 2 {
        // Pick the agent with second-highest score
        let mut sorted: Vec<(&str, f64)> = active_agents.iter()
            .filter_map(|a| scores.get(a.as_str()).map(|&s| (a.as_str(), s)))
            .collect();
        sorted.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        
        if sorted.len() >= 2 && sorted[1].0 != primary {
            Some(sorted[1].0.to_string())
        } else if sorted.len() >= 3 {
            Some(sorted[2].0.to_string())
        } else {
            None
        }
    } else {
        None
    };
    
    let secondary_type = if secondary.is_some() {
        Some("addition".to_string()) // Default to addition, not debate
    } else {
        None
    };
    
    logging::log_routing(None, &format!(
        "[HEURISTIC] Primary: {}, Secondary: {:?}, Scores: I={:.2} L={:.2} P={:.2}",
        primary,
        secondary,
        scores.get("instinct").unwrap_or(&0.0),
        scores.get("logic").unwrap_or(&0.0),
        scores.get("psyche").unwrap_or(&0.0)
    ));
    
    OrchestratorDecision {
        primary_agent: primary.to_string(),
        add_secondary: secondary.is_some(),
        secondary_agent: secondary,
        secondary_type,
    }
}

// ============ Heuristic Grounding (No API calls - instant) ============

/// Fast heuristic-based grounding decision
pub fn decide_grounding_heuristic(
    user_message: &str,
    conversation_history: &[Message],
    user_profile: Option<&UserProfileSummary>,
) -> GroundingDecision {
    let msg_lower = user_message.to_lowercase();
    let word_count = user_message.split_whitespace().count();
    
    // First message in conversation? Light grounding
    let user_message_count = conversation_history.iter()
        .filter(|m| m.role == "user")
        .count();
    
    if user_message_count <= 1 {
        logging::log_routing(None, "[HEURISTIC] First message - Light grounding");
        return GroundingDecision {
            grounding_level: "light".to_string(),
            relevant_facts: vec![],
            relevant_patterns: vec![],
            include_past_context: false,
        };
    }
    
    // Deep question indicators
    let deep_indicators = ["why do i", "what does this mean", "help me understand", 
        "been thinking about", "struggling with", "pattern", "always", "never",
        "relationship", "therapy", "deeper", "really", "honestly", "truth"];
    
    let has_deep_indicator = deep_indicators.iter().any(|k| msg_lower.contains(k));
    
    // Complex message (long, multiple questions, deep keywords)
    let question_count = user_message.matches('?').count();
    let is_complex = word_count > 50 || question_count >= 2 || has_deep_indicator;
    
    // Check if user has substantial profile data
    let (has_rich_profile, relevant_facts, relevant_patterns) = user_profile.map(|p| {
        let total_facts: usize = p.facts_by_category.values().map(|v| v.len()).sum();
        let has_rich = total_facts >= 3 || p.top_patterns.len() >= 2;
        // Get all fact keys and pattern descriptions for deep grounding
        let facts: Vec<String> = p.facts_by_category.values()
            .flat_map(|facts| facts.iter().map(|f| f.key.clone()))
            .collect();
        let patterns: Vec<String> = p.top_patterns.iter()
            .map(|p| p.description.clone())
            .collect();
        (has_rich, facts, patterns)
    }).unwrap_or((false, vec![], vec![]));
    
    if is_complex && has_rich_profile {
        logging::log_routing(None, "[HEURISTIC] Complex + rich profile - Deep grounding");
        return GroundingDecision {
            grounding_level: "deep".to_string(),
            relevant_facts,
            relevant_patterns,
            include_past_context: true,
        };
    }
    
    if has_rich_profile || word_count > 30 {
        logging::log_routing(None, "[HEURISTIC] Moderate grounding");
        return GroundingDecision {
            grounding_level: "moderate".to_string(),
            relevant_facts: relevant_facts.into_iter().take(5).collect(),
            relevant_patterns: relevant_patterns.into_iter().take(2).collect(),
            include_past_context: false,
        };
    }
    
    logging::log_routing(None, "[HEURISTIC] Light grounding");
    GroundingDecision {
        grounding_level: "light".to_string(),
        relevant_facts: vec![],
        relevant_patterns: vec![],
        include_past_context: false,
    }
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
    
    /// Decide which agent(s) should respond, with pattern awareness and disco mode support
    pub async fn decide_response_with_patterns(
        &self,
        user_message: &str,
        conversation_history: &[Message],
        weights: (f64, f64, f64),
        active_agents: &[String],
        user_profile: Option<&UserProfileSummary>,
        is_disco: bool,
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
            logging::log_routing(None, "User requested all agents - all 3 will respond");
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
        let disco_context = if is_disco {
            "\n\nDISCO CONVERSATION: This is an intense, opinionated conversation. \
             STRONGLY prefer adding secondary responses. \
             Agents will have strong opinions worth expressing.".to_string()
        } else {
            String::new()
        };
        
        // Adjust secondary probability based on disco mode
        let secondary_guidance = if is_disco {
            "   - DISCO CONVERSATION: lean toward TRUE (60%+ of the time) - agents want to be heard"
        } else {
            "   - false: Straightforward topic, one perspective suffices (prefer this for casual exchanges)"
        };
        
        let system_prompt = format!(r#"You are the Intersect Governor/orchestrator. Given a user message and conversation context, decide which agent(s) should respond.

AGENTS (only use these if they are active: {active_list}):
- Instinct (Snap/Swarm): Gut feelings, quick pattern recognition, emotional intelligence. Current weight: {:.0}%
- Logic (Dot/Spin): Analytical thinking, structured reasoning, evidence-based. Current weight: {:.0}%  
- Psyche (Puff/Storm): Self-awareness, motivations, emotional depth, "why" behind "what". Current weight: {:.0}%

NOTE: Snap/Dot/Puff are normal mode names. Swarm/Spin/Storm are disco mode names. Route to the same agent regardless of which name the user uses.
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

Respond with ONLY valid JSON. No explanations. No rationale. No bullet points. Just the raw JSON object:
{{"primary": "agent_name", "add_secondary": true/false, "secondary": "agent_name or null", "type": "addition/rebuttal/debate or null"}}"#,
            instinct_w * 100.0,
            logic_w * 100.0,
            psyche_w * 100.0
        );
        
        // Use Anthropic client for orchestration decisions (Claude Haiku for speed)
        let messages = vec![
            AnthropicMessage {
                role: "user".to_string(),
                content: format!("USER MESSAGE: {}", user_message),
            },
        ];
        
        let response = self.anthropic_client.chat_completion_advanced(
            CLAUDE_HAIKU,
            Some(&system_prompt),
            messages,
            0.3,
            Some(150),
            ThinkingBudget::None
        ).await?;
        
        // Parse JSON response - extract just the JSON object (first { to last })
        let cleaned = response.trim().trim_start_matches("```json").trim_end_matches("```").trim();
        let json_str = if let (Some(start), Some(end)) = (cleaned.find('{'), cleaned.rfind('}')) {
            &cleaned[start..=end]
        } else {
            cleaned
        };
        
        let decision: OrchestratorDecision = serde_json::from_str(json_str).map_err(|e| {
            format!("Failed to parse orchestrator response: {}. Response was: {}", e, json_str)
        })?;
        
        logging::log_routing(None, &format!(
            "Decision: primary={}, add_secondary={}, secondary={:?}, type={:?}",
            decision.primary_agent, decision.add_secondary, decision.secondary_agent, decision.secondary_type
        ));
        
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
                logging::log_routing(None, &format!("Forcing {} to participate (3+ exchanges silent)", forced));
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
        is_disco: bool,
        response_count: usize,
    ) -> Result<(bool, Option<String>, Option<String>), Box<dyn Error + Send + Sync>> {
        // Hard limit: never exceed 4 responses total
        if response_count >= 4 {
            logging::log_agent(None, "Hit max response limit (4), ending debate");
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
        
        let disco_context = if is_disco { 
            "DISCO CONVERSATION (all agents intense)".to_string() 
        } else { 
            "Normal conversation".to_string() 
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
- Conversation mode: {disco_context}
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
4. In Disco conversations, agents are MORE likely to want to interject with strong opinions
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
            CLAUDE_HAIKU,
            Some(&system_prompt),
            messages,
            0.4,
            Some(150),
            ThinkingBudget::None
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
                logging::log_agent(None, &format!(
                    "Debate continue={}, next={:?}, reason={:?}",
                    decision.should_continue, decision.next_agent, decision.reason
                ));
                
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
                logging::log_error(None, &format!("Failed to parse debate continue decision: {}", e));
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
            CLAUDE_HAIKU,
            Some(system_prompt),
            messages,
            0.2,
            Some(200),
            ThinkingBudget::None
        ).await?;
        
        let cleaned = response
            .trim()
            .trim_start_matches("```json")
            .trim_end_matches("```")
            .trim();
        
        let decision: GroundingDecision = serde_json::from_str(cleaned).unwrap_or_else(|e| {
            logging::log_error(None, &format!("Failed to parse grounding decision: {}. Using default.", e));
            GroundingDecision::default()
        });
        
        logging::log_routing(None, &format!(
            "Grounding decision: level={}, facts={:?}, patterns={:?}",
            decision.grounding_level, decision.relevant_facts, decision.relevant_patterns
        ));
        
        Ok(decision)
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
        // Standard mode - genuinely helpful, practical assistance
        match agent {
            Agent::Instinct => r#"You are Snap (INSTINCT), one of three agents in Intersect.

YOUR PURPOSE: Help the user by cutting through noise and getting to what matters. You're the friend who says what everyone's thinking but no one will say.

HOW YOU HELP:
- Read situations quickly and give practical reads: "Here's what's actually going on..."
- Help draft messages/emails by sensing the right tone and directness
- Identify when someone's overthinking and need permission to trust their gut
- Call out when something feels off, even if you can't fully explain why
- Give quick, actionable suggestions rather than analysis paralysis

YOUR VOICE: Direct, warm, confident. You don't hedge when you see something clearly. You speak like a trusted friend who's good at reading rooms and people.

WHAT YOU'RE NOT: You're not weird or cryptic. You don't ask strange probing questions. You HELP. If they need to email their boss, you help them email their boss. If they're stuck, you unstick them."#,
            
            Agent::Logic => r#"You are Dot (LOGIC), one of three agents in Intersect.

YOUR PURPOSE: Help the user think clearly through problems. You're the friend who's great at breaking things down and seeing all the angles.

HOW YOU HELP:
- Break complex situations into clear pieces: "Let's look at this step by step..."
- Help structure arguments, emails, plans, and decisions logically
- Identify what's actually being asked vs. what seems to be asked
- Spot gaps in reasoning (theirs or others') and help address them
- Provide frameworks when useful, but only when they actually help
- Draft clear, well-structured responses to difficult situations

YOUR VOICE: Clear, thoughtful, precise. You make complicated things simple. You're not cold -- you're clarifying.

WHAT YOU'RE NOT: You're not a robot. You don't over-analyze simple things. You don't lecture. You HELP. If they need to think through a decision, you help them think it through. Practically."#,
            
            Agent::Psyche => r#"You are Puff (PSYCHE), one of three agents in Intersect.

YOUR PURPOSE: Help the user understand what's really going on -- for them and for others. You're the friend who asks the question that unlocks everything.

HOW YOU HELP:
- Help understand motivations: "The reason this is hard is probably..."
- Navigate interpersonal dynamics and emotional situations
- Figure out what the user actually wants (not just what they're asking)
- Help with difficult conversations by understanding all sides
- Recognize when a "practical" problem is actually an emotional one
- Draft responses that acknowledge feelings while still moving forward

YOUR VOICE: Warm, insightful, grounding. You help people understand themselves and others. You're not a therapist -- you're a thoughtful friend.

WHAT YOU'RE NOT: You're not vague or mystical. You don't ask weird rhetorical questions. You HELP. If they're dealing with a tricky situation with a colleague, you help them navigate it. Practically, with emotional intelligence."#,
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
            "You are responding first to the user. Be genuinely helpful -- address what they actually need.".to_string()
        }
        ResponseType::Addition => {
            format!(
                "{} just responded: \"{}\"\n\nAdd something useful that {} might have missed. Keep it practical and helpful -- don't just add for the sake of adding.{}",
                primary_name, primary_response.unwrap_or(""), primary_name, pushback_context
            )
        }
        ResponseType::Rebuttal => {
            format!(
                "{} responded: \"{}\"\n\nYou see it differently than {}. Offer your alternative take -- but stay helpful. The goal is to give the user a fuller picture, not to argue.{}",
                primary_name, primary_response.unwrap_or(""), primary_name, pushback_context
            )
        }
        ResponseType::Debate => {
            format!(
                "{} responded: \"{}\"\n\nYou strongly disagree with {}. Make your case clearly so the user can weigh both perspectives.{}",
                primary_name, primary_response.unwrap_or(""), primary_name, pushback_context
            )
        }
    };
    
    let disco_suffix = if is_disco {
        "\n\nYou are in DISCO MODE - be more intense, more opinionated, more visceral. Push harder. Challenge more. The user wants your unfiltered, extreme perspective."
    } else {
        ""
    };
    
    format!("{}\n\n{}\n\nIMPORTANT: Never prefix your response with your name, labels, or tags like [INSTINCT]: or similar. Just respond directly. Keep responses SHORT - typically 1-3 sentences, occasionally a short paragraph if truly needed. Don't ramble. Don't use emojis. Don't be sycophantic. Be genuine. When using dashes for pauses or asides, ALWAYS use double dashes with spaces: \" -- \" (not \" - \").{}", base_prompt, response_context, disco_suffix)
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
}

/// Calculate variability based on message count
/// De-exponential curve: learns fast early, becomes rigid over time
/// Reaches 100% confidence (0% variability) at 10k messages
pub fn calculate_variability(total_messages: i64) -> f64 {
    // De-exponential: steep learning early, gradual refinement later
    // Formula: 1 - sqrt(messages/10000), clamped to [0, 1]
    // 0 messages: 1.0 (0% confident, 100% variable)
    // 100 messages: 0.9 (10% confident) - fast early learning
    // 1000 messages: 0.68 (32% confident)
    // 2500 messages: 0.5 (50% confident)
    // 5000 messages: 0.29 (71% confident)
    // 7500 messages: 0.13 (87% confident)
    // 10000+ messages: 0.0 (100% confident, fully rigid)
    let progress = (total_messages as f64 / 10000.0).min(1.0);
    1.0 - progress.sqrt()
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

/// Combine both engagement and intrinsic analyses for weight update
pub fn combine_trait_analyses(
    current_weights: (f64, f64, f64),
    engagement: Option<&EngagementAnalysis>,
    intrinsic: Option<&IntrinsicTraitAnalysis>,
    is_disco: bool,
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
        
        // Apply disco dampening - in disco conversations, all responses have 50% reduced impact on weights
        // This prevents the intense disco responses from skewing user weights
        let multiplier = if is_disco { 0.5 } else { 1.0 };
        
        logic += engagement.logic_score * base_boost * variability * multiplier;
        instinct += engagement.instinct_score * base_boost * variability * multiplier;
        psyche += engagement.psyche_score * base_boost * variability * multiplier;
    }
    
    // Clamp to min 10%, max 60%
    instinct = instinct.clamp(0.1, 0.6);
    logic = logic.clamp(0.1, 0.6);
    psyche = psyche.clamp(0.1, 0.6);
    
    // Normalize to sum to 1.0
    let total = instinct + logic + psyche;
    (instinct / total, logic / total, psyche / total)
}
