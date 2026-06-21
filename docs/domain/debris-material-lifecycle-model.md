# Debris Material Lifecycle and Ticket Model

Source: operator-provided domain model from EightForge development session, 2026-06-21. Grounded in FEMA Public Assistance Program and Policy Guide (PAPPG) debris monitoring practice and standard disaster-recovery contractor/monitoring firm operating models. This document is reference material for future EightForge taxonomy/validator work - specifically the planned Lifecycle-Aware Rate Taxonomy & Material Stream Model. It is NOT yet implemented in code; see project backlog for current implementation status.

## 1. Core Material Lifecycle Concept

Disaster debris is not a single static commodity. It moves through a lifecycle:

```text
Source Location
  -> Collection / Initial Haul
  -> DMS Intake
  -> Processing / Reduction / Transformation
  -> Derived Material
  -> Final Haul
  -> Final Disposal / Reuse / Recycling
  -> Closeout Documentation
```

Material identity changes through the lifecycle. A vegetative pile at the right-of-way is not the same operational material as ground mulch leaving a debris management site, and neither is the same as burn ash leaving an incineration area. Mixed construction and demolition debris is not the same as compacted C&D residue loaded out for landfill disposal. A validator that treats every line as only "vegetative removal" or "C&D removal" loses the operational distinction that makes the invoice review meaningful.

The core review question is therefore not simply whether an invoice line names the correct material. It is whether the invoice line matches the correct lifecycle stage, state, source, destination, unit, and rate authority for that material stream.

## 2. Key Nodes

### Source Location

The source location is where the debris enters the eligible work stream.

Common source nodes:

| Source node | Meaning | Common evidence |
|---|---|---|
| ROW | Public right-of-way collection point | Load ticket, tower ticket, GPS/zone, monitor signature |
| Public property | Eligible public site, facility, park, school, utility, or similar location | Work order, load ticket, site authorization |
| Private property / PPDR | Private property debris removal under approved PPDR controls | ROE packet, eligibility approval, load ticket |
| Commercial / CPDR | Commercial property debris removal under approved CPDR controls | Authorization packet, load ticket, eligibility review |
| Waterway | Canal, creek, river, drainage channel, or navigable waterway | Work order, environmental controls, load ticket |
| Hazard tree location | Location of tree, leaner, hanger, limb, stump, or related hazard work | Hazard tree packet, GPS/photo, monitor approval |

Recommended source fields:

```json
{
  "source_node": "ROW",
  "source_location_type": "public_right_of_way",
  "source_zone": "Zone 4",
  "source_address_or_segment": "Goodlettsville Area - Route 12",
  "eligibility_basis": "FEMA PA eligible debris removal",
  "source_evidence_ids": ["load-ticket-10421", "tower-ticket-10421"]
}
```

### Debris Management Site

A debris management site (DMS) is a transformation node. It receives original material, stages it, reduces it, processes it, separates it, burns it, grinds it, compacts it, decontaminates it, or otherwise changes the material state before final disposition.

| Original material | DMS activity | Derived material/state | Typical evidence |
|---|---|---|---|
| Vegetative debris | Grind/chip | Mulch / reduced vegetative material | DMS processing log, grinder log, volume reduction record |
| Vegetative debris | Burn / air curtain incineration | Ash | Burn log, ash load-out ticket |
| C&D debris | Sort/compact/load | Compacted C&D residue | DMS processing log, scale ticket |
| White goods | Segregate/decontaminate | Decontaminated scrap / recyclable metal | White goods log, refrigerant recovery record |
| E-waste | Segregate/package | Recyclable e-waste lot | Manifest, recycler receipt |
| HHW | Segregate/package | Manifested hazardous material | Environmental manifest, disposal receipt |
| Sand/soil/sediment/silt | Screen/dewater/load | Processed sediment or spoil | Screening log, disposal receipt |

Example DMS ticket types:

| Ticket type | Purpose |
|---|---|
| Tower ticket | Confirms volume into DMS, typically by truck measurement and monitor certification |
| Scale ticket | Confirms weight into or out of DMS |
| DMS processing log | Connects original material to processing/reduction activity |
| Stockpile balance | Reconciles intake, reduction, load-out, and remaining material |
| Haul-out ticket | Documents derived material leaving DMS |

