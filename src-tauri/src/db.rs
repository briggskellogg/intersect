use chrono::Utc;
use rusqlite::{Connection, Result, params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use once_cell::sync::Lazy;
use tauri::Manager;

// Database connection singleton
static DB: Lazy<Mutex<Option<Connection>>> = Lazy::new(|| Mutex::new(None));

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UserProfile {
    pub id: i64,
    pub api_key: Option<String>,
    pub anthropic_key: Option<String>,
    pub instinct_weight: f64,
    pub logic_weight: f64,
    pub psyche_weight: f64,
    pub total_messages: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Conversation {
    pub id: String,
    pub title: Option<String>,
    pub summary: Option<String>,
    pub limbo_summary: Option<String>,
    pub processed: bool,
    pub is_disco: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub role: String,
    pub content: String,
    pub response_type: Option<String>,
    pub references_message_id: Option<String>,
    pub timestamp: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UserContext {
    pub id: i64,
    pub key: String,
    pub value: String,
    pub confidence: f64,
    pub source_agent: Option<String>,
    pub updated_at: String,
}

// ============ Memory System Structs ============

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UserFact {
    pub id: i64,
    pub category: String,           // "personal", "preferences", "work", "relationships", "values"
    pub key: String,
    pub value: String,
    pub confidence: f64,            // 1.0 for explicit, lower for inferred
    pub source_type: String,        // "explicit" or "inferred"
    pub source_conversation_id: Option<String>,
    pub first_mentioned: String,
    pub last_confirmed: String,
    pub mention_count: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UserPattern {
    pub id: i64,
    pub pattern_type: String,       // "communication_style", "emotional_tendency", "thinking_mode", "recurring_theme"
    pub description: String,
    pub confidence: f64,
    pub evidence: String,           // JSON array of supporting observations
    pub first_observed: String,
    pub last_updated: String,
    pub observation_count: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ConversationSummary {
    pub id: i64,
    pub conversation_id: String,
    pub summary: String,
    pub key_topics: String,         // JSON array
    pub emotional_tone: Option<String>,
    pub user_state: Option<String>,
    pub agents_involved: String,    // JSON array
    pub message_count: i64,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RecurringTheme {
    pub id: i64,
    pub theme: String,
    pub frequency: i64,
    pub last_mentioned: String,
    pub related_conversations: Option<String>, // JSON array of conversation IDs
}

// ============ Multi-Profile System ============

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PersonaProfile {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    pub is_active: bool,
    pub dominant_trait: String,      // 'logic' | 'instinct' | 'psyche'
    pub secondary_trait: String,     // must differ from dominant
    pub instinct_weight: f64,
    pub logic_weight: f64,
    pub psyche_weight: f64,
    pub instinct_points: i64,        // User-allocated points (2-6, total 11)
    pub logic_points: i64,
    pub psyche_points: i64,
    pub message_count: i64,          // Number of messages sent with this profile
    pub created_at: String,
    pub updated_at: String,
}

fn get_db_path(app_handle: &tauri::AppHandle) -> PathBuf {
    let app_data_dir = app_handle.path().app_data_dir().expect("Failed to get app data dir");
    std::fs::create_dir_all(&app_data_dir).expect("Failed to create app data dir");
    app_data_dir.join("intersect.db")
}

pub fn init_database(app_handle: &tauri::AppHandle) -> Result<()> {
    let db_path = get_db_path(app_handle);
    let conn = Connection::open(&db_path)?;
    
    // Create tables
    conn.execute_batch(
        "
        -- User profile with evolving weights
        CREATE TABLE IF NOT EXISTS user_profile (
            id INTEGER PRIMARY KEY,
            api_key TEXT,
            anthropic_key TEXT,
            instinct_weight REAL DEFAULT 0.33,
            logic_weight REAL DEFAULT 0.33,
            psyche_weight REAL DEFAULT 0.34,
            total_messages INTEGER DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        -- Conversation sessions
        CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            title TEXT,
            summary TEXT,
            limbo_summary TEXT,
            processed INTEGER DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        -- Messages with agent attribution
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            response_type TEXT,
            references_message_id TEXT,
            timestamp TEXT NOT NULL,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id)
        );

        -- Learned user context (legacy, kept for compatibility)
        CREATE TABLE IF NOT EXISTS user_context (
            id INTEGER PRIMARY KEY,
            key TEXT UNIQUE NOT NULL,
            value TEXT NOT NULL,
            confidence REAL DEFAULT 0.5,
            source_agent TEXT,
            updated_at TEXT NOT NULL
        );

        -- User facts (explicit statements about the user)
        CREATE TABLE IF NOT EXISTS user_facts (
            id INTEGER PRIMARY KEY,
            category TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            confidence REAL DEFAULT 1.0,
            source_type TEXT NOT NULL,
            source_conversation_id TEXT,
            first_mentioned TEXT NOT NULL,
            last_confirmed TEXT NOT NULL,
            mention_count INTEGER DEFAULT 1,
            UNIQUE(category, key)
        );

        -- Inferred patterns (behavioral/personality observations)
        CREATE TABLE IF NOT EXISTS user_patterns (
            id INTEGER PRIMARY KEY,
            pattern_type TEXT NOT NULL,
            description TEXT NOT NULL,
            confidence REAL DEFAULT 0.5,
            evidence TEXT NOT NULL,
            first_observed TEXT NOT NULL,
            last_updated TEXT NOT NULL,
            observation_count INTEGER DEFAULT 1
        );

        -- Conversation summaries (token-efficient history)
        CREATE TABLE IF NOT EXISTS conversation_summaries (
            id INTEGER PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            summary TEXT NOT NULL,
            key_topics TEXT NOT NULL,
            emotional_tone TEXT,
            user_state TEXT,
            agents_involved TEXT NOT NULL,
            message_count INTEGER,
            created_at TEXT NOT NULL,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id)
        );

        -- Cross-conversation recurring themes
        CREATE TABLE IF NOT EXISTS recurring_themes (
            id INTEGER PRIMARY KEY,
            theme TEXT NOT NULL UNIQUE,
            frequency INTEGER DEFAULT 1,
            last_mentioned TEXT NOT NULL,
            related_conversations TEXT
        );

        -- Persona profiles (multiple user states/modes)
        CREATE TABLE IF NOT EXISTS persona_profiles (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            is_default INTEGER DEFAULT 0,
            is_active INTEGER DEFAULT 0,
            dominant_trait TEXT NOT NULL,
            secondary_trait TEXT NOT NULL,
            instinct_weight REAL DEFAULT 0.2,
            logic_weight REAL DEFAULT 0.5,
            psyche_weight REAL DEFAULT 0.3,
            message_count INTEGER DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        "
    )?;
    
    // Migration: Add anthropic_key column if it doesn't exist
    let has_anthropic_key: bool = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('user_profile') WHERE name='anthropic_key'",
        [],
        |row| Ok(row.get::<_, i64>(0)? > 0)
    ).unwrap_or(false);
    
    if !has_anthropic_key {
        let _ = conn.execute("ALTER TABLE user_profile ADD COLUMN anthropic_key TEXT", []);
    }
    
    // Migration: Add message_count column to persona_profiles if it doesn't exist
    let has_persona_message_count: bool = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('persona_profiles') WHERE name='message_count'",
        [],
        |row| Ok(row.get::<_, i64>(0)? > 0)
    ).unwrap_or(false);
    
    if !has_persona_message_count {
        let _ = conn.execute("ALTER TABLE persona_profiles ADD COLUMN message_count INTEGER DEFAULT 0", []);
    }
    
    // Migration: Add limbo_summary and processed columns to conversations table
    let has_limbo_summary: bool = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('conversations') WHERE name='limbo_summary'",
        [],
        |row| Ok(row.get::<_, i64>(0)? > 0)
    ).unwrap_or(false);
    
    if !has_limbo_summary {
        let _ = conn.execute("ALTER TABLE conversations ADD COLUMN limbo_summary TEXT", []);
        let _ = conn.execute("ALTER TABLE conversations ADD COLUMN processed INTEGER DEFAULT 0", []);
    }
    
    // Migration: Add is_disco column to conversations table for conversation-level disco mode
    let has_is_disco: bool = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('conversations') WHERE name='is_disco'",
        [],
        |row| Ok(row.get::<_, i64>(0)? > 0)
    ).unwrap_or(false);
    
    if !has_is_disco {
        let _ = conn.execute("ALTER TABLE conversations ADD COLUMN is_disco INTEGER DEFAULT 0", []);
    }
    
    // Migration: Add points columns to persona_profiles table
    let has_instinct_points: bool = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('persona_profiles') WHERE name='instinct_points'",
        [],
        |row| Ok(row.get::<_, i64>(0)? > 0)
    ).unwrap_or(false);
    
    if !has_instinct_points {
        // Add columns with defaults: 4, 4, 3 (total 11)
        let _ = conn.execute("ALTER TABLE persona_profiles ADD COLUMN instinct_points INTEGER DEFAULT 4", []);
        let _ = conn.execute("ALTER TABLE persona_profiles ADD COLUMN logic_points INTEGER DEFAULT 4", []);
        let _ = conn.execute("ALTER TABLE persona_profiles ADD COLUMN psyche_points INTEGER DEFAULT 3", []);
        
        // For existing profiles, initialize points based on current weights
        // Convert weights to points: points = round(weight * 11), but ensure valid range (2-6) and total = 11
        let _ = conn.execute(
            "UPDATE persona_profiles SET instinct_points = CAST(ROUND(instinct_weight * 11) AS INTEGER), logic_points = CAST(ROUND(logic_weight * 11) AS INTEGER), psyche_points = CAST(ROUND(psyche_weight * 11) AS INTEGER)",
            []
        );
        
        // Ensure points are in valid range (2-6) and total = 11
        // Clamp each to 2-6 range, then normalize total to 11
        let _ = conn.execute(
            "UPDATE persona_profiles SET 
                instinct_points = MAX(2, MIN(6, instinct_points)),
                logic_points = MAX(2, MIN(6, logic_points)),
                psyche_points = MAX(2, MIN(6, psyche_points))",
            []
        );
        
        // Normalize totals to 11 (this is approximate, but close enough for migration)
        // We'll fix exact totals in a separate pass if needed
    }
    
    // Ensure a user profile exists (for API keys and message count)
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM user_profile",
        [],
        |row| row.get(0)
    )?;
    
    if count == 0 {
        let now = Utc::now().to_rfc3339();
        // Default weights: Logic 50%, Psyche 30%, Instinct 20%
        conn.execute(
            "INSERT INTO user_profile (api_key, instinct_weight, logic_weight, psyche_weight, total_messages, created_at, updated_at)
             VALUES (NULL, 0.20, 0.50, 0.30, 0, ?1, ?2)",
            params![now, now]
        )?;
    }
    
    // Ensure exactly 3 fixed profiles exist (Logic, Instinct, Psyche)
    // Each profile is dominant for one trait at 40%, others at 30%
    let now = Utc::now().to_rfc3339();
    
    // Check for each required profile by dominant_trait
    let has_logic: bool = conn.query_row(
        "SELECT COUNT(*) FROM persona_profiles WHERE dominant_trait = 'logic'",
        [],
        |row| Ok(row.get::<_, i64>(0)? > 0)
    ).unwrap_or(false);
    
    let has_instinct: bool = conn.query_row(
        "SELECT COUNT(*) FROM persona_profiles WHERE dominant_trait = 'instinct'",
        [],
        |row| Ok(row.get::<_, i64>(0)? > 0)
    ).unwrap_or(false);
    
    let has_psyche: bool = conn.query_row(
        "SELECT COUNT(*) FROM persona_profiles WHERE dominant_trait = 'psyche'",
        [],
        |row| Ok(row.get::<_, i64>(0)? > 0)
    ).unwrap_or(false);
    
    // Create missing profiles
    if !has_logic {
        let logic_id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO persona_profiles (id, name, is_default, is_active, dominant_trait, secondary_trait, instinct_weight, logic_weight, psyche_weight, instinct_points, logic_points, psyche_points, message_count, created_at, updated_at)
             VALUES (?1, 'Logic', 1, 1, 'logic', 'logic', 0.30, 0.40, 0.30, 3, 4, 4, 0, ?2, ?3)",
            params![logic_id, now, now]
        )?;
    }
    
    if !has_instinct {
        let instinct_id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO persona_profiles (id, name, is_default, is_active, dominant_trait, secondary_trait, instinct_weight, logic_weight, psyche_weight, instinct_points, logic_points, psyche_points, message_count, created_at, updated_at)
             VALUES (?1, 'Instinct', 0, 0, 'instinct', 'instinct', 0.40, 0.30, 0.30, 4, 3, 4, 0, ?2, ?3)",
            params![instinct_id, now, now]
        )?;
    }
    
    if !has_psyche {
        let psyche_id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO persona_profiles (id, name, is_default, is_active, dominant_trait, secondary_trait, instinct_weight, logic_weight, psyche_weight, instinct_points, logic_points, psyche_points, message_count, created_at, updated_at)
             VALUES (?1, 'Psyche', 0, 0, 'psyche', 'psyche', 0.30, 0.30, 0.40, 3, 3, 5, 0, ?2, ?3)",
            params![psyche_id, now, now]
        )?;
    }
    
    // Ensure exactly one profile is active (prefer Logic if none)
    let has_active: bool = conn.query_row(
        "SELECT COUNT(*) FROM persona_profiles WHERE is_active = 1",
        [],
        |row| Ok(row.get::<_, i64>(0)? > 0)
    ).unwrap_or(false);
    
    if !has_active {
        conn.execute(
            "UPDATE persona_profiles SET is_active = 1 WHERE dominant_trait = 'logic'",
            []
        )?;
    }
    
    // Ensure exactly one profile is default (prefer Logic if none)
    let has_default: bool = conn.query_row(
        "SELECT COUNT(*) FROM persona_profiles WHERE is_default = 1",
        [],
        |row| Ok(row.get::<_, i64>(0)? > 0)
    ).unwrap_or(false);
    
    if !has_default {
        conn.execute(
            "UPDATE persona_profiles SET is_default = 1 WHERE dominant_trait = 'logic'",
            []
        )?;
    }
    
    // Remove any profiles that don't match the 3 fixed trait types
    // (Clean up any old custom profiles)
    conn.execute(
        "DELETE FROM persona_profiles WHERE dominant_trait NOT IN ('logic', 'instinct', 'psyche')",
        []
    )?;
    
    // Keep only one profile per dominant trait (remove duplicates, keep the one with most messages)
    for trait_type in &["logic", "instinct", "psyche"] {
        let count: i64 = conn.query_row(
            &format!("SELECT COUNT(*) FROM persona_profiles WHERE dominant_trait = '{}'", trait_type),
            [],
            |row| row.get(0)
        ).unwrap_or(0);
        
        if count > 1 {
            // Get the ID of the profile to keep (highest message_count)
            let keep_id: String = conn.query_row(
                &format!(
                    "SELECT id FROM persona_profiles WHERE dominant_trait = '{}' ORDER BY message_count DESC, created_at ASC LIMIT 1",
                    trait_type
                ),
                [],
                |row| row.get(0)
            ).unwrap_or_default();
            
            if !keep_id.is_empty() {
                conn.execute(
                    &format!(
                        "DELETE FROM persona_profiles WHERE dominant_trait = '{}' AND id != ?1",
                        trait_type
                    ),
                    params![keep_id]
                )?;
            }
        }
    }
    
    let mut db = DB.lock().unwrap();
    *db = Some(conn);
    
    Ok(())
}

