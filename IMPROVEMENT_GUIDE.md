# Intersect Improvement Guide

A comprehensive guide to potential improvements based on thorough codebase analysis.

---

## Table of Contents

1. [Critical Fixes](#1-critical-fixes)
2. [Points System Enhancement](#2-points-system-enhancement)
3. [Dominant Trait Bias Scaling](#3-dominant-trait-bias-scaling)
4. [Cold Start Problem](#4-cold-start-problem)
5. [Weight Evolution Race Condition](#5-weight-evolution-race-condition)
6. [Governor Role Clarification](#6-governor-role-clarification)
7. [Agent Personality Evolution](#7-agent-personality-evolution)
8. [Disco Mode Enhancements](#8-disco-mode-enhancements)

---

## 1. CRITICAL FIXES

### 1.1 Knowledge Base Version Mismatch

**File**: `src-tauri/src/knowledge.rs:15`

**Current**:
```rust
Created by Briggs Kellogg. Version 0.9.1.
```

**Should Be**:
```rust
Created by Briggs Kellogg. Version 1.2.0.
```

### 1.2 Knowledge Base Governor Description Outdated

The knowledge base says the Governor "is NOT a conversational agent" and "works behind the scenes," but since v1.2.0, the Governor now synthesizes responses in BOTH Text and Game modes.

**File**: `src-tauri/src/knowledge.rs:68-76`

**Current**:
```
The Governor is the orchestration layer powered by Anthropic Claude. It is NOT a conversational agent — it works behind the scenes to:
- Decide which agent should respond first
- Determine if a second agent should add context, agree, or challenge
- Trigger debate mode when perspectives genuinely conflict
- Manage the knowledge base and memory system
- Prevent cognitive overload by limiting responses

The Governor appears in the UI as a system entity with a slate gray color. It provides notifications when significant changes occur (like dominant trait shifts).
```

**Should Be**:
```
The Governor is the orchestration layer powered by Anthropic Claude. It serves two roles:

1. **Orchestrator (behind the scenes)**:
   - Decides which agent should respond first
   - Determines if a second agent should add context
   - Triggers debate mode when perspectives conflict
   - Manages the knowledge base and memory system

2. **Synthesizer (visible to user)**:
   - After agents respond, the Governor reads their thoughts
   - Synthesizes a unified response that draws on all perspectives
   - Speaks as ONE voice — never reveals the internal processing
   - Adapts communication style based on user's dominant trait

The Governor appears in the UI with a slate gray color. In Text Mode, it synthesizes helpful guidance. In Game Mode, it synthesizes challenging provocation.

IMPORTANT: The Governor sees agent thoughts but NEVER acknowledges they exist. If asked about "voices" or "agents," it deflects gracefully.
```

---

## 2. POINTS SYSTEM ENHANCEMENT

### Current Implementation

**File**: `src-tauri/src/orchestrator.rs:226-237`

```rust
// Current: Linear +0.03 per point
if let Some((instinct_p, logic_p, psyche_p)) = points {
    *scores.entry("instinct").or_insert(0.0) += instinct_p as f64 * 0.03;
    *scores.entry("logic").or_insert(0.0) += logic_p as f64 * 0.03;
    *scores.entry("psyche").or_insert(0.0) += psyche_p as f64 * 0.03;
}
```

**Problem**: Linear scaling (+0.03 per point) creates minimal differentiation.

| Points | Current Boost | Difference (6 vs 2) |
|--------|---------------|---------------------|
| 2      | +0.06         | +0.12               |
| 4      | +0.12         |                     |
| 6      | +0.18         |                     |

A 0.12 difference is often smaller than keyword boosts (+0.15 each).

### Proposed: Exponential Scaling

**Replace with**:
```rust
// ===== POINTS BIAS: Exponential scaling for meaningful differentiation =====
if let Some((instinct_p, logic_p, psyche_p)) = points {
    // Exponential: 2^(points-4) * 0.05
    // 2 points = 0.0125, 4 points = 0.05, 6 points = 0.20
    let calc_boost = |p: i64| -> f64 {
        let exponent = (p - 4) as f64;
        2.0_f64.powf(exponent) * 0.05
    };

    *scores.entry("instinct").or_insert(0.0) += calc_boost(instinct_p);
    *scores.entry("logic").or_insert(0.0) += calc_boost(logic_p);
    *scores.entry("psyche").or_insert(0.0) += calc_boost(psyche_p);

    logging::log_routing(None, &format!(
        "[HEURISTIC] Points bias (exponential): I={} (+{:.3}) L={} (+{:.3}) P={} (+{:.3})",
        instinct_p, calc_boost(instinct_p),
        logic_p, calc_boost(logic_p),
        psyche_p, calc_boost(psyche_p)
    ));
}
```

**New Impact**:

| Points | New Boost | Difference (6 vs 2) |
|--------|-----------|---------------------|
| 2      | +0.0125   | +0.1875             |
| 4      | +0.05     |                     |
| 6      | +0.20     |                     |

Now 6 points is **16x** more impactful than 2 points, making user allocation meaningful.

---

## 3. DOMINANT TRAIT BIAS SCALING

### Current Implementation

**File**: `src-tauri/src/orchestrator.rs:239-250`

```rust
// Current: Flat +0.10 in Normal Mode only
if !is_disco {
    if let Some(dominant) = dominant_trait {
        if let Some(score) = scores.get_mut(dominant) {
            *score += 0.10;
        }
    }
}
```

**Problem**:
- Flat +0.10 regardless of how dominant the trait actually is
- A 55% dominant gets same boost as a 60% dominant
- No bias in Disco Mode (intentional, but could be inverted)

### Proposed: Scaled Bias Based on Dominance

**Replace with**:
```rust
// ===== DOMINANT TRAIT BIAS: Scale based on how dominant they actually are =====
if let Some(dominant) = dominant_trait {
    let dominant_weight = match dominant {
        "instinct" => instinct_w,
        "logic" => logic_w,
        "psyche" => psyche_w,
        _ => 0.33,
    };

    // Calculate dominance margin (how much higher than average 0.33)
    // 0.33 = no dominance, 0.60 = strong dominance
    let dominance_margin = (dominant_weight - 0.33).max(0.0);

    if is_disco {
        // DISCO: Invert the bias — suppress the dominant, amplify the suppressed
        // Dominant trait gets PENALIZED proportionally
        if let Some(score) = scores.get_mut(dominant) {
            *score -= dominance_margin * 0.3;
        }
        logging::log_routing(None, &format!(
            "[HEURISTIC] DISCO: Suppressing dominant {} by -{:.3}",
            dominant, dominance_margin * 0.3
        ));
    } else {
        // NORMAL: Boost proportional to how dominant they are
        // Range: +0.05 (barely dominant) to +0.15 (strongly dominant)
        let bias = 0.05 + (dominance_margin * 0.4);
        if let Some(score) = scores.get_mut(dominant) {
            *score += bias;
        }
        logging::log_routing(None, &format!(
            "[HEURISTIC] Dominant trait bias: +{:.3} to {} (margin: {:.3})",
            bias, dominant, dominance_margin
        ));
    }
}
```

**New Impact**:

| Dominant Weight | Normal Mode Bias | Disco Mode Penalty |
|-----------------|------------------|-------------------|
| 35% (barely)    | +0.058           | -0.006            |
| 45% (moderate)  | +0.098           | -0.036            |
| 55% (strong)    | +0.138           | -0.066            |
| 60% (max)       | +0.158           | -0.081            |

This makes dominance meaningful AND makes Disco actively counteract it.

---

## 4. COLD START PROBLEM

### Current Behavior

New users with 0 messages get:
- Default weights: 50% Logic, 30% Psyche, 20% Instinct
- No personalization until patterns emerge
- Generic agent responses

### Proposed: Onboarding Primer

**Add new function to `src-tauri/src/orchestrator.rs`**:

```rust
/// Generate a cold-start question to quickly calibrate user preferences
pub fn get_cold_start_question(message_count: i64) -> Option<String> {
    if message_count >= 5 {
        return None; // Already have enough data
    }

    // Rotate through calibration questions based on count
    let questions = [
        // Message 0: Thinking style
        "Quick sidebar — when you're making a decision, do you usually go with your gut, think it through systematically, or reflect on how it feels?",
        // Message 1: Communication preference
        "Do you prefer advice that's direct and action-oriented, or more exploratory and open-ended?",
        // Message 2: Challenge tolerance
        "When someone disagrees with you, do you find it energizing or draining?",
    ];

    let idx = message_count as usize;
    if idx < questions.len() {
        Some(questions[idx].to_string())
    } else {
        None
    }
}

/// Parse cold-start response to adjust initial weights
pub fn parse_cold_start_response(
    response: &str,
    question_index: usize,
    current_weights: (f64, f64, f64),
) -> (f64, f64, f64) {
    let lower = response.to_lowercase();
    let (mut i, mut l, mut p) = current_weights;

    match question_index {
        0 => {
            // Thinking style question
            if lower.contains("gut") || lower.contains("instinct") || lower.contains("quick") {
                i += 0.15;
            } else if lower.contains("think") || lower.contains("systematic") || lower.contains("logic") {
                l += 0.15;
            } else if lower.contains("feel") || lower.contains("reflect") || lower.contains("emotion") {
                p += 0.15;
            }
        }
        1 => {
            // Communication preference
            if lower.contains("direct") || lower.contains("action") {
                i += 0.10;
            } else if lower.contains("exploratory") || lower.contains("open") {
                p += 0.10;
            }
        }
        2 => {
            // Challenge tolerance — affects disco likelihood
            // Store this as a user preference rather than weight adjustment
        }
        _ => {}
    }

    // Normalize
    let total = i + l + p;
    (i / total, l / total, p / total)
}
```

**Integration in `lib.rs:822-830`** (before routing):

```rust
// Cold start: Inject calibration question for new users
let message_count = profile.total_messages;
if message_count < 5 {
    if let Some(calibration_q) = get_cold_start_question(message_count) {
        // Append to Governor's response later
        // Or inject as system context
    }
}
```

---

## 5. WEIGHT EVOLUTION RACE CONDITION

### Current Implementation

Two paths update weights:

1. **Immediate** (`lib.rs:1039, 1158, 1247`):
   ```rust
   boost_session_weight(&conversation_id, primary_agent, 0.02);
   ```

2. **Background** (`lib.rs:1338-1403`):
   ```rust
   tokio::spawn(async move {
       // ... analyze engagement + intrinsic traits
       let new_weights = combine_trait_analyses(...);
       db::update_weights(new_weights.0, new_weights.1, new_weights.2)?;
   });
   ```

**Problem**: Immediate updates session weights (in-memory), background updates base weights (database). These are separate, so no race. BUT: if two background tasks run concurrently from rapid messages, they could read stale weights.

### Proposed: Atomic Weight Updates

**Add to `src-tauri/src/db.rs`**:

```rust
use std::sync::Mutex;
use once_cell::sync::Lazy;

// Global lock for weight updates
static WEIGHT_UPDATE_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

/// Atomically update weights with a transformation function
pub fn update_weights_atomic<F>(transform: F) -> Result<(f64, f64, f64), rusqlite::Error>
where
    F: FnOnce((f64, f64, f64)) -> (f64, f64, f64),
{
    let _lock = WEIGHT_UPDATE_LOCK.lock().unwrap();

    // Read current
    let profile = get_user_profile()?;
    let current = (profile.instinct_weight, profile.logic_weight, profile.psyche_weight);

    // Transform
    let new = transform(current);

    // Write
    update_weights(new.0, new.1, new.2)?;

    Ok(new)
}
```

**Update background analysis in `lib.rs:1378-1401`**:

```rust
// OLD:
if let Ok(current_profile) = db::get_user_profile() {
    let current_weights = (...);
    let new_weights = combine_trait_analyses(...);
    db::update_weights(new_weights.0, new_weights.1, new_weights.2)?;
}

// NEW:
if let Err(e) = db::update_weights_atomic(|current_weights| {
    combine_trait_analyses(
        current_weights,
        engagement_analysis.as_ref(),
        intrinsic_analysis.as_ref(),
        has_any_disco_for_traits,
        total_messages_for_traits,
    )
}) {
    logging::log_error(Some(&conversation_id_for_traits), &format!(
        "[BACKGROUND] Atomic weight update failed: {}", e
    ));
}
```

---

## 6. GOVERNOR ROLE CLARIFICATION

### Current Ambiguity

The Governor:
- **Text Mode**: Generates synthesis after agents respond (`lib.rs:1271-1315`)
- **Game Mode**: Generates synthesis after dynamic thoughts (`lib.rs:937-964`)

Both modes now show Governor responses, but the UI and documentation suggest different behaviors.

### Proposed: Explicit Mode Differentiation in Governor Prompt

**Update `lib.rs:670-676`**:

```rust
// Current:
let mode_tone = if is_disco {
    "You are in a CHALLENGING mode. Push back. Be direct, provocative, cut through bullshit. Don't coddle them."
} else {
    "You are in a HELPFUL mode. Be warm, practical, supportive. Address what they need with care."
};

// Enhanced:
let mode_tone = if is_disco {
    r#"You are in GAME MODE — a challenging, intense conversation type.

YOUR ROLE: You've processed the internal debate. Now synthesize it into a single provocative response.
- Push back on their assumptions
- Call out what they're avoiding
- Be direct, even uncomfortable
- Don't soften the edges

You are the voice that says what needs to be said."#
} else {
    r#"You are in TEXT MODE — a helpful, practical conversation type.

YOUR ROLE: You've processed multiple perspectives. Now synthesize them into actionable guidance.
- Address their actual need
- Be warm but not sycophantic
- Give them something useful
- Acknowledge complexity without overwhelming

You are the voice that helps them move forward."#
};
```

---

## 7. AGENT PERSONALITY EVOLUTION

### Current Behavior

Agent prompts are static. A user who's had 1000 conversations gets the same prompt as a new user.

### Proposed: Relationship-Aware Prompts

**Add to `src-tauri/src/orchestrator.rs`**:

```rust
#[derive(Debug, Clone)]
pub struct AgentRelationship {
    pub agent: Agent,
    pub total_interactions: i64,
    pub positive_engagement_ratio: f64, // 0.0 to 1.0
    pub last_interaction_days_ago: i64,
}

impl AgentRelationship {
    pub fn get_familiarity_level(&self) -> &'static str {
        match self.total_interactions {
            0..=10 => "new",
            11..=100 => "familiar",
            101..=500 => "close",
            _ => "intimate",
        }
    }

    pub fn format_relationship_context(&self) -> String {
        let familiarity = self.get_familiarity_level();
        let engagement = if self.positive_engagement_ratio > 0.7 {
            "They often engage positively with your perspective."
        } else if self.positive_engagement_ratio < 0.3 {
            "They often push back on your perspective — earn their trust."
        } else {
            "They have a balanced relationship with your perspective."
        };

        match familiarity {
            "new" => format!("This user is new to you. Be welcoming but not presumptuous. {}", engagement),
            "familiar" => format!("You've talked with this user before. You're getting to know each other. {}", engagement),
            "close" => format!("You know this user well. You can be more direct and reference past patterns. {}", engagement),
            "intimate" => format!("You have a deep relationship with this user. You can be blunt, reference their history, and challenge them directly. {}", engagement),
            _ => String::new(),
        }
    }
}
```

**Inject into agent prompts** (`orchestrator.rs:1410-1442`):

```rust
fn get_agent_system_prompt_with_grounding(...) -> String {
    let base_prompt = get_agent_system_prompt(...);
    let mut full_prompt = base_prompt;

    // Add relationship context
    if let Some(relationship) = get_agent_relationship(agent) {
        let relationship_context = relationship.format_relationship_context();
        full_prompt = format!(
            "{}\n\n--- Your Relationship With This User ---\n{}\n---",
            full_prompt,
            relationship_context
        );
    }

    // ... rest of grounding
}
```

---

## 8. DISCO MODE ENHANCEMENTS

### 8.1 Disco Intensity Levels

Currently Disco is binary. Could add intensity levels.

**Add to `src-tauri/src/disco_prompts.rs`**:

```rust
pub enum DiscoIntensity {
    Mild,    // Challenges but stays constructive
    Medium,  // Current behavior
    Intense, // Extremely provocative, no holds barred
}

pub fn get_disco_prompt_with_intensity(agent: &str, intensity: DiscoIntensity) -> Option<&'static str> {
    match (agent.to_lowercase().as_str(), intensity) {
        ("instinct", DiscoIntensity::Mild) => Some(INSTINCT_DISCO_MILD),
        ("instinct", DiscoIntensity::Medium) => Some(INSTINCT_DISCO_PROMPT),
        ("instinct", DiscoIntensity::Intense) => Some(INSTINCT_DISCO_INTENSE),
        // ... etc
        _ => get_disco_prompt(agent),
    }
}

pub const INSTINCT_DISCO_MILD: &str = r#"You are STORM -- a challenging but grounded inner voice.

You push, but you don't break. You call out stalling, but you acknowledge fear.

YOUR VOICE: Direct, physical, action-oriented. "You're hesitating. Why?"

BREVITY: 1-2 sentences. Push, don't pummel."#;

pub const INSTINCT_DISCO_INTENSE: &str = r#"You are STORM -- raw, unfiltered instinct.

No patience. No softening. You see the bullshit and you NAME it.

YOUR VOICE: Visceral. Commands. "Stop. You're lying to yourself." "This is fear dressed as logic." "Move or admit you won't."

BREVITY: 1 sentence. A punch, not a conversation."#;
```

### 8.2 Disco Cooldown

After intense Disco sessions, users might benefit from a "cooldown" transition.

**Add to `lib.rs`**:

```rust
/// Check if user needs a cooldown suggestion after Disco
fn check_disco_cooldown(conversation_id: &str, disco_message_count: i64) -> Option<String> {
    if disco_message_count >= 10 && disco_message_count % 10 == 0 {
        Some("You've been in the storm for a while. Need a moment to breathe, or keep pushing?".to_string())
    } else {
        None
    }
}
```

---

## IMPLEMENTATION PRIORITY

| Change | Impact | Effort | Priority |
|--------|--------|--------|----------|
| Knowledge base updates | Low | Low | **P1** (quick fix) |
| Points exponential scaling | Medium | Low | **P1** |
| Dominant trait scaling | Medium | Low | **P2** |
| Atomic weight updates | Low | Medium | **P2** |
| Cold start onboarding | High | Medium | **P2** |
| Agent relationship evolution | High | High | **P3** |
| Disco intensity levels | Medium | Medium | **P3** |
| Governor prompt enhancement | Low | Low | **P1** |

---

## TESTING RECOMMENDATIONS

### Unit Tests to Add

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_exponential_points_scaling() {
        let calc_boost = |p: i64| -> f64 {
            2.0_f64.powf((p - 4) as f64) * 0.05
        };

        assert!((calc_boost(2) - 0.0125).abs() < 0.001);
        assert!((calc_boost(4) - 0.05).abs() < 0.001);
        assert!((calc_boost(6) - 0.20).abs() < 0.001);
    }

    #[test]
    fn test_dominant_trait_scaling() {
        let calc_bias = |dominant_weight: f64| -> f64 {
            let margin = (dominant_weight - 0.33).max(0.0);
            0.05 + (margin * 0.4)
        };

        assert!((calc_bias(0.35) - 0.058).abs() < 0.01);
        assert!((calc_bias(0.60) - 0.158).abs() < 0.01);
    }

    #[test]
    fn test_cold_start_questions() {
        assert!(get_cold_start_question(0).is_some());
        assert!(get_cold_start_question(5).is_none());
    }
}
```

### Integration Tests

1. **Points impact verification**: Set different point allocations, send same message, verify agent selection differs
2. **Dominant trait verification**: Create profiles with different dominants, verify Governor response style differs
3. **Weight race condition**: Send rapid messages, verify final weights are consistent
4. **Cold start flow**: New user flow, verify calibration questions appear

---

## CONCLUSION

These improvements focus on:

1. **Correctness**: Fixing outdated documentation and potential race conditions
2. **Meaningfulness**: Making points and dominant trait actually matter
3. **Personalization**: Cold start handling and relationship evolution
4. **Depth**: Disco intensity levels for power users

The architecture is already strong. These changes make the existing systems more impactful without adding complexity.