### Final Disposal Site

The final disposal site (FDS) is the final resting place for derived material, not always the original material collected at the source. The FDS may receive mulch, burn ash, compacted C&D residue, decontaminated scrap, manifested hazardous waste, or another derived state.

| FDS type | Common material received | Evidence |
|---|---|---|
| Landfill | C&D, compacted C&D residue, ash, mixed debris residue | Disposal receipt, scale ticket |
| Recycling facility | White goods, scrap metal, e-waste, mulch reuse stream | Recycler receipt, manifest |
| Beneficial reuse site | Mulch, soil, sand, screened material | Haul-out ticket, receiving acknowledgement |
| HHW disposal facility | Hazardous household waste | Environmental manifest, disposal receipt |
| Ash disposal site | Burn ash | Scale ticket, disposal receipt |

Two invoice lines are not duplicates when they describe different lifecycle legs. For example, a line for hauling vegetative debris from ROW to DMS and a line for hauling mulch from DMS to FDS may use the same quantity family and a similar description, but they represent different source/destination nodes and different material states.

## 3. Primary Material Lifecycles

### 1. Vegetative ROW -> DMS -> Mulch -> FDS

#### Operational Flow

Vegetative debris is collected from ROW or other eligible source locations, hauled to a DMS, inspected and measured, ground or chipped, staged as mulch, then hauled to an FDS, recycler, or beneficial reuse site.

#### Material Transformation

```text
vegetative_pile -> vegetative_load -> dms_stockpile -> mulch -> mulch_loadout
```

#### Ticket Chain

1. Load ticket or tower ticket for ROW-to-DMS haul.
2. DMS processing or grinding log.
3. Stockpile balance or reduction record.
4. Haul-out ticket for mulch leaving DMS.
5. Disposal, recycling, or reuse receipt.

#### Rate Rows

- Collection/removal from source.
- Initial haul to DMS.
- DMS grinding/reduction.
- Haul-out of mulch.
- Final disposal, reuse, or recycling fee if applicable.

#### PM Risk

The PM risk is flattening mulch haul-out into a duplicate of original vegetative haul. The line is only duplicate billing if it charges the same activity, same material state, same source, and same destination twice.

### 2. Vegetative ROW -> DMS -> Burn Ash -> FDS

#### Operational Flow

Vegetative debris is collected and hauled to a DMS, burned through an approved burn process, converted to ash, loaded out, and hauled to final disposal.

#### Material Transformation

```text
vegetative_pile -> vegetative_load -> burn_feedstock -> ash -> ash_loadout
```

#### Ticket Chain

1. Load ticket or tower ticket for source-to-DMS haul.
2. Burn log or incineration log.
3. Ash generation or reduction record.
4. Ash haul-out ticket.
5. Landfill or ash disposal receipt.

#### Rate Rows

- Vegetative collection/removal.
- Haul to DMS.
- Burning or reduction activity.
- Ash haul-out.
- Ash disposal.

#### PM Risk

Ash is not the same material state as original vegetative debris. The PM should verify whether the contract separately authorizes burn processing, ash haul-out, and ash disposal.

### 3. Vegetative Direct-to-FDS

#### Operational Flow

Vegetative debris is collected from an eligible source and hauled directly to a final disposal, recycling, or reuse site without DMS processing.

#### Material Transformation

```text
vegetative_pile -> vegetative_load -> final_disposal_or_reuse
```

#### Ticket Chain

1. Load ticket at source.
2. Scale or disposal receipt at FDS.
3. Monitor certification and route/zone evidence.

#### Rate Rows

- Collection/removal.
- Direct haul to FDS.
- Disposal/recycling/reuse fee if contractually separate.

#### PM Risk

Do not infer a DMS processing stage if the evidence supports direct disposal. Direct-to-FDS rates and DMS-routed rates may have different authorities, distances, and evidence requirements.

### 4. C&D ROW/Property -> DMS -> Compacted -> Landfill

#### Operational Flow

Construction and demolition debris is collected from ROW, public property, PPDR, or CPDR source locations, hauled to DMS, staged, sorted, compacted or loaded, and hauled to landfill.

#### Material Transformation