fn with_connection<F, T>(f: F) -> Result<T>
where
    F: FnOnce(&Connection) -> Result<T>,
{
    let db = DB.lock().unwrap();
    let conn = db.as_ref().expect("Database not initialized");
    f(conn)
}

// ============ User Profile ============

pub fn get_user_profile() -> Result<UserProfile> {
    with_connection(|conn| {
        // Get base profile info (API keys, message count)
        let base: (i64, Option<String>, Option<String>, i64, String, String) = conn.query_row(
            "SELECT id, api_key, anthropic_key, total_messages, created_at, updated_at
             FROM user_profile LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?))
        )?;
        
        // Get weights from active persona profile, or fallback to user_profile weights
        let weights: (f64, f64, f64) = conn.query_row(
            "SELECT instinct_weight, logic_weight, psyche_weight FROM persona_profiles WHERE is_active = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        ).unwrap_or_else(|_| {
            // Fallback to user_profile weights if no active persona profile
            conn.query_row(
                "SELECT instinct_weight, logic_weight, psyche_weight FROM user_profile LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            ).unwrap_or((0.2, 0.5, 0.3)) // Final fallback to defaults
        });
        
        Ok(UserProfile {
            id: base.0,
            api_key: base.1,
            anthropic_key: base.2,
            instinct_weight: weights.0,
            logic_weight: weights.1,
            psyche_weight: weights.2,
            total_messages: base.3,
            created_at: base.4,
            updated_at: base.5,
        })
    })
}

