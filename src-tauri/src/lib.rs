mod anthropic;
mod db;
mod disco_prompts;
mod knowledge;
mod logging;
mod memory;
mod openai;
mod orchestrator;

use db::{Message, UserProfile, UserContext};
use memory::{MemoryExtractor, ConversationSummarizer};
use orchestrator::{Orchestrator, Agent, ResponseType, AgentResponse, evolve_weights, InteractionType, EngagementAnalyzer, IntrinsicTraitAnalyzer, combine_trait_analyses, decide_response_heuristic, decide_grounding_heuristic};
use serde::{Deserialize, Serialize};
use chrono::Utc;
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize)]
pub struct SendMessageResult {
    pub responses: Vec<AgentResponse>,
    pub debate_mode: Option<String>, // "mild" | "intense" | null
    pub weight_change: Option<WeightChangeNotification>,
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
async fn get_conversation_opener() -> Result<ConversationOpenerResult, String> {
    let profile = db::get_user_profile().map_err(|e| e.to_string())?;
    let anthropic_key = profile.anthropic_key.ok_or("Anthropic API key not set")?;
    
    let recent = db::get_recent_conversations(5).map_err(|e| e.to_string())?;
    
    // Get active persona profile to inform the greeting
    let active_profile = db::get_active_persona_profile().map_err(|e| e.to_string())?;
    let active_trait = active_profile.map(|p| p.dominant_trait).unwrap_or_else(|| "logic".to_string());
    
    // The dominant agent greets the user (using Anthropic/Claude)
    let content = generate_governor_greeting(&anthropic_key, &recent, &active_trait)
        .await
        .map_err(|e| e.to_string())?;
    
    // Return the dominant agent as the speaker, not "system"
    Ok(ConversationOpenerResult { agent: active_trait.clone(), content })
}

// ============ Temporal Context for Greetings ============

struct TemporalContext {
    time_since_last: String,      // "just_now", "short_break", "hours_ago", "same_day", "new_day", "days_ago"
    minutes_elapsed: i64,
    time_of_day: String,          // "early_morning", "morning", "afternoon", "evening", "late_night"
    hour: u32,
}

fn calculate_temporal_context(last_updated: Option<&str>) -> TemporalContext {
    use chrono::{DateTime, Local, Timelike};
    
    let now = Local::now();
    let hour = now.hour();
    
    // Determine time of day
    let time_of_day = match hour {
        5..=8 => "early_morning",
        9..=11 => "morning",
        12..=16 => "afternoon",
        17..=20 => "evening",
        _ => "late_night", // 21-4
    }.to_string();
    
    // If no previous conversation, treat as first time
    let Some(last_str) = last_updated else {
        return TemporalContext {
            time_since_last: "first_time".to_string(),
            minutes_elapsed: -1,
            time_of_day,
            hour,
        };
    };
    
    // Parse last updated timestamp
    let last_time = match DateTime::parse_from_rfc3339(last_str) {
        Ok(dt) => dt.with_timezone(&Local),
        Err(_) => {
            return TemporalContext {
                time_since_last: "unknown".to_string(),
                minutes_elapsed: -1,
                time_of_day,
                hour,
            };
        }
    };
    
    let duration = now.signed_duration_since(last_time);
    let minutes_elapsed = duration.num_minutes();
    
    // Check if it's a new calendar day
    let is_new_calendar_day = now.date_naive() != last_time.date_naive();
    
    // Determine time since last category
    let time_since_last = if minutes_elapsed < 5 {
        "just_now"
    } else if minutes_elapsed < 60 {
        "short_break"
    } else if minutes_elapsed < 240 { // < 4 hours
        "hours_ago"
    } else if !is_new_calendar_day {
        "same_day"
    } else if minutes_elapsed < 1440 { // < 24 hours but new day
        "new_day"
    } else if minutes_elapsed < 4320 { // < 3 days
        "days_ago"
    } else {
        "extended_absence"
    }.to_string();
    
    TemporalContext {
        time_since_last,
        minutes_elapsed,
        time_of_day,
        hour,
    }
}

/// Generate a brief Governor greeting for a new conversation using knowledge base
async fn generate_governor_greeting(anthropic_key: &str, recent_conversations: &[db::Conversation], active_trait: &str) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    use crate::anthropic::{AnthropicClient, AnthropicMessage, ThinkingBudget, CLAUDE_HAIKU};
    
    // ===== TEMPORAL CONTEXT =====
    let last_updated = recent_conversations.first().map(|c| c.updated_at.as_str());
    let temporal = calculate_temporal_context(last_updated);
    