```text
mixed_c_and_d -> c_and_d_load -> dms_c_and_d_stockpile -> compacted_c_and_d_residue -> landfill_load
```

#### Ticket Chain

1. Load ticket for C&D source-to-DMS haul.
2. DMS intake record.
3. Sorting/compaction/loading log.
4. Scale ticket for landfill haul-out.
5. Landfill disposal receipt.

#### Rate Rows

- C&D collection/removal.
- Haul to DMS.
- DMS processing/compaction/loading.
- Haul to landfill.
- Landfill tipping fee if separate.

#### PM Risk

Mixed C&D at the source is not identical to compacted C&D residue leaving the DMS. The PM should verify whether billed units are CY, tons, loads, or tipping-fee amounts and whether any conversion is explicit.

### 5. C&D Direct-to-Landfill

#### Operational Flow

C&D debris is collected and hauled directly to a landfill or approved disposal facility without DMS processing.

#### Material Transformation

```text
c_and_d_source_material -> c_and_d_load -> landfill_disposal
```

#### Ticket Chain

1. Load ticket or work order.
2. Scale ticket at landfill.
3. Landfill disposal receipt.

#### Rate Rows

- C&D collection/removal.
- Direct haul to landfill.
- Disposal or tipping fee if separately billable.

#### PM Risk

Direct C&D disposal should not be reconciled against DMS stockpile balances unless the material actually passed through a DMS.

### 6. White Goods

#### Operational Flow

White goods are collected from eligible source locations, segregated, staged, decontaminated when needed, and delivered to recycler or disposal facility.

#### Material Transformation

```text
white_goods -> staged_white_goods -> decontaminated_scrap -> recycler_or_disposal
```

#### Ticket Chain

1. Collection log or load ticket.
2. White goods inventory.
3. Refrigerant/decontamination record where applicable.
4. Recycler receipt or disposal receipt.

#### Rate Rows

- White goods collection.
- Decontamination/removal of refrigerants or hazardous components.
- Haul to recycler/disposal.
- Disposal or recycling fee if separate.

#### PM Risk

White goods cannot be reviewed like vegetative or C&D volume rows. Evidence must support item counts, decontamination, and final disposition.

### 7. E-waste

#### Operational Flow

Electronic waste is collected, segregated, packaged or palletized, manifested when required, and delivered to an approved recycler or disposal facility.

#### Material Transformation

```text
e_waste_items -> segregated_e_waste_lot -> recycler_load
```

#### Ticket Chain

1. Collection log or item count.
2. Segregation/staging record.
3. Manifest or recycler paperwork.
4. Final recycler/disposal receipt.

#### Rate Rows

- E-waste collection.
- Packaging/staging.
- Haul to recycler/disposal.
- Recycling or disposal fee if applicable.

#### PM Risk

E-waste review is evidence-heavy. The PM should verify item count, chain of custody, approved facility, and whether the rate is per item, per pound, per load, or lump sum.

### 8. HHW

#### Operational Flow

Household hazardous waste is identified, segregated, packaged, manifested, transported by authorized handlers, and disposed at approved facilities.

#### Material Transformation

```text
hhw_items -> segregated_hhw -> packaged_manifested_hhw -> approved_disposal
```

#### Ticket Chain

1. Collection or segregation log.
2. Hazard classification or inventory.
3. Environmental manifest.
4. Transport record.
5. Disposal receipt.

#### Rate Rows

- HHW collection/segregation.
- Packaging or handling.
- Transport.
- Disposal.

#### PM Risk

HHW billing requires stronger chain-of-custody and environmental controls than ordinary debris. Missing manifests should be treated as a material evidence gap.

### 9. Hazardous Trees, Leaners, Hangers, Limbs, and Stumps

#### Operational Flow

Hazard tree work begins with inspection and eligibility documentation, proceeds through cutting/removal or trimming, and may create vegetative debris that enters the ordinary vegetative debris stream.

#### Material Transformation

```text
hazard_tree_or_limb -> cut_removed_material -> vegetative_debris -> dms_or_fds
```

#### Ticket Chain

1. Hazard tree packet with GPS/photo/eligibility support.
2. Monitor approval.
3. Work completion evidence.
4. Load ticket if resulting debris is hauled.
5. DMS/FDS receipt if applicable.