pub fn update_api_key(api_key: &str) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    with_connection(|conn| {
        conn.execute(
            "UPDATE user_profile SET api_key = ?1, updated_at = ?2",
            params![api_key, now]
        )?;
        Ok(())
    })
}

pub fn clear_api_key() -> Result<()> {
    let now = Utc::now().to_rfc3339();
    with_connection(|conn| {
        conn.execute(
            "UPDATE user_profile SET api_key = NULL, updated_at = ?1",
            params![now]
        )?;
        Ok(())
    })
}

pub fn update_anthropic_key(api_key: &str) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    with_connection(|conn| {
        conn.execute(
            "UPDATE user_profile SET anthropic_key = ?1, updated_at = ?2",
            params![api_key, now]
        )?;
        Ok(())
    })
}

pub fn clear_anthropic_key() -> Result<()> {
    let now = Utc::now().to_rfc3339();
    with_connection(|conn| {
        conn.execute(
            "UPDATE user_profile SET anthropic_key = NULL, updated_at = ?1",
            params![now]
        )?;
        Ok(())
    })
}

/// Update points for the active persona profile
/// NOTE: Points affect agent weightings but do NOT change the dominant_trait
/// The dominant_trait is fixed per profile (selected when the profile is created/activated)
pub fn update_points(instinct: i64, logic: i64, psyche: i64) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    
    // Only update the points - do NOT change dominant_trait or secondary_trait
    // Those are fixed properties of the profile identity
    with_connection(|conn| {
        conn.execute(
            "UPDATE persona_profiles SET instinct_points = ?1, logic_points = ?2, psyche_points = ?3, updated_at = ?4 WHERE is_active = 1",
            params![instinct, logic, psyche, now]
        )?;
        Ok(())
    })
}

