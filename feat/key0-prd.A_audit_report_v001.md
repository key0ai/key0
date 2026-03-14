# Audit Report: key0-prd.md
**Report version**: v001
**Timestamp**: 2026-03-14T00:00:00 EST
**Audited file**: `feat/key0-prd.md`
**Audit skill version**: doc-prd-audit v2.3
**Overall status**: FAIL

---

## Summary

| Field | Value |
|---|---|
| PRD ID | Not assigned (no `PRD-NN` prefix) |
| PRD Title | Key0 Product Repositioning PRD |
| Version | 0.3 |
| Status | Draft |
| Validator status | FAIL — 14 errors, 5 warnings |
| Reviewer score | 14 / 100 |
| Pass threshold | ≥ 90 |
| Overall | **FAIL** |

The document is substantive and well-written — the content of the commerce lifecycle, personas, risks, and open questions is strong. However, it does not conform to the required PRD structural schema in any of the critical gates: it has no YAML frontmatter, no PRD-NN identity, is filed in the wrong directory, uses no traceability tags, has no diagram contract annotations, uses legacy element ID patterns, and is missing five required MVP template sections plus six required Document Control fields.

All issues are correctable. None reflect substantive content problems — they are schema compliance gaps.

---

## Score Calculation (Deduction-Based)

**Formula**: `100 − total_deductions`

### Contamination (max 50 deductions)

| Issue | Code | Deduction |
|---|---|---|
| No YAML frontmatter — no tags, no custom_fields | PRD-E001, PRD-E002, PRD-E003 | 10 |
| File not in `docs/02_PRD/PRD-NN_{slug}/` (filed under `feat/`) | PRD-E020, PRD-E021, PRD-E022 | 10 |
| Missing `@brd:` upstream tag | PRD-E013 | 5 |
| Missing `@diagram: c4-l2` | PRD-E023 | 5 |
| Missing `@diagram: dfd-l1` | PRD-E024 | 5 |
| Missing `@diagram: sequence-*` | PRD-E025 | 5 |
| Legacy element IDs — `AC-A1` through `AC-A6` violate `PRD.NN.TT.SS` format | PRD-E017 | 5 |
| **Contamination subtotal** | | **45 / 50** |

### FR Completeness (max 30 deductions)

| Issue | Code | Deduction |
|---|---|---|
| Missing dedicated Traceability section (Section 16) | PRD-E012 | 8 |
| Missing SYS-Ready Score in Document Control | PRD-E015 | 5 |
| Missing EARS-Ready Score in Document Control | PRD-E016 | 5 |
| Missing dedicated Functional Requirements section (Section 8) | PRD-E011 | 5 |
| User stories scattered inline, no dedicated Section 7 | PRD-E010 | 3 |
| **FR completeness subtotal** | | **26 / 30** |

### Structure / Quality (max 20 deductions)

| Issue | Code | Deduction |
|---|---|---|
| Missing Section 15 — Budget & Resources | PRD-E006 | 3 |
| Missing Section 13 — Implementation Approach | PRD-E006 | 3 |
| Missing Section 9 — Quality Attributes | PRD-E006 | 2 |
| Document Control missing: Author, Reviewer, Approver, Date Created, Last Updated, BRD Reference | PRD-E009 | 5 |
| Section numbering restarts inside Part 2 (not sequential across document) | PRD-E008 | 2 |
| **Structure/quality subtotal** | | **15 / 20** |

### Final Score

```
100 − (45 + 26 + 15) = 100 − 86 = 14 / 100   [FAIL — threshold: 90]
```

---

## Validator Findings

### Errors (14)

| Code | Severity | Location | Description |
|---|---|---|---|
| PRD-E001 | ERROR | top of file | Missing required tag `prd` — no YAML frontmatter present |
| PRD-E002 | ERROR | top of file | Missing required tag `layer-2-artifact` — no YAML frontmatter present |
| PRD-E003 | ERROR | top of file | Missing `document_type` field — no YAML frontmatter present |
| PRD-E009 | ERROR | Document Control block (lines 3-6) | Missing required fields: `Author`, `Reviewer`, `Approver`, `Date Created`, `Last Updated`, `BRD Reference` |
| PRD-E010 | ERROR | document-wide | No dedicated Section 7 (User Stories & User Roles) — stories are scattered inline across Sections 5 and 9 |
| PRD-E011 | ERROR | document-wide | No dedicated Section 8 (Functional Requirements) — requirements appear in inline tables without section-level identity |
| PRD-E012 | ERROR | document-wide | Missing Section 16 — Traceability |
| PRD-E013 | ERROR | document-wide | No `@brd:` upstream tag present anywhere in the document |
| PRD-E015 | ERROR | Document Control | SYS-Ready Score missing |
| PRD-E016 | ERROR | Document Control | EARS-Ready Score missing |
| PRD-E017 | ERROR | lines 192–197 | Legacy element IDs detected: `AC-A1`, `AC-A2`, `AC-A3`, `AC-A4`, `AC-A5`, `AC-A6` — must use `PRD.NN.TT.SS` format |
| PRD-E020 | ERROR | file path | PRD not in nested folder under `docs/02_PRD/` — current path: `feat/key0-prd.md` |
| PRD-E023 | ERROR | document-wide | Missing required diagram tag `@diagram: c4-l2` |
| PRD-E024 | ERROR | document-wide | Missing required diagram tag `@diagram: dfd-l1` |
| PRD-E025 | ERROR | document-wide | Missing required diagram tag `@diagram: sequence-*` |