#### Rate Rows

- Hazard tree removal.
- Leaner/hanger/limb removal.
- Stump removal.
- Haul of resulting vegetative debris.
- Disposal/reduction where separately authorized.

#### PM Risk

Hazard tree work can create both service-item rates and downstream debris-haul rates. A PM must distinguish removal work from hauling/disposal of resulting material.

### 10. Sand, Soil, Sediment, and Silt

#### Operational Flow

Sand, soil, sediment, or silt is removed from eligible locations, hauled to staging or processing, screened/dewatered where required, and hauled to disposal or beneficial reuse.

#### Material Transformation

```text
sand_soil_sediment_silt -> staged_material -> screened_or_dewatered_material -> disposal_or_reuse
```

#### Ticket Chain

1. Work order or load ticket.
2. Source location and eligibility evidence.
3. Screening/dewatering log if processed.
4. Haul-out ticket.
5. Disposal or reuse receipt.

#### Rate Rows

- Removal/excavation.
- Haul to DMS/staging.
- Screening/dewatering/processing.
- Haul to disposal/reuse.
- Disposal fee if applicable.

#### PM Risk

Units and eligibility are sensitive. The PM should verify whether quantities are CY, tons, acres, linear feet, or lump sum, and whether the source location is eligible.

## 4. The Three-Leg Ticket Model

### Leg 1: Haul-to-DMS

Leg 1 documents original material moving from an eligible source location to a DMS.

Example invoice line:

```text
Vegetative debris removal and haul from ROW to DMS - 43,894 CY @ $6.90/CY
```

Expected evidence:

- Load ticket or tower ticket.
- Source location/zone.
- Truck measurement or scale evidence.
- Monitor signature.
- DMS intake confirmation.

### Leg 2: Transform-at-DMS

Leg 2 documents processing, reduction, separation, burning, grinding, compaction, decontamination, or packaging at the DMS.

Example invoice line:

```text
Grind vegetative debris at DMS - 43,894 CY @ contract grinding rate
```

Expected evidence:

- DMS processing log.
- Grinder/burn/compaction/decontamination record.
- Stockpile balance or reduction factor.
- Processing date and responsible operator.

### Leg 3: Haul-Derived-Material-to-FDS

Leg 3 documents derived material leaving the DMS and going to final disposal, reuse, or recycling.

Example invoice line:

```text
Haul mulch from DMS to FDS/beneficial reuse site - derived CY or tons @ haul-out rate
```

Expected evidence:

- Haul-out ticket.
- Derived material state.
- DMS source pile or processing parent.
- FDS/recycler/disposal receipt.
- Distance tier or destination zone where rate depends on distance.

Critical validation principle: lifecycle stage difference is not duplicate billing. A duplicate requires the same billable activity over the same material state between the same nodes under the same rate authority, not merely a similar quantity or shared original material stream.

## 5. Lifecycle Matrix by Material Type

| Material type | Source | DMS role | Derived material | FDS role | Common billing legs |
|---|---|---|---|---|---|
| Vegetative | ROW, public property, PPDR, CPDR, waterway, hazard tree location | Intake, stage, grind, burn, reduce | Mulch, chips, ash, reduced vegetative debris | Landfill, ash disposal, beneficial reuse, recycler | Collection, initial haul, grinding/burning, haul-out, disposal/reuse |
| C&D | ROW, public property, PPDR, CPDR | Intake, sort, compact, load | Compacted C&D residue, sorted recyclable material | Landfill, recycler | Collection, haul to DMS, compaction/sorting/loading, landfill haul, tipping fee |
| White goods | ROW, public property, PPDR, CPDR | Segregate, inventory, decontaminate | Decontaminated scrap, recyclable metal | Recycler, approved disposal | Collection, decontamination, haul, recycling/disposal |
| E-waste | ROW, public property, PPDR, CPDR | Segregate, package, stage | Recyclable e-waste lot | Recycler, approved disposal | Collection, packaging, haul, recycling/disposal |
| HHW | ROW, public property, PPDR, CPDR | Segregate, classify, package | Manifested HHW | Approved hazardous waste disposal facility | Collection, handling, transport, disposal |
| Hazard trees | Tree location, ROW, public property, PPDR | May receive resulting vegetative debris | Cut vegetative debris, mulch, ash | DMS, FDS, beneficial reuse | Inspection, removal, haul, processing, disposal |
| Sand/silt | Waterway, drainage feature, public property, ROW | Stage, screen, dewater | Screened/dewatered material | Disposal, beneficial reuse | Removal, haul, processing, haul-out, disposal/reuse |

