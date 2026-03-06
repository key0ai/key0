---
name: agent-card-updater
description: Updates AGENT_CARD.md when the Agent Card type definition or builder logic changes. Use after editing src/types/agent-card.ts or src/core/agent-card.ts, or when any field is added, removed, or changed in AgentCard, AgentSkill, AgentExtension, AgentInterface, or SkillPricing.
---

Update `AGENT_CARD.md` to reflect the current state of the Agent Card types and builder.

## Steps

1. **Read the source files**:
   - `src/types/agent-card.ts` — all type definitions
   - `src/core/agent-card.ts` — how `buildAgentCard()` sets each field
   - `AGENT_CARD.md` — the current documentation

2. **Diff types vs docs**: For each field in the TypeScript types, check whether `AGENT_CARD.md` documents it correctly. Flag:
   - Missing fields (in types but not in docs)
   - Removed fields (in docs but no longer in types)
   - Changed types, optionality, or defaults
   - Changed hardcoded values or derivation logic in `buildAgentCard()`

3. **Update `AGENT_CARD.md`**: Apply the minimum diff needed to make the docs accurate:
   - Add a new subsection for each new field, following the existing format:
     ```
     #### `fieldName`
     - **Type**: `TypeScript type` (optional if applicable)
     - **Required**: Yes / No
     - **Description**: ...
     - **Example**: `...`
     - **Set from**: SellerConfig.field or "Hardcoded to X in buildAgentCard()"
     ```
   - Remove or mark deprecated any fields that no longer exist in the types
   - Update the **Complete Example** JSON at the bottom to match

4. **Preserve structure**: Keep existing section order, headers, and prose. Only touch the sections that need updating.

5. **Verify**: After editing, confirm every field in `src/types/agent-card.ts` has a corresponding entry in `AGENT_CARD.md` and the Complete Example is valid JSON.
