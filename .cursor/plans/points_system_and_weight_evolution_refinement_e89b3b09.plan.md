---
name: Points System and Weight Evolution Refinement
overview: Make points persistent and meaningful for routing, add dominant trait routing bias, surface Disco weight inversion, and separate session weights from base weights to eliminate race conditions.
todos: []
---

# Points Syst

em and Weight Evolution Refinement

## Goal

Fix four specific issues with the points/weights system:

1. Make points persistent and bias routing (+0.03 per point)
2. Add dominant trait routing bias (+0.10 in Normal Mode)
3. Surface Disco weight inversion in logging
4. Separate session weights (decays) from base weights (persists)

**Keep as-is:**

- No Governor synthesis (agents respond directly)
- Privacy boundaries (frontend abstraction)
- Context flow (memory extraction after responses is fine)

---

## Implementation Plan

### Change 1: Persistent Points with Routing Bias

**Problem**: Points are computed from weights on load, converted back on save. They don't persist and don't influence routing.**Solution**: Store points separately in database, add +0.03 routing bias per point.**Database Changes**:

- Add columns to `persona_profiles` table:
- `instinct_points INTEGER DEFAULT 4`
- `logic_points INTEGER DEFAULT 4`
- `psyche_points INTEGER DEFAULT 3`
- (Total = 11, each 2-6 range)

**Files to Modify**:

1. **`src-tauri/src/db.rs`**:

- Add migration to add `instinct_points`, `logic_points`, `psyche_points` columns
- Update `PersonaProfile` struct to include points fields
- Add `update_points()` function to save points separately from weights
- Update `get_user_profile()` to load points from active persona profile

2. **`src-tauri/src/lib.rs`**:

- Add Tauri command `update_points(instinct: i64, logic: i64, psyche: i64)`
- Update `send_message()` to load points and pass to routing function

3. **`src-tauri/src/orchestrator.rs`**:

- Modify `decide_response_heuristic()` signature to accept points
- Add point-based routing bias: `score += points[trait] * 0.03`
- Apply bias AFTER weight-based scoring but BEFORE keyword matching

4. **`src/hooks/useTauri.ts`**:

- Add `updatePoints(instinct: number, logic: number, psyche: number)` function

5. **`src/components/Settings.tsx`**:

- Load points from user profile (not compute from weights)
- Save points separately via `updatePoints()` instead of `updateWeights()`
- Keep point-to-weight conversion only for UI visualization (radar chart)

**Implementation Details**:

```rust
// In decide_response_heuristic, after initial score setup:
let points_bias = if let Some(points) = points_option {
    match trait {
        "instinct" => points.instinct as f64 * 0.03,
        "logic" => points.logic as f64 * 0.03,
        "psyche" => points.psyche as f64 * 0.03,
        _ => 0.0,
    }
} else {
    0.0
};
score += points_bias;
```

---

### Change 2: Dominant Trait Routing Bias

**Problem**: Dominant trait only sets initial weights, doesn't actively influence routing.**Solution**: Add +0.10 routing bias to dominant trait agent in Normal Mode only.**Files to Modify**:

1. **`src-tauri/src/lib.rs`**:

- Pass dominant trait to `decide_response_heuristic()` (get from active persona profile)

2. **`src-tauri/src/orchestrator.rs`**:

- Modify `decide_response_heuristic()` signature to accept `dominant_trait: Option<&str>`
- In Normal Mode (not Disco), add +0.10 to dominant trait's score:
     ```rust
               if !is_disco {
                   if let Some(dominant) = dominant_trait {
                       if let Some(score) = scores.get_mut(dominant) {
                           *score += 0.10;
                           logging::log_routing(None, &format!(
                               "[HEURISTIC] Dominant trait bias: +0.10 to {}",
                               dominant
                           ));
                       }
                   }
               }
     ```




- Apply AFTER points bias, BEFORE keyword matching

---

### Change 3: Surface Disco Weight Inversion

