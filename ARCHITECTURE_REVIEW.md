# Intersect Architecture Review: Turn-Taking, Context, Privacy, and Point System

## Executive Summary

This document reviews four critical aspects of Intersect's architecture based on codebase analysis:

1. **Turn-Taking Mechanics**: Agents respond directly to users; no Governor synthesis layer exists
2. **Context Management**: Two-tier system (conversation window + long-term memory) with some gaps
3. **Privacy Boundaries**: Frontend abstraction creates `governor_thoughts` display, but no true synthesis
4. **Point/Weight System**: User points and system weights are disconnected; unclear relationship

---

## Part 1: Turn-Taking Mechanics

### Current Flow Analysis

**Actual Implementation:**
1. User sends message → `send_message()` in `lib.rs:760`
2. Routing decision → `decide_response_heuristic()` (instant, heuristic-based)
   - Uses keyword matching + weight-based scoring
   - In Disco Mode: weights are INVERTED (lower weights → higher scores)
   - Secondary decision: score difference < 0.15 triggers secondary
   - Forced inclusion: agents silent for 3+ exchanges are included
3. **Agents respond directly** → `get_agent_response_with_grounding()` generates responses
4. Agent messages saved → Role = agent name (`"instinct"`, `"logic"`, `"psyche"`)
5. Frontend conversion → `ChatWindow.tsx` converts agent roles to `governor_thoughts` for display

**Key Finding: NO Governor Synthesis Step**

The codebase shows:
- `SendMessageResult` struct returns `responses: Vec<AgentResponse>` - only agent responses
- No `governor_response` field in the result
- No `generate_governor_response()` function that synthesizes agent thoughts
- Agent messages are saved directly to database with agent roles

**What Actually Happens:**
- Agents respond directly to user message
- Frontend displays these as "thoughts" via role conversion
- User sees agent responses styled as muted thoughts
- **No synthesized Governor response exists**

**Code Evidence:**
- `src-tauri/src/lib.rs:842-847`: Agent responses are pushed directly to `responses` vector
- `src/components/ChatWindow.tsx:582-590`: Agent responses converted to `governor_thoughts` role
- `src/components/ChatWindow.tsx:617-621`: Comment shows `result.governor_response` but this doesn't exist in backend

### Routing Logic Details

**Heuristic Routing** (`decide_response_heuristic`):
- **Normal Mode**: `score = weight + keyword_boosts` (higher weight → more likely selected)
- **Disco Mode**: `score = (1.0 - weight) + keyword_boosts` (inverted: lower weight → more likely)
- **Keyword Boost**: +0.15 per matching keyword (logic/instinct/psyche keywords)
- **Secondary Trigger**: Score difference < 0.15 between top two agents
- **Silence Detection**: Agents silent for 3+ user exchanges are forced inclusion

**Pattern-Aware Routing** (`decide_response_with_patterns`):
- Exists but NOT currently used (commented/legacy?)
- Would use Claude Opus 4.5 for routing decision
- Considers user patterns, communication style, emotional tendency

---

## Part 2: Context Management

### In-Window Context (Conversation History)

**Flow:**
1. `get_recent_messages(&conversation_id, 20)` → Last 20 messages from conversation
2. Passed to agents as `conversation_history` parameter
3. Agents see recent messages with roles (user, agent names)
4. Grounding decision determines user profile injection level (Light/Moderate/Deep)

**Current Implementation:**
```rust
// src-tauri/src/lib.rs:768
let recent_messages = db::get_recent_messages(&conversation_id, 20)
```

**Issues:**
- Agents see each other's responses in conversation history
- No distinction between "thoughts" vs "final response" in context
- All messages are treated equally (user, agent, system)
- Grounding injects user profile but doesn't separate thought context from synthesis context

### Long-Term Memory

**Memory Extraction Flow:**
1. **Extraction** (async, background, after response):
   - `MemoryExtractor.extract_from_exchange()` runs after each exchange
   - Extracts facts, patterns, themes from user message + agent responses
   - Uses Anthropic Opus for extraction
   - **Timing**: Happens AFTER agents respond (line 1182-1212)

2. **Storage**:
   - Facts → `user_facts` table (category, key, value, confidence)
   - Patterns → `user_patterns` table (pattern_type, description, confidence)
   - Themes → `recurring_themes` table

3. **Retrieval**:
   - `UserProfileSummary` built from all facts/patterns/themes
   - Grounding system decides injection level (Light/Moderate/Deep)
   - Patterns injected for Disco Mode challenge (new feature from previous work)

