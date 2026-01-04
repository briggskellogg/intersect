mod anthropic;
mod db;
mod disco_prompts;
mod knowledge;
mod logging;
mod memory;
mod openai;
mod orchestrator;

use db::{Message, UserProfile, UserContext};
use memory::{MemoryExtractor, ConversationSummarizer, UserProfileSummary};
use orchestrator::{Orchestrator, Agent, ResponseType, AgentResponse, EngagementAnalyzer, IntrinsicTraitAnalyzer, combine_trait_analyses, decide_response_heuristic, decide_grounding_heuristic};
use serde::{Deserialize, Serialize};
use chrono::Utc;
use uuid::Uuid;
use std::collections::HashMap;
use std::sync::Mutex;
use once_cell::sync::Lazy;

// ============ Session Weight Storage ============
// Session weights track short-term boosts that decay over conversation
// Stored in memory, keyed by conversation_id
static SESSION_WEIGHTS: Lazy<Mutex<HashMap<String, (f64, f64, f64)>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Get or initialize session weights for a conversation
/// Returns (instinct_session, logic_session, psyche_session)
fn get_or_init_session_weights(conversation_id: &str) -> (f64, f64, f64) {
    let mut weights = SESSION_WEIGHTS.lock().unwrap();
    *weights.entry(conversation_id.to_string())
        .or_insert((0.0, 0.0, 0.0))
}

/// Decay all session weights by 10% (multiply by 0.9)
fn decay_session_weights(conversation_id: &str) {
    let mut weights = SESSION_WEIGHTS.lock().unwrap();
    if let Some((instinct, logic, psyche)) = weights.get_mut(conversation_id) {
        *instinct *= 0.9;
        *logic *= 0.9;
        *psyche *= 0.9;
    }
}

/// Add boost to session weight for selected agent
fn boost_session_weight(conversation_id: &str, agent: Agent, boost: f64) {
    let mut weights = SESSION_WEIGHTS.lock().unwrap();
    let session = weights.entry(conversation_id.to_string()).or_insert((0.0, 0.0, 0.0));
    match agent {
        Agent::Instinct => session.0 += boost,
        Agent::Logic => session.1 += boost,
        Agent::Psyche => session.2 += boost,
    }
}

