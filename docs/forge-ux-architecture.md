# EightForge Forge UX Architecture

## Product Thesis

EightForge is not a dashboard suite. It is an operational intelligence system with one continuous progression:

`documents -> facts -> decisions -> actions -> audit`

The interface should therefore behave like a guided operational flow, not a set of disconnected destinations. Users should feel that work is moving forward through a project, not that they are browsing modules.

## 1. Final UX Architecture

### Level 0: Workspace

Purpose: portfolio awareness and prioritization

Question answered: which project needs attention

Primary job:
- rank projects by pressure, risk, and recent movement
- show where work is getting stuck
- route the operator into the right project immediately

This is not a dashboard. It is a portfolio triage surface.

### Level 1: Project

Purpose: operational container

Question answered: what is happening in this project

Primary job:
- preserve permanent scope for all documents, facts, decisions, actions, and audit
- keep project identity visible at all times
- show a compact operational summary above active work

The project page is a single operating frame, not a collection of tabs.

### Level 2: Forge

Purpose: in-project processing surface

Question answered: what needs to move forward right now

Primary job:
- give operators one continuous surface for moving work from intake to decision to execution
- default to `Decide`
- expose upstream pressure without turning the UI into a 6-column kanban

Forge is the main surface inside every project.

### Level 3: Item Detail

Purpose: inspection and control

Question answered: what exactly is this and why

Primary job:
- inspect source evidence
- review facts
- approve, correct, assign, or resolve
- expose audit trail and machine reasoning without leaving Forge

Item detail should open in context, not pull the user into a separate product area.

## Route Model

Recommended route model:

- `/workspace`
- `/projects/:projectId`
- `/projects/:projectId?stage=decide`
- `/projects/:projectId?stage=decide&item=decision:123`

Rules:
- stage changes are shallow route changes, not page changes
- selecting an item updates the right pane and URL state
- deep links open directly into the correct project, stage, and selected item
- full-page item routes become fallback deep links, not the primary browsing model

## 2. Detailed Layouts

### Workspace

Structure:

1. Top command band
2. Thin portfolio status strip
3. Prioritized project stack

#### Top command band

Contains:
- workspace name
- global search / command entry
- quick create project
- quick intake action that first asks for project scope

Rules:
- no big hero
- no widget grid
- no KPI card explosion

#### Portfolio status strip

A single restrained band for:
- projects needing attention
- blocked projects
- overdue actions
- recent intake volume

This is a status line, not a dashboard.

#### Project stack

Each project appears as a pressure card or strip. Cards should be full-width, sparse, and easy to compare vertically.

Each project card shows:
- project name and code
- current operational state
- thin pipeline rail with stage counts
- highest-pressure condition
- overdue action count
- last movement timestamp
- dominant next step

Recommended composition:

- left: project identity, status, owner
- center: thin stage rail with count distribution
- right: pressure summary and one clear entry action

The card should answer in one glance:
- is this healthy
- where is it stuck
- does it need me now

### Project Page

Structure:

1. Sticky project context header
2. Project overview band
3. Forge

#### Sticky project context header

Always visible and minimal.

Contains:
- breadcrumb: Workspace / Project
- project name and code
- project state
- quick actions: upload document, search in project, share link

Rules:
- project scope is never ambiguous
- project code and name stay visible during scrolling
- no secondary tab row

#### Project overview band

This replaces the current bloated overview page and tab set.

It sits directly above Forge and summarizes the project without becoming a second surface.

Contains:
- stage counts across `Intake -> Extract -> Structure -> Decide -> Act -> Audit`
- critical item count
- overdue action count
- most recent meaningful activity
- optional exposure or confidence signal when relevant to the project type

Recommended visual behavior:
- horizontal, compressed, always scannable
- each metric is a line item, not a large card
- stage counts are part of the same band, not a separate dashboard

What it should do:
- orient the operator before they enter the work surface

What it should not do:
- compete with Forge
- duplicate the center worklist

### Forge 3-Pane System

Structure:

1. Thin pipeline rail
2. Left pressure pane
3. Center work pane
4. Right evidence pane

Recommended desktop proportions:
- pipeline rail: 56-72px
- left pane: 260-320px
- center pane: fluid primary surface
- right pane: 320-400px

#### Thin pipeline rail

Stages:
- Intake
- Extract
- Structure
- Decide
- Act
- Audit

Rules:
- no equal-width kanban columns
- rail is for orientation and switching context
- selected stage changes the center pane
- stage counts appear as compact badges
- default selection is `Decide`

Behavior:
- clicking a stage does not navigate away from the project
- it reconfigures Forge in place

#### Left pane: upstream pressure

Purpose:
- show what is feeding pressure into the current stage
- make upstream blockers visible without dominating the screen

This pane is not the main workspace. It is the pressure diagnostic.

By selected stage:

- `Intake`: new uploads, missing metadata, routing errors
- `Extract`: OCR failures, parser failures, low-confidence extraction
- `Structure`: missing fields, conflicting facts, evidence gaps
- `Decide`: unresolved upstream blockers creating decision pressure
- `Act`: decisions lacking owner, due date, or operational specificity
- `Audit`: unresolved audit exceptions and recent compliance deviations