**Context Flow:**
```
User Message
  ↓
Routing Decision (uses current weights)
  ↓
Agent Responses (see recent_messages + grounding)
  ↓
Memory Extraction (async, background)
  ↓
Next Exchange (can use newly extracted memory)
```

**Issues:**
- Memory extraction happens AFTER agent responses
- Agents don't have access to newly extracted memory until next exchange
- No distinction between "memory for routing" vs "memory for synthesis"
- Grounding decision is heuristic-based (no API call), may miss nuanced cases

---

## Part 3: Privacy Boundaries

### Current Implementation

**Agent Thoughts Display:**
- Agent messages saved with role = agent name (`"instinct"`, `"logic"`, `"psyche"`)
- Frontend converts to `"governor_thoughts"` role for display
- Conversion happens in `ChatWindow.tsx:166-178`, `900-914`, `966-979`
- Styled as muted, italic thoughts in `MessageBubble.tsx`
- Shown in `ThoughtsContainer.tsx` component

**Governor Knowledge:**
- Governor (via `INTERSECT_KNOWLEDGE` constant) knows:
  - Agents exist and can be explained if user asks
  - System architecture (multi-agent, orchestration)
  - Turn-taking mechanics
- Governor does NOT know:
  - That users can see agent thoughts (frontend abstraction)
  - That thoughts are displayed as background context
  - That there's a synthesis step (because there isn't one)

**User Interaction:**
- User CAN see agent thoughts (displayed as muted background)
- User CANNOT directly respond to individual agent thoughts
- User can ask Governor about agents/system, and Governor can explain (via `INTERSECT_KNOWLEDGE`)

**Code Evidence:**
```typescript
// src/components/ChatWindow.tsx:166-178
const convertedMessages = loadedMessages.map(msg => {
  if (msg.role === 'instinct' || msg.role === 'logic' || msg.role === 'psyche') {
    return {
      ...msg,
      role: 'governor_thoughts' as const,  // Conversion happens here
      agentName: agentConfig.name,
      isDisco: conv.isDisco,
    };
  }
  return msg;
});
```

### Privacy Boundary Analysis

**Current State:**
- Privacy boundary is maintained by frontend abstraction only
- Backend has no concept of "thoughts" vs "final response"
- Agents respond directly; no synthesis layer
- Governor doesn't synthesize because synthesis doesn't exist

**Design Intent (Based on Knowledge Base):**
The `INTERSECT_KNOWLEDGE` constant suggests the intended design:
- "The Governor is the orchestration layer... It is NOT a conversational agent"
- "Agents are aware of each other's responses"
- But no mention of Governor synthesizing agent thoughts

**Question**: Is the current implementation (agents respond directly, displayed as thoughts) the intended design, or should there be a Governor synthesis step?

---

## Part 4: Point/Weight System

### Current Implementation

**Points (User-Allocated):**
- User allocates 11 points total across 3 traits (2-6 per trait)
- Stored in `persona_profiles` table (but field name unclear - may be implicit)
- Used for dominant trait selection (which determines user avatar)
- **Finding**: Points don't directly map to weights in code

**Weights (System-Evolved):**
- Start: 50% Logic, 30% Psyche, 20% Instinct (or based on dominant trait initial weights)
- Evolve via multiple paths:
  1. **Immediate**: `evolve_weights()` on primary/secondary selection
     - Primary: +0.02 boost (with de-exponential rigidity)
     - Secondary: +0.015 boost (with de-exponential rigidity)
  2. **Background**: `EngagementAnalyzer` + `IntrinsicTraitAnalyzer` → `combine_trait_analyses()`
     - Runs async after response
     - Analyzes user engagement with agent responses
     - Analyzes intrinsic trait signals in user message

**De-Exponential Rigidity:**
```rust
// src-tauri/src/orchestrator.rs:1395-1403
fn calculate_variability(total_messages: i64) -> f64 {
    // 0 messages: 1.0 (100% variable)
    // 10000+ messages: 0.0 (100% rigid)
    let progress = (total_messages as f64 / 10000.0).min(1.0);
    1.0 - progress.sqrt()
}
```
- Weights become less mutable over time (0-10000 messages)
- Early messages have more impact on weight evolution

**Weight Influence on Routing:**
- Heuristic routing: Weights are starting scores (normal mode) or inverted (disco mode)
- Keyword matching adds +0.15 boost per match
- Final score = weight + keyword_boosts
- Higher weight = more likely to be selected (normal mode)