    // ===== LAST CONVERSATION SUMMARY (for resolution state) =====
    let last_summary = if let Some(last_conv) = recent_conversations.first() {
        db::get_conversation_summary(&last_conv.id).unwrap_or(None)
    } else {
        None
    };
    
    // ===== GATHER USER CONTEXT =====
    let user_facts = db::get_all_user_facts().unwrap_or_default();
    let user_patterns = db::get_all_user_patterns().unwrap_or_default();
    
    // Build comprehensive context
    let mut context_parts = Vec::new();
    
    // 1. TEMPORAL SITUATION
    let temporal_desc = match temporal.time_since_last.as_str() {
        "just_now" => format!("TIMING: User JUST finished a conversation (< 5 min ago). They're back immediately -- something else on their mind or continuing a thread."),
        "short_break" => format!("TIMING: User took a short break ({} minutes). They're picking up the session.", temporal.minutes_elapsed),
        "hours_ago" => format!("TIMING: It's been {} hours since they last chatted. Same day, fresh energy.", temporal.minutes_elapsed / 60),
        "same_day" => format!("TIMING: They chatted earlier today but it's been a while ({}+ hours). Checking back in.", temporal.minutes_elapsed / 60),
        "new_day" => "TIMING: This is a NEW DAY since their last conversation. Fresh start, new day greeting appropriate.".to_string(),
        "days_ago" => format!("TIMING: It's been {} days since they last chatted. They've been away for a bit.", temporal.minutes_elapsed / 1440),
        "extended_absence" => format!("TIMING: Extended absence -- {} days since last chat. Welcome them back warmly.", temporal.minutes_elapsed / 1440),
        "first_time" => "TIMING: This is their FIRST conversation ever. Welcome them.".to_string(),
        _ => "TIMING: Unknown timing context.".to_string(),
    };
    context_parts.push(temporal_desc);
    
    // 2. TIME OF DAY
    let time_of_day_desc = match temporal.time_of_day.as_str() {
        "early_morning" => format!("TIME OF DAY: Early morning ({}:00). They're up early.", temporal.hour),
        "morning" => format!("TIME OF DAY: Morning ({}:00). Standard working hours.", temporal.hour),
        "afternoon" => format!("TIME OF DAY: Afternoon ({}:00). Midday energy.", temporal.hour),
        "evening" => format!("TIME OF DAY: Evening ({}:00). Winding down or reflective time.", temporal.hour),
        "late_night" => format!("TIME OF DAY: Late night ({}:00). They're burning the midnight oil.", temporal.hour),
        _ => "TIME OF DAY: Unknown.".to_string(),
    };
    context_parts.push(time_of_day_desc);
    
    // 3. LAST CONVERSATION STATE
    if let Some(ref summary) = last_summary {
        let mut last_conv_parts = vec![format!("LAST CONVERSATION:")];
        last_conv_parts.push(format!("- Summary: {}", summary.summary));
        if let Some(ref tone) = summary.emotional_tone {
            last_conv_parts.push(format!("- Emotional tone: {}", tone));
        }
        if let Some(ref state) = summary.user_state {
            last_conv_parts.push(format!("- User state: {}", state));
        }
        // Check for potential unresolved signals in the summary
        let summary_lower = summary.summary.to_lowercase();
        let unresolved_signals = ["trying to", "working on", "figuring out", "struggling with", 
                                   "not sure", "debating", "considering", "exploring", "stuck on"];
        let might_be_unresolved = unresolved_signals.iter().any(|s| summary_lower.contains(s));
        if might_be_unresolved {
            last_conv_parts.push("- SIGNAL: The last conversation may have left something unresolved or in-progress.".to_string());
        }
        context_parts.push(last_conv_parts.join("\n"));
    } else if let Some(last_conv) = recent_conversations.first() {
        // No summary but we have conversation metadata
        if let Some(ref title) = last_conv.title {
            context_parts.push(format!("LAST CONVERSATION: Topic was \"{}\" (no detailed summary available).", title));
        }
    }
    
    // 4. ACTIVE PROFILE
    let profile_context = match active_trait {
        "instinct" => "CURRENT PROFILE: INSTINCT (Snap) -- gut-feeling, action-oriented mode. Raw, impulsive energy.",
        "logic" => "CURRENT PROFILE: LOGIC (Dot) -- analytical, systematic mode. Problem-solving, seeking clarity.",
        "psyche" => "CURRENT PROFILE: PSYCHE (Puff) -- emotional, introspective mode. Processing feelings, seeking understanding.",
        _ => "CURRENT PROFILE: Balanced mode."
    };
    context_parts.push(profile_context.to_string());
    