Display pattern:
- compact stacked list
- severity first
- counts second
- one-line explanation

#### Center pane: primary work surface

Purpose:
- the place where work gets moved forward

This pane changes by stage.

By selected stage:

- `Intake`: intake queue with assign-to-project, classify, and accept controls
- `Extract`: extraction exceptions with retry and review actions
- `Structure`: fact normalization and structured review workspace
- `Decide`: decision worklist with approve, correct, assign, or escalate
- `Act`: action commitments grouped by urgency, owner, or due date
- `Audit`: timeline and control surface for review history and accountability

Rules:
- center pane owns the main action density
- only one primary list or board at a time
- prioritize `Decide` and `Act`
- avoid card mosaics and avoid six-column comparisons

Default `Decide` layout:
- top: stage summary with unresolved counts
- middle: decision queue ordered by severity and blockage
- optional lower segment: resulting actions created from selected decisions

Default `Act` layout:
- top: overdue and blocked action summary
- middle: actions grouped by `Needs owner`, `Due soon`, `Blocked`, `In progress`

#### Right pane: evidence, audit, context

Purpose:
- explain the currently selected item without breaking flow

Always reserved for the selected item or current project context.

Contains:
- source evidence and document preview
- fact provenance
- linked records
- audit trail
- rationale for the current decision or action

Rules:
- if nothing is selected, show project-level context and recent activity
- selecting a row in the left or center pane updates the right pane first
- full-page detail is secondary, for rare deep reading

## 3. Interaction Model

### Primary movement through the system

1. User lands in Workspace
2. Workspace ranks projects by pressure
3. User opens a project
4. Project opens directly into Forge at `Decide`
5. User works the current stage
6. Selecting an item reveals evidence and audit in the right pane
7. Completing an item updates project status and workspace pressure immediately

### Navigation principles

- Workspace is for choosing where to work
- Project is for understanding scoped operational state
- Forge is for moving work forward
- Item detail is for inspection, correction, and approval

### Key behaviors

- stage switching is in-place, never a module jump
- decision and action work happen inside the same Forge shell
- documents are entered through project-scoped intake, not a separate global area
- the right pane is the first stop for detail, not a new page
- keyboard search should jump to a project or item and preserve context

### Deep link behavior

Every important state should be linkable:
- project + stage
- project + stage + item
- project + stage + filtered worklist

This supports collaboration without recreating separate pages.

### Mobile behavior

On smaller screens:
- project context header stays pinned
- pipeline rail becomes a horizontal scroll strip
- left pressure pane becomes a collapsible drawer
- right evidence pane becomes a bottom sheet or inspector tab
- center pane remains primary

The mental model stays the same even when panes collapse.

## 4. Information Hierarchy

### Primary

- current project
- selected stage
- unresolved decisions and actions
- blocking upstream issues
- due dates, owners, severity, and next step
- evidence for the selected item

### Secondary

- stage counts
- project health summary
- recent activity
- related documents and linked records
- confidence and extraction quality indicators

### Tertiary

- raw diagnostics
- full audit event history
- extraction payloads
- historical comparisons and debug metadata

Rule:
- if information does not help the operator decide, act, or verify, it should be collapsed or removed

## 5. What Should Be Removed From the Current UI

Remove these as primary navigation surfaces:

- `Command Center`
- `Decision Queue`
- `My Actions`
- `Documents`
- `Intelligence`

These are not separate products. They are slices of the same operational flow and should be absorbed into Workspace, Project, and Forge.

Remove these project-level patterns:

- overview tabs for `Overview`, `Facts`, `Decisions`, `Actions`, `Documents`, `Audit`
- standalone facts section as a peer to decisions and actions
- separate documents block as a sibling module
- floating quick-action bars that duplicate the visible work surface

Remove these conceptual duplications:

- a global documents workspace separate from project flow
- a decision queue page separate from Forge
- an actions page separate from Forge
- a separate intelligence area when evidence and audit already live in the right pane

Remove these interaction failures:

- page-hopping to inspect details
- repeated status cards that restate the same counts
- large dashboard panels that do not change the next operator action
- any "standalone document" concept

New rule:
- every document is scoped to a project before ingestion is committed
- if upload starts from Workspace, project selection happens first or inline with project creation

## 6. Naming Recommendations

### Keep

- `Workspace`
- `Projects`
- `Forge`
- `Actions`
- `Audit`

### Rename

- `Command Center` -> `Workspace`
- `My Actions` -> `Act`
- `Decision Queue` -> `Decide`
- `Documents` -> `Intake`
- `Workflows` -> `Actions`
- `Intelligence` -> remove as top-level label; use `Evidence` or `Context` inside the right pane

### Recommended surface names

- top level: `Workspace`
- project summary band: `Project Pulse`
- in-project main surface: `Forge`
- right pane default label: `Context`
- right pane when item selected: `Evidence`

### Stage labels

Use the pipeline labels directly:

- Intake
- Extract
- Structure
- Decide
- Act
- Audit

This is clearer than mixing nouns and product names.

## Final Product Shape

The final product should feel like this:

- Workspace tells you which project needs you
- Project tells you what is happening in scope
- Forge tells you what needs to move now
- Item detail tells you exactly why

That is the correct EightForge hierarchy.