## 6. Why This Matters for Contract Rate Validation

A weak validator flattens everything into `vegetative_removal`. That creates false positives and false negatives:

- It may mark a legitimate mulch haul-out as a duplicate of ROW-to-DMS haul.
- It may accept a grinding rate where the invoice line is actually for final haul.
- It may compare original material against derived material.
- It may ignore whether the rate authority depends on source, destination, distance tier, or activity.
- It may hide missing evidence for DMS processing, FDS receipt, or environmental manifest.

Required preserved dimensions:

| Dimension | Why it matters |
|---|---|
| `material_type` | Identifies the material family, such as vegetative, C&D, HHW, or white goods. |
| `material_state` | Distinguishes original debris from mulch, ash, compacted residue, scrap, or manifested HHW. |
| `source_node` | Anchors where the billed movement or activity starts. |
| `destination_node` | Anchors where the billed movement or activity ends. |
| `activity_type` | Distinguishes collection, haul, grinding, burning, compaction, disposal, and evidence-only steps. |
| `unit` | Prevents CY/ton/load/item/lump-sum confusion. |
| `distance_tier` | Supports mileage or zone-based rates. |
| `rate_authority` | Ties the line to the governing contract, schedule, amendment, or approved rate source. |

## 7. Recommended Lifecycle Data Model

### Material Stream

```json
{
  "material_stream_id": "ms-goodlettsville-vegetative-001",
  "project_id": "goodlettsville",
  "material_type": "vegetative",
  "initial_material_state": "unprocessed_vegetative_debris",
  "source_node": {
    "node_type": "ROW",
    "location_name": "Goodlettsville ROW",
    "zone": "Zone 4"
  },
  "eligibility_basis": "FEMA_PA_debris_removal",
  "source_evidence_ids": ["ticket-1001", "ticket-1002"]
}
```

### Movement Event

```json
{
  "event_id": "move-001",
  "material_stream_id": "ms-goodlettsville-vegetative-001",
  "event_type": "movement",
  "activity_type": "initial_haul_to_dms",
  "material_type": "vegetative",
  "material_state": "unprocessed_vegetative_debris",
  "from_node": "ROW",
  "to_node": "DMS",
  "quantity": 43894,
  "unit": "CY",
  "ticket_ids": ["ticket-1001", "ticket-1002"],
  "rate_authority": "contract_rate_schedule"
}
```

### Transformation Event

```json
{
  "event_id": "transform-001",
  "material_stream_id": "ms-goodlettsville-vegetative-001",
  "event_type": "transformation",
  "activity_type": "grinding",
  "input_material_state": "unprocessed_vegetative_debris",
  "output_material_state": "mulch",
  "processing_node": "DMS",
  "input_quantity": 43894,
  "input_unit": "CY",
  "output_quantity": 17558,
  "output_unit": "CY",
  "conversion_basis": "documented_reduction_factor_or_stockpile_balance",
  "evidence_ids": ["dms-processing-log-001"]
}
```

### Final Movement Event

```json
{
  "event_id": "move-002",
  "material_stream_id": "ms-goodlettsville-vegetative-001",
  "event_type": "movement",
  "activity_type": "haul_derived_material_to_fds",
  "material_type": "vegetative",
  "material_state": "mulch",
  "from_node": "DMS",
  "to_node": "FDS",
  "quantity": 17558,
  "unit": "CY",
  "parent_transformation_event_id": "transform-001",
  "ticket_ids": ["haulout-2001"],
  "final_receipt_ids": ["reuse-receipt-3001"],
  "rate_authority": "contract_rate_schedule"
}
```

## 8. Recommended Rate Taxonomy

Recommended rate row categories:

- `collection_removal`
- `initial_haul_to_dms`
- `direct_haul_to_fds`
- `dms_intake`
- `dms_staging`
- `dms_grinding`
- `dms_chipping`
- `dms_burning`
- `dms_compaction`
- `dms_sorting`
- `dms_loading`
- `white_goods_collection`
- `white_goods_decontamination`
- `e_waste_collection`
- `e_waste_recycling`
- `hhw_collection`
- `hhw_handling`
- `hhw_transport`
- `hazard_tree_removal`
- `leaner_removal`
- `hanger_removal`
- `limb_removal`
- `stump_removal`
- `sand_silt_removal`
- `screening_dewatering`
- `haul_derived_material_to_fds`
- `final_disposal`
- `landfill_tipping_fee`
- `recycling_fee`
- `beneficial_reuse_haul`
- `environmental_manifest_handling`

### Collection / Haul Rate Row

```json
{
  "rate_row_id": "rate-veg-haul-dms",
  "category": "initial_haul_to_dms",
  "material_type": "vegetative",
  "material_state": "unprocessed_vegetative_debris",
  "activity_type": "haul",
  "from_node": "ROW",
  "to_node": "DMS",
  "unit": "CY",
  "rate": 6.9,
  "rate_authority": "contract_rate_schedule",
  "evidence_required": ["load_ticket", "tower_ticket", "dms_intake"]
}
```

### Grinding Rate Row

```json
{
  "rate_row_id": "rate-veg-grinding",
  "category": "dms_grinding",
  "material_type": "vegetative",
  "input_material_state": "unprocessed_vegetative_debris",
  "output_material_state": "mulch",
  "activity_type": "grinding",
  "processing_node": "DMS",
  "unit": "CY",
  "rate": 0,
  "rate_authority": "contract_rate_schedule",
  "evidence_required": ["dms_processing_log", "stockpile_balance"]
}
```

### Mulch Haul-Out Rate Row

```json
{
  "rate_row_id": "rate-mulch-haulout",
  "category": "haul_derived_material_to_fds",
  "material_type": "vegetative",
  "material_state": "mulch",
  "activity_type": "haul",
  "from_node": "DMS",
  "to_node": "FDS",
  "unit": "CY",
  "distance_tier": "contract_defined",
  "rate": 0,
  "rate_authority": "contract_rate_schedule",
  "evidence_required": ["haul_out_ticket", "fds_receipt"]
}
```

## 9. Ticket Types and Evidence Controls

| Ticket type | Lifecycle use | Required control |
|---|---|---|
| Load Ticket | Source collection and initial haul | Source, truck, quantity, material, monitor certification |
| Tower Ticket | DMS intake measurement | Truck measurement, DMS location, monitor certification |
| Scale Ticket | Weight-based intake or disposal | Facility, gross/tare/net, date/time, material |
| DMS Processing Log | Transformation at DMS | Input pile, activity, output state, quantity/reduction basis |
| Haul-Out Ticket | Derived material leaving DMS | Derived material state, from DMS, to FDS/reuse/recycler |
| Disposal Receipt | Final disposal or reuse | Facility, accepted material, quantity, date/time |
| ROE Packet | PPDR or CPDR eligibility | Owner authorization, location, scope, eligibility approval |
| Hazard Tree Packet | Hazard tree, leaner, hanger, limb, stump work | GPS/photo, eligibility, diameter/quantity, monitor approval |
| Environmental Manifest | HHW/e-waste/regulated materials | Chain of custody, transporter, facility, material class |

## 10. Lifecycle Validation Rules

### 1. `invoice-line-must-map-to-stage`

```text
For each invoice line:
  require activity_type
  require lifecycle_stage
  require material_type
  require material_state
  require source_node or processing_node
  require destination_node when activity_type is movement
```

### 2. `material-state-must-match-stage`

```text
If lifecycle_stage is initial_haul_to_dms:
  material_state must be an original/source state

If lifecycle_stage is transform_at_dms:
  input_material_state and output_material_state must both be present

If lifecycle_stage is haul_derived_material_to_fds:
  material_state must be a derived state
  parent_transformation_event_id must be present unless direct generation is documented
```

### 3. `source/destination-must-match-rate-row`

```text
For each invoice line matched to a rate row:
  invoice.from_node must equal rate_row.from_node when rate_row.from_node is present
  invoice.to_node must equal rate_row.to_node when rate_row.to_node is present
  invoice.activity_type must equal rate_row.activity_type
```