**Dominant Trait:**
- Selected by user (clicking profile picture in radar chart)
- Determines user avatar (via `USER_PROFILES` mapping)
- Determines initial weights (if set): 50% dominant, 30% secondary, 20% third
- **Finding**: Dominant trait does NOT actively influence routing beyond initial weights

### Issues and Gaps

1. **Points vs Weights Disconnection:**
   - User allocates "points" (2-11 total)
   - System uses "weights" (evolved, not directly tied to points)
   - Points appear to only affect dominant trait selection, not routing
   - **Question**: What is the relationship between user-allocated points and routing weights?

2. **Weight Evolution Complexity:**
   - Multiple weight update paths (immediate + background)
   - Potential race conditions: Immediate updates vs background updates
   - Both paths update the same database field
   - **Issue**: Last write wins - background update may overwrite immediate update

3. **Dominant Trait Impact:**
   - Dominant trait determines initial weights (if manually set)
   - After initial setup, dominant trait doesn't actively influence routing
   - **Opportunity**: Could dominant trait influence routing bias? (e.g., +0.10 boost to dominant trait agent)

4. **Disco Mode Weight Inversion:**
   - Weights are inverted in Disco Mode (lower weight → higher score)
   - This means lower-weighted agents speak MORE in Disco Mode
   - **Question**: Is this the desired behavior? (Challenging by hearing underrepresented voices)

5. **Point Allocation Purpose:**
   - User allocates points (2-11 total, 2-6 per trait)
   - But these points don't directly map to weights
   - **Question**: Should points directly set weights? Or is there a transformation?

### Code Evidence

**Weight Updates:**
```rust
// Immediate update (line 850-851)
let new_weights = evolve_weights(initial_weights, primary_agent, InteractionType::ChosenAsPrimary, profile.total_messages);
db::update_weights(new_weights.0, new_weights.1, new_weights.2)?;

// Background update (line 1159-1167)
let new_weights = combine_trait_analyses(...);
db::update_weights(new_weights.0, new_weights.1, new_weights.2)?;
```

**Routing Score Calculation:**
```rust
// Normal mode: score = weight
scores.insert("instinct", instinct_w);
scores.insert("logic", logic_w);
scores.insert("psyche", psyche_w);

// Disco mode: score = 1.0 - weight (inverted)
scores.insert("instinct", 1.0 - instinct_w);
scores.insert("logic", 1.0 - logic_w);
scores.insert("psyche", 1.0 - psyche_w);
```

---

## Key Questions and Recommendations

### 1. Governor Synthesis

**Question**: Should the Governor synthesize agent thoughts into a final response?

**Current**: Agents respond directly, frontend displays as thoughts

**Options**:
- **A) Keep current**: Agents respond directly, no synthesis (simpler, faster)
- **B) Add synthesis**: Governor reads agent thoughts, creates synthesized response

**Recommendation**: Clarify design intent. If synthesis is desired, implement `generate_governor_response()` that reads agent responses and synthesizes.

### 2. Points → Weights Relationship

**Question**: What is the exact relationship between user-allocated points and routing weights?

**Current**: Points appear disconnected from weights

**Options**:
- **A) Points directly set initial weights**: Normalize points to sum to 1.0
- **B) Points influence routing bias**: Points add to routing scores independently
- **C) Points influence weight evolution rate**: Higher points → faster weight evolution

**Recommendation**: Implement Option A or B - make points meaningful for routing.

### 3. Dominant Trait Routing Bias

**Question**: Should dominant trait actively influence routing (bias), or only determine initial weights?

**Current**: Only affects initial weights

**Recommendation**: Add routing bias (+0.10 boost to dominant trait agent) to make dominant trait actively influence routing.

### 4. Weight Evolution Consolidation

**Question**: How should immediate weight updates (routing) interact with background updates (engagement analysis)?

**Current**: Both update same field, potential race conditions

**Recommendation**: 
- Option A: Remove immediate updates, only use background updates
- Option B: Use immediate updates for routing decisions, background updates for long-term evolution (separate fields)
- Option C: Queue updates, apply sequentially

### 5. Context Separation

**Question**: Should agent "thoughts" be separate from "responses" in context?

**Current**: Agents respond directly, all messages treated equally in context

**Recommendation**: If synthesis is added, separate thought context from response context in conversation history.

---

## Summary of Findings

1. **No Governor Synthesis**: Agents respond directly; no synthesis layer exists
2. **Points Disconnected**: User-allocated points don't map to routing weights
3. **Weight Evolution Conflicts**: Immediate and background updates may conflict
4. **Dominant Trait Passive**: Only affects initial weights, not active routing
5. **Context Undifferentiated**: No separation between thoughts and responses in context