**Problem**: Disco Mode inverts weights but it's not visible/logged clearly.**Solution**: Add explicit logging that shows which agent was selected because of inversion.**Files to Modify**:

1. **`src-tauri/src/orchestrator.rs`**:

- In `decide_response_heuristic()`, after primary agent selection in Disco Mode:
     ```rust
               if is_disco {
                   let original_weights = (instinct_w, logic_w, psyche_w);
                   let inverted_scores = (1.0 - instinct_w, 1.0 - logic_w, 1.0 - psyche_w);
                   logging::log_routing(None, &format!(
                       "[DISCO] Weight inversion: {} selected (original weight: {:.2}, inverted score: {:.2}) - lowest-weighted agent speaks",
                       primary, original_weight, inverted_score
                   ));
               }
     ```




- Add similar logging when secondary agent is selected in Disco Mode

---

### Change 4: Separate Session Weights from Base Weights

**Problem**: Immediate weight updates (on selection) and background updates (engagement analysis) both write to same field, causing race conditions.**Solution**:

- Base weights: Persisted in database, updated by background analysis only
- Session weights: Computed on-the-fly (decays over conversation), updated by immediate selection
- Routing uses: `base_weight + session_weight`
- Session weight decays: `session_weight *= 0.9` per exchange (10% decay)

**Database Changes**:

- No schema changes needed (keep single weight field for base weights)
- Session weights are computed in memory, not stored

**Files to Modify**:

1. **`src-tauri/src/lib.rs`**:

- Add session weight tracking: `HashMap<String, f64>` keyed by conversation_id
- In `send_message()`, compute session weights for current conversation:
    - Load base weights from database
    - Apply decay: `session_weight *= 0.9` for all agents (10% decay per exchange)
    - Add immediate boost for selected agent: `session_weight[agent] += 0.02 `(primary) or `0.015` (secondary)
    - Pass `base_weights + session_weights` to routing
- Store session weights in memory (not database)

2. **`src-tauri/src/orchestrator.rs`**:

- Remove `evolve_weights()` calls from routing (no immediate weight updates to database)
- Background weight updates (engagement analysis) continue to update database base weights
- Routing function signature unchanged (still accepts weights tuple)

3. **`src-tauri/src/orchestrator.rs`** (background analysis):

- Keep `combine_trait_analyses()` → `update_weights()` in background task
- This updates base weights only

**Implementation Details**:

```rust
// In send_message(), before routing:
let base_weights = (profile.instinct_weight, profile.logic_weight, profile.psyche_weight);
let session_weights = get_or_init_session_weights(&conversation_id);

// Decay all session weights (10% per exchange)
for weight in session_weights.values_mut() {
    *weight *= 0.9;
}

// Apply immediate boost for selected agent (after routing decision)
session_weights[selected_agent] += boost_amount;

// Routing uses: base + session
let routing_weights = (
    base_weights.0 + session_weights["instinct"],
    base_weights.1 + session_weights["logic"],
    base_weights.2 + session_weights["psyche"],
);
```

**Session Weight Storage**:

- Use `std::collections::HashMap<String, (f64, f64, f64)>` keyed by conversation_id
- Store as module-level static with Mutex for thread safety
- Clear session weights when conversation ends

---

## Implementation Order

1. **Change 4 (Session Weights)**: Foundation - separate immediate vs background updates
2. **Change 1 (Persistent Points)**: Add points storage and routing bias
3. **Change 2 (Dominant Trait Bias)**: Add dominant trait routing bias
4. **Change 3 (Disco Logging)**: Surface inversion with logging

---

## Testing Checklist

- [ ] Points persist after app restart
- [ ] Points bias routing (higher points = more likely selected, all else equal)
- [ ] Dominant trait gets +0.10 bias in Normal Mode only
- [ ] Disco Mode logs show weight inversion clearly
- [ ] Session weights decay over conversation (10% per exchange)
- [ ] Base weights updated by background analysis only
- [ ] No race conditions between immediate and background updates

---

## Questions to Resolve