### 4. `derived-material-requires-transformation-parent`

```text
If material_state is mulch, ash, compacted_c_and_d_residue, decontaminated_scrap, or manifested_hhw:
  require a transformation event or accepted external derivation evidence
```

### 5. `FDS-receipt-required`

```text
If lifecycle_stage is final_disposal or haul_derived_material_to_fds:
  require disposal receipt, recycler receipt, reuse acknowledgement, or approved equivalent
```

### 6. `no-duplicate-billing-across-stages`

```text
Do not mark two invoice lines as duplicates solely because material_type or quantity matches.

Duplicate billing requires:
  same material_stream_id
  same material_state
  same activity_type
  same from_node
  same to_node
  same unit
  overlapping ticket/evidence set
  same rate_authority
```

### 7. `unit-conversion-must-be-explicit`

```text
If invoice quantity unit differs from ticket or rate row unit:
  require explicit conversion factor
  require conversion source
  preserve original quantity and converted quantity
```

### 8. `DMS-stockpile-balance-should-reconcile`

```text
For DMS-routed material streams:
  intake quantity
  minus processed/transformed quantity
  minus haul-out quantity
  minus remaining stockpile
  should reconcile within documented tolerance
```

## 11. Example Lifecycle Trace

Goodlettsville-style scenario:

```text
Contract line: Vegetative debris haul / removal
Rate: $6.90 per CY
Quantity: 43,894 CY
Invoice amount: 43,894 * $6.90 = $302,868.60
```

### Three-Stage Correct Interpretation

| Stage | Interpretation | Example quantity | Evidence |
|---|---|---:|---|
| 1. Initial haul | Vegetative debris from ROW to DMS | 43,894 CY | Load tickets, tower tickets, DMS intake |
| 2. Transformation | Vegetative debris ground, chipped, or burned at DMS | 43,894 input CY | DMS processing log, stockpile balance |
| 3. Derived haul/disposal | Mulch or ash leaves DMS for FDS/reuse/disposal | Derived quantity | Haul-out ticket, disposal/reuse receipt |

Under the correct interpretation, the $6.90/CY line must be matched to its actual lifecycle stage. If the line is for ROW-to-DMS haul, it should not be treated as covering mulch haul-out unless the contract expressly bundles those stages.

### Incorrect "Duplicate" Interpretation

```text
Line A: Vegetative debris haul - 43,894 CY
Line B: Mulch haul-out - derived quantity

Incorrect result:
  Flag duplicate because both relate to the same vegetative debris stream.

Correct result:
  Not duplicate unless Line A and Line B charge the same activity,
  same material state, same source, same destination, same unit,
  same evidence set, and same rate authority.
```

The validator must preserve the lifecycle stage before judging duplication. The same original material stream can legitimately produce multiple billable lifecycle events.

## 12. Operational Review by Role

### Applicant / County

- Confirm eligible work location and scope.
- Confirm FEMA PA eligibility basis.
- Review invoice lines against contract and monitoring evidence.
- Maintain closeout-ready documentation.
- Resolve policy or eligibility exceptions before payment.

### Debris Removal Contractor

- Perform collection, hauling, DMS operations, processing, and disposal work.
- Produce tickets, logs, receipts, and supporting documentation.
- Bill under the correct rate authority and unit.
- Separate original material work from derived material work.

### Debris Monitoring Firm

- Monitor source collection, DMS intake, processing, haul-out, and disposal.
- Certify quantities and truck measurements.
- Preserve evidence anchors and chain of custody.
- Reconcile tickets, DMS balances, and disposal receipts.
- Identify missing or inconsistent lifecycle evidence.

### Project Manager

- Ensure invoice review follows the material lifecycle.
- Distinguish stage differences from duplicate billing.
- Confirm rate row authority for each activity.
- Resolve material-state and source/destination mismatches.
- Protect closeout documentation and audit trail.

## 13. Lifecycle-Based Invoice Review Checklist

1. What material stream does this invoice line belong to?
2. What is the material type?
3. What is the material state at this lifecycle stage?
4. What activity is being billed?
5. What source, processing, or destination node anchors the line?
6. What ticket, log, receipt, packet, or manifest supports the line?
7. Does the rate row authorize this activity for this material state and node pair?
8. Are unit conversions explicit and evidence-backed?
9. Does any apparent duplicate actually represent a different lifecycle stage?
10. Does the full chain support FEMA PA closeout documentation?

