//! Structured logging module for Intersect
//! 
//! Writes logs to ~/Library/Logs/Intersect/ with categories:
//! - MEMORY: Knowledge base changes
//! - ROUTING: Governor turn-taking decisions
//! - AGENT: Agent response generation
//! - CONVERSATION: Session lifecycle
//! - ERROR: Errors and crashes

use chrono::{Local, Utc};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use once_cell::sync::Lazy;

/// Log categories for structured logging
#[derive(Debug, Clone, Copy)]
pub enum LogCategory {
    Memory,       // Knowledge base changes (facts, patterns, themes)
    Routing,      // Governor turn-taking decisions
    Agent,        // Agent response generation
    Conversation, // Session lifecycle (start, finalize, archive)
    Error,        // Errors and crashes
}

impl LogCategory {
    fn as_str(&self) -> &'static str {
        match self {
            LogCategory::Memory => "MEMORY",
            LogCategory::Routing => "ROUTING",
            LogCategory::Agent => "AGENT",
            LogCategory::Conversation => "CONVERSATION",
            LogCategory::Error => "ERROR",
        }
    }
}

/// Global log file handle
static LOG_FILE: Lazy<Mutex<Option<PathBuf>>> = Lazy::new(|| Mutex::new(None));

/// Get the log directory path
fn get_log_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home).join("Library/Logs/Intersect")
}

/// Get today's log file path
fn get_log_file_path() -> PathBuf {
    let today = Local::now().format("%Y-%m-%d").to_string();
    get_log_dir().join(format!("intersect-{}.log", today))
}

/// Initialize the logging system - creates log directory if needed
pub fn init_logging() -> Result<(), Box<dyn std::error::Error>> {
    let log_dir = get_log_dir();
    
    // Create log directory if it doesn't exist
    if !log_dir.exists() {
        fs::create_dir_all(&log_dir)?;
    }
    
    // Store the current log file path
    let log_path = get_log_file_path();
    *LOG_FILE.lock().unwrap() = Some(log_path.clone());
    
    // Log startup
    log(LogCategory::Conversation, None, "Intersect logging initialized");
    
    Ok(())
}

/// Log a message with category and optional conversation context
pub fn log(category: LogCategory, conversation_id: Option<&str>, message: &str) {
    let timestamp = Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let conv_context = conversation_id
        .map(|id| format!("conversation={} | ", &id[..8.min(id.len())]))
        .unwrap_or_default();
    
    let log_line = format!(
        "[{}] [{}] {}{}\n",
        timestamp,
        category.as_str(),
        conv_context,
        message
    );
    
    // Always print to console (for dev)
    print!("{}", log_line);
    
    // Write to file
    let log_path = get_log_file_path();
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        let _ = file.write_all(log_line.as_bytes());
    }
}

/// Log a memory event (fact learned, pattern detected, theme added)
pub fn log_memory(conversation_id: Option<&str>, message: &str) {
    log(LogCategory::Memory, conversation_id, message);
}

/// Log a routing decision (which agent, why, weights)
pub fn log_routing(conversation_id: Option<&str>, message: &str) {
    log(LogCategory::Routing, conversation_id, message);
}

/// Log an agent response event
pub fn log_agent(conversation_id: Option<&str>, message: &str) {
    log(LogCategory::Agent, conversation_id, message);
}

/// Log a conversation lifecycle event
pub fn log_conversation(conversation_id: Option<&str>, message: &str) {
    log(LogCategory::Conversation, conversation_id, message);
}

/// Log an error
pub fn log_error(conversation_id: Option<&str>, message: &str) {
    log(LogCategory::Error, conversation_id, message);
}

/// Clean up old log files (keep last 7 days)
pub fn cleanup_old_logs() -> Result<usize, Box<dyn std::error::Error>> {
    let log_dir = get_log_dir();
    let mut deleted = 0;
    
    if !log_dir.exists() {
        return Ok(0);
    }
    
    let cutoff = Utc::now() - chrono::Duration::days(7);
    
    for entry in fs::read_dir(&log_dir)? {
        let entry = entry?;
        let path = entry.path();
        
        if let Ok(metadata) = entry.metadata() {
            if let Ok(modified) = metadata.modified() {
                let modified_time: chrono::DateTime<Utc> = modified.into();
                if modified_time < cutoff {
                    if fs::remove_file(&path).is_ok() {
                        deleted += 1;
                    }
                }
            }
        }
    }
    
    Ok(deleted)
}