### Warnings (5)

| Code | Severity | Location | Description |
|---|---|---|---|
| PRD-W001 | WARNING | filename | File name `key0-prd.md` does not match required format `PRD-NN_{slug}.md` |
| PRD-W002 | WARNING | document-wide | Missing Section 9 — Quality Attributes |
| PRD-W002 | WARNING | document-wide | Missing Section 13 — Implementation Approach |
| PRD-W002 | WARNING | document-wide | Missing Section 15 — Budget & Resources |
| PRD-W004 | WARNING | Section 1 (Document Control) | No Document Revision History table |

---

## Reviewer Findings

### Errors (0)

No reviewer-level errors. Content quality is high where sections exist.

### Warnings (5)

| Code | Severity | Location | Description |
|---|---|---|---|
| REV-S002 | WARNING | Section 6 (Design Principles) | Serves as architecture principles but does not fulfill the Section 10 (Architecture Requirements) contract — no structured quality attributes or capacity requirements present |
| REV-S002 | WARNING | Section 11 (Non-Goals) | Partially covers constraints but does not fulfill Section 11 (Constraints & Assumptions) in template — no formal assumption list |
| REV-N001 | WARNING | lines 192–197 | `AC-A*` IDs are not valid PRD element IDs; they will not resolve in downstream EARS or SYS artifact generation |
| REV-TR004 | WARNING | Section 8 (Reputation) | Element `Tier A / B / C` identity tiers referenced but not assigned traceable IDs |
| REV-P005 | WARNING | Section 17 (Glossary) | Section absent — agent-commerce terms (`x402`, `A2A`, `MCP`, `escrow`, `EARS`) are used throughout without a glossary |

### Info (3)

| Code | Severity | Location | Description |
|---|---|---|---|
| REV-D006 | INFO | — | Drift cache created (first review); no prior `.drift_cache.json` existed |
| REV-A004 | INFO | Section 11 | Non-goals are clearly and correctly marked as deferred; no BRD contradiction detected |
| PRD-I001 | INFO | Section 1 (Success Criteria) | KPI table is present with quantified targets — well done |

---

## Diagram Contract Findings

| Tag required | Status | Blocking |
|---|---|---|
| `@diagram: c4-l2` | **MISSING** | Yes (PRD-E023) |
| `@diagram: dfd-l1` | **MISSING** | Yes (PRD-E024) |
| `@diagram: sequence-*` | **MISSING** | Yes (PRD-E025) |
| Sequence `alt/else` exception path | N/A (no sequence diagram) | N/A (PRD-E026 not triggered yet) |
| Diagram intent header completeness | N/A | — |

All three required diagram tags are absent. This is a blocking gate failure. The tags declare intent for diagram generation by downstream tools (`doc-ears-autopilot`, `doc-sys-autopilot`). They need not contain rendered diagrams — they declare what diagrams are required. They must be added before the PRD can advance.

---

## Fix Queue for doc-prd-fixer

### auto_fixable

| # | Source | Code | Severity | File | Section | Action hint | Confidence |
|---|---|---|---|---|---|---|---|
| 1 | validator | PRD-E001/E002/E003 | error | `feat/key0-prd.md` | top of file | Add YAML frontmatter block with `tags: [prd, layer-2-artifact]`, `document_type: prd`, `artifact_type: PRD`, `layer: 2`, `priority: primary`, `development_status: draft`, `architecture_approaches: []` | high |
| 2 | validator | PRD-W004 | warning | `feat/key0-prd.md` | Document Control | Add Document Revision History table: Version / Date / Author / Summary | high |
| 3 | validator | PRD-E023/24/25 | error | `feat/key0-prd.md` | Section 10 (Architecture) | Add diagram intent stubs: `@diagram: c4-l2`, `@diagram: dfd-l1`, `@diagram: sequence-payment-flow` with intent headers | high |
| 4 | validator | PRD-E017 | error | `feat/key0-prd.md` | lines 192–197, and inline ACs throughout | Rename `AC-A1..A6` and all inline `AC:` labels to `PRD.NN.06.SS` format once PRD-NN is assigned | medium |
| 5 | validator | PRD-W002 | warning | `feat/key0-prd.md` | missing | Add stub Section 9 — Quality Attributes (availability, latency, scalability targets already present in KPI table — extract and formalise) | high |
| 6 | validator | PRD-W002 | warning | `feat/key0-prd.md` | missing | Add stub Section 11 — Constraints & Assumptions (convert Non-Goals list + implicit assumptions) | high |
| 7 | validator | PRD-E010/E011 | error | `feat/key0-prd.md` | document-wide | Consolidate scattered user stories into dedicated Section 7; consolidate inline requirement tables into dedicated Section 8 with `PRD.NN.01.SS` IDs | medium |
| 8 | reviewer | REV-S002 | warning | `feat/key0-prd.md` | Section 6 | Rename Section 6 "Design Principles" → Section 10 "Architecture Requirements" and add capacity / availability targets drawn from existing KPI table | high |