    // 5. USER KNOWLEDGE
    let personal_facts: Vec<_> = user_facts.iter()
        .filter(|f| f.category == "personal" || f.category == "preferences")
        .take(5)
        .map(|f| format!("- {}: {}", f.key, f.value))
        .collect();
    if !personal_facts.is_empty() {
        context_parts.push(format!("KNOWN ABOUT USER:\n{}", personal_facts.join("\n")));
    }
    
    // 6. PATTERNS
    let themes: Vec<_> = user_patterns.iter()
        .filter(|p| p.confidence > 0.5)
        .take(3)
        .map(|p| format!("- {}", p.description))
        .collect();
    if !themes.is_empty() {
        context_parts.push(format!("BEHAVIORAL PATTERNS:\n{}", themes.join("\n")));
    }
    
    // 7. RECENT TOPICS (beyond just the last one)
    if recent_conversations.len() > 1 {
        let other_recent: Vec<String> = recent_conversations
            .iter()
            .skip(1)
            .take(2)
            .filter_map(|c| c.title.as_ref())
            .map(|t| format!("- {}", t))
            .collect();
        if !other_recent.is_empty() {
            context_parts.push(format!("OTHER RECENT TOPICS:\n{}", other_recent.join("\n")));
        }
    }
    
    let full_context = context_parts.join("\n\n");
    
    // ===== SOPHISTICATED SYSTEM PROMPT =====
    let agent_name = match active_trait {
        "instinct" => "Snap",
        "logic" => "Dot",
        "psyche" => "Puff",
        _ => "Dot"
    };
    