pub fn update_weights(instinct: f64, logic: f64, psyche: f64) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    with_connection(|conn| {
        // Update the active persona profile's weights (no constraints)
        let updated = conn.execute(
            "UPDATE persona_profiles SET instinct_weight = ?1, logic_weight = ?2, psyche_weight = ?3, updated_at = ?4 WHERE is_active = 1",
            params![instinct, logic, psyche, now]
        )?;
        
        // Fallback to user_profile if no active persona profile (legacy support)
        if updated == 0 {
            conn.execute(
                "UPDATE user_profile SET instinct_weight = ?1, logic_weight = ?2, psyche_weight = ?3, updated_at = ?4",
                params![instinct, logic, psyche, now]
            )?;
        }
        
        Ok(())
    })
}

/// Enforce that the dominant trait maintains at least a 10% lead over other traits
fn enforce_dominant_lead(instinct: f64, logic: f64, psyche: f64, dominant: &str) -> (f64, f64, f64) {
    let min_lead = 0.10; // 10% lead
    
    let (mut i, mut l, mut p) = (instinct, logic, psyche);
    
    match dominant {
        "instinct" => {
            let max_other = l.max(p);
            if i < max_other + min_lead {
                // Need to boost instinct to maintain lead
                i = max_other + min_lead;
            }
        }
        "logic" => {
            let max_other = i.max(p);
            if l < max_other + min_lead {
                l = max_other + min_lead;
            }
        }
        "psyche" => {
            let max_other = i.max(l);
            if p < max_other + min_lead {
                p = max_other + min_lead;
            }
        }
        _ => {}
    }
    
    // Normalize to sum to 1.0
    let total = i + l + p;
    (i / total, l / total, p / total)
}

pub fn increment_message_count() -> Result<()> {
    let now = Utc::now().to_rfc3339();
    with_connection(|conn| {
        // Increment global message count
        conn.execute(
            "UPDATE user_profile SET total_messages = total_messages + 1, updated_at = ?1",
            params![now]
        )?;
        
        // Also increment the active persona profile's message count
        conn.execute(
            "UPDATE persona_profiles SET message_count = message_count + 1, updated_at = ?1 WHERE is_active = 1",
            params![now]
        )?;
        Ok(())
    })
}

// ============ Conversations ============

pub fn create_conversation(id: &str, is_disco: bool) -> Result<Conversation> {
    let now = Utc::now().to_rfc3339();
    with_connection(|conn| {
        conn.execute(
            "INSERT INTO conversations (id, title, summary, limbo_summary, processed, is_disco, created_at, updated_at)
             VALUES (?1, NULL, NULL, NULL, 0, ?2, ?3, ?4)",
            params![id, if is_disco { 1 } else { 0 }, now, now]
        )?;
        Ok(Conversation {
            id: id.to_string(),
            title: None,
            summary: None,
            limbo_summary: None,
            processed: false,
            is_disco,
            created_at: now.clone(),
            updated_at: now,
        })
    })
}