### manual_required

| # | Source | Code | Severity | File | Section | Action hint | Confidence |
|---|---|---|---|---|---|---|---|
| 1 | validator | PRD-E020/W001 | error | `feat/key0-prd.md` | file path | Assign PRD-NN number; move file to `docs/02_PRD/PRD-NN_key0_platform/PRD-NN_key0_platform.md` | manual-required |
| 2 | validator | PRD-E009 | error | `feat/key0-prd.md` | Document Control | Fill in: Author, Reviewer, Approver, Date Created, Last Updated | manual-required |
| 3 | validator | PRD-E013 | error | `feat/key0-prd.md` | Document Control | Add `@brd: BRD.NN.TT.SS` reference — requires a BRD document to exist first | manual-required |
| 4 | validator | PRD-E015/E016 | error | `feat/key0-prd.md` | Document Control | Compute and fill SYS-Ready Score and EARS-Ready Score after structural fixes are complete | manual-required |
| 5 | validator | PRD-W002 | warning | `feat/key0-prd.md` | missing | Section 13 — Implementation Approach: requires technical decisions from engineering | manual-required |
| 6 | validator | PRD-W002 | warning | `feat/key0-prd.md` | missing | Section 15 — Budget & Resources: requires business input | manual-required |
| 7 | validator | PRD-E012 | error | `feat/key0-prd.md` | missing | Section 16 — Traceability: populate `@brd:` tags on each requirement once BRD exists | manual-required |
| 8 | validator | PRD-E023/24/25 | error | `feat/key0-prd.md` | diagrams | Render actual C4 L2 context diagram, data flow diagram, and payment sequence diagram with exception paths (`alt/else`) | manual-required |

### blocked

| # | Blocking issue | Resolution required |
|---|---|---|
| 1 | BRD does not exist | All `@brd:` traceability, REV-A001 alignment checks, and PRD-NN assignment depend on a BRD being created first |
| 2 | PRD-NN not assigned | Element ID renaming (`PRD.NN.TT.SS`) and file relocation are blocked until an ID is assigned |
| 3 | SYS/EARS scoring | Both scores blocked until structural fixes in auto_fixable are applied |

---

## Recommended Next Step

**Manual update required before doc-prd-fixer can operate fully.**

Priority order:

1. **Create a BRD** or confirm this PRD is BRD-free (standalone, no upstream BRD). If standalone, the `@brd:` requirement and upstream drift checks can be waived by setting `upstream_mode: standalone` in the drift cache.

2. **Assign PRD-NN and relocate file** to `docs/02_PRD/PRD-NN_key0_platform/PRD-NN_key0_platform.md`.

3. **Run `doc-prd-fixer`** — all `auto_fixable` items (YAML frontmatter, stub sections, diagram intent tags, ID renaming, document control fields) can be applied automatically after steps 1–2.

4. **Fill manual sections** — Budget & Resources, Implementation Approach, Author/Reviewer/Approver.

5. **Re-audit** — run `/doc-prd-audit` again to verify score ≥ 90 before advancing to EARS/SYS generation.

---

## Drift Cache

No `.drift_cache.json` existed prior to this audit. A cache entry is created below.

**Location**: `feat/.drift_cache.json`

```json
{
  "schema_version": "1.2",
  "document_id": "key0-prd",
  "document_version": "0.3",
  "upstream_mode": "standalone",
  "upstream_ref_path": null,
  "drift_detection_skipped": true,
  "last_reviewed": "2026-03-14T00:00:00",
  "last_fixed": null,
  "reviewer_version": "2.3",
  "fixer_version": null,
  "autopilot_version": null,
  "upstream_documents": {},
  "review_history": [
    {
      "date": "2026-03-14T00:00:00",
      "score": 14,
      "drift_detected": false,
      "report_version": "v001",
      "review_type": "audit",
      "status": "FAIL"
    }
  ],
  "fix_history": []
}
```

*Note: `drift_detection_skipped: true` and `upstream_mode: standalone` because no BRD reference exists. Update `upstream_mode` to `"brd"` and add upstream document hashes once a BRD is created.*