    let system_prompt = format!(r#"You are {agent_name}, greeting the user at the start of a new conversation in Intersect.

## CRITICAL OUTPUT INSTRUCTION

Generate EXACTLY ONE greeting. Output ONLY that greeting text -- no quotes around it, no explanations, no alternatives, no bullet points, no slashes showing options. Just the raw greeting as you would say it.

## TIMING CONTEXT (shapes the entire approach)

**Quick Return (< 5 min):** They just ended a conversation and started another.
Examples: "What else?" or "Something else on your mind?" or "More to unpack?"
DON'T ask how their day is going -- you JUST talked.

**Short Break (5-60 min):** Session continuation.
Examples: "Ready for round two?" or "Back at it?"

**Hours Later (same day):** Fresh return.
Examples: "Taking another look?" or "Fresh perspective?"

**New Day:** New calendar day, fresh start.
Examples: "Hey [name], how's today treating you?" or "New day -- what's on your mind?"

**Days Away (2-3 days):** They've been absent.
Examples: "Been a minute -- what's been going on?" or "Hey, it's been a few days."

**Extended Absence (3+ days):** Warm return.
Examples: "Good to see you back. What brings you?"

## UNRESOLVED TOPICS

If the last conversation left something unresolved, reference it:
Examples: "Did you figure out [topic]?" or "Still mulling over [X]?"

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
- NO meta-commentary, explanations, or quotation marks around your output"#);

    let client = AnthropicClient::new(anthropic_key);
    let messages = vec![
        AnthropicMessage {
            role: "user".to_string(),
            content: format!("Generate a contextually appropriate greeting based on this situation. Output ONLY the greeting text, nothing else:\n\n{}", full_context),
        },
    ];
    
    client.chat_completion_advanced(
        CLAUDE_HAIKU,
        Some(&system_prompt),
        messages,
        0.8,
        Some(100), // More room for nuanced greeting
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
    is_disco: bool,
) -> Result<SendMessageResult, String> {
    // Get profile for API keys and weights
    let profile = db::get_user_profile().map_err(|e| e.to_string())?;
    let api_key = profile.api_key.clone().ok_or("OpenAI API key not set")?;
    let anthropic_key = profile.anthropic_key.clone().ok_or("Anthropic API key not set")?;
    let initial_weights = (profile.instinct_weight, profile.logic_weight, profile.psyche_weight);
    
    if active_agents.is_empty() {
        return Ok(SendMessageResult { responses: Vec::new(), debate_mode: None, weight_change: None });
    }
    
    // ===== MEMORY SYSTEM: Build User Profile =====
    let user_profile = MemoryExtractor::build_profile_summary().ok();
    
    // Get existing facts for extraction context
    let existing_facts = db::get_all_user_facts().unwrap_or_default();
    
    // Track initial dominant agent for change detection
    let _initial_dominant = get_dominant_agent(initial_weights);
    
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
    
    // ===== FAST HEURISTIC ROUTING (No API calls) =====
    // Trait analysis moved to background task AFTER response for speed
    
    // Use heuristic grounding (instant, no API call)
    let grounding = user_profile.as_ref().map(|profile| {
        decide_grounding_heuristic(&user_message, &recent_messages, Some(profile))
    });
    
    // Use heuristic routing (instant, no API call)
    let decision = decide_response_heuristic(
        &user_message, 
        initial_weights, 
        &active_agents,
        &recent_messages,
        is_disco,
    );
    
    let mut responses = Vec::new();
    let mut debate_mode: Option<String> = None;
    let mut agents_involved = Vec::new();
    
    // Get primary agent response with grounding
    let primary_agent = Agent::from_str(&decision.primary_agent)
        .ok_or_else(|| format!("Invalid agent: {}", decision.primary_agent))?;
    agents_involved.push(primary_agent.as_str().to_string());
    
    // Check if this is a disco conversation
    let primary_is_disco = is_disco;
    if is_disco {
        logging::log_agent(Some(&conversation_id), &format!(
            "{} in DISCO CONVERSATION - using extreme prompts", primary_agent.as_str()
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
    
    // Update weights for primary agent (disco dampening now applied at engagement analysis stage)
    let new_weights = evolve_weights(initial_weights, primary_agent, InteractionType::ChosenAsPrimary, profile.total_messages);
    db::update_weights(new_weights.0, new_weights.1, new_weights.2).map_err(|e| e.to_string())?;
    let mut final_weights = new_weights;
    let mut had_secondary = false;
    
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
                                is_disco, // Conversation-level disco
                                is_disco, // primary_is_disco same as is_disco now
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
                had_secondary = true;
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
                
                // In disco conversation, all agents use disco prompts
                if is_disco {
                    logging::log_agent(Some(&conversation_id), &format!(
                        "{} in DISCO CONVERSATION - using extreme prompts", secondary_agent.as_str()
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
                        is_disco, // Conversation-level disco
                        is_disco, // primary_is_disco same as is_disco now
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
                
                // Update weights for secondary agent (disco dampening now applied at engagement analysis stage)
                let weights_after_primary = (new_weights.0, new_weights.1, new_weights.2);
                let secondary_weights = evolve_weights(weights_after_primary, secondary_agent, InteractionType::ChosenAsSecondary, profile.total_messages);
                db::update_weights(secondary_weights.0, secondary_weights.1, secondary_weights.2).map_err(|e| e.to_string())?;
                final_weights = secondary_weights;
                had_secondary = true;
                
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
                    let mut _last_agent_disco = is_disco; // In disco conversations, all agents use disco mode
                    let mut last_msg_id = secondary_msg.id.clone();
                    let mut current_weights = final_weights;
                    
                    // Try to continue debate (up to 2 more responses, max 4 total)
                    for turn in 0..2 {
                        let response_count = responses_so_far.len();
                        
                        let (should_continue, next_agent_str, next_type) = orchestrator
                            .should_continue_debate(
                                &user_message,
                                &responses_so_far,
                                &active_agents,
                                is_disco,
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
                                
                                logging::log_agent(Some(&conversation_id), &format!(
                                    "Debate turn {}: {} responding (disco: {})", turn + 1, next_agent.as_str(), is_disco
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
                                        is_disco, // Conversation-level disco
                                        is_disco, // last_agent_disco same as is_disco now
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
                                
                                // Update weights (disco dampening now applied at engagement analysis stage)
                                let debate_weights = evolve_weights(current_weights, next_agent, InteractionType::ChosenAsSecondary, profile.total_messages);
                                db::update_weights(debate_weights.0, debate_weights.1, debate_weights.2).map_err(|e| e.to_string())?;
                                current_weights = debate_weights;
                                final_weights = debate_weights;
                                
                                // Update for next iteration
                                responses_so_far.push((next_agent.as_str().to_string(), next_response.clone()));
                                last_response = next_response;
                                last_agent = next_agent.as_str().to_string();
                                _last_agent_disco = is_disco; // All agents in disco conversation use disco mode
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
    
    // Increment message count
    db::increment_message_count().map_err(|e| e.to_string())?;
    
    // ===== TRAIT ANALYSIS: Run in background AFTER response (non-blocking) =====
    // This was moved from before routing to improve response speed
    {
        let anthropic_key_for_traits = anthropic_key.clone();
        let user_message_for_traits = user_message.clone();
        let conversation_id_for_traits = conversation_id.clone();
        let is_disco_for_traits = is_disco;
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
                        is_disco_for_traits,
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
    
    // Generate weight change notification
    let weight_change = generate_weight_notification(
        initial_weights,
        final_weights,
        primary_agent.as_str(),
        had_secondary,
    );
    
    Ok(SendMessageResult { responses, debate_mode, weight_change })
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