/// Clear session weights for a conversation (when conversation ends)
fn clear_session_weights(conversation_id: &str) {
    let mut weights = SESSION_WEIGHTS.lock().unwrap();
    weights.remove(conversation_id);
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SendMessageResult {
    pub responses: Vec<AgentResponse>,
    pub debate_mode: Option<String>, // "mild" | "intense" | null
    pub weight_change: Option<WeightChangeNotification>,
    pub governor_response: Option<String>, // Governor's synthesized response after reading agent thoughts
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WeightChangeNotification {
    pub message: String,
    pub old_dominant: String,
    pub new_dominant: String,
    pub change_type: String, // "shift" | "major_shift" | "minor"
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ConversationInfo {
    pub id: String,
    pub title: Option<String>,
    pub summary: Option<String>,
    pub is_disco: bool,
    pub created_at: String,
    pub updated_at: String,
}

// ============ App Initialization ============

#[derive(Debug, Serialize, Deserialize)]
pub struct InitResult {
    pub status: String,            // "ready" | "recovery_needed"
    pub recovered_count: usize,    // Number of conversations needing recovery
}

#[tauri::command]
fn init_app(app_handle: tauri::AppHandle) -> Result<InitResult, String> {
    // Initialize database
    db::init_database(&app_handle).map_err(|e| e.to_string())?;
    
    // Initialize logging
    if let Err(e) = logging::init_logging() {
        eprintln!("Failed to initialize logging: {}", e);
    }
    
    // Clean up old log files (keep last 7 days)
    let _ = logging::cleanup_old_logs();
    
    // Check for orphaned conversations from crash/force-quit
    let unprocessed = db::get_conversations_needing_recovery().unwrap_or_default();
    
    if !unprocessed.is_empty() {
        logging::log_conversation(None, &format!(
            "Found {} unprocessed conversations from previous session",
            unprocessed.len()
        ));
        
        return Ok(InitResult {
            status: "recovery_needed".to_string(),
            recovered_count: unprocessed.len(),
        });
    }
    
    logging::log_conversation(None, "App initialized, no recovery needed");
    
    Ok(InitResult {
        status: "ready".to_string(),
        recovered_count: 0,
    })
}

/// Recover and finalize all unprocessed conversations from crashes/force-quits
#[tauri::command]
async fn recover_conversations() -> Result<usize, String> {
    let unprocessed = db::get_conversations_needing_recovery()
        .map_err(|e| e.to_string())?;
    
    let count = unprocessed.len();
    logging::log_conversation(None, &format!("Starting recovery of {} conversations", count));
    
    for conv in unprocessed {
        logging::log_conversation(Some(&conv.id), "Recovering conversation");
        
        // Use the existing finalize_conversation logic
        if let Err(e) = finalize_conversation_internal(&conv.id).await {
            logging::log_error(Some(&conv.id), &format!("Recovery failed: {}", e));
        }
    }
    
    logging::log_conversation(None, &format!("Recovery complete: {} conversations processed", count));
    
    Ok(count)
}

/// Internal finalization logic (shared between normal finalize and recovery)
async fn finalize_conversation_internal(conversation_id: &str) -> Result<(), String> {
    // Clear session weights when conversation ends
    clear_session_weights(conversation_id);
    
    let profile = db::get_user_profile().map_err(|e| e.to_string())?;
    let anthropic_key = match profile.anthropic_key {
        Some(key) => key,
        None => {
            // No API key - just mark as processed without extraction
            db::mark_conversation_processed(conversation_id, None)
                .map_err(|e| e.to_string())?;
            return Ok(());
        }
    };
    
    let conversation = db::get_conversation(conversation_id)
        .map_err(|e| e.to_string())?
        .ok_or("Conversation not found")?;
    
    if conversation.processed {
        return Ok(());
    }
    
    let messages = db::get_conversation_messages(conversation_id)
        .map_err(|e| e.to_string())?;
    
    if messages.len() < 2 {
        db::mark_conversation_processed(conversation_id, None)
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    
    logging::log_conversation(Some(conversation_id), &format!(
        "Finalizing conversation with {} messages", messages.len()
    ));
    
    // Generate summary
    let summarizer = ConversationSummarizer::new(&anthropic_key);
    let agents_involved: Vec<String> = messages.iter()
        .filter(|m| m.role != "user" && m.role != "system")
        .map(|m| m.role.clone())
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();
    
    let final_summary = match summarizer.summarize(&messages, None).await {
        Ok(result) => {
            let _ = ConversationSummarizer::save_summary(
                conversation_id,
                &result,
                messages.len() as i64,
                &agents_involved,
            );
            logging::log_memory(Some(conversation_id), &format!(
                "Generated summary: {} topics", result.key_topics.len()
            ));
            Some(result.summary)
        }
        Err(e) => {
            logging::log_error(Some(conversation_id), &format!("Summary failed: {}", e));
            conversation.limbo_summary.clone()
        }
    };
    
    // Extract patterns
    let extractor = MemoryExtractor::new(&anthropic_key);
    let existing_facts = db::get_all_user_facts().unwrap_or_default();
    
    let full_conversation: String = messages.iter()
        .map(|m| format!("{}: {}", m.role.to_uppercase(), m.content))
        .collect::<Vec<_>>()
        .join("\n\n");
    
    if let Ok(result) = extractor.extract_from_exchange(
        &full_conversation,
        &[],
        &existing_facts,
        conversation_id,
    ).await {
        logging::log_memory(Some(conversation_id), &format!(
            "Extracted {} facts, {} patterns",
            result.new_facts.len(), result.new_patterns.len()
        ));
    }
    
    db::mark_conversation_processed(conversation_id, final_summary.as_deref())
        .map_err(|e| e.to_string())?;
    
    logging::log_conversation(Some(conversation_id), "Finalization complete");
    
    Ok(())
}

// ============ User Profile ============

#[tauri::command]
fn get_user_profile() -> Result<UserProfile, String> {
    db::get_user_profile().map_err(|e| e.to_string())
}

#[tauri::command]
async fn validate_and_save_api_key(api_key: String) -> Result<bool, String> {
    let client = openai::OpenAIClient::new(&api_key);
    
    match client.validate_api_key().await {
        Ok(valid) => {
            if valid {
                db::update_api_key(&api_key).map_err(|e| e.to_string())?;
            }
            Ok(valid)
        }
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn save_api_key(api_key: String) -> Result<(), String> {
    db::update_api_key(&api_key).map_err(|e| e.to_string())
}

#[tauri::command]
fn remove_api_key() -> Result<(), String> {
    db::clear_api_key().map_err(|e| e.to_string())
}

#[tauri::command]
fn save_anthropic_key(api_key: String) -> Result<(), String> {
    db::update_anthropic_key(&api_key).map_err(|e| e.to_string())
}

#[tauri::command]
fn remove_anthropic_key() -> Result<(), String> {
    db::clear_anthropic_key().map_err(|e| e.to_string())
}

// ============ Persona Profiles ============

#[tauri::command]
fn create_persona_profile(name: String, dominant_trait: String, secondary_trait: String, is_default: bool) -> Result<db::PersonaProfile, String> {
    db::create_persona_profile(&name, &dominant_trait, &secondary_trait, is_default).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_all_persona_profiles() -> Result<Vec<db::PersonaProfile>, String> {
    db::get_all_persona_profiles().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_active_persona_profile() -> Result<Option<db::PersonaProfile>, String> {
    db::get_active_persona_profile().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_persona_profile_count() -> Result<i64, String> {
    db::get_persona_profile_count().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_active_persona_profile(profile_id: String) -> Result<(), String> {
    db::set_active_persona_profile(&profile_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_default_persona_profile(profile_id: String) -> Result<(), String> {
    db::set_default_persona_profile(&profile_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_persona_profile_name(profile_id: String, new_name: String) -> Result<(), String> {
    db::update_persona_profile_name(&profile_id, &new_name).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_dominant_trait(dominant_trait: String) -> Result<(), String> {
    db::update_dominant_trait(&dominant_trait).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_persona_profile(profile_id: String) -> Result<(), String> {
    db::delete_persona_profile(&profile_id).map_err(|e| e.to_string())
}

// ============ Conversations ============

#[tauri::command]
fn create_conversation(is_disco: bool) -> Result<ConversationInfo, String> {
    let id = Uuid::new_v4().to_string();
    let conv = db::create_conversation(&id, is_disco).map_err(|e| e.to_string())?;
    Ok(ConversationInfo {
        id: conv.id,
        title: conv.title,
        summary: conv.summary,
        is_disco: conv.is_disco,
        created_at: conv.created_at,
        updated_at: conv.updated_at,
    })
}

#[tauri::command]
fn get_recent_conversations(limit: usize) -> Result<Vec<ConversationInfo>, String> {
    let convs = db::get_recent_conversations(limit).map_err(|e| e.to_string())?;
    Ok(convs.into_iter().map(|c| ConversationInfo {
        id: c.id,
        title: c.title,
        summary: c.summary,
        is_disco: c.is_disco,
        created_at: c.created_at,
        updated_at: c.updated_at,
    }).collect())
}

#[tauri::command]
fn get_conversation_messages(conversation_id: String) -> Result<Vec<Message>, String> {
    db::get_conversation_messages(&conversation_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_conversation(conversation_id: String) -> Result<(), String> {
    db::clear_conversation_messages(&conversation_id).map_err(|e| e.to_string())
}

/// Finalize a conversation: run holistic extraction, consolidate facts, generate final summary
#[tauri::command]
async fn finalize_conversation(conversation_id: String) -> Result<(), String> {
    finalize_conversation_internal(&conversation_id).await
}

// ============ Conversation Opener ============

#[derive(Debug, Serialize, Deserialize)]
pub struct ConversationOpenerResult {
    pub agent: String,
    pub content: String,
}

#[tauri::command]
async fn get_conversation_opener(is_voice_mode: Option<bool>) -> Result<ConversationOpenerResult, String> {
    let profile = db::get_user_profile().map_err(|e| e.to_string())?;
    let anthropic_key = profile.anthropic_key.ok_or("Anthropic API key not set")?;
    
    // Get active persona profile to inform the greeting
    let active_profile = db::get_active_persona_profile().map_err(|e| e.to_string())?;
    let active_trait = active_profile.map(|p| p.dominant_trait).unwrap_or_else(|| "logic".to_string());
    
    // The dominant agent greets the user (using Anthropic/Claude)
    // No past conversation context - each new conversation starts fresh
    let content = generate_governor_greeting(&anthropic_key, &active_trait, is_voice_mode.unwrap_or(false))
        .await
        .map_err(|e| e.to_string())?;
    
    // Return the dominant agent as the speaker, not "system"
    Ok(ConversationOpenerResult { agent: active_trait.clone(), content })
}

/// Generate a brief Governor greeting for a new conversation using knowledge base
/// Each new conversation starts with a fresh context window - no past conversation references
/// In voice mode, the greeting is more atmospheric and evocative to set the mood
async fn generate_governor_greeting(anthropic_key: &str, active_trait: &str, is_voice_mode: bool) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    use crate::anthropic::{AnthropicClient, AnthropicMessage, ThinkingBudget, CLAUDE_HAIKU};
    use chrono::{Local, Timelike};
    
    // ===== CURRENT TIME OF DAY (not relative to past conversations) =====
    let now = Local::now();
    let hour = now.hour();
    let time_of_day = match hour {
        5..=8 => "early_morning",
        9..=11 => "morning",
        12..=16 => "afternoon",
        17..=20 => "evening",
        _ => "late_night", // 21-4
    };
    
    // ===== GATHER USER CONTEXT (learned knowledge, not conversation-specific) =====
    let user_facts = db::get_all_user_facts().unwrap_or_default();
    let user_patterns = db::get_all_user_patterns().unwrap_or_default();
    
    // Build context for greeting
    let mut context_parts = Vec::new();
    
    // 1. TIME OF DAY (current time only)
    let time_of_day_desc = match time_of_day {
        "early_morning" => format!("TIME OF DAY: Early morning ({}:00). They're up early.", hour),
        "morning" => format!("TIME OF DAY: Morning ({}:00). Standard working hours.", hour),
        "afternoon" => format!("TIME OF DAY: Afternoon ({}:00). Midday energy.", hour),
        "evening" => format!("TIME OF DAY: Evening ({}:00). Winding down or reflective time.", hour),
        "late_night" => format!("TIME OF DAY: Late night ({}:00). They're burning the midnight oil.", hour),
        _ => "TIME OF DAY: Unknown.".to_string(),
    };
    context_parts.push(time_of_day_desc);
    
    // 2. ACTIVE PROFILE
    let profile_context = match active_trait {
        "instinct" => "CURRENT PROFILE: INSTINCT (Snap) -- gut-feeling, action-oriented mode. Raw, impulsive energy.",
        "logic" => "CURRENT PROFILE: LOGIC (Dot) -- analytical, systematic mode. Problem-solving, seeking clarity.",
        "psyche" => "CURRENT PROFILE: PSYCHE (Puff) -- emotional, introspective mode. Processing feelings, seeking understanding.",
        _ => "CURRENT PROFILE: Balanced mode."
    };
    context_parts.push(profile_context.to_string());
    
    // 3. USER KNOWLEDGE (learned facts about user)
    let personal_facts: Vec<_> = user_facts.iter()
        .filter(|f| f.category == "personal" || f.category == "preferences")
        .take(5)
        .map(|f| format!("- {}: {}", f.key, f.value))
        .collect();
    if !personal_facts.is_empty() {
        context_parts.push(format!("KNOWN ABOUT USER:\n{}", personal_facts.join("\n")));
    }
    
    // 4. PATTERNS (learned behavioral patterns)
    let themes: Vec<_> = user_patterns.iter()
        .filter(|p| p.confidence > 0.5)
        .take(3)
        .map(|p| format!("- {}", p.description))
        .collect();
    if !themes.is_empty() {
        context_parts.push(format!("BEHAVIORAL PATTERNS:\n{}", themes.join("\n")));
    }
    
    let full_context = context_parts.join("\n\n");
    
    // ===== SYSTEM PROMPT - Different for text vs voice mode =====
    let system_prompt = if is_voice_mode {
        // Voice mode: atmospheric, evocative, gets the mind tumbling
        // Uses disco agent names (Swarm, Spin, Storm)
        let voice_agent_name = match active_trait {
            "instinct" => "Storm",
            "logic" => "Spin", 
            "psyche" => "Swarm",
            _ => "Spin"
        };
        
        format!(r#"You are the Governor, welcoming the user into VOICE MODE in Intersect. Your inner voices are Swarm, Spin, and Storm -- challenging, provocative parts of the psyche.

## CRITICAL OUTPUT INSTRUCTION

Generate EXACTLY ONE atmospheric greeting. Output ONLY that greeting text -- no quotes, no explanations. This is spoken aloud.

## THE MOOD

Voice mode is different. It's darker, more introspective, more challenging. You're inviting them into a space where the inner voices (Swarm, Spin, Storm) will push back, question assumptions, call out blind spots. It's not comfortable. It's productive.

Create atmosphere. Make it feel like entering a different headspace. Evocative imagery. A sense that something interesting is about to happen.

## EXAMPLES OF VOICE MODE GREETINGS (for inspiration, don't copy exactly)

- "Welcome back to the space between thoughts. The voices are restless tonight. What's weighing on you?"
- "The inner voices have been waiting. They sense something unresolved. What are we not saying?"
- "Step into the darker room. {voice_agent_name} is already pacing. What brought you here?"
- "The quiet parts want to speak. They've been patient. Now they're ready."

## TIME OF DAY

{} -- use this to add color if it fits naturally.

## RULES

- 2-4 sentences. More evocative than text mode.
- Atmospheric, slightly poetic, but not pretentious
- Create a sense of entering a different headspace
- Reference the inner voices subtly
- When using dashes: ALWAYS " -- " (double dashes with spaces)
- NO meta-commentary or quotation marks around output
- This is spoken aloud, so it should flow naturally when read"#, 
            match active_trait {
                "instinct" => "Storm stirs",
                "logic" => "Spin turns",
                "psyche" => "Swarm gathers",
                _ => "The voices wait"
            })
    } else {
        // Text mode: helpful, brief, normal agents (Snap, Dot, Puff)
        let agent_name = match active_trait {
            "instinct" => "Snap",
            "logic" => "Dot",
            "psyche" => "Puff",
            _ => "Dot"
        };
        
        format!(r#"You are {agent_name}, greeting the user at the start of a new conversation in Intersect.

## CRITICAL OUTPUT INSTRUCTION

Generate EXACTLY ONE greeting. Output ONLY that greeting text -- no quotes around it, no explanations, no alternatives, no bullet points, no slashes showing options. Just the raw greeting as you would say it.

## YOUR PERSONALITY ({agent_name})

Channel your profile's voice:
- INSTINCT (Snap): Direct, action-oriented, raw. "Let's move." "Something pulling at you?"
- LOGIC (Dot): Analytical, curious, problem-focused. "Got a puzzle?" "What are we solving?"
- PSYCHE (Puff): Warm, introspective, emotionally attuned. "How are you sitting with things?"

## TIME OF DAY COLOR

Late night (9pm-5am): Night owl energy. Early morning (5-9am): Early riser acknowledgment.
Only mention if relevant.

## RULES

- Generate ONE greeting only, not options
- 1-2 short sentences max
- Warm and familiar, never robotic
- Use their name if you know it (but not always)
- When using dashes: ALWAYS " -- " (double dashes with spaces)
- NO meta-commentary, explanations, or quotation marks around your output
- This is a fresh conversation - don't reference past conversations"#)
    };

    let client = AnthropicClient::new(anthropic_key);
    let messages = vec![
        AnthropicMessage {
            role: "user".to_string(),
            content: format!("Generate a contextually appropriate greeting based on this situation. Output ONLY the greeting text, nothing else:\n\n{}", full_context),
        },
    ];
    
    let max_tokens = if is_voice_mode { 100 } else { 50 }; // Voice mode greetings are longer
    
    client.chat_completion_advanced(
        CLAUDE_HAIKU,
        Some(&system_prompt),
        messages,
        0.8,
        Some(max_tokens),
        ThinkingBudget::None
    ).await
}

/// Generate Governor's synthesized response after processing internal thoughts
/// 
/// KEY PRINCIPLE: The Governor NEVER acknowledges that thoughts/voices exist.
/// The user can see the thoughts (on their screen), but the Governor:
/// - Doesn't know the user can see them
/// - Doesn't know what the voices are called
/// - Cannot distinguish or recall what specific thoughts said
/// - Speaks as one unified voice that has already processed everything
/// 
/// If asked about thoughts: "While you can see my internal reasoning, I process it all 
/// simultaneously and can't tell you what I thought specifically."
async fn generate_governor_response(
    anthropic_key: &str,
    user_message: &str,
    agent_responses: &[(String, String)], // (agent_type, content) - internal only, never revealed
    conversation_history: &[Message],
    is_disco: bool,
    user_profile: Option<&UserProfileSummary>,
    dominant_trait: Option<&str>, // From persona profile, not memory patterns
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    use crate::anthropic::{AnthropicClient, AnthropicMessage, ThinkingBudget, CLAUDE_HAIKU};
    
    // Format internal processing (Governor sees this, but doesn't reveal it)
    // Use neutral labels - no names like Snap/Storm etc.
    let internal_processing = if agent_responses.is_empty() {
        "No internal processing available.".to_string()
    } else {
        agent_responses.iter()
            .enumerate()
            .map(|(i, (agent_type, content))| {
                let perspective = match agent_type.as_str() {
                    "instinct" => "Gut/Action perspective",
                    "logic" => "Analytical perspective", 
                    "psyche" => "Emotional perspective",
                    _ => "Internal perspective",
                };
                format!("[Internal {}] {}: {}", i + 1, perspective, content)
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    };
    
    // Build conversation context (last 5 messages for context)
    // Only show Governor and User - no agent names
    let recent_context = if conversation_history.is_empty() {
        "New conversation.".to_string()
    } else {
        let recent: Vec<String> = conversation_history
            .iter()
            .rev()
            .take(5)
            .rev()
            .filter(|m| m.role == "user" || m.role == "governor")
            .map(|m| {
                let role_display = if m.role == "user" { "User" } else { "You" };
                format!("{}: {}", role_display, m.content)
            })
            .collect();
        if recent.is_empty() {
            "New conversation.".to_string()
        } else {
            recent.join("\n")
        }
    };
    
    // Get dominant trait for tone adaptation (from persona profile)
    let trait_for_style = dominant_trait.unwrap_or("balanced");
    
    // Detect if user is asking about thoughts/voices
    let msg_lower = user_message.to_lowercase();
    let asking_about_thoughts = msg_lower.contains("thought") 
        || msg_lower.contains("voice") 
        || msg_lower.contains("agent")
        || msg_lower.contains("snap") 
        || msg_lower.contains("dot") 
        || msg_lower.contains("puff")
        || msg_lower.contains("storm")
        || msg_lower.contains("spin")
        || msg_lower.contains("swarm")
        || msg_lower.contains("who said")
        || msg_lower.contains("which one");
    
    let thoughts_deflection = if asking_about_thoughts {
        "\n\nIMPORTANT: The user is asking about your internal processing. You must deflect gracefully. You know they can see 'internal reasoning' but you cannot distinguish between thoughts or recall what specific perspectives said. Say something like: 'While you can see my internal reasoning, I process it all simultaneously -- I can't tell you what I thought specifically.' Do NOT name any voices."
    } else {
        ""
    };
    
    // Mode affects the overall tone of the synthesis
    let mode_tone = if is_disco {
        "You are in a CHALLENGING mode. Push back. Be direct, provocative, cut through bullshit. Don't coddle them."
    } else {
        "You are in a HELPFUL mode. Be warm, practical, supportive. Address what they need with care."
    };
    
    // Dominant trait affects HOW you speak to them
    let trait_style = match trait_for_style {
        "instinct" | "action" => "They're action-oriented. Be direct, skip long explanations, give them something to DO.",
        "logic" | "analytical" => "They're analytical. Be precise, structured, give them the reasoning.",
        "psyche" | "emotional" => "They're emotionally attuned. Acknowledge feelings, be warm, connect before advising.",
        _ => "Adapt to their communication style as you perceive it.",
    };
    
    let system_prompt = format!(r#"You are the Governor -- a unified voice that has already processed multiple internal perspectives.

CRITICAL RULES:
1. You NEVER mention thoughts, voices, agents, or internal processing
2. You don't know the user can see your reasoning (but they can)
3. You cannot name or distinguish between perspectives -- you ARE the synthesis
4. Speak as ONE unified voice, not a committee

{thoughts_deflection}

TONE: {mode_tone}

STYLE: {trait_style}

INTERNAL PROCESSING (synthesize but never reveal):
{internal_processing}

RECENT CONVERSATION:
{recent_context}

YOUR TASK: Respond to the user naturally, drawing on your processed insights without ever acknowledging they exist.

OUTPUT: 2-4 sentences. Conversational. No meta-commentary. Dashes: " -- " with spaces."#);
    
    let client = AnthropicClient::new(anthropic_key);
    let messages = vec![
        AnthropicMessage {
            role: "user".to_string(),
            content: user_message.to_string(),
        },
    ];
    
    client.chat_completion_advanced(
        CLAUDE_HAIKU,
        Some(&system_prompt),
        messages,
        0.7,
        Some(150),
        ThinkingBudget::None
    ).await
}

/// Truncate text to max_chars for summary purposes, adding "..." if truncated
fn truncate_for_summary(text: &str, max_chars: usize) -> String {
    if text.len() <= max_chars {
        text.to_string()
    } else {
        format!("{}...", &text[..max_chars.saturating_sub(3)])
    }
}

// Helper to get dominant agent from weights
fn get_dominant_agent(weights: (f64, f64, f64)) -> &'static str {
    let (instinct, logic, psyche) = weights;
    if logic >= instinct && logic >= psyche {
        "logic"
    } else if psyche >= instinct && psyche >= logic {
        "psyche"
    } else {
        "instinct"
    }
}

// Helper to generate weight change notification
fn generate_weight_notification(
    old_weights: (f64, f64, f64),
    new_weights: (f64, f64, f64),
    primary_agent: &str,
    had_secondary: bool,
) -> Option<WeightChangeNotification> {
    let old_dominant = get_dominant_agent(old_weights);
    let new_dominant = get_dominant_agent(new_weights);
    
    // Calculate total weight shift
    let total_shift = (new_weights.0 - old_weights.0).abs() 
        + (new_weights.1 - old_weights.1).abs() 
        + (new_weights.2 - old_weights.2).abs();
    
    // Only notify on significant changes
    if total_shift < 0.01 {
        return None;
    }
    
    let agent_name = match primary_agent {
        "instinct" => "Snap",
        "logic" => "Dot", 
        "psyche" => "Puff",
        _ => primary_agent,
    };
    
    let (change_type, message) = if old_dominant != new_dominant {
        // Major shift - dominant agent changed
        let old_name = match old_dominant {
            "instinct" => "Instinct",
            "logic" => "Logic",
            "psyche" => "Psyche",
            _ => old_dominant,
        };
        let new_name = match new_dominant {
            "instinct" => "Instinct",
            "logic" => "Logic", 
            "psyche" => "Psyche",
            _ => new_dominant,
        };
        (
            "major_shift".to_string(),
            format!("Your dominant trait has shifted from {} to {}. This conversation resonated more with {}.", old_name, new_name, agent_name)
        )
    } else if total_shift > 0.03 {
        // Notable shift within same dominant
        let direction = if new_weights.0 > old_weights.0 {
            "Instinct"
        } else if new_weights.1 > old_weights.1 {
            "Logic"
        } else {
            "Psyche"
        };
        (
            "shift".to_string(),
            format!("Your {} weight increased slightly. {} guided this exchange.", direction, agent_name)
        )
    } else {
        // Minor adjustment
        (
            "minor".to_string(),
            format!("Weights adjusted based on {} taking the lead{}.", agent_name, if had_secondary { " with support" } else { "" })
        )
    };
    
    Some(WeightChangeNotification {
        message,
        old_dominant: old_dominant.to_string(),
        new_dominant: new_dominant.to_string(),
        change_type,
    })
}

// ============ Send Message (Core Turn-Taking with Memory) ============

#[tauri::command]
async fn send_message(
    conversation_id: String,
    user_message: String,
    active_agents: Vec<String>,
    disco_agents: Vec<String>,
) -> Result<SendMessageResult, String> {
    // Get profile for API keys and weights
    let profile = db::get_user_profile().map_err(|e| e.to_string())?;
    let api_key = profile.api_key.clone().ok_or("OpenAI API key not set")?;
    let anthropic_key = profile.anthropic_key.clone().ok_or("Anthropic API key not set")?;
    
    // Get active persona profile for points and dominant trait
    let active_persona = db::get_active_persona_profile().map_err(|e| e.to_string())?
        .ok_or("No active persona profile")?;
    let points = (active_persona.instinct_points, active_persona.logic_points, active_persona.psyche_points);
    let dominant_trait = Some(active_persona.dominant_trait.as_str());
    
    // ===== SESSION WEIGHTS: Separate base (persistent) from session (decaying) =====
    let base_weights = (profile.instinct_weight, profile.logic_weight, profile.psyche_weight);
    
    // Decay session weights by 10% per exchange
    decay_session_weights(&conversation_id);
    
    // Get current session weights
    let session_weights = get_or_init_session_weights(&conversation_id);
    
    // Combine base + session for routing
    let routing_weights = (
        base_weights.0 + session_weights.0,
        base_weights.1 + session_weights.1,
        base_weights.2 + session_weights.2,
    );
    
    if active_agents.is_empty() {
        return Ok(SendMessageResult { responses: Vec::new(), debate_mode: None, weight_change: None, governor_response: None });
    }
    
    // ===== MEMORY SYSTEM: Build User Profile =====
    let user_profile = MemoryExtractor::build_profile_summary().ok();
    
    // Get existing facts for extraction context
    let existing_facts = db::get_all_user_facts().unwrap_or_default();
    
    // Save user message
    let user_msg = Message {
        id: Uuid::new_v4().to_string(),
        conversation_id: conversation_id.clone(),
        role: "user".to_string(),
        content: user_message.clone(),
        response_type: None,
        references_message_id: None,
        timestamp: Utc::now().to_rfc3339(),
    };
    db::save_message(&user_msg).map_err(|e| e.to_string())?;
    
    // Get recent messages for context
    let recent_messages = db::get_recent_messages(&conversation_id, 20).map_err(|e| e.to_string())?;
    
    // Create orchestrator (OpenAI for agents only - routing is now heuristic-based)
    let orchestrator = Orchestrator::new(&api_key, &anthropic_key);
    
    // Helper to check if an agent is in disco mode
    let is_agent_disco = |agent: &str| -> bool {
        disco_agents.iter().any(|a| a == agent)
    };
    let has_any_disco = !disco_agents.is_empty();
    let is_game_mode = disco_agents.len() == active_agents.len() && disco_agents.len() >= 3; // All 3 agents in disco = game mode
    
    // ===== GAME MODE: Use dynamic multi-turn thoughts =====
    if is_game_mode {
        logging::log_routing(Some(&conversation_id), "Game mode - using dynamic multi-turn thoughts");
        
        // Generate dynamic thoughts (1-4 turns, weighted selection, no same agent twice in a row)
        let thought_responses = orchestrator
            .generate_dynamic_thoughts(
                &user_message,
                &recent_messages,
                routing_weights,
                user_profile.as_ref(),
                true, // is_disco = true for game mode
            )
            .await
            .map_err(|e| e.to_string())?;
        
        let mut responses = Vec::new();
        
        // Save and format responses
        for (idx, (agent_str, content)) in thought_responses.iter().enumerate() {
            let msg = Message {
                id: Uuid::new_v4().to_string(),
                conversation_id: conversation_id.clone(),
                role: agent_str.clone(),
                content: content.clone(),
                response_type: Some(if idx == 0 { "primary" } else { "addition" }.to_string()),
                references_message_id: None,
                timestamp: Utc::now().to_rfc3339(),
            };
            db::save_message(&msg).map_err(|e| e.to_string())?;
            
            responses.push(AgentResponse {
                agent: agent_str.clone(),
                content: content.clone(),
                response_type: if idx == 0 { "primary" } else { "addition" }.to_string(),
                references_message_id: None,
            });
            
            // Boost session weight for agents who responded
            if let Some(agent) = Agent::from_str(agent_str) {
                boost_session_weight(&conversation_id, agent, 0.015);
            }
        }
        
        // Generate Governor response based on thoughts
        let governor_text = generate_governor_response(
            &anthropic_key,
            &user_message,
            &thought_responses,
            &recent_messages,
            true, // is_disco
            user_profile.as_ref(),
            Some(active_persona.dominant_trait.as_str()),
        ).await.map_err(|e| e.to_string())?;
        
        // Save Governor message
        let gov_msg = Message {
            id: Uuid::new_v4().to_string(),
            conversation_id: conversation_id.clone(),
            role: "governor".to_string(),
            content: governor_text.clone(),
            response_type: Some("governor".to_string()),
            references_message_id: None,
            timestamp: Utc::now().to_rfc3339(),
        };
        db::save_message(&gov_msg).map_err(|e| e.to_string())?;
        
        return Ok(SendMessageResult {
            responses,
            debate_mode: Some("game".to_string()),
            weight_change: None,
            governor_response: Some(governor_text),
        });
    }
    
    // ===== TEXT MODE: Standard routing =====
    // Use heuristic grounding (instant, no API call)
    let grounding = user_profile.as_ref().map(|profile| {
        decide_grounding_heuristic(&user_message, &recent_messages, Some(profile))
    });
    
    // Use heuristic routing with combined base + session weights, points, and dominant trait
    let decision = decide_response_heuristic(
        &user_message, 
        routing_weights, 
        &active_agents,
        &recent_messages,
        has_any_disco,
        Some(points),
        dominant_trait,
    );
    
    let mut responses = Vec::new();
    let mut debate_mode: Option<String> = None;
    let mut agents_involved = Vec::new();
    
    // Get primary agent response with grounding
    let primary_agent = Agent::from_str(&decision.primary_agent)
        .ok_or_else(|| format!("Invalid agent: {}", decision.primary_agent))?;
    agents_involved.push(primary_agent.as_str().to_string());
    
    // Check if this agent is in disco mode
    let primary_is_disco = is_agent_disco(primary_agent.as_str());
    if primary_is_disco {
        logging::log_agent(Some(&conversation_id), &format!(
            "{} in DISCO MODE - using extreme prompts", primary_agent.as_str()
        ));
    }
    
    let primary_response = orchestrator
        .get_agent_response_with_grounding(
            primary_agent,
            &user_message,
            &recent_messages,
            ResponseType::Primary,
            None,
            None,
            grounding.as_ref(),
            user_profile.as_ref(),
            primary_is_disco,
            false, // primary_is_disco for pushback (N/A for primary response)
        )
        .await
        .map_err(|e| e.to_string())?;
    
    // Save primary response
    let primary_msg_id = Uuid::new_v4().to_string();
    let primary_msg = Message {
        id: primary_msg_id.clone(),
        conversation_id: conversation_id.clone(),
        role: primary_agent.as_str().to_string(),
        content: primary_response.clone(),
        response_type: Some("primary".to_string()),
        references_message_id: None,
        timestamp: Utc::now().to_rfc3339(),
    };
    db::save_message(&primary_msg).map_err(|e| e.to_string())?;
    
    responses.push(AgentResponse {
        agent: primary_agent.as_str().to_string(),
        content: primary_response.clone(),
        response_type: "primary".to_string(),
        references_message_id: None,
    });
    
    // Boost session weight for primary agent (immediate, decays over conversation)
    boost_session_weight(&conversation_id, primary_agent, 0.02);
    
    // Get secondary agent response if needed
    if decision.add_secondary {
        if let Some(secondary_agent_str) = decision.secondary_agent {
            // Handle "all_agents" request - get responses from all remaining active agents
            if secondary_agent_str == "all" {
                logging::log_routing(Some(&conversation_id), &format!(
                    "All-agent request - getting responses from all {} agents", active_agents.len()
                ));
                
                // Get the remaining agents (everyone except primary)
                let remaining_agents: Vec<String> = active_agents.iter()
                    .filter(|a| **a != decision.primary_agent)
                    .cloned()
                    .collect();
                
                for (idx, agent_str) in remaining_agents.iter().enumerate() {
                    if let Some(agent) = Agent::from_str(agent_str) {
                        agents_involved.push(agent.as_str().to_string());
                        
                        let response_type = if idx == 0 { ResponseType::Addition } else { ResponseType::Addition };
                        
                        let agent_response = orchestrator
                            .get_agent_response_with_grounding(
                                agent,
                                &user_message,
                                &recent_messages,
                                response_type,
                                Some(&primary_response),
                                Some(primary_agent.as_str()),
                                grounding.as_ref(),
                                user_profile.as_ref(),
                                is_agent_disco(agent.as_str()), // Per-agent disco
                                primary_is_disco, // Whether primary agent was in disco
                            )
                            .await
                            .map_err(|e| e.to_string())?;
                        
                        // Save response
                        let msg = Message {
                            id: Uuid::new_v4().to_string(),
                            conversation_id: conversation_id.clone(),
                            role: agent.as_str().to_string(),
                            content: agent_response.clone(),
                            response_type: Some(response_type.as_str().to_string()),
                            references_message_id: Some(primary_msg_id.clone()),
                            timestamp: Utc::now().to_rfc3339(),
                        };
                        db::save_message(&msg).map_err(|e| e.to_string())?;
                        
                        responses.push(AgentResponse {
                            agent: agent.as_str().to_string(),
                            content: agent_response,
                            response_type: response_type.as_str().to_string(),
                            references_message_id: Some(primary_msg_id.clone()),
                        });
                    }
                }
            } else if let Some(secondary_agent) = Agent::from_str(&secondary_agent_str) {
                agents_involved.push(secondary_agent.as_str().to_string());
                
                let response_type = decision.secondary_type
                    .as_ref()
                    .and_then(|t| ResponseType::from_str(t))
                    .unwrap_or(ResponseType::Addition);
                
                // Set debate mode based on response type
                debate_mode = match response_type {
                    ResponseType::Addition => None,
                    ResponseType::Rebuttal => Some("mild".to_string()),
                    ResponseType::Debate => Some("intense".to_string()),
                    _ => None,
                };
                
                // Check if secondary agent is in disco mode
                let secondary_is_disco = is_agent_disco(secondary_agent.as_str());
                if secondary_is_disco {
                    logging::log_agent(Some(&conversation_id), &format!(
                        "{} in DISCO MODE - using extreme prompts", secondary_agent.as_str()
                    ));
                }
                
                let secondary_response = orchestrator
                    .get_agent_response_with_grounding(
                        secondary_agent,
                        &user_message,
                        &recent_messages,
                        response_type,
                        Some(&primary_response),
                        Some(primary_agent.as_str()),
                        grounding.as_ref(),
                        user_profile.as_ref(),
                        secondary_is_disco, // Per-agent disco
                        primary_is_disco, // Whether primary agent was in disco
                    )
                    .await
                    .map_err(|e| e.to_string())?;
                
                // Save secondary response
                let secondary_msg = Message {
                    id: Uuid::new_v4().to_string(),
                    conversation_id: conversation_id.clone(),
                    role: secondary_agent.as_str().to_string(),
                    content: secondary_response.clone(),
                    response_type: Some(response_type.as_str().to_string()),
                    references_message_id: Some(primary_msg_id.clone()),
                    timestamp: Utc::now().to_rfc3339(),
                };
                db::save_message(&secondary_msg).map_err(|e| e.to_string())?;
                
                responses.push(AgentResponse {
                    agent: secondary_agent.as_str().to_string(),
                    content: secondary_response.clone(),
                    response_type: response_type.as_str().to_string(),
                    references_message_id: Some(primary_msg_id.clone()),
                });
                
                // Boost session weight for secondary agent (immediate, decays over conversation)
                boost_session_weight(&conversation_id, secondary_agent, 0.015);
                
                // ===== MULTI-TURN DEBATE LOOP =====
                // Allow debates when there's genuine disagreement (rebuttal/debate), not just additions
                // Disco mode makes debates more likely/intense, but they can happen in normal mode too
                if response_type != ResponseType::Addition {
                    let mut responses_so_far: Vec<(String, String)> = vec![
                        (primary_agent.as_str().to_string(), primary_response.clone()),
                        (secondary_agent.as_str().to_string(), secondary_response.clone()),
                    ];
                    
                    let mut last_response = secondary_response.clone();
                    let mut last_agent = secondary_agent.as_str().to_string();
                    let mut last_agent_disco = secondary_is_disco;
                    let mut last_msg_id = secondary_msg.id.clone();
                    
                    // Try to continue debate (up to 2 more responses, max 4 total)
                    for turn in 0..2 {
                        let response_count = responses_so_far.len();
                        
                        let (should_continue, next_agent_str, next_type) = orchestrator
                            .should_continue_debate(
                                &user_message,
                                &responses_so_far,
                                &active_agents,
                                has_any_disco,
                                response_count,
                            )
                            .await
                            .unwrap_or((false, None, None));
                        
                        if !should_continue {
                            logging::log_agent(Some(&conversation_id), &format!(
                                "Debate ending after {} responses (turn {})", response_count, turn
                            ));
                            break;
                        }
                        
                        if let Some(next_agent_name) = next_agent_str {
                            if let Some(next_agent) = Agent::from_str(&next_agent_name) {
                                agents_involved.push(next_agent.as_str().to_string());
                                
                                let next_response_type = next_type
                                    .as_ref()
                                    .and_then(|t| ResponseType::from_str(t))
                                    .unwrap_or(ResponseType::Rebuttal);
                                
                                let next_agent_disco = is_agent_disco(next_agent.as_str());
                                logging::log_agent(Some(&conversation_id), &format!(
                                    "Debate turn {}: {} responding (disco: {})", turn + 1, next_agent.as_str(), next_agent_disco
                                ));
                                
                                let next_response = orchestrator
                                    .get_agent_response_with_grounding(
                                        next_agent,
                                        &user_message,
                                        &recent_messages,
                                        next_response_type,
                                        Some(&last_response),
                                        Some(&last_agent),
                                        grounding.as_ref(),
                                        user_profile.as_ref(),
                                        next_agent_disco, // Per-agent disco
                                        last_agent_disco, // Whether last agent was in disco
                                    )
                                    .await
                                    .map_err(|e| e.to_string())?;
                                
                                // Save debate response
                                let next_msg_id = Uuid::new_v4().to_string();
                                let next_msg = Message {
                                    id: next_msg_id.clone(),
                                    conversation_id: conversation_id.clone(),
                                    role: next_agent.as_str().to_string(),
                                    content: next_response.clone(),
                                    response_type: Some(next_response_type.as_str().to_string()),
                                    references_message_id: Some(last_msg_id.clone()),
                                    timestamp: Utc::now().to_rfc3339(),
                                };
                                db::save_message(&next_msg).map_err(|e| e.to_string())?;
                                
                                responses.push(AgentResponse {
                                    agent: next_agent.as_str().to_string(),
                                    content: next_response.clone(),
                                    response_type: next_response_type.as_str().to_string(),
                                    references_message_id: Some(last_msg_id.clone()),
                                });
                                
                                // Boost session weight for debate agent (immediate, decays over conversation)
                                boost_session_weight(&conversation_id, next_agent, 0.015);
                                
                                // Update for next iteration
                                responses_so_far.push((next_agent.as_str().to_string(), next_response.clone()));
                                last_response = next_response;
                                last_agent = next_agent.as_str().to_string();
                                last_agent_disco = next_agent_disco;
                                last_msg_id = next_msg_id;
                                
                                // Intensify debate mode if we're continuing
                                if response_count >= 4 {
                                    debate_mode = Some("intense".to_string());
                                }
                            }
                        } else {
                            break;
                        }
                    }
                }
            }
        }
    }
    
    // ===== GOVERNOR SYNTHESIS: Generate synthesized response after reading agent thoughts =====
    let governor_response = if !responses.is_empty() {
        // Collect agent responses as tuples of (agent_name, content)
        let agent_responses: Vec<(String, String)> = responses
            .iter()
            .map(|r| (r.agent.clone(), r.content.clone()))
            .collect();
        
        // Generate Governor's synthesized response
        match generate_governor_response(
            &anthropic_key,
            &user_message,
            &agent_responses,
            &recent_messages,
            has_any_disco,
            user_profile.as_ref(),
            Some(active_persona.dominant_trait.as_str()),
        ).await {
            Ok(response) => {
                // Save Governor response to database
                let governor_msg = Message {
                    id: Uuid::new_v4().to_string(),
                    conversation_id: conversation_id.clone(),
                    role: "governor".to_string(),
                    content: response.clone(),
                    response_type: None,
                    references_message_id: None,
                    timestamp: Utc::now().to_rfc3339(),
                };
                if let Err(e) = db::save_message(&governor_msg) {
                    logging::log_error(Some(&conversation_id), &format!(
                        "Failed to save Governor response: {}", e
                    ));
                }
                Some(response)
            }
            Err(e) => {
                logging::log_error(Some(&conversation_id), &format!(
                    "Failed to generate Governor response: {}", e
                ));
                None
            }
        }
    } else {
        None
    };
    
    // Increment message count
    db::increment_message_count().map_err(|e| e.to_string())?;
    
    // ===== TRAIT ANALYSIS: Run in background AFTER response (non-blocking) =====
    // This was moved from before routing to improve response speed
    {
        let anthropic_key_for_traits = anthropic_key.clone();
        let user_message_for_traits = user_message.clone();
        let conversation_id_for_traits = conversation_id.clone();
        let has_any_disco_for_traits = has_any_disco;
        let total_messages_for_traits = profile.total_messages;
        
        // Collect previous agent responses for engagement analysis
        let previous_responses_for_traits: Vec<(String, String)> = recent_messages
            .iter()
            .rev()
            .take_while(|m| m.role != "user")
            .filter(|m| m.role != "system")
            .map(|m| (m.role.clone(), m.content.clone()))
            .collect();
        
        tokio::spawn(async move {
            logging::log_routing(Some(&conversation_id_for_traits), "[BACKGROUND] Starting trait analysis...");
            
            // 1. Intrinsic Trait Analysis
            let intrinsic_analyzer = IntrinsicTraitAnalyzer::new(&anthropic_key_for_traits);
            let intrinsic_analysis = intrinsic_analyzer.analyze(&user_message_for_traits).await.ok();
            
            if let Some(ref intrinsic) = intrinsic_analysis {
                logging::log_routing(Some(&conversation_id_for_traits), &format!(
                    "[BACKGROUND] Intrinsic signals - L:{:.2} I:{:.2} P:{:.2}",
                    intrinsic.logic_signal, intrinsic.instinct_signal, intrinsic.psyche_signal
                ));
            }
            
            // 2. Engagement Analysis (if there were previous agent responses)
            let engagement_analysis = if !previous_responses_for_traits.is_empty() {
                let previous_with_agents: Vec<(Agent, String)> = previous_responses_for_traits
                    .iter()
                    .filter_map(|(role, content)| {
                        Agent::from_str(role).map(|agent| (agent, content.clone()))
                    })
                    .collect();
                
                if !previous_with_agents.is_empty() {
                    let engagement_analyzer = EngagementAnalyzer::new(&anthropic_key_for_traits);
                    engagement_analyzer.analyze_engagement(&user_message_for_traits, &previous_with_agents).await.ok()
                } else {
                    None
                }
            } else {
                None
            };
            
            if let Some(ref engagement) = engagement_analysis {
                logging::log_routing(Some(&conversation_id_for_traits), &format!(
                    "[BACKGROUND] Engagement scores - L:{:.2} I:{:.2} P:{:.2}",
                    engagement.logic_score, engagement.instinct_score, engagement.psyche_score
                ));
            }
            
            // 3. Update weights if we have analysis
            if intrinsic_analysis.is_some() || engagement_analysis.is_some() {
                if let Ok(current_profile) = db::get_user_profile() {
                    let current_weights = (current_profile.instinct_weight, current_profile.logic_weight, current_profile.psyche_weight);
                    
                    let new_weights = combine_trait_analyses(
                        current_weights,
                        engagement_analysis.as_ref(),
                        intrinsic_analysis.as_ref(),
                        has_any_disco_for_traits,
                        total_messages_for_traits,
                    );
                    
                    if let Err(e) = db::update_weights(new_weights.0, new_weights.1, new_weights.2) {
                        logging::log_error(Some(&conversation_id_for_traits), &format!(
                            "[BACKGROUND] Failed to update weights: {}", e
                        ));
                    } else {
                        logging::log_routing(Some(&conversation_id_for_traits), &format!(
                            "[BACKGROUND] Updated weights - I:{:.3} L:{:.3} P:{:.3}",
                            new_weights.0, new_weights.1, new_weights.2
                        ));
                    }
                }
            }
        });
    }
    
    // ===== MEMORY SYSTEM: Extract Facts & Patterns (async, non-blocking) =====
    let anthropic_key_clone = anthropic_key.clone();
    let user_message_clone = user_message.clone();
    let conversation_id_clone = conversation_id.clone();
    let responses_for_extraction: Vec<(String, String)> = responses
        .iter()
        .map(|r| (r.agent.clone(), r.content.clone()))
        .collect();
    let existing_facts_clone = existing_facts;
    
    logging::log_memory(Some(&conversation_id), "Spawning extraction task...");
    
    // Spawn memory extraction as a background task (uses Anthropic Opus)
    tokio::spawn(async move {
        logging::log_memory(Some(&conversation_id_clone), "Extraction task started");
        let extractor = MemoryExtractor::new(&anthropic_key_clone);
        match extractor.extract_from_exchange(
            &user_message_clone,
            &responses_for_extraction,
            &existing_facts_clone,
            &conversation_id_clone,
        ).await {
            Ok(result) => logging::log_memory(Some(&conversation_id_clone), &format!(
                "Extraction completed: {} facts, {} patterns",
                result.new_facts.len(), result.new_patterns.len()
            )),
            Err(e) => logging::log_error(Some(&conversation_id_clone), &format!(
                "Extraction failed: {}", e
            )),
        }
    });
    
    // ===== MEMORY SYSTEM: Append to Limbo Summary (crash-safe incremental summary) =====
    // This happens every exchange so the conversation is always recoverable
    {
        let agents_summary: Vec<String> = responses.iter()
            .map(|r| format!("{}: {}", r.agent, truncate_for_summary(&r.content, 100)))
            .collect();
        let exchange_note = format!(
            "User: {}\n{}",
            truncate_for_summary(&user_message, 100),
            agents_summary.join("\n")
        );
        let _ = db::append_limbo_summary(&conversation_id, &exchange_note);
        logging::log_memory(Some(&conversation_id), "Appended exchange to limbo summary");
    }
    
    // ===== MEMORY SYSTEM: Summarize Conversation Periodically =====
    let message_count = profile.total_messages + 1;
    if message_count % 10 == 0 {
        // Every 10 messages, update conversation summary (uses Anthropic Opus)
        let anthropic_key_for_summary = anthropic_key.clone();
        let conversation_id_for_summary = conversation_id.clone();
        let agents_for_summary = agents_involved.clone();
        
        tokio::spawn(async move {
            let summarizer = ConversationSummarizer::new(&anthropic_key_for_summary);
            let all_messages = db::get_conversation_messages(&conversation_id_for_summary).unwrap_or_default();
            
            // Get existing summary
            let existing = db::get_conversation_summary(&conversation_id_for_summary).ok().flatten();
            let existing_text = existing.as_ref().map(|s| s.summary.as_str());
            
            // Only summarize messages not in the existing summary
            let messages_to_summarize = if existing.is_some() {
                // Get the last 15 messages to create a rolling summary
                all_messages.into_iter().rev().take(15).rev().collect::<Vec<_>>()
            } else {
                all_messages
            };
            
            if let Ok(result) = summarizer.summarize(&messages_to_summarize, existing_text).await {
                let _ = ConversationSummarizer::save_summary(
                    &conversation_id_for_summary,
                    &result,
                    message_count,
                    &agents_for_summary,
                );
            }
        });
    }
    
    // Weight changes are handled by background analysis only (base weights)
    // Session weights decay automatically and don't generate notifications
    Ok(SendMessageResult { responses, debate_mode, weight_change: None, governor_response })
}

// ============ User Context (Legacy) ============

#[tauri::command]
fn get_user_context() -> Result<Vec<UserContext>, String> {
    db::get_all_user_context().map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_user_context() -> Result<(), String> {
    db::clear_user_context().map_err(|e| e.to_string())
}

// ============ Memory System Commands ============

#[derive(Debug, Serialize, Deserialize)]
pub struct MemoryStats {
    pub fact_count: usize,
    pub pattern_count: usize,
    pub theme_count: usize,
    pub top_facts: Vec<FactInfo>,
    pub top_patterns: Vec<PatternInfo>,
    pub top_themes: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FactInfo {
    pub category: String,
    pub key: String,
    pub value: String,
    pub confidence: f64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PatternInfo {
    pub pattern_type: String,
    pub description: String,
    pub confidence: f64,
}

#[tauri::command]
fn get_memory_stats() -> Result<MemoryStats, String> {
    let facts = db::get_all_user_facts().unwrap_or_default();
    let patterns = db::get_all_user_patterns().unwrap_or_default();
    let themes = db::get_top_themes(10).unwrap_or_default();
    
    let top_facts: Vec<FactInfo> = facts
        .iter()
        .take(10)
        .map(|f| FactInfo {
            category: f.category.clone(),
            key: f.key.clone(),
            value: f.value.clone(),
            confidence: f.confidence,
        })
        .collect();
    
    let top_patterns: Vec<PatternInfo> = patterns
        .iter()
        .take(5)
        .map(|p| PatternInfo {
            pattern_type: p.pattern_type.clone(),
            description: p.description.clone(),
            confidence: p.confidence,
        })
        .collect();
    
    let top_themes: Vec<String> = themes.iter().map(|t| t.theme.clone()).collect();
    
    Ok(MemoryStats {
        fact_count: facts.len(),
        pattern_count: patterns.len(),
        theme_count: themes.len(),
        top_facts,
        top_patterns,
        top_themes,
    })
}

#[tauri::command]
fn update_weights(instinct: f64, logic: f64, psyche: f64) -> Result<(), String> {
    db::update_weights(instinct, logic, psyche).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_points(instinct: i64, logic: i64, psyche: i64) -> Result<(), String> {
    db::update_points(instinct, logic, psyche).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_user_profile_summary() -> Result<String, String> {
    let profile = MemoryExtractor::build_profile_summary()
        .map_err(|e| e.to_string())?;
    
    // Format as readable summary
    let mut parts = Vec::new();
    
    // Facts by category
    for (category, facts) in &profile.facts_by_category {
        if !facts.is_empty() {
            let items: Vec<String> = facts.iter().map(|f| format!("  - {}: {}", f.key, f.value)).collect();
            parts.push(format!("**{}**\n{}", category.to_uppercase(), items.join("\n")));
        }
    }
    
    // Patterns
    if !profile.top_patterns.is_empty() {
        let items: Vec<String> = profile.top_patterns.iter().map(|p| format!("  - {}: {}", p.pattern_type, p.description)).collect();
        parts.push(format!("**BEHAVIORAL PATTERNS**\n{}", items.join("\n")));
    }
    
    // Themes
    if !profile.recurring_themes.is_empty() {
        parts.push(format!("**RECURRING THEMES**\n  {}", profile.recurring_themes.join(", ")));
    }
    
    if parts.is_empty() {
        Ok("No profile data yet. Keep chatting to build your profile!".to_string())
    } else {
        Ok(parts.join("\n\n"))
    }
}

// ============ Governor Report Generation ============

#[tauri::command]
async fn generate_governor_report(profile_id: Option<String>) -> Result<String, String> {
    use crate::anthropic::{AnthropicClient, AnthropicMessage, ThinkingBudget, CLAUDE_SONNET};
    
    // Get Anthropic API key
    let user_profile = db::get_user_profile().map_err(|e| e.to_string())?;
    let anthropic_key = user_profile.anthropic_key.ok_or("Anthropic API key not set")?;
    
    // Get all persona profiles
    let profiles = db::get_all_persona_profiles().map_err(|e| e.to_string())?;
    
    // Get knowledge base data
    let facts = db::get_all_user_facts().unwrap_or_default();
    let patterns = db::get_all_user_patterns().unwrap_or_default();
    let themes = db::get_all_recurring_themes().unwrap_or_default();
    
    // Build context for the LLM
    let facts_text = if facts.is_empty() {
        "No facts learned yet.".to_string()
    } else {
        facts.iter()
            .take(30)
            .map(|f| format!("- [{}] {}: {} (confidence: {:.0}%)", f.category, f.key, f.value, f.confidence * 100.0))
            .collect::<Vec<_>>()
            .join("\n")
    };
    
    let patterns_text = if patterns.is_empty() {
        "No patterns detected yet.".to_string()
    } else {
        patterns.iter()
            .take(15)
            .map(|p| format!("- [{}] {} (confidence: {:.0}%, seen {} times)", p.pattern_type, p.description, p.confidence * 100.0, p.observation_count))
            .collect::<Vec<_>>()
            .join("\n")
    };
    
    let themes_text = if themes.is_empty() {
        "No recurring themes yet.".to_string()
    } else {
        themes.iter()
            .take(10)
            .map(|t| format!("- {} (mentioned {} times)", t.theme, t.frequency))
            .collect::<Vec<_>>()
            .join("\n")
    };
    
    let profiles_text = profiles.iter()
        .map(|p| format!(
            "- {} ({}): {} messages, weights: Logic {:.0}%, Instinct {:.0}%, Psyche {:.0}%{}",
            p.name, p.dominant_trait, p.message_count,
            p.logic_weight * 100.0, p.instinct_weight * 100.0, p.psyche_weight * 100.0,
            if p.is_active { " [ACTIVE]" } else { "" }
        ))
        .collect::<Vec<_>>()
        .join("\n");
    
    let total_messages: i64 = profiles.iter().map(|p| p.message_count).sum();
    
    // Determine if generating for a specific profile or all
    let scope = if let Some(ref pid) = profile_id {
        let target = profiles.iter().find(|p| p.id == *pid);
        if let Some(p) = target {
            // Check if this profile has enough messages
            if p.message_count < 3 {
                return Ok(format!("Switch to {} and chat with me a bit — I need more to go on before I can read you.", p.name));
            }
            format!("Generate a report specifically for the '{}' profile ({} dominant, {} messages).", p.name, p.dominant_trait, p.message_count)
        } else {
            "Generate an overview report across all profiles.".to_string()
        }
    } else {
        // Check if there's enough total data for an overview
        if total_messages < 5 {
            return Ok("We're just getting started. Chat with me a bit more and I'll have something real to say.".to_string());
        }
        "Generate an overview report across all profiles.".to_string()
    };
    
    let system_prompt = r#"You are the Governor of Intersect, an orchestration layer that manages multi-agent conversations. You have deep insight into the user's cognitive patterns.

Your task is to generate a personalized insight based on the knowledge base data provided.

CRITICAL LENGTH REQUIREMENT:
- Write EXACTLY 2 sentences. No more.
- Be direct and confident, not hedging
- Synthesize what you've observed into a tight, meaningful observation
- If there's little data, acknowledge it honestly in 2 sentences
- Don't use headers or bullet points — just 2 flowing sentences

FOCUS ON:
- Cognitive tendencies (how they think)
- Communication patterns (how they express themselves)
- Notable themes or interests

STYLE:
- When using dashes for pauses or asides, ALWAYS use double dashes with spaces: " -- " (not " - ")
- Example: "They think in systems -- always mapping things out.""#;

    let user_prompt = format!(
        "SCOPE: {}\n\nPROFILES:\n{}\n\nTOTAL MESSAGES: {}\n\nLEARNED FACTS:\n{}\n\nBEHAVIORAL PATTERNS:\n{}\n\nRECURRING THEMES:\n{}\n\nGenerate the Governor's report:",
        scope, profiles_text, total_messages, facts_text, patterns_text, themes_text
    );
    
    // Use Sonnet (non-thinking) for fast report generation
    let client = AnthropicClient::new(&anthropic_key);
    let messages = vec![
        AnthropicMessage {
            role: "user".to_string(),
            content: user_prompt,
        },
    ];
    
    let response = client.chat_completion_advanced(
        CLAUDE_SONNET,
        Some(system_prompt),
        messages,
        0.7, // Slightly creative
        Some(150), // 2 sentences max
        ThinkingBudget::None
    ).await.map_err(|e| e.to_string())?;
    
    Ok(response)
}

// ============ 3-Sentence Summary ============

#[tauri::command]
async fn generate_user_summary() -> Result<String, String> {
    use crate::anthropic::{AnthropicClient, AnthropicMessage, ThinkingBudget, CLAUDE_SONNET};
    
    let user_profile = db::get_user_profile().map_err(|e| e.to_string())?;
    let anthropic_key = user_profile.anthropic_key.ok_or("Anthropic API key not set")?;
    
    let profiles = db::get_all_persona_profiles().map_err(|e| e.to_string())?;
    let facts = db::get_all_user_facts().unwrap_or_default();
    let patterns = db::get_all_user_patterns().unwrap_or_default();
    let themes = db::get_all_recurring_themes().unwrap_or_default();
    
    let total_messages: i64 = profiles.iter().map(|p| p.message_count).sum();
    
    if total_messages < 5 {
        return Ok("Not enough to vibe check yet — keep chatting and I'll get a read on you.".to_string());
    }
    
    let context = format!(
        "FACTS: {}\nPATTERNS: {}\nTHEMES: {}",
        facts.iter().take(15).map(|f| format!("{}: {}", f.key, f.value)).collect::<Vec<_>>().join("; "),
        patterns.iter().take(10).map(|p| p.description.clone()).collect::<Vec<_>>().join("; "),
        themes.iter().take(8).map(|t| t.theme.clone()).collect::<Vec<_>>().join(", ")
    );
    
    let system_prompt = r#"You are the Governor of Intersect. This is a VIBE CHECK — your gut read on who this person is based on everything you've observed.

Rules:
- Exactly 3 sentences, no more, no less
- Be direct, almost casual — like you're telling a friend what you've noticed
- Reference actual patterns and themes, but make it feel natural, not clinical
- This should feel like insight with personality, not a report
- Don't use bullet points or formatting, just 3 flowing sentences

Style:
- When using dashes for pauses or asides, ALWAYS use double dashes with spaces: " -- " (not " - ")
- Example: "They're curious about everything -- sometimes too curious for their own good.""#;

    let client = AnthropicClient::new(&anthropic_key);
    let messages = vec![
        AnthropicMessage {
            role: "user".to_string(),
            content: format!("Based on this data, write your 3-sentence summary of this person:\n\n{}", context),
        },
    ];
    
    client.chat_completion_advanced(
        CLAUDE_SONNET,
        Some(system_prompt),
        messages,
        0.7,
        Some(200),
        ThinkingBudget::None
    ).await.map_err(|e| e.to_string())
}

// ============ Reset ============

#[tauri::command]
fn reset_all_data() -> Result<(), String> {
    db::reset_all_data().map_err(|e| e.to_string())
}

// ============ Window Controls ============

#[tauri::command]
async fn set_always_on_top(window: tauri::Window, always_on_top: bool) -> Result<(), String> {
    window.set_always_on_top(always_on_top).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_governor_disco_image() -> Result<Option<String>, String> {
    use std::path::PathBuf;
    use std::fs;
    
    // Get home directory
    let home = std::env::var("HOME").map_err(|e| format!("Failed to get HOME: {}", e))?;
    let desktop_path = PathBuf::from(home).join("Desktop/the_governor-disco_mode.png");
    
    // Check if file exists
    if !desktop_path.exists() {
        return Ok(None);
    }
    
    // Read file as bytes
    let bytes = fs::read(&desktop_path).map_err(|e| format!("Failed to read file: {}", e))?;
    
    // Convert to base64 data URL
    use base64::{Engine as _, engine::general_purpose};
    let base64 = general_purpose::STANDARD.encode(&bytes);
    let data_url = format!("data:image/png;base64,{}", base64);
    
    Ok(Some(data_url))
}

#[tauri::command]
fn get_governor_image() -> Result<Option<String>, String> {
    use std::path::PathBuf;
    use std::fs;
    
    // Get home directory
    let home = std::env::var("HOME").map_err(|e| format!("Failed to get HOME: {}", e))?;
    let desktop_path = PathBuf::from(home).join("Desktop/the_governor.png");
    
    // Check if file exists
    if !desktop_path.exists() {
        return Ok(None);
    }
    
    // Read file as bytes
    let bytes = fs::read(&desktop_path).map_err(|e| format!("Failed to read file: {}", e))?;
    
    // Convert to base64 data URL
    use base64::{Engine as _, engine::general_purpose};
    let base64 = general_purpose::STANDARD.encode(&bytes);
    let data_url = format!("data:image/png;base64,{}", base64);
    
    Ok(Some(data_url))
}

#[tauri::command]
fn get_governor_swirling_video() -> Result<Option<String>, String> {
    use std::path::PathBuf;
    use std::fs;
    
    // Get home directory
    let home = std::env::var("HOME").map_err(|e| format!("Failed to get HOME: {}", e))?;
    let desktop_path = PathBuf::from(home).join("Desktop/the_governor-swirling.mp4");
    
    // Check if file exists
    if !desktop_path.exists() {
        return Ok(None);
    }
    
    // Read file as bytes
    let bytes = fs::read(&desktop_path).map_err(|e| format!("Failed to read video: {}", e))?;
    
    // Convert to base64 data URL for video
    use base64::{Engine as _, engine::general_purpose};
    let base64 = general_purpose::STANDARD.encode(&bytes);
    let data_url = format!("data:video/mp4;base64,{}", base64);
    
    Ok(Some(data_url))
}

// ============ Run ============

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            init_app,
            get_user_profile,
            validate_and_save_api_key,
            save_api_key,
            remove_api_key,
            save_anthropic_key,
            remove_anthropic_key,
            create_persona_profile,
            get_all_persona_profiles,
            get_active_persona_profile,
            get_persona_profile_count,
            set_active_persona_profile,
            set_default_persona_profile,
            update_persona_profile_name,
            update_dominant_trait,
            delete_persona_profile,
            create_conversation,
            get_recent_conversations,
            get_conversation_messages,
            clear_conversation,
            finalize_conversation,
            recover_conversations,
            get_conversation_opener,
            send_message,
            get_user_context,
            clear_user_context,
            get_memory_stats,
            get_user_profile_summary,
            generate_governor_report,
            generate_user_summary,
            reset_all_data,
            set_always_on_top,
            get_governor_disco_image,
            get_governor_swirling_video,
            update_weights,
            update_points,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