pub fn get_conversation(id: &str) -> Result<Option<Conversation>> {
    with_connection(|conn| {
        let result = conn.query_row(
            "SELECT id, title, summary, limbo_summary, processed, is_disco, created_at, updated_at FROM conversations WHERE id = ?1",
            params![id],
            |row| {
                Ok(Conversation {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    summary: row.get(2)?,
                    limbo_summary: row.get(3)?,
                    processed: row.get::<_, i64>(4)? != 0,
                    is_disco: row.get::<_, i64>(5).unwrap_or(0) != 0,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            }
        );
        match result {
            Ok(conv) => Ok(Some(conv)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    })
}

pub fn get_recent_conversations(limit: usize) -> Result<Vec<Conversation>> {
    with_connection(|conn| {
        let mut stmt = conn.prepare(
            "SELECT c.id, c.title, c.summary, c.limbo_summary, c.processed, c.is_disco, c.created_at, c.updated_at,
                    (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) as msg_count
             FROM conversations c
             WHERE (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) > 0
             ORDER BY c.updated_at DESC 
             LIMIT ?1"
        )?;
        
        let convs = stmt.query_map([limit], |row| {
            Ok(Conversation {
                id: row.get(0)?,
                title: row.get(1)?,
                summary: row.get(2)?,
                limbo_summary: row.get(3)?,
                processed: row.get::<_, i64>(4)? != 0,
                is_disco: row.get::<_, i64>(5).unwrap_or(0) != 0,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })?;
        
        convs.collect()
    })
}

/// Get conversations that need recovery (unprocessed, have messages, older than 1 min)
/// Used on startup to finalize conversations from crashes/force-quits
pub fn get_conversations_needing_recovery() -> Result<Vec<Conversation>> {
    use chrono::Duration;
    
    with_connection(|conn| {
        // Get conversations that:
        // 1. Are not processed
        // 2. Are older than 1 minute (not currently being written to)
        let cutoff = (Utc::now() - Duration::minutes(1)).to_rfc3339();
        
        let mut stmt = conn.prepare(
            "SELECT c.id, c.title, c.summary, c.limbo_summary, c.processed, c.is_disco, c.created_at, c.updated_at,
                    (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) as msg_count
             FROM conversations c
             WHERE c.processed = 0 
               AND c.updated_at < ?1
             ORDER BY c.updated_at DESC"
        )?;
        
        let convs = stmt.query_map([cutoff], |row| {
            let msg_count: i64 = row.get(8)?;
            // Only include if has at least 2 messages (user + agent)
            if msg_count >= 2 {
                Ok(Some(Conversation {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    summary: row.get(2)?,
                    limbo_summary: row.get(3)?,
                    processed: row.get::<_, i64>(4)? != 0,
                    is_disco: row.get::<_, i64>(5).unwrap_or(0) != 0,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                }))
            } else {
                Ok(None)
            }
        })?;
        
        // Filter out None values
        convs.filter_map(|r| r.transpose()).collect()
    })
}

/// Append to the limbo summary (incremental summary built during conversation)
pub fn append_limbo_summary(conversation_id: &str, new_content: &str) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    with_connection(|conn| {
        // Get existing limbo summary
        let existing: Option<String> = conn.query_row(
            "SELECT limbo_summary FROM conversations WHERE id = ?1",
            params![conversation_id],
            |row| row.get(0)
        ).ok();
        
        // Append new content
        let updated = match existing {
            Some(existing_text) => format!("{}\n\n{}", existing_text, new_content),
            None => new_content.to_string(),
        };
        
        conn.execute(
            "UPDATE conversations SET limbo_summary = ?1, updated_at = ?2 WHERE id = ?3",
            params![updated, now, conversation_id]
        )?;
        Ok(())
    })
}

/// Mark a conversation as fully processed (after finalization)
pub fn mark_conversation_processed(conversation_id: &str, final_summary: Option<&str>) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    with_connection(|conn| {
        if let Some(summary) = final_summary {
            conn.execute(
                "UPDATE conversations SET processed = 1, summary = ?1, updated_at = ?2 WHERE id = ?3",
                params![summary, now, conversation_id]
            )?;
        } else {
            conn.execute(
                "UPDATE conversations SET processed = 1, updated_at = ?1 WHERE id = ?2",
                params![now, conversation_id]
            )?;
        }
        Ok(())
    })
}

// ============ Messages ============

pub fn save_message(message: &Message) -> Result<()> {
    with_connection(|conn| {
        conn.execute(
            "INSERT OR REPLACE INTO messages (id, conversation_id, role, content, response_type, references_message_id, timestamp)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                message.id,
                message.conversation_id,
                message.role,
                message.content,
                message.response_type,
                message.references_message_id,
                message.timestamp
            ]
        )?;
        
        // Update conversation timestamp
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE conversations SET updated_at = ?1 WHERE id = ?2",
            params![now, message.conversation_id]
        )?;
        
        Ok(())
    })
}

pub fn get_conversation_messages(conversation_id: &str) -> Result<Vec<Message>> {
    with_connection(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, role, content, response_type, references_message_id, timestamp 
             FROM messages 
             WHERE conversation_id = ?1 
             ORDER BY timestamp ASC"
        )?;
        
        let messages = stmt.query_map([conversation_id], |row| {
            Ok(Message {
                id: row.get(0)?,
                conversation_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                response_type: row.get(4)?,
                references_message_id: row.get(5)?,
                timestamp: row.get(6)?,
            })
        })?;
        
        messages.collect()
    })
}

pub fn get_recent_messages(conversation_id: &str, limit: usize) -> Result<Vec<Message>> {
    with_connection(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, role, content, response_type, references_message_id, timestamp 
             FROM messages 
             WHERE conversation_id = ?1 
             ORDER BY timestamp DESC 
             LIMIT ?2"
        )?;
        
        let messages = stmt.query_map(params![conversation_id, limit], |row| {
            Ok(Message {
                id: row.get(0)?,
                conversation_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                response_type: row.get(4)?,
                references_message_id: row.get(5)?,
                timestamp: row.get(6)?,
            })
        })?;
        
        let mut result: Vec<Message> = messages.collect::<Result<Vec<_>>>()?;
        result.reverse();
        Ok(result)
    })
}

pub fn clear_conversation_messages(conversation_id: &str) -> Result<()> {
    with_connection(|conn| {
        conn.execute("DELETE FROM messages WHERE conversation_id = ?1", params![conversation_id])?;
        Ok(())
    })
}

pub fn delete_conversation(conversation_id: &str) -> Result<()> {
    with_connection(|conn| {
        // Delete related data first (foreign key constraints)
        conn.execute("DELETE FROM messages WHERE conversation_id = ?1", params![conversation_id])?;
        conn.execute("DELETE FROM conversation_summaries WHERE conversation_id = ?1", params![conversation_id])?;
        // Delete user_facts that reference this conversation
        conn.execute("DELETE FROM user_facts WHERE source_conversation_id = ?1", params![conversation_id])?;
        // Delete the conversation itself
        conn.execute("DELETE FROM conversations WHERE id = ?1", params![conversation_id])?;
        Ok(())
    })
}

// ============ User Context ============

pub fn get_all_user_context() -> Result<Vec<UserContext>> {
    with_connection(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, key, value, confidence, source_agent, updated_at FROM user_context ORDER BY confidence DESC"
        )?;
        
        let contexts = stmt.query_map([], |row| {
            Ok(UserContext {
                id: row.get(0)?,
                key: row.get(1)?,
                value: row.get(2)?,
                confidence: row.get(3)?,
                source_agent: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })?;
        
        contexts.collect()
    })
}

