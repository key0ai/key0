---
name: agent-card-updater
description: Updates AGENT_CARD.md when the Agent Card type definition or builder logic changes. Use after editing src/types/agent-card.ts or src/core/agent-card.ts, or when any field is added, removed, or changed in AgentCard, AgentSkill, AgentExtension, AgentInterface, or SkillPricing. Also run periodically to audit AgentGate's implementation against the latest A2A spec.
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

6. **Audit against the latest A2A spec** (run when explicitly asked or periodically):
   - Fetch the latest A2A specification from the canonical repository:
     - **Spec directory**: `https://github.com/a2aproject/A2A/tree/main/specification`
     - **JSON schema**: `https://github.com/a2aproject/A2A/blob/main/specification/json/a2a.json`
     - **Changelog**: `https://github.com/a2aproject/A2A/blob/main/CHANGELOG.md`
     - **Agent Card topics**: `https://a2a-protocol.org/latest/topics/agent-discovery/`
     - **Extensions topics**: `https://a2a-protocol.org/latest/topics/extensions/`
   - Compare the upstream spec against AgentGate's current `src/types/agent-card.ts` and `AGENT_CARD.md`.
   - For each gap found, produce a **structured suggestion** in this format:

     ```
     ## A2A Spec Audit — <date>

     ### New fields in spec not in AgentGate types
     - `fieldName` (type, optional/required) — description and recommended action

     ### Changed field semantics
     - `fieldName` — what changed and whether AgentGate's behaviour is still compliant

     ### Deprecated or removed spec fields
     - `fieldName` — currently in AgentGate types; recommend removing or marking deprecated

     ### Extension spec changes
     - Any changes to the x402 extension URI, params schema, or activation protocol

     ### Recommended implementation changes
     - Ranked list of changes to make to src/types/agent-card.ts and/or src/core/agent-card.ts
     ```

   - **Do not auto-apply** implementation changes (type/builder edits). Surface them as recommendations only — the developer decides what to adopt.