## 14. How This Should Change EightForge's Logic

### Current Weak Model

```json
{
  "category": "vegetative_removal",
  "unit": "CY",
  "rate": 6.9
}
```

Weaknesses:

- Collapses source collection, haul, DMS processing, derived haul-out, and final disposal.
- Does not preserve material state.
- Does not preserve source and destination nodes.
- Cannot distinguish duplicate billing from valid lifecycle stages.
- Cannot validate evidence requirements by lifecycle stage.

### Better Model: Collect / Haul

```json
{
  "category": "initial_haul_to_dms",
  "material_type": "vegetative",
  "material_state": "unprocessed_vegetative_debris",
  "activity_type": "haul",
  "from_node": "ROW",
  "to_node": "DMS",
  "unit": "CY",
  "rate": 6.9,
  "rate_authority": "contract_rate_schedule"
}
```

### Better Model: Haul Derived Material

```json
{
  "category": "haul_derived_material_to_fds",
  "material_type": "vegetative",
  "material_state": "mulch",
  "activity_type": "haul",
  "from_node": "DMS",
  "to_node": "FDS",
  "unit": "CY",
  "rate": 0,
  "rate_authority": "contract_rate_schedule",
  "parent_transformation_required": true
}
```

## 15. Recommended Lifecycle Categories for Contract Rate Assembler

Canonical category candidates:

1. `collection_removal`
2. `source_collection`
3. `initial_haul_to_dms`
4. `direct_haul_to_fds`
5. `dms_intake`
6. `dms_staging`
7. `dms_sorting`
8. `dms_grinding`
9. `dms_chipping`
10. `dms_burning`
11. `dms_ash_handling`
12. `dms_compaction`
13. `dms_loading`
14. `haul_derived_material_to_fds`
15. `final_disposal`
16. `landfill_tipping_fee`
17. `beneficial_reuse_haul`
18. `recycling_haul`
19. `recycling_fee`
20. `vegetative_collection`
21. `vegetative_initial_haul`
22. `vegetative_grinding`
23. `vegetative_burning`
24. `mulch_haul_out`
25. `ash_haul_out`
26. `c_and_d_collection`
27. `c_and_d_initial_haul`
28. `c_and_d_compaction`
29. `c_and_d_landfill_haul`
30. `white_goods_collection`
31. `white_goods_decontamination`
32. `white_goods_recycling_haul`
33. `e_waste_collection`
34. `e_waste_packaging`
35. `e_waste_recycling_haul`
36. `hhw_collection`
37. `hhw_handling`
38. `hhw_transport`
39. `hhw_disposal`
40. `hazard_tree_removal`
41. `leaner_removal`
42. `hanger_removal`
43. `limb_removal`
44. `stump_removal`
45. `sand_silt_removal`
46. `screening_dewatering`
47. `environmental_manifest_handling`
48. `roe_packet_review`
49. `monitoring_ticket_review`
50. `closeout_documentation`

## 16. Practical PM Takeaway

Debris programs are built around material streams, not merely ticket collections. A ticket is evidence of a movement, processing event, disposal event, or eligibility control. The same original material may legitimately appear in multiple ticket sets as it moves from source, to DMS, through transformation, into derived material, then to final disposal, reuse, or recycling.

The PM review should preserve the chain:

```text
What material is this?
What state is it in now?
Where did it come from?
Where is it going?
What activity is being billed?
Which contract rate authorizes that activity?
Which evidence proves this stage occurred?
```

Final reframing:

```text
Old question:
  Does this invoice line match a contract rate?

Better question:
  Does this invoice line match the correct lifecycle stage for this material stream?
```

## Implementation Status

Not yet implemented. First concrete next step (per project backlog): an additive-only Phase A audit investigating whether `activity_type`, `from_node`, `to_node`, and `material_state` can be added as new OPTIONAL fields alongside the existing `category` field, without breaking any current schema, test, or Golden Project acceptance gate (Williamson County CYD 74,617 / Extended Cost $815,559.35). This is explicitly additive, not a replacement of `category`.