pub fn clear_user_context() -> Result<()> {
    with_connection(|conn| {
        conn.execute("DELETE FROM user_context", [])?;
        Ok(())
    })
}

// ============ User Facts ============

pub fn save_user_fact(fact: &UserFact) -> Result<()> {
    with_connection(|conn| {
        conn.execute(
            "INSERT INTO user_facts (category, key, value, confidence, source_type, source_conversation_id, first_mentioned, last_confirmed, mention_count)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(category, key) DO UPDATE SET
                value = ?3,
                confidence = MAX(confidence, ?4),
                last_confirmed = ?8,
                mention_count = mention_count + 1",
            params![
                fact.category,
                fact.key,
                fact.value,
                fact.confidence,
                fact.source_type,
                fact.source_conversation_id,
                fact.first_mentioned,
                fact.last_confirmed,
                fact.mention_count
            ]
        )?;
        Ok(())
    })
}

pub fn get_all_user_facts() -> Result<Vec<UserFact>> {
    with_connection(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, category, key, value, confidence, source_type, source_conversation_id, first_mentioned, last_confirmed, mention_count
             FROM user_facts ORDER BY confidence DESC, mention_count DESC"
        )?;
        
        let facts = stmt.query_map([], |row| {
            Ok(UserFact {
                id: row.get(0)?,
                category: row.get(1)?,
                key: row.get(2)?,
                value: row.get(3)?,
                confidence: row.get(4)?,
                source_type: row.get(5)?,
                source_conversation_id: row.get(6)?,
                first_mentioned: row.get(7)?,
                last_confirmed: row.get(8)?,
                mention_count: row.get(9)?,
            })
        })?;
        
        facts.collect()
    })
}

// ============ User Patterns ============

pub fn save_user_pattern(pattern: &UserPattern) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    with_connection(|conn| {
        // Check if pattern with same type and similar description exists
        let existing: Option<i64> = conn.query_row(
            "SELECT id FROM user_patterns WHERE pattern_type = ?1 AND description = ?2",
            params![pattern.pattern_type, pattern.description],
            |row| row.get(0)
        ).ok();
        
        if let Some(id) = existing {
            // Update existing pattern
            conn.execute(
                "UPDATE user_patterns SET confidence = MIN(1.0, confidence + 0.1), observation_count = observation_count + 1, last_updated = ?1, evidence = ?2 WHERE id = ?3",
                params![now, pattern.evidence, id]
            )?;
        } else {
            // Insert new pattern
            conn.execute(
                "INSERT INTO user_patterns (pattern_type, description, confidence, evidence, first_observed, last_updated, observation_count)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    pattern.pattern_type,
                    pattern.description,
                    pattern.confidence,
                    pattern.evidence,
                    pattern.first_observed,
                    pattern.last_updated,
                    pattern.observation_count
                ]
            )?;
        }
        Ok(())
    })
}

pub fn get_all_user_patterns() -> Result<Vec<UserPattern>> {
    with_connection(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, pattern_type, description, confidence, evidence, first_observed, last_updated, observation_count
             FROM user_patterns ORDER BY confidence DESC, observation_count DESC"
        )?;
        
        let patterns = stmt.query_map([], |row| {
            Ok(UserPattern {
                id: row.get(0)?,
                pattern_type: row.get(1)?,
                description: row.get(2)?,
                confidence: row.get(3)?,
                evidence: row.get(4)?,
                first_observed: row.get(5)?,
                last_updated: row.get(6)?,
                observation_count: row.get(7)?,
            })
        })?;
        
        patterns.collect()
    })
}

// ============ Conversation Summaries ============

pub fn save_conversation_summary(summary: &ConversationSummary) -> Result<()> {
    with_connection(|conn| {
        // Replace existing summary for this conversation
        conn.execute(
            "INSERT OR REPLACE INTO conversation_summaries 
             (conversation_id, summary, key_topics, emotional_tone, user_state, agents_involved, message_count, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                summary.conversation_id,
                summary.summary,
                summary.key_topics,
                summary.emotional_tone,
                summary.user_state,
                summary.agents_involved,
                summary.message_count,
                summary.created_at
            ]
        )?;
        Ok(())
    })
}

pub fn get_conversation_summary(conversation_id: &str) -> Result<Option<ConversationSummary>> {
    with_connection(|conn| {
        let result = conn.query_row(
            "SELECT id, conversation_id, summary, key_topics, emotional_tone, user_state, agents_involved, message_count, created_at
             FROM conversation_summaries WHERE conversation_id = ?1",
            params![conversation_id],
            |row| {
                Ok(ConversationSummary {
                    id: row.get(0)?,
                    conversation_id: row.get(1)?,
                    summary: row.get(2)?,
                    key_topics: row.get(3)?,
                    emotional_tone: row.get(4)?,
                    user_state: row.get(5)?,
                    agents_involved: row.get(6)?,
                    message_count: row.get(7)?,
                    created_at: row.get(8)?,
                })
            }
        );
        match result {
            Ok(s) => Ok(Some(s)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    })
}

// ============ Recurring Themes ============

pub fn save_recurring_theme(theme: &str, conversation_id: &str) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    with_connection(|conn| {
        // Try to get existing theme
        let existing: Option<(i64, String)> = conn.query_row(
            "SELECT id, related_conversations FROM recurring_themes WHERE theme = ?1",
            params![theme],
            |row| Ok((row.get(0)?, row.get::<_, Option<String>>(1)?.unwrap_or_default()))
        ).ok();
        
        if let Some((id, existing_convs)) = existing {
            // Update existing theme
            let mut convs: Vec<String> = if existing_convs.is_empty() {
                Vec::new()
            } else {
                serde_json::from_str(&existing_convs).unwrap_or_default()
            };
            if !convs.contains(&conversation_id.to_string()) {
                convs.push(conversation_id.to_string());
            }
            let convs_json = serde_json::to_string(&convs).unwrap_or_default();
            
            conn.execute(
                "UPDATE recurring_themes SET frequency = frequency + 1, last_mentioned = ?1, related_conversations = ?2 WHERE id = ?3",
                params![now, convs_json, id]
            )?;
        } else {
            // Insert new theme
            let convs_json = serde_json::to_string(&vec![conversation_id]).unwrap_or_default();
            conn.execute(
                "INSERT INTO recurring_themes (theme, frequency, last_mentioned, related_conversations) VALUES (?1, 1, ?2, ?3)",
                params![theme, now, convs_json]
            )?;
        }
        Ok(())
    })
}

pub fn get_all_recurring_themes() -> Result<Vec<RecurringTheme>> {
    with_connection(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, theme, frequency, last_mentioned, related_conversations
             FROM recurring_themes ORDER BY frequency DESC"
        )?;
        
        let themes = stmt.query_map([], |row| {
            Ok(RecurringTheme {
                id: row.get(0)?,
                theme: row.get(1)?,
                frequency: row.get(2)?,
                last_mentioned: row.get(3)?,
                related_conversations: row.get(4)?,
            })
        })?;
        
        themes.collect()
    })
}

