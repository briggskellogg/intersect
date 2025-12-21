mod db;
mod knowledge;
mod memory;
mod openai;
mod orchestrator;

use db::{Message, UserProfile, UserContext};
use memory::{MemoryExtractor, ConversationSummarizer};
use orchestrator::{Orchestrator, Agent, ResponseType, AgentResponse, evolve_weights, InteractionType, EngagementAnalyzer, apply_engagement_weights};
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
    pub created_at: String,
    pub updated_at: String,
}

// ============ App Initialization ============

#[tauri::command]
fn init_app(app_handle: tauri::AppHandle) -> Result<(), String> {
    db::init_database(&app_handle).map_err(|e| e.to_string())
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

// ============ Conversations ============

#[tauri::command]
fn create_conversation() -> Result<ConversationInfo, String> {
    let id = Uuid::new_v4().to_string();
    let conv = db::create_conversation(&id).map_err(|e| e.to_string())?;
    Ok(ConversationInfo {
        id: conv.id,
        title: conv.title,
        summary: conv.summary,
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

// ============ Conversation Opener ============

#[derive(Debug, Serialize, Deserialize)]
pub struct ConversationOpenerResult {
    pub agent: String,
    pub content: String,
}

#[tauri::command]
async fn get_conversation_opener() -> Result<ConversationOpenerResult, String> {
    let profile = db::get_user_profile().map_err(|e| e.to_string())?;
    let api_key = profile.api_key.ok_or("API key not set")?;
    let weights = (profile.instinct_weight, profile.logic_weight, profile.psyche_weight);
    
    let recent = db::get_recent_conversations(5).map_err(|e| e.to_string())?;
    
    // Choose opener agent based on weights with some randomness
    let agent = choose_opener_agent(weights);
    
    let orchestrator = Orchestrator::new(&api_key);
    let content = orchestrator.generate_conversation_opener(&recent, &agent)
        .await
        .map_err(|e| e.to_string())?;
    
    Ok(ConversationOpenerResult { agent, content })
}

// Choose which agent opens based on weights + randomness
fn choose_opener_agent(weights: (f64, f64, f64)) -> String {
    use rand::Rng;
    let mut rng = rand::rng();
    let roll: f64 = rng.random();
    
    let (instinct, _logic, psyche) = weights;
    
    // Weighted random selection
    if roll < instinct {
        "instinct".to_string()
    } else if roll < instinct + psyche {
        "psyche".to_string()
    } else {
        "logic".to_string()
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
) -> Result<SendMessageResult, String> {
    // Get profile for API key and weights
    let profile = db::get_user_profile().map_err(|e| e.to_string())?;
    let api_key = profile.api_key.clone().ok_or("API key not set")?;
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
    
    // Create orchestrator
    let orchestrator = Orchestrator::new(&api_key);
    
    // ===== ENGAGEMENT ANALYSIS: Learn from user's response patterns =====
    // Find previous agent responses to analyze user's engagement
    let previous_agent_responses: Vec<(Agent, String)> = recent_messages
        .iter()
        .rev() // Most recent first
        .take_while(|m| m.role != "user" || m.id == user_msg.id) // Until previous user message
        .filter(|m| m.role != "user" && m.role != "system")
        .filter_map(|m| {
            Agent::from_str(&m.role).map(|agent| (agent, m.content.clone()))
        })
        .collect();
    
    // If there were previous agent responses, analyze engagement
    if !previous_agent_responses.is_empty() {
        println!("[WEIGHTS] Analyzing engagement with {} previous agent responses", previous_agent_responses.len());
        
        let engagement_analyzer = EngagementAnalyzer::new(&api_key);
        if let Ok(analysis) = engagement_analyzer.analyze_engagement(&user_message, &previous_agent_responses).await {
            println!("[WEIGHTS] Engagement scores - Logic: {:.2}, Instinct: {:.2}, Psyche: {:.2}", 
                analysis.logic_score, analysis.instinct_score, analysis.psyche_score);
            println!("[WEIGHTS] Reasoning: {}", analysis.reasoning);
            
            // Apply engagement weights with de-exponential rigidity
            let current_weights = db::get_user_profile()
                .map(|p| (p.instinct_weight, p.logic_weight, p.psyche_weight))
                .unwrap_or(initial_weights);
            
            let new_weights = apply_engagement_weights(current_weights, &analysis, profile.total_messages);
            
            let variability = 1.0 / (1.0 + (profile.total_messages as f64 / 100.0).powf(1.5));
            println!("[WEIGHTS] Variability at {} messages: {:.4}", profile.total_messages, variability);
            println!("[WEIGHTS] Updated weights - Instinct: {:.3}, Logic: {:.3}, Psyche: {:.3}", 
                new_weights.0, new_weights.1, new_weights.2);
            
            db::update_weights(new_weights.0, new_weights.1, new_weights.2).map_err(|e| e.to_string())?;
        }
    }
    
    // ===== MEMORY SYSTEM: Grounding Decision =====
    let grounding = if let Some(ref profile) = user_profile {
        // Get conversation summary for context
        let conv_summary = db::get_conversation_summary(&conversation_id).ok().flatten();
        let context = conv_summary.as_ref().map(|s| s.summary.as_str());
        
        orchestrator
            .decide_grounding(&user_message, profile, context)
            .await
            .ok()
    } else {
        None
    };
    
    // ===== MEMORY SYSTEM: Pattern-Aware Routing =====
    let decision = orchestrator
        .decide_response_with_patterns(
            &user_message, 
            &recent_messages, 
            initial_weights, 
            &active_agents,
            user_profile.as_ref(),
        )
        .await
        .map_err(|e| e.to_string())?;
    
    let mut responses = Vec::new();
    let mut debate_mode: Option<String> = None;
    let mut agents_involved = Vec::new();
    
    // Get primary agent response with grounding
    let primary_agent = Agent::from_str(&decision.primary_agent)
        .ok_or_else(|| format!("Invalid agent: {}", decision.primary_agent))?;
    agents_involved.push(primary_agent.as_str().to_string());
    
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
    
    // Update weights for primary agent
    let new_weights = evolve_weights(initial_weights, primary_agent, InteractionType::ChosenAsPrimary, profile.total_messages);
    db::update_weights(new_weights.0, new_weights.1, new_weights.2).map_err(|e| e.to_string())?;
    let mut final_weights = new_weights;
    let mut had_secondary = false;
    
    // Get secondary agent response if needed
    if decision.add_secondary {
        if let Some(secondary_agent_str) = decision.secondary_agent {
            if let Some(secondary_agent) = Agent::from_str(&secondary_agent_str) {
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
                
                // Update weights for secondary agent
                let weights_after_primary = (new_weights.0, new_weights.1, new_weights.2);
                let secondary_weights = evolve_weights(weights_after_primary, secondary_agent, InteractionType::ChosenAsSecondary, profile.total_messages);
                db::update_weights(secondary_weights.0, secondary_weights.1, secondary_weights.2).map_err(|e| e.to_string())?;
                final_weights = secondary_weights;
                had_secondary = true;
            }
        }
    }
    
    // Increment message count
    db::increment_message_count().map_err(|e| e.to_string())?;
    
    // ===== MEMORY SYSTEM: Extract Facts & Patterns (async, non-blocking) =====
    let api_key_clone = api_key.clone();
    let user_message_clone = user_message.clone();
    let conversation_id_clone = conversation_id.clone();
    let responses_for_extraction: Vec<(String, String)> = responses
        .iter()
        .map(|r| (r.agent.clone(), r.content.clone()))
        .collect();
    let existing_facts_clone = existing_facts;
    
    println!("[MEMORY] Spawning extraction task...");
    
    // Spawn memory extraction as a background task
    tokio::spawn(async move {
        println!("[MEMORY] Extraction task started");
        let extractor = MemoryExtractor::new(&api_key_clone);
        match extractor.extract_from_exchange(
            &user_message_clone,
            &responses_for_extraction,
            &existing_facts_clone,
            &conversation_id_clone,
        ).await {
            Ok(result) => println!("[MEMORY] Extraction completed: {} facts, {} patterns", 
                result.new_facts.len(), result.new_patterns.len()),
            Err(e) => println!("[MEMORY] Extraction failed: {}", e),
        }
    });
    
    // ===== MEMORY SYSTEM: Summarize Conversation Periodically =====
    let message_count = profile.total_messages + 1;
    if message_count % 10 == 0 {
        // Every 10 messages, update conversation summary
        let api_key_for_summary = api_key.clone();
        let conversation_id_for_summary = conversation_id.clone();
        let agents_for_summary = agents_involved.clone();
        
        tokio::spawn(async move {
            let summarizer = ConversationSummarizer::new(&api_key_for_summary);
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
        .invoke_handler(tauri::generate_handler![
            init_app,
            get_user_profile,
            validate_and_save_api_key,
            save_api_key,
            remove_api_key,
            save_anthropic_key,
            remove_anthropic_key,
            create_conversation,
            get_recent_conversations,
            get_conversation_messages,
            clear_conversation,
            get_conversation_opener,
            send_message,
            get_user_context,
            clear_user_context,
            get_memory_stats,
            get_user_profile_summary,
            reset_all_data,
            set_always_on_top,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