pub fn get_top_themes(limit: usize) -> Result<Vec<RecurringTheme>> {
    with_connection(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, theme, frequency, last_mentioned, related_conversations
             FROM recurring_themes ORDER BY frequency DESC LIMIT ?1"
        )?;
        
        let themes = stmt.query_map([limit], |row| {
            Ok(RecurringTheme {
                id: row.get(0)?,
                theme: row.get(1)?,
                frequency: row.get(2)?,
                last_mentioned: row.get(3)?,
                related_conversations: row.get(4)?,
            })
        })?;
        
        themes.collect()
    })
}

// ============ Reset ============

pub fn reset_all_data() -> Result<()> {
    let now = Utc::now().to_rfc3339();
    with_connection(|conn| {
        // Clear all conversation and memory data
        conn.execute("DELETE FROM messages", [])?;
        conn.execute("DELETE FROM conversations", [])?;
        conn.execute("DELETE FROM user_context", [])?;
        conn.execute("DELETE FROM user_facts", [])?;
        conn.execute("DELETE FROM user_patterns", [])?;
        conn.execute("DELETE FROM conversation_summaries", [])?;
        conn.execute("DELETE FROM recurring_themes", [])?;
        
        // Delete all persona profiles (will be recreated on next init)
        conn.execute("DELETE FROM persona_profiles", [])?;
        
        // Reset user_profile weights and message count, but KEEP API keys
        conn.execute(
            "UPDATE user_profile SET instinct_weight = 0.20, logic_weight = 0.50, psyche_weight = 0.30, total_messages = 0, updated_at = ?1",
            params![now]
        )?;
        
        // Recreate the 3 fixed persona profiles with default names and weights
        // Format: (name, dominant_trait, instinct_weight, logic_weight, psyche_weight, is_default, is_active)
        let profiles = [
            ("Logic", "logic", 0.30, 0.40, 0.30, true, true),         // Logic dominant (40%), default and active
            ("Instinct", "instinct", 0.40, 0.30, 0.30, false, false), // Instinct dominant (40%)
            ("Psyche", "psyche", 0.30, 0.30, 0.40, false, false),     // Psyche dominant (40%)
        ];
        
        for (name, dominant, instinct_w, logic_w, psyche_w, is_default, is_active) in profiles {
            let id = uuid::Uuid::new_v4().to_string();
        // Default points: 4, 4, 3 (total 11) - will be adjusted by user
        conn.execute(
            "INSERT INTO persona_profiles (id, name, is_default, is_active, dominant_trait, instinct_weight, logic_weight, psyche_weight, instinct_points, logic_points, psyche_points, message_count, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 4, 4, 3, 0, ?9, ?9)",
                params![id, name, is_default, is_active, dominant, instinct_w, logic_w, psyche_w, now]
            )?;
        }
        
        Ok(())
    })
}

// ============ Persona Profiles (Multi-Profile System) ============

pub fn create_persona_profile(
    name: &str,
    dominant_trait: &str,
    secondary_trait: &str,
    is_default: bool,
) -> Result<PersonaProfile> {
    let now = Utc::now().to_rfc3339();
    let id = uuid::Uuid::new_v4().to_string();
    
    // Calculate weights based on trait selection: dominant 50%, secondary 30%, third 20%
    let (instinct_weight, logic_weight, psyche_weight) = calculate_trait_weights(dominant_trait, secondary_trait);
    
    with_connection(|conn| {
        // If this is the first profile or marked as default, ensure only one is default
        if is_default {
            conn.execute("UPDATE persona_profiles SET is_default = 0", [])?;
        }
        
        // Check if this is the first profile (make it active)
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM persona_profiles", [], |row| row.get(0))?;
        let is_active = count == 0; // First profile is automatically active
        
        // Default points: 4, 4, 3 (total 11) - will be adjusted by user
        conn.execute(
            "INSERT INTO persona_profiles (id, name, is_default, is_active, dominant_trait, secondary_trait, instinct_weight, logic_weight, psyche_weight, instinct_points, logic_points, psyche_points, message_count, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 4, 4, 3, 0, ?10, ?11)",
            params![id, name, is_default || is_active, is_active, dominant_trait, secondary_trait, instinct_weight, logic_weight, psyche_weight, now, now]
        )?;
        
        Ok(PersonaProfile {
            id,
            name: name.to_string(),
            is_default: is_default || is_active,
            is_active,
            dominant_trait: dominant_trait.to_string(),
            secondary_trait: secondary_trait.to_string(),
            instinct_weight,
            logic_weight,
            psyche_weight,
            instinct_points: 4,
            logic_points: 4,
            psyche_points: 3,
            message_count: 0,
            created_at: now.clone(),
            updated_at: now,
        })
    })
}

fn calculate_trait_weights(dominant: &str, secondary: &str) -> (f64, f64, f64) {
    // dominant = 50%, secondary = 30%, third = 20%
    let mut instinct = 0.2;
    let mut logic = 0.2;
    let mut psyche = 0.2;
    
    match dominant {
        "instinct" => instinct = 0.5,
        "logic" => logic = 0.5,
        "psyche" => psyche = 0.5,
        _ => {}
    }
    
    match secondary {
        "instinct" => instinct = 0.3,
        "logic" => logic = 0.3,
        "psyche" => psyche = 0.3,
        _ => {}
    }
    
    (instinct, logic, psyche)
}

pub fn get_all_persona_profiles() -> Result<Vec<PersonaProfile>> {
    with_connection(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, is_default, is_active, dominant_trait, secondary_trait, instinct_weight, logic_weight, psyche_weight, instinct_points, logic_points, psyche_points, message_count, created_at, updated_at
             FROM persona_profiles ORDER BY is_default DESC, message_count DESC"
        )?;
        
        let profiles = stmt.query_map([], |row| {
            Ok(PersonaProfile {
                id: row.get(0)?,
                name: row.get(1)?,
                is_default: row.get::<_, i64>(2)? != 0,
                is_active: row.get::<_, i64>(3)? != 0,
                dominant_trait: row.get(4)?,
                secondary_trait: row.get(5)?,
                instinct_weight: row.get(6)?,
                logic_weight: row.get(7)?,
                psyche_weight: row.get(8)?,
                instinct_points: row.get(9)?,
                logic_points: row.get(10)?,
                psyche_points: row.get(11)?,
                message_count: row.get(12)?,
                created_at: row.get(13)?,
                updated_at: row.get(14)?,
            })
        })?;
        
        profiles.collect()
    })
}

pub fn get_active_persona_profile() -> Result<Option<PersonaProfile>> {
    with_connection(|conn| {
        conn.query_row(
            "SELECT id, name, is_default, is_active, dominant_trait, secondary_trait, instinct_weight, logic_weight, psyche_weight, instinct_points, logic_points, psyche_points, message_count, created_at, updated_at
             FROM persona_profiles WHERE is_active = 1",
            [],
            |row| Ok(PersonaProfile {
                id: row.get(0)?,
                name: row.get(1)?,
                is_default: row.get::<_, i64>(2)? != 0,
                is_active: row.get::<_, i64>(3)? != 0,
                dominant_trait: row.get(4)?,
                secondary_trait: row.get(5)?,
                instinct_weight: row.get(6)?,
                logic_weight: row.get(7)?,
                psyche_weight: row.get(8)?,
                instinct_points: row.get(9)?,
                logic_points: row.get(10)?,
                psyche_points: row.get(11)?,
                message_count: row.get(12)?,
                created_at: row.get(13)?,
                updated_at: row.get(14)?,
            })
        ).optional()
    })
}

pub fn get_persona_profile_count() -> Result<i64> {
    with_connection(|conn| {
        conn.query_row("SELECT COUNT(*) FROM persona_profiles", [], |row| row.get(0))
    })
}

pub fn set_active_persona_profile(profile_id: &str) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    with_connection(|conn| {
        // Deactivate all profiles
        conn.execute("UPDATE persona_profiles SET is_active = 0", [])?;
        // Activate the selected profile
        conn.execute(
            "UPDATE persona_profiles SET is_active = 1, updated_at = ?1 WHERE id = ?2",
            params![now, profile_id]
        )?;
        Ok(())
    })
}

pub fn set_default_persona_profile(profile_id: &str) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    with_connection(|conn| {
        // Remove default from all profiles
        conn.execute("UPDATE persona_profiles SET is_default = 0", [])?;
        // Set the selected profile as default
        conn.execute(
            "UPDATE persona_profiles SET is_default = 1, updated_at = ?1 WHERE id = ?2",
            params![now, profile_id]
        )?;
        Ok(())
    })
}

pub fn update_persona_profile_name(profile_id: &str, new_name: &str) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    with_connection(|conn| {
        conn.execute(
            "UPDATE persona_profiles SET name = ?1, updated_at = ?2 WHERE id = ?3",
            params![new_name, now, profile_id]
        )?;
        Ok(())
    })
}

/// Update the dominant trait for the active persona profile
pub fn update_dominant_trait(dominant_trait: &str) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    
    // Derive secondary trait from dominant
    let secondary = match dominant_trait {
        "logic" => "instinct",
        "instinct" => "psyche",
        "psyche" => "logic",
        _ => "logic",
    };
    
    with_connection(|conn| {
        conn.execute(
            "UPDATE persona_profiles SET dominant_trait = ?1, secondary_trait = ?2, updated_at = ?3 WHERE is_active = 1",
            params![dominant_trait, secondary, now]
        )?;
        Ok(())
    })
}

pub fn delete_persona_profile(profile_id: &str) -> Result<()> {
    with_connection(|conn| {
        // Don't allow deleting the last profile
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM persona_profiles", [], |row| row.get(0))?;
        if count <= 1 {
            return Err(rusqlite::Error::QueryReturnedNoRows); // Using this as a simple error
        }
        
        // Check if this is the active profile
        let is_active: bool = conn.query_row(
            "SELECT is_active FROM persona_profiles WHERE id = ?1",
            params![profile_id],
            |row| Ok(row.get::<_, i64>(0)? != 0)
        ).unwrap_or(false);
        
        // Delete the profile
        conn.execute("DELETE FROM persona_profiles WHERE id = ?1", params![profile_id])?;
        
        // If we deleted the active profile, activate the default or first remaining
        if is_active {
            // Try to activate the default profile
            let activated = conn.execute(
                "UPDATE persona_profiles SET is_active = 1 WHERE is_default = 1",
                []
            )?;
            
            // If no default, activate the first one
            if activated == 0 {
                conn.execute(
                    "UPDATE persona_profiles SET is_active = 1 WHERE id = (SELECT id FROM persona_profiles ORDER BY created_at ASC LIMIT 1)",
                    []
                )?;
            }
        }
        
        Ok(())
    })
}


